/**
 * Unit tests for the pure-Node Deep Research client (lib/gemini-dr.ts).
 * The plan/confirm fixtures are REAL captured wire responses (2026-09-14,
 * live session) — no network; the transport is injected.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractChatIds,
  extractCookieJar,
  extractPlanTitle,
  frameStrings,
  geminiDeepResearch,
  parseFrames,
  type DrHttp,
} from "../lib/gemini-dr";
import { abortableSleep } from "../lib/retry";

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
const fixture = (name: string): Buffer => fs.readFileSync(path.join(here, "fixtures", name));

describe("parseFrames (byte-exact, len includes trailing newline)", () => {
  it("parses the captured plan-turn response", () => {
    const frames = parseFrames(fixture("dr-plan.bin"));
    assert.equal(frames.length, 9);
    assert.ok(includes(frames[0], "c_10950ff6b1b0ebc1"));
  });

  it("returns no frames for bodies without the stream header", () => {
    assert.deepEqual(parseFrames(Buffer.from("garbage")), []);
  });
});

describe("frameStrings / extractChatIds / extractPlanTitle", () => {
  it("recurses into escaped inner-JSON payloads of the real plan fixture", () => {
    const frames = parseFrames(fixture("dr-plan.bin"));
    const strings = frameStrings(frames);
    const ids = extractChatIds(strings);
    assert.equal(ids.cid, "c_10950ff6b1b0ebc1");
    assert.equal(ids.rid, "r_b1a8e63da21ae244");
    assert.equal(extractPlanTitle(parseFrames(fixture("dr-plan.bin"))), "JPEG Compression Research Plan");
  });

  it("extracts chat ids from the real confirm fixture", () => {
    const strings = frameStrings(parseFrames(fixture("dr-confirm.bin")));
    const ids = extractChatIds(strings);
    assert.equal(ids.cid, "c_10950ff6b1b0ebc1");
    assert.equal(ids.rid, "r_8d0d706f1f6d605a");
  });
});

describe("geminiDeepResearch (injected transport, fixture-driven cycle)", () => {
  const REPORT_TEXT =
    "Report: The JPEG standard emerged from 1986 onwards, finalized in 1992 as ISO/IEC 10918. " +
    "Its lossy DCT pipeline traded imperceptible detail for ~10:1 compression, and it became the " +
    "dominant image format of the web era. Further reading: https://example.com/jpeg-history";

  function fixtureHttp(): { http: DrHttp; calls: Array<{ url: string; body?: string }> } {
    const calls: Array<{ url: string; body?: string }> = [];
    const http: DrHttp = async (url, opts) => {
      calls.push({ url, body: opts.body });
      if (url.startsWith("https://gemini.google.com/app")) {
        return {
          status: 200,
          headers: { get: () => null, "set-cookie": ["NID=test; Path=/"] },
          buf: Buffer.from(')]}\'\n<html>"SNlM0e":"TOKEN123","cfb2h":"boq_test_build","FdrFJe":"12345"</html>'),
        };
      }
      if (url.includes("StreamGenerate")) {
        const turn = calls.filter((c) => c.url.includes("StreamGenerate")).length;
        return { status: 200, headers: { get: () => null }, buf: turn === 1 ? fixture("dr-plan.bin") : fixture("dr-confirm.bin") };
      }
      // batchexecute poll: first poll echoes the plan transcript (must be
      // skipped, not returned as the report), second returns the report
      const polls = calls.filter((c) => c.url.includes("batchexecute")).length;
      if (polls === 1) {
        const planTranscript = frameStrings(parseFrames(fixture("dr-plan.bin"))).filter((s) => s.length > 200)[0];
        const staleJson = JSON.stringify([null, [["rc_old", [planTranscript]]]]);
        return { status: 200, headers: { get: () => null }, buf: Buffer.from(")]}'\n\n" + (Buffer.byteLength(staleJson) + 1) + "\n" + staleJson + "\n") };
      }
      const reportJson = JSON.stringify([null, [["rc_test", [REPORT_TEXT]]]]);
      return { status: 200, headers: { get: () => null }, buf: Buffer.from(")]}'\n\n" + (Buffer.byteLength(reportJson) + 1) + "\n" + reportJson + "\n") };
    };
    return { http, calls };
  }

  it("runs plan → confirm → poll and extracts the report", async () => { // upstream mocha budget: 30_000ms
    const { http, calls } = fixtureHttp();
    const r = await geminiDeepResearch({
      cookie: { psid: "psid-test", psidts: "ts-test" },
      query: "history of JPEG compression",
      timeoutMs: 30_000,
      http,
    });
    assert.equal(r.title, "JPEG Compression Research Plan");
    assert.ok(includes(r.text, "JPEG standard emerged"));
    assert.deepEqual(r.sources, ["https://example.com/jpeg-history"]);
    assert.equal(r.partial, undefined);
    // plan turn and confirm turn both carried the deep-research flags
    const posts = calls.filter((c) => c.url.includes("StreamGenerate"));
    assert.equal(lengthOf(posts), 2);
    const planInner = JSON.parse(JSON.parse(new URLSearchParams(posts[0].body ?? "").get("f.req") ?? "[]")[1]);
    assert.equal(planInner[49], 1);
    assert.deepEqual(planInner[54], [[[[[1]]]]]);
    const confirmInner = JSON.parse(JSON.parse(new URLSearchParams(posts[1].body ?? "").get("f.req") ?? "[]")[1]);
    assert.deepEqual(confirmInner[2], ["c_10950ff6b1b0ebc1", "r_b1a8e63da21ae244"]); // confirm continues the same chat
  });

  it("reports a partial result when the report never arrives before the timeout", async () => { // upstream mocha budget: 20_000ms
    const { http } = fixtureHttp();
    const failing = http;
    const http2: DrHttp = async (url, opts) => {
      if (url.includes("batchexecute")) {
        // never any report
        return { status: 200, headers: { get: () => null }, buf: Buffer.from(")]}'\n\n25\n[[\"e\",4,null,null,25]]\n") };
      }
      return failing(url, opts);
    };
    const r = await geminiDeepResearch({
      cookie: { psid: "psid-test", psidts: "ts-test" },
      query: "q",
      timeoutMs: 1200,
      http: http2,
    });
    assert.equal(r.title, "JPEG Compression Research Plan");
    assert.match(String(r.partial), /could not be retrieved/);
    assert.ok(includes(r.partial, "c_"));
  });

  it("fails fast with an honest partial when the poll is auth-rejected (403)", async () => { // upstream mocha budget: 10_000ms
    let streamTurns = 0;
    let polls = 0;
    const http: DrHttp = async (url) => {
      if (url.startsWith("https://gemini.google.com/app")) {
        return {
          status: 200,
          headers: { get: () => null, "set-cookie": [] },
          buf: Buffer.from(')]}\'\n<html>"SNlM0e":"","cfb2h":"boq_test_build","FdrFJe":"1"</html>'),
        };
      }
      if (url.includes("StreamGenerate")) {
        streamTurns++;
        return { status: 200, headers: { get: () => null }, buf: streamTurns === 1 ? fixture("dr-plan.bin") : fixture("dr-confirm.bin") };
      }
      polls++;
      return { status: 403, headers: { get: () => null }, buf: Buffer.from("") };
    };
    const r = await geminiDeepResearch({ cookie: { psid: "psid-test", psidts: "ts-test" }, query: "q", timeoutMs: 8_000, http });
    assert.equal(polls, 1); // first rejection breaks the loop — no re-polling to the deadline
    assert.ok(includes(r.partial, "report poll rejected (HTTP 403)"));
    assert.ok(includes(r.partial, "c_10950ff6b1b0ebc1")); // chat id still surfaced
  });
});

describe("extractCookieJar (case-independent seeding, no duplicate Cookie header)", () => {
  it("seeds the jar from lowercase and capital Cookie keys, stripping the header from rest", () => {
    for (const key of ["cookie", "Cookie"]) {
      const { rest, jar } = extractCookieJar({ [key]: "__Secure-1PSID=abc; NID=zz", "content-type": "x" });
      assert.equal(jar.get("__Secure-1PSID"), "abc");
      assert.equal(jar.get("NID"), "zz");
      assert.deepEqual(rest, { "content-type": "x" });
      assert.strictEqual(Object.keys(rest).some((k) => k.toLowerCase() === "cookie"), false);
    }
  });

  it("tolerates a missing cookie header", () => {
    const { rest, jar } = extractCookieJar({ accept: "*/*" });
    assert.equal(jar.size, 0);
    assert.deepEqual(rest, { accept: "*/*" });
  });
});

describe("abortableSleep (listener hygiene)", () => {
  function countingSignal(): { signal: AbortSignal; added: () => number; removed: () => number } {
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const signal = controller.signal as AbortSignal & Record<string, unknown>;
    const realAdd = signal.addEventListener.bind(signal);
    const realRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...a: unknown[]) => {
      added++;
      return (realAdd as (...args: unknown[]) => void)(...a);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((...a: unknown[]) => {
      removed++;
      return (realRemove as (...args: unknown[]) => void)(...a);
    }) as typeof signal.removeEventListener;
    return { signal, added: () => added, removed: () => removed };
  }

  it("removes its abort listener when the timer wins (no leak across polls)", async () => {
    const { signal, added, removed } = countingSignal();
    for (let i = 0; i < 3; i++) await abortableSleep(5, signal);
    assert.equal(added(), 3);
    assert.equal(removed(), 3);
  });

  it("rejects with AbortError when aborted mid-sleep", async () => {
    const controller = new AbortController();
    const p = abortableSleep(60_000, controller.signal);
    setTimeout(() => controller.abort(), 5);
    try {
      await p;
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal((err as Error).name, "AbortError");
    }
  });
});
