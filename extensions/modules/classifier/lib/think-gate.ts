// think-gate.ts — main-session per-turn thinking gate (classifier.thinkGate).
//
// One Jev score question per USER turn ("how much reasoning does this turn
// need?") sets the session thinking level; the baseline is restored at settle.
// planGate precedent: default fully OFF, observe-first rollout, 2.5s budget,
// fail-open everywhere, every verdict audited to classifier.log.
//
// Scope guards (each returns without classifying):
//   - custom/triggerTurn messages (cron fires, subagent receipts) — only
//     messageType "user" turns are gated;
//   - plan mode (extensions/lib/plan-bridge.ts — the plan module owns the dial);
//   - CEULEN_THINK_GATE_OFF=1 (herdr pane children — they get dispatch-routed
//     thinking already; a per-turn gate would double-classify and fight it);
//   - stood-down sessions: ANY thinking_level_select event we did not cause
//     (user /think, level cycling, a model switch whose clamp differs) disables
//     the gate until restart — a user who touches the dial owns the dial.
//
// Ownership of our own set: pi emits thinking_level_select only when the level
// actually changes (agent-session.js setThinkingLevel isChanging gate), with
// {level, previousLevel} — our set always yields level===ours.to &&
// previousLevel===ours.from; a <1.5s window guards the pathological late emit.
// Both must hold, else the event reads as manual.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askJev, audit } from "../index.js";
import { getClassifierSettings } from "./settings.js";
import { isPlanActive } from "../../../lib/plan-bridge.js";

const TAG = "ceulen-think-gate";
const BUDGET_MS = 2_500;
/** Guards against a pathologically late event being misread as ours (pi emits
 *  synchronously off setThinkingLevel, so real ownership arrives in ms). */
const OWNERSHIP_WINDOW_MS = 1_500;

/** Keep in sync with extensions/modules/subagent/lib/routing.ts EFFORT_LADDER
 *  (same 5 rungs; a local copy so the classifier module stays dependency-free). */
const EFFORT_LADDER: readonly string[] = [
  "off: mechanical lookup or trivial edit, no reasoning needed",
  "low: simple, well-specified change; fix already identified",
  "medium: normal multi-step implementation or verification",
  "high: cross-file reasoning, subtle interactions, careful refactor",
  "xhigh: architecture, design tradeoffs, consequential planning",
];
const LEVELS = ["off", "low", "medium", "high", "xhigh"] as const;
type Level = (typeof LEVELS)[number];

interface Ours {
  setAt: number;
  from: Level;
  to: Level;
}

/** Armed BEFORE a setThinkingLevel call: pi's thinking_level_select arrives
 *  synchronously off the call site (live-verified 2026-10-19 — the event lands
 *  before the line after the call executes), so post-call attribution is too
 *  late. The arm is consumed by the next event, whatever its (clamped) values.
 *  A no-change set emits nothing; the arm then lingers windowed (5s) and only
 *  risks mis-attributing a pathological same-second manual change — fail-open
 *  direction: the gate keeps running. */
let expectEventAt = 0;
const EXPECT_EVENT_WINDOW_MS = 5_000;

export function registerThinkGate(pi: ExtensionAPI): void {
  let ours: Ours | undefined;
  let stoodDown = false;
  let reportedNoModel = false;

  const reset = () => {
    ours = undefined;
    stoodDown = false;
    reportedNoModel = false;
    expectEventAt = 0;
  };

  pi.on("session_start", () => reset());
  pi.on("session_shutdown", () => reset());

  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType !== "user" || !event.prompt) return undefined;
    if (process.env.CEULEN_THINK_GATE_OFF) return undefined;
    if (stoodDown || isPlanActive()) return undefined;
    const { thinkGate } = getClassifierSettings();
    if (!thinkGate.enabled && !thinkGate.observe) return undefined;

    const current = pi.getThinkingLevel() as Level;
    const model = ctx.model;
    const head = event.prompt.slice(0, 4000);
    const finish = (entry: Record<string, unknown>) =>
      // Awaited by the caller: one append per turn is ~1ms and makes the
      // audit-vs-settle ordering deterministic. (The bash hook keeps
      // fire-and-forget — that one is a per-tool-call hot path.)
      audit({ tag: TAG, prompt_head: head.slice(0, 80), model: model?.id, current_level: current, ...entry });

    let score: number | undefined;
    let confidence: number | undefined;
    let reason: string | undefined;
    try {
      const budget = AbortSignal.timeout(BUDGET_MS);
      const answers = (await Promise.race([
        askJev(
          ctx,
          { prompt: head, model: model?.id, current_level: current },
          {
            effort: {
              type: "score",
              instructions: "How much reasoning does this turn need?",
              criteria: [...EFFORT_LADDER],
            },
          },
          budget,
        ),
        new Promise<never>((_, reject) => budget.addEventListener("abort", () => reject(new Error("think gate budget exceeded")), { once: true })),
      ])) as Record<string, unknown>;
      const effort = answers.effort as { score?: unknown; confidence?: unknown } | undefined;
      if (effort && typeof effort.score === "number" && Number.isFinite(effort.score)) {
        score = effort.score;
        confidence = typeof effort.confidence === "number" ? effort.confidence : undefined;
      } else {
        reason = "malformed answer";
      }
    } catch (e) {
      reason = e instanceof Error ? e.message.slice(0, 80) : "classifier error";
    }

    if (score === undefined) {
      // Circuit-breaker for the log: a missing classifier model fail-opens on
      // EVERY turn — one audit line per turn is noise, one per session is a
      // trace. First miss writes the line and arms the flag; later misses are
      // silent (a malformed answer re-reports once via its own branch).
      if (reason?.includes("no classifier model")) {
        if (!reportedNoModel) {
          reportedNoModel = true;
          await finish({ applied: false, reason });
        }
      } else {
        await finish({ applied: false, reason });
      }
      return undefined;
    }
    if (confidence !== undefined && confidence < thinkGate.threshold) {
      await finish({ applied: false, reason: `confidence ${confidence} < ${thinkGate.threshold}`, verdict_score: score });
      return undefined;
    }

    const idx = Math.min(Math.max(Math.round(score), 0), LEVELS.length - 1);
    const verdict = LEVELS[idx];
    if (thinkGate.observe || verdict === current) {
      await finish({ applied: false, reason: thinkGate.observe ? "observe" : "same", verdict, confidence });
      return undefined;
    }

    // Arm BEFORE the set: pi emits synchronously off the call site (live
    // 2026-10-19) — `ours` and the event arm must be complete when the
    // handler runs.
    ours = { setAt: Date.now(), from: current, to: verdict };
    expectEventAt = Date.now();
    pi.setThinkingLevel(verdict);
    // pi CLAMPS the requested level (GLM-5.3 has no real "off": off→minimal
    // via the zai53 map) — keep the EFFECTIVE level as ours.to so the settle
    // check compares against reality. (Live lesson 2026-10-19: verdict "off"
    // clamped to "minimal"; the raw-verdict comparison restored nothing.)
    ours.to = pi.getThinkingLevel() as Level;
    if (ours.to === ours.from) ours = undefined;
    await finish({ applied: true, verdict, confidence, baseline: current });
    return undefined;
  });

  pi.on("agent_settled", async () => {
    if (!ours) return;
    const current = pi.getThinkingLevel() as Level;
    const o = ours;
    ours = undefined;
    if (current === o.to) {
      expectEventAt = Date.now();
      pi.setThinkingLevel(o.from);
      // Re-read: the restore is also subject to the clamp — log what actually
      // happened, and skip the audit on a no-op (a no-op emits no event; the
      // lingering arm is windowed and harmless).
      const restoredTo = pi.getThinkingLevel() as Level;
      if (restoredTo !== o.to) {
        await audit({ tag: TAG, restored: restoredTo, verdict: o.to });
      }
    }
    // Level moved by someone else mid-turn: thinking_level_select already
    // stood the gate down; nothing to restore here.
  });

  pi.on("thinking_level_select", async (event) => {
    // Kill-switch first: a herdr child's pi INIT fires this event (model default
    // re-apply) before any turn — without this guard the child logs a spurious
    // stoodDown even though its gate is env-disabled (live herdr test
    // 2026-10-19). Inert means fully inert.
    if (process.env.CEULEN_THINK_GATE_OFF) return;
    // Our own forward set or settle-restore (armed at the call site; pi emits
    // the CLAMPED values, which we cannot predict — the arm is the attribution).
    if (expectEventAt && Date.now() - expectEventAt < EXPECT_EVENT_WINDOW_MS) {
      expectEventAt = 0;
      return;
    }
    const isOurs = ours !== undefined
      && event.level === ours.to
      && event.previousLevel === ours.from
      && Date.now() - ours.setAt < OWNERSHIP_WINDOW_MS;
    if (isOurs) return;
    if (!stoodDown) {
      stoodDown = true;
      ours = undefined;
      await audit({ tag: TAG, stoodDown: true, level: event.level, previousLevel: event.previousLevel });
    }
  });
}
