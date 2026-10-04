/**
 * todo's /config contribution — Tasks tab, Todo section.
 *
 * One row: `todo.lingerSecs` — how long the all-done HUD stays above the
 * editor before auto-clearing (OMP's tasks.todoClearDelay parity). Writes the
 * GLOBAL agent-dir settings.json `todo` section (lib/settings.ts); read per
 * commit, so a save applies live with no /reload.
 */
import { row, type PanelGroup } from "../../lib/panel.js";
import type { ModuleConfig } from "../../lib/registry.js";
import { LINGER_DESCRIPTIONS, LINGER_VALUES, readLingerSecs, writeTodoSection } from "./lib/settings.ts";

/** Working-copy panel groups. Exported for tests. */
export function buildTodoGroups(lingerSecs: { value: string }): PanelGroup[] {
  return [
    {
      key: "todo",
      label: "Todo",
      tab: "Tasks",
      icon: "☑",
      rows: [
        row("todo.lingerSecs", "Completed board lingers", "number", lingerSecs.value, (v) => {
          lingerSecs.value = String(v ?? "");
        }, {
          menu: () => LINGER_VALUES.map((v) => ({ value: v, label: v === "-1" ? "Never" : `${Number(v) / 60} minute${Number(v) === 60 ? "" : "s"}`, description: LINGER_DESCRIPTIONS[v] })),
          description: "How long the all-done TODO HUD stays above the editor before auto-clearing. Applies live.",
          defaultValue: "60",
        }),
      ],
    },
  ];
}

const OWNED_PREFIX = "todo.";

/** todo's ModuleConfig for the central /config panel. */
export function todoConfig(): ModuleConfig {
  const before = String(readLingerSecs());
  const working = { value: before };

  return {
    groups: () => buildTodoGroups(working),
    save: async (edited, ctx) => {
      if (![...edited].some((k) => k.startsWith(OWNED_PREFIX))) return;
      const n = parseInt(working.value, 10);
      if (!Number.isFinite(n)) return;
      try {
        const file = writeTodoSection(n);
        ctx.ui.notify(`Todo config saved to ${file} — applies live (read per commit).`, "info");
      } catch (e) {
        ctx.ui.notify(`Todo save failed: ${e instanceof Error ? e.message : e}`, "error");
      }
    },
  };
}
