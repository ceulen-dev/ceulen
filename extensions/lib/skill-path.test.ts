// Windows regression: `new URL("../../../skills/", import.meta.url).pathname`
// yields "/C:/repo/skills/" — a leading slash before the drive letter — and
// fs.realpathSync then resolves it against the CURRENT drive, dying with
// `ENOENT ... lstat 'D:\C:'` at extension load. skillsRoot() must return a
// native path (fileURLToPath), i.e. never the drive-slash shape.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { skillsRoot } from "./skill-path.js";

describe("skillsRoot", () => {
  it("resolves the in-package skills/ dir on disk", () => {
    const root = skillsRoot();
    assert.ok(existsSync(root), `skills root exists: ${root}`);
    // realpathSync is the call that blew up on Windows — it must not throw.
    assert.equal(typeof realpathSync(root), "string");
  });

  it("never produces a drive-letter path with a leading slash", () => {
    assert.doesNotMatch(skillsRoot(), /^\/[A-Za-z]:\//);
  });

  it("joins to this package's own skill dirs", () => {
    for (const name of ["web", "munin", "a2a", "ponytail", "ux-design"]) {
      assert.ok(existsSync(join(skillsRoot(), name)), `skill dir exists: ${name}`);
    }
  });

  it("is absolute (never resolved against cwd)", () => {
    assert.ok(isAbsolute(skillsRoot()));
  });
});
