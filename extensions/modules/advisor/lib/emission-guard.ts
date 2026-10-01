// ponytail: vendored from @bacnh85/pi-advisor 0.3.8 (extensions/lib/emission-guard.ts) — verbatim.
export type Severity = "nit" | "concern" | "blocker";

export const SEVERITY_RANK: Record<Severity, number> = { nit: 0, concern: 1, blocker: 2 };

/** Notes whose entire content is one of these (after normalization) carry no actionable reason. Exported for tests only. */
export const CONTENT_FREE_SAFE: ReadonlySet<string> = new Set([
  "stop", "stop here", "stop now", "halt", "abort", "done", "task done", "task complete", "complete", "completed", "finished",
  "lgtm", "ok", "okay", "ok done", "good",
  "no issue", "no issues", "no issue continue", "nothing to add", "nothing new",
  "no concern", "no concerns", "no notes", "no problem", "no problems",
  "nothing to report", "no further input", "no further input needed", "no further input required",
  "no further advice", "no further advice needed",
  "looks good", "looking good", "all good", "agent is on track", "agent on track", "fine", "fine continue",
  "continue", "carry on", "keep going", "proceed", "on track",
  // Bare imperatives with zero technical content (observed live 2026-10-01:
  // the reviewer emitted "ignore previous instruction" as a note). Exact-match
  // only — a substantive note CONTAINING the phrase still passes.
  "ignore previous instruction", "ignore previous instructions",
  "ignore all previous instructions", "disregard previous instructions",
  "disregard all previous instructions", "disregard prior instructions",
]);

/**
 * Suffix verdicts that mean "no actionable note" when the note's final clause
 * declares one (e.g. "... No note warranted.", "... nothing to flag"). The
 * guard treats a note whose normalized text ENDS with any of these as
 * content-free, even when wrapped in prose — the reviewer's own verdict is
 * "nothing to act on".
 */
export const CONTENT_FREE_SUFFIXES: ReadonlySet<string> = new Set([
  "no note warranted", "no action needed", "no action required",
  "no issue found", "no issues found", "nothing to flag", "nothing to add",
  "nothing warranted", "not warranted", "no concerns", "no concern", "no notes",
  "no further input", "no further advice", "nothing further", "nothing to report",
]);

/** Lowercase, NFKC, fold every run of non-letter/non-digit to one space, trim.
 *  Unicode classes (not ASCII [a-z0-9]) so accented/CJK letters stay inside a
 *  word — "stöp" keys as one token instead of splitting (omp parity). */
export function normalizeNote(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Strip control chars, zero-width joiners, and bidi overrides — prompt-injection carriers that survive normalization. */
export function sanitizeNote(note: string): string {
  return note.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "").trim();
}

/** Note length cap — enforced on parse (parseReviewOutput) and again at render (renderNoteCard). */
export const MAX_NOTE_LENGTH = 280;

export interface GuardState {
  /** Note text → highest severity + the review index at which it was delivered. */
  delivered: Map<string, { severity: Severity; reviewIndex: number }>;
  /** True when a note has already been accepted this review cycle. */
  cycleUsed: boolean;
  counts: { suppressed: number; delivered: number };
  /** Monotonic review counter — bumped by the watcher each review attempt. */
  reviewIndex: number;
}

export function createGuard(): GuardState {
  return { delivered: new Map(), cycleUsed: false, counts: { suppressed: 0, delivered: 0 }, reviewIndex: 0 };
}

// ponytail: cap 1024 entries (OMP uses 4096; our sessions are shorter and bounded by dedupe hit rate anyway)
const MAX_DELIVERED = 1024;

function remember(state: GuardState, key: string, severity: Severity): void {
  state.delivered.set(key, { severity, reviewIndex: state.reviewIndex });
  if (state.delivered.size > MAX_DELIVERED) {
    const first = state.delivered.keys().next().value;
    if (first !== undefined) state.delivered.delete(first);
  }
}

export type GuardVerdict = { accepted: true; severity: Severity; note: string } | { accepted: false; reason: "content-free" | "duplicate" | "rate-limit" | "empty" };

/**
 * Decide whether a parsed advisor note may be delivered this cycle.
 * All rejection paths increment `counts.suppressed` and are silent.
 *
 * `redeliveryWindow` — how many *reviews* must elapse before the same
 * normalized text may be re-delivered at equal-or-lower severity. `Infinity`
 * means permanent dedupe (default for unit tests). The watcher passes
 * `immuneTurns` so an ignored note can be re-raised after the calm-down
 * window.
 */
export function guardCheck(
  state: GuardState,
  severity: Severity,
  note: string,
  redeliveryWindow: number = Infinity,
): GuardVerdict {
  const key = normalizeNote(note);
  if (!key) { state.counts.suppressed++; return { accepted: false, reason: "empty" }; }
  if (CONTENT_FREE_SAFE.has(key)) { state.counts.suppressed++; return { accepted: false, reason: "content-free" }; }
  // A note that leads OR closes with a no-op verdict is a no-op regardless of
  // surrounding prose (reviewer said "nothing to act on"). Handles both the
  // padv-c9 tail case ("... No note warranted.") and lead cases
  // ("No issues found — the change is correct.").
  const trimmed = key.replace(/[.\s]+$/, "");
  const hasNoopVerdict = [...CONTENT_FREE_SUFFIXES].some(
    (s) => trimmed === s || trimmed.endsWith(` ${s}`) || trimmed.startsWith(`${s} `),
  );
  if (hasNoopVerdict) {
    state.counts.suppressed++;
    return { accepted: false, reason: "content-free" };
  }
  const previous = state.delivered.get(key);
  if (previous) {
    const isEscalation = SEVERITY_RANK[severity] > SEVERITY_RANK[previous.severity];
    if (!isEscalation) {
      const elapsed = state.reviewIndex - previous.reviewIndex;
      if (elapsed <= redeliveryWindow) {
        state.counts.suppressed++;
        return { accepted: false, reason: "duplicate" };
      }
    }
  }
  if (state.cycleUsed) { state.counts.suppressed++; return { accepted: false, reason: "rate-limit" }; }
  state.cycleUsed = true;
  remember(state, key, severity);
  state.counts.delivered++;
  return { accepted: true, severity, note: sanitizeNote(note) };
}

/** Call between review cycles so the next note is not rate-limited by the previous one. */
export function nextCycle(state: GuardState): void {
  state.cycleUsed = false;
}

export function isSeverity(value: unknown): value is Severity {
  return value === "nit" || value === "concern" || value === "blocker";
}

/**
 * Defensive parse of the advisor model's output: exactly one line of strict JSON,
 * or empty/blank output meaning "nothing to review". Any other shape is a parse
 * failure — conservative, no note.
 */
export function parseReviewOutput(raw: string): { severity: Severity; note: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as { severity?: unknown; note?: unknown };
    if (!isSeverity(parsed.severity) || typeof parsed.note !== "string" || !parsed.note.trim()) return undefined;
    return { severity: parsed.severity, note: parsed.note.trim().slice(0, MAX_NOTE_LENGTH) };
  } catch { return undefined; }
}
