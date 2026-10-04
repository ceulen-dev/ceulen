// todo widget — the themed above-editor HUD + shared board renderer (OMP look).
//
// Pattern: extensions/modules/subagent/lib/widget.ts (WidgetTheme shim, pure
// renderers, small controller owning the setWidget handle). Todo is simpler:
// no live subscription — the widget only changes on a tool mutation, so the
// controller re-renders on demand and carries the ALL-DONE LINGER timer
// (OMP parity: the completed board stays `lingerSecs` before auto-clearing).
//
// Visual language (matched to OMP's todo HUD, user-approved 2026-10-04;
// nested-tree + progress-spine per the 2026-10-04 side-by-side):
//   TODO
//    └─ Tasks · 2/5          head connector accents when ALL done
//       ├─ ☑ done-title      success + strikethrough (stays visible)
//       ├─ ☐ current-title   mdLink (blue = "current"), default fg title
//       └─ ☐ pending-title   dim
// The tree spine is OMP's progress path: a connector turns accent once its
// phase is done — the completed tree reads as one lit path. Blocked rows keep
// the warning treatment + `(blocked by …)` tail; ids and notes stay in dim
// tails. The LLM-facing text board (index.ts) is unchanged.
//
// Rendering uses theme tokens only (theme.fg/bold/strikethrough) — no raw ANSI.

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { effectiveStatus, TODO_WIDGET_KEY, type TodoPhase } from "../index.ts";

/** Theme shim so renderers are testable without a Theme instance. */
export interface WidgetTheme {
  fg(color: string, text: string): string;
  bold?(text: string): string;
  strikethrough?(text: string): string;
}

function c(theme: WidgetTheme | null | undefined, token: string, text: string): string {
  return theme?.fg ? theme.fg(token, text) : text;
}

// Tree-spine glyphs (OMP's renderTreeList shape, 1-column cells).
const SPINE_BRANCH = "├─ ";
const SPINE_LAST = "└─ ";
const SPINE_VERT = "│  ";
const SPINE_BLANK = "   ";

/** One nested child row's spine prefix (1-space gutter + 3-cell indent under
 *  the group head — OMP's tree geometry). */
const childSpine = (last: boolean): string => " " + SPINE_BLANK + (last ? SPINE_LAST : SPINE_BRANCH);

/** Checked/unchecked box for a phase. */
function box(st: "pending" | "in_progress" | "done" | "blocked"): string {
  return st === "done" ? "☑" : "☐";
}

/** One themed phase row. `spine` prefixes the row (tree connectors); `current`
 *  marks the in-progress phase (mdLink = OMP's blue "current"). */
function phaseRow(
  p: TodoPhase,
  phases: readonly TodoPhase[],
  theme: WidgetTheme | null | undefined,
  spine: string,
  current: boolean,
  width: number,
  /** OMP: notes collapse to a `+n` marker — full text lives in the tool result. */
  compact = false,
): string {
  const st = effectiveStatus(p, phases);
  const waiters = p.blockedBy.filter((dep) => phases.find((x) => x.id === dep)?.status !== "done");
  const title = st === "done" && theme?.strikethrough ? theme.strikethrough(p.title) : p.title;
  const noteCount = (p.notes ? 1 : 0) + (st === "blocked" && waiters.length > 0 ? 1 : 0);
  const tail = compact
    ? ""
    : (
        [
          st === "blocked" && waiters.length > 0 ? `blocked by ${waiters.join(", ")}` : undefined,
          p.notes,
        ]
          .filter(Boolean)
          .join(" — ")
      );
  const line =
    // OMP's progress path: the connector lights accent once its phase is done.
    c(theme, st === "done" ? "accent" : "dim", spine) +
    c(theme, st === "done" ? "success" : current ? "mdLink" : "dim", box(st)) +
    " " +
    c(theme, st === "done" ? "success" : current ? "mdLink" : st === "blocked" ? "warning" : "dim", title) +
    (tail ? c(theme, "dim", ` (${tail})`) : "") +
    (compact && noteCount > 0 ? c(theme, "dim", ` +${noteCount}`) : "");
  return line.length > width ? truncateToWidth(line, width) : line;
}

/**
 * The full board, one themed line per phase — the transcript renderResult
 * surface and the all-done widget view. Same OMP visual language as the
 * widget (tree spine, checkboxes); ids/notes ride the dim tails.
 */
export function renderTodoBoard(phases: readonly TodoPhase[], theme?: WidgetTheme | null, width = 100): string[] {
  if (phases.length === 0) return [c(theme, "dim", "Todo list is empty.")];
  const lines: string[] = [];
  for (const [i, p] of phases.entries()) {
    const last = i === phases.length - 1;
    const spine = childSpine(last);
    lines.push(phaseRow(p, phases, theme, spine, effectiveStatus(p, phases) === "in_progress", width));
  }
  return lines;
}

/** Phases shown around the active one in the HUD window. */
const WINDOW_OPEN = 5; // active phase + up to 4 following open phases (OMP's cap shape)

/**
 * The bounded HUD window (OMP look): `TODO` header, then the phase subtree —
 * `└─ Tasks · done/total` with done phases KEPT visible (green strikethrough),
 * the current phase in mdLink blue, pending muted, `+ n more phases` tail when
 * truncated. An all-done list renders every phase (the closure view).
 */
export function renderTodoWidgetLines(phases: readonly TodoPhase[], theme?: WidgetTheme | null, width = 100): string[] {
  if (phases.length === 0) return [];
  const done = phases.filter((p) => p.status === "done").length;
  const all = done === phases.length;
  const header =
    c(theme, "accent", theme?.bold ? theme.bold("TODO") : "TODO");

  // Subtree head: OMP's single root elbowing into its children (`└─`), the
  // connector accenting only when the whole path is complete. The group is
  // the whole list — ceulen phases are flat, so the label is fixed.
  const groupHead =
    " " +
    c(theme, all ? "accent" : "dim", SPINE_LAST) +
    c(theme, "mdLink", theme?.bold ? theme.bold("Tasks") : "Tasks") +
    c(theme, "dim", ` · ${done}/${phases.length}`) +
    (!all && phases.some((p) => effectiveStatus(p, phases) === "blocked") ? c(theme, "warning", " · blocked") : "");

  if (all) {
    const rows = phases.map((p, i) =>
      phaseRow(p, phases, theme, childSpine(i === phases.length - 1), false, width, true),
    );
    return [header, groupHead, ...rows];
  }

  // OMP parity: done rows STAY visible (green strikethrough). The window
  // slides to show the active phase with context: one done row above it (the
  // just-finished step) + the pending tail, capped at WINDOW_OPEN rows.
  const activeIdx = phases.findIndex((p) => effectiveStatus(p, phases) === "in_progress");
  const start = activeIdx === -1 ? 0 : Math.max(0, activeIdx - 1);
  const windowed = phases.slice(start, start + WINDOW_OPEN);
  const hidden = phases.length - windowed.length;
  const rows = windowed.map((p, i) =>
    phaseRow(p, phases, theme, childSpine(i === windowed.length - 1 && hidden === 0), effectiveStatus(p, phases) === "in_progress", width, true),
  );
  if (hidden > 0) rows.push(c(theme, "dim", `${childSpine(true)}+ ${hidden} more phase${hidden === 1 ? "" : "s"}`));
  return [header, groupHead, ...rows];
}

// ---------------------------------------------------------------------------
// Controller — owns the setWidget handle + the all-done linger timer
// ---------------------------------------------------------------------------

export interface WidgetUi {
  mode?: string;
  ui: ExtensionContext["ui"];
}

export interface TodoWidgetController {
  /** Install/refresh/clear per current phases. `lingerSecs`:
   *  >0 = seconds the all-done board stays, 0 = clear instantly, -1 = never auto-clear.
   *  `render` reads through `getPhases` so re-renders always draw CURRENT state —
   *  a captured array would freeze the board at the install-time snapshot. */
  sync(target: WidgetUi | undefined, phases: readonly TodoPhase[], lingerSecs: number, getPhases?: () => readonly TodoPhase[]): void;
  /** Remove the widget + cancel the timer (stale ctx tolerated). */
  clear(target?: WidgetUi): void;
  dispose(): void;
  /** Test seam: true while a linger timer is armed. */
  lingerArmed(): boolean;
}

export function createTodoWidgetController(): TodoWidgetController {
  let widgetCtx: ExtensionContext["ui"] | null = null;
  let requestWidgetRender: (() => void) | null = null;
  let widgetTheme: WidgetTheme | null = null;
  let lingerTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  /** Live view of the board — swapped by sync so the render closure never
   *  holds a stale snapshot. */
  let current: readonly TodoPhase[] = [];

  const stale = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      return undefined; // stale ctx after session replacement
    }
  };

  function cancelLinger(): void {
    generation += 1;
    if (lingerTimer) {
      clearTimeout(lingerTimer);
      lingerTimer = undefined;
    }
  }

  function removeWidget(): void {
    if (widgetCtx) {
      const ui = widgetCtx;
      stale(() => ui.setWidget(TODO_WIDGET_KEY, undefined));
      widgetCtx = null;
    }
    requestWidgetRender = null;
    widgetTheme = null;
  }

  return {
    sync(target, phases, lingerSecs, getPhases) {
      cancelLinger();
      current = getPhases ? getPhases() : phases;
      if (!target || target.mode !== "tui") return;
      const { ui } = target;
      if (phases.length === 0) {
        removeWidget();
        return;
      }
      const all = phases.every((p) => p.status === "done");
      if (all && lingerSecs === 0) {
        removeWidget();
        return;
      }
      if (widgetCtx) {
        requestWidgetRender?.();
      } else {
        stale(() =>
          ui.setWidget(TODO_WIDGET_KEY, (tui, theme) => {
            widgetTheme = theme as unknown as WidgetTheme;
            requestWidgetRender = () => tui.requestRender();
            return {
              render: (width: number) => renderTodoWidgetLines(current, widgetTheme, width),
              invalidate: () => requestWidgetRender?.(),
              dispose: () => {
                widgetTheme = null;
                requestWidgetRender = null;
              },
            };
          }),
        );
        widgetCtx = ui;
      }
      if (all && lingerSecs >= 0) {
        const gen = generation;
        lingerTimer = setTimeout(() => {
          if (gen !== generation) return; // a newer sync canceled this arm
          lingerTimer = undefined;
          removeWidget();
        }, lingerSecs * 1000);
        lingerTimer.unref?.();
      }
    },

    clear(target) {
      cancelLinger();
      if (target?.ui && target.ui !== widgetCtx) {
        stale(() => target.ui.setWidget(TODO_WIDGET_KEY, undefined));
      }
      removeWidget();
    },

    dispose() {
      cancelLinger();
      removeWidget();
    },

    lingerArmed: () => lingerTimer !== undefined,
  };
}
