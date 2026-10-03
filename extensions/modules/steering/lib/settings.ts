// steering settings — the `steering` section of the agent-dir settings.json,
// overlaid by a TRUSTED project `.pi/settings.json` `steering` section.
//
// Read per turn (before_agent_start) so a /config save needs no /reload; the
// trusted project file is only eligible when the repo is trusted (an untrusted
// checkout must not be able to steer prompts). pi-model-tools' PI_MODEL_TOOLS_*
// env knobs are gone — every one of them is a row here.
//
//   "steering": {
//     "firstToolHints": true,      // prompt-aware bash/find/clone-first hints
//     "selectionGuidance": true,   // DeepSeek V4 routing table (system prompt)
//     "superpower": false,         // DeepSeek V4 Super Power prompt
//     "superpowerPrompt": "",      // custom text; empty = built-in
//     "strictSerena": false,       // escalate dedicated-tool misses to a block
//     "stripReasoning": true,      // drop accumulated reasoning_content
//     "dsAnchor": true,            // deepseek-v4-pro minimal-mode bootstrap
//     "weNeed": false              // A/B: "We need…" bootstrap directive
//   }

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SteeringSettings {
  firstToolHints: boolean;
  selectionGuidance: boolean;
  superpower: boolean;
  /** Custom Super Power prompt; empty = the built-in base prompt. */
  superpowerPrompt: string;
  strictSerena: boolean;
  stripReasoning: boolean;
  dsAnchor: boolean;
  weNeed: boolean;
}

export const DEFAULT_STEERING_SETTINGS: SteeringSettings = {
  firstToolHints: true,
  selectionGuidance: true,
  superpower: false,
  superpowerPrompt: "",
  strictSerena: false,
  stripReasoning: true,
  dsAnchor: true,
  weNeed: false,
};

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
  const raw = json?.steering;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** Merge one settings layer's `steering` keys into out. */
function mergeLayer(out: SteeringSettings, json: Record<string, unknown> | null): void {
  const s = section(json);
  for (const key of ["firstToolHints", "selectionGuidance", "superpower", "strictSerena", "stripReasoning", "dsAnchor", "weNeed"] as const) {
    if (typeof s[key] === "boolean") out[key] = s[key] as boolean;
  }
  if (typeof s.superpowerPrompt === "string") out.superpowerPrompt = s.superpowerPrompt.trim();
}

/** Effective steering settings: defaults ← global ← trusted project overlay. */
export function readSteeringSettings(ctx?: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): SteeringSettings {
  const out: SteeringSettings = { ...DEFAULT_STEERING_SETTINGS };
  mergeLayer(out, readJson(globalSettingsPath()));
  try {
    if (ctx?.cwd && ctx.isProjectTrusted?.()) mergeLayer(out, readJson(projectSettingsPath(ctx.cwd)));
  } catch {
    /* untrusted or no ctx — global only */
  }
  return out;
}

/** Read-modify-write `steering` fields into the GLOBAL settings.json (merge,
 *  never clobber; atomic tmp+rename; a corrupt file refuses to clobber).
 *  Returns the written path. Exported for tests. */
export function writeSteeringSection(patch: Partial<SteeringSettings>): string {
  const file = globalSettingsPath();
  let settings: Record<string, unknown>;
  try {
    settings = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  } catch {
    // Corrupt ≠ missing: writing here would replace the whole file with ONLY
    // the steering section — bail instead.
    throw new Error(`${file} is not valid JSON — fix or remove it before saving.`);
  }
  const s = (settings.steering ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    s[key] = typeof value === "string" ? value.trim() : value;
  }
  settings.steering = s;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/** True when a trusted project file carries its own `steering` section (the
 *  panel then discloses that those values override the global save). */
export function projectOverridesSteering(cwd: string, trusted: boolean): boolean {
  if (!trusted) return false;
  return Object.keys(section(readJson(projectSettingsPath(cwd)))).length > 0;
}
