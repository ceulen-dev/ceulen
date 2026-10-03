// Plan settings layer: defaults, trusted-project overlay, save policy
// validation, plans-dir expansion/containment, atomic writes.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import {
  DEFAULT_PLAN_SETTINGS,
  DEFAULT_PLANS_DIR,
  expandPlansDir,
  isInsidePlansDir,
  isSavePlans,
  planPath,
  projectOverridesPlan,
  readPlanSettings,
  writePlanSection,
} from "../lib/settings.js";

const realAgentDir = process.env.PI_CODING_AGENT_DIR;
let AGENT: string;
let REPO: string;

beforeEach(() => {
  AGENT = mkdtempSync(join(tmpdir(), "ceulen-plan-settings-"));
  REPO = mkdtempSync(join(tmpdir(), "ceulen-plan-repo-"));
  process.env.PI_CODING_AGENT_DIR = AGENT;
});

after(() => {
  if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = realAgentDir;
});

const writeGlobal = (body: unknown): void => writeFileSync(join(AGENT, "settings.json"), JSON.stringify(body, null, 2));
const trustedCtx = (trusted = true) => ({ cwd: REPO, isProjectTrusted: () => trusted });

describe("plan settings", () => {
  it("defaults: .pi/plans, save all, no model, no auto-approve", () => {
    const s = readPlanSettings(trustedCtx());
    assert.equal(s.plansDir, DEFAULT_PLANS_DIR);
    assert.equal(s.savePlans, "all");
    assert.equal(s.planModel, "");
    assert.equal(s.planThinking, "");
    assert.equal(s.autoApprove, false);
    assert.deepEqual(DEFAULT_PLAN_SETTINGS, s);
  });

  it("reads the global section and validates savePlans", () => {
    writeGlobal({ plan: { plansDir: ".agents/plans/{yyyymm}", savePlans: "approved", planModel: "router/zai/glm-5.3", planThinking: "high", autoApprove: true } });
    const s = readPlanSettings(trustedCtx());
    assert.equal(s.plansDir, ".agents/plans/{yyyymm}");
    assert.equal(s.savePlans, "approved");
    assert.equal(s.planModel, "router/zai/glm-5.3");
    assert.equal(s.planThinking, "high");
    assert.equal(s.autoApprove, true);

    writeGlobal({ plan: { savePlans: "sometimes" } }); // invalid → default preserved
    assert.equal(readPlanSettings(trustedCtx()).savePlans, "all");
  });

  it("trusted project overrides the global section; untrusted is ignored", () => {
    writeGlobal({ plan: { plansDir: "global-dir", savePlans: "all" } });
    const projectFile = join(REPO, ".pi", "settings.json");
    mkdirSync(join(REPO, ".pi"), { recursive: true });
    writeFileSync(projectFile, JSON.stringify({ plan: { plansDir: "project-dir", savePlans: "none" } }));

    const trusted = readPlanSettings(trustedCtx(true));
    assert.equal(trusted.plansDir, "project-dir");
    assert.equal(trusted.savePlans, "none");
    assert.equal(projectOverridesPlan(REPO, true), true);

    const untrusted = readPlanSettings(trustedCtx(false));
    assert.equal(untrusted.plansDir, "global-dir");
    assert.equal(untrusted.savePlans, "all");
    assert.equal(projectOverridesPlan(REPO, false), false);
  });

  it("writePlanSection merges without clobbering sibling keys and is atomic", () => {
    writeGlobal({ ceulen: { disabled: ["munin"] }, plan: { plansDir: "old" } });
    const file = writePlanSection({ plansDir: ".pi/plans", savePlans: "approved" });
    assert.equal(file, join(AGENT, "settings.json"));
    const body = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(body.ceulen, { disabled: ["munin"] }); // sibling preserved
    assert.equal(body.plan.plansDir, ".pi/plans");
    assert.equal(body.plan.savePlans, "approved");
    assert.equal(existsSync(file + ".tmp"), false, "tmp file renamed away");
  });

  it("writePlanSection refuses a corrupt file instead of clobbering it", () => {
    writeFileSync(join(AGENT, "settings.json"), "{ not json");
    assert.throws(() => writePlanSection({ savePlans: "none" }), /not valid JSON/);
    assert.equal(readFileSync(join(AGENT, "settings.json"), "utf8"), "{ not json", "corrupt file untouched");
  });

  it("{yyyymm} expands to the UTC month and planPath stays inside", () => {
    const now = new Date(Date.UTC(2026, 8, 30));
    assert.equal(expandPlansDir(".pi/plans/{yyyymm}", now), ".pi/plans/202609");
    const file = planPath(REPO, "My Feature Plan", ".pi/plans/{yyyymm}");
    assert.match(file, /\.pi\/plans\/2026\d\d\/\d{4}-.*-my-feature-plan\.md$/);
    assert.equal(isInsidePlansDir(file, ".pi/plans/{yyyymm}", REPO), true);
    assert.equal(isInsidePlansDir(join(REPO, ".pi/plans/202609/x.md"), ".pi/plans/{yyyymm}", REPO), true);
    assert.equal(isInsidePlansDir(join(REPO, ".pi/plan-escape.md"), ".pi/plans/{yyyymm}", REPO), false);
    assert.equal(isInsidePlansDir(join(REPO, ".pi/plans"), ".pi/plans/{yyyymm}", REPO), false, "the dir itself is not inside");
  });

  it("isSavePlans accepts only the closed set", () => {
    assert.equal(isSavePlans("all"), true);
    assert.equal(isSavePlans("approved"), true);
    assert.equal(isSavePlans("none"), true);
    assert.equal(isSavePlans("always"), false);
    assert.equal(isSavePlans(1), false);
  });
});
