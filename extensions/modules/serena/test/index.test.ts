/**
 * Unit tests for pi-serena detection logic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isReadOnlyWorkerAction, shouldRetryAfterTimeout } from "../index";
import {
  pathLooksLikeCode,
  pathLooksNonSemantic,
  commandLooksLikeSemanticCodeSearch,
} from "../lib/detect";
import { SERENA_FIRST_GUIDANCE, SERENA_MISS_GUIDANCE, isSerenaActive, shouldBlockSemanticMiss } from "../lib/guidance";
import { normalizeTimeoutMs, stripControlParams } from "../lib/normalize";
import { repairSymbolNameKey } from "../lib/symbol-key";
import { truncateText, OUTPUT_MAX_LINES, OUTPUT_MAX_BYTES } from "../lib/truncate";

describe("truncateText", () => {
  it("passes short text through unchanged", () => {
    assert.strictEqual(truncateText("short output"), "short output");
  });

  it("appends the marker when input exceeds the line cap", () => {
    const text = Array.from({ length: OUTPUT_MAX_LINES + 1 }, (_, i) => `line ${i}`).join("\n");
    const out = truncateText(text);
    assert.ok((out).includes("[Serena output truncated to"));
    assert.ok(out.split("\n").length <= OUTPUT_MAX_LINES + 3);
  });

  it("appends the marker when input exceeds the byte cap, splitting on a multi-byte boundary without lone surrogates", () => {
    // 3-byte chars: 51,200 % 3 ≠ 0, so the naive byte cut lands mid-character.
    const text = Array.from({ length: OUTPUT_MAX_LINES + 500 }, () => "日".repeat(30)).join("\n");
    const out = truncateText(text);
    assert.ok((out).includes("[Serena output truncated to"));
    for (const ch of out) {
      const cp = ch.codePointAt(0)!;
      assert.ok(!((cp) >= 0xd800 && (cp) <= 0xdfff));
    }
    assert.ok(!(out).includes("\uFFFD"));
  });
});

describe("Serena tool-selection guidance", () => {
  it("uses procedural Serena-first wording", () => {
    const guidance = SERENA_FIRST_GUIDANCE;
    assert.ok((guidance).includes("before reading whole code files"));
    assert.ok((guidance).includes("serena_get_symbols_overview"));
    assert.ok((guidance).includes("serena_find_symbol"));
    assert.ok((guidance).includes("Use read/grep/find for docs, configs, non-code files"));
  });

  it("detects strict-mode semantic misses for code reads and code searches", () => {
    assert.ok(shouldBlockSemanticMiss("read", { path: "src/index.ts" }));
    assert.ok(shouldBlockSemanticMiss("bash", { command: "rg 'class Foo' src/**/*.ts" }));
  });

  it("permits docs/config/non-code reads", () => {
    assert.ok(!(shouldBlockSemanticMiss("read", { path: "README.md" })));
    assert.ok(!(shouldBlockSemanticMiss("read", { path: "package.json" })));
    assert.ok(!(shouldBlockSemanticMiss("bash", { command: "rg 'install' README.md" })));
  });

  it("does not count --include/--exclude glob flags as searched code files", () => {
    assert.ok(!(commandLooksLikeSemanticCodeSearch('grep -rn "todo" --include="*.md" --include="*.ts" docs/')));
    assert.ok(!(commandLooksLikeSemanticCodeSearch("rg -g '*.ts' 'todo' docs/")));
  });
});

describe("isSerenaActive", () => {
  it("is true when the active tool list contains serena_find_symbol", () => {
    assert.ok(isSerenaActive(["read", "serena_find_symbol", "bash"]));
  });

  it("is false without serena_find_symbol in the list", () => {
    assert.ok(!(isSerenaActive(["read", "bash"])));
    assert.ok(!(isSerenaActive([])));
  });

  it("is false for undefined or non-array input", () => {
    assert.ok(!(isSerenaActive(undefined)));
    assert.ok(!(isSerenaActive("serena_find_symbol" as unknown as string[])));
  });
});

describe("handler wiring", () => {
  // Fake ExtensionAPI that records handlers; getActiveTools is the live registry
  // the gates must read (regression: systemPromptOptions.selectedTools never
  // contains extension-registered tools, so the guidance never fired).
  function fakePi(activeTools: string[] | undefined) {
    const handlers = new Map<string, Array<(event: any) => unknown>>();
    const pi: any = {
      on: (name: string, fn: (event: any) => unknown) => {
        handlers.set(name, [...(handlers.get(name) ?? []), fn]);
      },
      registerTool: () => {},
      registerCommand: () => {},
      getActiveTools: () => activeTools,
    };
    const fire = async (name: string, event: any) => {
      let out: unknown;
      for (const fn of handlers.get(name) ?? []) out = await fn(event);
      return out;
    };
    return { pi, fire };
  }

  it("before_agent_start appends guidance when serena tools are active", async () => {
    const { pi, fire } = fakePi(["read", "serena_find_symbol", "bash"]);
    const mod = await import("../index");
    mod.default(pi);
    const result = await fire("before_agent_start", { systemPrompt: "base" });
    assert.ok(((result as any).systemPrompt).includes(SERENA_FIRST_GUIDANCE));
  });

  it("before_agent_start does not append guidance without serena tools", async () => {
    const { pi, fire } = fakePi(["read", "bash"]);
    const mod = await import("../index");
    mod.default(pi);
    const result = await fire("before_agent_start", { systemPrompt: "base" });
    assert.strictEqual(result, undefined);
  });
});

describe("repairSymbolNameKey", () => {
  it("rewrites name_path -> name_path_pattern for pattern-key tools (find_symbol, safe_delete)", () => {
    assert.deepStrictEqual(repairSymbolNameKey({ name_path: "Foo", relative_path: "a.ts" }, true), { name_path_pattern: "Foo", relative_path: "a.ts" });
  });

  it("rewrites name_path_pattern -> name_path for the name_path tools", () => {
    assert.deepStrictEqual(repairSymbolNameKey({ name_path_pattern: "Foo", relative_path: "a.ts" }, false), { name_path: "Foo", relative_path: "a.ts" });
  });

  it("is a no-op when the expected key is already present", () => {
    assert.deepStrictEqual(repairSymbolNameKey({ name_path_pattern: "X" }, true), { name_path_pattern: "X" });
    assert.deepStrictEqual(repairSymbolNameKey({ name_path: "X", relative_path: "." }, false), { name_path: "X", relative_path: "." });
  });

  it("passes non-objects through unchanged", () => {
    assert.strictEqual(repairSymbolNameKey(undefined, true), undefined);
    assert.deepStrictEqual(repairSymbolNameKey([1, 2], false), [1, 2]);
  });
});

// ponytail: .spec.ts/.test.ts etc are covered by .ts — see pathLooksLikeCode uses lastIndexOf(".")
describe("pathLooksLikeCode", () => {
  const codeCases = [
    ["src/index.ts", ".ts"],
    ["src/main.py", ".py"],
    ["src/main.go", ".go"],
    ["src/app.js", ".js"],
    ["src/Component.tsx", ".tsx"],
    ["src/Component.jsx", ".jsx"],
    ["src/Component.spec.ts", ".spec.ts (covered by .ts)"],
    ["src/util.test.ts", ".test.ts (covered by .ts)"],
    ["some-module.cjs", ".cjs"],
  ];
  for (const [path, label] of codeCases) {
    it(`returns true for ${label}`, () => {
      assert.ok(pathLooksLikeCode(path));
    });
  }

  it("returns false for empty string", () => {
    assert.ok(!(pathLooksLikeCode("")));
  });

  it("returns false for non-string values", () => {
    assert.ok(!(pathLooksLikeCode(null)));
    assert.ok(!(pathLooksLikeCode(undefined)));
    assert.ok(!(pathLooksLikeCode(42)));
  });

  it("returns false for blank path", () => {
    assert.ok(!(pathLooksLikeCode("  ")));
  });

  it("ignores query strings", () => {
    assert.ok(pathLooksLikeCode("src/index.ts?foo=bar"));
  });

  it("ignores fragment identifiers", () => {
    assert.ok(pathLooksLikeCode("src/index.ts#L42"));
  });
});

describe("pathLooksNonSemantic", () => {
  const nonSemCases = [
    ["README.md", ".md"],
    ["package.json", ".json"],
    [".serena/project.yml", ".yml"],
    ["notes.txt", ".txt"],
    ["data.csv", ".csv"],
    ["server.log", ".log"],
    [".env", ".env"],
    ["config.toml", ".toml"],
    [".editorconfig", ".editorconfig"],
    [".gitignore", ".gitignore"],
  ];
  for (const [path, label] of nonSemCases) {
    it(`returns true for ${label}`, () => {
      assert.ok(pathLooksNonSemantic(path));
    });
  }

  it("returns false for .ts source files", () => {
    assert.ok(!(pathLooksNonSemantic("src/index.ts")));
  });

  it("returns false for .py source files", () => {
    assert.ok(!(pathLooksNonSemantic("src/main.py")));
  });
});

describe("commandLooksLikeSemanticCodeSearch", () => {
  const trueCases = [
    "grep -r 'class Foo' src/",
    "rg 'function validate' src/",
    "grep -rn 'def run' src/",
    "rg 'references' src/ --type ts",
    "find . -name '*.ts' | xargs grep 'interface'",
    "rg 'doSomething' src/**/*.ts",
    "grep 'error' *.py",
  ];
  for (const cmd of trueCases) {
    it(`returns true for: ${cmd}`, () => {
      assert.ok(commandLooksLikeSemanticCodeSearch(cmd));
    });
  }

  const falseCases = [
    ["ls -la", "no rg/grep/fd/find"],
    ["cat file.ts", "no rg/grep/fd/find"],
    ["node script.js", "no rg/grep/fd/find"],
    ["rg 'TODO' AGENTS.md", "non-code target"],
    ["grep 'version' package.json", "non-code target"],
    ["grep 'description' SKILL.md", "non-code target"],
    ["rg 'install' README.md", "non-code target"],
    ["grep 'name' package.json", "non-code target"],
    ["rg 'TODO' src/", "TODO pattern"],
    ["grep -rn 'FIXME' src/", "TODO pattern"],
    ["rg 'HACK' src/", "HACK pattern"],
    ["grep 'NOTE' src/", "NOTE pattern"],
    ["rg 'XXX' src/", "XXX pattern"],
    ["grep -r 'BUG' src/", "BUG pattern"],
    ["rg 'WORKAROUND' src/", "WORKAROUND pattern"],
    ["rg 'TODO.*method' src/", "TODO still triggers exclusion"],
  ];
  for (const [cmd, label] of falseCases) {
    it(`returns false for ${label}: ${cmd}`, () => {
      assert.ok(!(commandLooksLikeSemanticCodeSearch(cmd)));
    });
  }
});

describe("normalizeTimeoutMs", () => {
  it("returns undefined for non-number non-string", () => {
    assert.strictEqual(normalizeTimeoutMs(null), undefined);
    assert.strictEqual(normalizeTimeoutMs(undefined), undefined);
    assert.strictEqual(normalizeTimeoutMs(true), undefined);
    assert.strictEqual(normalizeTimeoutMs({}), undefined);
  });

  it("returns undefined for <= 0 numbers", () => {
    assert.strictEqual(normalizeTimeoutMs(0), undefined);
    assert.strictEqual(normalizeTimeoutMs(-1), undefined);
  });

  it("returns the number for positive finite numbers", () => {
    assert.strictEqual(normalizeTimeoutMs(5000), 5000);
    assert.strictEqual(normalizeTimeoutMs(120000), 120000);
  });

  it("parses numeric strings", () => {
    assert.strictEqual(normalizeTimeoutMs("5000"), 5000);
    assert.strictEqual(normalizeTimeoutMs("120000"), 120000);
  });

  it("returns undefined for non-numeric strings", () => {
    assert.strictEqual(normalizeTimeoutMs("abc"), undefined);
    assert.strictEqual(normalizeTimeoutMs(""), undefined);
    assert.strictEqual(normalizeTimeoutMs("0"), undefined);
    assert.strictEqual(normalizeTimeoutMs("-5"), undefined);
  });

  it("returns Infinity for Infinity", () => {
    assert.strictEqual(normalizeTimeoutMs(Infinity), undefined);
  });
});

describe("stripControlParams", () => {
  it("extracts control params and leaves tool params", () => {
    const result = stripControlParams({ project: "/p", context: "c", timeout_ms: 5000, relative_path: "src/index.ts" });
    assert.deepStrictEqual(result, { project: "/p", context: "c", timeoutMs: 5000, params: { relative_path: "src/index.ts" } });
  });

  it("pattern is removed when renamed to substring_pattern", () => {
    // This mirrors the search_for_pattern execute handler's mapping logic.
    const params: Record<string, unknown> = { pattern: "foo", relative_path: "src/" };
    if (params.pattern) {
      params.substring_pattern = params.pattern;
      delete params.pattern;
    }
    assert.strictEqual((params as any)["substring_pattern"], "foo");
    assert.ok(params == null || !Object.prototype.hasOwnProperty.call(params, "pattern"));
    assert.strictEqual((params as any)["relative_path"], "src/");
  });
});

describe("read-only retry gate", () => {
  it("classifies read-only actions and mutators", () => {
    assert.ok(isReadOnlyWorkerAction("call", { tool: "find_symbol" }));
    assert.ok(isReadOnlyWorkerAction("call", { tool: "get_symbols_overview" }));
    assert.ok(isReadOnlyWorkerAction("find_declaration"));
    assert.ok(isReadOnlyWorkerAction("get_diagnostics_for_file"));
    assert.ok(isReadOnlyWorkerAction("config"));
    assert.ok(isReadOnlyWorkerAction("status"));
    assert.ok(!(isReadOnlyWorkerAction("call", { tool: "replace_symbol_body" })));
    assert.ok(!(isReadOnlyWorkerAction("call", { tool: "insert_before_symbol" })));
    assert.ok(!(isReadOnlyWorkerAction("call", { tool: "rename_symbol" })));
    assert.ok(!(isReadOnlyWorkerAction("call", { tool: "safe_delete_symbol" })));
    assert.ok(!(isReadOnlyWorkerAction("call", { tool: "replace_content" })));
    assert.ok(!(isReadOnlyWorkerAction("restart_language_server")));
    assert.ok(!(isReadOnlyWorkerAction("onboarding")));
  });

  it("shouldRetryAfterTimeout: read-only tools retry on thrown timeout-class errors", () => {
    assert.ok(shouldRetryAfterTimeout("find_symbol", {}, { errorMessage: "Request timed out after 10ms" }));
    assert.ok(shouldRetryAfterTimeout("call", { tool: "get_symbols_overview" }, { errorMessage: "worker killed due to timeout" }));
    // non-timeout errors never retry
    assert.ok(!(shouldRetryAfterTimeout("find_symbol", {}, { errorMessage: "unrelated failure" })));
  });

  it("shouldRetryAfterTimeout: mutators NEVER retry (may have applied before the kill)", () => {
    assert.ok(!(shouldRetryAfterTimeout("rename_symbol", {}, { errorMessage: "Request timed out after 10ms" })));
    assert.ok(!(shouldRetryAfterTimeout("call", { tool: "safe_delete_symbol" }, { errorMessage: "worker exited unexpectedly" })));
    assert.ok(!(shouldRetryAfterTimeout("replace_content", {}, { errorMessage: "Request timed out after 10ms" })));
  });

  it("shouldRetryAfterTimeout: thrown timeout-class errors retry only for read-only actions", () => {
    for (const msg of ["Request timed out after 10ms", "worker killed due to timeout", "worker exited unexpectedly", "worker restarted"]) {
      assert.ok(shouldRetryAfterTimeout("search_for_pattern", {}, { errorMessage: msg }), msg);
      assert.notStrictEqual(shouldRetryAfterTimeout("insert_before_symbol", {}, { errorMessage: msg }), true, msg);
    }
    assert.ok(!(shouldRetryAfterTimeout("find_symbol", {}, { errorMessage: "unrelated failure" })));
  });
});

