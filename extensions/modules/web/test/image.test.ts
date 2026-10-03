/**
 * Unit tests for web_image (lib/imageapi.ts + gemini image generation).
 * No network — the gemini-reverse client is injected via a fake factory and
 * HTTP via an injectable fetchImpl; rate guardrails use a fake clock.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ZAI_PRESET,
  MAX_DOWNLOAD_BYTES,
  apiGenerateImage,
  describeImageApiError,
  generateImageWithFallback,
  imageRateCheck,
  imageRateRecord,
  imageRateSnapshot,
  loadImageApiConfig,
  loadImageRateConfig,
  __resetImageRate,
  __setImageRateClock,
  type FetchLike,
  type ImageApiConfig,
  type ImageRateConfig,
} from "../lib/imageapi";
import {
  geminiGenerateImage,
  loadGeminiWebConfig,
  __resetGeminiClientCache,
  type GeminiClientFactory,
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

// ---------------------------------------------------------------------------
// Env isolation (host ~/.pi/agent/.env.local must never leak in)
// ---------------------------------------------------------------------------

const ENV_VARS = [
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
  "WEB_IMAGE_API_BASE_URL",
  "WEB_IMAGE_API_KEY",
  "WEB_IMAGE_API_LABEL",
  "WEB_IMAGE_MIN_INTERVAL_MS",
  "WEB_IMAGE_DAILY_CAP",
  "GEMINI_WEB_SECURE_1PSID",
  "GEMINI_WEB_PROXY",
  "PI_CODING_AGENT_DIR",
] as const;
const OLD_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_VARS) OLD_ENV[k] = process.env[k];
  for (const k of ENV_VARS) delete process.env[k];
  process.env.PI_CODING_AGENT_DIR = "/nonexistent-pi-agent-dir";
  __resetImageRate();
  __resetGeminiClientCache();
});

afterEach(() => {
  for (const k of ENV_VARS) {
    if (OLD_ENV[k] !== undefined) process.env[k] = OLD_ENV[k];
    else delete process.env[k];
  }
});

const ISOLATED = "/nonexistent-dir-for-tests";
const NO_RATE: ImageRateConfig = { minIntervalMs: 0, dailyCap: 9999 };

async function tmpDir(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-web-image-test-"));
}

// ---------------------------------------------------------------------------
// Fake gemini client (image-capable)
// ---------------------------------------------------------------------------

function imageClient(opts: { images?: number; text?: string; failFirst?: boolean } = {}) {
  let generateCalls = 0;
  const seen: { newChatOpts?: { model?: string }; prompts: string[]; saved: string[] } = { prompts: [], saved: [] };
  const client: GeminiClientLike = {
    ask: async () => ({ text: "ok" }),
    research: async () => ({ text: "report" }),
    newChat: (newChatOpts?: { model?: string }) => ({
      generateContent: async (o: { prompt: string }) => {
        generateCalls++;
        seen.newChatOpts = newChatOpts;
        seen.prompts.push(o.prompt);
        if (opts.failFirst && generateCalls === 1) {
          const e = new Error("expired");
          e.name = "AuthError";
          throw e;
        }
        const n = opts.images ?? 1;
        return {
          text: opts.text ?? "",
          model: "gemini-image-test",
          generated_images: Array.from({ length: n }, (_, i) => ({
            save: async (so?: { path?: string }) => {
              const p = path.join(so?.path ?? ".", `img-${generateCalls}-${i}.png`);
              fs.writeFileSync(p, "png");
              seen.saved.push(p);
              return p;
            },
            url: "https://example.com/x.png",
            alt: "x",
          })),
        };
      },
    }),
  };
  return { client, seen };
}

function factoryFor(client: GeminiClientLike, calls?: { n: number }): GeminiClientFactory {
  return () => {
    if (calls) calls.n++;
    return client;
  };
}

// ---------------------------------------------------------------------------
// Fake fetch (OpenAI-images shape)
// ---------------------------------------------------------------------------

const PNG_B64 = Buffer.from("pngbytes").toString("base64");

function routingFetch(apiBody: unknown, apiStatus = 200, fileBytes = "imgbytes", fileMime = "png"): FetchLike {
  return (async (url: string, init?: { method?: string }) => {
    if (init?.method === "POST") {
      return {
        ok: apiStatus >= 200 && apiStatus < 300,
        status: apiStatus,
        statusText: "Status",
        json: async () => apiBody,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    // image download — TextEncoder gives an exact-size ArrayBuffer (Buffer
    // pooling would leak neighboring bytes into the "downloaded" file)
    const fakeRes = {
      ok: true,
      status: 200,
      json: async () => ({}),
      arrayBuffer: async () => new TextEncoder().encode(fileBytes).buffer as ArrayBuffer,
    };
    void fileMime;
    void url;
    return fakeRes;
  }) as unknown as FetchLike;
}

// ---------------------------------------------------------------------------
// loadImageApiConfig / loadImageRateConfig
// ---------------------------------------------------------------------------

describe("loadImageApiConfig", () => {
  it("reads ZAI_API_KEY (process.env first)", () => {
    process.env.ZAI_API_KEY = "zk";
    const cfg = loadImageApiConfig(ISOLATED, false);
    assert.equal(cfg.zai?.apiKey, "zk");
    assert.equal(cfg.zai?.source, "env");
    assert.equal(cfg.custom, undefined);
  });

  it("falls back to Z_AI_API_KEY when ZAI_API_KEY is unset", () => {
    process.env.Z_AI_API_KEY = "zk2";
    assert.equal(loadImageApiConfig(ISOLATED, false).zai?.apiKey, "zk2");
  });

  it("reads custom endpoint config and defaults the label to the host", () => {
    process.env.WEB_IMAGE_API_BASE_URL = "https://api.example.com/v1/";
    const cfg = loadImageApiConfig(ISOLATED, false);
    assert.equal(cfg.custom?.baseUrl, "https://api.example.com/v1");
    assert.equal(cfg.custom?.label, "api.example.com");
    assert.equal(cfg.custom?.apiKey, undefined);
    process.env.WEB_IMAGE_API_KEY = "ck";
    process.env.WEB_IMAGE_API_LABEL = "mine";
    const cfg2 = loadImageApiConfig(ISOLATED, false);
    assert.equal(cfg2.custom?.apiKey, "ck");
    assert.equal(cfg2.custom?.label, "mine");
  });

  it("returns empty config when nothing is set (isolated from host pi config)", () => {
    const cfg = loadImageApiConfig(ISOLATED, false);
    assert.equal(cfg.zai, undefined);
    assert.equal(cfg.custom, undefined);
  });
});

describe("loadImageRateConfig", () => {
  it("defaults to 5s interval and 20/day cap", () => {
    assert.deepEqual(loadImageRateConfig(ISOLATED, false), { minIntervalMs: 5000, dailyCap: 20 });
  });

  it("honors env overrides (invalid values fall back to defaults)", () => {
    process.env.WEB_IMAGE_MIN_INTERVAL_MS = "250";
    process.env.WEB_IMAGE_DAILY_CAP = "7";
    assert.deepEqual(loadImageRateConfig(ISOLATED, false), { minIntervalMs: 250, dailyCap: 7 });
    process.env.WEB_IMAGE_MIN_INTERVAL_MS = "bogus";
    assert.equal(loadImageRateConfig(ISOLATED, false).minIntervalMs, 5000);
  });
});

// ---------------------------------------------------------------------------
// Rate guardrails (fake clock)
// ---------------------------------------------------------------------------

describe("image rate guardrails", () => {
  it("enforces the min interval between calls", () => {
    let t = 10_000;
    __setImageRateClock(() => t);
    const rc: ImageRateConfig = { minIntervalMs: 5000, dailyCap: 20 };
    assert.equal(imageRateCheck("gemini", rc).ok, true);
    imageRateRecord("gemini");
    const v = imageRateCheck("gemini", rc);
    assert.equal(v.ok, false);
    if (!v.ok) assert.ok((v.retryAfterMs) > (0));
    t += 5000;
    assert.equal(imageRateCheck("gemini", rc).ok, true);
  });

  it("enforces the daily cap for gemini only, resetting on UTC day roll", () => {
    let t = Date.UTC(2026, 8, 13, 23, 50, 0);
    __setImageRateClock(() => t);
    const rc: ImageRateConfig = { minIntervalMs: 0, dailyCap: 2 };
    imageRateRecord("gemini", 2);
    const blocked = imageRateCheck("gemini", rc);
    assert.equal(blocked.ok, false);
    assert.equal(imageRateCheck("zai", rc).ok, true); // keyed API: interval-limited only
    t += 11 * 60 * 1000; // cross midnight UTC
    assert.equal(imageRateCheck("gemini", rc).ok, true);
  });

  it("counts successes only and exposes a snapshot", () => {
    let t = 1_000;
    __setImageRateClock(() => t);
    const rc: ImageRateConfig = { minIntervalMs: 1000, dailyCap: 5 };
    imageRateRecord("custom");
    assert.equal(imageRateSnapshot().custom.count, 1);
    t += 1000;
    assert.equal(imageRateCheck("custom", rc).ok, true);
    assert.equal(imageRateSnapshot().custom.msSinceLast, 1000);
  });
});

// ---------------------------------------------------------------------------
// geminiGenerateImage
// ---------------------------------------------------------------------------

describe("geminiGenerateImage", () => {
  it("saves returned images and reports guest + model", async () => {
    const { client, seen } = imageClient({ images: 2 });
    const outDir = await tmpDir();
    const r = await geminiGenerateImage("a red cube", {
      config: { psid: "psid", psidSource: "test" },
      outDir,
      factory: factoryFor(client),
    });
    assert.equal(lengthOf(r.paths), 2);
    assert.equal(fs.existsSync(r.paths[0]), true);
    assert.equal(r.guest, false);
    assert.equal(r.model, "gemini-image-test");
    assert.deepEqual(seen.prompts, ["a red cube"]);
  });

  it("passes the model through to newChat and flags guest mode without a cookie", async () => {
    const { client, seen } = imageClient();
    const r = await geminiGenerateImage("x", {
      config: loadGeminiWebConfig(ISOLATED, false),
      outDir: await tmpDir(),
      model: "gemini-image",
      factory: factoryFor(client),
    });
    assert.deepEqual(seen.newChatOpts, { model: "gemini-image" });
    assert.equal(r.guest, true);
  });

  it("errors with a hint when no images come back", async () => {
    const { client } = imageClient({ images: 0, text: "I cannot generate that." });
    try {
      await geminiGenerateImage("x", { config: { psid: "p", psidSource: "t" }, outDir: await tmpDir(), factory: factoryFor(client) });
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(includes((e as Error).message, "no images"));
      assert.ok(includes((e as Error).message, "I cannot generate that."));
    }
  });

  it("retries once on AuthError (re-created client re-runs init)", async () => {
    const { client, seen } = imageClient({ failFirst: true });
    const calls = { n: 0 };
    const r = await geminiGenerateImage("x", {
      config: { psid: "psid", psidSource: "t" },
      outDir: await tmpDir(),
      factory: factoryFor(client, calls),
      auth: {
        rotatePost: async () => ({ status: 200, setCookie: ["__Secure-1PSIDTS=rotated; Path=/"] }),
        storePath: path.join(await tmpDir(), "cookies.json"),
      },
    });
    assert.equal(calls.n, 2);
    assert.equal(lengthOf(r.paths), 1);
    void seen;
  });

  it("falls back to images when generated_images is empty", async () => {
    const outDir = await tmpDir();
    const img = {
      save: async (so?: { path?: string }) => {
        const p = path.join(so?.path ?? outDir, "fb-0.png");
        fs.writeFileSync(p, "png");
        return p;
      },
    };
    const client: GeminiClientLike = {
      ask: async () => ({ text: "ok" }),
      research: async () => ({ text: "r" }),
      newChat: () => ({
        generateContent: async () => ({ text: "", generated_images: [], images: [img] }),
      }),
    };
    const r = await geminiGenerateImage("x", { config: { psid: "psid", psidSource: "t" }, outDir, factory: () => client });
    assert.equal(lengthOf(r.paths), 1);
  });

  it("throws the text-preview error when no images come back", async () => {
    const outDir = await tmpDir();
    const client: GeminiClientLike = {
      ask: async () => ({ text: "ok" }),
      research: async () => ({ text: "r" }),
      newChat: () => ({
        generateContent: async () => ({ text: "cannot create images for you", generated_images: [] }),
      }),
    };
    try {
      await geminiGenerateImage("x", { config: { psid: "psid", psidSource: "t" }, outDir, factory: () => client });
      assert.fail("should throw");
    } catch (e) {
      assert.ok(includes((e as Error).message, "cannot create images for you"));
    }
  });

  it("throws the shape error when newChat is missing", async () => {
    const outDir = await tmpDir();
    const client: GeminiClientLike = { ask: async () => ({ text: "ok" }), research: async () => ({ text: "r" }) };
    try {
      await geminiGenerateImage("x", { config: { psid: "psid", psidSource: "t" }, outDir, factory: () => client });
      assert.fail("should throw");
    } catch (e) {
      assert.match(String((e as Error).message), /no newChat/);
    }
  });

  it("creates a non-existent out_dir before saving (parity with the API path)", async () => {
    const outDir = path.join(await tmpDir(), "nested", "deeper");
    const client: GeminiClientLike = {
      ask: async () => ({ text: "ok" }),
      research: async () => ({ text: "r" }),
      newChat: () => ({
        generateContent: async () => ({
          text: "",
          generated_images: [
            {
              save: async (so?: { path?: string }) => {
                const p = path.join(so!.path!, "mk-0.png");
                fs.writeFileSync(p, "png");
                return p;
              },
            },
          ],
        }),
      }),
    };
    const r = await geminiGenerateImage("x", { config: { psid: "psid", psidSource: "t" }, outDir, factory: () => client });
    assert.equal(lengthOf(r.paths), 1);
    assert.equal(fs.existsSync(r.paths[0]), true);
  });
});

describe("download-phase cancellation and size caps", () => {
  it("abort during the download phase rejects with AbortError, not a per-image downloadError", async () => {
    const outDir = await tmpDir();
    const controller = new AbortController();
    const fetchImpl = ((url: string, init?: { method?: string; signal?: AbortSignal }) => {
      if (init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: [{ url: "https://cdn.example.com/a.png" }] }),
        });
      }
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("The operation was aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    }) as unknown as FetchLike;
    const p = apiGenerateImage({ baseUrl: "https://x/v1", prompt: "p", outDir, fetchImpl, signal: controller.signal });
    const check = p.then(
      () => {
        throw new Error("should have rejected");
      },
      (e) => assert.equal((e as Error).name, "AbortError"),
    );
    controller.abort();
    await check;
  });

  it("Content-Length over the cap fails the download without buffering the body", async () => {
    const outDir = await tmpDir();
    let buffered = false;
    const fetchImpl = ((url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: [{ url: "https://cdn.example.com/big.png" }] }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? String(MAX_DOWNLOAD_BYTES + 1) : null) },
        arrayBuffer: async () => {
          buffered = true;
          return new ArrayBuffer(0);
        },
      });
    }) as unknown as FetchLike;
    // the cap error surfaces as a downloadError — the generation itself is
    // preserved (same contract as SSRF/redirect failures)
    const r = await apiGenerateImage({ baseUrl: "https://x/v1", prompt: "p", outDir, fetchImpl });
    assert.equal(lengthOf(r.urls), 1);
    assert.match(String(r.downloadErrors?.[0]), /download cap/);
    assert.equal(buffered, false);
  });
});

// ---------------------------------------------------------------------------
// apiGenerateImage (fake fetch)
// ---------------------------------------------------------------------------

describe("apiGenerateImage", () => {
  it("writes b64_json results and echoes the model", async () => {
    const outDir = await tmpDir();
    const r = await apiGenerateImage({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "img-1",
      prompt: "p",
      outDir,
      fetchImpl: routingFetch({ data: [{ b64_json: PNG_B64 }], model: "img-1" }),
    });
    assert.equal(lengthOf(r.paths), 1);
    assert.equal(fs.readFileSync(r.paths[0]).toString(), "pngbytes");
    assert.equal(r.model, "img-1");
  });

  it("notes an n shortfall when upstream returns fewer than requested", async () => {
    const outDir = await tmpDir();
    const r = await apiGenerateImage({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "img-1",
      prompt: "p",
      n: 2,
      outDir,
      fetchImpl: routingFetch({ data: [{ b64_json: PNG_B64 }] }),
    });
    assert.equal(lengthOf(r.paths), 1);
    assert.match(String(r.note), /1 of 2/);
    const r1 = await apiGenerateImage({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "img-1",
      prompt: "p",
      n: 1,
      outDir,
      fetchImpl: routingFetch({ data: [{ b64_json: PNG_B64 }] }),
    });
    assert.equal(r1.note, undefined);
  });

  it("downloads url results (extension from the URL)", async () => {
    const outDir = await tmpDir();
    const fetchImpl = routingFetch({ data: [{ url: "https://cdn.example.com/a/b.WEBP?x=1" }] });
    const r = await apiGenerateImage({ baseUrl: ZAI_PRESET.baseUrl, model: "cogview-4", prompt: "p", outDir, fetchImpl });
    assert.equal(lengthOf(r.paths), 1);
    assert.equal(r.paths[0].endsWith(".webp"), true);
    assert.equal(fs.readFileSync(r.paths[0]).toString(), "imgbytes");
  });

  it("passes size through in the request body only when set", async () => {
    const outDir = await tmpDir();
    const bodies: Array<Record<string, unknown>> = [];
    const capture = (impl: FetchLike): FetchLike => (url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return impl(url, init);
    };
    await apiGenerateImage({
      baseUrl: "https://api.example.com/v1",
      model: "glm-image",
      prompt: "p",
      size: "960x1728",
      outDir,
      fetchImpl: capture(routingFetch({ data: [{ b64_json: PNG_B64 }] })),
    });
    assert.equal(bodies[0].size, "960x1728");
    await apiGenerateImage({
      baseUrl: "https://api.example.com/v1",
      model: "glm-image",
      prompt: "p",
      outDir,
      fetchImpl: capture(routingFetch({ data: [{ b64_json: PNG_B64 }] })),
    });
    assert.equal(bodies[1].size, undefined);
  });

  it("maps HTTP errors into ImageApiError and rejects empty payloads", async () => {
    const outDir = await tmpDir();
    const fail = (status: number, body: unknown) =>
      apiGenerateImage({ baseUrl: "https://x/v1", prompt: "p", outDir, fetchImpl: routingFetch(body, status) });
    try {
      await fail(401, { error: { message: "bad key" } });
      assert.fail("should throw");
    } catch (e) {
      assert.ok(includes(describeImageApiError(e), "API key"));
      assert.ok(includes((e as Error).message, "bad key"));
    }
    try {
      await fail(429, { message: "quota" });
      assert.fail("should throw");
    } catch (e) {
      assert.ok(includes(describeImageApiError(e), "429"));
    }
    try {
      await fail(500, { error: { message: "boom" } });
      assert.fail("should throw");
    } catch (e) {
      assert.ok(includes(describeImageApiError(e), "server error"));
    }
    try {
      await apiGenerateImage({ baseUrl: "https://x/v1", prompt: "p", outDir, fetchImpl: routingFetch({ data: [] }) });
      assert.fail("should throw");
    } catch (e) {
      assert.ok(includes((e as Error).message, "no image data"));
    }
  });

  it("survives a failed image download by returning the URL (generation not wasted)", async () => {
    const outDir = await tmpDir();
    const failingDownload = (async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ url: "https://blocked-cdn.example.com/a.png" }] }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      throw new Error("connect ECONNREFUSED 0.0.0.0:443");
    }) as unknown as FetchLike;
    const r = await apiGenerateImage({ baseUrl: "https://x/v1", prompt: "p", outDir, fetchImpl: failingDownload });
    assert.deepEqual(r.paths, []);
    assert.deepEqual(r.urls, ["https://blocked-cdn.example.com/a.png"]); // raw URL, openable
    assert.equal(lengthOf(r.downloadErrors), 1);
  });

  it("retries a 404 and succeeds (CDN edge propagation delay after generation)", async () => {
    const outDir = await tmpDir();
    let gets = 0;
    const fetchImpl = (async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ data: [{ url: "https://cdn.example.com/fresh.png" }] }) };
      }
      gets++;
      if (gets === 1) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
      return { ok: true, status: 200, headers: { get: () => "image/png" }, arrayBuffer: async () => new TextEncoder().encode("pngbytes").buffer as ArrayBuffer };
    }) as unknown as FetchLike;
    const r = await apiGenerateImage({ baseUrl: "https://x/v1", prompt: "p", outDir, fetchImpl });
    assert.equal(gets, 2);
    assert.equal(lengthOf(r.paths), 1);
    assert.equal(fs.readFileSync(r.paths[0]).toString(), "pngbytes");
  });

  it("flattens multi-line download errors to one line (reasons render inline)", async () => {
    const outDir = await tmpDir();
    const failingDownload = (async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ data: [{ url: "https://blocked.example.com/a.png" }] }) };
      }
      throw new Error("line one\nline two\nline three");
    }) as unknown as FetchLike;
    const r = await apiGenerateImage({ baseUrl: "https://x/v1", prompt: "p", outDir, fetchImpl: failingDownload });
    assert.deepEqual(r.urls, ["https://blocked.example.com/a.png"]); // stays raw
    assert.deepEqual(r.downloadErrors, ["line one line two line three"]); // no newlines
  });
});

// ---------------------------------------------------------------------------
// generateImageWithFallback (the chain)
// ---------------------------------------------------------------------------

function baseParams(over: Partial<Parameters<typeof generateImageWithFallback>[0]> = {}) {
  return {
    prompt: "p",
    outDir: "/tmp/unused",
    provider: "auto" as const,
    geminiConfig: loadGeminiWebConfig(ISOLATED, false),
    apiConfig: {} as ImageApiConfig,
    rateConfig: NO_RATE,
    ...over,
  };
}

describe("generateImageWithFallback", () => {
  it("returns the first successful provider", async () => {
    const { client } = imageClient();
    const r = await generateImageWithFallback(baseParams({
      geminiFactory: factoryFor(client),
      outDir: await tmpDir(),
    }));
    assert.equal(r.provider, "gemini");
    assert.deepEqual(r.attempts, []);
  });

  it("falls through to zai when gemini fails, recording the attempt", async () => {
    const { client } = imageClient({ images: 0, text: "nope" });
    process.env.ZAI_API_KEY = "zk";
    const r = await generateImageWithFallback(baseParams({
      geminiFactory: factoryFor(client),
      apiConfig: loadImageApiConfig(ISOLATED, false),
      outDir: await tmpDir(),
      fetchImpl: routingFetch({ data: [{ b64_json: PNG_B64 }], model: "cogview-4" }),
    }));
    assert.equal(r.provider, "zai");
    assert.equal(r.model, "cogview-4");
    assert.equal(lengthOf(r.attempts), 2);
    assert.ok(includes(r.attempts[0], "gemini:"));
    assert.ok(includes(r.attempts[1], "chatgpt: not configured"));
  });

  it("skips a capped gemini (web tier) and uses the next provider", async () => {
    const t = 10_000;
    __setImageRateClock(() => t);
    const { client } = imageClient();
    process.env.WEB_IMAGE_API_BASE_URL = "https://custom.example.com/v1";
    imageRateRecord("gemini"); // prior success consumes today's cap
    const r = await generateImageWithFallback(baseParams({
      geminiFactory: factoryFor(client),
      apiConfig: loadImageApiConfig(ISOLATED, false),
      rateConfig: { minIntervalMs: 0, dailyCap: 1 },
      outDir: await tmpDir(),
      fetchImpl: routingFetch({ data: [{ b64_json: PNG_B64 }] }),
    }));
    assert.equal(r.provider, "custom");
    assert.ok(includes(r.attempts[0], "skipped"));
    assert.ok(includes(r.attempts[0], "daily soft cap"));
  });

  it("records rate state so a second immediate gemini call is interval-blocked", async () => {
    let t = 10_000;
    __setImageRateClock(() => t);
    const { client } = imageClient();
    process.env.ZAI_API_KEY = "zk";
    const common = baseParams({
      geminiFactory: factoryFor(client),
      apiConfig: loadImageApiConfig(ISOLATED, false),
      rateConfig: { minIntervalMs: 5000, dailyCap: 20 },
      outDir: await tmpDir(),
      fetchImpl: routingFetch({ data: [{ b64_json: PNG_B64 }] }),
    });
    const first = await generateImageWithFallback(common);
    assert.equal(first.provider, "gemini");
    t += 1;
    const second = await generateImageWithFallback({ ...common, outDir: await tmpDir() });
    assert.equal(second.provider, "zai");
    assert.ok(includes(second.attempts[0], "min interval"));
  });

  it("throws an aggregated error when every provider fails", async () => {
    const { client } = imageClient({ images: 0, text: "nope" });
    try {
      await generateImageWithFallback(baseParams({ geminiFactory: factoryFor(client), outDir: await tmpDir() }));
      assert.fail("should throw");
    } catch (e) {
      const msg = (e as Error).message;
      assert.ok(includes(msg, "All image providers failed"));
      assert.ok(includes(msg, "zai: not configured"));
      assert.ok(includes(msg, "custom: not configured"));
    }
  });

  it("reports a pinned-but-unconfigured provider as the failure cause", async () => {
    try {
      await generateImageWithFallback(baseParams({ provider: "zai", outDir: await tmpDir() }));
      assert.fail("should throw");
    } catch (e) {
      assert.ok(includes((e as Error).message, "zai: not configured"));
    }
  });

  it("passes size through the chain into the zai request body when set, omits it when unset", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const capture = (impl: FetchLike): FetchLike => (url, init) => {
      if (init?.method === "POST") bodies.push(JSON.parse(String(init?.body)));
      return impl(url, init);
    };
    const apiConfig: ImageApiConfig = { zai: { apiKey: "k", source: "test" } };
    const r = await generateImageWithFallback(baseParams({
      provider: "zai",
      apiConfig,
      size: "960x1728",
      outDir: await tmpDir(),
      fetchImpl: capture(routingFetch({ data: [{ b64_json: PNG_B64 }] })),
    }));
    assert.equal(r.provider, "zai");
    assert.equal(bodies[0].size, "960x1728");
    await generateImageWithFallback(baseParams({
      provider: "zai",
      apiConfig,
      outDir: await tmpDir(),
      fetchImpl: capture(routingFetch({ data: [{ b64_json: PNG_B64 }] })),
    }));
    assert.equal(bodies[1].size, undefined);
  });
});

describe("generateImageWithFallback cancellation + n handling (review findings)", () => {
  it("rejects with AbortError on an aborted signal and does not try further providers", async () => {
    const { client } = imageClient();
    const calls = { n: 0 };
    const controller = new AbortController();
    controller.abort();
    let zaiCalled = false;
    const fetchSpy: FetchLike = (async () => {
      zaiCalled = true;
      throw new Error("zai must not be attempted after abort");
    }) as unknown as FetchLike;
    try {
      await generateImageWithFallback(baseParams({
        geminiFactory: factoryFor(client, calls),
        apiConfig: { zai: { apiKey: "k", source: "test" } },
        fetchImpl: fetchSpy,
        signal: controller.signal,
        outDir: await tmpDir(),
      }));
      assert.fail("should throw");
    } catch (e) {
      assert.equal((e as Error).name, "AbortError");
    }
    assert.equal(calls.n, 0); // loop-top check: no client construction either
    assert.equal(zaiCalled, false);
  });

  it("notes when the gemini web tier returns fewer images than n requested", async () => {
    const { client } = imageClient({ images: 1 });
    const r = await generateImageWithFallback(baseParams({
      geminiFactory: factoryFor(client),
      n: 3,
      outDir: await tmpDir(),
    }));
    assert.equal(r.provider, "gemini");
    assert.equal(lengthOf(r.paths), 1);
    assert.ok(includes(r.attempts.join(" "), "n=3 requested"));
    assert.ok(includes(r.attempts.join(" "), "zai/custom"));
  });

  it("normalizes a provider-phase error to AbortError when the signal aborted mid-flight", async () => {
    const controller = new AbortController();
    let zaiAttempted = false;
    const client: GeminiClientLike = {
      ask: async () => ({ text: "" }),
      research: async () => ({ text: "" }),
      newChat: () => ({
        generateContent: async () => ({
          text: "",
          generated_images: [
            {
              save: async () => {
                controller.abort(); // user cancel lands during the save phase
                throw new Error("disk full");
              },
            },
          ],
        }),
      }),
    };
    try {
      await generateImageWithFallback(baseParams({
        geminiFactory: () => client,
        apiConfig: { zai: { apiKey: "k", source: "test" } },
        fetchImpl: (async () => {
          zaiAttempted = true;
          throw new Error("zai must not be attempted after abort");
        }) as unknown as FetchLike,
        signal: controller.signal,
        outDir: await tmpDir(),
      }));
      assert.fail("should throw");
    } catch (e) {
      // Not "disk full" (raw provider error) — cancellation semantics win.
      assert.equal((e as Error).name, "AbortError");
    }
    assert.equal(zaiAttempted, false); // cancelled calls skip fallback
  });

  it("continues the chain when a foreign AbortError-named error is not from the caller's signal", async () => {
    const { client } = imageClient({ images: 0, text: "nope" }); // gemini must fail so the chain reaches zai
    const fetchImpl = (async (url: string, init?: { method?: string }) => {
      if (init?.method !== "POST") throw new Error("download not expected");
      if (String(url).includes("api.z.ai")) {
        const e = new Error("upstream internal abort");
        e.name = "AbortError"; // foreign abort — not the caller's signal
        throw e;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ b64_json: PNG_B64 }] }),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }) as unknown as FetchLike;
    const r = await generateImageWithFallback(baseParams({
      geminiFactory: factoryFor(client),
      apiConfig: {
        zai: { apiKey: "k", source: "test" },
        custom: { baseUrl: "https://custom.example.com/v1", label: "c", source: "test" },
      },
      fetchImpl,
      outDir: await tmpDir(),
    }));
    assert.equal(r.provider, "custom"); // foreign abort recorded, chain continued
    assert.ok(includes(r.attempts.join(" "), "zai: upstream internal abort"));
    assert.equal(lengthOf(r.paths), 1);
  });

  it("throws AbortError before any provider work when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    __setImageRateClock(() => 10_000);
    imageRateRecord("gemini"); // cap gemini so the pre-fix code would skip it and reach zai's fetch
    const { client } = imageClient();
    const calls = { n: 0 };
    let fetchCalls = 0;
    const fetchSpy: FetchLike = (async () => {
      fetchCalls++;
      throw new Error("no fetch expected");
    }) as unknown as FetchLike;
    try {
      await generateImageWithFallback(baseParams({
        geminiFactory: factoryFor(client, calls),
        apiConfig: { zai: { apiKey: "k", source: "test" } },
        rateConfig: { minIntervalMs: 0, dailyCap: 1 },
        fetchImpl: fetchSpy,
        signal: controller.signal,
        outDir: await tmpDir(),
      }));
      assert.fail("should throw");
    } catch (e) {
      assert.equal((e as Error).name, "AbortError");
    }
    assert.equal(calls.n, 0);
    assert.equal(fetchCalls, 0);
  });

  it("skips gemini in auto chains after 2 consecutive refusals; pinned still attempts", async () => {
    const { client, seen } = imageClient({ images: 0, text: "can't create right now" });
    process.env.ZAI_API_KEY = "zk";
    const common = baseParams({
      geminiFactory: factoryFor(client),
      apiConfig: loadImageApiConfig(ISOLATED, false),
      rateConfig: { minIntervalMs: 0, dailyCap: 9999 },
      outDir: await tmpDir(),
      fetchImpl: routingFetch({ data: [{ b64_json: PNG_B64 }] }),
    });
    const first = await generateImageWithFallback(common); // refusal 1 → zai
    const second = await generateImageWithFallback({ ...common, outDir: await tmpDir() }); // refusal 2 → zai
    assert.equal(first.provider, "zai");
    assert.equal(second.provider, "zai");

    const third = await generateImageWithFallback({ ...common, outDir: await tmpDir() }); // gemini SKIPPED
    assert.equal(third.provider, "zai");
    assert.ok(includes(third.attempts.join(" "), "skipped — refused image generation 2×"));
    assert.equal(lengthOf(seen.prompts), 2); // gemini never invoked on the third call

    // A pinned provider=gemini always attempts (all-fail error lists it).
    try {
      await generateImageWithFallback({ ...common, provider: "gemini", outDir: await tmpDir() });
      assert.fail("should throw");
    } catch (e) {
      assert.ok(includes((e as Error).message, "gemini:"));
    }
  });

  it("SSRF-guards gateway-supplied image URLs (no fetch, URL surfaced)", async () => {
    const outDir = await tmpDir();
    let getCalled = false;
    const fetchImpl = (async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ url: "http://169.254.169.254/latest/meta-data" }] }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      getCalled = true;
      throw new Error("metadata host must not be fetched");
    }) as unknown as FetchLike;
    const r = await apiGenerateImage({ baseUrl: "https://x/v1", prompt: "p", outDir, fetchImpl });
    assert.equal(getCalled, false);
    assert.deepEqual(r.paths, []);
    assert.deepEqual(r.urls, ["http://169.254.169.254/latest/meta-data"]); // raw URL
    assert.ok(includes(r.downloadErrors?.[0], "SSRF-guarded"));
  });

  it("sniffs real image type from bytes (JPEG behind a .png URL saved as .jpg)", async () => {
    const outDir = await tmpDir();
    const jpegB64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64");
    const fetchImpl = (async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ b64_json: jpegB64 }] }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }) as unknown as FetchLike;
    const r = await apiGenerateImage({ baseUrl: "https://x/v1", prompt: "p", outDir, fetchImpl });
    assert.equal(r.paths[0].endsWith(".jpg"), true); // not .png
    assert.equal(fs.readFileSync(r.paths[0])[0], 0xff);
  });

  it("caps oversized downloads at MAX_DOWNLOAD_BYTES and surfaces the URL instead", async () => {
    const outDir = await tmpDir();
    const big = Buffer.alloc(MAX_DOWNLOAD_BYTES + 1);
    const fetchImpl = (async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ url: "https://cdn.example.com/huge.png" }] }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => big.buffer,
      };
    }) as unknown as FetchLike;
    const r = await apiGenerateImage({ baseUrl: "https://x/v1", prompt: "p", outDir, fetchImpl });
    assert.deepEqual(fs.readdirSync(outDir), []); // nothing written
    assert.deepEqual(r.urls, ["https://cdn.example.com/huge.png"]); // raw URL
    assert.ok(includes(r.downloadErrors?.[0], "download cap"));
  });

  it("refuses redirects to private hosts (fetch follows redirects by default)", async () => {
    const outDir = await tmpDir();
    const gets: string[] = [];
    const fetchImpl = (async (url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ url: "https://cdn.example.com/redirect" }] }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      gets.push(url);
      return {
        ok: false,
        status: 302,
        headers: { get: (name: string) => (name.toLowerCase() === "location" ? "http://169.254.169.254/latest" : null) },
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }) as unknown as FetchLike;
    const r = await apiGenerateImage({ baseUrl: "https://x/v1", prompt: "p", outDir, fetchImpl });
    assert.deepEqual(gets, ["https://cdn.example.com/redirect"]); // redirect target never fetched
    assert.deepEqual(r.urls, ["https://cdn.example.com/redirect"]); // raw URL, redirect target never fetched
    assert.ok(includes(r.downloadErrors?.[0], "SSRF-guarded"));
    assert.deepEqual(fs.readdirSync(outDir), []);
  });

  it("follows redirects to public hosts (manual redirect, re-validated per hop)", async () => {
    const outDir = await tmpDir();
    const fetchImpl = (async (url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ url: "https://cdn.example.com/hop" }] }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      if (String(url).endsWith("/hop")) {
        return {
          ok: false,
          status: 302,
          headers: { get: (name: string) => (name.toLowerCase() === "location" ? "/real.png" : null) },
          json: async () => ({}),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => new TextEncoder().encode("pngbytes").buffer as ArrayBuffer,
      };
    }) as unknown as FetchLike;
    const r = await apiGenerateImage({ baseUrl: "https://x/v1", prompt: "p", outDir, fetchImpl });
    assert.equal(lengthOf(r.paths), 1);
    assert.equal(fs.readFileSync(r.paths[0]).toString(), "pngbytes");
  });
});

describe("toImageBlock mime mapping", () => {
  it("maps .gif files to image/gif", async () => {
    const { toImageBlock } = await import("../index");
    const dir = await tmpDir();
    const file = path.join(dir, "x.gif");
    fs.writeFileSync(file, "GIF89a");
    const block = await toImageBlock(file);
    assert.equal(block.mimeType, "image/gif");
    assert.equal(block.type, "image");
  });
});

describe("parseSizeParam", () => {
  it("passes valid WxH through, rejects junk", async () => {
    const { parseSizeParam } = await import("../index");
    assert.equal(parseSizeParam("960x1728"), "960x1728");
    assert.equal(parseSizeParam(undefined), undefined);
    assert.throws(() => parseSizeParam("96x96"), /invalid size/i);
    assert.throws(() => parseSizeParam("foo"), /invalid size/i);
  });
});
