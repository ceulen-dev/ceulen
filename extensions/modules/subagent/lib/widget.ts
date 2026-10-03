// ponytail: vendored from @bacnh85/pi-subagent 0.23.2 (extensions/widget.ts).
// ceulen delta: widget key ceulen-subagent (conflict rule: status keys take the ceulen- prefix).
/**
 * Live progress widget for pi-subagent.
 *
 * A persistent above-editor widget that shows what each running subagent is
 * doing right now — spinner, agent, elapsed time, tool-call count, and the
 * latest tool call with done/error/in-progress status. Fed by the live
 * threadStore subscription (per SDK session event), NOT by JSONL polling.
 *
 * Mirrors pi-task's widget UX but cheaper: we have in-process live events.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Message } from "./types.ts";
import type { SubagentThread } from "./threads.ts";
import { formatToolCall, formatTokens, outputSnippet } from "./render.ts";

// ---------------------------------------------------------------------------
// Footer status (OMP-parity running count)
// ---------------------------------------------------------------------------

/** The subagent module's setStatus key — shows in pi's native footer and the
 *  composer footer (which passes every extension status through). */
export const SUBAGENT_STATUS_KEY = "ceulen-subagent";

/** Pure footer text for a thread set: `👥 2 running · 1 done`, undefined when
 *  nothing is running (the status item is cleared). Tested directly. */
export function statusLine(threads: SubagentThread[]): string | undefined {
  const running = threads.filter((t) => t.status === "running").length;
  if (running === 0) return undefined;
  const done = threads.filter((t) => t.status === "completed").length;
  const failed = threads.length - running - done;
  return `👥 ${running} running${done > 0 ? ` · ${done} ✓` : ""}${failed > 0 ? ` · ${failed} ✗` : ""}`;
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 80;
const TREE_LAST = "└─"; // pi-task uses └─; keep consistent
const MAX_WIDTH = 120;
const MAX_THREADS = 8;

// ---------------------------------------------------------------------------
// Theme shim
// ---------------------------------------------------------------------------

export interface WidgetTheme {
  fg(color: string, text: string): string;
  bold?(text: string): string;
}

function color(theme: WidgetTheme | null | undefined, token: string, text: string): string {
  return theme?.fg ? theme.fg(token, text) : text;
}

function bold(theme: WidgetTheme | null | undefined, text: string): string {
  return theme?.bold ? theme.bold(text) : text;
}

// ---------------------------------------------------------------------------
// Elapsed formatting
// ---------------------------------------------------------------------------

export function formatMs(ms: number): string {
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1_000)}s`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

// ---------------------------------------------------------------------------
// Tool-call status derivation from the message stream
// ---------------------------------------------------------------------------

export type ToolStatus = "in_progress" | "done" | "error";

export interface RecentToolCall {
  name: string;
  detail: string;
  status: ToolStatus;
}

/**
 * Derive recent tool calls with status by pairing assistant toolCall parts
 * (carrying .id) against later toolResult messages (carrying toolCallId + isError).
 * Returns most-recent-last. Capped at `cap` entries.
 */
export function deriveRecentToolCalls(messages: Message[], cap = 5): RecentToolCall[] {
  // Map toolCallId -> isError for completed results.
  const resultsById = new Map<string, boolean>();
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      resultsById.set(msg.toolCallId, msg.isError);
    }
  }
  // Walk assistant messages, collect toolCall parts in order.
  const calls: RecentToolCall[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type !== "toolCall") continue;
      const isError = resultsById.get(part.id);
      const status: ToolStatus = isError === undefined ? "in_progress" : isError ? "error" : "done";
      calls.push({
        name: part.name,
        detail: formatToolCall(part.name, part.arguments ?? {}, (token, text) => text),
        status,
      });
    }
  }
  return calls.slice(-cap);
}

function countToolProgress(messages: Message[]): { toolCount: number; inFlight: number } {
  const resultIds = new Set(messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
  let toolCount = 0;
  let inFlight = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.content) {
      if (p.type !== "toolCall") continue;
      if (resultIds.has(p.id)) toolCount++;
      else inFlight++;
    }
  }
  return { toolCount, inFlight };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function statusMark(theme: WidgetTheme | null | undefined, status: ToolStatus, spinner: string): string {
  switch (status) {
    case "done": return color(theme, "success", "✓");
    case "error": return color(theme, "error", "✗");
    case "in_progress":
    default: return color(theme, "accent", spinner);
  }
}

/**
 * One-line live status for a running thread: spinner · Agent · elapsed ·
 * tools · latest tool call. Used by both the widget and the tool-call row.
 */
export function renderLiveThreadLine(
  thread: SubagentThread,
  theme: WidgetTheme | null | undefined,
  now: number,
  agentColor: string,
  maxCalls = 5,
): string {
  const agentName = thread.agentName.charAt(0).toUpperCase() + thread.agentName.slice(1);
  const elapsed = formatMs(now - thread.createdAt);
  const messages = thread.result?.messages ?? [];
  const { toolCount, inFlight } = countToolProgress(messages);
  const spinner = SPINNER_FRAMES[Math.floor(now / SPINNER_MS) % SPINNER_FRAMES.length]!;

  let line =
    color(theme, "accent", spinner) + " " +
    color(theme, agentColor, bold(theme, agentName)) +
    color(theme, "dim", " · ") +
    color(theme, "warning", elapsed);
  const parts: string[] = [];
  if (toolCount > 0) parts.push(`${toolCount} tool${toolCount > 1 ? "s" : ""}`);
  if (inFlight > 0) parts.push(`${inFlight} running`);
  // OMP-parity token counters — the SDK path accumulates usage per assistant
  // message, so partial results already carry it; herdr threads stay blank.
  const usage = thread.result?.usage;
  if (usage?.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage?.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (parts.length > 0) {
    line += color(theme, "dim", " · ") + color(theme, "muted", parts.join(", "));
  }

  // Recent tool calls (up to maxCalls) — list, most-recent-last.
  const recent = deriveRecentToolCalls(messages, maxCalls);
  const hidden = Math.max(0, toolCount + inFlight - recent.length);
  if (hidden > 0 && recent.length >= maxCalls) {
    line += "\n  " + color(theme, "dim", `+${hidden} earlier`);
  }
  for (const call of recent) {
    line += "\n  " +
      color(theme, "dim", TREE_LAST) + " " +
      statusMark(theme, call.status, spinner) + " " +
      call.detail;
  }
  // Herdr panes carry no SDK messages — their lifecycle state ("herdr: working"
  // etc.) is the only activity signal; show it where tool calls would go.
  // SDK event-type labels ("message_end", …) are noise: the tool-call lines
  // above already carry the child's real activity.
  if (recent.length === 0 && thread.lastActivityLabel?.startsWith("herdr:")) {
    line += "\n  " + color(theme, "dim", TREE_LAST) + " " + color(theme, "muted", thread.lastActivityLabel);
  }
  return line;
}

// ---------------------------------------------------------------------------
// Wait tree — OMP-parity "waiting on N of M jobs" live view
// ---------------------------------------------------------------------------

/**
 * OMP-style job tree for operation:"wait"/"status" tool calls: a header with
 * running/done counts, one live line per running thread (waited task first),
 * then ✓ done rows. Pure — tested directly; renderCall feeds it threadStore.
 */
export function renderWaitTree(params: {
  taskId?: string;
  /** Thread id of the waited background task — sorted to the front. */
  focusThreadId?: string;
  threads: SubagentThread[];
  width: number;
  theme?: WidgetTheme | null;
  now?: number;
}): string[] {
  const { threads, width, theme } = params;
  const now = params.now ?? Date.now();
  const maxWidth = Math.min(width, MAX_WIDTH);
  const done = threads.filter((t) => t.status !== "running");
  const running = threads.filter((t) => t.status === "running");
  // Waited task reads first (OMP lists the awaited jobs up top).
  const ordered = params.focusThreadId
    ? [...running].sort((a, b) => (a.id === params.focusThreadId ? -1 : b.id === params.focusThreadId ? 1 : 0))
    : running;

  const head = threads.length === 0
    ? color(theme, "accent", `⏳ waiting on task ${params.taskId ?? "..."}`)
    : running.length === 0
      ? settledHead(theme, done)
      : color(theme, "accent", `⏳ waiting on ${running.length} of ${threads.length} jobs`) +
        settledCounts(theme, done);
  const lines = [truncateToWidth(head, maxWidth)];

  for (const thread of ordered.slice(0, MAX_THREADS)) {
    lines.push(truncateToWidth(renderLiveThreadLine(thread, theme, now, thread.color ?? "accent").split("\n")[0]!, maxWidth));
  }
  const hiddenRunning = running.length - Math.min(ordered.length, MAX_THREADS);
  if (hiddenRunning > 0) {
    lines.push(truncateToWidth(color(theme, "dim", `+ ${hiddenRunning} more running`), maxWidth));
  }
  for (const thread of done.slice(0, MAX_THREADS)) {
    const failed = thread.status !== "completed";
    const mark = failed ? color(theme, "error", "✗") : color(theme, "success", "✓");
    const elapsed = formatMs((thread.result as { durationMs?: number } | undefined)?.durationMs ?? thread.updatedAt - thread.createdAt);
    const name = thread.agentName.charAt(0).toUpperCase() + thread.agentName.slice(1);
    lines.push(truncateToWidth(
      `  ${mark} ${color(theme, thread.color ?? "muted", name)}${color(theme, "dim", ` · ${elapsed}`)}`,
      maxWidth,
    ));
    // OMP parity: the settled job's opening output line sits under its row.
    const snippet = thread.result ? outputSnippet(thread.result.messages) : undefined;
    if (snippet) {
      lines.push(truncateToWidth(color(theme, "dim", `     ⎿ ${snippet}`), maxWidth));
    }
  }
  lines.push(truncateToWidth(color(theme, "dim", "/agent to inspect · /subagent history"), maxWidth));
  return lines;
}

/** `1 done` / `1 done · 1 ✗` — failed threads are never counted as done. */
function settledCounts(theme: WidgetTheme | null | undefined, settled: SubagentThread[]): string {
  const done = settled.filter((t) => t.status === "completed").length;
  const failed = settled.length - done;
  return (done > 0 ? color(theme, "success", ` ${done} done`) : "") +
    (failed > 0 ? color(theme, "error", ` ${failed} ✗`) : "");
}

/** All-settled header for the wait tree. */
function settledHead(theme: WidgetTheme | null | undefined, settled: SubagentThread[]): string {
  const marks = `✓ ${settled.length} job${settled.length === 1 ? "" : "s"} settled`;
  return settled.every((t) => t.status === "completed")
    ? color(theme, "success", marks)
    : color(theme, "warning", marks);
}

function renderThread(
  thread: SubagentThread,
  now: number,
  maxWidth: number,
  theme: WidgetTheme | null | undefined,
): string[] {
  const lines: string[] = [];
  const agentColor = thread.color ?? "accent";

  // Header: spinner · Agent · elapsed · tools — then task preview.
  const base = renderLiveThreadLine(thread, theme, now, agentColor).split("\n")[0] ?? "";
  const taskPreview = thread.task.length > 40 ? `${thread.task.slice(0, 37)}...` : thread.task;
  const header = base + (thread.task ? color(theme, "dim", ` — ${taskPreview}`) : "");
  lines.push(truncateToWidth(header, maxWidth));

  // Latest tool call line (from the shared live-line renderer).
  const full = renderLiveThreadLine(thread, theme, now, agentColor).split("\n");
  if (full.length > 1) {
    lines.push(truncateToWidth(full[1]!, maxWidth));
  }
  return lines;
}

/**
 * Render the full widget for a set of threads.
 * Pure function — takes state, returns lines. No side effects.
 */
export function renderTaskWidget(params: {
  threads: SubagentThread[];
  width: number;
  theme?: WidgetTheme | null;
  now?: number;
}): string[] {
  const { threads, width, theme } = params;
  // Only running threads appear in the live widget.
  const running = threads.filter((t) => t.status === "running");
  if (running.length === 0) return [];

  const now = params.now ?? Date.now();
  const maxWidth = Math.min(width, MAX_WIDTH);

  const lines: string[] = [];
  // OMP-parity header: section title + running/done/failed counts.
  const doneCount = threads.filter((t) => t.status === "completed").length;
  const failedCount = threads.length - running.length - doneCount;
  lines.push(truncateToWidth(
    color(theme, "muted", bold(theme, "Subagents")) +
    color(theme, "dim", ` · ${running.length} running`) +
    (doneCount > 0 ? color(theme, "success", ` · ${doneCount} ✓`) : "") +
    (failedCount > 0 ? color(theme, "error", ` · ${failedCount} ✗`) : ""),
    maxWidth,
  ));
  const shown = running.slice(0, MAX_THREADS);
  for (const thread of shown) {
    lines.push(...renderThread(thread, now, maxWidth, theme));
    lines.push(""); // breathing room between threads
  }
  const hidden = running.length - shown.length;
  if (hidden > 0) {
    lines.push(truncateToWidth(color(theme, "dim", `+ ${hidden} more running`), maxWidth));
    lines.push("");
  }
  lines.push(truncateToWidth(color(theme, "dim", "/agent to inspect"), maxWidth));
  return lines;
}

// ---------------------------------------------------------------------------
// Controller — owns the setWidget handle + threadStore subscription
// ---------------------------------------------------------------------------

export interface TaskWidgetController {
  ensureWidget(ctx: ExtensionContext): void;
  requestRender(): void;
  /** Pass a fresh ctx on session replacement so the footer status clears even
   *  when the widget's own ctx is stale. */
  clearWidgetIfIdle(ctx?: ExtensionContext): void;
  dispose(): void;
}

export function createTaskWidgetController(
  getThreads: () => SubagentThread[],
  subscribe?: (listener: () => void) => () => void,
): TaskWidgetController {
  let widgetCtx: ExtensionContext | null = null;
  let requestWidgetRender: (() => void) | null = null;
  let widgetTheme: WidgetTheme | null = null;
  let unsubscribe: (() => void) | null = null;

  /** Footer status item — set while any thread runs, cleared when none do.
   *  Uses the last live ctx (stale ctx post-replacement is swallowed). */
  const syncStatus = (ctx: ExtensionContext | null): void => {
    if (!ctx) return;
    const plain = statusLine(getThreads());
    ignoreStaleExtensionCtx(() =>
      ctx.ui.setStatus(SUBAGENT_STATUS_KEY, plain ? (widgetTheme?.fg("warning", plain) ?? plain) : undefined),
    );
  };

  // On every threadStore change: re-render if running threads exist,
  // else clear the widget. This is the live-data path — no polling.
  const onStoreChange = (): void => {
    const running = getThreads().some((t) => t.status === "running");
    syncStatus(widgetCtx);
    if (running) {
      if (widgetCtx) requestRender();
    } else {
      clearWidgetIfIdle();
    }
  };

  function renderWidget(width: number): string[] {
    return renderTaskWidget({ threads: getThreads(), width, theme: widgetTheme });
  }

  function requestRender(): void {
    requestWidgetRender?.();
  }

  /**
   * Lazily install the widget + subscription on the first running thread.
   * Idempotent — safe to call on every thread creation.
   */
  function ensureWidget(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    // Subscribe once so future threadStore changes drive renders + idle-clear.
    if (!unsubscribe && subscribe) {
      unsubscribe = subscribe(onStoreChange);
    }
    if (widgetCtx) {
      requestRender();
      return;
    }
    widgetCtx = ctx;
    ignoreStaleExtensionCtx(() =>
      ctx.ui.setWidget("ceulen-subagent", (tui, theme) => {
        widgetTheme = theme ?? null;
        requestWidgetRender = () => tui.requestRender();
        return {
          render: (width: number) => renderWidget(width),
          invalidate: requestWidgetRender,
          dispose: () => {
            widgetTheme = null;
            requestWidgetRender = null;
          },
        };
      }),
    );
    syncStatus(ctx);
    requestRender();
  }

  /** Clear the widget when no threads are running (called after task completion).
   *  The optional ctx lets session_start clear a status held by a stale ctx. */
  function clearWidgetIfIdle(ctx?: ExtensionContext): void {
    const running = getThreads().filter((t) => t.status === "running").length;
    if (running > 0) {
      requestRender();
      return;
    }
    syncStatus(ctx ?? widgetCtx);
    if (widgetCtx) {
      const ctx = widgetCtx;
      ignoreStaleExtensionCtx(() => ctx.ui.setWidget("ceulen-subagent", undefined));
      widgetCtx = null;
    }
    requestWidgetRender = null;
  }

  function dispose(): void {
    unsubscribe?.();
    unsubscribe = null;
    syncStatus(widgetCtx);
    if (widgetCtx) {
      const ctx = widgetCtx;
      ignoreStaleExtensionCtx(() => ctx.ui.setWidget("ceulen-subagent", undefined));
      widgetCtx = null;
    }
    widgetTheme = null;
    requestWidgetRender = null;
  }

  return { ensureWidget, requestRender, clearWidgetIfIdle, dispose };
}

/**
 * Wrap a ctx operation so a stale (post-replacement) ExtensionContext
 * doesn't crash. Mirrors pi-task's ignoreStaleExtensionCtx.
 * ponytail: minimal try/catch — the only failure mode is a replaced session.
 */
function ignoreStaleExtensionCtx<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
