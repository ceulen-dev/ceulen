/**
 * Generation Rate handoff: usage computes tok/s on message_end and publishes
 * it to the shared store the composer renders. Reset per session.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../index.ts";
import { getGenRate } from "../../../lib/rate.js";

function makePi() {
  const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void> | void> = {};
  return {
    handlers,
    on(type: string, fn: (event: unknown, ctx: unknown) => Promise<void> | void) {
      handlers[type] = fn;
    },
    registerCommand() {},
  } as never;
}

const stubCtx = {
  signal: undefined,
  model: { provider: "ollama", id: "llama" }, // unsupported → no fetch/timer
  ui: { theme: { fg: (_c: string, s: string) => s }, setStatus() {}, notify() {} },
  getContextUsage: () => undefined,
} as never;

test("message_end publishes tok/s to the shared rate store; session_start resets it", async () => {
  const pi = makePi() as { handlers: Record<string, (e: unknown, c: never) => Promise<void> | void> };
  extension(pi);

  await pi.handlers.session_start!({ reason: "new" }, stubCtx);
  assert.equal(getGenRate().tps, undefined, "fresh session starts with no rate");

  await pi.handlers.before_provider_request!({}, stubCtx);
  await new Promise((r) => setTimeout(r, 110)); // clear the 100ms noise floor
  const usage = { output: 1000, reasoning: 400, cost: { total: 0 } };
  await pi.handlers.message_end!({ message: { role: "assistant", usage } }, stubCtx);
  const tps = getGenRate().tps;
  assert.ok(typeof tps === "number" && tps > 0, `rate published (${tps})`);

  await pi.handlers.session_start!({ reason: "new" }, stubCtx);
  assert.equal(getGenRate().tps, undefined, "new session clears the previous rate");
});

test("tok/s guards: sub-floor duration and aborted/errored streams publish nothing", async () => {
  const pi = makePi() as { handlers: Record<string, (e: unknown, c: never) => Promise<void> | void> };
  extension(pi);

  await pi.handlers.session_start!({ reason: "new" }, stubCtx);
  const usage = { output: 1000, reasoning: 0, cost: { total: 0 } };

  // Sub-floor: fast continuation would otherwise flash a huge rate.
  await pi.handlers.before_provider_request!({}, stubCtx);
  await pi.handlers.message_end!({ message: { role: "assistant", usage } }, stubCtx);
  assert.equal(getGenRate().tps, undefined, "<100ms elapsed is noise, not a rate");

  // Aborted partial: accumulated output is not a rate either.
  await pi.handlers.before_provider_request!({}, stubCtx);
  await new Promise((r) => setTimeout(r, 110));
  await pi.handlers.message_end!({ message: { role: "assistant", stopReason: "aborted", usage } }, stubCtx);
  assert.equal(getGenRate().tps, undefined, "aborted stream publishes nothing");

  // Errored stream.
  await pi.handlers.before_provider_request!({}, stubCtx);
  await new Promise((r) => setTimeout(r, 110));
  await pi.handlers.message_end!({ message: { role: "assistant", stopReason: "error", usage } }, stubCtx);
  assert.equal(getGenRate().tps, undefined, "errored stream publishes nothing");
});
