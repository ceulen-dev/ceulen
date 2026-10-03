// Lifecycle test, adapted from pi-model-tools
// extensions/test/unit/ds-anchor-wiring.test.ts: the real module is wired into a
// stub ExtensionAPI and the anchor lifecycle is driven directly —
// session_start → before_agent_start (#1 bootstrap) → before_provider_request
// (tool filter) → tool_call (bootstrap tool gate) → turn_end (promote) →
// before_agent_start #2 (full prompt path).

import assert from "node:assert";
import { after, before } from "node:test";
import { createFakePi, isolateAgentDir } from "./harness.js";

let restoreAgentDir: () => void;
before(() => { restoreAgentDir = isolateAgentDir("ceulen-steering-wiring-").restore; });
after(() => { restoreAgentDir(); });

const MINIMAL = "You are a helpful software engineer assistant.";
const PRO = "deepseek-v4-pro-0813";

// 1. session_start with a target model, empty durable history
const h = createFakePi(["bash", "read", "edit", "grep"]);
h.setEntries([]);
h.fire("session_start", {}, h.ctx(PRO));

// 2. first agent run → bootstrap: minimal prompt, no guidance
const r1 = h.fire("before_agent_start", { prompt: "do a task", systemPrompt: "FULL PI PROMPT", systemPromptOptions: {} }, h.ctx(PRO));
assert.equal(r1?.systemPrompt, MINIMAL, "request #1 gets the Minimal prompt");

// 3. provider request → tools replaced with the byte-exact DSH Minimal pair
const payload = { model: PRO, messages: [], tools: [
  { name: "bash", parameters: {} }, { name: "str_replace_editor", parameters: {} },
  { name: "edit", parameters: {} }, { name: "read", parameters: {} }, { name: "grep", parameters: {} },
] };
const out = h.fire("before_provider_request", { payload }, h.ctx(PRO));
assert.deepEqual(out.tools.map((t: any) => t?.function?.name ?? t?.name), ["bash", "str_replace_editor"], "payload tools replaced with the DSH Minimal pair (flat shape preserved)");
assert.equal(out.tools[0].description.length > 100, true, "DSH bash description is present");
assert.equal(out.tools[1].parameters.properties.command.enum.length, 4, "str_replace_editor command enum present");
assert.equal(out.tools[1].strict, undefined, "no strict field (DSH schema has none)");
assert.equal(out.max_tokens, 256000, "bootstrap budget matches DSH's captured payload");

// 4. tool_call during bootstrap: a name outside the pair is blocked, the pair passes
const blocked = h.fire("tool_call", { toolName: "read", input: {} }, h.ctx(PRO));
assert.equal(blocked?.block, true, "hidden tool (read) blocked during bootstrap");
const blockedEdit = h.fire("tool_call", { toolName: "edit", input: {} }, h.ctx(PRO));
assert.equal(blockedEdit?.block, true, "hidden tool (edit) blocked during bootstrap");
const okBash = h.fire("tool_call", { toolName: "bash", input: { command: "ls" } }, h.ctx(PRO));
assert.equal(okBash, undefined, "bash allowed during bootstrap");
const okEditor = h.fire("tool_call", { toolName: "str_replace_editor", input: { command: "view", path: "/x" } }, h.ctx(PRO));
assert.equal(okEditor, undefined, "str_replace_editor allowed during bootstrap");

// 5. assistant reply lands durably → the next before_agent_start scan promotes
h.setEntries([{ type: "message", message: { role: "assistant", content: [{ type: "toolCall" }] } }]);
h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] }, h.ctx(PRO));

// 6. second agent run → NOT minimal; full-prompt path (returns undefined when unchanged)
const r2 = h.fire("before_agent_start", { prompt: "next task", systemPrompt: "FULL PI PROMPT", systemPromptOptions: {} }, h.ctx(PRO));
assert.notEqual(r2?.systemPrompt, MINIMAL, "request #2 uses the full prompt");

// 7. provider request #2 → tools NOT filtered, budget NOT pinned
const out2 = h.fire("before_provider_request", { payload }, h.ctx(PRO));
assert.equal(out2?.tools, undefined, "no tool filtering after promotion (payload untouched or guidance-only)");
assert.notEqual(out2?.max_tokens, 256000, "budget pin is bootstrap-only");

// 8. non-target model: anchor inert from the start
h.setEntries([]);
h.fire("session_start", {}, h.ctx("deepseek-v4-flash"));
const rFlash = h.fire("before_agent_start", { prompt: "x", systemPrompt: "FULL PI PROMPT", systemPromptOptions: {} }, h.ctx("deepseek-v4-flash"));
assert.notEqual(rFlash?.systemPrompt, MINIMAL, "flash model: normal guidance path, no anchor");
assert.ok(rFlash.systemPrompt.includes("FULL PI PROMPT"), "flash keeps the full prompt");

// 9. resume edge: target session with existing assistant reply → instantly promoted
h.setEntries([{ type: "message", message: { role: "assistant", content: [{ type: "text" }] } }]);
h.fire("session_start", {}, h.ctx(PRO));
const rResume = h.fire("before_agent_start", { prompt: "continue", systemPrompt: "FULL PI PROMPT", systemPromptOptions: {} }, h.ctx(PRO));
assert.notEqual(rResume?.systemPrompt, MINIMAL, "resumed session with replies: no bootstrap");
assert.ok(rResume.systemPrompt.includes("FULL PI PROMPT"), "resumed session keeps the full prompt");

// 10. REGRESSION: session starts as FLASH (a2a gateway agent config), proxy
// silently serves deepseek-v4-pro — model_select NEVER fires. The anchor must
// still engage on the first agent run (live failure: anchorReady was latched
// only at session_start/model_select, so the bootstrap silently skipped).
h.setEntries([]); // genuinely fresh session — no durable replies yet
const servedCtx = h.ctx("deepseek/deepseek-v4-pro", { model: { id: "deepseek/deepseek-v4-pro", provider: "opencode-go" } });
h.fire("session_start", {}, h.ctx("opencode-go/deepseek-v4-flash"));
const rRewritten = h.fire("before_agent_start", { prompt: "task", systemPrompt: "FULL PI PROMPT", systemPromptOptions: {} }, servedCtx);
assert.equal(rRewritten?.systemPrompt, MINIMAL, "served-pro session bootstraps even though session started as flash");
const outRewritten = h.fire("before_provider_request", { payload }, servedCtx);
assert.deepEqual(outRewritten.tools.map((t: any) => t?.function?.name ?? t?.name), ["bash", "str_replace_editor"], "rewritten session gets the DSH Minimal pair");

// 11. anchor trace surfaces in the /steering status output
const h2 = createFakePi(["bash", "read", "edit", "str_replace_editor"]);
h2.setEntries([]);
h2.fire("session_start", {}, h2.ctx("deepseek-v4-pro"));
h2.fire("before_agent_start", { prompt: "x", systemPrompt: "FULL", systemPromptOptions: {} }, h2.ctx("deepseek-v4-pro"));
h2.fire("before_provider_request", { payload: { tools: [{ name: "bash" }, { name: "str_replace_editor" }] } }, h2.ctx("deepseek-v4-pro"));
const statusText = h2.status(h2.ctx("deepseek-v4-pro"));
assert.match(statusText, /bootstrap: minimal prompt engaged/, "trace shows bootstrap engagement");
assert.match(statusText, /payload: tools=\[bash,str_replace_editor\] \+ max_tokens=256000/, "trace shows the bootstrap payload + DSH budget");

console.log("steering ds-anchor wiring: all lifecycle checks passed");
