/**
 * ShapeEditor render tests — the critical invariants:
 *  1. chrome wraps every content row at the exact full width;
 *  2. the CURSOR_MARKER survives wrapping and lands at the right column
 *     (the TUI measures `visibleWidth(textBeforeMarker)` on the final line);
 *  3. text is laid out at the shape's content width (no overflow/cut-off);
 *  4. the working spinner stays visible while a turn runs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { IDENTITY_THEME, ShapeEditor, shapeById } from "../lib/shapes.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const theme = { borderColor: (s: string) => s, fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s };
// Loose stubs: only the surface the editor touches (pi's TUI type is huge).
const tui = { terminal: { rows: 30 }, requestRender() {} } as never;

/** Build an editor with text and the cursor at the end (focused → marker). */
function editor(id: string, text = "hello", data: { model?: string; cwd?: string; pct?: number | null } = {}) {
  const ed = new ShapeEditor(shapeById(id), { theme: () => IDENTITY_THEME, data: () => data }, tui, theme as never, {} as never, { embedWorkingStatus: true });
  ed.focused = true;
  ed.setText(text);
  return ed;
}

const rendered = (ed: ShapeEditor, w = 40) => ed.render(w);

describe("ShapeEditor rendering", () => {
  it("every rendered line is exactly the requested width, for every shape", () => {
    for (const id of ["band", "box", "claude", "pi", "borderless", "rule", "field", "rail"]) {
      for (const w of [24, 40, 61]) {
        for (const line of rendered(editor(id), w)) {
          assert.equal(visibleWidth(line), w, `${id}@${w}: ${JSON.stringify(plain(line))}`);
        }
      }
    }
  });

  it("keeps the cursor marker and reports the expected cursor column", () => {
    // pi: no side chrome → text starts at padX = 1; "hello" cursor at end ⇒ x=6.
    const pi = rendered(editor("pi"), 40);
    const piRow = pi.find((l) => l.includes(CURSOR_MARKER));
    assert.ok(piRow, "marker preserved (pi)");
    assert.equal(visibleWidth(piRow!.slice(0, piRow!.indexOf(CURSOR_MARKER))), 6);

    // box: border + padX(2) ⇒ 3 cells of chrome before text.
    const box = rendered(editor("box"), 40);
    const boxRow = box.find((l) => l.includes(CURSOR_MARKER));
    assert.ok(boxRow, "marker preserved (box)");
    assert.equal(visibleWidth(boxRow!.slice(0, boxRow!.indexOf(CURSOR_MARKER))), 8);

    // band: gutter `╰─ ` (3 cells) ⇒ cursor sits 3 cells right of the text start.
    const band = rendered(editor("band"), 40);
    const bandRow = band.find((l) => l.includes(CURSOR_MARKER));
    assert.ok(bandRow, "marker preserved (band)");
    assert.equal(visibleWidth(bandRow!.slice(0, bandRow!.indexOf(CURSOR_MARKER))), 8);
  });

  it("compacts a long single-line prompt into the shape's content width (no cut-off)", () => {
    const long = "x".repeat(200);
    for (const id of ["box", "band", "field", "rail"]) {
      const ed = editor(id, long);
      const lines = rendered(ed, 30).map(plain);
      // The text row must contain a contiguous run of x's up to the content width.
      const textRow = lines.find((l) => l.includes("x"));
      assert.ok(textRow, `${id} rendered text`);
      assert.ok(textRow!.includes("x".repeat(20)), `${id}: text not laid out to width`);
      assert.equal(visibleWidth(textRow!), 30);
    }
  });

  it("box merges the bottom border into the last row; other shapes keep their chrome", () => {
    const box = rendered(editor("box"), 30).map(plain);
    assert.ok(box[0]!.startsWith("╭") && box[0]!.endsWith("╮"), box[0]);
    assert.ok(box[box.length - 1]!.startsWith("╰") && box[box.length - 1]!.endsWith("╯"), box[box.length - 1]);
    const claude = rendered(editor("claude"), 30).map(plain);
    assert.ok(claude[claude.length - 1]!.startsWith("─"), "claude closes with a rule");
    const borderless = rendered(editor("borderless"), 30).map(plain);
    assert.equal(borderless.length, 1, "borderless is a single row");
  });

  it("status-bearing shapes show the live status; band is absent without data", () => {
    const withData = rendered(editor("box", "hi", { model: "GLM-5.3", cwd: "ceulen", pct: 42 }), 50).map(plain);
    assert.ok(withData[0]!.includes("GLM-5.3") && withData[0]!.includes("42%"), withData[0]);
    const empty = rendered(editor("band"), 50).map(plain);
    assert.ok(empty.every((l) => !l.includes("π")), "no status rows without data (the layout never shifts)");
  });

  it("keeps the working spinner visible while a turn runs", () => {
    for (const id of ["band", "pi", "borderless", "box"]) {
      const ed = editor(id);
      ed.setWorkingStatusIndicator({ renderInBorder: () => "⟳", renderSpinnerInBorder: () => "⟳" } as never);
      const lines = rendered(ed, 40).map(plain);
      assert.ok(lines.some((l) => l.includes("⟳")), `${id} keeps the spinner`);
    }
  });

  it("drops back to shape chrome when the spinner clears", () => {
    const ed = editor("borderless");
    ed.setWorkingStatusIndicator({ renderInBorder: () => "⟳", renderSpinnerInBorder: () => "⟳" } as never);
    assert.ok(rendered(ed, 40).some((l) => plain(l).includes("⟳")));
    ed.setWorkingStatusIndicator(undefined);
    assert.ok(!rendered(ed, 40).some((l) => plain(l).includes("⟳")), "spinner row gone");
  });

  it("applies the shape's minimum padding over the host's", () => {
    const box = editor("box");
    assert.ok(box.getPaddingX() >= shapeById("box").padX, "shape minimum padding applied");
    box.setPaddingX(0);
    assert.equal(box.getPaddingX(), shapeById("box").padX, "host 0 is raised to the shape minimum");
    box.setPaddingX(3);
    assert.equal(box.getPaddingX(), 3, "host padding may exceed the minimum");
  });

  it("survives a throwing theme/data getter by degrading to plain chrome", () => {
    const ed = new ShapeEditor(
      shapeById("band"),
      {
        theme: () => {
          throw new Error("boom");
        },
        data: () => {
          throw new Error("boom");
        },
      },
      tui,
      theme as never,
      {} as never,
      { embedWorkingStatus: true },
    );
    ed.setText("ok");
    const lines = ed.render(30);
    assert.ok(lines.length > 0 && lines.some((l) => plain(l).includes("ok")), "still renders");
    for (const l of lines) assert.equal(visibleWidth(l), 30);
  });
});
