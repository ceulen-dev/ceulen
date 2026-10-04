/**
 * rules module tests: the before_agent_start composer (append-only, no-op with
 * zero rules), the rule_get tool (found / not-found / sticky), the /rules
 * command (status hides rulebook bodies; reload drops the cache), and the
 * per-tool kill-switch.
 *
 * The `pi` stub is deliberately loose (only the surface the module touches) —
 * pi's real SDK types require a full context object.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import rulesExtension from "../index.ts";
import { readDisabledTools } from "../../../lib/tools";

const temps: string[] = [];
const envBackup = process.env.PI_CODING_AGENT_DIR;
delete process.env.PI_CODING_AGENT_DIR; // keep user-level discovery off the dev machine

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  if (envBackup !== undefined) process.env.PI_CODING_AGENT_DIR = envBackup;
  clearDisabled();
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function write(file: string, text: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
  return file;
}

/** Isolated workspace; cwd has no ancestor .pi/RULES.md (temp dir under os.tmpdir). */
function workspace(files: Record<string, string> = {}): string {
  const cwd = path.join(tmp("rules-mod-"), "a", "b");
  mkdirSync(cwd, { recursive: true });
  for (const [rel, text] of Object.entries(files)) write(path.join(cwd, rel), text);
  return cwd;
}

/** Empty dir used as PI_CODING_AGENT_DIR (an inherited one adds a live user RULES.md). */
const agentDir = tmp("rules-agent-");
mkdirSync(agentDir, { recursive: true });

interface Harness {
  events: Map<string, (event: any, ctx: any) => any>;
  tools: Map<string, any>;
  commands: Map<string, any>;
  notes: { message: string; level?: string }[];
}

function harness(): Harness {
  const events = new Map();
  const tools = new Map();
  const commands = new Map();
  const notes: Harness["notes"] = [];
  const pi = {
    on(name: string, handler: any) { events.set(name, handler); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, options: any) { commands.set(name, options); },
  };
  rulesExtension(pi as any);
  return { events, tools, commands, notes };
}

function context(cwd: string, notes: Harness["notes"] = []): any {
  return { cwd, ui: { notify: (message: string, level?: string) => notes.push({ message, level }) }, isProjectTrusted: () => true };
}

/** Point the kill-switch at the temp agent dir (readDisabledTools has no cwd arg). */
function disableTools(names: string[]): void {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ ceulen: { disabledTools: names } }), "utf8");
}

function clearDisabled(): void {
  rmSync(path.join(agentDir, "settings.json"), { force: true });
}

async function startBlock(cwd: string, base = "BASE"): Promise<string | undefined> {
  const { events } = harness();
  const result = await events.get("before_agent_start")!({ systemPrompt: base, prompt: "p" }, context(cwd));
  return result?.systemPrompt;
}

describe("rules module — before_agent_start", () => {
  it("is a no-op when no RULES.md exists anywhere (zero footprint)", async () => {
    const cwd = workspace();
    const { events } = harness();
    const result = await events.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "p" }, context(cwd));
    assert.equal(result, undefined);
  });

  it("appends the block to the existing system prompt, never replacing it", async () => {
    const cwd = workspace({ ".pi/RULES.md": "## sticky\nS body\n\n## book\ndescription: B desc\nB body\n" });
    const out = (await startBlock(cwd))!;
    assert.ok(out.startsWith("BASE\n\n<user-rules>"));
    assert.ok(out.includes("S body"));
    assert.ok(out.includes("- book: B desc"));
    assert.ok(!out.includes("B body"));
  });

  it("does not gate on the tool set (the fff pattern minus the active-tool check)", async () => {
    const cwd = workspace({ ".pi/RULES.md": "## sticky\nS body\n" });
    disableTools(["rule_get"]);
    try {
      assert.equal(readDisabledTools().has("rule_get"), true);
      assert.ok((await startBlock(cwd))!.includes("S body"));
    } finally {
      clearDisabled();
    }
  });
});

describe("rules module — rule_get", () => {
  it("registers the canonical tool name, active by default", () => {
    const { tools } = harness();
    assert.deepEqual([...tools.keys()], ["rule_get"]);
    assert.equal(tools.get("rule_get").defaultActive, true);
  });

  it("returns the body (imports expanded) for a found rule and lists names when not found", async () => {
    const cwd = workspace({
      ".pi/RULES.md": "## book\ndescription: B desc\nsee @detail.md\n",
      ".pi/detail.md": "DETAIL-BODY\n",
    });
    const { tools } = harness();
    const tool = tools.get("rule_get");

    const found = await tool.execute("id", { name: "book" }, undefined, undefined, context(cwd));
    assert.ok(found.content[0].text.includes("DETAIL-BODY"));
    assert.ok(found.content[0].text.includes("from " + path.join(cwd, ".pi/RULES.md")));

    const missing = await tool.execute("id", { name: "nope" }, undefined, undefined, context(cwd));
    assert.ok(missing.content[0].text.includes('Rule "nope" not found'));
    assert.ok(missing.content[0].text.includes("book"));
  });

  it("labels a sticky rule as already present in the prompt", async () => {
    const cwd = workspace({ ".pi/RULES.md": "## sticky\nS body\n" });
    const { tools } = harness();
    const result = await tools.get("rule_get").execute("id", { name: "sticky" }, undefined, undefined, context(cwd));
    assert.ok(result.content[0].text.includes('already appended to the system prompt'));
  });

  it("reports an empty workspace distinctly", async () => {
    const cwd = workspace();
    const { tools } = harness();
    const result = await tools.get("rule_get").execute("id", { name: "anything" }, undefined, undefined, context(cwd));
    assert.ok(result.content[0].text.includes("no RULES.md exists in this workspace"));
  });

  it("registers inactive when listed in ceulen.disabledTools", () => {
    disableTools(["rule_get"]);
    try {
      assert.equal(harness().tools.get("rule_get").defaultActive, false);
    } finally {
      clearDisabled();
    }
  });
});

describe("rules module — /rules command", () => {
  it("reports sources, counts, names, and char count without leaking rulebook bodies", async () => {
    const cwd = workspace({
      ".pi/RULES.md": "## sticky\nS body\n\n## book\ndescription: B desc\nSECRET-BODY-TEXT\n",
    });
    const notes: Harness["notes"] = [];
    const { commands } = harness();
    await commands.get("rules").handler("", context(cwd, notes));

    const text = notes[0].message;
    assert.equal(notes[0].level, "info");
    assert.ok(text.includes(path.join(cwd, ".pi/RULES.md")));
    assert.ok(text.includes("Sticky rules (1): sticky"));
    assert.ok(text.includes("Rulebook rules (1): book"));
    assert.ok(text.includes("Bodies are served on demand"));
    assert.ok(!text.includes("SECRET-BODY-TEXT"), "rulebook bodies are on-demand only");
    assert.ok(!text.includes("S body"), "sticky bodies are not echoed either");
    assert.ok(/Prompt block: \d+ chars/.test(text));
  });

  it("says so when nothing was found", async () => {
    const notes: Harness["notes"] = [];
    const { commands } = harness();
    await commands.get("rules").handler("", context(workspace(), notes));
    assert.ok(notes[0].message.includes("Rule sources: none"));
  });

  it("drops the cache on /rules reload so edits apply without a restart", async () => {
    const cwd = workspace({ ".pi/RULES.md": "## a\nV1\n" });
    const { commands } = harness();
    const notes: Harness["notes"] = [];
    assert.ok((await startBlock(cwd))!.includes("V1"));

    const file = path.join(cwd, ".pi/RULES.md");
    writeFileSync(file, "## a\nV2\n", "utf8");
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);

    await commands.get("rules").handler("reload", context(cwd, notes));
    assert.ok(notes[0].message.includes("cache dropped"));
    assert.ok((await startBlock(cwd))!.includes("V2"));
  });

  it("rejects an unknown argument", async () => {
    const notes: Harness["notes"] = [];
    const { commands } = harness();
    await commands.get("rules").handler("bogus", context(workspace(), notes));
    assert.equal(notes[0].level, "error");
  });
});
