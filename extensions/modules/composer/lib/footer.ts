/**
 * Composer footer — replaces pi's built-in footer WHERE the composer's status
 * band already carries the stock info. The band owns identity + context + the
 * session token stats + provider quota windows; this footer keeps only what
 * the band does NOT show: every other extension's `setStatus` items (plan
 * mode, rtk, serena, ux, accordion — kept for the later port).
 *
 * Shapes WITHOUT an embedded band (pi · borderless · field · rail) keep pi's
 * NATIVE footer — there the footer is the only place that info appears.
 *
 * Lifecycle: pi's `resetExtensionUI()` calls `setExtensionFooter(undefined)` on
 * session replacement (new/resume/fork/reload), so this re-arms on
 * `session_start` — the same contract the shape editor relies on.
 */

import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { formatCompact, type ShapeTheme } from "./shapes.ts";

/** Usage fields the totals read (structural — pi's Usage satisfies it). */
interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Session-entry slice the totals read (structural — pi's SessionEntry fits). */
interface EntryLike {
  type?: string;
  usage?: UsageLike | null;
  message?: { role?: string; usage?: UsageLike | null };
}

export interface SessionTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Cache-read share of the latest assistant prompt, when computable. */
  cacheHitRate?: number;
}

export const EMPTY_TOTALS: SessionTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Sum session usage exactly like pi's own footer: `usage` entries, assistant
 *  and toolResult messages, compaction/branch summaries. */
export function sessionTotals(entries: readonly EntryLike[]): SessionTotals {
  const t: SessionTotals = { ...EMPTY_TOTALS };
  for (const e of entries) {
    let u: UsageLike | null | undefined;
    if (e.type === "usage") u = e.usage;
    else if (e.type === "message" && (e.message?.role === "assistant" || e.message?.role === "toolResult")) u = e.message.usage;
    else if (e.type === "compaction" || e.type === "branch_summary") u = e.usage;
    if (!u) continue;
    t.input += num(u.input);
    t.output += num(u.output);
    t.cacheRead += num(u.cacheRead);
    t.cacheWrite += num(u.cacheWrite);
    if (e.type === "message" && e.message?.role === "assistant") {
      const prompt = num(u.input) + num(u.cacheRead) + num(u.cacheWrite);
      if (prompt > 0) t.cacheHitRate = (num(u.cacheRead) / prompt) * 100;
    }
  }
  return t;
}

/** Band token stats for line 1 (`↑1.9M ↓377k R69M CH99.7%` — cost stays
 *  /usage-only; "" before any usage). */
export function statsLine(t: SessionTotals): string {
  const parts: string[] = [];
  if (t.input) parts.push(`↑${formatCompact(t.input)}`);
  if (t.output) parts.push(`↓${formatCompact(t.output)}`);
  if (t.cacheRead) parts.push(`R${formatCompact(t.cacheRead)}`);
  if (t.cacheWrite) parts.push(`W${formatCompact(t.cacheWrite)}`);
  if (t.cacheHitRate !== undefined) parts.push(`CH${t.cacheHitRate.toFixed(1)}%`);
  return parts.join(" ");
}

/** One status string per line: control chars out, runs of spaces collapsed
 *  (pi's own sanitizeStatusText). */
const sanitize = (s: string) => s.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();

export interface ComposerFooterDeps {
  /** Extension status texts, already key-sorted by the caller. */
  statuses: () => readonly string[];
}

/** The replacement footer component: one line of extension statuses. */
export class ComposerFooter implements Component {
  private deps: ComposerFooterDeps;

  constructor(deps: ComposerFooterDeps) {
    this.deps = deps;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    try {
      const statuses = this.deps.statuses().map(sanitize).filter(Boolean).join("  ");
      if (statuses) lines.push(truncateToWidth(statuses, width, "…"));
    } catch {
      // A core surface must never take the frame down.
    }
    return lines;
  }

  invalidate(): void {
    // Reads live closures per render — nothing cached here.
  }

  dispose(): void {
    // No timers or subscriptions.
  }
}
