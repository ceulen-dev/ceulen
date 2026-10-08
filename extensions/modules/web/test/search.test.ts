import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  searchWithDiagnostics,
  selectSearchBackendOrder,
  type SearchParams,
  type SearchResult,
} from "../lib/search";

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

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
  });
}

function installMockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

function restoreEnv(): void {
  process.env = { ...ORIGINAL_ENV };
}

describe("SearchParams and SearchResult types", () => {
  it("accept expected fields", () => {
    const params: SearchParams = { query: "test", backend: "auto", signal: new AbortController().signal };
    const result: SearchResult = { title: "T", url: "https://example.com", snippet: "S", age: "", content: "", backend: "brave" };
    assert.equal(params.backend, "auto");
    assert.equal(result.backend, "brave");
  });
});

describe("selectSearchBackendOrder", () => {
  it("selects Brave first for include_content", () => {
    assert.deepEqual(selectSearchBackendOrder({ query: "homelab ansible", include_content: true }), ["brave", "searxng", "firecrawl"]);
  });

  it("selects Brave first for site: and precision queries", () => {
    assert.deepEqual(selectSearchBackendOrder({ query: "site:docs.ansible.com podman quadlet" }), ["brave", "searxng", "firecrawl"]);
    assert.deepEqual(selectSearchBackendOrder({ query: '"exact phrase" release notes' }), ["brave", "searxng", "firecrawl"]);
  });

  it("keeps SearXNG first for broad discovery and explicit engines", () => {
    assert.deepEqual(selectSearchBackendOrder({ query: "homelab ansible ideas" }), ["searxng", "brave", "firecrawl"]);
    assert.deepEqual(selectSearchBackendOrder({ query: "docs api", engines: "google,github" }), ["searxng", "brave", "firecrawl"]);
  });

  it("honors explicit backend", () => {
    assert.deepEqual(selectSearchBackendOrder({ query: "test", backend: "firecrawl" }), ["firecrawl"]);
  });
});

describe("searchWithDiagnostics", () => {
  beforeEach(() => {
    restoreEnv();
    process.env.BRAVE_API_KEY = "test-brave-key";
    process.env.SEARXNG_BASE_URL = "http://searxng.test";
    process.env.FIRECRAWL_API_URL = "http://firecrawl.test/v2";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    restoreEnv();
  });

  it("uses Brave first for include_content and fetches inline content", async () => {
    const calls = installMockFetch((url) => {
      if (url.startsWith("https://api.search.brave.com/")) {
        return jsonResponse({ web: { results: [{ title: "Brave", url: "https://example.com/page", description: "Snippet" }] } });
      }
      if (url === "https://example.com/page") {
        return htmlResponse("<html><head><title>Page</title></head><body><main><h1>Page</h1><p>This is long enough readable content for the inline content fetch test.</p></main></body></html>");
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await searchWithDiagnostics({ query: "homelab ansible", include_content: true });
    assert.equal(result.selectedBackend, "brave");
    assert.equal(result.backendOrder[0], "brave");
    assert.ok(includes(result.results[0].content, "readable content"));
    assert.ok(includes(calls[0], "api.search.brave.com"));
  });

  it("uses SearXNG first for broad discovery", async () => {
    const calls = installMockFetch((url) => {
      if (url.startsWith("http://searxng.test/search")) {
        return jsonResponse({ results: [{ title: "SearXNG", url: "https://example.com", content: "Snippet" }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await searchWithDiagnostics({ query: "homelab ansible ideas" });
    assert.equal(result.selectedBackend, "searxng");
    assert.ok(deepIncludes(result.attempts, { backend: "searxng", status: "success", message: "Selected searxng", resultCount: 1 }));
    assert.ok(includes(calls[0], "searxng.test"));
  });

  it("forwards freshness pw/pm/py to SearXNG as time_range", async () => {
    const calls = installMockFetch((url) => {
      if (url.startsWith("http://searxng.test/search")) {
        return jsonResponse({ results: [{ title: "SearXNG", url: "https://example.com", content: "Snippet" }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await searchWithDiagnostics({ query: "homelab ansible ideas", freshness: "pw" });
    assert.equal(result.selectedBackend, "searxng");
    assert.ok(includes(calls[0], "time_range=pw"));

    // Explicit date ranges are Brave-only — no time_range on the SearXNG call.
    const calls2 = installMockFetch((url) => {
      if (url.startsWith("http://searxng.test/search")) {
        return jsonResponse({ results: [] });
      }
      if (url.startsWith("https://api.search.brave.com/")) {
        return jsonResponse({ web: { results: [] } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    await searchWithDiagnostics({ query: "homelab ansible ideas", freshness: "2026-01-01to2026-01-31" });
    assert.ok(!includes(calls2[0], "time_range="));
  });

  it("captures backend errors and falls through to Firecrawl last", async () => {
    installMockFetch((url) => {
      if (url.startsWith("http://searxng.test/search")) return jsonResponse({ results: [] });
      if (url.startsWith("https://api.search.brave.com/")) return jsonResponse({ error: "rate limited" }, 429);
      if (url.startsWith("http://firecrawl.test/v2/search")) {
        return jsonResponse({ data: { web: [{ title: "Fire", url: "https://fire.example", description: "Fallback" }] } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await searchWithDiagnostics({ query: "homelab ansible ideas" });
    assert.equal(result.selectedBackend, "firecrawl");
    assert.deepEqual(result.attempts.map((a) => a.backend), ["searxng", "brave", "firecrawl"]);
    assert.equal(result.attempts[1].status, "error");
    assert.ok(!includes(result.attempts[1].message, "test-brave-key"));
  });

  it("explicit backend tries only that backend", async () => {
    const calls = installMockFetch((url) => {
      if (url.startsWith("http://searxng.test/search")) return jsonResponse({ results: [] });
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await searchWithDiagnostics({ query: "nothing", backend: "searxng" });
    assert.deepEqual(result.results, []);
    assert.ok(deepIncludes(result.attempts, { backend: "searxng", status: "empty", message: "searxng returned 0 results", resultCount: 0 }));
    assert.equal(lengthOf(calls), 1);
  });

  it("auto + >=2 backends routes through the classifier when a model resolves", async () => {
    // A fake registry whose classify() always answers brave_first with high
    // confidence — the order flips to precision regardless of the heuristic.
    const registry = {
      findOfType: () => ({ id: "combo/jev", provider: "router" }),
      getModelsOfType: () => [{ id: "combo/jev", provider: "router" }],
      getAvailableOfType: async () => [{ id: "combo/jev", provider: "router" }],
      refresh: async () => {},
      classify: async () => ({
        stopReason: "stop",
        answers: {
          backend_preference: { choice: "brave_first", probabilities: { brave_first: 0.9, searxng_first: 0.1 }, confidence: 0.9 },
        },
      }),
    };
    const calls = installMockFetch((url) => {
      if (url.startsWith("https://api.search.brave.com/")) {
        return jsonResponse({ web: { results: [{ title: "Brave", url: "https://example.com", description: "S" }] } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    // A broad query the heuristic would send to searxng first (unique string:
    // the verdict LRU is keyed by query fingerprint and earlier tests run
    // the same broad query without a ctx, which caches the heuristic order).
    const result = await searchWithDiagnostics({ query: "homelab ansible ideas 2026", _ctx: { modelRegistry: registry } });
    assert.equal(result.router, "classifier:jev");
    assert.equal(result.backendOrder[0], "brave");
    assert.equal(result.selectedBackend, "brave");
    assert.ok(lengthOf(calls) >= 1);
  });

  it("classifier low confidence falls back to the heuristic", async () => {
    const registry = {
      findOfType: () => ({ id: "combo/jev", provider: "router" }),
      getModelsOfType: () => [{ id: "combo/jev", provider: "router" }],
      getAvailableOfType: async () => [{ id: "combo/jev", provider: "router" }],
      refresh: async () => {},
      classify: async () => ({
        stopReason: "stop",
        answers: { backend_preference: { choice: "searxng_first", probabilities: { searxng_first: 0.3, brave_first: 0.2 }, confidence: 0.3 } },
      }),
    };
    const calls = installMockFetch((url) => {
      if (url.startsWith("http://searxng.test/search")) {
        return jsonResponse({ results: [{ title: "SearXNG", url: "https://example.com", content: "Snippet" }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const result = await searchWithDiagnostics({ query: "homelab ansible ideas", _ctx: { modelRegistry: registry } });
    assert.equal(result.router, "heuristic", "0.3 confidence < 0.6 → heuristic");
    assert.equal(result.backendOrder[0], "searxng");
    assert.ok(includes(calls[0], "searxng.test"));
  });

  it("explicit backend/engines params report router: explicit and never ask Jev", async () => {
    let classifyCalls = 0;
    const registry = {
      findOfType: () => ({ id: "combo/jev", provider: "router" }),
      getAvailableOfType: async () => [{ id: "combo/jev", provider: "router" }],
      refresh: async () => {},
      classify: async () => { classifyCalls++; throw new Error("must not be called"); },
    };
    installMockFetch((url) => {
      if (url.startsWith("http://searxng.test/search")) {
        return jsonResponse({ results: [{ title: "SearXNG", url: "https://example.com", content: "Snippet" }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const explicit = await searchWithDiagnostics({ query: "homelab ansible", backend: "searxng", _ctx: { modelRegistry: registry } });
    assert.equal(explicit.router, "explicit");
    const engines = await searchWithDiagnostics({ query: "homelab ansible", engines: "google,github", _ctx: { modelRegistry: registry } });
    assert.equal(engines.router, "explicit");
    assert.equal(classifyCalls, 0);
  });

});
