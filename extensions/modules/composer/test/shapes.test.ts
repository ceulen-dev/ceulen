/**
 * Composer shape tests — chrome builders, OMP copy parity, layout math, and
 * the cursor marker surviving chrome wrapping (the invariant that makes side
 * chrome safe: the TUI measures the marker in the FINAL rendered line).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import {
  contentWidth,
  DEFAULT_SHAPE,
  gutterWidth,
  IDENTITY_THEME,
  isShapeId,
  padRow,
  previewShape,
  SHAPE_IDS,
  SHAPES,
  shapeById,
  statusLine,
  surfacePainter,
  type ShapeTheme,
} from "../lib/shapes.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const th = IDENTITY_THEME;

describe("composer shape vocabulary (OMP parity)", () => {
  it("ships all 8 OMP shapes in OMP order with OMP ids", () => {
    assert.deepEqual(SHAPE_IDS, ["band", "box", "claude", "pi", "borderless", "rule", "field", "rail"]);
    assert.equal(DEFAULT_SHAPE, "band");
  });

  it("carries OMP's labels and descriptions verbatim", () => {
    const expected: Record<string, [string, string]> = {
      band: ["Status Band (Default)", "Flush soft-capped status band above a curved prompt, no frame"],
      box: ["Rounded Box", "Status line embedded in top border, compact 2-line prompt"],
      claude: ["Claude Code", "Full-width horizontal rules above and below, status line at bottom"],
      pi: ["Pi", "Framed horizontal rules with status line at bottom"],
      borderless: ["Borderless", "Clean prompt glyph with status line at bottom, no box borders"],
      rule: ["Top Rule Dock", "Single top rule with status docked onto it and below"],
      field: ["Compact Field", "Filled one-row field with accent end caps"],
      rail: ["Accent Rail", "Filled one-row field anchored by a single accent rail"],
    };
    for (const s of SHAPES) {
      assert.deepEqual([s.label, s.description], expected[s.id], s.id);
    }
  });

  it("unknown ids fall back to the default (stale settings can't break the editor)", () => {
    assert.equal(shapeById("nonexistent").id, "band");
    assert.equal(isShapeId("rail"), true);
    assert.equal(isShapeId("nope"), false);
    assert.equal(isShapeId(42), false);
  });
});

describe("shape geometry", () => {
  it("side chrome and gutters are subtracted from the content width", () => {
    assert.equal(contentWidth(shapeById("pi"), 80), 80, "no side chrome, no gutter");
    assert.equal(contentWidth(shapeById("band"), 80), 80 - 3, "gutter `╰─ ` = 3 cells");
    assert.equal(contentWidth(shapeById("box"), 80), 80 - 2, "1-cell border per side");
    assert.equal(contentWidth(shapeById("field"), 80), 80 - 2, "one cap per side");
    assert.equal(contentWidth(shapeById("rail"), 80), 80 - 2, "rail reserves a cell each side (single left rail)");
  });

  it("gutter is capped so narrow terminals keep a text column", () => {
    assert.ok(contentWidth(shapeById("band"), 4) >= 1);
    assert.ok(gutterWidth(shapeById("band"), 4) <= 4);
  });

  it("padRow pads to exactly the content width, marker-safe", () => {
    assert.equal(visibleWidth(padRow(10, "abc")), 10);
    const withMarker = `ab${CURSOR_MARKER}`;
    assert.equal(visibleWidth(padRow(10, withMarker)), 10, "marker is zero-width");
    assert.ok(padRow(10, withMarker).includes(CURSOR_MARKER), "marker survives padding");
  });
});

describe("chrome rendering through the shared builders", () => {
  it("every shape renders a prompt row at the full width", () => {
    for (const s of SHAPES) {
      const lines = previewShape(s.id, 60, th, { model: "M", cwd: "d", pct: 10 });
      assert.ok(lines.length >= 1, `${s.id} renders`);
      for (const l of lines) {
        assert.equal(visibleWidth(l), 60, `${s.id}: ${JSON.stringify(plain(l))}`);
      }
      assert.ok(lines.some((l) => plain(l).includes("Ask anything")), `${s.id} shows the prompt`);
    }
  });

  it("box draws corners + side bars; field/rail draw caps and rails; rail has no right cap", () => {
    // A one-row prompt: the box merges its bottom border into that row, so
    // the preview is exactly `╭…╮` + `╰─ … ─╯` (OMP's compact 2-line prompt).
    const box = previewShape("box", 30, th).map(plain);
    assert.equal(box.length, 2, box.join("\n"));
    assert.ok(box[0]!.startsWith("╭") && box[0]!.endsWith("╮"));
    assert.ok(box[1]!.startsWith("╰─") && box[1]!.endsWith("─╯"), box[1]);
    const field = previewShape("field", 30, th).map(plain);
    assert.ok(field[0]!.startsWith("▐") && field[0]!.endsWith("▌"), field[0]);
    const rail = previewShape("rail", 30, th).map(plain);
    assert.ok(rail[0]!.startsWith("▎"), rail[0]);
    assert.ok(!rail[0]!.endsWith("▌"), "rail has a single rail, no caps");
  });

  it("closing chrome glyphs survive at every width (no silent truncation)", () => {
    // Regression: the box status row was one cell over budget and
    // truncateToWidth silently ate the closing `╮`.
    for (const w of [24, 30, 40, 57, 80]) {
      const box = previewShape("box", w, th, { model: "GLM-5.3", cwd: "ceulen", pct: 42 }).map(plain);
      assert.ok(box[0]!.endsWith("╮"), `box top closes at ${w}: ${box[0]}`);
      assert.ok(box[box.length - 1]!.endsWith("─╯"), `box bottom closes at ${w}: ${box[box.length - 1]}`);
      const claude = previewShape("claude", w, th, { model: "M" }).map(plain);
      assert.equal(claude.length, 3, `claude keeps both rules at ${w}`);
      for (const l of claude) assert.equal(visibleWidth(l), w, `claude row width at ${w}`);
    }
  });

  it("status-bearing shapes show the live status line; band reserves a blank row when empty", () => {
    const box = previewShape("box", 40, th, { model: "GLM-5.3", cwd: "ceulen", pct: 42 }).map(plain);
    assert.ok(box[0]!.includes("GLM-5.3") && box[0]!.includes("ceulen") && box[0]!.includes("42%"), box[0]);
    const bandEmpty = previewShape("band", 40, th).map(plain);
    assert.equal(bandEmpty[0]!.trim(), "", "band row reserved (blank) without data");
    const bandFull = previewShape("band", 40, th, { model: "M" }).map(plain);
    assert.ok(bandFull[0]!.includes("╭─") && bandFull[0]!.includes("M"), bandFull[0]);
  });

  it("rules carry pi's scroll indicator when lines are hidden", () => {
    // pi shape: top/bottom rules; hidden comes from the editor. Preview has 0,
    // so assert the helper through a ctx-shaped shape def directly.
    const def = shapeById("pi");
    const line = def.top!({ w: 30, hidden: 4, theme: th })!;
    assert.ok(plain(line).includes(" ↑ 4 more "), plain(line));
    assert.equal(visibleWidth(line), 30);
  });
});

describe("status line + surface fill", () => {
  it("statusLine joins model · dir · pct with theme styling and skips blanks", () => {
    assert.equal(plain(statusLine({ model: "M", cwd: "d", pct: 42.6 }, th)), "M · d · 43%");
    assert.equal(plain(statusLine({ model: "M" }, th)), "M");
    assert.equal(statusLine({}, th), "");
    assert.equal(statusLine(undefined, th), "");
    assert.equal(plain(statusLine({ model: " ", cwd: "x" }, th)), "x", "blank segments skipped");
  });

  it("surfacePainter re-applies the fill across nested resets (cursor glyph)", () => {
    const painted = surfacePainter("\x1b[44m")(`a\x1b[0mb`);
    assert.equal(painted, "\x1b[44ma\x1b[0m\x1b[44mb\x1b[39m\x1b[49m");
    assert.equal(surfacePainter("")("plain"), "plain", "empty prefix is a no-op");
  });
});

describe("theme adapter", () => {
  it("shapeTheme maps pi Theme colors and keeps bg through getBgAnsi", async () => {
    const { shapeTheme } = await import("../lib/shapes.ts");
    const seen: string[] = [];
    const t = {
      fg: (c: string, s: string) => {
        seen.push(c);
        return `<${c}>${s}`;
      },
      getBgAnsi: () => "\x1b[48m",
      getFgAnsi: () => "\x1b[38m",
      inverse: (s: string) => `[inv]${s}`,
    };
    const st: ShapeTheme = shapeTheme(t as never);
    assert.equal(st.accent("x"), "<accent>x");
    assert.equal(st.border("x"), "<borderMuted>x");
    assert.ok(st.fill("x").includes("\x1b[48m"), "bg applied");
    assert.equal(st.inverse("x"), "[inv]x");
    assert.ok(seen.length > 0, "theme colors requested through fg()");
  });
});
