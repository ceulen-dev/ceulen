// content module tests — the fetchReadableContent SSRF guard (F5): local URLs
// refused before any fetch, redirect hops re-validated, public URLs unchanged.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fetchReadableContent } from "../lib/content";

const ORIGINAL_FETCH = globalThis.fetch;

/** Track every fetch call; redirect: "manual" is asserted on the request init. */
function installMockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("fetchReadableContent SSRF guard", () => {
  it("rejects http://169.254.169.254/ before any fetch (metadata endpoint)", async () => {
    const calls = installMockFetch(() => {
      throw new Error("fetch must never be called for a guarded host");
    });
    await assert.rejects(
      () => fetchReadableContent("http://169.254.169.254/latest/meta-data/"),
      /SSRF-guarded/,
    );
    assert.deepEqual(calls, []);
  });

  it("rejects http://127.0.0.1/ before any fetch (loopback)", async () => {
    const calls = installMockFetch(() => {
      throw new Error("fetch must never be called for a guarded host");
    });
    await assert.rejects(() => fetchReadableContent("http://127.0.0.1:8080/"), /SSRF-guarded/);
    assert.deepEqual(calls, []);
  });

  it("refuses a public→169.254.169.254 redirect hop", async () => {
    const calls = installMockFetch((url) => {
      if (url === "https://public.example/start") {
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      }
      throw new Error(`fetch must never follow to ${url}`);
    });
    await assert.rejects(() => fetchReadableContent("https://public.example/start"), /SSRF-guarded/);
    assert.deepEqual(calls, ["https://public.example/start"], "the redirect target is never fetched");
  });

  it("follows a public→public redirect and extracts the landed page", async () => {
    installMockFetch((url) => {
      if (url === "https://public.example/a") {
        return new Response(null, { status: 301, headers: { location: "https://public.example/b" } });
      }
      if (url === "https://public.example/b") {
        return new Response(
          "<html><head><title>Moved</title></head><body><main><h1>Landed</h1><p>" +
            "This public page carries plenty of readable content so the static extraction path returns it. ".repeat(2) +
            "</p></main></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const r = await fetchReadableContent("https://public.example/a");
    assert.equal(r.title, "Moved");
    assert.match(r.markdown, /Landed/);
  });

  it("still extracts a plain public URL (existing static path unchanged)", async () => {
    installMockFetch((url) => {
      if (url === "https://example.com/page") {
        return new Response(
          "<html><head><title>Plain</title></head><body><main><p>" +
            "Ordinary public content, well above the readability floor, extracted through the untouched static path. ".repeat(2) +
            "</p></main></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const r = await fetchReadableContent("https://example.com/page");
    assert.equal(r.title, "Plain");
  });
});
