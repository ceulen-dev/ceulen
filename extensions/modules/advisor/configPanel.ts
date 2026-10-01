/**
 * advisor's /config contribution — Model tab, Advisor section.
 *
 * The working copy is the EFFECTIVE settings (agent-dir file, trusted project
 * file over it); saving writes the full `advisor` section back to the
 * agent-dir settings.json and applies it to the live session through the
 * module bridge — no /reload. Enable + per-tool rows are prepended/appended by
 * the config module automatically.
 *
 * The model menu reads the catalogue (provider/id) from the registry stash the
 * module fills at session_start — config factories receive no ctx (classifier
 * precedent). `menu` and inline `completions` are mutually exclusive on one
 * row, hence the primary picker and the comma-separated fallback row.
 */
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { row, toInt, type PanelCompletionItem, type PanelGroup, type PanelMenuOption } from "../../lib/panel.js";
import type { ModuleConfig } from "../../lib/registry.js";
import {
  chainFromSettings,
  loadAdvisorSettings,
  projectShadow,
  settingsFromChain,
  THINKING_LEVELS,
  writeAdvisorSettings,
  type AdvisorChain,
  type AdvisorConfig,
} from "./lib/config.js";
import { modelRef } from "./lib/model-picker.js";

/** The panel's working copy: the chain rows plus the non-chain settings. */
export interface AdvisorPanelCfg extends AdvisorChain {
  enabled: boolean;
  minToolCalls: number;
  immuneTurns: number;
}

/** Installed by the module at load — effective settings + live apply. */
export interface AdvisorBridge {
  read(): AdvisorConfig;
  apply(next: AdvisorConfig, ctx: ExtensionContext): void | Promise<void>;
}

let bridge: AdvisorBridge | undefined;
export function setAdvisorBridge(value: AdvisorBridge | undefined): void {
  bridge = value;
}

/** Registry stash — set by the module's session_start; `/config` always opens
 *  after a session exists. Exported for tests. */
let registry: ModelRegistry | undefined;
export function setAdvisorRegistry(value: ModelRegistry | undefined): void {
  registry = value;
}

function modelOptions(): PanelMenuOption[] {
  return (registry?.getAvailable() ?? [])
    .map((model) => {
      const ref = modelRef(model);
      return { value: ref, label: ref, ...(model.name && model.name !== ref ? { description: model.name } : {}) };
    })
    .sort((a, b) => a.value.localeCompare(b.value));
}

/** Build the advisor panel groups over a working copy (mutated by row setters).
 *  Exported for tests. */
export function buildAdvisorGroups(cfg: AdvisorPanelCfg): PanelGroup[] {
  const modelMenu = (): PanelMenuOption[] => [
    { value: "", label: "(none)", description: "No primary model — the advisor stays inactive." },
    ...modelOptions(),
  ];
  const thinkingMenu = (): PanelMenuOption[] => [
    { value: "", label: "(model default)", description: "No pinned level — the provider default applies." },
    ...THINKING_LEVELS.filter((level) => level !== "off").map((level) => ({ value: level, label: level })),
  ];
  const modelCompletions = (): PanelCompletionItem[] =>
    modelOptions().map((option) => ({ value: option.value, label: option.label, description: option.description }));

  return [
    {
      key: "advisor",
      label: "Advisor",
      tab: "Model",
      icon: "🧭",
      rows: [
        row("advisor.enabled", "Review settled turns", "toggle", cfg.enabled, (v) => {
          cfg.enabled = Boolean(v);
        }, {
          description: "Automatic background review: after a settled turn the reviewer may steer one note in. Off = no review — the consult tool still works. /advisor on|off overrides it for this session.",
          defaultValue: true,
        }),
        row("advisor.model", "Primary model", "string", cfg.model, (v) => {
          cfg.model = String(v ?? "").trim();
        }, {
          menu: modelMenu,
          description: "Reviewer model (provider/id), picked from the catalogue. Empty = advisor inactive.",
          warning: cfg.model ? undefined : "No model set — the advisor will not run.",
          defaultValue: "",
        }),
        row("advisor.thinking", "Thinking", "string", cfg.thinking, (v) => {
          cfg.thinking = String(v ?? "").trim();
        }, {
          menu: thinkingMenu,
          description: "Thinking level pinned on the primary chain entry (saved as its :level suffix).",
          defaultValue: "",
        }),
        row("advisor.fallbacks", "Fallback chain", "string", cfg.fallbacks, (v) => {
          cfg.fallbacks = String(v ?? "").trim();
        }, {
          completions: modelCompletions,
          description: "Ordered fallbacks, comma-separated provider/id (optionally :level). Served when the primary fails.",
          defaultValue: "",
        }),
        row("advisor.watch.minToolCalls", "Min tool calls per review", "number", cfg.minToolCalls, (v) => {
          cfg.minToolCalls = Math.max(0, toInt(v, cfg.minToolCalls));
        }, {
          description: "Turns with fewer new tool calls than this are skipped (0 = review every turn).",
          defaultValue: 3,
        }),
        row("advisor.watch.immuneTurns", "Immune turns", "number", cfg.immuneTurns, (v) => {
          cfg.immuneTurns = Math.max(0, toInt(v, cfg.immuneTurns));
        }, {
          description: "Settled turns after a steer during which further nits are deferred (also the dedupe window).",
          defaultValue: 3,
        }),
      ],
    },
  ];
}

const OWNED_PREFIX = "advisor.";

/** advisor's ModuleConfig for the central /config panel. Reads go through the
 *  module bridge (which knows the session's cwd + trust); tests and headless
 *  opens fall back to an untrusted agent-dir read. */
export function advisorConfig(): ModuleConfig {
  const before = (bridge?.read ?? (() => loadAdvisorSettings(process.cwd(), false)))();
  const working: AdvisorPanelCfg = {
    ...chainFromSettings(before.models),
    enabled: before.enabled,
    minToolCalls: before.watch.minToolCalls,
    immuneTurns: before.watch.immuneTurns,
  };
  const originalModels = [...before.models];
  const original = { enabled: before.enabled, minToolCalls: before.watch.minToolCalls, immuneTurns: before.watch.immuneTurns };

  return {
    groups: () => buildAdvisorGroups(working),
    save: async (edited, ctx) => {
      if (![...edited].some((k) => k.startsWith(OWNED_PREFIX))) return;
      const next: AdvisorConfig = {
        enabled: working.enabled,
        models: settingsFromChain(working),
        watch: { minToolCalls: working.minToolCalls, immuneTurns: working.immuneTurns },
      };
      if (
        next.enabled === original.enabled &&
        next.watch.minToolCalls === original.minToolCalls &&
        next.watch.immuneTurns === original.immuneTurns &&
        next.models.join("\u0000") === originalModels.join("\u0000")
      ) {
        ctx.ui.notify("Advisor: no changes.", "info");
        return;
      }
      let file: string;
      try {
        file = writeAdvisorSettings(next);
      } catch (e) {
        ctx.ui.notify(`Advisor save failed: ${e instanceof Error ? e.message : e}`, "error");
        return;
      }
      const notes = [
        next.models.length > 0
          ? `Advisor saved to ${file}: ${next.models.join(" → ")}`
          : `Advisor chain cleared — saved to ${file}`,
        next.enabled
          ? `auto-review on (minToolCalls=${next.watch.minToolCalls}, immuneTurns=${next.watch.immuneTurns})`
          : "auto-review off",
      ];
      try {
        await bridge?.apply(next, ctx);
        notes.push("Applied to this session.");
      } catch (e) {
        notes.push(`Saved to the file, but the live session update failed: ${e instanceof Error ? e.message : e}`);
      }
      // The project layer wins over a global save — say so (pi-advisor's own
      // warning), for both the new and the legacy section name.
      const shadow = projectShadow(ctx.cwd, ctx.isProjectTrusted?.() === true);
      if (shadow.length > 0) {
        notes.push(`This project's .pi/settings.json sets "${shadow[0]}" — the project layer overrides this save.`);
      }
      ctx.ui.notify(notes.join(" "), shadow.length > 0 ? "warning" : "info");
    },
  };
}
