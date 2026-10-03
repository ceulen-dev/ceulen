// steering's /config contribution — Model tab, Steering section.
//
// Rows write the GLOBAL agent-dir settings.json `steering` section (see
// lib/settings.ts); a TRUSTED project `.pi/settings.json` overlays it and is
// disclosed on save. Settings are read per turn (before_agent_start), so a save
// applies immediately — no /reload. The Enable row is prepended by the config
// module automatically (not here).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { row, type PanelGroup } from "../../lib/panel.js";
import type { ModuleConfig } from "../../lib/registry.js";
import {
  DEFAULT_STEERING_SETTINGS,
  projectOverridesSteering,
  readSteeringSettings,
  writeSteeringSection,
  type SteeringSettings,
} from "./lib/settings.js";

/** Build the steering panel groups over a working copy (mutated by row
 *  setters). Exported for tests. */
export function buildSteeringGroups(cfg: SteeringSettings): PanelGroup[] {
  return [
    {
      key: "steering",
      label: "Steering",
      tab: "Model",
      icon: "☸",
      rows: [
        row("steering.firstToolHints", "First-tool hints", "toggle", cfg.firstToolHints, (v) => {
          cfg.firstToolHints = Boolean(v);
        }, {
          defaultValue: true,
          description: "Prompt-aware bash-first / find-first / clone-first hints, appended to the current user message (never the cached system prompt). All families.",
        }),
        row("steering.selectionGuidance", "Selection guidance", "toggle", cfg.selectionGuidance, (v) => {
          cfg.selectionGuidance = Boolean(v);
        }, {
          defaultValue: true,
          description: "DeepSeek V4 tool-routing table prepended to the system prompt. Static per session, so the prefix cache stays warm.",
        }),
        row("steering.superpower", "Super Power prompt", "toggle", cfg.superpower, (v) => {
          cfg.superpower = Boolean(v);
        }, {
          defaultValue: false,
          description: "Prepend the DeepSeek Super Power capability prompt each deepseek-v4 session.",
        }),
        row("steering.superpowerPrompt", "Super Power prompt text", "string", cfg.superpowerPrompt, (v) => {
          cfg.superpowerPrompt = String(v ?? "").trim();
        }, {
          defaultValue: "",
          description: "Optional custom prompt overriding the built-in Super Power text. Empty = built-in.",
        }),
        row("steering.strictSerena", "Strict Serena", "toggle", cfg.strictSerena, (v) => {
          cfg.strictSerena = Boolean(v);
        }, {
          defaultValue: false,
          description: "DeepSeek V4: escalate a repeated bash-instead-of-dedicated-tool miss (ls/find/grep/read/write) from a reminder to a block after 3 in a session. grep/ffgrep are never blocked.",
        }),
        row("steering.stripReasoning", "Strip reasoning", "toggle", cfg.stripReasoning, (v) => {
          cfg.stripReasoning = Boolean(v);
        }, {
          defaultValue: true,
          description: "Strip accumulated reasoning_content from prior turns (prefix-cache stability; prevents provider 400s).",
        }),
        row("steering.dsAnchor", "DS minimal-mode anchor", "toggle", cfg.dsAnchor, (v) => {
          cfg.dsAnchor = Boolean(v);
        }, {
          defaultValue: true,
          warning: "deepseek-v4-pro only: request #1 gets a minimal prompt + bash/str_replace_editor only; full catalog returns after the first reply. Repair module must be enabled for the anchor tool pair.",
          description: "Two-phase bootstrap that anchors request #1 to the DeepSeek Harness minimal-mode distribution.",
        }),
        row("steering.weNeed", "We-need directive", "toggle", cfg.weNeed, (v) => {
          cfg.weNeed = Boolean(v);
        }, {
          defaultValue: false,
          description: "A/B knob: prepend the 'We need…' thinking directive to the bootstrap prompt.",
        }),
      ],
    },
  ];
}

const OWNED_KEYS = [
  "steering.firstToolHints",
  "steering.selectionGuidance",
  "steering.superpower",
  "steering.superpowerPrompt",
  "steering.strictSerena",
  "steering.stripReasoning",
  "steering.dsAnchor",
  "steering.weNeed",
];

/** steering's ModuleConfig for the central /config panel. Reads the EFFECTIVE
 *  settings (global ⊕ trusted project) so the panel shows what actually runs.
 *  Takes the module's `pi` per the ModuleConfig factory contract but needs
 *  nothing live from it — settings are re-read per turn. */
export function steeringConfig(_pi?: ExtensionAPI): ModuleConfig {
  const before = readSteeringSettings();
  const working = structuredClone(before);
  return {
    groups: () => buildSteeringGroups(working),
    save: async (edited, ctx: ExtensionContext) => {
      if (!OWNED_KEYS.some((k) => edited.has(k))) return;
      const patch: Partial<SteeringSettings> = {};
      for (const key of Object.keys(DEFAULT_STEERING_SETTINGS) as (keyof SteeringSettings)[]) {
        if (working[key] !== before[key]) (patch as Record<string, unknown>)[key] = working[key];
      }
      if (Object.keys(patch).length === 0) {
        ctx.ui.notify("No changes.", "info");
        return;
      }
      const file = writeSteeringSection(patch);
      const notes = [`Steering saved to ${file}. Applies from the next turn.`];
      if (projectOverridesSteering(ctx.cwd, ctx.isProjectTrusted?.() === true)) {
        notes.push("A trusted project .pi/settings.json also sets steering.* and overrides these values.");
      }
      ctx.ui.notify(notes.join(" "), "info");
    },
  };
}
