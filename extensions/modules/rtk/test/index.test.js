import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Orchestration tests for index.ts: availability gating, env bypass, and the
// safe-rewrite decision on the tool_call path, via a stubbed pi + ctx.
// Module-level cache state (rtkAvailable/rtkLastCheckedAt) persists across
// tests in this file — tests are ordered to lean on it, and session_start
// (which re-checks unconditionally) re-establishes availability where needed.

// Isolate the agent dir for the WHOLE file: readRtkSettings reads the global
// `rtk` section per bash call, and a host settings.json with `chained: "never"`
// would silently disable every chain rewrite under test.
const HOST_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const TEMP_AGENT_DIR = mkdtempSync(join(tmpdir(), "ceulen-rtk-index-"));
process.env.PI_CODING_AGENT_DIR = TEMP_AGENT_DIR;
test.after(() => {
  if (HOST_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = HOST_AGENT_DIR;
  rmSync(TEMP_AGENT_DIR, { recursive: true, force: true });
});

function createHarness() {
  const state = { versionCalls: 0, rewriteCalls: 0, rewritten: null, versionAvailable: false };
  const handlers = {};
  const ctx = {
    hasUI: false,
    cwd: process.cwd(),
    signal: { aborted: false },
    ui: { setStatus() {}, notify() {} },
  };
  const pi = {
    registerCommand() {},
    on(name, fn) {
      handlers[name] = fn;
    },
    exec(cmd, args) {
      if (args[0] === "--version") {
        state.versionCalls++;
        return state.versionAvailable
          ? Promise.resolve({ code: 0, stdout: "rtk 0.46.0\n" })
          : Promise.resolve({ code: 1, stdout: "" });
      }
      if (args[0] === "rewrite") {
        state.rewriteCalls++;
        return state.rewritten === null
          ? Promise.reject(new Error("spawn failed"))
          : Promise.resolve({ code: 3, stdout: state.rewritten + "\n", killed: false });
      }
      return Promise.resolve({ code: 0, stdout: "" });
    },
  };
  return { pi, ctx, handlers, state };
}

async function fireToolCall(h, command) {
  const event = { type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command } };
  await h.handlers.tool_call(event, h.ctx);
  return event.input.command;
}

test("rtk unavailable: command passes through unchanged and availability is cached", async () => {
  const h = createHarness();
  h.state.versionAvailable = false;
  const ext = (await import("../index.ts")).default;
  ext(h.pi);

  // session_start performs the initial availability check (as in a real session).
  await h.handlers.session_start({}, h.ctx);

  const afterFirst = await fireToolCall(h, "git status");
  assert.equal(afterFirst, "git status");
  assert.equal(h.state.versionCalls, 1);

  // Second call within the 30s negative-cache window must not re-check.
  const afterSecond = await fireToolCall(h, "ls -la");
  assert.equal(afterSecond, "ls -la");
  assert.equal(h.state.versionCalls, 1);
  assert.equal(h.state.rewriteCalls, 0);
});

test("RTK_DISABLED=1: no rewrite even when rtk is available", async () => {
  const h = createHarness();
  h.state.versionAvailable = true;
  const ext = (await import("../index.ts")).default;
  ext(h.pi);

  // Fresh session check establishes availability first.
  await h.handlers.session_start({}, h.ctx);
  process.env.RTK_DISABLED = "1";
  try {
    const after = await fireToolCall(h, "git status");
    assert.equal(after, "git status");
    assert.equal(h.state.rewriteCalls, 0);
  } finally {
    delete process.env.RTK_DISABLED;
  }
});

test("safe rewrite path applies the rewritten command", async () => {
  const h = createHarness();
  h.state.versionAvailable = true;
  h.state.rewritten = "rtk git status";
  const ext = (await import("../index.ts")).default;
  ext(h.pi);

  await h.handlers.session_start({}, h.ctx);
  const after = await fireToolCall(h, "git status");
  assert.equal(after, "rtk git status");
  assert.equal(h.state.rewriteCalls, 1);
});

test("unsafe rewrite (isSafeRewrite false) keeps the original command", async () => {
  const h = createHarness();
  h.state.versionAvailable = true;
  h.state.rewritten = "evil -rf /";
  const ext = (await import("../index.ts")).default;
  ext(h.pi);

  await h.handlers.session_start({}, h.ctx);
  const after = await fireToolCall(h, "git status");
  assert.equal(after, "git status");
  assert.equal(h.state.rewriteCalls, 1);
});

test("before_agent_start: prompt note injected only when rtk is available", async () => {
  const ext = (await import("../index.ts")).default;

  // rtkAvailable === false → rewrites pass through, so no rewrite note.
  const off = createHarness();
  off.state.versionAvailable = false;
  ext(off.pi);
  await off.handlers.session_start({}, off.ctx);
  const resOff = await off.handlers.before_agent_start({ systemPrompt: "BASE" });
  assert.equal(resOff, undefined, "no systemPrompt modification when unavailable");

  // Available → the static note is appended truthfully.
  const on = createHarness();
  on.state.versionAvailable = true;
  ext(on.pi);
  await on.handlers.session_start({}, on.ctx);
  const resOn = await on.handlers.before_agent_start({ systemPrompt: "BASE" });
  assert.match(resOn.systemPrompt, /rewritten through RTK where RTK supports them/);
  assert.match(resOn.systemPrompt, /chains, redirects, inline scripts, and unsupported commands pass through unchanged/);

  // Static-policy note: byte-identical across two firings (prefix-cache head).
  const resOn2 = await on.handlers.before_agent_start({ systemPrompt: "BASE" });
  assert.equal(resOn2.systemPrompt, resOn.systemPrompt);
  assert.equal(
    resOn.systemPrompt.slice("BASE".length),
    "\n\nYour bash commands are rewritten through RTK where RTK supports them (git, ls, rg, read, test runners as single commands); chains, redirects, inline scripts, and unsupported commands pass through unchanged.",
  );
});

test("chain pass-through fires the [pi-rtk] notify once for two consecutive identical chains", async () => {
  const notifications = [];
  const h = createHarness();
  h.state.versionAvailable = true;
  h.state.rewritten = ""; // rtk consulted, returns empty = unmodeled → pass-through
  h.ctx.hasUI = true;
  h.ctx.ui.notify = (message) => notifications.push(message);
  const ext = (await import("../index.ts")).default;
  ext(h.pi);

  await h.handlers.session_start({}, h.ctx);
  const chain = "npm test 2>&1 | tail -8";
  const afterFirst = await fireToolCall(h, chain);
  assert.equal(afterFirst, chain, "unmodeled chain executes unchanged");
  const afterSecond = await fireToolCall(h, chain);
  assert.equal(afterSecond, chain);
  const passNotes = notifications.filter((n) => n.startsWith("[pi-rtk] passed through unchanged:"));
  assert.equal(passNotes.length, 1, `dedupe: one notify for two identical chains, got ${passNotes.length}`);

  // A different chain notifies again.
  await fireToolCall(h, "npx tsc --noEmit 2>&1 | head -20");
  assert.equal(notifications.filter((n) => n.startsWith("[pi-rtk] passed through unchanged:")).length, 2);

  // session_start resets the dedupe.
  await h.handlers.session_start({}, h.ctx);
  await fireToolCall(h, chain);
  assert.equal(notifications.filter((n) => n.startsWith("[pi-rtk] passed through unchanged:")).length, 3);
});

test("pass-through notify does not fire when rtk was not consulted", async () => {
  const notifications = [];
  const h = createHarness();
  h.state.versionAvailable = true;
  h.ctx.hasUI = true;
  h.ctx.ui.notify = (message) => notifications.push(message);
  const ext = (await import("../index.ts")).default;
  ext(h.pi);

  await h.handlers.session_start({}, h.ctx);
  process.env.RTK_DISABLED = "1";
  try {
    await fireToolCall(h, "npm test 2>&1 | tail -8");
    assert.equal(notifications.filter((n) => n.includes("passed through")).length, 0, "env bypass = not consulted");
  } finally {
    delete process.env.RTK_DISABLED;
  }
  // hasUI=false suppresses notifies entirely.
  h.ctx.hasUI = false;
  await fireToolCall(h, "npm test 2>&1 | tail -8");
  assert.equal(notifications.filter((n) => n.includes("passed through")).length, 0);
});

test("rtk settings: mode off is a kill switch; chained never skips the spawn", async () => {
  // Isolate the agent dir so read/writeRtkSettings never touch the real file.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ceulen-rtk-test-"));
  const realAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const { writeRtkSection } = await import("../lib/settings.ts");

    const h = createHarness();
    h.state.versionAvailable = true;
    h.state.rewritten = "rtk git status";
    const ext = (await import("../index.ts")).default;
    ext(h.pi);
    await h.handlers.session_start({}, h.ctx);

    // mode: off → no rewrite, no spawn.
    writeRtkSection({ mode: "off" });
    assert.equal(await fireToolCall(h, "git status"), "git status");
    assert.equal(h.state.rewriteCalls, 0);

    // back to supported-only → rewrites again.
    writeRtkSection({ mode: "supported-only" });
    assert.equal(await fireToolCall(h, "git status"), "rtk git status");

    // chained: never → a chain never reaches the binary...
    writeRtkSection({ chained: "never" });
    const callsBefore = h.state.rewriteCalls;
    assert.equal(await fireToolCall(h, "ls -la; pwd; cat a.txt"), "ls -la; pwd; cat a.txt");
    assert.equal(h.state.rewriteCalls, callsBefore, "no spawn for a chain under chained: never");
    // ...but a quoted operator is not a chain separator.
    assert.equal(await fireToolCall(h, "git commit -m \"fix: a|b\""), "rtk git status");
    assert.equal(h.state.rewriteCalls, callsBefore + 1, "quoted | is not a chain operator");
  } finally {
    if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = realAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
