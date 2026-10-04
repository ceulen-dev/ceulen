/**
 * Composer module tests — settings roundtrip (temp PI_CODING_AGENT_DIR, as
 * the router tests do), shape dispatch, /config contribution, and the core
 * (non-disableable) contract.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { applyShape, buildComposerGroups, composerConfig, default as composerModule, shapeOptions } from "../index.ts";
import { DEFAULT_SHAPE, SHAPES } from "../lib/shapes.ts";

let tmpHome = "";

before(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "composer-test-"));
  process.env.PI_CODING_AGENT_DIR = tmpHome;
});

after(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(tmpHome, { recursive: true, force: true });
});

const settingsFile = () => join(tmpHome, "settings.json");
const readSettings = (): Record<string, unknown> =>
  JSON.parse(readFileSync(settingsFile(), "utf8")) as Record<string, unknown>;

/** Untyped ctx stub — only what applyShape/save touch. */
function stubCtx(overrides: Record<string, unknown> = {}): never {
  const calls: { factory: unknown }[] = [];
  const footerCalls: { factory: unknown }[] = [];
  const ctx: Record<string, unknown> = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp/somerepo",
    model: { name: "GLM" },
    thinkingLevel: "high",
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    sessionManager: {
      getSessionId: () => "s1",
      getLeafId: () => "l1",
      getEntries: () => [
        { type: "message", message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } } },
      ],
    },
    ui: {
      theme: { fg: (_t: string, s: string) => s, inverse: (s: string) => s, getBgAnsi: () => "", getFgAnsi: () => "" },
      setEditorComponent: (factory: unknown) => {
        calls.push({ factory });
      },
      setFooter: (factory: unknown) => {
        footerCalls.push({ factory });
      },
      notify: () => {},
    },
    ...overrides,
  };
  ctx.__calls = calls;
  ctx.__footerCalls = footerCalls;
  return ctx as never;
}

/** Load the module and fire session_start — installs liveCtx (status data +
 *  theme source), the same flow the real runtime runs. */
async function startModule(ctx: never): Promise<void> {
  const events = new Map<string, (e: unknown, c: never) => Promise<void>>();
  composerModule({ on: (name: string, h: never) => events.set(name, h), getSettings: () => ({ compaction: { enabled: true } }) } as never);
  await events.get("session_start")!({}, ctx);
}

describe("composer settings", () => {
  it("defaults to the OMP default when unset or invalid; roundtrips through settings.json", async () => {
    const { readComposerShape, writeComposerSection } = await import("../lib/settings.ts");
    assert.equal(readComposerShape(), DEFAULT_SHAPE, "missing file → default");
    writeComposerSection({ shape: "rail" });
    assert.equal(readComposerShape(), "rail");
    assert.equal((readSettings().composer as { shape: string }).shape, "rail");

    // Merge, never clobber: another top-level key survives.
    writeFileSync(settingsFile(), JSON.stringify({ other: 1 }), "utf8");
    writeComposerSection({ shape: "rule" });
    assert.equal(readSettings().other, 1);
    assert.equal(readComposerShape(), "rule");

    // A stale/unknown stored id reads as the default (editor must never break).
    writeFileSync(settingsFile(), JSON.stringify({ composer: { shape: "rails-2019" } }), "utf8");
    assert.equal(readComposerShape(), DEFAULT_SHAPE);

    // Corrupt file refuses to clobber.
    writeFileSync(settingsFile(), "{broken", "utf8");
    assert.throws(() => writeComposerSection({ shape: "band" }), /not valid JSON/);
    assert.equal(readFileSync(settingsFile(), "utf8"), "{broken", "corrupt file untouched");
    // Leave valid state for later tests.
    writeFileSync(settingsFile(), "{}", "utf8");
  });
});

describe("applyShape dispatch", () => {
  it("installs an editor factory for every shape, including the default", () => {
    for (const s of SHAPES) {
      const ctx = stubCtx();
      applyShape(s.id, ctx);
      const calls = (ctx as unknown as { __calls: { factory: unknown }[] }).__calls;
      assert.equal(calls.length, 1, s.id);
      assert.equal(typeof calls[0]!.factory, "function", `${s.id} installs a factory`);
    }
  });

  it("unknown shape ids fall back to the default instead of breaking the editor", () => {
    const ctx = stubCtx();
    applyShape("rails-2019", ctx);
    const calls = (ctx as unknown as { __calls: { factory: unknown }[] }).__calls;
    assert.equal(typeof calls[0]!.factory, "function");
  });

  it("non-TUI / missing API are no-ops", () => {
    applyShape("band", stubCtx({ mode: "rpc" }));
    applyShape("band", stubCtx({ hasUI: false }));
    const ctxNoApi = stubCtx();
    (ctxNoApi as { ui: Record<string, unknown> }).ui = {};
    applyShape("band", ctxNoApi);
  });

  it("the installed factory builds a working ShapeEditor", async () => {
    const ctx = stubCtx();
    applyShape("box", ctx);
    const factory = (
      ctx as unknown as {
        __calls: { factory: (t: unknown, th: unknown, kb: unknown) => { render(w: number): string[]; setText(s: string): void } }[];
      }
    ).__calls[0]!.factory;
    const ed = factory({ terminal: { rows: 30 }, requestRender() {} }, { borderColor: (s: string) => s }, {});
    ed.setText("hi");
    const lines = ed.render(30);
    assert.ok(lines.length >= 2, "editor renders chrome");
  });

  it("the live factory carries the stock status: cwd, branch, context window, Generation Rate", async () => {
    const { setGenRate, resetGenRate } = await import("../../../lib/rate.js");
    const { setUsageItem, resetUsageItem } = await import("../../../lib/usage-store.js");
    const ctx = stubCtx();
    await startModule(ctx); // liveCtx = ctx — the same data source the factory reads
    applyShape("band", ctx);
    const factory = (
      ctx as unknown as {
        __calls: { factory: (t: unknown, th: unknown, kb: unknown) => { render(w: number): string[]; setText(s: string): void } }[];
      }
    ).__calls[0]!.factory;
    const ed = factory({ terminal: { rows: 30 }, requestRender() {} }, { borderColor: (s: string) => s }, {});
    ed.setText("hi");
    setGenRate({ tps: 46 });
    setUsageItem({ provider: "router", windows: "R:59%/2H3M" });
    const lines = ed.render(90).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    const line = lines[0]!;
    assert.ok(lines[0]!.includes("⚡ 46 tok/s"), `Generation Rate is line 1: ${lines[0]}`);
    // Line 1 carries the numeric block: rate · session token stats · quota windows.
    assert.ok(line.includes("↑100 ↓50"), `token stats on line 1: ${line}`);
    assert.ok(line.includes("R:59%"), `quota windows on line 1: ${line}`);
    const band = lines[1]!;
    assert.ok(band.includes("GLM"), band);
    assert.ok(band.includes("/tmp/somerepo"), `cwd shown: ${band}`);
    assert.ok(band.includes("10.0%/1.0k"), `context window shown: ${band}`);
    assert.ok(!band.includes("↑100 ↓50") && !band.includes("R:59%"), `stats/quota stay off the band: ${band}`);
    assert.ok(band.includes("10.0%/1.0k (auto)"), `auto-compact marker from pi settings: ${band}`);
    resetGenRate();
    resetUsageItem();
  });

  it("replaces pi's footer only on band-embedding shapes (no duplicated info)", () => {
    const withFooter = (shape: string) => {
      const ctx = stubCtx();
      applyShape(shape, ctx);
      return (ctx as unknown as { __footerCalls: { factory: unknown }[] }).__footerCalls;
    };
    for (const id of ["band", "box", "claude", "rule"]) {
      const calls = withFooter(id);
      assert.equal(calls.length, 1, `${id} installs a custom footer`);
      assert.equal(typeof calls[0]!.factory, "function", `${id} factory is a function`);
    }
    for (const id of ["pi", "borderless", "field", "rail"]) {
      const calls = withFooter(id);
      assert.equal(calls.length, 1, `${id} restores the native footer`);
      assert.equal(calls[0]!.factory, undefined, `${id} passes undefined (native footer)`);
    }
  });

  it("the custom footer renders only the other extensions' statuses", async () => {
    const ctx = stubCtx();
    await startModule(ctx);
    applyShape("band", ctx);
    const factory = (ctx as unknown as { __footerCalls: { factory: unknown }[] }).__footerCalls[0]!.factory as (
      t: unknown,
      th: unknown,
      fd: unknown,
    ) => { render(w: number): string[] };
    const footerData = {
      getExtensionStatuses: () => new Map([["rtk", "rtk ✓"], ["ceulen-usage", "(router) R:59%/2H3M"], ["serena", "serena ✓"]]) as ReadonlyMap<string, string>,
    };
    const lines = factory({}, {}, footerData).render(80).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    assert.equal(lines.length, 1, "statuses line only — stats/quota live in the band now");
    assert.equal(lines[0], "rtk ✓  serena ✓", "usage item filtered out (the band carries it), rest key-sorted (pi parity)");
    for (const l of lines) assert.ok(!l.includes("%/") && !l.includes("↑"), `band info stays in the band: ${l}`);
  });
});

describe("composerConfig", () => {
  it("groups carry one Shape row on the Appearance tab with the OMP menu copy", async () => {
    const ctx = stubCtx();
    await startModule(ctx);
    const cfg = composerConfig();
    const groups = cfg.groups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.tab, "Appearance");
    assert.equal(groups[0]!.label, "Composer Shape");
    const shapeRow = groups[0]!.rows.find((r) => r.key === "composer.shape")!;
    assert.equal(shapeRow.defaultValue, DEFAULT_SHAPE);
    // OMP's selector copy: label + description per shape, in OMP order.
    const options = shapeOptions();
    assert.deepEqual(
      options.map((o) => [o.value, o.label, o.description]),
      SHAPES.map((s) => [s.id, s.label, s.description]),
    );
    const preview = shapeRow.previewLines!("box", 40);
    assert.ok(preview.length >= 2, "previewLines render");
    assert.ok(preview.some((l) => l.includes("Ask anything")), "preview shows the prompt");
  });

  it("save() no-ops without its key; with it, persists + applies + notifies", async () => {
    const ctx = stubCtx();
    await startModule(ctx);
    const cfg = composerConfig();
    const before = existsSync(settingsFile()) ? readFileSync(settingsFile(), "utf8") : undefined;
    await cfg.save(new Set(["unrelated.key"]), ctx as never);
    assert.equal(
      existsSync(settingsFile()) ? readFileSync(settingsFile(), "utf8") : undefined,
      before,
      "no write without the owned key",
    );

    const shapeRow = cfg.groups()[0]!.rows[0]!;
    shapeRow.set("rail");
    assert.equal(shapeRow.value, "rail");

    await cfg.save(new Set(["composer.shape"]), ctx as never);
    assert.equal((readSettings().composer as { shape: string }).shape, "rail");
    const calls = (ctx as unknown as { __calls: { factory: unknown }[] }).__calls;
    assert.ok(calls.length >= 1, "applied live");
    assert.equal(typeof calls[calls.length - 1]!.factory, "function", "the save's apply installed the shape editor");
  });
});

describe("module registration (core)", () => {
  it("registers session events + thinking_level_select handlers", () => {
    const events = new Map<string, unknown>();
    composerModule({ on: (name: string, h: unknown) => events.set(name, h) } as never);
    assert.deepEqual([...events.keys()].sort(), ["session_shutdown", "session_start", "thinking_level_select"]);
  });

  it("thinking_level_select updates the live level without a session restart", async () => {
    const events = new Map<string, (e: unknown, c: never) => Promise<void>>();
    const ctx = stubCtx({ thinkingLevel: "high" });
    composerModule({ on: (name: string, h: never) => events.set(name, h), getSettings: () => ({ compaction: { enabled: true } }) } as never);
    await events.get("session_start")!({}, ctx);
    applyShape("band", ctx);
    const factoryOf = () =>
      (ctx as unknown as { __calls: { factory: (t: unknown, th: unknown, kb: unknown) => { render(w: number): string[] } }[] }).__calls.at(-1)!.factory;
    const render = (ed: { render(w: number): string[] }) => {
      const lines = ed.render(120).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
      return lines.find((l) => l.includes("π ·")) ?? lines[0]!;
    };
    const ed1 = factoryOf()({ terminal: { rows: 30 }, requestRender() {} }, { borderColor: (s: string) => s }, {});
    assert.ok(render(ed1).includes("(high)"), "session_start ctx level");
    await events.get("thinking_level_select")!({ type: "thinking_level_select", level: "max", previousLevel: "high" }, ctx);
    const ed2 = factoryOf()({ terminal: { rows: 30 }, requestRender() {} }, { borderColor: (s: string) => s }, {});
    assert.ok(render(ed2).includes("(max)"), "event updates the level live");
  });
});

describe("core module contract", () => {
  it("is marked core in the registry and survives a stale disabled entry", async () => {
    const { MODULES, isCore, readDisabled } = await import("../../../lib/registry.js");
    const entry = MODULES.find((m) => m.name === "composer")!;
    assert.equal(entry.core, true, "composer is core");
    assert.equal(isCore("composer"), true);
    assert.equal(isCore("munin"), false);

    // A settings file that (wrongly) lists a core module as disabled must not
    // disable it — readDisabled filters core modules out.
    writeFileSync(settingsFile(), JSON.stringify({ ceulen: { disabled: ["composer", "munin"] } }), "utf8");
    assert.deepEqual(readDisabled(), ["munin"], "core module filtered from the kill-switch");
    writeFileSync(settingsFile(), "{}", "utf8");
  });

  it("writeDisabled never persists a core module", async () => {
    const { writeDisabled } = await import("../../../lib/registry.js");
    writeDisabled(["composer", "munin"]);
    assert.deepEqual((readSettings().ceulen as { disabled: string[] }).disabled, ["munin"]);
    writeFileSync(settingsFile(), "{}", "utf8");
  });

  it("nextDisabled excludes core modules; withEnableRow adds no row for them", async () => {
    const { nextDisabled, withEnableRow } = await import("../../config/index.js");
    // working = enabled set; nextDisabled lists the NOT-enabled non-core modules.
    assert.deepEqual(nextDisabled(new Set(["munin"])), ["zai", "ponytail", "subagent", "plan", "a2a", "todo", "repair", "serena", "fff", "web", "rules", "steering", "rtk"]);
    assert.deepEqual(nextDisabled(new Set(["router", "classifier", "ux", "munin", "usage", "ponytail", "subagent", "plan", "a2a", "todo", "repair", "serena", "fff", "web", "rules", "steering", "zai", "rtk", "config"])), [], "all-on → nothing disabled");
    for (const core of ["composer", "advisor", "router", "classifier", "usage", "ux", "config"]) {
      assert.ok(!nextDisabled(new Set()).includes(core), `core (${core}) is never disableable`);
    }
    const groups = [{ key: "composer", label: "Composer Shape", rows: [{ key: "composer.shape" }] }] as never;
    const out = withEnableRow(groups, "composer", "Composer shape.", new Set(["composer"]));
    assert.deepEqual(out[0]!.rows.map((r: { key: string }) => r.key), ["composer.shape"], "no Enable row for core");
    const nonCore = [{ key: "ponytail", label: "Ponytail", rows: [{ key: "ponytail.defaultMode" }] }] as never;
    const out2 = withEnableRow(nonCore, "ponytail", "Lazy mode.", new Set(["ponytail"]));
    assert.deepEqual(out2[0]!.rows.map((r: { key: string }) => r.key), ["ceulen.disabled.ponytail", "ponytail.defaultMode"]);
  });
});
