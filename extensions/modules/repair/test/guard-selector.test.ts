// Live-found defect (reviewer 2026-10-06): the always-on read-on-guessed-path
// guard hard-blocked every numeric path-selector read. The tool_call hook ran
// on the RAW path (`f.ts:50-200`) while the selector peels only inside
// execute, so existsSync probed a path that never exists on disk. This suite
// fires the REAL registered hook: a selector read whose stem exists must
// pass; genuinely missing paths (plain or with a selector suffix) still block.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import repairModule from "../index.js";

type Hook = (event: unknown, ctx: unknown) => unknown;
const dirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "repair-guard-"));
  dirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir; // neutral settings: guards default ON
  await writeFile(join(dir, "f.ts"), "line1\nline2\nline3\nline4\nline5\n");
  const handlers: Record<string, Hook> = {};
  repairModule({
    on: (event: string, handler: Hook) => { handlers[event] = handler; },
    registerTool: () => {},
    registerCommand: () => {},
  } as never);
  const call = (path: string) => handlers.tool_call!({ toolName: "read", input: { path } }, { cwd: dir });
  return { dir, call };
}

describe("read guard × path-selector interaction", () => {
  it("a selector read whose STEM exists passes the guard", async () => {
    const { call } = await fixture();
    assert.equal(await call("f.ts:2-4"), undefined, "existing stem + numeric selector must not be blocked");
    assert.equal(await call("f.ts:5"), undefined);
    assert.equal(await call("f.ts:-2"), undefined);
    assert.equal(await call("f.ts:1-2,5"), undefined);
    assert.equal(await call("f.ts:conflicts"), undefined, ":conflicts never matched looksLikeCodePath anyway");
  });

  it("missing paths still block — plain and selector-suffixed", async () => {
    const { call } = await fixture();
    const plain = await call("missing.ts") as { block: boolean; reason: string } | undefined;
    assert.ok(plain?.block, "plain missing code path blocked");
    const sel = await call("missing.ts:50") as { block: boolean; reason: string } | undefined;
    assert.ok(sel?.block, "missing stem with selector blocked (peeled probe also missing)");
    assert.match(sel.reason, /Path not found/);
  });

  it("an invalid selector on an existing file falls back to the raw probe (execute's loud error path)", async () => {
    const { call } = await fixture();
    // `:not-a-selector` doesn't parse → probe stays raw → raw doesn't exist →
    // looksLikeCodePath(raw without digit-suffix strip)... the raw path
    // "f.ts:zz" is not a code path (extension test on the full string fails),
    // so the guard passes and execute surfaces the literal-not-found error.
    assert.equal(await call("f.ts:zz"), undefined);
  });
});
