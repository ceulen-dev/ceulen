// repair module settings — the `repair` section of settings.json.
//
// Precedence (one file per layer, field-wise): defaults → global agent-dir
// settings.json → TRUSTED project `.pi/settings.json`. Read per tool call by
// index.ts, so a /config save applies to the next turn without /reload —
// exactly like subagent's read-per-execute() contract. The two bash keys
// (autoBg / autoBgSecs) are the exception: the wrapped bash description and
// the auto-background mechanics bind ONCE at module load, so those rows take
// effect on the next session.
//
// ponytail: the reader used to take a pi ExtensionContext, but every runtime
// call site lacked one at read time, leaving the trusted-project layer dead;
// cwd is the minimal honest input (pi's trust semantics come from
// lib/registry.js isProjectTrusted — the rule the other settings readers use).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isProjectTrusted } from "../../../lib/registry.js";

export interface RepairSettings {
  /** Schema-driven argument repair (invalid/truncated JSON, param aliases). */
  arguments: boolean;
  /** Edit mismatch repair: trim-tolerant retry + nearest-region + escalation. */
  editRetry: boolean;
  /** Destructive-bash + read-on-guessed-path guards. */
  guards: boolean;
  /** Refuse write/edit on auto-generated files (lockfiles, dist, min.js). */
  autoGenGuard: boolean;
  /** Auto-background long foreground bash calls. */
  autoBg: boolean;
  /** Foreground threshold (seconds) before auto-backgrounding. */
  autoBgSecs: number;
}

export const DEFAULT_REPAIR_SETTINGS: RepairSettings = {
  arguments: true,
  editRetry: true,
  guards: true,
  autoGenGuard: true,
  autoBg: false,
  autoBgSecs: 120,
};

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null; // unreadable/corrupt → this layer is simply absent
  }
}

function section(json: Record<string, unknown> | null, key: string): Record<string, unknown> {
  const raw = json?.[key];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** Merge one settings layer's `repair` keys over out (field-wise override). */
function mergeLayer(out: RepairSettings, json: Record<string, unknown> | null): void {
  const s = section(json, "repair");
  for (const key of ["arguments", "editRetry", "guards", "autoGenGuard", "autoBg"] as const) {
    if (typeof s[key] === "boolean") out[key] = s[key];
  }
  if (typeof s.autoBgSecs === "number" && Number.isFinite(s.autoBgSecs)) {
    // Clamp to ≥1: "0.5" would floor to 0 → a 0 ms timer = instant-background
    // everything (upstream's env reader clamped for the same reason).
    out.autoBgSecs = Math.max(1, Math.floor(s.autoBgSecs));
  }
}

/** The agent-dir settings.json (the file /config saves into). */
export function settingsPath(): string {
  return path.join(agentDir(), "settings.json");
}

/** Effective repair settings: global agent-dir file ⊕ trusted project overlay.
 *  `cwd` opts the caller into the project layer: only when <cwd> is TRUSTED
 *  does `<cwd>/.pi/settings.json` override the global file field-wise.
 *  Runtime call sites pass the execute/hook cwd; ctx-less calls (prepareArguments
 *  has none) read the global layer only. */
export function readRepairSettings(cwd?: string): RepairSettings {
  const out: RepairSettings = { ...DEFAULT_REPAIR_SETTINGS };
  mergeLayer(out, readJson(settingsPath()));
  if (cwd) {
    try {
      if (isProjectTrusted(cwd)) {
        mergeLayer(out, readJson(path.join(cwd, ".pi", "settings.json")));
      }
    } catch { /* untrusted or unreadable — global only */ }
  }
  return out;
}

/** True when a trusted project file carries a `repair` section (it then wins
 *  over any global save) — disclosed by the /config save and /repair status. */
export function projectShadow(cwd: string, trusted: boolean): boolean {
  if (!trusted) return false;
  return Object.keys(section(readJson(path.join(cwd, ".pi", "settings.json")), "repair")).length > 0;
}

/** Write the given keys back to the GLOBAL settings.json `repair` section.
 *  Atomic (tmp + rename); creates the file when missing. Returns the path. */
export function writeRepairSection(patch: Partial<RepairSettings>): string {
  const file = settingsPath();
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`${file} is not valid JSON — fix or remove it before saving.`);
    }
  }
  const repair = section(settings, "repair");
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) repair[key] = value;
  }
  settings.repair = repair;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}
