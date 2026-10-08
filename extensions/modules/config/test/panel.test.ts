import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolation: PI_CODING_AGENT_DIR → temp dir; cwd is the repo root (tests run
// from the package root), whose .pi/settings.json must never be touched —
// project-scope tests below use a temp cwd instead of chdir.
const TMP_HOME = join(tmpdir(), "ceulen-config-test-" + process.pid);
before(() => {
  mkdirSync(TMP_HOME, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = TMP_HOME;
});
after(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

const settingsPath = () => join(TMP_HOME, "settings.json");

// ── registry: kill-switch read + layer precedence (write side deleted with the /config rows) ──

describe("registry kill-switch", () => {
  it("readDisabled returns [] when no settings file exists", async () => {
    try { unlinkSync(settingsPath()); } catch { /* ignore */ }
    const { readDisabled } = await import("../../../lib/registry.js");
    assert.deepEqual(readDisabled(), []);
  });

  it("readDisabled honors a hand-written settings escape hatch and maps the deprecated sub alias", async () => {
    writeFileSync(settingsPath(), JSON.stringify({ ceulen: { disabled: ["sub", "ponytail"] } }));
    const { readDisabled } = await import("../../../lib/registry.js");
    assert.deepEqual(readDisabled(), ["ponytail"]);
  });

  it("deprecated \"sub\" alias still maps (to the now-core usage module, so it disables nothing)", async () => {
    // A "sub" entry maps to "usage"; core modules are filtered, so only the
    // non-core sibling survives — proving the alias resolved (an unknown
    // string would have survived verbatim).
    writeFileSync(settingsPath(), JSON.stringify({ ceulen: { disabled: ["sub", "ponytail"] } }));
    const { readDisabled } = await import("../../../lib/registry.js");
    assert.deepEqual(readDisabled(), ["ponytail"]);
  });

  // Project scope: temp cwd + trust.json in the agent dir. readDisabled(cwd)/
  // writeDisabled are cwd-parameterized, so no chdir needed.
  describe("trusted project precedence", () => {
    const projectCwd = join(TMP_HOME, "project");
    const projectSettings = join(projectCwd, ".pi", "settings.json");

    before(() => {
      mkdirSync(join(projectCwd, ".pi"), { recursive: true });
      writeFileSync(join(TMP_HOME, "trust.json"), JSON.stringify({ [projectCwd]: true }));
    });

    it("project ceulen section wins the read", async () => {
      writeFileSync(settingsPath(), JSON.stringify({ ceulen: { disabled: ["usage"] } }));
      writeFileSync(projectSettings, JSON.stringify({ ceulen: { disabled: ["ponytail"] } }));
      const { readDisabled, disabledSource } = await import("../../../lib/registry.js");

      assert.deepEqual(readDisabled(projectCwd), ["ponytail"]); // project wins
      const source = disabledSource(projectCwd);
      assert.equal(source.path, projectSettings);
      assert.equal(source.isProject, true);
    });

    it("project file WITHOUT a ceulen section does not claim the key", async () => {
      writeFileSync(projectSettings, JSON.stringify({ router: { baseUrl: "http://x" } }));
      try { unlinkSync(settingsPath()); } catch { /* ignore */ }
      const { disabledSource } = await import("../../../lib/registry.js");
      assert.equal(disabledSource(projectCwd).isProject, false);
    });
  });
});

// ── config module: group assembly + save dispatch ───────────────────────────

describe("config module", () => {
  const ctxStub = () => {
    const notes: string[] = [];
    return {
      notes,
      // cwd is required by the pi-settings SettingsManager instance the
      // /config handler creates; use the isolated temp home as the project.
      // ui/modelRegistry carry the runtime menu lookups (themes, models).
      ctx: {
        cwd: TMP_HOME,
        ui: {
          notify: (m: string) => notes.push(m),
          getAllThemes: () => [{ name: "dark", path: undefined }, { name: "light", path: undefined }],
          getTheme: () => undefined,
          setTheme: () => ({ success: true }),
        },
        modelRegistry: { getAvailable: () => [] },
      } as never,
    };
  };

  it("saveContributions: only edited-key owners are invoked, and a thrower doesn't block siblings", async () => {
    const { saveContributions } = await import("../index.js");
    const calls: string[] = [];
    const contribution = (name: string, keys: string[], boom = false) => ({
      name,
      cfg: {
        groups: () => [],
        save: async (edited: Set<string>) => {
          if (!keys.some((k) => edited.has(k))) return;
          calls.push(name);
          if (boom) throw new Error("boom");
        },
      },
    });
    const { ctx, notes } = ctxStub();
    await saveContributions(
      [contribution("router", ["router.baseUrl"]), contribution("ponytail", ["ponytail.defaultMode"], true), contribution("late", ["late.key"])],
      new Set(["router.baseUrl", "ponytail.defaultMode", "late.key"]),
      ctx,
    );
    // router + late ran despite ponytail throwing between them; error surfaced.
    assert.deepEqual(calls, ["router", "ponytail", "late"]);
    assert.ok(notes.some((n) => n.includes("ponytail: save failed")));
  });

  it("saveContributions: a save() that no-ops for unedited keys is the contract, dispatch still calls it once", async () => {
    const { saveContributions } = await import("../index.js");
    const { ctx } = ctxStub();
    let invoked = 0;
    let savedWith: string[] = [];
    await saveContributions(
      [{
        name: "router",
        cfg: {
          groups: () => [],
          save: async (edited: Set<string>) => {
            invoked++;
            if (!edited.has("router.baseUrl")) return; // module's own guard
            savedWith = [...edited];
          },
        },
      }],
      new Set(["ponytail.defaultMode"]),
      ctx,
    );
    assert.equal(invoked, 1); // dispatch is unconditional; the module guards
    assert.deepEqual(savedWith, []);
  });

  it("piMenuLookup: theme preview captures the live theme once, restores on Esc, clears after commit", async () => {
    const { piMenuLookup } = await import("../index.js");
    const live = { name: "live-instance" };
    const calls: unknown[] = [];
    const ctx = {
      ui: {
        theme: live,
        getAllThemes: () => [{ name: "dark" }, { name: "light" }],
        getTheme: (n: string) => ({ name: `theme:${n}` }),
        setTheme: (t: unknown) => { calls.push(t); return { success: true }; },
      },
      modelRegistry: { getAvailable: () => [] },
    } as never;
    const lk = piMenuLookup(ctx);
    assert.deepEqual(lk.themes!(), ["dark", "light"]);
    lk.previewTheme!("dark");
    lk.previewTheme!("light");
    // Capture happens ONCE (first preview), not per move.
    assert.deepEqual(calls, [{ name: "theme:dark" }, { name: "theme:light" }]);
    lk.restoreTheme!();
    assert.deepEqual(calls[2], live, "Esc restores the pre-browse live instance");
    // After a restore the capture is re-armed for the next browse session.
    lk.previewTheme!("dark");
    lk.restoreTheme!();
    assert.equal(calls.length, 5);
    assert.deepEqual(calls[4], live);
    // Commit clears the capture: a following Esc must not clobber the commit.
    calls.length = 0;
    lk.previewTheme!("dark"); // capture = live
    lk.applyTheme!("light"); // commit (live + persist), capture cleared
    lk.restoreTheme!(); // stray cancel — must be a no-op
    assert.equal(calls.length, 2, "only preview + apply happened; restore no-oped");
  });

  it("/config show assembles pi + module + plugin sections in OMP taxonomy order", async () => {
    // Stub pi that records the registered command so the real handler runs.
    let handler: ((args: string, ctx: never) => Promise<void>) | undefined;
    const pi = {
      registerCommand: (_name: string, opts: { handler: typeof handler }) => { handler = opts.handler; },
    } as never;
    const factories = new Map<string, () => never>([
      [

        "router",
        () => ({
          groups: () => [
            { key: "router", label: "Router", tab: "Providers", rows: [{ key: "router.baseUrl", label: "Base URL", kind: "string", value: "" }] },
          ],
          save: async () => {},
        }) as never,
      ],
    ]);
    const { default: configModule } = await import("../index.js");
    configModule(pi, { configContribs: factories } as never);
    assert.ok(handler, "handler registered");
    const { notes, ctx } = ctxStub();
    // Non-TUI branch takes the textual summary over the same assembly.
    await (handler as never as (a: string, c: unknown) => Promise<void>)("show", ctx);
    const text = notes.join("\n");
    assert.ok(text.includes("[Appearance]"), `pi settings present: ${text.slice(0, 200)}`);
    assert.ok(text.includes("[Providers]") && text.includes("Router"), "router section categorized");
    assert.ok(text.includes("[Tasks]") && text.includes("Ponytail"), "ponytail section categorized");
    assert.ok(text.includes("[Plugins]"), "plugins tab present");
    assert.ok(!text.includes("[Modules]"), "standalone Modules tab is gone");
    // Order follows PI_TAB_ORDER: Appearance before Model before Interaction…
    assert.ok(text.indexOf("[Appearance]") < text.indexOf("[Model]"), "taxonomy order");
    assert.ok(text.indexOf("[Model]") < text.indexOf("[Interaction]"));
  });
});

// ── router contribution ─────────────────────────────────────────────────────

describe("router config contribution", () => {
  it("buildRouterGroups has prefixed row keys and mutates the working copy", async () => {
    const { buildRouterGroups } = await import("../../router/configPanel.js");
    const cfg = { baseUrl: "http://a", enableReasoning: true };
    const groups = buildRouterGroups(cfg);
    const rows = groups.flatMap((g) => g.rows);
    assert.deepEqual(rows.map((r) => r.key), ["router.baseUrl", "router.enableReasoning"]);
    // ONE section under OMP's Providers tab (the Enable row is prepended by
    // the config module at assembly time).
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.tab, "Providers");
    assert.equal(groups[0]!.label, "Router");

    rows[0]!.set("http://b/");
    assert.equal(cfg.baseUrl, "http://b/"); // setter mutates the copy the module handed over
    rows[1]!.set(false);
    assert.equal(cfg.enableReasoning, false);
  });

  it("routerConfig().save ignores non-router keys (no write, no notify)", async () => {
    const { routerConfig } = await import("../../router/configPanel.js");
    const settingsBefore = existsSync(settingsPath()) ? readFileSync(settingsPath(), "utf8") : null;
    let notified = 0;
    const ctx = { ui: { notify: () => { notified++; } } } as never;
    const cfg = routerConfig({} as never);
    await cfg.save(new Set(["ponytail.defaultMode"]), ctx);
    assert.equal(notified, 0);
    assert.equal(existsSync(settingsPath()) ? readFileSync(settingsPath(), "utf8") : null, settingsBefore);
  });
});

// ── openConfigPanel: fullscreen overlay contract ──────────────────────────

describe("openConfigPanel overlay launch", () => {
  it("passes overlay:true + full-viewport options to ctx.ui.custom and resolves on done()", async () => {
    const { openConfigPanel } = await import("../../../lib/panel.js");
    let captured: { overlay?: boolean; overlayOptions?: unknown } | undefined;
    let factory: ((...a: unknown[]) => unknown) | undefined;
    let finish: ((v?: unknown) => void) | undefined;
    const ctx = {
      mode: "tui",
      hasUI: true,
      ui: {
        notify: () => {},
        custom: (f: (...a: unknown[]) => unknown, options?: { overlay?: boolean; overlayOptions?: unknown }) => {
          captured = options;
          factory = f;
          return new Promise((resolve) => { finish = resolve; });
        },
      },
    } as never;
    const p = openConfigPanel({
      ctx,
      cfg: {},
      build: () => [],
      onSave: () => {},
    });
    // The options are resolved synchronously at custom() time; the factory is
    // invoked by the real TUI — here we only contract-check what was passed.
    await new Promise((r) => setImmediate(r));
    assert.ok(captured, "ctx.ui.custom received options");
    assert.equal(captured!.overlay, true);
    const resolved = (captured!.overlayOptions as () => Record<string, unknown>)();
    assert.deepEqual(resolved, { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 });
    // done() (the model's close path) resolves the panel promise.
    finish?.();
    await p;
    void factory;
  });

  it("non-TUI mode still notifies and resolves without opening", async () => {
    const { openConfigPanel } = await import("../../../lib/panel.js");
    const notes: string[] = [];
    let opened = false;
    const ctx = {
      mode: "rpc",
      hasUI: false,
      ui: { notify: (m: string) => notes.push(m), custom: () => { opened = true; } },
    } as never;
    await openConfigPanel({ ctx, cfg: {}, build: () => [] });
    assert.equal(opened, false);
    assert.ok(notes.some((n) => n.includes("TUI")));
  });
});

// ── ponytail contribution ───────────────────────────────────────────────────

describe("ponytail config contribution", () => {
  const ponytailHome = join(TMP_HOME, "ponytail-xdg");

  it("buildPonytailGroups has prefixed keys, enum values + row metadata", async () => {
    const { buildPonytailGroups } = await import("../../ponytail/index.js");
    const cfg = { defaultMode: "full", quietStartup: false };
    const groups = buildPonytailGroups(cfg);
    assert.equal(groups[0]!.tab, "Tasks", "ponytail is a task/mode setting in OMP's taxonomy");
    const rows = groups.flatMap((g) => g.rows);
    assert.deepEqual(rows.map((r) => r.key), ["ponytail.defaultMode", "ponytail.quietStartup"]);
    // Closed value set + declared default: the panel cycles these, no free text.
    assert.deepEqual(rows[0]!.values, ["off", "lite", "full", "ultra"]);
    assert.equal(rows[0]!.defaultValue, "full");
    assert.ok(rows.every((r) => r.description), "every ponytail row carries a description");
    rows[1]!.set(true);
    assert.equal(cfg.quietStartup, true);
  });

  it("save writes defaultMode + bool flags into the ponytail config file", async () => {
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = ponytailHome;
    try {
      const { writeDefaultMode } = await import("../../ponytail/lib/config.js");
      writeDefaultMode("lite"); // seed
      const { ponytailConfig } = await import("../../ponytail/index.js");
      const ctx = { ui: { notify: () => {} } } as never;
      const cfg = ponytailConfig();
      for (const r of cfg.groups().flatMap((g) => g.rows)) {
        if (r.key === "ponytail.quietStartup") r.set(true);
      }
      await cfg.save(new Set(["ponytail.quietStartup"]), ctx);
      const written = JSON.parse(readFileSync(join(ponytailHome, "ponytail", "config.json"), "utf8"));
      assert.equal(written.quietStartup, true);
      assert.equal(written.defaultMode, "lite"); // untouched fields preserved
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
    }
  });
});
