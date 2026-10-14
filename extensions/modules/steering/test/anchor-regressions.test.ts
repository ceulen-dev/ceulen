// Regression tests for reviewer-found ds-anchor defects (ported from
// pi-model-tools extensions/test/unit/ds-anchor-regressions.test.ts):
//  1. model_select away from target must NOT re-engage the bootstrap (stale
//     sessionModel fallback) — minimal prompt/tool filter/budget pin must be
//     inert for a non-target model after an explicit switch.
//  2. turn_end with stopReason error/aborted must NOT promote — the retry
//     stays anchored.
//  3. anchorTrace is per-session (reset on session_start).
//  4. max_tokens pin emits exactly one budget field (no conflicting pair).
import assert from "node:assert";
import { describe, it } from "node:test";
import { createFakePi } from "./harness.js";

const MINIMAL = "You are a helpful software engineer assistant.";

describe("ds-anchor regressions", () => {
  it("model_select away from target keeps the anchor inert (no stale sessionModel re-engage)", () => {
    const h = createFakePi();
    h.setEntries([]);
    h.fire("session_start", {}, h.ctx("deepseek-v4-pro-0813"));
    // switch AWAY to flash
    h.fire("model_select", { model: { id: "deepseek-v4-flash" }, previousModel: undefined, source: "set" }, h.ctx("deepseek-v4-flash"));
    const r = h.fire("before_agent_start", { prompt: "x", systemPrompt: "FULL PI PROMPT", systemPromptOptions: {} }, h.ctx("deepseek-v4-flash"));
    assert.notEqual(r?.systemPrompt, MINIMAL, "flash after switch-away must NOT get the minimal prompt");
    const out = h.fire("before_provider_request", { payload: { tools: [{ name: "bash" }, { name: "str_replace_editor" }, { name: "edit" }] } }, h.ctx("deepseek-v4-flash"));
    assert.equal(out?.tools, undefined, "no tool substitution after switch-away");
    assert.equal(out?.max_tokens, undefined, "no budget pin after switch-away");
  });

  it("model_select to target re-engages the bootstrap", () => {
    const h = createFakePi();
    h.setEntries([]);
    h.fire("session_start", {}, h.ctx("deepseek-v4-flash"));
    h.fire("model_select", { model: { id: "deepseek-v4-pro" }, previousModel: undefined, source: "set" }, h.ctx("deepseek-v4-pro"));
    const r = h.fire("before_agent_start", { prompt: "x", systemPrompt: "FULL PI PROMPT", systemPromptOptions: {} }, h.ctx("deepseek-v4-pro"));
    assert.equal(r?.systemPrompt, MINIMAL, "switch to pro engages the bootstrap");
  });

  it("turn_end with stopReason error does NOT promote (retry stays anchored)", () => {
    const h = createFakePi();
    h.setEntries([]);
    h.fire("session_start", {}, h.ctx("deepseek-v4-pro"));
    h.fire("before_agent_start", { prompt: "x", systemPrompt: "FULL", systemPromptOptions: {} }, h.ctx("deepseek-v4-pro"));
    h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "error", content: [] }, toolResults: [] }, h.ctx("deepseek-v4-pro"));
    const r = h.fire("before_agent_start", { prompt: "retry", systemPrompt: "FULL", systemPromptOptions: {} }, h.ctx("deepseek-v4-pro"));
    assert.equal(r?.systemPrompt, MINIMAL, "error reply must not promote; retry re-anchors");
  });

  it("turn_end with stopReason aborted does NOT promote", () => {
    const h = createFakePi();
    h.setEntries([]);
    h.fire("session_start", {}, h.ctx("deepseek-v4-pro"));
    h.fire("before_agent_start", { prompt: "x", systemPrompt: "FULL", systemPromptOptions: {} }, h.ctx("deepseek-v4-pro"));
    h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "aborted", content: [] }, toolResults: [] }, h.ctx("deepseek-v4-pro"));
    const r = h.fire("before_agent_start", { prompt: "retry", systemPrompt: "FULL", systemPromptOptions: {} }, h.ctx("deepseek-v4-pro"));
    assert.equal(r?.systemPrompt, MINIMAL, "aborted reply must not promote");
  });

  it("turn_end with a real reply promotes", () => {
    const h = createFakePi();
    h.setEntries([]);
    h.fire("session_start", {}, h.ctx("deepseek-v4-pro"));
    h.fire("before_agent_start", { prompt: "x", systemPrompt: "FULL", systemPromptOptions: {} }, h.ctx("deepseek-v4-pro"));
    h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop", content: [{ type: "toolCall" }] }, toolResults: [] }, h.ctx("deepseek-v4-pro"));
    const r = h.fire("before_agent_start", { prompt: "next", systemPrompt: "FULL", systemPromptOptions: {} }, h.ctx("deepseek-v4-pro"));
    assert.notEqual(r?.systemPrompt, MINIMAL, "durable reply promotes");
  });

  it("anchorTrace resets per session", () => {
    const h = createFakePi();
    h.setEntries([]);
    h.fire("session_start", {}, h.ctx("deepseek-v4-pro"));
    h.fire("before_agent_start", { prompt: "x", systemPrompt: "FULL", systemPromptOptions: {} }, h.ctx("deepseek-v4-pro"));
    let s = h.status(h.ctx("deepseek-v4-pro"));
    assert.match(s, /bootstrap: minimal prompt engaged/, "trace populated in session 1");
    // new session
    h.fire("session_start", {}, h.ctx("deepseek-v4-pro"));
    s = h.status(h.ctx("deepseek-v4-pro"));
    assert.doesNotMatch(s, /bootstrap: minimal prompt engaged/, "trace does not leak across sessions");
  });

  it("budget pin emits exactly one field and drops the other", () => {
    const h = createFakePi();
    h.setEntries([]);
    h.fire("session_start", {}, h.ctx("deepseek-v4-pro"));
    h.fire("before_agent_start", { prompt: "x", systemPrompt: "FULL", systemPromptOptions: {} }, h.ctx("deepseek-v4-pro"));
    const out = h.fire("before_provider_request", {
      payload: { tools: [{ name: "bash" }, { name: "str_replace_editor" }], max_tokens: 8192, max_completion_tokens: 8192 },
    }, h.ctx("deepseek-v4-pro"));
    assert.equal(out.max_completion_tokens, 256000, "budget pinned on the field the payload already carries");
    assert.equal(out.max_tokens, undefined, "conflicting max_tokens dropped");
  });

  // pi 1.2.0: before_agent_start also fires for sendMessage({triggerTurn: true})
  // runs (cron fires, auto-bg receipts) with messageType "custom" and NO prompt.
  it("a custom-triggered run does NOT consume the bootstrap; the next user turn still gets it", () => {
    const h = createFakePi();
    h.setEntries([]);
    h.fire("session_start", {}, h.ctx("deepseek-v4-pro"));
    // cron-style custom run (no `prompt` field — pi's custom variant)
    const custom = h.fire("before_agent_start", {
      messageType: "custom", message: { customType: "ceulen-cron-fire", content: "job fired" },
      systemPrompt: "FULL PI PROMPT", systemPromptOptions: {},
    }, h.ctx("deepseek-v4-pro"));
    assert.notEqual(custom?.systemPrompt, MINIMAL, "custom run must not get the minimal prompt");
    const out = h.fire("before_provider_request", { payload: { tools: [{ name: "bash" }, { name: "str_replace_editor" }, { name: "edit" }] } }, h.ctx("deepseek-v4-pro"));
    assert.equal(out?.tools, undefined, "custom run keeps the full tool catalog");
    assert.equal(out?.max_tokens, undefined, "custom run gets no budget pin");
    // the bootstrap stayed pending for the next user turn
    const user = h.fire("before_agent_start", { messageType: "user", prompt: "do a task", systemPrompt: "FULL PI PROMPT", systemPromptOptions: {} }, h.ctx("deepseek-v4-pro"));
    assert.equal(user?.systemPrompt, MINIMAL, "the next USER turn still bootstraps");
  });

  it("a custom-triggered run gets no first-tool hints (no prompt to read)", () => {
    const h = createFakePi(["bash", "read", "edit", "grep"]);
    h.setEntries([]);
    h.fire("session_start", {}, h.ctx("deepseek-v4-flash"));
    const custom = h.fire("before_agent_start", {
      messageType: "custom", message: { customType: "ceulen-cron-fire", content: "run the task" },
      systemPrompt: "FULL", systemPromptOptions: {},
    }, h.ctx("deepseek-v4-flash"));
    // The static family guidance still composes; what must NOT appear is the
    // prompt-derived dynamic hint (recognisable by its "Do NOT spawn a task
    // agent" / task-shaped preamble). A user turn with the same text DOES add it.
    const customDynamic = (custom?.systemPrompt ?? "").length;
    const user = h.fire("before_agent_start", { messageType: "user", prompt: "refactor everything in the repo", systemPrompt: "FULL", systemPromptOptions: {} }, h.ctx("deepseek-v4-flash"));
    assert.equal(user?.systemPrompt, custom?.systemPrompt, "a custom run adds no dynamic hint");
    assert.ok(String(custom?.systemPrompt ?? "").startsWith("DeepSeek V4"), "static family guidance still composes on custom runs");
    assert.ok(customDynamic > "FULL".length, "static guidance present");
  });
});
