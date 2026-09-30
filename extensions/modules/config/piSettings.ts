/**
 * Pi core settings contribution to the central /config panel.
 *
 * Rows are backed by pi's OWN public `SettingsManager` (exported from the
 * package root): typed getters return effective values (global ⊕ project),
 * typed setters persist to the GLOBAL settings.json with pi's own layering,
 * locking and atomic-write logic, and `flush()` drains the write queue before
 * the panel reports success. Only settings WITH a typed setter are surfaced —
 * fields like `externalEditor`, `sessionDir`, `defaultTools` or
 * `branchSummary.*` remain config-file-only rather than duplicate
 * SettingsManager's persistence by hand.
 *
 * Tab/section names follow OMP's settings taxonomy (Appearance, Model,
 * Interaction, Context, Shell, …) so ceulen modules and pi core settings read
 * as one system; tabs with no settable rows are omitted.
 *
 * Everything a row writes needs /reload (or a new session) to be picked up by
 * the running process — pi's live SettingsManager is a different instance, and
 * even the Model row only persists the DEFAULT (new sessions): a live model
 * switch requires the session's own setModel() (agent-session.js), which the
 * public extension API doesn't expose. The ONE exception is the Theme row when
 * the /config command supplies a PiMenuLookup: it previews/commits through
 * ctx.ui.setTheme, which applies to the running session immediately.
 */

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { row, type PanelGroup, type PanelMenuOption } from "../../lib/panel.js";

/** pi's thinking levels (core/defaults.ts THINKING_LEVEL_OPTIONS). */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** pi's transports (pi-ai types). */
const TRANSPORTS = ["auto", "sse", "websocket", "websocket-cached"] as const;
const TUI_MODES = ["regular", "fullscreen"] as const;
const FULLSCREEN_EXIT = ["transcript", "resume-hint"] as const;
const FULLSCREEN_SCROLLBAR = ["hidden", "auto", "always"] as const;
const MERMAID_MODES = ["off", "final", "streaming"] as const;
const CACHE_WARMING = ["streaming", "off", "idle"] as const;
const STEERING_MODES = ["one-at-a-time", "all"] as const;
const DOUBLE_ESCAPE = ["tree", "fork", "none"] as const;
const TREE_FILTERS = ["default", "no-tools", "user-only", "labeled-only", "all"] as const;
const PROJECT_TRUST = ["ask", "always", "never"] as const;
const OUTPUT_PADS = ["1", "0"] as const;

/** One declarative row spec over the manager (order defines render order). */
interface PiRowSpec {
  key: string;
  tab: string;
  section: string;
  label: string;
  kind: "toggle" | "string" | "number";
  value: unknown;
  values?: readonly string[];
  menu?: () => PanelMenuOption[];
  preview?: (value: string) => void;
  previewCancel?: () => void;
  defaultValue?: unknown;
  description: string;
  warning?: string;
  set(v: unknown): void;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const joinedList = (v: unknown): string => (Array.isArray(v) ? v.join(" ") : "");
const splitList = (v: unknown): string[] | undefined => {
  const parts = str(v).trim().split(/[\s,]+/).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
};

/** Wrap a numeric setter: the panel's number rows pass the raw typed text
 *  through (`kindValue` returns the string when it does not parse), and some
 *  SettingsManager setters THROW on non-finite input — a throw here would
 *  escape the panel's input handler. Ignore unparseable values (the row keeps
 *  its previous value). */
const num = (fn: (n: number) => void) => (v: unknown): void => {
  const n = Number(v);
  if (Number.isFinite(n)) fn(n);
};

/** Runtime lookups the /config command supplies from its ExtensionContext —
 *  the only panel data that does NOT come from a SettingsManager. Absent in
 *  tests and headless `show` paths, in which case the affected rows stay plain
 *  text rows. */
export interface PiMenuLookup {
  /** Available theme names (ctx.ui.getAllThemes). */
  themes?(): string[];
  /** Apply a theme LIVE without persisting (ctx.ui.setTheme with a Theme
   *  instance — settings.json stays untouched while browsing). Captures the
   *  theme that was live so `restoreTheme` can undo the preview. */
  previewTheme?(name: string): void;
  /** Undo the last theme preview (restore the captured instance). */
  restoreTheme?(): void;
  /** Apply a theme LIVE and persist it (ctx.ui.setTheme with the name). */
  applyTheme?(name: string): void;
  /** Model catalog entries for the Default model row (ctx.modelRegistry
   *  .getAvailable), rendered as `provider/id`. */
  models?(): { provider: string; id: string; description?: string }[];
}

/** The Default model row value: `provider/id` (either half alone renders as
 *  itself so a half-configured pair stays visible). */
const modelValue = (m: SettingsManager): string => {
  const p = str(m.getDefaultProvider());
  const id = str(m.getDefaultModel());
  return p && id ? `${p}/${id}` : (id || p);
};

/** Split a `provider/id` menu value; undefined for malformed input (the
 *  setter then keeps the previous value instead of writing garbage). */
const splitModel = (v: unknown): { provider: string; id: string } | undefined => {
  const s = str(v);
  const at = s.indexOf("/");
  if (at <= 0 || at === s.length - 1) return undefined;
  return { provider: s.slice(0, at), id: s.slice(at + 1) };
};

/** Every pi-core setting the panel surfaces, mapped into OMP's tabs. */
function piRowSpecs(m: SettingsManager, lookup?: PiMenuLookup): PiRowSpec[] {
  return [
    // ── Appearance ────────────────────────────────────────────────────────
    {
      key: "pi.theme", tab: "Appearance", section: "Theme", label: "Theme",
      kind: "string", value: str(m.getThemeSetting()),
      description: lookup
        ? "Color theme for the session. Browse themes with ↑/↓ to preview live; Enter selects."
        : "Name of the color theme (see /theme). Applies after /reload.",
      ...(lookup?.themes
        ? {
            // Lazy: theme lists are read at open time (and may be empty —
            // openMenu then falls back to the inline editor).
            menu: () => {
              const names = lookup.themes?.() ?? [];
              const cur = str(m.getThemeSetting());
              const all = cur && !names.includes(cur) ? [cur, ...names] : names;
              return all.map((n) => ({ value: n, label: n }));
            },
            preview: (v: string) => lookup.previewTheme?.(v),
            // Esc: undo the live preview (OMP's onPreviewCancel) — the lookup
            // captured the pre-browse theme on the first preview.
            previewCancel: () => lookup.restoreTheme?.(),
            // Commit: persist through the panel's own manager (flushed on
            // save) AND live-apply + persist via ctx.ui — the preview hook is
            // not fired on commit (kernel contract), so the row's set owns
            // the live apply.
            set: (v: unknown) => {
              m.setTheme(str(v));
              lookup.applyTheme?.(str(v));
            },
          }
        : { set: (v: unknown) => m.setTheme(str(v)) }),
    },
    {
      key: "pi.markdown.mermaid", tab: "Appearance", section: "Display", label: "Mermaid diagrams",
      kind: "string", value: m.getMermaidRenderingMode(), values: MERMAID_MODES, defaultValue: "streaming",
      description: "How mermaid diagrams in responses are rendered.",
      set: (v) => m.setMermaidRenderingMode(str(v) as never),
    },
    {
      key: "pi.terminal.showTerminalProgress", tab: "Appearance", section: "Display", label: "Terminal progress",
      kind: "toggle", value: m.getShowTerminalProgress(), defaultValue: false,
      description: "Report progress to the terminal's native progress protocol.",
      set: (v) => m.setShowTerminalProgress(Boolean(v)),
    },
    {
      key: "pi.terminal.clearOnShrink", tab: "Appearance", section: "Display", label: "Clear on shrink",
      kind: "toggle", value: m.getClearOnShrink(), defaultValue: false,
      description: "Clear stale lines when the terminal shrinks. PI_CLEAR_ON_SHRINK env overrides.",
      set: (v) => m.setClearOnShrink(Boolean(v)),
    },
    {
      key: "pi.showHardwareCursor", tab: "Appearance", section: "Editor", label: "Show hardware cursor",
      kind: "toggle", value: m.getShowHardwareCursor(), defaultValue: false,
      description: "Show the terminal's real cursor in the editor. PI_HARDWARE_CURSOR env overrides.",
      set: (v) => m.setShowHardwareCursor(Boolean(v)),
    },
    {
      key: "pi.editorPaddingX", tab: "Appearance", section: "Editor", label: "Editor padding",
      kind: "number", value: m.getEditorPaddingX(), defaultValue: 0,
      description: "Horizontal editor padding in columns (0–3).",
      set: num((n) => m.setEditorPaddingX(n)),
    },
    {
      key: "pi.outputPad", tab: "Appearance", section: "Editor", label: "Output padding",
      kind: "string", value: String(m.getOutputPad()), values: OUTPUT_PADS, defaultValue: "1",
      description: "Add a blank line between output blocks.",
      set: (v) => m.setOutputPad(Number(v) === 0 ? 0 : 1),
    },
    {
      key: "pi.autocompleteMaxVisible", tab: "Appearance", section: "Editor", label: "Autocomplete max items",
      kind: "number", value: m.getAutocompleteMaxVisible(), defaultValue: 5,
      description: "Most completion rows shown at once (3–20).",
      set: num((n) => m.setAutocompleteMaxVisible(n)),
    },
    {
      key: "pi.tuiMode", tab: "Appearance", section: "Fullscreen", label: "TUI mode",
      kind: "string", value: m.getTuiMode(), values: TUI_MODES, defaultValue: "regular",
      description: "Regular scrolling transcript or the alternate-screen fullscreen UI.",
      set: (v) => m.setTuiMode(str(v) as never),
    },
    {
      key: "pi.fullscreenExitOutput", tab: "Appearance", section: "Fullscreen", label: "Fullscreen exit output",
      kind: "string", value: m.getFullscreenExitOutput(), values: FULLSCREEN_EXIT, defaultValue: "transcript",
      description: "What the alternate screen leaves behind on exit.",
      set: (v) => m.setFullscreenExitOutput(str(v) as never),
    },
    {
      key: "pi.fullscreenScrollbar", tab: "Appearance", section: "Fullscreen", label: "Fullscreen scrollbar",
      kind: "string", value: m.getFullscreenScrollbar(), values: FULLSCREEN_SCROLLBAR, defaultValue: "auto",
      description: "Scrollbar visibility in fullscreen mode.",
      set: (v) => m.setFullscreenScrollbar(str(v) as never),
    },
    {
      key: "pi.fullscreenCopyOnSelect", tab: "Appearance", section: "Fullscreen", label: "Copy on select",
      kind: "toggle", value: m.getFullscreenCopyOnSelect(), defaultValue: true,
      description: "Copy selected text in fullscreen mode automatically.",
      set: (v) => m.setFullscreenCopyOnSelect(Boolean(v)),
    },
    {
      key: "pi.terminal.showImages", tab: "Appearance", section: "Images", label: "Show images",
      kind: "toggle", value: m.getShowImages(), defaultValue: true,
      description: "Render images inline in the terminal.",
      set: (v) => m.setShowImages(Boolean(v)),
    },
    {
      key: "pi.terminal.imageWidthCells", tab: "Appearance", section: "Images", label: "Image width",
      kind: "number", value: m.getImageWidthCells(), defaultValue: 60,
      description: "Preferred inline-image width in terminal cells.",
      set: num((n) => m.setImageWidthCells(n)),
    },
    {
      key: "pi.images.autoResize", tab: "Appearance", section: "Images", label: "Auto-resize images",
      kind: "toggle", value: m.getImageAutoResize(), defaultValue: true,
      description: "Shrink oversized images to the terminal width.",
      set: (v) => m.setImageAutoResize(Boolean(v)),
    },
    {
      key: "pi.images.blockImages", tab: "Appearance", section: "Images", label: "Block images",
      kind: "toggle", value: m.getBlockImages(), defaultValue: false,
      description: "Refuse to send images to the model.",
      set: (v) => m.setBlockImages(Boolean(v)),
    },

    // ── Model ─────────────────────────────────────────────────────────────
    {
      key: "pi.defaultModel", tab: "Model", section: "Default model", label: "Default model",
      kind: "string", value: modelValue(m),
      description: lookup?.models
        ? "Model for NEW sessions as provider/id (applies after /reload). Enter opens the catalogue picker."
        : "Model id used for new sessions (see /model, which sets provider + id together).",
      ...(lookup?.models
        ? {
            // Lazy: the catalogue is read at open time (it can refresh).
            menu: () =>
              (lookup.models?.() ?? []).map((e) => ({
                value: `${e.provider}/${e.id}`,
                label: `${e.provider}/${e.id}`,
                ...(e.description ? { description: e.description } : {}),
              })),
            set: (v: unknown) => {
              const split = splitModel(v);
              if (!split) return;
              m.setDefaultModelAndProvider(split.provider, split.id);
            },
          }
        : { set: (v: unknown) => m.setDefaultModel(str(v)) }),
    },
    {
      key: "pi.defaultProvider", tab: "Model", section: "Default model", label: "Default provider",
      kind: "string", value: str(m.getDefaultProvider()),
      description: "Provider id paired with the default model.",
      set: (v) => m.setDefaultProvider(str(v)),
    },
    {
      key: "pi.enabledModels", tab: "Model", section: "Default model", label: "Enabled models",
      kind: "string", value: joinedList(m.getEnabledModels()),
      description: "Space-separated model patterns to scope the session (empty = all models).",
      set: (v) => m.setEnabledModels(splitList(v)),
    },
    {
      key: "pi.defaultThinkingLevel", tab: "Model", section: "Thinking", label: "Default thinking level",
      kind: "string", value: str(m.getDefaultThinkingLevel() ?? "medium"), values: THINKING_LEVELS, defaultValue: "medium",
      description: "Thinking level for new sessions.",
      set: (v) => m.setDefaultThinkingLevel(str(v) as never),
    },
    {
      key: "pi.hideThinkingBlock", tab: "Model", section: "Thinking", label: "Hide thinking",
      kind: "toggle", value: m.getHideThinkingBlock(), defaultValue: false,
      description: "Collapse thinking blocks in the transcript.",
      set: (v) => m.setHideThinkingBlock(Boolean(v)),
    },
    {
      key: "pi.transport", tab: "Model", section: "Network", label: "Transport",
      kind: "string", value: m.getTransport(), values: TRANSPORTS, defaultValue: "auto",
      description: "Streaming transport for provider requests.",
      set: (v) => m.setTransport(str(v) as never),
    },
    {
      key: "pi.httpIdleTimeoutMs", tab: "Model", section: "Network", label: "HTTP idle timeout",
      kind: "number", value: m.getHttpIdleTimeoutMs(), defaultValue: 300000,
      description: "Drop idle provider connections after this many ms.",
      set: num((n) => m.setHttpIdleTimeoutMs(Math.max(0, n))),
    },
    {
      key: "pi.retry.enabled", tab: "Model", section: "Retry & Fallback", label: "Retry on failure",
      kind: "toggle", value: m.getRetryEnabled(), defaultValue: true,
      description: "Retry failed provider requests.",
      set: (v) => m.setRetryEnabled(Boolean(v)),
    },
    {
      key: "pi.cacheWarming", tab: "Model", section: "Efficiency", label: "Cache warming",
      kind: "string", value: m.getCacheWarmingMode(), values: CACHE_WARMING, defaultValue: "streaming",
      description: "Warm the prompt cache during streaming or idle time (costs tokens).",
      set: (v) => m.setCacheWarmingMode(str(v) as never),
    },
    {
      key: "pi.showCacheMissNotices", tab: "Model", section: "Efficiency", label: "Cache miss notices",
      kind: "toggle", value: m.getShowCacheMissNotices(), defaultValue: false,
      description: "Show a notice when the prompt cache is missed.",
      set: (v) => m.setShowCacheMissNotices(Boolean(v)),
    },
    {
      key: "pi.warnings.anthropicExtraUsage", tab: "Model", section: "Warnings", label: "Anthropic extra usage",
      kind: "toggle", value: Boolean(m.getWarnings().anthropicExtraUsage), defaultValue: false,
      description: "Warn when requests bill against extra usage.",
      set: (v) => m.setWarnings({ ...m.getWarnings(), anthropicExtraUsage: Boolean(v) }),
    },

    // ── Interaction ───────────────────────────────────────────────────────
    {
      key: "pi.steeringMode", tab: "Interaction", section: "Input", label: "Steering mode",
      kind: "string", value: m.getSteeringMode(), values: STEERING_MODES, defaultValue: "one-at-a-time",
      description: "Queue one message at a time or all of them while the agent runs.",
      set: (v) => m.setSteeringMode(str(v) as never),
    },
    {
      key: "pi.followUpMode", tab: "Interaction", section: "Input", label: "Follow-up mode",
      kind: "string", value: m.getFollowUpMode(), values: STEERING_MODES, defaultValue: "one-at-a-time",
      description: "How follow-up messages queue after a run finishes.",
      set: (v) => m.setFollowUpMode(str(v) as never),
    },
    {
      key: "pi.doubleEscapeAction", tab: "Interaction", section: "Input", label: "Double-escape action",
      kind: "string", value: m.getDoubleEscapeAction(), values: DOUBLE_ESCAPE, defaultValue: "tree",
      description: "What double-Esc opens: session tree, fork picker, or nothing.",
      set: (v) => m.setDoubleEscapeAction(str(v) as never),
    },
    {
      key: "pi.treeFilterMode", tab: "Interaction", section: "Input", label: "Tree filter mode",
      kind: "string", value: m.getTreeFilterMode(), values: TREE_FILTERS, defaultValue: "default",
      description: "Default filter for the session tree view.",
      set: (v) => m.setTreeFilterMode(str(v) as never),
    },
    {
      key: "pi.quietStartup", tab: "Interaction", section: "Startup & Notices", label: "Quiet startup",
      kind: "toggle", value: m.getQuietStartup(), defaultValue: false,
      description: "Skip the startup banner.",
      set: (v) => m.setQuietStartup(Boolean(v)),
    },
    {
      key: "pi.collapseChangelog", tab: "Interaction", section: "Startup & Notices", label: "Collapse changelog",
      kind: "toggle", value: m.getCollapseChangelog(), defaultValue: false,
      description: "Show the changelog collapsed after an update.",
      set: (v) => m.setCollapseChangelog(Boolean(v)),
    },
    {
      key: "pi.enableSkillCommands", tab: "Interaction", section: "Startup & Notices", label: "Skill commands",
      kind: "toggle", value: m.getEnableSkillCommands(), defaultValue: true,
      description: "Expose skills as slash commands.",
      set: (v) => m.setEnableSkillCommands(Boolean(v)),
    },
    {
      key: "pi.defaultProjectTrust", tab: "Interaction", section: "Trust & Telemetry", label: "Default project trust",
      kind: "string", value: m.getDefaultProjectTrust(), values: PROJECT_TRUST, defaultValue: "ask",
      description: "Whether new projects are trusted without asking.",
      warning: "Trusting projects automatically lets their extensions and .env files run.",
      set: (v) => m.setDefaultProjectTrust(str(v) as never),
    },
    {
      key: "pi.enableInstallTelemetry", tab: "Interaction", section: "Trust & Telemetry", label: "Install telemetry",
      kind: "toggle", value: m.getEnableInstallTelemetry(), defaultValue: true,
      description: "Send anonymous install/update counts.",
      set: (v) => m.setEnableInstallTelemetry(Boolean(v)),
    },
    {
      key: "pi.enableAnalytics", tab: "Interaction", section: "Trust & Telemetry", label: "Analytics",
      kind: "toggle", value: m.getEnableAnalytics(), defaultValue: false,
      description: "Opt in to anonymous usage analytics (generates a tracking id on first enable).",
      set: (v) => m.setEnableAnalytics(Boolean(v)),
    },

    // ── Context ───────────────────────────────────────────────────────────
    {
      key: "pi.compaction.enabled", tab: "Context", section: "Compaction", label: "Auto-compact",
      kind: "toggle", value: m.getCompactionEnabled(), defaultValue: true,
      description: "Compact the conversation automatically when it approaches the context limit.",
      set: (v) => m.setCompactionEnabled(Boolean(v)),
    },

    // ── Shell ─────────────────────────────────────────────────────────────
    {
      key: "pi.shellPath", tab: "Shell", section: "Bash", label: "Shell path",
      kind: "string", value: str(m.getShellPath()),
      description: "Shell binary used for bash tool calls (empty = system default).",
      set: (v) => m.setShellPath(str(v) || undefined),
    },
    {
      key: "pi.shellCommandPrefix", tab: "Shell", section: "Bash", label: "Command prefix",
      kind: "string", value: str(m.getShellCommandPrefix()),
      description: "Prefix prepended to every bash command (e.g. an env setup snippet).",
      set: (v) => m.setShellCommandPrefix(str(v) || undefined),
    },
    {
      key: "pi.npmCommand", tab: "Shell", section: "Bash", label: "npm command",
      kind: "string", value: joinedList(m.getNpmCommand()),
      description: "Space-separated npm command override (e.g. a registry mirror wrapper).",
      set: (v) => m.setNpmCommand(splitList(v)),
    },
  ];
}

/** Build the pi-settings sections, grouped by (tab, section) in spec order.
 *  `lookup` (from the /config command's ctx) upgrades the Theme and Default
 *  model rows into live selection submenus; without it they stay text rows. */
export function buildPiSettingsGroups(m: SettingsManager, lookup?: PiMenuLookup): PanelGroup[] {
  const groups: PanelGroup[] = [];
  const byKey = new Map<string, PanelGroup>();
  for (const spec of piRowSpecs(m, lookup)) {
    const gkey = `${spec.tab}\u0000${spec.section}`;
    let group = byKey.get(gkey);
    if (!group) {
      group = { key: `pi-${spec.tab}-${spec.section}`, label: spec.section, tab: spec.tab, rows: [] };
      const icon = PI_TAB_ICONS[spec.tab];
      if (icon) group.icon = icon;
      byKey.set(gkey, group);
      groups.push(group);
    }
    group.rows.push(
      row(spec.key, spec.label, spec.kind, spec.value, (v) => spec.set(v), {
        values: spec.values,
        menu: spec.menu,
        preview: spec.preview,
        previewCancel: spec.previewCancel,
        defaultValue: spec.defaultValue,
        description: spec.description,
        warning: spec.warning,
      }),
    );
  }
  return groups;
}

/** OMP tab order — the assembly order for the whole panel. */
export const PI_TAB_ORDER = ["Appearance", "Model", "Interaction", "Context", "Memory", "Files", "Shell", "Tools", "Tasks", "Providers", "Plugins"] as const;

/** Tab-chip icons for the pi-owned tabs (ceulen sections bring their own). */
const PI_TAB_ICONS: Record<string, string> = {
  Appearance: "🎨",
  Model: "🤖",
  Interaction: "⌨️",
  Context: "🧠",
  Shell: "🖥️",
};

/** True when a row key belongs to the pi-settings contribution. */
export function isPiKey(key: string): boolean {
  return key.startsWith("pi.");
}
