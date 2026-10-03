/**
 * subagent's /config contribution — Tasks tab, Subagents section.
 *
 * Rows: the three built-in role chains (comma-separated, catalogue
 * completions — advisor-fallbacks pattern), routing (mode/dispatch/classifier
 * model/threshold), and the timeout + advisor-wait rows (0 = off semantics).
 *
 * Reads go through lib/settings.ts (effective: global ⊕ trusted project);
 * saves write the GLOBAL settings.json `subagent` section. Roles/agent rows
 * are read per execute() call, so a save applies live — no /reload.
 *
 * The registry stash (agents + catalogue) is filled by the module's
 * session_start — config factories receive no ctx (advisor/classifier
 * precedent).
 */
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { row, type PanelCompletionItem, type PanelGroup, type PanelMenuOption } from "../../lib/panel.js";
import type { ModuleConfig } from "../../lib/registry.js";
import { DEFAULT_ROLES, type RoleMap } from "./lib/roles.ts";
import { readSubagentSettingsGlobal, settingsPath, writeSubagentSection } from "./lib/settings.ts";
import type { RoutingMode, RoutingSettings } from "./lib/routing.ts";

/** Installed by the module at load — live registry + agent-name stash. */
export interface SubagentBridge {
  registry?: ModelRegistry;
  agentNames(): string[];
}
let bridge: SubagentBridge | undefined;
export function setSubagentBridge(value: SubagentBridge | undefined): void {
  bridge = value;
}

function modelCompletions(): PanelCompletionItem[] {
  return (bridge?.registry?.getAvailable() ?? [])
    .map((model) => {
      const ref = `${model.provider}/${model.id}`;
      return { value: ref, label: ref, ...(model.name && model.name !== ref ? { description: model.name } : {}) };
    })
    .sort((a, b) => a.value.localeCompare(b.value));
}

function classifierModelMenu(): PanelMenuOption[] {
  // Decision models ONLY (router provider, classifier type) — chat models
  // must never appear in this picker (classifier module precedent).
  const options: PanelMenuOption[] = [
    { value: "", label: "(auto)", description: "First available router classifier model." },
  ];
  for (const model of bridge?.registry?.getModelsOfType("classifier", "router") ?? []) {
    options.push({ value: model.id, label: model.id, ...(model.name && model.name !== model.id ? { description: model.name } : {}) });
  }
  return options;
}

/** Build the subagent panel groups over a working copy (mutated by row setters).
 *  Exported for tests. */
export function buildSubagentGroups(cfg: {
  roles: RoleMap;
  routingMode: RoutingMode;
  routingModel: string;
  routingThreshold: number;
  idleTimeoutMins: number;
  hardTimeoutMins: number;
  advisorWaitSecs: number;
  routingDispatch: string;
}): PanelGroup[] {
  const roleRow = (role: string, label: string, description: string) => {
    const current = cfg.roles[role];
    const value = Array.isArray(current) ? current.join(", ") : String(current ?? "");
    return row(`subagent.roles.${role}`, label, "string", value, (v) => {
      // Empty clears the override — an empty array marks the role for deletion
      // at save time (built-in default applies again).
      const chain = String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      cfg.roles[role] = chain.length > 0 ? chain : [];
    }, {
      completions: modelCompletions,
      description,
      defaultValue: Array.isArray(DEFAULT_ROLES[role]) ? (DEFAULT_ROLES[role] as string[]).join(", ") : String(DEFAULT_ROLES[role] ?? ""),
      warning: Array.isArray(current) && current.length === 0 ? `Role "${role}" cleared — saving restores the built-in default chain.` : undefined,
    });
  };

  return [
    {
      key: "subagent",
      label: "Subagents",
      tab: "Tasks",
      icon: "🧩",
      rows: [
        row("subagent.routing.mode", "Classifier routing", "string", cfg.routingMode, (v) => {
          if (v === "off" || v === "classify") cfg.routingMode = v;
        }, {
          values: ["classify", "off"],
          menu: (): PanelMenuOption[] => [
            { value: "classify", label: "classify", description: "Jev picks model tier + thinking per task (pins win; fails open)." },
            { value: "off", label: "off", description: "Static role chains only — the agent frontmatter decides." },
          ],
          description: "Per-task model-tier + thinking routing via the classifier module's decision models. Pinned agents (agentModels/agentThinking) are never overridden.",
          defaultValue: "classify",
        }),
        row("subagent.routing.dispatch", "Dispatch", "string", cfg.routingDispatch, (v) => {
          if (v === "classify" || v === "off") cfg.routingDispatch = v;
        }, {
          menu: (): PanelMenuOption[] => [
            { value: "classify", label: "classifier decides", description: "Jev picks pane vs background per single dispatch (explicit runner/background wins; fails open to a pane)." },
            { value: "off", label: "always a visible pane", description: "Foreground dispatch stays in herdr; pass background:true explicitly for detached runs." },
          ],
          description: "herdr only: when a single dispatch names neither runner nor background, let the classifier choose between a visible pane and a detached background task.",
          defaultValue: "classify",
        }),
        row("subagent.routing.model", "Classifier model", "string", cfg.routingModel, (v) => {
          cfg.routingModel = String(v ?? "").trim();
        }, {
          menu: classifierModelMenu,
          description: "Decision model for routing — only router decision models are listed. (auto) = first available.",
          defaultValue: "",
        }),
        row("subagent.routing.threshold", "Routing confidence", "number", cfg.routingThreshold, (v) => {
          const n = Number(v);
          if (Number.isFinite(n)) cfg.routingThreshold = Math.min(0.99, Math.max(0.1, n));
        }, {
          description: "Minimum certainty (0.1–0.99) before an answer overrides the agent's default tier — tier gates on the winning label's probability, effort on the score answer's confidence.",
          defaultValue: 0.6,
        }),
        roleRow("fast", "Fast chain (@fast)", "Model pool for scout/tester-style work — comma-separated provider/id fallbacks. Empty = parent model."),
        roleRow("coder", "Coder chain (@coder)", "Model pool for worker-style implementation — comma-separated fallbacks. Empty = parent model."),
        roleRow("smart", "Smart chain (@smart)", "Model pool for planner/reviewer-style reasoning — comma-separated fallbacks. Empty = parent model."),
        row("subagent.idleTimeoutMins", "Idle timeout (min)", "number", cfg.idleTimeoutMins, (v) => {
          const n = Number(v);
          if (Number.isFinite(n)) cfg.idleTimeoutMins = Math.min(60, Math.max(0, Math.round(n)));
        }, {
          description: "Abort a child after this many minutes with NO activity (the hang detector). 0 = default (3).",
          defaultValue: 0,
        }),
        row("subagent.hardTimeoutMins", "Hard cap (min)", "number", cfg.hardTimeoutMins, (v) => {
          const n = Number(v);
          if (Number.isFinite(n)) cfg.hardTimeoutMins = Math.min(60, Math.max(0, Math.round(n)));
        }, {
          description: "Absolute lifetime cap per child. 0 = OFF (default) — a child producing output is never killed; only total silence is.",
          defaultValue: 0,
        }),
        row("subagent.advisorWaitSecs", "Advisor wait (sec)", "number", cfg.advisorWaitSecs, (v) => {
          const n = Number(v);
          if (Number.isFinite(n)) cfg.advisorWaitSecs = Math.min(900, Math.max(0, Math.round(n)));
        }, {
          description: "herdr panes only: wait for the child's own advisor review to finish before collecting its report, so steered corrections are included. 0 = collect at first settle.",
          defaultValue: 120,
        }),
      ],
    },
  ];
}

const OWNED_KEYS = [
  "subagent.routing.mode", "subagent.routing.model", "subagent.routing.threshold",
  "subagent.routing.dispatch",
  "subagent.roles.fast", "subagent.roles.coder", "subagent.roles.smart",
  "subagent.idleTimeoutMins", "subagent.hardTimeoutMins",
  "subagent.advisorWaitSecs",
];

/** subagent's ModuleConfig for the central /config panel. */
export function subagentConfig(): ModuleConfig {
  const before = readSubagentSettingsGlobal();
  const working = {
    roles: structuredClone(before.roles.roles) as RoleMap,
    routingMode: before.routing.mode,
    routingModel: before.routing.model,
    routingThreshold: before.routing.threshold,
    routingDispatch: before.routing.dispatch,
    idleTimeoutMins: before.idleTimeoutMins,
    hardTimeoutMins: before.hardTimeoutMins,
    advisorWaitSecs: before.advisorWaitSecs,
  };
  const original = JSON.stringify(working);

  return {
    groups: () => buildSubagentGroups(working),
    save: async (edited, ctx: ExtensionContext) => {
      if (!OWNED_KEYS.some((k) => edited.has(k))) return;
      if (JSON.stringify(working) === original) {
        ctx.ui.notify("Subagents: no changes.", "info");
        return;
      }
      // Persist only roles that differ from the load-time state: roles still
      // at their built-in default stay out of settings.json (they'd freeze
      // today's defaults against future changes); an edited-to-empty role is
      // written as [] = deletion (writeSubagentSection removes the key).
      const rolesPatch: Record<string, string | string[]> = {};
      for (const role of ["fast", "coder", "smart"]) {
        const nowValue = working.roles[role];
        const originalValue = before.roles.roles[role];
        const same = JSON.stringify(nowValue) === JSON.stringify(originalValue ?? (role in DEFAULT_ROLES ? DEFAULT_ROLES[role] : undefined));
        if (!same) rolesPatch[role] = Array.isArray(nowValue) ? nowValue : [];
      }
      let file: string;
      try {
        file = writeSubagentSection({
          routing: { mode: working.routingMode, model: working.routingModel, threshold: working.routingThreshold, dispatch: working.routingDispatch as RoutingSettings["dispatch"] },
          ...(Object.keys(rolesPatch).length > 0 ? { roles: rolesPatch } : {}),
          idleTimeoutMins: working.idleTimeoutMins,
          hardTimeoutMins: working.hardTimeoutMins,
          advisorWaitSecs: working.advisorWaitSecs,
        });
      } catch (e) {
        ctx.ui.notify(`Subagent save failed: ${e instanceof Error ? e.message : e}`, "error");
        return;
      }
      const notes = [
        `Subagents saved to ${file}`,
        `routing=${working.routingMode}${working.routingModel ? ` (${working.routingModel})` : ""}`,
        `dispatch=${working.routingDispatch}`,
        `hard cap=${working.hardTimeoutMins === 0 ? "off" : `${working.hardTimeoutMins}m`}`,
        `advisor wait=${working.advisorWaitSecs === 0 ? "off" : `${working.advisorWaitSecs}s`}`,
        "Applied to this session.",
      ];
      ctx.ui.notify(notes.join(" · "), "info");
    },
  };
}
