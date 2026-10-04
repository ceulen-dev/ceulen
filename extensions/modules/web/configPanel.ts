// web's /config contribution — Tools tab, Web section (icon 🌍).
//
// The 16 provider rows over the `web` settings section (global agent-dir
// settings.json; a trusted project `.pi/settings.json` `web` section shadows
// per field; env vars win over both — see lib/settings.ts lookupVar). The
// Enable row + 11 tool toggle rows are prepended/appended by the config
// module automatically (withEnableRow/withToolRows over the registry entry).
// Config is read PER TOOL CALL, so a save applies to the live session with
// no /reload.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { row, type PanelGroup } from "../../lib/panel.js";
import type { ModuleConfig } from "../../lib/registry.js";
import { agentDirs } from "../../lib/registry.js";
import { findEnvValue } from "./lib/config.js";
import {
  DEFAULT_SEARXNG_BASE_URL,
  DEFAULT_CRAWL4AI_API_URL,
  HOSTED_FIRECRAWL_BASE_URL,
} from "./lib/config.js";
import {
  ENV_TO_SETTINGS_KEY,
  readProjectWebSection,
  sectionValue,
  writeWebSection,
} from "./lib/settings.js";

/** One row's definition: settings key, label, effective value, default. */
interface WebRowSpec {
  key: string; // after "web."
  label: string;
  envVar: string;
  kind: "string" | "number";
  mask?: boolean;
  defaultValue?: string;
  description: string;
  secret?: boolean;
  /** Closed set (Enter opens the submenu) — used for timeouts so an invalid
   *  value can't brick a tool (pi-web's loaders require an integer >= 1000). */
  allow?: readonly string[];
}

// OMP-parity labelled timeout options (providers.webSearchTimeoutSeconds).
const TIMEOUT_VALUES = ["15000", "30000", "60000", "120000", "300000"] as const;
const TIMEOUT_DESCRIPTIONS: Record<string, string> = {
  "15000": "15 seconds — snappy, fails fast on slow backends",
  "30000": "30 seconds",
  "60000": "1 minute (default)",
  "120000": "2 minutes",
  "300000": "5 minutes — slow/self-hosted backends",
};

// Lazy: reading lib/config constants at module top level would TDZ on the
// registry → configPanel → lib/config → settings → registry cycle.
function webRowSpecs(): WebRowSpec[] {
  return [
  // ── Search ──────────────────────────────────────────────────────────
  { key: "searxng.baseUrl", label: "SearXNG base URL", envVar: "SEARXNG_BASE_URL", kind: "string", defaultValue: DEFAULT_SEARXNG_BASE_URL,
    description: "Self-hosted SearXNG instance for web_search (broad discovery backend). SEARXNG_BASE_URL env overrides." },
  { key: "brave.apiKey", label: "Brave API key", envVar: "BRAVE_API_KEY", kind: "string", mask: true, secret: true,
    description: "Brave Search API key — the precision backend (site:/quotes/docs). BRAVE_API_KEY env overrides." },
  // ── Firecrawl ───────────────────────────────────────────────────────
  { key: "firecrawl.baseUrl", label: "Firecrawl URL", envVar: "FIRECRAWL_API_URL", kind: "string", defaultValue: HOSTED_FIRECRAWL_BASE_URL,
    description: "Self-hosted or hosted Firecrawl API (search/scrape/crawl/map). FIRECRAWL_API_URL env overrides." },
  { key: "firecrawl.apiKey", label: "Firecrawl API key", envVar: "FIRECRAWL_API_KEY", kind: "string", mask: true, secret: true,
    description: "Required for hosted Firecrawl; optional for self-hosted. FIRECRAWL_API_KEY env overrides." },
  { key: "firecrawl.timeoutMs", label: "Firecrawl timeout", envVar: "FIRECRAWL_TIMEOUT_MS", kind: "number", defaultValue: "60000", allow: TIMEOUT_VALUES,
    description: "Firecrawl request timeout (integer ms >= 1000). FIRECRAWL_TIMEOUT_MS env overrides." },
  // ── Crawl4AI ────────────────────────────────────────────────────────
  { key: "crawl4ai.baseUrl", label: "Crawl4AI URL", envVar: "CRAWL4AI_API_URL", kind: "string", defaultValue: DEFAULT_CRAWL4AI_API_URL,
    description: "Crawl4AI Docker API for full extraction, crawl, screenshot, PDF. CRAWL4AI_API_URL env overrides." },
  { key: "crawl4ai.apiToken", label: "Crawl4AI token", envVar: "CRAWL4AI_API_TOKEN", kind: "string", mask: true, secret: true,
    description: "Required if Crawl4AI auth is enabled (v0.9+ default config). CRAWL4AI_API_TOKEN env overrides." },
  { key: "crawl4ai.timeoutMs", label: "Crawl4AI timeout", envVar: "CRAWL4AI_API_TIMEOUT_MS", kind: "number", defaultValue: "60000", allow: TIMEOUT_VALUES,
    description: "Crawl4AI request timeout (integer ms >= 1000). CRAWL4AI_API_TIMEOUT_MS env overrides." },
  // ── Gemini web ──────────────────────────────────────────────────────
  { key: "gemini.cookie", label: "Gemini web cookie", envVar: "GEMINI_WEB_SECURE_1PSID", kind: "string", mask: true, secret: true,
    description: "__Secure-1PSID from a fresh incognito gemini.google.com login — enables authed web_research (Deep Research). GEMINI_WEB_SECURE_1PSID env overrides; keep the source browser session closed." },
  { key: "gemini.proxy", label: "Gemini web proxy", envVar: "GEMINI_WEB_PROXY", kind: "string",
    description: "Proxy URL for Gemini web calls if Google blocks the IP. GEMINI_WEB_PROXY env overrides." },
  // ── Image ───────────────────────────────────────────────────────────
  { key: "image.zaiKey", label: "Z.ai image key", envVar: "ZAI_API_KEY", kind: "string", mask: true, secret: true,
    description: "Z.ai API key for the web_image GLM-Image provider (distinct from the zai module's ZAI_ANTHROPIC_API_KEY). ZAI_API_KEY env overrides." },
  { key: "image.customUrl", label: "Custom image URL", envVar: "WEB_IMAGE_API_BASE_URL", kind: "string",
    description: "web_image custom provider: any OpenAI-compatible /images/generations endpoint. WEB_IMAGE_API_BASE_URL env overrides." },
  { key: "image.customKey", label: "Custom image key", envVar: "WEB_IMAGE_API_KEY", kind: "string", mask: true, secret: true,
    description: "Bearer key for the custom image endpoint. WEB_IMAGE_API_KEY env overrides." },
  { key: "image.dailyCap", label: "Web image daily cap", envVar: "WEB_IMAGE_DAILY_CAP", kind: "number", defaultValue: "20",
    description: "Daily soft cap for the Gemini web tier and ChatGPT web image providers (keyed APIs stay uncapped). WEB_IMAGE_DAILY_CAP env overrides." },
  // ── Chat ────────────────────────────────────────────────────────────
  { key: "chat.baseUrl", label: "Web chat gateway URL", envVar: "WEB_CHAT_API_BASE_URL", kind: "string",
    description: "web_chat gateway: any OpenAI-compatible /chat/completions endpoint. WEB_CHAT_API_BASE_URL env overrides." },
  { key: "chat.apiKey", label: "Web chat gateway key", envVar: "WEB_CHAT_API_KEY", kind: "string", mask: true, secret: true,
    description: "Bearer key for the web_chat gateway. WEB_CHAT_API_KEY env overrides." },
  ];
}

/** Effective row values for the panel's working copy: env wins over settings
 *  (what the tools actually resolve), settings shown when env is unset.
 *  Exported for tests. */
export function readWebRowValues(cwd: string, trusted: boolean): Record<string, { value: string; source: string }> {
  const out: Record<string, { value: string; source: string }> = {};
  for (const spec of webRowSpecs()) {
    // findEnvValue == lookupVar: env → settings layers in one call, with the
    // source disclosing which layer served ("env" | "project settings" |
    // "global settings"), so the panel shows exactly what the tools resolve.
    const r = findEnvValue(spec.envVar, cwd, trusted);
    out[spec.key] = r.value ? { value: r.value, source: r.source } : { value: "", source: "default" };
  }
  return out;
}

/** Build the web panel group over a working copy (mutated by row setters).
 *  Exported for tests. */
export function buildWebGroups(working: Record<string, string>): PanelGroup[] {
  return [
    {
      key: "web",
      label: "Web",
      tab: "Tools",
      icon: "🌍",
      rows: webRowSpecs().map((spec) =>
        row(
          `web.${spec.key}`,
          spec.label,
          spec.kind,
          working[spec.key] ?? "",
          (v) => {
            working[spec.key] = v === undefined || v === null ? "" : String(v).trim();
          },
          {
            ...(spec.mask ? { mask: true } : {}),
            ...(spec.defaultValue !== undefined ? { defaultValue: spec.defaultValue } : {}),
            ...(spec.allow ? {
              menu: () => spec.allow!.map((v) => ({ value: v, label: `${Number(v) / 1000} seconds`, description: TIMEOUT_DESCRIPTIONS[v] })),
            } : {}),
            description: spec.description,
            ...(spec.secret
              ? { warning: "Stored in the settings file — prefer the env var on shared machines." }
              : {}),
          },
        ),
      ),
    },
  ];
}

const OWNED_PREFIX = "web.";

/** The save patch for the rows edited since the pre-edit snapshot. Number rows
 *  persist as numbers (timeoutMs semantics), strings as strings, and an empty
 *  string clears the key (writeWebSection semantics). Free text that is not a
 *  finite number is SKIPPED — writing 0 would clobber the stored cap with a
 *  value the consumer then clamps (or bricks the timeout loaders). Exported
 *  for tests. */
export function diffWebPatch(
  working: Record<string, string>,
  before: Record<string, string>,
): Record<string, string | number> {
  const patch: Record<string, string | number> = {};
  for (const spec of webRowSpecs()) {
    if (working[spec.key] === before[spec.key]) continue;
    const raw = working[spec.key] ?? "";
    if (spec.kind === "number" && raw !== "") {
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n)) continue; // garbage → leave the stored value alone
      patch[spec.key] = n;
    } else {
      patch[spec.key] = raw;
    }
  }
  return patch;
}

/** web's ModuleConfig for the central /config panel. cwd/trust come from the
 *  save ctx (factories receive none); reads use process.cwd(), matching
 *  munin's panel pattern. */
export function webConfig(): ModuleConfig {
  const read = () => {
    const values = readWebRowValues(process.cwd(), true);
    return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.value]));
  };
  const before = read();
  const working = structuredClone(before);

  return {
    groups: () => buildWebGroups(working),
    save: async (edited, ctx) => {
      if (![...edited].some((k) => k.startsWith(OWNED_PREFIX))) return;
      const target = `${agentDirs()[0]}${"/"}settings.json`;
      // Diff against the pre-edit effective values: only changed keys are
      // written (masked rows start empty — an untouched masked row diffs to
      // no change).
      const patch = diffWebPatch(working, before);
      writeWebSection(patch, target);
      const notes = [`Web config saved to ${target} — effective immediately (read per tool call).`];
      // Disclose env vars that still override saved values, and a trusted
      // project file that shadows a field.
      const envOverrides = webRowSpecs().filter((s) => patch[s.key] !== undefined && process.env[s.envVar]).map((s) => s.envVar);
      if (envOverrides.length) notes.push(`Still overridden by env: ${envOverrides.join(", ")}.`);
      // Resolve through the SAME lookup the runtime uses, so a hand-written
      // NESTED project entry (web.brave.apiKey as {brave:{apiKey}}) is
      // disclosed instead of shadowing the save silently. The PROJECT layer
      // alone — a merged read reports the just-written global key as a shadow.
      const shadowed = ctx.isProjectTrusted?.() === true
        ? Object.keys(patch).filter((k) => {
            const v = sectionValue(readProjectWebSection(ctx.cwd), k);
            return v !== undefined && v !== null && v !== "";
          })
        : [];
      if (shadowed.length) notes.push(`A trusted project .pi/settings.json web section shadows: ${shadowed.join(", ")}.`);
      ctx.ui.notify(notes.join(" "), "info");
    },
  };
}

/** Exposed for tests + the module's own status surfaces. */
export { ENV_TO_SETTINGS_KEY };
