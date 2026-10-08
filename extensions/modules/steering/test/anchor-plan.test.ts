// ds-anchor × plan mode: the bootstrap DEFERS while plan mode is active.
// Plan mode strips the mutator tools (str_replace_editor is in plan's
// BLOCKED_TOOLS), so the DSH pair can never reach the payload — previously
// the anchor fail-opened PERMANENTLY there: warning + anchorPromoted latch +
// request #1 shipped with the minimal persona and NO plan-mode contract.
// Deferral keeps the session anchorable and the warning silent.

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { createFakePi, isolateAgentDir } from "./harness.js";
import { setPlanActive } from "../../../lib/plan-bridge.ts";

const MINIMAL = "You are a helpful software engineer assistant.";
const PRO = "deepseek-v4-pro";
// Plan-mode-shaped catalog: reads + plan tools, NO mutator pair.
const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", "write_plan", "ask_user_question"];

describe("ds-anchor × plan mode", () => {
  let restoreAgentDir: () => void;
  before(() => { restoreAgentDir = isolateAgentDir("ceulen-steering-plan-").restore; });
  after(() => { setPlanActive(false); restoreAgentDir(); });

  it("defers while plan mode is active: no minimal prompt, no tool filter, no fail-open warning", () => {
    setPlanActive(true);
    const h = createFakePi(PLAN_TOOLS);
    h.setEntries([]);
    h.fire("session_start", {}, h.ctx(PRO));

    const r = h.fire("before_agent_start", { prompt: "plan it", systemPrompt: "FULL PI PROMPT", systemPromptOptions: {} }, h.ctx(PRO));
    assert.notEqual(r?.systemPrompt, MINIMAL, "no minimal prompt while planning");
    assert.ok(r?.systemPrompt === undefined || r.systemPrompt.includes("FULL PI PROMPT"), "composed prompt preserved (plan contract survives)");

    // The payload that triggered the live bug: plan-filtered catalog without str_replace_editor.
    const out = h.fire("before_provider_request", { payload: { tools: PLAN_TOOLS.map((name) => ({ name })) } }, h.ctx(PRO));
    assert.equal(out?.tools, undefined, "no tool substitution while planning");
    assert.equal(out?.max_tokens, undefined, "no budget pin while planning");
    assert.equal(h.notifications.length, 0, "no fail-open warning");
  });

  it("bootstrap engages on the first post-exit turn when no assistant reply landed", () => {
    setPlanActive(true);
    const h = createFakePi(PLAN_TOOLS);
    h.setEntries([]);
    h.fire("session_start", {}, h.ctx(PRO));
    h.fire("before_agent_start", { prompt: "plan it", systemPrompt: "FULL PI PROMPT", systemPromptOptions: {} }, h.ctx(PRO));
    h.fire("before_provider_request", { payload: { tools: PLAN_TOOLS.map((name) => ({ name })) } }, h.ctx(PRO));
    assert.equal(h.notifications.length, 0, "still no warning after exit");

    setPlanActive(false);
    const r2 = h.fire("before_agent_start", { prompt: "now do it", systemPrompt: "FULL PI PROMPT", systemPromptOptions: {} }, h.ctx(PRO));
    assert.equal(r2?.systemPrompt, MINIMAL, "plan exit with no durable reply → bootstrap fires");
  });

  it("plan-mode assistant replies promote naturally (no post-exit re-anchor)", () => {
    setPlanActive(true);
    const h = createFakePi(PLAN_TOOLS);
    h.setEntries([]);
    h.fire("session_start", {}, h.ctx(PRO));
    h.setEntries([{ type: "message", message: { role: "assistant", content: [{ type: "text" }] } }]);

    setPlanActive(false);
    const r = h.fire("before_agent_start", { prompt: "execute", systemPrompt: "FULL PI PROMPT", systemPromptOptions: {} }, h.ctx(PRO));
    assert.notEqual(r?.systemPrompt, MINIMAL, "history diverged from DSH distribution — no re-anchor");
  });

  it("/steering status discloses the deferral", () => {
    setPlanActive(true);
    const h = createFakePi(PLAN_TOOLS);
    h.setEntries([]);
    h.fire("session_start", {}, h.ctx(PRO));
    assert.ok(h.status(h.ctx(PRO)).includes("deferred (plan mode)"));
  });
});
