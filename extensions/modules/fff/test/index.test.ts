import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FileFinder } from "@ff-labs/fff-node";
import { mkdtempSync, mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fffExtension, { BoundedMap } from "../index";

const originalCreate = FileFinder.create;
const originalMode = process.env.PI_FFF_MODE;

function item(relativePath: string, lineContent = "  match", lineNumber = 1) {
  return {
    relativePath,
    fileName: relativePath.split("/").pop() ?? relativePath,
    gitStatus: "clean",
    totalFrecencyScore: 0,
    accessFrecencyScore: 0,
    lineContent,
    lineNumber,
    contextBefore: [],
    contextAfter: [],
  };
}

function search(items: any[], totalMatched = items.length, scores?: any[]) {
  return {
    ok: true,
    value: {
      items,
      scores: scores ?? items.map(() => ({ total: 100 })),
      totalMatched,
      totalFiles: totalMatched,
    },
  };
}

function grep(items: any[], nextCursor: any = null) {
  return {
    ok: true,
    value: {
      items,
      totalMatched: items.length,
      totalFilesSearched: 1,
      totalFiles: 10,
      filteredFileCount: 10,
      nextCursor,
    },
  };
}

function fakeFinder(overrides: Record<string, any> = {}) {
  return {
    isDestroyed: false,
    destroy() { this.isDestroyed = true; },
    waitForScan: async () => ({ ok: true, value: true }),
    fileSearch: () => search([]),
    glob: () => search([]),
    grep: () => grep([]),
    multiGrep: () => grep([]),
    mixedSearch: () => ({ ok: true, value: { items: [] } }),
    ...overrides,
  };
}

function harness(
  finder: any,
  mode?: string,
  extraFlags: Record<string, unknown> = {},
  options: { cwd?: string; create?: (params: any) => any; excludedTools?: string[] } = {},
) {
  (FileFinder as any).create = (params: any) => ({
    ok: true,
    value: options.create?.(params) ?? finder,
  });
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, Function[]>();
  const flags = new Map<string, unknown>(Object.entries(extraFlags));
  let activeTools = ["read", "bash", "edit", "write"];
  if (mode) flags.set("fff-mode", mode);
  let flagsReady = false;
  const pi = {
    getFlag: (name: string) => flagsReady ? flags.get(name) : undefined,
    registerFlag: () => {},
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: Function) => events.set(name, [...(events.get(name) ?? []), handler]),
    getAllTools: () => [...tools.values()]
      .filter((tool) => !options.excludedTools?.includes(tool.name))
      .map((tool) => ({ name: tool.name })),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { activeTools = [...names]; },
  };
  fffExtension(pi as any);
  flagsReady = true;
  const ctx = { cwd: options.cwd ?? process.cwd(), ui: { notify: () => {}, addAutocompleteProvider: () => {} } };
  const started = events.get("session_start")?.[0]({}, ctx);
  return { tools, commands, events, flags, started, setActiveTools: (names: string[]) => { activeTools = [...names]; }, get activeTools() { return activeTools; } };
}

async function run(tool: any, params: any) {
  return tool.execute("test", params, undefined, undefined, {});
}

function text(result: any): string {
  return result.content[0].text;
}

describe("BoundedMap", () => {
  it("evicts least-recently-used, not FIFO", () => {
    const map = new BoundedMap<number>(2, "test");
    const a = map.store(1);
    map.store(2);
    map.get(a); // touch: `a` becomes most-recently-used
    const c = map.store(3); // over capacity → evicts the untouched `2`
    assert.strictEqual(map.get(a), 1);
    assert.strictEqual(map.get(c), 3);
  });
});

describe("pi-fff tools", () => {
  afterEach(() => {
    (FileFinder as any).create = originalCreate;
    if (originalMode === undefined) delete process.env.PI_FFF_MODE;
    else process.env.PI_FFF_MODE = originalMode;
  });

  it("enforces a global grep limit and keeps scoped fuzzy pagination bound", async () => {
    const calls: Array<{ query: string; options: any }> = [];
    const cursor = { __brand: "GrepCursor", _offset: 1 };
    const finder = fakeFinder({
      grep(query: string, options: any) {
        calls.push({ query, options });
        if (calls.length === 1) return grep([]);
        if (calls.length === 2) {
          const match = { ...item("src/a.ts", "  needle", 10), isDefinition: true, contextAfter: ["  one", "  two", "  three"] };
          return grep([match], cursor);
        }
        return grep([{ ...item("src/b.ts", "  needle", 20) }]);
      },
    });
    const { tools } = harness(finder);
    const tool = tools.get("ffgrep");
    const first = await run(tool, { pattern: "needle", path: "src/", exclude: "test/", limit: 1, context: 1 });
    const cursorId = text(first).match(/cursor="([^"]+)"/)?.[1];

    assert.strictEqual(calls[0].query, "src/ !test/ needle");
    assert.strictEqual(calls[0].options.pageSize, 1);
    assert.strictEqual(calls[1].query, calls[0].query);
    assert.strictEqual(calls[1].options.mode, "fuzzy");
    assert.ok((text(first)).includes("  one")); assert.ok(!(text(first)).includes("  two"));

    await run(tool, { pattern: "changed", path: "elsewhere/", cursor: cursorId });
    assert.strictEqual(calls[2].query, "src/ !test/ needle");
    assert.strictEqual(calls[2].options.mode, "fuzzy");
    assert.strictEqual(calls[2].options.cursor, cursor);

    const crossed = await run(tools.get("fff_multi_grep"), { patterns: ["x"], cursor: cursorId });
    assert.ok((text(crossed)).includes("Invalid or expired multi-grep cursor"));
  });

  it("keeps live find and grep cursors distinct and rejects cross-tool use", async () => {
    const nativeCursor = { __brand: "GrepCursor", _offset: 1 };
    const finder = fakeFinder({
      grep: () => grep([item("src/a.ts")], nativeCursor),
      fileSearch: () => search([item("src/a.ts")], 2, [{ total: 100 }]),
    });
    const { tools } = harness(finder);
    const grepResult = await run(tools.get("ffgrep"), { pattern: "a", limit: 1 });
    const findResult = await run(tools.get("fffind"), { pattern: "a", limit: 1 });
    const grepCursor = text(grepResult).match(/cursor="([^"]+)"/)?.[1];
    const findCursor = text(findResult).match(/cursor="([^"]+)"/)?.[1];
    assert.ok(grepCursor, "grep result carries a cursor");
    assert.ok(findCursor, "find result carries a cursor");
    assert.match(grepCursor!, /^grep:/);
    assert.match(findCursor!, /^find:/);
    assert.notStrictEqual(grepCursor, findCursor);
    assert.ok((text(await run(tools.get("ffgrep"), { pattern: "a", cursor: findCursor }))).includes("Invalid or expired grep cursor"));
    assert.ok((text(await run(tools.get("fffind"), { pattern: "a", cursor: grepCursor }))).includes("Invalid or expired find cursor"));
  });

  it("rejects cursors after the active workspace changes", async () => {
    const nativeCursor = { __brand: "GrepCursor", _offset: 1 };
    let grepCalls = 0;
    let findCalls = 0;
    const finder = fakeFinder({
      grep: () => { grepCalls++; return grep([item("a.ts")], nativeCursor); },
      fileSearch: () => { findCalls++; return search([item("a.ts")], 2, [{ total: 100 }]); },
    });
    const runtime = harness(finder);
    await runtime.started;
    const grepToken = text(await run(runtime.tools.get("ffgrep"), { pattern: "a", limit: 1 })).match(/cursor="([^"]+)"/)?.[1];
    const findToken = text(await run(runtime.tools.get("fffind"), { pattern: "a", limit: 1 })).match(/cursor="([^"]+)"/)?.[1];
    await runtime.events.get("session_start")?.[0]({}, {
      cwd: join(process.cwd(), "other-workspace"),
      ui: { notify: () => {}, addAutocompleteProvider: () => {} },
    });
    const before = { grepCalls, findCalls };
    assert.ok((text(await run(runtime.tools.get("ffgrep"), { pattern: "a", cursor: grepToken }))).includes("Invalid or expired grep cursor"));
    assert.ok((text(await run(runtime.tools.get("fffind"), { pattern: "a", cursor: findToken }))).includes("Invalid or expired find cursor"));
    assert.deepStrictEqual({ grepCalls, findCalls }, before);
  });

  it("searches an explicitly scoped hidden directory with a rooted native finder", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "pi-fff-hidden-"));
    mkdirSync(join(fixture, ".agents"));
    writeFileSync(join(fixture, ".agents", "plan.md"), "plan\n");
    const root = fakeFinder({ fileSearch: () => search([]) });
    let scopedQuery = "";
    const scoped = fakeFinder({ fileSearch: (query: string) => { scopedQuery = query; return search([item("plan.md")]); } });
    const runtime = harness(root, undefined, {}, {
      cwd: fixture,
      create: (options) => options.basePath.endsWith(".agents") ? scoped : root,
    });
    try {
      await runtime.started;
      const result = await run(runtime.tools.get("fffind"), {
        pattern: "*",
        path: ".agents/**/*.md",
        exclude: ".agents/generated/**",
      });
      assert.ok((text(result)).includes(".agents/plan.md"));
      assert.strictEqual(scopedQuery, "**/*.md !generated/ *");
      for (const exclude of ["generated", "generated/", "generated/**"]) {
        await run(runtime.tools.get("fffind"), { pattern: "*", path: ".agents", exclude });
        assert.strictEqual(scopedQuery, "!generated/ *");
      }
      assert.strictEqual(text(await run(runtime.tools.get("fffind"), {
        pattern: "*",
        path: ".agents/**/*.md",
        exclude: ".agents/**",
      })), "No files found matching pattern");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("searches explicit hidden scopes with grep, override grep, and multi-grep", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "pi-fff-hidden-grep-"));
    mkdirSync(join(fixture, ".agents"));
    writeFileSync(join(fixture, ".agents", "plan.md"), "needle\n");
    const cursor = { __brand: "GrepCursor", _offset: 1 };
    const root = fakeFinder({ grep: () => grep([]), multiGrep: () => grep([]) });
    const scopedQueries: string[] = [];
    const scopedConstraints: Array<string | undefined> = [];
    const scoped = fakeFinder({
      grep: (query: string, options: any) => {
        scopedQueries.push(query);
        return grep([item("plan.md", "needle")], options.cursor ? null : cursor);
      },
      multiGrep: (options: any) => {
        scopedConstraints.push(options.constraints);
        return grep([item("plan.md", "needle")]);
      },
    });
    const create = (options: any) => options.basePath.endsWith(".agents") ? scoped : root;
    try {
      const normal = harness(root, undefined, {}, { cwd: fixture, create });
      await normal.started;
      const first = await run(normal.tools.get("ffgrep"), {
        pattern: "needle",
        path: ".agents/**/*.md",
        exclude: ".agents/generated/**",
        limit: 1,
      });
      assert.ok((text(first)).includes(".agents/plan.md"));
      const next = text(first).match(/cursor="([^"]+)"/)?.[1];
      assert.ok(next, "result carries a cursor");
      assert.match(next!, /^grep:/);
      assert.ok((text(await run(normal.tools.get("ffgrep"), { pattern: "changed", cursor: next }))).includes(".agents/plan.md"));
      assert.ok((text(await run(normal.tools.get("fff_multi_grep"), {
        patterns: ["needle"],
        path: ".agents/**/*.md",
        exclude: ".agents/generated/**",
      }))).includes(".agents/plan.md"));
      assert.strictEqual(scopedQueries[0], "**/*.md !generated/ needle");
      assert.ok((scopedConstraints).includes("**/*.md !generated/"));

      const override = harness(root, "override", {}, { cwd: fixture, create });
      await override.started;
      assert.ok((text(await run(override.tools.get("grep"), { pattern: "needle", path: ".agents/**/*.md", literal: true }))).includes(".agents/plan.md"));
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("applies pattern and exclusions to explicit hidden files", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "pi-fff-hidden-file-"));
    writeFileSync(join(fixture, ".note"), "needle one\nneedle two\nneedle three\n");
    writeFileSync(join(fixture, ".large"), "needle\n");
    truncateSync(join(fixture, ".large"), 10 * 1024 * 1024 + 1);
    writeFileSync(join(fixture, ".dense"), "x\n".repeat(1_000_000));
    writeFileSync(join(fixture, ".bin"), "needle\nbinary\0data\n");
    const root = fakeFinder({ fileSearch: () => search([]), grep: () => grep([]), multiGrep: () => grep([]) });
    const runtime = harness(root, undefined, {}, { cwd: fixture });
    try {
      await runtime.started;
      assert.ok((text(await run(runtime.tools.get("fffind"), { pattern: ".note", path: ".note" }))).includes(".note"));
      assert.strictEqual(text(await run(runtime.tools.get("fffind"), { pattern: "*.ts", path: ".note" })), "No files found matching pattern");
      assert.strictEqual(text(await run(runtime.tools.get("fffind"), { pattern: ".note", path: ".note", exclude: ".note" })), "No files found matching pattern");
      assert.strictEqual(text(await run(runtime.tools.get("ffgrep"), { pattern: "needle", path: ".large" })), "No matches found");
      // NUL byte in the first chunk → binary file rejected even though "needle" matches
      assert.strictEqual(text(await run(runtime.tools.get("ffgrep"), { pattern: "needle", path: ".bin" })), "No matches found");
      const dense = await run(runtime.tools.get("ffgrep"), { pattern: "x", path: ".dense", limit: 1 });
      assert.ok((text(dense)).includes('cursor="grep:'));
      const first = await run(runtime.tools.get("ffgrep"), { pattern: "needle", path: ".note", limit: 1 });
      const firstCursor = text(first).match(/cursor="([^"]+)"/)?.[1];
      assert.ok((text(first)).includes("needle one"));
      const second = await run(runtime.tools.get("ffgrep"), { pattern: "changed", cursor: firstCursor });
      const secondCursor = text(second).match(/cursor="([^"]+)"/)?.[1];
      assert.ok((text(second)).includes("needle two"));
      assert.ok((text(await run(runtime.tools.get("ffgrep"), { pattern: "changed", cursor: secondCursor }))).includes("needle three"));

      const multiFirst = await run(runtime.tools.get("fff_multi_grep"), { patterns: ["needle"], path: ".note", limit: 1 });
      const multiCursor = text(multiFirst).match(/cursor="([^"]+)"/)?.[1];
      assert.ok((text(multiFirst)).includes("needle one"));
      assert.ok((text(await run(runtime.tools.get("fff_multi_grep"), { patterns: ["changed"], cursor: multiCursor }))).includes("needle two"));
      assert.ok((text(await run(runtime.tools.get("fff_multi_grep"), { patterns: ["needle"], cursor: firstCursor }))).includes("Invalid or expired multi-grep cursor"));

      const override = harness(root, "override", {}, { cwd: fixture });
      await override.started;
      const overrideResult = await run(override.tools.get("grep"), { pattern: "needle", path: ".note", literal: true, limit: 1 });
      assert.ok((text(overrideResult)).includes("needle one"));
      assert.strictEqual(overrideResult.details.matchLimitReached, 1);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects expired find cursors instead of restarting with new arguments", async () => {
    let calls = 0;
    const { tools } = harness(fakeFinder({ fileSearch: () => { calls++; return search([]); } }));
    const result = await run(tools.get("fffind"), { pattern: "new", cursor: "missing" });
    assert.ok((text(result)).includes("Invalid or expired find cursor"));
    assert.strictEqual(calls, 0);
  });

  it("fetches a runner-up for resolve_file limit 1 and strips leading @", async () => {
    let query = "";
    let pageSize = 0;
    const finder = fakeFinder({
      fileSearch(q: string, options: any) {
        query = q;
        pageSize = options.pageSize;
        return search([item("src/a.ts"), item("src/b.ts")], 2, [{ total: 10 }, { total: 9 }]);
      },
    });
    const result = await run(harness(finder).tools.get("resolve_file"), { pattern: "@src/a", limit: 1 });
    assert.strictEqual(query, "src/a");
    assert.strictEqual(pageSize, 2);
    assert.strictEqual(result.details.resolved, false);
    assert.ok((text(result)).includes("src/a.ts")); assert.ok(!(text(result)).includes("src/b.ts"));
  });

  it("keeps related files in the resolved file directory with the same normalized stem", async () => {
    const queries: string[] = [];
    const finder = fakeFinder({
      fileSearch(query: string) {
        queries.push(query);
        if (queries.length === 1) return search([item("src/Chart.tsx")]);
        return search([
          item("src/Chart.test.tsx"),
          item("src/Chart.module.css"),
          item("src/Chart.types.ts"),
          item("lib/Chart.tsx"),
          item("src/Chartreuse.tsx"),
        ]);
      },
    });
    const result = await run(harness(finder).tools.get("related_files"), { path: "@src/Chart.tsx" });
    assert.strictEqual(queries[0], "src/Chart.tsx");
    assert.strictEqual(queries[1], "src/ Chart");
    assert.deepStrictEqual(result.details.related, [
      "src/Chart.test.tsx",
      "src/Chart.module.css",
      "src/Chart.types.ts",
    ]);
  });

  it("makes concurrent callers await the same initial scan", async () => {
    let createCount = 0;
    let release!: () => void;
    const scanning = new Promise<void>((resolve) => { release = resolve; });
    const finder = fakeFinder({ waitForScan: () => scanning, fileSearch: () => search([]) });
    (FileFinder as any).create = () => { createCount++; return { ok: true, value: finder }; };
    const tools = new Map<string, any>();
    let sessionStart: Function | undefined;
    const pi = {
      getFlag: () => undefined,
      registerFlag: () => {},
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: () => {},
      on: (name: string, handler: Function) => {
        if (name === "session_start") sessionStart = handler;
      },
    };
    fffExtension(pi as any);
    const initializing = sessionStart?.({}, {
      cwd: process.cwd(),
      ui: { notify: () => {}, addAutocompleteProvider: () => {} },
    });

    let firstDone = false;
    let secondDone = false;
    const first = run(tools.get("fffind"), { pattern: "a" }).then(() => { firstDone = true; });
    const second = run(tools.get("resolve_file"), { pattern: "b" }).then(() => { secondDone = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(createCount, 1);
    assert.strictEqual(firstDone, false);
    assert.strictEqual(secondDone, false);
    release();
    await Promise.all([initializing, first, second]);
  });

  it("registers the autocomplete provider once across repeated session_start", async () => {
    (FileFinder as any).create = () => ({ ok: true, value: fakeFinder({}) });
    let sessionStart: Function | undefined;
    const pi = {
      getFlag: () => undefined,
      registerFlag: () => {},
      registerTool: () => {},
      registerCommand: () => {},
      on: (name: string, handler: Function) => {
        if (name === "session_start") sessionStart = handler;
      },
    };
    fffExtension(pi as any);
    const autocompleteCalls: unknown[] = [];
    const ctx = {
      cwd: process.cwd(),
      ui: { notify: () => {}, addAutocompleteProvider: (p: unknown) => autocompleteCalls.push(p) },
    };
    await sessionStart?.({}, ctx);
    await sessionStart?.({}, ctx);
    assert.strictEqual(autocompleteCalls.length, 1);
  });

  it("fff-health awaits the shared in-flight finder instead of reporting not-initialized", async () => {
    let createCount = 0;
    let release!: () => void;
    const scanning = new Promise<void>((resolve) => { release = resolve; });
    const finder = fakeFinder({
      waitForScan: () => scanning,
      healthCheck: () => ({
        ok: true,
        value: {
          version: "9.9.9",
          git: { repositoryFound: true, workdir: "/repo" },
          filePicker: { initialized: true, indexedFiles: 5 },
          frecency: { initialized: false },
          queryTracker: { initialized: false },
        },
      }),
      getScanProgress: () => ({ ok: true, value: { isScanning: false, scannedFilesCount: 5 } }),
    });
    const runtime = harness(finder, undefined, {}, { create: () => { createCount++; return finder; } });
    const initializing = runtime.started;
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(createCount, 1);

    const notes: string[] = [];
    await runtime.commands.get("fff-health").handler("", { ui: { notify: (m: string) => notes.push(m) } });
    assert.strictEqual(createCount, 1); // shared the in-flight promise — no second spawn
    release();
    await initializing;
    assert.strictEqual((notes).length, 1);
    assert.ok((notes[0]).includes("FFF v9.9.9"));
  });

  it("fff-health reports initialization failure when re-create fails", async () => {
    const finder = fakeFinder();
    const runtime = harness(finder);
    await runtime.started;
    (FileFinder as any).create = () => ({ ok: false, error: "boom" });
    finder.destroy();
    const notes: string[] = [];
    await runtime.commands.get("fff-health").handler("", { ui: { notify: (m: string) => notes.push(m) } });
    assert.deepStrictEqual(notes, ["FFF initialization failed"]);
  });

  it("reads CLI flags after Pi populates them and before registering tools", async () => {
    let createOptions: any;
    const finder = fakeFinder();
    const runtime = harness(finder, "override", {
      "fff-frecency-db": "/tmp/frecency.db",
      "fff-history-db": "/tmp/history.db",
      "fff-enable-root-scan": true,
    }, {
      create: (options) => {
        createOptions = options;
        return finder;
      },
    });
    await runtime.started;
    assert.strictEqual(runtime.tools.has("find"), true);
    assert.strictEqual(runtime.tools.has("grep"), true);
    assert.strictEqual(runtime.tools.has("fffind"), false);
    assert.ok(["find", "grep"].every((m: any) => (runtime.activeTools).includes(m)));
    assert.strictEqual(createOptions.frecencyDbPath, "/tmp/frecency.db");
    assert.strictEqual(createOptions.historyDbPath, "/tmp/history.db");
    assert.strictEqual(createOptions.enableFsRootScanning, true);

    const excluded = harness(fakeFinder(), "override", {}, { excludedTools: ["grep"] });
    await excluded.started;
    assert.ok((excluded.activeTools).includes("find"));
    assert.ok(!(excluded.activeTools).includes("grep"));
  });

  it("reloads only when mode changes cross the override boundary and honors CLI flags", async () => {
    delete process.env.PI_FFF_MODE;
    const normal = harness(fakeFinder());
    let reloads = 0;
    const ctx = { ui: { notify: () => {} }, reload: async () => { reloads++; } };
    await normal.commands.get("fff-mode").handler("tools-only", ctx);
    assert.strictEqual(reloads, 0);
    assert.strictEqual(process.env.PI_FFF_MODE, "tools-only");
    await normal.commands.get("fff-mode").handler("override", ctx);
    assert.strictEqual(reloads, 1);
    assert.strictEqual(process.env.PI_FFF_MODE, "override");

    const flagged = harness(fakeFinder(), "override");
    process.env.PI_FFF_MODE = "override";
    await flagged.commands.get("fff-mode").handler("tools-only", ctx);
    assert.strictEqual(process.env.PI_FFF_MODE, "override");
  });

  it("uses Pi-compatible override schemas, details, and exact glob semantics", async () => {
    const cursor = { __brand: "GrepCursor", _offset: 1 };
    const globCalls: string[] = [];
    const finder = fakeFinder({
      grep: () => grep([item("src/a.ts")], cursor),
      fileSearch: () => search([item("src/a.ts")], 2, [{ total: 100 }]),
      glob: (pattern: string) => {
        globCalls.push(pattern);
        if (pattern === "foo") return search([]);
        if (pattern === "src/*.ts") return search([item("src/a.ts")]);
        return search([item("src/a.ts")], 2, [{ total: 100 }]);
      },
    });
    const { tools } = harness(finder, "override");
    assert.deepStrictEqual(Object.keys(tools.get("find").parameters.properties), ["pattern", "path", "limit"]);
    assert.deepStrictEqual(Object.keys(tools.get("grep").parameters.properties), [
      "pattern", "path", "glob", "ignoreCase", "literal", "context", "limit",
    ]);

    const grepResult = await run(tools.get("grep"), { pattern: "MATCH", glob: "*.ts", ignoreCase: true, literal: true, limit: 1 });
    assert.deepStrictEqual(Object.keys(grepResult.details), ["matchLimitReached"]);
    const findResult = await run(tools.get("find"), { pattern: "*.ts", limit: 1 });
    assert.deepStrictEqual(Object.keys(findResult.details), ["resultLimitReached"]);
    assert.strictEqual(text(await run(tools.get("find"), { pattern: "foo" })), "No files found matching pattern");
    assert.strictEqual(text(await run(tools.get("find"), { pattern: "*.ts", path: "src" })), "a.ts");
    assert.ok((globCalls).includes("src/*.ts"));
  });

  it("returns a friendly error when override find gets an absolute out-of-workspace path", async () => {
    const { tools } = harness(fakeFinder(), "override");
    const result = await run(tools.get("find"), { pattern: "*.ts", path: "/etc" });
    assert.ok((text(result)).includes("Invalid path constraint"));
    assert.ok((text(result)).includes("must be relative to the workspace"));
  });

  it("truncates every tool output with Pi metadata", async () => {
    const items = Array.from({ length: 2101 }, (_, i) => item(`src/file-${i}.ts`));
    const result = await run(harness(fakeFinder({ fileSearch: () => search(items) })).tools.get("fffind"), {
      pattern: "file",
      limit: items.length,
    });
    assert.strictEqual(result.details.truncation.truncated, true);
    assert.ok((text(result)).includes("[Output truncated:"));
    assert.ok(result.details.truncation.outputLines <= 2000);
  });
});

describe("before_agent_start search guidance", () => {
  const PHRASE = "Search tools: ffgrep/fffind";

  it("appends the ffgrep/fffind paragraph in default mode", async () => {
    const { events, started, setActiveTools } = harness(fakeFinder());
    await started;
    setActiveTools(["ffgrep", "fffind"]);
    const handler = events.get("before_agent_start")![0];
    const result = await handler({ systemPrompt: "BASE" });
    assert.strictEqual(result?.systemPrompt.startsWith("BASE"), true);
    assert.ok((result?.systemPrompt).includes(PHRASE));
  });

  it("returns undefined when the fff tools are not active", async () => {
    const { events, started, setActiveTools } = harness(fakeFinder());
    await started;
    setActiveTools(["read", "bash"]);
    const handler = events.get("before_agent_start")![0];
    const result = await handler({ systemPrompt: "BASE" });
    assert.strictEqual(result, undefined);
  });

  it("returns undefined in override mode even with ffgrep listed", async () => {
    const { events, started, setActiveTools } = harness(fakeFinder(), "override");
    await started;
    setActiveTools(["ffgrep"]);
    const handler = events.get("before_agent_start")![0];
    const result = await handler({ systemPrompt: "BASE" });
    assert.strictEqual(result, undefined);
  });
});
