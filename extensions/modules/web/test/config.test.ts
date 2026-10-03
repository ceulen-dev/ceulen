/**
 * Unit tests for pi-web config module.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  findEnvValue,
  normalizeSearxngBaseUrl,
  normalizeFirecrawlBaseUrl,
  normalizeCrawl4aiApiUrl,
  loadCrawl4aiConfig,
  DEFAULT_SEARXNG_BASE_URL,
  DEFAULT_CRAWL4AI_API_URL,
  HOSTED_FIRECRAWL_BASE_URL,
} from "../lib/config";

// The web settings layer reads the agent-dir settings.json — isolate it so a
// host `web` section (real timeouts/keys) never leaks into these unit tests.
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

describe("normalizeSearxngBaseUrl", () => {
  it("returns default when nothing provided", () => {
    assert.equal(normalizeSearxngBaseUrl(), DEFAULT_SEARXNG_BASE_URL);
  });

  it("preserves full URL with scheme", () => {
    assert.equal(normalizeSearxngBaseUrl("https://search.example.com"), 
      "https://search.example.com",
    );
  });

  it("adds http for localhost", () => {
    assert.equal(normalizeSearxngBaseUrl("localhost:8888"), 
      "http://localhost:8888",
    );
  });

  it("adds http for private IP", () => {
    assert.equal(normalizeSearxngBaseUrl("192.168.1.1:8888"), 
      "http://192.168.1.1:8888",
    );
  });

  it("adds https for public hostname", () => {
    assert.equal(normalizeSearxngBaseUrl("search.example.com"), 
      "https://search.example.com",
    );
  });

  it("removes trailing slashes", () => {
    assert.equal(normalizeSearxngBaseUrl("http://localhost:8888/"), 
      "http://localhost:8888",
    );
  });
});

describe("normalizeFirecrawlBaseUrl", () => {
  it("returns hosted default when nothing provided", () => {
    assert.equal(normalizeFirecrawlBaseUrl(), HOSTED_FIRECRAWL_BASE_URL);
  });

  it("appends /v2 if no version segment", () => {
    assert.equal(normalizeFirecrawlBaseUrl("http://localhost:3002"), "http://localhost:3002/v2");
  });

  it("preserves existing version segment", () => {
    assert.equal(normalizeFirecrawlBaseUrl("http://localhost:3002/v1"), "http://localhost:3002/v1");
  });

  it("removes trailing slash before appending version", () => {
    assert.equal(normalizeFirecrawlBaseUrl("http://localhost:3002/"), "http://localhost:3002/v2");
  });
});

describe("findEnvValue", () => {
  it("reads from process.env first", () => {
    process.env.TEST_PI_WEB_VAR = "from_process";
    try {
      const result = findEnvValue("TEST_PI_WEB_VAR", "/tmp", false);
      assert.equal(result.value, "from_process");
      assert.equal(result.source, "env");
    } finally {
      delete process.env.TEST_PI_WEB_VAR;
    }
  });

  it("returns undefined when not found", () => {
    const result = findEnvValue("THIS_VAR_DOES_NOT_EXIST_12345", "/tmp", false);
    assert.equal(result.value, undefined);
    assert.equal(result.source, "");
  });
});

describe("normalizeCrawl4aiApiUrl", () => {
  it("returns default when nothing provided", () => {
    assert.equal(normalizeCrawl4aiApiUrl(), DEFAULT_CRAWL4AI_API_URL);
  });

  it("preserves full URL with scheme", () => {
    assert.equal(normalizeCrawl4aiApiUrl("https://crawl.example.com"), 
      "https://crawl.example.com",
    );
  });

  it("adds http for private IP", () => {
    assert.equal(normalizeCrawl4aiApiUrl("172.30.55.22:11235"), 
      "http://172.30.55.22:11235",
    );
  });

  it("adds https for public hostname", () => {
    assert.equal(normalizeCrawl4aiApiUrl("crawl.example.com"), 
      "https://crawl.example.com",
    );
  });

  it("removes trailing slashes", () => {
    assert.equal(normalizeCrawl4aiApiUrl("http://localhost:11235/"), 
      "http://localhost:11235",
    );
  });

  it("does not append /v2 like Firecrawl", () => {
    assert.equal(normalizeCrawl4aiApiUrl("http://localhost:11235"), 
      "http://localhost:11235",
    );
  });
});

describe("loadCrawl4aiConfig", () => {
  it("returns default config from defaults", () => {
    // Hermetic: findEnvValue reads process.env AND piConfigDirs() (~/.pi/agent/.env)
    // even with includeCwd=false, so point PI_CODING_AGENT_DIR at an empty dir
    // and clear the ambient var — the default-assertion must not inherit either.
    const _require = createRequire(import.meta.url);
    const { mkdtempSync } = _require("node:fs");
    const { tmpdir } = _require("node:os");
    const { join } = _require("node:path");
    const emptyDir = mkdtempSync(join(tmpdir(), "pi-web-cfg-"));
    const savedDir = process.env.PI_CODING_AGENT_DIR;
    const savedUrl = process.env.CRAWL4AI_API_URL;
    delete process.env.CRAWL4AI_API_URL;
    process.env.PI_CODING_AGENT_DIR = emptyDir;
    try {
      const config = loadCrawl4aiConfig({}, "/tmp", false);
      assert.equal(config.baseUrl, DEFAULT_CRAWL4AI_API_URL);
      assert.equal(config.timeoutMs, 60000);
    } finally {
      if (savedDir !== undefined) process.env.PI_CODING_AGENT_DIR = savedDir;
      else delete process.env.PI_CODING_AGENT_DIR;
      if (savedUrl !== undefined) process.env.CRAWL4AI_API_URL = savedUrl;
    }
  });

  it("accepts explicit API URL from params", () => {
    const config = loadCrawl4aiConfig(
      { crawl4ai_api_url: "http://custom:12345" },
      "/tmp",
      false,
    );
    assert.equal(config.baseUrl, "http://custom:12345");
  });

  it("accepts explicit API token from params", () => {
    const config = loadCrawl4aiConfig(
      { crawl4ai_api_token: "my-token" },
      "/tmp",
      false,
    );
    assert.equal(config.apiToken, "my-token");
  });

  it("reads timeout from params", () => {
    const config = loadCrawl4aiConfig({ timeout_ms: 30000 }, "/tmp", false);
    assert.equal(config.timeoutMs, 30000);
  });

  it("throws on invalid timeout", () => {
    assert.throws(() => loadCrawl4aiConfig({ timeout_ms: 500 }, "/tmp", false));
  });
});
