// repair's /config contribution — Tools tab, Repair section.
//
// The working copy mirrors the GLOBAL settings.json `repair` section (the
// file this panel writes); readRepairSettings() without a cwd is exactly the
// global layer. The trusted-project layer stays visible: the save notify
// discloses when a project file shadows the global save (projectShadow), the
// same contract as the other global-writing panels (advisor, subagent, a2a).
// The three tool-call-time toggles apply to the next turn (settings are read
// per tool call); the two bash keys bind at module load, hence the "next
// session" warning. The config module AUTO-prepends the Enable row and
// appends the per-tool toggle rows (apply_patch / str_replace_editor from the
// registry entry) — none of those are declared here.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { row, type PanelGroup } from "../../lib/panel.js";
import type { ModuleConfig } from "../../lib/registry.js";
import {
  DEFAULT_REPAIR_SETTINGS,
  projectShadow,
  readRepairSettings,
  writeRepairSection,
  type RepairSettings,
} from "./lib/settings.js";

/** Build the repair panel groups over a working copy (mutated by row setters).
 *  Exported for tests. */
export function buildRepairGroups(cfg: RepairSettings): PanelGroup[] {
  return [
    {
      key: "repair",
      label: "Repair",
      tab: "Tools",
      icon: "🔧",
      rows: [
        row("repair.arguments", "Argument repair", "toggle", cfg.arguments, (v) => {
          cfg.arguments = v === true;
        }, {
          defaultValue: DEFAULT_REPAIR_SETTINGS.arguments,
          description: "Schema-driven tool argument repair (invalid/truncated JSON, param aliases). Applies to all models.",
        }),
        row("repair.editRetry", "Edit mismatch repair", "toggle", cfg.editRetry, (v) => {
          cfg.editRetry = v === true;
        }, {
          defaultValue: DEFAULT_REPAIR_SETTINGS.editRetry,
          description: "Edit mismatch repair: strip read-notice contamination, retry trim-tolerant, escalate to apply_patch.",
        }),
        row("repair.guards", "Tool-call guards", "toggle", cfg.guards, (v) => {
          cfg.guards = v === true;
        }, {
          defaultValue: DEFAULT_REPAIR_SETTINGS.guards,
          description: "Block destructive bash (rm -rf /, dd writes) and read-on-guessed-path.",
        }),
        row("repair.autoGenGuard", "Auto-generated write guard", "toggle", cfg.autoGenGuard, (v) => {
          cfg.autoGenGuard = v === true;
        }, {
          defaultValue: DEFAULT_REPAIR_SETTINGS.autoGenGuard,
          description: "Refuse write/edit on generated files (lockfiles, dist/, *.min.js) — regenerate from source instead; bash is the override hatch.",
        }),
        row("repair.autoBg", "Auto-background bash", "toggle", cfg.autoBg, (v) => {
          cfg.autoBg = v === true;
        }, {
          defaultValue: DEFAULT_REPAIR_SETTINGS.autoBg,
          description: "Detach foreground bash calls still running after the threshold and deliver their output as a follow-up message.",
          warning: "Bash description + auto-background mechanism bind at session start — applies to the next session.",
        }),
        row("repair.autoBgSecs", "Auto-background after", "number", cfg.autoBgSecs, (v) => {
          // Mirror the cron guard: non-numeric input must not persist NaN→null.
          const n = Math.floor(Number(v));
          if (Number.isFinite(n) && n > 0) cfg.autoBgSecs = n;
        }, {
          defaultValue: DEFAULT_REPAIR_SETTINGS.autoBgSecs,
          description: "Seconds a foreground bash call may run before it is auto-backgrounded.",
        }),
      ],
    },
  ];
}

const OWNED_PREFIX = "repair.";
const BOOL_KEYS = ["arguments", "editRetry", "guards", "autoGenGuard", "autoBg"] as const;

/** repair's ModuleConfig for the central /config panel. The factory receives
 *  the module's guarded pi but needs nothing from it — settings live in the
 *  settings file, not in the extension runtime. */
export function repairConfig(_pi: ExtensionAPI): ModuleConfig {
  const before = readRepairSettings();
  const working: RepairSettings = { ...before };
  return {
    groups: () => buildRepairGroups(working),
    save: async (edited, ctx: ExtensionContext) => {
      if (![...edited].some((k) => k.startsWith(OWNED_PREFIX))) return;
      const patch: Partial<RepairSettings> = {};
      for (const key of BOOL_KEYS) {
        if (working[key] !== before[key]) patch[key] = working[key];
      }
      if (working.autoBgSecs !== before.autoBgSecs) patch.autoBgSecs = working.autoBgSecs;
      const file = writeRepairSection(patch);
      const notes = [`Repair settings saved to ${file}.`];
      if (patch.autoBg !== undefined || patch.autoBgSecs !== undefined) {
        notes.push("The bash description + auto-background mechanics bind at session start — that change applies to the next session.");
      }
      const shadowed = projectShadow(ctx.cwd, ctx.isProjectTrusted?.() === true);
      if (shadowed) notes.push(`This project's .pi/settings.json sets "repair" — the project layer overrides this save (project values stay authoritative at runtime).`);
      ctx.ui.notify(notes.join(" "), shadowed ? "warning" : "info");
    },
  };
}
