// NEW for the ceulen port — the module wiring: unconditional registration with
// the settings-resolved baseUrl, provider-gated hooks (NOT family-gated), the
// throttle/signing gates, the 401 ladder, and /zai status.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import zaiModule, { zaiRegisteredBaseUrl } from "../index.js";
import { DEFAULT_BASE_URL } from "../lib/anthropic.js";
import { ClientSigningManager, setZcodeSigningManager } from "../lib/signing.js";

const ENV_KEYS = [
  "ZAI_ANTHROPIC_API_KEY",
  "ZAI_ANTHROPIC_BASE_URL",
  "ZAI_ANTHROPIC_SPEED",
  "ZAI_ANTHROPIC_SIGNING",
  "ZAI_ANTHROPIC_MIN_INTERVAL_MS",
  "PI_CODING_AGENT_DIR",
] as const;

let dirs: string[] = [];
let saved: Record<string, string | undefined> = {};

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Temp agent dir (global settings + throttle state) + temp cwd (project file). */
function scopes() {
  const agentDir = tempDir("zai-ext-agent-");
  const cwd = tempDir("zai-ext-cwd-");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return { agentDir, cwd, global: join(agentDir, "settings.json"), project: join(cwd, ".pi", "settings.json") };
}

interface FakePi {
  pi: ExtensionAPI;
  providers: Array<{ name: string; config: any }>;
  hooks: Map<string, Array<(event: any, ctx: any) => any>>;
  commands: Map<string, any>;
}

function fakePi(): FakePi {
  const providers: FakePi["providers"] = [];
  const hooks: FakePi["hooks"] = new Map();
  const commands: FakePi["commands"] = new Map();
  const pi = {
    registerProvider: (name: string, config: any) => providers.push({ name, config }),
    on: (event: string, handler: (e: any, c: any) => any) => {
      hooks.set(event, [...(hooks.get(event) ?? []), handler]);
      return () => {};
    },
    registerCommand: (name: string, options: any) => commands.set(name, options),
  } as unknown as ExtensionAPI;
  return { pi, providers, hooks, commands };
}

function fakeCtx(opts: { cwd: string; provider?: string; trusted?: boolean; sessionId?: string } = { cwd: process.cwd() }) {
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = {
    cwd: opts.cwd,
    model: { provider: opts.provider ?? "zai-anthropic", id: "glm-5.3" },
    isProjectTrusted: () => opts.trusted === true,
    sessionManager: { getSessionId: () => opts.sessionId ?? "sess_test_0001" },
    ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
  } as unknown as ExtensionContext;
  return { ctx, notifications };
}

function hook(f: FakePi, name: string) {
  const handlers = f.hooks.get(name);
  assert.ok(handlers && handlers.length > 0, `${name} handler registered`);
  return handlers[0]!;
}

beforeEach(() => {
  dirs = [];
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  setZcodeSigningManager(undefined);
});

describe("zai module wiring", () => {
  it("registers the provider UNCONDITIONALLY at load with the settings-resolved baseUrl", () => {
    const s = scopes();
    writeFileSync(s.global, JSON.stringify({ zai: { baseUrl: "https://open.bigmodel.cn/api/anthropic" } }));
    const f = fakePi();
    zaiModule(f.pi); // no API key in env — must still register (/login supplies it)

    assert.equal(f.providers.length, 1);
    assert.equal(f.providers[0]!.name, "zai-anthropic");
    assert.equal(f.providers[0]!.config.baseUrl, "https://open.bigmodel.cn/api/anthropic");
    assert.equal(f.providers[0]!.config.apiKey, "$ZAI_ANTHROPIC_API_KEY");
    assert.equal(f.providers[0]!.config.api, "anthropic-messages");
    assert.equal(zaiRegisteredBaseUrl(), "https://open.bigmodel.cn/api/anthropic");
  });

  it("session_start re-registers only when a trusted project file flips the endpoint", () => {
    const s = scopes();
    const f = fakePi();
    zaiModule(f.pi);
    assert.equal(f.providers[0]!.config.baseUrl, DEFAULT_BASE_URL);

    // Untrusted: the project file must not touch the endpoint.
    writeFileSync(s.project, JSON.stringify({ zai: { baseUrl: "https://zcode.z.ai/api/v1/ultra-zai/anthropic" } }));
    const untrusted = fakeCtx({ cwd: s.cwd, trusted: false });
    hook(f, "session_start")({}, untrusted.ctx);
    assert.equal(f.providers.length, 1, "untrusted project ignored");

    const trusted = fakeCtx({ cwd: s.cwd, trusted: true });
    hook(f, "session_start")({}, trusted.ctx);
    assert.equal(f.providers.length, 2);
    assert.equal(f.providers[1]!.config.baseUrl, "https://zcode.z.ai/api/v1/ultra-zai/anthropic");

    // Unchanged → no re-register churn.
    hook(f, "session_start")({}, trusted.ctx);
    assert.equal(f.providers.length, 2);
  });

  it("before_provider_request adds the fast-mode body field only for zai-anthropic", () => {
    const s = scopes();
    const f = fakePi();
    zaiModule(f.pi);
    const handler = hook(f, "before_provider_request");
    const payload: Record<string, unknown> = { model: "glm-5.3", messages: [] };

    const out = handler({ type: "before_provider_request", payload }, fakeCtx({ cwd: s.cwd }).ctx);
    assert.equal(out.speed, "fast");
    assert.equal(payload.speed, undefined, "original payload untouched");

    assert.equal(handler({ payload }, fakeCtx({ cwd: s.cwd, provider: "router" }).ctx), undefined);

    writeFileSync(s.global, JSON.stringify({ zai: { speed: "standard" } }));
    assert.equal(handler({ payload }, fakeCtx({ cwd: s.cwd }).ctx), undefined, "standard tier → no body change");
  });

  it("before_provider_headers: beta header for zai-anthropic, no signing when disabled, gate off at 0ms", async () => {
    const s = scopes();
    writeFileSync(s.global, JSON.stringify({ zai: { signing: false, minIntervalMs: 0 } }));
    const f = fakePi();
    zaiModule(f.pi);
    const handler = hook(f, "before_provider_headers");

    const headers: Record<string, string | null | undefined> = {};
    await handler({ type: "before_provider_headers", headers }, fakeCtx({ cwd: s.cwd }).ctx);
    assert.equal(headers["anthropic-beta"], "fast-mode-2026-02-01");
    assert.equal(headers["User-Agent"], undefined, "signing off → no identity headers");
    assert.equal(existsSync(join(s.agentDir, "zai-anthropic-dispatch.json")), false, "0ms gate disabled → no state file");

    const other: Record<string, string | null | undefined> = { existing: "1" };
    await handler({ headers: other }, fakeCtx({ cwd: s.cwd, provider: "openrouter" }).ctx);
    assert.deepEqual(other, { existing: "1" }, "non-zai-anthropic requests are untouched");
  });

  it("before_provider_headers: signing on merges identity headers and fails open without a network", async () => {
    const s = scopes();
    writeFileSync(s.global, JSON.stringify({ zai: { minIntervalMs: 0 } })); // signing defaults ON
    process.env.ZAI_ANTHROPIC_API_KEY = "abc123.secret456";
    const stub = new ClientSigningManager({
      identity: { appVersion: "3.10.2", sourceTitle: "electron", refererOrigin: "https://zcode.z.ai" },
      fetchImpl: (async () => {
        throw new Error("no network in this test");
      }) as typeof fetch,
    });
    setZcodeSigningManager(stub);

    const f = fakePi();
    zaiModule(f.pi);
    const headers: Record<string, string | null | undefined> = { "x-api-key": "abc123.secret456" };
    await hook(f, "before_provider_headers")({ headers }, fakeCtx({ cwd: s.cwd }).ctx);

    assert.equal(headers["User-Agent"], "ZCode/3.10.2");
    assert.equal(headers["X-ZCode-Agent"], "glm");
    assert.equal(headers["x-session-id"], "sess_test_0001", "fail-open path keeps the lowercase session id");
    assert.ok(!headers["X-Client-Sig"], "gate unreachable → unsigned");
  });

  it("after_provider_response drives the 401 ladder only for zai-anthropic with signing on", () => {
    const s = scopes();
    const f = fakePi();
    zaiModule(f.pi);
    const handler = hook(f, "after_provider_response");
    let notes401 = 0;
    let okNotes = 0;
    setZcodeSigningManager({
      noteResponse401: () => { notes401++; },
      noteResponseOk: () => { okNotes++; },
    } as unknown as ClientSigningManager);

    handler({ status: 401 }, fakeCtx({ cwd: s.cwd }).ctx);
    assert.equal(notes401, 1);
    handler({ status: 200 }, fakeCtx({ cwd: s.cwd }).ctx);
    assert.equal(okNotes, 1);

    handler({ status: 401 }, fakeCtx({ cwd: s.cwd, provider: "router" }).ctx);
    assert.equal(notes401, 1, "other providers ignored");

    writeFileSync(s.global, JSON.stringify({ zai: { signing: false } }));
    handler({ status: 401 }, fakeCtx({ cwd: s.cwd }).ctx);
    assert.equal(notes401, 1, "signing off → ladder inert");
  });

  it("/zai status reports endpoint + layer + flags and never the key", async () => {
    const s = scopes();
    writeFileSync(s.global, JSON.stringify({ zai: { baseUrl: "https://open.bigmodel.cn/api/anthropic", minIntervalMs: 250 } }));
    process.env.ZAI_ANTHROPIC_API_KEY = "super-secret-key-value";
    const f = fakePi();
    zaiModule(f.pi);

    const { ctx, notifications } = fakeCtx({ cwd: s.cwd });
    await f.commands.get("zai")!.handler("", ctx as unknown as ExtensionCommandContext);

    assert.equal(notifications.length, 1);
    const text = notifications[0]!.message;
    assert.match(text, /zai-anthropic/);
    assert.match(text, /https:\/\/open\.bigmodel\.cn\/api\/anthropic/);
    assert.match(text, /global settings\.json/, "discloses which layer set the endpoint");
    assert.match(text, /Speed: fast/);
    assert.match(text, /Signing: on/);
    assert.match(text, /250ms between request starts/);
    assert.match(text, /API key: set \(env/);
    assert.ok(!text.includes("super-secret-key-value"), "the key is never printed");
  });

  it("/zai status discloses the env layer for baseUrl", async () => {
    const s = scopes();
    process.env.ZAI_ANTHROPIC_BASE_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic";
    const f = fakePi();
    zaiModule(f.pi);
    const { ctx, notifications } = fakeCtx({ cwd: s.cwd });
    await f.commands.get("zai")!.handler("", ctx as unknown as ExtensionCommandContext);
    assert.match(notifications[0]!.message, /env ZAI_ANTHROPIC_BASE_URL/);
    assert.match(notifications[0]!.message, /API key: /, "key presence is reported, never the value");
  });
});
