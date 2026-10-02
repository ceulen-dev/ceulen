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
import classifierModule from "../modules/classifier/index.ts";
import { classifierConfig } from "../modules/classifier/configPanel.js";
import advisorModule from "../modules/advisor/index.ts";
import { advisorConfig } from "../modules/advisor/configPanel.js";
import usageModule from "../modules/usage/index.ts";
import composerModule, { composerConfig } from "../modules/composer/index.ts";
import ponytailModule, { ponytailConfig } from "../modules/ponytail/index.ts";
import uxModule, { uxConfig } from "../modules/ux/index.ts";
import serenaModule from "../modules/serena/index.ts";
import fffModule from "../modules/fff/index.ts";
import rtkModule from "../modules/rtk/index.ts";
import muninModule from "../modules/munin/index.ts";
import { muninConfig } from "../modules/munin/configPanel.ts";
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
   *  /config shows no Enable row. Core is for modules with no meaningful
   *  half-state: composer owns the editor surface, advisor's off-switch is its
   *  model chain, usage reads the router provider, and the settings panel
   *  itself (config) must stay reachable. */
  core?: boolean;
  /** OMP-taxonomy tab the module's /config sections live in — the single
   *  source for tab placement, synthesized Enable-only sections, and /ceulen
   *  status grouping (the {section, icon} pretty-names stay in the config
   *  module's local map). */
  category: string;
  /** One-line module purpose — rendered as the kill-switch row's description
   *  and reused by /ceulen status output. */
  describe?: string;
  /** Canonical tool names the module registers — drives the per-tool
   *  enable/disable toggle rows in /config (ceulen.disabledTools). */
  tools?: string[];
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
  // CORE: usage depends on the router provider — a switch that can empty the
  // catalogue out from under usage is a footgun, so the provider is always on.
  { name: "router", core: true, category: "Providers", describe: "Route requests to a yardmaster/OmniRoute endpoint and expose its models.", load: routerModule, config: routerConfig },
  // Classifier right after router: its classify tool resolves decision models
  // from the router provider's registry catalog (needs router registered, not
  // the module object itself — order is for /config grouping readability).
  { name: "classifier", core: true, category: "Model", describe: "System One decision models (Jev): classify tool + bash permission auto-approve, via router-discovered models.", load: classifierModule, config: classifierConfig, tools: ["classify"] },
  // Advisor right after classifier: second-model reviewer (turn-end notes +
  // the on-demand `advisor` tool) with a catalogue-backed model picker in /config.
  // CORE: the advisor is always loaded — its real off-switch is the model chain
  // (an empty `Primary model` row), so it needs no kill-switch row.
  { name: "advisor", core: true, category: "Model", describe: "Second-model reviewer: reviews each settled turn, injects severity-routed notes, plus an on-demand consult tool.", load: advisorModule, config: advisorConfig, tools: ["advisor"] },
  // ── Appearance ─────────────────────────────────────────────────────────
  { name: "usage", core: true, category: "Appearance", describe: "Subscription-usage footer (5h/weekly/monthly windows + credits).", load: usageModule },
  { name: "composer", core: true, category: "Appearance", describe: "Composer shape for the input editor — pick one in /config with a live preview. Core: always on.", load: composerModule, config: composerConfig },
  { name: "ux", core: true, category: "Appearance", describe: "Anti-slop UI/UX design discipline: /ux modes, ux_audit tool, design skills. No status-bar footprint.", load: uxModule, config: uxConfig, tools: ["ux_audit"] },
  // ── Memory ─────────────────────────────────────────────────────────────
  { name: "munin", category: "Memory", describe: "Munin long-term memory tools (search/get/store/list/recent/delete/capabilities/share) + memory protocol. Config at project level.", load: muninModule, config: muninConfig, tools: [
    "munin_search", "munin_get", "munin_store", "munin_list", "munin_recent", "munin_delete", "munin_capabilities", "munin_share",
  ] },
  // ── Tasks ──────────────────────────────────────────────────────────────
  { name: "ponytail", category: "Tasks", describe: "Lazy-senior-dev mode: prompts, skills, subagent instructions.", load: ponytailModule, config: ponytailConfig },
  // ── Tools ──────────────────────────────────────────────────────────────
  { name: "serena", category: "Tools", describe: "Serena semantic code tools via a persistent Python worker.", load: serenaModule, tools: [
    "serena_status", "serena_list_tools", "serena_get_symbols_overview", "serena_find_symbol",
    "serena_find_referencing_symbols", "serena_find_declaration", "serena_find_implementations",
    "serena_replace_symbol_body", "serena_insert_before_symbol", "serena_insert_after_symbol",
    "serena_rename_symbol", "serena_safe_delete_symbol", "serena_search_for_pattern",
    "serena_replace_content", "serena_restart_language_server", "serena_restart_worker",
    "serena_get_current_config", "serena_check_onboarding_performed", "serena_onboarding",
    "serena_get_diagnostics_for_file",
  ] },
  { name: "fff", category: "Tools", describe: "FFF fuzzy file/content search (ffgrep, fffind) + @-mention completions.", load: fffModule, tools: [
    "ffgrep", "ffind", "fff_multi_grep", "resolve_file", "related_files",
  ] },
  // ── Shell ──────────────────────────────────────────────────────────────
  { name: "rtk", category: "Shell", describe: "Route shell commands through RTK for token savings.", load: rtkModule },
  // ── Plugins ────────────────────────────────────────────────────────────
  // Config last: it owns /config and reads the contrib map. CORE: the panel is
  // the only in-app way back from a misconfiguration — it can never be the
  // module you accidentally switched off.
  { name: "config", core: true, category: "Plugins", describe: "This panel — /config central settings for every module.", load: configModule },
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
