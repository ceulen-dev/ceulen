// sg module unit tests — fake SgRunner (scripted arg-matching, gh.test.ts
// pattern). No real sg spawns; the binary is not assumed present.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sgBinary, type SgRunner } from "../lib/sg-cli.js";
import {
  buildRunArgs,
  formatMatches,
  mergeMatches,
  parseDiffOutput,
  parseSearch,
  type SgMatch,
} from "../lib/ops.js";

function sgMatch(over: Partial<SgMatch>): SgMatch {
  return { file: "a.ts", line: 2, column: 3, text: "return 1;", byteStart: 26, ...over };
}

const SEARCH_JSON = JSON.stringify([
  { text: "return 1;", range: { byteOffset: { start: 26, end: 35 }, start: { line: 1, column: 2 }, end: { line: 1, column: 11 } }, file: "a.ts", lines: "  return 1;" },
]);

describe("buildRunArgs", () => {
  it("search: pattern + json + default path", () => {
    assert.deepEqual(buildRunArgs({ pattern: "return 1", json: true }), ["run", "-p", "return 1", "--json=compact", "."]);
  });
  it("language, globs, paths", () => {
    const args = buildRunArgs({ pattern: "P", language: "ts", globs: ["*.ts"], paths: ["src", "lib"], json: true });
    assert.deepEqual(args, ["run", "-p", "P", "-l", "ts", "--globs", "*.ts", "--json=compact", "src", "lib"]);
  });
  it("rewrite dry-run has NO -U; apply adds it", () => {
    const dry = buildRunArgs({ pattern: "P", rewrite: "R", json: true });
    assert.equal(dry.includes("-U"), false);
    assert.ok(dry.includes("-r"));
    const apply = buildRunArgs({ pattern: "P", rewrite: "R", update: true });
    assert.equal(apply.includes("-U"), true);
  });
});

describe("parseSearch", () => {
  it("converts 0-based range to 1-based display", () => {
    const r = parseSearch({ exitCode: 0, stdout: SEARCH_JSON, stderr: "" }, "return 1");
    assert.equal(r.matches[0]!.line, 2);
    assert.equal(r.matches[0]!.column, 3);
    assert.equal(r.noMatches, false);
  });

  it("exit 1 + empty array = no matches, NOT an error", () => {
    const r = parseSearch({ exitCode: 1, stdout: "[]", stderr: "" }, "zzz");
    assert.equal(r.noMatches, true);
    assert.deepEqual(r.matches, []);
  });

  it("ERROR node stderr → pattern error with remediation text", () => {
    const r = parseSearch({ exitCode: 0, stdout: "[]", stderr: "Warning: Pattern contains an ERROR node and may cause unexpected results." }, "((((");
    assert.match(r.patternError!, /pattern failed to parse/);
  });

  it("non-JSON stdout throws (bad args surface loudly)", () => {
    assert.throws(() => parseSearch({ exitCode: 9, stdout: "error: unexpected argument", stderr: "" }, "x"), /non-JSON/);
  });

  it("matches without byteOffset still parse (dedupe key -1)", () => {
    const legacy = JSON.stringify([{ text: "x", file: "f.ts", range: { start: { line: 0, column: 0 } } }]);
    const r = parseSearch({ exitCode: 0, stdout: legacy, stderr: "" }, "x");
    assert.equal(r.matches[0]!.byteStart, -1);
  });
});

describe("mergeMatches", () => {
  it("dedupes by file + byteStart across sequential runs", () => {
    const a = { matches: [sgMatch({ byteStart: 5 }), sgMatch({ file: "b.ts", byteStart: 7 })], noMatches: false };
    const b = { matches: [sgMatch({ byteStart: 5 }), sgMatch({ byteStart: 9 })], noMatches: false };
    const merged = mergeMatches([a, b]);
    assert.equal(merged.matches.length, 3);
  });
  it("keeps -1-keyed legacy matches (no false dedupe)", () => {
    const a = { matches: [sgMatch({ byteStart: -1, line: 1 })], noMatches: false };
    const b = { matches: [sgMatch({ byteStart: -1, line: 5 })], noMatches: false };
    assert.equal(mergeMatches([a, b]).matches.length, 2);
  });
  it("surfaces a pattern error from any run", () => {
    const merged = mergeMatches([{ matches: [], noMatches: true }, { matches: [], noMatches: true, patternError: "bad" }]);
    assert.equal(merged.patternError, "bad");
  });
});

describe("formatMatches", () => {
  it("path:line:col + text, capped with a footer", () => {
    const matches = Array.from({ length: 250 }, (_, i) => sgMatch({ file: `f${i}.ts`, line: i + 1, column: 1, byteStart: i }));
    const out = formatMatches(matches, "pat");
    const lines = out.split("\n");
    assert.match(lines[0]!, /^f0\.ts:1:1  return 1;$/);
    assert.match(lines.at(-1)!, /showing 200 of 250/);
  });
  it("empty → friendly no-match line", () => {
    assert.equal(formatMatches([], "pat"), "no matches for pat");
  });
});

describe("parseDiffOutput", () => {
  it("splits per-file sections on bare-path headers", () => {
    const stdout = [
      "a.ts",
      "@@ -0,3 +0,3 @@",
      "1 1│ export function foo() {",
      "  │-  return 1;",
      "  2│+  return 2",
      "sub/c.ts",
      "@@ -0,3 +0,3 @@",
      "2  │-  return 1;",
    ].join("\n");
    const sections = parseDiffOutput(stdout);
    assert.deepEqual(sections.map((s) => s.file), ["a.ts", "sub/c.ts"]);
    assert.match(sections[0]!.diff, /return 2/);
    assert.match(sections[1]!.diff, /return 1;/);
  });
});

describe("binary probe", () => {
  it("sgBinary returns a name or null without throwing", () => {
    // Cached after first call; on this dev machine ast-grep IS installed,
    // but the test only asserts the shape (CI has no binary).
    const bin = sgBinary();
    assert.ok(bin === null || bin === "ast-grep" || bin === "sg");
  });
});
