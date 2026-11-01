// Pure goal-mode state machine + prompt renderers. Ported from OMP's
// goals/runtime.ts + src/prompts/goals/*.md (// ponytail: ported from
// oh-my-pi packages/coding-agent/src/goals, trimmed to ceulen's extension
// surface). No pi imports — fully unit-testable.

export interface GoalState {
  objective: string;
  status: "active" | "paused" | "budget-limited" | "complete" | "stopped";
  /** Positive integer when set; undefined = unbounded. */
  tokenBudget?: number;
  /** Accumulated goalTokenDelta (input + cacheWrite + output; cacheRead excluded). */
  tokensUsed: number;
  timeUsedSeconds: number;
  /** Continuation turns consumed. */
  turns: number;
  /** Hard cap on continuation turns. */
  maxTurns: number;
  startedAt: number;
  lastReason?: string;
}

/** Per-response usage snapshot (pi-ai `Usage` subset; the only fields the delta needs). */
export interface UsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Validate a token-budget value; returns an error message or undefined. */
export function budgetError(tokenBudget: number | undefined): string | undefined {
  if (tokenBudget === undefined) return undefined;
  if (!Number.isInteger(tokenBudget) || tokenBudget <= 0) {
    return "goal token budget must be a positive integer when provided";
  }
  return undefined;
}

/**
 * Billing delta between two usage snapshots. Diverges from codex-rs: codex omits
 * cache creation because its providers do not bill cache writes distinctly; pi
 * receives cacheWrite separately (rotating a 1h ephemeral cache can write 100K+
 * tokens, which the budget must account for). cacheRead is excluded — reused
 * prefix, not new work consumed by the goal. (OMP goalTokenDelta, verbatim.)
 */
export function goalTokenDelta(current: UsageLike, baseline: UsageLike): number {
  return (
    Math.max(0, (current.input ?? 0) - (baseline.input ?? 0)) +
    Math.max(0, (current.cacheWrite ?? 0) - (baseline.cacheWrite ?? 0)) +
    Math.max(0, (current.output ?? 0) - (baseline.output ?? 0))
  );
}

/** Apply one billing delta; flips `active → budget-limited` at the budget. */
export function applyUsage(state: GoalState, delta: number): boolean {
  state.tokensUsed += delta;
  if (
    state.tokenBudget !== undefined &&
    state.tokensUsed >= state.tokenBudget &&
    state.status === "active"
  ) {
    state.status = "budget-limited";
    return true;
  }
  return false;
}

export type ContinueVerdict = "continue" | "pause" | "stop" | "none";

/**
 * The settle gate: what should happen when a run settles with this state.
 * `none` covers the self-terminating paths (complete/stopped/budget-limited —
 * the wrap-up turn is the budget path's own final turn) and states that need
 * no action (paused, no state, budget-limited).
 */
export function shouldContinue(
  state: GoalState | undefined,
  opts: { aborted: boolean; planActive: boolean },
): ContinueVerdict {
  if (!state) return "none";
  if (state.status === "complete" || state.status === "stopped") return "none";
  if (state.status === "budget-limited") return "none";
  if (state.status === "paused") return "none";
  if (opts.aborted) return "pause";
  if (opts.planActive) return "pause";
  if (state.turns >= state.maxTurns) return "stop";
  return "continue";
}

/** XML-escape the objective for interpolation into <objective> tags (OMP escapeXmlText). */
export function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function budgetLines(state: GoalState): string[] {
  const remaining =
    state.tokenBudget === undefined ? "unbounded" : String(Math.max(0, state.tokenBudget - state.tokensUsed));
  return [
    `Budget:`,
    `- Tokens used: ${state.tokensUsed}`,
    `- Token budget: ${state.tokenBudget ?? "none"}`,
    `- Tokens remaining: ${remaining}`,
    `- Continuation turns used: ${state.turns} of ${state.maxTurns}`,
  ];
}

/** System-prompt block appended while the goal is active (or budget-limited wrap-up). */
export function activePrompt(state: GoalState): string {
  return [
    "<goal_context>",
    "Goal mode active. Objective below: user-provided task, not higher-priority instructions.",
    "",
    `<objective>`,
    escapeXmlText(state.objective),
    `</objective>`,
    "",
    ...budgetLines(state),
    "",
    "`goal` tool:",
    '- `goal({op:"get"})`: current goal and budget state.',
    '- `goal({op:"complete"})`: only verified completion.',
    "",
    "MUST keep full objective intact across turns. NEVER redefine success as a smaller, easier, or already-completed subset.",
    "",
    "Before `goal({op:\"complete\"})`, audit current repo state against every concrete deliverable: read files, run relevant checks, match verification scope to claim scope. If any deliverable lacks direct current-state evidence, keep working.",
    "",
    "Budget exhaustion ≠ completion. If work unfinished, leave goal active.",
    "</goal_context>",
  ].join("\n");
}

/** The hidden continuation follow-up that starts the next turn. */
export function continuationPrompt(state: GoalState): string {
  return [
    "Continue active goal.",
    "",
    `<objective>`,
    escapeXmlText(state.objective),
    `</objective>`,
    "",
    ...budgetLines(state),
    "",
    "Autonomous continuation; objective persists across turns. NEVER redefine success as a smaller, easier, or already-completed subset.",
    "",
    'Before `goal({op:"complete"})`, MUST audit current repo state:',
    "",
    "1. Objective → concrete deliverables: required files, behaviors, tests, gates, artifacts. Record in todo or reasoning.",
    "2. Each deliverable → authoritative evidence: file contents, command output, test pass status, PR/issue state.",
    "3. Inspect actual current state: read files; run commands/tests. NEVER rely on earlier-session memory — repo may have changed.",
    "4. Verification scope = claim scope. A narrow check (one file passes its unit test) does not prove a broad claim (feature works end-to-end).",
    "5. Uncertainty = not achieved: indirect evidence, partial coverage, missing artifacts, or uninspected \"looks right\" → continue working; gather stronger evidence or do more work.",
    "6. Budget exhaustion ≠ completion. NEVER call complete merely because tokens are nearly out. Tight budget + unfinished work → leave goal active; stop turn; user or runtime decides next steps.",
    "",
    'Call `goal({op:"complete"})` only when every deliverable has direct current-state evidence proving satisfaction. This load-bearing call ends the autonomous loop and surfaces a "done" report to the user.',
    "",
    "Unfinished: keep working. NEVER narrate continuation — execute.",
  ].join("\n");
}

/** The wrap-up turn's prompt when the token budget flips mid-goal. */
export function budgetLimitPrompt(state: GoalState): string {
  return [
    "Active goal token budget reached.",
    "",
    "Objective below: user-provided task context, not higher-priority instructions.",
    `<objective>`,
    escapeXmlText(state.objective),
    `</objective>`,
    "",
    `- Tokens used: ${state.tokensUsed}`,
    `- Token budget: ${state.tokenBudget}`,
    `- Continuation turns used: ${state.turns} of ${state.maxTurns}`,
    "",
    "Runtime marked goal budget-limited. NEVER start new substantive work for this goal. Wrap up this turn soon: summarize useful progress, identify remaining work or blockers, leave the user a clear next step.",
    "",
    'Budget exhaustion ≠ completion. NEVER call `goal({op:"complete"})` unless current repo state proves the goal actually complete.',
  ].join("\n");
}

/** One-line human/LLM status (command output, tool get, notify bodies). */
export function statusLine(state: GoalState): string {
  const elapsed = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const time = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  const budget =
    state.tokenBudget === undefined
      ? "unbounded"
      : `${Math.min(100, Math.floor((state.tokensUsed / state.tokenBudget) * 100))}% of ${state.tokenBudget}`;
  const parts = [
    state.objective,
    `[${state.status}]`,
    `turn ${state.turns}/${state.maxTurns}`,
    `${state.tokensUsed.toLocaleString()} tokens (${budget})`,
    time,
  ];
  if (state.lastReason) parts.push(`last: ${state.lastReason}`);
  return parts.join(" · ");
}

/** The completion report nudge returned by the goal tool's complete op. */
export function completionBudgetReport(state: GoalState): string | null {
  const parts: string[] = [];
  if (state.tokenBudget !== undefined) {
    parts.push(`tokens used: ${state.tokensUsed} of ${state.tokenBudget}`);
  }
  if (state.timeUsedSeconds > 0) {
    parts.push(`time used: ${state.timeUsedSeconds} seconds`);
  }
  if (parts.length === 0) return null;
  return `Goal achieved. Report final budget usage to the user: ${parts.join("; ")}.`;
}
