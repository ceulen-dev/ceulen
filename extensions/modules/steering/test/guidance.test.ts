// Ported from pi-model-tools extensions/test/unit/guidance.test.ts.
// Local change: the PI_MODEL_TOOLS_* env toggles are `steering` settings rows
// now, so the hook tests write a settings file into a temp agent dir and fire a
// turn (settings are re-read per before_agent_start).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { createFakePi, isolateAgentDir } from "./harness.js";
import {
  applyPatchPreferenceGuidance,
  clearGuidanceCache,
  deepSeekSelectionGuidance,
  githubCloneFirstToolHint,
  readUncertainPathHint,
  runTaskFirstToolHint,
  superPowerPrompt,
} from "../lib/guidance.js";

let AGENT: string;
let restoreAgentDir: () => void;

before(() => {
  const isolated = isolateAgentDir("ceulen-steering-guidance-");
  AGENT = isolated.dir;
  restoreAgentDir = isolated.restore;
});
after(() => { restoreAgentDir(); });
beforeEach(() => { writeFileSync(join(AGENT, "settings.json"), "{}"); });
/** Write the `steering` section the next turn will read. */
const setSettings = (steering: Record<string, unknown>) => writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ steering }));

describe("deepSeekSelectionGuidance", () => {
  it("includes the compact routing table with serena entries when serena is active", () => {
    const g = deepSeekSelectionGuidance(["read", "bash", "serena_find_symbol", "serena_find_referencing_symbols"]);
    assert.match(g, /pick the right tool on the first try/);
    assert.match(g, /"run tests".*bash/);
    assert.match(g, /path uncertain.*find before read/);
    assert.match(g, /serena_find_symbol/);
    assert.match(g, /serena_find_referencing_symbols/);
    assert.match(g, /serena_get_symbols_overview/);
  });

  it("omits serena entries when serena is not active", () => {
    const g = deepSeekSelectionGuidance(["ls", "grep", "bash", "write"]);
    assert.doesNotMatch(g, /serena/);
    assert.match(g, /"list files in <dir>" → ls/);
    assert.match(g, /create a file → write/);
  });

  it("produces consistent memoized output for same tool set", () => {
    clearGuidanceCache();
    const a = deepSeekSelectionGuidance(["bash", "read"]);
    const b = deepSeekSelectionGuidance(["read", "bash"]);
    const c = deepSeekSelectionGuidance(["bash", "read", "serena_find_symbol"]);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe("runTaskFirstToolHint", () => {
  it("fires a bash-FIRST hint for run/build/execute tasks", () => {
    assert.match(runTaskFirstToolHint("Run the unit tests.")!, /FIRST tool call MUST be bash/i);
    assert.ok(runTaskFirstToolHint("Build the project and report errors."));
    assert.ok(runTaskFirstToolHint("Lint the source files."));
    assert.ok(runTaskFirstToolHint("Execute the test suite."));
    assert.ok(runTaskFirstToolHint("Compile the TypeScript."));
  });

  it("returns undefined for discovery/explanation tasks (no false positives)", () => {
    assert.equal(runTaskFirstToolHint("Find all test files for the project."), undefined);
    assert.equal(runTaskFirstToolHint("Find TypeScript test files under extensions/test."), undefined);
    assert.equal(runTaskFirstToolHint("Inspect symbols in index.ts and summarize them."), undefined);
    assert.equal(runTaskFirstToolHint("Find the definition of deepSeekSelectionGuidance."), undefined);
    assert.equal(runTaskFirstToolHint("Analyze the codebase at https://github.com/octocat/Hello-World."), undefined);
    assert.equal(runTaskFirstToolHint("List files in the project."), undefined);
    assert.equal(runTaskFirstToolHint("How does the test runner work?"), undefined);
    assert.equal(runTaskFirstToolHint(""), undefined);
  });
});

describe("readUncertainPathHint", () => {
  it("fires a find-FIRST hint for bare-filename reads with no directory path", () => {
    assert.match(readUncertainPathHint("Read the first 20 lines of guidance.ts under the lib dir.")!, /Call find FIRST/i);
    assert.ok(readUncertainPathHint("Show me the contents of cli.py."));
    assert.ok(readUncertainPathHint("Read auth.ts."));
  });

  it("returns undefined when an exact dir/file path is given or for non-read/symbol tasks", () => {
    assert.equal(readUncertainPathHint("Read only the first 20 lines of README.md."), undefined);
    assert.equal(readUncertainPathHint("Read the README scope section."), undefined);
    assert.equal(readUncertainPathHint("Inspect symbols in extensions/index.ts and summarize them."), undefined);
    assert.equal(readUncertainPathHint("Find the definition of deepSeekSelectionGuidance."), undefined);
    assert.equal(readUncertainPathHint("Read src/config/app.ts carefully."), undefined);
    assert.equal(readUncertainPathHint("Run the unit tests."), undefined);
    assert.equal(readUncertainPathHint(""), undefined);
  });
});

describe("githubCloneFirstToolHint", () => {
  it("fires a bash-FIRST hint for analyze-a-repo-URL requests", () => {
    assert.match(githubCloneFirstToolHint("Analyze the codebase at https://github.com/octocat/Hello-World and summarize its structure.")!, /FIRST tool call MUST be bash.*git clone/is);
    assert.ok(githubCloneFirstToolHint("Review the code at https://gitlab.com/foo/bar."));
    assert.ok(githubCloneFirstToolHint("Understand the architecture of https://github.com/owner/repo.git"));
  });

  it("returns undefined for page-level reads (issues/PRs) and non-repo/non-analyze prompts", () => {
    assert.equal(githubCloneFirstToolHint("Read the issue at https://github.com/octocat/Hello-World/issues/1."), undefined, "issue page → web tool");
    assert.equal(githubCloneFirstToolHint("Summarize PR https://github.com/owner/repo/pull/42."), undefined, "PR → web tool");
    assert.equal(githubCloneFirstToolHint("What is the release at https://github.com/owner/repo/releases/tag/v1?"), undefined, "release → web tool");
    assert.equal(githubCloneFirstToolHint("Inspect symbols in pi-model-tools/extensions/index.ts."), undefined, "no repo URL");
    assert.equal(githubCloneFirstToolHint("Run the tests."), undefined, "no repo URL");
    assert.equal(githubCloneFirstToolHint(""), undefined);
  });
});

describe("applyPatchPreferenceGuidance", () => {
  it("returns guidance when apply_patch is in active tools", () => {
    const out = applyPatchPreferenceGuidance(["edit", "apply_patch", "read"]);
    assert.ok(out, "expected guidance when apply_patch active");
    assert.match(out!, /apply_patch/);
    assert.match(out!, /UNIQUELY/i);
    assert.match(out!, /frontmatter/i, "should mention YAML frontmatter");
    assert.match(out!, /Create a new file .* write .*never create files from bash/i, "should steer file creation away from bash writes");
    assert.match(out!, /one-strike/i, "should mention one-strike-switch rule");
    assert.match(out!, /≤3 lines/, "should mention ~3-line threshold for edit");
  });

  it("returns undefined when apply_patch is not active", () => {
    assert.equal(applyPatchPreferenceGuidance(["edit", "read", "bash"]), undefined);
  });
});

describe("superPowerPrompt", () => {
  it("returns the base prompt when no custom text is configured", () => {
    const result = superPowerPrompt();
    assert.ok(result.length > 100);
    assert.match(result, /DEEPSEEK-V4-SUPERPOWER/);
    assert.match(result, /NEVER refuse/);
  });

  it("uses the custom text when the settings row is set", () => {
    assert.equal(superPowerPrompt("You are a helpful assistant."), "You are a helpful assistant.");
    assert.match(superPowerPrompt("   "), /DEEPSEEK-V4-SUPERPOWER/);
  });
});

describe("prompt-aware hints apply to ALL families (not DeepSeek-only)", () => {
  it("fires github-clone and run hints for a GLM model", () => {
    const { fire, ctx } = createFakePi(["bash", "find", "read"]);
    const beforeStart = fire("before_agent_start",
      { systemPrompt: "base", systemPromptOptions: { selectedTools: ["bash", "find", "read"] }, prompt: "Analyze the codebase at https://github.com/octocat/Hello-World and summarize its structure." },
      ctx("glm-5.2"));
    // Hints are per-turn dynamic → injected into the current user message by
    // before_provider_request, NOT the system prompt (cache-head stability).
    assert.equal(beforeStart, undefined, "no static system-prompt content for this tool set (no apply_patch → no patch hint)");
    const payload = { messages: [{ role: "user", content: "Analyze the codebase at https://github.com/octocat/Hello-World." }] };
    const result = fire("before_provider_request", { payload }, ctx("glm-5.2"));
    assert.ok(result, "GLM should receive prompt-aware hints via the user message");
    assert.match(result.messages[0].content, /FIRST tool call MUST be bash.*git clone/is);
    // GLM must NOT receive the verbose DeepSeek selection-guidance text block.
    assert.doesNotMatch(result.messages[0].content, /DeepSeek V4 — pick the right tool/);
    assert.doesNotMatch(result.messages[0].content, /DEEPSEEK-V4-SUPERPOWER/);
  });

  it("fires read-uncertain-path hint for a GLM bare-filename read", () => {
    const { fire, ctx } = createFakePi(["find", "read"]);
    const beforeStart = fire("before_agent_start",
      { systemPrompt: "base", systemPromptOptions: { selectedTools: ["find", "read"] }, prompt: "Read the first 20 lines of guidance.ts under pi-model-tools." },
      ctx("glm-5.2"));
    assert.equal(beforeStart, undefined, "no DeepSeek selection-guidance block for this tool set");
    const payload = { messages: [{ role: "user", content: "Read the first 20 lines of guidance.ts under pi-model-tools." }] };
    const result = fire("before_provider_request", { payload }, ctx("glm-5.2"));
    assert.ok(result);
    assert.match(result.messages[0].content, /Call find FIRST/i);
  });

  it("GLM + apply_patch active → patch-hint guidance is appended to the system prompt", () => {
    const { fire, ctx } = createFakePi(["edit", "apply_patch", "read"]);
    const beforeStart = fire("before_agent_start",
      { systemPrompt: "base", systemPromptOptions: { selectedTools: ["edit", "apply_patch", "read"] }, prompt: "Refactor the auth module." },
      ctx("glm-5.2"));
    assert.ok(beforeStart, "GLM should receive the static patch-hint block (un-gated 2026-09)");
    assert.match(beforeStart.systemPrompt, /apply_patch \(preferred for non-trivial edits\)/);
    assert.match(beforeStart.systemPrompt, /Create a new file .* write .*never create files from bash/i);
    // DeepSeek-only blocks stay absent for GLM.
    assert.doesNotMatch(beforeStart.systemPrompt, /DeepSeek V4 — pick the right tool/);
    assert.doesNotMatch(beforeStart.systemPrompt, /DEEPSEEK-V4-SUPERPOWER/);
  });

  it("leaves the incoming system prompt intact (compose, never clobber)", () => {
    const { fire, ctx } = createFakePi(["edit", "apply_patch", "read"]);
    const incoming = "PONYTAIL LINE\n\nAdvisor notes: …\n\nbase prompt";
    const beforeStart = fire("before_agent_start",
      { systemPrompt: incoming, systemPromptOptions: { selectedTools: ["edit", "apply_patch", "read"] }, prompt: "refactor" },
      ctx("glm-5.2"));
    assert.ok(beforeStart.systemPrompt.startsWith(incoming), "earlier handlers' prompt text is preserved verbatim as the head");
  });
});

describe("Super Power Mode (settings row `steering.superpower`)", () => {
  it("injects the super power prompt into the system prompt when enabled for DeepSeek V4", () => {
    setSettings({ superpower: true });
    const { fire, ctx } = createFakePi(["read", "bash"]);
    const result = fire("before_agent_start", { systemPrompt: "base prompt", systemPromptOptions: { selectedTools: ["read", "bash"] } }, ctx("deepseek-v4-flash"));
    assert.ok(result, "should return a modified system prompt");
    assert.match(result.systemPrompt, /DEEPSEEK-V4-SUPERPOWER/);
    assert.match(result.systemPrompt, /base prompt/);
    assert.ok(result.systemPrompt.indexOf("DEEPSEEK-V4-SUPERPOWER") < result.systemPrompt.indexOf("base prompt"),
      "super power prompt should appear before the base system prompt");
  });

  it("uses the custom prompt text from steering.superpowerPrompt", () => {
    setSettings({ superpower: true, superpowerPrompt: "You are CUSTOM SUPERPOWER." });
    const { fire, ctx } = createFakePi(["read", "bash"]);
    const result = fire("before_agent_start", { systemPrompt: "base", systemPromptOptions: { selectedTools: ["read", "bash"] } }, ctx("deepseek-v4-flash"));
    assert.match(result.systemPrompt, /CUSTOM SUPERPOWER/);
    assert.doesNotMatch(result.systemPrompt, /DEEPSEEK-V4-SUPERPOWER/);
  });

  it("does not inject the super power prompt by default (row off)", () => {
    const { fire, ctx } = createFakePi(["read", "bash"]);
    const result = fire("before_agent_start", { systemPrompt: "base prompt", systemPromptOptions: { selectedTools: ["read", "bash"] } }, ctx("deepseek-v4-flash"));
    assert.doesNotMatch(result.systemPrompt, /DEEPSEEK-V4-SUPERPOWER/);
  });

  it("does not modify prompt for non-DeepSeek models", () => {
    setSettings({ superpower: true });
    const { fire, ctx } = createFakePi(["read"]);
    const result = fire("before_agent_start", { systemPrompt: "base prompt", systemPromptOptions: { selectedTools: ["read"] } }, ctx("gpt-5.5"));
    assert.equal(result, undefined, "should not modify non-DeepSeek prompts");
  });

  it("orders: super power → guidance → base prompt", () => {
    setSettings({ superpower: true });
    const { fire, ctx } = createFakePi(["read", "bash", "serena_find_symbol"]);
    const result = fire("before_agent_start",
      { systemPrompt: "base prompt", systemPromptOptions: { selectedTools: ["read", "bash", "serena_find_symbol"] } },
      ctx("deepseek-v4-flash"));
    assert.ok(result);
    const sys = result.systemPrompt;
    const spIdx = sys.indexOf("DEEPSEEK-V4-SUPERPOWER");
    const guidanceIdx = sys.indexOf("DeepSeek V4 — pick the right tool");
    const baseIdx = sys.indexOf("base prompt");
    assert.ok(spIdx >= 0 && guidanceIdx >= 0 && baseIdx >= 0);
    assert.ok(spIdx < guidanceIdx, "super power before guidance");
    assert.ok(guidanceIdx < baseIdx, "guidance before base prompt");
  });
});

describe("selection guidance row", () => {
  it("off → no DeepSeek routing table in the system prompt", () => {
    setSettings({ selectionGuidance: false });
    const { fire, ctx } = createFakePi(["read", "bash"]);
    const result = fire("before_agent_start", { systemPrompt: "base", systemPromptOptions: { selectedTools: ["read", "bash"] } }, ctx("deepseek-v4-flash"));
    assert.equal(result, undefined, "nothing to add once guidance is off (no apply_patch active)");
  });
});

describe("first-tool hints row", () => {
  it("off → the run-task hint is never injected", () => {
    setSettings({ firstToolHints: false });
    const { fire, ctx } = createFakePi(["bash", "read", "find"]);
    fire("before_agent_start", { systemPrompt: "base", systemPromptOptions: { selectedTools: ["bash", "read", "find"] }, prompt: "Run the unit tests." }, ctx("deepseek-v4-flash"));
    const result = fire("before_provider_request", { payload: { messages: [{ role: "user", content: "Run the unit tests." }] } }, ctx("deepseek-v4-flash"));
    assert.equal(result, undefined, "hints disabled → payload untouched");
  });
});

describe("cache-stable system prompt (deterministic active-tools source)", () => {
  it("produces byte-identical system prompt whether or not the host populates selectedTools", () => {
    setSettings({ superpower: true });
    const { fire, ctx } = createFakePi(["read", "bash", "serena_find_symbol"]);
    const c = ctx("deepseek-v4-flash");
    // Turn A: host populates selectedTools.
    const withSelected = fire("before_agent_start",
      { systemPrompt: "base prompt", systemPromptOptions: { selectedTools: ["read", "bash", "serena_find_symbol"] }, prompt: "hi" }, c);
    // Turn B: host omits selectedTools → falls back to pi.getActiveTools().
    const withoutSelected = fire("before_agent_start",
      { systemPrompt: "base prompt", systemPromptOptions: { selectedTools: undefined }, prompt: "hi" }, c);
    assert.ok(withSelected, "system prompt should be modified");
    assert.ok(withoutSelected, "system prompt should be modified");
    assert.strictEqual(withSelected.systemPrompt, withoutSelected.systemPrompt,
      "same active tools must yield byte-identical system prompt (cache head)");
    // Selection guidance must be present in BOTH (the fallback must resolve).
    assert.match(withoutSelected.systemPrompt, /DeepSeek V4 — pick the right tool/);
  });
});

describe("pendingGuidance lifecycle (first provider round of a turn only)", () => {
  it("injects on round 1, never again once the model has produced output", () => {
    const { fire, ctx } = createFakePi(["bash", "read", "find"]);
    const c = ctx("deepseek-v4-flash");
    // before_agent_start with a run-task prompt → bash-first hint fires.
    const beforeStart = fire("before_agent_start",
      { systemPrompt: "base", systemPromptOptions: { selectedTools: ["bash", "read", "find"] }, prompt: "Run the unit tests." }, c);
    assert.ok(beforeStart, "DeepSeek still gets the static selection guidance");
    // The DYNAMIC run-task hint must NOT be in the system prompt (cache head).
    assert.doesNotMatch(beforeStart.systemPrompt, /FIRST tool call MUST be bash/i);

    // Round 1 of the turn (first provider call): guidance appended.
    const payload1 = { messages: [{ role: "user", content: "Run the unit tests." }] };
    const r1 = fire("before_provider_request", { payload: payload1 }, c);
    assert.ok(r1, "first provider round receives the guidance");
    assert.match(r1.messages[0].content, /FIRST tool call MUST be bash/i);

    // Round 1 of a LATER turn in the same session: the payload carries prior
    // assistant history, but the tail is the new plain user prompt → the hint
    // MUST still fire (gate is tail-based, not any-assistant-message-based).
    const payloadMulti = { messages: [
      { role: "user", content: "Run the unit tests." },
      { role: "assistant", content: "done" },
      { role: "user", content: "Execute the build now." },
    ] };
    const rMulti = fire("before_provider_request", { payload: payloadMulti }, c);
    assert.ok(rMulti, "later-turn round 1 with plain-prompt tail still gets guidance");
    assert.match(rMulti.messages[2].content, /FIRST tool call MUST be bash/i);
    assert.doesNotMatch(rMulti.messages[0].content, /FIRST tool call MUST be bash/i, "prior turns stay guidance-free");

    // Round 2, OpenAI-style payload (tool results are role "tool"): the hint
    // must NOT be re-appended — re-injecting after the model has complied reads
    // as a repeated demand and loops strict models into re-running bash.
    const payload2 = { messages: [
      { role: "user", content: "Run the unit tests." },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", content: "ok", name: "bash" },
    ] };
    const r2 = fire("before_provider_request", { payload: payload2 }, c);
    assert.equal(r2, undefined, "round 2 (OpenAI-style) gets no guidance re-injection");

    // Round 2, anthropic-style payload (tool results live in a user message):
    // the last user message is the tool-result container — the hint must still
    // not be appended after it.
    const payload2a = { messages: [
      { role: "user", content: "Run the unit tests." },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ] };
    const r2a = fire("before_provider_request", { payload: payload2a }, c);
    assert.equal(r2a, undefined, "round 2 (anthropic-style) gets no guidance re-injection");

    // A NEW turn (before_agent_start fires again with a non-matching prompt) must
    // clear pendingGuidance so it does not leak into the next turn.
    fire("before_agent_start", { systemPrompt: "base", systemPromptOptions: { selectedTools: ["bash", "read", "find"] }, prompt: "hello" }, c);
    const payload3 = { messages: [{ role: "user", content: "hello" }] };
    const r3 = fire("before_provider_request", { payload: payload3 }, c);
    assert.equal(r3, undefined, "new turn with no dynamic guidance leaves payload untouched");

    // A new matching turn re-arms the hint for ITS round 1.
    const beforeStart3 = fire("before_agent_start",
      { systemPrompt: "base", systemPromptOptions: { selectedTools: ["bash", "read", "find"] }, prompt: "Execute the lint step." }, c);
    assert.ok(beforeStart3);
    const payload4 = { messages: [{ role: "user", content: "Execute the lint step." }] };
    const r4 = fire("before_provider_request", { payload: payload4 }, c);
    assert.ok(r4, "a new matching turn gets guidance on its own round 1");
  });
});
