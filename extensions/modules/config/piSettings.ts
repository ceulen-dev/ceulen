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

// ── stock-/settings parity constants ─────────────────────────────────────────
// Pi's stock /settings selector carries friendly choice sets and per-option
// descriptions that are NOT exported from the package root; deep-importing
// dist internals would break the peer-range drop-in promise, so the handful
// of tiny constants are replicated here (source: pi 0.99.x
// settings-selector.js + core/http-dispatcher.js). Cosmetic drift only.

/** stock THINKING_DESCRIPTIONS — per-option submenu descriptions. */
const THINKING_DESCRIPTIONS: Record<string, string> = {
  off: "No reasoning",
  minimal: "Very brief reasoning (~1k tokens)",
  low: "Light reasoning (~2k tokens)",
  medium: "Moderate reasoning (~8k tokens)",
  high: "Deep reasoning (~16k tokens)",
  xhigh: "Extra-high reasoning (~32k tokens)",
  max: "Maximum reasoning",
};

/** stock HTTP_IDLE_TIMEOUT_CHOICES (label ↔ ms, "disabled" = 0). */
const HTTP_TIMEOUT_CHOICES: readonly (readonly [string, number])[] = [
  ["disabled", 0],
  ["30 sec", 30_000],
  ["1 min", 60_000],
  ["2 min", 120_000],
  ["5 min", 300_000],
];
const httpTimeoutLabel = (ms: number): string =>
  HTTP_TIMEOUT_CHOICES.find(([, v]) => v === ms)?.[0] ?? `${ms / 1000} sec`;
const httpTimeoutMs = (label: string): number | undefined =>
  HTTP_TIMEOUT_CHOICES.find(([l]) => l === label)?.[1];

/** stock DEFAULT_PROJECT_TRUST_LABELS. */
const TRUST_LABELS: readonly (readonly [string, string])[] = [
  ["Ask", "ask"],
  ["Always trust", "always"],
  ["Never trust", "never"],
];
const trustLabel = (v: string): string => TRUST_LABELS.find(([, e]) => e === v)?.[0] ?? v;
const trustEnum = (label: string): string | undefined =>
  TRUST_LABELS.find(([l]) => l === label)?.[1];

/** stock fullscreen wheel-scroll choices ("auto" + line counts). */
const WHEEL_CHOICES = ["auto", "1", "2", "3", "5", "10"] as const;
const wheelChoices = (current: string): string[] =>
  current && !WHEEL_CHOICES.includes(current as never) ? [current, ...WHEEL_CHOICES] : [...WHEEL_CHOICES];

/** stock editor-padding / autocomplete / image-width choice sets. */
const EDITOR_PAD_CHOICES = ["0", "1", "2", "3"] as const;
const AUTOCOMPLETE_CHOICES = ["3", "5", "7", "10", "15", "20"] as const;
const IMAGE_WIDTH_CHOICES = ["60", "80", "120"] as const;
const withCurrent = (choices: readonly string[], current: string): string[] =>
  current && !choices.includes(current) ? [current, ...choices] : [...choices];

/** Per-model override clear sentinel (stock's stepped-submenu "(clear
 *  override)" — a menu value, removed from the map on commit). */
const CLEAR_OVERRIDE = "(clear override)";

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
   *  .getAvailable), rendered as `provider/id`. `reasoning` is the model's
   *  reasoning flag — non-reasoning models only support the "off" level. */
  models?(): { provider: string; id: string; description?: string; reasoning?: boolean }[];
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
      description: "Render Mermaid code blocks as Unicode diagrams.",
      set: (v) => m.setMermaidRenderingMode(str(v) as never),
    },
    {
      key: "pi.terminal.showTerminalProgress", tab: "Appearance", section: "Display", label: "Terminal progress",
      kind: "toggle", value: m.getShowTerminalProgress(), defaultValue: false,
      description: "Show OSC 9;4 progress indicators in the terminal tab bar.",
      set: (v) => m.setShowTerminalProgress(Boolean(v)),
    },
    {
      key: "pi.terminal.clearOnShrink", tab: "Appearance", section: "Display", label: "Clear on shrink",
      kind: "toggle", value: m.getClearOnShrink(), defaultValue: false,
      description: "Clear empty rows when content shrinks (may cause flicker). PI_CLEAR_ON_SHRINK env overrides.",
      set: (v) => m.setClearOnShrink(Boolean(v)),
    },
    {
      key: "pi.showHardwareCursor", tab: "Appearance", section: "Editor", label: "Show hardware cursor",
      kind: "toggle", value: m.getShowHardwareCursor(), defaultValue: false,
      description: "Show the terminal cursor while still positioning it for IME support. PI_HARDWARE_CURSOR env overrides.",
      set: (v) => m.setShowHardwareCursor(Boolean(v)),
    },
    {
      key: "pi.editorPaddingX", tab: "Appearance", section: "Editor", label: "Editor padding",
      kind: "string", value: String(m.getEditorPaddingX()), values: withCurrent(EDITOR_PAD_CHOICES, String(m.getEditorPaddingX())), defaultValue: "0",
      description: "Horizontal padding for input editor (0-3).",
      set: num((n) => m.setEditorPaddingX(n)),
    },
    {
      key: "pi.outputPad", tab: "Appearance", section: "Editor", label: "Output padding",
      kind: "string", value: String(m.getOutputPad()), values: OUTPUT_PADS, defaultValue: "1",
      description: "Horizontal padding for user messages, assistant messages, and thinking.",
      set: (v) => m.setOutputPad(Number(v) === 0 ? 0 : 1),
    },
    {
      key: "pi.autocompleteMaxVisible", tab: "Appearance", section: "Editor", label: "Autocomplete max items",
      kind: "string", value: String(m.getAutocompleteMaxVisible()), values: withCurrent(AUTOCOMPLETE_CHOICES, String(m.getAutocompleteMaxVisible())), defaultValue: "5",
      description: "Max visible items in autocomplete dropdown (3-20).",
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
      description: "Print the transcript or only a session resume hint when exiting fullscreen mode.",
      set: (v) => m.setFullscreenExitOutput(str(v) as never),
    },
    {
      key: "pi.fullscreenScrollbar", tab: "Appearance", section: "Fullscreen", label: "Fullscreen scrollbar",
      kind: "string", value: m.getFullscreenScrollbar(), values: FULLSCREEN_SCROLLBAR, defaultValue: "auto",
      description: "Scrollbar behavior in fullscreen mode; has no effect in regular mode.",
      set: (v) => m.setFullscreenScrollbar(str(v) as never),
    },
    {
      key: "pi.fullscreenCopyOnSelect", tab: "Appearance", section: "Fullscreen", label: "Copy on select",
      kind: "toggle", value: m.getFullscreenCopyOnSelect(), defaultValue: true,
      description: "Automatically copy selected text in fullscreen mode; disable to copy selections with Ctrl+X.",
      set: (v) => m.setFullscreenCopyOnSelect(Boolean(v)),
    },
    {
      key: "pi.fullscreenWheelScrollLines", tab: "Appearance", section: "Fullscreen", label: "Wheel scrolling",
      kind: "string", value: String(m.getFullscreenWheelScrollLines()),
      values: wheelChoices(String(m.getFullscreenWheelScrollLines())), defaultValue: "auto",
      description: "Lines per mouse-wheel event in fullscreen mode; 'auto' speeds up fast wheel spins where the terminal does not.",
      set: (v) => {
        if (v === "auto") {
          m.setFullscreenWheelScrollLines("auto");
          return;
        }
        const n = Number(v);
        if (Number.isFinite(n)) m.setFullscreenWheelScrollLines(n); // clamps 1-100
      },
    },
    {
      key: "pi.terminal.showImages", tab: "Appearance", section: "Images", label: "Show images",
      kind: "toggle", value: m.getShowImages(), defaultValue: true,
      description: "Render images inline in terminal.",
      set: (v) => m.setShowImages(Boolean(v)),
    },
    {
      key: "pi.terminal.imageWidthCells", tab: "Appearance", section: "Images", label: "Image width",
      kind: "string", value: String(m.getImageWidthCells()), values: withCurrent(IMAGE_WIDTH_CHOICES, String(m.getImageWidthCells())), defaultValue: "60",
      description: "Preferred inline-image width in terminal cells.",
      set: num((n) => m.setImageWidthCells(n)),
    },
    {
      key: "pi.images.autoResize", tab: "Appearance", section: "Images", label: "Auto-resize images",
      kind: "toggle", value: m.getImageAutoResize(), defaultValue: true,
      description: "Resize large images to 2000x2000 max for better model compatibility.",
      set: (v) => m.setImageAutoResize(Boolean(v)),
    },
    {
      key: "pi.images.blockImages", tab: "Appearance", section: "Images", label: "Block images",
      kind: "toggle", value: m.getBlockImages(), defaultValue: false,
      description: "Prevent images from being sent to LLM providers.",
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
      kind: "string", value: str(m.getDefaultThinkingLevel() ?? "medium"), defaultValue: "medium",
      description: "Thinking level for new sessions. /thinking cycles in-session.",
      menu: () => THINKING_LEVELS.map((l) => ({ value: l, description: THINKING_DESCRIPTIONS[l] })),
      set: (v) => m.setDefaultThinkingLevel(str(v) as never),
    },
    // ── Per-model thinking overrides (stock /settings "Default thinking level
    //    per model") — one row per configured override + an "Add override"
    //    menu row; openConfigPanel runs with rebuildOnCommit so rows appear
    //    and disappear on commit.
    ...Object.entries(m.getAllModelThinkingLevels()).map(([key, level]) => {
      const at = key.indexOf("/");
      const catalog = lookup?.models?.().find((mo) => `${mo.provider}/${mo.id}` === key);
      const levels = catalog?.reasoning === false ? ["off"] : [...THINKING_LEVELS];
      return {
        key: `pi.modelThinkingLevels.${key}`, tab: "Model", section: "Thinking", label: key,
        kind: "string" as const, value: str(level), defaultValue: CLEAR_OVERRIDE,
        menu: () => [
          ...levels.map((l) => ({ value: l, description: THINKING_DESCRIPTIONS[l] })),
          { value: CLEAR_OVERRIDE, description: `Revert to the default thinking level (${str(m.getDefaultThinkingLevel() ?? "medium")}).` },
        ],
        description: `Per-model thinking override for ${key}. Takes effect for new sessions and model switches.`,
        set: (v: unknown) => {
          if (v === CLEAR_OVERRIDE) {
            if (at > 0) m.removeModelThinkingLevel(key.slice(0, at), key.slice(at + 1));
            return;
          }
          if (at > 0) m.setModelThinkingLevel(key.slice(0, at), key.slice(at + 1), str(v) as never);
        },
      };
    }),
    {
      key: "pi.modelThinkingLevels.add", tab: "Model", section: "Thinking", label: "Add model override",
      kind: "string", value: `${Object.keys(m.getAllModelThinkingLevels()).length} set`,
      description: "Pick a catalog model, then choose its default thinking level on the row that appears. Applies to new sessions.",
      ...(lookup?.models
        ? {
            menu: () => {
              const overridden = new Set(Object.keys(m.getAllModelThinkingLevels()));
              return (lookup.models?.() ?? [])
                .filter((mo) => !overridden.has(`${mo.provider}/${mo.id}`))
                .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
                .map((mo) => ({
                  value: `${mo.provider}/${mo.id}`,
                  label: `${mo.provider}/${mo.id}`,
                  ...(mo.description ? { description: mo.description } : {}),
                }));
            },
          }
        : {}),
      set: (v: unknown) => {
        const split = splitModel(v);
        if (!split) return;
        const catalog = lookup?.models?.().find((mo) => mo.provider === split.provider && mo.id === split.id);
        const initial = catalog?.reasoning === false ? "off" : str(m.getDefaultThinkingLevel() ?? "medium");
        m.setModelThinkingLevel(split.provider, split.id, initial as never);
      },
    },
    {
      key: "pi.hideThinkingBlock", tab: "Model", section: "Thinking", label: "Hide thinking",
      kind: "toggle", value: m.getHideThinkingBlock(), defaultValue: false,
      description: "Collapse thinking blocks in the transcript.",
      set: (v) => m.setHideThinkingBlock(Boolean(v)),
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
      description: "off: never; streaming: while the agent runs; idle: also between runs while continuation stays profitable.",
      set: (v) => m.setCacheWarmingMode(str(v) as never),
    },
    {
      key: "pi.showCacheMissNotices", tab: "Model", section: "Efficiency", label: "Cache miss notices",
      kind: "toggle", value: m.getShowCacheMissNotices(), defaultValue: false,
      description: "Show transcript notices for cache costs and provider recovery diagnostics.",
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
      description: "Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
      set: (v) => m.setSteeringMode(str(v) as never),
    },
    {
      key: "pi.followUpMode", tab: "Interaction", section: "Input", label: "Follow-up mode",
      kind: "string", value: m.getFollowUpMode(), values: STEERING_MODES, defaultValue: "one-at-a-time",
      description: "Queues follow-up messages until the agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
      set: (v) => m.setFollowUpMode(str(v) as never),
    },
    {
      key: "pi.doubleEscapeAction", tab: "Interaction", section: "Input", label: "Double-escape action",
      kind: "string", value: m.getDoubleEscapeAction(), values: DOUBLE_ESCAPE, defaultValue: "tree",
      description: "Action when pressing Escape twice with an empty editor.",
      set: (v) => m.setDoubleEscapeAction(str(v) as never),
    },
    {
      key: "pi.treeFilterMode", tab: "Interaction", section: "Input", label: "Tree filter mode",
      kind: "string", value: m.getTreeFilterMode(), values: TREE_FILTERS, defaultValue: "default",
      description: "Default filter when opening /tree.",
      set: (v) => m.setTreeFilterMode(str(v) as never),
    },
    {
      key: "pi.quietStartup", tab: "Interaction", section: "Startup & Updates", label: "Quiet startup",
      kind: "toggle", value: m.getQuietStartup(), defaultValue: false,
      description: "Disable verbose printing at startup.",
      set: (v) => m.setQuietStartup(Boolean(v)),
    },
    {
      key: "pi.collapseChangelog", tab: "Interaction", section: "Startup & Updates", label: "Collapse changelog",
      kind: "toggle", value: m.getCollapseChangelog(), defaultValue: false,
      description: "Show condensed changelog after updates.",
      set: (v) => m.setCollapseChangelog(Boolean(v)),
    },
    {
      key: "pi.defaultProjectTrust", tab: "Interaction", section: "Trust", label: "Default project trust",
      kind: "string", value: trustLabel(m.getDefaultProjectTrust()), defaultValue: "Ask",
      values: TRUST_LABELS.map(([label]) => label),
      description: "Fallback behavior when no extension or saved trust decision decides project trust.",
      warning: "Trusting projects automatically lets their extensions and .env files run.",
      set: (v) => {
        // Accept the stock label (what the menu commits) or the raw enum.
        const s = str(v);
        const e = trustEnum(s) ?? (PROJECT_TRUST.includes(s as never) ? s : undefined);
        if (e) m.setDefaultProjectTrust(e as never);
      },
    },

    // ── Context ───────────────────────────────────────────────────────────
    {
      key: "pi.compaction.enabled", tab: "Context", section: "Compaction", label: "Auto-compact",
      kind: "toggle", value: m.getCompactionEnabled(), defaultValue: true,
      description: "Automatically compact context when it gets too large.",
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

    // ── Tasks (OMP: Commands & Skills) ────────────────────────────────────
    {
      key: "pi.enableSkillCommands", tab: "Tasks", section: "Commands & Skills", label: "Skill commands",
      kind: "toggle", value: m.getEnableSkillCommands(), defaultValue: true,
      description: "Register skills as /skill:name commands.",
      set: (v) => m.setEnableSkillCommands(Boolean(v)),
    },
    {
      key: "pi.paths.skills", tab: "Tasks", section: "Commands & Skills", label: "Skill dirs",
      kind: "string", value: joinedList(m.getSkillPaths()),
      description: "Extra skill directories, space-separated (also loads ~/.pi/agent/skills and .pi/skills).",
      set: (v) => m.setSkillPaths(splitList(v) ?? []),
    },

    // ── Providers (OMP: Protocol / Timeouts / Privacy) ────────────────────
    {
      key: "pi.transport", tab: "Providers", section: "Protocol", label: "Transport",
      kind: "string", value: m.getTransport(), values: TRANSPORTS, defaultValue: "auto",
      description: "Preferred transport for providers that support multiple transports.",
      set: (v) => m.setTransport(str(v) as never),
    },
    {
      key: "pi.httpIdleTimeoutMs", tab: "Providers", section: "Timeouts", label: "HTTP idle timeout",
      kind: "string", value: httpTimeoutLabel(m.getHttpIdleTimeoutMs()), defaultValue: "5 min",
      description: "Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
      set: (v) => {
        const s = str(v);
        const known = httpTimeoutMs(s);
        if (known !== undefined) {
          m.setHttpIdleTimeoutMs(known);
          return;
        }
        // Custom labels render as "N sec" — keep them round-trippable, and
        // ignore anything else (the panel passes raw typed text through).
        const sec = /^([\d.]+) sec$/.exec(s);
        const n = sec ? Number(sec[1]) * 1000 : Number(s);
        if (Number.isFinite(n)) m.setHttpIdleTimeoutMs(Math.max(0, n));
      },
    },
    {
      key: "pi.enableInstallTelemetry", tab: "Providers", section: "Privacy", label: "Install telemetry",
      kind: "toggle", value: m.getEnableInstallTelemetry(), defaultValue: true,
      description: "Send an anonymous version/update ping after changelog-detected updates.",
      set: (v) => m.setEnableInstallTelemetry(Boolean(v)),
    },
    {
      key: "pi.enableAnalytics", tab: "Providers", section: "Privacy", label: "Analytics",
      kind: "toggle", value: m.getEnableAnalytics(), defaultValue: false,
      description: "Opt in to anonymous usage analytics (generates a tracking id on first enable).",
      set: (v) => m.setEnableAnalytics(Boolean(v)),
    },

    // ── Tools (OMP: Extensions) / Context (Prompt templates) / Theme ──────
    {
      key: "pi.paths.extensions", tab: "Tools", section: "Extensions", label: "Extension dirs",
      kind: "string", value: joinedList(m.getExtensionPaths()),
      description: "Extra extension paths, space-separated (also loads ~/.pi/agent/extensions and .pi/extensions).",
      set: (v) => m.setExtensionPaths(splitList(v) ?? []),
    },
    {
      key: "pi.paths.prompts", tab: "Context", section: "Prompt templates", label: "Template dirs",
      kind: "string", value: joinedList(m.getPromptTemplatePaths()),
      description: "Extra prompt-template directories, space-separated (also loads ~/.pi/agent/prompts and .pi/prompts).",
      set: (v) => m.setPromptTemplatePaths(splitList(v) ?? []),
    },
    {
      key: "pi.paths.themes", tab: "Appearance", section: "Theme", label: "Theme dirs",
      kind: "string", value: joinedList(m.getThemePaths()),
      description: "Extra theme directories, space-separated (also loads ~/.pi/agent/themes and .pi/themes).",
      set: (v) => m.setThemePaths(splitList(v) ?? []),
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
  Memory: "🪶",
  Shell: "🖥️",
  Tools: "🧰",
  Tasks: "🗂️",
  Providers: "🔌",
};

/** True when a row key belongs to the pi-settings contribution. */
export function isPiKey(key: string): boolean {
  return key.startsWith("pi.");
}
