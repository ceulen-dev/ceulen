// /steering status surface: the command is the only in-session view of the
// module's state, so every field the port promises is asserted here.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createFakePi, isolateAgentDir, setSteeringSettings } from "./harness.js";

let AGENT: string;
let restoreAgentDir: () => void;
before(() => {
  const isolated = isolateAgentDir("ceulen-steering-status-");
  AGENT = isolated.dir;
  restoreAgentDir = isolated.restore;
});
after(() => { restoreAgentDir(); });
beforeEach(() => { setSteeringSettings(AGENT, {}); });

describe("/steering status", () => {
  it("reports family, requested/served model and every steering flag", () => {
    const h = createFakePi(["bash", "read"]);
    h.fire("session_start", {}, h.ctx("deepseek-v4-flash"));
    const text = h.status(h.ctx("deepseek-v4-flash"));
    assert.match(text, /## steering status/);
    assert.match(text, /\*\*Active family:\*\* deepseek-v4/);
    assert.match(text, /Requested: test\/deepseek-v4-flash/);
    assert.match(text, /Served: test\/deepseek-v4-flash/);
    assert.match(text, /First-tool hints \(all families\): on/);
    assert.match(text, /Selection guidance \(DeepSeek V4\): on/);
    assert.match(text, /Super Power Mode \(DeepSeek V4\): off/);
    assert.match(text, /Strict Serena \(DeepSeek V4\): off/);
    assert.match(text, /Reasoning strip: on/);
    assert.match(text, /ds-anchor \(deepseek-v4-pro\): off/);
    assert.match(text, /We-need directive \(bootstrap\): off/);
    assert.match(text, /Super Power turns: 0/);
  });

  it("reflects settings rows and the custom Super Power prompt", () => {
    setSteeringSettings(AGENT, { superpower: true, superpowerPrompt: "loud", strictSerena: true, stripReasoning: false });
    const h = createFakePi(["bash", "read"]);
    h.fire("session_start", {}, h.ctx("deepseek-v4-flash"));
    const text = h.status(h.ctx("deepseek-v4-flash"));
    assert.match(text, /Super Power Mode \(DeepSeek V4\): on \(custom prompt\)/);
    assert.match(text, /Strict Serena \(DeepSeek V4\): on \(block after 3 reminders\)/);
    assert.match(text, /Reasoning strip: off/);
  });

  it("flags a thinking level below the recipe's max while the anchor is active", () => {
    const h = createFakePi(["bash", "read"]);
    const ctx = h.ctx("deepseek-v4-pro", { thinkingLevel: "high" });
    h.fire("session_start", {}, ctx);
    h.fire("before_agent_start", { prompt: "x", systemPrompt: "FULL", systemPromptOptions: {} }, ctx);
    const below = h.status(ctx);
    assert.match(below, /Thinking level: high \(recipe wants max\)/);
    assert.match(below, /ds-anchor \(deepseek-v4-pro\): bootstrapping/);
    // A level change past max clears the marker.
    h.fire("thinking_level_select", { level: "max", previousLevel: "high" }, ctx);
    assert.match(h.status(ctx), /Thinking level: max$/m);
  });

  it("shows the error tally and the ds-anchor trace ring", () => {
    const h = createFakePi(["bash", "read"]);
    const ctx = h.ctx("deepseek-v4-pro");
    h.setEntries([]);
    h.fire("session_start", {}, ctx);
    h.fire("tool_execution_end", { toolName: "read", isError: true, result: "ENOENT: no such file or directory" }, ctx);
    h.fire("before_agent_start", { prompt: "x", systemPrompt: "FULL", systemPromptOptions: {} }, ctx);
    const text = h.status(ctx);
    assert.match(text, /\*\*Errors:\*\* 1 total, last: path_not_found on read/);
    assert.match(text, /\*\*ds-anchor trace:\*\*/);
    assert.match(text, /bootstrap: minimal prompt engaged/);
  });
});
