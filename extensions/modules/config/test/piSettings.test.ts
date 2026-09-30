/**
 * Pi-settings contribution tests — all against `SettingsManager.inMemory`,
 * so no file I/O and no dependence on the developer's real settings.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { buildPiSettingsGroups, isPiKey, PI_TAB_ORDER } from "../piSettings.js";

const rowsOf = (m: SettingsManager) => buildPiSettingsGroups(m).flatMap((g) => g.rows);
const rowAt = (m: SettingsManager, key: string) => rowsOf(m).find((r) => r.key === key)!;

describe("pi settings contribution", () => {
  it("builds OMP-taxonomy tabs with unique keys and sections", () => {
    const groups = buildPiSettingsGroups(SettingsManager.inMemory());
    const keys = groups.flatMap((g) => g.rows.map((r) => r.key));
    assert.equal(new Set(keys).size, keys.length, "row keys are unique");
    // Tab names all belong to OMP's taxonomy.
    for (const g of groups) {
      assert.ok(PI_TAB_ORDER.includes(g.tab as (typeof PI_TAB_ORDER)[number]), `known tab: ${g.tab}`);
      assert.ok(g.rows.every((r) => r.key.startsWith("pi.")), "pi-prefixed keys");
    }
    // The tabs the panel relies on are present.
    const tabs = new Set(groups.map((g) => g.tab));
    for (const t of ["Appearance", "Model", "Interaction", "Context", "Shell"]) {
      assert.ok(tabs.has(t), `tab present: ${t}`);
    }
  });

  it("isPiKey matches only pi-core keys", () => {
    assert.ok(isPiKey("pi.steeringMode"));
    assert.ok(!isPiKey("ceulen.disabled.router"));
    assert.ok(!isPiKey("router.baseUrl"));
  });

  it("reads EFFECTIVE values from the manager (defaults included)", () => {
    const m = SettingsManager.inMemory({ steeringMode: "all", hideThinkingBlock: true });
    assert.equal(rowAt(m, "pi.steeringMode").value, "all");
    assert.equal(rowAt(m, "pi.followUpMode").value, "one-at-a-time", "built-in default");
    assert.equal(rowAt(m, "pi.hideThinkingBlock").value, true);
    assert.equal(rowAt(m, "pi.compaction.enabled").value, true, "default auto-compact on");
  });

  it("changed-from-default is expressed via defaultValue for every settable row", () => {
    // Rows WITHOUT a declared default can never render as changed — the panel
    // only warns when defaultValue is present and differs.
    const rows = rowsOf(SettingsManager.inMemory());
    const noDefault = rows.filter((r) => r.defaultValue === undefined).map((r) => r.key);
    // Free-text rows (theme, default model/provider, shell paths, lists) are
    // intentionally defaultless; everything else must declare one.
    assert.deepEqual(noDefault.sort(), [
      "pi.defaultModel",
      "pi.defaultProvider",
      "pi.enabledModels",
      "pi.npmCommand",
      "pi.shellCommandPrefix",
      "pi.shellPath",
      "pi.theme",
    ].sort());
  });

  it("setters persist through the manager and are observable via getters", () => {
    const m = SettingsManager.inMemory();
    rowAt(m, "pi.steeringMode").set("all");
    assert.equal(m.getSteeringMode(), "all");
    rowAt(m, "pi.compaction.enabled").set(false);
    assert.equal(m.getCompactionEnabled(), false);
    rowAt(m, "pi.quietStartup").set(true);
    assert.equal(m.getQuietStartup(), true);
    rowAt(m, "pi.defaultProjectTrust").set("never");
    assert.equal(m.getDefaultProjectTrust(), "never");
    rowAt(m, "pi.tuiMode").set("fullscreen");
    assert.equal(m.getTuiMode(), "fullscreen");
  });

  it("number rows coerce and clamp through the typed setters", () => {
    const m = SettingsManager.inMemory();
    rowAt(m, "pi.editorPaddingX").set(2);
    assert.equal(m.getEditorPaddingX(), 2);
    rowAt(m, "pi.editorPaddingX").set(9); // clamped 0–3 by pi
    assert.equal(m.getEditorPaddingX(), 3);
    rowAt(m, "pi.autocompleteMaxVisible").set(1); // clamped 3–20
    assert.equal(m.getAutocompleteMaxVisible(), 3);
  });

  it("number rows IGNORE unparseable input instead of throwing (the panel passes typed text)", () => {
    const m = SettingsManager.inMemory();
    const before = m.getHttpIdleTimeoutMs();
    // kindValue returns the raw string when it does not parse; pi's
    // setHttpIdleTimeoutMs THROWS on NaN — the guard must swallow it.
    assert.doesNotThrow(() => rowAt(m, "pi.httpIdleTimeoutMs").set("abc"));
    assert.equal(m.getHttpIdleTimeoutMs(), before, "value unchanged on garbage input");
    // Negative is clamped to 0 (pi throws on < 0).
    assert.doesNotThrow(() => rowAt(m, "pi.httpIdleTimeoutMs").set(-5));
    assert.equal(m.getHttpIdleTimeoutMs(), 0);
  });

  it("list rows join on read and split on write", () => {
    const m = SettingsManager.inMemory({ enabledModels: ["anthropic/*", "zai/glm-*"] });
    const r = rowAt(m, "pi.enabledModels");
    assert.equal(r.value, "anthropic/* zai/glm-*");
    r.set("openai/gpt-5 router/*");
    assert.deepEqual(m.getEnabledModels(), ["openai/gpt-5", "router/*"]);
    r.set("");
    assert.equal(m.getEnabledModels(), undefined, "empty clears the scope");
  });

  it("warnings merge into the existing object instead of replacing it", () => {
    const m = SettingsManager.inMemory({ warnings: { anthropicExtraUsage: false } });
    rowAt(m, "pi.warnings.anthropicExtraUsage").set(true);
    assert.deepEqual(m.getWarnings(), { anthropicExtraUsage: true });
  });

  it("rows carry descriptions and enum rows declare closed value sets", () => {
    const rows = rowsOf(SettingsManager.inMemory());
    assert.ok(rows.every((r) => (r.description ?? "").length > 0), "every pi row is described");
    const steering = rowAt(SettingsManager.inMemory(), "pi.steeringMode");
    assert.deepEqual(steering.values, ["one-at-a-time", "all"], "closed value set cycles");
    const trust = rowAt(SettingsManager.inMemory(), "pi.defaultProjectTrust");
    assert.deepEqual(trust.values, ["ask", "always", "never"]);
    assert.ok(trust.warning, "auto-trust carries a risk note");
  });

  it("without a lookup the Theme and Default model rows stay plain text rows", () => {
    const m = SettingsManager.inMemory({ theme: "dark", defaultProvider: "zai", defaultModel: "glm-5" });
    const theme = rowAt(m, "pi.theme");
    assert.equal(theme.menu, undefined);
    assert.equal(theme.preview, undefined);
    theme.set("light");
    assert.equal(m.getThemeSetting(), "light", "plain setter still persists");
    const model = rowAt(m, "pi.defaultModel");
    assert.equal(model.menu, undefined);
    model.set("gpt-5");
    assert.equal(m.getDefaultModel(), "gpt-5");
  });

  it("theme lookup: menu lists themes (+ the unlisted current value first), preview cancels via the row hook", () => {
    const m = SettingsManager.inMemory();
    const previewed: string[] = [];
    const applied: string[] = [];
    let restores = 0;
    const rows = buildPiSettingsGroups(m, {
      themes: () => ["dark", "light"],
      previewTheme: (n) => previewed.push(n),
      restoreTheme: () => { restores++; },
      applyTheme: (n) => applied.push(n),
    }).flatMap((g) => g.rows);
    const theme = rows.find((r) => r.key === "pi.theme")!;
    assert.ok(theme.menu, "theme row gained a menu");
    assert.deepEqual(theme.menu!().map((o) => o.value), ["dark", "light"]);
    // A current setting outside the list is offered first so it stays visible.
    m.setTheme("custom-x");
    assert.deepEqual(theme.menu!().map((o) => o.value), ["custom-x", "dark", "light"]);
    theme.preview!("light");
    assert.deepEqual(previewed, ["light"], "preview routed to the non-persisting hook");
    assert.equal(m.getThemeSetting(), "custom-x", "preview never writes the manager");
    theme.previewCancel!();
    assert.equal(restores, 1, "cancel routed to the restore hook");
    theme.set("light");
    assert.equal(m.getThemeSetting(), "light", "commit persists through the manager");
    assert.deepEqual(applied, ["light"], "commit also live-applies");
  });

  it("model lookup: menu is provider/id, commit writes the pair atomically", () => {
    const m = SettingsManager.inMemory({ defaultProvider: "zai", defaultModel: "glm-5" });
    const rows = buildPiSettingsGroups(m, {
      models: () => [
        { provider: "zai", id: "glm-5", description: "GLM-5" },
        { provider: "openai", id: "gpt-5" },
      ],
    }).flatMap((g) => g.rows);
    const model = rows.find((r) => r.key === "pi.defaultModel")!;
    assert.equal(model.value, "zai/glm-5", "value renders as provider/id");
    assert.deepEqual(model.menu!().map((o) => o.value), ["zai/glm-5", "openai/gpt-5"]);
    assert.equal(model.menu!()[1]!.description, undefined, "no description when the model has none");
    model.set("openai/gpt-5");
    assert.equal(m.getDefaultProvider(), "openai");
    assert.equal(m.getDefaultModel(), "gpt-5");
    // Malformed values keep the previous pair instead of writing garbage.
    model.set("no-slash");
    assert.equal(m.getDefaultProvider(), "openai");
    assert.equal(m.getDefaultModel(), "gpt-5");
  });
});
