// Handler-level contract for the three DSH enrichments wired into repair's
// `tool_result` / `before_agent_start` hooks.
//
// The exclusion cases are the point of this file. Stock read/bash truncate
// INSIDE the tool before `tool_result` fires, so spilling them would bound an
// already-bounded result and name a file that cannot restore the dropped
// bytes. The discriminator is METADATA, never notice text: a WRAPPED read of a
// file whose content contains "Use offset=" must still spill (the wrapper
// strips details.truncation on its own views; only the stock pass-through
// keeps it).
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import repairModule from "../index.js";
import { setSpillRootForTests } from "../lib/spill-store.js";
import { estimateTokens } from "../lib/spill.js";

const dirs: string[] = [];
let agentDir: string;
let cwd: string;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Settings live in <agentDir>/settings.json; trust.json admits the project. */
async function configure(repair: Record<string, unknown>): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ repair }));
  await writeFile(join(agentDir, "trust.json"), JSON.stringify({ [cwd]: true }));
}

interface Harness {
  fire: (name: string, event: unknown) => Promise<any>;
  ctx: any;
}

function createHarness(): Harness {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on: (n: string, h: any) => { handlers.set(n, h); },
    registerTool: () => {},
    registerCommand: () => {},
  };
  repairModule(pi as never);
  const ctx = {
    cwd,
    ui: { notify: () => {}, setStatus: () => {} },
    sessionManager: { getSessionId: () => "session-1" },
    isProjectTrusted: () => true,
  };
  return {
    ctx,
    fire: async (name, event) => {
      const handler = handlers.get(name);
      assert.ok(handler, `no handler for ${name}`);
      return handler(event as never, ctx);
    },
  };
}

/** A text result event as pi delivers it. */
function resultEvent(overrides: Record<string, unknown>) {
  return {
    type: "tool_result",
    toolName: "web_extract",
    toolCallId: "call-1",
    input: {},
    content: [{ type: "text", text: "" }],
    isError: false,
    ...overrides,
  };
}

const BIG = "line of text\n".repeat(6000); // ~78KB → well over 12.5K tokens

let h: Harness;

beforeEach(async () => {
  agentDir = await tempDir("repair-dsh-agent-");
  cwd = await tempDir("repair-dsh-cwd-");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.TMPDIR = await tempDir("repair-dsh-tmp-");
  await configure({ spillMaxTokens: 12_500, repeatReminder: true, clock: false });
  h = createHarness();
});

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const textOf = (out: any): string =>
  (out?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");

describe("spill", () => {
  it("bounds an oversized EXTENSION-tool result and names a retrievable file", async () => {
    const out = await h.fire("tool_result", resultEvent({ content: [{ type: "text", text: BIG }] }));
    const text = textOf(out);
    assert.match(text, /bytes omitted/);
    const path = text.match(/Full output saved to: (\S+)/)?.[1];
    assert.ok(path, "notice names a path");
    assert.ok(existsSync(path!), "the spill file exists");
    // The full text is recoverable — that is the whole point.
    assert.equal(await readFile(path!, "utf8"), BIG);
    assert.ok(text.startsWith(BIG.slice(0, 40)), "head retained");
    assert.match(text, /Retrieve it in <=1900-line, ~\d+-byte UTF-8-safe pages with bash/, "recovery advice is last");
    assert.ok(text.trimEnd().endsWith("_ OFFSET"), "notice is last and carries the offset argument");
  });

  it("leaves a result under budget untouched", async () => {
    assert.equal(await h.fire("tool_result", resultEvent({ content: [{ type: "text", text: "short" }] })), undefined);
  });

  it("does nothing when spill is disabled (0)", async () => {
    await configure({ spillMaxTokens: 0 });
    h = createHarness();
    assert.equal(await h.fire("tool_result", resultEvent({ content: [{ type: "text", text: BIG }] })), undefined);
  });

  it("skips a STOCK-truncated read (bytes already gone; offset pagination is its recovery)", async () => {
    const out = await h.fire("tool_result", resultEvent({
      toolName: "read",
      content: [{ type: "text", text: BIG }],
      details: { truncation: { truncated: true, truncatedBy: "bytes" } },
    }));
    assert.equal(out, undefined);
  });

  it("skips self-truncated bash (fullOutputPath is its recovery)", async () => {
    const out = await h.fire("tool_result", resultEvent({
      toolName: "bash",
      content: [{ type: "text", text: BIG }],
      details: { fullOutputPath: "/tmp/full.txt" },
    }));
    assert.equal(out, undefined);
  });

  it("skips codemode, which self-truncates at 10k tokens and sets fullOutputPath", async () => {
    // Live herdr finding: codemode's own budget (execute.js:248,
    // DEFAULT_MAX_OUTPUT_TOKENS 10000) lands at ~10,061 est tokens — under the
    // 12,500 spill budget — so it can never reach the seam oversized. The
    // generic fullOutputPath check is what makes that explicit rather than
    // accidental, and it keeps a future budget change from double-spilling.
    const out = await h.fire("tool_result", resultEvent({
      toolName: "codemode",
      content: [{ type: "text", text: BIG }],
      details: { fullOutputPath: "/tmp/pi-codemode-x.txt" },
    }));
    assert.equal(out, undefined);
  });

  it("SPILLS a wrapped read view with NO truncation metadata (archive member / multi-range)", async () => {
    // The wrapper builds these results itself and sets details: undefined.
    const out = await h.fire("tool_result", resultEvent({
      toolName: "read",
      content: [{ type: "text", text: BIG }],
      details: undefined,
    }));
    assert.match(textOf(out), /bytes omitted/);
  });

  it("SPILLS a wrapped read whose TEXT merely contains the stock notice phrase", async () => {
    // The advisor regression: text matching would wrongly suppress this.
    // A wrapped view of pi's own read.js (or this repo's AGENTS.md) contains
    // "Use offset=" verbatim while being completely unbounded.
    const content = `${"\n[Showing lines 1-2000 of 99999. Use offset=2001 to continue.]".repeat(2000)}`;
    const out = await h.fire("tool_result", resultEvent({
      toolName: "read",
      content: [{ type: "text", text: content }],
      details: undefined,
    }));
    assert.ok(out, "a wrapped view containing the phrase must still spill");
    assert.match(textOf(out), /bytes omitted/);
  });

  it("skips image-bearing results (fail-open: no image token calculator here)", async () => {
    const out = await h.fire("tool_result", resultEvent({
      toolName: "read",
      content: [{ type: "text", text: BIG }, { type: "image", data: "x", mimeType: "image/png" }],
    }));
    assert.equal(out, undefined);
  });

  it("fails open when the store is unwritable", async () => {
    setSpillRootForTests("/dev/null/nope");
    try {
      const out = await h.fire("tool_result", resultEvent({ content: [{ type: "text", text: BIG }] }));
      assert.equal(out, undefined, "the model keeps its result");
    } finally {
      setSpillRootForTests(undefined);
    }
  });

  it("sizes the long-line recovery hint from the ACTIVE budget, not a constant", async () => {
    // A hardcoded `head -c 50000` would re-spill (12,504 est tokens > 12,500).
    // Lowering the budget must shrink the chunk the model is told to use.
    const singleLine = "y".repeat(200_000);
    const atDefault = await h.fire("tool_result", resultEvent({
      toolName: "web_extract", content: [{ type: "text", text: singleLine }],
    }));
    const defaultChunk = Number(textOf(atDefault).match(/~(\d+)-byte UTF-8-safe pages/)?.[1]);
    assert.ok(defaultChunk > 0 && defaultChunk < 50_000, `default chunk ${defaultChunk} must be under 50KB`);

    await configure({ spillMaxTokens: 2_000 });
    h = createHarness();
    const atLow = await h.fire("tool_result", resultEvent({
      toolName: "web_extract", content: [{ type: "text", text: singleLine }],
    }));
    const lowChunk = Number(textOf(atLow).match(/~(\d+)-byte UTF-8-safe pages/)?.[1]);
    assert.ok(lowChunk > 0 && lowChunk < defaultChunk, `lower budget must shrink the chunk (${lowChunk} < ${defaultChunk})`);
  });

  // The recovery must TERMINATE: fetching a spilled result can never itself
  // spill. These execute the emitted command rather than trusting its text.
  for (const budget of [2_000, 12_500]) {
    it(`recovery pages under budget and cannot re-spill (budget ${budget})`, async () => {
      await configure({ spillMaxTokens: budget });
      h = createHarness();

      // A payload that FITS pi's read caps (under 50KB / 2000 lines) while
      // exceeding the active budget — exactly the case where "use read" used to
      // look safe. Only reachable at a LOWERED budget: pi's own 50KB read cap
      // already estimates to 12,804 tokens, so at the 12,500 default NO
      // read-cap-sized short-line payload can be under budget — which is itself
      // the proof that read can never be a safe recommendation.
      // At 2,000 this is the advisor's case: 9,000 chars / 100 lines, 2,254 tok.
      const fitsReadCaps = budget < 12_500;
      const lines = fitsReadCaps ? 100 : 2_500;
      const payload = `${"x".repeat(89)}\n`.repeat(lines);
      if (fitsReadCaps) {
        assert.ok(payload.length < 50 * 1024, "fixture stays under pi's read byte cap");
        assert.ok(lines < 2_000, "fixture stays under pi's read line cap");
      }
      assert.ok(estimateTokens([{ type: "text", text: payload }]) > budget, "fixture exceeds the budget");
      const out = await h.fire("tool_result", resultEvent({
        toolName: "web_extract", content: [{ type: "text", text: payload }],
      }));
      const notice = textOf(out);
      const path = notice.match(/Full output saved to: (\S+)/)?.[1];
      const chunk = Number(notice.match(/~(\d+)-byte UTF-8-safe pages/)?.[1]);
      assert.ok(path && chunk > 0, "notice names a path and a chunk size");
      assert.doesNotMatch(notice, /Use read with that path/, "never sends the model to read");

      // Execute the notice's OWN command verbatim (offset 1), not a
      // hand-written equivalent — the emitted template is what a model runs,
      // so testing anything else would miss a broken hint.
      const template = notice.slice(notice.indexOf("bash -c ")).trim();
      const raw = execFileSync("/bin/sh", ["-c", template.replace("_ OFFSET", "_ 1")], {
        encoding: "utf8", maxBuffer: 32 << 20,
      });
      assert.match(raw, /\[next OFFSET = \d+\]\n$/, "the page reports its own next offset");
      const page = raw.slice(0, raw.lastIndexOf("[next OFFSET"));

      assert.ok(page.length > 0, "the recovery returns real content");
      const pageCost = estimateTokens([{ type: "text", text: page }]);
      assert.ok(pageCost <= budget, `recovered ${pageCost} tokens must fit the ${budget} budget — else it re-spills`);

      // Feed the recovered page back through the seam: it must not re-spill.
      const echo = await h.fire("tool_result", resultEvent({
        toolName: "bash", content: [{ type: "text", text: page }],
      }));
      assert.equal(echo, undefined, "a recovered page must not re-spill");
    });
  }
});

describe("repeat-tool-reminder", () => {
  const call = (overrides: Record<string, unknown> = {}) =>
    h.fire("tool_result", resultEvent({ toolName: "grep", input: { pattern: "TODO" }, content: [{ type: "text", text: "hit" }], ...overrides }));

  it("appends a gentle footer on the 3rd identical call, not before", async () => {
    assert.equal(await call(), undefined);
    assert.equal(await call(), undefined);
    const third = await call();
    assert.match(textOf(third), /\[ceulen\] Same tool call repeated/);
    assert.match(textOf(third), /^hit\n\n\[ceulen\]/, "the real result survives the footer");
  });

  it("escalates at the 5th call", async () => {
    await call(); await call(); await call(); await call();
    const fifth = await call();
    assert.match(textOf(fifth), /consecutive_calls: 5/);
  });

  it("ignores property order in arguments", async () => {
    // Identical arguments, different key order — must still form a chain.
    await h.fire("tool_result", resultEvent({ toolName: "read", input: { path: "a", limit: 5 }, content: [{ type: "text", text: "x" }] }));
    await h.fire("tool_result", resultEvent({ toolName: "read", input: { limit: 5, path: "a" }, content: [{ type: "text", text: "x" }] }));
    const third = await h.fire("tool_result", resultEvent({ toolName: "read", input: { path: "a", limit: 5 }, content: [{ type: "text", text: "x" }] }));
    assert.match(textOf(third), /Same tool call repeated/);
  });

  it("resets on a new user message", async () => {
    await call(); await call();
    await h.fire("before_agent_start", { type: "before_agent_start", messageType: "user" });
    assert.equal(await call(), undefined, "chain restarted from 1");
  });

  it("does not reset on a non-user run (cron / follow-up)", async () => {
    await call(); await call();
    await h.fire("before_agent_start", { type: "before_agent_start", messageType: "custom" });
    const third = await call();
    assert.match(textOf(third), /Same tool call repeated/);
  });

  it("skips nested calls", async () => {
    for (let i = 0; i < 3; i++) {
      const out = await h.fire("tool_result", resultEvent({
        toolName: "grep", input: { pattern: "TODO" }, content: [{ type: "text", text: "hit" }], parentToolCallId: "parent-1",
      }));
      assert.equal(out, undefined);
    }
  });

  it("never advises on munin tools", async () => {
    for (let i = 0; i < 4; i++) {
      const out = await h.fire("tool_result", resultEvent({
        toolName: "munin_search", input: { query: "x" }, content: [{ type: "text", text: "hit" }],
      }));
      assert.equal(out, undefined);
    }
  });

  it("is off when the setting is off", async () => {
    await configure({ repeatReminder: false });
    h = createHarness();
    await call(); await call();
    assert.equal(await call(), undefined);
  });
});

describe("clock", () => {
  it("does not inject when off (default)", async () => {
    assert.equal(await h.fire("before_agent_start", { type: "before_agent_start", messageType: "user" }), undefined);
  });

  it("injects a ceulen-clock custom message when on", async () => {
    await configure({ clock: true, clockRefreshMs: 600_000 });
    h = createHarness();
    const out = await h.fire("before_agent_start", { type: "before_agent_start", messageType: "user" });
    assert.equal(out?.message?.customType, "ceulen-clock");
    assert.equal(out?.message?.display, false, "never rendered in the transcript");
    assert.match(out?.message?.content, /^Time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} \(/);
    assert.match(out?.message?.content, /Elapsed since last activity: unavailable/);
  });

  it("suppresses a second injection inside the refresh window, then allows it after", async () => {
    await configure({ clock: true, clockRefreshMs: 600_000 });
    h = createHarness();
    assert.ok(await h.fire("before_agent_start", { type: "before_agent_start", messageType: "user" }));
    assert.equal(await h.fire("before_agent_start", { type: "before_agent_start", messageType: "user" }), undefined);

    await configure({ clock: true, clockRefreshMs: 0 });
    h = createHarness();
    assert.ok(await h.fire("before_agent_start", { type: "before_agent_start", messageType: "user" }));
    assert.ok(await h.fire("before_agent_start", { type: "before_agent_start", messageType: "user" }), "0 = every step");
  });

  it("reports the elapsed span from the previous activity", async () => {
    await configure({ clock: true, clockRefreshMs: 0 });
    h = createHarness();
    await h.fire("before_agent_start", { type: "before_agent_start", messageType: "user" });
    const second = await h.fire("before_agent_start", { type: "before_agent_start", messageType: "user" });
    assert.match(second?.message?.content, /Elapsed since last activity: \d+s/);
  });
});
