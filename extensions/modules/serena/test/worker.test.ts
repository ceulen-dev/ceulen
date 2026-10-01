/**
 * Unit tests for SerenaWorkerClient protocol parsing and lifecycle.
 * Uses mocked child_process to avoid actual Python dependency.
 */

import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SerenaWorkerClient, JB_TOOL_MAP, JB_DROP_PARAMS, JB_PARAM_RENAMES } from "../worker";

function createMockProcess(onWrite?: (data: string) => void): any {
  const mockStdout = new EventEmitter() as any;
  const mockStderr = new EventEmitter() as any;
  const mockStdin = {
    write: (data: string) => {
      onWrite?.(String(data));
      // Auto-respond to shutdown requests so stop() doesn't hang
      let parsed: any;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return true;
      }
      if (parsed.action === "shutdown") {
        setTimeout(() => {
          mockStdout.emit("data", JSON.stringify({ id: String(parsed.id), ok: true, shutdown: true }) + "\n");
        }, 1);
      }
      return true;
    },
  } as any;
  const proc: any = {
    stdout: mockStdout,
    stderr: mockStderr,
    stdin: mockStdin,
    killed: false,
    pid: 99999,
    kill: () => {
      proc.killed = true;
    },
    on: (event: string, handler: (...args: any[]) => void) => {
      if (event === "exit") proc._exitHandler = handler;
    },
    _exitHandler: null as ((code: number | null, signal: string | null) => void) | null,
  };
  return proc;
}

/**
 * Create a worker whose internal process is set to a mock.
 * The onStdout and exit handlers are manually attached because
 * ensureStarted() is bypassed (process already exists).
 */
function createMockedWorker(): {
  worker: SerenaWorkerClient;
  mockStdout: EventEmitter;
  mockStdin: { write: (...args: any[]) => boolean };
  mockProcess: any;
} {
  const worker = new SerenaWorkerClient();

  function installMockProcess(): any {
    const proc = createMockProcess();
    (worker as any).process = proc;
    const onStdout = (worker as any).onStdout.bind(worker);
    proc.stdout.on("data", (chunk: string) => onStdout(chunk));
    proc.on("exit", (code: number | null, signal: string | null) => {
      if ((worker as any).process === proc) {
        (worker as any).process = undefined;
      }
      (worker as any).failAll(new Error(`Serena worker exited code=${code} signal=${signal}`));
    });
    return proc;
  }

  const mockProcess = installMockProcess();
  (worker as any).ensureStarted = () => {
    if (!(worker as any).process || (worker as any).process.killed) installMockProcess();
  };

  (worker as any).buffer = "";
  (worker as any).nextId = 1;
  (worker as any).pending = new Map();
  (worker as any).generation = 0;

  return { worker, mockStdout: mockProcess.stdout, mockStdin: mockProcess.stdin, mockProcess };
}

// Mirrors resolve_jb_tool_call in the Python bridge (worker.ts PYTHON_BRIDGE),
// which is built from the same exported tables via JSON interpolation.
function resolveJbToolCall(toolName: string, params: Record<string, unknown>): { name: string; params: Record<string, unknown> } {
  const jbName = JB_TOOL_MAP[toolName] ?? toolName;
  const mapped: Record<string, unknown> = { ...params };
  for (const [renameFrom, renameTo] of Object.entries(JB_PARAM_RENAMES[jbName] ?? {})) {
    if (renameFrom in mapped) {
      mapped[renameTo] = mapped[renameFrom];
      delete mapped[renameFrom];
    }
  }
  for (const drop of JB_DROP_PARAMS[jbName] ?? []) {
    delete mapped[drop];
  }
  return { name: jbName, params: mapped };
}

// Mirrors _jb_pick_unique_symbol in the Python bridge (worker.ts PYTHON_BRIDGE):
// find_symbol matches name-path *patterns*, so multiple symbols may match; only a
// single match or exactly one exact name-path match is accepted.
function jbPickUniqueSymbol(symbols: Array<{ name_path?: string }>, namePath: string): { name_path?: string } | null {
  if (!symbols || symbols.length === 0) return null;
  if (symbols.length === 1) return symbols[0]!;
  const suffix = "/" + namePath;
  const exact = symbols.filter((s) => s.name_path === namePath || (s.name_path ?? "").endsWith(suffix));
  return exact.length === 1 ? exact[0]! : null;
}

// Mirrors _jb_is_declaration_position_error in the Python bridge: the JetBrains
// plugin reports declarations-at-position with varying wording; match tolerantly.
function jbIsDeclarationPositionError(result: string): boolean {
  return /not.*resolvable|may not be on|is.*declaration|declaration.*itself/i.test(result);
}

// The three regex templates in _jb_declaration_regexes must each contain exactly
// ONE capturing group — find_text_coordinates raises ValueError otherwise, silently
// disabling the stage-2 find_declaration fallback. These are fixtures mirroring the
// Python rf-string templates (name -> {last}, re.escape'd).
const JB_DECLARATION_REGEX_TEMPLATES = [
  String.raw`\b(?:class|interface|type|function|const|let|var|def|struct|enum|trait|impl)\s+({last})\b`,
  String.raw`(?<![.\w])({last})\s*\(`,
  String.raw`\b({last})\b`,
];

describe("JetBrains tool remapping tables", () => {
  it("maps every LSP-excluded tool to its jet_brains_* variant", () => {
    const excluded = ["get_symbols_overview", "find_symbol", "find_referencing_symbols", "find_declaration", "find_implementations", "rename_symbol", "safe_delete_symbol"];
    for (const tool of excluded) {
      assert.strictEqual(typeof JB_TOOL_MAP[tool], "string", tool);
      assert.ok(JB_TOOL_MAP[tool].startsWith("jet_brains_"), tool);
    }
  });

  it("maps to the exact serena-agent variant names", () => {
    assert.deepStrictEqual(JB_TOOL_MAP, {
      get_symbols_overview: "jet_brains_get_symbols_overview",
      find_symbol: "jet_brains_find_symbol",
      find_referencing_symbols: "jet_brains_find_referencing_symbols",
      find_declaration: "jet_brains_find_declaration",
      find_implementations: "jet_brains_find_implementations",
      rename_symbol: "jet_brains_rename",
      safe_delete_symbol: "jet_brains_safe_delete",
    });
  });

  it("drop/rename tables only reference known jet_brains_* variants", () => {
    const jbNames = new Set(Object.values(JB_TOOL_MAP));
    for (const key of Object.keys(JB_DROP_PARAMS)) {
      assert.ok(jbNames.has(key), `JB_DROP_PARAMS key ${key}`);
      assert.ok(JB_DROP_PARAMS[key].length > 0);
    }
    for (const key of Object.keys(JB_PARAM_RENAMES)) {
      assert.ok(jbNames.has(key), `JB_PARAM_RENAMES key ${key}`);
    }
  });

  it("safe_delete remaps name_path_pattern -> name_path and drops LSP-only params", () => {
    const out = resolveJbToolCall("safe_delete_symbol", {
      name_path_pattern: "Foo",
      relative_path: "a.ts",
      delete_even_if_used: false,
    });
    assert.strictEqual(out.name, "jet_brains_safe_delete");
    assert.deepStrictEqual(out.params, { name_path: "Foo", relative_path: "a.ts", delete_even_if_used: false });
  });

  it("find_symbol drops include_kinds/exclude_kinds/substring_matching", () => {
    const out = resolveJbToolCall("find_symbol", {
      name_path_pattern: "Foo",
      include_kinds: [5, 6],
      exclude_kinds: [7],
      substring_matching: true,
      relative_path: "a.ts",
    });
    assert.strictEqual(out.name, "jet_brains_find_symbol");
    assert.deepStrictEqual(out.params, { name_path_pattern: "Foo", relative_path: "a.ts" });
  });

  it("find_referencing_symbols drops include_kinds/exclude_kinds", () => {
    const out = resolveJbToolCall("find_referencing_symbols", {
      name_path: "Foo/bar",
      relative_path: "a.ts",
      include_kinds: [5],
      exclude_kinds: [7],
    });
    assert.strictEqual(out.name, "jet_brains_find_referencing_symbols");
    assert.deepStrictEqual(out.params, { name_path: "Foo/bar", relative_path: "a.ts" });
  });

  it("rename_symbol maps to jet_brains_rename with unchanged params", () => {
    const out = resolveJbToolCall("rename_symbol", { name_path: "Foo", relative_path: "a.ts", new_name: "Bar" });
    assert.strictEqual(out.name, "jet_brains_rename");
    assert.deepStrictEqual(out.params, { name_path: "Foo", relative_path: "a.ts", new_name: "Bar" });
  });

  it("is a no-op for shared tools (replace_symbol_body, search_for_pattern)", () => {
    for (const tool of ["replace_symbol_body", "insert_before_symbol", "search_for_pattern", "replace_content"]) {
      const out = resolveJbToolCall(tool, { relative_path: "a.ts" });
      assert.strictEqual(out.name, tool);
    }
  });

  it("_jb_pick_unique_symbol returns the single match as-is", () => {
    const syms = [{ name_path: "Foo/bar" }];
    assert.deepStrictEqual(jbPickUniqueSymbol(syms, "bar"), { name_path: "Foo/bar" });
  });

  it("_jb_pick_unique_symbol returns null for no matches", () => {
    assert.strictEqual(jbPickUniqueSymbol([], "bar"), null);
  });

  it("_jb_pick_unique_symbol disambiguates by exact name-path suffix match", () => {
    const syms = [{ name_path: "Foo/bar" }, { name_path: "Baz/bar" }, { name_path: "Foo/baz" }];
    // "bar" matches Foo/bar and Baz/bar (2 exact suffix matches) -> ambiguous -> null
    assert.strictEqual(jbPickUniqueSymbol(syms, "bar"), null);
    // "Foo/bar" has exactly one exact match -> returned
    assert.deepStrictEqual(jbPickUniqueSymbol(syms, "Foo/bar"), { name_path: "Foo/bar" });
  });

  it("_jb_pick_unique_symbol returns null for ambiguous bare name", () => {
    const syms = [{ name_path: "Foo/bar" }, { name_path: "Baz/bar" }];
    assert.strictEqual(jbPickUniqueSymbol(syms, "bar"), null);
  });

  it("_jb_is_declaration_position_error matches the plugin's phrasing variants", () => {
    assert.ok(jbIsDeclarationPositionError("Error executing tool: APIError - No declaration found at line 1. The cursor may not be on a resolvable reference."));
    assert.ok(jbIsDeclarationPositionError("Error: The selected element is a declaration, not a reference"));
    assert.ok(jbIsDeclarationPositionError("Error: Symbol at this position is itself a declaration"));
    assert.ok(!(jbIsDeclarationPositionError("Error executing tool: APIError - No symbol found for NamePathMatcher")));
    assert.ok(!(jbIsDeclarationPositionError("OK")));
  });

  it("_jb_is_declaration_position_error is case-insensitive", () => {
    assert.ok(jbIsDeclarationPositionError("MAY NOT BE ON a resolvable reference"));
  });

  it("each _jb_declaration_regexes pattern has exactly one capturing group", () => {
    const sample = "Foo";
    for (const template of JB_DECLARATION_REGEX_TEMPLATES) {
      const pattern = template.replace("{last}", sample);
      const re = new RegExp(pattern);
      // A capturing group count: count unescaped '(' that open a capture group.
      // Non-capturing groups are (?:...) — excluded by this count.
      let groups = 0;
      for (let i = 0; i < pattern.length; i++) {
        if (pattern[i] !== "(") continue;
        // Skip escaped \(
        if (i > 0 && pattern[i - 1] === "\\") continue;
        // Skip non-capturing (?: and lookarounds (?<! / (?=
        const next = pattern[i + 1];
        if (next === "?") continue;
        groups++;
      }
      assert.strictEqual(groups, 1, `pattern ${pattern} must have exactly 1 capturing group`);
    }
  });

  it("each _jb_declaration_regexes pattern matches its intended declaration shape", () => {
    const sample = "methodOne";
    const [keyword, call, bare] = JB_DECLARATION_REGEX_TEMPLATES.map((t) => new RegExp(t.replace("{last}", sample)));
    assert.ok(keyword.test("  function methodOne(): void {")); // keyword-anchored
    assert.ok(call.test("  methodOne(): void {")); // method definition (no preceding word char/dot)
    assert.ok(!(call.test("  this.methodOne();"))); // call site (preceded by dot) excluded
    assert.ok(bare.test("  methodOne")); // bare fallback
  });
});

describe("SerenaWorkerClient", () => {
  describe("request/response protocol", () => {
    it("resolves a successful response", async () => {
      const { worker, mockStdout } = createMockedWorker();
      const resultPromise = worker.request({ action: "test" });
      mockStdout.emit("data", JSON.stringify({ id: "1", ok: true, result: "hello" }) + "\n");
      const result = await resultPromise;
      assert.ok(result.ok);
      assert.strictEqual(result.result, "hello");
    });

    it("handles error responses", async () => {
      const { worker, mockStdout } = createMockedWorker();
      const resultPromise = worker.request({ action: "test" });
      mockStdout.emit("data", JSON.stringify({ id: "1", ok: false, error: "something went wrong", errorType: "serena_error" }) + "\n");
      const result = await resultPromise;
      assert.ok(!(result.ok));
      assert.strictEqual(result.error, "something went wrong");
      assert.strictEqual(result.errorType, "serena_error");
    });

    it("handles chunked stdout data", async () => {
      const { worker, mockStdout } = createMockedWorker();
      const resultPromise = worker.request({ action: "test" });
      mockStdout.emit("data", '{"id":"1","ok":true,');
      mockStdout.emit("data", '"result":"chunked"}\n');
      const result = await resultPromise;
      assert.ok(result.ok);
      assert.strictEqual(result.result, "chunked");
    });

    it("queues multiple requests and resolves them sequentially", async () => {
      const { worker, mockStdout } = createMockedWorker();
      const p1 = worker.request({ action: "first" });
      const p2 = worker.request({ action: "second" });
      assert.strictEqual((worker as any).queue.length, 1);
      mockStdout.emit("data", JSON.stringify({ id: "1", ok: true, result: "first" }) + "\n");
      const r1 = await p1;
      mockStdout.emit("data", JSON.stringify({ id: "2", ok: true, result: "second" }) + "\n");
      const r2 = await p2;
      assert.strictEqual(r1.result, "first");
      assert.strictEqual(r2.result, "second");
    });

    it("ignores JSON lines with unknown ids", async () => {
      const { worker, mockStdout } = createMockedWorker();
      const resultPromise = worker.request({ action: "test" });
      mockStdout.emit("data", JSON.stringify({ id: "unknown", ok: true, result: "ignored" }) + "\n");
      mockStdout.emit("data", JSON.stringify({ id: "1", ok: true, result: "real" }) + "\n");
      const result = await resultPromise;
      assert.strictEqual(result.result, "real");
    });

    it("ignores non-JSON stdout lines", async () => {
      const { worker, mockStdout } = createMockedWorker();
      const resultPromise = worker.request({ action: "test" });
      mockStdout.emit("data", "not json\n");
      mockStdout.emit("data", JSON.stringify({ id: "1", ok: true, result: "after noise" }) + "\n");
      const result = await resultPromise;
      assert.strictEqual(result.result, "after noise");
    });

    it("handles responses with no 'id' field", async () => {
      const { worker, mockStdout } = createMockedWorker();
      const resultPromise = worker.request({ action: "test" });
      mockStdout.emit("data", JSON.stringify({ ok: true, result: "no id" }) + "\n");
      mockStdout.emit("data", JSON.stringify({ id: "1", ok: true, result: "with id" }) + "\n");
      const result = await resultPromise;
      assert.strictEqual(result.result, "with id");
    });

    it("handles empty lines between responses", async () => {
      const { worker, mockStdout } = createMockedWorker();
      const resultPromise = worker.request({ action: "test" });
      mockStdout.emit("data", "\n\n");
      mockStdout.emit("data", JSON.stringify({ id: "1", ok: true, result: "after blanks" }) + "\n");
      const result = await resultPromise;
      assert.strictEqual(result.result, "after blanks");
    });
  });

  describe("timeout handling", () => {
    it("rejects and resets on timeout", async () => {
      const { worker } = createMockedWorker();
      const start = Date.now();
      try {
        await worker.request({ action: "test" }, 20);
        assert.fail("Should have thrown on timeout");
      } catch (err: any) {
        assert.ok((err.message).includes("timed out"));
        assert.ok((err.message).includes("test"));
      }
      // Worker should be reset after timeout
      assert.strictEqual((worker as any).process, undefined);
      assert.ok(Date.now() - start >= 15);
    });

    it("does not reject later queued requests when the current request times out", async () => {
      const { worker } = createMockedWorker();
      const p1 = worker.request({ action: "first" }, 20);
      const p2 = worker.request({ action: "second" }, 100);
      try {
        await p1;
        assert.fail("Should have thrown");
      } catch (err: any) {
        assert.ok((err.message).includes("timed out"));
      }
      setTimeout(() => {
        const proc = (worker as any).process;
        proc.stdout.emit("data", JSON.stringify({ id: "2", ok: true, result: "second" }) + "\n");
      }, 1);
      const result = await p2;
      assert.strictEqual(result.result, "second");
      assert.strictEqual((worker as any).pending.size, 0);
    });
  });

  describe("lifecycle", () => {
    it("stop() does not hang behind an active queued request", async () => {
      const { worker, mockProcess, mockStdout } = createMockedWorker();
      // Start a request that will hang
      const p1 = worker.request({ action: "hang" }, 5000);
      p1.catch(() => {}); // prevent unhandled rejection warning
      let writtenToStdin = false;
      mockProcess.stdin.write = (data: string) => {
        if (data.includes("shutdown")) {
          writtenToStdin = true;
          try {
            const parsed = JSON.parse(data);
            setTimeout(() => mockStdout.emit("data", JSON.stringify({ id: parsed.id, ok: true, shutdown: true }) + "\n"), 1);
          } catch {}
        }
        return true;
      };
      // Call stop() while the request is still pending
      const stopPromise = worker.stop();
      await stopPromise;
      assert.ok(writtenToStdin); // Shutdown should be sent immediately bypassing queue
      assert.ok(mockProcess.killed);
      try {
        await p1;
        assert.fail("Should have thrown");
      } catch (err: any) {
        assert.ok((err.message).includes("Serena worker stopped"));
      }
    });

    it("stop() rejects queued requests promptly", async () => {
      const { worker, mockProcess } = createMockedWorker();
      // One active request
      const p1 = worker.request({ action: "active" }, 5000);
      p1.catch(() => {});
      // One queued request
      const p2 = worker.request({ action: "queued" }, 5000);
      p2.catch(() => {});
      // Should be in queue
      assert.strictEqual((worker as any).queue.length, 1);

      await worker.stop();

      try { await p1; assert.fail("expected rejection"); } catch (e: any) { assert.ok((e.message).includes("Serena worker stopped")); }
      try { await p2; assert.fail("expected rejection"); } catch (e: any) { assert.ok((e.message).includes("Serena worker stopped")); }
    });

    it("stop() rejects a request enqueued during the shutdown-ack wait", async () => {
      const { worker, mockProcess, mockStdout } = createMockedWorker();
      const p1 = worker.request({ action: "active" }, 5000);
      p1.catch(() => {});
      // Hold the shutdown ack open until we enqueue the second request.
      let releaseAck: () => void = () => {};
      mockProcess.stdin.write = (data: string) => {
        if (data.includes("shutdown")) {
          const parsed = JSON.parse(data);
          releaseAck = () => mockStdout.emit("data", JSON.stringify({ id: parsed.id, ok: true, shutdown: true }) + "\n");
        }
        return true;
      };
      const stopPromise = worker.stop();
      const p2 = worker.request({ action: "during-stop" }, 5000);
      p2.catch(() => {});
      releaseAck();
      await stopPromise;
      try { await p2; assert.fail("Should have been rejected"); }
      catch (e: any) { assert.ok((e.message).includes("Serena worker stopped")); }
    });

    it("stop() kills the process and clears state", async () => {
      const { worker, mockProcess } = createMockedWorker();
      // stop() sends "shutdown", waits 2000ms max, kills the process in finally block.
      await worker.stop();
      assert.strictEqual((worker as any).process, undefined);
      assert.ok(mockProcess.killed);
    });

    it("restart() destroys pending and starts fresh", () => {
      const { worker, mockProcess } = createMockedWorker();
      assert.ok(!(mockProcess.killed));

      // restart() kills the current process and calls ensureStarted().
      // ensureStarted() may find Python and spawn a real process if Serena
      // is installed. We handle both cases.
      try {
        worker.restart();
      } catch {
        // No Python found — expected in isolated environments
      }

      assert.ok(mockProcess.killed);
      assert.strictEqual((worker as any).pending.size, 0);
    });

    it("exit handler triggers failAll", (_t, done) => {
      const { worker, mockProcess } = createMockedWorker();
      // Set up a pending request
      (worker as any).pending.set("1", {
        resolve: () => done(new Error("Should not resolve")),
        reject: (err: Error) => {
          try {
            assert.ok((err.message).includes("exited"));
            done();
          } catch (assertErr) {
            done(assertErr);
          }
        },
        timer: setTimeout(() => {}, 100_000),
      });

      // Simulate process exit — the exit handler is in ensureStarted() which
      // was never called (we injected process directly). Fire the handler manually.
      mockProcess._exitHandler?.(1, null);
    });

    it("stop() cleans up pending entry on timeout", async () => {
      const { worker, mockProcess } = createMockedWorker();
      const originalSetTimeout = global.setTimeout;
      let capturedCallback: (() => void) | undefined;
      (global as any).setTimeout = (cb: () => void, ms: number) => {
        if (ms === 2000) {
          capturedCallback = cb;
          return 123;
        }
        return originalSetTimeout(cb, ms);
      };
      try {
        mockProcess.stdin.write = () => true;
        const stopPromise = worker.stop();
        if (capturedCallback) {
          capturedCallback();
        }
        await stopPromise;
        assert.strictEqual((worker as any).pending.size, 0);
      } finally {
        global.setTimeout = originalSetTimeout;
      }
    });

    it("stop() unconditionally resets stopping and never kills a replacement process", async () => {
      const { worker, mockProcess } = createMockedWorker();
      const originalSetTimeout = global.setTimeout;
      let capturedCallback: (() => void) | undefined;
      (global as any).setTimeout = (cb: () => void, ms: number) => {
        if (ms === 2000) {
          capturedCallback = cb;
          return 123;
        }
        return originalSetTimeout(cb, ms);
      };
      try {
        mockProcess.stdin.write = () => true;
        const stopPromise = worker.stop();
        const newProc = { kill: () => {} };
        let newProcKilled = false;
        newProc.kill = () => { newProcKilled = true; };
        (worker as any).process = newProc;
        if (capturedCallback) {
          capturedCallback();
        }
        await stopPromise;
        assert.ok(!((worker as any).stopping));
        assert.ok(!(newProcKilled));
        assert.strictEqual((worker as any).process, newProc);
      } finally {
        global.setTimeout = originalSetTimeout;
      }
    });
  });
});
