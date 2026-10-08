// rtk settings — global agent dir only (`rtk` section), read per bash call so
// a /config save applies without /reload:
//
//   "rtk": {
//     "mode": "supported-only" | "off",          // off = kill switch (session-scoped; RTK_DISABLED=1 stays the env-level bypass)
//     "chained": "never" | "only-all-modeled"    // never = skip the rewrite spawn entirely for chain-bearing commands
//   }
//
// No write side needs env precedence — these are switches, not secrets, and a
// repo file must not change how the model's commands execute (global only).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RtkSettings {
  mode: "supported-only" | "off";
  chained: "never" | "only-all-modeled";
}

function settingsPath(): string {
  const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(dir, "settings.json");
}

/** Read the `rtk` settings; unknown values fall back to the defaults
 *  (supported-only + only-all-modeled = rewrite single modeled commands,
 *  let rtk's own fail-open decide chains). Exported for tests. */
export function readRtkSettings(): RtkSettings {
  let raw: Record<string, unknown> = {};
  try {
    if (existsSync(settingsPath())) {
      raw = JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
    }
  } catch {
    raw = {}; // unreadable → defaults below
  }
  const c = raw.rtk && typeof raw.rtk === "object" ? (raw.rtk as Record<string, unknown>) : {};
  return {
    mode: c.mode === "off" ? "off" : "supported-only",
    chained: c.chained === "never" ? "never" : "only-all-modeled",
  };
}

/** Read-modify-write non-secret `rtk` fields into the GLOBAL settings.json
 *  (merge, never clobber; atomic tmp+rename; a corrupt file refuses to
 *  clobber). Exported for tests / the config panel. */
export function writeRtkSection(patch: { mode?: "supported-only" | "off"; chained?: "never" | "only-all-modeled" }): void {
  let settings: Record<string, unknown>;
  try {
    settings = existsSync(settingsPath())
      ? (JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>)
      : {};
  } catch {
    throw new Error(`${settingsPath()} is not valid JSON — fix or remove it before saving.`);
  }
  const c = (settings.rtk ?? {}) as Record<string, unknown>;
  if (patch.mode !== undefined) c.mode = patch.mode;
  if (patch.chained !== undefined) c.chained = patch.chained;
  settings.rtk = c;
  mkdirSync(dirname(settingsPath()), { recursive: true });
  const tmp = settingsPath() + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, settingsPath());
}
