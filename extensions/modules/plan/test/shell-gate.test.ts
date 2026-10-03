// Bash classification for plan mode: read auto-runs, writers hard-block,
// everything else takes the confirm tier. The vendored rules are
// regression-hardened upstream — these tests pin the contract, not the regexes.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyCommand, splitShellSegments, xargsPayload } from "../lib/shell-gate.js";

describe("plan shell gate — reads auto-run", () => {
  for (const cmd of [
    "ls -la",
    "grep -rn foo src",
    "cat package.json",
    "git status",
    "git log --oneline -5",
    "git diff HEAD",
    "git branch --show-current",
    "git config --get user.email",
    "head -20 README.md | wc -l",
    "grep foo src | head",
    "ls -la; echo done",
    "cd src && ls",
    "FOO=1 LANG=C ls",
    "find . -name '*.ts' 2>/dev/null | head",
    "file README.md",
    "jq '.name' package.json",
    "echo a | xargs grep -l x",
    "tar -tf archive.tar",
    "tar -xOf archive.tar file",
    "command -v node",
    "type git",
    "sort -n numbers.txt",
    "sed -E 's/a/b/' file.txt | head",
    "while IFS= read -r f; do cat \"$f\"; done",
  ]) {
    it(`read: ${cmd}`, () => assert.equal(classifyCommand(cmd), "read", cmd));
  }
});

describe("plan shell gate — writers hard-block", () => {
  for (const cmd of [
    "echo hi > out.txt",
    "ls >> log.txt",
    "cat <<EOF > x.md\nhello\nEOF",
    "sed -i 's/a/b/' file.ts",
    "echo x | tee out.txt",
    "cp a b",
    "mv a b",
    "rm -rf node_modules",
    "mkdir -p .pi/plans",
    "touch newfile",
    "find . -name '*.tmp' -delete",
    "perl -pi -e 's/a/b/' file.ts",
    "sort -o out.txt in.txt",
    "git commit -m x",
    "git checkout main",
    "git config user.email x@y.z",
    "echo $(date)",
    "echo a | xargs rm",
    "echo a | xargs --null rm",
  ]) {
    it(`write: ${cmd}`, () => assert.equal(classifyCommand(cmd), "write", cmd));
  }
});

describe("plan shell gate — unknown executables confirm", () => {
  for (const cmd of [
    "npm test",
    "bun run build",
    "pytest -q",
    "make all",
    "node script.js",
    "python3 -c 'open(\"x\",\"w\")'",
    "git -C repo status", // tolerated global opt → read (regression pin)
  ]) {
    it(`confirm-or-read: ${cmd}`, () => {
      const disposition = classifyCommand(cmd);
      // Git global opts are explicitly read; the rest are confirm.
      if (cmd.startsWith("git ")) assert.equal(disposition, "read", cmd);
      else assert.equal(disposition, "confirm", cmd);
    });
  }
});

describe("plan shell gate — helpers", () => {
  it("splitShellSegments keeps quoted separators in one segment", () => {
    assert.deepEqual(splitShellSegments("grep 'a|b' f | head"), ["grep 'a|b' f", "head"]);
    assert.deepEqual(splitShellSegments("ls; echo done"), ["ls", "echo done"]);
  });

  it("xargsPayload strips separate-value flags and attached clusters", () => {
    assert.equal(xargsPayload("xargs -I {} grep -l x"), "grep -l x");
    assert.equal(xargsPayload("xargs -0 -r grep -l x"), "grep -l x");
    // Regression (fixed deviation): a VALUELESS long option must not eat the
    // payload — `--null rm` must yield `rm`, not "" (which upstream read as
    // "read" and auto-allowed a writer).
    assert.equal(xargsPayload("xargs --null rm"), "rm");
    assert.equal(xargsPayload("xargs --arg-file list grep x"), "grep x");
  });

  it("empty command → confirm (never auto-run)", () => {
    assert.equal(classifyCommand("   "), "confirm");
  });
});
