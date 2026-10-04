/**
 * rules lib tests: parsing (sticky vs rulebook), @import expansion (cycle guard,
 * missing marker, fence skip), prompt-block composition (marker, cap + truncation
 * marker), and the mtime cache. Fixture files live in temp dirs.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MAX_IMPORT_DEPTH,
  STICKY_CHAR_CAP,
  clearRuleCache,
  composeRulesBlock,
  discoverRuleFiles,
  loadRules,
  parseRulesFile,
} from "../lib/rules";

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
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

/** cwd nested inside an empty temp root — no ancestor can hold a .pi/RULES.md. */
function workspace(): { cwd: string; userDir: string } {
  const root = tmp("rules-lib-");
  return { cwd: path.join(root, "a", "b"), userDir: path.join(root, "agent") };
}

describe("parseRulesFile", () => {
  it("classifies a description-led section as rulebook and the rest as sticky", () => {
    const rules = parseRulesFile(
      [
        "## never-push",
        "Never commit or push.",
        "",
        "## api-style",
        "description: How to write HTTP handlers here.",
        "Always use the shared json() helper.",
      ].join("\n"),
      "/x/.pi/RULES.md",
    );

    assert.deepEqual(rules.map((r) => [r.name, r.sticky, r.description]), [
      ["never-push", true, undefined],
      ["api-style", false, "How to write HTTP handlers here."],
    ]);
    assert.equal(rules[0].body, "Never commit or push.");
    // The description line is metadata, never part of the body.
    assert.equal(rules[1].body, "Always use the shared json() helper.");
  });

  it("treats pre-heading prose as one sticky rule named RULES", () => {
    const rules = parseRulesFile("Never edit generated files.\nDo not commit without asking.\n", "/x/RULES.md");
    assert.deepEqual(rules.map((r) => [r.name, r.sticky, r.body]), [
      ["RULES", true, "Never edit generated files.\nDo not commit without asking."],
    ]);
  });

  it("does not parse headings inside fenced code blocks or non-## headings", () => {
    const rules = parseRulesFile(
      ["# Title", "## real", "```md", "## not-a-rule", "```", "### also-not-a-rule"].join("\n"),
      "/x/RULES.md",
    );
    assert.deepEqual(rules.map((r) => r.name), ["real"]);
    assert.ok(rules[0].body.includes("## not-a-rule"));
    assert.ok(rules[0].body.includes("### also-not-a-rule"));
  });

  it("ignores empty sections and a description line with no value", () => {
    assert.deepEqual(parseRulesFile("## empty\n\n## also-empty\n", "/x/RULES.md"), []);
    const [rule] = parseRulesFile("## x\ndescription:\nbody here\n", "/x/RULES.md");
    assert.equal(rule.sticky, true, "an empty description must not turn a sticky rule into a rulebook entry");
    assert.equal(rule.body, "description:\nbody here");
  });
});

describe("@import expansion", () => {
  it("expands relative to the importing RULES.md (not cwd), recursively", () => {
    const { cwd, userDir } = workspace();
    const rulesFile = write(
      path.join(cwd, ".pi/RULES.md"),
      ["## a", "top", "@inc/one.md"].join("\n"),
    );
    write(path.join(cwd, ".pi/inc/one.md"), "one\n@sibling/two.md\n");
    write(path.join(cwd, ".pi/inc/sibling/two.md"), "two\n");

    const model = loadRules(cwd, userDir);
    assert.equal(model.rules.length, 1);
    assert.ok(model.rules[0].body.includes("top"));
    assert.ok(model.rules[0].body.includes("one"));
    assert.ok(model.rules[0].body.includes("two"), "nested imports expand relative to their own file");
    assert.equal(model.rules[0].source, rulesFile);
    assert.deepEqual(discoverRuleFiles(cwd, userDir), [rulesFile]);
  });

  it("leaves cycles and repeats literal and never crashes", () => {
    const { cwd, userDir } = workspace();
    write(path.join(cwd, ".pi/RULES.md"), "## a\n@a.md\n@b.md\n@b.md\n");
    write(path.join(cwd, ".pi/a.md"), "AAA\n@b.md\n");
    write(path.join(cwd, ".pi/b.md"), "BBB\n@a.md\n");

    const body = loadRules(cwd, userDir).rules[0].body;
    assert.ok(body.includes("AAA"));
    assert.ok(body.includes("BBB"));
    // a.md already pulled b.md, so b.md's own @a.md back-reference stays literal.
    assert.ok(body.includes("@a.md"));
    // Second mention of b.md is a repeat → literal, not a second expansion.
    assert.equal(body.match(/BBB/g)?.length, 1);
  });

  it("marks a missing import in one line instead of failing", () => {
    const { cwd, userDir } = workspace();
    write(path.join(cwd, ".pi/RULES.md"), "## a\nsee @nope/missing.md for details\n");
    assert.ok(loadRules(cwd, userDir).rules[0].body.includes("[missing import: @nope/missing.md]"));
  });

  it("stops expanding past the depth limit", () => {
    const { cwd, userDir } = workspace();
    const chain = Array.from({ length: MAX_IMPORT_DEPTH + 2 }, (_, i) => `level-${i}`);
    write(path.join(cwd, ".pi/RULES.md"), `## a\n@f0.md\n`);
    chain.forEach((text, i) => write(path.join(cwd, `.pi/f${i}.md`), `${text}\n@f${i + 1}.md\n`));

    const body = loadRules(cwd, userDir).rules[0].body;
    assert.ok(body.includes(`level-${MAX_IMPORT_DEPTH - 1}`));
    assert.ok(body.includes(`[import depth limit reached: @f${MAX_IMPORT_DEPTH}.md]`));
    assert.ok(!body.includes(`level-${MAX_IMPORT_DEPTH + 1}`));
  });

  it("does not expand @tokens inside fences, or email/git tokens", () => {
    const { cwd, userDir } = workspace();
    write(path.join(cwd, ".pi/doc.md"), "EXPANDED\n");
    write(
      path.join(cwd, ".pi/RULES.md"),
      ["## a", "```", "@doc.md", "```", "mail me at user@example.com", "clone git@github.com:o/r.git", "also `@nope.ts`"].join("\n"),
    );
    const body = loadRules(cwd, userDir).rules[0].body;
    assert.ok(!body.includes("EXPANDED"), "fenced @tokens stay literal");
    assert.ok(body.includes("user@example.com"));
    assert.ok(body.includes("git@github.com:o/r.git"));
    // A `@token` opening an inline code span follows a backtick, so the
    // "line start or whitespace" gate leaves it literal — span and fence alike.
    assert.ok(body.includes("`@nope.ts`"), "inline code spans stay literal");
    assert.ok(!body.includes("[missing import: @nope.ts]"));
  });
});

describe("precedence", () => {
  it("resolves sources nearest-first and projects override the user file", () => {
    const { cwd, userDir } = workspace();
    const near = write(path.join(cwd, ".pi/RULES.md"), "## shared\nnear\n## near-only\nN\n");
    const far = write(path.join(cwd, "..", ".pi/RULES.md"), "## shared\nfar\n## far-only\nF\n");
    const user = write(path.join(userDir, "RULES.md"), "## shared\nuser\n## user-only\nU\n");

    assert.deepEqual(discoverRuleFiles(cwd, userDir), [near, far, user]);

    const model = loadRules(cwd, userDir);
    assert.deepEqual(model.rules.map((r) => r.name), ["shared", "near-only", "far-only", "user-only"]);
    assert.equal(model.rules[0].body, "near", "nearest project file wins the duplicate name");
    assert.deepEqual(
      model.rules.map((r) => r.source),
      [near, near, far, user],
    );
  });
});

describe("composeRulesBlock", () => {
  it("is undefined when no RULES.md exists anywhere (zero footprint)", () => {
    const { cwd, userDir } = workspace();
    const model = loadRules(cwd, userDir);
    assert.equal(model.block, undefined);
    assert.deepEqual(model.files, []);
    assert.equal(composeRulesBlock(model, cwd), undefined);
  });

  it("marks the block and lists rulebook names with descriptions only", () => {
    const { cwd, userDir } = workspace();
    write(
      path.join(cwd, ".pi/RULES.md"),
      ["## sticky-one", "S body", "", "## book-one", "description: B description", "B body secret"].join("\n"),
    );
    const model = loadRules(cwd, userDir);
    const block = model.block!;

    assert.ok(block.startsWith("<user-rules>"));
    assert.ok(block.endsWith("</user-rules>"));
    assert.ok(block.includes("S body"));
    assert.ok(block.includes("- book-one: B description"));
    assert.ok(!block.includes("B body secret"), "the rulebook body is served on demand, never inlined");
    assert.equal(model.blockChars, block.length);
  });

  it("caps the sticky block and drops the lowest-precedence files first, loudly", () => {
    const { cwd, userDir } = workspace();
    const big = (name: string) => `## ${name}\n${name.repeat(1500)}\n`;
    write(path.join(cwd, ".pi/RULES.md"), big("near"));
    write(path.join(userDir, "RULES.md"), big("user"));

    const model = loadRules(cwd, userDir);
    const block = model.block!;
    assert.equal(model.sticky.length, 2);
    assert.ok(block.includes("near"), "the nearest file survives");
    assert.ok(!block.includes("user".repeat(1500)), "the user file is dropped first");
    assert.ok(block.includes("STICKY RULES TRUNCATED"));
    assert.ok(block.includes(`exceeded ${STICKY_CHAR_CAP} chars`));
  });

  it("truncates a single oversized sticky rule instead of dumping it whole", () => {
    const { cwd, userDir } = workspace();
    write(path.join(cwd, ".pi/RULES.md"), `## huge\n${"x".repeat(STICKY_CHAR_CAP * 2)}\n`);
    const block = loadRules(cwd, userDir).block!;
    assert.ok(block.includes("[rule body truncated at the sticky cap]"));
    assert.ok(block.length < STICKY_CHAR_CAP + 500);
  });
});

describe("mtime cache", () => {
  it("re-reads after an edit and after an edit to an imported file", async () => {
    const { cwd, userDir } = workspace();
    const imported = write(path.join(cwd, ".pi/snippet.md"), "OLD-IMPORT\n");
    write(path.join(cwd, ".pi/RULES.md"), "## a\n@snippet.md\n");
    assert.ok(loadRules(cwd, userDir).rules[0].body.includes("OLD-IMPORT"));

    // Same mtimeMs/size would hide the change — bump mtime explicitly.
    const bump = (file: string, text: string) => {
      writeFileSync(file, text, "utf8");
      const future = new Date(Date.now() + 5000);
      utimesSync(file, future, future);
    };

    bump(imported, "NEW-IMPORT\n");
    assert.ok(loadRules(cwd, userDir).rules[0].body.includes("NEW-IMPORT"), "imported-file edits invalidate the cache");

    bump(path.join(cwd, ".pi/RULES.md"), "## a\nBODY-V2\n@missing.md\n");
    assert.ok(loadRules(cwd, userDir).rules[0].body.includes("BODY-V2"));

    clearRuleCache();
    assert.ok(loadRules(cwd, userDir).rules[0].body.includes("BODY-V2"));
  });

  it("returns the cached model unchanged when nothing on disk moved", () => {
    const { cwd, userDir } = workspace();
    write(path.join(cwd, ".pi/RULES.md"), "## a\nstable\n");
    const first = loadRules(cwd, userDir);
    assert.equal(loadRules(cwd, userDir), first, "same mtime+size → the same model object");
  });
});
