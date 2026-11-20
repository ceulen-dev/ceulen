// Drive the same bootstrap lifecycle for both target model IDs.
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { createFakePi, isolateAgentDir, setSteeringSettings } from "./harness.js";
import { BOOTSTRAP_TOOLS, MINIMAL_SYSTEM_PROMPT, WE_NEED_DIRECTIVE } from "../lib/anchor.js";

const PRO = "deepseek-v4-pro-0813";
const FLASH = "combo/deepseek-v4.1-flash";
const TOOLS = ["bash", "str_replace_editor", "read", "find", "apply_patch", "codemode"];
let isolated: ReturnType<typeof isolateAgentDir>;
before(() => { isolated = isolateAgentDir("ceulen-steering-wiring-"); });
after(() => isolated.restore());

for (const id of [PRO, FLASH]) {
  it(`${id}: anchors request #1 only, then restores the full composed prompt and catalog in the same turn`, () => {
    const h = createFakePi(TOOLS);
    const ctx = h.ctx(id);
    h.fire("session_start", {}, ctx);
    const { systemPrompt } = h.fire("before_agent_start", { prompt: "Read limits.ts", systemPrompt: "FULL PI PROMPT" }, ctx);
    assert.match(systemPrompt, /FULL PI PROMPT/);
    assert.match(systemPrompt, /Batch independent calls/);
    const payload = { model: id, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: "Read limits.ts" }], tools: TOOLS.map((name) => ({ function: { name } })), max_tokens: 384000 };
    const out = h.fire("before_provider_request", { payload }, ctx);
    assert.deepEqual(out.tools.map((t: any) => t.function.name), BOOTSTRAP_TOOLS);
    assert.equal(out.messages[0].content, MINIMAL_SYSTEM_PROMPT);
    assert.match(out.messages[1].content, /current workspace with bash \(`find \. -name/);
    assert.doesNotMatch(out.messages[1].content, /Call find FIRST/, "no find-tool hint while find is unavailable");
    assert.equal(out.max_tokens, 256000);
    assert.match(h.status(ctx), /bootstrap: minimal prompt engaged; tools=\[bash,str_replace_editor\]/);
    assert.equal(h.fire("tool_call", { toolName: "read", input: {} }, ctx)?.block, true);
    assert.equal(h.fire("tool_call", { toolName: "str_replace_editor", input: { command: "view", path: "/x" } }, ctx), undefined);
    h.fire("turn_end", { message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall" }] } }, ctx);
    assert.equal(h.fire("tool_call", { toolName: "read", input: {} }, ctx), undefined);
    const next = { ...payload, messages: [...payload.messages, { role: "tool", content: "result" }] };
    assert.equal(h.fire("before_provider_request", { payload: next }, ctx), undefined);
    assert.equal(next.messages[0].content, systemPrompt);
    assert.equal(next.tools.length, TOOLS.length);
  });
}

it("keeps guidance and loadout when the pair is absent or hidden", () => {
  for (const active of [["read", "find"], TOOLS]) {
    const h = createFakePi(active);
    const ctx = h.ctx(FLASH);
    h.fire("session_start", {}, ctx);
    const hiddenTools = active === TOOLS ? ["bash", "str_replace_editor"] : [];
    const { systemPrompt } = h.fire("before_agent_start", { prompt: "Read limits.ts", systemPrompt: "CHILD CONTRACT", systemPromptOptions: { selectedTools: active, hiddenTools } }, ctx);
    const payload = { messages: [{ role: "system", content: systemPrompt }, { role: "user", content: "Read limits.ts" }], tools: active.filter((name) => !hiddenTools.includes(name)).map((name) => ({ name })) };
    const out = h.fire("before_provider_request", { payload }, ctx);
    assert.match(out.messages[0].content, /CHILD CONTRACT/);
    assert.match(out.messages[1].content, /Call find FIRST/);
    assert.deepEqual(out.tools, payload.tools);
    assert.equal(out.max_tokens, undefined);
    assert.equal(h.notifications.length, 0);
  }
});

it("fails open atomically when the wire tools differ from the selected tools", () => {
  const h = createFakePi(TOOLS);
  const ctx = h.ctx(FLASH);
  h.fire("session_start", {}, ctx);
  h.fire("before_agent_start", { prompt: "hello", systemPrompt: "FULL" }, ctx);
  const payload = { messages: [{ role: "system", content: "FULL" }], tools: [{ name: "bash" }, { name: "read" }] };
  assert.equal(h.fire("before_provider_request", { payload }, ctx), undefined);
  assert.equal(h.fire("tool_call", { toolName: "read", input: {} }, ctx), undefined);
  assert.match(h.notifications[0], /full prompt and catalog preserved/);
});

it("anchors the proxied served model, honors the we-need flag and clamps to the model limit", () => {
  setSteeringSettings(isolated.dir, { weNeed: true });
  try {
    const h = createFakePi(TOOLS);
    h.fire("session_start", {}, h.ctx("deepseek-v4-flash"));
    const ctx = h.ctx(FLASH, { model: { id: FLASH, provider: "router", maxTokens: 64000 } });
    h.fire("before_agent_start", { prompt: "task", systemPrompt: "FULL" }, ctx);
    const payload = { messages: [{ role: "developer", content: "FULL" }], tools: TOOLS.map((name) => ({ name })), max_tokens: 8192, max_completion_tokens: 8192 };
    const out = h.fire("before_provider_request", { payload }, ctx);
    assert.equal(out.messages[0].content, WE_NEED_DIRECTIVE + MINIMAL_SYSTEM_PROMPT);
    assert.equal(out.max_completion_tokens, 64000);
    assert.equal(out.max_tokens, undefined);
  } finally { setSteeringSettings(isolated.dir, {}); }
});
