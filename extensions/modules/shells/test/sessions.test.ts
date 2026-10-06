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
  child.stdin = { write: (d: string) => child.__writes.push(d), get writable() { return !child.__closed; } };
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
      lastOutputOffset: 0,
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
      lastOutputOffset: 0,
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

  it("killAll skips exited sessions and escalates for live ones", { timeout: 10_000 }, async () => {
    const store = new SessionStore();
    const fc = fakeChild();
    const s = store.list().length; // 0
    store.add({
      id: "s1", pid: fc.child.pid, child: fc.child, cwd: "/", command: "x",
      startedAt: Date.now(), stdout: new RingBuffer(), stderr: new RingBuffer(), lastOutputOffset: 0,
    });
    store.add({
      id: "s2", pid: 1, child: fakeChild().child, cwd: "/", command: "x",
      startedAt: Date.now(), exitedAt: Date.now(), exitCode: 0,
      stdout: new RingBuffer(), stderr: new RingBuffer(), lastOutputOffset: 0,
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
