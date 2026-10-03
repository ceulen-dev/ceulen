// The `web` settings layer: env-var-first resolution with a settings.json
// fallback, mirroring the munin/zai layering contract.
//
// Precedence (per var): per-call params (applied by the load*Config callers)
// > process.env (ceulen's bundle env.ts already ingests agent-dir + trusted-cwd
// .env* into process.env, so "env" here IS the full env chain)
// > trusted project `.pi/settings.json` `web` section > global agent-dir
// `settings.json` `web` section > built-in default.
//
// Read PER TOOL CALL — a /config save applies to the live session with no
// /reload. Secrets are never printed; callers disclose only presence + source.

import fs from "node:fs";
import path from "node:path";
import { agentDirs, isProjectTrusted } from "../../../lib/registry.js";

/** Env var → settings.json key inside the `web` section (path after "web."). */
export const ENV_TO_SETTINGS_KEY: Record<string, string> = {
  SEARXNG_BASE_URL: "searxng.baseUrl",
  BRAVE_API_KEY: "brave.apiKey",
  FIRECRAWL_API_URL: "firecrawl.baseUrl",
  FIRECRAWL_API_KEY: "firecrawl.apiKey",
  FIRECRAWL_TIMEOUT_MS: "firecrawl.timeoutMs",
  CRAWL4AI_API_URL: "crawl4ai.baseUrl",
  CRAWL4AI_API_TOKEN: "crawl4ai.apiToken",
  CRAWL4AI_API_TIMEOUT_MS: "crawl4ai.timeoutMs",
  GEMINI_WEB_SECURE_1PSID: "gemini.cookie",
  GEMINI_WEB_PROXY: "gemini.proxy",
  ZAI_API_KEY: "image.zaiKey",
  WEB_IMAGE_API_BASE_URL: "image.customUrl",
  WEB_IMAGE_API_KEY: "image.customKey",
  WEB_IMAGE_DAILY_CAP: "image.dailyCap",
  WEB_CHAT_API_BASE_URL: "chat.baseUrl",
  WEB_CHAT_API_KEY: "chat.apiKey",
};

export type WebSettings = Record<string, unknown>;

function readSection(file: string): WebSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const section = raw.web;
    return section && typeof section === "object" && !Array.isArray(section) ? (section as WebSettings) : {};
  } catch {
    return {}; // missing/unreadable/malformed → empty layer
  }
}

/** Effective settings values: global agent-dir `web` section overlaid per
 *  field by the trusted project's `.pi/settings.json` `web` section. */
export function readWebSettings(cwd = process.cwd(), trusted = isProjectTrusted(cwd)): WebSettings {
  const global = readSection(path.join(agentDirs()[0]!, "settings.json"));
  if (!trusted) return global;
  return { ...global, ...readSection(path.join(path.resolve(cwd), ".pi", "settings.json")) };
}

/** Read one value from a `web` section by settings key. Accepts BOTH the
 *  flat panel form (`"brave.apiKey"`) and a nested form (`brave.apiKey` as
 *  { brave: { apiKey } } path) so hand-written settings of either shape work. */
function sectionValue(section: WebSettings, key: string): unknown {
  if (key in section) return section[key];
  const parts = key.split(".");
  let cur: unknown = section;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Settings-layer value for one env var ("" when unset everywhere). */
function settingsValue(name: string, cwd: string, trusted: boolean): string {
  const key = ENV_TO_SETTINGS_KEY[name];
  if (!key) return "";
  const section = readWebSettings(cwd, trusted);
  const v = sectionValue(section, key);
  return v === undefined || v === null || v === "" ? "" : String(v);
}

/** Resolve one config variable: process.env first, then the settings layers.
 *  `source` mirrors the old findEnvValue vocabulary: "env" | "project
 *  settings" | "global settings" | "" (callers fall through to defaults). */
export function lookupVar(name: string, cwd = process.cwd(), includeCwd = false): { value?: string; source: string } {
  if (process.env[name]) return { value: process.env[name], source: "env" };
  const key = ENV_TO_SETTINGS_KEY[name] ?? "";
  const trusted = includeCwd && isProjectTrusted(path.resolve(cwd));
  if (trusted) {
    const v = sectionValue(readSection(path.join(path.resolve(cwd), ".pi", "settings.json")), key);
    if (v !== undefined && v !== null && v !== "") return { value: String(v), source: "project settings" };
  }
  const g = sectionValue(readSection(path.join(agentDirs()[0]!, "settings.json")), key);
  if (g !== undefined && g !== null && g !== "") return { value: String(g), source: "global settings" };
  return { value: undefined, source: "" };
}

/** Merge `patch` into the `web` section of `targetPath` (settings.json),
 *  atomically (tmp + rename). Undefined patch fields are skipped. Corrupt
 *  target refuses to clobber (same data-loss guard as writeDisabled). */
export function writeWebSection(patch: WebSettings, targetPath: string): void {
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(targetPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(targetPath, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`${targetPath} is not valid JSON — fix or remove it before saving.`);
    }
  }
  const web = { ...(settings.web as WebSettings | undefined ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === "") {
      delete web[k]; // cleared row = remove the key (default restored)
      deleteNestedPath(web, k);
    } else {
      web[k] = v; // flat panel key is the canonical written form
    }
  }
  pruneEmpty(web);
  if (Object.keys(web).length === 0) delete settings.web;
  else settings.web = web;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmp = targetPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, targetPath);
}

/** Recursively drop empty nested objects (a fully-cleared section must be
 *  removable — writeWebSection's `delete settings.web` only sees top level). */
function pruneEmpty(node: WebSettings): void {
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      pruneEmpty(v as WebSettings);
      if (Object.keys(v as WebSettings).length === 0) delete node[k];
    }
  }
}

/** Delete the nested path for a flat key (clears a hand-written nested entry). */
function deleteNestedPath(section: WebSettings, key: string): void {
  const parts = key.split(".");
  if (parts.length < 2) return;
  let cur = section as Record<string, unknown>;
  for (const p of parts.slice(0, -1)) {
    if (!cur[p] || typeof cur[p] !== "object") return;
    cur = cur[p] as Record<string, unknown>;
  }
  delete cur[parts[parts.length - 1]!];
}
