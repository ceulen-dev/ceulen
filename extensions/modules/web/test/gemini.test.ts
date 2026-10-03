/**
 * Unit tests for the Gemini web research wrapper (lib/gemini.ts).
 * No network — the gemini-reverse client is injected via a fake factory.
 */

type DrHttp = (url: string, opts?: { headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; buf: Buffer }>;
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyHeaderCapArgs,
  extractSources,
  loadGeminiWebConfig,
  loadDefaultFactory,
  injectGeminiRequestTweaks,
  describeGeminiError,
  geminiAsk,
  geminiResearch,
  withGeminiClient,
  __resetGeminiClientCache,
  type GeminiClientLike,
  type GeminiClientFactory,
} from "../lib/gemini";

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

const here = path.dirname(fileURLToPath(import.meta.url));

function fakeClient(overrides: Partial<GeminiClientLike> = {}): GeminiClientLike {
  return {
    ask: async () => ({ text: "ok" }),
    research: async () => ({ text: "report" }),
    ...overrides,
  };
}

function factoryFor(client: GeminiClientLike, calls?: { n: number }): GeminiClientFactory {
  return () => {
    if (calls) calls.n++;
    return client;
  };
}

describe("extractSources", () => {
  it("extracts markdown links first, then bare URLs", () => {
    const text = "See [docs](https://example.com/a) and https://example.org/b directly.";
    assert.deepEqual(extractSources(text), ["https://example.com/a", "https://example.org/b"]);
  });

  it("dedupes and strips trailing punctuation", () => {
    const text = "[a](https://x.com/p) — visit https://x.com/p. Also (https://y.com/q).";
    assert.deepEqual(extractSources(text), ["https://x.com/p", "https://y.com/q"]);
  });

  it("caps the list", () => {
    const text = Array.from({ length: 40 }, (_, i) => `[s](${`https://s.io/${i}`})`).join(" ");
    assert.equal(lengthOf(extractSources(text, 30)), 30);
  });

  it("returns empty for empty text", () => {
    assert.deepEqual(extractSources(""), []);
    assert.deepEqual(extractSources("no urls here"), []);
  });
});

describe("loadGeminiWebConfig", () => {
  const OLD_PSID = process.env.GEMINI_WEB_SECURE_1PSID;
  const OLD_PROXY = process.env.GEMINI_WEB_PROXY;
  const OLD_DIR = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (OLD_PSID !== undefined) process.env.GEMINI_WEB_SECURE_1PSID = OLD_PSID;
    else delete process.env.GEMINI_WEB_SECURE_1PSID;
    if (OLD_PROXY !== undefined) process.env.GEMINI_WEB_PROXY = OLD_PROXY;
    else delete process.env.GEMINI_WEB_PROXY;
    if (OLD_DIR !== undefined) process.env.PI_CODING_AGENT_DIR = OLD_DIR;
    else delete process.env.PI_CODING_AGENT_DIR;
  });

  it("reads env vars (process.env first)", () => {
    process.env.GEMINI_WEB_SECURE_1PSID = "psid-test";
    process.env.GEMINI_WEB_PROXY = "http://127.0.0.1:8080";
    const cfg = loadGeminiWebConfig("/tmp", false);
    assert.equal(cfg.psid, "psid-test");
    assert.equal(cfg.proxy, "http://127.0.0.1:8080");
    assert.equal(cfg.psidSource, "env");
  });

  it("reports not set when absent (guest mode) — isolated from the host's pi config", () => {
    delete process.env.GEMINI_WEB_SECURE_1PSID;
    delete process.env.GEMINI_WEB_PROXY;
    process.env.PI_CODING_AGENT_DIR = "/nonexistent-pi-agent-dir"; // shield from the host's ~/.pi/agent/.env.local
    const cfg = loadGeminiWebConfig("/nonexistent-dir-for-tests", false);
    assert.equal(cfg.psid, undefined);
    assert.equal(cfg.psidSource, "not set");
  });
});

describe("raceGuard abort safety", () => {
  it("pre-aborted signal: AbortError now, later underlying rejection is swallowed (no unhandledRejection)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      // Non-AuthError rejection keeps withGeminiClient on its single-attempt
      // path (no rotation) — the abort semantics under test are orthogonal.
      const client: GeminiClientLike = {
        ask: async () => {
          throw new Error("boom");
        },
        research: async () => ({ text: "r" }),
      };
      const p = geminiAsk("q", {
        config: { psid: "p", psidSource: "t" },
        signal: AbortSignal.abort(),
        factory: () => client,
      });
      await p.then(
        () => {
          throw new Error("should have rejected");
        },
        (e) => assert.equal((e as Error).name, "AbortError"),
      );
      // give the unguarded-rejection a chance to fire if the fix regressed
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(lengthOf(unhandled), 0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("describeGeminiError", () => {
  it("maps upstream error classes by name and constructor", () => {
    assert.ok(includes(describeGeminiError({ name: "AuthError" }), "session expired"));
    class UsageLimitExceeded extends Error {}
    assert.ok(includes(describeGeminiError(new UsageLimitExceeded("x")), "usage limit"));
    assert.ok(includes(describeGeminiError({ name: "TemporarilyBlocked" }), "GEMINI_WEB_PROXY"));
    assert.equal(describeGeminiError(new Error("boom")), "Gemini web error: boom");
  });

  it("maps unknown API errors (e.g. 1184) to the hedged reliability hint", () => {
    const msg = describeGeminiError(new Error("Unknown API error: 1184"));
    assert.ok(includes(msg, "1184"));
    assert.ok(includes(msg, "unreliable"));
    assert.ok(includes(msg, "free-tier"));
    assert.ok(includes(msg, "Pro/Ultra-gated"));
    assert.ok(includes(msg, "unverified"));
  });
});

describe("loadDefaultFactory 1PSIDTS injection", () => {
  it("injects __Secure-1PSIDTS into the client cookie jar pre-init", async () => {
    const f = await loadDefaultFactory();
    const c = await f({ secure_1psid: "psid", secure_1psidts: "ts-value" });
    assert.equal((c as unknown as { cookies: Record<string, string> }).cookies["__Secure-1PSIDTS"], "ts-value");
  });
});

describe("applyHeaderCapArgs (http.request 3-arg safety)", () => {
  const CAP = 256 * 1024;

  it("mutates the options-object form in place", () => {
    const opts = { hostname: "gemini.google.com", path: "/x" };
    const cb = () => {};
    const out = applyHeaderCapArgs([opts, { method: "POST" }, cb]);
    assert.equal((opts as { maxHeaderSize?: number }).maxHeaderSize, CAP);
    assert.equal(out[0], opts);
  });

  it("3-arg (url, options, cb): merges into the follow-on options and keeps the url", () => {
    const follow: Record<string, unknown> = { method: "POST" };
    const cb = () => {};
    const url = "https://gemini.google.com/app";
    const out = applyHeaderCapArgs([url, follow, cb]);
    assert.equal(follow.maxHeaderSize, CAP);
    assert.ok(includes((follow.headers as Record<string, unknown>)["user-agent"], "Chrome/145"));
    assert.equal(out[0], url);
    assert.equal(out[1], follow);
    assert.equal(out[2], cb);
  });

  it("2-arg (url, cb): replaces the url with options carrying the cap", () => {
    const cb = () => {};
    const out = applyHeaderCapArgs(["https://gemini.google.com/app", cb]);
    assert.equal((out[0] as { hostname?: string }).hostname, "gemini.google.com");
    assert.equal((out[0] as { maxHeaderSize?: number }).maxHeaderSize, CAP);
    assert.equal(out[1], cb);
  });

  it("non-gemini hosts pass through untouched", () => {
    const opts = { hostname: "example.com" };
    const out = applyHeaderCapArgs([opts, () => {}]);
    assert.ok(((opts) as any)?.hasOwnProperty?.("maxHeaderSize") !== true);
    assert.equal(out[0], opts);
  });
});

describe("injectGeminiRequestTweaks (header cap + browser UA for privileged surfaces)", () => {
  const CAP = 256 * 1024;

  it("injects the cap for gemini.google.com in all three http.request input forms", () => {
    for (const input of [
      "https://gemini.google.com/app",
      new URL("https://gemini.google.com/app"),
      { hostname: "gemini.google.com", path: "/app" },
    ]) {
      const out = injectGeminiRequestTweaks(input);
      assert.equal(typeof out, "object", String(input));
      assert.equal(out!.maxHeaderSize, CAP);
      assert.equal(out!.hostname, "gemini.google.com");
    }
  });

  it("adds browser UA + client hints to gemini.google.com requests", () => {
    const opts = { hostname: "gemini.google.com", path: "/app" } as Record<string, unknown>;
    injectGeminiRequestTweaks(opts);
    const headers = opts.headers as Record<string, unknown>;
    assert.ok(includes(headers["user-agent"], "Chrome/145"));
    assert.equal(typeof headers["sec-ch-ua"], 'string');
    assert.equal(headers["sec-fetch-site"], "same-origin");
    assert.equal(typeof headers["accept-language"], 'string');
  });

  it("replaces a non-browser UA; never clobbers other existing headers (any case)", () => {
    const opts = {
      hostname: "gemini.google.com",
      headers: { "User-Agent": "axios/1.20.0", "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
    };
    injectGeminiRequestTweaks(opts);
    const headers = opts.headers as Record<string, unknown>;
    assert.equal(headers["User-Agent"], undefined); // mixed-case key removed — no duplicate UA headers
    assert.ok(includes(headers["user-agent"], "Chrome/145")); // axios default replaced
    assert.equal(headers["content-type"], "application/x-www-form-urlencoded;charset=utf-8");
    // absent keys still land
    assert.equal(headers["sec-fetch-mode"], "cors");
  });

  it("leaves an existing browser UA untouched", () => {
    const opts = { hostname: "gemini.google.com", headers: { "user-agent": "Mozilla/5.0 Chrome/145.0.0.0 mine" } };
    injectGeminiRequestTweaks(opts);
    assert.equal((opts.headers as Record<string, unknown>)["user-agent"], "Mozilla/5.0 Chrome/145.0.0.0 mine");
  });

  it("passes through non-gemini hosts untouched", () => {
    const opts = { hostname: "example.com", path: "/" };
    assert.strictEqual(injectGeminiRequestTweaks(opts), null);
    assert.ok(((opts) as any)?.hasOwnProperty?.("maxHeaderSize") !== true);
    assert.ok(((opts) as any)?.hasOwnProperty?.("headers") !== true);
  });

  it("preserves a pre-set maxHeaderSize", () => {
    const opts = { hostname: "gemini.google.com", maxHeaderSize: 1024 };
    assert.strictEqual(injectGeminiRequestTweaks(opts), null);
    assert.equal(opts.maxHeaderSize, 1024);
  });

  it("rejects non-object non-string input", () => {
    assert.strictEqual(injectGeminiRequestTweaks(undefined), null);
    assert.strictEqual(injectGeminiRequestTweaks(42), null);
  });

  it("parses the host from string/URL forms with ports and paths intact", () => {
    const out = injectGeminiRequestTweaks("https://gemini.google.com:443/app?x=1");
    assert.equal(out!.path, "/app?x=1");
    assert.equal(out!.maxHeaderSize, CAP);
  });
});

describe("loadDefaultFactory (real gemini-reverse import path)", () => {
  // Constructor is offline (init is lazy per call) — no network in unit tests.
  it("resolves the Gemini constructor across CJS interop and constructs a client", async () => {
    const make = await loadDefaultFactory();
    assert.equal(typeof make, 'function');
    const client = await make({});
    assert.equal(typeof client.ask, 'function');
    assert.equal(typeof client.research, 'function');
  });
});

describe("geminiAsk", () => {
  it("returns text + sources and passes temporary/model", async () => {
    __resetGeminiClientCache();
    let captured: Record<string, unknown> | undefined;
    const client = fakeClient({
      ask: async (_q: string, opts?: Record<string, unknown>) => {
        captured = opts;
        return { text: "Answer with [src](https://a.example/x).", model: "gemini-3-flash" };
      },
    });
    const res = await geminiAsk("q", { config: { psid: "p", psidSource: "test" }, model: "gemini-3-flash", factory: factoryFor(client) });
    assert.ok(includes(res.text, "Answer with"));
    assert.equal(res.model, "gemini-3-flash");
    assert.strictEqual(res.guest, false);
    assert.deepEqual(res.sources, ["https://a.example/x"]);
    assert.equal(captured?.temporary, true);
    assert.equal(captured?.model, "gemini-3-flash");
  });

  it("flags guest mode when no cookie", async () => {
    __resetGeminiClientCache();
    const res = await geminiAsk("q", { config: { psidSource: "not set" }, factory: factoryFor(fakeClient()) });
    assert.strictEqual(res.guest, true);
  });

  it("falls back to candidates[0].text when the getter is absent", async () => {
    __resetGeminiClientCache();
    const client = fakeClient({ ask: async () => ({ candidates: [{ text: "from candidate" }] }) });
    const res = await geminiAsk("q", { config: { psid: "p", psidSource: "test" }, factory: factoryFor(client) });
    assert.equal(res.text, "from candidate");
  });
});

describe("geminiResearch", () => {
  it("runs the pure-Node DR cycle and returns title/text/sources", async () => {
    __resetGeminiClientCache();
    const planBuf = fs.readFileSync(path.join(here, "fixtures", "dr-plan.bin"));
    const reportJson = JSON.stringify([null, [["rc_x", ["Report body citing [s](https://r.example/1) — " + "padding ".repeat(30) + " End of report."]]]]);
    const reportBuf = Buffer.from(")]}'\n\n" + (Buffer.byteLength(reportJson) + 1) + "\n" + reportJson + "\n");
    let turns = 0;
    const drHttp: DrHttp = async (url: string) => {
      if (url.startsWith("https://gemini.google.com/app")) {
        return { status: 200, headers: { get: () => null }, buf: Buffer.from('<html>"SNlM0e":"TOK","cfb2h":"b1","FdrFJe":"7"</html>') };
      }
      if (url.includes("StreamGenerate")) {
        turns++;
        return { status: 200, headers: { get: () => null }, buf: planBuf };
      }
      return { status: 200, headers: { get: () => null }, buf: reportBuf };
    };
    const res = await geminiResearch("q", { config: { psid: "p", psidSource: "test" }, timeoutMs: 5000, drHttp });
    assert.equal(res.title, "JPEG Compression Research Plan");
    assert.equal(res.eta, null);
    assert.deepEqual(res.sources, ["https://r.example/1"]);
    assert.equal(turns, 2); // plan + confirm turns
  });

  it("refuses research in guest mode with a setup message", async () => {
    try {
      await geminiResearch("q", { config: { psidSource: "not set" }, factory: factoryFor(fakeClient()) });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(includes((err as Error).message, "GEMINI_WEB_SECURE_1PSID"));
    }
  });
});

describe("abort + timeout guarding", () => {
  it("ask rejects with AbortError when the signal is already aborted (no poll awaited)", async () => {
    __resetGeminiClientCache();
    const controller = new AbortController();
    controller.abort();
    const never = fakeClient({ ask: () => new Promise(() => {}) });
    try {
      await geminiAsk("q", { config: { psid: "p", psidSource: "test" }, signal: controller.signal, factory: factoryFor(never) });
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal((err as Error).name, "AbortError");
    }
  });

  it("research rejects with AbortError on a pre-aborted signal without real network", async () => {
    __resetGeminiClientCache();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const offlineHttp: DrHttp = () => {
      calls++;
      return new Promise(() => {}); // never resolves — any call proves the transport is stubbed, not defaultHttp
    };
    try {
      await geminiResearch("q", { config: { psid: "p", psidSource: "test" }, signal: controller.signal, drHttp: offlineHttp });
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal((err as Error).name, "AbortError");
    }
    assert.equal(calls, 1); // init attempted on the stub — no real https.request fired
  });

  it("ask enforces timeout_ms (TimeoutError) when the client never resolves", async () => {
    __resetGeminiClientCache();
    const never = fakeClient({ ask: () => new Promise(() => {}) });
    try {
      await geminiAsk("q", { config: { psid: "p", psidSource: "test" }, timeoutMs: 20, factory: factoryFor(never) });
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal((err as Error).name, "TimeoutError");
      assert.ok(includes((err as Error).message, "timed out after 20ms"));
    }
  });

  it("describeGeminiError passes abort/timeout messages through unprefixed", () => {
    const e = new Error("web_research ask aborted");
    e.name = "AbortError";
    assert.equal(describeGeminiError(e), "web_research ask aborted");
  });
});

describe("withGeminiClient auth retry", () => {
  it("re-creates the client once on AuthError and succeeds", async () => {
    __resetGeminiClientCache();
    let attempts = 0;
    const client = fakeClient({
      ask: async () => {
        attempts++;
        if (attempts === 1) {
          const e = new Error("Cookies invalid.");
          e.name = "AuthError";
          throw e;
        }
        return { text: "recovered" };
      },
    });
    const calls = { n: 0 };
    const auth = {
      rotatePost: async () => ({ status: 200, setCookie: ["__Secure-1PSIDTS=rotated; Path=/"] }),
      storePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gemini-test-")), "cookies.json"),
    };
    const res = await withGeminiClient({ psid: "p", psidSource: "test" }, (c) => c.ask("q"), factoryFor(client, calls), auth);
    assert.equal((res as { text?: string }).text, "recovered");
    assert.equal(calls.n, 2);
  });

  it("does not retry non-auth errors", async () => {
    __resetGeminiClientCache();
    const calls = { n: 0 };
    const client = fakeClient({ ask: async () => { throw new Error("boom"); } });
    try {
      await withGeminiClient({ psid: "p2", psidSource: "test" }, (c) => c.ask("q"), factoryFor(client, calls));
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal((err as Error).message, "boom");
    }
    assert.equal(calls.n, 1);
  });
});
