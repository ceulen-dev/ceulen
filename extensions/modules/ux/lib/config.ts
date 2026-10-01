// ux — shared configuration resolver.
// ponytail: vendored from @bacnh85/pi-ux 0.6.6 (hooks/ux-config.js, CJS → ESM TS);
// hideStatus dropped — the ceulen ux module renders no status-bar segment.
//
// Resolution order for default mode:
//   1. PI_UX_DEFAULT_MODE environment variable
//   2. Config file defaultMode field (XDG_CONFIG_HOME/pi-ux/config.json)
//   3. 'strict'

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_MODE = "strict";
export const RUNTIME_MODES = ["off", "lite", "strict"] as const;

export type UxMode = (typeof RUNTIME_MODES)[number];

export function normalizeMode(mode: unknown): UxMode | null {
  if (typeof mode !== "string") return null;
  const normalized = mode.trim().toLowerCase();
  return (RUNTIME_MODES as readonly string[]).includes(normalized) ? (normalized as UxMode) : null;
}

export function isDeactivationCommand(text: unknown): boolean {
  const t = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[.!?\s]+$/, "");
  return t === "stop ux" || t === "normal mode";
}

function getConfigDir(): string {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "pi-ux");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "pi-ux");
  }
  return path.join(os.homedir(), ".config", "pi-ux");
}

function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

// Memoized read: one stat per call, re-parse only when path/mtime/size change.
// (Same pattern as ponytail-config's readConfig; keeps writeDefaultMode and
// test XDG swaps correct.)
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

export function getDefaultMode(): UxMode {
  const envMode = process.env.PI_UX_DEFAULT_MODE;
  if (envMode && (RUNTIME_MODES as readonly string[]).includes(envMode.toLowerCase())) {
    return envMode.toLowerCase() as UxMode;
  }
  const config = readConfig();
  const configMode = config.defaultMode;
  if (typeof configMode === "string" && (RUNTIME_MODES as readonly string[]).includes(configMode.toLowerCase())) {
    return configMode.toLowerCase() as UxMode;
  }
  return DEFAULT_MODE;
}

export function getQuietStartup(): boolean {
  return readConfigBool("PI_UX_QUIET_STARTUP", "quietStartup");
}

export function writeDefaultMode(mode: string): UxMode | null {
  const normalized = normalizeMode(mode);
  if (!normalized) return null;

  const config = readConfig();
  config.defaultMode = normalized;

  writeConfig(config);
  return normalized;
}

/** Merge boolean flags into the config file (read-modify-write; the memoized
 *  read cache is invalidated). quietStartup only — no hideStatus: the module
 *  renders no status-bar segment. */
export function writeConfigBools(patch: { quietStartup?: boolean }): void {
  const config = readConfig();
  if (patch.quietStartup !== undefined) config.quietStartup = patch.quietStartup;
  writeConfig(config);
}

function writeConfig(config: Record<string, unknown>): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  configCache = { path: null, mtimeMs: -1, size: -1, config: {} }; // force re-read
}
