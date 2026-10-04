/**
 * todo module tests — the state machine, persistence rehydrate, and the
 * footer indicator. Untyped harness stub: only the pi surface the module
 * touches (usage/ponytail test tradition).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import todoModule, {
  TODO_ENTRY_TYPE,
  TODO_STATUS_KEY,
  applyTodo,
  resolveTodoPhases,
  statusLine,
  type TodoPhase,
} from "../index.ts";

type Params = Parameters<typeof applyTodo>[1];
const op = (o: Record<string, unknown>) => o as unknown as Params;

/** Apply an action to a list and return the resulting phases (throws on error). */
function run(current: TodoPhase[], params: Record<string, unknown>): TodoPhase[] {
  const r = applyTodo(current, op(params));
  assert.deepEqual(r.errors, [], `unexpected errors: ${r.errors}`);
  return r.phases;
}
function fail(current: TodoPhase[], params: Record<string, unknown>): string[] {
  const r = applyTodo(current, op(params));
  assert.ok(r.errors.length > 0, "expected an error");
  assert.equal(r.changed, false);
  return r.errors;
}

const seeded = () =>
  run([], {
    action: "init",
    phases: [{ title: "Read the repo" }, { title: "Port the tool" }, { title: "Verify" }],
  });

function createPiHarness() {
  const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, unknown>();
  const tools = new Map<string, any>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  let branchEntries: unknown[] = [];
  const statusCalls: Array<[string, string | undefined]> = [];
  const notifications: string[] = [];

  const ui = {
    notify: (m: string) => { notifications.push(m); },
    setStatus: (k: string, t: string | undefined) => { statusCalls.push([k, t]); },
  };
  const ctx = { ui, sessionManager: { getBranch: () => branchEntries } };

  const pi = {
    on: (n: string, h: any) => { events.set(n, h); },
    registerTool: (t: any) => { tools.set(t.name, t); },
    registerCommand: (n: string, o: any) => { commands.set(n, o); },
    appendEntry: (customType: string, data: unknown) => { entries.push({ customType, data }); },
  };
  todoModule(pi as never);

  return {
    events, commands, tools, entries, statusCalls, notifications, ui, ctx,
    setBranch: (e: unknown[]) => { branchEntries = e; },
    /** Fire the tool with params through the real execute() path. */
    call: (params: Record<string, unknown>) => tools.get("todo").execute("call-1", op(params), undefined, undefined, ctx),
  };
}

describe("todo state machine", () => {
  it("init assigns stable ids, replaces the whole list, and auto-starts the first phase", () => {
    const phases = seeded();
    assert.deepEqual(phases.map((p) => [p.id, p.status]), [["p1", "in_progress"], ["p2", "pending"], ["p3", "pending"]]);
    const replaced = run(phases, { action: "init", phases: [{ id: "a", title: "Only" }] });
    assert.deepEqual(replaced.map((p) => p.id), ["a"]);
  });

  it("start marks in_progress; a second start ERRORS while one is running", () => {
    // seeded() already auto-started p1 — p2 must be forced.
    assert.match(fail(seeded(), { action: "start", id: "p2" })[0], /already in_progress/);
    const forced = run(seeded(), { action: "start", id: "p2", force: true });
    assert.deepEqual(forced.map((p) => p.status), ["pending", "in_progress", "pending"]);
    // An explicit start that finishes the running phase advances the pointer by itself.
    assert.equal(run(seeded(), { action: "done", id: "p1" })[1].status, "in_progress");
  });

  it("done marks done (idempotent) and never reopens a finished phase", () => {
    const done = run(run(seeded(), { action: "done", id: "p1" }), { action: "done", id: "p3" });
    // p2 auto-started when p1 completed; the out-of-order done of p3 leaves it running.
    assert.deepEqual(done.map((p) => p.status), ["done", "in_progress", "done"]);
    assert.equal(run(done, { action: "done", id: "p3" })[2].status, "done", "done of already-done stays done");
  });

  it("block/unblock set blockedBy; a blocked phase is skipped by the pointer", () => {
    // p2 waits on p3 — a blocker that stays UNMET after p1 completes.
    const blocked = run(seeded(), { action: "block", id: "p2", blockedBy: ["p3"] });
    assert.deepEqual(blocked[1].blockedBy, ["p3"]);

    // p1 completes → the pointer must SKIP blocked p2 and land on p3.
    const advanced = run(blocked, { action: "done", id: "p1" });
    assert.deepEqual(advanced.map((p) => p.status), ["done", "pending", "in_progress"]);
    assert.equal(statusLine(advanced), "▸ 1/3 done · in_progress: Verify · 1 blocked");

    // A met blocker unblocks the phase — but never steals a running pointer.
    const unblocked = run(blocked, { action: "unblock", id: "p2" });
    assert.deepEqual(unblocked[1].blockedBy, []);
    const partial = run(run(blocked, { action: "block", id: "p2", blockedBy: ["p1"] }), { action: "unblock", id: "p2", blockedBy: ["p3"] });
    assert.deepEqual(partial[1].blockedBy, ["p1"], "unblock drops only the named edge");
  });

  it("append adds one phase with a fresh id and rejects duplicates", () => {
    const appended = run(seeded(), { action: "append", phases: [{ title: "Ship it" }] });
    assert.deepEqual(appended.map((p) => p.id), ["p1", "p2", "p3", "p4"]);
    assert.match(fail(appended, { action: "append", phases: [{ title: "Ship it" }] })[0], /already exists/);
  });

  it("rm removes a phase (and its dangling blocker edges), or clears the list", () => {
    const blocked = run(seeded(), { action: "block", id: "p3", blockedBy: ["p2"] });
    const removed = run(blocked, { action: "rm", id: "p2" });
    assert.deepEqual(removed.map((p) => p.id), ["p1", "p3"]);
    assert.deepEqual(removed[1].blockedBy, [], "the removed phase is no longer a blocker");
    assert.deepEqual(run(seeded(), { action: "rm" }), [], "rm without an id clears");
  });

  it("errors: unknown phase, block with no blocker, unknown blocker, self-block, duplicate ids", () => {
    const phases = seeded();
    assert.match(fail(phases, { action: "start", id: "nope" })[0], /not found/);
    assert.match(fail(phases, { action: "start" })[0], /Missing phase id/);
    assert.match(fail(phases, { action: "block", id: "p1" })[0], /needs blockedBy/);
    assert.match(fail(phases, { action: "block", id: "p1", blockedBy: ["ghost"] })[0], /not a phase in this list/);
    assert.match(fail(phases, { action: "block", id: "p1", blockedBy: ["p1"] })[0], /cannot block itself/);
    assert.match(fail(phases, { action: "init", phases: [{ id: "x", title: "A" }, { id: "x", title: "B" }] })[0], /Duplicate phase id/);
    assert.match(fail(phases, { action: "init", phases: [{ title: "A", blockedBy: ["zz"] }] })[0], /unknown phase "zz"/);
  });

  it("view never changes the list", () => {
    const phases = seeded();
    const r = applyTodo(phases, op({ action: "view" }));
    assert.deepEqual(r.errors, []);
    assert.equal(r.changed, false);
    assert.deepEqual(r.phases, phases);
  });
});

describe("status indicator text", () => {
  it("counts done/total, names the running phase, and clears when done", () => {
    assert.equal(statusLine([]), undefined, "empty list → cleared");
    assert.equal(statusLine(seeded()), "▸ 0/3 done · in_progress: Read the repo");
    const allDone = run(run(run(seeded(), { action: "done", id: "p1" }), { action: "done", id: "p2" }), { action: "done", id: "p3" });
    assert.equal(statusLine(allDone), undefined, "all done → cleared");
    // A list whose remaining phases are all blocked names no pointer.
    const blocked = run(run(seeded(), { action: "block", id: "p1", blockedBy: ["p2"] }), { action: "block", id: "p2", blockedBy: ["p3"] });
    assert.equal(statusLine(blocked), "▸ 0/3 done · next: Verify · 2 blocked");
  });
});

describe("module wiring", () => {
  it("registers one tool and one command", () => {
    const h = createPiHarness();
    assert.deepEqual([...h.tools.keys()], ["todo"]);
    assert.deepEqual([...h.commands.keys()], ["todo"]);
  });

  it("persists to ceulen-todo on every mutation, never on view", async () => {
    const h = createPiHarness();
    await h.call({ action: "init", phases: [{ title: "One" }, { title: "Two" }] });
    await h.call({ action: "view" });
    await h.call({ action: "done", id: "p1" });
    assert.deepEqual(h.entries.map((e) => e.customType), [TODO_ENTRY_TYPE, TODO_ENTRY_TYPE]);
    assert.deepEqual((h.entries[1].data as any).phases.map((p: TodoPhase) => p.status), ["done", "in_progress"]);
  });

  it("a failed op keeps the previous state and reports it as an error", async () => {
    const h = createPiHarness();
    await h.call({ action: "init", phases: [{ title: "One" }] });
    const before = h.entries.length;
    const r = await h.call({ action: "start", id: "ghost" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /not found/);
    assert.match(r.content[0].text, /\[p1\] One/, "the board stays at the previous state");
    assert.equal(h.entries.length, before, "no persistence on error");
  });

  it("mutating results restate the batch contract; a view does not", async () => {
    const h = createPiHarness();
    const init = await h.call({ action: "init", phases: [{ title: "One" }] });
    assert.match(init.content[0].text, /never call todo alone/);
    assert.match(init.content[0].text, /1\. ▸ \[p1\] One/, "the board renders glyph + id + title");
    const view = await h.call({ action: "view" });
    assert.doesNotMatch(view.content[0].text, /never call todo alone/);
  });

  it("the tool carries the batch contract as guidelines", () => {
    const h = createPiHarness();
    const guidelines: string[] = h.tools.get("todo").promptGuidelines;
    assert.ok(guidelines.some((g) => /NEVER call todo alone/.test(g)));
    assert.ok(guidelines.some((g) => /init alongside the FIRST work call/.test(g)));
    assert.ok(guidelines.some((g) => /SAME call that starts the next action/.test(g)));
  });

  it("sets the footer indicator on mutation and clears it on shutdown", async () => {
    const h = createPiHarness();
    await h.call({ action: "init", phases: [{ title: "One" }] });
    assert.deepEqual(h.statusCalls.at(-1), [TODO_STATUS_KEY, "▸ 0/1 done · in_progress: One"]);
    await h.call({ action: "done", id: "p1" });
    assert.deepEqual(h.statusCalls.at(-1), [TODO_STATUS_KEY, undefined], "all done → cleared");
    await h.events.get("session_shutdown")!({}, h.ctx);
    assert.deepEqual(h.statusCalls.at(-1), [TODO_STATUS_KEY, undefined]);
  });

  it("rehydrates the LAST ceulen-todo entry on session_start", async () => {
    const h = createPiHarness();
    h.setBranch([
      { type: "message" },
      { type: "custom", customType: TODO_ENTRY_TYPE, data: { phases: [{ id: "old", title: "Stale", status: "pending", blockedBy: [] }] } },
      { type: "custom", customType: "other-entry", data: {} },
      { type: "custom", customType: TODO_ENTRY_TYPE, data: { phases: [{ id: "a", title: "Resumed", status: "in_progress", blockedBy: [] }] } },
    ]);
    await h.events.get("session_start")!({}, h.ctx);
    assert.deepEqual(h.statusCalls.at(-1), [TODO_STATUS_KEY, "▸ 0/1 done · in_progress: Resumed"]);
    await h.call({ action: "done", id: "a" });
    assert.deepEqual((h.entries.at(-1)!.data as any).phases[0].title, "Resumed");
  });

  it("resolveTodoPhases ignores malformed entries and unknown customTypes", () => {
    assert.deepEqual(resolveTodoPhases(undefined), []);
    assert.deepEqual(resolveTodoPhases([{ type: "custom", customType: "other", data: { phases: [{ id: "x", title: "y", status: "pending", blockedBy: [] }] } }]), []);
    // Junk entries without a phases array are skipped, not fatal.
    assert.deepEqual(
      resolveTodoPhases([{ type: "custom", customType: TODO_ENTRY_TYPE, data: {} }, { type: "custom", customType: TODO_ENTRY_TYPE, data: { phases: [{ id: "a", title: "Good", status: "pending", blockedBy: [], junk: 1 }] } }]).map((p) => p.id),
      ["a"],
    );
  });
});

describe("/todo command", () => {
  it("bare prints the board, unknown warns, clear resets", async () => {
    const h = createPiHarness();
    await h.call({ action: "init", phases: [{ title: "One" }] });
    const cmd = h.commands.get("todo") as any;
    await cmd.handler("", h.ctx);
    assert.match(h.notifications.at(-1)!, /\[p1\] One/);
    await cmd.handler("bogus", h.ctx);
    assert.match(h.notifications.at(-1)!, /Unknown subcommand/);
    await cmd.handler("clear", h.ctx);
    assert.equal(h.notifications.at(-1), "Todo list cleared.");
    await cmd.handler("", h.ctx);
    assert.equal(h.notifications.at(-1), "Todo list is empty.");
  });
});
