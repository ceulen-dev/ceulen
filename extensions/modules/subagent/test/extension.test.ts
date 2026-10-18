// Regression guard for the review-skill registration (reviewer finding,
// munin extension.test.ts harness pattern): a typo'd path.join segment or a
// dropped handler must fail here instead of shipping silently — pi only
// surfaces a bad skill path as a runtime warning.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import subagentExtension from "../index.ts";

describe("review skill registration", () => {
  it("registers the review skill via resources_discover", () => {
    const discover: Function[] = [];
    const pi: any = {
      registerTool() {},
      registerCommand() {},
      on(name: string, handler: Function) { if (name === "resources_discover") discover.push(handler); },
    };
    // ESM: __dirname exists only inside pi's extension loading context; the
    // factory body reads it (bundledAgentsDir), so supply the real dir.
    (globalThis as any).__dirname = fileURLToPath(new URL("../", import.meta.url));
    subagentExtension(pi);
    assert.equal(discover.length, 1);
    const result = discover[0]!() as { skillPaths: string[] };
    assert.equal(result.skillPaths.length, 1);
    assert.match(result.skillPaths[0]!, /review$/);
    assert.ok(existsSync(join(result.skillPaths[0]!, "SKILL.md")), "SKILL.md exists in the contributed dir");
  });
});
