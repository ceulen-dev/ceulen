/**
 * Unit tests for web_screenshot's tool-result shape.
 *
 * The screenshot must come back as a real inline image block (ImageContent)
 * so multimodal models can see it — not as base64 text. Regression guard for
 * pi-web 0.6.2; the HTTP layer is stubbed so no Crawl4AI daemon is needed.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import piWebExtension from "../index";

// The web settings layer reads the agent-dir settings.json — isolate the
// agent dir so a host `web` section never leaks into these tests.
process.env.PI_CODING_AGENT_DIR = "/nonexistent-pi-agent-dir-for-web-tests";

// chai-compat helpers (assert-based)
function includes(haystack: unknown, needle: unknown): boolean {
  if (typeof haystack === "string") return haystack.includes(String(needle));
  if (Array.isArray(haystack)) return (haystack as unknown[]).some((v) => {
    if (typeof v === "string" && typeof needle === "string") return v.includes(needle);
    if (v === needle) return true;
    // chai's to.include on an array does DEEP membership for objects.
    if (v && needle && typeof v === "object" && typeof needle === "object") {
      try { assert.deepStrictEqual(v, needle); return true; } catch { return false; }
    }
    return false;
  });
  // chai's to.include on an OBJECT target: needle's properties are a subset.
  if (haystack && typeof haystack === "object" && needle && typeof needle === "object") {
    return deepIncludes(haystack, needle as Record<string, unknown>);
  }
  return false;
}
function lengthOf(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") return v.length;
  if (v && typeof v === "object" && "length" in (v as Record<string, unknown>)) return Number((v as Record<string, unknown>).length);
  if (v && typeof v === "object" && "size" in (v as Record<string, unknown>)) return Number((v as Record<string, unknown>).size);
  throw new Error("lengthOf: value has no length/size");
}
/** Deep "includes" — every own key of `part` must exist on `obj` with a
 *  deep-equal value (chai's to.deep.include for object subjects). */
function deepIncludes(obj: unknown, part: Record<string, unknown>): boolean {
  if (Array.isArray(obj)) return includes(obj, part); // deep membership
  if (typeof obj !== "object" || obj === null) return false;
  return Object.entries(part).every(([k, v]) => {
    try { assert.deepStrictEqual((obj as Record<string, unknown>)[k], v); return true; } catch { return false; }
  });
}

function harness(): Record<string, any> {
  const tools: Record<string, any> = {};
  const pi: any = {
    registerTool(tool: any) { tools[tool.name] = tool; },
    on() {},
  };
  piWebExtension(pi);
  return tools;
}

const BASE_RESPONSE = { success: true, url: "https://example.com", mime: "image/png", size: 3 };

async function runScreenshot(payload: Record<string, unknown>) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({ ok: true, status: 200, text: async () => JSON.stringify(payload) })) as any;
  try {
    const tools = harness();
    return await tools.web_screenshot.execute(
      "t1", { url: "https://example.com" }, new AbortController().signal, undefined, {},
    );
  } finally {
    globalThis.fetch = orig;
  }
}

describe("web_screenshot tool result shape", () => {
  it("returns the PNG as an inline image block, not base64 text", async () => {
    const result = await runScreenshot({ ...BASE_RESPONSE, screenshot: "QUJD" });
    const image = result.content.find((c: any) => c.type === "image");
    assert.deepEqual(image, { type: "image", data: "QUJD", mimeType: "image/png" });
    assert.equal(result.content[0].type, "text");
    assert.ok(!includes(result.content[0].text, "base64"));
  });

  it("returns text-only when no screenshot comes back", async () => {
    const result = await runScreenshot({ ...BASE_RESPONSE });
    assert.equal(lengthOf(result.content), 1);
    assert.equal(result.content[0].type, "text");
  });

  it("falls back to image/png when the response has no mime", async () => {
    const result = await runScreenshot({ success: true, url: "https://example.com", screenshot: "QUJD" });
    const image = result.content.find((c: any) => c.type === "image");
    assert.deepEqual(image, { type: "image", data: "QUJD", mimeType: "image/png" });
  });

  it("surfaces daemon success:false as a loud error", async () => {
    let err: any = null;
    try {
      await runScreenshot({ success: false, error_message: "nav failed" });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.match(String(String(err?.message)), /nav failed/);
  });
});
