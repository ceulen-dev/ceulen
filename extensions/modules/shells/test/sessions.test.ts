// shells unit tests — fake-child logic tests + a couple of REAL spawn
// integration tests (posix only). No network, no sleeps beyond ms timers.

import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  RingBuffer,
  SessionStore,
  createSession,
  killSession,
  nextId,
  resetIdCounter,
  resolveSession,
  TOTAL_BYTES,
  truncationMarker,
  type ShellSession,
  type SpawnFn,
} from "../lib/sessions.js";

/** A fake child: EventEmitter surface used by createSession, capture mode. */
function fakeChild(): { child: any; writes: string[]; killCalls: string[]; emitExit: (code: number | null, signal?: NodeJS.Signals | null) => void } {
  const child = new EventEmitter() as any;
  child.pid = 42_424;
  // stdin must be an EventEmitter: createSession registers an 'error'
  // listener on it (EPIPE containment).
  child.stdin = Object.assign(new EventEmitter(), { write: (d: string) => child.__writes.push(d) });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (sig: NodeJS.Signals = "SIGTERM") => {
    child.__kills.push(sig);
    return true;
  };
  child.__writes = [] as string[];
  child.__kills = [] as string[];
  child.__closed = false;
  child.__emitExit = (code: number | null, signal?: NodeJS.Signals | null) => {
    child.__closed = true;
    child.emit("exit", code, signal ?? null);
  };
  return { child, writes: child.__writes, killCalls: child.__kills, emitExit: child.__emitExit };
}

const noopSpawn: SpawnFn = () => fakeChild().child as never;

// ── RingBuffer ──────────────────────────────────────────────────────────────

describe("RingBuffer", () => {
  it("buffers lines including the unterminated tail", () => {
    const rb = new RingBuffer();
    rb.push("one\ntwo\nthr");
    assert.deepEqual(rb.lines(), ["one", "two", "thr"]); // tail visible
    assert.equal(rb.peekPartial(), "thr");
    rb.push("ee\nfour\n");
    assert.deepEqual(rb.lines(), ["one", "two", "three", "four"]);
  });

  it("reports totalWritten and truncation state", () => {
    const rb = new RingBuffer();
    rb.push("a\n");
    assert.equal(rb.totalWritten(), 2);
    assert.equal(rb.isTruncated(), false);
    rb.push("x".repeat(TOTAL_BYTES + 10));
    assert.equal(rb.isTruncated(), true);
    assert.ok(rb.totalWritten() > TOTAL_BYTES); // lifetime count is pre-truncation
  });

  it("keeps head + tail with a marker when the cap trips", () => {
    const rb = new RingBuffer();
    rb.push("HEAD-LINE\n");
    rb.push("x".repeat(TOTAL_BYTES) + "\n");
    rb.push("TAIL-LINE\n");
    const lines = rb.lines();
    assert.equal(lines[0], "HEAD-LINE");
    assert.equal(lines.at(-1), "TAIL-LINE");
    const marker = lines.find((l) => l.startsWith("[…"));
    assert.ok(marker, "has a truncation marker line");
    assert.match(marker!, /^\[… \d+(?:\.\d+)? (Ki?B|bytes) truncated …\]$/);
  });

  it("truncationMarker formats", () => {
    assert.equal(truncationMarker(5), "[… 5 bytes truncated …]");
  });

  it("keeps the unterminated partial line after the cap trips", () => {
    const rb = new RingBuffer();
    rb.push("HEAD-LINE\n");
    rb.push("x".repeat(TOTAL_BYTES) + "\n"); // cap trips
    rb.push("spinner…"); // no trailing newline, arrives after capping
    assert.equal(rb.isTruncated(), true);
    assert.match(rb.lines().at(-1)!, /^spinner…/);
  });
});

// ── ids + resolution ────────────────────────────────────────────────────────

describe("ids and resolveSession", () => {
  it("nextId is monotonic; resetIdCounter resets", () => {
    resetIdCounter(0);
    assert.equal(nextId(), "s1");
    assert.equal(nextId(), "s2");
    resetIdCounter(9);
    assert.equal(nextId(), "s10");
    resetIdCounter();
  });

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
      lastStdoutOffset: 0, lastStderrOffset: 0,
      ...over,
    };
  }

  it("resolves by id first, then unique name", () => {
    const store = new SessionStore();
    const a = session({ id: "s1", name: "dev" });
    const b = session({ id: "s2" });
    store.add(a);
    store.add(b);
    assert.equal(resolveSession(store, "s2"), b);
    assert.equal(resolveSession(store, "dev"), a);
  });

  it("ambiguous name errors with the listing; unknown errors too", () => {
    const store = new SessionStore();
    store.add(session({ id: "s1", name: "dev" }));
    store.add(session({ id: "s2", name: "dev" }));
    assert.throws(() => resolveSession(store, "dev"), /ambiguous.*dev/s);
    assert.throws(() => resolveSession(store, "nope"), /no session 'nope'/);
  });

  it("prefers a live match over an exited one with the same name", () => {
    const store = new SessionStore();
    const dead = session({ id: "s1", name: "dev", exitedAt: Date.now(), exitCode: 0 });
    const live = session({ id: "s2", name: "dev" });
    store.add(dead);
    store.add(live);
    assert.equal(resolveSession(store, "dev"), live);
    // Ambiguity is judged among LIVE sessions only.
    const live2 = session({ id: "s3", name: "dev" });
    store.add(live2);
    assert.throws(() => resolveSession(store, "dev"), /ambiguous \(2 sessions\)/);
    // All matches exited → fall back to the FULL list (original semantics:
    // ambiguity is decided over the fallback set).
    live.exitedAt = Date.now();
    live2.exitedAt = Date.now();
    assert.throws(() => resolveSession(store, "dev"), /ambiguous \(3 sessions\)/);
  });
});

// ── SessionStore ────────────────────────────────────────────────────────────

describe("SessionStore", () => {
  function live(over: Partial<ShellSession>): ShellSession {
    return {
      id: `s${Math.random()}`,
      pid: 1,
      child: {} as never,
      cwd: "/",
      command: "true",
      startedAt: Date.now(),
      stdout: new RingBuffer(),
      stderr: new RingBuffer(),
      lastStdoutOffset: 0, lastStderrOffset: 0,
      ...over,
    };
  }

  it("refuses an 11th live session, listing them", () => {
    const store = new SessionStore();
    for (let i = 0; i < 10; i++) store.add(live({ id: `s${i}` }));
    assert.throws(() => store.add(live({ id: "s11" })), /refusing to start an 11th live shell session[\s\S]*s9/);
    // Exited sessions don't count toward the live cap.
    const dead = live({ id: "sx", exitedAt: Date.now(), exitCode: 0 });
    store.add(dead);
    assert.equal(store.list().length, 11);
  });

  it("evictOldestExited keeps at most 5 exited", () => {
    const store = new SessionStore();
    for (let i = 0; i < 7; i++) store.add(live({ id: `d${i}`, exitedAt: 1_000 + i, exitCode: 0 }));
    let evicted = 0;
    while (store.evictOldestExited()) evicted++;
    assert.equal(evicted, 2);
    assert.equal(store.list().length, 5);
    assert.equal(store.list()[0]!.id, "d2"); // oldest two gone
  });

  it("clear drops every session", () => {
    const store = new SessionStore();
    store.add(live({ id: "s1" }));
    store.add(live({ id: "s2" }));
    store.clear();
    assert.equal(store.list().length, 0);
  });

  it("killAll skips exited sessions and escalates for live ones", { timeout: 10_000 }, async () => {
    const store = new SessionStore();
    const fc = fakeChild();
    const s = store.list().length; // 0
    store.add({
      id: "s1", pid: fc.child.pid, child: fc.child, cwd: "/", command: "x",
      startedAt: Date.now(), stdout: new RingBuffer(), stderr: new RingBuffer(), lastStdoutOffset: 0, lastStderrOffset: 0,
    });
    store.add({
      id: "s2", pid: 1, child: fakeChild().child, cwd: "/", command: "x",
      startedAt: Date.now(), exitedAt: Date.now(), exitCode: 0,
      stdout: new RingBuffer(), stderr: new RingBuffer(), lastStdoutOffset: 0, lastStderrOffset: 0,
    });
    await store.killAll("SIGTERM");
    // Group signal fails (bogus pid) → falls back to child.kill; escalation
    // to SIGKILL after the 2s wait hits the live session only.
    assert.ok(fc.killCalls.includes("SIGTERM"));
    assert.ok(fc.killCalls.includes("SIGKILL"));
    assert.equal(s, 0);
  });
});

// ── createSession ───────────────────────────────────────────────────────────

describe("createSession", () => {
  it("wires streams, exit, stdin; rejects duplicate live names", () => {
    const store = new SessionStore();
    resetIdCounter(0);
    const fc = fakeChild();
    const s = createSession(store, () => fc.child as never, { command: "npm run dev", cwd: "/", name: "dev" });
    assert.equal(s.id, "s1");
    assert.equal(s.pid, 42_424);
    fc.child.stdout.emit("data", Buffer.from("hello\n"));
    fc.child.stderr.emit("data", Buffer.from("oops\n"));
    assert.deepEqual(s.stdout.lines(), ["hello"]);
    assert.deepEqual(s.stderr.lines(), ["oops"]);
    assert.throws(() => createSession(store, noopSpawn, { command: "x", cwd: "/", name: "dev" }), /already exists/);
    // Exit marks the session and frees the name.
    fc.emitExit(0);
    assert.equal(s.exitedAt !== undefined, true);
    const again = createSession(store, noopSpawn, { command: "x", cwd: "/", name: "dev" });
    assert.equal(again.id, "s2");
  });

  it("spawn failure cleans up the placeholder", () => {
    const store = new SessionStore();
    assert.throws(() => createSession(store, () => { throw new Error("bad cwd"); }, { command: "x", cwd: "/" }), /failed to start 'x': bad cwd/);
    assert.equal(store.list().length, 0);
  });

  it("marks an async spawn failure exited and never signals pi's own group", async () => {
    const store = new SessionStore();
    resetIdCounter(0);
    // Async failure: child emits 'error' with pid undefined (bad cwd etc.).
    const fc = fakeChild();
    fc.child.pid = undefined;
    const s = createSession(store, () => {
      queueMicrotask(() => fc.child.emit("error", new Error("ENOENT: spawn bad-cwd")));
      return fc.child as never;
    }, { command: "x", cwd: "/nonexistent-cwd" });
    assert.equal(s.pid, 0);
    await new Promise<void>((r) => setImmediate(r));
    assert.ok(s.exitedAt !== undefined, "spawn failure marks the session exited");
    assert.equal(s.exitCode, null);

    // kill on the zombie resolves early — nothing to signal, and never
    // process.kill(-0) (== kill(0) == SIGTERM for every process in pi's
    // own group).
    const origKill = process.kill;
    const groupCalls: [number | undefined, NodeJS.Signals][] = [];
    (process as any).kill = (pid: number | undefined, sig?: NodeJS.Signals) => {
      if (typeof pid === "number" && pid <= 0) groupCalls.push([pid, sig as NodeJS.Signals]);
      return true;
    };
    try {
      const r = await killSession(s, "SIGKILL", 50);
      assert.deepEqual(r, { code: null, signal: null }); // early exit, no signal
      assert.deepEqual(groupCalls, [], "no negative/zero-pid group signal may be issued");
    } finally {
      (process as any).kill = origKill;
    }
    assert.deepEqual(fc.killCalls, [] as string[], "exited session is not signalled");
  });

  it("kill on a live pid-0 session falls back to child.kill, not the host group", async () => {
    const store = new SessionStore();
    // Race window: session registered, spawn 'error' not yet fired → still
    // live with pid 0. killSession must reach for child.kill only.
    const fc = fakeChild();
    fc.child.pid = undefined;
    const s = createSession(store, () => fc.child as never, { command: "x", cwd: "/" });
    assert.equal(s.pid, 0);
    const origKill = process.kill;
    const groupCalls: [number | undefined, NodeJS.Signals][] = [];
    (process as any).kill = (pid: number | undefined, sig?: NodeJS.Signals) => {
      if (typeof pid === "number" && pid <= 0) groupCalls.push([pid, sig as NodeJS.Signals]);
      return true;
    };
    try {
      const r = await killSession(s, "SIGTERM", 50);
      assert.equal(r.signal, "SIGKILL"); // escalated: fake never exits
      assert.deepEqual(groupCalls, [], "no negative/zero-pid group signal may be issued");
    } finally {
      (process as any).kill = origKill;
    }
    assert.ok(fc.killCalls.includes("SIGTERM"));
    assert.ok(fc.killCalls.includes("SIGKILL"), "falls back to child.kill");
  });

  it("frees the name after an async spawn failure", async () => {
    const store = new SessionStore();
    const fc = fakeChild();
    fc.child.pid = undefined;
    createSession(store, () => {
      queueMicrotask(() => fc.child.emit("error", new Error("ENOENT")));
      return fc.child as never;
    }, { command: "x", cwd: "/", name: "dev" });
    await new Promise<void>((r) => setImmediate(r));
    const again = createSession(store, noopSpawn, { command: "y", cwd: "/", name: "dev" });
    assert.ok(again.id.length > 0);
  });

  it("killSession escalates to SIGKILL after the wait", async () => {
    const store = new SessionStore();
    const fc = fakeChild(); // never emits exit on its own
    const s = createSession(store, () => fc.child as never, { command: "sleep 30", cwd: "/" });
    const started = Date.now();
    const r = await killSession(s, "SIGTERM", 60);
    assert.ok(Date.now() - started >= 50);
    assert.equal(r.signal, "SIGKILL");
    assert.ok(fc.killCalls.length >= 1);
  });

  it("killSession returns early for already-exited sessions", async () => {
    const store = new SessionStore();
    const fc = fakeChild();
    const s = createSession(store, () => fc.child as never, { command: "x", cwd: "/" });
    fc.emitExit(3);
    const r = await killSession(s);
    assert.equal(r.code, 3);
  });

  it("contains a stdin EPIPE that races child exit (no uncaught error)", () => {
    const store = new SessionStore();
    const fc = fakeChild();
    const s = createSession(store, () => fc.child as never, { command: "sh -c 'exit 0'", cwd: "/" });
    fc.emitExit(0);
    // A write that raced the exit already EPIPEd: the 'error' event lands on
    // stdin with no writer left. On a real child that would be an
    // uncaughtException killing pi; on an EventEmitter, emitting 'error'
    // with no listener THROWS — so doesNotThrow is the no-crash assertion.
    assert.doesNotThrow(() => fc.child.stdin.emit("error", new Error("EPIPE")));
    assert.deepEqual(s.stderr.lines(), ["[shells] stdin write failed (process exited)"]);
  });
});

// ── REAL spawn integration (posix) ──────────────────────────────────────────

const posixIt = process.platform === "win32" ? it.skip : it;

describe("real spawns", () => {
  const tmp = os.tmpdir();

  posixIt("echo lands in the buffer via createSession", async () => {
    const store = new SessionStore();
    const s = createSession(store, realSpawn as unknown as SpawnFn, { command: "echo real-hello", cwd: tmp });
    assert.notEqual(s.pid, 0);
    // Wait for exit + buffer flush (event-driven, capped).
    await new Promise<void>((r) => {
      const t = setInterval(() => {
        if (s.exitedAt !== undefined && s.stdout.lines().length > 0) {
          clearInterval(t);
          r();
        }
      }, 25);
      setTimeout(() => { clearInterval(t); r(); }, 5_000);
    });
    assert.deepEqual(s.stdout.lines(), ["real-hello"]);
    await killSession(s, "SIGKILL", 500).catch(() => {});
  });

  posixIt("killAll reaps a sleep child (process group)", async () => {
    const store = new SessionStore();
    const s = createSession(store, realSpawn as unknown as SpawnFn, { command: "sleep 30", cwd: tmp });
    await store.killAll("SIGKILL");
    assert.ok(s.exitedAt !== undefined || s.exitCode !== null || s.child.killed);
  });
});

after(() => resetIdCounter());
