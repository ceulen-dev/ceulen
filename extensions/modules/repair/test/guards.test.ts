// ponytail: vendored from @bacnh85/pi-model-tools 0.9.5 —
// extensions/test/unit/shell-helpers.test.ts, PORTED SUBSET: the
// checkDangerousCommand block plus looksLikeCodePath coverage (the upstream
// file's semantic-miss / categorization tests belong to the steering layer and
// are not ported).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDangerousCommand, looksLikeCodePath } from "../lib/guards.js";

describe("checkDangerousCommand", () => {
  it("flags forced recursive delete of absolute paths", () => {
    assert.ok(checkDangerousCommand("rm -rf /etc"));
    assert.ok(checkDangerousCommand("rm -rf --no-preserve-root /"));
    assert.ok(checkDangerousCommand("rm -rf '/home/user'"));
    assert.equal(checkDangerousCommand("rm -rf -- /var/tmp/x"), "Forced recursive delete of an absolute path");
  });

  it("does not flag safe rm", () => {
    assert.equal(checkDangerousCommand("rm file.txt"), undefined);
    assert.equal(checkDangerousCommand("rm -rf ./build"), undefined); // relative, not absolute
    assert.equal(checkDangerousCommand("ls -la"), undefined);
  });

  it("requires BOTH -r and -f for the rm rule", () => {
    assert.equal(checkDangerousCommand("rm -r /etc"), undefined);
    assert.equal(checkDangerousCommand("rm -f /etc/hosts"), undefined);
    assert.ok(checkDangerousCommand("rm --recursive --force /etc"));
  });

  it("flags destructive dd writes to block devices", () => {
    assert.ok(checkDangerousCommand("dd if=/dev/zero of=/dev/sda bs=1M"));
    assert.ok(checkDangerousCommand("sudo dd if=img of='/dev/nvme0n1'"));
    assert.ok(checkDangerousCommand("dd of=/dev/disk2 if=x"));
  });

  it("does not flag benign dd or non-string input", () => {
    assert.equal(checkDangerousCommand("dd if=/dev/zero of=/tmp/file bs=1M"), undefined);
    assert.equal(checkDangerousCommand(undefined), undefined);
    assert.equal(checkDangerousCommand({ command: "rm -rf /" }), undefined);
  });
});

describe("looksLikeCodePath", () => {
  it("matches source-file extensions (case-insensitive, query/fragment stripped)", () => {
    assert.equal(looksLikeCodePath("src/app.ts"), true);
    assert.equal(looksLikeCodePath("src/app.PY"), true);
    assert.equal(looksLikeCodePath("src/app.py?x=1"), true);
    assert.equal(looksLikeCodePath("a/b/c.rs#L10"), true);
    assert.equal(looksLikeCodePath("main.go"), true);
  });

  it("does not match docs, configs, or extension-less paths", () => {
    assert.equal(looksLikeCodePath("README.md"), false);
    assert.equal(looksLikeCodePath("package.json"), false);
    assert.equal(looksLikeCodePath(".gitignore"), false);
    assert.equal(looksLikeCodePath("notes.txt"), false);
    assert.equal(looksLikeCodePath("src/dir"), false);
  });

  it("does not match non-string input", () => {
    assert.equal(looksLikeCodePath(undefined), false);
    assert.equal(looksLikeCodePath(42), false);
  });
});
