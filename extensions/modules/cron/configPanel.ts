/**
 * cron's /config contribution — Tasks tab, Cron section.
 *
 * Rows write the GLOBAL agent-dir settings.json `cron` section (a
 * writeCronSection sibling of readCronSettings). The module re-reads settings
 * at load (global-only) and on every session_start (project overlay), so a
 * save applies to the next session without /reload; the tick interval also
 * re-arms on session_start.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { row, type PanelGroup } from "../../lib/panel.js";
import type { ModuleConfig } from "../../lib/registry.js";
import { readCronSettings, type CronSettings } from "./index.ts";

/** Effective settings for the panel — the same chain the scheduler uses. */
export function loadCronSettings(): CronSettings {
  return readCronSettings();
}

/** Write ONE patch into the GLOBAL agent-dir `cron` section (never the merged
 *  snapshot — a project-overlay value must not be promoted to global). */
export function writeCronSection(patch: Partial<CronSettings>): string {
  const file = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "settings.json");
  let settings: Record<string, unknown>;
  try {
    settings = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`${file} is not valid JSON — fix or remove it before saving.`);
  }
  const s = (settings.cron ?? {}) as Record<string, unknown>;
  Object.assign(s, patch);
  settings.cron = s;
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/** Build the cron panel groups over a working copy (mutated by row setters).
 *  Exported for tests. */
export function buildCronGroups(cfg: CronSettings): PanelGroup[] {
  return [
    {
      key: "cron",
      label: "Cron",
      tab: "Tasks",
      icon: "⏰",
      rows: [
        row("cron.enabled", "Scheduler enabled", "toggle", cfg.enabled, (v) => {
          cfg.enabled = Boolean(v);
        }, {
          description: "Global kill switch for the in-process scheduler (30s ticks fire due jobs into the live session).",
          defaultValue: true,
        }),
        row("cron.tickMs", "Tick interval (ms)", "number", cfg.tickMs, (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) cfg.tickMs = n;
        }, {
          description: "How often due jobs are checked. Clamped 5s–10min on read (default 30s). Re-arms on next session.",
          defaultValue: 30_000,
        }),
        row("cron.timeoutMs", "Headless child cap (ms)", "number", cfg.timeoutMs, (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) cfg.timeoutMs = n;
        }, {
          description: "Hard cap for pinned (headless) job runs: SIGTERM at the cap, SIGKILL after 5s grace. Clamped 1min–24h (default 10min).",
          defaultValue: 600_000,
        }),
      ],
    },
  ];
}

const OWNED_PREFIX = "cron.";

/** cron's ModuleConfig for the central /config panel. */
export function cronConfig(): ModuleConfig {
  const before = loadCronSettings();
  const working: CronSettings = { ...before };

  return {
    groups: () => buildCronGroups(working),
    save: async (edited, ctx) => {
      const FIELDS: (keyof CronSettings)[] = ["enabled", "tickMs", "timeoutMs"];
      const patch: Partial<CronSettings> = {};
      for (const key of edited) {
        if (!key.startsWith(OWNED_PREFIX)) continue;
        const field = key.slice(OWNED_PREFIX.length) as keyof CronSettings;
        if (FIELDS.includes(field)) (patch as Record<string, unknown>)[field] = working[field];
      }
      if (!Object.keys(patch).length) return;
      try {
        const file = writeCronSection(patch);
        ctx.ui.notify(`Cron settings saved to ${file} — applies next session (project .pi/settings.json may shadow per field).`, "info");
      } catch (e) {
        ctx.ui.notify(`Cron save failed: ${e instanceof Error ? e.message : e}`, "error");
      }
    },
  };
}
