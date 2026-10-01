import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalEntry, exactModel, modelRef } from "../lib/model-picker.js";

const models = [
  { provider: "zai-coding-cn", id: "glm-5.3" },
  { provider: "opencode-go", id: "deepseek-v4-pro" },
  { provider: "openrouter", id: "nvidia/nemotron:free" },
  { provider: "router", id: "zai/glm-5.3-flash" },
] as never[];

describe("model-picker thinking suffix", () => {
  it("exactModel matches refs with a trailing :level", () => {
    assert.equal(exactModel(models, "zai-coding-cn/glm-5.3:high") !== undefined, true);
    assert.equal(modelRef(exactModel(models, "zai-coding-cn/glm-5.3:high")!), "zai-coding-cn/glm-5.3");
  });

  it("exactModel keeps openrouter :free ids matchable", () => {
    assert.equal(modelRef(exactModel(models, "openrouter/nvidia/nemotron:free")!), "openrouter/nvidia/nemotron:free");
  });

  it("exactModel resolves router refs whose id contains slashes (first-slash provider split)", () => {
    assert.equal(modelRef(exactModel(models, "router/zai/glm-5.3-flash:max")!), "router/zai/glm-5.3-flash");
  });

  it("canonicalEntry re-attaches a valid level; unknown entries return as typed", () => {
    assert.equal(canonicalEntry(models, "glm-5.3:high"), "zai-coding-cn/glm-5.3:high");
    assert.equal(canonicalEntry(models, "glm-5.3"), "zai-coding-cn/glm-5.3");
    assert.equal(canonicalEntry(models, "openrouter/nvidia/nemotron:free"), "openrouter/nvidia/nemotron:free");
    assert.equal(canonicalEntry(models, "no-such/model:high"), "no-such/model:high");
  });
});
