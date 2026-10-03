/**
 * Unit tests for pi-web format module.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeSnippet,
  truncateText,
  formatFirecrawlScrape,
  formatCrawl4aiResult,
  type SearchResultItem,
} from "../lib/format";

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

const OUTPUT_MAX_BYTES = 50 * 1024;
const OUTPUT_MAX_LINES = 2_000;

describe("sanitizeSnippet", () => {
  it("returns empty string for empty input", () => {
    assert.equal(sanitizeSnippet(), "");
    assert.equal(sanitizeSnippet(""), "");
  });

  it("strips HTML tags", () => {
    assert.equal(sanitizeSnippet("<b>hello</b> world"), "hello world");
  });

  it("decodes HTML entities", () => {
    assert.equal(sanitizeSnippet("foo &amp; bar"), "foo & bar");
    assert.equal(sanitizeSnippet("&lt;tag&gt;"), "<tag>");
    assert.equal(sanitizeSnippet("&quot;quoted&quot;"), '"quoted"');
    assert.equal(sanitizeSnippet("hello&nbsp;world"), "hello world");
  });

  it("decodes numeric HTML entities", () => {
    assert.equal(sanitizeSnippet("&#65;"), "A");
    assert.equal(sanitizeSnippet("&#x41;"), "A");
  });

  it("collapses whitespace", () => {
    assert.equal(sanitizeSnippet("hello   world"), "hello world");
    assert.equal(sanitizeSnippet("  hello  "), "hello");
  });
});

describe("truncateText", () => {
  it("returns short text as-is", () => {
    const text = "hello world";
    assert.equal(truncateText(text), text);
  });

  it("truncates by line count when exceeding OUTPUT_MAX_LINES", () => {
    const lines = Array.from({ length: OUTPUT_MAX_LINES + 10 }, (_, i) => `line ${i}`);
    const text = lines.join("\n");
    const result = truncateText(text);
    assert.ok(includes(result, "[Web output truncated to"));
    assert.ok((result.split("\n").length) < (OUTPUT_MAX_LINES + 15));
  });

  it("truncates by byte count when exceeding OUTPUT_MAX_BYTES", () => {
    const text = "x".repeat(OUTPUT_MAX_BYTES + 50000);
    const result = truncateText(text);
    assert.ok(includes(result, "[Web output truncated to"));
  });

  it("handles empty string", () => {
    assert.equal(truncateText(""), "");
  });
});

describe("formatFirecrawlScrape", () => {
  it("formats scrape data with metadata", () => {
    const data = {
      data: {
        metadata: {
          title: "Test Page",
          sourceURL: "https://example.com",
          statusCode: 200,
        },
        markdown: "# Hello\n\nThis is content.",
      },
    };
    const output = formatFirecrawlScrape(data);
    assert.ok(includes(output, "# Test Page"));
    assert.ok(includes(output, "Source: https://example.com"));
    assert.ok(includes(output, "Status: 200"));
    assert.ok(includes(output, "# Hello"));
    assert.ok(includes(output, "This is content."));
  });

  it("resolves data at top level when no nested data", () => {
    const data = {
      metadata: { title: "Direct" },
      markdown: "Content",
    };
    const output = formatFirecrawlScrape(data);
    assert.ok(includes(output, "# Direct"));
    assert.ok(includes(output, "Content"));
  });

  it("includes warning when present", () => {
    const data = { data: { markdown: "x" }, warning: "Rate limited" };
    const output = formatFirecrawlScrape(data);
    assert.ok(includes(output, "Warning: Rate limited"));
  });

  it("includes links when present", () => {
    const data = {
      data: {
        markdown: "body",
        links: ["https://a.com", "https://b.com"],
      },
    };
    const output = formatFirecrawlScrape(data);
    assert.ok(includes(output, "## Links"));
    assert.ok(includes(output, "- https://a.com"));
  });

  it("returns JSON stringify fallback for empty data", () => {
    const data = { foo: "bar" };
    const output = formatFirecrawlScrape(data);
    assert.ok(includes(output, "foo"));
  });
});

describe("formatCrawl4aiResult", () => {
  it("formats a single successful crawl result with markdown", () => {
    const data = {
      url: "https://example.com",
      success: true,
      status_code: 200,
      markdown: { fit_markdown: "# Hello\n\nWorld content." },
    };
    const output = formatCrawl4aiResult(data);
    assert.ok(includes(output, "URL: https://example.com"));
    assert.ok(includes(output, "Status: 200"));
    assert.ok(includes(output, "# Hello"));
  });

  it("shows error for failed crawl", () => {
    const data = {
      url: "https://example.com/404",
      success: false,
      error_message: "Not Found",
    };
    const output = formatCrawl4aiResult(data);
    assert.ok(includes(output, "Error: Not Found"));
    assert.ok(includes(output, "URL: https://example.com/404"));
  });

  it("formats multiple results from wrapped response", () => {
    const data = {
      results: [
        { url: "https://a.com", success: true, markdown: { raw_markdown: "Page A" } },
        { url: "https://b.com", success: true, markdown: { raw_markdown: "Page B" } },
      ],
    };
    const output = formatCrawl4aiResult(data);
    assert.ok(includes(output, "=== Result 1 ==="));
    assert.ok(includes(output, "=== Result 2 ==="));
    assert.ok(includes(output, "Page A"));
    assert.ok(includes(output, "Page B"));
  });

  it("falls back to raw_markdown when fit_markdown is absent", () => {
    const data = {
      url: "https://example.com",
      success: true,
      markdown: { raw_markdown: "Raw content only" },
    };
    const output = formatCrawl4aiResult(data);
    assert.ok(includes(output, "Raw content only"));
  });

  it("includes links when present", () => {
    const data = {
      url: "https://example.com",
      success: true,
      markdown: { fit_markdown: "body" },
      links: {
        internal: [{ href: "https://example.com/about" }],
        external: [{ href: "https://other.com" }],
      },
    };
    const output = formatCrawl4aiResult(data);
    assert.ok(includes(output, "Links"));
    assert.ok(includes(output, "https://example.com/about"));
  });

  it("returns fallback for empty data", () => {
    assert.equal(formatCrawl4aiResult({}), "(No data)");
  });
});


