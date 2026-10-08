/**
 * ceulen module registry + shared settings access.
 *
 * Lives outside extensions/index.ts so the config module can iterate the
 * registry without a circular import (index imports the config module
 * statically; the config module imports this list).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PanelGroup } from "./panel.js";
import routerModule from "../modules/router/index.ts";
import { routerConfig } from "../modules/router/configPanel.ts";
import zaiModule from "../modules/zai/index.ts";
import { zaiConfig } from "../modules/zai/configPanel.ts";
import classifierModule from "../modules/classifier/index.ts";
import { classifierConfig } from "../modules/classifier/configPanel.js";
import advisorModule from "../modules/advisor/index.ts";
import { advisorConfig } from "../modules/advisor/configPanel.js";
import usageModule from "../modules/usage/index.ts";
import composerModule, { composerConfig } from "../modules/composer/index.ts";
import ponytailModule, { ponytailConfig } from "../modules/ponytail/index.ts";
import subagentModule from "../modules/subagent/index.ts";
import { subagentConfig } from "../modules/subagent/configPanel.js";
import planModule from "../modules/plan/index.ts";
import { planConfig } from "../modules/plan/configPanel.js";
import a2aModule from "../modules/a2a/index.ts";
import { a2aConfig } from "../modules/a2a/configPanel.js";
import todoModule from "../modules/todo/index.ts";
import { todoConfig } from "../modules/todo/configPanel.ts";
import steeringModule from "../modules/steering/index.ts";
import { steeringConfig } from "../modules/steering/configPanel.js";
import repairModule from "../modules/repair/index.ts";
import { repairConfig } from "../modules/repair/configPanel.js";
import uxModule, { uxConfig } from "../modules/ux/index.ts";
import serenaModule from "../modules/serena/index.ts";
import fffModule from "../modules/fff/index.ts";
import rtkModule from "../modules/rtk/index.ts";
import muninModule from "../modules/munin/index.ts";
import { muninConfig } from "../modules/munin/configPanel.ts";
import webModule from "../modules/web/index.ts";
import { webConfig } from "../modules/web/configPanel.ts";
import ghModule from "../modules/gh/index.ts";
import { ghConfig } from "../modules/gh/configPanel.js";
import rulesModule from "../modules/rules/index.ts";
import attachmentsModule from "../modules/attachments/index.ts";
import { attachmentsConfig } from "../modules/attachments/configPanel.ts";
import cronModule from "../modules/cron/index.ts";
import { cronConfig } from "../modules/cron/configPanel.ts";
import permissionModule from "../modules/permission/index.ts";
import shellsModule from "../modules/shells/index.ts";
import sgModule from "../modules/sg/index.ts";
import jfindModule from "../modules/jfind/index.ts";
import notifyModule from "../modules/notify/index.ts";
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
  /** The module's tools registered `exposure: "deferred"` — NOT declared to
   *  the model; `tool_search` loads them on demand (they stay callable via
   *  ctx.executeTool/codemode meanwhile). Single source for the tier list;
   *  every tool a module registers that is NOT listed here stays `direct`.
   *  The bundle entry injects the exposure at registration (see index.ts). */
  deferredTools?: string[];
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
  // Z.AI direct provider (GLM via the Anthropic endpoint) — independent of the
  // router; registers unconditionally so /login zai-anthropic stays reachable.
  { name: "zai", category: "Providers", describe: "Z.AI Coding Plan via the Anthropic endpoint — GLM-5.x with explicit prompt caching, fast tier, ZCode-parity request signing. Key via /login zai-anthropic or $ZAI_ANTHROPIC_API_KEY.", load: zaiModule, config: zaiConfig },
  // Classifier right after router: its classify tool resolves decision models
  // from the router provider's registry catalog (needs router registered, not
  // the module object itself — order is for /config grouping readability).
  { name: "classifier", core: true, category: "Model", describe: "System One decision models (Jev): classify tool + bash permission auto-approve, via router-discovered models.", load: classifierModule, config: classifierConfig },
  // Advisor right after classifier: second-model reviewer (turn-end notes +
  // the on-demand `advisor` tool) with a catalogue-backed model picker in /config.
  // CORE: the advisor is always loaded — its real off-switch is the model chain
  // (an empty `Primary model` row), so it needs no kill-switch row.
  { name: "advisor", core: true, category: "Model", describe: "Second-model reviewer: reviews each settled turn, injects severity-routed notes, plus an on-demand consult tool.", load: advisorModule, config: advisorConfig },
  // ── Appearance ─────────────────────────────────────────────────────────
  { name: "usage", core: true, category: "Appearance", describe: "Subscription-usage footer (5h/weekly/monthly windows + credits).", load: usageModule },
  { name: "composer", core: true, category: "Appearance", describe: "Composer shape for the input editor — pick one in /config with a live preview. Core: always on.", load: composerModule, config: composerConfig },
  // ux_audit is DIRECT (2026-10-08 usage re-eval): every ux_* skill routes to
  // it, it must run pre-code in the ux workflow, and it has no fs/network side
  // effects. The ux module is CORE (always loaded), so registration alone
  // declares it — no tool_search detour to start the UX discipline.
  { name: "ux", core: true, category: "Appearance", describe: "Anti-slop UI/UX design discipline: /ux modes, ux_audit tool, design skills. No status-bar footprint.", load: uxModule, config: uxConfig },
  // ── Memory ─────────────────────────────────────────────────────────────
  // munin_search + munin_get are DIRECT (2026-10-08 usage re-eval): the Memory
  // Protocol is injected into every configured session and its before-acting
  // rule is a search — forcing a tool_search round-trip first was pure
  // latency. The remaining six stay deferred: store/list/recent/delete/
  // capabilities/share are needed only after search/get evidence is in hand
  // (and store/delete/share stay behind plan mode's BLOCKED_TOOLS).
  { name: "munin", category: "Memory", describe: "Munin long-term memory tools (search/get/store/list/recent/delete/capabilities/share) + memory protocol. Config at project level.", load: muninModule, config: muninConfig, deferredTools: [
    "munin_store", "munin_list", "munin_recent", "munin_delete", "munin_capabilities", "munin_share",
  ] },
  // ── Tasks ──────────────────────────────────────────────────────────────
  { name: "ponytail", category: "Tasks", describe: "Lazy-senior-dev mode: prompts, skills, subagent instructions.", load: ponytailModule, config: ponytailConfig },
  // Subagent after ponytail: ponytail's tool_call hook injects into the
  // `subagent` tool's instructions param — hooks resolve at call time, so
  // order is not load-bearing; this is grouping readability.
  { name: "subagent", category: "Tasks", describe: "In-process subagents: scout/tester/worker/planner/reviewer agents, role-based model pools, classifier tier+thinking routing, background tasks with liveness, herdr delegation.", load: subagentModule, config: subagentConfig },
  // Plan after subagent: its tool gating reads subagent agent frontmatter
  // (sandbox: read-only) and its before_agent_start must compose BEFORE
  // steering (the last prompt rewriter — see its entry below).
  { name: "plan", category: "Tasks", describe: "Read-only plan mode: /plan toggle, tool gating, write_plan + ask_user_question, plan model/thinking, approval handoff.", load: planModule, config: planConfig },
  // A2A after plan: cross-agent delegation (the remote sibling of subagent).
  // No before_agent_start → no prompt-rewrite ordering constraint; its
  // child sessions reuse the host-only session guards in the module.
  { name: "a2a", category: "Tasks", describe: "A2A Protocol v1.0 peer: call remote agents (a2a_call…), be called by them (opt-in inbound server), local/mDNS/gateway discovery.", load: a2aModule, config: a2aConfig, deferredTools: ["a2a_call", "a2a_status", "a2a_discover", "a2a_list", "a2a_history", "a2a_orchestrate", "a2a_peers"] },
  { name: "todo", category: "Tasks", describe: "Phased task board: the `todo` tool (init/start/done/block/unblock) with session persistence, blockers, an above-editor HUD, and a status-segment progress readout.", load: todoModule, config: todoConfig },
  // Cron after todo: scheduled prompts into the live session (the clock-driven
  // sibling of the task board). No before_agent_start → no ordering constraint.
  { name: "cron", category: "Tasks", describe: "Scheduled jobs firing prompts into the live session: add/remove/list/run/enable/disable/test/logs/export, headless pinned runs, crontab export.", load: cronModule, config: cronConfig, deferredTools: ["cron"] },
  // ── Tools ─────────────────────────────────────────────────────────────
  // Repair first in the section: it wraps the built-in tools; serena/fff ride
  // on top (no load-order dependency — hooks resolve at call time).
  { name: "repair", category: "Tools", describe: "Tool-call hardening: schema argument repair, edit mismatch retry, destructive-command guard. Wraps the built-in tools once; adds apply_patch + str_replace_editor.", load: repairModule, config: repairConfig },
  { name: "serena", category: "Tools", describe: "Serena semantic code tools via a persistent Python worker.", load: serenaModule, deferredTools: [
    "serena_status", "serena_list_tools", "serena_get_symbols_overview", "serena_find_symbol",
    "serena_find_referencing_symbols", "serena_find_declaration", "serena_find_implementations",
    "serena_replace_symbol_body", "serena_insert_before_symbol", "serena_insert_after_symbol",
    "serena_rename_symbol", "serena_safe_delete_symbol", "serena_search_for_pattern",
    "serena_replace_content", "serena_restart_language_server", "serena_restart_worker",
    "serena_get_current_config", "serena_check_onboarding_performed", "serena_onboarding",
    "serena_get_diagnostics_for_file",
  ] },
  { name: "fff", category: "Tools", describe: "FFF fuzzy file/content search (ffgrep, fffind) + @-mention completions.", load: fffModule, deferredTools: [
    "fff_multi_grep", "resolve_file", "related_files",
  ] },
  // jfind after fff: the semantic sibling of the lexical search pair (its
  // judge resolves through the router's classifier models at execute time).
  { name: "jfind", category: "Tools", describe: "Semantic code find: describe what code does, get files + line ranges (lexical prior + System One judge cascade).", load: jfindModule, deferredTools: ["jfind"] },
  // Web after fff: same class of append-only before_agent_start guidance
  // (conditional on web_* tools being active) — no prompt-rewrite contract
  // beyond fff's shipped precedent.
  { name: "web", category: "Tools", describe: "Unified web tools: search (SearXNG/Brave/Firecrawl), extract & crawl (JSDOM/Firecrawl/Crawl4AI/agy), screenshot/PDF, CDP browser interaction, Gemini research, image generation, one-off chat.", load: webModule, config: webConfig, deferredTools: [
    "web_map", "web_crawl", "web_pdf", "web_research", "web_image", "web_chat", "web_status", "web_a11y", "read_pdf",
  ] },
  { name: "rules", category: "Context", describe: "Sticky RULES.md constraints carried in every request + a rulebook of on-demand rules served by rule_get. Nearest-first project walk over user-level.", load: rulesModule, deferredTools: ["rule_get"] },
  // Attachments: paste/drop files become real attachments. No tools/commands —
  // input hook + widget + shortcut only; no load-order constraint.
  { name: "attachments", category: "Files", describe: "Real attachments from pasted/dropped files: [[attach:]] tokens + 📎 chips, image ImageContent parts, large-paste collapse, clipboard file paste.", load: attachmentsModule, config: attachmentsConfig },
  // gh after web: same class of external-fetch tooling; fail-open on a missing
  // gh binary (registers nothing until installed). Read-only ops only, so
  // plan mode auto-allows it (plan-tools.ts READ_ONLY_TOOLS).
  // github is DIRECT (2026-10-08 usage re-eval): 61 calls across 17 sessions
  // made it the top deferred-tool user — and every one of them happened in the
  // pre-deferral direct era. After the deferred pass, release verification did
  // not discover it via tool_search at all and fell back to raw bash gh,
  // forfeiting the wrapper's deadline, output cap, and read-only guardrails.
  { name: "gh", category: "Tools", describe: "GitHub tool over the gh CLI: repo/file/PR views, PR diff, five search flavors, Actions run_watch. Read-only; mutating flows stay on bash gh.", load: ghModule, config: ghConfig },
  // sg after gh: the same external-binary fail-open shape, for ast-grep.
  { name: "sg", category: "Tools", describe: "Structural search & rewrite via the ast-grep CLI: ast_grep search, ast_edit dry-run-default rewrites. Registers nothing until ast-grep/sg is installed.", load: sgModule, deferredTools: ["ast_grep", "ast_edit"] },
  // notify: harmless desktop ping (bell fallback), herdr multi-pane ergonomics.
  { name: "notify", category: "Tools", describe: "Desktop notification tool: ping the user when long work settles or input is needed (osascript / notify-send / bell).", load: notifyModule, deferredTools: ["notify"] },
  // rtk is a PROMPT REWRITER (its before_agent_start appends the RTK note), so
  // it must load BEFORE steering — during a ds-anchor bootstrap, steering's
  // minimal prompt replaces everything, including this note (byte-identity);
  // on the normal path steering composes onto it.
  // Steering LAST of the prompt rewriters, i.e. after EVERY before_agent_start
  // composer (ponytail/plan/subagent/munin/advisor/ux/fff/serena/web/rules) and
  // before the config module (load order is load-bearing even though its
  // /config rows live on the Model tab, which PI_TAB_ORDER sorts
  // independently): pi chains before_agent_start results, so steering must run
  // LAST for its deepseek-v4-pro anchor bootstrap to REPLACE the final prompt
  // (byte-identical minimal prompt) instead of appending to a prompt that
  // serena/web/rtk then append to. rtk (a prompt rewriter — it appends the
  // RTK note) loads BEFORE this entry; nothing after steering touches the
  // prompt — do not move rtk back after it or add a prompt rewriter here.
  { name: "rtk", category: "Shell", describe: "Route shell commands through RTK for token savings.", load: rtkModule },
  { name: "steering", category: "Model", describe: "Per-model-family steering (DeepSeek/GLM): first-tool hints, reasoning strip, leak cleaning, error recovery hints, DeepSeek guidance + v4-pro minimal-mode anchor.", load: steeringModule, config: steeringConfig },
  // ── Shell ──────────────────────────────────────────────────────────────
  // Permission after rtk: persistent allow/ask/deny gating. Inert until rules
  // exist; defers to plan mode via the shared plan-bridge flag (order-free).
  { name: "permission", category: "Shell", describe: "Persistent allow/ask/deny permission rules per tool (wildcards, external-directory boundary, doom-loop guard) — opt-in via the `permission` settings section; inert until configured.", load: permissionModule },
  // Background shell sessions (the bash-escape-hatch tool is BLOCKED in plan
  // mode via plan-tools.ts — keep that in sync when renaming).
  { name: "shells", category: "Shell", describe: "Background shell sessions: start/list/output/stdin/kill over persistent processes (dev servers, watchers). Killed on session shutdown; blocked in plan mode.", load: shellsModule, deferredTools: ["shell"] },
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

/** The file `readDisabled` resolves: the first candidate that
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
 *  Resolves through `disabledSource`. */
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

/** Project trust: read <agentDir>/trust.json ({ "<path>": true|false }),
 *  walking up the tree like pi's ProjectTrustStore. Unreadable/absent →
 *  false (fail closed). */
export function isProjectTrusted(cwd: string, dirs: string[] = agentDirs()): boolean {
  for (const dir of dirs) {
    // Per-dir walk start — the walk below mutates `current` up to the root, so
    // a second agent dir must restart from cwd, not inherit the first's root.
    let current = path.resolve(cwd);
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
