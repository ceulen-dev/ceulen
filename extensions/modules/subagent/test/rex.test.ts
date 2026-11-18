// rex delegation backend (lib/rex.ts): detection, name allocation, window/pane
// topology, prompt+wait (readiness gate, submit, freshness turn-proof),
// collection (head slice + blob tail, echo cut), and result mapping. Every CLI
// call is scripted through the `rexCli.exec` seam (the herdrCli/herdrAppCli
// precedent).

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  cancelRexAgent,
  clearRexRegistry,
  closeRexWindow,
  collectRexResult,
  executeRexTask,
  findRexAgent,
  forgetRexAgent,
  forgetRexWindow,
  getRexRegistry,
  getRexTerminal,
  lastTiledBlock,
  prepareRexTask,
  probeRexBinary,
  promptRexAndWait,
  readRexBlock,
  rexTiming,
  replyBeyondEcho,
  resetRexProbe,
  rexCli,
  rexDisabled,
  rexEnvDetected,
  rexWindowCloseBlockers,
  wrapRexTaskPrompt,
  type RexHandle,
} from "../lib/rex.ts";

type Res = { code: number; stdout?: string; stderr?: string };
type Call = { args: string[] };

/** Scripted exec: "<sub> <verb> <first-positional-if-any>" → queued replies.
 *  Unscripted calls answer 0/{} so a missing script fails loudly in assertions
 *  rather than throwing. */
function fakeCli(script: Map<string, Res[]>, calls: Call[]) {
  return async (cmd: string, args: string[]) => {
    // args carries the global "-s <session>" prefix; strip it for keying.
    const trimmed = args[0] === "-s" ? args.slice(2) : args;
    // `block call -b <id> <method>` keys on the METHOD (the interesting part);
    // `block send -b <id>` keys on the verb.
    // Two-word commands ("block ls", "window new", "session inspect") key on
    // both words; single verbs ("split", "focus", "version") on one; `block
    // call` keys on the METHOD (the interesting part of that shape).
    const twoWord = new Set(["block ls", "block send-key", "block send", "block close", "window ls", "window new", "window close", "session inspect"]);
    let key = trimmed.slice(0, 2).join(" ");
    if (!twoWord.has(key)) key = trimmed[0] ?? "";
    if (trimmed[0] === "block" && trimmed[1] === "call") key = `block call ${trimmed[4] ?? ""}`;
    const res = { code: 0, stdout: "{}", stderr: "", ...script.get(`${cmd} ${key}`)?.shift() };
    calls.push({ args });
    return res;
  };
}

/** Root status record for a live pi in a given state. */
function piStatus(state: string, updatedAt: string): Res {
  return {
    code: 0,
    stdout: JSON.stringify({ records: [{ state, app: "pi", effective_app: "pi", updated_at: updatedAt }] }),
  };
}

function liveProc(cwd = "/repo"): Res {
  return { code: 0, stdout: JSON.stringify({ last_exit: null, foreground: { cwd, name: "node" } }) };
}

function exitedProc(): Res {
  return { code: 0, stdout: JSON.stringify({ last_exit: { code: 0 }, foreground: { name: "node" } }) };
}

const T0 = "2026-11-18T09:41:43.810154+07:00";
const T1 = "2026-11-18T09:42:05.510036+07:00";
const T2 = "2026-11-18T09:42:07.913979+07:00";

// Failure-path windows are wall-clock; shrink them (the herdrHeartbeat
// precedent) so the suite stays fast, then restore.
const DEFAULT_TIMING = { ...rexTiming };
test.before(() => {
  rexTiming.readyTimeoutMs = 800;
  rexTiming.pollMs = 20;
  rexTiming.unsentGraceMs = 200;
});
test.after(() => Object.assign(rexTiming, DEFAULT_TIMING));

afterEach(() => {
  clearRexRegistry();
  resetRexProbe();
  rexCli.exec = ((cmd: string) => Promise.resolve({ code: 0, stdout: "{}", stderr: "" })) as typeof rexCli.exec;
  delete process.env.REX_SESSION;
  delete process.env.REX_BLOCK;
  delete process.env.PI_SUBAGENT_HERDR;
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test("rexEnvDetected: REX_SESSION is the marker; REX_BLOCK alone is not enough", () => {
  delete process.env.REX_SESSION;
  delete process.env.REX_BLOCK;
  assert.equal(rexEnvDetected(), false);
  process.env.REX_BLOCK = "block:1";
  assert.equal(rexEnvDetected(), false);
  process.env.REX_SESSION = "session:1";
  assert.equal(rexEnvDetected(), true);
});

test("rexDisabled: subagent.herdr:\"off\" and the child recursion guard both disable", () => {
  assert.equal(rexDisabled(undefined), false);
  assert.equal(rexDisabled({ herdr: "off" }), true);
  assert.equal(rexDisabled({ herdr: "auto" }), false);
  process.env.PI_SUBAGENT_HERDR = "off";
  assert.equal(rexDisabled(undefined), true);
});

test("probeRexBinary: `rex version` must answer; successes cache, failures do not", async () => {
  const calls: Call[] = [];
  rexCli.exec = fakeCli(new Map([["rex version", [{ code: 1 }]]]), calls) as typeof rexCli.exec;
  assert.equal(await probeRexBinary(rexCli.exec), false);
  assert.ok(calls.some((c) => c.args[0] === "version"));

  const okCalls: Call[] = [];
  rexCli.exec = fakeCli(new Map([["rex version", [{ code: 0, stdout: "rex 0.1.0\n" }]]]), okCalls) as typeof rexCli.exec;
  assert.equal(await probeRexBinary(rexCli.exec), true);
});

// ---------------------------------------------------------------------------
// Terminal state
// ---------------------------------------------------------------------------

test("getRexTerminal: maps the root status record, keeps the clock, fails closed", async () => {
  rexCli.exec = fakeCli(new Map([
    ["rex block call program_status", [piStatus("working", T1)]],
    ["rex block call process", [liveProc("/repo")]],
  ]), []) as typeof rexCli.exec;
  const info = await getRexTerminal("block:1", rexCli.exec);
  assert.equal(info?.status, "working");
  assert.equal(info?.app, "pi");
  assert.equal(info?.state, "live");
  assert.equal(info?.cwd, "/repo");
  assert.equal(info?.statusAt, Date.parse(T1));

  // An unreported/unknown state must never read as idle.
  rexCli.exec = fakeCli(new Map([
    ["rex block call program_status", [{ code: 0, stdout: JSON.stringify({ records: [{ state: "future-state", app: "pi", updated_at: T1 }] }) }]],
    ["rex block call process", [liveProc()]],
  ]), []) as typeof rexCli.exec;
  assert.equal((await getRexTerminal("block:1", rexCli.exec))?.status, "unknown");

  // A reported last_exit means the program ended.
  rexCli.exec = fakeCli(new Map([
    ["rex block call program_status", [piStatus("done", T2)]],
    ["rex block call process", [exitedProc()]],
  ]), []) as typeof rexCli.exec;
  assert.equal((await getRexTerminal("block:1", rexCli.exec))?.state, "finished");

  // Both calls failing = no information at all.
  rexCli.exec = fakeCli(new Map([
    ["rex block call program_status", [{ code: 1, stderr: "not found" }]],
    ["rex block call process", [{ code: 1, stderr: "not found" }]],
  ]), []) as typeof rexCli.exec;
  assert.equal(await getRexTerminal("nope", rexCli.exec), undefined);
});

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

test("lastTiledBlock: LAST leaf in layout order, falls back to the focused block", () => {
  const splitWindow = {
    focused_block_id: "block:a",
    layers: [{
      kind: "tiled",
      layout: {
        rect: [0, 0, 1, 1],
        split: {
          split_id: "split:1",
          direction: "vertical",
          ratio: 0.5,
          before: { rect: [0, 0, 1, 0.5], block_id: "block:a" },
          after: { rect: [0, 0.5, 1, 0.5], block_id: "block:b" },
        },
      },
    }],
  };
  assert.equal(lastTiledBlock(splitWindow), "block:b");
  // No layout at all → the focused block; nothing at all → undefined.
  assert.equal(lastTiledBlock({ focused_block_id: "block:z", layers: [] }), "block:z");
  assert.equal(lastTiledBlock({ layers: [] }), undefined);
});

// ---------------------------------------------------------------------------
// Prepare: topology
// ---------------------------------------------------------------------------

function spacesEmpty(): Res {
  return { code: 0, stdout: JSON.stringify({ windows: [] }) };
}

test("prepare: creates one window per agent type with the pi argv (and env wrapper)", async () => {
  process.env.REX_SESSION = "session:1";
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-rex-prep-"));
  const calls: Call[] = [];
  rexCli.exec = fakeCli(new Map([
    ["rex block ls", [{ code: 0, stdout: JSON.stringify({ blocks: [] }) }]],
    ["rex window ls", [spacesEmpty()]],
    ["rex window new", [{ code: 0, stdout: JSON.stringify({ window_id: "window:1", block_ids: ["block:10"] }) }]],
  ]), calls) as typeof rexCli.exec;
  const handle = await prepareRexTask({
    agentType: "scout",
    systemPrompt: "you are scout",
    task: "find things",
    cwd,
    model: "router/ds-flash",
    thinking: "off",
    tools: ["read", "grep"],
    timeoutMs: 60_000,
  });
  assert.equal(handle.tabId, "window:1");
  assert.equal(handle.address, "block:10");
  assert.equal(handle.paneId, "block:10");
  assert.equal(handle.tabCreatedHere, true);
  assert.ok(handle.resultFile.startsWith(join(cwd, ".pi", "rex")));
  assert.equal(findRexAgent("block:10")?.address, "block:10");
  assert.equal(findRexAgent(handle.name)?.address, "block:10");

  const windowNew = calls.find((c) => c.args.includes("new") && c.args.includes("window"));
  assert.ok(windowNew);
  const argv = windowNew!.args;
  // The window label is POSITIONAL (right after the subcommand) and `--`
  // introduces the command, so a label can never be read as a command word.
  const newIdx = argv.indexOf("new");
  assert.equal(argv[newIdx + 1], "scout");
  assert.ok(argv.includes("--focus=false"));
  assert.ok(argv.includes("--json"));
  const sep = argv.indexOf("--");
  assert.ok(sep > 0);
  const command = argv.slice(sep + 1);
  assert.equal(command[0], "/usr/bin/env");
  assert.ok(command.includes("PI_SUBAGENT_HERDR=off"), "child must not recurse into rex dispatch");
  assert.ok(command.some((a) => a.startsWith("CEULEN_ADVISOR_MARKER=")), "advisor marker must reach the child");
  const pi = command.indexOf("pi");
  assert.ok(pi > 0);
  const piArgs = command.slice(pi + 1);
  assert.ok(piArgs.includes("--append-system-prompt"));
  assert.ok(piArgs.includes("--model"));
  assert.ok(piArgs.includes("--tools"));
  assert.ok(piArgs.includes("--session-id"));
  assert.ok(piArgs.includes("--name"));
});

test("prepare: adopts an existing same-type window (never close-eligible) and splits a pane", async () => {
  process.env.REX_SESSION = "session:1";
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-rex-prep-"));
  const calls: Call[] = [];
  rexCli.exec = fakeCli(new Map([
    ["rex block ls", [
      { code: 0, stdout: JSON.stringify({ blocks: [{ block_id: "block:5", label: "scout-1", window_id: "window:1" }] }) },
      { code: 0, stdout: JSON.stringify({ blocks: [{ block_id: "block:5", label: "scout-1", window_id: "window:1" }] }) },
    ]],
    ["rex window ls", [{ code: 0, stdout: JSON.stringify({ windows: [{ window_id: "window:1", label: "scout" }] }) }]],
    ["rex session inspect", [{
      code: 0,
      stdout: JSON.stringify({
        windows: [{
          window_id: "window:1",
          label: "scout",
          focused_block_id: "block:5",
          layers: [{ kind: "tiled", layout: { rect: [0, 0, 1, 1], block_id: "block:5" } }],
        }],
      }),
    }]],
    ["rex split", [{ code: 0, stdout: JSON.stringify({ anchor_id: "block:5", block_ids: ["block:11"] }) }]],
  ]), calls) as typeof rexCli.exec;
  const handle = await prepareRexTask({ agentType: "scout", systemPrompt: "s", task: "t", cwd, timeoutMs: 60_000 });
  assert.equal(handle.tabId, "window:1");
  assert.equal(handle.tabCreatedHere, false); // adopted → not ours to close
  assert.equal(handle.address, "block:11");
  assert.notEqual(handle.name, "scout-1"); // allocateName avoided the live label
  const split = calls.find((c) => c.args.includes("split"));
  assert.ok(split);
  assert.ok(split!.args.includes("block:5")); // anchored on the window's only block
  assert.ok(split!.args.includes("--label"));
  // `session inspect` takes the session POSITIONALLY and rejects the global
  // `-s` prefix (live 2026-11-18: the prefixed form made every adoption fail
  // with "window has no block to split beside"). It must stay unprefixed.
  const inspect = calls.find((c) => c.args.includes("inspect"));
  assert.ok(inspect);
  assert.equal(inspect!.args[0], "session");
  assert.ok(!inspect!.args.includes("-s"));
});

test("prepare: no window to adopt and no anchor → clear failure, no orphan registry entry", async () => {
  process.env.REX_SESSION = "session:1";
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-rex-prep-"));
  rexCli.exec = fakeCli(new Map([
    ["rex block ls", [{ code: 0, stdout: JSON.stringify({ blocks: [] }) }]],
    ["rex window ls", [{ code: 0, stdout: JSON.stringify({ windows: [{ window_id: "window:1", label: "scout" }] }) }]],
    ["rex session inspect", [{ code: 0, stdout: JSON.stringify({ windows: [{ window_id: "window:1", label: "scout", layers: [] }] }) }]],
  ]), []) as typeof rexCli.exec;
  await assert.rejects(
    () => prepareRexTask({ agentType: "scout", systemPrompt: "s", task: "t", cwd, timeoutMs: 60_000 }),
    /no block to split beside/,
  );
  assert.equal(getRexRegistry().length, 0);
});

test("prepare: window new failure leaves no registry entry behind", async () => {
  process.env.REX_SESSION = "session:1";
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-rex-prep-"));
  rexCli.exec = fakeCli(new Map([
    ["rex block ls", [{ code: 0, stdout: JSON.stringify({ blocks: [] }) }]],
    ["rex window ls", [spacesEmpty()]],
    ["rex window new", [{ code: 1, stderr: "rex window new failed: bad label" }]],
  ]), []) as typeof rexCli.exec;
  await assert.rejects(() => prepareRexTask({ agentType: "scout", systemPrompt: "s", task: "t", cwd, timeoutMs: 60_000 }), /window new failed/);
  assert.equal(getRexRegistry().length, 0);
});

// ---------------------------------------------------------------------------
// Prompt + wait
// ---------------------------------------------------------------------------

test("promptRexAndWait: readiness gate, paste+enter, settle on done", async () => {
  const calls: Call[] = [];
  rexCli.exec = fakeCli(new Map([
    // Booting (working) first, then ready idle at T0.
    ["rex block call program_status", [piStatus("working", T0), piStatus("idle", T0), piStatus("done", T2)]],
    ["rex block call process", [liveProc(), liveProc(), liveProc()]],
    ["rex block send", [{ code: 0, stdout: "{}" }]],
    ["rex block send-key", [{ code: 0, stdout: "{}" }]],
  ]), calls) as typeof rexCli.exec;
  const out = await promptRexAndWait({ address: "block:1", text: "hi", timeoutMs: 60_000, exec: rexCli.exec });
  assert.deepEqual(out, { state: "done", delivered: true });
  // Readiness polls happened BEFORE the paste; the paste is send + send-key.
  const sendIdx = calls.findIndex((c) => c.args.includes("send"));
  const statusPollsBefore = calls.slice(0, sendIdx).filter((c) => c.args.includes("program_status")).length;
  assert.equal(statusPollsBefore, 2);
  const sendKeyIdx = calls.findIndex((c) => c.args.includes("send-key"));
  assert.ok(sendKeyIdx > sendIdx);
  assert.ok(calls[sendKeyIdx]!.args.includes("enter"));
});

test("promptRexAndWait: a paste that never submitted is NOT a delivery (no fresh status)", async () => {
  rexCli.exec = fakeCli(new Map([
    // Ready at T0 and stays there: the composer holds the text, nothing ran.
    ["rex block call program_status", Array.from({ length: 40 }, () => piStatus("idle", T0))],
    ["rex block call process", Array.from({ length: 40 }, () => liveProc())],
    ["rex block send", [{ code: 0, stdout: "{}" }]],
    ["rex block send-key", [{ code: 0, stdout: "{}" }]],
  ]), []) as typeof rexCli.exec;
  const out = await promptRexAndWait({ address: "block:1", text: "hi", timeoutMs: 60_000, exec: rexCli.exec });
  assert.equal(out.delivered, false);
  assert.match(out.error ?? "", /never submitted/);
});

test("promptRexAndWait: idle with a FRESH timestamp settles (turn finished unwatched)", async () => {
  rexCli.exec = fakeCli(new Map([
    ["rex block call program_status", [piStatus("idle", T0), piStatus("idle", T1)]],
    ["rex block call process", [liveProc(), liveProc()]],
    ["rex block send", [{ code: 0, stdout: "{}" }]],
    ["rex block send-key", [{ code: 0, stdout: "{}" }]],
  ]), []) as typeof rexCli.exec;
  const out = await promptRexAndWait({ address: "block:1", text: "hi", timeoutMs: 60_000, exec: rexCli.exec });
  assert.deepEqual(out, { state: "idle", delivered: true });
});

test("promptRexAndWait: blocked settles as blocked without a delivery", async () => {
  rexCli.exec = fakeCli(new Map([
    ["rex block call program_status", [piStatus("idle", T0), piStatus("blocked", T1)]],
    ["rex block call process", [liveProc(), liveProc()]],
    ["rex block send", [{ code: 0, stdout: "{}" }]],
    ["rex block send-key", [{ code: 0, stdout: "{}" }]],
  ]), []) as typeof rexCli.exec;
  const out = await promptRexAndWait({ address: "block:1", text: "hi", timeoutMs: 60_000, exec: rexCli.exec });
  assert.equal(out.state, "blocked");
  assert.equal(out.delivered, false);
  assert.match(out.error ?? "", /blocked/i);
});

test("promptRexAndWait: a working child that never settles reports timeout, still delivered", async () => {
  rexCli.exec = fakeCli(new Map([
    ["rex block call program_status", [piStatus("idle", T0), ...Array.from({ length: 60 }, () => piStatus("working", T1))]],
    ["rex block call process", Array.from({ length: 61 }, () => liveProc())],
    ["rex block send", [{ code: 0, stdout: "{}" }]],
    ["rex block send-key", [{ code: 0, stdout: "{}" }]],
  ]), []) as typeof rexCli.exec;
  const out = await promptRexAndWait({ address: "block:1", text: "hi", timeoutMs: 400, exec: rexCli.exec });
  assert.equal(out.delivered, true);
  assert.match(out.error ?? "", /timeout after 400ms/);
});

test("promptRexAndWait: never sends to a child that is not a ready pi", async () => {
  const calls: Call[] = [];
  rexCli.exec = fakeCli(new Map([
    ["rex block call program_status", Array.from({ length: 400 }, () => ({ code: 0, stdout: JSON.stringify({ records: [{ state: "working", app: "pi", updated_at: T1 }] }) }))],
    ["rex block call process", Array.from({ length: 400 }, () => liveProc())],
  ]), calls) as typeof rexCli.exec;
  const out = await promptRexAndWait({ address: "block:1", text: "x", timeoutMs: 300, exec: rexCli.exec });
  assert.equal(out.delivered, false);
  assert.equal(calls.some((c) => c.args.includes("send")), false);
});

test("promptRexAndWait: a pre-aborted signal never touches the CLI", async () => {
  const calls: Call[] = [];
  rexCli.exec = fakeCli(new Map(), calls) as typeof rexCli.exec;
  const controller = new AbortController();
  controller.abort();
  const out = await promptRexAndWait({ address: "block:1", text: "hi", timeoutMs: 1_000, exec: rexCli.exec, signal: controller.signal });
  assert.equal(out.delivered, false);
  assert.match(out.error ?? "", /aborted/);
  assert.deepEqual(calls, []);
});

test("promptRexAndWait: a finished child is reported, never prompted", async () => {
  rexCli.exec = fakeCli(new Map([
    ["rex block call program_status", [piStatus("done", T0)]],
    ["rex block call process", [exitedProc()]],
  ]), []) as typeof rexCli.exec;
  const out = await promptRexAndWait({ address: "block:1", text: "hi", timeoutMs: 5_000, exec: rexCli.exec });
  assert.equal(out.delivered, false);
  assert.match(out.error ?? "", /exited before its task was sent/);
});

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

function handleWith(cwd: string, overrides: Partial<RexHandle> = {}): RexHandle {
  return {
    name: "scout-1", agentType: "scout", tabId: "window:1", address: "block:10", paneId: "block:10",
    task: "t", resultFile: join(cwd, "report.md"), advisorMarker: join(cwd, "m.json"),
    model: "router/x", timeoutMs: 60_000, tabCreatedHere: true,
    ...overrides,
  };
}

test("collectRexResult: the report file wins over the pane", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-rex-collect-"));
  const handle = handleWith(cwd);
  writeFileSync(handle.resultFile, "REPORT BODY");
  const calls: Call[] = [];
  rexCli.exec = fakeCli(new Map(), calls) as typeof rexCli.exec;
  const out = await collectRexResult({ handle, exec: rexCli.exec });
  assert.deepEqual(out, { output: "REPORT BODY", source: "file" });
  assert.equal(calls.length, 0); // no pane read when the contract file exists
});

test("readRexBlock: the head slice is tailed through blob_read when more remains", async () => {
  const calls: Call[] = [];
  rexCli.exec = fakeCli(new Map([
    ["rex block call format", [{ code: 0, stdout: JSON.stringify({ content: "head", total: 100_000, id: 7 }) }]],
    ["rex block call blob_read", [{ code: 0, stdout: JSON.stringify({ id: 7, data: "TAIL", total: 100_000, eof: true }) }]],
  ]), calls) as typeof rexCli.exec;
  const res = await readRexBlock("block:10", rexCli.exec, 1_000);
  assert.deepEqual(res, { ok: true, text: "TAIL" });
  const blob = calls.find((c) => c.args.includes("blob_read"));
  assert.ok(blob);
  const args = JSON.parse(blob!.args[blob!.args.length - 1]!) as { id: number; offset: number };
  assert.equal(args.id, 7);
  assert.equal(args.offset, 99_000); // total - maxBytes
});

test("readRexBlock: a reply carrying an id is re-read from the END even when total < cap", async () => {
  // Live 2026-11-18: a 892-byte pane returned 365 bytes of boot chrome WITH an
  // id (more remains). Comparing `total` against the cap instead of checking
  // the id kept the head and lost the child's actual reply.
  const calls: Call[] = [];
  rexCli.exec = fakeCli(new Map([
    ["rex block call format", [{ code: 0, stdout: JSON.stringify({ content: "boot chrome head", total: 892, id: 4 }) }]],
    ["rex block call blob_read", [{ code: 0, stdout: JSON.stringify({ id: 4, data: "THE ACTUAL REPLY", total: 892, eof: true }) }]],
  ]), calls) as typeof rexCli.exec;
  const res = await readRexBlock("block:10", rexCli.exec);
  assert.deepEqual(res, { ok: true, text: "THE ACTUAL REPLY" });
  const blob = calls.find((c) => c.args.includes("blob_read"));
  assert.ok(blob, "the reply must be re-read, not the head kept");
  const args = JSON.parse(blob!.args[blob!.args.length - 1]!) as { offset: number };
  assert.equal(args.offset, 892 - 64 * 1024 < 0 ? 0 : 892 - 64 * 1024);
});

test("collectRexResult: an echo-only pane is NOT a reply", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-rex-echo-"));
  const task = "Write exactly WORKER-PROBE-OK to the report file, then reply.";
  const handle = handleWith(cwd, { task });
  rexCli.exec = fakeCli(new Map([
    ["rex block call format", [{
      code: 0,
      stdout: JSON.stringify({
        content: [
          "▀▀█  v1.5.2",
          " π > model > repo",
          task,
          "---",
          "Delivery: when your task is complete, write your full final report as Markdown to `/r.md` " +
            "(create parent directories if needed), then reply with a one-line summary only. " +
            "If follow-up feedback arrives after delivery (e.g. an advisor review), apply it and update the report file to the corrected version.",
        ].join("\n"),
      }),
    }]],
  ]), []) as typeof rexCli.exec;
  const out = await collectRexResult({ handle, exec: rexCli.exec });
  assert.deepEqual(out, { output: "", source: "none" });
});

test("collectRexResult: a real inline reply comes through beyond the contract", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-rex-reply-"));
  const task = "Reply with exactly SCOUT-INLINE-OK and nothing else.";
  const handle = handleWith(cwd, { task, readOnly: true });
  rexCli.exec = fakeCli(new Map([
    ["rex block call format", [{
      code: 0,
      stdout: JSON.stringify({
        content: [
          "▀▀█  v1.5.2",
          task,
          "---",
          "Delivery: this session has read-only tools — do NOT write any files. Reply with your full final report as your final message.",
          "SCOUT-INLINE-OK",
          "↑74 ↓7 R35K CH99.8% · (router) R:90%/54M W:92%/6D M:41%/11D",
          " π > ⬢ ocg/deepseek-v4.1-flash · max > 📁 /tmp > ⑂ main",
        ].join("\n"),
      }),
    }]],
  ]), []) as typeof rexCli.exec;
  const out = await collectRexResult({ handle, exec: rexCli.exec });
  assert.equal(out.source, "pane");
  assert.match(out.output, /SCOUT-INLINE-OK/);
  // Status chrome and the composer must not leak into the payload.
  assert.doesNotMatch(out.output, /↑74/);
  assert.doesNotMatch(out.output, /π >/);
});

test("replyBeyondEcho: cuts at the delivery contract, else at the task echo", () => {
  const text = [
    "chrome",
    "Do the thing.",
    "---",
    "Delivery: this session has read-only tools — do NOT write any files. Reply with your full final report as your final message.",
    "THE ANSWER",
  ].join("\n");
  assert.equal(replyBeyondEcho(text, "Do the thing."), "THE ANSWER");
  // No contract (a follow-up the child typed): cut after the task echo.
  assert.equal(replyBeyondEcho("echoed prompt FOLLOWUP ANSWER", "echoed prompt"), "FOLLOWUP ANSWER");
});

// ---------------------------------------------------------------------------
// Execute: full flow, abort, timeout
// ---------------------------------------------------------------------------

test("executeRexTask: collects the report and stamps the rex pane in the usage line", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-rex-exec-"));
  const handle = handleWith(cwd);
  writeFileSync(handle.resultFile, "FINAL REPORT");
  rexCli.exec = fakeCli(new Map([
    ["rex block call program_status", [piStatus("idle", T0), piStatus("done", T1)]],
    ["rex block call process", [liveProc(), liveProc()]],
    ["rex block send", [{ code: 0, stdout: "{}" }]],
    ["rex block send-key", [{ code: 0, stdout: "{}" }]],
  ]), []) as typeof rexCli.exec;
  const result = await executeRexTask(handle, { exec: rexCli.exec });
  assert.equal(result.status, "success");
  assert.match(result.model ?? "", /rex pane:scout-1/);
  assert.equal(result.bestEffort, false);
  const text = (result.messages[0] as any)?.content?.[0]?.text;
  assert.equal(text, "FINAL REPORT");
});

test("executeRexTask: a timeout interrupts the pane and says so", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-rex-exec-"));
  const handle = handleWith(cwd, { timeoutMs: 400 });
  const calls: Call[] = [];
  rexCli.exec = fakeCli(new Map([
    ["rex block call program_status", [piStatus("idle", T0), ...Array.from({ length: 80 }, () => piStatus("working", T1))]],
    ["rex block call process", Array.from({ length: 90 }, () => liveProc())],
    ["rex block send", [{ code: 0, stdout: "{}" }]],
    ["rex block send-key", Array.from({ length: 10 }, () => ({ code: 0, stdout: "{}" }) as Res)],
  ]), calls) as typeof rexCli.exec;
  const result = await executeRexTask(handle, { exec: rexCli.exec });
  assert.equal(result.status, "timeout");
  assert.match(result.errorMessage ?? "", /may still complete its current write/);
  assert.ok(calls.some((c) => c.args.includes("esc")));
});

test("executeRexTask: an aborted parent maps to status aborted, never success", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-rex-exec-"));
  const handle = handleWith(cwd);
  writeFileSync(handle.resultFile, "REPORT");
  rexCli.exec = fakeCli(new Map([
    ["rex block call program_status", [piStatus("idle", T0), piStatus("done", T1)]],
    ["rex block call process", [liveProc(), liveProc()]],
    ["rex block send", [{ code: 0, stdout: "{}" }]],
    ["rex block send-key", [{ code: 0, stdout: "{}" }]],
  ]), []) as typeof rexCli.exec;
  const controller = new AbortController();
  const promise = executeRexTask(handle, { exec: rexCli.exec, signal: controller.signal });
  controller.abort();
  const result = await promise;
  assert.equal(result.status, "aborted");
  assert.equal(result.stopReason, "aborted");
});

test("cancelRexAgent: esc then ctrl+c only while still working", async () => {
  const escalate: Call[] = [];
  rexCli.exec = fakeCli(new Map([
    ["rex block call program_status", [{ code: 0, stdout: JSON.stringify({ records: [{ state: "working", app: "pi", updated_at: T1 }] }) }]],
    ["rex block call process", [liveProc()]],
    ["rex block send-key", [{ code: 0, stdout: "{}" }, { code: 0, stdout: "{}" }]],
  ]), escalate) as typeof rexCli.exec;
  await cancelRexAgent("block:10", rexCli.exec);
  assert.ok(escalate.some((c) => c.args.includes("ctrl+c")));

  const calm: Call[] = [];
  rexCli.exec = fakeCli(new Map([
    ["rex block call program_status", [piStatus("idle", T0)]],
    ["rex block call process", [liveProc()]],
    ["rex block send-key", [{ code: 0, stdout: "{}" }]],
  ]), calm) as typeof rexCli.exec;
  await cancelRexAgent("block:10", rexCli.exec);
  assert.equal(calm.some((c) => c.args.includes("ctrl+c")), false);
});

// ---------------------------------------------------------------------------
// Delivery contract + registry + control-tool guards
// ---------------------------------------------------------------------------

test("wrapRexTaskPrompt: writable children get the report-file contract; read-only reply inline", () => {
  assert.match(wrapRexTaskPrompt("do it", "/tmp/r.md"), /write your full final report as Markdown to `\/tmp\/r\.md`/);
  assert.match(wrapRexTaskPrompt("do it", "/tmp/r.md", true), /do NOT write any files/);
  assert.match(wrapRexTaskPrompt("do it", "/tmp/r.md", true), /Reply with your full final report/);
});

test("registry: two dispatches register, lookup by name/block id, forget by window drops both", async () => {
  process.env.REX_SESSION = "session:1";
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-rex-reg-"));
  rexCli.exec = fakeCli(new Map([
    ["rex block ls", [
      { code: 0, stdout: JSON.stringify({ blocks: [] }) },
      { code: 0, stdout: JSON.stringify({ blocks: [{ block_id: "block:30", label: "scout-1", window_id: "window:1" }] }) },
      { code: 0, stdout: JSON.stringify({ blocks: [{ block_id: "block:30", label: "scout-1", window_id: "window:1" }] }) },
      { code: 0, stdout: JSON.stringify({ blocks: [{ block_id: "block:30", label: "scout-1", window_id: "window:1" }] }) },
    ]],
    ["rex window ls", [
      { code: 0, stdout: JSON.stringify({ windows: [] }) },
      { code: 0, stdout: JSON.stringify({ windows: [{ window_id: "window:1", label: "scout" }] }) },
    ]],
    ["rex session inspect", [{
      code: 0,
      stdout: JSON.stringify({ windows: [{ window_id: "window:1", label: "scout", focused_block_id: "block:30", layers: [{ kind: "tiled", layout: { rect: [0, 0, 1, 1], block_id: "block:30" } }] }] }),
    }]],
    ["rex window new", [{ code: 0, stdout: JSON.stringify({ window_id: "window:1", block_ids: ["block:30"] }) }]],
    ["rex split", [{ code: 0, stdout: JSON.stringify({ block_ids: ["block:31"] }) }]],
  ]), []) as typeof rexCli.exec;
  const first = await prepareRexTask({ agentType: "scout", systemPrompt: "s", task: "one", cwd, timeoutMs: 60_000 });
  const second = await prepareRexTask({ agentType: "scout", systemPrompt: "s", task: "two", cwd, timeoutMs: 60_000 });
  assert.equal(getRexRegistry().length, 2);
  assert.notEqual(first.name, second.name);
  assert.equal(findRexAgent("block:30")?.name, first.name); // block-id lookup
  assert.equal(findRexAgent(second.name)?.address, "block:31");
  forgetRexWindow("window:1"); // by window id drops every sibling in it
  assert.equal(getRexRegistry().length, 0);
  assert.equal(findRexAgent("block:30"), undefined);
  forgetRexAgent("nope"); // no-op, no throw
});

test("rexWindowCloseBlockers: a busy or unverifiable sibling blocks the close", async () => {
  process.env.REX_SESSION = "session:1";
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-rex-blockers-"));
  rexCli.exec = fakeCli(new Map([
    ["rex block ls", [
      { code: 0, stdout: JSON.stringify({ blocks: [] }) },
      { code: 0, stdout: JSON.stringify({ blocks: [{ block_id: "block:30", label: "scout-1", window_id: "window:1" }] }) },
      { code: 0, stdout: JSON.stringify({ blocks: [{ block_id: "block:30", label: "scout-1", window_id: "window:1" }] }) },
    ]],
    ["rex window ls", [
      { code: 0, stdout: JSON.stringify({ windows: [] }) },
      { code: 0, stdout: JSON.stringify({ windows: [{ window_id: "window:1", label: "scout" }] }) },
    ]],
    ["rex session inspect", [{
      code: 0,
      stdout: JSON.stringify({ windows: [{ window_id: "window:1", label: "scout", focused_block_id: "block:30", layers: [{ kind: "tiled", layout: { rect: [0, 0, 1, 1], block_id: "block:30" } }] }] }),
    }]],
    ["rex window new", [{ code: 0, stdout: JSON.stringify({ window_id: "window:1", block_ids: ["block:30"] }) }]],
    ["rex split", [{ code: 0, stdout: JSON.stringify({ block_ids: ["block:31"] }) }]],
    // Sibling probe: block:31 is mid-turn; the named block:30 is at rest.
    ["rex block call program_status", [piStatus("working", T1), piStatus("idle", T0)]],
    ["rex block call process", [liveProc(), liveProc()]],
  ]), []) as typeof rexCli.exec;
  const first = await prepareRexTask({ agentType: "scout", systemPrompt: "s", task: "one", cwd, timeoutMs: 60_000 });
  await prepareRexTask({ agentType: "scout", systemPrompt: "s", task: "two", cwd, timeoutMs: 60_000 });
  const { siblings, self } = await rexWindowCloseBlockers(first, rexCli.exec);
  assert.equal(siblings.length, 1); // the working sibling blocks the close
  assert.equal(self, undefined);    // the named agent itself is settled
});

test("closeRexWindow: reports CLI failure instead of claiming success", async () => {
  rexCli.exec = fakeCli(new Map([
    ["rex window close", [{ code: 1, stderr: "window not found" }]],
  ]), []) as typeof rexCli.exec;
  const res = await closeRexWindow("window:1", rexCli.exec);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /window not found/);
});

test("prepareRexTask: task over the argv budget is rejected before any topology", async () => {
  process.env.REX_SESSION = "session:1";
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-rex-budget-"));
  const calls: Call[] = [];
  rexCli.exec = fakeCli(new Map(), calls) as typeof rexCli.exec;
  await assert.rejects(
    () => prepareRexTask({ agentType: "scout", systemPrompt: "s", task: "x".repeat(80 * 1024), cwd, timeoutMs: 60_000 }),
    /exceeds the .*byte budget/,
  );
  assert.deepEqual(calls, []); // nothing spawned
});
