// munin's /config contribution — Memory tab, Munin section.
//
// API config lives at PROJECT level: <cwd>/.pi/settings.json under a `munin`
// section ({ apiKey, project, baseUrl }). The project file is read only when
// trusted (see lib/helpers.ts getMuninConfig); env keeps highest precedence.
// Enable row + tool rows are prepended by the config module automatically.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { row, type PanelGroup } from "../../lib/panel.js";
import type { ModuleConfig } from "../../lib/registry.js";
import {
  DEFAULT_MUNIN_BASE_URL,
  getMuninConfig,
  projectSettingsPath,
  writeMuninSection,
} from "./lib/helpers.js";

export interface MuninSettings {
  project: string;
  baseUrl: string;
  apiKey: string;
}

/** Read the panel's working copy: the EFFECTIVE values (env overrides shown),
 *  falling back to saved/project values when unset. Exported for tests. */
export function readMuninSettings(cwd: string, trusted: boolean, agentDirs?: string[]): MuninSettings {
  let cfg: ReturnType<typeof getMuninConfig> | undefined;
  try {
    cfg = getMuninConfig({}, cwd, trusted, agentDirs ? { agentDirs } : undefined);
  } catch {
    cfg = undefined; // unconfigured — empty working copy, rows stay editable
  }
  return {
    project: cfg?.projectId ?? "",
    baseUrl: cfg?.baseUrl ?? DEFAULT_MUNIN_BASE_URL,
    apiKey: cfg?.apiKey ?? "",
  };
}

/** Build the munin panel groups over a working copy (mutated by row setters).
 *  Exported for tests. */
export function buildMuninGroups(cfg: MuninSettings): PanelGroup[] {
  return [
    {
      key: "munin",
      label: "Munin",
      tab: "Memory",
      icon: "🪶",
      rows: [
        row("munin.project", "Project", "string", cfg.project, (v) => {
          cfg.project = String(v ?? "").trim();
        }, {
          description: "Munin project ID (memory bank) for this repo. MUNIN_PROJECT env and a per-call `project` param override it.",
        }),
        row("munin.baseUrl", "Base URL", "string", cfg.baseUrl, (v) => {
          cfg.baseUrl = String(v ?? "").trim();
        }, {
          defaultValue: DEFAULT_MUNIN_BASE_URL,
          description: "Munin server endpoint. MUNIN_BASE_URL env and a per-call `base_url` param override it.",
        }),
        row("munin.apiKey", "API key", "string", cfg.apiKey, (v) => {
          cfg.apiKey = String(v ?? "").trim();
        }, {
          mask: true,
          description: "Bearer credential for the Munin server. MUNIN_API_KEY env / .env overrides it.",
          warning: "Stored in this repo's .pi/settings.json — add it to .gitignore.",
        }),
      ],
    },
  ];
}

const OWNED_PREFIX = "munin.";

/** munin's ModuleConfig for the central /config panel. cwd/trust are taken
 *  from the save ctx (factories receive none); reads use process.cwd(),
 *  matching router's panel pattern. */
export function muninConfig(): ModuleConfig {
  const before = readMuninSettings(process.cwd(), true);
  const working = structuredClone(before);
  return {
    groups: () => buildMuninGroups(working),
    save: async (edited, ctx) => {
      if (![...edited].some((k) => k.startsWith(OWNED_PREFIX))) return;
      const trusted = ctx.isProjectTrusted?.() === true;
      const target = projectSettingsPath(ctx.cwd);
      writeMuninSection(
        {
          project: working.project !== before.project ? working.project : undefined,
          baseUrl: working.baseUrl !== before.baseUrl ? working.baseUrl : undefined,
          apiKey: working.apiKey !== before.apiKey ? working.apiKey : undefined,
        },
        target,
      );
      const notes: string[] = [`Munin config saved to ${target}.`];
      if (!trusted) {
        notes.push("This project is NOT trusted — pi ignores .pi/settings.json until you trust this repo.");
      }
      if (process.env.MUNIN_API_KEY || process.env.MUNIN_PROJECT || process.env.MUNIN_BASE_URL) {
        notes.push("MUNIN_* env vars override the saved values.");
      }
      ctx.ui.notify(notes.join(" "), trusted ? "info" : "warning");
    },
  };
}
