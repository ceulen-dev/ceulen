// Ported from @bacnh85/pi-munin 0.5.12 extensions/test/unit/helpers.test.ts
// (mocha/chai → node:test). loadEnv/piConfigDirs suites dropped — those
// helpers were replaced by ceulen's bundle env.ts; config.test.ts covers the
// settings.json-based getMuninConfig instead.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getMuninConfig,
  parseTags,
  validateMemoryTags,
  validateMemoryKey,
  validateSearchQuery,
  validateTagMode,
  classifyError,
  sanitizeErrorMessage,
  formatMemory,
  formatMemories,
  formatCapabilities,
  truncateText,
  normalizeMemory,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_LINES,
} from "../lib/helpers.js";

const CONFIG_ENV_KEYS = ["MUNIN_API_KEY", "MUNIN_PROJECT", "MUNIN_BASE_URL"] as const;

describe("getMuninConfig (env layer)", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = Object.fromEntries(CONFIG_ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of CONFIG_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of CONFIG_ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it("keeps first-file precedence semantics via process.env (bundle env.ts contract)", () => {
    process.env.MUNIN_API_KEY = "local-key";
    process.env.MUNIN_PROJECT = "local-project";
    const cfg = getMuninConfig({}, "/nonexistent-project", false);
    assert.equal(cfg.apiKey, "local-key");
    assert.equal(cfg.projectId, "local-project");
    assert.equal(cfg.sources.apiKey, "env");
  });

  it("does not pair an ambient key with an endpoint override", () => {
    process.env.MUNIN_API_KEY = "ambient-key";
    process.env.MUNIN_PROJECT = "ambient-project";
    assert.throws(() => getMuninConfig({ base_url: "https://example.test" }), /explicit api_key/);
    const cfg = getMuninConfig({ base_url: "https://example.test/api/", api_key: "explicit-key" });
    assert.deepEqual(
      { apiKey: cfg.apiKey, projectId: cfg.projectId, baseUrl: cfg.baseUrl },
      { apiKey: "explicit-key", projectId: "ambient-project", baseUrl: "https://example.test/api" },
    );
  });

  it("validates endpoint URLs", () => {
    process.env.MUNIN_API_KEY = "key";
    process.env.MUNIN_PROJECT = "project";
    for (const base_url of ["not a url", "ftp://example.test", "https://user:pass@example.test", "https://example.test?q=1"]) {
      assert.throws(() => getMuninConfig({ base_url, api_key: "explicit-key" }), /Munin base URL/);
    }
  });

  it("reports missing key/project with config pointers", () => {
    assert.throws(() => getMuninConfig({}, "/tmp", false), /\/config → Memory/);
    process.env.MUNIN_API_KEY = "key";
    assert.throws(() => getMuninConfig({}, "/tmp", false), /Munin project is not configured/);
  });

  it("falls back to the default base URL", () => {
    process.env.MUNIN_API_KEY = "key";
    process.env.MUNIN_PROJECT = "project";
    const cfg = getMuninConfig({}, "/tmp", false);
    assert.equal(cfg.baseUrl, "https://munin.kalera.ai");
    assert.equal(cfg.sources.baseUrl, "default");
  });
});

describe("parseTags", () => {
  it("parses comma-separated string", () => {
    assert.deepEqual(parseTags("type:fact,domain:memory"), [
      "type:fact",
      "domain:memory",
    ]);
  });

  it("trims whitespace", () => {
    assert.deepEqual(parseTags(" type:fact , domain:memory "), [
      "type:fact",
      "domain:memory",
    ]);
  });

  it("handles array input", () => {
    assert.deepEqual(parseTags(["type:fact", "domain:memory"]), [
      "type:fact",
      "domain:memory",
    ]);
  });

  it("filters empty values", () => {
    assert.deepEqual(parseTags("type:fact,,domain:memory"), [
      "type:fact",
      "domain:memory",
    ]);
  });

  it("returns empty array for falsy input", () => {
    assert.deepEqual(parseTags(null), []);
    assert.deepEqual(parseTags(undefined), []);
    assert.deepEqual(parseTags(""), []);
  });

  it("coerces non-string array items", () => {
    assert.deepEqual(parseTags(["type:fact", 123]), ["type:fact", "123"]);
  });
});

describe("validateMemoryTags", () => {
  it("accepts valid tags with type: and domain:", () => {
    const result = validateMemoryTags("type:fact,domain:memory");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.tags, ["type:fact", "domain:memory"]);
    }
  });

  it("rejects tags without type:", () => {
    assert.equal(validateMemoryTags("domain:memory,other").ok, false);
  });

  it("rejects tags without domain:", () => {
    assert.equal(validateMemoryTags("type:fact,other").ok, false);
  });

  it("rejects empty tags", () => {
    assert.equal(validateMemoryTags("").ok, false);
  });

  it("accepts array input", () => {
    assert.equal(validateMemoryTags(["type:fact", "domain:memory"]).ok, true);
  });
});

describe("validateMemoryKey", () => {
  it("accepts valid keys", () => {
    assert.equal(validateMemoryKey("my-key"), "my-key");
    assert.equal(validateMemoryKey("category/sub/key"), "category/sub/key");
    assert.equal(validateMemoryKey("auth-refresh-token"), "auth-refresh-token");
    assert.equal(validateMemoryKey("a"), "a");
  });

  it("rejects empty key", () => {
    assert.throws(() => validateMemoryKey(""), /non-empty string/);
  });

  it("rejects whitespace-only key", () => {
    assert.throws(() => validateMemoryKey("   "), /whitespace/);
  });

  it("normalizes invalid characters instead of throwing", () => {
    // Version stamps in keys were the top store-failure family (session mining)
    assert.equal(validateMemoryKey("pi-a2a/gateway-token-hardening-0.6.2"), "pi-a2a/gateway-token-hardening-0-6-2");
    assert.equal(validateMemoryKey("pi/0.84.2-compat-and-glm-5.3"), "pi/0-84-2-compat-and-glm-5-3"); // / preserved
    assert.equal(validateMemoryKey("deepseek-tools/readme-env-cleanup-0.9.2"), "deepseek-tools/readme-env-cleanup-0-9-2");
    // Legacy-legal keys (incl. consecutive hyphens) pass through unchanged
    assert.equal(validateMemoryKey("auth--refresh--token"), "auth--refresh--token");
    // Degenerate results (no alphanumerics) are rejected, not collapsed to "-"
    assert.throws(() => validateMemoryKey("..."), /alphanumeric/);
    // Store and lookup must derive the same normalized key (round-trip)
    assert.equal(validateMemoryKey(validateMemoryKey("pi-plan/v0.4.3-lifecycle-rewrite")), validateMemoryKey("pi-plan/v0.4.3-lifecycle-rewrite"));
  });

  it("rejects keys over 200 chars", () => {
    const long = "a".repeat(201);
    assert.throws(() => validateMemoryKey(long), /200/);
  });

  it("rejects non-string", () => {
    assert.throws(() => validateMemoryKey(null), /non-empty string/);
    assert.throws(() => validateMemoryKey(123), /non-empty string/);
  });
});

describe("validateSearchQuery", () => {
  it("accepts valid queries", () => {
    assert.equal(validateSearchQuery("test"), "test");
    assert.equal(validateSearchQuery("  hello  "), "hello");
  });

  it("rejects empty query", () => {
    assert.throws(() => validateSearchQuery(""), /non-empty/);
    assert.throws(() => validateSearchQuery("   "), /whitespace/);
  });

  it("rejects non-string", () => {
    assert.throws(() => validateSearchQuery(null), /non-empty/);
  });
});

describe("validateTagMode", () => {
  it("accepts all and any", () => {
    assert.equal(validateTagMode("all"), "all");
    assert.equal(validateTagMode("any"), "any");
  });

  it("passes through absent values (server default applies)", () => {
    assert.equal(validateTagMode(undefined), undefined);
    assert.equal(validateTagMode(null), undefined);
    assert.equal(validateTagMode(""), undefined);
  });

  it("rejects anything else naming the valid values", () => {
    assert.throws(() => validateTagMode("either"), /Invalid tag_mode "either"\. Valid values: "all" \(default\), "any"/);
    assert.throws(() => validateTagMode(1), /Valid values/);
  });
});

describe("classifyError", () => {
  it("classifies auth errors", () => {
    assert.equal(classifyError(new Error("Unauthorized access")).type, "auth");
    assert.equal(classifyError(new Error("invalid API key")).type, "auth");
  });

  it("classifies e2ee errors", () => {
    assert.equal(classifyError(new Error("E2EE encryption failed")).type, "e2ee");
  });

  it("classifies stale protocol errors", () => {
    assert.equal(classifyError(new Error("Stale protocol detected")).type, "stale_protocol");
  });

  it("classifies ERR_STALE_PROTOCOL errors", () => {
    assert.equal(classifyError(new Error("ERR_STALE_PROTOCOL")).type, "stale_protocol");
  });

  it("classifies not found errors", () => {
    assert.equal(classifyError(new Error("Memory not found")).type, "not_found");
  });

  it("classifies timeout errors", () => {
    assert.equal(classifyError(new Error("Request timeout")).type, "timeout");
    assert.equal(classifyError(new Error("ETIMEDOUT")).type, "timeout");
  });

  it("classifies network errors", () => {
    assert.equal(classifyError(new Error("Network error")).type, "network");
    assert.equal(classifyError(new Error("ECONNREFUSED")).type, "network");
    assert.equal(classifyError(new Error("socket hang up")).type, "network");
  });

  it("classifies unknown errors", () => {
    assert.equal(classifyError(new Error("Something weird happened")).type, "unknown");
  });

  it("uses structured SDK error codes and names", () => {
    const cases = [
      ["AUTH_INVALID", "auth"],
      ["VALIDATION_ERROR", "validation"],
      ["FEATURE_DISABLED", "feature_disabled"],
      ["RATE_LIMITED", "rate_limit"],
      ["ERR_STALE_PROTOCOL", "stale_protocol"],
      ["NOT_FOUND", "not_found"],
    ] as const;
    for (const [code, type] of cases) {
      assert.equal(classifyError(Object.assign(new Error(code), { code })).type, type);
    }
    assert.equal(classifyError(Object.assign(new Error("fetch failed"), { name: "MuninTransportError" })).type, "network");
    assert.equal(classifyError(Object.assign(new Error("aborted"), { name: "AbortError" })).type, "timeout");
  });

  it("handles non-Error input", () => {
    assert.equal(classifyError("string error").type, "unknown");
  });
});

describe("sanitizeErrorMessage", () => {
  it("redacts MUNIN_API_KEY in message", () => {
    const result = sanitizeErrorMessage(
      new Error("MUNIN_API_KEY=secret123"),
    );
    assert.match(result, /\[REDACTED\]/);
    assert.doesNotMatch(result, /secret123/);
  });

  it("passes through normal messages unchanged", () => {
    assert.equal(sanitizeErrorMessage(new Error("Normal error message")), "Normal error message");
  });

  it("redacts Bearer tokens", () => {
    const result = sanitizeErrorMessage(new Error("Request failed: Bearer mun_sk_123.abc-def_456 rejected"));
    assert.match(result, /Bearer \[REDACTED\]/);
    assert.doesNotMatch(result, /mun_sk_123/);
  });

  it("redacts apiKey= and api_key: literals", () => {
    for (const msg of ['apiKey=hunter2secret', "api_key: 'abc123.xyz'", "API_KEY=zzzz"]) {
      const result = sanitizeErrorMessage(new Error(`auth failed with ${msg}`));
      assert.match(result, /\[REDACTED\]/);
      assert.doesNotMatch(result, /hunter2secret/);
      assert.doesNotMatch(result, /abc123/);
    }
  });
});

describe("formatMemory", () => {
  it("formats a complete memory", () => {
    const result = formatMemory({
      key: "my-key",
      title: "My Title",
      content: "Some content",
      tags: ["type:fact", "domain:memory"],
    });
    assert.match(result, /Key: my-key/);
    assert.match(result, /Title: My Title/);
    assert.match(result, /Tags: type:fact, domain:memory/);
    assert.match(result, /Content:\nSome content/);
  });

  it("does not show ID when same as key", () => {
    const result = formatMemory({ key: "my-key", id: "my-key" });
    assert.match(result, /Key: my-key/);
    assert.doesNotMatch(result, /ID:/);
  });

  it("shows ID when different from key", () => {
    const result = formatMemory({ key: "my-key", id: "different-id" });
    assert.match(result, /ID: different-id/);
  });

  it("handles empty memory", () => {
    assert.equal(formatMemory({}), "");
  });

  it("handles content from text/body/value fallbacks", () => {
    assert.match(formatMemory({ text: "Hello" }), /Content:\nHello/);
    assert.match(formatMemory({ body: "Body text" }), /Content:\nBody text/);
    assert.match(formatMemory({ value: "Value text" }), /Content:\nValue text/);
  });

  it("prefers content over fallbacks", () => {
    const result = formatMemory({ content: "primary", text: "fallback" });
    assert.match(result, /Content:\nprimary/);
    assert.doesNotMatch(result, /fallback/);
  });

  it("handles updated/updatedAt and created/createdAt", () => {
    const result = formatMemory({
      key: "k",
      updatedAt: "2024-01-01",
      created: "2023-01-01",
    });
    assert.match(result, /Updated: 2024-01-01/);
    assert.match(result, /Created: 2023-01-01/);
  });
});

describe("formatMemories", () => {
  it("returns 'No memories found' for empty array", () => {
    assert.equal(formatMemories({ data: [] }), "No memories found.");
    assert.equal(formatMemories({ items: [] }), "No memories found.");
  });

  it("formats a single memory", () => {
    const result = formatMemories({ data: { key: "k", content: "c" } });
    assert.match(result, /Key: k/);
    assert.match(result, /Content:\nc/);
  });

  it("formats multiple memories", () => {
    const result = formatMemories({
      data: [
        { key: "a", title: "A" },
        { key: "b", title: "B" },
      ],
    });
    assert.match(result, /--- Memory 1 ---/);
    assert.match(result, /--- Memory 2 ---/);
    assert.match(result, /Key: a/);
    assert.match(result, /Key: b/);
  });

  it("preserves search scores and totals", () => {
    const result = formatMemories({
      data: { memories: [{ memory: { key: "a" }, score: 0.91 }], total: 42 },
    });
    assert.match(result, /Score: 0.91/);
    assert.match(result, /Total: 42/);
  });

  it("handles result wrapper", () => {
    assert.match(formatMemories({ result: { key: "k" } }), /Key: k/);
  });

  it("handles items wrapper", () => {
    assert.match(formatMemories({ items: [{ key: "k" }] }), /Key: k/);
  });

  it("handles search response shape (data.memories nested array)", () => {
    const result = formatMemories({
      data: {
        memories: [
          { key: "s1", title: "Search 1" },
          { key: "s2", title: "Search 2" },
        ],
      },
    });
    assert.match(result, /--- Memory 1 ---/);
    assert.match(result, /--- Memory 2 ---/);
    assert.match(result, /Key: s1/);
    assert.match(result, /Key: s2/);
    assert.match(result, /Search 1/);
    assert.match(result, /Search 2/);
  });

  it("handles data.memories with single item", () => {
    const result = formatMemories({
      data: { memories: [{ key: "single", title: "Only One" }] },
    });
    assert.match(result, /Key: single/);
    assert.match(result, /Only One/);
  });

  it("handles data.memories empty array", () => {
    assert.equal(formatMemories({ data: { memories: [] } }), "No memories found.");
  });

  it("handles non-object input", () => {
    assert.equal(formatMemories(undefined), "undefined");
    assert.equal(formatMemories(null), "null");
    assert.equal(formatMemories("string"), "string");
  });
});

describe("normalizeMemory", () => {
  it("unwraps { memory } wrapper or passes through plain objects", () => {
    const wrapped = normalizeMemory({ memory: { key: "k", content: "c" }, score: 0.95 });
    assert.equal(wrapped.key, "k");
    assert.equal(wrapped.score, 0.95);
    assert.equal(normalizeMemory({ key: "k" }).key, "k");
    assert.deepEqual(normalizeMemory(null), {});
    assert.deepEqual(normalizeMemory(undefined), {});
  });
});

describe("truncateText", () => {
  it("returns text as-is when under limits", () => {
    assert.equal(truncateText("hello"), "hello");
  });

  it("truncates when over line limit", () => {
    const lines = Array.from({ length: OUTPUT_MAX_LINES + 10 }, (_, i) => `line ${i}`);
    const text = lines.join("\n");
    const result = truncateText(text);
    assert.match(result, /\[Munin output truncated:/);
  });

  it("truncates when over byte limit", () => {
    // Create a string just over the byte limit
    const longLine = "x".repeat(OUTPUT_MAX_BYTES + 100);
    const result = truncateText(longLine);
    assert.ok(Buffer.byteLength(result, "utf8") <= OUTPUT_MAX_BYTES + 1024);
  });

  it("truncates UTF-8 output only at complete lines", () => {
    const result = truncateText("🙂🙂🙂\n".repeat(OUTPUT_MAX_LINES + 1));
    assert.match(result, /\[Munin output truncated:/);
    assert.doesNotMatch(result, /\uFFFD/);
  });

  it("does not add truncation notice when exact", () => {
    assert.doesNotMatch(truncateText("hello"), /truncated/);
  });
});

describe("formatCapabilities", () => {
  it("formats complete capabilities", () => {
    const result = formatCapabilities({
      specVersion: "v1.0.0",
      actions: {
        core: ["store", "list"],
        optional: ["encrypt", "decrypt"],
      },
      features: {
        semanticSearch: { supported: true },
      },
      metadata: { serverVersion: "1.5.0" },
    });
    assert.match(result, /--- Munin Server Capabilities ---/);
    assert.match(result, /Spec Version: v1.0.0/);
    assert.match(result, /Server Version: 1.5.0/);
    assert.match(result, /Core Actions: store, list/);
    assert.match(result, /Optional Actions: encrypt, decrypt/);
    assert.match(result, /Features: semanticSearch/);
  });

  it("handles missing optional sections", () => {
    const result = formatCapabilities({ specVersion: "v1.0.0", actions: { core: ["store"] } });
    assert.match(result, /Core Actions: store/);
    assert.doesNotMatch(result, /Optional Actions/);
    assert.doesNotMatch(result, /Features/);
    assert.doesNotMatch(result, /Server Version/);
  });

  it("handles empty object", () => {
    assert.equal(formatCapabilities({}), "--- Munin Server Capabilities ---");
  });

  it("handles unknown features with unsupported status", () => {
    const result = formatCapabilities({
      features: { experimental: { supported: false } },
    });
    assert.match(result, /experimental/);
    assert.match(result, /✗/);
  });
});
