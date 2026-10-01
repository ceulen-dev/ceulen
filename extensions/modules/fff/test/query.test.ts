import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildQuery, normalizePathConstraint } from "../lib/query";

const cwd = "/tmp/workspace";

describe("path constraint normalization", () => {
  it("converts absolute in-workspace paths to repo-relative constraints", () => {
    assert.strictEqual(normalizePathConstraint("/tmp/workspace/.agents/**", cwd), ".agents/");
    assert.strictEqual(normalizePathConstraint("/tmp/workspace/.agents/plans/**", cwd), ".agents/plans/");
  });

  it("rejects absolute paths outside the workspace", () => {
    assert.throws(() => normalizePathConstraint("/tmp/other/.agents/**", cwd), /Path\ constraint\ must\ be\ relative\ to\ the\ workspace/);
  });

  it("collapses only simple trailing recursive directory globs", () => {
    assert.strictEqual(normalizePathConstraint(".agents/**", cwd), ".agents/");
    assert.strictEqual(normalizePathConstraint("src/**/*", cwd), "src/");
    assert.strictEqual(normalizePathConstraint("src/**/*.ts", cwd), "src/**/*.ts");
    assert.strictEqual(normalizePathConstraint("{src,lib}/**", cwd), "{src,lib}/**");
  });

  it("builds find queries with normalized include and exclude constraints", () => {
    assert.strictEqual(buildQuery("/tmp/workspace/.agents/**", "*", "/tmp/workspace/test/**", cwd), ".agents/ !test/ *");
  });

  it("treats path='.' as workspace root", () => {
    assert.strictEqual(normalizePathConstraint(".", cwd), null);
    assert.strictEqual(normalizePathConstraint("./", cwd), null);
    assert.strictEqual(buildQuery(".", "needle", undefined, cwd), "needle");
  });

  it("treats absolute workspace root as no constraint", () => {
    assert.strictEqual(normalizePathConstraint(cwd, cwd), null);
    assert.strictEqual(buildQuery(cwd, "needle", undefined, cwd), "needle");
  });

  it("uses filesystem metadata for real dot-directories and extensionless files", () => {
    const fixture = mkdtempSync(join(tmpdir(), "pi-fff-query-"));
    try {
      mkdirSync(join(fixture, ".agents"));
      writeFileSync(join(fixture, "Dockerfile"), "FROM scratch\n");
      writeFileSync(join(fixture, ".gitignore"), "node_modules\n");

      assert.strictEqual(normalizePathConstraint(".agents", fixture), ".agents/");
      assert.strictEqual(normalizePathConstraint("@.agents", fixture), ".agents/");
      assert.strictEqual(normalizePathConstraint("Dockerfile", fixture), "Dockerfile");
      assert.strictEqual(normalizePathConstraint("@Dockerfile", fixture), "Dockerfile");
      assert.strictEqual(normalizePathConstraint(".gitignore", fixture), ".gitignore");
      assert.strictEqual(normalizePathConstraint("@*.ts", fixture), "*.ts");
      assert.throws(() => normalizePathConstraint("@../outside", fixture), /Path\ constraint\ must\ be\ relative\ to\ the\ workspace/);
      assert.throws(() => normalizePathConstraint("..\\.secrets\\token.txt", fixture), /Path\ constraint\ must\ be\ relative\ to\ the\ workspace/);
      assert.throws(() => normalizePathConstraint("C:other\\.hidden", fixture), /Path\ constraint\ must\ be\ relative\ to\ the\ workspace/);
      assert.strictEqual(normalizePathConstraint(".agents\\**\\*.md", fixture), ".agents/**/*.md");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("normalizes bare directories and file paths", () => {
    assert.strictEqual(normalizePathConstraint("app", cwd), "app/");
    assert.strictEqual(normalizePathConstraint("src/nested", cwd), "src/nested/");
    assert.strictEqual(normalizePathConstraint("/tmp/workspace/src/main.rs", cwd), "src/main.rs");
    assert.strictEqual(normalizePathConstraint("/tmp/workspace/src", cwd), "src/");
    assert.strictEqual(normalizePathConstraint("/tmp/workspace/src/**/*.ts", cwd), "src/**/*.ts");
  });
});
