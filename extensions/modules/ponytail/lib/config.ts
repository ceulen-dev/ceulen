// ponytail — shared configuration resolver
//
// Resolution order for default mode:
//   1. PONYTAIL_DEFAULT_MODE environment variable
//   2. Config file defaultMode field (XDG_CONFIG_HOME/ponytail/config.json)
//   3. 'full'
//
// Ported from pi-ponytail hooks/ponytail-config.js (CJS → ESM TS).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_MODE = "full";
export const VALID_MODES = ["off", "lite", "full", "ultra", "review"] as const;
export const RUNTIME_MODES = ["off", "lite", "full", "ultra"] as const;

export type RuntimeMode = (typeof RUNTIME_MODES)[number];
export type PonytailMode = (typeof VALID_MODES)[number];

export function normalizeMode(mode: unknown): RuntimeMode | null {
  if (typeof mode !== "string") return null;
  const normalized = mode.trim().toLowerCase();
  return (RUNTIME_MODES as readonly string[]).includes(normalized) ? (normalized as RuntimeMode) : null;
}

export function normalizePersistedMode(mode: unknown): PonytailMode | null {
  if (typeof mode !== "string") return null;
  const n = mode.trim().toLowerCase();
  return normalizeMode(n) || ((VALID_MODES as readonly string[]).includes(n) ? (n as PonytailMode) : null);
}

export function isDeactivationCommand(text: unknown): boolean {
  const t = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[.!?\s]+$/, "");
  return t === "stop ponytail" || t === "normal mode";
}

function getConfigDir(): string {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "ponytail");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "ponytail");
  }
  return path.join(os.homedir(), ".config", "ponytail");
}

function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

// Memoized read: one stat per call, re-parse only when path/mtime/size change.
// ponytail: stat-per-call keeps writeDefaultMode and test XDG swaps correct;
// drop the stat if profiling ever shows it matters.
let configCache: { path: string | null; mtimeMs: number; size: number; config: Record<string, unknown> } = {
  path: null,
  mtimeMs: -1,
  size: -1,
  config: {},
};

function readConfig(): Record<string, unknown> {
  const configPath = getConfigPath();
  let st: fs.Stats;
  try {
    st = fs.statSync(configPath);
    if (configCache.path === configPath && configCache.mtimeMs === st.mtimeMs && configCache.size === st.size) {
      return configCache.config;
    }
  } catch {
    // Missing/unreadable file → empty config; cache it for this path.
    if (configCache.path === configPath && configCache.mtimeMs === -1) {
      return configCache.config;
    }
    configCache = { path: configPath, mtimeMs: -1, size: -1, config: {} };
    return configCache.config;
  }
  let config: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") config = parsed as Record<string, unknown>;
  } catch {
    // Malformed config → empty
  }
  configCache = { path: configPath, mtimeMs: st.mtimeMs, size: st.size, config };
  return config;
}

function readConfigBool(envVar: string, configKey: string): boolean {
  const env = process.env[envVar];
  if (env !== undefined) {
    const v = env.trim().toLowerCase();
    return v !== "" && v !== "0" && v !== "false" && v !== "no";
  }
  return readConfig()[configKey] === true;
}

export function getDefaultMode(): RuntimeMode {
  const envMode = process.env.PONYTAIL_DEFAULT_MODE;
  // ponytail: a default must be a runtime level (off/lite/full/ultra)
  if (envMode && (RUNTIME_MODES as readonly string[]).includes(envMode.toLowerCase())) {
    return envMode.toLowerCase() as RuntimeMode;
  }
  const config = readConfig();
  const configMode = config.defaultMode;
  if (typeof configMode === "string" && (RUNTIME_MODES as readonly string[]).includes(configMode.toLowerCase())) {
    return configMode.toLowerCase() as RuntimeMode;
  }
  return DEFAULT_MODE;
}

export function getQuietStartup(): boolean {
  return readConfigBool("PONYTAIL_QUIET_STARTUP", "quietStartup");
}

export function getHideStatus(): boolean {
  return readConfigBool("PONYTAIL_HIDE_STATUS", "hideStatus");
}

export function writeDefaultMode(mode: string): RuntimeMode | null {
  const normalized = normalizeMode(mode);
  if (!normalized) return null;

  const config = readConfig();
  config.defaultMode = normalized;

  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  configCache = { path: null, mtimeMs: -1, size: -1, config: {} }; // force re-read
  return normalized;
}
