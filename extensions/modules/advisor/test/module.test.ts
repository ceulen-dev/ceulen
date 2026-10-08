import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import advisorModule, { __getRuntimeForTest, __setIsolatedForTest } from "../index.js";
import { advisorConfig } from "../configPanel.js";
import { writeAdvisorSettings } from "../lib/config.js";

const NO_USAGE = { input: 0, output: 0, cacheRead: 0, totalTokens: 0, cost: 0 };

const realAgentDir = process.env.PI_CODING_AGENT_DIR;
let AGENT: string;
let REPO: string;

beforeEach(() => {
  AGENT = mkdtempSync(join(tmpdir(), "ceulen-advisor-mod-"));
  REPO = mkdtempSync(join(tmpdir(), "ceulen-advisor-mod-repo-"));
  process.env.PI_CODING_AGENT_DIR = AGENT;
  __setIsolatedForTest(undefined);
});

after(() => {
  __setIsolatedForTest(undefined);
  if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = realAgentDir;
});

const writeSettings = (body: unknown): void => writeFileSync(join(AGENT, "settings.json"), JSON.stringify(body, null, 2));
const readSettings = (): any => JSON.parse(readFileSync(join(AGENT, "settings.json"), "utf8"));

function toolCalls(n: number): any[] {
  const list: any[] = [{ type: "message", id: "e0", parentId: null, timestamp: "0", message: { role: "user", content: [{ type: "text", text: "task" }], timestamp: 0 } }];
  for (let i = 1; i <= n; i++) {
    list.push({ type: "message", id: `t${i}`, parentId: list[list.length - 1].id, timestamp: `${i}`, message: { role: "assistant", content: [{ type: "toolCall", id: `tc${i}`, name: "read", arguments: {} }], timestamp: i } });
    list.push({ type: "message", id: `r${i}`, parentId: `t${i}`, timestamp: `${i}r`, message: { role: "toolResult", toolCallId: `tc${i}`, toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: i + 0.5 } });
  }
  list.push({ type: "message", id: `a${n}`, parentId: list[list.length - 1].id, timestamp: `${n}a`, message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: n + 1 } });
  return list;
}

function createFakePi() {
  const state: any = {
    activeTools: new Set<string>(),
    tools: new Map(),
    commands: new Map(),
    entryRenderers: new Map(),
    messageRenderers: new Map(),
    eventHandlers: new Map<string, ((event: any, ctx: any) => any)[]>(),
    entries: [] as any[],
    userMessages: [] as any[],
    sendMessageCalls: 0,
  };
  const pi: any = {
    registerTool: (tool: any) => { state.tools.set(tool.name, tool); },
    registerCommand: (name: string, def: any) => { state.commands.set(name, def); },
    getActiveTools: () => [...state.activeTools],
    setActiveTools: (tools: string[]) => { state.activeTools = new Set(tools); },
    registerEntryRenderer: (type: string, renderer: any) => { state.entryRenderers.set(type, renderer); },
    registerMessageRenderer: (type: string, renderer: any) => { state.messageRenderers.set(type, renderer); },
    appendEntry: (customType: string, data: unknown) => { state.entries.push({ type: "custom", customType, data }); },
    sendMessage: () => { state.sendMessageCalls++; }, // would enter LLM context — must never be used for status/cards
    sendUserMessage: (content: string, options?: any) => { state.userMessages.push({ content, options }); },
    on: (channel: string, handler: (event: any, ctx: any) => void) => {
      const list = state.eventHandlers.get(channel) ?? [];
      list.push(handler);
      state.eventHandlers.set(channel, list);
      return () => {};
    },
  };
  return { pi, state };
}

function fakeCtx(entries: any[], sessionId = "test-session"): any {
  const notes: { message: string; level?: string }[] = [];
  const ctx: any = {
    cwd: REPO,
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => false,
    model: { provider: "test", id: "main-model" },
    modelRegistry: {
      getAvailable: () => [],
      refresh: async () => {},
      find: () => ({ provider: "test", id: "advisor-model", contextWindow: 32_768 }),
      getError: () => undefined,
    },
    getSystemPrompt: () => "Primary system prompt",
    sessionManager: { getEntries: () => entries, getLeafId: () => entries[entries.length - 1]?.id, getSessionId: () => sessionId },
    ui: { notify: (message: string, level?: string) => notes.push({ message, level }) },
  };
  ctx.notes = notes;
  return ctx;
}

async function fire(_pi: any, state: any, channel: string, ctx: any): Promise<void> {
  const handlers = state.eventHandlers.get(channel) ?? [];
  for (const h of handlers) await h({}, ctx);
  // agent_settled schedules the review fire-and-forget (never blocks the
  // settle) — drain the event loop so a floating review settles before
  // assertions.
  await new Promise((r) => setImmediate(r));
}

const MODEL = "test/advisor-model";
const step = (ctx: any, mode: string | undefined) => (mode === undefined ? ctx : { ...ctx, mode });
const available = (ctx: any, on = true) => {
  ctx.modelRegistry.getAvailable = () => (on ? [{ provider: "test", id: "advisor-model", contextWindow: 32_768 }] : []);
  return ctx;
};

describe("advisor module wiring", () => {
  it("registers the tool (inactive by default), the command, and both ceulen-advisor renderers", () => {
    const { pi, state } = createFakePi();
    advisorModule(pi);
    assert.ok(state.tools.has("advisor"), "advisor tool registered");
    assert.ok(state.commands.has("advisor"), "/advisor command registered");
    assert.ok(state.entryRenderers.has("ceulen-advisor"), "card entry renderer registered under the ceulen- prefix");
    assert.ok(state.messageRenderers.has("ceulen-advisor"), "deferred-aside message renderer registered");
    assert.ok(state.eventHandlers.has("agent_settled"), "agent_settled hook registered");
    assert.ok(state.eventHandlers.has("session_start") && state.eventHandlers.has("session_shutdown"));
  });

  it("session_start activates the tool when a model + master are configured", async () => {
    const { pi, state } = createFakePi();
    advisorModule(pi);
    writeSettings({ advisor: { models: [MODEL] } });
    await fire(pi, state, "session_start", available(fakeCtx([])));
    assert.ok(state.activeTools.has("advisor"));
  });

  it("keeps the tool inactive while no model resolves, and always loaded as a module", async () => {
    const off = createFakePi();
    advisorModule(off.pi);
    // `Review settled turns` off is NOT an on/off for the advisor: the consult
    // tool follows the chain, so it stays registered (pi-advisor semantics).
    writeSettings({ advisor: { enabled: false, models: [MODEL] } });
    await fire(off.pi, off.state, "session_start", available(fakeCtx([])));
    assert.equal(off.state.activeTools.has("advisor"), true, "review off + chain → consult tool still registered");

    const unauthed = createFakePi();
    advisorModule(unauthed.pi);
    writeSettings({ advisor: { models: [MODEL] } });
    await fire(unauthed.pi, unauthed.state, "session_start", fakeCtx([]));
    assert.equal(unauthed.state.activeTools.has("advisor"), false, "no resolvable model → no tool");
  });

  it("is a core module: a stale ceulen.disabled entry cannot switch it off", async () => {
    const { readDisabled } = await import("../../../lib/registry.js");
    assert.equal(readDisabled().includes("advisor"), false, "advisor is filtered out of the kill-switch list");
  });


  it("reads the legacy pi-advisor section at session_start, then migrates it on the first /config save", async () => {
    const { pi, state } = createFakePi();
    advisorModule(pi);
    writeSettings({ "pi-advisor": { models: [MODEL] } });
    const ctx = available(fakeCtx([]));
    await fire(pi, state, "session_start", ctx);
    assert.ok(state.activeTools.has("advisor"), "legacy chain still arms the advisor");

    const cmd = state.commands.get("advisor");
    cmd.handler("status", ctx);
    assert.match(ctx.notes.at(-1).message, /test\/advisor-model/, "status shows the legacy chain");

    // A /config save rewrites the section: legacy gone, `advisor` authoritative.
    const m = advisorConfig();
    m.groups()[0]!.rows[1]!.set("test/advisor-model");
    m.groups()[0]!.rows[5]!.set("6");
    await m.save(new Set(["advisor.watch.immuneTurns"]), ctx);
    const raw = readSettings();
    assert.equal(raw["pi-advisor"], undefined, "legacy section removed on save");
    assert.deepEqual(raw.advisor.models, [MODEL]);
    assert.equal(raw.advisor.watch.immuneTurns, 6);
    assert.equal(state.activeTools.has("advisor"), true, "still armed after the migration");
  });

  it("/config applies the review switch + chain to the live session (no /reload)", async () => {
    const { pi, state } = createFakePi();
    advisorModule(pi);
    writeSettings({ advisor: { models: [MODEL] } });
    const ctx = available(fakeCtx([]));
    await fire(pi, state, "session_start", ctx);

    // Turn the background review off from /config: no review, tool unaffected.
    let calls = 0;
    __setIsolatedForTest(async (_c, models) => { calls++; return { text: '{"severity":"nit","note":"live"}', model: models[0], usage: NO_USAGE }; });
    const m = advisorConfig();
    m.groups()[0]!.rows[0]!.set(false);
    await m.save(new Set(["advisor.enabled"]), ctx);
    await fire(pi, state, "agent_settled", step(available(fakeCtx(toolCalls(4))), "tui"));
    assert.equal(calls, 0, "review off stops the background review without a reload");
    assert.ok(state.activeTools.has("advisor"), "the consult tool stays registered — the review switch does not gate it");

    // Turn it back on with a fallback chain: reviews resume against the new chain.
    const m2 = advisorConfig();
    m2.groups()[0]!.rows[0]!.set(true);
    m2.groups()[0]!.rows[3]!.set("test/backup-model");
    await m2.save(new Set(["advisor.enabled", "advisor.fallbacks"]), ctx);
    assert.deepEqual(readSettings().advisor.models, [MODEL, "test/backup-model"]);
    await fire(pi, state, "agent_settled", step(available(fakeCtx(toolCalls(4))), "tui"));
    assert.equal(calls, 1, "review resumed after re-enabling");
  });

  it("/advisor on re-syncs tool availability after the model becomes available again", async () => {
    const { pi, state } = createFakePi();
    advisorModule(pi);
    writeSettings({ advisor: { models: [MODEL] } });
    // Registry starts EMPTY (auth dropped) → session_start's sync removes the tool.
    const ctx = fakeCtx([]);
    await fire(pi, state, "session_start", ctx);
    assert.equal(state.activeTools.has("advisor"), false, "tool hidden while no model resolves");

    // User re-auths (model now in the registry) and runs /advisor on —
    // enableWatch must re-sync, not just re-arm the watcher.
    available(ctx);
    const cmd = state.commands.get("advisor");
    await cmd.handler("on", ctx);
    assert.ok(state.activeTools.has("advisor"), "tool re-activated by /advisor on without waiting for session_start");
  });

  it("session_start(review off, no chain) + /config save enabling both reseeds the cursor (no history replay)", async () => {
    const { pi, state } = createFakePi();
    advisorModule(pi);
    writeSettings({ advisor: { enabled: false } });
    // Session opens with the review OFF and NO chain → runtime cursor stays undefined.
    let ctx = available(fakeCtx(toolCalls(4)));
    await fire(pi, state, "session_start", ctx);
    const rt = __getRuntimeForTest();
    assert.ok(rt, "runtime created for the session");
    assert.equal(rt!.cursor, undefined, "no chain + review off → nothing reviewed yet");
    assert.equal(rt!.models.length, 0, "no advisor model configured at start");

    // ONE /config save sets enabled:true AND the chain. The reseed must key on
    // the target watch state (willWatch), not on the not-yet-updated watchEnabled.
    const entries = toolCalls(4);
    ctx = available(fakeCtx(entries));
    const m = advisorConfig();
    m.groups()[0]!.rows[0]!.set(true);
    m.groups()[0]!.rows[1]!.set(MODEL);
    await m.save(new Set(["advisor.enabled", "advisor.model"]), ctx);

    assert.deepEqual(readSettings().advisor, { enabled: true, models: [MODEL], watch: { minToolCalls: 3, immuneTurns: 3 } }, "enabled + chain written in one save");
    assert.equal(rt!.cursor, entries.at(-1).id, "cursor reseeded to the transcript tail — the pre-existing history is not replayed");

    // And the watch actually reviews only NEW work: the settled turn adds
    // nothing, so the reseeded cursor leaves the existing 4 tool calls unseen.
    let calls = 0;
    __setIsolatedForTest(async (_c, models) => { calls++; return { text: "", model: models[0], usage: NO_USAGE }; });
    await fire(pi, state, "agent_settled", step(available(fakeCtx(entries)), "tui"));
    assert.equal(calls, 0, "nothing new since the reseed → no review of the pre-existing turn");
  });

  it("session_start(review off, chain configured) + enable-only save reseeds the cursor (no history replay)", async () => {
    // Live-found defect (reviewer 2026-10-06): the reseed keyed on the 0→N
    // chain transition, so enabling `Review settled turns` on a session that
    // STARTED with enabled:false + a configured chain left cursor undefined —
    // the first settled turn counted the ENTIRE session's tool calls and
    // reviewed the whole transcript. The reseed must key on first activation.
    const { pi, state } = createFakePi();
    advisorModule(pi);
    writeSettings({ advisor: { enabled: false, models: [MODEL] } });
    let ctx = available(fakeCtx(toolCalls(4)));
    await fire(pi, state, "session_start", ctx);
    const rt = __getRuntimeForTest();
    assert.ok(rt, "runtime created");
    assert.equal(rt!.models.length, 1, "chain was configured all along");
    assert.equal(rt!.cursor, undefined, "review off at start → cursor never seeded");

    // Enable ONLY the review — the chain is untouched.
    const entries = toolCalls(4);
    ctx = available(fakeCtx(entries));
    const m = advisorConfig();
    m.groups()[0]!.rows[0]!.set(true);
    await m.save(new Set(["advisor.enabled"]), ctx);

    assert.equal(rt!.cursor, entries.at(-1).id, "enable-only save reseeds to the tail — history is not replayed");

    let calls = 0;
    __setIsolatedForTest(async (_c, models) => { calls++; return { text: "", model: models[0], usage: NO_USAGE }; });
    await fire(pi, state, "agent_settled", step(available(fakeCtx(entries)), "tui"));
    assert.equal(calls, 0, "no new work since enable → no review");
  });
});

describe("advisor review flow", () => {
  const arm = async (settings: unknown = { advisor: { models: [MODEL] } }) => {
    const { pi, state } = createFakePi();
    advisorModule(pi);
    writeSettings(settings);
    await fire(pi, state, "session_start", available(fakeCtx([])));
    return { pi, state };
  };

  it("nit flow steers via sendUserMessage (accepted notes all trigger a turn at settle)", async () => {
    const { pi, state } = await arm();
    let isolatedCalled = false;
    __setIsolatedForTest(async (_ctx, models) => { isolatedCalled = true; return { text: '{"severity":"nit","note":"unused import in foo.ts"}', model: models[0], usage: NO_USAGE }; });
    await fire(pi, state, "agent_settled", step(available(fakeCtx(toolCalls(4))), "tui"));
    assert.ok(isolatedCalled, "review executed");
    assert.equal(state.sendMessageCalls, 0, "nit no longer goes through a non-interrupting sendMessage aside at settle");
    assert.equal(state.entries.length, 0, "nit is NOT a display-only appendEntry card");
    assert.equal(state.userMessages.length, 1, "nit triggers a follow-up turn (agent_settled is idle, no step boundary)");
  });

  it("concern steers via sendUserMessage and arms cooldown", async () => {
    const { pi, state } = await arm();
    __setIsolatedForTest(async (_ctx, models) => ({ text: '{"severity":"concern","note":"edit went to the wrong file"}', model: models[0], usage: NO_USAGE }));
    await fire(pi, state, "agent_settled", step(available(fakeCtx(toolCalls(4))), "tui"));
    assert.equal(state.userMessages.length, 1);
    assert.equal(state.userMessages[0].options.deliverAs, "followUp");
    assert.equal(state.entries.length, 0, "concern is a steer, not a card");
  });

  it("agent_settled does not block on the review (fire-and-forget)", async () => {
    const { pi, state } = await arm();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    __setIsolatedForTest(async (_ctx, models) => { await gate; return { text: '{"severity":"nit","note":"pending note"}', model: models[0], usage: NO_USAGE }; });
    await fire(pi, state, "agent_settled", step(available(fakeCtx(toolCalls(4))), "tui"));
    assert.equal(state.userMessages.length, 0, "handler returned while the review is still in flight");
    release();
    await new Promise((r) => setImmediate(r)); // drain the floating review
    assert.equal(state.userMessages.length, 1, "note delivered once the review finishes");
  });

  it("headless mode (print) skips the watch review entirely", async () => {
    const { pi, state } = await arm();
    let calls = 0;
    __setIsolatedForTest(async (_ctx, models) => { calls++; return { text: "", model: models[0], usage: NO_USAGE }; });
    await fire(pi, state, "agent_settled", fakeCtx(toolCalls(4))); // default fake mode is "print"
    assert.equal(calls, 0, "no review dispatched in print mode");
  });

  it("mode-less ctx is treated as headless (fail-safe skip)", async () => {
    const { pi, state } = await arm();
    let calls = 0;
    __setIsolatedForTest(async (_ctx, models) => { calls++; return { text: "", model: models[0], usage: NO_USAGE }; });
    const ctx = fakeCtx(toolCalls(4));
    delete ctx.mode;
    await fire(pi, state, "agent_settled", ctx);
    assert.equal(calls, 0, "no review dispatched without a known mode");
  });

  it("a review in flight across /new delivers nothing into the new session", async () => {
    const { pi, state } = await arm();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    __setIsolatedForTest(async (_ctx, models) => { await gate; return { text: '{"severity":"nit","note":"stale note"}', model: models[0], usage: NO_USAGE }; });
    await fire(pi, state, "session_start", available(fakeCtx([], "s1")));
    await fire(pi, state, "agent_settled", step(available(fakeCtx(toolCalls(4), "s1")), "tui"));
    assert.equal(state.userMessages.length, 0, "review still in flight");
    await fire(pi, state, "session_start", available(fakeCtx([], "s2"))); // /new — runtime replaced
    release();
    await fire(pi, state, "agent_settled", step(available(fakeCtx(toolCalls(4), "s2")), "tui"));
    assert.equal(state.userMessages.length, 1, "stale note dropped; new session's own review delivered");
  });

  it("before_agent_start injects the authority line only in tui", async () => {
    const { state } = await arm();
    const handler = state.eventHandlers.get("before_agent_start")[0];
    const evt = { systemPrompt: "base" };
    assert.equal(handler(evt, fakeCtx([])), undefined, "no authority line in headless modes");
    const out = handler(evt, { ...fakeCtx([]), mode: "tui" });
    assert.ok(out && out.systemPrompt.includes("Advisor notes:"), "authority line injected in tui");
    assert.ok(out.systemPrompt.startsWith("base\n\n"), "base prompt preserved");
    // Idempotent: an already-injected prompt is left alone.
    assert.equal(handler({ systemPrompt: out.systemPrompt }, { ...fakeCtx([]), mode: "tui" }), undefined);
  });

  it("before_agent_start tolerates a missing systemPrompt (never returns a broken prompt)", async () => {
    const { state } = await arm();
    const handler = state.eventHandlers.get("before_agent_start")[0];
    const out = handler({}, { ...fakeCtx([]), mode: "tui" });
    assert.ok(out.systemPrompt.startsWith("Advisor notes:"), "no stray leading blank lines");
  });

  it("session_shutdown disarms an in-flight review (silent discard, no toast)", async () => {
    const { pi, state } = await arm();
    const ctx = step(available(fakeCtx(toolCalls(4))), "tui");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    __setIsolatedForTest(async (_c, models) => { await gate; return { text: '{"severity":"nit","note":"late note"}', model: models[0], usage: NO_USAGE }; });
    await fire(pi, state, "agent_settled", ctx);
    await fire(pi, state, "session_shutdown", ctx); // SDK teardown — awaited before invalidation
    release();
    await new Promise((r) => setImmediate(r));
    assert.equal(state.userMessages.length, 0, "no delivery after teardown");
    assert.equal(ctx.notes.length, 0, "no spurious error toast in the replaced session");
  });

  it("a delivery-time throw while live is caught and reported (no unhandled rejection)", async () => {
    const { pi, state } = await arm();
    const ctx = step(available(fakeCtx(toolCalls(4))), "tui");
    pi.sendUserMessage = () => { throw new Error("This extension ctx is stale"); };
    __setIsolatedForTest(async (_c, models) => ({ text: '{"severity":"nit","note":"boom note"}', model: models[0], usage: NO_USAGE }));
    await fire(pi, state, "agent_settled", ctx);
    assert.equal(state.userMessages.length, 0, "throwing delivery never recorded");
    assert.ok(ctx.notes.some((n: any) => n.message.includes("Advisor review failed")), "failure reported via notify while live");
  });

  it("/advisor off during an in-flight review suppresses delivery", async () => {
    const { pi, state } = await arm();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    __setIsolatedForTest(async (_ctx, models) => { await gate; return { text: '{"severity":"nit","note":"late note"}', model: models[0], usage: NO_USAGE }; });
    await fire(pi, state, "agent_settled", step(available(fakeCtx(toolCalls(4))), "tui"));
    const cmd = state.commands.get("advisor");
    await cmd.handler("off", available(fakeCtx([]))); // clears rt.models mid-flight
    release();
    await new Promise((r) => setImmediate(r));
    assert.equal(state.userMessages.length, 0, "a disabled watch must not fire a follow-up run");
    assert.equal(state.entries.length, 0, "and must not append a card");
  });

  it("skipped overlap returns before cursor advance (next review still counts those calls)", async () => {
    const { pi, state } = await arm();
    const base = toolCalls(4);
    const extra = [1, 2, 3, 4].map((i) => ({ type: "message", id: `x${i}`, parentId: "a4", timestamp: `${i}x`, message: { role: "assistant", content: [{ type: "toolCall", id: `xc${i}`, name: "read", arguments: {} }], timestamp: i } }));
    const extended = [...base, ...extra];
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    __setIsolatedForTest(async (_ctx, models) => { calls++; await gate; return { text: '{"severity":"nit","note":"n"}', model: models[0], usage: NO_USAGE }; });
    await fire(pi, state, "agent_settled", step(available(fakeCtx(base)), "tui"));
    assert.equal(calls, 1, "first review dispatched");
    await fire(pi, state, "agent_settled", step(available(fakeCtx(extended)), "tui"));
    assert.equal(calls, 1, "overlapped settle skipped while the first review is in flight");
    release();
    await new Promise((r) => setImmediate(r));
    await fire(pi, state, "agent_settled", step(available(fakeCtx(extended)), "tui"));
    assert.equal(calls, 2, "cursor untouched by the skipped settle — the +4 calls still trigger a review");
  });

  it("no advisor model → no review call at all", async () => {
    const { pi, state } = await arm({ advisor: {} });
    let calls = 0;
    __setIsolatedForTest(async () => { calls++; return { text: '{"severity":"nit","note":"x"}', model: "", usage: NO_USAGE }; });
    const ctx = available(fakeCtx(toolCalls(4)));
    await fire(pi, state, "agent_settled", step(ctx, "tui"));
    assert.equal(calls, 0, "no isolated call without a model");
    assert.equal(state.entries.length, 0);
  });

  it("the 3-strike pause notice reaches the user exactly once through the real wiring", async () => {
    const { pi, state } = await arm({ advisor: { models: [MODEL], watch: { minToolCalls: 0, immuneTurns: 1 } } });
    __setIsolatedForTest(async () => { throw new Error("429 rate limited"); });
    const base = toolCalls(1);
    const ctx = step(available(fakeCtx(base)), "tui");
    // Three consecutive failing reviews — each its own settled turn with new work.
    for (const extra of [toolCalls(1), toolCalls(1), toolCalls(1)]) {
      ctx.sessionManager = { ...ctx.sessionManager, getEntries: () => [...base, ...extra] };
      await fire(pi, state, "agent_settled", ctx);
    }
    const pause = ctx.notes.filter((n: any) => n.message.includes("Advisor watch paused"));
    assert.equal(pause.length, 1, "the pause toast lands (previously dead code behind the paused flag)");
    assert.equal(pause[0].level, "error", "delivered as an error toast");
    assert.equal(__getRuntimeForTest()!.stats.paused, true, "the watch is still paused");
    assert.equal(state.userMessages.length, 0, "no note delivered by the failed reviews");

    // Paused means NO further reviews until /advisor on — the next turn skips.
    let calls = 0;
    __setIsolatedForTest(async (_c, models) => { calls++; return { text: "", model: models[0], usage: NO_USAGE }; });
    ctx.sessionManager = { ...ctx.sessionManager, getEntries: () => [...base, ...toolCalls(1), ...toolCalls(1)] };
    await fire(pi, state, "agent_settled", ctx);
    assert.equal(calls, 0, "paused watch issues no further review");

    // …and /advisor on resumes, as the notice promises: no duplicate toast.
    await state.commands.get("advisor").handler("on", ctx);
    assert.equal(__getRuntimeForTest()!.stats.paused, false, "resumed");
    await fire(pi, state, "agent_settled", ctx);
    assert.equal(calls, 1, "reviews resume after /advisor on");
    assert.equal(ctx.notes.filter((n: any) => n.message.includes("Advisor watch paused")).length, 1, "still exactly one pause notice");
  });
});

describe("/advisor command surface", () => {
  const setup = async () => {
    const { pi, state } = createFakePi();
    advisorModule(pi);
    writeSettings({ advisor: {} });
    const ctx = available(fakeCtx([]));
    ctx.modelRegistry.getAvailable = () => [
      { provider: "p", id: "m1", contextWindow: 8_000 },
      { provider: "p", id: "m2", contextWindow: 8_000 },
    ];
    await fire(pi, state, "session_start", ctx);
    return { pi, state, ctx, cmd: state.commands.get("advisor") };
  };

  it("offers keywords ahead of models, filtered by prefix", async () => {
    const { cmd, ctx } = await setup();
    const all = cmd.getArgumentCompletions("");
    const values = all.map((i: any) => i.value);
    for (const kw of ["on", "off", "status", "models", "watch-off"]) {
      assert.ok(values.includes(kw), `keyword ${kw} offered at empty prefix`);
      assert.ok(values.indexOf(kw) < values.findIndex((v: string) => v.includes("/")), `keyword ${kw} sorts before model items`);
    }
    const o = cmd.getArgumentCompletions("o").map((i: any) => i.value);
    assert.ok(o.includes("on") && o.includes("off"), "keywords survive prefix filtering");
    assert.ok(!o.includes("status"), "non-matching keyword filtered out");
    assert.equal(cmd.getArgumentCompletions("zzz"), null, "no matches → null (popup suppressed)");
    assert.equal(ctx.notes.length, 0, "completion never notifies");
  });

  it("status reports the review state, watch state, chain, tool and counters", async () => {
    const { cmd, ctx } = await setup();
    cmd.handler("status", ctx);
    const text = ctx.notes.at(-1).message;
    assert.match(text, /Advisor: review on \(settings\) · watch on/);
    assert.match(text, /Models: \(unset — advisor inactive\)/);
    assert.match(text, /consult tool off/, "no chain → no consult tool");
    assert.match(text, /Edit the chain in \/config → Model → Advisor/);
  });

  it("a chain argument persists to the `advisor` section and arms the live runtime", async () => {
    const { cmd, ctx } = await setup();
    await cmd.handler("p/m1, p/m2", ctx);
    assert.deepEqual(readSettings().advisor.models, ["p/m1", "p/m2"]);
    cmd.handler("status", ctx);
    assert.match(ctx.notes.at(-1).message, /Models: p\/m1 → p\/m2/);
    // completion after a comma carries the typed head (kernel replaces the whole argument)
    const comps = cmd.getArgumentCompletions("p/m1,").map((i: any) => i.value);
    assert.deepEqual(comps, ["p/m1, p/m1", "p/m1, p/m2"], "post-comma completion preserves the typed prefix");
  });

  it("trailing comma is a single model, not an explicit chain; canonicalized duplicates dedupe", async () => {
    const { cmd, ctx } = await setup();
    await cmd.handler("p/m9,", ctx);
    assert.equal(ctx.notes.at(-1).level, "warning", "unresolvable bare hint → remediation notify, not a throw");
    assert.match(ctx.notes.at(-1).message, /No model matches/);
    await cmd.handler("p/m1, m1", ctx);
    assert.deepEqual(readSettings().advisor.models, ["p/m1"], "canonicalized duplicates removed at the call site");
  });

  it("/advisor models and a bare /advisor notify instead of polluting LLM context", async () => {
    const { cmd, ctx, state } = await setup();
    await cmd.handler("p/m1", ctx);
    cmd.handler("models", ctx);
    assert.match(ctx.notes.at(-1).message, /ordered fallback/);
    cmd.handler("", ctx);
    assert.match(ctx.notes.at(-1).message, /Models: p\/m1/);
    assert.equal(state.sendMessageCalls, 0, "status output never enters the LLM context");
  });

  it("on with no chain warns; watch-off flips only the session flag", async () => {
    const { cmd, ctx } = await setup();
    cmd.handler("on", ctx);
    assert.equal(ctx.notes.at(-1).level, "warning", "no chain → cannot enable");
    await cmd.handler("p/m1", ctx);
    cmd.handler("watch-off", ctx);
    assert.match(ctx.notes.at(-1).message, /watch disabled for this session/);
    cmd.handler("status", ctx);
    assert.match(ctx.notes.at(-1).message, /watch off/);
    assert.deepEqual(readSettings().advisor.models, ["p/m1"], "watch-off never rewrites the chain");
  });

  it("parseChainArgument trims, drops blanks, and dedupes chain entries", async () => {
    const { parseChainArgument } = await import("../commands/advisor.js");
    assert.deepEqual(parseChainArgument(" a/b , c/d ,, "), ["a/b", "c/d"]);
    assert.deepEqual(parseChainArgument("a/b"), ["a/b"]);
    assert.deepEqual(parseChainArgument(""), []);
    assert.deepEqual(parseChainArgument("a/b, a/b"), ["a/b"]);
  });

  it("chain edits from the command migrate the legacy section too", async () => {
    const { pi, state } = createFakePi();
    advisorModule(pi);
    writeSettings({ "pi-advisor": { models: ["p/m1"] } });
    const ctx = available(fakeCtx([]));
    ctx.modelRegistry.getAvailable = () => [{ provider: "p", id: "m2", contextWindow: 8_000 }];
    await fire(pi, state, "session_start", ctx);
    await state.commands.get("advisor").handler("p/m2", ctx);
    const raw = readSettings();
    assert.equal(raw["pi-advisor"], undefined);
    assert.deepEqual(raw.advisor.models, ["p/m2"]);
  });

  it("status reports cumulative advisor usage", async () => {
    const { pi, state } = createFakePi();
    advisorModule(pi);
    writeSettings({ advisor: { models: [MODEL], watch: { minToolCalls: 0, immuneTurns: 1 } } });
    const ctx = available(fakeCtx([]));
    await fire(pi, state, "session_start", ctx);
    let n = 0;
    __setIsolatedForTest(async (_c, models) => {
      n++;
      return { text: "", model: models[0] ?? "", usage: { input: 1000, output: 100, cacheRead: 0, totalTokens: 1100, cost: 0.0025 } };
    });
    await fire(pi, state, "agent_settled", step(available(fakeCtx(toolCalls(1))), "tui"));
    await fire(pi, state, "agent_settled", step(available(fakeCtx([...toolCalls(1), ...toolCalls(1)])), "tui"));
    cmdStatus(state, ctx);
    const text = ctx.notes.at(-1).message;
    assert.match(text, /Advisor usage: 2K in \/ 200 out · \$0\.0050 across 2 reviews/);
  });

  it("session_compact reseeds the cursor and clears the guard", async () => {
    const { pi, state } = createFakePi();
    advisorModule(pi);
    writeSettings({ advisor: { models: [MODEL], watch: { minToolCalls: 0, immuneTurns: 1 } } });
    const entries = toolCalls(1);
    const ctx = available(fakeCtx(entries));
    ctx.mode = "tui";
    await fire(pi, state, "session_start", ctx);
    __setIsolatedForTest(async (_c, models) => ({ text: '{"severity":"nit","note":"first note"}', model: models[0], usage: NO_USAGE }));
    await fire(pi, state, "agent_settled", step(ctx, "tui"));
    assert.equal(state.userMessages.length, 1, "first note steers");

    // Same note text again: the guard dedupes it (no second steer)…
    await fire(pi, state, "agent_settled", step(available(fakeCtx([...entries, ...toolCalls(1)])), "tui"));
    assert.equal(state.userMessages.length, 1, "identical note deduped while the guard remembers it");

    // …compaction rewrites the transcript: cursor reseeds to the NEW tail and
    // the guard resets, so the reviewer can re-raise against the new context.
    const compacted = toolCalls(2);
    const ctx2 = available(fakeCtx(compacted));
    ctx2.mode = "tui";
    await fire(pi, state, "session_compact", ctx2);
    // cursor now points at the compacted tail: a settled turn adds one more
    // tool call → minToolCalls 0 review runs again, and the SAME note is
    // accepted because the guard was cleared (omp: re-primed reviewer may
    // re-raise against the rewritten transcript).
    await fire(pi, state, "agent_settled", step(available(fakeCtx([...compacted, ...toolCalls(1)])), "tui"));
    assert.equal(state.userMessages.length, 2, "same note accepted again after the compaction reset");
  });

  it("a rewrite event from a replaced session does not touch the live runtime", async () => {
    const { pi, state } = createFakePi();
    advisorModule(pi);
    writeSettings({ advisor: { models: [MODEL], watch: { minToolCalls: 0, immuneTurns: 1 } } });
    const ctx = available(fakeCtx(toolCalls(1)));
    ctx.mode = "tui";
    await fire(pi, state, "session_start", ctx);
    __setIsolatedForTest(async (_c, models) => ({ text: '{"severity":"nit","note":"n1"}', model: models[0], usage: NO_USAGE }));
    await fire(pi, state, "agent_settled", step(ctx, "tui"));
    assert.equal(state.userMessages.length, 1);

    // A rewrite event carrying a DIFFERENT session id (stale ctx racing the
    // replacement) must be ignored: the guard survives so the duplicate below
    // is still deduped.
    const stale = available(fakeCtx(toolCalls(1)), false);
    stale.mode = "tui";
    stale.sessionManager = { ...stale.sessionManager, getSessionId: () => "replaced-session" };
    await fire(pi, state, "session_compact", stale);
    await fire(pi, state, "agent_settled", step(available(fakeCtx([...toolCalls(1), ...toolCalls(1)])), "tui"));
    assert.equal(state.userMessages.length, 1, "stale rewrite event did not reset the guard");
  });
});

describe("writeAdvisorSettings integration", () => {
  it("a direct write is picked up by the next session_start", async () => {
    const { pi, state } = createFakePi();
    advisorModule(pi);
    writeAdvisorSettings({ enabled: true, models: [MODEL], watch: { minToolCalls: 0, immuneTurns: 1 } });
    const ctx = available(fakeCtx([]));
    await fire(pi, state, "session_start", ctx);
    assert.ok(state.activeTools.has("advisor"));
    let calls = 0;
    __setIsolatedForTest(async () => { calls++; return { text: "", model: MODEL, usage: NO_USAGE }; });
    await fire(pi, state, "agent_settled", step(available(fakeCtx(toolCalls(1))), "tui"));
    assert.equal(calls, 1, "minToolCalls 0 reviews even a single-tool turn");
    cmdStatus(state, ctx);
    assert.match(ctx.notes.at(-1).message, /minToolCalls=0 immuneTurns=1/, "watch knobs reach the runtime");
  });
});

function cmdStatus(state: any, ctx: any): void {
  state.commands.get("advisor").handler("status", ctx);
}
