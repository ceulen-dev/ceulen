/**
 * plan's /config contribution — Tasks tab, Plan mode section.
 *
 * Rows write the GLOBAL agent-dir settings.json `plan` section (see
 * lib/settings.ts); a TRUSTED project `.pi/settings.json` overlays it and is
 * disclosed on save. Save applies to the live session through the module
 * bridge (settings are re-read per event, so no /reload).
 */
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { row, toInt, type PanelCompletionItem, type PanelGroup, type PanelMenuOption } from "../../lib/panel.js";
import type { ModuleConfig } from "../../lib/registry.js";
import {
  DEFAULT_PLANS_DIR,
  projectOverridesPlan,
  readPlanSettings,
  writePlanSection,
  SAVE_PLANS_VALUES,
  THINKING_LEVELS,
  type PlanSettings,
  type SavePlans,
} from "./lib/settings.js";

/** Installed by the module at load — effective settings + live apply. */
export interface PlanBridge {
  read(): PlanSettings;
  apply(next: PlanSettings): void;
}

let bridge: PlanBridge | undefined;
export function setPlanBridge(value: PlanBridge | undefined): void {
  bridge = value;
}

/** Registry stash — set by the module at session_start; `/config` always opens
 *  after a session exists. Exported for tests. */
let registry: ModelRegistry | undefined;
export function setPlanRegistry(value: ModelRegistry | undefined): void {
  registry = value;
}
export function getPlanRegistry(): ModelRegistry | undefined {
  return registry;
}

function modelOptions(): PanelMenuOption[] {
  return (registry?.getAvailable() ?? [])
    .map((model) => {
      const ref = `${model.provider}/${model.id}`;
      return { value: ref, label: ref, ...(model.name && model.name !== ref ? { description: model.name } : {}) };
    })
    .sort((a, b) => a.value.localeCompare(b.value));
}

/** Build the plan panel groups over a working copy (mutated by row setters).
 *  Exported for tests. */
export function buildPlanGroups(cfg: PlanSettings): PanelGroup[] {
  const modelMenu = (): PanelMenuOption[] => [
    { value: "", label: "(active model)", description: "Plan mode follows the active model — no switch on entering planning." },
    ...modelOptions(),
  ];
  const thinkingMenu = (): PanelMenuOption[] => [
    { value: "", label: "(keep active level)", description: "Plan mode keeps the current thinking level." },
    ...THINKING_LEVELS.map((level) => ({ value: level, label: level })),
  ];
  const saveMenu = (): PanelMenuOption[] => [
    { value: "all", label: "all", description: "Every write_plan persists to disk (drafts included)." },
    { value: "approved", label: "approved", description: "Drafts stay in memory; the file is written only when a plan is approved." },
    { value: "none", label: "none", description: "Plans never touch disk — the conversation is the only copy." },
  ];
  const modelCompletions = (): PanelCompletionItem[] =>
    modelOptions().map((option) => ({ value: option.value, label: option.label, description: option.description }));

  return [
    {
      key: "plan",
      label: "Plan mode",
      tab: "Tasks",
      icon: "🗺️",
      rows: [
        row("plan.savePlans", "Save plans", "string", cfg.savePlans, (v) => {
          cfg.savePlans = SAVE_PLANS_VALUES.includes(v as SavePlans) ? (v as SavePlans) : cfg.savePlans;
        }, {
          menu: saveMenu,
          description: "Which plans are written to disk: all = every write_plan, approved = written at approval, none = never persisted.",
          defaultValue: "all",
        }),
        row("plan.plansDir", "Plans directory", "string", cfg.plansDir, (v) => {
          cfg.plansDir = String(v ?? "").trim() || DEFAULT_PLANS_DIR;
        }, {
          description: "Directory for plan files, relative to the repo (or absolute). {yyyymm} expands to the UTC month.",
          defaultValue: DEFAULT_PLANS_DIR,
        }),
        row("plan.planModel", "Plan model", "string", cfg.planModel, (v) => {
          cfg.planModel = String(v ?? "").trim();
        }, {
          menu: modelMenu,
          description: "Model applied only while plan mode is active (provider/id). Empty = keep the active model.",
          defaultValue: "",
        }),
        row("plan.planThinking", "Plan thinking", "string", cfg.planThinking, (v) => {
          cfg.planThinking = String(v ?? "").trim();
        }, {
          menu: thinkingMenu,
          description: "Thinking level applied only while plan mode is active; the pre-plan level is restored on exit.",
          defaultValue: "",
        }),
        row("plan.autoApprove", "Auto-approve plans", "toggle", cfg.autoApprove, (v) => {
          cfg.autoApprove = Boolean(v);
        }, {
          description: "When on, a written plan is approved and executed in this session without a keypress (/plan-auto). Off = /plan-approve is prefilled for review.",
          defaultValue: false,
        }),
      ],
    },
  ];
}

const OWNED_PREFIX = "plan.";

/** plan's ModuleConfig for the central /config panel. */
export function planConfig(): ModuleConfig {
  const before = (bridge?.read ?? (() => readPlanSettings()))();
  const working: PlanSettings = { ...before };

  return {
    groups: () => buildPlanGroups(working),
    save: async (edited, ctx) => {
      const next: PlanSettings = { ...working };
      // Persist ONLY edited plan.* fields — a full write would promote
      // project-overlay values into the global file (same rule as the
      // module's persistSettings).
      const PLAN_FIELDS: (keyof PlanSettings)[] = ["savePlans", "plansDir", "planModel", "planThinking", "autoApprove"];
      const patch: Partial<PlanSettings> = {};
      for (const key of edited) {
        if (!key.startsWith(OWNED_PREFIX)) continue;
        const field = key.slice(OWNED_PREFIX.length) as keyof PlanSettings;
        if (PLAN_FIELDS.includes(field)) (patch as Record<string, unknown>)[field] = next[field];
      }
      if (!Object.keys(patch).length) return;
      try {
        const file = writePlanSection(patch);
        bridge?.apply(next);
        const notes = [`Plan settings saved to ${file}.`];
        if (projectOverridesPlan(ctx.cwd, ctx.isProjectTrusted?.() === true)) {
          notes.push('This project\'s .pi/settings.json sets "plan" — the project layer overrides this save.');
        }
        ctx.ui.notify(notes.join(" "), notes.length > 1 ? "warning" : "info");
      } catch (e) {
        ctx.ui.notify(`Plan save failed: ${e instanceof Error ? e.message : e}`, "error");
      }
    },
  };
}
