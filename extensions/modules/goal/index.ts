// ceulen-goal — autonomous goal mode for Pi (OMP/Codex self-continuation).
//
// /goal <objective> sets a session goal; after every settled turn the module
// re-injects a continuation prompt (objective + budget + OMP's completion
// audit) until the agent calls goal({op:"complete"}) with verified evidence,
// the token budget flips (one wrap-up turn), the turn cap hits, or the user
// pauses/clears. The safety surface is UNCHANGED: goal mode never bypasses
// plan-mode gates or bash approvals — it only keeps the agent working.
//
// // ponytail: ported from oh-my-pi packages/coding-agent/src/goals (runtime,
// prompts) + @bacnh85/pi-plan commands/goal.ts lineage, trimmed to pi's
// public extension API. Deliberate deviations from OMP (enumerated):
// - Budget wrap-up is a FOLLOW-UP TURN (triggerTurn:true), not OMP's
//   deliverAs:"steer": OMP folds usage mid-turn (loop live, steer consumed);
//   pi folds at turn boundaries where no loop can consume a steer — a
//   non-triggering steer would strand the wrap-up forever (advisor-found).
// - Lifecycle ops (create/pause/resume/drop) live on the /goal command; the
//   `goal` tool carries only get/complete — the USER owns lifecycle, the
//   AGENT owns completion reporting.
// - No OMP todo-coupling (goalOpenWorkAllBlocked): ceulen's todo is
//   phase-granular; the turn cap bounds any blocked-phase spin.
// - No RPC/interactive continuation-mode split: one path, gated only by
//   plan-mode mutual exclusion and the pause/abort rules.
//
// The `goal` tool is DIRECT, never deferred (munin-loop lesson: a protocol's
// terminal action must stay in the live schema across plan baselines and
// branch restores). Plan mode blocks it via plan-tools.ts BLOCKED_TOOLS.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { isPlanActive } from "../../lib/plan-bridge.js";
import { readGoalSettings } from "./lib/settings.js";
import {
  activePrompt,
  applyUsage,
  budgetError,
  budgetLimitPrompt,
  completionBudgetReport,
  continuationPrompt,
  goalTokenDelta,
  shouldContinue,
  statusLine,
  type GoalState,
  type UsageLike,
  type UsageSnapshot,
} from "./lib/state.js";

const GOAL_ENTRY = "ceulen-goal"; // state snapshots (appendEntry data, no renderer)
const GOAL_STATUS_KEY = "ceulen-goal";
const GOAL_REPORT_TYPE = "ceulen-goal-report"; // display entry (achieved/stopped)
const CONTINUE_TYPE = "ceulen-goal-continue"; // hidden continuation turn
const BUDGET_TYPE = "ceulen-goal-budget"; // hidden wrap-up turn

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function defaultMaxTurns(): number {
  return readGoalSettings().maxTurns;
}

export function defaultBudget(): number | undefined {
  return readGoalSettings().defaultBudget;
}

/**
 * Goal module factory. All state is module-scoped (one session = one goal);
 * persistence rides pi.appendEntry (branch-scoped, todo/plan pattern) and
 * rehydrates PAUSED on session_start — an unattended loop never resumes by
 * itself after a process restart.
 */
export default function goalModule(pi: ExtensionAPI): void {
  let goal: GoalState | undefined;
  // Usage accounting: lastSeenUsage is the last assistant usage snapshot seen
  // (goal or not). Billing: with a pre-goal baseline, only the post-goal delta
  // counts (goal set mid-run); with none (fresh session), the full snapshot
  // bills — the goal fired this session's first run, so all of it is goal work.
  let lastSeenUsage: UsageSnapshot | undefined;
  let lastAccountedAt = 0;
  let pendingDelta = 0;
  // One wrap-up turn per goal: reset on create/resume/budget-raise/clear.
  let budgetReported = false;

  const setStatus = (ctx?: Pick<ExtensionContext, "ui">): void => {
    try {
      const text =
        goal && goal.status !== "complete" && goal.status !== "stopped"
          ? `🎯 ${truncate(goal.objective, 30)} · turn ${goal.turns}/${goal.maxTurns}${
              goal.tokenBudget !== undefined
                ? ` · ${Math.min(100, Math.floor((goal.tokensUsed / goal.tokenBudget) * 100))}%`
                : ""
            }`
          : undefined;
      ctx?.ui.setStatus(GOAL_STATUS_KEY, text);
    } catch {
      /* headless ui — statuses are cosmetic */
    }
  };

  const commit = (next: GoalState | undefined, ctx?: Pick<ExtensionContext, "ui">): void => {
    goal = next;
    if (next) pi.appendEntry(GOAL_ENTRY, next);
    setStatus(ctx);
  };

  const notify = (ctx: Pick<ExtensionContext, "ui">, message: string, level: "info" | "warning" | "error" = "info"): void => {
    try {
      ctx.ui.notify(message, level);
    } catch {
      /* headless */
    }
  };

  // ---------- lifecycle helpers shared by command and tool ----------

  const parseBudgetFlag = (text: string): { objective: string; budget?: number; error?: string } => {
    const match = text.match(/\s--budget[=\s](\d+)(?=\s|$)/);
    if (!match) {
      const bad = text.match(/\s--budget(?:[=\s]\S+)?/);
      return bad
        ? { objective: text.replace(bad[0], " ").trim(), error: `Invalid --budget value: ${bad[0].trim()} (positive integer expected)` }
        : { objective: text.trim() };
    }
    const budget = Number.parseInt(match[1], 10);
    const objective = text.replace(match[0], " ").trim();
    return { objective, budget };
  };

  const setGoal = (rawArgs: string, ctx: ExtensionContext): void => {
    const { objective, budget, error } = parseBudgetFlag(rawArgs);
    if (error) {
      notify(ctx, `Goal not set — ${error}`, "error");
      return;
    }
    if (!objective) {
      showStatus(ctx);
      return;
    }
    if (isPlanActive()) {
      notify(ctx, "Exit plan mode before setting a goal (run /plan).", "warning");
      return;
    }
    if (goal && goal.status !== "complete" && goal.status !== "stopped") {
      notify(ctx, `A goal is already ${goal.status}: ${goal.objective}. /goal clear first to replace it.`, "warning");
      return;
    }
    const db = defaultBudget() ?? 0;
    const effectiveBudget = budget ?? (db > 0 ? db : undefined); // 0 = unbounded default
    const bErr = budgetError(effectiveBudget);
    if (bErr) {
      notify(ctx, `Goal not set — ${bErr}`, "error");
      return;
    }
    const now = Date.now();
    const next: GoalState = {
      objective, // stored RAW; prompt renderers escape at render time
      status: "active",
      tokenBudget: effectiveBudget,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      turns: 0,
      maxTurns: defaultMaxTurns(),
      startedAt: now,
    };
    lastAccountedAt = now;
    budgetReported = false;
    commit(next, ctx);
    notify(ctx, `Goal set: ${objective} (cap ${next.maxTurns} turns${next.tokenBudget !== undefined ? `, budget ${next.tokenBudget} tokens` : ", unbounded"})`);
    void pi.sendUserMessage(objective, { deliverAs: "followUp" });
  };

  const showStatus = (ctx: Pick<ExtensionContext, "ui">): void => {
    if (!goal) {
      notify(ctx, "No goal set. Use /goal <objective>.");
      return;
    }
    notify(ctx, statusLine(goal));
  };

  const pauseGoal = (ctx: ExtensionContext, reason?: string): void => {
    if (!goal || goal.status === "complete" || goal.status === "stopped") {
      notify(ctx, "No active goal to pause.");
      return;
    }
    if (goal.status === "paused") {
      notify(ctx, "Goal is already paused.");
      return;
    }
    goal.status = "paused";
    if (reason) goal.lastReason = reason;
    commit(goal, ctx);
    notify(ctx, `Goal paused${reason ? ` (${reason})` : ""}. /goal resume to continue.`);
  };

  const resumeGoal = (ctx: ExtensionContext): void => {
    if (!goal) {
      notify(ctx, "No goal to resume.");
      return;
    }
    if (goal.status === "complete") {
      notify(ctx, "Goal is already complete.");
      return;
    }
    if (goal.status === "active" || goal.status === "budget-limited") {
      notify(ctx, "Goal is already running.");
      return;
    }
    goal.status = "active";
    goal.lastReason = undefined;
    budgetReported = false;
    lastAccountedAt = Date.now();
    commit(goal, ctx);
    notify(ctx, `Goal resumed: ${goal.objective}`);
    void pi.sendMessage(
      { customType: CONTINUE_TYPE, content: continuationPrompt(goal), display: false },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  const clearGoal = (ctx: ExtensionContext): void => {
    if (!goal) {
      notify(ctx, "No goal set.");
      return;
    }
    const was = truncate(goal.objective, 60);
    // Terminal tombstone: the LAST ceulen-goal entry must never be an
    // "active" snapshot, or a restart would resurrect a cleared goal.
    pi.appendEntry(GOAL_ENTRY, { ...goal, status: "stopped" });
    commit(undefined, ctx);
    notify(ctx, `Goal cleared: ${was}`);
  };

  const mutateBudget = (args: string, ctx: ExtensionContext): void => {
    if (!goal || goal.status === "complete" || goal.status === "stopped") {
      notify(ctx, "No live goal to budget.");
      return;
    }
    const value = args.trim().toLowerCase();
    if (value === "off" || value === "none") {
      goal.tokenBudget = undefined;
      if (goal.status === "budget-limited") goal.status = "active";
      budgetReported = false;
      commit(goal, ctx);
      notify(ctx, "Goal budget removed (unbounded).");
      return;
    }
    const budget = Number.parseInt(value, 10);
    const err = budgetError(budget) ?? (String(budget) !== value ? "goal token budget must be a positive integer when provided" : undefined);
    if (err) {
      notify(ctx, err, "error");
      return;
    }
    goal.tokenBudget = budget;
    // OMP onBudgetMutated semantics, both directions:
    // set a budget already exceeded → budget-limited NOW (+ the one wrap-up
    // turn); raise above usage → back to active.
    if (goal.status === "active" && goal.tokensUsed >= budget) {
      goal.status = "budget-limited";
      if (!budgetReported) {
        budgetReported = true;
        try {
          pi.sendMessage(
            { customType: BUDGET_TYPE, content: budgetLimitPrompt(goal), display: false },
            { triggerTurn: true, deliverAs: "followUp" },
          );
        } catch {
          /* fire-and-forget */
        }
      }
    } else if (goal.status === "budget-limited" && goal.tokensUsed < budget) {
      goal.status = "active";
      budgetReported = false;
      lastAccountedAt = Date.now();
    }
    commit(goal, ctx);
    notify(ctx, `Goal budget set to ${budget} (${goal.tokensUsed.toLocaleString()} used).`);
  };

  // ---------- /goal command ----------

  pi.registerCommand("goal", {
    description: "Autonomous goal mode: /goal <objective> [--budget N] | status | pause | resume | clear | budget <N|off>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [first, ...rest] = trimmed.split(/\s+/);
      const lower = (first ?? "").toLowerCase();
      if (!trimmed || lower === "status") {
        showStatus(ctx);
        return;
      }
      if (lower === "pause") return pauseGoal(ctx);
      if (lower === "resume") return resumeGoal(ctx);
      if (lower === "clear" || lower === "stop" || lower === "off" || lower === "cancel") return clearGoal(ctx);
      if (lower === "budget") return mutateBudget(rest.join(" "), ctx);
      if (lower === "help") {
        notify(
          ctx,
          "/goal <objective> [--budget N] · /goal status · /goal pause · /goal resume · /goal clear · /goal budget <N|off>",
        );
        return;
      }
      setGoal(trimmed, ctx);
    },
  });

  // ---------- goal tool (DIRECT — never deferred; munin-loop lesson) ----------

  pi.registerTool({
    name: "goal",
    label: "Goal",
    description:
      'Report on the active goal. op:"get" returns goal + budget state; op:"complete" ends the autonomous loop — call it ONLY when current repo state (files read, commands run, tests passed) directly proves every deliverable of the objective. Budget exhaustion is NOT completion.',
    promptSnippet: 'Report goal progress (get) or verified completion (complete) for the active goal.',
    promptGuidelines: [
      'Call goal({op:"complete"}) only with direct current-state evidence for EVERY deliverable — a bare claim of done is not evidence.',
      "Budget exhaustion ≠ completion: with unfinished work, keep working and leave the goal active.",
    ],
    parameters: Type.Object({
      op: Type.Union([Type.Literal("get"), Type.Literal("complete")], {
        description: '"get" = current goal/budget state; "complete" = verified completion, ends the loop.',
      }),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!goal || goal.status === "stopped") {
        return {
          content: [{ type: "text", text: "No active goal." }],
          details: { goal: null },
          isError: true,
        };
      }
      if (params.op === "get") {
        return {
          content: [{ type: "text", text: statusLine(goal) }],
          details: { goal },
        };
      }
      // op === "complete"
      if (goal.status === "paused") {
        return {
          content: [{ type: "text", text: "Goal is paused — call goal({op:\"get\"}) and continue working, or wait for the user to resume." }],
          details: { goal },
          isError: true,
        };
      }
      if (goal.status === "complete") {
        return {
          content: [{ type: "text", text: "Goal is already complete." }],
          details: { goal },
          isError: true,
        };
      }
      const done: GoalState = { ...goal, status: "complete" };
      const report = `Goal achieved: ${done.objective} · ${done.turns} turn(s) · ${done.tokensUsed.toLocaleString()} tokens`;
      pi.appendEntry(GOAL_ENTRY, done); // terminal tombstone — no restart resurrection
      commit(undefined, ctx);
      budgetReported = false;
      try {
        pi.sendMessage({
          customType: GOAL_REPORT_TYPE,
          content: report,
          display: true,
          details: done,
        });
        ctx.ui.notify(`✓ ${report}`, "info");
      } catch {
        /* headless — the tool result still reports */
      }
      const budgetReport = completionBudgetReport(done);
      return {
        content: [
          {
            type: "text",
            text: budgetReport
              ? `${report}\n${budgetReport}`
              : `${report}\nGoal mode ended — report completion to the user in your final answer.`,
          },
        ],
        details: { goal: done },
      };
    },
    renderResult: (result, options, theme) => {
      if (options.isPartial || !result) return new Text("", 0, 0);
      const isError = "isError" in result && result.isError;
      const text = result.content.find((c) => c.type === "text");
      const body = text && "text" in text ? text.text : "";
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const first = body.split("\n")[0] ?? "";
      return new Text(`${icon} ${first}`, 0, 0);
    },
  });

  // ---------- display renderer for the achieved/stopped report ----------

  pi.registerMessageRenderer?.(GOAL_REPORT_TYPE, (message, _opts, theme) => {
    const text = typeof message.content === "string" ? message.content : "Goal report";
    return new Text(theme.fg("success", `🎯 ${text}`), 0, 0);
  });

  // ---------- usage accounting ----------

  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; usage?: UsageLike };
    if (message.role !== "assistant" || !message.usage) return;
    const u = message.usage;
    const snap: UsageSnapshot = {
      input: u.input ?? 0,
      output: u.output ?? 0,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
    };
    const prior = lastSeenUsage;
    lastSeenUsage = snap;
    if (!goal || (goal.status !== "active" && goal.status !== "budget-limited")) return;
    // Billing baseline:
    // - prior snapshot exists (goal set mid-run or after earlier turns) → bill
    //   only the post-goal delta.
    // - no prior (fresh session, /goal fired the first run) → bill the full
    //   snapshot from a zero baseline: every token this session spent IS goal
    //   work (OMP bills turn-1 input the same way). Live-test finding
    //   2026-11-01: lazy-init here dropped the whole first turn (46K tok).
    if (goal.status === "active") {
      pendingDelta += prior
        ? goalTokenDelta(snap, prior)
        : Math.max(0, snap.input) + Math.max(0, snap.output) + Math.max(0, snap.cacheWrite);
    }
  });

  pi.on("turn_end", () => {
    if (!goal || (goal.status !== "active" && goal.status !== "budget-limited")) {
      pendingDelta = 0;
      return;
    }
    const now = Date.now();
    const wallSeconds = lastAccountedAt ? Math.max(0, Math.floor((now - lastAccountedAt) / 1000)) : 0;
    const delta = pendingDelta;
    pendingDelta = 0;
    if (delta <= 0 && wallSeconds <= 0) return;
    goal.timeUsedSeconds += wallSeconds;
    goal.lastReason = undefined;
    const flipped = applyUsage(goal, delta);
    if (lastAccountedAt) lastAccountedAt = now;
    if (flipped && !budgetReported) {
      budgetReported = true;
      // The wrap-up turn STARTS here: followUp + triggerTurn (never a steer —
      // at a turn boundary no live loop can consume one; advisor-found).
      try {
        pi.sendMessage(
          { customType: BUDGET_TYPE, content: budgetLimitPrompt(goal), display: false },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } catch {
        /* send is fire-and-forget; a throw must not abort usage folding */
      }
    }
    pi.appendEntry(GOAL_ENTRY, goal);
  });

  // ---------- the continuation loop ----------

  pi.on("agent_settled", (event, ctx) => {
    const verdict = shouldContinue(goal, { aborted: event.aborted, planActive: isPlanActive() });
    if (verdict === "none") return;
    if (verdict === "pause") {
      pauseGoal(ctx, event.aborted ? "run aborted" : "plan mode active");
      return;
    }
    if (verdict === "stop") {
      const reason = `turn cap ${goal!.maxTurns} reached`;
      if (goal) goal.lastReason = reason;
      goal = goal ? { ...goal, status: "stopped" } : undefined;
      if (goal) pi.appendEntry(GOAL_ENTRY, goal);
      setStatus(ctx);
      notify(ctx, `Goal stopped: ${reason}. ${goal?.objective ?? ""}`, "warning");
      return;
    }
    // continue — fire the next turn (cron's fire mechanism).
    try {
      const current = goal!;
      current.turns += 1;
      commit(current, ctx);
      try {
        pi.sendMessage(
          { customType: CONTINUE_TYPE, content: continuationPrompt(current), display: false },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } catch (e) {
        pauseGoal(ctx, `continuation failed: ${e instanceof Error ? e.message : e}`);
      }
    } catch (e) {
      pauseGoal(ctx, `continuation failed: ${e instanceof Error ? e.message : e}`);
    }
  });

  // ---------- system-prompt composer (append-only; BEFORE rules/steering) ----------

  pi.on("before_agent_start", (event) => {
    if (!goal || (goal.status !== "active" && goal.status !== "budget-limited")) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${activePrompt(goal)}` };
  });

  // ---------- rehydration ----------

  pi.on("session_start", (_event, ctx) => {
    try {
      const entries = ctx.sessionManager.getBranch() as unknown as
        | { type?: string; customType?: string; data?: GoalState }[]
        | undefined;
      if (!Array.isArray(entries)) return;
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry?.type !== "custom" || entry?.customType !== GOAL_ENTRY) continue;
        const saved = entry.data;
        if (!saved || typeof saved !== "object" || !saved.objective) break;
        // Safe default: an unattended loop NEVER resumes by itself after a
        // process restart — active/budget-limited goals come back paused.
        goal =
          saved.status === "active" || saved.status === "budget-limited"
            ? { ...saved, status: "paused", lastReason: "restored paused after restart" }
            : saved;
        lastSeenUsage = undefined;
        lastAccountedAt = 0;
        budgetReported = false;
        setStatus(ctx);
        if (goal.status === "paused") {
          notify(ctx, `Goal restored paused (run /goal resume): ${truncate(goal.objective, 60)}`);
        }
        break;
      }
    } catch {
      /* rehydration is best-effort */
    }
  });

  // test seam — module-scoped state introspection
  if ((process.env as Record<string, string | undefined>).CEULEN_GOAL_TEST === "1") {
    (pi as unknown as { __goalTest?: object }).__goalTest = {
      get: () => goal,
      set: (next: GoalState | undefined) => {
        goal = next;
      },
    };
  }
}
