/**
 * Kernel v5 — selection submenu (OMP's select submenu): Enter on a
 * `values`/`menu` row opens an option list with live preview, type-to-filter,
 * Enter commit and Esc-back-with-restore.
 *
 * Positive-identity assertions throughout: every navigation step asserts the
 * row/option it actually landed on (the recurring vacuous-navigation failure
 * mode: a clamped loop that exhausts without ever matching).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigPanelModel, row, type PanelGroup, type PanelRow } from "../../../lib/panel.js";

const theme = null;
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function panel(rows: PanelRow[], title = "T"): ConfigPanelModel {
  const g: PanelGroup[] = [{ key: "s", label: "Section", rows }];
  const m = new ConfigPanelModel(g, theme, title);
  m.getHeight = () => 40;
  return m;
}

const body = (m: ConfigPanelModel) => m.render(100).slice(3, -13).map(plain).join("\n");

describe("kernel v5 — selection submenu", () => {
  it("Enter opens a menu on the current value; ↑/↓ navigate the real options", () => {
    const m = panel([
      row("mode", "Default mode", "string", "lite", () => {}, {
        values: ["off", "lite", "full", "ultra"],
        description: "Intensity for new sessions.",
      }),
    ]);
    m.handleInput("\r");
    assert.ok(m.menuOpen, "menu open");
    assert.deepEqual(m.menuOptions.map((o) => o.value), ["off", "lite", "full", "ultra"]);
    assert.equal(m.menuIndex, 1, "cursor starts on the current value (lite)");
    m.handleInput("\u001b[B");
    assert.equal(m.menuIndex, 2);
    assert.equal(m.menuOptions[m.menuIndex]!.value, "full", "landed on full");
    m.handleInput("\u001b[A");
    assert.equal(m.menuOptions[m.menuIndex]!.value, "lite", "landed back on lite");
    // Clamps at the ends (OMP SelectList), no wrap.
    m.handleInput("\u001b[A");
    m.handleInput("\u001b[A");
    assert.equal(m.menuOptions[m.menuIndex]!.value, "off", "clamped at the first option");
    for (let i = 0; i < 10; i++) m.handleInput("\u001b[B");
    assert.equal(m.menuOptions[m.menuIndex]!.value, "ultra", "clamped at the last option");
  });

  it("renders the option list with the cursor, (current) mark and filter line", () => {
    const m = panel([
      row("theme", "Theme", "string", "dark", () => {}, {
        values: ["dark", "light", "nord"],
        description: "Color theme.",
      }),
    ]);
    m.handleInput("\r");
    const text = body(m);
    for (const v of ["dark", "light", "nord"]) assert.ok(text.includes(v), `option ${v} renders`);
    assert.ok(text.includes("(current)"), "current value marked");
    assert.ok(text.includes("Type to search"), "empty-query hint shown");
    assert.ok(text.includes("›"), "cursor marker");
    assert.ok(plain(m.render(100).at(-2)!).includes("Enter select"), "footer swaps to menu hints");
  });

  it("keeps the row description in the fixed description area while the menu is open", () => {
    const m = panel([
      row("theme", "Theme", "string", "dark", () => {}, {
        values: ["dark", "light"],
        description: "Theme used when the terminal has a dark background.",
      }),
    ]);
    m.handleInput("\r");
    const full = m.render(100).map(plain).join("\n");
    assert.ok(
      full.includes("Theme used when the terminal has a dark background."),
      "row description still rendered below the menu",
    );
  });

  it("Enter commits: set + dirty + editedKeys; Esc cancels without dirty", () => {
    const cfg = { mode: "full" };
    const m = panel([
      row("mode", "Default mode", "string", cfg.mode, (v) => { cfg.mode = String(v); }, {
        values: ["off", "lite", "full", "ultra"],
      }),
    ]);
    m.handleInput("\r");
    m.handleInput("\u001b[B"); // ultra
    m.handleInput("\r");
    assert.equal(cfg.mode, "ultra", "committed value");
    assert.ok(m.dirty);
    assert.ok(m.editedKeys.has("mode"));
    assert.equal(m.menuOpen, false);

    // Re-open on the committed value, pick the same one → no extra write.
    const m2 = panel([
      row("mode", "Default mode", "string", cfg.mode, () => { throw new Error("must not set same value"); }, {
        values: ["off", "lite", "full", "ultra"],
      }),
    ]);
    m2.handleInput("\r");
    assert.equal(m2.menuIndex, 3, "cursor on ultra");
    m2.handleInput("\r");
    assert.equal(m2.dirty, false, "same-value pick writes nothing");

    // Esc cancels: value untouched, not dirty.
    const m3 = panel([
      row("mode", "Default mode", "string", "full", () => { throw new Error("must not set on cancel"); }, {
        values: ["off", "lite", "full", "ultra"],
      }),
    ]);
    m3.handleInput("\r");
    m3.handleInput("\u001b[B");
    m3.handleInput("\u001b");
    assert.equal(m3.menuOpen, false);
    assert.equal(m3.dirty, false, "cancel never dirties");
  });

  it("preview fires on every highlighted option; Esc fires previewCancel once", () => {
    const seen: string[] = [];
    let cancels = 0;
    const m = panel([
      row("theme", "Theme", "string", "dark", () => {}, {
        values: ["dark", "light", "nord"],
        preview: (v) => seen.push(v),
        previewCancel: () => { cancels++; },
      }),
    ]);
    m.handleInput("\r");
    assert.deepEqual(seen, [], "opening does not preview (no move yet)");
    m.handleInput("\u001b[B"); // light
    m.handleInput("\u001b[B"); // nord
    assert.deepEqual(seen, ["light", "nord"], "preview follows the highlight");
    m.handleInput("\u001b");
    assert.equal(cancels, 1, "Esc fires previewCancel once (row owns the restore)");
    assert.deepEqual(seen, ["light", "nord"], "preview is not re-fired for the original value");
  });

  it("type-to-filter narrows the options; ⌫ edits; Esc clears then backs out", () => {
    const m = panel([
      row("theme", "Theme", "string", "limestone", () => {}, {
        values: ["limestone", "marble", "obsidian", "quartz", "sandstone"],
      }),
    ]);
    m.handleInput("\r");
    assert.equal(m.menuIndex, 0, "current value at index 0");
    m.handleInput("s"); // limestone, obsidian, sandstone
    assert.deepEqual(m.menuOptions.map((o) => o.value), ["limestone", "obsidian", "sandstone"]);
    m.handleInput("a"); // sandstone only
    assert.deepEqual(m.menuOptions.map((o) => o.value), ["sandstone"], "narrowed positively");
    m.handleInput("\u007f"); // ⌫ → "s"
    assert.deepEqual(m.menuOptions.map((o) => o.value), ["limestone", "obsidian", "sandstone"]);
    m.handleInput("\u001b"); // clear query, menu stays
    assert.ok(m.menuOpen, "first Esc cleared the query");
    assert.equal(m.menuOptions.length, 5, "full list back");
    m.handleInput("\u001b"); // back out
    assert.equal(m.menuOpen, false, "second Esc left the menu");
  });

  it("menu claims every key while open — Tab does not switch tabs beneath it", () => {
    const groupsIn: PanelGroup[] = [
      { key: "a", label: "A", tab: "A", rows: [row("a.x", "X", "string", "one", () => {}, { values: ["one", "two"] })] },
      { key: "b", label: "B", tab: "B", rows: [row("b.y", "Y", "toggle", true, () => {})] },
    ];
    const m = new ConfigPanelModel(groupsIn, theme, "T");
    m.handleInput("\r");
    assert.ok(m.menuOpen);
    assert.equal(m.activeTab, 0);
    m.handleInput("\t");
    assert.equal(m.activeTab, 0, "Tab swallowed by the menu");
    assert.ok(m.menuOpen, "menu still open");
  });

  it("dynamic menu() options render as labels with per-option descriptions", () => {
    const m = panel([
      row("model", "Default model", "string", "zai/glm-5", () => {}, {
        menu: () => [
          { value: "zai/glm-5", label: "zai/glm-5", description: "GLM-5" },
          { value: "openai/gpt-5", label: "openai/gpt-5", description: "GPT-5" },
        ],
      }),
    ]);
    m.handleInput("\r");
    assert.deepEqual(m.menuOptions.map((o) => o.value), ["zai/glm-5", "openai/gpt-5"]);
    assert.equal(m.menuIndex, 0, "cursor on the current value");
    const text = body(m);
    assert.ok(text.includes("zai/glm-5 — GLM-5"), "per-option description renders");
    assert.ok(text.includes("openai/gpt-5 — GPT-5"), "second option description renders");
  });

  it("an empty menu() falls back to the inline editor (string rows)", () => {
    const m = panel([row("query", "Query", "string", "abc", () => {}, { menu: () => [] })]);
    m.handleInput("\r");
    assert.equal(m.menuOpen, false, "no menu for an empty provider");
    assert.ok(m.render(100).some((l) => plain(l).includes("abc")), "inline editor took over");
  });

  it("menu window follows the cursor through a long list (positive identity)", () => {
    const values = Array.from({ length: 60 }, (_, i) => `opt-${String(i).padStart(2, "0")}`);
    const m = panel([row("k", "Long", "string", "opt-00", () => {}, { values })]);
    m.handleInput("\r");
    for (let i = 0; i < 25; i++) m.handleInput("\u001b[B");
    assert.equal(m.menuOptions[m.menuIndex]!.value, "opt-25", "cursor advanced 25 steps");
    const text = body(m);
    assert.ok(text.includes("opt-25"), "cursor row visible");
    assert.ok(!text.includes("opt-00"), "window scrolled past the first option");
  });

  it("commit closes the menu and re-renders the rows pane with the new value", () => {
    const m = panel([
      row("mode", "Default mode", "string", "lite", () => {}, {
        values: ["off", "lite", "full"],
        description: "Intensity for new sessions.",
      }),
    ]);
    m.handleInput("\r");
    m.handleInput("\u001b[B"); // full
    m.handleInput("\r");
    const text = m.render(100).map(plain).join("\n");
    assert.ok(text.includes("Default mode") && text.includes("full"), "rows pane back with committed value");
    assert.ok(!text.includes("Type to search"), "menu chrome gone");
  });
});

describe("kernel — rebuild on commit", () => {
  const groups = (rows: PanelRow[]): PanelGroup[] => [{ key: "s", label: "Section", rows }];

  it("menu commit swaps in the rebuilt groups (dynamic row sets)", () => {
    // The shape `rebuildOnCommit` exists for: a row set that grows with the
    // config (per-model override rows).
    let extra = false;
    const build = () => groups([
      row("add", "Add", "string", "off", (v) => { extra = v === "on"; }, { values: ["off", "on"] }),
      ...(extra ? [row("extra", "Extra", "toggle", true, () => {})] : []),
    ]);
    const m = new ConfigPanelModel(build(), null, "T");
    m.getHeight = () => 40;
    m.rebuild = build;

    assert.ok(!m.groups.some((g) => g.rows.some((r) => r.key === "extra")), "extra absent initially");
    m.handleInput("\r");      // open menu
    m.handleInput("\u001b[B"); // "on"
    m.handleInput("\r");       // commit → rebuild
    assert.ok(m.groups.some((g) => g.rows.some((r) => r.key === "extra")), "row added by the commit rebuild");
  });

  it("toggle and inline submit fire the rebuild too", () => {
    let rebuilds = 0;
    let value = "one";
    const build = () => {
      rebuilds++;
      return groups([
        row("t", "Toggle", "toggle", true, () => {}),
        row("s", "Text", "string", value, (v) => { value = String(v); }),
      ]);
    };
    const m = new ConfigPanelModel(build(), null, "T");
    m.getHeight = () => 40;
    m.rebuild = build;
    const before = rebuilds;
    m.handleInput("\r"); // toggle → rebuild
    assert.equal(rebuilds, before + 1, "toggle commit rebuilt");
    m.handleInput("\u001b[B"); // onto the string row
    m.handleInput("\r");       // start the inline editor
    for (let i = 0; i < 3; i++) m.handleInput("\u007f"); // clear "one"
    for (const ch of "two") m.handleInput(ch);
    m.handleInput("\r");       // submit → rebuild after the editor tears down
    assert.equal(value, "two");
    assert.equal(rebuilds, before + 2, "inline submit rebuilt");
  });

  it("selection clamps when a rebuild drops the rows under the cursor", () => {
    let n = 3;
    const build = () => groups(
      Array.from({ length: n }, (_, i) => row(`k${i}`, `K${i}`, "toggle", true, () => { n = 1; })),
    );
    const m = new ConfigPanelModel(build(), null, "T");
    m.getHeight = () => 40;
    m.rebuild = build;
    m.handleInput("\u001b[B");
    m.handleInput("\u001b[B"); // cursor on the last row
    assert.equal(m.selectedIndex, 2, "cursor on k2");
    m.handleInput("\r");       // toggle → shrink to one row → rebuild
    assert.equal(m.groups[0]!.rows.length, 1, "rebuilt to one row");
    assert.equal(m.selectedIndex, 0, "selection clamped, no throw");
  });
});
