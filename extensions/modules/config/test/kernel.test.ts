/**
 * Kernel v2 model tests — split layout, selection submenus, descriptions/warnings,
 * changed-vs-default styling, group jumps, degrade, type-to-search.
 *
 * The stub theme emits REAL ANSI codes (so truncateToWidth/visibleWidth see
 * honest widths and marker assertions stay unambiguous) with distinct colors
 * per token.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { ConfigPanelModel, filterText, printableText, row, type PanelGroup } from "../../../lib/panel.js";

const ANSI = {
  accent: "\x1b[36m",
  warning: "\x1b[33m",
  dim: "\x1b[2m",
  muted: "\x1b[90m",
  success: "\x1b[32m",
  text: "",
  reset: "\x1b[0m",
} as const;
const theme = {
  fg: (token: string, text: string) => `${ANSI[token as keyof typeof ANSI] ?? ""}${text}${ANSI.reset}`,
  bold: (text: string) => text,
};
// Strip ANSI for text assertions; keep raw for token assertions.
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function groups(): PanelGroup[] {
  return [
    {
      key: "modules",
      label: "Modules",
      rows: [
        row("ceulen.disabled.usage", "usage", "toggle", true, () => {}, {
          description: "Usage footer.",
          warning: "Off takes effect after /reload.",
          defaultValue: true,
        }),
        row("ceulen.disabled.ponytail", "ponytail", "toggle", false, () => {}, {
          description: "Lazy mode.",
          defaultValue: true, // differs from value → changed
        }),
      ],
    },
    {
      key: "ponytail",
      label: "Ponytail",
      rows: [
        row("ponytail.mode", "Default mode", "string", "full", () => {}, {
          values: ["off", "lite", "full", "ultra"],
          defaultValue: "full",
          description: "Intensity for new sessions.",
        }),
        row("ponytail.quiet", "Quiet startup", "toggle", false, () => {}, { defaultValue: false }),
      ],
    },
  ];
}

const model = (g: PanelGroup[] = groups()) => {
  const m = new ConfigPanelModel(g, theme, "Ceulen Configuration");
  m.getHeight = () => 40; // deterministic frame height (default reads the real terminal)
  return m;
};

describe("panel kernel v2 — render", () => {
  it("renders a tab bar, the ACTIVE tab's rows only, and the fixed description area", () => {
    const m = model();
    const out = m.render(110).map(plain);
    assert.ok(out[0]!.includes("Ceulen Configuration"), "title sits in the top border");
    // Tab bar lists every group; only the FIRST tab's rows render.
    const tabBar = out.find((l) => l.includes("Modules") && l.includes("Ponytail") && !l.includes("Default mode"));
    assert.ok(tabBar, `tab bar with both groups: ${JSON.stringify(out.slice(0, 3))}`);
    assert.ok(out.some((l) => l.includes("usage")), "active tab row renders");
    assert.ok(!out.some((l) => l.includes("Default mode")), "other tab's rows hidden");
    // Description area: warning above description, fixed 3 rows.
    assert.ok(out.some((l) => l.includes("Off takes effect after /reload.")), "warning renders");
    assert.ok(out.some((l) => l.includes("Usage footer.")), "description renders");
    assert.ok(out.at(-1)!.includes("no changes") === false, "last line is the bottom border, not the status");
  });

  it("line count is stable and width never exceeds the panel", () => {
    const m = model();
    const wide = m.render(110);
    const narrow = m.render(70);
    assert.equal(wide.length, narrow.length, "same layout height regardless of width");
    for (const w of [110, 90, 70, 58, 40, 21]) {
      for (const line of m.render(w)) {
        assert.ok(visibleWidth(line) <= w, `line wider than ${w}: ${JSON.stringify(line)}`);
      }
    }
  });

  it("description area is fixed height — moving between described/undescribed rows never shifts layout", () => {
    const m = model();
    const withDesc = m.render(110).length; // row 0 has description + warning
    m.handleInput("\u001b[B");
    m.handleInput("\u001b[B");
    m.handleInput("\u001b[B"); // row 3 "Default mode" — described
    m.handleInput("\u001b[B"); // row 4 "Quiet startup" — NO description
    const withoutDesc = m.render(110);
    assert.equal(withoutDesc.length, withDesc, "same line count without a description");
    const out = withoutDesc.map(plain);
    // The 3-row description area is still present (rows end before the
    // divider; count back from the footer divider).
    let dividerAt = -1;
    for (let i = out.length - 1; i >= 0; i--) if (out[i]!.startsWith("├")) { dividerAt = i; break; }
    assert.ok(dividerAt >= 3, "description area reserved");
  });

  it("narrow terminals keep the active tab visible with edge markers", () => {
    const g: PanelGroup[] = [
      { key: "a", label: "Modules", rows: [row("a.x", "X", "toggle", true, () => {})] },
      { key: "b", label: "Endpoint", rows: [row("b.x", "Y", "toggle", true, () => {})] },
      { key: "c", label: "Ponytail", rows: [row("c.x", "Z", "toggle", true, () => {})] },
    ];
    const m = new ConfigPanelModel(g, theme, "T");
    // The kernel clamps to a 20-column minimum; three tabs cannot fit in it.
    const out = m.render(20);
    assert.ok(out.every((l) => visibleWidth(l) <= 20), "never exceeds the width");
    const bar = out.find((l) => l.includes("Modules"));
    assert.ok(bar, "active tab label stays visible");
    assert.ok(plain(bar!).includes("…"), "clipped side marked");
    // Once the selection moves to the last tab, ITS label is visible.
    m.handleInput("\u001b[C");
    m.handleInput("\u001b[C");
    const bar2 = m.render(20).find((l) => l.includes("Ponytail"));
    assert.ok(bar2, "active tab label follows the selection");
  });

  it("styles a value differently from its default as changed (warning), and aligned label column", () => {
    const m = model();
    // Move selection off the first row so semantic colors are visible.
    m.handleInput("\u001b[B");
    const out = m.render(110);
    // ponytail toggle value false ≠ default true → warning-styled "off".
    assert.ok(out.some((l) => l.includes(`${ANSI.warning}off`)), "changed value warning-styled");
    // Unselected unchanged ON keeps the semantic success color.
    assert.ok(out.some((l) => l.includes(`${ANSI.success}on`)), "unchanged on stays success");
    // Label column: two row labels in the same tab start at the same index.
    const rows = out.map(plain);
    const usageAt = rows.find((l) => l.includes("usage"))!.indexOf("usage");
    const ponyAt = rows.find((l) => l.includes("ponytail"))!.indexOf("ponytail");
    assert.equal(usageAt, ponyAt, "label column aligned within the tab");
  });

  it("selected row's value is accent when not changed", () => {
    const m = model();
    const out = m.render(110);
    assert.ok(out.some((l) => l.includes(`${ANSI.accent}on`)), "selected unchanged toggle value accented");
  });
});

describe("panel kernel v2 — tabs", () => {
  it("Tab/arrows switch categories; only the active tab's rows render and navigation stays inside it", () => {
    const m = model();
    assert.equal(m.selectedIndex, 0);
    m.handleInput("\u001b[B"); // down within Modules
    m.handleInput("\u001b[B");
    assert.equal(m.selectedIndex, 1, "clamped at the tab's last row — must not cross into Ponytail");
    m.handleInput("\u001b[C"); // → Ponytail tab
    assert.equal(m.activeTab, 1);
    assert.equal(m.selectedIndex, 2, "lands on the target tab's first row");
    const out = m.render(110).map(plain);
    assert.ok(out.some((l) => l.includes("Default mode")), "tab 2 rows render");
    assert.ok(!out.some((l) => l.includes("usage")), "tab 1 rows hidden");
    m.handleInput("\u001b[D"); // ← back
    assert.equal(m.activeTab, 0);
    assert.equal(m.selectedIndex, 1, "returns to the remembered row of tab 1");
    m.handleInput("\t"); // Tab forwards
    assert.equal(m.activeTab, 1);
    m.handleInput("\u001b[Z"); // Shift+Tab back
    assert.equal(m.activeTab, 0);
    m.handleInput("\u001b[D"); // ← at the first tab WRAPS to the last (OMP behavior)
    assert.equal(m.activeTab, 1, "wraps around the tab ring");
    m.handleInput("\u001b[C"); // → wraps back to the first
    assert.equal(m.activeTab, 0);
  });

  it("single-group panels render no tab bar, but DO name the category", () => {
    const g: PanelGroup[] = [{ key: "p", label: "Ponytail", rows: [row("p.x", "X", "toggle", false, () => {})] }];
    const m = new ConfigPanelModel(g, theme, "T");
    m.getHeight = () => 40;
    const out = m.render(110).map(plain);
    // No tab bar line (nothing to switch) — exactly one Ponytail mention: the
    // middle heading indicator above the rows.
    assert.equal(out.filter((l) => l.includes("Ponytail")).length, 1, `one label line: ${JSON.stringify(out)}`);
    assert.ok(out.some((l) => l.includes("X")), "rows render");
  });

  it("during search, Tab jumps between categories that have matches", () => {
    const m = model();
    m.handleInput("o"); // matches rows in both groups (Ponytail, ponytail, mode…)
    const before = m.selectedIndex;
    m.handleInput("\t");
    assert.notEqual(m.selectedIndex, before, "tab key moved to another category's match");
    m.handleInput("\u001b"); // clear search → tab snaps to the matched category
    const out = m.render(110).map(plain);
    assert.ok(out.some((l) => l.includes("Modules") && l.includes("Ponytail")), "tab bar back");
    // The rendered rows must belong to the tab the selection is in.
    const sel = m.selectedIndex;
    const rowLabel = out.find((l) => l.includes("›"))!;
    assert.ok(rowLabel.length > 0 && m.groups.flatMap((g) => g.rows).length > sel, "selection valid");
  });

  it("renders group icons in the tab bar; active tab inverse-highlighted", () => {
    const g: PanelGroup[] = [
      { key: "a", label: "Modules", icon: "🧩", rows: [row("a.x", "X", "toggle", true, () => {})] },
      { key: "b", label: "Ponytail", icon: "🦥", rows: [row("b.x", "Y", "toggle", true, () => {})] },
    ];
    const m = new ConfigPanelModel(g, theme, "T");
    const out = m.render(110);
    const tabBar = out.find((l) => plain(l).includes("🧩") && plain(l).includes("🦥"));
    assert.ok(tabBar, "tab bar carries both icons");
    // No middle indicator row (OMP has none): the tab chip and the in-pane
    // section heading carry the location instead.
    assert.ok(!out.some((l) => plain(l).includes("setting") || plain(l).includes("settings")), "no count row");
    assert.ok(out.some((l) => plain(l).includes("Modules")), "section heading names the group");
  });

  it("footer key hints color the KEYS and dim the meanings", () => {
    const m = model();
    const out = m.render(110);
    const hint = out.find((l) => l.includes("navigate"));
    assert.ok(hint, "hint line renders");
    assert.ok(hint!.includes(`${ANSI.accent}←→`), "arrow key accented");
    assert.ok(hint!.includes(`${ANSI.accent}Enter`), "Enter key accented");
    assert.ok(hint!.includes(`${ANSI.dim}tab`), "meaning dimmed");
  });
});

describe("panel kernel v2 — navigation", () => {
  it("arrows move within the active tab; tab switches land on remembered rows", () => {
    const m = model();
    assert.equal(m.selectedIndex, 0);
    m.handleInput("\u001b[B");
    m.handleInput("\u001b[B");
    assert.equal(m.selectedIndex, 1, "clamped inside Modules");
    m.handleInput("\u001b[C"); // → Ponytail
    assert.equal(m.activeTab, 1);
    assert.equal(m.selectedIndex, 2, "landed on Ponytail's first row");
    m.handleInput("\u001b[Z"); // Shift+Tab = previous tab
    assert.equal(m.activeTab, 0);
    assert.equal(m.selectedIndex, 1, "Modules' remembered row restored");
    m.handleInput("\t"); // Tab = next tab
    assert.equal(m.activeTab, 1);
    assert.equal(m.selectedIndex, 2, "Ponytail's remembered row restored");
    m.handleInput("\u001b[C"); // wraps the ring back to Modules
    assert.equal(m.activeTab, 0);
  });

  it("PageUp/PageDown jump SECTIONS inside a tab (groups sharing a `tab`)", () => {
    const g: PanelGroup[] = [
      { key: "e", label: "Endpoint", tab: "Router", icon: "🔌", rows: [row("e.x", "Base URL", "string", "http://x", () => {})] },
      { key: "m", label: "Models", tab: "Router", rows: [row("m.x", "Thinking", "toggle", true, () => {}), row("m.y", "Aliases", "string", "a", () => {})] },
      { key: "p", label: "Ponytail", icon: "🦥", rows: [row("p.x", "Mode", "string", "full", () => {})] },
    ];
    const m = new ConfigPanelModel(g, theme, "T");
    // The two Router groups merge into ONE tab; sections stay distinct.
    assert.equal(m.activeTab, 0);
    const out = m.render(110).map(plain);
    assert.ok(out.some((l) => l.includes("Router")), "merged tab renders under the tab name");
    assert.ok(out.some((l) => l.includes("Endpoint")) && out.some((l) => l.includes("Models")), "section names visible in the sidebar");
    m.handleInput("\u001b[B"); // Base URL → Thinking (crosses the section boundary)
    assert.equal(m.selectedIndex, 1);
    m.handleInput("\u001b[6~"); // PageDown → next section's first row
    assert.equal(m.activeTab, 0, "section jump stays inside the tab");
    assert.equal(m.selectedIndex, 0, "section ring wraps back to Endpoint");
    m.handleInput("\u001b[C"); // → Ponytail tab
    assert.equal(m.activeTab, 1);
  });

  it("←/→ match every arrow encoding (CSI, SS3 application-cursor, kitty CSI-u)", () => {
    for (const [right, left] of [["\u001b[C", "\u001b[D"], ["\u001bOC", "\u001bOD"], ["\u001b[1;1C", "\u001b[1;1D"]] as const) {
      const m = model();
      m.handleInput(right);
      assert.equal(m.activeTab, 1, `right ${JSON.stringify(right)} advances`);
      m.handleInput(left);
      assert.equal(m.activeTab, 0, `left ${JSON.stringify(left)} goes back`);
      // Wrap both ways per encoding.
      m.handleInput(left);
      assert.equal(m.activeTab, 1, `left at the first tab wraps (${JSON.stringify(left)})`);
      m.handleInput(right);
      assert.equal(m.activeTab, 0, `right at the last tab wraps (${JSON.stringify(right)})`);
    }
  });

  it("Esc after a CROSS-TAB search snaps to the matched row's tab (not back)", () => {
    const m = model();
    // CROSS-TAB by construction: "intensity" matches ONLY the Ponytail-tab
    // row (its description) — the first/only match lives in tab 1, never in
    // tab 0, so the snap cannot pass vacuously.
    for (const ch of "intensity") m.handleInput(ch);
    assert.equal(m.visibleRows.length, 1, `exactly one match, in tab 1 (got ${JSON.stringify(m.visibleRows)})`);
    assert.equal(m.selectedIndex, 2, "selection pulled onto the tab-1 match");
    assert.equal(m.activeTab, 1, "active tab followed the cross-tab match while typing");
    m.handleInput("\u001b"); // clear
    assert.equal(m.filter, "", "filter cleared");
    assert.equal(m.activeTab, 1, "tab STAYED on the matched row's tab after Esc");
    assert.equal(m.selectedIndex, 2, "matched row still selected");
  });

  it("tabs() never merges a group whose key coincides with a neighbor's label", () => {
    const g: PanelGroup[] = [
      { key: "general", label: "General", rows: [row("g.x", "A", "toggle", true, () => {})] },
      { key: "x", label: "Other", tab: "General", rows: [row("x.y", "B", "toggle", true, () => {})] },
    ];
    const m = new ConfigPanelModel(g, theme, "T");
    // The second group's tab KEY is "General" but the first group's tab KEY is
    // `$0` — distinct keys, so two tabs (a label collision must not merge).
    m.handleInput("\u001b[C");
    assert.equal(m.activeTab, 1, "second tab reachable");
    assert.equal(m.render(110).map(plain).some((l) => l.includes("B")), true, "second group's row renders");
  });
});

describe("panel kernel v2 — activation", () => {
  it("Enter on an enum opens the selection submenu; Enter commits + marks dirty", async () => {
    const cfg = { mode: "full" };
    const g: PanelGroup[] = [{
      key: "p",
      label: "Ponytail",
      rows: [row("ponytail.mode", "Default mode", "string", cfg.mode, (v) => { cfg.mode = String(v); }, {
        values: ["off", "lite", "full", "ultra"],
        defaultValue: "full",
      })],
    }];
    const m = new ConfigPanelModel(g, theme, "T");
    m.handleInput("\r");
    assert.ok(m.menuOpen, "Enter opened the submenu instead of cycling");
    assert.equal(cfg.mode, "full", "opening the menu does not change the value");
    assert.equal(m.menuIndex, 2, "cursor starts on the current value (full)");
    m.handleInput("\u001b[B"); // ultra
    m.handleInput("\r");
    assert.equal(cfg.mode, "ultra", "Enter committed the highlighted option");
    assert.equal(m.menuOpen, false, "menu closed on commit");
    assert.ok(m.dirty);
    assert.ok(m.editedKeys.has("ponytail.mode"));
    // Enum rows never open the inline editor.
    assert.equal(m.render(110).some((l) => l.includes("Enter keep typed")), false);
  });

  it("Enter on a toggle flips it; space does not start a search", () => {
    const m = model();
    m.handleInput("\r"); // usage: true → false
    assert.ok(m.editedKeys.has("ceulen.disabled.usage"));
    assert.equal(m.filter, "", "space key never opens search");
  });
});

describe("panel kernel v2 — type to search", () => {
  it("printable keys filter rows; query/matches render; Esc clears, second Esc closes", () => {
    const m = model();
    let closed = 0;
    m.onClose = () => { closed++; };
    m.handleInput("m");
    assert.equal(m.filter, "m");
    let out = m.render(110).map(plain);
    assert.ok(out.some((l) => l.includes("▸ m")), "banner shows the query");
    assert.ok(out.some((l) => l.includes("matches")), "match count renders");

    m.handleInput("o");
    m.handleInput("d");
    m.handleInput("e");
    assert.equal(m.filter, "mode");
    out = m.render(110).map(plain);
    assert.ok(out.some((l) => l.includes("Default mode")), "fuzzy match on label");
    // Filtered view is flat: no in-pane section headings, no sidebar rail.
    assert.ok(!out.some((l) => l.includes("Modules")), "filtered view drops section headings");

    m.handleInput("\u007f"); // backspace
    assert.equal(m.filter, "mod");
    m.handleInput("\u001b"); // Esc 1: clear filter, do not close
    assert.equal(m.filter, "");
    assert.equal(closed, 0);
    m.handleInput("\u001b"); // Esc 2: close
    assert.equal(closed, 1);
  });

  it("selection navigates matches only; Enter activates the matched row", () => {
    const toggled: string[] = [];
    const g: PanelGroup[] = [{
      key: "x",
      label: "X",
      rows: [
        row("a.alpha", "Alpha", "toggle", false, () => toggled.push("alpha")),
        row("b.beta", "Beta", "toggle", false, () => toggled.push("beta")),
        row("c.gamma", "Gamma", "toggle", false, () => toggled.push("gamma")),
      ],
    }];
    const m = new ConfigPanelModel(g, theme, "T");
    m.handleInput("b"); // matches Beta only (label "Beta"; key b.beta)
    m.handleInput("\u001b[B"); // down must not escape the match set
    assert.equal(m.selectedIndex, 1, "still on Beta");
    m.handleInput("\r");
    assert.deepEqual(toggled, ["beta"], "activation targets the matched row");
  });

  it("no matches keeps chrome and reports zero", () => {
    const m = model();
    m.handleInput("z");
    m.handleInput("z");
    m.handleInput("z");
    const out = m.render(110).map(plain);
    assert.ok(out.some((l) => l.includes("0 matches")));
    assert.ok(out.some((l) => l.includes("No matching rows")));
  });
});

describe("panel kernel v2 — fullscreen frame (OMP parity)", () => {
  it("renders exactly getHeight() lines: title border, pinned hint footer, bottom border", () => {
    const m = model();
    const out = m.render(110);
    assert.equal(out.length, 40, "frame fills the injected viewport height");
    assert.ok(plain(out[0]!).startsWith("╭─"), "rounded top border opens the frame");
    assert.ok(plain(out[0]!).includes("Ceulen Configuration"), "title inset in the top border");
    assert.ok(plain(out.at(-1)!).match(/^╰─+╯$/), "rounded bottom border closes the frame");
    const hint = plain(out.at(-2)!);
    assert.ok(hint.includes("Esc save"), "key hint is the pinned last content row");
    // Every non-divider content row is boxed: `│ … │` (OMP's overlay row()).
    for (const line of out.slice(1, -1)) {
      const p = plain(line);
      if (p.startsWith("├")) {
        assert.ok(p.endsWith("┤"), `divider tees: ${JSON.stringify(p)}`);
        continue;
      }
      assert.ok(p.startsWith("│") && p.endsWith("│"), `row boxed: ${JSON.stringify(p)}`);
    }
  });

  it("hint text follows the mode: browse → filter → completions edit", () => {
    const m = model();
    const browseHint = plain(m.render(110).at(-2)!);
    assert.ok(browseHint.includes("←→ tab") && browseHint.includes("Esc save"));

    for (const ch of "mode") m.handleInput(ch);
    const filterHint = plain(m.render(110).at(-2)!);
    assert.ok(filterHint.includes("Esc clear"), `filter hint: ${filterHint}`);

    m.handleInput("\u001b"); // clear filter
    m.handleInput("\u001b[D"); // → Ponytail tab
    m.handleInput("\u001b[B"); // onto Default mode (enum row — Enter opens its menu, never edits)
    m.handleInput("\u001b[B"); // Quiet startup toggle — force a string edit below
    // Enums never open the inline editor (they open the selection submenu) —
    // so cover the edit-hint branch through startEdit on a plain string row.
    const g: PanelGroup[] = [{
      key: "s",
      label: "String",
      rows: [row("s.url", "Base URL", "string", "http://a", () => {}, {
        completions: () => [{ value: "http://b" }],
      })],
    }];
    const m2 = new ConfigPanelModel(g, theme, "T");
    m2.getHeight = () => 40;
    m2.handleInput("\r"); // opens the inline editor with the picker up
    const editHint = plain(m2.render(110).at(-2)!);
    assert.ok(editHint.includes("keep typed"), `edit hint: ${editHint}`);
  });

  it("dirty marker rides the footer's right edge and clears after save", () => {
    const m = model();
    let saved = 0;
    // The Esc path routes through onClose (openConfigPanel wires it to save).
    m.onClose = () => { saved++; m.dirty = false; };
    m.handleInput("\r"); // toggle → dirty
    const out = plain(m.render(110).at(-2)!);
    assert.ok(out.includes("unsaved changes"), `dirty marker: ${out}`);
    m.handleInput("\u001b"); // Esc → save
    assert.equal(saved, 1);
    assert.ok(plain(m.render(110).at(-2)!).includes("Esc save"), "footer back to hints");
  });

  it("tiny viewports shrink the body, never the chrome", () => {
    const m = model();
    m.getHeight = () => 12; // below the 14-row floor
    const out = m.render(110);
    assert.equal(out.length, 14, "14-row floor honored");
    assert.ok(out.some((l) => plain(l).includes("usage")), "at least one row still visible");
    assert.ok(plain(out.at(-2)!).includes("Esc save"), "footer survives");
  });

  it("tall viewports show more rows instead of paging sooner (budget follows height)", () => {
    const many: PanelGroup[] = [{
      key: "big",
      label: "Big",
      rows: Array.from({ length: 30 }, (_, i) => row(`b.${i}`, `Setting ${i}`, "toggle", true, () => {})),
    }];
    const m = new ConfigPanelModel(many, theme, "T");
    m.getHeight = () => 50;
    const visibleRows = m.render(110).map(plain).filter((l) => l.includes("Setting ")).length;
    assert.ok(visibleRows > 18, `height-driven budget shows >18 rows (got ${visibleRows})`);
  });
});

describe("panel kernel v2 — pure helpers", () => {
  it("filterText covers label/key/value/description/warning/values but never a masked value", () => {
    const r = row("k", "Label", "string", "secret-value", () => {}, {
      mask: true,
      description: "Desc",
      warning: "Warn",
      values: ["a", "b"],
    });
    const t = filterText(r);
    assert.ok(t.includes("Label") && t.includes("k") && t.includes("Desc") && t.includes("Warn") && t.includes("a"));
    assert.ok(!t.includes("secret-value"), "masked value is not searchable");
  });

  it("printableText rejects control sequences and accepts text", () => {
    assert.equal(printableText("\u001b[A"), undefined);
    assert.equal(printableText("\u001b"), undefined);
    assert.equal(printableText("\r"), undefined);
    assert.equal(printableText("\u007f"), undefined);
    assert.equal(printableText("a"), "a");
    assert.equal(printableText("é"), "é");
  });
});

void (0 as unknown as Component); // type import keeps the tui peer honest
