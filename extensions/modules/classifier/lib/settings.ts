// classifier settings — global agent dir only, same contract as pi-classifier:
// `classifier` section of ~/.pi/agent/settings.json (the Bearer key follows the
// ROUTER credential via the provider, never this file — nothing secret here).
//
//   "classifier": {
//     "model": "combo/jev",                      // empty/unset = first available
//     "permission": {
//       "enabled": true,                          // default on (owner decision)
//       "mode": "observe" | "enforce",            // default enforce
//       "threshold": 0.9                          // both nouls must clear it
//     }
//   }
//
// `planGate` in the file is left untouched (pi-plan's key; no consumer in
// ceulen until the pi-plan port).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ClassifierSettings {
  /** Model id on the router provider; empty = first available classifier model. */
  model: string;
  permission: {
    enabled: boolean;
    mode: "observe" | "enforce";
    threshold: number;
  };
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function settingsPath(): string {
  return join(agentDir(), "settings.json");
}

/** Read the `classifier` settings. Global only — these rows only ever REDUCE
 *  prompts; a repo file must not flip enforcement. Defaults match pi-classifier
 *  (enabled/enforce/0.9 since the 0.2.0 live audit). Exported for tests. */
export function getClassifierSettings(): ClassifierSettings {
  let raw: Record<string, unknown> = {};
  try {
    if (existsSync(settingsPath())) {
      raw = JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
    }
  } catch {
    raw = {}; // unreadable → defaults below
  }
  const c = raw.classifier && typeof raw.classifier === "object" ? (raw.classifier as Record<string, unknown>) : {};
  const perm = c.permission && typeof c.permission === "object" ? (c.permission as Record<string, unknown>) : {};
  return {
    model: typeof c.model === "string" ? c.model.trim() : "",
    permission: {
      // Explicit enabled:false wins; default ON per owner decision after a
      // 102-verdict live audit (0 dangerous approvals). No-op until the
      // router provider is configured: classify errors fall back to the prompt.
      enabled: perm.enabled !== false,
      mode: perm.mode === "observe" ? "observe" : "enforce",
      threshold: typeof perm.threshold === "number" && perm.threshold > 0 && perm.threshold < 1 ? perm.threshold : 0.9,
    },
  };
}

/** Read-modify-write non-secret `classifier` fields into the GLOBAL
 *  settings.json (merge, never clobber; atomic tmp+rename; a corrupt file
 *  refuses to clobber). Exported for tests. */
export function writeClassifierSection(patch: { model?: string; enabled?: boolean; mode?: "observe" | "enforce"; threshold?: number }): void {
  let settings: Record<string, unknown>;
  try {
    settings = existsSync(settingsPath())
      ? (JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>)
      : {};
  } catch {
    // Corrupt ≠ missing: writing here would replace the whole file with ONLY
    // the classifier section — bail instead.
    throw new Error(`${settingsPath()} is not valid JSON — fix or remove it before saving.`);
  }
  const c = (settings.classifier ?? {}) as Record<string, unknown>;
  const perm = (c.permission ?? {}) as Record<string, unknown>;
  if (patch.model !== undefined) c.model = String(patch.model).trim();
  if (patch.enabled !== undefined) perm.enabled = patch.enabled === true;
  if (patch.mode !== undefined) perm.mode = patch.mode === "enforce" ? "enforce" : "observe";
  if (patch.threshold !== undefined) {
    const t = Number(patch.threshold);
    perm.threshold = t > 0 && t < 1 ? t : 0.9;
  }
  c.permission = perm;
  settings.classifier = c;
  mkdirSync(dirname(settingsPath()), { recursive: true });
  const tmp = settingsPath() + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, settingsPath());
}
