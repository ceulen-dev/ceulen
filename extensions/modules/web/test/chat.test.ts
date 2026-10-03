/**
 * Unit tests for web_chat (lib/chatapi.ts). No network — fetch is injected.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  chatgptChat,
  describeChatApiError,
  loadChatConfig,
} from "../lib/chatapi";
import type { FetchLike } from "../lib/imageapi";

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

const ENV_VARS = ["WEB_CHAT_API_BASE_URL", "WEB_CHAT_API_KEY", "PI_CODING_AGENT_DIR"] as const;
const OLD_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_VARS) OLD_ENV[k] = process.env[k];
  for (const k of ENV_VARS) delete process.env[k];
  process.env.PI_CODING_AGENT_DIR = "/nonexistent-pi-agent-dir";
});

afterEach(() => {
  for (const k of ENV_VARS) {
    if (OLD_ENV[k] !== undefined) process.env[k] = OLD_ENV[k];
    else delete process.env[k];
  }
});

const ISOLATED = "/nonexistent-dir-for-tests";

function okFetch(body: unknown): FetchLike {
  return (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    void url;
    void init;
    return {
      ok: true,
      status: 200,
      json: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  }) as unknown as FetchLike;
}

describe("loadChatConfig", () => {
  it("reads WEB_CHAT_API_BASE_URL + key (process.env first)", () => {
    process.env.WEB_CHAT_API_BASE_URL = "https://gw.example.com/v1/";
    process.env.WEB_CHAT_API_KEY = "ck";
    const cfg = loadChatConfig(ISOLATED, false);
    assert.equal(cfg?.baseUrl, "https://gw.example.com/v1");
    assert.equal(cfg?.apiKey, "ck");
    assert.equal(cfg?.source, "env");
  });

  it("returns null when unconfigured (isolated from host pi config)", () => {
    assert.equal(loadChatConfig(ISOLATED, false), null);
  });
});

describe("chatgptChat", () => {
  it("posts a non-streaming completion and returns content + model", async () => {
    let seenUrl = "";
    let seenInit: { headers?: Record<string, string>; body?: string } | undefined;
    const fetchImpl = (async (url: string, init?: any) => {
      seenUrl = url;
      seenInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ model: "gpt-5.3-mini", choices: [{ message: { content: "the answer" } }] }),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }) as unknown as FetchLike;
    const r = await chatgptChat({ baseUrl: "https://gw.example.com/v1", apiKey: "ck", prompt: "q", model: "gpt-5.3-mini", fetchImpl });
    assert.equal(r.text, "the answer");
    assert.equal(r.model, "gpt-5.3-mini");
    assert.equal(seenUrl, "https://gw.example.com/v1/chat/completions");
    assert.equal(seenInit?.headers?.Authorization, "Bearer ck");
    const sent = JSON.parse(seenInit!.body!);
    assert.equal(sent.stream, false);
    assert.deepEqual(sent.messages, [{ role: "user", content: "q" }]);
  });

  it("includes the system message when provided", async () => {
    let sent: any;
    const fetchImpl = (async (_url: string, init?: any) => {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    }) as unknown as FetchLike;
    await chatgptChat({ baseUrl: "https://x/v1", prompt: "q", system: "be terse", fetchImpl });
    assert.deepEqual(sent.messages[0], { role: "system", content: "be terse" });
  });

  it("rejects empty completions", async () => {
    try {
      await chatgptChat({ baseUrl: "https://x/v1", prompt: "q", model: "m", fetchImpl: okFetch({ choices: [{ message: { content: "" } }] }) });
      assert.fail("should throw");
    } catch (e) {
      assert.ok(includes((e as Error).message, "empty completion"));
      assert.ok(includes((e as Error).message, "model m"));
    }
  });
});

describe("describeChatApiError", () => {
  async function expectHint(status: number, body: unknown, fragment: string): Promise<void> {
    const failing = (async () => ({
      ok: false,
      status,
      json: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as FetchLike;
    try {
      await chatgptChat({ baseUrl: "https://x/v1", prompt: "p", fetchImpl: failing });
      assert.fail("should throw");
    } catch (e) {
      assert.ok(includes(describeChatApiError(e), fragment));
    }
  }

  it("maps 401 to an API-key hint", async () => {
    await expectHint(401, { error: { message: "bad key" } }, "API key");
  });

  it("maps 429 to a quota hint", async () => {
    await expectHint(429, { error: { message: "quota" } }, "429");
  });

  it("maps 502 to the empty account pool hint", async () => {
    await expectHint(502, { error: { message: "upstream_error" } }, "empty account pool");
  });

  it("maps 5xx to a server-error hint", async () => {
    await expectHint(503, { error: { message: "boom" } }, "server error");
  });
});
