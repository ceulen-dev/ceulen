import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { opencodeSessionHeaders, runIsolatedChain } from "../lib/isolated-model.js";

/** Model ref that parseModel resolves; provider name is arbitrary. */
const MODEL = "fake/timeout-model";

interface FakeOptions {
  signal?: AbortSignal;
  reasoning?: unknown;
  headers?: Record<string, string>;
}

type FakeResponse = AsyncIterable<{ type: string; delta?: string }> & {
  result(): Promise<{ stopReason: string; content: Array<{ type: string; text?: string }> }>;
};

/** Response that streams `count` deltas `intervalMs` apart, then completes —
 *  total duration exceeds the deadline while each idle gap stays under it.
 *  Honors abort like the real streamSimple: an abort mid-stream surfaces as
 *  an error (iterator/result reject), never as a successful completion. */
function slowAliveResponse(options: FakeOptions, intervalMs: number, count: number, text: string): FakeResponse {
  const signal = options.signal;
  let remaining = count;
  const abortError = () => new Error("SLOW-ALIVE-ABORTED: stream killed mid-stream");
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (remaining <= 0) return { done: true, value: undefined as never };
          remaining--;
          const sleep = new Promise((r) => setTimeout(r, intervalMs));
          const aborted = new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          await Promise.race([sleep, aborted]);
          if (signal?.aborted) throw abortError();
          return { done: false, value: { type: "text_delta", delta: text } };
        },
      };
    },
    async result() {
      if (signal?.aborted) throw abortError();
      return { stopReason: "stop", content: [{ type: "text", text }] };
    },
  };
}

/** Response that never yields data but honors abort like the real streamSimple:
 *  the iterator stalls until the signal fires, then result() rejects. */
function hangingResponse(signal: AbortSignal | undefined): FakeResponse {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (!signal || signal.aborted) return { done: true, value: undefined as never };
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return { done: true, value: undefined as never };
        },
      };
    },
    async result() {
      if (signal?.aborted) throw new Error("CANDIDATE-ABORT-MARKER: stream killed by abort");
      await new Promise(() => {}); // never resolves when not aborted
      return {} as never;
    },
  };
}

/** Response that streams text normally. */
function goodResponse(text: string): FakeResponse {
  return {
    [Symbol.asyncIterator]() {
      return (async function* () {
        yield { type: "text_delta", delta: text };
      })();
    },
    async result() {
      return { stopReason: "stop", content: [{ type: "text", text }] };
    },
  };
}

type FakeProvider = (model: unknown, context: unknown, options: FakeOptions) => unknown;

/** Fake context exposing the registry surface runIsolated uses: `find` for the
 *  ref → model lookup and `streamSimple` as the provider-neutral stream entry. */
function fakeCtx(provider: FakeProvider): any {
  return {
    model: undefined,
    getSystemPrompt: () => "",
    modelRegistry: {
      find: () => ({ id: "timeout-model", provider: "fake" }),
      streamSimple: (model: unknown, context: unknown, options: FakeOptions) => provider(model, context, options ?? {}),
    },
  };
}

describe("runIsolatedChain candidate deadline", () => {
  it("returns the serving call's usage alongside text and model", async () => {
    const provider: FakeProvider = () => ({
      [Symbol.asyncIterator]() { return (async function* () { yield { type: "text_delta", delta: "ok" }; })(); },
      async result() {
        return { stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 120, output: 34, cacheRead: 8, totalTokens: 162, cost: { total: 0.0123 } } };
      },
    });
    const result = await runIsolatedChain(fakeCtx(provider) as never, [MODEL], { systemPrompt: "s", messages: [] });
    assert.deepEqual(result.usage, { input: 120, output: 34, cacheRead: 8, totalTokens: 162, cost: 0.0123 });
  });

  it("a response without usage reports zeroed usage instead of throwing", async () => {
    const result = await runIsolatedChain(fakeCtx(() => goodResponse("ok")) as never, [MODEL], { systemPrompt: "s", messages: [] });
    assert.deepEqual(result.usage, { input: 0, output: 0, cacheRead: 0, totalTokens: 0, cost: 0 });
  });

  it("a hung first candidate times out and the chain serves the next model", async () => {
    let calls = 0;
    const provider: FakeProvider = (_model, _context, options) => {
      calls++;
      return calls === 1 ? hangingResponse(options.signal) : goodResponse("ok");
    };
    const result = await runIsolatedChain(
      fakeCtx(provider) as never,
      [MODEL, MODEL],
      { systemPrompt: "s", messages: [] },
      undefined,
      undefined,
      undefined,
      100,
    );
    assert.equal(result.text, "ok");
    assert.equal(result.model, MODEL);
  });

  it("a slow-but-alive stream survives the deadline (idle, not total)", async () => {
    // 5 deltas × 40ms = 200ms total > timeoutMs=100, but no idle gap reaches it.
    let calls = 0;
    const provider: FakeProvider = (_model, _context, options) => {
      calls++;
      return slowAliveResponse(options, 40, 5, "slow-ok");
    };
    const result = await runIsolatedChain(
      fakeCtx(provider) as never,
      [MODEL],
      { systemPrompt: "s", messages: [] },
      undefined,
      undefined,
      undefined,
      100,
    );
    assert.equal(result.text, "slow-ok");
    assert.equal(calls, 1);
  });

  it("caller abort still aborts without falling through", async () => {
    let calls = 0;
    const provider: FakeProvider = (_model, _context, options) => {
      calls++;
      return hangingResponse(options.signal);
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(
      runIsolatedChain(fakeCtx(provider) as never, [MODEL, MODEL], { systemPrompt: "s", messages: [] }, undefined, controller.signal),
      /CANDIDATE-ABORT-MARKER/,
    );
    // The ORIGINAL candidate error must surface (exact-marker match above):
    // if the catch-side `signal?.aborted` rethrow were removed, the chain
    // would swallow it and the loop-top check would throw the generic
    // "Advisor call aborted" instead, failing this assertion.
    assert.equal(calls, 1);
  });

  it("an erroring first candidate falls through to a good one (existing chain behavior)", async () => {
    let calls = 0;
    const provider: FakeProvider = () => {
      calls++;
      if (calls === 1) throw new Error("rate limited");
      return goodResponse("ok");
    };
    const result = await runIsolatedChain(fakeCtx(provider) as never, [MODEL, MODEL], { systemPrompt: "s", messages: [] });
    assert.equal(result.text, "ok");
    assert.deepEqual(calls, 2);
  });

  it("a pre-aborted signal refuses to start any candidate", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const provider: FakeProvider = () => {
      calls++;
      return goodResponse("ok");
    };
    await assert.rejects(
      runIsolatedChain(fakeCtx(provider) as never, [MODEL, MODEL], { systemPrompt: "s", messages: [] }, undefined, controller.signal),
      /aborted/,
    );
    assert.equal(calls, 0, "no provider call for an already-aborted chain");
  });

  it("all candidates dead surfaces the last error", async () => {
    const provider: FakeProvider = () => {
      throw new Error("quota exhausted");
    };
    await assert.rejects(
      runIsolatedChain(fakeCtx(provider) as never, [MODEL, MODEL], { systemPrompt: "s", messages: [] }),
      /quota exhausted/,
    );
  });
});

describe("opencode session headers on the isolated path", () => {
  // The main loop's `transformHeaders` closure is not reachable from an
  // extension, so the session header must ride in the request options or
  // Console Go answers 400 MissingSessionID (bacnh85/pi-extensions#38).
  it("builds the header only for opencode models with a session id", () => {
    const expected = { "x-opencode-session": "ses_1", "x-opencode-client": "pi" };
    assert.deepEqual(opencodeSessionHeaders({ provider: "opencode-go" }, "ses_1"), expected);
    assert.deepEqual(opencodeSessionHeaders({ provider: "x", baseUrl: "https://opencode.ai/zen/go/v1" }, "ses_1"), expected);
    assert.equal(opencodeSessionHeaders({ provider: "opencode-go" }, undefined), undefined);
    assert.equal(opencodeSessionHeaders({ provider: "zai", baseUrl: "not-a-url" }, "ses_1"), undefined);
  });

  it("passes it through the stream options for an opencode model", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const provider: FakeProvider = (_model, _context, options) => {
      seen.push(options.headers);
      return goodResponse("ok");
    };
    const ctx = fakeCtx(provider) as Record<string, any>;
    ctx.sessionManager = { getSessionId: () => "ses_1" };
    ctx.modelRegistry.find = () => ({ id: "omen-alpha", provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" });
    await runIsolatedChain(ctx as never, ["opencode-go/omen-alpha"], { systemPrompt: "s", messages: [] });
    assert.equal(seen[0]?.["x-opencode-session"], "ses_1");
    assert.equal(seen[0]?.["x-opencode-client"], "pi");
  });

  it("adds no headers for a non-opencode model", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const provider: FakeProvider = (_model, _context, options) => {
      seen.push(options.headers);
      return goodResponse("ok");
    };
    const ctx = fakeCtx(provider) as Record<string, any>;
    ctx.sessionManager = { getSessionId: () => "ses_1" };
    ctx.modelRegistry.find = () => ({ id: "claude", provider: "anthropic", baseUrl: "https://api.anthropic.com" });
    await runIsolatedChain(ctx as never, ["anthropic/claude"], { systemPrompt: "s", messages: [] });
    assert.equal(seen[0], undefined);
  });
});

describe("runIsolated thinking suffix", () => {
  it("passes a pinned :level as options.reasoning, per candidate", async () => {
    const seen: unknown[] = [];
    const provider: FakeProvider = (_model, _context, options) => {
      seen.push(options.reasoning);
      return goodResponse("ok");
    };
    const result = await runIsolatedChain(
      fakeCtx(provider) as never,
      ["fake/timeout-model:high"],
      { systemPrompt: "s", messages: [] },
    );
    assert.equal(result.text, "ok");
    assert.deepEqual(seen, ["high"]);
    assert.equal(result.model, "fake/timeout-model:high", "raw entry surfaces for display");
  });

  it("no suffix and :off leave reasoning unset (provider default)", async () => {
    const seen: unknown[] = [];
    let calls = 0;
    const provider: FakeProvider = (_model, _context, options) => {
      seen.push(options.reasoning);
      calls++;
      if (calls === 1) throw new Error("rate limited"); // advance to the :off candidate
      return goodResponse("ok");
    };
    const result = await runIsolatedChain(fakeCtx(provider) as never, [MODEL, `${MODEL}:off`], { systemPrompt: "s", messages: [] });
    assert.equal(result.text, "ok");
    assert.deepEqual(seen, [undefined, undefined]);
  });

  it("an invalid trailing segment is not a level — it stays part of the model id", async () => {
    const seen: unknown[] = [];
    const provider: FakeProvider = (_model, _context, options) => {
      seen.push(options.reasoning);
      return goodResponse("ok");
    };
    const ctx = fakeCtx(provider) as Record<string, any>;
    ctx.modelRegistry.find = (_p: string, id: string) => (id === "timeout-model:hgh" ? { id, provider: "fake" } : undefined);
    const result = await runIsolatedChain(ctx as never, ["fake/timeout-model:hgh"], { systemPrompt: "s", messages: [] });
    assert.equal(result.text, "ok", "`:hgh` rides along in the id (a real registry reports it unresolvable)");
    assert.deepEqual(seen, [undefined]);
  });

  it("an unresolvable model ref fails the candidate without a stream call", async () => {
    let calls = 0;
    const provider: FakeProvider = () => {
      calls++;
      return goodResponse("ok");
    };
    const ctx = fakeCtx(provider) as Record<string, any>;
    ctx.modelRegistry.find = () => undefined;
    await assert.rejects(
      runIsolatedChain(ctx as never, ["fake/gone"], { systemPrompt: "s", messages: [] }),
      /Model unavailable/,
    );
    assert.equal(calls, 0);
  });
});
