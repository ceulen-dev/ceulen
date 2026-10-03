/**
 * Unit tests for web_crawl light-mode poll loop deadline handling.
 *
 * The loop must honor timeout_ms (stop polling + report incomplete state)
 * instead of always running its full 60×2s iteration cap.
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("web_crawl light-mode poll loop", () => {
  const ORIGINAL_FETCH = globalThis.fetch;
  const SAVED_URL = process.env.FIRECRAWL_API_URL;
  const SAVED_KEY = process.env.FIRECRAWL_API_KEY;

  beforeEach(() => {
    process.env.FIRECRAWL_API_URL = "http://firecrawl.test/v2";
    process.env.FIRECRAWL_API_KEY = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (SAVED_URL === undefined) delete process.env.FIRECRAWL_API_URL;
    else process.env.FIRECRAWL_API_URL = SAVED_URL;
    if (SAVED_KEY === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = SAVED_KEY;
  });

  it("stops polling at timeout_ms and returns an honest incomplete-state note", async () => {
    let getCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/crawl")) return jsonResponse({ id: "c1" });
      if (url.endsWith("/crawl/c1")) {
        getCalls += 1;
        return jsonResponse({ status: "scraping" });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const tools = harness();
    const res = await tools.web_crawl.execute(
      "t1",
      { url: "https://example.com", mode: "light", poll: true, timeout_ms: 1000 },
      new AbortController().signal,
      undefined,
      {},
    );
    // Exited on the deadline after one poll, not the 60-iteration cap.
    assert.equal(getCalls, 1);
    assert.ok(includes(res.content[0].text, "timeout_ms"));
    assert.ok(includes(res.content[0].text, "scraping"));
    assert.ok(includes(res.content[0].text, "incomplete"));
  });

  it("still returns immediately when the crawl is already completed (no timeout_ms)", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/crawl")) return jsonResponse({ id: "c2" });
      if (url.endsWith("/crawl/c2")) {
        return jsonResponse({ status: "completed", data: [{ markdown: "# Page", url: "https://example.com" }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const tools = harness();
    const res = await tools.web_crawl.execute(
      "t2",
      { url: "https://example.com", mode: "light", poll: true },
      new AbortController().signal,
      undefined,
      {},
    );
    assert.ok(!includes(res.content[0].text, "incomplete"));
    assert.ok(includes(res.content[0].text, "Page"));
  });
});
