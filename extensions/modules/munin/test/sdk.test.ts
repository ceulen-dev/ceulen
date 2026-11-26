// Regression tests for the vendored Munin SDK (lib/sdk/, upstream
// @kalera/munin-sdk 1.6.0). The incident these guard: the envelope advertised
// a client version that the server's write gate rejected, and nothing in the
// repo compared the advertised version with the vendored vendor header.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MuninClient, CLIENT_VERSION, MuninTransportError, fetchCapabilities } from "../lib/sdk/index.js";

type FetchInit = RequestInit & { signal?: AbortSignal | null };

/** A `typeof fetch` fake with a call log. */
function makeFetch(handler: (url: string, init?: FetchInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: FetchInit }[] = [];
  const impl = (async (input: unknown, init?: FetchInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A capabilities payload; `extra` merges into the data envelope. */
function caps(extra: Record<string, unknown> = {}, serverVersion = "9.9.9") {
  return {
    ok: true,
    data: {
      specVersion: "1.0",
      actions: { core: ["store", "search", "retrieve", "list", "recent", "delete"], optional: [] },
      features: {},
      metadata: { serverVersion, timestamp: "2026-11-26T00:00:00.000Z" },
      ...extra,
    },
  };
}

const isAction = (url: string): boolean => url.endsWith("/api/mcp/action");

beforeEach(() => {
  globalThis.__munin_caps = undefined;
});

describe("vendored SDK — envelope version", () => {
  it("sends CLIENT_VERSION in the action envelope, and the vendored SDK IS that version", async () => {
    const { calls, impl } = makeFetch((url) => (isAction(url) ? json({ ok: true, data: {} }) : json(caps())));
    const client = new MuninClient({ baseUrl: "https://munin.test", apiKey: "k", fetchImpl: impl, writeQueue: false });
    await client.store("proj", { key: "k" });

    const post = calls.find((c) => isAction(c.url));
    assert.ok(post, "an action POST happened");
    const body = JSON.parse(String(post!.init?.body)) as { client?: unknown };
    assert.deepEqual(body.client, { name: "@kalera/munin-sdk", version: CLIENT_VERSION });

    assert.match(CLIENT_VERSION, /^\d+\.\d+\.\d+$/, "CLIENT_VERSION is a semver triple");

    // The load-bearing half: the constant must match the vendor header of the
    // file that ships it. Bumping one without the other is the incident.
    const source = readFileSync(new URL("../lib/sdk/index.ts", import.meta.url), "utf8");
    const escaped = CLIENT_VERSION.replace(/\./g, "\\.");
    assert.match(
      source,
      new RegExp(`vendored from @kalera/munin-sdk ${escaped}\\b`),
      `lib/sdk/index.ts must declare "vendored from @kalera/munin-sdk ${CLIENT_VERSION}"`,
    );
  });
});

describe("vendored SDK — capabilities cache delta", () => {
  it("caches per baseUrl (keyed), not one un-keyed global", async () => {
    const counters: Record<string, number> = {};
    const { calls, impl } = makeFetch((url) => {
      const host = new URL(url).host;
      counters[host] = (counters[host] ?? 0) + 1;
      return json(caps({}, `server-of-${host}`));
    });

    const a = new MuninClient({ baseUrl: "https://a.munin.test", apiKey: "k", fetchImpl: impl, writeQueue: false });
    const b = new MuninClient({ baseUrl: "https://b.munin.test", apiKey: "k", fetchImpl: impl, writeQueue: false });

    const capsA = await a.capabilities();
    assert.equal(counters["a.munin.test"], 1);
    assert.equal(capsA.metadata.serverVersion, "server-of-a.munin.test");

    // Upstream's un-keyed global would answer 0 fetches here AND hand B A's
    // capabilities — which, with the write gate, means the wrong server's
    // minimum version silently allows/blocks the write.
    const capsB = await b.capabilities();
    assert.equal(counters["b.munin.test"], 1, "B fetched its own capabilities");
    assert.equal(capsB.metadata.serverVersion, "server-of-b.munin.test");

    // Single-slot ceiling, on purpose: B's fetch evicted A's slot, so A pays
    // one extra GET. A Map cache would avoid it; the tradeoff (unbounded
    // module-scope state across servers/keys) is worse than one GET.
    const again = await a.capabilities();
    assert.equal(counters["a.munin.test"], 2, "A re-fetched after B evicted it");
    assert.equal(again.metadata.serverVersion, "server-of-a.munin.test");

    assert.equal(calls.length, 3);
  });
});

describe("vendored SDK — capabilities timeout delta", () => {
  it("arms a timeout so a dead capabilities endpoint cannot hang the call", async () => {
    const impl = (async (_input: unknown, init?: FetchInit) => {
      // Never answers on its own: only the abort signal settles it.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;

    await assert.rejects(
      fetchCapabilities("https://munin.test", "k", impl, 25),
      (e: unknown) => e instanceof MuninTransportError && /capabilities endpoint/.test((e as Error).message),
    );
  });
});

describe("vendored SDK — writeQueue:false under maintenance", () => {
  it("surfaces MuninMaintenanceError queued:false instead of saving locally", async () => {
    const { impl } = makeFetch((url) =>
      isAction(url)
        ? json({ ok: false, error: { code: "MAINTENANCE_READ_ONLY", message: "read only" } }, 503)
        : json(caps()));
    const client = new MuninClient({
      baseUrl: "https://munin.test",
      apiKey: "k",
      fetchImpl: impl,
      writeQueue: false,
      maintenanceRetry: { retries: 0 },
      sleep: async () => {},
    });

    await assert.rejects(client.store("proj", { key: "k" }), (e: unknown) => {
      const err = e as Error & { queued?: boolean };
      return err.name === "MuninMaintenanceError" && err.queued === false && /try again later/.test(err.message);
    });
  });
});

describe("vendored SDK — pre-write version gate", () => {
  it("refuses a write BEFORE the POST when the server requires a newer client", async () => {
    const { calls, impl } = makeFetch((url) =>
      isAction(url) ? json({ ok: true, data: {} }) : json(caps({ clients: { "@kalera/munin-sdk": { minimum: "99.0.0" } } })));
    const client = new MuninClient({ baseUrl: "https://munin.test", apiKey: "k", fetchImpl: impl, writeQueue: false });

    await assert.rejects(client.store("proj", { key: "k" }), (e: unknown) => {
      const err = e as Error & { code?: string };
      return err.code === "ERR_CLIENT_OUTDATED" && /too old to write/.test(err.message);
    });
    assert.equal(calls.filter((c) => isAction(c.url)).length, 0, "the write never reached the server");
  });

  it("gates a write that SKIPS the capability check (delete): ensureCapability:false is not a gate bypass", async () => {
    // callMunin dispatches delete with ensureCapability:false (the server does
    // not advertise it), but delete IS in WRITE_ACTIONS — so the gate has to
    // run on that path too.
    const { calls, impl } = makeFetch((url) =>
      isAction(url) ? json({ ok: true, data: {} }) : json(caps({ clients: { "@kalera/munin-sdk": { minimum: "99.0.0" } } })));
    const client = new MuninClient({ baseUrl: "https://munin.test", apiKey: "k", fetchImpl: impl, writeQueue: false });

    await assert.rejects(
      client.invoke("proj", "delete", { key: "k" }, { ensureCapability: false }),
      (e: unknown) => (e as Error & { code?: string }).code === "ERR_CLIENT_OUTDATED",
    );
    assert.equal(calls.filter((c) => isAction(c.url)).length, 0, "the delete never reached the server");
  });

  it("fails open: an old/served minimum lets the write through", async () => {
    const oldMinimum = makeFetch((url) =>
      isAction(url) ? json({ ok: true, data: {} }) : json(caps({ clients: { "@kalera/munin-sdk": { minimum: "0.0.1" } } })));
    await new MuninClient({ baseUrl: "https://m.test", apiKey: "k", fetchImpl: oldMinimum.impl, writeQueue: false })
      .store("proj", { key: "k" });
    assert.equal(oldMinimum.calls.filter((c) => isAction(c.url)).length, 1);

    const noClients = makeFetch((url) => (isAction(url) ? json({ ok: true, data: {} }) : json(caps())));
    await new MuninClient({ baseUrl: "https://m.test", apiKey: "k", fetchImpl: noClients.impl, writeQueue: false })
      .store("proj", { key: "k" });
    assert.equal(noClients.calls.filter((c) => isAction(c.url)).length, 1);

    // Malformed minimum (non-string / empty entry) is treated as absent.
    const junk = makeFetch((url) =>
      isAction(url) ? json({ ok: true, data: {} }) : json(caps({ clients: { "@kalera/munin-sdk": {} } })));
    await new MuninClient({ baseUrl: "https://m.test", apiKey: "k", fetchImpl: junk.impl, writeQueue: false })
      .store("proj", { key: "k" });
    assert.equal(junk.calls.filter((c) => isAction(c.url)).length, 1);
  });

  it("fails open: an unreachable capabilities endpoint is a transport error, never a gate error", async () => {
    // A capabilities fetch that cannot answer still blocks the write — that is
    // upstream's ensureCapability behavior for every munin_* call, not the
    // gate's. What must NOT happen is the gate inventing ERR_CLIENT_OUTDATED.
    const { calls, impl } = makeFetch((url) =>
      isAction(url) ? json({ ok: true, data: {} }) : Promise.reject(new Error("boom")));
    const client = new MuninClient({ baseUrl: "https://munin.test", apiKey: "k", fetchImpl: impl, writeQueue: false });

    await assert.rejects(client.store("proj", { key: "k" }), (e: unknown) => {
      const err = e as Error & { code?: string };
      return err instanceof MuninTransportError && err.code === undefined && /capabilities endpoint/.test(err.message);
    });
    assert.equal(calls.filter((c) => isAction(c.url)).length, 0);
  });
});
