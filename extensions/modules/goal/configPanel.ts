/**
 * goal's /config contribution — Tasks tab, Goal mode section 🎯.
 *
 * Rows write the GLOBAL agent-dir settings.json `goal` section (see
 * lib/settings.ts); read per event, so a save applies without /reload.
 */
import { row, toInt, type PanelGroup } from "../../lib/panel.js";
import type { ModuleConfig } from "../../lib/registry.js";
import { readGoalSettings, DEFAULT_GOAL_SETTINGS, type GoalSettings } from "./lib/settings.js";

/** Build the panel groups over a working copy (mutated by row setters). */
export function buildGoalGroups(cfg: GoalSettings): PanelGroup[] {
  return [
    {
      key: "goal",
      label: "Goal mode",
      tab: "Tasks",
      icon: "🎯",
      rows: [
        row("goal.maxTurns", "Max continuation turns", "number", cfg.maxTurns, (v) => {
          const n = toInt(v, cfg.maxTurns);
          if (n > 0) cfg.maxTurns = n;
        }, {
          description: "Hard cap on autonomous continuation turns before the loop stops itself.",
          warning: "Uncapped autonomous loops burn tokens — the cap is the seatbelt.",
          defaultValue: DEFAULT_GOAL_SETTINGS.maxTurns,
        }),
        row("goal.defaultBudget", "Default token budget", "number", cfg.defaultBudget ?? 0, (v) => {
          const n = toInt(v, 0);
          if (n >= 0) cfg.defaultBudget = n;
        }, {
          description: "Default token budget for /goal set without --budget. 0 = unbounded.",
          defaultValue: DEFAULT_GOAL_SETTINGS.defaultBudget,
        }),
      ],
    },
  ];
}

const OWNED_PREFIX = "goal.";

/** goal's ModuleConfig for the central /config panel. */
export function goalConfig(): ModuleConfig {
  const working: GoalSettings = readGoalSettings();
  return {
    groups: () => buildGoalGroups(working),
    save: async (edited, ctx) => {
      if (![...edited].some((k) => k.startsWith(OWNED_PREFIX))) return;
      // Read-modify-write the two owned keys into the GLOBAL settings.json.
      try {
        const { writeGoalSection } = await import("./lib/settings.js");
        const patch: Partial<GoalSettings> = {};
        if (edited.has("goal.maxTurns")) patch.maxTurns = working.maxTurns;
        if (edited.has("goal.defaultBudget")) patch.defaultBudget = working.defaultBudget;
        if (!Object.keys(patch).length) return;
        const file = writeGoalSection(patch);
        ctx.ui.notify(`Goal settings saved to ${file} (applies without /reload).`);
      } catch (e) {
        ctx.ui.notify(`Goal save failed: ${e instanceof Error ? e.message : e}`, "error");
      }
    },
  };
}
