// Ported from pi-model-tools extensions/test/unit/model-detection.test.ts
// (the detectFamily + isRecord halves; the env-helper tests moved to
// settings.test.ts, since those knobs are `steering` settings rows now).
import assert from "node:assert";
import { describe, it } from "node:test";
import { detectFamily, isRecord } from "../lib/family.js";

describe("detectFamily", () => {
  const cases: Array<{ id: string; provider?: string; expected: string | null; label: string }> = [
    // DeepSeek V4
    { id: "deepseek-v4-flash", provider: "opencode-go", expected: "deepseek-v4", label: "deepseek-v4-flash" },
    { id: "deepseek-v4-pro", provider: "opencode-go", expected: "deepseek-v4", label: "deepseek-v4-pro" },
    { id: "ocg/deepseek-v4-flash", provider: "9router", expected: "deepseek-v4", label: "9router deepseek" },
    { id: "deepseek-flash", provider: "deepseek", expected: "deepseek-v4", label: "deepseek-flash (V4.1 canonical)" },
    { id: "ds/deepseek-flash", provider: "router", expected: "deepseek-v4", label: "router deepseek-flash" },
    { id: "deepseek-v4.1-flash", provider: "opencode-go", expected: "deepseek-v4", label: "deepseek-v4.1-flash" },
    // GLM family
    { id: "glm-5.2", provider: "zai-coding-cn", expected: "glm", label: "glm-5.2" },
    { id: "glm-4.7", provider: "zai", expected: "glm", label: "glm-4.7" },
    { id: "z-ai/glm-5.2", provider: "openrouter", expected: "glm", label: "openrouter glm" },
    { id: "glm-5-turbo", provider: "zai", expected: "glm", label: "glm-5-turbo" },
    // Non-matching
    { id: "claude-opus-4.8", provider: "anthropic", expected: null, label: "claude" },
    { id: "gpt-5.5", provider: "openai", expected: null, label: "gpt" },
    { id: "deepseek-v3", provider: "deepseek", expected: null, label: "deepseek-v3 (not v4)" },
    { id: "deepseek-chat", provider: "deepseek", expected: null, label: "deepseek-chat (not v4)" },
    { id: "deepseek-r1", provider: "openrouter", expected: null, label: "deepseek-r1 (not v4)" },
  ];
  for (const { id, provider, expected, label } of cases) {
    it(`detects ${label} as ${expected}`, () => {
      assert.strictEqual(detectFamily({ id, provider }), expected);
    });
  }
  it("returns null for empty/undefined", () => {
    assert.strictEqual(detectFamily(undefined), null);
    assert.strictEqual(detectFamily({}), null);
  });
});

describe("isRecord", () => {
  it("returns true for plain objects", () => { assert.strictEqual(isRecord({}), true); assert.strictEqual(isRecord({ a: 1 }), true); });
  it("returns false for null, arrays, primitives", () => { assert.strictEqual(isRecord(null), false); assert.strictEqual(isRecord([]), false); assert.strictEqual(isRecord("x"), false); });
});
