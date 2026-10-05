// read path selector tests — parser unit cases + wrapper integration through
// the REAL createReadToolDefinition against temp files (the wrapper.test.ts
// lesson: faithful fakes don't prove the wiring).

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  extractConflictBlocks,
  isMultiRange,
  parseLineRanges,
  parseSel,
  parseTailCount,
  peelPathSelector,
  resolveTailSelector,
  selToOffsetLimit,
} from "../lib/read-selector.js";
import { wrapToolDefinition } from "../index.js";

const dirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "read-sel-"));
  dirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

// ── Parser unit cases ──

describe("parseSel grammar", () => {
  it("N means from-line-onward; in a list it pins the single line", () => {
    assert.deepEqual(parseSel("50"), { kind: "lines", ranges: [{ startLine: 50, endLine: undefined }] });
    assert.deepEqual(parseSel("19,59"), {
      kind: "lines",
      ranges: [{ startLine: 19, endLine: 19 }, { startLine: 59, endLine: 59 }],
    });
  });

  it("ranges: N-M, N+K, N-, .. alias; commas merge", () => {
    assert.deepEqual(parseSel("50-200"), { kind: "lines", ranges: [{ startLine: 50, endLine: 200 }] });
    assert.deepEqual(parseSel("50+150"), { kind: "lines", ranges: [{ startLine: 50, endLine: 199 }] });
    assert.deepEqual(parseSel("50-"), { kind: "lines", ranges: [{ startLine: 50, endLine: undefined }] });
    assert.deepEqual(parseSel("10..12"), { kind: "lines", ranges: [{ startLine: 10, endLine: 12 }] });
    const merged = parseSel("5-16,15-20");
    assert.deepEqual(merged, { kind: "lines", ranges: [{ startLine: 5, endLine: 20 }] });
  });

  it("tail, raw, conflicts, compounds", () => {
    assert.deepEqual(parseSel("-60"), { kind: "tail", count: 60 });
    assert.deepEqual(parseSel("raw"), { kind: "raw" });
    assert.deepEqual(parseSel("conflicts"), { kind: "conflicts" });
    assert.deepEqual(parseSel("raw:50-100"), { kind: "lines", ranges: [{ startLine: 50, endLine: 100 }], raw: true });
    assert.deepEqual(parseSel("50-100:raw"), { kind: "lines", ranges: [{ startLine: 50, endLine: 100 }], raw: true });
  });

  it("invalid bounds throw; selector-like compounds throw; unrecognized falls through to none", () => {
    assert.throws(() => parseSel("0"), /1-indexed/);
    assert.throws(() => parseSel("200-50"), /end must be >= start/);
    assert.throws(() => parseSel("1-1:conflicts"), /Invalid selector/);
    assert.throws(() => parseSel("-0"), /Tail selector -0/);
    // Not selector-shaped → none (literal-path semantics, OMP fall-through).
    assert.deepEqual(parseSel("bogus"), { kind: "none" });
    assert.deepEqual(parseSel("a:b"), { kind: "none" });
  });
});

describe("tail resolution + offset/limit", () => {
  it("resolveTailSelector pins :-N against the line count", () => {
    const pinned = resolveTailSelector({ kind: "tail", count: 3 }, 10);
    assert.deepEqual(pinned, { kind: "lines", ranges: [{ startLine: 8, endLine: 10 }] });
    // Count larger than the file clamps to line 1.
    const clamped = resolveTailSelector({ kind: "tail", count: 99 }, 10);
    if (clamped.kind !== "lines") throw new Error("unreachable");
    assert.deepEqual(clamped.ranges[0].startLine, 1);
  });

  it("selToOffsetLimit converts single ranges", () => {
    assert.deepEqual(selToOffsetLimit({ kind: "lines", ranges: [{ startLine: 50, endLine: 200 }] }), { offset: 50, limit: 151 });
    assert.deepEqual(selToOffsetLimit({ kind: "lines", ranges: [{ startLine: 7, endLine: undefined }] }), { offset: 7, limit: undefined });
    assert.deepEqual(selToOffsetLimit({ kind: "raw" }), {});
  });

  it("multi-range detection and tail parsing", () => {
    assert.equal(isMultiRange(parseSel("5-16,960-973")), true);
    assert.equal(isMultiRange(parseSel("5-16")), false);
    assert.equal(parseTailCount("-60"), 60);
    assert.equal(parseTailCount("60"), null);
    assert.deepEqual(parseLineRanges("5-16,960-973"), [{ startLine: 5, endLine: 16 }, { startLine: 960, endLine: 973 }]);
  });
});

describe("path peeling", () => {
  it("peels a selector suffix; keeps schemes and drive letters literal", () => {
    assert.deepEqual(peelPathSelector("src/foo.ts:50-200"), { stem: "src/foo.ts", selector: parseSel("50-200") });
    assert.deepEqual(peelPathSelector("https://x/y:1-2"), { stem: "https://x/y:1-2" }); // scheme
    assert.deepEqual(peelPathSelector("C:\\tmp\\x.ts:1-2"), { stem: "C:\\tmp\\x.ts:1-2" }); // drive
    assert.deepEqual(peelPathSelector("no-colon.ts"), { stem: "no-colon.ts" });
  });
});

describe("conflict extraction", () => {
  it("pulls <<<<<<< … >>>>>>> blocks", () => {
    const lines = [
      "before",
      "<<<<<<< HEAD",
      "ours",
      "=======",
      "theirs",
      ">>>>>>> feature",
      "after",
    ];
    const blocks = extractConflictBlocks(lines);
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0], lines.slice(1, 6));
  });
});

// ── Wrapper integration (real read tool + real temp files) ──

describe("wrapped read selectors (integration)", () => {
  it("single range, tail, multi-range, conflicts, and literal-colon precedence", async () => {
    const dir = await tempDir();
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`);
    await writeFile(join(dir, "f.ts"), lines.join("\n") + "\n");
    // A file whose NAME contains a colon-selector shape — must win literally.
    await writeFile(join(dir, "g:1-2"), "COLON FILE");

    const onRepairs: string[] = [];
    const factory = (cwd: string) => createReadToolDefinition(cwd);
    const wrapped = wrapToolDefinition(factory(process.cwd()), factory, () => false, () => onRepairs.push("x"));
    const ctx = { cwd: dir };

    // Single range → translated to offset/limit, content sliced.
    const r1 = await wrapped.execute("t1", { path: "f.ts:10-12" }, undefined, undefined, ctx);
    const t1 = r1.content[0].text;
    assert.match(t1, /line10/);
    assert.match(t1, /line12/);
    assert.doesNotMatch(t1, /line13/);
    assert.doesNotMatch(t1, /line9\n/);

    // Tail :-3 → last three lines.
    const r2 = await wrapped.execute("t2", { path: "f.ts:-3" }, undefined, undefined, ctx);
    const t2 = r2.content[0].text;
    assert.match(t2, /line98/);
    assert.match(t2, /line100/);
    assert.doesNotMatch(t2, /line97/);

    // Multi-range → both slices + a skip marker.
    const r3 = await wrapped.execute("t3", { path: "f.ts:1-2,98-100" }, undefined, undefined, ctx);
    const t3 = r3.content[0].text;
    assert.match(t3, /line1\nline2/);
    assert.match(t3, /line98/);
    assert.match(t3, /lines 1-2/);
    assert.match(t3, /of 100 total/);
    assert.doesNotMatch(t3, /line50/);

    // Conflicts: fixture with merge markers.
    await writeFile(
      join(dir, "conflicted.txt"),
      ["keep", "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> branch", "tail"].join("\n"),
    );
    const r4 = await wrapped.execute("t4", { path: "conflicted.txt:conflicts" }, undefined, undefined, ctx);
    const t4 = r4.content[0].text;
    assert.match(t4, /1 conflict block/);
    assert.match(t4, /<<<<<<< HEAD/);
    assert.match(t4, />>>>>>> branch/);
    assert.doesNotMatch(t4, /^keep$/m);

    // Literal file named g:1-2 exists → read as-is, no selector.
    const r5 = await wrapped.execute("t5", { path: "g:1-2" }, undefined, undefined, ctx);
    assert.equal(r5.content[0].text, "COLON FILE");

    // Invalid selector on a real stem → loud error, not silent widening.
    await assert.rejects(
      () => wrapped.execute("t6", { path: "f.ts:1-1:conflicts" }, undefined, undefined, ctx),
      /Invalid selector/,
    );
  });

  it("description carries the selector grammar after wrapping", async () => {
    const dir = await tempDir();
    const factory = (cwd: string) => createReadToolDefinition(cwd);
    const wrapped = wrapToolDefinition(factory(dir), factory, () => false, () => {});
    assert.match(wrapped.description, /Path suffixes/);
    assert.match(wrapped.description, /:conflicts/);
  });
});
