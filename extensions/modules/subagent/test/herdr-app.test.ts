// herdr-app delegation backend (lib/herdr-app.ts): detection, name allocation
// against `hc ls`, tab/permission topology, prompt+wait mapping, collection,
// and the abort/timeout result mapping. Every CLI call is scripted through the
// `herdrAppCli.exec` seam (the herdr.ts `herdrCli` precedent).

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  cancelAppAgent,
  clearHerdrAppRegistry,
  collectAppResult,
  executeHerdrAppTask,
  findHerdrAppAgent,
  forgetHerdrAppTab,
  getHerdrAppRegistry,
  getTerminal,
  herdrAppCli,
  herdrAppDisabled,
  herdrAppEnvDetected,
  isDelegatedHerdrAppAgent,
  prepareHerdrAppTask,
  promptAppAndWait,
  probeHerdrAppBinary,
  wrapAppTaskPrompt,
  type HerdrAppHandle,
} from "../lib/herdr-app.ts";

type Res = { code: number; stdout?: string; stderr?: string };
type Call = { cmd: string; args: string[] };

/** Scripted exec: "cmd key" → queued responses; unscripted calls answer 0/{}. */
function fakeCli(script: Map<string, Res[]>, calls: Call[]) {
  return async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args[0] ?? ""}`;
    const res = { code: 0, stdout: "{}", stderr: "", ...script.get(key)?.shift() };
    calls.push({ cmd, args });
    return res;
  };
}

/** `hc get` reply: a live, input-ready pi reporting idle at `turn`. */
function readyPi(turn = 0): Res {
  return { code: 0, stdout: JSON.stringify({ address: "t20", state: "live", turn, status: { app: "pi", state: "idle" } }) };
}

afterEach(() => {
  clearHerdrAppRegistry();
  herdrAppCli.exec = ((cmd: string, args: string[]) => {
    // Reset to a benign default so a leaked script never affects another test.
    return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
  }) as typeof herdrAppCli.exec;
  delete process.env.HC_TERMINAL_ID;
  delete process.env.PI_SUBAGENT_HERDR;
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test("herdrAppEnvDetected: HC_TERMINAL_ID is the marker (HERDR_ENV is the TUI's)", () => {
  delete process.env.HC_TERMINAL_ID;
  assert.equal(herdrAppEnvDetected(), false);
  process.env.HC_TERMINAL_ID = "t2";
  assert.equal(herdrAppEnvDetected(), true);
});

test("herdrAppDisabled: subagent.herdr:\"off\" and the child guard both disable", () => {
  assert.equal(herdrAppDisabled(undefined), false);
  assert.equal(herdrAppDisabled({ herdr: "off" }), true);
  assert.equal(herdrAppDisabled({ herdr: "auto" }), false);
  process.env.PI_SUBAGENT_HERDR = "off";
  assert.equal(herdrAppDisabled(undefined), true);
});

test("probeHerdrAppBinary: needs BOTH binaries (app for layout, hc for terminals)", async () => {
  const calls: Call[] = [];
  // hc answers, herdr-app does not → not usable.
  herdrAppCli.exec = fakeCli(new Map([["herdr-app --version", [{ code: 1 }]]]), calls) as typeof herdrAppCli.exec;
  assert.equal(await probeHerdrAppBinary(herdrAppCli.exec), false);
  assert.deepEqual(calls.map((c) => c.cmd).sort(), ["hc", "herdr-app"]);

  const okCalls: Call[] = [];
  herdrAppCli.exec = fakeCli(new Map([
    ["herdr-app --version", [{ code: 0, stdout: "herdr-app 0.9.5" }]],
    ["hc --version", [{ code: 0, stdout: "hc 0.1.21" }]],
  ]), okCalls) as typeof herdrAppCli.exec;
  assert.equal(await probeHerdrAppBinary(herdrAppCli.exec), true);
});

// ---------------------------------------------------------------------------
// Terminal state
// ---------------------------------------------------------------------------

test("getTerminal maps the hc status object; unknown shapes fail closed", async () => {
  const calls: Call[] = [];
  herdrAppCli.exec = fakeCli(new Map([
    ["hc get", [{ code: 0, stdout: JSON.stringify({ address: "t7", state: "live", status: { app: "pi", state: "working" }, cwd: "/repo" }) }]],
  ]), calls) as typeof herdrAppCli.exec;
  const info = await getTerminal("t7", herdrAppCli.exec);
  assert.equal(info?.status, "working");
  assert.equal(info?.app, "pi");
  assert.equal(info?.state, "live");
  assert.equal(info?.cwd, "/repo");

  herdrAppCli.exec = fakeCli(new Map([
    ["hc get", [{ code: 0, stdout: JSON.stringify({ state: "live", status: { app: "pi", state: "something-new" } }) }]],
  ]), []) as typeof herdrAppCli.exec;
  assert.equal((await getTerminal("t7", herdrAppCli.exec))?.status, "unknown");

  herdrAppCli.exec = fakeCli(new Map([
    ["hc get", [{ code: 3, stderr: JSON.stringify({ error: { kind: "not_found", message: "no terminal" } }) }]],
  ]), []) as typeof herdrAppCli.exec;
  assert.equal(await getTerminal("nope", herdrAppCli.exec), undefined);
});

// ---------------------------------------------------------------------------
// Prepare: topology
// ---------------------------------------------------------------------------

const SPACES_EMPTY = JSON.stringify({ spaces: [] });
function spacesWith(tabName: string, terminals: { pane: string; terminal: string }[], tabId = "tab-existing") {
  return JSON.stringify({
    spaces: [{
      id: "sp1",
      name: "ceulen",
      machine: null,
      tabs: [{ id: tabId, name: tabName, terminals }],
    }],
  });
}

test("prepare: no app window → clear failure, no orphan registry entry", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-app-prep-"));
  const calls: Call[] = [];
  herdrAppCli.exec = fakeCli(new Map([
    ["hc ls", [{ code: 0, stdout: JSON.stringify({ terminals: [] }) }]],
    ["herdr-app ls", [{ code: 0, stdout: SPACES_EMPTY }]],
  ]), calls) as typeof herdrAppCli.exec;
  await assert.rejects(
    () => prepareHerdrAppTask({ agentType: "scout", systemPrompt: "s", task: "t", cwd, timeoutMs: 60_000 }),
    /no window\/space is open/,
  );
  assert.equal(getHerdrAppRegistry().length, 0);
});

test("prepare: creates one tab per agent type with the pi argv from the agent contract", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-app-prep-"));
  const calls: Call[] = [];
  herdrAppCli.exec = fakeCli(new Map([
    ["hc ls", [{ code: 0, stdout: JSON.stringify({ terminals: [] }) }]],
    ["herdr-app ls", [{ code: 0, stdout: JSON.stringify({ spaces: [{ id: "sp1", name: "ceulen", machine: null, tabs: [] }] }) }]],
    ["herdr-app do", [{ code: 0, stdout: JSON.stringify({ space: "sp1", tab: "tab-new", terminal: "t20" }) }]],
  ]), calls) as typeof herdrAppCli.exec;
  const handle = await prepareHerdrAppTask({
    agentType: "scout",
    systemPrompt: "you are scout",
    task: "find things",
    cwd,
    model: "router/ds-flash",
    thinking: "off",
    tools: ["read", "grep"],
    timeoutMs: 60_000,
  });
  assert.equal(handle.tabName, "scout");
  assert.equal(handle.tabId, "tab-new");
  assert.equal(handle.address, "t20");
  assert.equal(handle.tabCreatedHere, true);
  assert.ok(handle.resultFile.startsWith(join(cwd, ".pi", "herdr-app")));
  // The dispatch is registered so the control tool can see it.
  assert.equal(isDelegatedHerdrAppAgent("t20"), true);
  assert.equal(findHerdrAppAgent(handle.name)?.address, "t20");
  // tab.new carries the argv + no-focus (the window must not jump).
  const tabNew = calls.find((c) => c.cmd === "herdr-app" && c.args[1] === "tab.new");
  assert.ok(tabNew);
  const payload = JSON.parse(tabNew!.args[2]!) as Record<string, unknown>;
  assert.equal(payload.name, "scout");
  assert.equal(payload.folder, cwd);
  assert.equal(payload.focus, false);
  const argv = payload.argv as string[];
  // argv[0] must be the PROGRAM: the app launcher execs argv[0] and forwards
  // the rest (unlike `herdr agent start --kind pi`, which supplies pi itself).
  assert.equal(argv[0], "pi");
  assert.ok(argv.includes("--append-system-prompt"));
  assert.ok(argv.includes("--model"));
  assert.ok(argv.includes("--tools"));
  assert.ok(argv.includes("--session-id"));
  assert.ok(argv.includes("--name"));
});

test("prepare: adopts an existing same-type tab (never close-eligible) and splits a pane", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-app-prep-"));
  const calls: Call[] = [];
  herdrAppCli.exec = fakeCli(new Map([
    ["hc ls", [{ code: 0, stdout: JSON.stringify({ terminals: [{ address: "t5", name: "scout-1" }] }) }]],
    ["herdr-app ls", [{ code: 0, stdout: spacesWith("scout", [{ pane: "p31", terminal: "t5" }]) }]],
    ["herdr-app do", [{ code: 0, stdout: JSON.stringify({ pane: "p32", terminal: "t21" }) }]],
  ]), calls) as typeof herdrAppCli.exec;
  const handle = await prepareHerdrAppTask({ agentType: "scout", systemPrompt: "s", task: "t", cwd, timeoutMs: 60_000 });
  assert.equal(handle.tabId, "tab-existing");
  assert.equal(handle.tabCreatedHere, false); // adopted → not ours to close
  assert.equal(handle.address, "t21");
  // allocateName avoided the live name scout-1.
  assert.notEqual(handle.name, "scout-1");
  const split = calls.find((c) => c.args[1] === "pane.split");
  assert.ok(split);
  const payload = JSON.parse(split!.args[2]!) as Record<string, unknown>;
  assert.equal(payload.pane, "p31"); // anchored on the last existing pane
  assert.ok(payload.direction === "right" || payload.direction === "down");
});

// ---------------------------------------------------------------------------
// Prompt + wait
// ---------------------------------------------------------------------------

test("promptAppAndWait: a settled turn maps to its reported status", async () => {
  herdrAppCli.exec = fakeCli(new Map([
    // Readiness gate: hc get must see a live idle pi before the send.
    ["hc get", [readyPi(0)]],
    ["hc send", [{
      code: 0,
      stdout: JSON.stringify({ started: true, status: "idle", turn: 0, wait: { ended: true, reason: "status", status: "done", turn: 1 } }),
    }]],
  ]), []) as typeof herdrAppCli.exec;
  const out = await promptAppAndWait({ address: "t20", text: "hi", timeoutMs: 60_000, exec: herdrAppCli.exec });
  assert.deepEqual(out, { state: "done", delivered: true });
});

test("promptAppAndWait: blocked skill refusal (exit 9) is not a delivery", async () => {
  herdrAppCli.exec = fakeCli(new Map([
    ["hc get", [readyPi(0)]],
    ["hc send", [{ code: 9, stderr: JSON.stringify({ error: { kind: "blocked", message: "program is blocked" } }) }]],
  ]), []) as typeof herdrAppCli.exec;
  const out = await promptAppAndWait({ address: "t20", text: "hi", timeoutMs: 60_000, exec: herdrAppCli.exec });
  assert.equal(out.delivered, false);
  assert.equal(out.state, "blocked");
  assert.match(out.error ?? "", /blocked/i);
});

test("promptAppAndWait: wait timeout keeps delivery=true and reports the timeout", async () => {
  herdrAppCli.exec = fakeCli(new Map([
    ["hc get", [readyPi(0), { code: 0, stdout: JSON.stringify({ state: "live", status: { app: "pi", state: "working" } }) }]],
    ["hc send", [{ code: 0, stdout: JSON.stringify({ started: true, wait: { ended: false, reason: "timeout", status: "working" } }) }]],
  ]), []) as typeof herdrAppCli.exec;
  const out = await promptAppAndWait({ address: "t20", text: "hi", timeoutMs: 5_000, exec: herdrAppCli.exec });
  assert.equal(out.delivered, true);
  assert.equal(out.state, "working");
  assert.match(out.error ?? "", /timeout after 5000ms/);
});

test("promptAppAndWait: a pre-aborted signal never touches the CLI", async () => {
  const calls: Call[] = [];
  herdrAppCli.exec = fakeCli(new Map(), calls) as typeof herdrAppCli.exec;
  const controller = new AbortController();
  controller.abort();
  const out = await promptAppAndWait({ address: "t20", text: "hi", timeoutMs: 1_000, exec: herdrAppCli.exec, signal: controller.signal });
  assert.equal(out.delivered, false);
  assert.match(out.error ?? "", /aborted/);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Readiness gate + paste-never-submitted guard (live incident 2026-11-17)
// ---------------------------------------------------------------------------

test("promptAppAndWait: waits for an input-ready pi before sending", async () => {
  const calls: Call[] = [];
  herdrAppCli.exec = fakeCli(new Map([
    // Booting: reports no status word yet, so it is NOT ready.
    ["hc get", [
      { code: 0, stdout: JSON.stringify({ state: "live", status: { app: "pi", state: "working" } }) },
      readyPi(0),
      { code: 0, stdout: JSON.stringify({ state: "live", status: { app: "pi", state: "done" } }) },
    ]],
    ["hc send", [{ code: 0, stdout: JSON.stringify({ started: true, wait: { ended: true, reason: "status", status: "done", turn: 1 } }) }]],
  ]), calls) as typeof herdrAppCli.exec;
  const out = await promptAppAndWait({ address: "t20", text: "hi", timeoutMs: 60_000, exec: herdrAppCli.exec });
  assert.equal(out.delivered, true);
  // Two readiness polls happened BEFORE the send.
  const sendIdx = calls.findIndex((c) => c.args[0] === "send");
  const getsBefore = calls.slice(0, sendIdx).filter((c) => c.args[0] === "get").length;
  assert.equal(getsBefore, 2);
});

test("promptAppAndWait: a `done` agent is ready — follow-ups to a settled pane must not time out", async () => {
  // pi reports `done` for a turn that finished unwatched; that composer takes
  // input exactly like `idle`. Accepting only `idle` made every follow-up
  // prompt wait 120s and fail (live 2026-11-17).
  herdrAppCli.exec = fakeCli(new Map([
    ["hc get", [
      { code: 0, stdout: JSON.stringify({ address: "t20", state: "live", turn: 1, status: { app: "pi", state: "done" } }) },
      { code: 0, stdout: JSON.stringify({ address: "t20", state: "live", turn: 2, status: { app: "pi", state: "done" } }) },
    ]],
    ["hc send", [{ code: 0, stdout: JSON.stringify({ started: true, wait: { ended: true, reason: "status", status: "done", turn: 2 } }) }]],
  ]), []) as typeof herdrAppCli.exec;
  const out = await promptAppAndWait({ address: "t20", text: "follow up", timeoutMs: 10_000, exec: herdrAppCli.exec });
  assert.equal(out.delivered, true);
  assert.equal(out.state, "done");
});

test("waitForReady rejects a working or blocked child (not ready)", async () => {
  // Nothing but `working` replies: the gate must give up, never send.
  const calls: Call[] = [];
  herdrAppCli.exec = fakeCli(new Map([
    ["hc get", Array.from({ length: 200 }, () => ({
      code: 0,
      stdout: JSON.stringify({ address: "t20", state: "live", turn: 0, status: { app: "pi", state: "working" } }),
    }))],
  ]), calls) as typeof herdrAppCli.exec;
  const out = await promptAppAndWait({ address: "t20", text: "x", timeoutMs: 5_000, exec: herdrAppCli.exec });
  assert.equal(out.delivered, false);
  assert.equal(calls.some((c) => c.args[0] === "send"), false); // never sent
});

test("promptAppAndWait: a settled reply with an UNCHANGED turn is not a delivery", async () => {
  herdrAppCli.exec = fakeCli(new Map([
    ["hc get", [readyPi(3), { code: 0, stdout: JSON.stringify({ state: "live", status: { app: "pi", state: "idle" } }) }]],
    // Pasted but never submitted: the child never worked, turn stays put.
    ["hc send", [{ code: 0, stdout: JSON.stringify({ started: false, wait: { ended: true, reason: "status", status: "idle", turn: 3 } }) }]],
  ]), []) as typeof herdrAppCli.exec;
  const out = await promptAppAndWait({ address: "t20", text: "hi", timeoutMs: 60_000, exec: herdrAppCli.exec });
  assert.equal(out.delivered, false);
  // Either guard may fire (started:false precedes the turn check) — both mean
  // "the paste never became work".
  assert.match(out.error ?? "", /did not start working|never submitted/);
});

test("collectAppResult: a pane holding only the task echo is NOT a reply", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-app-echo-"));
  const handle = handleWith(cwd);
  // Real shape from the failed live dispatch: boot chrome + the echoed task.
  const pane = [
    "▀▀█  v1.5.2",
    " █▀ █ escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more",
    "Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
    "[Context]",
    "  .pi/herdr-app/worker-1.system.md",
    "esc interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more",
    "π > ocg/deepseek-v4.1-flash > repo",
    `Write exactly WORKER-PROBE-OK to the report file, then reply.`,
    "---",
    "Delivery: when your task is complete, write your full final report as Markdown to `/r.md` " +
      "(create parent directories if needed), then reply with a one-line summary only. " +
      "If follow-up feedback arrives after delivery (e.g. an advisor review), apply it and update the report file to the corrected version.",
  ].join("\n");
  herdrAppCli.exec = fakeCli(new Map([["hc read", [{ code: 0, stdout: pane }]]]), []) as typeof herdrAppCli.exec;
  const out = await collectAppResult({ handle, exec: herdrAppCli.exec });
  assert.deepEqual(out, { output: "", source: "none" });
});

test("collectAppResult: a real inline reply still comes through (hc-wrapped)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-app-reply-"));
  const handle = { ...handleWith(cwd), readOnly: true, task: "Reply with exactly SCOUT-INLINE-OK and nothing else." };
  // Verbatim shape of a live read-only dispatch (alternate-screen capture):
  // boot chrome, the hc-wrapped task, then the child's inline answer.
  const pane = [
    "▀▀█  v1.5.2",
    " █▀ █ escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more",
    " Press ctrl+o to show full startup help and loaded resources.",
    " Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
    "[Skills]",
    "  a2a, cron, deploy-checks, find-skills, herdr, munin, ponytail, review, web",
    "[Extensions]",
    "  ceulen, herdr-agent-state.ts",
    "[a2a] gateway channel open: remote@172.30.55.22:9920 as mbp-sao-9916 (firewall-safe receive)",
    ' <hc from="t2">Reply with exactly SCOUT-INLINE-OK and nothing else.',
    " ────────────────────────────────────────────────────────────────────────────────",
    " Delivery: this session has read-only tools — do NOT write any files. Reply with your full final report as your final",
    " message.</hc>",
    " SCOUT-INLINE-OK",
    "↑74 ↓7 R35K CH99.8% · (router) R:90%/54M W:92%/6D M:41%/11D",
    " π > ⬢ ocg/deepseek-v4.1-flash · max > 📁 /Volumes/Dev/agents/ceulen > ⑂ main *2 ?3 ─4%─────┃1M─",
  ].join("\n");
  herdrAppCli.exec = fakeCli(new Map([["hc read", [{ code: 0, stdout: pane }]]]), []) as typeof herdrAppCli.exec;
  const out = await collectAppResult({ handle, exec: herdrAppCli.exec });
  assert.equal(out.source, "pane");
  assert.match(out.output, /SCOUT-INLINE-OK/);
});

// ---------------------------------------------------------------------------
// Collection + cancel
// ---------------------------------------------------------------------------

function handleWith(cwd: string): HerdrAppHandle {
  return {
    tabName: "scout", tabId: "tab-1", address: "t20", paneId: "p1", name: "scout-1",
    agentType: "scout", task: "t", resultFile: join(cwd, "report.md"),
    advisorMarker: join(cwd, "m.json"), model: "router/x", timeoutMs: 60_000, tabCreatedHere: true,
  };
}

test("collectAppResult: the report file wins over the pane", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-app-collect-"));
  const handle = handleWith(cwd);
  writeFileSync(handle.resultFile, "REPORT BODY");
  const calls: Call[] = [];
  herdrAppCli.exec = fakeCli(new Map(), calls) as typeof herdrAppCli.exec;
  const out = await collectAppResult({ handle, exec: herdrAppCli.exec });
  assert.deepEqual(out, { output: "REPORT BODY", source: "file" });
  assert.equal(calls.length, 0); // no pane read when the contract file exists
});

test("collectAppResult: falls back to hc read and marks it as a pane capture", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-app-collect-"));
  const handle = { ...handleWith(cwd), readOnly: true, task: "Report the pane." };
  herdrAppCli.exec = fakeCli(new Map([
    ["hc read", [{
      code: 0,
      stdout: [
        "▀▀█  v1.5.2",
        "[Skills]",
        "  review, web",
        "Report the pane.",
        "---",
        "Delivery: this session has read-only tools — do NOT write any files. Reply with your full final report as your final message.",
        "PANE CAPTURE REPLY",
        "π > model > repo",
        "╰─",
      ].join("\n"),
    }]],
  ]), []) as typeof herdrAppCli.exec;
  const out = await collectAppResult({ handle, exec: herdrAppCli.exec });
  assert.equal(out.output, "PANE CAPTURE REPLY");
  assert.equal(out.source, "pane");
});

test("cancelAppAgent: escalates to hc kill only while still working", async () => {
  const escalateCalls: Call[] = [];
  herdrAppCli.exec = fakeCli(new Map([
    ["hc interrupt", [{ code: 0, stdout: JSON.stringify({ status: "working" }) }]],
    ["hc get", [{ code: 0, stdout: JSON.stringify({ state: "live", status: { state: "working" } }) }]],
    ["hc kill", [{ code: 0, stdout: JSON.stringify({ address: "t20" }) }]],
  ]), escalateCalls) as typeof herdrAppCli.exec;
  await cancelAppAgent("t20", herdrAppCli.exec);
  assert.ok(escalateCalls.some((c) => c.args[0] === "kill"));

  const calmCalls: Call[] = [];
  herdrAppCli.exec = fakeCli(new Map([
    ["hc interrupt", [{ code: 0, stdout: JSON.stringify({ status: "idle" }) }]],
  ]), calmCalls) as typeof herdrAppCli.exec;
  await cancelAppAgent("t20", herdrAppCli.exec);
  assert.equal(calmCalls.some((c) => c.args[0] === "kill"), false);
});

// ---------------------------------------------------------------------------
// Execute: full flow, abort, timeout
// ---------------------------------------------------------------------------

test("executeHerdrAppTask: collects the report and stamps the app pane in the usage line", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-app-exec-"));
  const handle = handleWith(cwd);
  writeFileSync(handle.resultFile, "FINAL REPORT");
  herdrAppCli.exec = fakeCli(new Map([
    ["hc get", [readyPi(0), { code: 0, stdout: JSON.stringify({ state: "live", status: { app: "pi", state: "done" } }) }]],
    ["hc send", [{ code: 0, stdout: JSON.stringify({ started: true, wait: { ended: true, reason: "status", status: "done", turn: 1 } }) }]],
  ]), []) as typeof herdrAppCli.exec;
  const result = await executeHerdrAppTask(handle, { exec: herdrAppCli.exec });
  assert.equal(result.status, "success");
  assert.match(result.model ?? "", /herdr pane:scout-1/);
  // Report-file source → NOT best-effort (the boolean is always present).
  assert.equal(result.bestEffort, false);
  const text = (result.messages[0] as any)?.content?.[0]?.text;
  assert.equal(text, "FINAL REPORT");
});

test("executeHerdrAppTask: a timeout interrupts the pane and says so", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-app-exec-"));
  const handle = handleWith(cwd);
  const calls: Call[] = [];
  herdrAppCli.exec = fakeCli(new Map([
    ["hc get", [readyPi(0), { code: 0, stdout: JSON.stringify({ state: "live", status: { app: "pi", state: "working" } }) }]],
    ["hc send", [{ code: 0, stdout: JSON.stringify({ started: true, wait: { ended: false, reason: "timeout", status: "working" } }) }]],
    ["hc interrupt", [{ code: 0, stdout: JSON.stringify({ status: "idle" }) }]],
  ]), calls) as typeof herdrAppCli.exec;
  const result = await executeHerdrAppTask(handle, { exec: herdrAppCli.exec });
  assert.equal(result.status, "timeout");
  assert.match(result.errorMessage ?? "", /may still complete its current write/);
  assert.ok(calls.some((c) => c.args[0] === "interrupt"));
});

test("executeHerdrAppTask: an aborted parent maps to status aborted, never success", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-app-exec-"));
  const handle = handleWith(cwd);
  writingReport(handle.resultFile);
  herdrAppCli.exec = fakeCli(new Map([
    ["hc get", [readyPi(0), { code: 0, stdout: JSON.stringify({ state: "live", status: { app: "pi", state: "done" } }) }]],
    ["hc send", [{ code: 0, stdout: JSON.stringify({ started: true, wait: { ended: true, reason: "status", status: "done", turn: 1 } }) }]],
  ]), []) as typeof herdrAppCli.exec;
  const controller = new AbortController();
  // Abort after the prompt resolves: the result must still be stamped aborted.
  const promise = executeHerdrAppTask(handle, { exec: herdrAppCli.exec, signal: controller.signal });
  controller.abort();
  const result = await promise;
  assert.equal(result.status, "aborted");
  assert.equal(result.stopReason, "aborted");
});

function writingReport(file: string): void {
  writeFileSync(file, "REPORT");
}

test("executeHerdrAppTask: a pane-sourced answer is flagged bestEffort as DATA, not as a text prefix", async () => {
  // Live 2026-11-17: the old `[best-effort pane capture]` TEXT prefix travelled
  // into `{previous}` chain substitution, and the next child read the marker
  // as a prompt-injection signal and derailed. Provenance must be data.
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-app-be-"));
  const handle = { ...handleWith(cwd), readOnly: true, task: "Reply with exactly BE-OK" };
  herdrAppCli.exec = fakeCli(new Map([
    ["hc get", [readyPi(0), { code: 0, stdout: JSON.stringify({ state: "live", status: { app: "pi", state: "done" } }) }]],
    ["hc send", [{ code: 0, stdout: JSON.stringify({ started: true, wait: { ended: true, reason: "status", status: "done", turn: 1 } }) }]],
    ["hc read", [{
      code: 0,
      stdout: [
        "Reply with exactly BE-OK",
        "---",
        "Delivery: this session has read-only tools — do NOT write any files. Reply with your full final report as your final message.",
        "BE-OK",
        "π > model > repo",
      ].join("\n"),
    }]],
  ]), []) as typeof herdrAppCli.exec;
  const result = await executeHerdrAppTask(handle, { exec: herdrAppCli.exec });
  assert.equal(result.status, "success");
  assert.equal(result.bestEffort, true);
  const text = (result.messages[0] as any)?.content?.[0]?.text ?? "";
  assert.equal(text, "BE-OK");                       // clean payload for {previous}
  assert.doesNotMatch(text, /best-effort/i);         // no marker in the text
});

// ---------------------------------------------------------------------------
// Delivery contract + registry
// ---------------------------------------------------------------------------

test("wrapAppTaskPrompt: writable children get the report-file contract; read-only reply inline", () => {
  assert.match(wrapAppTaskPrompt("do it", "/tmp/r.md"), /write your full final report as Markdown to `\/tmp\/r\.md`/);
  assert.match(wrapAppTaskPrompt("do it", "/tmp/r.md", true), /do NOT write any files/);
  assert.match(wrapAppTaskPrompt("do it", "/tmp/r.md", true), /Reply with your full final report/);
});

test("registry: two dispatches register, lookup by name/address, forget by tab drops both", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ceulen-app-reg-"));
  herdrAppCli.exec = fakeCli(new Map([
    ["hc ls", [
      { code: 0, stdout: JSON.stringify({ terminals: [] }) },
      { code: 0, stdout: JSON.stringify({ terminals: [{ address: "t30", name: "scout-1" }] }) },
    ]],
    // First prepare: empty space (create). Second: the created tab is listed
    // (adopt + split) — exactly what a same-type follow-up sees.
    ["herdr-app ls", [
      { code: 0, stdout: JSON.stringify({ spaces: [{ id: "sp1", name: "c", machine: null, tabs: [] }] }) },
      { code: 0, stdout: spacesWith("scout", [{ pane: "p1", terminal: "t30" }], "tab-1") },
    ]],
    ["herdr-app do", [
      { code: 0, stdout: JSON.stringify({ zone: 1, tab: "tab-1", terminal: "t30" }) },
      { code: 0, stdout: JSON.stringify({ pane: "p2", terminal: "t31" }) },
    ]],
  ]), []) as typeof herdrAppCli.exec;

  const first = await prepareHerdrAppTask({ agentType: "scout", systemPrompt: "s", task: "one", cwd, timeoutMs: 60_000 });
  const second = await prepareHerdrAppTask({ agentType: "scout", systemPrompt: "s", task: "two", cwd, timeoutMs: 60_000 });
  // Both siblings share one tab but stay individually addressable.
  assert.equal(getHerdrAppRegistry().length, 2);
  assert.notEqual(first.name, second.name);
  assert.equal(findHerdrAppAgent(first.name)?.address, "t30");
  assert.equal(findHerdrAppAgent("t31")?.name, second.name); // address lookup
  forgetHerdrAppTab("tab-1"); // by tab ID drops every sibling in it
  assert.equal(getHerdrAppRegistry().length, 0);
  assert.equal(isDelegatedHerdrAppAgent("t30"), false);
});
