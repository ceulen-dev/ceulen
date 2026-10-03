// Tests for the subagent live-UI renderers (OMP-parity indicators).
// Pure functions — null theme renders plain text, so assertions read the raw
// strings (same convention as the render probes).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderLiveThreadLine,
  renderTaskWidget,
  renderWaitTree,
  statusLine,
  SUBAGENT_STATUS_KEY,
} from "../lib/widget.ts";
import type { SubagentThread } from "../lib/threads.ts";

function thread(overrides: Partial<SubagentThread> = {}): SubagentThread {
  const now = Date.now();
  return {
    id: overrides.id ?? "t1",
    agentName: overrides.agentName ?? "scout",
    task: overrides.task ?? "Recon the registry module",
    mode: overrides.mode ?? "single",
    status: overrides.status ?? "running",
    createdAt: overrides.createdAt ?? now - 12_000,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  };
}

test("SUBAGENT_STATUS_KEY keeps the ceulen- conflict prefix", () => {
  assert.equal(SUBAGENT_STATUS_KEY, "ceulen-subagent");
});

test("statusLine: undefined when nothing is running, counts otherwise", () => {
  assert.equal(statusLine([]), undefined);
  assert.equal(statusLine([thread({ status: "completed" })]), undefined);

  assert.equal(statusLine([thread()]), "👥 1 running");
  assert.equal(
    statusLine([thread({ id: "a" }), thread({ id: "b", status: "completed" })]),
    "👥 1 running · 1 ✓",
  );
});

test("renderLiveThreadLine shows tool activity and token counters", () => {
  const messages = [
    {
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id: "c1", name: "read", arguments: { file_path: "/tmp/x.ts" } }],
    },
  ];
  const line = renderLiveThreadLine(
    thread({
      status: "running",
      result: {
        agent: "scout",
        task: "t",
        exitCode: -1,
        messages: messages as never,
        stderr: "",
        usage: { input: 12_300, output: 1_400, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      },
    }),
    null,
    Date.now(),
    "accent",
  );
  assert.match(line, /Scout/);
  assert.match(line, /↑12k|↑12\.3k/);
  assert.match(line, /↓1\.4k/);
  assert.match(line, /read \/tmp\/x\.ts/);
});

test("renderLiveThreadLine falls back to the herdr activity label (no messages)", () => {
  const line = renderLiveThreadLine(
    thread({ agentName: "worker", lastActivityLabel: "herdr: working" }),
    null,
    Date.now(),
    "accent",
  );
  assert.match(line, /Worker/);
  assert.match(line, /herdr: working/);
});

test("renderLiveThreadLine drops raw SDK event labels (tool lines are the signal)", () => {
  const line = renderLiveThreadLine(
    thread({ lastActivityLabel: "message_end" }),
    null,
    Date.now(),
    "accent",
  );
  assert.doesNotMatch(line, /message_end/);
});

test("statusLine and widget header count failures as ✗, not ✓", () => {
  const threads = [
    thread({ id: "a" }),
    thread({ id: "b", status: "completed" }),
    thread({ id: "c", status: "failed" }),
  ];
  assert.equal(statusLine(threads), "👥 1 running · 1 ✓ · 1 ✗");
  const text = renderTaskWidget({ threads, width: 100, theme: null }).join("\n");
  assert.match(text, /Subagents · 1 running · 1 ✓ · 1 ✗/);
});

test("renderTaskWidget: header counts, per-thread lines, inspect hint", () => {
  const lines = renderTaskWidget({
    threads: [
      thread({ id: "a", agentName: "scout" }),
      thread({ id: "b", agentName: "tester", status: "completed" }),
      thread({ id: "c", agentName: "worker", status: "completed" }),
    ],
    width: 100,
    theme: null,
  });
  const text = lines.join("\n");
  assert.match(text, /Subagents · 1 running · 2 ✓/);
  assert.match(text, /Scout/);
  // Completed threads never render a body line of their own.
  assert.doesNotMatch(text, /^Tester/m);
  assert.match(text, /\/agent to inspect/);
});

test("renderTaskWidget: empty when nothing is running", () => {
  assert.deepEqual(renderTaskWidget({ threads: [thread({ status: "completed" })], width: 100 }), []);
});

test("renderWaitTree: counts, focus-first ordering, done rows", () => {
  const lines = renderWaitTree({
    taskId: "bg-2",
    focusThreadId: "t2",
    threads: [
      thread({ id: "t1", agentName: "scout" }),
      thread({ id: "t2", agentName: "worker" }),
      thread({
        id: "t3",
        agentName: "tester",
        status: "completed",
        updatedAt: Date.now(),
        result: {
          agent: "tester", task: "t", exitCode: 0, messages: [
            { role: "assistant", content: [{ type: "text", text: "All 12 tests pass" }] },
          ] as never,
          stderr: "",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        },
      }),
    ],
    width: 100,
    theme: null,
  });
  const text = lines.join("\n");
  assert.match(text, /waiting on 2 of 3 jobs/);
  assert.match(text, /1 done/);
  // The waited task reads before the other running thread.
  assert.ok(text.indexOf("Worker") < text.indexOf("Scout"), "focus thread first");
  assert.match(text, /✓ Tester/);
  // Settled row carries the OMP-style output snippet.
  assert.match(text, /⎿ All 12 tests pass/);
  assert.match(text, /\/agent to inspect/);
});

test("renderWaitTree: failures are counted ✗, never as done", () => {
  const lines = renderWaitTree({
    taskId: "bg-1",
    threads: [
      thread({ id: "t1", status: "completed" }),
      thread({ id: "t2", status: "failed" }),
      thread({ id: "t3" }),
    ],
    width: 100,
    theme: null,
  });
  const text = lines.join("\n");
  assert.match(text, /waiting on 1 of 3 jobs/);
  assert.match(text, /1 done 1 ✗/);
  assert.match(text, /✓ Scout/);
  assert.match(text, /✗ Scout/);
});

test("renderWaitTree: unknown task but live threads still render the fleet", () => {
  const lines = renderWaitTree({
    taskId: "bg-gone",
    threads: [thread({ id: "t1" })],
    width: 100,
    theme: null,
  });
  assert.match(lines.join("\n"), /waiting on 1 of 1 jobs/);
});

test("renderWaitTree: no threads at all falls back to a single waiting line", () => {
  const lines = renderWaitTree({ taskId: "bg-x", threads: [], width: 100, theme: null });
  assert.match(lines[0]!, /waiting on task bg-x/);
});

test("renderWaitTree: settled fleet drops the waiting header", () => {
  const lines = renderWaitTree({
    taskId: "bg-1",
    threads: [thread({ id: "t1", status: "completed" }), thread({ id: "t2", status: "failed" })],
    width: 100,
    theme: null,
  });
  const text = lines.join("\n");
  assert.match(text, /2 jobs settled/);
  assert.doesNotMatch(text, /waiting on/);
  assert.match(text, /✓ Scout/);
  assert.match(text, /✗ Scout/);
});
