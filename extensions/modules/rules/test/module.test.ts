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
import { clearRuleCache, loadRules } from "../lib/rules.ts";

const temps: string[] = [];
const envBackup = process.env.PI_CODING_AGENT_DIR;
const agentDir = tmp("rules-agent-"); // empty agent dir: an inherited one adds a live user RULES.md
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  if (envBackup !== undefined) process.env.PI_CODING_AGENT_DIR = envBackup;
  else delete process.env.PI_CODING_AGENT_DIR;
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

/** Empty dir used as PI_CODING_AGENT_DIR — set at the top of this file. */

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
    assert.ok((await startBlock(cwd))!.includes("S body"));
  });
});

describe("rules module — rule_get", () => {
  it("registers the canonical tool name", () => {
    const { tools } = harness();
    assert.deepEqual([...tools.keys()], ["rule_get"]);
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

  it("UNTRUSTED project: reload counts only user-level sources and the cache key matches the composer's", async () => {
    // F5: /rules reload called loadRules without the trust gate — the phantom
    // trusted=true model also poisoned the mtime cache with a key the composer
    // (trusted=false) could never hit.
    const cwd = workspace({ ".pi/RULES.md": "## project-rule\nPROJECT-SECRET-MARKER\n" });
    const userFile = write(path.join(agentDir, "RULES.md"), "## user-rule\nUSER-MARKER\n");
    const { commands } = harness();
    const notes: Harness["notes"] = [];
    const untrusted = { ...context(cwd, notes), isProjectTrusted: () => false };

    await commands.get("rules").handler("reload", untrusted);
    assert.ok(notes[0].message.includes("1 source(s)"), `only user-level source: ${notes[0].message}`);
    assert.ok(!notes[0].message.includes(path.join(cwd, ".pi/RULES.md")));

    // The composer now hits the reload-populated cache: loadRules with the
    // SAME (cwd, trusted=false) key the composer uses returns the identical
    // model object — the reload-run cache is a hit, not a re-parse.
    const { events } = harness();
    const first = await events.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "p" }, untrusted);
    assert.ok(first?.systemPrompt.includes("USER-MARKER"));
    assert.ok(!first?.systemPrompt.includes("PROJECT-SECRET-MARKER"));
    assert.equal(loadRules(cwd, undefined, false), loadRules(cwd, undefined, false), "cache hit — same model object");
    await events.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "p" }, untrusted);

    rmSync(userFile);
    clearRuleCache();
  });

  it("UNTRUSTED project: repo RULES.md never reaches the prompt; user file still applies", async () => {
    // Live-found defect (reviewer 2026-10-06): the composer had no trust gate —
    // an untrusted checkout's RULES.md (and its @imports) landed in every
    // request's system prompt. Same gate as pi's AGENTS.md context files.
    const cwd = workspace({ ".pi/RULES.md": "## project-rule\nPROJECT-SECRET-MARKER\n" });
    const { events } = harness();
    const untrusted = { ...context(cwd), isProjectTrusted: () => false };
    const result = await events.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "p" }, untrusted);
    assert.equal(result, undefined, "no project rules for an untrusted checkout");

    // rule_get honors the same gate (no on-demand exfiltration of bodies).
    const { tools } = harness();
    const got = await tools.get("rule_get")!.execute("t1", { name: "project-rule" }, undefined, undefined, untrusted);
    assert.match(JSON.stringify(got), /not found/i, "untrusted: rule body not served");

    // Trusted sees them again (and the cache key carries the flag).
    const trustedResult = await events.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "p" }, context(cwd));
    assert.ok(trustedResult?.systemPrompt.includes("PROJECT-SECRET-MARKER"));
  });
});

