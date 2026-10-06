// jfind unit tests — fake judge, fixture tree, cascade end-to-end. No
// network; the classifier is injected through the Judge seam.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { clipBytes, countOccurrences, keywords, lines, takeChars } from "../lib/lexical.js";
import { idf, grepIndex, fileScore } from "../lib/lexical.js";
import {
  eligibleFile,
  listFiles,
  mergeHeat,
  plainContent,
  rankedHeat,
  selectWindows,
  sketch,
  windows,
} from "../lib/tree.js";
import { entryKey, passageKey, nameBatch, sketchBatch, passageBatch, type Judge, type Request } from "../lib/questions.js";
import { runCascade, type CascadeOptions } from "../lib/cascade.js";

const dir = mkdtempSync(path.join(tmpdir(), "ceulen-jfind-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// ── primitives ──────────────────────────────────────────────────────────────

describe("text primitives", () => {
  it("lines: no phantom tail, \\r stripped", () => {
    assert.deepEqual(lines("a\nb\r\n"), ["a", "b"]);
    assert.deepEqual(lines(""), []);
  });
  it("clipBytes never splits a code point", () => {
    const s = "aé☃".repeat(10);
    const clipped = clipBytes(s, 5);
    assert.ok(Buffer.byteLength(clipped) <= 5);
    assert.ok(s.startsWith(clipped));
  });
  it("takeChars counts code points", () => {
    assert.equal(takeChars("aé☃x", 2), "aé");
  });
  it("countOccurrences", () => {
    assert.equal(countOccurrences("aXbXc", "X"), 2);
    assert.equal(countOccurrences("abc", ""), 0);
  });
});

describe("keywords", () => {
  it("stopwords dropped, tokens stemmed, quoted phrases whole", () => {
    const kws = keywords('parse "cron expr" into spawn-times', []);
    assert.ok(kws.includes("cron expr"));
    assert.ok(kws.includes("parse"));
    assert.ok(kws.includes("spawn")); // stemmed from spawn-times token split? token is spawn, times
    assert.ok(kws.includes("time")); // stemmed
    assert.ok(!kws.includes("into"));
  });
  it("extra keywords folded, deduped, lowercased", () => {
    const kws = keywords("parse flags", ["Parse", "CLI"]);
    assert.deepEqual(kws.filter((k) => k === "parse").length, 1);
    assert.ok(kws.includes("cli"));
  });
});

// ── lexical prior ───────────────────────────────────────────────────────────

describe("lexical prior", () => {
  it("grepIndex counts per file; idf clamps; fileScore boosts path hits", async () => {
    const a = path.join(dir, "scan-a.txt");
    const b = path.join(dir, "scan-b.txt");
    writeFileSync(a, "spawn x\nspawn y\nSPAWN z\nother\n");
    writeFileSync(b, "nothing here\n");
    const files = new Map([
      ["scan-a.txt", a],
      ["scan-b.txt", b],
    ]);
    const index = await grepIndex(dir, ["spawn"], { files });
    assert.equal(index.filesScanned, 2);
    assert.deepEqual(index.perFileKw.get("scan-a.txt"), [3]);
    assert.equal(index.perFileKw.has("scan-b.txt"), false);
    const weights = idf(index);
    assert.equal(weights.length, 1);
    assert.ok(weights[0]! >= 0.5 && weights[0]! <= 6);
    const scoreA = fileScore(index.perFileKw.get("scan-a.txt")!, weights, "scan-a.txt", ["spawn"]);
    const scoreB = fileScore([0], weights, "scan-b.txt", ["spawn"]);
    assert.ok(scoreA > scoreB);
  });
});

// ── tree ────────────────────────────────────────────────────────────────────

describe("tree eligibility + walk", () => {
  const proj = path.join(dir, "proj");
  before(() => {
    mkdirSync(path.join(proj, "src"), { recursive: true });
    mkdirSync(path.join(proj, "node_modules"), { recursive: true });
    mkdirSync(path.join(proj, ".git"), { recursive: true });
    writeFileSync(path.join(proj, "src", "impl.ts"), "export const x = 1;\n");
    writeFileSync(path.join(proj, "package-lock.json"), "{}");
    writeFileSync(path.join(proj, "node_modules", "x.js"), "module.exports = 1;\n");
    writeFileSync(path.join(proj, ".git", "config"), "[core]\n");
    writeFileSync(path.join(proj, "secret.key"), "-----BEGIN");
    writeFileSync(path.join(proj, ".env"), "TOP_SECRET=1\n");
    writeFileSync(path.join(proj, ".env.example"), "FOO=\n");
    writeFileSync(path.join(proj, "empty.ts"), "");
  });

  it("eligibleFile deny-lists build noise, secrets, binaries, empty", () => {
    assert.equal(eligibleFile("src/impl.ts", 10, false), true);
    assert.equal(eligibleFile("package-lock.json", 10, false), false);
    assert.equal(eligibleFile("node_modules/x.js", 10, false), false);
    assert.equal(eligibleFile("secret.key", 10, false), false);
    assert.equal(eligibleFile(".env", 10, false), false);
    assert.equal(eligibleFile(".env.example", 10, false), false); // hidden dotfile: excluded unless includeHidden
    assert.equal(eligibleFile(".env.example", 10, true), true); // template admitted when hidden included
    assert.equal(eligibleFile("empty.ts", 0, false), false);
    assert.equal(eligibleFile("logo.png", 10, false), false);
    assert.equal(eligibleFile(".hidden.ts", 10, false), false);
    assert.equal(eligibleFile(".hidden.ts", 10, true), true);
  });

  it("listFiles walks the tree, skipping deny dirs; git checkout preferred", () => {
    const files = listFiles(proj);
    const rels = files.map((f) => f.rel);
    assert.ok(rels.includes("src/impl.ts"));
    assert.ok(!rels.includes(".env.example")); // hidden, walk runs includeHidden=false
    assert.ok(!rels.some((r) => r.startsWith("node_modules") || r.startsWith(".git") || r === "package-lock.json" || r === "secret.key" || r === ".env"));
    void proj;
    void mkdirSync; // silence unused import in some tsconfigs
  });
});

// ── passages ────────────────────────────────────────────────────────────────

describe("passages", () => {
  const text = Array.from({ length: 30 }, (_, i) => (i === 5 ? "spawn child process" : `line ${i}`)).join("\n");
  it("windows: byte-bounded, 1-based, keyword-scored", () => {
    const ps = windows(text, 256, ["spawn"], [2]);
    assert.ok(ps.length > 1);
    assert.equal(ps[0]!.start, 1);
    const hit = ps.find((p) => p.score > 0);
    assert.ok(hit, "the spawn window scored");
    assert.match(hit!.text, /L6\| spawn child process/);
  });
  it("selectWindows: scores first, even spread on zero scores", () => {
    const ps = windows(text, 256, ["spawn"], [2]);
    const sel = selectWindows(ps, 3);
    assert.ok(sel.length <= 3);
    const all = windows(Array.from({ length: 40 }, (_, i) => `row ${i}`).join("\n"), 128, ["zzz"], [1]);
    const spread = selectWindows(all, 4);
    assert.ok(spread[0]!.start < spread[1]!.start);
    assert.ok(spread.at(-1)!.end >= 39); // reaches the end of the file
  });
  it("plainContent strips the L<n>| tags", () => {
    const p = windows("alpha\nbeta\n", 4096, [], [])[0]!;
    assert.equal(plainContent(p), "alpha\nbeta\n");
  });
  it("sketch: keyword-ranked verbatim lines, budget-bounded", () => {
    const p = windows(text, 8192, ["spawn"], [2])[0]!;
    const s = sketch(p, ["spawn"], [2], 200);
    assert.match(s, /^6: spawn child process/m);
    assert.ok(Buffer.byteLength(s) <= 200 + 180);
  });
  it("mergeHeat unions adjacent positives, keeps max p, drops below threshold", () => {
    const heat = [
      { start: 1, end: 3, p: 0.9, snippet: "a" },
      { start: 4, end: 6, p: 0.5, snippet: "b" },
      { start: 10, end: 12, p: 0.15, snippet: "low" },
      { start: 20, end: 22, p: 0.8, snippet: "c" },
    ];
    const merged = mergeHeat(heat, 0.2);
    assert.equal(merged.length, 2);
    assert.deepEqual([merged[0]!.start, merged[0]!.end], [1, 6]);
    assert.equal(merged[0]!.p, 0.9);
    assert.deepEqual([merged[1]!.start, merged[1]!.end], [20, 22]);
  });
  it("rankedHeat: strongest first, limited", () => {
    const heat = [
      { start: 1, end: 2, p: 0.5, snippet: "a" },
      { start: 5, end: 6, p: 0.9, snippet: "b" },
    ];
    const r = rankedHeat(heat, 1);
    assert.equal(r.length, 1);
    assert.equal(r[0]!.start, 5);
  });
});

// ── questions ───────────────────────────────────────────────────────────────

describe("questions", () => {
  it("keys are zero-padded and stable", () => {
    assert.equal(entryKey(0), "e000");
    assert.equal(entryKey(17), "e017");
    assert.equal(passageKey(3), "p03");
  });
  it("nameBatch renders a tree with tags + per-entry noul questions", () => {
    const req = nameBatch("proj", "parse flags", [
      { path: "/x/src/cli.ts", rel: "src/cli.ts", size: 1200 },
      { path: "/x/README.md", rel: "README.md", size: 400 },
    ]);
    assert.match(String(req.state.tree), /# src\//);
    assert.match(String(req.state.tree), /e000 cli\.ts \(1\.2 KB\)/);
    assert.ok(req.questions.e000);
    assert.ok(req.questions.e001);
    assert.match(req.questions.e000!.instructions, /"cli\.ts"/);
  });
  it("sketchBatch + passageBatch carry criteria + query", () => {
    const s = sketchBatch("q", [{ fileKey: "f0", rel: "a.ts", sketch: "1: x" }]);
    assert.deepEqual((s.state.passages as Record<string, unknown>).p00, ["f0", "1: x"]);
    const ps = windows("alpha\nbeta\n", 4096, [], []);
    const v = passageBatch("q", "a.ts", ps);
    assert.match(String((v.state.passages as Record<string, string>).p00!), /alpha/);
  });
});

// ── cascade end-to-end with a scripted judge ────────────────────────────────

describe("cascade", () => {
  const proj = path.join(dir, "cascadeproj");
  before(() => {
    mkdirSync(path.join(proj, "src"), { recursive: true });
    writeFileSync(
      path.join(proj, "src", "spawn.ts"),
      [
        "// child spawn helper",
        "export function spawnChild(cmd: string) {",
        '  const child = spawn(cmd, { shell: true });',
        "  return child;",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(path.join(proj, "src", "unrelated.ts"), "export const unrelated = 1;\n");
  });

  /** Scripted judge: noul 0.95 for any question whose instructions mention
   *  the target file or a passage (sketch/verify waves), 0.05 for the rest. */
  function fakeJudge(positiveRel: string): Judge {
    return {
      label: "fake",
      async judge(request: Request) {
        const answers: Record<string, { probability: number }> = {};
        for (const key of Object.keys(request.questions)) {
          const state = JSON.stringify(request.state);
          const passages = request.state.passages as Record<string, unknown> | undefined;
          const hit = passages
            ? Object.values(passages).some((p) => JSON.stringify(p).includes("spawn"))
            : state.includes(positiveRel);
          answers[key] = { probability: hit || state.includes("spawn") ? 0.95 : 0.05 };
        }
        return { answers, usage: { input: 100, output: 10 } };
      },
    };
  }

  it("finds the implementing file with heat ranges, strongest first", async () => {
    const judge = fakeJudge("src/spawn.ts");
    const opts: CascadeOptions = {
      root: proj,
      query: "spawn a child process",
      extraKeywords: [],
      judge,
    };
    const result = await runCascade(opts);
    assert.equal(result.threshold, 0.2);
    assert.ok(result.hits.length >= 1, `hits: ${JSON.stringify(result.hits)}, stats: ${JSON.stringify(result.stats)}`);
    const top = result.hits[0]!;
    assert.equal(top.rel, "src/spawn.ts");
    assert.ok(top.contentScore >= 0.2);
    assert.ok(top.ranges.length >= 1);
    assert.ok(top.ranges[0]!.start >= 1);
    assert.match(top.ranges[0]!.snippet, /spawn/);
    assert.ok(result.stats.requests > 0);
    assert.ok(result.stats.judged > 0);
  });

  it("judge failures degrade to failures[] instead of throwing", async () => {
    const judge: Judge = {
      label: "failing",
      async judge() {
        throw new Error("endpoint down");
      },
    };
    const result = await runCascade({ root: proj, query: "spawn", extraKeywords: [], judge });
    assert.equal(result.hits.length, 0);
    assert.equal(result.stats.errors, result.stats.requests);
    assert.ok(result.stats.failures.length >= 1);
  });

  it("aborted signal surfaces (does not swallow)", async () => {
    const judge: Judge = {
      label: "aborting",
      async judge(_r, options) {
        options?.signal?.throwIfAborted?.();
        throw new Error("aborted");
      },
    };
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runCascade({ root: proj, query: "spawn", extraKeywords: [], judge, signal: controller.signal }),
      /aborted/,
    );
  });
});
