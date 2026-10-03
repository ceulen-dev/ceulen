// Wrapper INTEGRATION test — the munin this-binding lesson: pure-function
// tests alone do not prove the wiring. This drives `wrapToolDefinition` around
// a REAL `createEditToolDefinition` (pi's own core edit tool) against a real
// temp file, through the full documented repair chain:
//
//   prepareArguments (schema repair / read-notice decontamination)
//     → execute → core exact-match MISMATCH
//     → trim-tolerant retry rebuilt from the file's real bytes → SUCCESS
//     → (unresolvable case) nearest-region + apply_patch escalation message
//
// A "faithful fake" would not catch a changed core-factory signature, a moved
// ctx.cwd contract, or a rewritten core error string — the real definition does.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { wrapToolDefinition } from "../index.js";

const dirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

// The module entry reads settings per tool call — point the agent dir at an
// empty temp dir so these tests never read the developer's real settings.json.
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "repair-wrapper-"));
  dirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

function makeWrapped(
  onRepair: (tool: string, kinds: readonly string[]) => void,
  counts = new Map<string, number>(),
  active: string[] = ["apply_patch"],
) {
  // factory = the REAL core tool factory: execute() re-creates the definition
  // from ctx.cwd on every call, exactly as the module registers it.
  return wrapToolDefinition(
    createEditToolDefinition(process.cwd()),
    createEditToolDefinition,
    () => true,
    onRepair,
    counts,
    () => active,
    () => true,
  );
}

const ctxFor = (cwd: string) => ({ cwd } as any);

describe("wrapToolDefinition × real edit tool (integration)", () => {
  it("repairs nested snake_case aliases, then recovers an indentation mismatch via the trim-tolerant retry", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "a.ts"), "alpha\n    indented\nomega\n", "utf-8");

    const repairs: string[] = [];
    const wrapped = makeWrapped((tool, kinds) => repairs.push(`${tool}:${kinds.join("+")}`));

    // Cursor-trained payload: snake_case inside edits[], and the model dropped
    // the file's indentation — the exact double failure this module exists for.
    const prepared: any = wrapped.prepareArguments({
      path: "a.ts",
      edits: [{ old_text: "alpha\nindented", new_text: "alpha\n    INDENTED" }],
    });

    assert.equal(prepared.edits[0].oldText, "alpha\nindented", "schema repair renamed old_text");
    assert.equal(prepared.edits[0].newText, "alpha\n    INDENTED", "schema repair renamed new_text");
    assert.ok(!("old_text" in prepared.edits[0]), "alias key removed");
    assert.ok(repairs.some((r) => r === "edit:param-alias"), `alias repair recorded (got ${repairs.join(", ")})`);

    // Relative path + ctx.cwd proves the wrapper re-creates the tool from the
    // call's cwd (the registered template was built from process.cwd()).
    const result: any = await wrapped.execute("t1", prepared, undefined, undefined, ctxFor(dir));
    assert.equal(result.isError, undefined);
    assert.equal(await readFile(join(dir, "a.ts"), "utf-8"), "alpha\n    INDENTED\nomega\n");
    assert.ok(repairs.includes("edit:trim-match-retry"), `retry recorded (got ${repairs.join(", ")})`);
  });

  it("strips a read-tool contamination notice from oldText, so a contaminated copy still applies", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "b.ts"), "const a = 1;\nconst b = 2;\n", "utf-8");

    const repairs: string[] = [];
    const wrapped = makeWrapped((tool, kinds) => repairs.push(`${tool}:${kinds.join("+")}`));

    const prepared: any = wrapped.prepareArguments({
      path: "b.ts",
      edits: [{
        oldText: "const b = 2;\n\n[Showing lines 1-2 of 90. Use offset=3 to continue.]",
        newText: "const b = 3;",
      }],
    });

    assert.equal(prepared.edits[0].oldText, "const b = 2;", "notice stripped before the core match");
    assert.ok(repairs.includes("edit:read-notice-stripped"), `decontamination recorded (got ${repairs.join(", ")})`);

    const result: any = await wrapped.execute("t2", prepared, undefined, undefined, ctxFor(dir));
    assert.equal(result.isError, undefined);
    assert.equal(await readFile(join(dir, "b.ts"), "utf-8"), "const a = 1;\nconst b = 3;\n");
  });

  it("rejects a no-op edit before any I/O", async () => {
    const dir = await tempDir();
    const wrapped = makeWrapped(() => {});
    await assert.rejects(
      () => wrapped.execute("t3", { path: "missing.ts", edits: [{ oldText: "same", newText: "same" }] }, undefined, undefined, ctxFor(dir)),
      /edits\[0\] is a no-op/,
    );
  });

  it("escalates an unresolvable mismatch: nearest region + apply_patch nudge, counting per file", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "c.ts"), "alpha\nbeta\ngamma\n", "utf-8");

    const counts = new Map<string, number>();
    const wrapped = makeWrapped(() => {}, counts);

    const miss = () => wrapped.execute(
      "t4",
      { path: "c.ts", edits: [{ oldText: "no such content anywhere near here", newText: "x" }] },
      undefined,
      undefined,
      ctxFor(dir),
    );

    await assert.rejects(miss, (err: Error) => {
      assert.match(err.message, /Could not find the exact text in c\.ts/);
      assert.match(err.message, /Nearest matching region/);
      assert.match(err.message, /edit has failed 1× on this file\. Switch to apply_patch/);
      return true;
    });

    // Second miss on the SAME file escalates the counter (per-file, per-session).
    await assert.rejects(miss, /edit has failed 2× on this file/);
    assert.equal(counts.size, 1, "one counter entry per file");

    // A successful edit clears the escalation counter for that file.
    const ok: any = await wrapped.execute(
      "t5",
      { path: "c.ts", edits: [{ oldText: "beta", newText: "BETA" }] },
      undefined,
      undefined,
      ctxFor(dir),
    );
    assert.equal(ok.isError, undefined);
    assert.equal(counts.size, 0, "counter cleared after a successful edit");
  });

  it("omits the apply_patch nudge when apply_patch is not an active tool", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "d.ts"), "alpha\n", "utf-8");
    const wrapped = makeWrapped(() => {}, new Map(), []);
    await assert.rejects(
      () => wrapped.execute("t6", { path: "d.ts", edits: [{ oldText: "nowhere", newText: "x" }] }, undefined, undefined, ctxFor(dir)),
      (err: Error) => {
        assert.doesNotMatch(err.message, /apply_patch/);
        return true;
      },
    );
  });

  it("passes the mismatch straight through when editRetry is off", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "e.ts"), "alpha\n", "utf-8");
    const repairs: string[] = [];
    const wrapped = wrapToolDefinition(
      createEditToolDefinition(process.cwd()),
      createEditToolDefinition,
      () => true,
      (tool, kinds) => repairs.push(`${tool}:${kinds.join("+")}`),
      new Map(),
      () => ["apply_patch"],
      () => false, // repair.editRetry = off
    );
    await assert.rejects(
      () => wrapped.execute("t7", { path: "e.ts", edits: [{ oldText: "nowhere", newText: "x" }] }, undefined, undefined, ctxFor(dir)),
      (err: Error) => {
        assert.doesNotMatch(err.message, /Nearest matching region|apply_patch/);
        return true;
      },
    );
    assert.ok(!repairs.includes("edit:trim-match-retry"));
  });

  it("read wrapper adds the offset/limit default and appends the note to the result", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "f.txt"), "one\ntwo\n", "utf-8");
    const { createReadToolDefinition } = await import("@earendil-works/pi-coding-agent");
    const wrapped = wrapToolDefinition(
      createReadToolDefinition(process.cwd()),
      createReadToolDefinition,
      () => false,
      () => {},
    );
    const prepared: any = wrapped.prepareArguments({ path: "f.txt", limit: 10 });
    assert.equal(prepared.offset, 1, "limit without offset defaults offset to 1");
    const result: any = await wrapped.execute("t8", prepared, undefined, undefined, ctxFor(dir));
    const texts = (result.content ?? []).map((c: any) => c.text ?? "").join("\n");
    assert.match(texts, /defaulted to 1/);
    assert.ok(!("__mtReadNote" in result), "note marker never leaks into the result");
  });
});
