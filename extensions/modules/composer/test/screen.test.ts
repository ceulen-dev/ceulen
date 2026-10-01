/**
 * Composed-screen tests — drive the REAL pi-tui renderer (`TuiMainScreen`)
 * with a mock terminal, exactly like production: the TUI composes the frame,
 * strips CURSOR_MARKER, and positions the hardware cursor from
 * `visibleWidth(textBeforeMarker)`.
 *
 * This is the layer the editor-level tests can't reach: SGR state carrying
 * across chrome-wrapped rows, marker placement after wrapping, and the
 * hardware-cursor column pi actually emits.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { IDENTITY_THEME, ShapeEditor, shapeById, SHAPES } from "../lib/shapes.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const COLS = 60;

/** Mock terminal capturing every byte the TUI writes. */
function mockTerminal(cols = COLS, rows = 20) {
  const chunks: string[] = [];
  const term = {
    start: () => {},
    stop: () => {},
    drainInput: async () => {},
    write: (d: string) => {
      chunks.push(d);
    },
    columns: cols,
    rows,
    kittyProtocolActive: false,
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
  };
  return { term, text: () => chunks.join("") };
}

/** Render one frame through the real TUI: compose → cursor extraction. */
function compose(ed: ShapeEditor, cols = COLS, rows = 20): { out: string; lines: string[] } {
  const { term, text } = mockTerminal(cols, rows);
  const tui = new TuiMainScreen(term as never, true);
  tui.addChild(ed as never);
  tui.setFocus(ed as never);
  tui.start();
  tui.renderNow(true);
  const out = text();
  tui.stop();
  const lines = out
    .split(/\r?\n/)
    .map((l) => plain(l).replace(/\x1b/g, ""))
    .filter((l) => l.trim() !== "");
  return { out, lines };
}

function editor(id: string, txt = "hello") {
  const theme = { borderColor: (s: string) => s, fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s };
  const tui = { terminal: { rows: 20 }, requestRender() {} } as never;
  const ed = new ShapeEditor(
    shapeById(id),
    {
      theme: () => IDENTITY_THEME,
      data: () => ({ model: "GLM-5.3", cwd: "~/dev/ceulen", branch: "main", git: { staged: 1, unstaged: 3, untracked: 2 }, pct: 12, window: 1_000_000, rate: 46, stats: "↑1.9M ↓377k R69M", usage: "(router) R:59%/2H3M" }),
    },
    tui,
    theme as never,
    {} as never,
    { embedWorkingStatus: true },
  );
  ed.focused = true;
  ed.setText(txt);
  return ed;
}

describe("composed screen through the real TUI renderer", () => {
  it("never leaks the cursor marker to the terminal, for any shape", () => {
    for (const s of SHAPES) {
      const { out } = compose(editor(s.id));
      assert.ok(!out.includes("\x1b_pi:c"), `${s.id}: cursor marker must not reach the terminal`);
    }
  });

  it("emits a hardware-cursor column inside the composer, for every shape", () => {
    for (const s of SHAPES) {
      const { out } = compose(editor(s.id));
      // pi positions the cursor with \x1b[<row>;<col>H or \x1b[<col>G.
      const moves = [...out.matchAll(/\x1b\[(\d+);(\d+)H|\x1b\[(\d+)G/g)];
      assert.ok(moves.length > 0, `${s.id}: a cursor position is emitted`);
      const last = moves[moves.length - 1]!;
      const col = last[2] !== undefined ? Number(last[2]) : Number(last[3]);
      assert.ok(col > 1 && col <= COLS, `${s.id}: cursor column ${col} inside the composer`);
    }
  });

  it("paints the input text and never exceeds the terminal width", () => {
    for (const s of SHAPES) {
      const { out } = compose(editor(s.id, "hello world"));
      assert.ok(out.includes("hello world"), `${s.id}: input text painted`);
      for (const line of out.split(/\r?\n/)) {
        const w = visibleWidth(plain(line));
        assert.ok(w <= COLS, `${s.id}: row wider than the terminal (${w}): ${JSON.stringify(plain(line))}`);
      }
    }
  });

  it("paints each shape's defining chrome on screen", () => {
    assert.ok(compose(editor("box")).out.includes("╭"), "box top border");
    assert.ok(compose(editor("box")).out.includes("╰"), "box bottom border");
    assert.ok(compose(editor("band")).out.includes("╰─"), "band gutter");
    assert.ok(compose(editor("band")).out.includes("GLM-5.3"), "band status");
    assert.ok(compose(editor("claude")).out.includes("❯"), "claude prompt");
    assert.ok(compose(editor("field")).out.includes("▐"), "field left cap");
    assert.ok(compose(editor("rail")).out.includes("▎"), "rail glyph");
  });

  it("band carries the stock status on screen: icons on every segment, context right-justified", () => {
    // At the default 60 cols the band keeps brand+model+dir and sheds the rest
    // whole; the widest capture exercises every segment at once. Line 1 (right-
    // justified, OMP placement) sits above the band when present: rate · stats
    // · usage on one row.
    const narrowBand = (l: string) => l.includes("π ·");
    const narrow = compose(editor("band")).lines.find(narrowBand)!;
    assert.ok(narrow.includes("π · GLM-5.3"), narrow);
    assert.ok(narrow.includes("📁 ~/dev/ceulen"), narrow);
    assert.ok(narrow.includes("12.0%/1.0M"), `context figure never clipped: ${narrow}`);
    assert.ok(!narrow.includes("…"), "whole segments only, no half-cut segment");

    const wide = compose(editor("band"), 120);
    const wideBand = wide.lines.find((l) => l.includes("π ·"))!;
    const usageLine = wide.lines.find((l) => l.includes("⚡ 46 tok/s"))!;
    assert.ok(usageLine.includes("↑1.9M ↓377k R69M") && usageLine.includes("R:59%"), `rate · stats · usage on line 1: ${usageLine}`);
    assert.ok(!wideBand.includes("⚡"), `line 1 sits above the band: ${wide.lines.join("\n")}`);
    assert.ok(wideBand.includes("⑂ main *3 +1 ?2"), wideBand);
    assert.ok(wideBand.includes("12.0%/1.0M"), wideBand); // right-justification asserted purely in shapes.test

    const claude = compose(editor("claude"), 120).lines.find((l) => l.includes("GLM-5.3"))!;
    assert.ok(claude.includes("⑂ main") && claude.includes("12.0%/1.0M"), claude);
  });

  it("composes at narrow widths without eating closing chrome", () => {
    for (const cols of [30, 40]) {
      const out = compose(editor("box"), cols).out;
      assert.ok(out.includes("╮"), `box top-right corner survives at ${cols}`);
      assert.ok(out.includes("╯"), `box bottom-right corner survives at ${cols}`);
    }
  });

  it("wraps the autocomplete dropdown in shape chrome at exact width", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const { term, text } = mockTerminal(COLS, 20);
    const tui = new TuiMainScreen(term as never, true);
    const ident = (s: string) => s;
    const editorTheme = {
      borderColor: ident,
      selectList: { selectedPrefix: ident, selectedText: ident, description: ident, scrollInfo: ident, noMatch: ident },
    };
    const ed = new ShapeEditor(
      shapeById("box"),
      { theme: () => IDENTITY_THEME, data: () => ({ model: "M", cwd: "d", pct: 1 }) },
      { terminal: { rows: 20 }, requestRender() {} } as never,
      editorTheme as never,
      { matches: () => false } as never,
      { embedWorkingStatus: true },
    );
    ed.focused = true;
    ed.setAutocompleteProvider({
      triggerCharacters: ["/"],
      getSuggestions: async () => ({
        items: [
          { value: "/help", label: "/help", description: "Show help" },
          { value: "/config", label: "/config", description: "Settings" },
        ],
        prefix: "/",
      }),
      applyCompletion: (l: string[], cl: number, cc: number) => ({ lines: l, cursorLine: cl, cursorCol: cc }),
    } as never);
    tui.addChild(ed as never);
    tui.setFocus(ed as never);
    tui.start();
    ed.handleInput("/");
    await sleep(900);
    tui.renderNow(true);
    const out = text();
    tui.stop();
    assert.ok(out.includes("/help"), "dropdown painted");
    const frame = out.slice(out.lastIndexOf("\x1b[3J") + 4);
    const rows = frame.split(/\r?\n/).filter((l) => visibleWidth(l) > 0);
    for (const l of rows) assert.equal(visibleWidth(l), COLS, `autocomplete row width: ${JSON.stringify(plain(l))}`);
  });

  it("each row re-asserts its own colors (no cross-row SGR reliance)", () => {
    // With a themed editor every chrome row must carry its own SGR prefix.
    const themed = {
      border: (s: string) => `\x1b[34m${s}\x1b[39m`,
      accent: (s: string) => `\x1b[36m${s}\x1b[39m`,
      text: (s: string) => s,
      dim: (s: string) => s,
      warn: (s: string) => s,
      error: (s: string) => s,
      fill: (s: string) => s,
      inverse: (s: string) => s,
    };
    const theme = { borderColor: (s: string) => `\x1b[34m${s}\x1b[39m` };
    const tui = { terminal: { rows: 20 }, requestRender() {} } as never;
    const ed = new ShapeEditor(shapeById("box"), { theme: () => themed, data: () => ({ model: "M" }) }, tui, theme as never, {} as never, {
      embedWorkingStatus: true,
    });
    ed.focused = true;
    ed.setText("hi");
    const { out } = compose(ed);
    // Both the top border and the merged bottom row carry color codes.
    const topSeg = out.slice(out.indexOf("╭"), out.indexOf("╮"));
    const botSeg = out.slice(out.indexOf("╰"), out.indexOf("╯"));
    assert.ok(topSeg.includes("\x1b[34m"), "top border colored");
    assert.ok(botSeg.includes("\x1b[34m"), "bottom border colored after the text row");
  });
});
