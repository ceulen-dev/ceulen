// rtk's /config contribution: row keys, closed sets, save routing (only
// rtk.* edits persist), round-trip through the working copy.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { buildRtkGroups, rtkConfig } from "../configPanel.js";
import { readRtkSettings } from "../lib/settings.js";

const realAgentDir = process.env.PI_CODING_AGENT_DIR;
let AGENT: string;

beforeEach(() => {
  AGENT = mkdtempSync(join(tmpdir(), "ceulen-rtk-cfg-"));
  process.env.PI_CODING_AGENT_DIR = AGENT;
});

after(() => {
  if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = realAgentDir;
});

const fakeCtx = (notified: string[] = []): any => ({
  cwd: AGENT,
  ui: { notify: (message: string) => { notified.push(message); } },
});

describe("rtk config panel", () => {
  it("rows: mode + chained on the Shell tab, both closed sets", () => {
    const groups = buildRtkGroups(readRtkSettings());
    assert.equal(groups.length, 1);
    const group = groups[0];
    assert.equal(group.tab, "Shell");
    assert.equal(group.label, "RTK rewrite");
    assert.deepEqual(group.rows.map((r) => r.key), ["rtk.mode", "rtk.chained"]);
    assert.deepEqual(group.rows[0].values, ["supported-only", "off"]);
    assert.deepEqual(group.rows[1].values, ["only-all-modeled", "never"]);
  });

  it("applyRows round-trips a working copy and save persists it", async () => {
    const cfg = rtkConfig();
    const groups = cfg.groups();
    const modeRow = groups[0]!.rows.find((r) => r.key === "rtk.mode")!;
    const chainedRow = groups[0]!.rows.find((r) => r.key === "rtk.chained")!;
    modeRow.set("off");
    chainedRow.set("never");
    const notified: string[] = [];
    await cfg.save(new Set(["rtk.mode", "rtk.chained"]), fakeCtx(notified));
    const saved = readRtkSettings();
    assert.equal(saved.mode, "off");
    assert.equal(saved.chained, "never");
    assert.ok(notified[0]!.includes("mode off"));
  });

  it("save no-ops without an owned edit; sibling sections survive the write", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ theme: "dark" }));
    const cfg = rtkConfig();
    const notified: string[] = [];
    await cfg.save(new Set(["plan.autoApprove"]), fakeCtx(notified));
    assert.deepEqual(readRtkSettings(), { mode: "supported-only", chained: "only-all-modeled" });

    const groups = cfg.groups();
    const modeRow = groups[0]!.rows.find((r) => r.key === "rtk.mode")!;
    modeRow.set("off");
    await cfg.save(new Set(["rtk.mode"]), fakeCtx(notified));
    const raw = JSON.parse(readFileSync(join(AGENT, "settings.json"), "utf8"));
    assert.equal(raw.theme, "dark", "sibling section survives");
    assert.equal(raw.rtk.mode, "off");
  });
});
