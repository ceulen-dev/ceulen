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
import { builtinToolRows, DEFAULT_TOOLS_PREFIX, nextDefaultTools, startupToolSet, writeDefaultTools } from "./defaultTools.js";
import { openConfigPanel, row, type PanelGroup } from "../../lib/panel.js";
import { agentDirs, isCore, MODULES, disabledSource, readDisabled, writeDisabled, type ModuleConfig, type ModuleLoadDeps } from "../../lib/registry.js";
import { readDisabledTools, writeDisabledTools } from "../../lib/tools.js";
import { buildPiSettingsGroups, isPiKey, PI_TAB_ORDER, type PiMenuLookup } from "./piSettings.js";
import { buildPluginsGroups, isPluginsKey, openPluginsWorking, savePlugins } from "./plugins.js";

export const KILL_SWITCH_PREFIX = "ceulen.disabled.";
export const TOOL_SWITCH_PREFIX = "ceulen.disabledTools.";

/** Display overrides for tool rows whose bare name would not explain itself
 *  (the row IS the tool's kill-switch, so it must say what on/off means).
 *  Tools without an entry keep the bare tool name — the identity the model
 *  sees — with the generic registration description. */
const TOOL_PRETTY: Record<string, { label: string; description: string }> = {
  advisor: {
    label: "Consult tool",
    description: "Registers the advisor tool so the agent can ask for a second opinion on demand. Off = not registered; the background review is unaffected.",
  },
};

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

/** One per-tool toggle row (key `ceulen.disabledTools.<tool>` over the given
 *  working set of ENABLED tool names). Applied live on save — no /reload. */
export function moduleToolRow(tool: string, working: Set<string>): ReturnType<typeof row> {
  const pretty = TOOL_PRETTY[tool];
  return row(`${TOOL_SWITCH_PREFIX}${tool}`, pretty?.label ?? tool, "toggle", working.has(tool), (v) => {
    if (v) working.add(tool);
    else working.delete(tool);
  }, {
    description: pretty?.description ?? "Registers the tool inactive when off — applied to this session immediately on save.",
    defaultValue: true,
  });
}

/** Toggle rows for every tool a module declares. Exported for tests. */
export function moduleToolRows(tools: string[] | undefined, working: Set<string>): ReturnType<typeof row>[] {
  return (tools ?? []).map((t) => moduleToolRow(t, working));
}

/** Append the module's tool rows after its (first-section) rows. A no-op for
 *  modules without a `tools` list. Exported for tests. */
export function withToolRows(groups: PanelGroup[], tools: string[] | undefined, working: Set<string>): PanelGroup[] {
  const rows = moduleToolRows(tools, working);
  if (rows.length === 0) return groups;
  const [first, ...rest] = groups;
  if (!first) return groups;
  return [{ ...first, rows: [...first.rows, ...rows] }, ...rest];
}

/** The disabled-tools list that results from toggling `working` (enabled set)
 *  across every ceulen-declared tool. Pure — exported for tests. */
export function nextDisabledTools(working: Set<string>): string[] {
  return MODULES.flatMap((m) => m.tools ?? []).filter((n) => !working.has(n));
}

/** Every tool name ceulen modules declare. */
export function allDeclaredTools(): string[] {
  return MODULES.flatMap((m) => m.tools ?? []);
}

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
  const PRETTY_OF: Record<string, { section: string; icon?: string }> = {
    router: { section: "Router", icon: "🌐" },
    classifier: { section: "Classifier (Jev)", icon: "⚖" },
    advisor: { section: "Advisor", icon: "🧭" },
    usage: { section: "Usage footer", icon: "📊" },
    munin: { section: "Munin", icon: "🪶" },
    composer: { section: "Composer", icon: "🎨" },
    ux: { section: "UX discipline", icon: "📐" },
    ponytail: { section: "Ponytail", icon: "🦥" },
    serena: { section: "Serena" },
    fff: { section: "FFF search" },
    rtk: { section: "RTK" },
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
      const workingTools = new Set(allDeclaredTools().filter((t) => !readDisabledTools().has(t)));
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
          return withToolRows(withEnableRow(groups, c.name, module?.describe ?? "", workingEnabled), module?.tools, workingTools);
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
            rows: [moduleEnableRow(m.name, m.describe ?? "", workingEnabled), ...moduleToolRows(m.tools, workingTools)],
          });
        }
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

          // Kill-switch first: compare the working Set against what's persisted.
          if ([...keys].some((k) => k.startsWith(KILL_SWITCH_PREFIX))) {
            try {
              const file = writeDisabled(nextDisabled(workingEnabled));
              ctx.ui.notify(`Module kill-switch saved to ${file} — /reload (or restart) to apply.`, "info");
            } catch (e) {
              ctx.ui.notify(`Kill-switch save failed: ${e instanceof Error ? e.message : e}`, "error");
            }
          }

          if ([...keys].some((k) => k.startsWith(TOOL_SWITCH_PREFIX))) {
            try {
              const before = new Set(allDeclaredTools().filter((t) => !readDisabledTools().has(t)));
              const after = workingTools;
              const file = writeDisabledTools(nextDisabledTools(after));
              applyToolSwitches(pi, before, after);
              const changed = allDeclaredTools().filter((t) => before.has(t) !== after.has(t));
              ctx.ui.notify(
                changed.length > 0
                  ? `Tools ${changed.map((t) => (after.has(t) ? `+${t}` : `-${t}`)).join(" ")} — saved to ${file}, applied live.`
                  : `Tool toggles saved to ${file}.`,
                "info",
              );
            } catch (e) {
              ctx.ui.notify(`Tool toggle save failed: ${e instanceof Error ? e.message : e}`, "error");
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
