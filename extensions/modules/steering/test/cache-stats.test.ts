// turn_end cache-stats guard (ported from pi-model-tools
// extensions/test/unit/cache-stats.test.ts): usage fields that are missing,
// undefined, or NaN must fall back to 0 — never poison the session sums or the
// hit-rate display.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createFakePi, isolateAgentDir } from "./harness.js";

let restoreAgentDir: () => void;
before(() => { restoreAgentDir = isolateAgentDir("ceulen-steering-cache-").restore; });
after(() => { restoreAgentDir(); });

function makeHarness() {
  const h = createFakePi(["bash", "read", "edit", "str_replace_editor"]);
  const ctx = () => h.ctx("glm-5.2");
  const fire = (name: string, event: any) => h.fire(name, event, ctx());
  const status = () => h.status(ctx());
  return { fire, status };
}

describe("turn_end cache stats", () => {
  it("missing usage fields fall back to 0 (counts as a miss turn)", () => {
    const h = makeHarness();
    h.fire("session_start", {});
    h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", usage: { input: 100 } }, toolResults: [] });
    const text = h.status();
    assert.ok(text.includes("Input: 100 · cached: 0 · written: 0"), `missing fields → zeros, got: ${text.split("Prompt cache")[1]}`);
    assert.ok(text.includes("0 hit turns · 1 miss turns"), "no cacheRead → miss turn");
  });

  it("NaN usage fields fall back to 0 (no NaN poisoning)", () => {
    const h = makeHarness();
    h.fire("session_start", {});
    h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", usage: { input: 50, cacheRead: NaN, cacheWrite: undefined } }, toolResults: [] });
    h.fire("turn_end", { turnIndex: 1, message: { role: "assistant", usage: { input: NaN, cacheRead: 80, cacheWrite: "7" as unknown as number } }, toolResults: [] });
    const text = h.status();
    const cacheBlock = text.split("**Prompt cache (this session):**")[1] ?? "";
    assert.ok(cacheBlock.length > 0, "cache block still shown (input > 0 survives the guard)");
    assert.ok(!cacheBlock.includes("NaN"), `no NaN in status, got: ${cacheBlock}`);
    assert.ok(cacheBlock.includes("Input: 50 · cached: 80 · written: 0"), `NaN fields contribute 0, got: ${cacheBlock}`);
    assert.ok(cacheBlock.includes("1 hit turns · 1 miss turns"), "NaN cacheRead counts as miss, real cacheRead as hit");
  });
});
