/**
 * Session-scoped accumulators: /usage labels these figures "Session cost" and
 * "Session avg", so they must not survive session_start (/new, reload, switch,
 * fork) — before the fix they were created once at module load and kept
 * accumulating, so the second session reported the first session's cost.
 *
 * Unsupported provider ("ollama") on purpose: no adapter, so no refresh timer
 * is armed (no open handles) and renderSubscriptionLine takes the tok/s branch.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import extension, { renderSubscriptionLine, type State } from "../index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness() {
  const handlers: Record<string, (event: any, ctx: any) => any> = {};
  const statuses: (string | undefined)[] = [];
  const pi = {
    on(type: string, fn: any) {
      handlers[type] = fn;
    },
    registerCommand() {},
    registerMessageRenderer() {},
  };
  const ctx = {
    model: { provider: "ollama", id: "llama" }, // unsupported → no adapter, no timer
    isProjectTrusted: () => false,
    ui: {
      theme: { fg: (_c: string, s: string) => s },
      setStatus(_key: string, value?: string) {
        statuses.push(value);
      },
      notify() {},
    },
    getContextUsage: () => undefined,
  };
  const state = extension(pi as never) as State;
  /** One assistant response: publishes tok/s and accumulates the session figures. */
  const respond = async (cost: number) => {
    await handlers.before_provider_request!({}, ctx);
    await sleep(110); // clear the 100ms noise floor
    await handlers.message_end!({ message: { role: "assistant", usage: { output: 1000, reasoning: 400, cost: { total: cost } } } }, ctx);
  };
  return { handlers, ctx, state, statuses, respond };
}

test("session_start resets the session cost/avg accumulators (a second session never inherits the first)", async () => {
  const h = harness();
  await h.handlers.session_start!({ reason: "startup" }, h.ctx);
  assert.equal(h.state.cumulativeCost, 0, "fresh session starts at zero cost");

  await h.respond(0.05);
  assert.ok(h.state.cumulativeCost > 0, "cost accumulates within the session");
  assert.ok(h.state.cumulativeOutput > 0 && h.state.cumulativeDurationMs > 0, "tok/s samples accumulate the session average");
  assert.ok(h.state.lastTokPerSec !== undefined, "last response rate published");

  // The /usage footer/session-avg surface reads these fields directly.
  renderSubscriptionLine(h.state);
  assert.match(String(h.statuses.at(-1)), /tok\/s/, "last response rate rendered before the switch");

  // /new (or reload/switch/fork): the accumulators must reset with the session.
  await h.handlers.session_start!({ reason: "new" }, h.ctx);
  assert.equal(h.state.cumulativeCost, 0, "session cost reset — not the previous session's total");
  assert.equal(h.state.cumulativeOutput, 0, "session output reset");
  assert.equal(h.state.cumulativeDurationMs, 0, "session duration reset");
  assert.equal(h.state.lastTokPerSec, undefined, "last-response rate cleared with the session");
  assert.equal(h.state.lastTokPerSecLabel, undefined, "last-response label cleared too (it belongs to the old session)");
  assert.equal(h.state.responseStartPerf, undefined, "no half-measured request carried across the switch");

  renderSubscriptionLine(h.state);
  assert.equal(h.state.cumulativeCost, 0);
  const last = String(h.statuses.at(-1));
  assert.ok(!/Session avg|tok\/s/.test(last), `session-scoped tok/s surfaces gone after the switch (got ${JSON.stringify(last)})`);

  // Positive control: the reset is per SESSION, not per message — the new
  // session accumulates its own figures normally. (No separate lifetime/aggregate
  // counter exists in State, so the reset has nothing else to clobber: cost,
  // output, duration and the last-response rate are all session-scoped.)
  await h.respond(0.01);
  assert.ok(h.state.cumulativeCost > 0 && h.state.cumulativeCost < 0.02, "the new session counts only its own cost");
  await h.respond(0.01);
  assert.ok(h.state.cumulativeCost > 0.015, "messages within one session still accumulate");
});
