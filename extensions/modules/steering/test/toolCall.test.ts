// tool_call steering: DeepSeek-only semantic-miss / dedicated-tool behavior,
// the grep/ffgrep never-block rule, the per-turn reminder dedupe, and the
// strictSerena escalation (fixed reminder count — the upstream env knob is
// gone).
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createFakePi, isolateAgentDir, setSteeringSettings } from "./harness.js";

const ACTIVE = ["bash", "read", "edit", "ls", "find", "grep", "serena_find_symbol", "serena_get_symbols_overview"];
const SYMBOL_GREP = { command: "grep -rn 'class UserService' src/index.ts" };
const LS_MISS = { command: "ls extensions" };

let AGENT: string;
let restoreAgentDir: () => void;
before(() => {
  const isolated = isolateAgentDir("ceulen-steering-toolcall-");
  AGENT = isolated.dir;
  restoreAgentDir = isolated.restore;
});
after(() => { restoreAgentDir(); });
beforeEach(() => { setSteeringSettings(AGENT, {}); });

/** Fire one turn's prelude so the per-turn latch is re-armed like production. */
function newTurn(h: ReturnType<typeof createFakePi>, id: string) {
  h.fire("before_agent_start", { systemPrompt: "base", systemPromptOptions: { selectedTools: ACTIVE }, prompt: "go" }, h.ctx(id));
}

describe("semantic-miss steering (DeepSeek V4)", () => {
  it("hard-blocks a simple bash symbol search and suggests Serena", () => {
    const h = createFakePi(ACTIVE);
    const result = h.fire("tool_call", { toolName: "bash", input: SYMBOL_GREP }, h.ctx("deepseek-v4-flash"));
    assert.equal(result?.block, true);
    assert.match(result.reason, /Serena/);
    assert.match(result.reason, /Try: serena_/, "names a Serena entry point");
    assert.equal(h.messages.length, 0, "a block is not a steered message");
  });

  it("never hard-blocks grep/ffgrep — steers once per turn instead", () => {
    const h = createFakePi(ACTIVE);
    const first = h.fire("tool_call", { toolName: "grep", input: { pattern: "UserService", path: "src/index.ts" } }, h.ctx("deepseek-v4-flash"));
    assert.equal(first, undefined, "grep is a first-class tool — never blocked");
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].message.customType, "ceulen-steering");
    assert.equal(h.messages[0].options.deliverAs, "steer");
    assert.match(h.messages[0].message.content, /serena_find_symbol/);
    // Same turn, second miss: deduped.
    h.fire("tool_call", { toolName: "grep", input: { pattern: "UserService", path: "src/index.ts" } }, h.ctx("deepseek-v4-flash"));
    assert.equal(h.messages.length, 1, "one reminder per turn");
    // A Serena call re-arms the latch for the rest of the turn.
    h.fire("tool_call", { toolName: "serena_find_symbol", input: { name_path_pattern: "UserService" } }, h.ctx("deepseek-v4-flash"));
    h.fire("tool_call", { toolName: "grep", input: { pattern: "UserService", path: "src/index.ts" } }, h.ctx("deepseek-v4-flash"));
    assert.equal(h.messages.length, 2, "serena resets the per-turn reminder latch");
  });

  it("steers (never blocks) a dedicated-tool miss by default", () => {
    const h = createFakePi(ACTIVE);
    const result = h.fire("tool_call", { toolName: "bash", input: LS_MISS }, h.ctx("deepseek-v4-flash"));
    assert.equal(result, undefined, "non-strict: reminder only");
    assert.equal(h.messages.length, 1);
    assert.match(h.messages[0].message.content, /dedicated ls tool/);
  });

  it("does not steer for non-DeepSeek families", () => {
    const h = createFakePi(ACTIVE);
    assert.equal(h.fire("tool_call", { toolName: "bash", input: SYMBOL_GREP }, h.ctx("glm-5.2")), undefined);
    assert.equal(h.messages.length, 0);
  });

  it("does not steer when no Serena tool is active (nothing to switch to)", () => {
    const h = createFakePi(["bash", "read", "edit"]);
    assert.equal(h.fire("tool_call", { toolName: "bash", input: SYMBOL_GREP }, h.ctx("deepseek-v4-flash")), undefined);
    assert.equal(h.messages.length, 0);
  });
});

describe("strictSerena escalation", () => {
  it("blocks the same dedicated-tool miss on the 3rd reminder of a session", () => {
    setSteeringSettings(AGENT, { strictSerena: true });
    const h = createFakePi(ACTIVE);
    const id = "deepseek-v4-flash";
    assert.equal(h.fire("tool_call", { toolName: "bash", input: LS_MISS }, h.ctx(id)), undefined, "1st: reminder");
    newTurn(h, id);
    assert.equal(h.fire("tool_call", { toolName: "bash", input: LS_MISS }, h.ctx(id)), undefined, "2nd: reminder");
    newTurn(h, id);
    const third = h.fire("tool_call", { toolName: "bash", input: LS_MISS }, h.ctx(id));
    assert.equal(third?.block, true, "3rd: blocked");
    assert.match(third.reason, /blocked after 3 reminders/);
    assert.equal(h.messages.length, 2, "the two earlier turns steered, the block did not");
  });

  it("never blocks a dedicated-tool miss when strictSerena is off", () => {
    const h = createFakePi(ACTIVE);
    for (let i = 0; i < 5; i++) {
      newTurn(h, "deepseek-v4-flash");
      assert.equal(h.fire("tool_call", { toolName: "bash", input: LS_MISS }, h.ctx("deepseek-v4-flash")), undefined);
    }
    assert.equal(h.messages.length, 5, "one reminder per turn, never a block");
  });
});
