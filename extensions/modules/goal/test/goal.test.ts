/**
 * goal module tests — the pure state machine, command parsing, the
 * continuation loop, budget flow, the goal tool, and rehydration.
 * Untyped harness stub: only the pi surface the module touches
 * (usage/ponytail/todo test tradition).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import goalModule, { defaultBudget, defaultMaxTurns } from "../index.ts";
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
} from "../lib/state.ts";

const fresh = (over: Partial<GoalState> = {}): GoalState => ({
  objective: "make the tests pass",
  status: "active",
  tokenBudget: undefined,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  turns: 0,
  maxTurns: 3,
  startedAt: Date.now(),
  ...over,
});

// ---------- pure state machine ----------

describe("goalTokenDelta", () => {
  it("sums positive input+cacheWrite+output deltas; cacheRead excluded; negatives clamp to 0", () => {
    assert.equal(
      goalTokenDelta(
        { input: 120, output: 40, cacheRead: 5000, cacheWrite: 30 },
        { input: 100, output: 10, cacheRead: 4000, cacheWrite: 10 },
      ),
      20 + 20 + 30,
    );
    // A compaction/shrink (input lower than baseline) never produces negative billing.
    assert.equal(goalTokenDelta({ input: 50, output: 0, cacheRead: 0, cacheWrite: 0 }, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }), 0);
  });
});

describe("applyUsage", () => {
  it("accumulates and flips active → budget-limited exactly at the budget", () => {
    const s = fresh({ tokenBudget: 100 });
    assert.equal(applyUsage(s, 60), false);
    assert.equal(applyUsage(s, 39), false);
    assert.equal(applyUsage(s, 1), true, "flip at >= budget");
    assert.equal(s.status, "budget-limited");
    assert.equal(s.tokensUsed, 100);
  });

  it("never flips when unbounded, and does not flip a paused goal", () => {
    const s = fresh();
    assert.equal(applyUsage(s, 10_000), false);
    const p = fresh({ status: "paused", tokenBudget: 10 });
    applyUsage(p, 500);
    assert.equal(p.status, "paused");
  });
});

describe("shouldContinue", () => {
  it("continues only for an active, non-aborted, non-plan, under-cap goal", () => {
    assert.equal(shouldContinue(fresh(), { aborted: false, planActive: false }), "continue");
    assert.equal(shouldContinue(fresh({ turns: 3, maxTurns: 3 }), { aborted: false, planActive: false }), "stop");
    assert.equal(shouldContinue(fresh(), { aborted: true, planActive: false }), "pause");
    assert.equal(shouldContinue(fresh(), { aborted: false, planActive: true }), "pause");
    assert.equal(shouldContinue(fresh({ status: "budget-limited" }), { aborted: false, planActive: false }), "none");
    assert.equal(shouldContinue(fresh({ status: "paused" }), { aborted: false, planActive: false }), "none");
    assert.equal(shouldContinue(fresh({ status: "complete" }), { aborted: false, planActive: false }), "none");
    assert.equal(shouldContinue(undefined, { aborted: false, planActive: false }), "none");
  });
});

describe("budget validation + completion report", () => {
  it("budgetError rejects non-positive-integers only", () => {
    assert.equal(budgetError(undefined), undefined);
    assert.equal(budgetError(1000), undefined);
    assert.match(budgetError(0)!, /positive integer/);
    assert.match(budgetError(-5)!, /positive integer/);
    assert.match(budgetError(1.5)!, /positive integer/);
  });

  it("completionBudgetReport mentions budget and time only when present", () => {
    assert.equal(completionBudgetReport(fresh()), null);
    const r = completionBudgetReport(fresh({ tokenBudget: 500, tokensUsed: 420, timeUsedSeconds: 90 }));
    assert.match(r!, /tokens used: 420 of 500/);
    assert.match(r!, /time used: 90 seconds/);
  });
});

// ---------- prompts ----------

describe("prompts", () => {
  it("escape XML-sensitive objective text at render time (raw state stays intact)", () => {
    const s = fresh({ objective: 'fix "a<b> & c' });
    const p = continuationPrompt(s);
    assert.ok(p.includes("&lt;b&gt;"), "objective must be escaped in the prompt");
    assert.ok(!p.includes("<b>"), "raw <b> must not appear");
    assert.equal(s.objective, 'fix "a<b> & c');
    assert.ok(activePrompt(s).includes("&quot;"));
  });

  it("continuation prompt carries the audit ladder and the no-narration rule", () => {
    const p = continuationPrompt(fresh({ tokenBudget: 9000, tokensUsed: 3000 }));
    for (const frag of [
      "Continue active goal.",
      "make the tests pass",
      "NEVER redefine success as a smaller",
      "Verification scope = claim scope",
      "Budget exhaustion ≠ completion",
      "NEVER narrate continuation — execute",
      "Tokens remaining: 6000",
    ]) {
      assert.ok(p.includes(frag), `missing: ${frag}`);
    }
  });

  it("budget-limit prompt forbids new work and completion", () => {
    const p = budgetLimitPrompt(fresh({ tokenBudget: 1000, tokensUsed: 1100 }));
    assert.ok(p.includes("NEVER start new substantive work"));
    assert.ok(p.includes("Tokens used: 1100"));
  });

  it("statusLine composes the readout", () => {
    const line = statusLine(fresh({ tokensUsed: 250, tokenBudget: 1000, turns: 2, maxTurns: 50 }));
    assert.match(line, /make the tests pass/);
    assert.match(line, /\[active\]/);
    assert.match(line, /turn 2\/50/);
    assert.match(line, /25% of 1000/);
  });
});

// ---------- module (harness) ----------

/** Module harness: captures the pi surface goal uses. Plan-bridge is module
 *  state — reset it through the real setter to keep the loop honest. */
async function createHarness() {
  const { setPlanActive } = await import("../../../lib/plan-bridge.ts");
  setPlanActive(false);
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/tmp/ceulen-goal-test-settings";

  const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> | void }>();
  const tools = new Map<string, any>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  let branchEntries: unknown[] = [];
  const statusCalls: Array<[string, string | undefined]> = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const sends: Array<{ msg: { customType: string; content: string; display?: boolean }; opts?: { triggerTurn?: boolean; deliverAs?: string } }> = [];
  const userSends: Array<{ content: string; opts?: { deliverAs?: string } }> = [];

  const ui = {
    notify: (m: string, level?: string) => {
      notifications.push({ message: m, level });
    },
    setStatus: (k: string, t: string | undefined) => {
      statusCalls.push([k, t]);
    },
  };
  const ctx: any = { ui, sessionManager: { getBranch: () => branchEntries } };

  const pi: any = {
    on: (n: string, h: any) => {
      events.set(n, h);
    },
    registerTool: (t: any) => {
      tools.set(t.name, t);
    },
    registerCommand: (n: string, o: any) => {
      commands.set(n, o);
    },
    registerMessageRenderer: undefined, // optional-chained in the module
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data });
    },
    sendMessage: (msg: any, opts?: any) => {
      sends.push({ msg, opts });
    },
    sendUserMessage: (content: string, opts?: any) => {
      userSends.push({ content, opts });
    },
  };
  goalModule(pi);

  const h = {
    events,
    commands,
    tools,
    entries,
    statusCalls,
    notifications,
    sends,
    userSends,
    ctx,
    setPlanActive,
    setBranch: (e: unknown[]) => {
      branchEntries = e;
    },
    command: (args: string) => commands.get("goal")!.handler(args, ctx),
    /** Fire the goal tool through the real execute() path. */
    tool: (params: Record<string, unknown>) => tools.get("goal").execute("t1", params, undefined, undefined, ctx),
    settle: (aborted = false) => events.get("agent_settled")!({ type: "agent_settled", aborted }, ctx),
    assistantEnd: (usage: Record<string, number>) =>
      events.get("message_end")!({ message: { role: "assistant", usage } }, ctx),
    turnEnd: () => events.get("turn_end")!({ type: "turn_end" }, ctx),
    restore() {
      if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    },
  };
  return h;
}

describe("goal command", () => {
  it("sets a goal, starts the first turn, and refuses a second / plan-mode set", async () => {
    const h = await createHarness();
    try {
      await h.command("make the tests pass --budget 12345");
      const [entry] = h.entries.filter((e) => e.customType === "ceulen-goal");
      assert.equal((entry.data as GoalState).status, "active");
      assert.equal((entry.data as GoalState).tokenBudget, 12345);
      assert.equal(h.userSends.length, 1, "the objective itself starts the first work turn");
      assert.equal(h.userSends[0].opts?.deliverAs, "followUp");

      await h.command("another objective");
      assert.match(h.notifications.at(-1)!.message, /already active/);

      h.setPlanActive(true);
      await h.command("third objective after clearing");
      assert.match(h.notifications.at(-1)!.message, /Exit plan mode/);
      assert.equal(h.entries.filter((e) => e.customType === "ceulen-goal").length, 1, "no state written");
    } finally {
      h.restore();
    }
  });

  it("pause/resume/clear round-trip; resume fires a continuation turn", async () => {
    const h = await createHarness();
    try {
      await h.command("ship it");
      await h.command("pause");
      assert.equal(lastState(h.entries)!.status, "paused");
      assert.equal(h.sends.length, 0, "pause sends nothing");

      await h.command("resume");
      assert.equal(lastState(h.entries)!.status, "active");
      assert.equal(h.sends.length, 1);
      assert.equal(h.sends[0].opts?.triggerTurn, true, "resume starts the next turn");
      assert.match(h.sends[0].msg.content, /Continue active goal/);

      await h.command("clear");
      // Terminal tombstone: the LAST entry must never be "active" or a
      // restart would resurrect the cleared goal.
      assert.equal(lastState(h.entries)!.status, "stopped");
      await h.command("status");
      assert.match(h.notifications.at(-1)!.message, /No goal set/);
    } finally {
      h.restore();
    }
  });

  it("budget mutations: invalid refused, off unbounds and un-limits, raise revives", async () => {
    const h = await createHarness();
    try {
      // Pre-goal usage establishes the baseline.
      h.assistantEnd({ input: 10, output: 10, cacheRead: 0, cacheWrite: 0 });
      await h.command("ship it --budget 100");
      // In-goal response bills the full delta: 40+50 = 90... plus nothing — 90 < 100, so push higher.
      h.assistantEnd({ input: 70, output: 70, cacheRead: 0, cacheWrite: 0 }); // delta 120 ≥ 100
      h.turnEnd();
      assert.equal(lastState(h.entries)!.status, "budget-limited");
      await h.command("budget off");
      assert.equal(lastState(h.entries)!.status, "active");
      assert.equal(lastState(h.entries)!.tokenBudget, undefined);

      await h.command("budget 40"); // set below usage → budget-limited NOW (OMP semantics)
      const state = lastState(h.entries)!;
      assert.equal(state.status, "budget-limited");
      assert.equal(state.tokenBudget, 40);
      // Two episodes (flip at 100, then re-limit at 40 after budget off) →
      // one wrap-up PER EPISODE is the invariant.
      assert.equal(h.sends.filter((s) => s.msg.customType === "ceulen-goal-budget").length, 2);

      await h.command("budget 500"); // raise above usage → active again
      assert.equal(lastState(h.entries)!.status, "active");
      assert.equal(lastState(h.entries)!.tokenBudget, 500);

      await h.command("budget abc");
      assert.match(h.notifications.at(-1)!.message, /positive integer/);
    } finally {
      h.restore();
    }
  });
});

function lastState(entries: Array<{ customType: string; data: unknown }>): GoalState | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].customType === "ceulen-goal") return entries[i].data as GoalState;
  }
  return undefined;
}

describe("continuation loop", () => {
  it("a clean settle fires ONE continuation with triggerTurn; abort pauses; cap stops", async () => {
    const h = await createHarness();
    try {
      await h.command("do the thing");
      h.sends.length = 0;
      h.settle(false);
      assert.equal(h.sends.length, 1, "exactly one continuation per settle");
      assert.equal(h.sends[0].opts?.triggerTurn, true);
      assert.equal(h.sends[0].opts?.deliverAs, "followUp");
      assert.match(h.sends[0].msg.customType, /continue/);
      assert.match(h.sends[0].msg.content, /do the thing/);
      assert.equal(lastState(h.entries)!.turns, 1);

      // Abort (Escape) → pause, no continuation.
      h.settle(true);
      assert.equal(lastState(h.entries)!.status, "paused");
      assert.equal(h.sends.length, 1, "no second send");

      // Cap → stopped + warning.
      await h.command("resume");
      const capped = lastState(h.entries)!;
      capped.turns = capped.maxTurns;
      h.settle(false);
      assert.equal(lastState(h.entries)!.status, "stopped");
      assert.match(h.notifications.at(-1)!.message, /turn cap/);
    } finally {
      h.restore();
    }
  });

  it("plan mode becoming active between turns pauses instead of continuing", async () => {
    const h = await createHarness();
    try {
      await h.command("do the thing");
      h.setPlanActive(true);
      h.settle(false);
      assert.equal(lastState(h.entries)!.status, "paused");
      assert.equal(h.sends.length, 0);
    } finally {
      h.restore();
    }
  });
});

describe("budget flow end-to-end", () => {
  it("flip sends ONE wrap-up turn (triggerTurn+followUp — never a steer); later settles send nothing", async () => {
    const h = await createHarness();
    try {
      // Pre-goal baseline, then turn-1 usage crosses the budget (delta 105 ≥ 100).
      h.assistantEnd({ input: 10, output: 10, cacheRead: 0, cacheWrite: 0 });
      await h.command("finish it --budget 100");
      h.sends.length = 0;
      h.assistantEnd({ input: 70, output: 55, cacheRead: 10_000, cacheWrite: 0 });
      h.turnEnd();
      assert.equal(lastState(h.entries)!.status, "budget-limited");
      assert.equal(h.sends.length, 1, "the wrap-up message went out");
      assert.equal(h.sends[0].opts?.triggerTurn, true, "wrap-up MUST start a turn (advisor-found stranding bug)");
      assert.equal(h.sends[0].opts?.deliverAs, "followUp", "wrap-up is a followUp, not a stranded steer");
      assert.match(h.sends[0].msg.content, /NEVER start new substantive work/);

      // The wrap-up turn's own settle: budget-limited → none. No loop tail.
      h.turnEnd(); // wrap-up turn usage — no second wrap-up (budgetReported)
      h.settle(false);
      assert.equal(h.sends.length, 1, "no continuation and no second wrap-up after the flip");
    } finally {
      h.restore();
    }
  });

  it("rolling baseline: only the delta after the last snapshot is billed", async () => {
    const h = await createHarness();
    try {
      // Usage BEFORE the goal exists establishes the pre-goal baseline.
      h.assistantEnd({ input: 9999, output: 9999, cacheRead: 0, cacheWrite: 0 });
      await h.command("new goal --budget 100");
      h.sends.length = 0;
      // First in-goal response: billed from the 9999 baseline, not from zero.
      h.assistantEnd({ input: 10_009, output: 10_004, cacheRead: 0, cacheWrite: 0 });
      h.turnEnd();
      assert.equal(lastState(h.entries)!.tokensUsed, 10 + 5, "only the post-goal delta");
      assert.equal(lastState(h.entries)!.status, "active");
      assert.equal(h.sends.length, 0);
    } finally {
      h.restore();
    }
  });

  it("lazy init: a goal born mid-turn is not billed for the in-flight response", async () => {
    const h = await createHarness();
    try {
      h.assistantEnd({ input: 9999, output: 9999, cacheRead: 0, cacheWrite: 0 });
      await h.command("new goal --budget 100");
      h.sends.length = 0;
      h.assistantEnd({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
      h.turnEnd();
      assert.equal(lastState(h.entries)!.tokensUsed, 0);
      assert.equal(lastState(h.entries)!.status, "active");
    } finally {
      h.restore();
    }
  });

  it("fresh-session first turn bills in full — zero baseline (live-test regression)", async () => {
    const h = await createHarness();
    try {
      await h.command("find it --budget 1000");
      h.sends.length = 0;
      // No prior snapshot anywhere: the goal fired this session's first run,
      // so the whole snapshot bills (live 2026-11-01: lazy-init dropped 46K).
      h.assistantEnd({ input: 800, output: 100, cacheRead: 50, cacheWrite: 30 });
      h.turnEnd();
      assert.equal(lastState(h.entries)!.tokensUsed, 930, "input+output+cacheWrite from zero; cacheRead excluded");
      h.assistantEnd({ input: 850, output: 110, cacheRead: 50, cacheWrite: 30 });
      h.turnEnd();
      assert.equal(lastState(h.entries)!.tokensUsed, 930 + 60, "second response bills its delta");
      assert.equal(lastState(h.entries)!.status, "active");
    } finally {
      h.restore();
    }
  });
});

describe("goal tool", () => {
  it("get renders state; complete ends the loop, reports, and clears; errors on wrong states", async () => {
    const h = await createHarness();
    try {
      await h.command("prove it done");

      const got = await h.tool({ op: "get" });
      assert.match(got.content[0].text, /prove it done/);

      const done = await h.tool({ op: "complete" });
      assert.match(done.content[0].text, /Goal achieved/);
      assert.match(h.notifications.at(-1)!.message, /Goal achieved/);
      const report = h.sends.find((s) => s.msg.customType === "ceulen-goal-report");
      assert.ok(report, "display entry sent");
      // Terminal tombstone in the transcript + live state cleared.
      assert.equal(lastState(h.entries)!.status, "complete");
      const activeAfter = lastState(h.entries)!.status;
      assert.ok(activeAfter === "complete", "no active snapshot left behind");

      const again = await h.tool({ op: "complete" });
      assert.equal(again.isError, true);

      await h.command("paused goal");
      await h.command("pause");
      const paused = await h.tool({ op: "complete" });
      assert.equal(paused.isError, true, "complete on paused is refused");
      assert.match(paused.content[0].text, /paused/);
    } finally {
      h.restore();
    }
  });
});

describe("rehydration + composer", () => {
  it("restores an active goal PAUSED after restart; complete stays terminal", async () => {
    const h = await createHarness();
    try {
      h.setBranch([
        { type: "message", role: "user" },
        { type: "custom", customType: "ceulen-goal", data: fresh({ status: "active", turns: 4 }) },
      ]);
      await h.events.get("session_start")!({ type: "session_start", reason: "startup" }, h.ctx);
      assert.equal(lastState([] as typeof h.entries)?.status, undefined); // entries list untouched
      assert.match(h.notifications.at(-1)!.message, /restored paused/);

      // A restored-paused goal never continues.
      h.settle(false);
      assert.equal(h.sends.length, 0);

      // A complete snapshot restores as complete (terminal, no resume).
      h.setBranch([{ type: "custom", customType: "ceulen-goal", data: fresh({ status: "complete" }) }]);
      await h.events.get("session_start")!({ type: "session_start", reason: "startup" }, h.ctx);
      const done = await h.tool({ op: "complete" });
      assert.equal(done.isError, true, "still terminal after restore");
    } finally {
      h.restore();
    }
  });

  it("before_agent_start appends goal context only while active/budget-limited", async () => {
    const h = await createHarness();
    try {
      const composer = h.events.get("before_agent_start")!;
      assert.equal(composer({ type: "before_agent_start", systemPrompt: "BASE" }, h.ctx), undefined);

      await h.command("ctx test");
      const active = composer({ type: "before_agent_start", systemPrompt: "BASE" }, h.ctx) as { systemPrompt: string };
      assert.ok(active.systemPrompt.startsWith("BASE"), "append-only — base preserved verbatim");
      assert.ok(active.systemPrompt.includes("<goal_context>"));
      assert.match(active.systemPrompt, /ctx test/);

      await h.command("pause");
      assert.equal(composer({ type: "before_agent_start", systemPrompt: "BASE" }, h.ctx), undefined);
    } finally {
      h.restore();
    }
  });
});

describe("settings defaults", () => {
  it("defaults resolve from the (redirected) agent dir without a settings file", () => {
    assert.equal(defaultMaxTurns(), 50);
    assert.equal(defaultBudget() ?? 0, 0, "0 = unbounded default");
  });
});
