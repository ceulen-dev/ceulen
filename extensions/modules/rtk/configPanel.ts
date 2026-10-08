// rtk's /config contribution — Shell tab, RTK rewrite section.
//
// Rows write the global `rtk` section (see lib/settings.ts); the values are
// read per bash call, so a save applies to the next command without /reload.
// Enable + tool rows are prepended by the config module automatically.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { row, type PanelGroup } from "../../lib/panel.js";
import type { ModuleConfig } from "../../lib/registry.js";
import { readRtkSettings, writeRtkSection, type RtkSettings } from "./lib/settings.js";

/** Build the rtk panel groups over a working copy (mutated by row setters).
 *  Exported for tests. */
export function buildRtkGroups(cfg: RtkSettings): PanelGroup[] {
  return [
    {
      key: "rtk",
      label: "RTK rewrite",
      tab: "Shell",
      icon: "⚡",
      rows: [
        row("rtk.mode", "Rewrite mode", "string", cfg.mode, (v) => {
          cfg.mode = v === "off" ? "off" : "supported-only";
        }, {
          values: ["supported-only", "off"],
          description: "supported-only rewrites commands RTK models (single commands or fully-modeled chains). off passes everything through unchanged.",
          defaultValue: "supported-only",
        }),
        row("rtk.chained", "Chained commands", "string", cfg.chained, (v) => {
          cfg.chained = v === "never" ? "never" : "only-all-modeled";
        }, {
          values: ["only-all-modeled", "never"],
          warning: "never skips the rewrite attempt for commands containing | ; & — rtk models few chains, so this avoids a wasted spawn per call.",
          description: "never disables rewrites for commands containing | ; & && || (they always execute byte-identical). only-all-modeled lets RTK try: it rewrites only when EVERY segment is modeled, else fails open to the original.",
          defaultValue: "only-all-modeled",
        }),
      ],
    },
  ];
}

const OWNED_PREFIX = "rtk.";

/** rtk's ModuleConfig for the central /config panel. */
export function rtkConfig(): ModuleConfig {
  const before = readRtkSettings();
  const working = structuredClone(before);
  return {
    groups: () => buildRtkGroups(working),
    save: async (edited, ctx: ExtensionContext) => {
      if (![...edited].some((k) => k.startsWith(OWNED_PREFIX))) return;
      if (working.mode === before.mode && working.chained === before.chained) {
        ctx.ui.notify("No changes.", "info");
        return;
      }
      writeRtkSection({
        mode: working.mode !== before.mode ? working.mode : undefined,
        chained: working.chained !== before.chained ? working.chained : undefined,
      });
      const after = readRtkSettings();
      ctx.ui.notify(
        `RTK saved: mode ${after.mode}, chains ${after.chained} — applies to the next bash call.`,
        "info",
      );
    },
  };
}
