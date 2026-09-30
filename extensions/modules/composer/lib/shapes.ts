/**
 * Composer shapes — the full OMP vocabulary (band · box · claude · pi ·
 * borderless · rule · field · rail) with OMP's labels/descriptions.
 *
 * OMP's ComposerStyle owns side chrome, fills and prompt gutters; pi's Editor
 * paints content rows internally. The row CONTENT is still addressable: it is
 * laid out at the shape's content width (`super.render(inner)`), and the TUI
 * locates the hardware cursor with `visibleWidth(textBeforeMarker)` on the
 * FINAL line — so chrome can wrap each composed row (rails, caps, gutter,
 * fill) without touching text, wrapping, or cursor placement.
 *
 * Status: shapes that embed a status line in their chrome (band · box ·
 * claude · rule) render model · dir · context% from live session data.
 * OMP's standalone BOTTOM status bar has no twin here — pi's own footer
 * already sits under the editor for every shape.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth, type EditorTheme, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";

/** Live data the status line shows (fail-soft to blanks). */
export interface BandData {
  model?: string;
  cwd?: string;
  /** Context-window usage percent, when known. */
  pct?: number | null;
}

/** Styling hooks — the live editor and the /config preview both build these
 *  from the live theme, so the two can never drift. */
export interface ShapeTheme {
  border: (s: string) => string;
  accent: (s: string) => string;
  text: (s: string) => string;
  dim: (s: string) => string;
  warn: (s: string) => string;
  /** Filled surface (background + on-surface foreground), robust to nested
   *  SGR resets — the cursor glyph emits one, which would otherwise drop the
   *  fill from that point on (OMP's bgFill). */
  fill: (s: string) => string;
  inverse: (s: string) => string;
}

export const IDENTITY_THEME: ShapeTheme = {
  border: (s) => s,
  accent: (s) => s,
  text: (s) => s,
  dim: (s) => s,
  warn: (s) => s,
  fill: (s) => s,
  inverse: (s) => s,
};

/** The slice of pi's Theme the shapes need (the live Theme satisfies it). */
export interface ThemeLike {
  fg: (color: never, text: string) => string;
  getBgAnsi?: (color: never) => string;
  getFgAnsi?: (color: never) => string;
  inverse?: (text: string) => string;
}

/** Build the shape styling from a live pi Theme. */
export function shapeTheme(t: ThemeLike): ShapeTheme {
  const bg = t.getBgAnsi?.("userMessageBg" as never) ?? "";
  const onBg = t.getFgAnsi?.("userMessageText" as never) ?? "";
  return {
    border: (s) => t.fg("borderMuted" as never, s),
    accent: (s) => t.fg("accent" as never, s),
    text: (s) => t.fg("text" as never, s),
    dim: (s) => t.fg("dim" as never, s),
    warn: (s) => t.fg("warning" as never, s),
    fill: surfacePainter(bg + onBg),
    inverse: (s) => t.inverse?.(s) ?? s,
  };
}

export interface ShapeCtx {
  /** FULL composer width (side chrome included). */
  w: number;
  /** Content lines scrolled out of view. */
  hidden: number;
  theme: ShapeTheme;
  /** Pre-styled status line, when the shape embeds one. */
  status?: string;
  /** The active shape's prompt gutter (wired in at render time so row
   *  builders can align continuation rows without a second parameter). */
  gutter?: string;
}

export interface RowOpts {
  first: boolean;
  isLast: boolean;
}

export interface ComposerShapeDef {
  id: string;
  /** OMP's selector label + description — the /config menu copy. */
  label: string;
  description: string;
  /** Cells one side chrome consumes per side (0 = none). */
  sideWidth: number;
  /** Minimum editor paddingX this shape needs (host padding can raise it). */
  padX: number;
  /** True when the shape's top row embeds the status line (OMP's
   *  statusAttachment). Non-embedding shapes surface the working spinner
   *  through pi's native spinner-bearing rule instead. */
  embedsStatus?: boolean;
  /** First-row prompt gutter (OMP's defaultPromptGutter); continuation rows
   *  get spaces so the text column stays aligned. */
  gutter?: string;
  top?: (c: ShapeCtx) => string | undefined;
  bottom?: (c: ShapeCtx) => string | undefined;
  /** Wrap one composed editor row, padded to the content width. */
  row: (c: ShapeCtx, text: string, o: RowOpts) => string;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const spaces = (n: number) => " ".repeat(Math.max(0, n));

/** Pad a composed row to the content width (ANSI- and cursor-marker-safe). */
export const padRow = (inner: number, text: string) => text + spaces(inner - visibleWidth(text));

/** Surface painter that survives nested resets (OMP's bgFill): re-apply the
 *  bg+fg prefix after every reset the row text carries. */
export function surfacePainter(prefix: string): (s: string) => string {
  return (s) => (prefix === "" ? s : prefix + s.replace(/\x1b\[0m/g, `\x1b[0m${prefix}`) + "\x1b[39m\x1b[49m");
}

/** One styled status line: model · dir · context% (segments drop out when the
 *  session hasn't provided them — never wrong, just shorter). */
export function statusLine(data: BandData | undefined, theme: ShapeTheme): string {
  const sep = theme.dim(" · ");
  const parts: string[] = [];
  if (data?.model?.trim()) parts.push(theme.accent(data.model.trim()));
  if (data?.cwd?.trim()) parts.push(theme.dim(data.cwd.trim()));
  if (typeof data?.pct === "number" && Number.isFinite(data.pct)) {
    const pct = Math.round(data.pct);
    parts.push(pct > 80 ? theme.warn(`${pct}%`) : theme.dim(`${pct}%`));
  }
  return parts.join(sep);
}

function rule(w: number, th: ShapeTheme): string {
  return th.border("─".repeat(Math.max(0, w)));
}

/** Rule carrying pi's native scroll indicator (` ↑ N more `), centered. */
function ruleWithScroll(w: number, hidden: number, th: ShapeTheme): string {
  if (hidden > 0) {
    const label = ` ↑ ${hidden} more `;
    const lw = visibleWidth(label);
    if (lw + 2 <= w) {
      const left = Math.floor((w - lw) / 2);
      return th.border("─".repeat(left) + label + "─".repeat(w - left - lw));
    }
  }
  return rule(w, th);
}

/** Right-docked status chip on a rule (OMP's renderTopRule: left fill, status
 *  at the right edge, one rule cell after it). */
function topRuleChip(c: ShapeCtx): string {
  const { w, theme, status } = c;
  if (status && visibleWidth(status) > 0 && w > 2) {
    const content = visibleWidth(status) > w - 2 ? truncateToWidth(status, w - 2, "…") : status;
    return theme.border("─".repeat(Math.max(0, w - visibleWidth(content) - 1))) + content + theme.border("─");
  }
  return ruleWithScroll(w, c.hidden, theme);
}

/** Flush soft-capped status band (no frame). Reserved row: blank when the
 *  status has nothing to show yet, so the layout never shifts. */
function bandTop(c: ShapeCtx): string {
  const { w, theme, status } = c;
  if (!status || visibleWidth(status) === 0) return "";
  const cap = theme.accent("╭─");
  const scroll = c.hidden > 0 ? theme.border(` ↑${c.hidden} `) : "";
  const budget = Math.max(1, w - visibleWidth(cap) - visibleWidth(scroll));
  const body = truncateToWidth(` ${status} `, budget);
  return cap + theme.fill(body + spaces(budget - visibleWidth(body))) + scroll;
}

/** Rounded box top: `╭─ status ─────╮` (status left-embedded, OMP's box). */
function boxTop(c: ShapeCtx): string {
  const { w, theme, status } = c;
  const inner = Math.max(0, w - 2);
  if (!status || visibleWidth(status) === 0) return theme.border("╭" + "─".repeat(inner) + "╮");
  const content = truncateToWidth(status, Math.max(1, inner - 4), "…");
  // `╭─ ` (3) + content + ` ` (1) + fill + `─` (1) + `╮` (1) = w  ⇒  fill = inner - content - 4.
  const fill = "─".repeat(Math.max(0, inner - visibleWidth(content) - 4));
  return theme.border("╭─ ") + content + theme.border(" " + fill + "─" + "╮");
}

/** Prompt gutter on the first row, aligned blanks on continuation rows. */
const gutterRow = (c: ShapeCtx, text: string, o: RowOpts) => {
  const gw = visibleWidth(c.gutter ?? "");
  if (gw === 0) return text;
  return o.first ? sliceByColumn(c.gutter!, 0, gw, true) + text : spaces(gw) + text;
};

// ── the shapes (OMP order + copy) ────────────────────────────────────────────

export const SHAPES: ComposerShapeDef[] = [
  {
    id: "band",
    label: "Status Band (Default)",
    description: "Flush soft-capped status band above a curved prompt, no frame",
    sideWidth: 0,
    padX: 0,
    embedsStatus: true,
    gutter: "╰─ ",
    top: bandTop,
    row: (c, text, o) =>
      (o.first ? c.theme.border(c.gutter ?? "") : spaces(visibleWidth(c.gutter ?? ""))) + text,
  },
  {
    id: "box",
    label: "Rounded Box",
    description: "Status line embedded in top border, compact 2-line prompt",
    sideWidth: 1,
    padX: 2,
    embedsStatus: true,
    top: boxTop,
    row: (c, text, o) => {
      if (!o.isLast) return c.theme.border("│") + text + c.theme.border("│");
      // Merge the bottom border into the last content row (OMP's box):
      // `╰─ text ─╯` — one padding cell each side becomes the corner rule.
      const trimStart = text.startsWith(" ") ? text.slice(1) : text;
      const trimEnd = trimStart.endsWith(" ") ? trimStart.slice(0, -1) : trimStart;
      return c.theme.border("╰─") + trimEnd + c.theme.border("─╯");
    },
  },
  {
    id: "claude",
    label: "Claude Code",
    description: "Full-width horizontal rules above and below, status line at bottom",
    sideWidth: 0,
    padX: 0,
    embedsStatus: true,
    gutter: "❯ ",
    top: topRuleChip,
    bottom: (c) => ruleWithScroll(c.w, c.hidden, c.theme),
    row: (c, text, o) => (o.first ? c.theme.accent(c.gutter ?? "") : spaces(visibleWidth(c.gutter ?? ""))) + text,
  },
  {
    id: "pi",
    label: "Pi",
    description: "Framed horizontal rules with status line at bottom",
    sideWidth: 0,
    padX: 1,
    top: (c) => ruleWithScroll(c.w, c.hidden, c.theme),
    bottom: (c) => ruleWithScroll(c.w, c.hidden, c.theme),
    row: (_c, text) => text,
  },
  {
    id: "borderless",
    label: "Borderless",
    description: "Clean prompt glyph with status line at bottom, no box borders",
    sideWidth: 0,
    padX: 0,
    gutter: "❯ ",
    row: (c, text, o) => (o.first ? c.theme.accent(c.gutter ?? "") : spaces(visibleWidth(c.gutter ?? ""))) + text,
  },
  {
    id: "rule",
    label: "Top Rule Dock",
    description: "Single top rule with status docked onto it and below",
    sideWidth: 0,
    padX: 0,
    embedsStatus: true,
    gutter: "❯ ",
    top: topRuleChip,
    row: (c, text, o) => (o.first ? c.theme.accent(c.gutter ?? "") : spaces(visibleWidth(c.gutter ?? ""))) + text,
  },
  {
    id: "field",
    label: "Compact Field",
    description: "Filled one-row field with accent end caps",
    sideWidth: 1,
    padX: 1,
    row: (c, text) => c.theme.accent("▐") + c.theme.fill(text) + c.theme.accent("▌"),
  },
  {
    id: "rail",
    label: "Accent Rail",
    description: "Filled one-row field anchored by a single accent rail",
    sideWidth: 1,
    padX: 1,
    row: (c, text) => c.theme.accent("▎") + c.theme.fill(text),
  },
];

export const SHAPE_IDS: readonly string[] = SHAPES.map((s) => s.id);

/** OMP's default composer shape. */
export const DEFAULT_SHAPE = "band";

export function isShapeId(v: unknown): v is string {
  return typeof v === "string" && SHAPE_IDS.includes(v);
}

/** Unknown ids fall back to the default (OMP's getComposerStyle contract) —
 *  a stale settings value must never break the editor. */
export function shapeById(id: string): ComposerShapeDef {
  return SHAPES.find((s) => s.id === id) ?? SHAPES[0]!;
}

/** Gutter cells a shape's layout reserves on every row. */
export function gutterWidth(shape: ComposerShapeDef, w: number): number {
  return Math.min(visibleWidth(shape.gutter ?? ""), Math.max(0, w - shape.sideWidth * 2 - 1));
}

/** Content width the editor lays text out at, for a given shape. */
export function contentWidth(shape: ComposerShapeDef, w: number): number {
  return Math.max(1, w - shape.sideWidth * 2 - gutterWidth(shape, w));
}

/** Render one shape through its own chrome builders — the /config preview and
 *  the live editor share these, so the preview cannot drift. */
export function previewShape(id: string, w: number, theme: ShapeTheme, data?: BandData): string[] {
  const shape = shapeById(id);
  const inner = contentWidth(shape, w);
  const c: ShapeCtx = { w, hidden: 0, theme, gutter: shape.gutter, status: statusLine(data, theme) || undefined };
  const prompt = theme.text(truncateToWidth("Ask anything, edit files, run tools", Math.max(1, inner - shape.padX * 2 - 1), "…"));
  const text = padRow(inner, spaces(shape.padX) + prompt + theme.inverse(" "));
  const lines: string[] = [];
  const top = shape.top?.(c);
  if (top !== undefined) lines.push(top);
  lines.push(shape.row(c, text, { first: true, isLast: true }));
  const bottom = shape.bottom?.(c);
  if (bottom !== undefined) lines.push(bottom);
  return lines.map((l) => truncateToWidth(l, w, "", true));
}

type EditorCtorArgs = ConstructorParameters<typeof CustomEditor>;

/** The native editor re-chromed by a shape. Extends `CustomEditor` so pi
 *  duck-types the full app keybinding surface onto it (escape, ctrl+d,
 *  paste-image, extension shortcuts, action handlers). */
export class ShapeEditor extends CustomEditor {
  private shape: ComposerShapeDef;
  private shapeTheme: () => ShapeTheme;
  private data: () => BandData | undefined;

  constructor(shape: ComposerShapeDef, opts: { theme: () => ShapeTheme; data: () => BandData | undefined }, ...base: EditorCtorArgs) {
    super(...base);
    this.shape = shape;
    this.shapeTheme = opts.theme;
    this.data = opts.data;
    super.setPaddingX(this.effectivePadding(super.getPaddingX()));
  }

  /** The shape owns its minimum padding; host padding may raise it. */
  override setPaddingX(padding: number): void {
    super.setPaddingX(this.effectivePadding(padding));
  }

  private effectivePadding(host: number): number {
    const h = Number.isFinite(host) ? Math.max(0, Math.floor(host)) : 0;
    return Math.max(h, this.shape.padX);
  }

  override render(width: number): string[] {
    try {
      const shape = this.shape;
      const theme = this.safeTheme();
      const inner = contentWidth(shape, width);
      const raw = super.render(inner);
      const ac = (this as unknown as { renderedAutocompleteHeight?: number }).renderedAutocompleteHeight;
      const acH = typeof ac === "number" ? ac : 0;
      const bottomIdx = Math.max(1, raw.length - acH - 1);
      const content = raw.slice(1, bottomIdx);
      const acRows = raw.slice(bottomIdx + 1);

      const spinner = this.spinnerText();
      const status = [spinner, statusLine(this.safeData(), theme)].filter(Boolean).join("  ");
      const c: ShapeCtx = { w: width, hidden: this.hiddenLines(), theme, gutter: shape.gutter, status: status || undefined };

      const out: string[] = [];
      const top = shape.top?.(c);
      if (spinner !== undefined && !shape.embedsStatus) {
        // No status-bearing chrome on this shape — the spinner rides pi's
        // native spinner-bearing rule instead (only while a turn runs).
        out.push(this.nativeTop(raw[0]!, width, theme));
      } else if (top !== undefined) {
        out.push(top);
      }
      content.forEach((r, i) => out.push(shape.row(c, padRow(inner, r), { first: i === 0, isLast: i === content.length - 1 })));
      const bottom = shape.bottom?.(c);
      if (bottom !== undefined) out.push(bottom);
      for (const r of acRows) out.push(shape.row(c, padRow(inner, r), { first: false, isLast: false }));
      return out.map((l) => truncateToWidth(l, width, "", true));
    } catch {
      // A core feature must never take the editor down with it.
      return super.render(width);
    }
  }

  /** Keep the native spinner border visible at full width. */
  private nativeTop(nativeLine: string, width: number, theme: ShapeTheme): string {
    return nativeLine + theme.border("─".repeat(Math.max(0, width - visibleWidth(nativeLine))));
  }

  /** The working spinner glyph from the embedded indicator, when active. */
  private spinnerText(): string | undefined {
    try {
      const ind = (this as unknown as { workingStatusIndicator?: { renderSpinnerInBorder?: (w: number) => string } }).workingStatusIndicator;
      return ind && typeof ind.renderSpinnerInBorder === "function" ? ind.renderSpinnerInBorder(2) : undefined;
    } catch {
      return undefined;
    }
  }

  private hiddenLines(): number {
    // ponytail: private pi-tui scroll state, read guarded — 0 when it moves.
    const v = (this as unknown as { scrollOffset?: unknown }).scrollOffset;
    return typeof v === "number" ? v : 0;
  }

  private safeTheme(): ShapeTheme {
    try {
      return this.shapeTheme() ?? IDENTITY_THEME;
    } catch {
      return IDENTITY_THEME;
    }
  }

  private safeData(): BandData | undefined {
    try {
      return this.data();
    } catch {
      return undefined;
    }
  }
}
