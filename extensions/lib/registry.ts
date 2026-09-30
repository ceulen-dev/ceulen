/**
 * ceulen module registry + shared settings access.
 *
 * Lives outside extensions/index.ts so the config module can iterate the
 * registry without a circular import (index imports the config module
 * statically; the config module imports this list).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PanelGroup } from "./panel.js";
import routerModule from "../modules/router/index.ts";
import { routerConfig } from "../modules/router/configPanel.ts";
import usageModule from "../modules/usage/index.ts";
import composerModule, { composerConfig } from "../modules/composer/index.ts";
import ponytailModule, { ponytailConfig } from "../modules/ponytail/index.ts";
import configModule from "../modules/config/index.ts";

/** A module's contribution to the central `/config` panel. */
export interface ModuleConfig {
  /** Panel groups over a fresh working copy; called once per /config open.
   *  Row keys MUST be prefixed `<module>.` so editedKeys route to the owner. */
  groups: () => PanelGroup[];
  /** Persist + apply. Only called when an owned key was edited. */
  save: (edited: Set<string>, ctx: ExtensionContext) => Promise<void>;
}

/** Per-load dependencies handed to a module factory (second arg). Only the
 *  config module reads it: the map holds one config-contribution factory per
 *  enabled module, each closing over THAT module's guarded pi — so a runtime
 *  re-registration (router's provider) stays the owner's claim, never config's. */
export interface ModuleLoadDeps {
  configContribs: Map<string, () => ModuleConfig>;
}

export interface ModuleEntry {
  name: string;
  /** Core modules are always loaded — the kill-switch can't disable them and
   *  /config shows no Enable row (composer owns the editor surface: a
   *  half-configured composer is worse than none). */
  core?: boolean;
  /** OMP-taxonomy tab the module's /config sections live in — the single
   *  source for tab placement, synthesized Enable-only sections, and /ceulen
   *  status grouping (the {section, icon} pretty-names stay in the config
   *  module's local map). */
  category: string;
  /** One-line module purpose — rendered as the kill-switch row's description
   *  and reused by /ceulen status output. */
  describe?: string;
  load: (pi: ExtensionAPI, deps?: ModuleLoadDeps) => void;
  /** Central-config contribution factory, called with the module's OWN guarded
   *  pi once per /config open. Optional — purely additive. */
  config?: (pi: ExtensionAPI) => ModuleConfig;
}

// ponytail: module registry grows by append — one object per module, loader
// stays ~10 lines forever, no plugin framework
export const MODULES: ModuleEntry[] = [
  // ── Providers ──────────────────────────────────────────────────────────
  // Router first: usage reads the `router` provider for usage display.
  { name: "router", category: "Providers", describe: "Route requests to a yardmaster/OmniRoute endpoint and expose its models.", load: routerModule, config: routerConfig },
  // ── Appearance ─────────────────────────────────────────────────────────
  { name: "usage", category: "Appearance", describe: "Subscription-usage footer (5h/weekly/monthly windows + credits).", load: usageModule },
  { name: "composer", core: true, category: "Appearance", describe: "Composer shape for the input editor — pick one in /config with a live preview. Core: always on.", load: composerModule, config: composerConfig },
  // ── Tasks ──────────────────────────────────────────────────────────────
  { name: "ponytail", category: "Tasks", describe: "Lazy-senior-dev mode: prompts, status, skills, subagent instructions.", load: ponytailModule, config: ponytailConfig },
  // ── Plugins ────────────────────────────────────────────────────────────
  // Config last: it owns /config and reads the contrib map.
  { name: "config", category: "Plugins", describe: "This panel — /config central settings for every module.", load: configModule },
];

// ── Kill-switch settings ─────────────────────────────────────────────────────

/** True when the module is core (always loaded, never kill-switchable). */
export function isCore(name: string): boolean {
  return MODULES.some((m) => m.name === name && m.core === true);
}

/** Candidate settings files in read precedence: trusted project scope first
 *  (when trusted), then agent dirs. */
function settingsCandidates(cwd = process.cwd()): string[] {
  return [
    ...(isProjectTrusted(cwd) ? [path.join(cwd, ".pi", "settings.json")] : []),
    ...agentDirs().map((d) => path.join(d, "settings.json")),
  ];
}

export function agentDirs(): string[] {
  return process.env.PI_CODING_AGENT_DIR
    ? [process.env.PI_CODING_AGENT_DIR]
    : [path.join(os.homedir(), ".pi", "agent"), path.join(os.homedir(), ".pi", "agents")];
}

/** The file `readDisabled`/`writeDisabled` resolve: the first candidate that
 *  exists and carries a `ceulen` section (a project file configuring only other
 *  keys must not shadow the kill-switch). Falls back to the agent-dir file
 *  (`~/.pi/agent/settings.json`), the documented home for `ceulen.disabled`,
 *  when no file claims it. */
export function disabledSource(cwd = process.cwd()): { path: string; isProject: boolean } {
  const projectPath = path.join(cwd, ".pi", "settings.json");
  for (const file of settingsCandidates(cwd)) {
    if (!existsSync(file)) continue;
    try {
      const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (json && typeof json.ceulen === "object" && json.ceulen !== null) {
        return { path: file, isProject: file === projectPath };
      }
    } catch {
      // malformed → not claiming (readDisabled falls back the same way)
    }
  }
  return { path: path.join(agentDirs()[0]!, "settings.json"), isProject: false };
}

/** Read the `ceulen.disabled` module list. The project scope is only eligible
 *  when trusted (an untrusted checkout must not re-enable or disable modules).
 *  Resolves through `disabledSource` — the same file `writeDisabled` targets. */
export function readDisabled(cwd = process.cwd()): string[] {
  const { path: file } = disabledSource(cwd);
  if (!existsSync(file)) return [];
  try {
    const raw = (JSON.parse(readFileSync(file, "utf8"))?.ceulen ?? {}) as { disabled?: unknown };
    if (!Array.isArray(raw.disabled)) return [];
    // ponytail: deprecated "sub" alias — the module was renamed to "usage"; drop when no settings ship it
    // Core modules are never disableable — a stale/foreign entry is ignored.
    return raw.disabled
      .map((n) => (n === "sub" ? "usage" : n))
      .filter((n): n is string => typeof n === "string" && !isCore(n));
  } catch {
    return []; // malformed → defaults (all modules on)
  }
}

/** Write `ceulen.disabled` into the SAME file readDisabled resolves, so a
 *  toggle can never be shadowed by a project-level section. Atomic (tmp +
 *  rename); a corrupt file refuses to clobber (same data-loss guard as
 *  writeRouterSection). Returns the written path for the caller's disclosure. */
export function writeDisabled(list: string[], cwd = process.cwd()): string {
  const { path: file } = disabledSource(cwd);
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`${file} is not valid JSON — fix or remove it before saving.`);
    }
  }
  const ceulen = (settings.ceulen ?? {}) as Record<string, unknown>;
  ceulen.disabled = list.filter((n) => !isCore(n));
  settings.ceulen = ceulen;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/** Project trust: read <agentDir>/trust.json ({ "<path>": true|false }),
 *  walking up the tree like pi's ProjectTrustStore. Unreadable/absent →
 *  false (fail closed). */
export function isProjectTrusted(cwd: string, dirs: string[] = agentDirs()): boolean {
  let current = path.resolve(cwd);
  for (const dir of dirs) {
    const file = path.join(dir, "trust.json");
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      for (;;) {
        const v = data[current];
        if (typeof v === "boolean") return v;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    } catch {
      return false;
    }
  }
  return false;
}
