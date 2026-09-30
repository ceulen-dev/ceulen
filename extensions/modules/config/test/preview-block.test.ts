/**
 * Kernel preview block — a selected row's (or open menu's highlighted
 * option's) `previewLines` render as a read-only block under the rows pane,
 * clamped into the remaining body budget; the frame geometry stays exact.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ConfigPanelModel, row, type PanelGroup } from "../../../lib/panel.js";

const theme = null;
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const HEIGHT = 40;
// Frame chrome: top + tabs + divider + blank + 3 desc + divider + footer + bottom = 10.
const BODY_ROWS = HEIGHT - 10;

function panel(rows: PanelGroup["rows"], height = HEIGHT): ConfigPanelModel {
  const g: PanelGroup[] = [{ key: "s", label: "Section", rows }];
  const m = new ConfigPanelModel(g, theme, "T");
  m.getHeight = () => height;
  return m;
}

const body = (m: ConfigPanelModel) => m.render(100).slice(3, -7).map(plain);

const previewRow = (lines: string[]) =>
  row("shape", "Shape", "string", "a", () => {}, {
    values: ["a", "b"],
    previewLines: (v: string) => [`${v}-one`, `${v}-two`, `${v}-three`],
  });

describe("kernel preview block", () => {
  it("renders under the rows pane for the selected row; absent without the hook", () => {
    const withHook = body(panel([previewRow([])])).join("\n");
    assert.ok(withHook.includes("Preview:"), "label present");
    assert.ok(withHook.includes("a-one"), "current value previewed");
    assert.ok(!withHook.includes("b-one"), "only the current value");

    const noHook = body(panel([row("x", "X", "toggle", true, () => {})])).join("\n");
    assert.ok(!noHook.includes("Preview:"), "no block without previewLines");
  });

  it("follows the highlighted option while the submenu is open", () => {
    const m = panel([previewRow([])]);
    m.handleInput("\r"); // open menu, cursor on current value "a"
    assert.ok(m.menuOpen);
    let text = body(m).join("\n");
    assert.ok(text.includes("a-one"), "preview shows option a");
    m.handleInput("\u001b[B"); // ↓ to "b"
    text = body(m).join("\n");
    assert.ok(text.includes("b-one"), "preview followed to b");
    assert.ok(!text.includes("a-one"), "stale preview gone");
    m.handleInput("\u001b"); // close menu — selection unchanged
    assert.equal(m.menuOpen, false);
    assert.ok(body(m).join("\n").includes("a-one"), "back to the row's own value");
  });

  it("clamps into the body budget; frame geometry invariant", () => {
    const m = panel([previewRow([])]);
    const out = m.render(100);
    assert.equal(out.length, HEIGHT, "frame stays max(14, getHeight()) lines");
    const many = body(panel([previewRow([])])).join("\n");
    assert.ok(many.includes("Preview:"), "label present");
    assert.ok(many.includes("a-two") || many.includes("a-one"), "at least one preview line fits");
  });

  it("tight body: preview shrinks or skips cleanly, frame height honored", () => {
    // max(14,13)=14 → body=4 rows: rows pane eats 1, blank+label+1 line fits.
    const tiny = panel([previewRow([])], 13);
    const out = tiny.render(100);
    assert.equal(out.length, Math.max(14, 13), "height honored at small sizes");
    const text = out.slice(3, -7).map(plain).join("\n");
    assert.ok(text.includes("a-one") || !text.includes("Preview:"), "either fits or skips cleanly");
  });

  it("preview lines are truncated to the inner width", () => {
    const long = row("shape", "Shape", "string", "a", () => {}, {
      values: ["a"],
      previewLines: () => ["x".repeat(200)],
    });
    const m = panel([long]);
    for (const line of m.render(100)) {
      assert.ok(visibleWidth(line) <= 100, `line overflow: ${visibleWidth(line)}`);
    }
  });
});
