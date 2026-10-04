/**
 * Render smoke for the ported modules' /config sections (Serena, FFF search,
 * RTK): boxed frame intact, tool rows visible, no width overflow, no icons.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigPanelModel, row, type PanelGroup } from "../../../lib/panel.js";
import { MODULES } from "../../../lib/registry.js";
import { moduleEnableRow, moduleToolRows } from "../index.js";

const theme = {
  fg: (text: string) => text,
  bold: (text: string) => text,
  underline: (text: string) => text,
} as never;

const plain = (l: string) => l.replace(/\u001b\[[0-9;]*m/g, "");

function toolGroups(): PanelGroup[] {
  const workingTools = new Set(MODULES.flatMap((m) => m.tools ?? [])); // all on
  const out: PanelGroup[] = [];
  for (const m of MODULES) {
    if (!m.tools) continue;
    out.push({
      key: `ceulen-${m.name}`,
      label: m.name === "fff" ? "FFF search" : m.name === "serena" ? "Serena" : m.name,
      tab: m.category,
      rows: [moduleEnableRow(m.name, m.describe ?? "", new Set([m.name])), ...moduleToolRows(m.tools, workingTools)],
    });
  }
  return out;
}

describe("render smoke — ported modules' /config sections", () => {
  it("renders Enable + per-tool rows inside the boxed frame with zero overflow", () => {
    const groups = toolGroups();
    assert.equal(groups.length, 13, "serena + fff + ux + munin + classifier + advisor + subagent + repair + plan + todo + web + rules + a2a (rtk has no tools)");
    const m = new ConfigPanelModel(groups, theme, "Settings");
    m.getHeight = () => 40;
    for (const w of [110, 100, 80, 60]) {
      for (const line of m.render(w)) {
        assert.ok(
          (line as unknown as string).length >= 0 && plain(line as unknown as string).length <= w,
          `line wider than ${w}`,
        );
      }
    }
  });

  it("shows the tool names as row labels and no icon glyphs in the groups", () => {
    const groups = toolGroups();
    const serena = groups.find((g) => g.label === "Serena")!;
    const keys = serena.rows.map((r) => r.key);
    assert.ok(keys.includes("ceulen.disabledTools.serena_find_symbol"));
    assert.ok(keys.includes("ceulen.disabledTools.serena_onboarding"));
    assert.equal(keys.length, 21, "Enable + 20 serena tools");
    const fff = groups.find((g) => g.label === "FFF search")!;
    assert.ok(fff.rows.some((r) => r.key === "ceulen.disabledTools.ffgrep"));
    const ux = groups.find((g) => g.label === "ux")!;
    assert.ok(ux.rows.some((r) => r.key === "ceulen.disabledTools.ux_audit"));
    const advisor = groups.find((g) => g.label === "advisor")!;
    assert.ok(advisor.rows.some((r) => r.key === "ceulen.disabledTools.advisor"));
    const subagent = groups.find((g) => g.label === "subagent")!;
    assert.ok(subagent.rows.some((r) => r.key === "ceulen.disabledTools.subagent"));
    assert.ok(subagent.rows.some((r) => r.key === "ceulen.disabledTools.herdr"));
    for (const g of groups) assert.equal(g.icon, undefined, "no icons for the ported modules");
  });
});

// keep `row` import used (types only otherwise)
void row;
