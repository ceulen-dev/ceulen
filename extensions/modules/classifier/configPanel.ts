// classifier's /config contribution — Model tab, Classifier (Jev) section.
//
// Rows write the global `classifier` section (see lib/settings.ts). The model
// menu lists the router provider's discovered decision models at open time via
// the module-level registry stash (extension config factories get no ctx; the
// session_start handler in index.ts supplies it — same pattern as router's
// lastCtx). Enable + tool rows are prepended by the config module automatically.

import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { row, type PanelGroup } from "../../lib/panel.js";
import type { ModuleConfig } from "../../lib/registry.js";
import { getClassifierSettings, writeClassifierSection, type ClassifierSettings } from "./lib/settings.js";

/** Registry stash — set by the module's session_start (config panel opens per
 *  command, always after a session exists). */
let registry: ModelRegistry | undefined;

/** Test/session hook: supply the live registry for the model menu. */
export function setClassifierRegistry(r: ModelRegistry | undefined): void {
  registry = r;
}

/** Build the classifier panel groups over a working copy (mutated by setters).
 *  Exported for tests. */
export function buildClassifierGroups(cfg: ClassifierSettings): PanelGroup[] {
  const modelMenu = () => {
    const ids = (registry?.getModelsOfType("classifier", "router") ?? []).map((m) => m.id);
    return [
      { value: "", label: "(auto — first available)", description: "Resolve the decision model at ask time." },
      ...ids.map((id) => ({ value: id, label: id })),
    ];
  };
  return [
    {
      key: "classifier",
      label: "Classifier (Jev)",
      tab: "Model",
      icon: "⚖",
      rows: [
        row("classifier.model", "Decision model", "string", cfg.model, (v) => {
          cfg.model = String(v ?? "").trim();
        }, {
          description: "Router decision model for Jev asks. Empty = first available from /v1/systemone/models discovery.",
          menu: modelMenu,
          defaultValue: "",
        }),
        row("classifier.permission.enabled", "Auto-approve", "toggle", cfg.permission.enabled, (v) => {
          cfg.permission.enabled = Boolean(v);
        }, {
          description: "Jev-gated bash auto-approve (reversible + serves the task). Fails safe to the normal prompt.",
          defaultValue: true,
        }),
        row("classifier.permission.mode", "Mode", "string", cfg.permission.mode, (v) => {
          cfg.permission.mode = v === "observe" ? "observe" : "enforce";
        }, {
          values: ["enforce", "observe"],
          description: "enforce auto-approves confident verdicts; observe only logs would-be decisions.",
          defaultValue: "enforce",
        }),
        row("classifier.permission.threshold", "Threshold (0-1)", "string", String(cfg.permission.threshold), (v) => {
          const t = parseFloat(String(v));
          cfg.permission.threshold = t > 0 && t < 1 ? t : cfg.permission.threshold;
        }, {
          description: "Both nouls must clear it. Saved values outside (0,1) fall back to 0.9.",
          defaultValue: "0.9",
        }),
      ],
    },
  ];
}

const OWNED_KEYS = ["classifier.model", "classifier.permission.enabled", "classifier.permission.mode", "classifier.permission.threshold"];

/** classifier's ModuleConfig for the central /config panel. */
export function classifierConfig(): ModuleConfig {
  const before = getClassifierSettings();
  const working = structuredClone(before);
  return {
    groups: () => buildClassifierGroups(working),
    save: async (edited, ctx: ExtensionContext) => {
      if (!OWNED_KEYS.some((k) => edited.has(k))) return;
      if (
        working.model === before.model &&
        working.permission.enabled === before.permission.enabled &&
        working.permission.mode === before.permission.mode &&
        working.permission.threshold === before.permission.threshold
      ) {
        ctx.ui.notify("No changes.", "info");
        return;
      }
      writeClassifierSection({
        model: working.model !== before.model ? working.model : undefined,
        enabled: working.permission.enabled !== before.permission.enabled ? working.permission.enabled : undefined,
        mode: working.permission.mode !== before.permission.mode ? working.permission.mode : undefined,
        threshold: working.permission.threshold !== before.permission.threshold ? working.permission.threshold : undefined,
      });
      const after = getClassifierSettings();
      ctx.ui.notify(
        `Classifier saved. Model: ${after.model || "(auto)"} · auto-approve ${after.permission.enabled ? after.permission.mode : "disabled"} at ${after.permission.threshold}.`,
        "info",
      );
    },
  };
}
