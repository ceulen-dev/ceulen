// promptAndWait's agent_prompt_stalled recovery — OUTPUT-evidence based.
// herdr 0.9.3's status watcher never observes `working` for pi panes
// (state_change_seq frozen across live turns; live probe 2026-10-10), so its
// `agent prompt --wait` stalls on healthy dispatches and NO state probe can
// recover it. Recovery waits on evidence instead: a changed report-file stamp
// (delivery contract) or a changed-then-quiet pane tail (read-only inline
// replies). Silence through the grace window is a genuine stall.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { captureEvidenceStamp, promptAndWait } from "../lib/herdr.ts";

type FakeRes = { code: number; stdout?: string; stderr?: string };
type Call = { args: string[]; res: { code: number; stdout: string; stderr: string } };

/** Scripted exec: args-signature (first 2 tokens, e.g. "agent read") → responses consumed in order. */
function fakeExec(script: Map<string, FakeRes[]>, calls: Call[]) {
  return async (_cmd: string, args: string[]) => {
    const key = args.slice(0, 2).join(" ");
    const res = { code: 0, stdout: "", stderr: "", ...script.get(key)?.shift() };
    calls.push({ args, res });
    return res;
  };
}

const idleInfo = JSON.stringify({ result: { agent: { name: "a1", agent_status: "idle" } } });
const STALLED = { code: 1, stderr: "error: agent_prompt_stalled: no working within 5000ms" };

function tmpResultFile(): string {
  return join(mkdtempSync(join(tmpdir(), "ceulen-herdr-stalled-")), "report.md");
}

test("captureEvidenceStamp: missing file → empty stamp; existing → size:mtime", async () => {
  const missing = join(tmpdir(), "ceulen-herdr-stamped-", "nope.md");
  const exec = fakeExec(new Map(), []);
  assert.equal((await captureEvidenceStamp({ resultFile: missing }, "a1", exec)).fileStamp, "");
  const f = tmpResultFile();
  writeFileSync(f, "hello");
  const st = statSync(f);
  assert.equal((await captureEvidenceStamp({ resultFile: f }, "a1", exec)).fileStamp, `${st.size}:${st.mtimeMs}`);
});

test("stalled recovery: report file appears during grace → success (fast-child case)", async () => {
  const resultFile = tmpResultFile();
  // Baseline taken BEFORE the file exists (like a first dispatch); the child
  // writing its report is the settle evidence.
  const stamp = await captureEvidenceStamp({ resultFile }, "a1", fakeExec(new Map(), []));
  writeFileSync(resultFile, "# report\n");
  const calls: Call[] = [];
  const script = new Map<string, FakeRes[]>([
    ["agent prompt", [STALLED]],
    ["agent get", [{ code: 0, stdout: idleInfo }]],
  ]);
  const outcome = await promptAndWait({
    name: "a1", text: "t", timeoutMs: 5_000, exec: fakeExec(script, calls),
    evidence: { resultFile, stamp, graceMs: 5_000 },
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.state, "idle");
});

test("stalled recovery: read-only child's pane tail changed + stayed quiet → success", async () => {
  const calls: Call[] = [];
  const script = new Map<string, FakeRes[]>([
    ["agent prompt", [STALLED]],
    ["agent read", [{ code: 0, stdout: "REPLY-DONE" }]],
    ["agent get", [{ code: 0, stdout: idleInfo }]],
  ]);
  const outcome = await promptAndWait({
    name: "a1", text: "t", timeoutMs: 5_000, exec: fakeExec(script, calls),
    evidence: { resultFile: tmpResultFile(), readOnly: true, stamp: { fileStamp: "", paneTail: "PRE-PROMPT" }, graceMs: 15_000 },
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.state, "idle");
});

test("stalled recovery: silence through the evidence window → timeout semantics (delivered, may still complete)", async () => {
  const resultFile = tmpResultFile(); // never written
  const calls: Call[] = [];
  const script = new Map<string, FakeRes[]>([
    ["agent prompt", [STALLED]],
  ]);
  const outcome = await promptAndWait({
    name: "a1", text: "t", timeoutMs: 5_000, exec: fakeExec(script, calls),
    evidence: { resultFile, stamp: { fileStamp: "" }, graceMs: 200 },
  });
  // Exhausted evidence wait = spent budget: the caller interrupts the pane;
  // the dispatch was delivered, so never a hard stall.
  assert.equal(outcome.delivered, true);
  assert.match(outcome.error ?? "", /timeout/);
});

test("stalled without evidence channels → immediate hard fail (CLI-faithful, unchanged)", async () => {
  const calls: Call[] = [];
  const script = new Map<string, FakeRes[]>([["agent prompt", [STALLED]]]);
  const outcome = await promptAndWait({ name: "a1", text: "t", timeoutMs: 5_000, exec: fakeExec(script, calls) });
  assert.equal(outcome.delivered, false);
  assert.match(outcome.error ?? "", /agent_prompt_stalled/);
  // No evidence polling happened (no `agent read` calls).
  assert.equal(calls.filter((c) => c.args[1] === "read").length, 0);
});

test("no regression: plain timeout still short-circuits before the stalled branch", async () => {
  const calls: Call[] = [];
  const script = new Map<string, FakeRes[]>([
    ["agent prompt", [{ code: 1, stderr: "error: timeout after 1000ms" }]],
  ]);
  const outcome = await promptAndWait({ name: "a1", text: "t", timeoutMs: 1000, exec: fakeExec(script, calls) });
  assert.equal(outcome.delivered, true);
  assert.match(outcome.error ?? "", /timeout/);
  assert.equal(calls.filter((c) => c.args[1] === "read").length, 0);
});
