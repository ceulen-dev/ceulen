/**
 * Unit tests for pi-web Crawl4AI client.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../lib/retry";

describe("HttpError", () => {
  it("formats error message with status and text", () => {
    const err = new HttpError(401, "Unauthorized", '{"detail":"bad token"}');
    assert.equal(err.status, 401);
    assert.ok(includes(err.message, "HTTP 401: Unauthorized"));
    assert.ok(includes(err.message, '{"detail":"bad token"}'));
  });

  it("handles empty response text", () => {
    const err = new HttpError(500, "Internal Server Error", "");
    assert.equal(err.status, 500);
    assert.equal(err.message, "HTTP 500: Internal Server Error");
  });

  it("is instance of Error", () => {
    const err = new HttpError(403, "Forbidden", "rate limit");
    assert.ok(err instanceof Error);
  });
});

// ---------------------------------------------------------------------------
// Config + format integration: verify imported functions exist with correct sigs
// ---------------------------------------------------------------------------

import type { Crawl4aiConfig } from "../lib/config";

describe("Crawl4aiConfig interface", () => {
  it("has expected shape", () => {
    const config: Crawl4aiConfig = {
      baseUrl: "http://localhost:11235",
      apiToken: "token123",
      timeoutMs: 30000,
    };
    assert.equal(config.baseUrl, "http://localhost:11235");
    assert.equal(config.apiToken, "token123");
    assert.equal(config.timeoutMs, 30000);
  });
});

// ---------------------------------------------------------------------------
// Verify client exports exist
// ---------------------------------------------------------------------------

import {
  fetchCrawl4aiMarkdown,
  fetchCrawl4aiCrawl,
  fetchCrawl4aiScreenshot,
  fetchCrawl4aiPdf,
  fetchCrawl4aiHealth,
  crawl4aiRequest,
} from "../lib/crawl4ai";

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

describe("Crawl4AI client exports", () => {
  it("exports all expected functions", () => {
    assert.equal(typeof fetchCrawl4aiMarkdown, 'function');
    assert.equal(typeof fetchCrawl4aiCrawl, 'function');
    assert.equal(typeof fetchCrawl4aiScreenshot, 'function');
    assert.equal(typeof fetchCrawl4aiPdf, 'function');
    assert.equal(typeof fetchCrawl4aiHealth, 'function');
    assert.equal(typeof crawl4aiRequest, 'function');
  });
});
