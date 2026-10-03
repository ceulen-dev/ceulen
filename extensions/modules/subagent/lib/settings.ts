// subagent module settings — the `subagent` section of the agent-dir
// settings.json (stable contract, like ponytail.*; pi-subagent settings carry
// over unchanged). Trusted project `.pi/settings.json` overlays read-only.
//
// Routing + timeout settings are read per execute() call, so /config saves
// apply live without /reload.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readSubagentRoles, type RolesConfig } from "./roles.ts";
import { DEFAULT_ROUTING, type RoutingSettings } from "./routing.ts";

export interface SubagentSettings {
  roles: RolesConfig;
  routing: RoutingSettings;
  /** Idle (hang-detection) window in minutes; 0 = env default. */
  idleTimeoutMins: number;
  /** Absolute lifetime cap in minutes; 0 = OFF (ceulen default). */
  hardTimeoutMins: number;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function section(json: Record<string, unknown> | null, key: string): Record<string, unknown> {
  const raw = json?.[key];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Merge one settings layer's `subagent` routing/timeout keys into out. */
function mergeLayer(out: SubagentSettings, json: Record<string, unknown> | null): void {
  const s = section(json, "subagent");
  const routing = section(s, "routing");
  if (routing.mode === "off" || routing.mode === "classify") out.routing.mode = routing.mode;
  if (typeof routing.model === "string") out.routing.model = routing.model.trim();
  if (typeof routing.threshold === "number" && Number.isFinite(routing.threshold)) {
    out.routing.threshold = Math.min(0.99, Math.max(0.1, routing.threshold));
  }
  out.idleTimeoutMins = num(s.idleTimeoutMins, out.idleTimeoutMins, 0, 60);
  out.hardTimeoutMins = num(s.hardTimeoutMins, out.hardTimeoutMins, 0, 60);
}

/**
 * Effective subagent settings: global agent-dir file ⊕ trusted project overlay.
 * Roles reuse roles.ts's own precedence (defaults → global → project → layered).
 */
export function readSubagentSettings(ctx?: ExtensionContext): SubagentSettings {
  const out: SubagentSettings = {
    roles: readSubagentRoles(ctx),
    routing: { ...DEFAULT_ROUTING },
    idleTimeoutMins: 0, // 0 = fall back to the env default (security.ts)
    hardTimeoutMins: 0, // 0 = cap OFF
  };
  mergeLayer(out, readJson(path.join(agentDir(), "settings.json")));
  try {
    if (ctx?.isProjectTrusted?.()) {
      mergeLayer(out, readJson(path.join(ctx.cwd, ".pi", "settings.json")));
    }
  } catch { /* untrusted or ctx without cwd — global only */ }
  return out;
}

/** Global-only variant for the /config working copy (advisor precedent). */
export function readSubagentSettingsGlobal(): SubagentSettings {
  const out: SubagentSettings = {
    roles: readSubagentRoles(ctx_global()),
    routing: { ...DEFAULT_ROUTING },
    idleTimeoutMins: 0,
    hardTimeoutMins: 0,
  };
  mergeLayer(out, readJson(path.join(agentDir(), "settings.json")));
  return out;
}

function ctx_global(): undefined {
  return undefined;
}

function settingsPath(): string {
  return path.join(agentDir(), "settings.json");
}
export { settingsPath };

/** Write routing/timeout keys back to the GLOBAL settings.json `subagent`
 *  section (roles are written by the config contribution via roles helpers).
 *  Atomic (tmp + rename); creates the file when missing. Returns the path. */
export function writeSubagentSection(patch: {
  routing?: RoutingSettings;
  roles?: Record<string, string | string[]>;
  idleTimeoutMins?: number;
  hardTimeoutMins?: number;
}): string {
  const file = settingsPath();
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`${file} is not valid JSON — fix or remove it before saving.`);
    }
  }
  const sub = (settings.subagent ?? {}) as Record<string, unknown>;
  if (patch.routing) {
    const routing = (sub.routing ?? {}) as Record<string, unknown>;
    routing.mode = patch.routing.mode;
    routing.model = patch.routing.model;
    routing.threshold = patch.routing.threshold;
    sub.routing = routing;
  }
  if (patch.idleTimeoutMins !== undefined) sub.idleTimeoutMins = patch.idleTimeoutMins;
  if (patch.hardTimeoutMins !== undefined) sub.hardTimeoutMins = patch.hardTimeoutMins;
  if (patch.roles) {
    // Role chains: pi-subagent's normalizeChain semantics — comma string or
    // array, empty entries dropped; empty chain deletes the role (falls back
    // to the built-in default).
    const roles = (sub.roles ?? {}) as Record<string, string | string[]>;
    for (const [name, value] of Object.entries(patch.roles)) {
      const chain = Array.isArray(value) ? value : String(value).split(",");
      const clean = chain.map((s) => s.trim()).filter(Boolean);
      if (clean.length > 0) roles[name] = clean;
      else delete roles[name];
    }
    sub.roles = roles;
  }
  settings.subagent = sub;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, file);
  return file;
}
