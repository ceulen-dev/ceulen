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

  it("init/append reject a stored status:\"blocked\" — blocked is derived from blockedBy", () => {
    assert.match(fail([], { action: "init", phases: [{ title: "A", status: "blocked" }] })[0], /blockedBy/);
    const seeded2 = run([], { action: "init", phases: [{ title: "A" }] });
    assert.match(fail(seeded2, { action: "append", phases: [{ title: "B", status: "blocked" }] })[0], /blockedBy/);
    // Normal flows unchanged: blocking goes through blockedBy edges.
    const blocked = run(seeded(), { action: "block", id: "p1", blockedBy: ["p3"] });
    assert.deepEqual(blocked[0].blockedBy, ["p3"]);
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

// ---------------------------------------------------------------------------
// Themed renderers + HUD widget (lib/render.ts)
// ---------------------------------------------------------------------------

import { createTodoWidgetController, renderTodoBoard, renderTodoWidgetLines, type WidgetTheme } from "../lib/render.ts";

/** Recording theme shim — asserts colors by token, keeps text readable. */
function recTheme(): WidgetTheme & { tokens: string[] } {
  const tokens: string[] = [];
  return {
    tokens,
    fg: (color: string, text: string) => {
      tokens.push(color);
      return `<${color}>${text}</>`;
    },
    bold: (text: string) => `**${text}**`,
    strikethrough: (text: string) => `~~${text}~~`,
  };
}

const board = () => run([], { action: "init", phases: [{ title: "Read the repo" }, { title: "Port the tool" }, { title: "Verify" }] });

describe("renderTodoBoard (OMP look)", () => {
  it("colors by status: done success+strikethrough, current mdLink, pending muted, blocked warning", () => {
    const t = recTheme();
    const phases = board();
    mark(phases, "p1", "done");
    mark(phases, "p2", "in_progress");
    mark(phases, "p3", "blocked", ["p2"]);
    const lines = renderTodoBoard(phases, t);
    // Nested-tree geometry (OMP): rows indent under an implied head with their
    // own connectors; a done row's connector lights accent (the progress path).
    assert.match(lines[0]!, /<accent>    ├─ <\/><success>☑<\/> <success>~~Read the repo~~<\/>/);
    assert.match(lines[1]!, /<dim>    ├─ <\/><mdLink>☐<\/> <mdLink>Port the tool<\/>/);
    assert.match(lines[2]!, /<dim>    └─ <\/><dim>☐<\/> <warning>Verify<\/><dim> \(blocked by p2\)<\/>/);
    assert.ok(t.tokens.includes("success") && t.tokens.includes("mdLink") && t.tokens.includes("warning"));
  });

  it("done rows STAY VISIBLE with success + strikethrough (OMP parity — no omission in the full board)", () => {
    const t = recTheme();
    const phases = board();
    mark(phases, "p1", "done");
    const lines = renderTodoBoard(phases, t);
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /~~Read the repo~~/);
  });

  it("blocked tail lists unmet blockers only, notes ride the dim tail", () => {
    const t = recTheme();
    const phases = run([], { action: "init", phases: [{ id: "a", title: "One", notes: "check npm test" }, { id: "b", title: "Two", blockedBy: ["a"] }] });
    const lines = renderTodoBoard(phases, t);
    assert.match(lines[1]!, /\(blocked by a\)/);
    assert.match(lines[0]!, /\(check npm test\)/);
    // a satisfied → the dependent shows open (unmet-only rule)
    mark(phases, "a", "done");
    assert.match(renderTodoBoard(phases, t)[1]!, /<dim>Two<\/>$/);
  });

  it("without a theme the board is plain text (no ANSI)", () => {
    const lines = renderTodoBoard(board());
    for (const line of lines) assert.ok(!line.includes("\u001b") && !line.includes("<"), line);
    assert.match(lines[0]!, /   ├─ ☐ Read the repo/);
  });

  it("long titles truncate to width", () => {
    const long = "x".repeat(200);
    const phases = run([], { action: "init", phases: [{ title: long }] });
    const lines = renderTodoBoard(phases, undefined, 40);
    assert.ok(lines[0]!.length <= 40 + 40, `len=${lines[0]!.length}`);
  });
});

describe("renderTodoWidgetLines (OMP look)", () => {
  it("header TODO + group head Tasks · done/total; done rows stay, current mdLink", () => {
    const t = recTheme();
    const phases = board();
    mark(phases, "p1", "done");
    mark(phases, "p2", "in_progress");
    const lines = renderTodoWidgetLines(phases, t);
    assert.match(lines[0]!, /<accent>\*\*TODO\*\*<\/>/);
    assert.match(lines[1]!, /^ <dim>└─ <\/><mdLink>\*\*Tasks\*\*<\/><dim> · 1\/3<\/>/);
    // Done rows stay visible (OMP parity), current phase drawn in mdLink.
    assert.match(lines[2]!, /<success>☑<\/> <success>~~Read the repo~~<\/>/);
    assert.match(lines[3]!, /<mdLink>☐<\/> <mdLink>Port the tool<\/>/);
    assert.match(lines[4]!, /<dim>Verify<\/>/);
  });

  it("caps the window at 5 open phases with a + n more tail", () => {
    const phases = run([], { action: "init", phases: Array.from({ length: 8 }, (_, i) => ({ title: `Phase ${i + 1}` })) });
    const lines = renderTodoWidgetLines(phases, recTheme());
    const body = lines.filter((l) => /☐/.test(l));
    assert.equal(body.length, 5);
    assert.match(lines.at(-1)!, /\+ 3 more phases/);
  });

  it("done phases auto-unblock dependents (real blockedBy edge, not the title)", () => {
    // Regression: a drill init once put "blocked by p5" only in the TITLE —
    // the dependent then auto-started while its blocker was still pending.
    const r = run([], {
      action: "init",
      phases: [
        { title: "A" },
        { title: "B", blockedBy: ["p1"] },
      ],
    });
    assert.ok(r[1]!.status === "pending", "dependent must not auto-start");
    assert.equal(r[1]!.blockedBy[0], "p1");
    const after = run(r, { action: "done", id: "p1" });
    assert.ok(after[1]!.status === "in_progress", "finishing the blocker auto-starts the dependent");
  });

  it("all-done renders the closure view: every phase checked green, counts on the group head", () => {
    const t = recTheme();
    const phases = board();
    for (const p of phases) p.status = "done";
    const lines = renderTodoWidgetLines(phases, t);
    assert.match(lines[1]!, /<dim> · 3\/3<\/>/);
    // All-done: the whole path is lit (head + connectors accent) — OMP's
    // completed-tree look from the user's screenshot.
    assert.match(lines[1]!, /^ <accent>└─ <\/>/);
    assert.match(lines[2]!, /<accent>    ├─ <\/><success>☑<\/>/);
    assert.equal(lines.filter((l) => /☑/.test(l)).length, 3);
    assert.ok(lines.every((l) => !l.includes("▸ ")), "no footer fraction line (counts moved to the head)");
  });

  it("empty list renders nothing", () => {
    assert.deepEqual(renderTodoWidgetLines([], recTheme()), []);
  });
});

describe("todo HUD widget controller", () => {
  interface WidgetCall { content: unknown }
  function harness() {
    const widgets: WidgetCall[] = [];
    const ui: any = {
      setWidget: (key: string, content: unknown) => widgets.push({ content }),
      setStatus: () => {},
    };
    const ctx = { mode: "tui", ui };
    const ctl = createTodoWidgetController();
    return { widgets, ui, ctx, ctl };
  }

  it("installs on first open work, re-renders on change, headless is a no-op", () => {
    const h = harness();
    const live = board();
    h.ctl.sync(h.ctx, live, 60, () => live);
    assert.equal(h.widgets.length, 1, "widget installed once");
    const factory = h.widgets[0]!.content as any;
    assert.equal(typeof factory, "function", "component-factory form (theme-aware)");
    // Re-render through the factory: captures theme, renders lines.
    let renders = 0;
    const comp = factory({ requestRender: () => renders++ }, recTheme());
    const lines: string[] = comp.render(120);
    assert.match(lines[0]!, /TODO/);
    h.ctl.sync(h.ctx, live, 60, () => live);
    assert.equal(h.widgets.length, 1, "already installed → requestRender, not re-set");
    assert.ok(renders >= 1);
    // Headless: nothing installs.
    const headless = harness();
    headless.ctl.sync({ mode: "rpc", ui: headless.ui } as any, board(), 60);
    assert.equal(headless.widgets.length, 0);
  });

  it("re-renders draw CURRENT state, not the install-time snapshot (live-caught stale closure)", () => {
    const h = harness();
    const live = board(); // 3 phases, p1 auto-started
    h.ctl.sync(h.ctx, live, 60, () => live);
    const comp = (h.widgets[0]!.content as any)({ requestRender: () => {} }, recTheme());
    assert.match(comp.render(120).join("\n"), /\*\*Tasks\*\*<\/><dim> · 0\/3<\/>/);
    assert.ok(!/· 3\/3/.test(comp.render(120).join("\n")), "open board while work remains");
    // Mutate the SAME array (module state) and re-sync: render must reflect it.
    for (const p of live) p.status = "done";
    h.ctl.sync(h.ctx, live, 60, () => live);
    const after = comp.render(120).join("\n");
    assert.match(after, /Tasks[^\n]*3\/3/, "group-head counts update after mutation");
    assert.equal((after.match(/☑/g) ?? []).length, 3, "all rows checked in the completion view");
    // Also without an explicit getPhases: sync swaps the internal view.
    const h2 = harness();
    const first = board();
    h2.ctl.sync(h2.ctx, first, 60);
    const comp2 = (h2.widgets[0]!.content as any)({ requestRender: () => {} }, recTheme());
    const done = board();
    for (const p of done) p.status = "done";
    h2.ctl.sync(h2.ctx, done, 60);
    assert.match(comp2.render(120).join("\n"), /· 3\/3/);
    assert.equal((comp2.render(120).join("\n").match(/☑/g) ?? []).length, 3);
  });

  it("all-done with linger 0 clears the widget instantly; -1 never arms the timer", () => {
    const done = () => { const p = board(); for (const x of p) x.status = "done"; return p; };
    const instant = harness();
    instant.ctl.sync(instant.ctx, board(), 60);
    instant.ctl.sync(instant.ctx, done(), 0);
    assert.equal((instant.widgets.at(-1)!.content as any), undefined, "linger 0 → removed");
    assert.equal(instant.ctl.lingerArmed(), false);

    const never = harness();
    never.ctl.sync(never.ctx, board(), 60);
    never.ctl.sync(never.ctx, done(), -1);
    assert.equal(never.widgets.length, 1, "linger -1 → widget stays");
    assert.equal(never.ctl.lingerArmed(), false, "no timer armed");
  });

  it("a new mutation after all-done cancels the pending linger (generation guard)", () => {
    const done = () => { const p = board(); for (const x of p) x.status = "done"; return p; };
    const h = harness();
    h.ctl.sync(h.ctx, done(), 1); // arms a 1s timer
    assert.ok(h.ctl.lingerArmed(), "timer armed");
    h.ctl.sync(h.ctx, board(), 60); // new work before it fires
    assert.equal(h.ctl.lingerArmed(), false, "timer canceled by newer sync");
    assert.equal(h.widgets.length, 1, "widget re-used, not re-installed");
  });

  it("clear/dispose remove the widget; clear tolerates an unknown ui (stale ctx)", () => {
    const h = harness();
    h.ctl.sync(h.ctx, board(), 60);
    h.ctl.clear({ mode: "tui", ui: { setWidget: () => {} } as any });
    assert.equal((h.widgets.at(-1)!.content as any), undefined);
    h.ctl.sync(h.ctx, board(), 60);
    h.ctl.dispose();
    assert.equal((h.widgets.at(-1)!.content as any), undefined);
  });
});

// helpers used above
function mark(phases: TodoPhase[], id: string, status: TodoPhase["status"], blockedBy?: string[]): void {
  const hit = phases.find((p) => p.id === id)!;
  hit.status = status;
  if (blockedBy) hit.blockedBy = blockedBy;
}

describe("tool renderResult + config row", () => {
  it("renderResult draws the colored board from details.phases; falls back to the text blob", async () => {
    const h = createPiHarness();
    const tool = h.tools.get("todo");
    const theme = recTheme();
    // A mutation result carries phases in details → themed board.
    await h.call({ action: "init", phases: [{ title: "One" }] });
    const component = tool.renderResult(
      { content: [{ type: "text", text: "board" }], details: { phases: run([], { action: "init", phases: [{ title: "One" }] }) } },
      { expanded: true, isPartial: false },
      theme,
      {} as never,
    );
    assert.match(component.render(120).join("\n"), /<mdLink>☐<\/> <mdLink>One<\/>/);
    // No phases (error path with junk details) → plain text passthrough.
    const fallback = tool.renderResult(
      { content: [{ type: "text", text: "✗ boom" }], details: {} },
      { expanded: true, isPartial: false },
      theme,
      {} as never,
    );
    assert.match(fallback.render(120).join("\n"), /^✗ boom\s*$/);
  });

  it("the /config row writes todo.lingerSecs through writeTodoSection", async () => {
    const { buildTodoGroups, todoConfig } = await import("../configPanel.ts");
    const working = { value: "300" };
    const groups = buildTodoGroups(working);
    const row0 = groups[0]!.rows[0]!;
    assert.equal(row0.key, "todo.lingerSecs");
    assert.equal(row0.defaultValue, "60");
    // Menu is a closed set incl. Never.
    const menu = (row0 as any).menu();
    assert.deepEqual(menu.map((m: any) => m.value), ["0", "60", "300", "900", "-1"]);
    // set() mutates the working copy; save() persists via writeTodoSection.
    row0.set("900");
    assert.equal(working.value, "900");
    // save() with no owned edited key is a no-op.
    const saved: string[] = [];
    await todoConfig().save(new Set(["other.key"]), { ui: { notify: (m: string) => saved.push(m) } } as never);
    assert.equal(saved.length, 0);
  });
});
