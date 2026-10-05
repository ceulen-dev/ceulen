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
 * Status architecture = OMP's, per shape: band/box embed a POWERLINE status
 * row (bg-filled left group `π > ⬢ model > 📁 dir > ⑂ git`, OMP's context
 * gauge with embedded `N%`/window labels, session-title chip on box) — the
 * band relocates the title away, exactly like OMP's band layout. claude and
 * rule dock the session-title chip on the top rule and render the left group
 * + context segment on a standalone BOTTOM bar (left of the closing rule for
 * claude, after a spacer row for rule); pi/borderless/field/rail render the
 * full standalone bottom bar (session title right-justified). pi's replaced
 * footer keeps only the other extensions' statuses; line 1 (rateLine) stays
 * ceulen's numeric block on every shape.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth, type EditorTheme, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Live data the status line shows (fail-soft to blanks). */
export interface BandData {
  model?: string;
  /** Router/provider prefix of the model id, shown before the model. */
  provider?: string;
  /** Current thinking level (pi's ThinkingLevel, rendered after the model). */
  thinkingLevel?: string;
  /** Display cwd (`~/…`-relative, pi-footer parity). */
  cwd?: string;
  /** Current git branch, "detached", or null outside a repo. */
  branch?: string | null;
  /** Working-tree counts (`*` unstaged, `+` staged, `?` untracked). */
  git?: GitStats | null;
  /** Context-window usage percent, when known. */
  pct?: number | null;
  /** Context window size in tokens, when known. */
  window?: number;
  /** Auto-compaction armed (drives the gauge's `┃` threshold marker and the
   *  context segment's `⟲` icon — OMP's auto marker). */
  autoCompact?: boolean;
  /** Session title (OMP's session_name segment — the right group / rule chip). */
  sessionName?: string;
  /** Generation Rate: last response's tok/s. */
  rate?: number;
  /** Provider quota windows from the usage module (e.g. `(router) R:59%/2H3M`). */
  usage?: string;
  /** Usage tone — warning/error when quota runs low, dim otherwise. */
  usageTone?: "dim" | "warning" | "error";
  /** Session token stats, pi-footer format (e.g. `↑1.9M ↓377k R69M CH99.7%`). */
  stats?: string;
}

/** Working-tree change counts (OMP's git segment indicators). */
export interface GitStats {
  staged: number;
  unstaged: number;
  untracked: number;
}

/** Styling hooks — the live editor and the /config preview both build these
 *  from the live theme, so the two can never drift. */
export interface ShapeTheme {
  border: (s: string) => string;
  accent: (s: string) => string;
  text: (s: string) => string;
  dim: (s: string) => string;
  warn: (s: string) => string;
  error: (s: string) => string;
  /** Clean-tree git branch / staged indicator (OMP's statusLineStaged). */
  success: (s: string) => string;
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
  error: (s) => s,
  success: (s) => s,
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
    error: (s) => t.fg("error" as never, s),
    success: (s) => t.fg("success" as never, s),
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
  /** Live session data for the embedded status line. */
  data?: BandData;
  /** Working-spinner glyph, joined into the status left group. */
  spinner?: string;
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
  /** True when the shape's top chrome carries status (band/box powerline
   *  row, claude/rule chip); the rest surface the spinner through pi's
   *  native spinner-bearing rule and status on the standalone bottom bar. */
  embedsStatus?: boolean;
  /** OMP's bottomBar: standalone status bar under the editor — `left` group
   *  only (claude/rule: the title rides the top rule), `full` (pi/borderless/
   *  field/rail: title right-justified), `none` (band/box: embedded top). */
  bottomBar?: "left" | "full" | "none";
  /** Blank spacer row between the editor and the standalone bottom bar
   *  (OMP's bottomBarGap — styles without bottom chrome need it). */
  barGap?: boolean;
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

/** Token/window figure in OMP's formatNumber shape (`9.5k`, `200K`, `1.0M`). */
export function formatNumberTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 10_000) return `${trim1(n / 1000)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  if (n < 10_000_000) return `${trim1(n / 1_000_000)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

const trim1 = (n: number): string => {
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
};

/** Composer status icons — OMP's unicode glyph set, so every shape speaks the
 *  same visual language: brand mark before the model, folder on the working
 *  dir, branch glyph on the git segment, throughput on the Generation Rate. */
export const ICONS = {
  brand: "π",
  model: "⬢",
  folder: "📁",
  branch: "⑂",
  context: "◫",
  auto: "⟲",
  threshold: "┃",
  throughput: "⚡",
} as const;

/** Context-window segment: `◫ 2.1%/1M ⟲` (OMP's context_pct — icon, one-
 *  decimal pct + OMP-format window, auto-compact `⟲` when armed). Color
 *  steps at OMP's thresholds (>50 warning, >90 error). */
function contextSegment(data: BandData, theme: ShapeTheme): string {
  const pct = typeof data.pct === "number" && Number.isFinite(data.pct) ? data.pct : undefined;
  const win = typeof data.window === "number" && data.window > 0 ? formatNumberTokens(data.window) : undefined;
  if (pct === undefined && win === undefined) return "";
  const text = pct !== undefined ? `${pct.toFixed(1)}%${win ? `/${win}` : ""}` : `${win}/?`;
  const color = pct !== undefined && pct > 90 ? theme.error : pct !== undefined && pct > 50 ? theme.warn : theme.dim;
  const auto = data.autoCompact ? ` ${theme.dim(ICONS.auto)}` : "";
  return `${theme.dim(ICONS.context)} ${color(text)}${auto}`;
}

/** Git segment: `⑂ main *3 +1 ?2` — branch + OMP's working-tree indicators,
 *  each in OMP's per-indicator color (`*` unstaged warn, `+` staged success,
 *  `?` untracked dim); the branch goes warning when the tree is dirty. */
function gitSegment(data: BandData, theme: ShapeTheme): string {
  const branch = typeof data.branch === "string" && data.branch.trim() ? data.branch.trim() : "";
  const g = data.git;
  const dirty = !!g && g.staged + g.unstaged + g.untracked > 0;
  const ind: string[] = [];
  if (dirty && g) {
    if (g.unstaged > 0) ind.push(theme.warn(`*${g.unstaged}`));
    if (g.staged > 0) ind.push(theme.success(`+${g.staged}`));
    if (g.untracked > 0) ind.push(theme.dim(`?${g.untracked}`));
  }
  const branchText = branch ? `${ICONS.branch} ${branch}` : ind.length > 0 ? ICONS.branch : "";
  if (!branchText) return "";
  // OMP colors the BRANCH itself only when dirty; a clean branch rides the
  // plain group color, and only the indicators carry their own colors.
  return [dirty ? theme.warn(branchText) : branchText, ...ind].join(" ");
}

/** The status line's stock groups. OMP's powerline layouts fill the LEFT
 *  group (brand · model · dir · git) with the context segment appended —
 *  the gauge absorbs the context figure at render time; the RIGHT group is
 *  the session title. `plain` bars join with ` · ` instead of powerline `>`. */
export function statusSegments(
  data: BandData | undefined,
  theme: ShapeTheme,
  spinner?: string,
): { left: string; right: string } {
  return {
    left: identitySegments(data, theme, spinner).join(theme.dim(` ${POWERLINE_SEP} `)),
    right: data?.sessionName?.trim() ? theme.accent(data.sessionName.trim()) : "",
  };
}

/** The identity segments WITHOUT the leading brand (model · dir · git) —
 *  the bottom bar appends the context segment before the brand joins. */
function identityList(data: BandData | undefined, theme: ShapeTheme): string[] {
  const identity: string[] = [];
  const model = data?.model?.trim();
  if (model) {
    const level = data?.thinkingLevel?.trim();
    let label = `${ICONS.model} ${theme.accent(model)}`;
    if (level && level !== "off") label += theme.dim(` · ${level}`);
    identity.push(label);
  }
  const cwd = data?.cwd?.trim();
  if (cwd) identity.push(theme.dim(`${ICONS.folder} ${cwd}`));
  const git = data ? gitSegment(data, theme) : "";
  if (git) identity.push(git);
  return identity;
}

/** The identity group as separate styled segments, brand first — callers that
 *  must fit a fixed width shed WHOLE trailing segments (git → dir) rather
 *  than cutting one in half (OMP's overflow behavior). Model segment:
 *  `⬢ model · level` (OMP's model segment: icon, thinking level after OMP's
 *  dot separator). */
export function identitySegments(data: BandData | undefined, theme: ShapeTheme, spinner?: string): string[] {
  const identity = identityList(data, theme);
  // Generation rate renders as its own right-justified line ABOVE the band
  // (OMP's throughline placement) — not a band segment.
  // The brand leads ONLY a group that exists (OMP's pi segment): with nothing
  // to identify, the band stays blank so the layout never shifts on startup.
  // While a turn runs the working spinner takes the brand slot.
  const lead = identity.length > 0 || spinner ? spinner ?? theme.dim(ICONS.brand) : undefined;
  return lead ? [lead, ...identity] : identity;
}

/** Powerline separator + soft cap glyphs (OMP's `powerline-thin` / band cap;
 *  the unicode fallbacks — the nerd-font private-use glyphs are terminal-
 *  specific, and the ascii twins render everywhere). */
const POWERLINE_SEP = ">";
/** OMP's band soft cap (`sep.powerlineCapLeft`) — empty in the unicode/ascii
 *  symbol sets (only the nerd set has \ue0b6), so the band starts flush. */
const BAND_CAP = "";
/** Cells reserved ahead of the left group so the gauge keeps room for its
 *  embedded `─N% ┃ ─window` labels (OMP's embeddedContextGaugeMinWidth). */
const GAUGE_RESERVE = 14;

/** Fill a styled group for the powerline row: OMP's bg-filled group text —
 *  ` seg > seg > seg ` — padded one cell each side, background preserved
 *  across the nested SGR resets the styled segments carry. */
function powerlineGroup(segs: readonly string[], theme: ShapeTheme): string {
  if (segs.length === 0) return "";
  const joined = segs.join(theme.dim(` ${POWERLINE_SEP} `));
  return theme.fill(` ${joined} `);
}

/** One composed status line: left flush-left, right justified right. Over-
 *  budget, the LEFT group yields first (OMP's priority — the session title
 *  stays); the right group is truncated only when it alone overflows. */
export function composeStatus(left: string, right: string, w: number): string {
  const rw = visibleWidth(right);
  if (!right) return left;
  if (!left) return rw > w ? truncateToWidth(right, Math.max(1, w), "…") : right;
  const lw = visibleWidth(left);
  const gap = w - lw - rw;
  if (gap >= 1) return left + spaces(gap) + right;
  const room = w - rw - 1;
  if (room <= 0) return truncateToWidth(right, Math.max(1, w), "…");
  return truncateToWidth(left, room, "…") + " " + right;
}

function rule(w: number, th: ShapeTheme): string {
  return th.border("─".repeat(Math.max(0, w)));
}

/** Rule carrying pi's scroll indicator (` ↑ N more `), centered. */
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

/** Context-reactive gauge (OMP's #buildContextGaugeFill): accent used-portion,
 *  border remainder; the rounded `N%` label rides just past the used cells,
 *  the `┃` marks pi's auto-compaction threshold position (window − 16384
 *  reserve) when armed, and the window figure sits at the far right edge. */
function gaugeFill(w: number, data: BandData | undefined, theme: ShapeTheme): string {
  const pct = typeof data?.pct === "number" && Number.isFinite(data.pct) ? Math.min(100, Math.max(0, data.pct)) : null;
  const win = typeof data?.window === "number" && data.window > 0 ? formatNumberTokens(data.window) : undefined;
  const windowLabel = win ?? "";
  const percentLabel = pct === null ? "" : `${Math.round(pct)}%`;
  const windowStart = windowLabel ? Math.max(1, w - windowLabel.length - 1) : -1;
  const scale = windowStart >= 0 ? windowStart : w;
  const usedCount = Math.min(scale, Math.max(1, Math.round(((pct ?? 0) / 100) * scale)));
  const percentStart = percentLabel ? Math.min(Math.max(1, scale - percentLabel.length - 1), Math.max(1, usedCount)) : -1;
  // pi's compaction fires at contextWindow − reserveTokens (16384 default).
  const thresholdIdx =
    data?.autoCompact && w >= 8 && data.window ? Math.min(scale - 1, Math.max(0, Math.round(((data.window - 16384) / data.window) * scale))) : -1;
  let out = "";
  for (let i = 0; i < w; i++) {
    if (percentStart >= 0 && i >= percentStart && i < percentStart + percentLabel.length) out += theme.accent(percentLabel[i - percentStart]!);
    else if (i === thresholdIdx && (percentStart < 0 || i < percentStart || i >= percentStart + percentLabel.length)) out += theme.dim(ICONS.threshold);
    else if (windowStart >= 0 && i >= windowStart) out += i < windowStart + windowLabel.length ? theme.dim(windowLabel[i - windowStart]!) : theme.dim("─");
    else out += i < usedCount ? theme.accent("─") : theme.border("─");
  }
  return out;
}

/** Left group the gauge layouts shed whole trailing segments from
 *  (stats → git → dir), never a half segment. */
function shedSegments(segs: readonly string[], theme: ShapeTheme, budget: number): string[] {
  const sep = visibleWidth(theme.dim(` ${POWERLINE_SEP} `));
  const width = (n: number) => segs.slice(0, n).reduce((a, s) => a + visibleWidth(s), 0) + sep * Math.max(0, n - 1);
  let keep = segs.length;
  while (keep > 1 && width(keep) > budget) keep--;
  return width(keep) > budget ? [] : segs.slice(0, keep);
}

/** Right-docked session-title chip on a rule (OMP's renderTopRule: left
 *  fill, chip near the right edge, one rule cell after it). */
function topRuleChip(c: ShapeCtx): string {
  const { w, theme, data } = c;
  const title = data?.sessionName?.trim() ? theme.accent(data.sessionName.trim()) : "";
  if (visibleWidth(title) > 0 && w > 2) {
    const content = visibleWidth(title) > w - 2 ? truncateToWidth(title, w - 2, "…") : title;
    return theme.border("─".repeat(Math.max(0, w - visibleWidth(content) - 1))) + content + theme.border("─");
  }
  return ruleWithScroll(w, c.hidden, theme);
}

/** Flush soft-capped powerline band (OMP's band layout, minus the session
 *  title it relocates): filled left group, context-reactive gauge to the
 *  right edge. Reserved blank row until the status has anything to show. */
function bandTop(c: ShapeCtx): string {
  const { w, theme, data } = c;
  const segs = identitySegments(data, theme, c.spinner);
  const context = data ? contextSegment(data, theme) : "";
  if (segs.length === 0 && context === "") return ""; // reserved blank row until data arrives
  const budget = Math.max(0, w - visibleWidth(BAND_CAP) - GAUGE_RESERVE);
  const left = powerlineGroup(shedSegments(segs, theme, budget), theme);
  const body = Math.max(0, w - visibleWidth(BAND_CAP) - visibleWidth(left));
  return left + gaugeFill(body, data, theme);
}

/** Rounded box top: `╭─ left …gauge… title ─╮` — the powerline row embedded
 *  in the border (OMP's box + getTopBorder, session-title chip on the right). */
function boxTop(c: ShapeCtx): string {
  const { w, theme, data } = c;
  const inner = Math.max(0, w - 2);
  const segs = identitySegments(data, theme, c.spinner);
  const title = data?.sessionName?.trim() ? theme.accent(data.sessionName.trim()) : "";
  if (segs.length === 0 && !title) return theme.border("╭" + "─".repeat(inner) + "╮");
  const titleBlock = title ? ` ${title} ` : "";
  // `╭─` + content + `─╮` = w ⇒ the content budget is inner - 2; the closing
  // dash before `╮` is unconditional (OMP's ` omp ─┐`).
  const body = Math.max(0, inner - 2);
  const gauge = Math.min(Math.max(8, Math.floor(inner / 5)), Math.max(8, body - visibleWidth(titleBlock) - 24));
  const budget = Math.max(0, body - gauge - visibleWidth(titleBlock));
  let left = powerlineGroup(shedSegments(segs, theme, budget), theme);
  if (visibleWidth(left) > budget) left = truncateToWidth(left, budget, "…");
  const gap = Math.max(0, body - visibleWidth(left) - visibleWidth(titleBlock));
  return theme.border("╭─") + left + gaugeFill(gap, data, theme) + titleBlock + theme.border("─╮");
}

/** Standalone bottom status bar (OMP's renderBottomBar): plain ` · `-joined
 *  groups — left group + context segment flush-left, session title right-
 *  justified. `groups: "left"` drops the title (claude/rule: it's on the chip). */
export function bottomBar(c: ShapeCtx, groups: "left" | "full"): string {
  const { w, theme, data } = c;
  const identity = identityList(data, theme);
  const context = data ? contextSegment(data, theme) : "";
  const rest = context ? [...identity, context] : identity;
  const title = groups === "full" && data?.sessionName?.trim() ? theme.accent(data.sessionName.trim()) : "";
  if (rest.length === 0 && !title) return "";
  const lead = rest.length > 0 || c.spinner ? c.spinner ?? theme.dim(ICONS.brand) : undefined;
  const segs = lead ? [lead, ...rest] : rest;
  const sep = theme.dim(" · ");
  const right = title;
  const rw = visibleWidth(right) + (right ? 1 : 0);
  let keep = segs.length;
  const width = (n: number) => segs.slice(0, n).reduce((a, s) => a + visibleWidth(s), 0) + visibleWidth(sep) * Math.max(0, n - 1);
  while (keep > 1 && width(keep) + rw > w) keep--;
  const left = width(keep) + rw > w ? "" : segs.slice(0, keep).join(sep);
  return composeStatus(left, right, w);
}

/** Line 1 (OMP's Generation Rate placement): the numeric block split by the
 *  composer's stock left/right groups — token stats + quota windows flush
 *  LEFT, tok/s justified RIGHT — so the band stays identity-only. Blank (no
 *  row) while there is nothing to show. Narrow widths shed whole trailing
 *  left segments (usage → stats) before the rate yields anything. */
export function rateLine(data: BandData | undefined, theme: ShapeTheme, w: number): string {
  const left: string[] = [];
  const stats = data?.stats?.trim();
  if (stats) left.push(theme.dim(stats));
  const usage = data?.usage?.trim();
  const paint = data?.usageTone === "error" ? theme.error : data?.usageTone === "warning" ? theme.warn : theme.dim;
  if (usage) left.push(paint(usage));
  const rate = data?.rate;
  const right = typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? theme.dim(`${ICONS.throughput} ${Math.round(rate)} tok/s`) : "";
  if (left.length === 0 && !right) return "";
  const sep = theme.dim(" · ");
  let keep = left.length;
  while (keep > 0 && visibleWidth(left.slice(0, keep).join(sep)) + (right ? visibleWidth(right) + 1 : 0) > w) keep--;
  const leftText = left.slice(0, keep).join(sep);
  if (!right) return leftText;
  if (!leftText) return spaces(Math.max(0, w - visibleWidth(right))) + right;
  return composeStatus(leftText, right, w);
}

/** Current git branch for a cwd — reads `.git/HEAD` (walk-up; a `.git` FILE
 *  is a linked worktree pointing at `gitdir:`), `"detached"` on a raw SHA,
 *  null outside a repo. Sync by design: callers cache; never watches. */
export function readGitBranch(cwd: string): string | null {
  try {
    let dir = resolve(cwd);
    for (let up = 0; up < 64; up++) {
      const dotGit = join(dir, ".git");
      if (existsSync(dotGit)) {
        let gitDir = dotGit;
        if (statSync(dotGit).isFile()) {
          const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, "utf8"));
          if (!m) return null;
          gitDir = isAbsolute(m[1]!) ? m[1]! : resolve(dir, m[1]!);
        }
        const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return ref ? ref[1]!.trim() : head.length > 0 ? "detached" : null;
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

/** Parse `git status --porcelain` output into OMP's indicator counts. Each
 *  line starts with XY: X = staged state, Y = worktree state; `??` = untracked.
 *  Pure — the caller owns the (cached) subprocess. */
export function parseGitStats(porcelain: string): GitStats {
  const stats: GitStats = { staged: 0, unstaged: 0, untracked: 0 };
  for (const line of porcelain.split("\n")) {
    if (line.length < 2) continue;
    const x = line[0]!;
    const y = line[1]!;
    if (x === "?" && y === "?") {
      stats.untracked++;
      continue;
    }
    if (x !== " " && x !== "?") stats.staged++;
    if (y !== " " && y !== "?") stats.unstaged++;
  }
  return stats;
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
    bottomBar: "none",
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
    bottomBar: "none",
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
    bottomBar: "left",
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
    bottomBar: "full",
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
    bottomBar: "full",
    // OMP's borderless is bottomBarGap:false — the bar sits flush under the
    // single prompt row.
    barGap: false,
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
    bottomBar: "left",
    barGap: true,
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
    bottomBar: "full",
    barGap: true,
    row: (c, text) => c.theme.accent("▐") + c.theme.fill(text) + c.theme.accent("▌"),
  },
  {
    id: "rail",
    label: "Accent Rail",
    description: "Filled one-row field anchored by a single accent rail",
    sideWidth: 1,
    padX: 1,
    bottomBar: "full",
    barGap: true,
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
  const c: ShapeCtx = { w, hidden: 0, theme, gutter: shape.gutter, data };
  const prompt = theme.text(truncateToWidth("Ask anything, edit files, run tools", Math.max(1, inner - shape.padX * 2 - 1), "…"));
  const text = padRow(inner, spaces(shape.padX) + prompt + theme.inverse(" "));
  const lines: string[] = [];
  const top = shape.top?.(c);
  if (top !== undefined && top !== "") lines.push(top);
  lines.push(shape.row(c, text, { first: true, isLast: true }));
  const bottom = shape.bottom?.(c);
  if (bottom !== undefined) lines.push(bottom);
  if (shape.bottomBar && shape.bottomBar !== "none") {
    const bar = bottomBar(c, shape.bottomBar);
    if (bar) {
      if (shape.barGap) lines.push("");
      lines.push(bar);
    }
  }
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
      const c: ShapeCtx = { w: width, hidden: this.hiddenLines(), theme, gutter: shape.gutter, data: this.safeData(), spinner };

      const out: string[] = [];
      // OMP's Generation Rate placement: right-justified line above the shape's
      // own chrome (blank until the first response, so the layout never shifts).
      const rate = rateLine(c.data, theme, width);
      if (rate) out.push(rate);
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
      // OMP's standalone bottom status bar (claude/rule: left group only;
      // pi/borderless/field/rail: full), after its spacer row when the shape
      // has no bottom chrome. Hidden while the autocomplete menu is up — the
      // menu yields rows instead (OMP's autocomplete probe).
      if (shape.bottomBar && shape.bottomBar !== "none" && acH === 0) {
        const bar = bottomBar(c, shape.bottomBar);
        if (bar) {
          if (shape.barGap) out.push("");
          out.push(bar);
        }
      }
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
