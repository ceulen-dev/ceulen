/**
 * // ponytail: forked from @bacnh85/pi-config-panel 0.1.10; evolved in-repo
 * (split layout, row descriptions/warnings, enum rows, defaults, type-to-search).
 * Upstream sync = manual port.
 *
 * Shared interactive config-panel kernel — an arrow-key toggle/edit form
 * opened via ctx.ui.custom, mirroring Pi's built-in /settings UX.
 *
 * Extracted from pi-a2a's /a2a-config panel (0.3.0 design, unchanged kernel):
 * a generic row model (kind: toggle | string | number | action) with a pure
 * build-rows function per extension so all logic is unit-testable without a
 * TUI. The interactive shell (ctx.ui.custom) is a thin adapter over the model.
 *
 * IMPORTANT (learned the hard way in pi-a2a): the panel must NOT call
 * ctx.ui.input() / ctx.ui.confirm() while it is displayed — those open
 * editor-container dialogs that render UNDER the overlay and fight the
 * overlay focus. Instead the panel embeds its own pi-tui Input component for
 * value editing and saves directly on Esc (no confirmation dialog). This
 * matches the proven llama extension pattern (single custom component,
 * self-contained input handling).
 *
 * Layout (v4, fullscreen boxed frame): the panel renders as a fixed-chrome
 * frame sized to the terminal, launched as a full-viewport overlay. Rounded
 * corners + tee dividers + `│ … │` rows make it a closed rectangle (OMP's
 * overlay-box): boxed top with the title inset → boxed tab row → divider →
 * boxed body → boxed description area → divider → boxed pinned key-hint
 * footer → boxed bottom border. The body is OMP's split — a section sidebar
 * on the left (width PINNED across every tab so the rail never jumps), the
 * rows on the right with in-pane underlined section headings and
 * non-active-section rows dim-washed. Below a 60-column rows pane the
 * sidebar hides and only the headings remain; a fixed-height description
 * area keeps navigation from shifting.
 *
 * Keys: ↑/↓ navigate, Enter toggles booleans / cycles enums / edits strings+
 * numbers (inline input), → ←/Tab jump groups, printable text filters rows,
 * Esc closes (saves when dirty).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, KeybindingsManager } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

export type PanelRowKind = "toggle" | "string" | "number" | "action" | "info";

/** Suggestion option for rows with inline completion support. */
export interface PanelCompletionItem {
  value: string;
  label?: string;
  description?: string;
}

/** One option of a row's selection submenu (Enter on a multi-choice row). */
export interface PanelMenuOption {
  value: string;
  label?: string;
  description?: string;
}

export interface PanelRow {
  key: string;
  label: string;
  kind: PanelRowKind;
  value: unknown;
  /** Mask the value in render + inline-edit hint (for secrets/tokens). */
  mask?: boolean;
  /** One-line help for the row, rendered in the fixed description area while
   *  selected (env precedence, next-session timing, …). */
  description?: string;
  /** Risk/caveat note rendered above the description in warning styling, with
   *  a glyph on the row (e.g. "takes effect after /reload"). */
  warning?: string;
  /** Closed value set: Enter opens the selection submenu (OMP's select
   *  submenu), where ↑/↓ browse, Enter commits and Esc backs out. Rows with
   *  `values` never open the inline editor. */
  values?: readonly string[];
  /** Dynamic option set for the selection submenu (overrides `values` for the
   *  menu; computed at open time — themes, models, …). */
  menu?: () => PanelMenuOption[];
  /** Live preview fired with each highlighted option while the submenu is
   *  open (OMP's onThemePreview). Never fired on commit. */
  preview?: (value: string) => void;
  /** Fired once when the submenu is cancelled (Esc) so the row can undo its
   *  live preview (OMP's onPreviewCancel). The row owns the restore — passing
   *  the original value back through `preview` can't restore values that
   *  aren't valid options (e.g. the "auto" theme setting). */
  previewCancel?: () => void;
  /** Read-only preview render (OMP's settings-screen preview window): the
   *  block rendered under the rows pane / open submenu for this row — while
   *  browsing a submenu, `value` is the HIGHLIGHTED option's value so the
   *  preview follows the cursor. Pure: fired per render, never mutates
   *  anything. `width` is the body's inner width; lines are truncated to it. */
  previewLines?: (value: string, width: number) => string[];
  /** Declared default; a current value that differs renders warning-styled so
   *  the user sees at a glance what this session changed. */
  defaultValue?: unknown;
  /** When set, inline editing shows a suggestion list (↑/↓ + Tab to pick,
   *  Enter always submits the typed text). Options are re-filtered against
   *  the text after the last `,` so comma-separated values can be composed. */
  completions?: () => PanelCompletionItem[];
  set(v: unknown): void;
}

export interface PanelGroup {
  key: string;
  label: string;
  /** Optional tab this group belongs to. ADJACENT groups with the same `tab`
   *  render as one tab (the tab chip shows the tab name + first icon) with
   *  each group's `label` as a left-sidebar SECTION, the rows on the right —
   *  OMP's tab → section → rows hierarchy. Without `tab`, the group is its
   *  own tab and `label` doubles as the tab name. */
  tab?: string;
  /** Short glyph shown on the tab chip (emoji or symbol; width-aware). */
  icon?: string;
  rows: PanelRow[];
}

/** Options accepted by `row()` beyond the required set. */
export interface PanelRowOpts {
  mask?: boolean;
  description?: string;
  warning?: string;
  values?: readonly string[];
  menu?: () => PanelMenuOption[];
  preview?: (value: string) => void;
  previewCancel?: () => void;
  previewLines?: (value: string, width: number) => string[];
  defaultValue?: unknown;
  completions?: () => PanelCompletionItem[];
}

/** Action descriptor (the "add peer" / "remove peer" rows). */
export interface PanelAction {
  label: string;
  /** Runs when the row is activated. `prompt` opens an inline input dialog
   *  (Enter confirms, Esc cancels → undefined) — actions must NOT call
   *  ctx.ui.input()/select()/confirm() while the panel overlay is showing. */
  run: (prompt: (label: string, onDone: (value: string | undefined) => void) => void) => Promise<void> | void;
}

/** Build the row model from a working config. The extension owns this —
 *  row setters mutate the passed config in place so the caller keeps a
 *  working copy and marks dirty. */
export type BuildRows<T> = (cfg: T, actions: Record<string, PanelAction>) => PanelGroup[];

// ---------------------------------------------------------------------------
// Pure row helpers — shared by every extension's buildRows
// ---------------------------------------------------------------------------

/** Construct a row whose setter updates BOTH the backing config and row.value
 *  so the render reflects the change immediately (a stale value made toggles
 *  appear dead — regression-tested in pi-a2a). */
export function row(
  key: string,
  label: string,
  kind: PanelRowKind,
  value: unknown,
  set: (v: unknown) => void,
  opts: PanelRowOpts = {},
): PanelRow {
  const r: PanelRow = {
    key,
    label,
    kind,
    value,
    mask: opts.mask,
    description: opts.description,
    warning: opts.warning,
    values: opts.values,
    menu: opts.menu,
    preview: opts.preview,
    previewCancel: opts.previewCancel,
    previewLines: opts.previewLines,
    defaultValue: opts.defaultValue,
    ...(opts.completions && { completions: opts.completions }),
    set(v: unknown) {
      set(v);
      r.value = kind === "number" ? toInt(v, Number(r.value)) : v;
    },
  };
  return r;
}

/** Coerce to int, keeping the fallback on garbage input. */
export function toInt(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? parseInt(v, 10) : v;
  return Number.isFinite(n) ? (n as number) : fallback;
}

/** Apply every row's setter to a fresh config (for tests / "apply" flows). */
export function applyRows<T>(cfg: T, groups: PanelGroup[]): T {
  for (const g of groups) {
    for (const r of g.rows) {
      if (r.kind !== "action") r.set(r.value);
    }
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Interactive shell (thin adapter over the model)
// ---------------------------------------------------------------------------

export interface ConfigPanelOpts<T> {
  ctx: ExtensionContext;
  cfg: T;
  /** Row builder for the panel's config (the extension-specific part). */
  build: BuildRows<T>;
  actions?: Record<string, PanelAction>;
  /** Panel title (first render line). */
  title?: string;
  /** Rebuild the groups from `build` after every committed edit — for row
   *  sets that grow/shrink with the config (per-model override rows). Off by
   *  default: static row sets don't need it. */
  rebuildOnCommit?: boolean;
  /** Called when the panel saves (Esc with dirty). Second arg: row keys the
   *  user actually edited (for secret-persistence decisions). */
  onSave?: (saved: boolean, editedKeys?: Set<string>) => void;
}

/** Build the action-row handler for an open panel. Shared with tests so the
 *  rebuild-after-action behavior (added/removed rows re-render) is guarded by
 *  the same code path production uses. `onError` reports action failures
 *  (openConfigPanel routes to ctx.ui.notify). */
export function makeOnAction<T>(
  model: ConfigPanelModel,
  cfg: T,
  build: BuildRows<T>,
  actions: Record<string, PanelAction>,
  onError: (msg: string) => void,
): (row: PanelRow) => Promise<void> {
  return async (row) => {
    // Cancel detection: run() is typically sync — it returns BEFORE the inline
    // prompt resolves — so dirty/rebuild is decided at prompt resolution, not
    // after row.set resolves. Esc resolves onDone(undefined) → cancelled → no
    // dirty, no rebuild, so Esc-close won't fire onSave(true). Promptless
    // actions (no prompt() call) keep the old apply-on-return behavior.
    let prompted = false;
    const apply = () => {
      model.dirty = true;
      model.setGroups(build(cfg, actions));
      model.requestRender();
    };
    try {
      await row.set((label: string, onDone: (v: string | undefined) => void) => {
        prompted = true;
        model.prompt(label, (v) => {
          // Run the action's own callback first so the rebuild below sees the
          // mutated config; "" (empty submit) is an applied change, only
          // undefined is a cancel.
          onDone(v);
          if (v !== undefined) apply();
        });
      });
      if (!prompted) apply();
    } catch (e: any) {
      onError(`Action failed: ${e?.message || e}`);
    }
  };
}

/**
 * Open the interactive config panel via ctx.ui.custom.
 * Resolves when the panel closes (Esc — saves when dirty).
 *
 * Full-viewport (OMP's /settings shape): launched as a 100%×100% top-left
 * overlay so the frame covers the terminal and the chat stays untouched
 * underneath; on close pi hides the overlay and focus returns to the editor
 * (interactive-mode.js custom→showExtensionCustom overlay branch).
 */
export function openConfigPanel<T>(opts: ConfigPanelOpts<T>): Promise<void> {
  const { ctx, cfg, build, actions = {}, title, onSave } = opts;
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("Config panel requires interactive TUI mode.", "warning");
    onSave?.(false);
    return Promise.resolve();
  }
  return ctx.ui.custom((tui, theme, keybindings, done) => {
    const model = new ConfigPanelModel(build(cfg, actions), theme, title);
    model.keybindings = keybindings;
    model.onRequestRender = () => tui.requestRender();
    if (opts.rebuildOnCommit) model.rebuild = () => build(cfg, actions);
    model.onSave = async () => {
      try {
        await onSave?.(true, model.editedKeys);
      } catch (e: any) {
        // Async rejections land here too (await unwraps the promise) — the
        // panel stays open so the user can retry or Esc without saving.
        ctx.ui.notify(`Save failed: ${e?.message || e}`, "error");
        return;
      }
      done();
    };
    // Action rows run with an inline prompt (Enter confirms, Esc cancels →
    // undefined). Actions must NOT use ctx.ui.input/select/confirm here —
    // those render under the overlay and break the panel. onAction is an
    // error-reporting hook (activate() drives the action itself).
    model.onAction = makeOnAction(model, cfg, build, actions, (msg) => ctx.ui.notify(msg, "error"));
    model.onClose = () => {
      // Save when dirty (no confirm dialog — Esc = save-and-close; Esc within
      // an inline input cancels the edit instead). Matches the llama
      // extension's no-nested-dialog pattern.
      if (model.dirty) {
        model.onSave?.();
      } else {
        done();
      }
    };
    return model;
  }, {
    overlay: true,
    overlayOptions: () => ({ anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 }),
  });
}

/** Coerce a raw input string to the row kind's value. */
export function kindValue(kind: PanelRowKind, raw: string): unknown {
  if (kind === "number") {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : raw;
  }
  if (kind === "toggle") return /^(1|true|yes|on)$/i.test(raw.trim());
  return raw;
}

// ---------------------------------------------------------------------------
// Inline completion helpers (pure — unit-tested without a TUI)
// ---------------------------------------------------------------------------

/** Split the value at the cursor into the committed head (text before the
 *  segment containing the cursor) and the live segment the cursor sits in.
 *  Cursor-aware: the picker edits whichever entry the cursor is inside, not
 *  just the last one. Without a cursor (undefined), falls back to the legacy
 *  last-segment split. */
function splitSegments(raw: string, cursor?: number): { head: string; suffix: string } {
  if (cursor === undefined || cursor >= raw.length) {
    const idx = raw.lastIndexOf(",");
    if (idx === -1) return { head: "", suffix: raw };
    return { head: raw.slice(0, idx).trim(), suffix: raw.slice(idx + 1).replace(/^ /, '') };
  }
  // Segment boundaries: commas before and after the cursor. A cursor sitting
  // ON a comma belongs to the segment before it (editing that entry's tail).
  const start = (raw.lastIndexOf(",", cursor - 1) + 1) || 0;
  let end = raw.indexOf(",", cursor);
  if (end === -1) end = raw.length;
  const head = raw.slice(0, start).trim().replace(/,$/, "").trim();
  const suffix = raw.slice(start, end).replace(/^ /, "");
  return { head, suffix };
}

/** Filter completion options against the segment the cursor sits in (or the
 *  last segment when no cursor is given). Empty → every option (full list).
 *  Case-insensitive substring. `emptyQuery` overrides the segment text with
 *  an empty query (full list) — used after cursor navigation so entering an
 *  existing entry offers all options, not just itself. */
export function filterSuggestions(options: PanelCompletionItem[], raw: string, cursor?: number, emptyQuery = false): PanelCompletionItem[] {
  const { suffix } = splitSegments(raw, cursor);
  const q = emptyQuery ? "" : suffix.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => o.value.toLowerCase().includes(q) || (o.label ?? o.value).toLowerCase().includes(q));
}

/** Searchable text for a row: label, key, rendered value, description,
 *  warning, and enum values (OMP's getSettingItemFilterText). */
export function filterText(r: PanelRow): string {
  const value = r.mask && String(r.value ?? "") !== "" ? "" : String(r.value ?? "");
  return [r.label, r.key, value, r.description ?? "", r.warning ?? "", ...(r.values ?? [])].join(" ");
}

/** Value produced by accepting `item.value` while editing `raw`: replaces the
 *  segment at the cursor (last segment when no cursor given) — `head + ", " +
 *  value` + untouched tail segments. No trailing comma is added after the
 *  replaced segment; typing `,` after a pick starts the next segment. */
export function joinCompletion(raw: string, itemValue: string, cursor?: number): string {
  const { head } = splitSegments(raw, cursor);
  // Preserve any segments after the cursor's segment (a first-segment pick
  // has an empty head but still a tail — early-return would drop it).
  const after = cursor === undefined || cursor >= raw.length
    ? ""
    : (() => {
        let end = raw.indexOf(",", cursor);
        if (end === -1) end = raw.length;
        return raw.slice(end); // ", seg2, seg3" or ""
      })();
  if (!head) return `${itemValue}${after}`;
  return `${head}, ${itemValue}${after}`;
}

/** Extract the printable text of a keypress (single printable grapheme), or
 *  undefined for control sequences. Used by type-to-search. */
export function printableText(data: string): string | undefined {
  if (data.length === 0) return undefined;
  // Control chars, escape sequences, and bare/paired control codes → no text.
  if (data.length === 1 && data.charCodeAt(0) < 0x20) return undefined;
  if (data.charCodeAt(0) === 0x7f) return undefined;
  if (data.startsWith("\u001b")) return undefined;
  return data;
}

// ---------------------------------------------------------------------------

interface PanelTheme {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold?(text: string): string;
  underline?(text: string): string;
}

/** Fixed description-area height (blank + this many text rows), so moving
 *  between rows with/without descriptions never shifts the layout (OMP). */
const DESC_ROWS = 3;

/** Frame chrome rows (fixed): top border, tab row, divider, blank + DESC_ROWS
 *  description area, divider, footer hint, bottom border — 7 + DESC_ROWS. The
 *  body (heading + rows window) gets whatever height remains — OMP's
 *  fullscreen shape. */
const FRAME_ROWS = 7 + DESC_ROWS;

/** Max label column width before the value column starts (OMP's metric). */
const MAX_LABEL_WIDTH = 30;

/** Max inline suggestions shown while editing a completion row. */
const MAX_SUGGESTIONS = 8;

export class ConfigPanelModel implements Component {
  onRequestRender: (() => void) | null = null;
  onChanged: (() => void) | null = null;
  onSave: (() => void) | null = null;
  onAction: ((row: PanelRow) => Promise<void>) | null = null;
  /** When set, fires after every committed edit (toggle, menu pick, inline
   *  submit) and replaces the groups — lets dynamic row sets (per-model
   *  overrides) appear/disappear without reopening the panel. The returned
   *  groups become the new model state; selection is preserved by position,
   *  clamped when rows were removed. Wired by openConfigPanel from
   *  `rebuildOnCommit`. */
  rebuild: (() => PanelGroup[]) | null = null;
  onClose: (() => void) | null = null;
  keybindings: KeybindingsManager | null = null;
  /** Terminal height source for the full-viewport frame; tests inject a
   *  constant (default: the real terminal, 40 when unknown). */
  getHeight: () => number = () => process.stdout.rows || 40;

  dirty = false;
  /** Keys of rows the user actually edited (for secret-persistence decisions). */
  editedKeys = new Set<string>();
  /** Current groups (exposed for tests/rebuild inspection). */
  get groups(): PanelGroup[] {
    return this._groups;
  }
  private _groups: PanelGroup[];
  /** pi's theme object is a Proxy over a globalThis slot (theme.js) — every
   *  property access reads the CURRENT theme, so a live preview restyles the
   *  panel chrome too without any refresh hook. */
  private theme: PanelTheme | null;
  private title: string;
  private flat: PanelRow[] = [];
  private selected = 0;
  private editing: PanelRow | null = null;
  private input: Input | null = null;
  /** Live suggestion list while editing a row that has completions. */
  private suggestions: PanelCompletionItem[] = [];
  private lastFilteredValue: string | null = null;
  private suggestionIdx = 0;
  private pendingPrompt: { label: string; onDone: (value: string | undefined) => void } | null = null;
  /** Selection submenu (Enter on a `values`/`menu` row): OMP's select
   *  submenu — browse options with live preview, Enter commits, Esc backs
   *  out. `view` is the query-filtered slice the cursor navigates. */
  private menuItem: {
    row: PanelRow;
    options: PanelMenuOption[];
    view: PanelMenuOption[];
    idx: number;
    query: string;
  } | null = null;
  /** Type-to-filter query. Filtering swaps the rows pane to a flat match list
   *  (no sidebar) while the selection moves over matches only. */
  filter = "";
  /** Visible row indices (all rows, or filtered matches) — the selection
   *  navigates THIS list, so filtering can't select a hidden row. */
  private visible: number[] = [];
  /** Active tab index (tab = group; only the active group's rows render).
   *  Selection is remembered per tab so switching back lands where you left. */
  private tab = 0;
  private tabSelection: number[] = [];
  private _focused = false;

  /** Active tab index (tests). */
  get activeTab(): number {
    return this.tab;
  }

  /** Tab index containing the selected row (tests — the invariant the sidebar
   *  and tab bar highlight both derive from). */
  get tabOfSelection(): number {
    return this.tabOf(this.selected);
  }

  /** Absolute row indices currently visible/navigable (tests). */
  get visibleRows(): number[] {
    return [...this.visible];
  }

  constructor(groups: PanelGroup[], theme: PanelTheme | null, title = "Configuration") {
    this._groups = groups;
    this.theme = theme;
    this.title = title;
    this.rebuildFlat();
  }

  // Focusable interface (TUI checks `"focused" in component`).
  get focused(): boolean {
    return this._focused;
  }

  /** Selected row's absolute index (tests + save routing inspection). */
  get selectedIndex(): number {
    return this.selected;
  }

  set focused(v: boolean) {
    this._focused = v;
    if (this.input) this.input.focused = v;
  }

  private rebuildFlat(): void {
    this.flat = this.groups.flatMap((g) => g.rows);
    this.recomputeVisible();
  }

  /** Tab model: adjacent groups sharing a `tab` key form one tab. Each tab is
   *  `{ tabKey, label, icon, groups: [group indices] }`; a group without
   *  `tab` is its own tab (`tabKey` = its group key, so a coinccidental label
   *  match can never merge unrelated groups). Computed per call — group lists
   *  are tiny. */
  private tabs(): { tabKey: string; label: string; icon?: string; groups: number[] }[] {
    const out: { tabKey: string; label: string; icon?: string; groups: number[] }[] = [];
    for (let i = 0; i < this.groups.length; i++) {
      const g = this.groups[i]!;
      const key = g.tab ?? `$${i}`; // $-prefixed: group keys can never collide with it
      if (g.tab !== undefined && out.length > 0 && out[out.length - 1]!.tabKey === key) {
        out[out.length - 1]!.groups.push(i);
        if (!out[out.length - 1]!.icon && g.icon) out[out.length - 1]!.icon = g.icon;
        continue;
      }
      out.push({ tabKey: key, label: g.tab ?? g.label, ...(g.icon ? { icon: g.icon } : {}), groups: [i] });
    }
    return out;
  }

  /** Rows of a tab: every row of every group belonging to it. */
  private tabRows(t: number): number[] {
    const tabs = this.tabs();
    const tab = tabs[t];
    if (!tab) return [];
    const out: number[] = [];
    for (const gi of tab.groups) {
      const start = this.groupStart(gi);
      const count = this.groups[gi]?.rows.length ?? 0;
      for (let j = 0; j < count; j++) out.push(start + j);
    }
    return out;
  }

  /** First row index of a tab (0 when the tab has no rows). */
  private tabStart(t: number): number {
    const tabs = this.tabs();
    return tabs[t]?.groups.length ? this.groupStart(tabs[t]!.groups[0]!) : 0;
  }

  /** Absolute row index of a group's first row (0 when missing). */
  private groupStart(g: number): number {
    let acc = 0;
    for (let i = 0; i < g && i < this.groups.length; i++) acc += this.groups[i]!.rows.length;
    return acc;
  }

  /** Tab index containing a flat row index (0 when none). */
  private tabOf(index: number): number {
    const tabs = this.tabs();
    for (let t = 0; t < tabs.length; t++) {
      const rows = this.tabRows(t);
      if (rows.length > 0 && index >= rows[0]! && index <= rows[rows.length - 1]!) return t;
    }
    return 0;
  }

  /** Group index whose rows contain a flat row index (-1 when none). */
  private sectionOf(index: number): number {
    for (let gi = 0; gi < this.groups.length; gi++) {
      const start = this.groupStart(gi);
      const count = this.groups[gi]?.rows.length ?? 0;
      if (count > 0 && index >= start && index < start + count) return gi;
    }
    return -1;
  }

  /** Switch to tab `t`, remembering the selection of the tab being left and
   *  restoring the target tab's own via recomputeVisible (which honors
   *  `tabSelection` in unfiltered mode). Wraps like OMP's TabBar. */
  private setTab(t: number): void {
    const tabs = this.tabs();
    if (tabs.length === 0) return;
    const next = ((t % tabs.length) + tabs.length) % tabs.length;
    if (next === this.tab) return;
    // Remember where we were in the tab we're leaving.
    this.tabSelection[this.tab] = this.selected;
    this.tab = next;
    this.recomputeVisible();
    this.requestRender();
  }

  /** Tab-step key: switches tabs (wrapping); during a search (matches span
   *  every category) it jumps the selection to the next/previous category
   *  that HAS a match — OMP's "tabs act as jump targets" behavior. */
  private stepTab(delta: number): void {
    const tabs = this.tabs();
    if (tabs.length === 0) return;
    if (this.filter) {
      const tabsInView = [...new Set(this.visible.map((i) => this.tabOf(i)))].sort((a, b) => a - b);
      if (tabsInView.length === 0) return;
      const cur = this.tabOf(this.selected);
      const at = tabsInView.indexOf(cur);
      const target = at === -1
        ? (delta > 0 ? tabsInView[0]! : tabsInView[tabsInView.length - 1]!)
        : tabsInView[((at + delta) % tabsInView.length + tabsInView.length) % tabsInView.length]!;
      const landed = this.visible.find((i) => this.tabOf(i) === target);
      if (landed !== undefined) this.selected = landed;
      this.requestRender();
      return;
    }
    this.setTab(this.tab + delta);
  }

  /** Jump to the next/previous SECTION (group) inside the active tab — OMP's
   *  section jump: selection lands on the section's first visible row. Tabs
   *  with one section fall back to paging through rows. */
  private jumpSection(delta: number): void {
    const tabs = this.tabs();
    const tab = tabs[this.tab];
    if (!tab) return;
    if (tab.groups.length < 2) {
      // No sections: page through the tab's rows (OMP's fallback).
      const rows = this.tabRows(this.tab);
      const pos = rows.indexOf(this.selected);
      const at = pos === -1 ? 0 : Math.max(0, Math.min(rows.length - 1, pos + delta * this.bodyRows()));
      if (rows.length > 0) this.selected = rows[at]!;
      this.requestRender();
      return;
    }
    // Which section holds the selection?
    let cur = 0;
    for (let s = 0; s < tab.groups.length; s++) {
      const gi = tab.groups[s]!;
      if (this.selected >= this.groupStart(gi)) cur = s;
    }
    const nextSection = ((cur + delta) % tab.groups.length + tab.groups.length) % tab.groups.length;
    const start = this.groupStart(tab.groups[nextSection]!);
    const count = this.groups[tab.groups[nextSection]!]?.rows.length ?? 0;
    if (count > 0) this.selected = start;
    this.requestRender();
  }

  /** Recompute the navigable row list. Without a filter the list is the
   *  ACTIVE TAB's rows (tabs separate categories — ↑/↓ must not wander into a
   *  hidden tab); with one, rows from every tab fuzzy-match on
   *  label/value/description and the previously selected row is kept when it
   *  survives, else the first match wins. */
  private recomputeVisible(): void {
    const q = this.filter.trim();
    if (!q) {
      const rows = this.tabRows(this.tab);
      this.visible = rows;
      if (rows.length > 0 && !rows.includes(this.selected)) {
        // Prefer this tab's remembered row (tab switch); fall back to its first.
        const remembered = this.tabSelection[this.tab];
        this.selected = remembered !== undefined && rows.includes(remembered)
          ? remembered
          : rows[0]!;
      }
      return;
    }
    const prevRow = this.flat[this.selected];
    this.visible = this.flat
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => fuzzyFilter([r], q, filterText).length > 0)
      .map(({ i }) => i);
    if (this.visible.length === 0) {
      this.selected = 0;
      return;
    }
    const at = prevRow ? this.visible.indexOf(this.flat.indexOf(prevRow)) : -1;
    this.selected = at >= 0 ? this.flat.indexOf(prevRow) : this.visible[0]!;
    // While filtering, the active tab FOLLOWS the selection (OMP's "tabs act
    // as jump targets"): the tab the matched row lives on is the one you are
    // configuring, even before Esc clears the search.
    this.tab = this.tabOf(this.selected);
  }

  /** Selected row's position within `visible`. */
  private visiblePos(): number {
    const at = this.visible.indexOf(this.selected);
    return at >= 0 ? at : 0;
  }

  /** Set the type-to-search filter: swap the rows pane to a flat match list
   *  and pull the selection onto a surviving match. Clearing the filter snaps
   *  the tab to the row the user was on, so the panel resumes on that
   *  category instead of the one they started from. */
  setFilter(q: string): void {
    const cleared = this.filter !== "" && q === "";
    // Capture the matched row + its tab BEFORE the filter clears: the
    // unfiltered recompute below re-clamps `selected` back onto the OLD tab's
    // rows, which would make any after-the-fact snap resolve to the old tab
    // and silently no-op.
    const matchRow = cleared && this.visible.length > 0 ? this.selected : undefined;
    this.filter = q;
    if (matchRow !== undefined) {
      this.tab = this.tabOf(matchRow);
      this.selected = matchRow;
      this.tabSelection[this.tab] = matchRow;
    }
    this.recomputeVisible();
    this.requestRender();
  }

  requestRender(): void {
    this.onRequestRender?.();
  }

  /** SDK Component contract — external invalidation replays the flat model. */
  invalidate(): void {
    this.rebuildFlat();
    this.onRequestRender?.();
  }

  /** Replace the row model (after an action mutated the config, e.g. added an
   *  entry) and rebuild the flat list, preserving the selected ROW by identity
   *  (indices shift when a group grows/shrinks). */
  setGroups(groups: PanelGroup[]): void {
    const prevRow = this.flat[this.selected];
    this._groups = groups;
    this.flat = this.groups.flatMap((g) => g.rows);
    // The tab list is derived from groups — an action may have removed tabs,
    // so re-clamp BEFORE any tab-indexed lookup (tabBarLine derefs it raw).
    this.tab = Math.max(0, Math.min(this.tab, this.tabs().length - 1));
    const at = prevRow ? this.flat.indexOf(prevRow) : -1;
    this.selected = at >= 0 ? at : Math.max(0, Math.min(this.selected, this.flat.length - 1));
    this.recomputeVisible();
  }

  private color(token: string, text: string): string {
    return this.theme?.fg ? this.theme.fg(token, text) : text;
  }

  /** Footer key hints with colored key glyphs (OMP style): `[["←→","tab"],
   *  ["↑↓","navigate"]]` → `←→ tab · ↑↓ navigate ...` — keys in `accent`,
   *  their meaning in `dim`. */
  private keyHint(pairs: [string, string][]): string {
    const sep = this.color("dim", " · ");
    return pairs
      .map(([key, meaning]) => this.color("accent", key) + " " + this.color("dim", meaning))
      .join(sep);
  }

  render(width: number): string[] {
    const w = Math.max(20, width);
    const flat = this.flat;
    const contentRows = this.bodyRows();
    // Fixed-chrome frame (OMP's fullscreen settings shape): boxed title
    // border → tab row → divider → body → description → divider → pinned
    // key-hint footer → boxed bottom border. Every row is wrapped in box
    // sides (OMP's row()) so the frame is a closed rectangle. Exactly
    // max(14, getHeight()) lines.
    const lines: string[] = [this.boxTop(w)];

    // Tab row — always exactly one line: the search banner while filtering
    // (search spans every tab), else the tab bar; single-tab panels leave it
    // blank so the geometry never shifts.
    if (this.filter) {
      const q = this.color("accent", "▸ ") + this.filter + this.color("accent", "█");
      const count = this.visible.length === 1 ? "1 match" : `${this.visible.length} matches`;
      const right = this.color(this.visible.length > 0 ? "dim" : "warning", count);
      const gap = Math.max(1, w - 4 - visibleWidth(q) - visibleWidth(right) - 1);
      lines.push(this.boxRow(q + " ".repeat(gap) + right, w));
    } else {
      lines.push(this.boxRow(this.tabBarLine(w - 4) ?? "", w));
    }
    lines.push(this.boxDivider(w));

    // Body — rows pane (+ sidebar), empty-state note, or the inline action
    // prompt — padded/truncated to contentRows below so the body absorbs the
    // terminal height instead of the frame floating after the content.
    // Inner width: box sides + their single-column insets (OMP's row()).
    const iw = Math.max(1, w - 4);
    const body: string[] = [];
    if (this.pendingPrompt) {
      const inputLines = this.input ? this.input.render(iw - 2) : ["…"];
      body.push(this.color("text", `${this.pendingPrompt.label}: ${inputLines[0] ?? ""}`));
    }

    // Description area shows the selected row ONLY when that row belongs to
    // the active tab (an empty/shrunk tab must not describe a hidden
    // neighbor's row). During a filter the search spans every tab.
    const visibleRow = this.filter
      ? this.visible.includes(this.selected)
      : this.tabRows(this.tab).includes(this.selected);
    const selectedRow = visibleRow ? flat[this.selected] : undefined;

    // Empty filter result: keep the fixed chrome, say so in the pane. (The
    // prompt arm stays empty — its body line is already pushed above.)
    if (this.pendingPrompt) {
      // nothing else renders behind the prompt
    } else if (this.menuItem) {
      this.renderMenu(body, iw, contentRows);
    } else if (this.visible.length === 0) {
      if (this.filter) {
        body.push(this.color("dim", "  No matching rows"));
        body.push(this.color("dim", "  ⌫ edit search · Esc clear"));
      } else {
        body.push(this.color("dim", "  (no settings in this tab)"));
      }
    } else {
      // Render-list. Filtering: a flat match list across every tab (OMP skips
      // headings in search). Otherwise: the active tab's rows with a heading
      // line per SECTION and, when the width allows, a left sidebar — OMP
      // renders BOTH the sidebar and the in-pane underlined headings.
      const items: ({ row: number } | { heading: string; section: number })[] = [];
      const tabs = this.tabs();
      const tab = tabs[this.tab];
      const sections = tab ? tab.groups : [];
      if (this.filter) {
        for (const rowIdx of this.visible) items.push({ row: rowIdx });
      } else {
        // In-pane section headings lead every section (OMP always renders
        // them, sidebar or not; they dim outside the active section).
        for (const gi of sections) {
          const start = this.groupStart(gi);
          const count = this.groups[gi]?.rows.length ?? 0;
          if (count === 0) continue;
          items.push({ heading: this.groups[gi]!.label, section: gi });
          for (let j = 0; j < count; j++) items.push({ row: start + j });
        }
      }
      const selLine = items.findIndex((it) => "row" in it && it.row === this.selected);

      // Sidebar (sections): pinned width across every tab (OMP), shown on
      // ANY tab with sections when the rows pane stays readable — OMP hides
      // it below a 60-column pane and falls back to headings only.
      const sidebarWidth = this.sidebarCols();
      const sidebarPanes = !this.filter && sections.length >= 1 && iw - sidebarWidth - 2 >= 60;
      // Window: keep the selected line in view, roughly centered (OMP).
      const budget = Math.max(1, contentRows);
      const total = items.length;
      const viewport = Math.min(budget, total);
      const start = Math.max(0, Math.min(selLine - Math.floor(viewport / 2), total - viewport));
      const windowItems = items.slice(start, start + viewport);
      const useScrollbar = total > viewport;
      const rowWidth = iw - (useScrollbar ? 1 : 0) - (sidebarPanes ? sidebarWidth + 2 : 0);

      // Label column spans the WINDOW so it stays stable while scrolling.
      const labelWidths = windowItems
        .filter((it): it is { row: number } => "row" in it)
        .map((it) => visibleWidth(flat[it.row]!.label) + (flat[it.row]!.warning ? 2 : 0));
      const labelWidth = Math.min(MAX_LABEL_WIDTH, labelWidths.length ? Math.max(...labelWidths) : 0);
      const scrollbar = useScrollbar ? this.scrollbarColumn(start, viewport, total) : [];

      // Sidebar (OMP's split layout): section names STACKED at the top of the
      // left column — sidebar line i sits beside pane line i — with the
      // section holding the cursor accented, the rest dim. Not aligned to
      // each section's pane position (OMP's exact model).
      let activeSection = sections[0];
      for (const gi of sections) if (this.selected >= this.groupStart(gi)) activeSection = gi;
      const sidebarLines: string[] = [];
      if (sidebarPanes) {
        for (const gi of sections) {
          const label = truncateToWidth(this.groups[gi]!.label, Math.max(1, sidebarWidth - 4));
          const styled = gi === activeSection
            ? this.color("accent", this.theme?.bold ? this.theme.bold(label) : label)
            : this.color("dim", label);
          sidebarLines.push("  " + styled + " ".repeat(Math.max(0, sidebarWidth - 2 - visibleWidth(label))));
        }
      }

      for (let i = 0; i < windowItems.length; i++) {
        const it = windowItems[i]!;
        // In-pane section heading (OMP's underlined heading rows): dimmed
        // outside the active section, muted+bold+underline on it. Rendered
        // with the same sidebar prefix so the columns stay aligned.
        if ("heading" in it) {
          const active = it.section === activeSection;
          const text = it.heading;
          const styled = active
            ? this.color("muted", this.theme?.bold ? this.theme.bold(text) : text)
            : this.color("dim", text);
          const underlined = this.theme?.underline ? this.theme.underline(styled) : styled;
          const prefix = sidebarPanes
            ? (sidebarLines[i] ?? " ".repeat(sidebarWidth)) + this.color("border", "│ ")
            : "";
          // Pad the heading to the row width so the scrollbar column stays
          // pinned (an unpadded heading let the glyph drift into the text).
          body.push(truncateToWidth(prefix + truncateToWidth(underlined, rowWidth, "...", true) + (scrollbar[i] ?? (useScrollbar ? " " : "")), iw));
          continue;
        }
        const r = flat[it.row]!;
        const selected = it.row === this.selected;
        // OMP's dim wash: with a sidebar, rows OUTSIDE the active section are
        // dimmed so the section under the cursor pops.
        const dimmed = sidebarPanes && !selected && this.sectionOf(it.row) !== activeSection;
        const pane = this.renderRow(r, selected, dimmed, labelWidth, rowWidth);
        const prefix = sidebarPanes
          ? (sidebarLines[i] ?? " ".repeat(sidebarWidth)) + this.color("border", "│ ")
          : "";
        for (let k = 0; k < pane.length; k++) {
          body.push(truncateToWidth(prefix + (pane[k] ?? "") + (scrollbar[i] ?? (useScrollbar ? " " : "")), iw));
        }
      }
    }

    // Preview block (OMP's settings-screen preview window): a read-only
    // render under the rows pane or the open submenu — the selected row's
    // (menu: highlighted option's) previewLines, clamped into the remaining
    // body budget. No key handling; the pad below still fills the frame.
    const pvRow = this.menuItem?.row ?? selectedRow;
    const pvValue = this.menuItem
      ? String(this.menuItem.view[this.menuItem.idx]?.value ?? pvRow?.value ?? "")
      : String(pvRow?.value ?? "");
    const pvLines = pvRow?.previewLines ? pvRow.previewLines(pvValue, iw) : [];
    if (pvLines.length > 0 && contentRows - body.length > 2) {
      body.push("");
      body.push(this.color("dim", "Preview:"));
      for (const line of pvLines) {
        if (body.length >= contentRows) break;
        body.push(truncateToWidth(line, iw));
      }
    }

    while (body.length < contentRows) body.push("");
    for (const line of body.slice(0, contentRows)) lines.push(this.boxRow(line, w));

    // Fixed-height description area: warning first (survives the clamp), then
    // description; exactly DESC_ROWS lines so navigation never shifts layout.
    lines.push(this.boxRow("", w));
    const descLines: string[] = [];
    if (selectedRow) {
      if (selectedRow.warning) {
        const mark = this.color("warning", "⚠ ");
        for (const l of wrapTextWithAnsi(selectedRow.warning, Math.max(10, iw - 2))) {
          descLines.push("  " + mark + this.color("warning", l));
        }
      }
      if (selectedRow.description) {
        for (const l of wrapTextWithAnsi(selectedRow.description, Math.max(10, iw - 2))) {
          descLines.push("  " + this.color("dim", l));
        }
      }
    }
    if (descLines.length > DESC_ROWS) {
      descLines.length = DESC_ROWS;
      descLines[DESC_ROWS - 1] = truncateToWidth(descLines[DESC_ROWS - 1]!, Math.max(0, iw - 1)) + "…";
    }
    while (descLines.length < DESC_ROWS) descLines.push("");
    for (const l of descLines) lines.push(this.boxRow(l, w));

    lines.push(this.boxDivider(w));
    lines.push(this.boxRow(this.footerLine(iw), w));
    lines.push(this.boxBottom(w));
    // Truncate every line to the panel width — the TUI throws when a custom
    // component renders a line wider than the terminal (long URLs etc.).
    return lines.map((l) => truncateToWidth(l, w));
  }

  /** Body (heading + rows window) height available inside the frame. */
  private bodyRows(): number {
    return Math.max(1, Math.max(14, this.getHeight()) - FRAME_ROWS);
  }

  /** Rounded top border with the title inset: `╭─ Title ─────╮` (OMP's
   *  overlay-box). */
  private boxTop(w: number): string {
    const bold = this.theme?.bold ? this.theme.bold.bind(this.theme) : (t: string) => t;
    const title = this.color("accent", ` ${bold(this.title)} `);
    const fill = Math.max(0, w - 3 - visibleWidth(title));
    return this.color("border", "╭─") + title + this.color("border", "─".repeat(fill) + "╮");
  }

  /** Tee-jointed section divider: `├────────┤` (OMP). */
  private boxDivider(w: number): string {
    return this.color("border", "├" + "─".repeat(Math.max(0, w - 2)) + "┤");
  }

  /** Selection submenu body (OMP's select submenu): the row's own label as a
   *  heading, its per-option details, the current value marked, the cursor on
   *  the highlighted option, and the type-to-filter line. The row stays
   *  `selected` so the fixed description area below keeps rendering its
   *  description/warning — OMP keeps the setting context visible while its
   *  submenu is open. */
  private renderMenu(body: string[], iw: number, contentRows: number): void {
    const m = this.menuItem;
    if (!m) return;
    // Heading: the row label, bold + accent (OMP's FormField label).
    const heading = this.theme?.bold ? this.theme.bold(m.row.label) : m.row.label;
    body.push(this.color("accent", "  " + heading));
    body.push("");

    // Window: cursor roughly centered, same shape as the rows pane.
    const budget = Math.max(1, contentRows - 3); // heading + blank + filter line
    const total = m.view.length;
    const viewport = Math.min(budget, total);
    const start = Math.max(0, Math.min(m.idx - Math.floor(viewport / 2), total - viewport));
    const windowItems = m.view.slice(start, start + viewport);
    const useScrollbar = total > viewport;
    const scrollbar = useScrollbar ? this.scrollbarColumn(start, viewport, total) : [];
    const cursor = String(m.row.value ?? "");

    for (let i = 0; i < windowItems.length; i++) {
      const o = windowItems[i]!;
      const highlighted = start + i === m.idx;
      const label = o.label ?? o.value;
      const isCurrent = o.value === cursor;
      const desc = o.description ? this.color("dim", ` — ${o.description}`) : "";
      const current = isCurrent ? this.color("dim", " (current)") : "";
      const line = `${highlighted ? this.color("accent", "›") : " "} ${highlighted ? this.color("text", label) : this.color("muted", label)}${desc}${current}`;
      body.push(truncateToWidth(line + (scrollbar[i] ?? (useScrollbar ? " " : "")), iw - 2));
    }

    // Type-to-filter line (OMP's "Type to search"): query with cursor, right-
    // aligned match count; the plain hint when nothing is typed.
    const searching = m.query !== "";
    const q = this.color("accent", "▸ ") + m.query + this.color("accent", "█");
    const count = m.view.length === 1 ? "1 match" : `${m.view.length} matches`;
    const right = this.color(m.view.length > 0 ? "dim" : "warning", count);
    if (searching) {
      const gap = Math.max(1, iw - 2 - visibleWidth(q) - visibleWidth(right) - 1);
      body.push(truncateToWidth(q + " ".repeat(gap) + right, iw - 2));
    } else if (m.view.length === 0) {
      body.push(this.color("dim", "  No matching options"));
    } else {
      body.push(this.color("dim", "  Type to search"));
    }
  }

  /** Rounded bottom border: `╰────────╯` (OMP). */
  private boxBottom(w: number): string {
    return this.color("border", "╰" + "─".repeat(Math.max(0, w - 2)) + "╯");
  }

  /** One boxed content row: `│ content │`, single-column insets (OMP's row()). */
  private boxRow(content: string, w: number): string {
    const inner = Math.max(0, w - 4);
    const fill = inner - visibleWidth(content);
    const body = fill > 0 ? content + " ".repeat(fill) : truncateToWidth(content, inner);
    return this.color("border", "│") + " " + body + " " + this.color("border", "│");
  }

  /** Sidebar column width pinned across EVERY tab from all section labels
   *  (OMP's settingsSidebarWidth — the divider never jumps between tabs):
   *  min(22, longest label) + 4 for the 2-column indent and 2-column gap. */
  private sidebarCols(): number {
    let max = 0;
    for (const g of this.groups) max = Math.max(max, visibleWidth(g.label));
    return Math.min(22, max) + 4;
  }

  /** Pinned footer — the frame's last content row (OMP's hint bar): the
   *  mode's key hints left, the dirty marker right. */
  private footerLine(w: number): string {
    const hint = this.footerHint();
    const dirty = this.dirty ? this.color("warning", "● unsaved changes") : "";
    const gap = w - visibleWidth(hint) - visibleWidth(dirty);
    if (!dirty) return truncateToWidth(hint, w);
    // Both can't fit: the unsaved marker is the more urgent signal (Esc saves).
    if (gap < 2) return truncateToWidth(dirty, w);
    return truncateToWidth(hint + " ".repeat(gap) + dirty, w);
  }

  /** Footer hint text per mode (the former in-body hint row, now pinned).
   *  The browse hint derives from the ACTIVE tab's row kinds (OMP's footer
   *  does the same: its plugins tab shows different guidance than the
   *  setting tabs): a tab of toggles/enums says "toggle", a read-only tab
   *  drops the Enter pair, and a single-section tab drops the section jump. */
  private footerHint(): string {
    if (this.pendingPrompt) {
      return this.keyHint([["Enter", "confirm"], ["Esc", "cancel"]]);
    }
    if (this.menuItem) {
      return this.keyHint([["Enter", "select"], ["↑↓", "navigate"], ["type", "to search"], ["Esc", "back"]]);
    }
    if (this.filter) {
      return this.keyHint([["↑↓", "navigate"], ["←→", "jump category"], ["Enter", "change"], ["⌫", "edit"], ["Esc", "clear"]]);
    }
    if (this.editing?.completions) {
      return this.keyHint([["↑↓", "highlight"], ["Tab", "pick"], ["Enter", "keep typed"], ["Esc", "close"]]);
    }
    const rows = this.tabRows(this.tab).map((i) => this.flat[i]!);
    const actionable = rows.filter((r) => r.kind !== "info");
    if (actionable.length > 0) {
      const onlyToggles = actionable.every((r) => r.kind === "toggle");
      // Predicate only (never invoke menu() here — this runs every render and
      // providers build model/theme lists).
      const onlyChoices = actionable.every((r) => r.kind === "toggle" || !!r.menu || (r.values?.length ?? 0) > 0);
      const hint: [string, string][] = [["←→", "tab"], ["↑↓", "navigate"]];
      if (this.sectionCount() >= 2) hint.push(["⇞⇟", "section"]);
      hint.push(["Enter", onlyToggles ? "toggle" : onlyChoices ? "choose" : "change"]);
      hint.push(["type", "to search"], ["Esc", "save"]);
      return this.keyHint(hint);
    }
    const hint: [string, string][] = [["←→", "tab"], ["↑↓", "navigate"]];
    if (this.sectionCount() >= 2) hint.push(["⇞⇟", "section"]);
    hint.push(["type", "to search"], ["Esc", "save"]);
    return this.keyHint(hint);
  }

  /** Sections (groups) of the active tab — 0 when the tab is unknown. */
  private sectionCount(): number {
    const tab = this.tabs()[this.tab];
    return tab ? tab.groups.length : 0;
  }

  /** Scrollbar column for the window: track + proportional thumb. */
  private scrollbarColumn(start: number, viewport: number, total: number): string[] {
    const thumbSize = Math.max(1, Math.round((viewport * viewport) / total));
    const maxStart = Math.max(1, total - viewport);
    const thumbTop = Math.round((start / maxStart) * Math.max(0, viewport - thumbSize));
    const out: string[] = [];
    for (let i = 0; i < viewport; i++) {
      const thumb = i >= thumbTop && i < thumbTop + thumbSize;
      out.push(this.color(thumb ? "accent" : "dim", thumb ? "█" : "│"));
    }
    return out;
  }

  /** One-line tab bar with per-tab icons (OMP look): the ACTIVE tab renders
   *  as inverse/`selectedBg` ` icon Label `; inactive tabs show their icon (or
   *  a dim label) — full label while it fits, compact icon-only otherwise. On
   *  the way down the bar collapses the inactive tabs FARTHEST from the
   *  active one first (OMP's TabBar); the active tab keeps its full label.
   *  If it still overflows (tabs without icons), the window slides around the
   *  active tab with `…` marking clipped sides. Returns null when there is
   *  only ONE tab (nothing to switch). */
  private tabBarLine(width: number): string | null {
    const tabs = this.tabs();
    if (tabs.length < 2) return null;
    const textWidth = (t: (typeof tabs)[number]) => visibleWidth(` ${t.icon ? t.icon + " " : ""}${t.label} `);
    const iconWidth = (t: (typeof tabs)[number]) => visibleWidth(t.icon ? ` ${t.icon} ` : ` ${truncateToWidth(t.label, 3)} `);
    // Per-tab compaction: collapse inactive tabs farthest from the active one
    // until the bar fits one line; the active tab never compacts.
    const compact = tabs.map(() => false);
    const widthOf = (i: number) => (compact[i] ? iconWidth(tabs[i]!) : textWidth(tabs[i]!)) + 1; // + gap
    const totalWidth = () => tabs.reduce((sum, _, i) => sum + widthOf(i), 0) - 1;
    const order = tabs
      .map((_, i) => i)
      .filter((i) => i !== this.tab)
      .sort((a, b) => Math.abs(b - this.tab) - Math.abs(a - this.tab));
    for (const i of order) {
      if (totalWidth() <= width) break;
      compact[i] = true;
    }

    // Still too wide: slide a window around the ACTIVE tab (left first —
    // reading order — then right), `…` marking clipped sides.
    let from = 0;
    let to = tabs.length - 1;
    if (totalWidth() > width) {
      from = this.tab;
      to = this.tab;
      let used = widthOf(this.tab) - 1; // no trailing gap yet
      for (;;) {
        const canLeft = from > 0 && used + widthOf(from - 1) + (to < tabs.length - 1 ? 2 : 0) <= width;
        if (canLeft) { from--; used += widthOf(from); continue; }
        const canRight = to < tabs.length - 1 && used + widthOf(to + 1) + (from > 0 ? 2 : 0) <= width;
        if (canRight) { to++; used += widthOf(to); continue; }
        break;
      }
    }

    const style = (i: number) => {
      const t = tabs[i]!;
      const body = compact[i]
        ? (t.icon ?? truncateToWidth(t.label, 3))
        : (t.icon ? `${t.icon} ${t.label}` : t.label);
      const text = ` ${body} `;
      if (i !== this.tab) return this.color(compact[i] ? "dim" : "muted", text);
      const boldText = this.theme?.bold ? this.theme.bold(text) : text;
      return this.theme?.bg
        ? this.theme.bg("selectedBg", this.color("text", boldText))
        : this.color("accent", boldText);
    };
    const parts: string[] = [];
    if (from > 0) parts.push(this.color("dim", "…"));
    for (let i = from; i <= to; i++) parts.push(style(i));
    if (to < tabs.length - 1) parts.push(this.color("dim", "…"));
    return truncateToWidth(parts.join(""), width);
  }

  /** True when a row's current value differs from its declared default. */
  private isChanged(r: PanelRow): boolean {
    return r.defaultValue !== undefined && String(r.value ?? "") !== String(r.defaultValue ?? "");
  }

  private renderRow(r: PanelRow, selected: boolean, dimmed: boolean, labelWidth: number, width: number): string[] {
    const mark = selected ? this.color("accent", "›") : " ";
    const masked = r.mask && String(r.value ?? "") !== "";
    if (this.editing === r) {
      // Inline input row — the input's own render (single line) plus the
      // current value as a hint, then the live suggestion list (Tab picks).
      // Lines array, NOT a joined string: the outer render truncates each
      // element, and truncateToWidth collapses a multi-line styled blob into
      // one line, which silently dropped the suggestion list (real theme).
      const inputLines = this.input ? this.input.render(width - 4) : ["…"];
      // Masked rows only: the secret never renders, so hint at its presence.
      // Non-masked rows are prefilled — the value is in the input, no hint.
      const hint = masked ? this.color("dim", " (was: ••••)") : "";
      const lines = [`${mark} ${r.label}: ${inputLines[0] ?? ""}${hint}`];
      if (this.suggestions.length > 0) {
        for (let i = 0; i < this.suggestions.length; i++) {
          const s = this.suggestions[i]!;
          const hl = i === this.suggestionIdx;
          const label = s.label ?? s.value;
          const desc = s.description ? this.color("dim", ` — ${s.description}`) : "";
          const text = `    ${hl ? this.color("accent", "›") : " "}` +
            (hl ? this.color("text", `${label}${desc}`) : this.color("dim", `${label}${desc}`));
          lines.push(text);
        }
      }
      return lines;
    }

    // Info rows: read-only derived state — dim value, never an action hint.
    if (r.kind === "info") {
      const raw = String(r.value ?? "");
      const labelPadI = " ".repeat(Math.max(1, labelWidth - visibleWidth(r.label) + 2));
      const text = `${mark} ${this.color("dim", r.label)}${labelPadI}${this.color("dim", raw)}`;
      return [truncateToWidth(text, width, "...", true)];
    }

    // Label + (warning glyph) + padding + value column.
    const glyph = r.warning ? this.color("warning", " ⚠") : "";
    const labelPad = " ".repeat(Math.max(1, labelWidth - visibleWidth(r.label) - (r.warning ? 2 : 0) + 2));
    const changed = this.isChanged(r);
    let valueText: string;
    // Dim wash wins over semantic colors for rows outside the active section
    // (OMP renders them under one dim wash so nothing fights it).
    const selectedValue = (t: string) =>
      dimmed && !selected
        ? this.color("dim", t)
        : changed ? this.color("warning", t) : selected ? this.color("accent", t) : this.color("muted", t);
    if (r.kind === "toggle") {
      // Selected row wins over the semantic on/off color so the cursor line
      // reads as one unit; changed overrides both (warning).
      valueText = r.value
        ? (selected || changed || dimmed ? selectedValue("on") : this.color("success", "on"))
        : selectedValue("off");
    } else if (r.kind === "action") {
      valueText = this.color("accent", "press Enter");
    } else if (masked) {
      valueText = this.color("dim", "••••");
    } else {
      const raw = String(r.value ?? "");
      valueText = raw === "" ? this.color("dim", "(not set)") : selectedValue(raw);
    }
    // Label priority: selected → accent (the cursor line stays identifiable),
    // else changed → warning (OMP's screenshots: a selected+changed row shows
    // a blue label with an orange value). The dim wash wins outside the
    // active section.
    const labelText = dimmed && !selected
      ? this.color("dim", r.label)
      : selected ? this.color("accent", r.label) : changed ? this.color("warning", r.label) : this.color("text", r.label);
    const rowText = `${mark} ${labelText}${glyph}${labelPad}${valueText}`;
    return [truncateToWidth(rowText, width, "...", true)];
  }

  handleInput(data: string): void {
    // The selection submenu owns EVERY key while open (↑/↓ browse, type to
    // filter, Enter commits, Esc backs out) — Tab/←/→ must not switch tabs
    // underneath it, and the panel Esc-close can't fire from here.
    if (this.menuItem && this.handleMenuInput(data)) return;
    // While editing or prompting, route ALL keys to the inline input — except
    // suggestion navigation (↑/↓), pick (Tab or Enter), and list dismiss
    // (Esc) while a completion list is up. Enter PICKS the highlighted item
    // (picker-first UX, like every other pi selector); after a pick the list
    // is off, so the NEXT Enter submits the typed text (custom refs still
    // reachable: Esc first, then edit + Enter). Tab keeps its fill role.
    if ((this.editing || this.pendingPrompt) && this.input) {
      if (this.editing && this.suggestions.length > 0) {
        const kb = this.keybindings;
        if (kb) {
          if (kb.matches(data, "tui.select.up")) return this.moveSuggestion(-1);
          if (kb.matches(data, "tui.select.down")) return this.moveSuggestion(1);
          if (kb.matches(data, "tui.select.confirm")) return this.acceptSuggestion();
        } else {
          if (data === "\u001b[A" || data === "\u001bOA") return this.moveSuggestion(-1);
          if (data === "\u001b[B" || data === "\u001bOB") return this.moveSuggestion(1);
          if (data === "\r" || data === "\n") return this.acceptSuggestion();
        }
        if (data === "\t") return this.acceptSuggestion();
        // Esc with the list OPEN dismisses the list only (typed text kept);
        // with no list it falls through to Input → cancels the edit.
        if (data === "\u001b" && this.suggestions.length > 0) {
          this.suggestions = [];
          this.lastFilteredValue = this.input.getValue();
          this.requestRender();
          return;
        }
      }
      this.input.handleInput(data);
      if (this.editing) this.refilterSuggestions();
      this.requestRender();
      return;
    }
    const kb = this.keybindings;
    if (kb) {
      if (kb.matches(data, "tui.select.up")) return this.move(-1);
      if (kb.matches(data, "tui.select.down")) return this.move(1);
      if (kb.matches(data, "tui.select.pageUp")) return this.jumpSection(-1);
      if (kb.matches(data, "tui.select.pageDown")) return this.jumpSection(1);
      // matchesKey normalizes every arrow encoding (CSI/SS3/kitty CSI-u) —
      // raw byte comparisons missed SS3 \u001bOD and kitty sequences.
      if (matchesKey(data, "left")) return this.stepTab(-1);
      if (matchesKey(data, "right")) return this.stepTab(1);
      if (matchesKey(data, "tab")) return this.stepTab(1);
      if (matchesKey(data, "shift+tab")) return this.stepTab(-1);
      if (this.filter) {
        // Search-mode keys: printable text edits the query, ⌫ shortens it,
        // Esc clears the filter (a second Esc closes the panel).
        if (kb.matches(data, "tui.select.cancel")) return this.setFilter("");
        if (kb.matches(data, "tui.editor.deleteCharBackward")) return this.setFilter([...this.filter].slice(0, -1).join(""));
        const printable = printableText(data);
        if (printable !== undefined) return this.setFilter(this.filter + printable);
        if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.input.submit")) {
          void this.activate();
          return;
        }
        return;
      }
      if (kb.matches(data, "tui.select.cancel")) return this.onClose?.();
      if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.input.submit")) {
        void this.activate();
        return;
      }
      const printable = printableText(data);
      if (printable !== undefined && (this.filter || printable.trim())) return this.setFilter(printable);
      return;
    }
    // Fallback raw parsing (tests / non-standard keybindings).
    if (this.filter) {
      if (matchesKey(data, "up")) return this.move(-1);
      if (matchesKey(data, "down")) return this.move(1);
      if (matchesKey(data, "left")) return this.stepTab(-1);
      if (matchesKey(data, "right")) return this.stepTab(1);
      if (matchesKey(data, "tab")) return this.stepTab(1);
      if (matchesKey(data, "shift+tab")) return this.stepTab(-1);
      if (matchesKey(data, "pageUp")) return this.jumpSection(-1);
      if (matchesKey(data, "pageDown")) return this.jumpSection(1);
      if (matchesKey(data, "escape") || data === "\u0003") return this.setFilter("");
      if (data === "\u007f" || data === "\b") return this.setFilter([...this.filter].slice(0, -1).join(""));
      const printable = printableText(data);
      if (printable !== undefined) return this.setFilter(this.filter + printable);
      if (matchesKey(data, "enter")) void this.activate();
      return;
    }
    if (matchesKey(data, "up") || data === "k") return this.move(-1);
    if (matchesKey(data, "down") || data === "j") return this.move(1);
    if (matchesKey(data, "left")) return this.stepTab(-1);
    if (matchesKey(data, "right")) return this.stepTab(1);
    if (matchesKey(data, "tab")) return this.stepTab(1);
    if (matchesKey(data, "shift+tab")) return this.stepTab(-1);
    if (matchesKey(data, "pageUp")) return this.jumpSection(-1);
    if (matchesKey(data, "pageDown")) return this.jumpSection(1);
    if (matchesKey(data, "escape") || data === "\u0003") return this.onClose?.();
    if (matchesKey(data, "enter")) void this.activate();
    else {
      const printable = printableText(data);
      // A bare space never starts a search (it would swallow the key).
      if (printable !== undefined && (this.filter || printable.trim())) this.setFilter(printable);
    }
  }

  private async activate(): Promise<void> {
    const row = this.flat[this.selected];
    if (!row) return;
    // Only act on a row the user can actually SEE: an empty tab (or a search
    // with no matches) leaves `selected` on a hidden row — Enter there would
    // silently toggle an invisible setting. Same predicate render() uses.
    const inView = this.filter
      ? this.visible.includes(this.selected)
      : this.tabRows(this.tab).includes(this.selected);
    if (!inView) return;
    // Info rows are display-only (derived state the panel cannot edit).
    if (row.kind === "info") return;
    if (row.kind === "action") {
      // Route through onAction (wired by openConfigPanel) which passes the
      // inline prompt to the action's run(). Actions must NOT call
      // ctx.ui.input/select/confirm — those render under the overlay.
      await this.onAction?.(row);
    } else if (this.hasMenu(row)) {
      this.openMenu(row);
    } else if (row.kind === "toggle") {
      row.set(!row.value);
      this.dirty = true;
      this.editedKeys.add(row.key);
      this.onChanged?.();
      this.committed();
    } else {
      this.startEdit(row);
    }
  }

  // -------------------------------------------------------------------------
  // Selection submenu (OMP's select submenu)
  // -------------------------------------------------------------------------

  /** True when Enter opens the selection submenu: a `values` set or a dynamic
   *  `menu` provider. Pure predicate — never invokes `menu()` (openMenu owns
   *  the single provider call; empty results fall through to inline edit). */
  private hasMenu(row: PanelRow): boolean {
    return !!row.menu || (row.values?.length ?? 0) > 0;
  }

  /** Shared tail of every committed edit: rebuild dynamic groups (rows added
   *  or removed by the setter), then repaint. Order matters on the inline-edit
   *  path — `editing`/`input` must be torn down BEFORE the rebuild so
   *  setGroups swaps rows under a closed editor. */
  private committed(): void {
    if (this.rebuild) this.setGroups(this.rebuild());
    this.requestRender();
  }

  /** Open the submenu for a row: options from `menu()` or `values`, cursor on
   *  the row's current value, and the row's own description/warning kept in
   *  the fixed description area (the row stays `selected`). */
  private openMenu(row: PanelRow): void {
    const options: PanelMenuOption[] = row.menu
      ? row.menu()
      : (row.values ?? []).map((v) => ({ value: v }));
    if (options.length === 0) {
      if (row.kind === "string" || row.kind === "number") this.startEdit(row);
      return;
    }
    const original = String(row.value ?? "");
    const at = options.findIndex((o) => o.value === original);
    this.menuItem = {
      row,
      options,
      view: options,
      idx: at >= 0 ? at : 0,
      query: "",
    };
    this.requestRender();
  }

  /** Selection menu is open (tests + render branch). */
  get menuOpen(): boolean {
    return this.menuItem !== null;
  }

  /** Options the open menu currently shows (tests). */
  get menuOptions(): PanelMenuOption[] {
    return this.menuItem ? [...this.menuItem.view] : [];
  }

  /** Highlighted index in the open menu (tests). */
  get menuIndex(): number {
    return this.menuItem?.idx ?? -1;
  }

  /** Move the menu cursor (clamped, OMP SelectList) and fire the live preview
   *  for the newly highlighted option. */
  private moveMenu(delta: number): void {
    const m = this.menuItem;
    if (!m || m.view.length === 0) return;
    const next = Math.max(0, Math.min(m.view.length - 1, m.idx + delta));
    if (next === m.idx) return;
    m.idx = next;
    m.row.preview?.(m.view[next]!.value);
    this.requestRender();
  }

  /** Page the menu cursor by a viewport (PageUp/Dn). */
  private pageMenu(delta: number): void {
    const m = this.menuItem;
    if (!m || m.view.length === 0) return;
    const next = Math.max(0, Math.min(m.view.length - 1, m.idx + delta * this.bodyRows()));
    if (next === m.idx) return;
    m.idx = next;
    m.row.preview?.(m.view[next]!.value);
    this.requestRender();
  }

  /** Re-filter the menu options against the typed query (case-insensitive
   *  substring on option label + value) and clamp the cursor into range. */
  private refilterMenu(): void {
    const m = this.menuItem;
    if (!m) return;
    const q = m.query.trim().toLowerCase();
    const prev = m.view[m.idx];
    m.view = q
      ? m.options.filter((o) =>
          (o.label ?? o.value).toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
      : m.options;
    if (m.view.length === 0) {
      m.idx = 0;
    } else {
      const at = prev ? m.view.findIndex((o) => o.value === prev.value) : -1;
      m.idx = at >= 0 ? at : 0;
    }
    // A filter change can re-target the highlight (the old option dropped
    // out) — keep the live preview in sync with whatever is now highlighted.
    const next = m.view[m.idx];
    if (next && next.value !== prev?.value) m.row.preview?.(next.value);
    this.requestRender();
  }

  /** Commit the highlighted option: the normal enum write path, then close.
   *  A commit never fires `preview` — the row's own setter is the effect. */
  private commitMenu(): void {
    const m = this.menuItem;
    if (!m) return;
    const picked = m.view[m.idx];
    this.menuItem = null;
    if (!picked) {
      this.requestRender();
      return;
    }
    if (picked.value !== String(m.row.value ?? "")) {
      m.row.set(picked.value);
      this.dirty = true;
      this.editedKeys.add(m.row.key);
      this.onChanged?.();
      this.committed();
      return;
    }
    this.requestRender();
  }

  /** Cancel the menu: let the row undo its live preview (OMP's
   *  onPreviewCancel) and close. Never marks dirty. */
  private cancelMenu(): void {
    const m = this.menuItem;
    if (!m) return;
    this.menuItem = null;
    m.row.previewCancel?.();
    this.requestRender();
  }

  /** Menu key handling. Returns true when the key was consumed. */
  private handleMenuInput(data: string): boolean {
    const m = this.menuItem;
    if (!m) return false;
    const kb = this.keybindings;
    const up = kb ? kb.matches(data, "tui.select.up") : false;
    const down = kb ? kb.matches(data, "tui.select.down") : false;
    const pageUp = kb ? kb.matches(data, "tui.select.pageUp") : false;
    const pageDown = kb ? kb.matches(data, "tui.select.pageDown") : false;
    const cancel = kb ? kb.matches(data, "tui.select.cancel") : false;
    const confirm = kb
      ? kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.input.submit")
      : false;
    if (up || (!kb && matchesKey(data, "up"))) return this.moveMenu(-1), true;
    if (down || (!kb && matchesKey(data, "down"))) return this.moveMenu(1), true;
    if (pageUp || (!kb && matchesKey(data, "pageUp"))) return this.pageMenu(-1), true;
    if (pageDown || (!kb && matchesKey(data, "pageDown"))) return this.pageMenu(1), true;
    if (confirm || (!kb && matchesKey(data, "enter"))) return this.commitMenu(), true;
    // Esc: a non-empty query clears first (OMP: search then back), a second
    // Esc leaves the menu and restores the original value.
    if (cancel || (!kb && (matchesKey(data, "escape") || data === "\u0003"))) {
      if (m.query !== "") {
        m.query = "";
        this.refilterMenu();
      } else {
        this.cancelMenu();
      }
      return true;
    }
    if (kb && kb.matches(data, "tui.editor.deleteCharBackward")) {
      if (m.query !== "") {
        m.query = [...m.query].slice(0, -1).join("");
        this.refilterMenu();
      }
      return true;
    }
    if (!kb && (data === "\u007f" || data === "\b")) {
      if (m.query !== "") {
        m.query = [...m.query].slice(0, -1).join("");
        this.refilterMenu();
      }
      return true;
    }
    const printable = printableText(data);
    if (printable !== undefined) {
      m.query += printable;
      this.refilterMenu();
      return true;
    }
    // Any other key is swallowed — the menu owns input while open (Tab/
    // arrows must not switch tabs or move the hidden rows pane).
    return true;
  }

  /** Begin an inline prompt (for action rows like add/remove entries). */
  prompt(label: string, onDone: (value: string | undefined) => void): void {
    this.pendingPrompt = { label, onDone };
    this.input = new Input();
    this.suggestions = [];
    this.input.onSubmit = (raw: string) => {
      const p = this.pendingPrompt;
      this.pendingPrompt = null;
      this.input = null;
      p?.onDone(raw);
      this.requestRender();
    };
    this.input.onEscape = () => {
      const p = this.pendingPrompt;
      this.pendingPrompt = null;
      this.input = null;
      p?.onDone(undefined);
      this.requestRender();
    };
    this.input.focused = this._focused;
    this.requestRender();
  }

  /** Begin inline editing of a row. String rows with a value start PREFILLED
   *  (cursor at end) so existing entries are edited in place, not retyped;
   *  blank submit still resets (callers define blank = default). Masked rows
   *  start empty — never render the secret — and number rows keep
   *  type-to-replace (prefill + digits would append). */
  private startEdit(row: PanelRow): void {
    this.editing = row;
    this.input = new Input();
    if (row.kind === "string" && !row.mask) {
      const existing = String(row.value ?? "");
      if (existing !== "") {
        this.input.setValue(existing);
        // pi-tui Input.setValue clamps the cursor instead of moving it — park
        // at the end explicitly (same pattern as acceptSuggestion).
        (this.input as unknown as { cursor: number }).cursor = existing.length;
      }
    }
    this.suggestionIdx = 0;
    this.lastFilteredValue = null; // first refilter after start counts as value-change
    this.refilterSuggestions();
    this.input.onSubmit = (raw: string) => {
      if (row.mask && raw === "") {
        this.editing = null;
        this.input = null;
        this.requestRender();
        return;
      }
      const next = kindValue(row.kind, raw);
      if (String(next) !== String(row.value)) {
        row.set(next);
        this.dirty = true;
        this.editedKeys.add(row.key);
        this.onChanged?.();
      }
      this.editing = null;
      this.input = null;
      this.suggestions = [];
      this.committed();
    };
    this.input.onEscape = () => {
      this.editing = null;
      this.input = null;
      this.suggestions = [];
      this.requestRender();
    };
    this.input.focused = this._focused;
    this.requestRender();
  }

  /** Recompute the suggestion list from the input's current text (filtered by
   *  the segment the cursor sits in — arrow left/right retargets the picker
   *  to an earlier entry). Cursor moves WITHOUT value changes show the full
   *  list for that segment (entering an existing entry shouldn't filter to
   *  just itself); typing filters as usual. */
  private refilterSuggestions(): void {
    if (!this.editing?.completions || !this.input) {
      this.suggestions = [];
      return;
    }
    const valueChanged = this.input.getValue() !== this.lastFilteredValue;
    this.suggestions = filterSuggestions(
      this.editing.completions(),
      this.input.getValue(),
      (this.input as unknown as { cursor: number }).cursor,
      !valueChanged, // cursor-only move → empty query → full list
    ).slice(0, MAX_SUGGESTIONS);
    this.lastFilteredValue = this.input.getValue();
    if (valueChanged) {
      this.suggestionIdx = 0;
    } else {
      // Cursor-only retarget: pre-highlight the entry's CURRENT value so the
      // picker opens on what the segment already holds (↓ moves off it).
      const { suffix } = splitSegments(this.input.getValue(), (this.input as unknown as { cursor: number }).cursor);
      const cur = suffix.trim().toLowerCase();
      const at = this.suggestions.findIndex((o) => o.value.toLowerCase() === cur);
      this.suggestionIdx = at >= 0 ? at : 0;
    }
  }

  private moveSuggestion(delta: number): void {
    const next = this.suggestionIdx + delta;
    if (next >= 0 && next < this.suggestions.length) {
      this.suggestionIdx = next;
      this.requestRender();
    }
  }

  /** Pick the highlighted option into the segment at the cursor (Tab or
   *  Enter). Always closes the list — the next Enter submits the value;
   *  typing (`,` or chars) reopens it via refilter. */
  private acceptSuggestion(): void {
    const item = this.suggestions[this.suggestionIdx];
    if (!item || !this.input) return;
    const cursor = (this.input as unknown as { cursor: number }).cursor;
    const before = this.input.getValue();
    const joined = joinCompletion(before, item.value, cursor);
    const head = splitSegments(before, cursor).head;
    this.input.setValue(joined);
    // pi-tui Input.setValue clamps the cursor instead of moving it to the end
    // (stays at 0 on a fresh input). Park at the end of the REPLACED segment
    // (head + ", " + value) — with tail segments after the cursor's segment,
    // joined.length would overshoot into the next entry. Empty head joins
    // WITHOUT the ", " separator, so don't count it.
    (this.input as unknown as { cursor: number }).cursor = (head ? head.length + 2 : 0) + item.value.length;
    this.suggestionIdx = 0;
    // Close: sync lastFilteredValue so the next handleInput doesn't treat the
    // pick as a cursor-only move and "retarget" the list back open.
    this.suggestions = [];
    this.lastFilteredValue = this.input.getValue();
    this.requestRender();
  }

  private move(delta: number): void {
    const pos = this.visiblePos() + delta;
    if (pos < 0 || pos >= this.visible.length) return;
    this.selected = this.visible[pos]!;
    this.requestRender();
  }
}
