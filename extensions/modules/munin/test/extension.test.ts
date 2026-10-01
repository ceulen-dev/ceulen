// Ported from @bacnh85/pi-munin 0.5.12 extensions/test/index.test.ts
// (mocha/chai → node:test). Project cwd config now comes from .pi/settings.json
// (trusted) instead of .env.local — projectDir() writes the settings file.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { projectSettingsPath, OUTPUT_MAX_BYTES } from "../lib/helpers.js";
import { MuninClient } from "../lib/sdk.js";
import muninExtension, { MUNIN_PROTOCOL_HEADER } from "../index.js";

const ENV_KEYS = ["MUNIN_API_KEY", "MUNIN_PROJECT", "MUNIN_BASE_URL", "PI_CODING_AGENT_DIR"] as const;

function harness(confirm = false) {
  const tools: Record<string, any> = {};
  const handlers: Record<string, Function[]> = {};
  const commands: Record<string, any> = {};
  const notifications: string[] = [];
  const pi: any = {
    registerTool(tool: any) { tools[tool.name] = tool; },
    registerCommand(name: string, command: any) { commands[name] = command; },
    on(name: string, handler: Function) { (handlers[name] ??= []).push(handler); },
  };
  muninExtension(pi);
  const ctx: any = {
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    ui: {
      confirm: async () => confirm,
      notify: (message: string) => notifications.push(message),
    },
  };
  return { tools, handlers, commands, notifications, ctx };
}

describe("munin extension", () => {
  let dirs: string[];
  let originalEnv: Record<string, string | undefined>;
  let originalCapabilities: typeof MuninClient.prototype.capabilities;
  let originalInvoke: typeof MuninClient.prototype.invoke;

  beforeEach(() => {
    dirs = [];
    originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    originalCapabilities = MuninClient.prototype.capabilities;
    originalInvoke = MuninClient.prototype.invoke;
  });

  afterEach(() => {
    MuninClient.prototype.capabilities = originalCapabilities;
    MuninClient.prototype.invoke = originalInvoke;
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function projectDir(): string {
    const cwd = mkdtempSync(join(tmpdir(), "munin-ext-project-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(projectSettingsPath(cwd), JSON.stringify({ munin: { apiKey: "project-key", project: "project-id" } }));
    return cwd;
  }

  it("registers eight tools with named prompt guidelines", () => {
    const { tools } = harness();
    assert.equal(Object.keys(tools).length, 8);
    for (const tool of Object.values(tools) as any[]) {
      for (const guideline of tool.promptGuidelines) {
        assert.match(guideline, new RegExp(tool.name.replace("munin_", "")) , `guideline for ${tool.name}`);
      }
    }
    assert.equal(Object.hasOwn(tools.munin_delete.parameters.properties, "force"), false);
  });

  it("registers the munin skill via resources_discover", () => {
    const discover: Function[] = [];
    const pi: any = {
      registerTool() {},
      registerCommand() {},
      on(name: string, handler: Function) { if (name === "resources_discover") discover.push(handler); },
    };
    muninExtension(pi);
    assert.equal(discover.length, 1);
    const result = discover[0]!() as { skillPaths: string[] };
    assert.equal(result.skillPaths.length, 1);
    assert.match(result.skillPaths[0]!, /munin$/);
  });

  it("uses trusted project settings in the prompt hook and status command", async () => {
    const h = harness();
    h.ctx.cwd = projectDir();
    const result = await h.handlers.before_agent_start[0]({ systemPrompt: "BASE" }, h.ctx);
    assert.match(result.systemPrompt, /Munin Memory Protocol/);
    // Condensed protocol sections (not just a 2-line header anymore).
    assert.match(result.systemPrompt, /### Before acting/);
    assert.match(result.systemPrompt, /### What to store/);
    assert.match(result.systemPrompt, /### Memory shape/);
    assert.match(result.systemPrompt, /### Lifecycle and safety/);
    // BASE prompt preserved after the header.
    assert.match(result.systemPrompt, /BASE/);
    assert.equal(result.systemPrompt.startsWith(MUNIN_PROTOCOL_HEADER), true);
    await h.commands["munin-status"].handler("", h.ctx);
    assert.match(h.notifications[0]!, /Project: project-id/);
    assert.match(h.notifications[0]!, /project \(\.pi\/settings\.json\)/);
  });

  it("treats absent isProjectTrusted callback as untrusted (no throw)", async () => {
    // Pins the ?. calls — reverting either the munin-status handler or the
    // before_agent_start hook to a direct ctx.isProjectTrusted() call throws
    // TypeError instead of degrading to untrusted-default behaviour.
    // Untrusted default: the project settings file is NOT read, so the project
    // key here is invisible → header skipped, status command reports the error.
    const h = harness();
    delete h.ctx.isProjectTrusted;
    h.ctx.cwd = projectDir();
    const result = await h.handlers.before_agent_start[0]({ systemPrompt: "BASE" }, h.ctx);
    assert.equal(result, undefined);
    await h.commands["munin-status"].handler("", h.ctx);
    assert.match(h.notifications[0]!, /Munin Status: Munin API key is not configured/);
  });

  it("skips the protocol header when unconfigured", async () => {
    const h = harness();
    h.ctx.cwd = mkdtempSync(join(tmpdir(), "munin-ext-empty-"));
    dirs.push(h.ctx.cwd);
    const result = await h.handlers.before_agent_start[0]({ systemPrompt: "BASE" }, h.ctx);
    assert.equal(result, undefined);
  });

  it("throws for invalid munin_store tags", async () => {
    const { tools, ctx } = harness();
    process.env.MUNIN_API_KEY = "key";
    process.env.MUNIN_PROJECT = "project";
    await assert.rejects(
      tools.munin_store.execute("id", {
        key: "valid-key",
        title: "Title",
        content: "Content",
        tags: "type:fact",
      }, undefined, undefined, ctx),
      /Tag validation failed/,
    );
  });

  it("cancels delete and share before SDK dispatch", async () => {
    const { tools, ctx } = harness(false);
    process.env.MUNIN_API_KEY = "key";
    process.env.MUNIN_PROJECT = "project";
    MuninClient.prototype.invoke = async () => { throw new Error("SDK should not be called"); };
    const deleted = await tools.munin_delete.execute("id", { key: "memory-key" }, undefined, undefined, ctx);
    const shared = await tools.munin_share.execute("id", {
      memory_ids: ["memory-id"],
      target_project_ids: ["target-id"],
    }, undefined, undefined, ctx);
    assert.equal(deleted.details.cancelled, true);
    assert.equal(shared.details.cancelled, true);
  });

  it("calls capabilities with forceRefresh instead of a project payload", async () => {
    const { tools, ctx } = harness();
    process.env.MUNIN_API_KEY = "key";
    process.env.MUNIN_PROJECT = "project";
    const args: unknown[] = [];
    MuninClient.prototype.capabilities = async function (forceRefresh?: boolean) {
      args.push(forceRefresh);
      return { specVersion: "v1" } as any;
    };
    const result = await tools.munin_capabilities.execute("id", {}, undefined, undefined, ctx);
    assert.deepEqual(args, [true]);
    assert.match((result.content[0] as { text: string }).text, /Spec Version: v1/);
  });

  // ── tool_result error sanitization hook (anti-injection path) ──────────

  it("tool_result hook strips a prior 'Munin <type> error:' prefix (no double-wrap)", async () => {
    const h = harness();
    const hook = h.handlers.tool_result[0];
    const out = await hook({
      toolName: "munin_search",
      isError: true,
      content: [{ type: "text", text: "Munin auth error: unauthorized: invalid api key" }],
    });
    // A previous sanitization pass already added the prefix — the hook must
    // re-wrap once, not stack "Munin auth error: " twice.
    assert.equal(out.content[0].text, "Munin auth error: unauthorized: invalid api key");
    assert.equal(out.details.errorType, "auth");
  });

  it("tool_result hook bounds oversized munin error output", async () => {
    const h = harness();
    const hook = h.handlers.tool_result[0];
    const huge = "network error: " + "x".repeat(120 * 1024);
    const out = await hook({ toolName: "munin_get", isError: true, content: [{ type: "text", text: huge }] });
    assert.ok(out.content[0].text.length <= OUTPUT_MAX_BYTES + 200, "bounded to max bytes + marker slack");
    assert.match(out.content[0].text, /\[Munin output truncated:/);
    assert.equal(out.details.errorType, "network");
  });

  it("tool_result hook unwinds a DOUBLY-wrapped 'Munin <type> error:' prefix in a loop", async () => {
    const h = harness();
    const hook = h.handlers.tool_result[0];
    const out = await hook({
      toolName: "munin_search",
      isError: true,
      content: [{ type: "text", text: "Munin auth error: Munin network error: fetch failed" }],
    });
    // Both stacked prefixes strip — the result never re-presents the stack.
    assert.doesNotMatch(out.content[0].text, /Munin auth error: Munin/);
    assert.match(out.content[0].text, /fetch failed/);
  });

  it("tool_result hook ignores non-munin tools and successful results", async () => {
    const h = harness();
    const hook = h.handlers.tool_result[0];
    assert.equal(await hook({ toolName: "read", isError: true, content: [{ type: "text", text: "boom" }] }), undefined);
    assert.equal(await hook({ toolName: "munin_search", isError: false, content: [{ type: "text", text: "ok" }] }), undefined);
  });
});
