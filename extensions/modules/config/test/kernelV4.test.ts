/**
 * Kernel v4 tests — OMP-parity chrome: boxed frame, pinned sidebar width,
 * in-pane underlined headings beside the sidebar, tab-derived footer hints,
 * changed/selected colors, responsive sidebar hide, tab-bar compaction.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ConfigPanelModel, row, type PanelGroup } from "../../../lib/panel.js";

const ANSI = {
  accent: "\x1b[36m",
  warning: "\x1b[33m",
  dim: "\x1b[2m",
  muted: "\x1b[90m",
  success: "\x1b[32m",
  border: "\x1b[34m",
  text: "",
  reset: "\x1b[0m",
} as const;
const theme = {
  fg: (token: string, text: string) => `${ANSI[token as keyof typeof ANSI] ?? ""}${text}${ANSI.reset}`,
  bold: (text: string) => text,
  underline: (text: string) => text,
};
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Two tabs, each with sections; Provider's first section label is long
 *  enough to pin the sidebar width for BOTH tabs. */
function sectioned(): PanelGroup[] {
  return [
    {
      key: "a1", label: "Very Long Section", tab: "Appearance", icon: "🎨",
      rows: [row("a.one", "One", "toggle", true, () => {}, { defaultValue: true })],
    },
    {
      key: "a2", label: "Short", tab: "Appearance",
      rows: [row("a.two", "Two", "toggle", true, () => {}, { defaultValue: true })],
    },
    {
      key: "p1", label: "Router", tab: "Providers", icon: "🌐",
      rows: [row("p.one", "Endpoint", "string", "http://x", () => {}, { defaultValue: "" })],
    },
  ];
}

const model = (g: PanelGroup[] = sectioned(), height = 40) => {
  const m = new ConfigPanelModel(g, theme, "Settings");
  m.getHeight = () => height;
  return m;
};

describe("kernel v4 — boxed frame", () => {
  it("draws rounded corners, tee dividers and boxed content rows", () => {
    const out = model().render(100).map(plain);
    assert.ok(out[0]!.startsWith("╭") && out[0]!.endsWith("╮"), "rounded top");
    assert.ok(out.at(-1)!.startsWith("╰") && out.at(-1)!.endsWith("╯"), "rounded bottom");
    const dividers = out.filter((l) => l.startsWith("├"));
    assert.equal(dividers.length, 2, "two tee dividers (tab row, description)");
    assert.ok(dividers.every((l) => l.endsWith("┤")), "dividers end in tees");
    for (const line of out.slice(1, -1)) {
      if (line.startsWith("├")) continue;
      assert.ok(line.startsWith("│") && line.endsWith("│"), `boxed row: ${JSON.stringify(line)}`);
    }
  });

  it("never exceeds the width at any size", () => {
    for (const w of [100, 80, 61, 60, 40, 21]) {
      for (const line of model().render(w)) {
        assert.ok(visibleWidth(line) <= w, `line wider than ${w}: ${JSON.stringify(line)}`);
      }
    }
  });
});

describe("kernel v4 — pinned sidebar", () => {
  it("keeps the divider column identical across tabs", () => {
    const m = model();
    const colOf = (line: string) => line.indexOf("│ ", line.indexOf("│ ") + 1);
    const wide = m.render(100).map(plain);
    const before = wide.find((l) => l.includes("│ ") && l.includes("Very Long Section"))!;
    m.handleInput("\u001b[C"); // switch to Providers
    const after = m.render(100).map(plain);
    const providersRow = after.find((l) => l.includes("Router") && l.includes("│"))!;
    assert.ok(before && providersRow, "both tabs render a rail");
    assert.equal(colOf(before), colOf(providersRow), "sidebar column pinned across tabs");
  });

  it("hides below a 60-column rows pane and shows in-pane headings instead", () => {
    const wide = model().render(100).map(plain);
    assert.ok(wide.some((l) => l.includes("│ ") && l.includes("Very Long Section")), "sidebar wide");
    const narrow = model().render(61).map(plain);
    assert.ok(narrow.some((l) => l.includes("Very Long Section")), "heading still present");
    // No sidebar rail inside the lines (borders sit at the edges).
    assert.ok(!narrow.some((l) => l.includes("│ ") && l.trimStart().startsWith("│") && l.indexOf("│ ", 2) > 0), "no sidebar rail at 61 cols");
    assert.ok(!narrow.some((l) => l.includes("Very Long Section  │")), "no sidebar column");
  });
});

describe("kernel v4 — headings & colors", () => {
  it("renders in-pane section headings even WITH the sidebar (OMP shows both)", () => {
    const out = model().render(100).map(plain);
    // One line carries BOTH the sidebar entry and the in-pane heading:
    // `Very Long Section  │ Very Long Section`.
    const both = out.find((l) => (l.match(/Very Long Section/g) ?? []).length === 2);
    assert.ok(both, `sidebar entry + in-pane heading share a line: ${JSON.stringify(out.slice(2, 5))}`);
    // Sections are separated by in-pane headings in document order.
    const order = out.filter((l) => l.includes("Very Long Section") || l.includes("Short"));
    assert.ok(order.length >= 3, "heading + rows for both sections");
  });

  it("changed beats selected on the VALUE; selected wins the LABEL", () => {
    const g: PanelGroup[] = [{
      key: "x", label: "X",
      rows: [
        row("x.a", "Changed", "string", "now", () => {}, { defaultValue: "before" }),
        row("x.b", "Unchanged", "string", "same", () => {}, { defaultValue: "same" }),
      ],
    }];
    const m = model(g);
    const out = m.render(100);
    // Row 0 selected + changed: label accent, value warning.
    const r0 = out.find((l) => l.includes("Changed"))!;
    assert.ok(r0.includes(`${ANSI.accent}Changed`), "selected label accent");
    assert.ok(r0.includes(`${ANSI.warning}now`), "changed value warning");
    // Row 1 unselected + unchanged: plain label, muted value.
    const r1 = out.find((l) => l.includes("Unchanged"))!;
    assert.ok(!r1.includes(`${ANSI.warning}Unchanged`), "unchanged label not warning");
  });

  it("changed (unselected) also colors the LABEL — OMP's theme fn", () => {
    const g: PanelGroup[] = [{
      key: "x", label: "X",
      rows: [
        row("x.a", "Stable", "string", "same", () => {}, { defaultValue: "same" }),
        row("x.b", "Moved", "string", "now", () => {}, { defaultValue: "before" }),
      ],
    }];
    const m = model(g);
    m.handleInput("\u001b[B"); // select "Moved" — no; we want it unselected, so move back
    m.handleInput("\u001b[A");
    const out = m.render(100);
    const r = out.find((l) => l.includes("Moved"))!;
    assert.ok(r.includes(`${ANSI.warning}Moved`), "changed label warning-styled");
  });
});

describe("kernel v4 — tab-derived footer hints", () => {
  it("all-toggle tabs say 'toggle', mixed tabs say 'change'", () => {
    const togglesOnly: PanelGroup[] = [{
      key: "t", label: "T",
      rows: [row("t.a", "A", "toggle", true, () => {})],
    }];
    assert.ok(plain(model(togglesOnly).render(100).at(-2)!).includes("Enter toggle"));

    const mixed: PanelGroup[] = [{
      key: "t", label: "T",
      rows: [row("t.a", "A", "toggle", true, () => {}), row("t.b", "B", "string", "x", () => {})],
    }];
    assert.ok(plain(model(mixed).render(100).at(-2)!).includes("Enter change"));
  });

  it("info-only tabs drop the Enter pair; single-section tabs drop the section jump", () => {
    const infoOnly: PanelGroup[] = [{
      key: "i", label: "I",
      rows: [row("i.a", "Note", "info", "v", () => {})],
    }];
    const hint = plain(model(infoOnly).render(100).at(-2)!);
    assert.ok(!hint.includes("Enter"), `no Enter pair: ${hint}`);
    assert.ok(!hint.includes("section"), "single section → no section jump");

    const multi = sectioned();
    assert.ok(plain(model(multi).render(100).at(-2)!).includes("section"), "2+ sections → section jump");
  });
});

describe("kernel v4 — tab bar compaction", () => {
  it("keeps the ACTIVE tab's full label while collapsing inactive tabs to icons", () => {
    const g: PanelGroup[] = [
      { key: "a", label: "Appearance", icon: "🎨", rows: [row("a.x", "X", "toggle", true, () => {})] },
      { key: "m", label: "Model", icon: "🤖", rows: [row("m.x", "Y", "toggle", true, () => {})] },
      { key: "i", label: "Interaction", icon: "⌨️", rows: [row("i.x", "Z", "toggle", true, () => {})] },
      { key: "p", label: "Providers", icon: "🌐", rows: [row("p.x", "W", "toggle", true, () => {})] },
    ];
    const m = model(g);
    m.getHeight = () => 24;
    // Narrow enough that not every full label fits.
    const out = m.render(46).map(plain);
    const bar = out.find((l) => l.includes("Appearance"))!;
    assert.ok(bar, "active tab label visible");
    assert.ok(bar.includes("Appearance"), "active keeps its label");
    assert.ok(!bar.includes("Interaction"), "far inactive tabs collapsed to icons");
  });
});
