// Bash classification for plan mode: read auto-runs, writers hard-block,
// everything else takes the confirm tier. The vendored rules are
// regression-hardened upstream — these tests pin the contract, not the regexes.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

// 2026-10-17 escape-hardening (security review F1): backslash-escaped quotes
// outside quotes must not open phantom quotes; double-quote closes must count
// backslash-run parity ("a\\" = literal backslash + close); $()/backticks
// inside DOUBLE quotes still execute (bash); dangling quotes never auto-run.
describe("plan shell gate — escape hardening (phantom-quote exploit class)", () => {
  const cases: Array<[string, "read" | "write" | "confirm"]> = [
    // Escaped quote OUTSIDE quotes is a literal — the ; stays a separator and
    // the rm segment makes the whole command a write. (Pre-fix: phantom quote
    // swallowed the ; and the command classified read → auto-run.)
    ["ls \\' ; rm -rf /tmp/sg-fixture", "write"],
    ["ls \\\" ; rm -rf /tmp/sg-fixture", "write"],
    ["cat \\'$(rm -rf /tmp/sg-fixture)\\'", "write"],
    // Even backslash run immediately before a double quote = literal
    // backslash, then the quote CLOSES (bash-faithful; pre-fix stayed open).
    ['ls "a\\\\" ; rm -rf /tmp/sg-fixture', "write"],
    ['echo "x\\\\" ; rm -rf /tmp/sg-fixture/x', "write"],
    // Odd run = escaped quote, stays open → dangling → confirm (never read).
    ['echo "a\\" ; rm -rf /tmp/sg-fixture/x', "confirm"],
    // Benign escaped quotes must stay reads.
    ["grep \"a\\\"b\" f", "read"],
    ['grep "a\\\\" f', "read"],
    // Dangling single quote (bash: unexpected EOF) → confirm, never read.
    ["echo 'it\\'s'", "confirm"],
    // $() / backticks inside DOUBLE quotes execute in bash — the inner rm
    // must surface. (Pre-fix: substitution finder treated quoted spans as
    // literal → echo read → auto-run.)
    ['echo "$(rm -rf x)"', "write"],
    ['echo "`rm -rf x`"', "write"],
    // Single-quoted substitution is literal data — stays read.
    ["echo '$(date)'", "read"],
    // Quoted redirect chars stay data (regression pins from the 2026-10-15 rework).
    [`jq -r 'select(.x > "1")' f.json`, "read"],
    [`grep -oE "[^<]" page.html`, "read"],
  ];
  for (const [cmd, expected] of cases) {
    it(`${expected}: ${cmd.split("\n")[0]}`, () => assert.equal(classifyCommand(cmd), expected, cmd));
  }

  it("escaped-quote segments split on the previously-swallowed separators", () => {
    assert.deepEqual(splitShellSegments("ls \\' ; rm -rf /tmp/sg-fixture"), ["ls \\'", "rm -rf /tmp/sg-fixture"]);
  });
});

// 2026-10-17 home-wipe incident: exploit fixtures pointed rm at the home
// directory. Fixture text is mined into plans, printed by failing test
// output, and pasted into real shells during verification - every rm
// target in this file stays on a sacrificial /tmp path; this meta-test
// keeps it so. (The probe strings are built from char codes so this test
// cannot flag its own source text.)
describe("plan shell gate - fixture ammo discipline", () => {
  it("no rm fixture points at the home directory", () => {
    const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const tilde = String.fromCharCode(0x7e);
    const rmDash = ["rm", "-"].join(" ");
    const bad = src
      .split(String.fromCharCode(10))
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.includes(rmDash) && (line.includes(tilde) || line.includes("$HOME")));
    assert.deepEqual(bad.map(({ n }) => n), [], "home-pointing rm fixtures found - retarget to /tmp/sg-fixture");
  });
});
