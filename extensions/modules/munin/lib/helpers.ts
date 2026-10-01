// Ported from @bacnh85/pi-munin 0.5.12 extensions/lib/helpers.ts. Differences:
// dotenv/loadEnv removed — ceulen's bundle env.ts already ingests global +
// trusted-cwd .env files into process.env before module handlers run; config
// now also reads settings.json layers (project trust-gated) with env winning.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Munin config
// ---------------------------------------------------------------------------

export interface MuninConfig {
  apiKey: string;
  projectId: string;
  baseUrl: string;
}

/** Where the three config fields came from — for /munin-status disclosure. */
export type MuninConfigSource = "param" | "env" | "project" | "global" | "default";

export interface MuninResolvedConfig extends MuninConfig {
  sources: { apiKey: MuninConfigSource; projectId: MuninConfigSource; baseUrl: MuninConfigSource };
  /** The settings file the /config panel writes (project `.pi/settings.json`). */
  projectFile: string;
  projectTrusted: boolean;
}

/** The `munin` section of a settings.json file. Missing/malformed → null. */
export function readMuninSection(file: string): { apiKey?: string; project?: string; baseUrl?: string } | null {
  if (!existsSync(file)) return null;
  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!json || typeof json.munin !== "object" || json.munin === null) return null;
    const m = json.munin as Record<string, unknown>;
    const out: { apiKey?: string; project?: string; baseUrl?: string } = {};
    for (const key of ["apiKey", "project", "baseUrl"] as const) {
      if (typeof m[key] === "string" && (m[key] as string).trim()) out[key] = (m[key] as string).trim();
    }
    return out;
  } catch {
    return null; // malformed → treated as unconfigured (never clobbered on write)
  }
}

/** Read-modify-write the `munin` section into `file` (merge, never clobber).
 *  Atomic (tmp+rename); a corrupt file refuses to overwrite (same guard as
 *  writeDisabled/writeRouterSection). */
export function writeMuninSection(patch: { apiKey?: string; project?: string; baseUrl?: string }, file: string): void {
  let settings: Record<string, unknown> | null = {};
  try {
    if (existsSync(file)) {
      settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    }
  } catch {
    // Corrupt ≠ missing: a {} fallback would make the rename below overwrite
    // the file with ONLY the munin section, destroying every other key.
    settings = null;
  }
  if (settings === null) {
    throw new Error(`${file} is not valid JSON — fix or remove it before saving.`);
  }
  const munin = (settings.munin ?? {}) as Record<string, unknown>;
  for (const key of ["apiKey", "project", "baseUrl"] as const) {
    if (patch[key] !== undefined) {
      const v = patch[key]!.trim();
      if (v) munin[key] = v;
      else delete munin[key]; // empty input clears the field
    }
  }
  settings.munin = munin;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/** Project settings file for `cwd` — the /config save target. */
export function projectSettingsPath(cwd = process.cwd()): string {
  return path.join(cwd, ".pi", "settings.json");
}

/** First existing agent-dir settings.json (global scope). */
export function globalSettingsPath(dirs: string[] = []): string {
  const candidates = dirs.length > 0
    ? dirs
    : process.env.PI_CODING_AGENT_DIR
      ? [process.env.PI_CODING_AGENT_DIR]
      : [path.join(process.env.HOME || "", ".pi", "agent"), path.join(process.env.HOME || "", ".pi", "agents")];
  return path.join(candidates[0]!, "settings.json");
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Munin base URL must be a valid HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Munin base URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Munin base URL must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("Munin base URL must not contain a query or fragment");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export const DEFAULT_MUNIN_BASE_URL = "https://munin.kalera.ai";

/** Env key names must not shadow the resolved project id in error text — helper for tests. */
export const CONFIG_ENV_KEYS = ["MUNIN_API_KEY", "MUNIN_PROJECT", "MUNIN_BASE_URL"] as const;

/**
 * Resolve Munin config. Precedence per field: explicit tool param > env
 * (process.env — the bundle's trust-gated .env ingestion populates it) >
 * trusted project `.pi/settings.json` `munin` section > global settings.json
 * `munin` section > default (baseUrl only). The project file is read ONLY when
 * trusted — an untrusted checkout must not redirect where the API key is sent
 * (same rule as the router module).
 *
 * An explicit `base_url` param without an explicit `api_key` throws: a
 * caller redirecting the endpoint must own the credential too.
 */
export function getMuninConfig(
  params: Record<string, unknown> = {},
  cwd = process.cwd(),
  trusted = false,
  opts: { agentDirs?: string[] } = {},
): MuninResolvedConfig {
  const explicitApiKey = typeof params.api_key === "string" && params.api_key ? params.api_key : undefined;
  const explicitBaseUrl = typeof params.base_url === "string" && params.base_url ? params.base_url : undefined;
  const explicitProject = typeof params.project === "string" && params.project ? params.project : undefined;
  if (explicitBaseUrl && !explicitApiKey) {
    throw new Error("An explicit api_key is required when overriding base_url");
  }

  const projectFile = projectSettingsPath(cwd);
  const project = trusted ? readMuninSection(projectFile) : null;
  const global = readMuninSection(globalSettingsPath(opts.agentDirs));

  const pick = (
    param: string | undefined,
    env: string | undefined,
    fromProject: string | undefined,
    fromGlobal: string | undefined,
  ): { value: string | undefined; source: MuninConfigSource } => {
    if (param) return { value: param, source: "param" };
    if (env) return { value: env, source: "env" };
    if (fromProject) return { value: fromProject, source: "project" };
    if (fromGlobal) return { value: fromGlobal, source: "global" };
    return { value: undefined, source: "default" };
  };

  const apiKey = pick(explicitApiKey, process.env.MUNIN_API_KEY, project?.apiKey, global?.apiKey);
  const projectId = pick(explicitProject, process.env.MUNIN_PROJECT, project?.project, global?.project);
  const baseUrl = pick(explicitBaseUrl, process.env.MUNIN_BASE_URL, project?.baseUrl, global?.baseUrl);

  if (!apiKey.value) {
    throw new Error(
      "Munin API key is not configured. Set it via /config → Memory → Munin (saved to this project's .pi/settings.json), MUNIN_API_KEY env, or a per-call api_key.",
    );
  }
  if (!projectId.value) {
    throw new Error(
      "Munin project is not configured. Set it via /config → Memory → Munin (saved to this project's .pi/settings.json), MUNIN_PROJECT env, or a per-call project.",
    );
  }
  return {
    apiKey: apiKey.value,
    projectId: projectId.value,
    baseUrl: normalizeBaseUrl(baseUrl.value || DEFAULT_MUNIN_BASE_URL),
    sources: { apiKey: apiKey.source, projectId: projectId.source, baseUrl: baseUrl.source },
    projectFile,
    projectTrusted: trusted,
  };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export const OUTPUT_MAX_BYTES = DEFAULT_MAX_BYTES;
export const OUTPUT_MAX_LINES = DEFAULT_MAX_LINES;

export function truncateText(text: string): string {
  const result = truncateHead(text, {
    maxLines: OUTPUT_MAX_LINES,
    maxBytes: OUTPUT_MAX_BYTES,
  });
  if (!result.truncated) return result.content;
  return `${result.content}\n\n[Munin output truncated: showing ${result.outputLines} of ${result.totalLines} lines / ${result.outputBytes} of ${result.totalBytes} bytes.]`;
}

export function normalizeMemory(item: unknown): Record<string, unknown> {
  const wrapper = item as { memory?: Record<string, unknown>; score?: unknown };
  if (wrapper?.memory) {
    return { ...wrapper.memory, score: wrapper.score };
  }
  return (item as Record<string, unknown>) || {};
}

export function formatMemory(memory: Record<string, unknown>): string {
  const parts: string[] = [];
  if (memory.key) parts.push(`Key: ${memory.key}`);
  if (memory.id && memory.id !== memory.key) parts.push(`ID: ${memory.id}`);
  if (memory.title) parts.push(`Title: ${memory.title}`);
  if (memory.score !== undefined) parts.push(`Score: ${memory.score}`);
  if (memory.tags) {
    const tags = Array.isArray(memory.tags) ? memory.tags.join(", ") : String(memory.tags);
    parts.push(`Tags: ${tags}`);
  }
  if (memory.updatedAt || memory.updated) {
    parts.push(`Updated: ${(memory.updatedAt ?? memory.updated) as string}`);
  }
  if (memory.createdAt || memory.created) {
    parts.push(`Created: ${(memory.createdAt ?? memory.created) as string}`);
  }
  const content = (memory.content ?? memory.text ?? memory.body ?? memory.value ?? "") as string;
  if (content) parts.push(`Content:\n${content}`);
  return parts.join("\n");
}

// ponytail: handles { data: [...] }, { data: { memories: [...] } }, and raw arrays — 3 shapes the SDK actually returns. Unknown shapes are coerced (object → single-item list, primitives → String()).
export function formatMemories(result: unknown): string {
  if (!result || typeof result !== "object") return String(result);
  const container = result as Record<string, unknown>;
  let data = container.data ?? container.items ?? container.result ?? result;
  const nested = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined;
  const total = container.total ?? nested?.total;
  if (Array.isArray(nested?.memories)) data = nested.memories;
  const items = Array.isArray(data) ? data.filter(Boolean) : [data].filter(Boolean);
  if (items.length === 0) return "No memories found.";
  const formatted = items
    .map((item: unknown, index: number) => {
      const memory = normalizeMemory(item);
      const formatted = formatMemory(memory);
      // Skip items that produced no useful fields (meaningless data)
      if (!formatted) return null;
      return `--- Memory ${index + 1} ---\n${formatted}`;
    })
    .filter(Boolean)
    .join("\n\n");
  if (!formatted) return "No memories found.";
  return total !== undefined ? `${formatted}\n\nTotal: ${total}` : formatted;
}

export function toTextResult(result: unknown): string {
  if (result === null || result === undefined) return "No result.";
  if (typeof result === "string") return truncateText(result);
  const formatted = formatMemories(result);
  return truncateText(formatted);
}

/**
 * Format Munin server capabilities into a clean structured text output.
 * Capabilities are not memory objects, so they need dedicated formatting.
 */
export function formatCapabilities(caps: Record<string, unknown>): string {
  const lines = ["--- Munin Server Capabilities ---"];
  const meta = caps.metadata as Record<string, unknown> | undefined;
  if (caps.specVersion) lines.push(`Spec Version: ${caps.specVersion}`);
  if (meta?.serverVersion) lines.push(`Server Version: ${meta.serverVersion}`);
  const actions = caps.actions as Record<string, string[]> | undefined;
  if (actions?.core?.length) lines.push(`Core Actions: ${actions.core.join(", ")}`);
  if (actions?.optional?.length) lines.push(`Optional Actions: ${actions.optional.join(", ")}`);
  const features = Object.entries(caps.features as Record<string, { supported: boolean }> || {});
  if (features.length) lines.push(`Features: ${features.map(([n, i]) => `${n} ${i?.supported ? "✓" : "✗"}`).join(", ")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export function parseTags(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).trim()).filter(Boolean);
  if (typeof tags === "string") return tags.split(",").map((tag) => tag.trim()).filter(Boolean);
  return [];
}

export function validateMemoryTags(tags: unknown): { ok: true; tags: string[] } | { ok: false; message: string; tags: string[] } {
  const tagList = parseTags(tags);
  const hasTypeTag = tagList.some((tag: string) => tag.startsWith("type:"));
  const hasDomainTag = tagList.some((tag: string) => tag.startsWith("domain:"));
  if (!hasTypeTag || !hasDomainTag) {
    return {
      ok: false,
      message: `Tag validation failed: Memory must have at least one "type:" tag AND one "domain:" tag. Provided tags: ${tagList.join(", ") || "none"}`,
      tags: tagList,
    };
  }
  return { ok: true, tags: tagList };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

export function validateMemoryKey(key: unknown): string {
  if (!key || typeof key !== "string") {
    throw new Error("Memory key must be a non-empty string");
  }
  if (key.trim().length === 0) {
    throw new Error("Memory key cannot be empty or whitespace only");
  }
  if (key.length > 200) {
    throw new Error("Memory key must be at most 200 characters");
  }
  // Models stamp version numbers into keys ("pi-a2a/gateway-token-0.6.2"),
  // which the server rejects. Normalize instead of throwing — only chars the
  // server rejects are substituted, so legacy keys (incl. "a--b") stay intact.
  // Top munin failure family (session mining, 2026-08).
  const normalized = key.replace(/[^a-zA-Z0-9-_/]+/g, "-");
  if (!/[a-zA-Z0-9]/.test(normalized.replace(/[/_-]/g, ""))) {
    throw new Error("Memory key must contain at least one alphanumeric character");
  }
  return normalized;
}

export function validateSearchQuery(query: unknown): string {
  if (!query || typeof query !== "string") {
    throw new Error("Search query must be a non-empty string");
  }
  if (query.trim().length === 0) {
    throw new Error("Search query cannot be empty or whitespace only");
  }
  if (query.length > 1000) {
    throw new Error("Search query must be less than 1000 characters");
  }
  return query.trim();
}

/**
 * Validate the search tag_mode parameter: only "all" or "any" are accepted.
 * Returns undefined when absent (server default applies).
 */
export function validateTagMode(tagMode: unknown): string | undefined {
  if (tagMode === undefined || tagMode === null || tagMode === "") return undefined;
  if (tagMode === "all" || tagMode === "any") return tagMode;
  throw new Error(`Invalid tag_mode "${String(tagMode)}". Valid values: "all" (default), "any"`);
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export function classifyError(error: unknown): { type: string; message: string; remediation?: Remediation } {
  const err = error instanceof Error ? error : new Error(String(error));
  const remediation = extractRemediation(err);
  const code = String((err as Error & { code?: unknown }).code ?? "").toUpperCase();
  const structuredTypes: Record<string, string> = {
    AUTH_INVALID: "auth",
    VALIDATION_ERROR: "validation",
    FEATURE_DISABLED: "feature_disabled",
    RATE_LIMITED: "rate_limit",
    ERR_STALE_PROTOCOL: "stale_protocol",
    NOT_FOUND: "not_found",
  };
  if (structuredTypes[code]) return { type: structuredTypes[code], message: err.message, remediation };

  const message = err.message.toLowerCase().replace(/_/g, " ");
  const name = err.name.toLowerCase();
  if (name === "aborterror" || message.includes("timeout") || message.includes("timed out") || message.includes("etimed") || message.includes("aborterror")) {
    return { type: "timeout", message: err.message };
  }
  if (name === "munintransporterror" || message.includes("network") || message.includes("econn") || message.includes("socket") || message.includes("fetch failed")) {
    return { type: "network", message: err.message };
  }
  if (message.includes("unauthorized") || message.includes("invalid api key")) return { type: "auth", message: err.message };
  if (message.includes("validation") || message.includes("invalid request")) return { type: "validation", message: err.message };
  if (message.includes("feature disabled") || message.includes("not supported")) return { type: "feature_disabled", message: err.message };
  if (message.includes("rate limit") || message.includes("too many requests") || /\b429\b/.test(message)) return { type: "rate_limit", message: err.message };
  if (message.includes("e2ee") || message.includes("encryption")) return { type: "e2ee", message: err.message };
  if (message.includes("stale protocol")) return { type: "stale_protocol", message: err.message };
  if (message.includes("not found")) return { type: "not_found", message: err.message };
  return { type: "unknown", message: err.message };
}

// ponytail: redacts the env-var name plus Bearer/apiKey literals — heuristic
// base64 sniffing stays out (fragile, false positives).
export function sanitizeErrorMessage(error: Error): string {
  return error.message
    .replace(/MUNIN_API_KEY[=\s]+[A-Za-z0-9+/=_-]{4,}/gi, "MUNIN_API_KEY=[REDACTED]")
    .replace(/api[_-]?key\s*[=:]\s*["']?[A-Za-z0-9._-]+/gi, "apiKey=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}

// ---------------------------------------------------------------------------
// ERR_STALE_PROTOCOL remediation (server setup handshake)
// ---------------------------------------------------------------------------

export interface Remediation {
  action?: string;
  url?: string;
  version_from?: string | null;
  version_to?: string;
  acknowledge_after_reading?: {
    action: string;
    payload: { version: string };
  };
}

/** Pull the server's remediation block from an SDK error's `details`. Null-safe. */
export function extractRemediation(error: unknown): Remediation | undefined {
  const err = error instanceof Error ? error : new Error(String(error));
  const details = (err as Error & { details?: unknown }).details;
  if (details && typeof details === "object") {
    const remediation = (details as { remediation?: unknown }).remediation;
    if (remediation && typeof remediation === "object") {
      return remediation as Remediation;
    }
  }
  return undefined;
}

/** Human-readable remediation suffix for an error message. Empty string when none.
 *  Server-provided url/action are validated + sanitized: url must be http(s) (rejects
 *  javascript:/file:/data: and non-URLs), control chars stripped, phrased as data not
 *  an imperative to avoid a prompt-injection vector via a malicious/buggy server. */
export function formatRemediation(remediation: Remediation | undefined): string {
  if (!remediation) return "";
  const parts: string[] = [];
  const safeUrl = sanitizeRemediationUrl(remediation.url);
  const hasUrl = !!safeUrl;
  if (safeUrl) parts.push(`Setup guide: ${safeUrl}`);
  if (remediation.version_to) {
    const action = sanitizeRemediationToken(remediation.acknowledge_after_reading?.action) || "acknowledge_setup";
    const safeVersion = sanitizeRemediationToken(remediation.version_to);
    if (safeVersion) parts.push(`${hasUrl ? "then " : ""}run ${action} with version ${safeVersion}`);
  }
  if (!parts.length) return "";
  return ` Setup handshake required: ${parts.join(" ")}.`;
}

// C0 control + DEL + Unicode control/format chars that enable injection or deceptive rendering:
// bidi overrides (U+202E), zero-width (U+200B-200D), Unicode line/para separators (U+2028/2029),
// LTR/RTL marks (U+200E/200F), isolates (U+2066-2069), BOM/ZWNBSP (U+FEFF).
const REMEDIATION_CTRL_RE = /[\r\n\t\x00-\x1f\x7f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;

/** Allow only clean http(s) URLs. Rejects non-URLs, non-http schemes, URLs with credentials
 *  (mirrors normalizeBaseUrl's policy), and any URL containing control/bidi/format chars. */
function sanitizeRemediationUrl(url: string | undefined): string {
  if (!url || typeof url !== "string") return "";
  if (REMEDIATION_CTRL_RE.test(url)) return "";
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    // No credentials — matches normalizeBaseUrl's reject policy.
    if (u.username || u.password) return "";
    return u.href;
  } catch {
    return "";
  }
}

/** Strip C0/DEL + Unicode control/format chars from a short token (action name / version). */
function sanitizeRemediationToken(token: string | undefined): string {
  if (!token || typeof token !== "string") return "";
  return token.replace(/[\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff\r\n\t\x00-\x1f\x7f]/g, "");
}
