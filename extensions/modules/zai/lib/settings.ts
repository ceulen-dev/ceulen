/**
 * settings.ts — the `zai` settings section, layered like the other ceulen
 * modules: env (`ZAI_ANTHROPIC_*`) > trusted project `.pi/settings.json` >
 * global agent-dir settings.json > default.
 *
 * The project file is read ONLY when trusted (router/munin rule): an untrusted
 * checkout must not redirect the endpoint the API key is sent to. The /config
 * save always targets the GLOBAL settings.json and warns when a trusted
 * project file (or env) shadows the saved value.
 *
 * Mirrors munin's layering helper (extensions/modules/munin/lib/helpers.ts)
 * and router's read-modify-write section writer (router/lib/config.ts).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentDirs } from "../../../lib/registry.js";
import { DEFAULT_BASE_URL } from "./anthropic.js";
import { DEFAULT_MIN_INTERVAL_MS } from "./throttle.js";

export type ZaiSettingSource = "env" | "project" | "global" | "default";

export interface ZaiSettings {
  /** Anthropic-compatible endpoint (an entry of KNOWN_BASE_URLS by default). */
  baseUrl: string;
  /** Serving tier: `fast` (ZCode parity) or `standard`. */
  speed: "fast" | "standard";
  /** ZCode Client-Signing V4 parity on/off (fail-open when on). */
  signing: boolean;
  /** Cross-process dispatch spacing in ms; 0 disables the gate. */
  minIntervalMs: number;
}

export interface ZaiResolvedSettings extends ZaiSettings {
  /** Which layer supplied each field — for /zai and /config disclosure. */
  sources: Record<keyof ZaiSettings, ZaiSettingSource>;
  /** The project file that would shadow (`.pi/settings.json` in cwd). */
  projectFile: string;
  projectTrusted: boolean;
}

export const ZAI_ENV_KEYS = {
  baseUrl: "ZAI_ANTHROPIC_BASE_URL",
  speed: "ZAI_ANTHROPIC_SPEED",
  signing: "ZAI_ANTHROPIC_SIGNING",
  minIntervalMs: "ZAI_ANTHROPIC_MIN_INTERVAL_MS",
} as const;

/** Project settings file for `cwd` (read gated on trust, never the write target). */
export function projectSettingsPath(cwd = process.cwd()): string {
  return path.join(cwd, ".pi", "settings.json");
}

/** First agent-dir settings.json (global scope, the /config write target). */
export function globalSettingsPath(dirs: string[] = agentDirs()): string {
  return path.join(dirs[0]!, "settings.json");
}

export function normalizeZaiBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** The `zai` section of a settings.json file. Missing/malformed → null. */
export function readZaiSection(file: string): Partial<ZaiSettings> | null {
  if (!existsSync(file)) return null;
  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!json || typeof json.zai !== "object" || json.zai === null) return null;
    const z = json.zai as Record<string, unknown>;
    const out: Partial<ZaiSettings> = {};
    if (typeof z.baseUrl === "string" && z.baseUrl.trim()) out.baseUrl = normalizeZaiBaseUrl(z.baseUrl);
    if (z.speed === "fast" || z.speed === "standard") out.speed = z.speed;
    if (typeof z.signing === "boolean") out.signing = z.signing;
    if (typeof z.minIntervalMs === "number" && Number.isFinite(z.minIntervalMs) && z.minIntervalMs >= 0) {
      out.minIntervalMs = Math.floor(z.minIntervalMs);
    }
    return out;
  } catch {
    return null; // malformed → treated as unconfigured (never clobbered on write)
  }
}

/** Read-modify-write the `zai` section into `file` (merge, never clobber).
 *  Atomic (tmp+rename); a corrupt file refuses to overwrite (same data-loss
 *  guard as writeRouterSection/writeMuninSection). Strings are trimmed; an
 *  empty string clears the key (default restored). `0` is a real value
 *  (minIntervalMs disables the gate) and is persisted, never treated as unset. */
export function writeZaiSection(
  patch: Partial<ZaiSettings>,
  file: string = globalSettingsPath(),
): void {
  let settings: Record<string, unknown> | null = {};
  try {
    if (existsSync(file)) {
      settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    }
  } catch {
    // Corrupt ≠ missing: a {} fallback would make the rename below overwrite
    // the file with ONLY the zai section, destroying every other key.
    settings = null;
  }
  if (settings === null) {
    throw new Error(`${file} is not valid JSON — fix or remove it before saving.`);
  }
  const zai = (settings.zai ?? {}) as Record<string, unknown>;
  for (const key of ["baseUrl", "speed", "signing", "minIntervalMs"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (typeof value === "string" && !value.trim()) delete zai[key]; // empty input clears the field
    else if (key === "baseUrl") zai[key] = normalizeZaiBaseUrl(value as string);
    else zai[key] = value;
  }
  settings.zai = zai;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

// ── env parsing (strict: an unparseable value falls through to the next layer) ──

function envBaseUrl(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v ? normalizeZaiBaseUrl(v) : undefined;
}

function envSpeed(raw: string | undefined): "fast" | "standard" | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "fast") return "fast";
  if (v === "standard" || v === "normal" || v === "slow") return "standard";
  return undefined;
}

function envSigning(raw: string | undefined): boolean | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v) return undefined;
  if (["1", "true", "yes", "on", "enabled"].includes(v)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(v)) return false;
  return undefined;
}

function envInterval(raw: string | undefined): number | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  const parsed = Number(v);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

/**
 * Resolve the effective `zai` settings. Precedence per field: env >
 * trusted project `.pi/settings.json` > global settings.json > default.
 */
export function getZaiSettings(
  opts: { cwd?: string; trusted?: boolean; env?: Record<string, string | undefined>; dirs?: string[] } = {},
): ZaiResolvedSettings {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const trusted = opts.trusted === true;
  const projectFile = projectSettingsPath(cwd);
  const project = trusted ? readZaiSection(projectFile) : null;
  const global = readZaiSection(globalSettingsPath(opts.dirs));

  const pick = <T>(
    fromEnv: T | undefined,
    fromProject: T | undefined,
    fromGlobal: T | undefined,
  ): { value: T | undefined; source: ZaiSettingSource } => {
    if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
    if (fromProject !== undefined) return { value: fromProject, source: "project" };
    if (fromGlobal !== undefined) return { value: fromGlobal, source: "global" };
    return { value: undefined, source: "default" };
  };

  const baseUrl = pick(envBaseUrl(env[ZAI_ENV_KEYS.baseUrl]), project?.baseUrl, global?.baseUrl);
  const speed = pick(envSpeed(env[ZAI_ENV_KEYS.speed]), project?.speed, global?.speed);
  const signing = pick(envSigning(env[ZAI_ENV_KEYS.signing]), project?.signing, global?.signing);
  const minIntervalMs = pick(
    envInterval(env[ZAI_ENV_KEYS.minIntervalMs]),
    project?.minIntervalMs,
    global?.minIntervalMs,
  );

  return {
    baseUrl: baseUrl.value ?? DEFAULT_BASE_URL,
    speed: speed.value ?? "fast",
    signing: signing.value ?? true,
    minIntervalMs: minIntervalMs.value ?? DEFAULT_MIN_INTERVAL_MS,
    sources: {
      baseUrl: baseUrl.source,
      speed: speed.source,
      signing: signing.source,
      minIntervalMs: minIntervalMs.source,
    },
    projectFile,
    projectTrusted: trusted,
  };
}
