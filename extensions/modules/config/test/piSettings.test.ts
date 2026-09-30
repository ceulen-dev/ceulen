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
      "pi.modelThinkingLevels.add",
      "pi.paths.extensions",
      "pi.paths.prompts",
      "pi.paths.skills",
      "pi.paths.themes",
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
    rowAt(m, "pi.defaultProjectTrust").set("Never trust");
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
    assert.deepEqual(trust.values, ["Ask", "Always trust", "Never trust"], "stock labels");
    assert.ok(trust.warning, "auto-trust carries a risk note");
  });

  it("moved rows land in their OMP tabs and sections", () => {
    const m = SettingsManager.inMemory();
    const groupOf = (key: string) =>
      buildPiSettingsGroups(m).find((g) => g.rows.some((r) => r.key === key))!;
    assert.equal(groupOf("pi.transport").tab, "Providers");
    assert.equal(groupOf("pi.transport").label, "Protocol");
    assert.equal(groupOf("pi.httpIdleTimeoutMs").label, "Timeouts");
    assert.equal(groupOf("pi.enableInstallTelemetry").label, "Privacy");
    assert.equal(groupOf("pi.enableSkillCommands").tab, "Tasks");
    assert.equal(groupOf("pi.enableSkillCommands").label, "Commands & Skills");
    assert.equal(groupOf("pi.paths.extensions").tab, "Tools");
    assert.equal(groupOf("pi.paths.themes").label, "Theme");
  });

  it("fullscreen wheel scroll row round-trips auto, numbers and custom values", () => {
    const m = SettingsManager.inMemory();
    const r = rowAt(m, "pi.fullscreenWheelScrollLines");
    assert.equal(r.value, "auto", "stock default");
    r.set("3");
    assert.equal(m.getFullscreenWheelScrollLines(), 3);
    r.set("auto");
    assert.equal(m.getFullscreenWheelScrollLines(), "auto");
    const r2 = rowAt(SettingsManager.inMemory({ fullscreenWheelScrollLines: 7 }),
      "pi.fullscreenWheelScrollLines");
    assert.ok(r2.values!.includes("7"), "a custom persisted value joins the choices");
  });

  it("http idle timeout maps stock labels to ms (disabled = 0)", () => {
    const m = SettingsManager.inMemory();
    const r = rowAt(m, "pi.httpIdleTimeoutMs");
    assert.equal(r.value, "5 min", "default renders as a label");
    r.set("disabled");
    assert.equal(m.getHttpIdleTimeoutMs(), 0);
    r.set("2 min");
    assert.equal(m.getHttpIdleTimeoutMs(), 120_000);
    assert.equal(
      rowAt(SettingsManager.inMemory({ httpIdleTimeoutMs: 45_000 }), "pi.httpIdleTimeoutMs").value,
      "45 sec",
      "custom ms renders as its own label",
    );
  });

  it("default project trust maps stock labels both ways", () => {
    const m = SettingsManager.inMemory();
    const r = rowAt(m, "pi.defaultProjectTrust");
    assert.equal(r.value, "Ask");
    r.set("Never trust");
    assert.equal(m.getDefaultProjectTrust(), "never");
    r.set("Always trust");
    assert.equal(m.getDefaultProjectTrust(), "always");
  });

  it("per-model thinking override rows render, edit and clear", () => {
    const m = SettingsManager.inMemory({ modelThinkingLevels: { "zai/glm-5": "high" } });
    const r = rowAt(m, "pi.modelThinkingLevels.zai/glm-5");
    assert.equal(r.value, "high");
    assert.equal(r.defaultValue, "(clear override)", "an override IS a deviation");
    r.set("low");
    assert.equal(m.getModelThinkingLevel("zai", "glm-5"), "low");
    r.set("(clear override)");
    assert.equal(m.getModelThinkingLevel("zai", "glm-5"), undefined, "cleared");
    // Rebuilding from the manager drops the cleared row.
    assert.ok(!rowsOf(m).some((x) => x.key === "pi.modelThinkingLevels.zai/glm-5"));
  });

  it("Add override row: menu excludes overridden models, commit writes the default level", () => {
    const m = SettingsManager.inMemory({ modelThinkingLevels: { "zai/glm-5": "high" } });
    const rows = buildPiSettingsGroups(m, {
      models: () => [
        { provider: "zai", id: "glm-5", reasoning: true },
        { provider: "openai", id: "gpt-5", reasoning: true },
        { provider: "openai", id: "mini", reasoning: false },
      ],
    }).flatMap((g) => g.rows);
    const add = rows.find((r) => r.key === "pi.modelThinkingLevels.add")!;
    assert.deepEqual(
      add.menu!().map((o) => o.value),
      ["openai/gpt-5", "openai/mini"],
      "overridden models are not offered; provider-sorted",
    );
    add.set("openai/gpt-5");
    assert.equal(m.getModelThinkingLevel("openai", "gpt-5"), "medium", "seeds the global default");
    add.set("not-a-model");
    assert.equal(m.getModelThinkingLevel("not", "a-model"), undefined, "malformed input no-ops");
  });

  it("non-reasoning models seed and offer only the off level", () => {
    const m = SettingsManager.inMemory({ defaultThinkingLevel: "high" });
    const lookup = { models: () => [{ provider: "openai", id: "mini", reasoning: false }] };
    const add = buildPiSettingsGroups(m, lookup)
      .flatMap((g) => g.rows)
      .find((r) => r.key === "pi.modelThinkingLevels.add")!;
    add.set("openai/mini");
    assert.equal(m.getModelThinkingLevel("openai", "mini"), "off", "non-reasoning seeds off");
    // Rebuild: the new override row must reflect the non-reasoning level set.
    const or = buildPiSettingsGroups(m, lookup)
      .flatMap((g) => g.rows)
      .find((r) => r.key === "pi.modelThinkingLevels.openai/mini")!;
    assert.deepEqual(
      or.menu!().filter((o) => o.value !== "(clear override)").map((o) => o.value),
      ["off"],
    );
  });

  it("resource path rows join/split lists through the typed setters", () => {
    const m = SettingsManager.inMemory();
    rowAt(m, "pi.paths.extensions").set("/a/ext /b/ext");
    assert.deepEqual(m.getExtensionPaths(), ["/a/ext", "/b/ext"]);
    rowAt(m, "pi.paths.skills").set("/skills");
    assert.deepEqual(m.getSkillPaths(), ["/skills"]);
    rowAt(m, "pi.paths.prompts").set("/p1,/p2");
    assert.deepEqual(m.getPromptTemplatePaths(), ["/p1", "/p2"]);
    rowAt(m, "pi.paths.themes").set("/themes");
    assert.deepEqual(m.getThemePaths(), ["/themes"]);
    rowAt(m, "pi.paths.extensions").set("");
    assert.deepEqual(m.getExtensionPaths(), [], "empty clears");
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
