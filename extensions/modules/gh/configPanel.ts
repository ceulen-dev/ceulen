// gh module's /config contribution — Tools tab, GitHub section.
//
// One row: the run_watch budget. The module itself needs no settings (the gh
// binary + the user's gh auth own everything else). Saving writes the GLOBAL
// settings.json `gh` section; ops read it per call, so a save applies live.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { row, type PanelGroup } from "../../lib/panel.js";
import type { ModuleConfig } from "../../lib/registry.js";

export const DEFAULT_RUN_WATCH_TIMEOUT_SECS = 600;

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function readRunWatchTimeoutSecs(): number {
  for (const file of [path.join(agentDir(), "settings.json")]) {
    try {
      if (!existsSync(file)) continue;
      const section = JSON.parse(readFileSync(file, "utf8"))?.gh;
      const v = section?.runWatchTimeoutSecs;
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
    } catch {
      // corrupt layer → default
    }
  }
  return DEFAULT_RUN_WATCH_TIMEOUT_SECS;
}

function writeRunWatchTimeoutSecs(secs: number): string {
  const file = path.join(agentDir(), "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`${file} is not valid JSON — fix or remove it before saving.`);
    }
  }
  settings.gh = { ...(settings.gh as object | undefined ?? {}), runWatchTimeoutSecs: secs };
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

export function buildGhGroups(working: { value: number }): PanelGroup[] {
  return [
    {
      key: "gh",
      label: "GitHub",
      tab: "Tools",
      icon: "🐙",
      rows: [
        row("gh.runWatchTimeoutSecs", "run_watch budget", "number", working.value, (v) => {
          // NaN guard is load-bearing: a garbage inline edit must not write
          // NaN (JSON null) — leave the working value untouched instead.
          const n = Math.floor(Number(v));
          if (Number.isFinite(n)) working.value = Math.max(10, n);
        }, {
          defaultValue: DEFAULT_RUN_WATCH_TIMEOUT_SECS,
          description: "Seconds run_watch keeps polling a workflow run before reporting in-progress (capped at gh's 5-min command deadline).",
        }),
      ],
    },
  ];
}

/** gh's ModuleConfig for the central /config panel. */
export function ghConfig(_pi: ExtensionAPI): ModuleConfig {
  const working = { value: readRunWatchTimeoutSecs() };
  return {
    groups: () => buildGhGroups(working),
    save: async (edited, ctx: ExtensionContext) => {
      if (![...edited].some((k) => k.startsWith("gh."))) return;
      const file = writeRunWatchTimeoutSecs(working.value);
      ctx.ui.notify(`Saved gh.runWatchTimeoutSecs=${working.value} to ${file} (applies to the next run_watch call).`, "info");
    },
  };
}
