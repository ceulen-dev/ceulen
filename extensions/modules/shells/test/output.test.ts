// Unit tests for the tool's output rendering + store lifecycle wiring
// (index.ts): per-stream `since:"last"` cursors and the session_start clear.
// index.ts is loaded through a stub ExtensionAPI; spawn is not touched.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RingBuffer, SessionStore, type ShellSession } from "../lib/sessions.js";
import mod, { getStoreForTests } from "../index.js";

/** Drive the module against a stub pi and return the registered tool + handlers. */
function load(): { tool: any; handlers: Record<string, Function>; store: SessionStore } {
  const handlers: Record<string, Function> = {};
  let tool: any;
  const fakePi: any = {
    on: (ev: string, fn: Function) => { handlers[ev] = fn; },
    registerTool: (t: any) => { tool = t; },
  };
  mod(fakePi);
  // Reach the store for cursor/clear assertions (module closes over it).
  return { tool, handlers, store: getStoreForTests()! };
}

function session(over: Partial<ShellSession>): ShellSession {
  return {
    id: "s1",
    pid: 1,
    child: {} as never,
    cwd: "/",
    command: "true",
    startedAt: Date.now(),
    stdout: new RingBuffer(),
    stderr: new RingBuffer(),
    lastStdoutOffset: 0,
    lastStderrOffset: 0,
    ...over,
  };
}

describe("output cursors (since:\"last\")", () => {
  it("advances per-stream, independently", async () => {
    const { tool, store } = load();
    const s = session({ id: "s1" });
    s.stdout.push("out-1\n");
    s.stderr.push("err-1\n");
    store.add(s);

    const read = async () => {
      const r = await tool.execute("t", { action: "output", id: "s1", since: "last" }, undefined as never, undefined as never, { cwd: "/" } as never);
      return (r.content[0] as { text: string }).text;
    };

    let text = await read();
    assert.match(text, /out-1/);
    assert.match(text, /err-1/);
    assert.equal(s.lastStdoutOffset, 1);
    assert.equal(s.lastStderrOffset, 1);

    // Only stderr advances now: stdout cursor must stay put.
    s.stderr.push("err-2\n");
    text = await read();
    assert.doesNotMatch(text, /out-1/);
    assert.match(text, /err-2/);
    assert.equal(s.lastStdoutOffset, 1, "stdout cursor unchanged when only stderr grew");
    assert.equal(s.lastStderrOffset, 2);

    // Only stdout grows past stderr — stderr must not repeat (the old
    // single-cursor bug showed stderr again whenever stdout was longer).
    s.stdout.push("out-2\n");
    text = await read();
    assert.match(text, /out-2/);
    assert.doesNotMatch(text, /err-1/);
    assert.doesNotMatch(text, /err-2/);
    assert.equal(s.lastStdoutOffset, 2);
    assert.equal(s.lastStderrOffset, 2);
  });

  it("since:\"start\" never moves the cursors", async () => {
    const { tool, store } = load();
    const s = session({ id: "s1" });
    s.stdout.push("a\nb\n");
    store.add(s);
    await tool.execute("t", { action: "output", id: "s1" }, undefined as never, undefined as never, { cwd: "/" } as never);
    assert.equal(s.lastStdoutOffset, 0);
    assert.equal(s.lastStderrOffset, 0);
  });

  it("re-clamps a cursor left above a ring-cap-shrunk array and recovers", async () => {
    const { tool, store } = load();
    const s = session({ id: "s1" });
    store.add(s);
    const read = async () => {
      const r = await tool.execute("t", { action: "output", id: "s1", since: "last" }, undefined as never, undefined as never, { cwd: "/" } as never);
      return (r.content[0] as { text: string }).text;
    };

    // Fill the ring PAST its cap (1KB lines, two big chunks): enforceCap()
    // rebuilds the array to head + marker + tail (~260 lines). The drain
    // poll reports the truncation and records that line count as the cursor.
    s.stdout.push("HEAD-LINE\n");
    const kbLine = `${"A".repeat(999)}\n`.repeat(420); // ~420KB per chunk
    s.stdout.push(kbLine);
    s.stdout.push(kbLine);
    const text1 = await read();
    assert.match(text1, /truncated/);
    assert.equal(s.lastStdoutOffset, s.stdout.lifetimeLines(), "drain records the lifetime cursor");

    // Two huge lines re-cap and SHRINK the window far below the recorded
    // index-space position. A window-index cursor (the old design) strands
    // above the shrunk array forever — the lifetime cursor cannot.
    s.stdout.push(`${"x".repeat(99_999)}\n${"y".repeat(99_999)}\n`);
    await read();
    assert.ok(s.lastStdoutOffset > s.stdout.lines().length, "cursor is lifetime space, above the shrunk window (previously the blackout)");
    assert.equal(s.lastStdoutOffset, s.stdout.lifetimeLines(), "cursor stays synced to lifetime lines after the shrink");

    // Recovery: new pushes must surface again, not "no new output yet".
    for (let i = 0; i < 12; i++) s.stdout.push(`${"NEW-".padEnd(4999, "N")}\n`.repeat(60));
    const text2 = await read();
    assert.match(text2, /NEW-/);
    assert.doesNotMatch(text2, /no new output yet/);
  });
});

describe("session_start wiring", () => {
  it("clears the store (no-op bug regression)", async () => {
    const { handlers, store } = load();
    store.add(session({ id: "s1" }));
    (handlers.session_start as (e: unknown, ctx: unknown) => void)({}, {});
    assert.equal(store.list().length, 0);
  });
});
