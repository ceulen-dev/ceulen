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
  const ctx: Record<string, unknown> = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp/somerepo",
    model: { name: "GLM" },
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    ui: {
      theme: { fg: (_t: string, s: string) => s, inverse: (s: string) => s, getBgAnsi: () => "", getFgAnsi: () => "" },
      setEditorComponent: (factory: unknown) => {
        calls.push({ factory });
      },
      notify: () => {},
    },
    ...overrides,
  };
  ctx.__calls = calls;
  return ctx as never;
}

/** Load the module and fire session_start — installs liveCtx (status data +
 *  theme source), the same flow the real runtime runs. */
async function startModule(ctx: never): Promise<void> {
  const events = new Map<string, (e: unknown, c: never) => Promise<void>>();
  composerModule({ on: (name: string, h: never) => events.set(name, h) } as never);
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
  it("registers session_start + session_shutdown handlers", () => {
    const events = new Map<string, unknown>();
    composerModule({ on: (name: string, h: unknown) => events.set(name, h) } as never);
    assert.deepEqual([...events.keys()].sort(), ["session_shutdown", "session_start"]);
  });
});

describe("core module contract", () => {
  it("is marked core in the registry and survives a stale disabled entry", async () => {
    const { MODULES, isCore, readDisabled } = await import("../../../lib/registry.js");
    const entry = MODULES.find((m) => m.name === "composer")!;
    assert.equal(entry.core, true, "composer is core");
    assert.equal(isCore("composer"), true);
    assert.equal(isCore("usage"), false);

    // A settings file that (wrongly) lists composer as disabled must not
    // disable it — readDisabled filters core modules out.
    writeFileSync(settingsFile(), JSON.stringify({ ceulen: { disabled: ["composer", "usage"] } }), "utf8");
    assert.deepEqual(readDisabled(), ["usage"], "core module filtered from the kill-switch");
    writeFileSync(settingsFile(), "{}", "utf8");
  });

  it("writeDisabled never persists a core module", async () => {
    const { writeDisabled } = await import("../../../lib/registry.js");
    writeDisabled(["composer", "usage"]);
    assert.deepEqual((readSettings().ceulen as { disabled: string[] }).disabled, ["usage"]);
    writeFileSync(settingsFile(), "{}", "utf8");
  });

  it("nextDisabled excludes core modules; withEnableRow adds no row for them", async () => {
    const { nextDisabled, withEnableRow } = await import("../../config/index.js");
    // working = enabled set; nextDisabled lists the NOT-enabled non-core modules.
    assert.deepEqual(nextDisabled(new Set(["usage"])), ["router", "ponytail", "config"]);
    assert.deepEqual(nextDisabled(new Set(["router", "usage", "ponytail", "config"])), [], "all-on → nothing disabled");
    const groups = [{ key: "composer", label: "Composer Shape", rows: [{ key: "composer.shape" }] }] as never;
    const out = withEnableRow(groups, "composer", "Composer shape.", new Set(["composer"]));
    assert.deepEqual(out[0]!.rows.map((r: { key: string }) => r.key), ["composer.shape"], "no Enable row for core");
    const nonCore = [{ key: "ponytail", label: "Ponytail", rows: [{ key: "ponytail.defaultMode" }] }] as never;
    const out2 = withEnableRow(nonCore, "ponytail", "Lazy mode.", new Set(["ponytail"]));
    assert.deepEqual(out2[0]!.rows.map((r: { key: string }) => r.key), ["ceulen.disabled.ponytail", "ponytail.defaultMode"]);
  });
});
