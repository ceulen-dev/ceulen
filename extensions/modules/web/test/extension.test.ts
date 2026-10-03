// ceulen integration contract: per-tool kill-switch (ceulen.disabledTools →
// defaultActive:false), skill contributed via resources_discover, and the
// before_agent_start guidance hook gated on active web_* tools.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import webExtension from "../index";

const ALL_TOOLS = [
  "web_search", "web_extract", "web_map", "web_crawl", "web_screenshot", "web_pdf",
  "web_interact", "web_research", "web_image", "web_chat", "web_status",
];

function harness(opts: { disabledTools?: string[]; activeTools?: string[] } = {}) {
  const tools: Record<string, { name: string; defaultActive?: boolean }> = {};
  const handlers: Record<string, Function[]> = {};
  const discoverResults: { skillPaths: string[] }[] = [];
  const pi: any = {
    registerTool(tool: any) { tools[tool.name] = tool; },
    on(name: string, handler: Function) {
      (handlers[name] ??= []).push(handler);
    },
    getActiveTools: () => opts.activeTools ?? [],
  };
  // Intercept resources_discover results (munin harness pattern).
  const realOn = pi.on.bind(pi);
  pi.on = (name: string, handler: Function) => {
    if (name === "resources_discover") {
      return realOn(name, (...args: unknown[]) => {
        const r = (handler as (...a: unknown[]) => { skillPaths: string[] })(...args);
        discoverResults.push(r);
        return r;
      });
    }
    return realOn(name, handler);
  };
  const oldDisabled = process.env.CEULEN_TEST_DISABLED_TOOLS;
  // readDisabledTools reads the settings file — shield via PI_CODING_AGENT_DIR
  // + a settings file carrying the disabled list.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-ext-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  if (opts.disabledTools?.length) {
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ ceulen: { disabledTools: opts.disabledTools } }));
  }
  try {
    webExtension(pi);
  } finally {
    if (oldDisabled === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDisabled;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { tools, handlers, discoverResults };
}

async function callGuidance(handlers: Record<string, Function[]>, selectedTools?: string[]) {
  return await handlers.before_agent_start[0]({ systemPrompt: "BASE", systemPromptOptions: { selectedTools } });
}

describe("web module ceulen contract", () => {
  let oldAgentDir: string | undefined;

  beforeEach(() => {
    oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  });
  afterEach(() => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  });

  it("registers exactly the eleven web_* tools", () => {
    const { tools } = harness();
    assert.deepEqual(Object.keys(tools).sort(), [...ALL_TOOLS].sort());
  });

  it("ceulen.disabledTools → defaultActive:false (inactive at registration)", () => {
    const { tools } = harness({ disabledTools: ["web_search", "web_image"] });
    assert.equal(tools.web_search!.defaultActive, false);
    assert.equal(tools.web_image!.defaultActive, false);
    assert.equal(tools.web_extract!.defaultActive, true);
    assert.equal(tools.web_status!.defaultActive, true);
  });

  it("all tools default-active when the kill-switch list is empty", () => {
    const { tools } = harness();
    for (const name of ALL_TOOLS) assert.equal(tools[name]!.defaultActive, true, name);
  });

  it("contributes exactly one skill: skills/web (kill-switch gated by factory load)", () => {
    const { handlers } = harness();
    // resources_discover is a subscription — invoke the handler as pi would.
    const discoverResults = [handlers.resources_discover![0]!()];
    assert.equal(discoverResults.length, 1);
    assert.equal(discoverResults[0]!.skillPaths.length, 1);
    assert.ok(discoverResults[0]!.skillPaths[0]!.endsWith(path.join("skills", "web")));
    assert.ok(fs.existsSync(path.join(discoverResults[0]!.skillPaths[0]!, "SKILL.md")));
  });

  it("guidance injects only when a web_* tool is active (selectedTools)", async () => {
    const { handlers } = harness();
    const hit = await callGuidance(handlers, ["read", "web_search"]);
    assert.ok(String(hit?.systemPrompt).includes("BASE"));
    assert.ok(String(hit?.systemPrompt).includes("Web Tool Routing"));
    const miss = await callGuidance(handlers, ["read", "bash", "grep"]);
    assert.equal(miss, undefined);
  });

  it("guidance falls back to pi.getActiveTools() when selectedTools is undefined", async () => {
    const { handlers } = harness({ activeTools: ["read", "web_extract"] });
    const hit = await callGuidance(handlers);
    assert.ok(String(hit?.systemPrompt).includes("Web Tool Routing"));
    const quiet = harness({ activeTools: ["read", "bash"] });
    assert.equal(await callGuidance(quiet.handlers), undefined);
  });
});
