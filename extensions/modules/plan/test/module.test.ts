// Plan module lifecycle: /plan toggle + tool gating + write_plan + approval.
// Handlers fire through the fake-pi harness (module seams, no real session).
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { createFakePi, isolateAgentDir, setPlanSettings } from "./harness.js";

const realAgentDir = process.env.PI_CODING_AGENT_DIR;
let agent: ReturnType<typeof isolateAgentDir>;
let REPO: string;

beforeEach(() => {
  agent = isolateAgentDir();
  REPO = mkdtempSync(join(tmpdir(), "ceulen-plan-repo-"));
});

after(() => {
  agent.restore();
  if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = realAgentDir;
});

/** Start the module in a fresh session at REPO. */
async function start(h = createFakePi()) {
  await h.fire("session_start", { reason: "startup" }, h.ctx({ cwd: REPO }));
  return h;
}

describe("plan mode — toggle", () => {
  it("/plan enters plan mode: mutators stripped, plan tools added, status set", async () => {
    const h = await start();
    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    const active = h.activeTools();
    assert.deepEqual(active.sort(), ["bash", "grep", "read", "write_plan", "ask_user_question"].sort());
    assert.ok(h.entryTypes.includes("ceulen-plan"), "state persisted");
  });

  it("/plan toggles back and restores the original tool set (plan tools stay)", async () => {
    const h = await start();
    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    // write_plan/ask_user_question are session-visible tools: they must stay
    // active after exit (the model can refine a plan during execution).
    assert.deepEqual(h.activeTools().sort(), ["bash", "read", "edit", "write", "grep", "write_plan", "ask_user_question"].sort());
  });

  it("/plan rejects arguments", async () => {
    const h = await start();
    await h.commands.plan.handler("please", h.ctx({ cwd: REPO }));
    assert.ok(h.notifications.some((n) => n.includes("does not take arguments")));
  });
});

describe("plan mode — tool gating", () => {
  it("hard-blocks mutators while planning and lets them through after exit", async () => {
    const h = await start();
    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    const blocked = await h.fire("tool_call", { toolName: "edit", input: {} }, h.ctx({ cwd: REPO }));
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /not available while planning/);

    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    const allowed = await h.fire("tool_call", { toolName: "edit", input: {} }, h.ctx({ cwd: REPO }));
    assert.equal(allowed, undefined);
  });

  it("auto-allows read-only tools and read bash, hard-blocks bash writers", async () => {
    const h = await start();
    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    assert.equal(await h.fire("tool_call", { toolName: "read", input: {} }, h.ctx({ cwd: REPO })), undefined);
    assert.equal(await h.fire("tool_call", { toolName: "bash", input: { command: "git status" } }, h.ctx({ cwd: REPO })), undefined);
    const write = await h.fire("tool_call", { toolName: "bash", input: { command: "echo x > f.txt" } }, h.ctx({ cwd: REPO }));
    assert.equal(write.block, true);
  });

  it("confirm tier: unknown bash prompts; 'Allow for this session' remembers the first token", async () => {
    const h = await start();
    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    const ctx = h.ctx({ cwd: REPO, ui: { ...h.ctx().ui, select: async () => "Allow for this session" } });
    assert.equal(await h.fire("tool_call", { toolName: "bash", input: { command: "npm test" } }, ctx), undefined);
    // Remembered: no prompt, no block on the second call.
    let prompted = false;
    const ctx2 = h.ctx({ cwd: REPO, ui: { ...h.ctx().ui, select: async () => { prompted = true; return "Deny"; } } });
    assert.equal(await h.fire("tool_call", { toolName: "bash", input: { command: "npm test" } }, ctx2), undefined);
    assert.equal(prompted, false, "session allow short-circuits the prompt");
  });

  it("confirm tier: Deny blocks; no-UI blocks outright", async () => {
    const h = await start();
    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    const deny = h.ctx({ cwd: REPO, ui: { ...h.ctx().ui, select: async () => "Deny" } });
    const blocked = await h.fire("tool_call", { toolName: "bash", input: { command: "npm test" } }, deny);
    assert.equal(blocked.block, true);

    const headless = h.ctx({ cwd: REPO, hasUI: false, ui: { ...h.ctx().ui, select: async () => undefined } });
    const blockedHeadless = await h.fire("tool_call", { toolName: "bash", input: { command: "npm test" } }, headless);
    assert.equal(blockedHeadless.block, true);
    assert.match(blockedHeadless.reason, /UI is not available/);
  });

  it("non-read custom tools take the confirm tier, not a hard block", async () => {
    const h = await start();
    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    const allow = await h.fire("tool_call", { toolName: "some_mcp_tool", input: {} }, h.ctx({ cwd: REPO, ui: { ...h.ctx().ui, select: async () => "Allow once" } }));
    assert.equal(allow, undefined);
    const deny = await h.fire("tool_call", { toolName: "some_mcp_tool", input: {} }, h.ctx({ cwd: REPO, ui: { ...h.ctx().ui, select: async () => undefined } }));
    assert.equal(deny.block, true);
  });
});

describe("plan mode — write_plan", () => {
  it("writes to .pi/plans by default and reports the path", async () => {
    const h = await start();
    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    const result = await h.tools.write_plan.execute("tc1", { title: "Add widget", content: "## Approach\nDo it." }, undefined, undefined, h.ctx({ cwd: REPO }));
    const text = result.content[0].text;
    assert.match(text, /Plan written to \.pi\/plans\/\d{4}-.*-add-widget\.md/);
    const file = join(REPO, ".pi", "plans");
    const name = readSyncRecursive(file)[0];
    assert.ok(name, "plan file exists");
    assert.match(readFileSync(join(file, name), "utf8"), /^# Add widget/);
  });

  it("savePlans=approved defers the file until approval", async () => {
    setPlanSettings(agent.dir, { savePlans: "approved" });
    const h = await start();
    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    const result = await h.tools.write_plan.execute("tc1", { title: "Deferred", content: "body" }, undefined, undefined, h.ctx({ cwd: REPO }));
    assert.match(result.content[0].text, /held for approval/);
    assert.equal(existsSync(join(REPO, ".pi", "plans")), false, "no file yet");

    await h.commands["plan-approve"].handler("current", h.ctx({ cwd: REPO }));
    const names = readSyncRecursive(join(REPO, ".pi", "plans"));
    assert.equal(names.length, 1, "file written at approval");
    assert.match(h.userMessages[0].content, /Execute the approved plan/);
  });

  it("savePlans=none keeps the plan in the conversation and disallows new-session execution", async () => {
    setPlanSettings(agent.dir, { savePlans: "none" });
    const h = await start();
    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    const result = await h.tools.write_plan.execute("tc1", { title: "Ephemeral", content: "body" }, undefined, undefined, h.ctx({ cwd: REPO }));
    assert.match(result.content[0].text, /kept in this conversation only/);
    assert.equal(existsSync(join(REPO, ".pi", "plans")), false);

    await h.commands["plan-approve"].handler("new", h.ctx({ cwd: REPO }));
    assert.ok(h.notifications.some((n) => n.includes("fresh-session execution needs a plan file")));

    await h.commands["plan-approve"].handler("current", h.ctx({ cwd: REPO }));
    assert.equal(h.userMessages.length, 1);
    assert.equal(existsSync(join(REPO, ".pi", "plans")), false, "still nothing on disk");
  });

  it("refinement of the same draft reuses its file", async () => {
    const h = await start();
    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    await h.tools.write_plan.execute("tc1", { title: "Same", content: "v1" }, undefined, undefined, h.ctx({ cwd: REPO }));
    await h.tools.write_plan.execute("tc2", { title: "Same", content: "v2" }, undefined, undefined, h.ctx({ cwd: REPO }));
    const names = readSyncRecursive(join(REPO, ".pi", "plans"));
    assert.equal(names.length, 1, "one file for the same draft");
    assert.equal(readFileSync(join(REPO, ".pi", "plans", names[0]), "utf8").trim(), "# Same\n\nv2");
  });
});

describe("plan mode — prompt + approval flow", () => {
  it("injects the plan contract into before_agent_start only while planning", async () => {
    const h = await start();
    const off = await h.fire("before_agent_start", { systemPrompt: "BASE" }, h.ctx({ cwd: REPO }));
    assert.equal(off, undefined, "no injection outside plan mode");

    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    const on = await h.fire("before_agent_start", { systemPrompt: "BASE" }, h.ctx({ cwd: REPO }));
    assert.match(on.systemPrompt, /^BASE/);
    assert.match(on.systemPrompt, /## Plan Mode/);
    assert.match(on.systemPrompt, /\.pi\/plans/);
    assert.match(on.systemPrompt, /decision-complete/);
  });

  it("write_plan marks the plan ready and agent_settled prefills /plan-approve", async () => {
    const h = await start();
    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    await h.tools.write_plan.execute("tc1", { title: "T", content: "body" }, undefined, undefined, h.ctx({ cwd: REPO }));
    let prefilled: string | undefined;
    const ctx = h.ctx({ cwd: REPO, ui: { ...h.ctx().ui, setEditorText: (t: string) => { prefilled = t; } } });
    await h.fire("agent_settled", {}, ctx);
    assert.equal(prefilled, "/plan-approve");
  });

  it("auto-approve executes on settle without a keypress", async () => {
    setPlanSettings(agent.dir, { autoApprove: true });
    const h = await start();
    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    await h.tools.write_plan.execute("tc1", { title: "T", content: "body" }, undefined, undefined, h.ctx({ cwd: REPO }));
    await h.fire("agent_settled", {}, h.ctx({ cwd: REPO }));
    assert.equal(h.userMessages.length, 1);
    assert.equal(h.userMessages[0].options.deliverAs, "followUp");
    assert.match(h.userMessages[0].content, /Execute the approved plan/);
  });

  it("auto-approve never fires off an aborted settle; the plan still approves on a clean one", async () => {
    setPlanSettings(agent.dir, { autoApprove: true });
    const h = await start();
    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    await h.tools.write_plan.execute("tc1", { title: "T", content: "body" }, undefined, undefined, h.ctx({ cwd: REPO }));
    // User hit Escape after write_plan → no autonomous execution.
    await h.fire("agent_settled", { aborted: true }, h.ctx({ cwd: REPO }));
    assert.equal(h.userMessages.length, 0, "aborted settle does not execute");
    // The plan stays pending: the next clean settle approves it.
    await h.fire("agent_settled", {}, h.ctx({ cwd: REPO }));
    assert.equal(h.userMessages.length, 1);
    assert.match(h.userMessages[0].content, /Execute the approved plan/);
  });

  it("/plan-approve without a plan warns", async () => {
    const h = await start();
    await h.commands["plan-approve"].handler("current", h.ctx({ cwd: REPO }));
    assert.ok(h.notifications.some((n) => n.includes("No plan is ready for approval")));
  });

  it("approving clears the draft: re-entering plan mode starts fresh", async () => {
    const h = await start();
    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    await h.tools.write_plan.execute("tc1", { title: "First", content: "body" }, undefined, undefined, h.ctx({ cwd: REPO }));
    await h.commands["plan-approve"].handler("current", h.ctx({ cwd: REPO }));

    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    await h.commands["plan-approve"].handler("current", h.ctx({ cwd: REPO }));
    assert.ok(h.notifications.some((n) => n.includes("No plan is ready for approval")), "stale plan is gone");

    // An unapproved draft survives a toggle so refinement keeps the file.
    await h.tools.write_plan.execute("tc2", { title: "Second", content: "v1" }, undefined, undefined, h.ctx({ cwd: REPO }));
    await h.commands.plan.handler("", h.ctx({ cwd: REPO })); // off
    await h.commands.plan.handler("", h.ctx({ cwd: REPO })); // on
    const result = await h.tools.write_plan.execute("tc3", { title: "Second", content: "v2" }, undefined, undefined, h.ctx({ cwd: REPO }));
    assert.match(result.content[0].text, /Plan written to/);
    const names = readSyncRecursive(join(REPO, ".pi", "plans"));
    // Two plans exist (First's approved file stays as history; Second was
    // refined in place across the toggle).
    assert.equal(names.length, 2, names.join(","));
    assert.equal(readFileSync(join(REPO, ".pi", "plans", names.find((n) => n.includes("second"))!), "utf8").trim(), "# Second\n\nv2");
  });

  it("fresh-session handoff marks the plan approved and does not reuse it as a draft", async () => {
    const h = await start();
    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    await h.tools.write_plan.execute("tc1", { title: "Handoff", content: "body" }, undefined, undefined, h.ctx({ cwd: REPO }));
    await h.commands["plan-approve"].handler("new", h.ctx({ cwd: REPO }));

    // The child session gets the approved plan state, marked so a later
    // plan-mode entry does not mistake it for a draft to refine.
    const handedOff = h.newSessionStates.find((e) => e.customType === "ceulen-plan");
    assert.ok(handedOff, "child session received the plan state entry");
    assert.equal(handedOff.data.planApproved, true, "handed-off plan is marked approved");
    assert.equal(handedOff.data.enabled, false);
    assert.match(handedOff.data.lastPlanPath, /\.pi\/plans\/.*handoff\.md$/);
    assert.equal(h.newSessionMessages.length, 1, "child received the execution prompt");
    assert.match(h.newSessionMessages[0].content, /Execute the approved plan/);

    // Regression: re-entering plan mode after the handoff must NOT reuse the
    // child's plan path — a new plan writes a NEW file.
    await h.commands.plan.handler("", h.ctx({ cwd: REPO }));
    await h.tools.write_plan.execute("tc2", { title: "Handoff", content: "v2" }, undefined, undefined, h.ctx({ cwd: REPO }));
    assert.equal(readSyncRecursive(join(REPO, ".pi", "plans")).filter((n) => n.includes("handoff")).length, 2, "fresh plan file, not an in-place refinement");
  });
});

describe("plan mode — ask_user_question", () => {
  it("returns the selected option and marks the recommendation", async () => {
    const h = await start();
    let dialog: string[] = [];
    const ctx = h.ctx({ cwd: REPO, ui: { ...h.ctx().ui, select: async (_t: string, options: string[]) => { dialog = options; return options[1]; } } });
    const result = await h.tools.ask_user_question.execute("tc1", {
      question: "Which?",
      options: [{ label: "A" }, { label: "B", description: "better" }],
      recommended: "A",
    }, undefined, undefined, ctx);
    assert.equal(dialog[0], "★ A");
    assert.match(dialog[1], /^B — better$/);
    assert.match(result.content[0].text, /User selected: B/);
  });

  it("rejects duplicate/non-matching parameters", async () => {
    const h = await start();
    await assert.rejects(
      () => h.tools.ask_user_question.execute("tc1", { question: "q", options: [{ label: "A" }, { label: "A" }] }, undefined, undefined, h.ctx()),
      /unique/,
    );
    await assert.rejects(
      () => h.tools.ask_user_question.execute("tc1", { question: "q", options: [{ label: "A" }, { label: "B" }], recommended: "C" }, undefined, undefined, h.ctx()),
      /must match/,
    );
  });
});

describe("plan mode — branch restore", () => {
  it("restores enabled state from the persisted entry", async () => {
    const h = createFakePi();
    (h as unknown as { setEntries: (e: unknown[]) => void }).setEntries([
      { type: "custom", customType: "ceulen-plan", data: { enabled: true, toolsBeforePlan: ["bash", "read", "edit", "write", "grep"] } },
    ]);
    await h.fire("session_start", { reason: "resume" }, h.ctx({ cwd: REPO }));
    assert.ok(h.activeTools().includes("write_plan"), "plan tools re-enabled");
    assert.equal(h.activeTools().includes("edit"), false, "mutators stripped");
  });
});

/** Recursively collect file names under dir ([] when missing). */
function readSyncRecursive(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...readSyncRecursive(join(dir, entry.name), `${prefix}${entry.name}/`));
    else out.push(`${prefix}${entry.name}`);
  }
  return out;
}
