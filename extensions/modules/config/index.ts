/**
 * config module — owns the central `/config` panel for all ceulen modules.
 *
 * Renders one panel (extensions/lib/panel.ts) from per-module contributions:
 * pi core settings (piSettings.ts), every ceulen module's descriptor groups,
 * and the pi-package (plugins) groups — all categorized under OMP's settings
 * taxonomy (Appearance, Model, Interaction, Context, Tasks, Providers, …).
 *
 * The bundle-level kill-switch is no longer a standalone "Modules" tab: each
 * module's Enable row is prepended to its own functional section (Router →
 * Providers, Ponytail → Tasks, …) so a feature is turned on/off where it is
 * configured. Save routes edited row keys to their owner: `ceulen.disabled.*`
 * → the kill-switch file, `pi.*` → SettingsManager.flush(), `ceulen.plugins.*`
 * → the packages file, `<module>.<key>` → the module's `save()` — each in its
 * own try/catch, so one failure never blocks the others.
 *
 * Naming note: `/settings` is a Pi builtin — an extension command with that
 * name is skipped in autocomplete and renamed (`/settings:1`), never an
 * override. `/config` is unused by Pi core.
 */

import { SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openConfigPanel, row, type PanelGroup } from "../../lib/panel.js";
import { agentDirs, isCore, MODULES, disabledSource, readDisabled, writeDisabled, type ModuleConfig, type ModuleLoadDeps } from "../../lib/registry.js";
import { buildPiSettingsGroups, isPiKey, PI_TAB_ORDER, type PiMenuLookup } from "./piSettings.js";
import { buildPluginsGroups, isPluginsKey, openPluginsWorking, savePlugins } from "./plugins.js";

export const KILL_SWITCH_PREFIX = "ceulen.disabled.";

/** Read the current kill-switch state as a Set of ENABLED module names. */
function enabledModules(): Set<string> {
  const disabled = new Set(readDisabled());
  // Core modules are always enabled, whatever a stale settings file says.
  return new Set(MODULES.map((m) => m.name).filter((n) => !disabled.has(n)));
}

/** The module's Enable kill-switch row over a live working Set (toggles
 *  mutate it; save diffs it against the persisted state). Lives at the top of
 *  the module's own section — the feature is turned on where it is
 *  configured. When the effective settings file is the project's, the
 *  description discloses where writes land. */
export function moduleEnableRow(name: string, describe: string, working: Set<string>): ReturnType<typeof row> {
  const where = disabledSource().isProject ? "this project's .pi/settings.json" : "the global settings.json";
  return row(`${KILL_SWITCH_PREFIX}${name}`, "Enabled", "toggle", working.has(name), (v) => {
    if (v) working.add(name);
    else working.delete(name);
  }, {
    description: `${describe} Writes ${where}.`,
    // Sole warning rows: the kill-switch does NOT apply on save — the ⚠
    // marks "needs /reload" against the instant-apply rest.
    warning: "Takes effect after /reload (or restart).",
    defaultValue: true,
  });
}

/** Prepend a module's Enable row to the FIRST group of its contribution. */
export function withEnableRow(groups: PanelGroup[], name: string, describe: string, working: Set<string>): PanelGroup[] {
  // Core modules are always on — no kill-switch row (nothing to toggle).
  if (isCore(name)) return groups;
  const [first, ...rest] = groups;
  if (!first) return groups;
  return [{ ...first, rows: [moduleEnableRow(name, describe, working), ...first.rows] }, ...rest];
}

/** The kill-switch list that results from toggling `working` (enabled set).
 *  Pure — exported for tests. Core modules are excluded (never disableable). */
export function nextDisabled(working: Set<string>): string[] {
  return MODULES.filter((m) => !m.core).map((m) => m.name).filter((n) => !working.has(n));
}

/** Runtime lookups for the pi-settings menu rows, built from the /config
 *  command's live ExtensionContext. Theme browsing previews through the Theme
 *  INSTANCE form of `ctx.ui.setTheme` (live, no settings.json write) and
 *  remembers the pre-browse instance so Esc can undo; committing goes through
 *  the NAME form (live + persist). Exported for tests. */
export function piMenuLookup(ctx: ExtensionContext): PiMenuLookup {
  let before: ReturnType<() => typeof ctx.ui.theme> | undefined;
  return {
    themes: () => ctx.ui.getAllThemes().map((t) => t.name),
    previewTheme: (name) => {
      const t = ctx.ui.getTheme(name);
      if (!t) return;
      // Capture the LIVE theme once per browse session — the instance form
      // only swaps the running theme, never settings.json.
      if (before === undefined) before = ctx.ui.theme;
      ctx.ui.setTheme(t);
    },
    restoreTheme: () => {
      const prev = before;
      before = undefined;
      if (prev) ctx.ui.setTheme(prev);
    },
    applyTheme: (name) => {
      ctx.ui.setTheme(name);
      before = undefined;
    },
    models: () =>
      ctx.modelRegistry.getAvailable().map((mo) => ({
        provider: mo.provider,
        id: mo.id,
        ...(mo.name && mo.name !== mo.id ? { description: mo.name } : {}),
      })),
  };
}

/** Run each contribution's save, isolated: one module's failure notifies an
 *  error but never blocks the others. Each save() no-ops unless one of its own
 *  keys was edited. Exported for tests. */
export async function saveContributions(
  contributions: { name: string; cfg: ModuleConfig }[],
  keys: Set<string>,
  ctx: Pick<ExtensionContext, "ui">,
): Promise<void> {
  for (const c of contributions) {
    try {
      await c.cfg.save(keys, ctx as ExtensionContext);
    } catch (e) {
      ctx.ui.notify(`${c.name}: save failed: ${e instanceof Error ? e.message : e}`, "error");
    }
  }
}

function summaryLines(groups: PanelGroup[]): string[] {
  const enabled = enabledModules();
  const lines = [
    "── Ceulen config ──",
    `Modules: ${MODULES.map((m) => `${m.name}${enabled.has(m.name) ? "" : " (off)"}`).join(", ")}`,
    "",
  ];
  // Generic row dump per tab/section (label: value) — stays in lockstep with
  // the panel's assembly, pi settings and plugins included.
  let lastTab = "";
  let lastSection = "";
  for (const g of groups) {
    const tab = g.tab ?? g.label;
    if (tab !== lastTab) {
      lines.push(`[${tab}]`);
      lastTab = tab;
      lastSection = "";
    }
    if (g.label !== lastSection && g.tab !== undefined) {
      lines.push(`  ${g.label}`);
      lastSection = g.label;
    }
    for (const r of g.rows) {
      const value = r.mask && String(r.value ?? "") !== "" ? "••••" : String(r.value ?? "");
      const warning = r.warning ? `  ⚠ ${r.warning}` : "";
      const desc = r.description ? `  — ${r.description}` : "";
      lines.push(`    ${r.label}: ${value}${desc}${warning}`);
    }
  }
  lines.push(
    "",
    "  /config            Open the central settings panel (TUI)",
    "  /ceulen            Module status",
    "  /ponytail status   Ponytail mode + default",
    "",
    "Kill-switch: `ceulen.disabled` in settings.json; /reload (or restart) applies.",
  );
  return lines;
}

export default function configModule(pi: ExtensionAPI, deps?: ModuleLoadDeps): void {
  // One contribution factory per module that opted in, keyed by module name.
  // Each factory closes over the module's OWN guarded pi (see ModuleLoadDeps),
  // so a save that re-registers a provider stays the owner's claim.
  const factories = deps?.configContribs ?? new Map<string, () => ModuleConfig>();

  // Where each module's section lives in OMP's taxonomy — pretty section
  // names + icons only; the TAB comes from the registry's `category` (one
  // source: adding a module = one registry entry, no second map to touch).
  // A module WITHOUT a contribution factory (usage, config) renders an
  // Enable-only section here; unknown modules fall back to their own tab so
  // a new module still renders.
  const PRETTY_OF: Record<string, { section: string; icon: string }> = {
    router: { section: "Router", icon: "🌐" },
    usage: { section: "Usage footer", icon: "📊" },
    composer: { section: "Composer", icon: "🎨" },
    ponytail: { section: "Ponytail", icon: "🦥" },
    config: { section: "Ceulen config", icon: "🧩" },
  };
  const SECTION_OF: Record<string, { tab: string; section: string; icon: string | undefined }> = Object.fromEntries(
    MODULES.map((m) => [m.name, { tab: m.category, section: PRETTY_OF[m.name]?.section ?? m.name, icon: PRETTY_OF[m.name]?.icon }]),
  );

  pi.registerCommand("config", {
    description: "Central settings panel for all ceulen modules.",
    handler: async (args, ctx) => {
      const sub = String(args ?? "").trim().toLowerCase();
      const workingEnabled = new Set(enabledModules());
      const pluginsWorking = openPluginsWorking();

      // Pi core settings: an OWN SettingsManager instance over the same files
      // (typed setters persist to global settings.json with pi's own locking;
      // the running session picks changes up on /reload).
      const piSettings = SettingsManager.create(ctx.cwd, agentDirs()[0]);

      // A DISABLED module has no registered factory (the loader skips it), so
      // its section collapses to the Enable row below — settings are moot
      // while off, and the row must stay reachable to turn it back on.
      const contributions = [...factories.entries()].map(([name, factory]) => ({ name, cfg: factory() }));

      // Assemble in OMP taxonomy order: pi settings first (they own the
      // Appearance/Model/Interaction/Context/Shell spine), then ceulen module
      // sections with their Enable row, then plugins.
      const assemble = (): PanelGroup[] => {
        const seen = new Set(contributions.map((c) => c.name));
        const modGroups = contributions.flatMap((c) => {
          const section = SECTION_OF[c.name];
          const groups = c.cfg.groups();
          if (!section) return groups;
          const module = MODULES.find((m) => m.name === c.name);
          return withEnableRow(groups, c.name, module?.describe ?? "", workingEnabled);
        });
        // Modules with no contribution factory still need their Enable row
        // reachable (usage, config itself) — and a disabled module needs the
        // same synthesized section to be switchable back on. Core modules are
        // always on: no synthesized Enable-only section (their contribution,
        // if any, renders without one).
        for (const m of MODULES) {
          const section = SECTION_OF[m.name];
          if (!section || seen.has(m.name) || m.core) continue;
          modGroups.push({
            key: `ceulen-${m.name}`,
            label: section.section,
            tab: section.tab,
            icon: section.icon,
            rows: [moduleEnableRow(m.name, m.describe ?? "", workingEnabled)],
          });
        }
        // Plugins' package sections precede the config module's own switch.
        const all = [...buildPiSettingsGroups(piSettings, piMenuLookup(ctx)), ...buildPluginsGroups(pluginsWorking), ...modGroups];
        const rank = (g: PanelGroup) => {
          const at = PI_TAB_ORDER.indexOf((g.tab ?? g.label) as (typeof PI_TAB_ORDER)[number]);
          return at === -1 ? PI_TAB_ORDER.length : at;
        };
        return [...all].sort((a, b) => rank(a) - rank(b));
      };

      if (sub === "show" || ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify(summaryLines(assemble()).join("\n"), "info");
        return;
      }

      await openConfigPanel({
        ctx,
        cfg: {},
        title: "Settings",
        build: assemble,
        onSave: async (_saved, edited) => {
          const keys = edited ?? new Set<string>();

          // Kill-switch first: compare the working Set against what's persisted.
          if ([...keys].some((k) => k.startsWith(KILL_SWITCH_PREFIX))) {
            try {
              const file = writeDisabled(nextDisabled(workingEnabled));
              ctx.ui.notify(`Module kill-switch saved to ${file} — /reload (or restart) to apply.`, "info");
            } catch (e) {
              ctx.ui.notify(`Kill-switch save failed: ${e instanceof Error ? e.message : e}`, "error");
            }
          }

          // Pi packages (plugins): writes land in the file each entry came from.
          if ([...keys].some(isPluginsKey)) {
            try {
              const files = savePlugins(pluginsWorking);
              if (files.length > 0) {
                ctx.ui.notify(`Plugins saved to ${files.join(", ")} — /reload (or restart) to apply.`, "info");
              }
            } catch (e) {
              ctx.ui.notify(`Plugins save failed: ${e instanceof Error ? e.message : e}`, "error");
            }
          }

          // Module contributions: each isolated — one module's failure must not
          // block the others (nor the kill-switch above).
          await saveContributions(contributions, keys, ctx);

          // Pi core settings: setters already queued their writes; flush the
          // manager's write queue and surface any persistence errors.
          if ([...keys].some(isPiKey)) {
            try {
              await piSettings.flush();
              const errors = piSettings.drainErrors();
              if (errors.length > 0) {
                ctx.ui.notify(`Pi settings: ${errors.map((e) => e.error.message).join("; ")}`, "error");
              } else {
                ctx.ui.notify("Pi settings saved — /reload (or restart) to apply.", "info");
              }
            } catch (e) {
              ctx.ui.notify(`Pi settings save failed: ${e instanceof Error ? e.message : e}`, "error");
            }
          }
        },
      });
    },
  });
}
