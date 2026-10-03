/**
 * Unit tests for Gemini cookie auto-refresh (lib/gemini-auth.ts) and its
 * integration with lib/gemini.ts. No network — the rotate POST is injected.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __keepaliveDebug,
  clearCookieStore,
  cookieStoreSnapshot,
  defaultStorePath,
  ensureKeepalive,
  keepaliveOnce,
  loadCookieStore,
  refreshGeminiAuth,
  resolvePsidts,
  rotateCookies,
  saveCookieStore,
  stopKeepalive,
  defaultPost,
  type PostFn,
} from "../lib/gemini-auth";
import {
  describeGeminiError,
  withGeminiClient,
  __resetGeminiClientCache,
  type GeminiClientLike,
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

function tmpStore(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gemini-auth-test-")), "cookies.json");
}

function fakePost(
  res: { status: number; setCookie: string[] },
  capture?: { url?: string; opts?: { headers?: Record<string, string>; body?: string } },
): PostFn {
  return async (url, opts) => {
    if (capture) {
      capture.url = url;
      capture.opts = opts;
    }
    return res;
  };
}

const okPost = (ts: string, capture?: Parameters<typeof fakePost>[1]) => fakePost({ status: 200, setCookie: [`__Secure-1PSIDTS=${ts}; Path=/; Secure; HttpOnly`] }, capture);
const unauthorizedPost = () => fakePost({ status: 401, setCookie: [] });

const config = { psid: "psid-test", psidts: "env-ts", psidSource: "test", proxy: undefined };

describe("cookie store", () => {
  it("round-trips an entry and reports snapshot freshness", () => {
    const p = tmpStore();
    saveCookieStore({ psid: "a", psidts: "b", updatedAt: Date.now() }, p);
    assert.ok(deepIncludes(loadCookieStore(p), { psid: "a", psidts: "b" }));
    const snap = cookieStoreSnapshot(p);
    assert.equal(snap.present, true);
    assert.ok((snap.ageSeconds ?? 0) >= 0);
    fs.chmodSync(p, 0o600); // saveCookieStore must leave it 0600
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  });

  it("treats missing and corrupt files as absent, clear removes", () => {
    const p = tmpStore();
    assert.equal(loadCookieStore(p), null);
    fs.writeFileSync(p, "{not json");
    assert.equal(loadCookieStore(p), null);
    saveCookieStore({ psid: "a", psidts: "b", updatedAt: 1 }, p);
    clearCookieStore(p);
    assert.equal(loadCookieStore(p), null);
    assert.equal(cookieStoreSnapshot(p).present, false);
  });

  it("honors GEMINI_WEB_COOKIE_STORE for the default path", () => {
    const old = process.env.GEMINI_WEB_COOKIE_STORE;
    process.env.GEMINI_WEB_COOKIE_STORE = "/tmp/xyz/store.json";
    assert.equal(defaultStorePath(), "/tmp/xyz/store.json");
    if (old === undefined) delete process.env.GEMINI_WEB_COOKIE_STORE;
    else process.env.GEMINI_WEB_COOKIE_STORE = old;
  });

  // ceulen: the module reads process.env ONLY — .env file ingestion is the
  // bundle env.ts's job (agent-dir at import, trusted cwd at session_start).
  it("GEMINI_WEB_COOKIE_STORE follows process.env changes (no module-level caching)", () => {
    const old = process.env.GEMINI_WEB_COOKIE_STORE;
    process.env.GEMINI_WEB_COOKIE_STORE = "/tmp/xyz/store.json";
    assert.equal(defaultStorePath(), "/tmp/xyz/store.json");
    process.env.GEMINI_WEB_COOKIE_STORE = "/tmp/xyz/other.json";
    assert.equal(defaultStorePath(), "/tmp/xyz/other.json");
    if (old === undefined) delete process.env.GEMINI_WEB_COOKIE_STORE;
    else process.env.GEMINI_WEB_COOKIE_STORE = old;
  });
});

describe("resolvePsidts", () => {
  it("env (fresh paste) always wins over the store", () => {
    const p = tmpStore();
    saveCookieStore({ psid: "psid-test", psidts: "store-ts", updatedAt: 1 }, p);
    assert.equal(resolvePsidts("psid-test", "env-ts", p), "env-ts");
  });

  it("falls back to the store only when env has no TS", () => {
    const p = tmpStore();
    saveCookieStore({ psid: "psid-test", psidts: "store-ts", updatedAt: 1 }, p);
    assert.equal(resolvePsidts("psid-test", undefined, p), "store-ts");
  });

  it("falls back to env with no store, and passes through guest mode", () => {
    assert.equal(resolvePsidts("psid-test", "env-ts", tmpStore()), "env-ts");
    assert.equal(resolvePsidts(undefined, "env-ts", tmpStore()), "env-ts");
  });
});

describe("rotateCookies", () => {
  it("sends the documented request shape and parses the fresh 1PSIDTS", async () => {
    const capture: { url?: string; opts?: { headers?: Record<string, string>; body?: string } } = {};
    const r = await rotateCookies({ psid: "p1", psidts: "t1", post: okPost("fresh", capture) });
    assert.ok(deepIncludes(r, { ok: true, psidts: "fresh" }));
    assert.equal(capture.url, "https://accounts.google.com/RotateCookies");
    assert.equal(capture.opts!.body, '[000,"-0000000000000000000"]');
    assert.equal(capture.opts!.headers!["Content-Type"], "application/json");
    assert.equal(capture.opts!.headers!.Origin, "https://accounts.google.com");
    assert.ok(includes(capture.opts!.headers!["User-Agent"], "Chrome/145")); // non-browser UAs get 400
    assert.equal(capture.opts!.headers!.Cookie, "__Secure-1PSID=p1; __Secure-1PSIDTS=t1");
  });

  it("treats 400/401 as definitive but 200-no-TS and 5xx as non-stale", async () => {
    const r = await rotateCookies({ psid: "p1", post: okPost("f2") });
    assert.equal(r.ok, true);
    const u = await rotateCookies({ psid: "p1", post: unauthorizedPost() });
    assert.equal(u.ok, false);
    assert.equal(u.stale, true);
    assert.match(String(u.reason), /unauthorized/);
    const bad = await rotateCookies({ psid: "p1", post: fakePost({ status: 400, setCookie: [] }) });
    assert.equal(bad.ok, false);
    assert.equal(bad.stale, true);
    const none = await rotateCookies({ psid: "p1", post: fakePost({ status: 200, setCookie: ["NID=x; Path=/"] }) });
    assert.equal(none.ok, false);
    assert.equal(none.stale, undefined);
    const boom = await rotateCookies({ psid: "p1", post: fakePost({ status: 503, setCookie: [] }) });
    assert.equal(boom.ok, false);
    assert.equal(boom.stale, undefined);
    const forbidden = await rotateCookies({ psid: "p1", post: fakePost({ status: 403, setCookie: [] }) });
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.stale, undefined); // 403 = soft-block, not dead
  });

  it("marks transport errors as NOT stale", async () => {
    const r = await rotateCookies({ psid: "p1", post: async () => { throw new Error("ECONNRESET"); } });
    assert.equal(r.ok, false);
    assert.equal(r.stale, undefined);
  });
});

describe("refreshGeminiAuth", () => {
  it("persists the fresh 1PSIDTS on success", async () => {
    const p = tmpStore();
    const r = await refreshGeminiAuth(config, { post: okPost("fresh-ts"), storePath: p });
    assert.equal(r.ok, true);
    assert.ok(deepIncludes(loadCookieStore(p), { psid: "psid-test", psidts: "fresh-ts" }));
  });

  it("never destroys the store on rotation failures (400/401/offline/5xx/403)", async () => {
    const p = tmpStore();
    saveCookieStore({ psid: "psid-test", psidts: "old", updatedAt: 1 }, p);
    await refreshGeminiAuth(config, { post: unauthorizedPost(), storePath: p });
    assert.ok(deepIncludes(loadCookieStore(p), { psidts: "old" }));

    saveCookieStore({ psid: "psid-test", psidts: "old", updatedAt: 1 }, p);
    await refreshGeminiAuth(config, { post: async () => { throw new Error("offline"); }, storePath: p });
    assert.ok(deepIncludes(loadCookieStore(p), { psidts: "old" }));

    // transient 5xx must also keep the store (reviewer: stale is for definitive rejections only)
    saveCookieStore({ psid: "psid-test", psidts: "old", updatedAt: 1 }, p);
    await refreshGeminiAuth(config, { post: fakePost({ status: 503, setCookie: [] }), storePath: p });
    assert.ok(deepIncludes(loadCookieStore(p), { psidts: "old" }));

    // 403 is a soft-block — the newest TS must survive it
    saveCookieStore({ psid: "psid-test", psidts: "old", updatedAt: 1 }, p);
    await refreshGeminiAuth(config, { post: fakePost({ status: 403, setCookie: [] }), storePath: p });
    assert.ok(deepIncludes(loadCookieStore(p), { psidts: "old" }));
  });

  it("is a no-op without a psid", async () => {
    const r = await refreshGeminiAuth({ psid: undefined }, { storePath: tmpStore() });
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /not set/);
  });
});

describe("keepaliveOnce", () => {
  it("skips the network when the store is fresh", async () => {
    const p = tmpStore();
    saveCookieStore({ psid: "psid-test", psidts: "recent", updatedAt: Date.now() }, p);
    let called = 0;
    const post: PostFn = async () => {
      called++;
      return { status: 200, setCookie: [] };
    };
    assert.equal(await keepaliveOnce(config, { storePath: p, post }), true);
    assert.equal(called, 0);
  });

  it("rotates and persists when stale, fails but keeps the store when dead", async () => {
    const p = tmpStore();
    saveCookieStore({ psid: "psid-test", psidts: "old", updatedAt: 1 }, p);
    assert.equal(await keepaliveOnce(config, { storePath: p, post: okPost("new-ts") }), true);
    assert.ok(deepIncludes(loadCookieStore(p), { psidts: "new-ts" }));

    saveCookieStore({ psid: "psid-test", psidts: "old", updatedAt: 1 }, p);
    assert.equal(await keepaliveOnce(config, { storePath: p, post: unauthorizedPost() }), false);
    assert.ok(deepIncludes(loadCookieStore(p), { psidts: "old" }));
  });

  it("does not skip rotation for a fresh store belonging to a DIFFERENT psid", async () => {
    const p = tmpStore();
    saveCookieStore({ psid: "old-psid", psidts: "old-ts", updatedAt: Date.now() }, p);
    let called = 0;
    const post: PostFn = async () => {
      called++;
      return { status: 200, setCookie: ["__Secure-1PSIDTS=fresh-ts; Path=/"] };
    };
    assert.equal(await keepaliveOnce(config, { storePath: p, post }), true);
    assert.equal(called, 1);
    assert.ok(deepIncludes(loadCookieStore(p), { psid: "psid-test", psidts: "fresh-ts" }));
  });
});

describe("withGeminiClient auto-heal + passive persist", () => {
  const cfg = { ...config };

  beforeEach(() => {
    __resetGeminiClientCache();
  });

  it("on AuthError: rebuild-retries once (rotation is opt-in, not auto-invoked)", async () => {
    const p = tmpStore();
    const calls: GeminiClientLike[] = [];
    const factory = () => {
      const client: GeminiClientLike = {
        ask: async () => {
          if (calls.length === 1) {
            const e = new Error("Cookies invalid.");
            e.name = "AuthError";
            throw e;
          }
          return { text: "ok" };
        },
        research: async () => ({ text: "report" }),
      };
      calls.push(client);
      return client;
    };
    const result = await withGeminiClient(cfg, (c) => c.ask!("q"), factory, { storePath: p });
    assert.equal(result.text, "ok");
    assert.equal(lengthOf(calls), 2);
    assert.equal(loadCookieStore(p), null); // no rotation → no store write
  });

  it("on persistent AuthError: rebuilds once, propagates, and never destroys the store", async () => {
    const p = tmpStore();
    saveCookieStore({ psid: "psid-test", psidts: "old", updatedAt: 1 }, p);
    const calls = { n: 0 };
    const factory: Parameters<typeof withGeminiClient>[2] = () => {
      calls.n++;
      return {
        ask: async () => {
          const e = new Error("Cookies invalid.");
          e.name = "AuthError";
          throw e;
        },
        research: async () => ({ text: "report" }),
      };
    };
    let threw: unknown;
    try {
      await withGeminiClient(cfg, (c) => c.ask!("q"), factory, { rotatePost: unauthorizedPost(), storePath: p });
    } catch (e) {
      threw = e;
    }
    assert.equal((threw as Error).name, "AuthError");
    assert.equal(calls.n, 2);
    assert.ok(deepIncludes(loadCookieStore(p), { psid: "psid-test", psidts: "old" })); // store is never destroyed
  });

  it("persists a rotated 1PSIDTS absorbed from the client jar", async () => {
    const p = tmpStore();
    const client: GeminiClientLike = {
      ask: async () => ({ text: "ok" }),
      research: async () => ({ text: "report" }),
      cookies: { "__Secure-1PSIDTS": "jar-ts" },
    } as GeminiClientLike;
    await withGeminiClient(cfg, (c) => c.ask!("q"), () => client, { storePath: p });
    assert.ok(deepIncludes(loadCookieStore(p), { psid: "psid-test", psidts: "jar-ts" }));
  });

  it("never writes the store in guest mode", async () => {
    const p = tmpStore();
    const client: GeminiClientLike = {
      ask: async () => ({ text: "ok" }),
      research: async () => ({ text: "report" }),
      cookies: { "__Secure-1PSIDTS": "jar-ts" },
    } as GeminiClientLike;
    await withGeminiClient({ ...cfg, psid: undefined }, (c) => c.ask!("q"), () => client, { storePath: p });
    assert.equal(loadCookieStore(p), null);
  });

  it("store-write failure never fails the call (best-effort persist)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-auth-ro-"));
    fs.chmodSync(dir, 0o555);
    const client: GeminiClientLike = {
      ask: async () => ({ text: "ok" }),
      research: async () => ({ text: "report" }),
      cookies: { "__Secure-1PSIDTS": "jar-ts" },
    } as GeminiClientLike;
    try {
      const r = await withGeminiClient(cfg, (c) => c.ask!("q"), () => client, { storePath: path.join(dir, "cookies.json") });
      assert.equal(r.text, "ok");
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });
});

describe("describeGeminiError AuthError guidance", () => {
  it("points at the incognito re-paste and the keepalive store", () => {
    const e = new Error("Cookies invalid.");
    e.name = "AuthError";
    const msg = describeGeminiError(e);
    assert.match(String(msg), /incognito/);
    assert.match(String(msg), /daily browser/);
  });
});

describe("ensureKeepalive arming", () => {
  const OLD_KEEPALIVE = process.env.GEMINI_WEB_KEEPALIVE;
  const OLD_INTERVAL = process.env.GEMINI_WEB_ROTATE_INTERVAL_MS;

  afterEach(() => {
    stopKeepalive();
    if (OLD_KEEPALIVE === undefined) delete process.env.GEMINI_WEB_KEEPALIVE;
    else process.env.GEMINI_WEB_KEEPALIVE = OLD_KEEPALIVE;
    if (OLD_INTERVAL === undefined) delete process.env.GEMINI_WEB_ROTATE_INTERVAL_MS;
    else process.env.GEMINI_WEB_ROTATE_INTERVAL_MS = OLD_INTERVAL;
  });

  it("stays disarmed by default (rotation is opt-in)", () => {
    delete process.env.GEMINI_WEB_KEEPALIVE;
    delete process.env.GEMINI_WEB_ROTATE_INTERVAL_MS;
    ensureKeepalive(config);
    assert.equal(__keepaliveDebug().armed, false);
  });

  it("stays disarmed when GEMINI_WEB_KEEPALIVE=0", () => {
    process.env.GEMINI_WEB_KEEPALIVE = "0";
    ensureKeepalive(config);
    assert.equal(__keepaliveDebug().armed, false);
  });

  it("arms when GEMINI_WEB_KEEPALIVE=1: default 600s cadence, honors env interval, clamps below the floor", () => {
    process.env.GEMINI_WEB_KEEPALIVE = "1";
    delete process.env.GEMINI_WEB_ROTATE_INTERVAL_MS;
    ensureKeepalive(config);
    assert.equal(__keepaliveDebug().armed, true);
    assert.equal(__keepaliveDebug().intervalMs, 600_000);
    stopKeepalive();
    process.env.GEMINI_WEB_ROTATE_INTERVAL_MS = "120000";
    ensureKeepalive(config);
    assert.equal(__keepaliveDebug().intervalMs, 120_000);
    stopKeepalive();
    process.env.GEMINI_WEB_ROTATE_INTERVAL_MS = "5000";
    ensureKeepalive(config);
    assert.equal(__keepaliveDebug().intervalMs, 600_000);
  });

  it("re-arms when the psid changes", () => {
    process.env.GEMINI_WEB_KEEPALIVE = "1";
    ensureKeepalive(config);
    assert.equal(__keepaliveDebug().psid, "psid-test");
    ensureKeepalive({ ...config, psid: "psid-other" });
    assert.equal(__keepaliveDebug().psid, "psid-other");
  });

  it("tick passes cfg+hooks through (post called, store written)", async () => { // upstream mocha budget: 5000ms
    process.env.GEMINI_WEB_KEEPALIVE = "1";
    const p = tmpStore();
    let called = 0;
    const post: PostFn = async () => {
      called++;
      return { status: 200, setCookie: ["__Secure-1PSIDTS=tick-ts; Path=/"] };
    };
    ensureKeepalive(config, { post, storePath: p, intervalMs: 1000 });
    await new Promise((r) => setTimeout(r, 1300));
    stopKeepalive();
    assert.ok((called) >= (1));
    assert.ok(deepIncludes(loadCookieStore(p), { psidts: "tick-ts" }));
  });
});

describe('defaultPost (rotation transport)', () => {
  it('captures Set-Cookie from a redirect without following it', async () => { // upstream mocha budget: 5000ms
    const { createServer } = await import('node:http');
    let hits = 0;
    const server = createServer((req, res) => {
      hits++;
      res.writeHead(302, { 'set-cookie': ['__Secure-1PSIDTS=redirect-ts; Path=/'], location: '/should-not-follow' });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await defaultPost(`http://127.0.0.1:${port}/rotate`, {
        headers: { 'Content-Type': 'application/json' },
        body: '[000,"-0000000000000000000"]',
        timeoutMs: 2000,
      });
      assert.equal(res.status, 302); // redirect NOT followed
      assert.ok(includes(res.setCookie.join(' '), '__Secure-1PSIDTS=redirect-ts'));
      await new Promise((r2) => setTimeout(r2, 100));
      assert.equal(hits, 1); // exactly one request
    } finally {
      server.close();
    }
  });
});
