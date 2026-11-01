// goal settings — the `goal` section of the GLOBAL agent-dir settings.json.
// Read per event so a /config save needs no /reload.
//
//   "goal": {
//     "maxTurns": 50,        // hard cap on autonomous continuation turns
//     "defaultBudget": 0     // 0 = unbounded; default token budget for new goals
//   }

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GoalSettings {
  maxTurns: number;
  /** 0 = unbounded (no default token budget). */
  defaultBudget: number;
}

export const DEFAULT_GOAL_SETTINGS: GoalSettings = { maxTurns: 50, defaultBudget: 0 };

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function globalSettingsPath(): string {
  return path.join(agentDir(), "settings.json");
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null; // unreadable/corrupt → this layer contributes nothing
  }
}

function section(json: Record<string, unknown> | null): Record<string, unknown> {
  const raw = json?.goal;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** Read-modify-write `goal` fields into the GLOBAL settings.json (merge, never
 *  clobber; atomic tmp+rename; a corrupt file refuses to clobber). Returns the
 *  written path. Exported for tests. */
export function writeGoalSection(patch: Partial<GoalSettings>): string {
  const file = globalSettingsPath();
  let settings: Record<string, unknown>;
  try {
    settings = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  } catch {
    // Corrupt ≠ missing: writing here would replace the whole file with ONLY
    // this section — refuse and let the caller surface the error.
    throw new Error(`settings.json is corrupt, refusing to write: ${file}`);
  }
  const next: Record<string, unknown> = { ...(settings.goal as Record<string, unknown> | undefined), ...patch };
  const merged: Record<string, unknown> = { ...settings, goal: next };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}

/** Effective goal settings: defaults ← global settings.json. */
export function readGoalSettings(): GoalSettings {
  const out: GoalSettings = { ...DEFAULT_GOAL_SETTINGS };
  const s = section(readJson(globalSettingsPath()));
  if (typeof s.maxTurns === "number" && Number.isInteger(s.maxTurns) && s.maxTurns > 0) out.maxTurns = s.maxTurns;
  if (typeof s.defaultBudget === "number" && Number.isInteger(s.defaultBudget) && s.defaultBudget >= 0) {
    out.defaultBudget = s.defaultBudget;
  }
  return out;
}
