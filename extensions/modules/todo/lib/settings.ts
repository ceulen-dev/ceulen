// todo settings — the `todo` section of the GLOBAL agent-dir settings.json.
// ponytail: deliberately global-only (no trusted-project overlay) — a cosmetic
// preference; add the overlay only if a project genuinely needs it.
//
//   "todo": {
//     "lingerSecs": 60   // seconds the all-done HUD stays up; 0 = instant clear, -1 = never
//   }

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_LINGER_SECS = 60;

/** Closed set for the /config row (plan: values 0 / 60 / 300 / 900 / -1). */
export const LINGER_VALUES = ["0", "60", "300", "900", "-1"] as const;
export type LingerValue = (typeof LINGER_VALUES)[number];

export const LINGER_DESCRIPTIONS: Record<LingerValue, string> = {
  "0": "Instant — the HUD clears the moment the last phase completes",
  "60": "1 minute (default)",
  "300": "5 minutes",
  "900": "15 minutes",
  "-1": "Never auto-clears — /todo clear removes it",
};

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function globalSettingsPath(): string {
  return path.join(agentDir(), "settings.json");
}

/** Effective linger seconds: default ← global `todo.lingerSecs`. Unset/garbage
 *  → default. `allow` (the /config closed set) clamps the accepted values. */
export function readLingerSecs(): number {
  const file = globalSettingsPath();
  try {
    if (!existsSync(file)) return DEFAULT_LINGER_SECS;
    const raw = (JSON.parse(readFileSync(file, "utf8"))?.todo ?? {}) as { lingerSecs?: unknown };
    const n = typeof raw.lingerSecs === "string" ? parseInt(raw.lingerSecs, 10) : raw.lingerSecs;
    if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_LINGER_SECS;
    if (n === -1) return -1;
    if (n < 0) return DEFAULT_LINGER_SECS;
    // Out-of-set values are clamped into the closed set (nearest member).
    const allowed = [...LINGER_VALUES.map(Number), DEFAULT_LINGER_SECS].sort((a, b) => a - b);
    return allowed.reduce((best, v) => (Math.abs(v - n) < Math.abs(best - n) ? v : best));
  } catch {
    return DEFAULT_LINGER_SECS; // unreadable/corrupt → default
  }
}

/** Read-modify-write `todo.lingerSecs` into the GLOBAL settings.json (merge,
 *  never clobber; atomic tmp+rename; a corrupt file refuses to clobber).
 *  Returns the written path. Exported for tests. */
export function writeTodoSection(lingerSecs: number): string {
  const file = globalSettingsPath();
  let settings: Record<string, unknown>;
  try {
    settings = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`${file} is not valid JSON — fix or remove it before saving.`);
  }
  const s = (settings.todo ?? {}) as Record<string, unknown>;
  s.lingerSecs = lingerSecs;
  settings.todo = s;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}
