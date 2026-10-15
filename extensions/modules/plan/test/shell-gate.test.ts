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
    "echo $(rm -rf x)",
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

// 2026-10-15 rework (plan 2026-10-15T08-50-03-167Z): the six false-block
// classes mined from 2 weeks of session history. Each command below was a
// REAL hard-block in a live session except the regression writers.
describe("plan shell gate — false-block rework fixtures", () => {
  const cases: Array<[string, "read" | "write" | "confirm"]> = [
    // A6: sed s-command flag scan no longer parses file PATHS.
    ["sed -n '800,845p' extensions/modules/plan/index.ts", "read"],
    ["sed -n '1,12p' extensions/modules/web/index.ts", "read"],
    // A5: bare `env` prints the environment.
    [`env | grep -i "PI_"`, "read"],
    ["env FOO=1 grep x f", "read"],
    ["env rm -rf x", "write"],
    // A1: quoted `<`/`>` are data, not redirects.
    [`jq -r 'select(.timestamp > "2026-10-14") | .x' sessions.jsonl`, "read"],
    [`grep -oE "CgroupNS[^<]{0,120}" page.html`, "read"],
    // A2: substitution classifies its INNER command.
    [`TOKEN=$(curl -s https://x.test/t); curl -s https://x.test/v`, "confirm"],
    ["echo $(date)", "confirm"],
    // Substitution AS the sed script is uninspectable (its w/e flags are
    // runtime-computed) → confirm even with a read-only inner. REAL failing
    // command from classifier.log (advisor-flagged A5 misreport, 2026-10-15):
    [`sed -n "$(grep -n 'function planGateAutoRun' extensions/modules/plan/index.ts | cut -d: -f1),+2p" extensions/modules/plan/index.ts`, "confirm"],
    // A3: process substitution demotes to confirm.
    [`comm -23 <(ls themes/*.json | sort) <(jq -r '.x' themes/a.json)`, "confirm"],
    // A4: heredoc feeding an interpreter is confirm, not write.
    ["python3 - <<'EOF'\nprint(1)\nEOF", "confirm"],
    // `<` file input reads a file — demote to confirm, never auto-read.
    ["wc -l < notes.md", "confirm"],
    // True writers stay hard-blocked.
    ["echo hi > /tmp/x", "write"],
    ["rm file.txt", "write"],
    ["cat > newf.ts <<'EOF'\nx\nEOF", "write"],
    ["cat <<EOF > x.md\nhello\nEOF", "write"],
    // Controls (regression pins from the live probe).
    ["diff pi-web/a.d.ts /Users/x/node_modules/a.d.ts", "read"],
    ["R=/rel1/dist; L=/rel2/dist; diff \"$R/types.d.ts\" \"$L/types.d.ts\" | head -5", "read"],
    ["node --import tsx -e \"console.log(1)\"", "confirm"],
    ["npm test", "confirm"],
    ["for f in ~/.pi/agent/sessions/*/*.jsonl; do jq -r '.x' \"$f\"; done", "confirm"],
    ["git log --oneline | head -3", "read"],
    ["grep -rn \"exposure\" pi-*/extensions/*.ts | head", "read"],
    ["python3 -c 'import json; print(json.load(open(\"p.json\"))[\"a\"])'", "confirm"],
    ["git diff --stat", "read"],
    ["curl -s https://example.com | grep title", "confirm"],
    ["which pi; pi --version 2>/dev/null", "confirm"],
    ["wc -l extensions/modules/plan/index.ts", "read"],
  ];
  for (const [cmd, expected] of cases) {
    it(`${expected}: ${cmd.split("\n")[0]}`, () => assert.equal(classifyCommand(cmd), expected, cmd));
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
