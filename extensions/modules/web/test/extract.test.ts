import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  extractWithDiagnostics,
  type ExtractMode,
  type ExtractParams,
  type ExtractResult,
} from "../lib/extract";
import { resetAgyInstalledCache } from "../lib/agy";

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

const _require = createRequire(import.meta.url);

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

describe("ExtractParams and ExtractResult types", () => {
  it("accept expected fields", () => {
    const modes: ExtractMode[] = ["auto", "static", "dynamic", "full", "agy"];
    const params: ExtractParams = { url: "https://example.com", mode: modes[0], wait_for: 1000, mobile: true };
    const result: ExtractResult = { title: "Title", markdown: "Content", backend: "static", structured: { ok: true } };
    assert.equal(params.mode, "auto");
    assert.deepEqual(result.structured, { ok: true });
  });
});

describe("extractWithDiagnostics", () => {
  beforeEach(() => {
    restoreEnv();
    process.env.FIRECRAWL_API_URL = "http://firecrawl.test/v2";
    process.env.CRAWL4AI_API_URL = "http://crawl4ai.test";
    resetAgyInstalledCache(); // agy install cache is module-level — must reset between tests
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    restoreEnv();
    resetAgyInstalledCache();
  });

  it("uses static extraction when it returns useful content", async () => {
    installMockFetch((url) => {
      if (url === "https://example.com/static") {
        return htmlResponse("<html><head><title>Static</title></head><body><main><h1>Static</h1><p>This static article has enough readable text to pass the useful-content threshold in auto mode without falling back.</p><p>Additional words make it reliably longer than the minimum threshold.</p></main></body></html>");
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const diagnostics = await extractWithDiagnostics({ url: "https://example.com/static" });
    assert.equal(diagnostics.selectedMode, "static");
    assert.strictEqual(diagnostics.fallbackUsed, false);
    assert.ok(includes(diagnostics.result.markdown, "static article"));
  });

  it("passes raw text/plain and JSON bodies through without Readability", async () => {
    installMockFetch((url) => {
      if (url === "https://raw.test/code.js") {
        return new Response("// A module used by tests.\n" + "export function boot() { return 42; }\n".repeat(6), { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      if (url === "https://raw.test/data.json") {
        return new Response(JSON.stringify({ name: "pi-fff", stars: 99, description: "Fuzzy file and content search for Pi, well over the useful-content threshold for extraction." }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://raw.test/page.html") {
        return htmlResponse("<html><head><title>Page</title></head><body><main><h1>Page</h1><p>This ordinary web page has plenty of readable content to pass the useful-content threshold in auto mode. Additional sentences ensure the extracted text is long enough to be considered useful by the extraction pipeline.</p><p>More filler keeps the article comfortably above the minimum length so the static path succeeds without falling through.</p></main></body></html>");
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const textDiag = await extractWithDiagnostics({ url: "https://raw.test/code.js" });
    assert.equal(textDiag.selectedMode, "static");
    assert.ok(includes(textDiag.result.markdown, "return 42;"));

    const jsonDiag = await extractWithDiagnostics({ url: "https://raw.test/data.json" });
    assert.ok(includes(jsonDiag.result.markdown, '"stars":99'));
    assert.equal(jsonDiag.result.markdown.indexOf("```json"), 0);

    // text/html must still go through Readability → markdown, not raw source
    const htmlDiag = await extractWithDiagnostics({ url: "https://raw.test/page.html" });
    assert.ok(!includes(htmlDiag.result.markdown, "<main>"));
    assert.equal(htmlDiag.result.title, "Page");
    assert.ok(includes(htmlDiag.result.markdown, "plenty of readable content"));
  });

  it("falls through from short static content to dynamic extraction", async () => {
    const calls = installMockFetch((url) => {
      if (url === "https://example.com/short") return htmlResponse("<html><body><main>short</main></body></html>");
      if (url === "http://firecrawl.test/v2/scrape") {
        return jsonResponse({ data: { markdown: "# Dynamic\n\nDynamic content from Firecrawl after static extraction was too short.", metadata: { title: "Dynamic", sourceURL: "https://example.com/short" } } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const diagnostics = await extractWithDiagnostics({ url: "https://example.com/short" });
    assert.equal(diagnostics.selectedMode, "dynamic");
    assert.strictEqual(diagnostics.fallbackUsed, true);
    assert.deepEqual(diagnostics.attempts.map((a) => a.mode), ["static", "dynamic"]);
    assert.ok(includes(diagnostics.result.markdown, "fell back to Firecrawl"));
    assert.deepEqual(calls, ["https://example.com/short", "http://firecrawl.test/v2/scrape"]);
  });

  it("explicit static mode does not fall through", async () => {
    installMockFetch((url) => {
      if (url === "https://example.com/short") return htmlResponse("<html><body><main>short</main></body></html>");
      throw new Error(`unexpected fetch ${url}`);
    });

    const diagnostics = await extractWithDiagnostics({ url: "https://example.com/short", mode: "static" });
    assert.equal(diagnostics.selectedMode, "static");
    assert.ok(includes(diagnostics.result.markdown, "short"));
  });

  it("dynamic mode includes structured JSON output when present", async () => {
    installMockFetch((url, init) => {
      if (url === "http://firecrawl.test/v2/scrape") {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.formats, ["markdown", "json"]);
        assert.deepEqual(body.jsonOptions, { prompt: "Extract title" });
        return jsonResponse({ data: { markdown: "# Dynamic\n\nBody", json: { title: "Structured" }, metadata: { title: "Dynamic" } } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const diagnostics = await extractWithDiagnostics({ url: "https://example.com/dynamic", mode: "dynamic", prompt: "Extract title" });
    assert.deepEqual(diagnostics.result.structured, { title: "Structured" });
    assert.ok(includes(diagnostics.result.markdown, "## Structured extraction"));
  });

  it("falls through to full mode when static and dynamic fail", async () => {
    installMockFetch((url) => {
      if (url === "https://example.com/full") return htmlResponse("<html><body><main>tiny</main></body></html>");
      if (url === "http://firecrawl.test/v2/scrape") return jsonResponse({ error: "blocked" }, 500);
      if (url === "http://crawl4ai.test/md") return jsonResponse({ success: true, markdown: "# Full\n\nCrawl4AI markdown content" });
      throw new Error(`unexpected fetch ${url}`);
    });

    const diagnostics = await extractWithDiagnostics({ url: "https://example.com/full" });
    assert.equal(diagnostics.selectedMode, "full");
    assert.deepEqual(diagnostics.attempts.map((a) => a.mode), ["static", "dynamic", "full"]);
    assert.ok(includes(diagnostics.result.markdown, "Crawl4AI"));
  });

  it("falls through to agy mode when static/dynamic/full all fail and agy is installed", async () => {
    const cp = _require("node:child_process");
    const origSpawn = cp.spawn;
    const origSpawnSync = cp.spawnSync;
    cp.spawnSync = () => ({ status: 0 }); // agy installed
    cp.spawn = function () {
      const { EventEmitter } = _require("events");
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 123;
      process.nextTick(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ response: "# agy content\n\nFetched via read_url" })));
        child.emit("close", 0, null);
      });
      return child;
    } as any;

    installMockFetch((url) => {
      if (url === "https://example.com/blocked") return htmlResponse("<html><body><main>tiny</main></body></html>");
      if (url === "http://firecrawl.test/v2/scrape") return jsonResponse({ error: "blocked" }, 500);
      if (url === "http://crawl4ai.test/md") return jsonResponse({ error: "blocked" }, 500);
      throw new Error(`unexpected fetch ${url}`);
    });

    try {
      const diagnostics = await extractWithDiagnostics({ url: "https://example.com/blocked" });
      assert.equal(diagnostics.selectedMode, "agy");
      assert.deepEqual(diagnostics.attempts.map((a) => a.mode), ["static", "dynamic", "full", "agy"]);
      assert.ok(includes(diagnostics.result.markdown, "agy (model-backed browser)"));
      assert.ok(includes(diagnostics.result.markdown, "Fetched via read_url"));
    } finally {
      cp.spawn = origSpawn;
      cp.spawnSync = origSpawnSync;
    }
  });

  it("skips agy in auto chain when agy is not installed", async () => {
    const cp = _require("node:child_process");
    const origSpawnSync = cp.spawnSync;
    cp.spawnSync = () => ({ status: 1 }); // agy not installed

    installMockFetch((url) => {
      if (url === "https://example.com/skipagy") return htmlResponse("<html><body><main>tiny</main></body></html>");
      if (url === "http://firecrawl.test/v2/scrape") return jsonResponse({ error: "blocked" }, 500);
      if (url === "http://crawl4ai.test/md") return jsonResponse({ success: true, markdown: "# Full\n\nCrawl4AI fallback content" });
      throw new Error(`unexpected fetch ${url}`);
    });

    try {
      const diagnostics = await extractWithDiagnostics({ url: "https://example.com/skipagy" });
      assert.equal(diagnostics.selectedMode, "full");
      assert.deepEqual(diagnostics.attempts.map((a) => a.mode), ["static", "dynamic", "full"]);
    } finally {
      cp.spawnSync = origSpawnSync;
    }
  });

  it("explicit agy mode calls agy directly", async () => {
    const cp = _require("node:child_process");
    const origSpawn = cp.spawn;
    const origSpawnSync = cp.spawnSync;
    cp.spawnSync = () => ({ status: 0 });
    let capturedArgs: string[] | null = null;
    cp.spawn = function (_cmd: string, args: string[]) {
      capturedArgs = args;
      const { EventEmitter } = _require("events");
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 123;
      process.nextTick(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ response: "# Direct agy\n\ncontent" })));
        child.emit("close", 0, null);
      });
      return child;
    } as any;

    try {
      const diagnostics = await extractWithDiagnostics({ url: "https://example.com/direct", mode: "agy" });
      assert.equal(diagnostics.selectedMode, "agy");
      assert.deepEqual(diagnostics.attempts.map((a) => a.mode), ["agy"]);
      assert.notStrictEqual(capturedArgs, null);
      assert.ok(!includes(capturedArgs!.join(" "), "--dangerously-skip-permissions"));
      assert.ok(includes(capturedArgs!.join(" "), "read_url"));
      assert.ok(includes(diagnostics.result.markdown, "Direct agy"));
    } finally {
      cp.spawn = origSpawn;
      cp.spawnSync = origSpawnSync;
    }
  });

  it("agy structured extraction populates structured field and strips fenced JSON", async () => {
    const cp = _require("node:child_process");
    const origSpawn = cp.spawn;
    const origSpawnSync = cp.spawnSync;
    cp.spawnSync = () => ({ status: 0 });
    cp.spawn = function () {
      const { EventEmitter } = _require("events");
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 123;
      process.nextTick(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ response: '```json\n{"title": "Moby", "first": "sentence"}\n```\n' })));
        child.emit("close", 0, null);
      });
      return child;
    } as any;

    try {
      const diagnostics = await extractWithDiagnostics({
        url: "https://example.com/structured",
        mode: "agy",
        schema: { title: "string" },
      });
      assert.deepEqual(diagnostics.result.structured, { title: "Moby", first: "sentence" });
      // raw model fenced block stripped; only the renderer's own block remains
      assert.equal(diagnostics.result.markdown.split("```json").length - 1, 1);
      assert.ok(includes(diagnostics.result.markdown, "## Structured extraction"));
    } finally {
      cp.spawn = origSpawn;
      cp.spawnSync = origSpawnSync;
    }
  });

  it("agy prompt-only (no schema) also populates structured field", async () => {
    const cp = _require("node:child_process");
    const origSpawn = cp.spawn;
    const origSpawnSync = cp.spawnSync;
    cp.spawnSync = () => ({ status: 0 });
    cp.spawn = function () {
      const { EventEmitter } = _require("events");
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 123;
      process.nextTick(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ response: '```json\n{"title": "Moby"}\n```\n' })));
        child.emit("close", 0, null);
      });
      return child;
    } as any;

    try {
      const diagnostics = await extractWithDiagnostics({
        url: "https://example.com/promptonly",
        mode: "agy",
        prompt: "Extract the title",
      });
      assert.deepEqual(diagnostics.result.structured, { title: "Moby" });
    } finally {
      cp.spawn = origSpawn;
      cp.spawnSync = origSpawnSync;
    }
  });

  it("agy structured JSON is not duplicated in the body when only JSON is returned", async () => {
    const cp = _require("node:child_process");
    const origSpawn = cp.spawn;
    const origSpawnSync = cp.spawnSync;
    cp.spawnSync = () => ({ status: 0 });
    cp.spawn = function () {
      const { EventEmitter } = _require("events");
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 123;
      process.nextTick(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ response: '```json\n{"title": "Moby"}\n```\n' })));
        child.emit("close", 0, null);
      });
      return child;
    } as any;

    try {
      const diagnostics = await extractWithDiagnostics({
        url: "https://example.com/jsononly",
        mode: "agy",
        schema: { title: "string" },
      });
      const md = diagnostics.result.markdown;
      const sectionIdx = md.indexOf("## Structured extraction");
      const body = md.slice(0, sectionIdx);
      // JSON appears only once total (in the structured section), not verbatim in body
      assert.ok(!includes(body, '"title"'));
      assert.ok(includes(body, "Structured extraction only"));
      assert.equal(md.split('"title"').length - 1, 1);
    } finally {
      cp.spawn = origSpawn;
      cp.spawnSync = origSpawnSync;
    }
  });

  it("agy bare-JSON output (no fence) still populates structured field", async () => {
    const cp = _require("node:child_process");
    const origSpawn = cp.spawn;
    const origSpawnSync = cp.spawnSync;
    cp.spawnSync = () => ({ status: 0 });
    cp.spawn = function () {
      const { EventEmitter } = _require("events");
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 123;
      process.nextTick(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ response: '{"title": "Moby"}\n' })));
        child.emit("close", 0, null);
      });
      return child;
    } as any;

    try {
      const diagnostics = await extractWithDiagnostics({
        url: "https://example.com/barejson",
        mode: "agy",
        schema: { title: "string" },
      });
      assert.deepEqual(diagnostics.result.structured, { title: "Moby" });
      assert.ok(includes(diagnostics.result.markdown, "Structured extraction only"));
    } finally {
      cp.spawn = origSpawn;
      cp.spawnSync = origSpawnSync;
    }
  });

});
