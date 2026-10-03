// plan's /config contribution: row keys, closed-set save menu, save routing
// (only plan.* edits persist), and the project-shadow disclosure.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { applyRows } from "../../../lib/panel.js";
import { buildPlanGroups, planConfig, setPlanBridge } from "../configPanel.js";
import { DEFAULT_PLAN_SETTINGS, readPlanSettings } from "../lib/settings.js";

const realAgentDir = process.env.PI_CODING_AGENT_DIR;
let AGENT: string;
let REPO: string;

beforeEach(() => {
  AGENT = mkdtempSync(join(tmpdir(), "ceulen-plan-cfg-"));
  REPO = mkdtempSync(join(tmpdir(), "ceulen-plan-cfg-repo-"));
  process.env.PI_CODING_AGENT_DIR = AGENT;
  setPlanBridge(undefined);
});

after(() => {
  setPlanBridge(undefined);
  if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = realAgentDir;
});

const fakeCtx = (notified: string[] = []): any => ({
  cwd: REPO,
  isProjectTrusted: () => false,
  ui: { notify: (message: string) => { notified.push(message); } },
});

describe("plan config panel", () => {
  it("rows: savePlans, plansDir, planModel, planThinking, autoApprove on the Tasks tab", () => {
    const groups = buildPlanGroups({ ...DEFAULT_PLAN_SETTINGS });
    assert.equal(groups.length, 1);
    const group = groups[0];
    assert.equal(group.tab, "Tasks");
    assert.equal(group.label, "Plan mode");
    assert.deepEqual(
      group.rows.map((r) => r.key),
      ["plan.savePlans", "plan.plansDir", "plan.planModel", "plan.planThinking", "plan.autoApprove"],
    );
    assert.equal(group.rows[0].values, undefined, "menu-driven row");
    assert.equal(group.rows[4].kind, "toggle");
  });

  it("applyRows round-trips a working copy (Save plans + dir + auto-approve)", () => {
    const cfg = { ...DEFAULT_PLAN_SETTINGS };
    const groups = buildPlanGroups(cfg);
    const byKey = new Map(groups[0].rows.map((r) => [r.key, r]));
    byKey.get("plan.savePlans")!.set("approved");
    byKey.get("plan.plansDir")!.set(".agents/plans/{yyyymm}");
    byKey.get("plan.autoApprove")!.set(true);
    applyRows(cfg, groups);
    assert.equal(cfg.savePlans, "approved");
    assert.equal(cfg.plansDir, ".agents/plans/{yyyymm}");
    assert.equal(cfg.autoApprove, true);
  });

  it("rejects an off-set savePlans value", () => {
    const cfg = { ...DEFAULT_PLAN_SETTINGS };
    const row = buildPlanGroups(cfg)[0].rows[0];
    row.set("sometimes");
    assert.equal(cfg.savePlans, "all", "off-set value ignored");
  });

  it("save() no-ops unless an owned key was edited", async () => {
    const notified: string[] = [];
    const config = planConfig();
    await config.save(new Set(["advisor.model"]), fakeCtx(notified));
    assert.deepEqual(notified, []);
    assert.equal(readPlanSettings().plansDir, DEFAULT_PLAN_SETTINGS.plansDir);
  });

  it("save() writes the global plan section", async () => {
    setPlanBridge({ read: () => ({ ...DEFAULT_PLAN_SETTINGS, savePlans: "none" }), apply: () => {} });
    const config = planConfig();
    config.groups(); // open the panel (captures the working copy)
    await config.save(new Set(["plan.savePlans"]), fakeCtx());
    const body = JSON.parse(readFileSync(join(AGENT, "settings.json"), "utf8"));
    assert.equal(body.plan.savePlans, "none");
  });

  it("save() discloses a shadowing project section", async () => {
    mkdirSync(join(REPO, ".pi"), { recursive: true });
    writeFileSync(join(REPO, ".pi", "settings.json"), JSON.stringify({ plan: { plansDir: "project" } }));
    const notified: string[] = [];
    const config = planConfig();
    config.groups();
    await config.save(new Set(["plan.plansDir"]), { ...fakeCtx(notified), isProjectTrusted: () => true });
    assert.ok(notified.some((n) => n.includes("overrides this save")), notified.join(" | "));
  });
});
