// plan settings — the `plan` section of the agent-dir settings.json, overlaid
// by a TRUSTED project `.pi/settings.json` `plan` section.
//
// Read per event (before_agent_start / tool_call) so a /config save needs no
// /reload; the trusted project file is only eligible when the repo is trusted.
//
//   "plan": {
//     "plansDir": ".pi/plans",     // default; {yyyymm} expands to the UTC month
//     "savePlans": "all",          // all | approved | none — which plans hit disk
//     "planModel": "",             // provider/id applied only in plan mode
//     "planThinking": "",          // thinking level applied only in plan mode
//     "autoApprove": false         // approve a written plan and execute without a keypress
//   }

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Which plans are written to disk. `all`: every write_plan persists;
 *  `approved`: drafts stay in memory, the file is written at approval;
 *  `none`: plans never touch disk. */
export type SavePlans = "all" | "approved" | "none";

export const SAVE_PLANS_VALUES: readonly SavePlans[] = ["all", "approved", "none"];

/** Thinking levels accepted for `plan.planThinking` (pi's level set). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

export interface PlanSettings {
  plansDir: string;
  savePlans: SavePlans;
  planModel: string;
  planThinking: string;
  autoApprove: boolean;
}

export const DEFAULT_PLANS_DIR = ".pi/plans";

export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  plansDir: DEFAULT_PLANS_DIR,
  savePlans: "all",
  planModel: "",
  planThinking: "",
  autoApprove: false,
};

/** Expanded plans dir (relative to the repo cwd). `{yyyymm}` is UTC-month. */
export function expandPlansDir(dir: string, d: Date = new Date()): string {
  return dir.replace("{yyyymm}", d.toISOString().slice(0, 7).replace("-", ""));
}

export function isSavePlans(value: unknown): value is SavePlans {
  return typeof value === "string" && (SAVE_PLANS_VALUES as readonly string[]).includes(value);
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function globalSettingsPath(): string {
  return path.join(agentDir(), "settings.json");
}

/** <cwd>/.pi/settings.json — the trusted project overlay. */
export function projectSettingsPath(cwd: string): string {
  return path.join(cwd, ".pi", "settings.json");
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
  const raw = json?.plan;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** Merge one settings layer's `plan` keys into out. */
function mergeLayer(out: PlanSettings, json: Record<string, unknown> | null): void {
  const s = section(json);
  if (typeof s.plansDir === "string" && s.plansDir.trim()) out.plansDir = s.plansDir.trim();
  if (isSavePlans(s.savePlans)) out.savePlans = s.savePlans;
  if (typeof s.planModel === "string") out.planModel = s.planModel.trim();
  if (typeof s.planThinking === "string") out.planThinking = s.planThinking.trim();
  if (typeof s.autoApprove === "boolean") out.autoApprove = s.autoApprove;
}

/** Effective plan settings: defaults ← global ← trusted project overlay. */
export function readPlanSettings(ctx?: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): PlanSettings {
  const out: PlanSettings = { ...DEFAULT_PLAN_SETTINGS };
  mergeLayer(out, readJson(globalSettingsPath()));
  try {
    if (ctx?.cwd && ctx.isProjectTrusted?.()) mergeLayer(out, readJson(projectSettingsPath(ctx.cwd)));
  } catch {
    /* untrusted or no ctx — global only */
  }
  return out;
}

/** Read-modify-write `plan` fields into the GLOBAL settings.json (merge, never
 *  clobber; atomic tmp+rename; a corrupt file refuses to clobber). Returns the
 *  written path. Exported for tests. */
export function writePlanSection(patch: Partial<PlanSettings>): string {
  const file = globalSettingsPath();
  let settings: Record<string, unknown>;
  try {
    settings = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  } catch {
    // Corrupt ≠ missing: writing here would replace the whole file with ONLY
    // the plan section — bail instead.
    throw new Error(`${file} is not valid JSON — fix or remove it before saving.`);
  }
  const s = (settings.plan ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    s[key] = typeof value === "string" ? value.trim() : value;
  }
  settings.plan = s;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/** True when a trusted project file carries its own `plan` section (the panel
 *  then discloses that those values override the global save). */
export function projectOverridesPlan(cwd: string, trusted: boolean): boolean {
  if (!trusted) return false;
  return Object.keys(section(readJson(projectSettingsPath(cwd)))).length > 0;
}

/** Resolved plan file path for a title under the configured dir. */
export function planPath(cwd: string, title: string, plansDir: string = DEFAULT_PLANS_DIR): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "plan";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(cwd, expandPlansDir(plansDir), `${stamp}-${slug}.md`);
}

/** True when `resolved` is a file inside the configured plans dir; a
 *  `{yyyymm}` pattern segment must match an actual 6-digit month segment
 *  (segment-wise — a bare wildcard splice would let ANY segment stand in). */
export function isInsidePlansDir(resolved: string, plansDir: string, cwd: string): boolean {
  const pattern = path.resolve(cwd, plansDir).split(/[\\/]/).filter(Boolean);
  const actual = path.resolve(cwd, resolved).split(/[\\/]/).filter(Boolean);
  if (actual.length <= pattern.length) return false;
  return pattern.every((seg, i) => (seg === "{yyyymm}" ? /^\d{6}$/.test(actual[i] ?? "") : actual[i] === seg));
}

/** Relative path with forward slashes (prompt text). */
export function relativeToCwd(cwd: string, absolutePath: string): string {
  return path.relative(cwd, absolutePath).split(path.sep).join("/");
}
