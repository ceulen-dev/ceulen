/**
 * config module — owns the central `/config` panel for all ceulen modules.
 *
 * Renders one panel (extensions/lib/panel.ts) from per-module contributions:
 * pi core settings (piSettings.ts), every ceulen module's descriptor groups,
 * and the pi-package (plugins) groups — all categorized under OMP's settings
 * taxonomy (Appearance, Model, Interaction, Context, Tasks, Providers, …).
 *
 * Modules are always loaded; the `ceulen.disabled` settings key is a
 * settings.json-only escape hatch read by the bundle entry, never edited here.
 * Cold tools register `exposure: "deferred"` (registry `deferredTools`), so
 * there is no per-module Enable row and no per-tool toggle — /config carries
 * only functional settings. Save routes edited row keys to their owner:
 * `pi.*` → SettingsManager.flush(), `ceulen.plugins.*` → the packages file,
 * `<module>.<key>` → the module's `save()` — each in its own try/catch, so
 * one failure never blocks the others.
 *
 * Naming note: `/settings` is a Pi builtin — an extension command with that
 * name is skipped in autocomplete and renamed (`/settings:1`), never an
 * override. `/config` is unused by Pi core.
 */

import { SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { builtinToolRows, DEFAULT_TOOLS_PREFIX, nextDefaultTools, startupToolSet, writeDefaultTools } from "./defaultTools.js";
import { openConfigPanel, row, type PanelGroup } from "../../lib/panel.js";
import { agentDirs, MODULES, type ModuleConfig, type ModuleLoadDeps } from "../../lib/registry.js";
import { buildPiSettingsGroups, isPiKey, PI_TAB_ORDER, type PiMenuLookup } from "./piSettings.js";
import { buildPluginsGroups, isPluginsKey, openPluginsWorking, savePlugins } from "./plugins.js";

/** Apply the disabled-tools list to the LIVE session: drop newly disabled
 *  tools, re-activate newly enabled ones (registered tools only — unknown
 *  names are ignored by setActiveTools). Exported for tests. */
export function applyToolSwitches(pi: { getActiveTools(): string[]; getAllTools(): { name: string }[]; setActiveTools(names: string[]): void }, before: Set<string>, after: Set<string>): void {
  const registered = new Set(pi.getAllTools().map((t) => t.name));
  const active = new Set(pi.getActiveTools());
  for (const t of before) {
    if (!after.has(t)) active.delete(t);
  }
  for (const t of after) {
    if (!before.has(t) && registered.has(t)) active.add(t);
  }
  pi.setActiveTools([...active]);
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
        ...(mo.reasoning === false ? { reasoning: false } : {}),
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
  const lines = ["── Ceulen config ──"];
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
    "Escape hatch: `ceulen.disabled` in settings.json (no UI); /reload applies.",
  );
  return lines;
}

export default function configModule(pi: ExtensionAPI, deps?: ModuleLoadDeps): void {
  // One contribution factory per module that opted in, keyed by module name.
  // Each factory closes over the module's OWN guarded pi (see ModuleLoadDeps),
  // so a save that re-registers a provider stays the owner's claim.
  const factories = deps?.configContribs ?? new Map<string, () => ModuleConfig>();


  pi.registerCommand("config", {
    description: "Central settings panel for all ceulen modules.",
    handler: async (args, ctx) => {
      const sub = String(args ?? "").trim().toLowerCase();
      const pluginsWorking = openPluginsWorking();
      // Pi core settings: an OWN SettingsManager instance over the same files
      // (typed setters persist to global settings.json with pi's own locking;
      // the running session picks changes up on /reload).
      const piSettings = SettingsManager.create(ctx.cwd, agentDirs()[0]);

      // Pi's built-in tools (defaultTools setting): one working Set of
      // enabled names, toggled by the Built-in tools rows and diffed on save
      // (persist + live apply). initialStartup is the pre-panel state the
      // live-apply diff runs against.
      const initialStartup = startupToolSet(piSettings);
      const workingStartup = new Set(initialStartup);

      // The loader skips a module named in the `ceulen.disabled` settings
      // escape hatch, so its factory (and section) never renders here — the
      // settings.json key is the only way back, by design (no UI toggles).
      const contributions = [...factories.entries()].map(([name, factory]) => ({ name, cfg: factory() }));

      // Assemble in OMP taxonomy order: pi settings first (they own the
      // Appearance/Model/Interaction/Context/Shell spine), then ceulen module
      // sections (functional rows only — no Enable/tool toggles), then plugins.
      const assemble = (): PanelGroup[] => {
        const modGroups = contributions.flatMap((c) => c.cfg.groups());
        // Plugins' package sections precede the config module's own switch.
        const piGroups = buildPiSettingsGroups(piSettings, piMenuLookup(ctx));
        // Built-in tools lead the Tools tab (before the extension-dirs rows).
        const toolsAt = piGroups.findIndex((g) => g.tab === "Tools");
        piGroups.splice(toolsAt === -1 ? piGroups.length : toolsAt, 0, {
          key: "pi-tools-builtin",
          label: "Built-in tools",
          tab: "Tools",
          rows: builtinToolRows(workingStartup),
        });
        const all = [...piGroups, ...buildPluginsGroups(pluginsWorking), ...modGroups];
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
        // Per-model thinking override rows grow/shrink with the manager
        // state — rebuild on every committed edit so add/clear is visible.
        rebuildOnCommit: true,
        onSave: async (_saved, edited) => {
          const keys = edited ?? new Set<string>();

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

          // Module contributions: each isolated — one module's failure must
          // never block the others.
          await saveContributions(contributions, keys, ctx);

          // Pi's built-in tools: persist the selection (stock-equal deletes
          // the key) and apply the delta to the LIVE session — the startup
          // selection is also the current session's tool set.
          if ([...keys].some((k) => k.startsWith(DEFAULT_TOOLS_PREFIX))) {
            try {
              const file = writeDefaultTools(nextDefaultTools(workingStartup));
              applyToolSwitches(pi, initialStartup, workingStartup);
              const changed = [...initialStartup].filter((t) => !workingStartup.has(t))
                .concat([...workingStartup].filter((t) => !initialStartup.has(t)));
              ctx.ui.notify(
                changed.length > 0
                  ? `Default tools ${changed.map((t) => (workingStartup.has(t) ? `+${t}` : `-${t}`)).join(" ")} — saved to ${file}, applied live.`
                  : `Default tools saved to ${file}.`,
                "info",
              );
            } catch (e) {
              ctx.ui.notify(`Default tools save failed: ${e instanceof Error ? e.message : e}`, "error");
            }
          }

          // Pi core settings: setters already queued their writes; flush the
          // manager's write queue and surface any persistence errors. The
          // built-in-tools rows above persist through their own file write,
          // not the manager — they never enter this branch.
          if ([...keys].some((k) => isPiKey(k) && !k.startsWith(DEFAULT_TOOLS_PREFIX))) {
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
