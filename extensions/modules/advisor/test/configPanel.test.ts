import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { advisorConfig, buildAdvisorGroups, setAdvisorBridge, setAdvisorRegistry, type AdvisorPanelCfg } from "../configPanel.js";
import type { AdvisorConfig } from "../lib/config.js";

const realAgentDir = process.env.PI_CODING_AGENT_DIR;
let home: string;
let cwd: string;
let notes: { message: string; level: string }[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ceulen-advisor-cfg-"));
  cwd = mkdtempSync(join(tmpdir(), "ceulen-advisor-cfg-repo-"));
  process.env.PI_CODING_AGENT_DIR = home;
  notes = [];
  setAdvisorRegistry(undefined);
  setAdvisorBridge(undefined);
});

after(() => {
  setAdvisorRegistry(undefined);
  setAdvisorBridge(undefined);
  if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = realAgentDir;
});

const cfg = (over: Partial<AdvisorPanelCfg> = {}): AdvisorPanelCfg => ({
  model: "router/zai/glm-5.3-flash",
  thinking: "",
  fallbacks: "",
  enabled: true,
  minToolCalls: 3,
  immuneTurns: 3,
  ...over,
});

const catalog = [
  { provider: "router", id: "zai/glm-5.3-flash", name: "glm-5.3-flash" },
  { provider: "opencode-go", id: "deepseek-v4-pro" },
];
const useCatalog = (list: typeof catalog = catalog) => setAdvisorRegistry({ getAvailable: () => list } as never);

function ctx(): any {
  return {
    cwd,
    isProjectTrusted: () => false,
    ui: { notify: (message: string, level?: string) => notes.push({ message, level: level ?? "info" }) },
  };
}

const writeGlobal = (body: unknown): void => writeFileSync(join(home, "settings.json"), JSON.stringify(body, null, 2));
const readGlobal = (): any => JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));

describe("buildAdvisorGroups", () => {
  it("renders one Model-tab section with the six advisor rows", () => {
    const groups = buildAdvisorGroups(cfg());
    assert.equal(groups.length, 1);
    const [group] = groups;
    assert.equal(group!.key, "advisor");
    assert.equal(group!.label, "Advisor");
    assert.equal(group!.tab, "Model");
    assert.equal(group!.icon, "🧭");
    assert.deepEqual(group!.rows.map((r) => r.key), [
      "advisor.enabled",
      "advisor.model",
      "advisor.thinking",
      "advisor.fallbacks",
      "advisor.watch.minToolCalls",
      "advisor.watch.immuneTurns",
    ]);
    const byKey = new Map(group!.rows.map((r) => [r.key, r]));
    assert.equal(byKey.get("advisor.enabled")!.kind, "toggle");
    assert.equal(byKey.get("advisor.enabled")!.label, "Review settled turns", "the row names the behavior, not 'advisor enabled'");
    assert.match(String(byKey.get("advisor.enabled")!.description), /consult tool still works/, "off must disclose that the tool is unaffected");
    assert.equal(byKey.get("advisor.enabled")!.defaultValue, true);
    assert.equal(byKey.get("advisor.watch.minToolCalls")!.kind, "number");
    assert.equal(byKey.get("advisor.watch.minToolCalls")!.defaultValue, 3);
    assert.equal(byKey.get("advisor.watch.immuneTurns")!.defaultValue, 3);
    assert.ok(byKey.get("advisor.model")!.menu, "primary model row opens a picker");
    assert.ok(byKey.get("advisor.thinking")!.menu, "thinking row is a closed set");
    assert.ok(byKey.get("advisor.fallbacks")!.completions, "fallback row offers inline model completions");
    assert.equal(byKey.get("advisor.model")!.warning, undefined);
  });

  it("warns on the primary row when no model is set", () => {
    const [group] = buildAdvisorGroups(cfg({ model: "" }));
    assert.match(String(group!.rows[1]!.warning), /No model set/);
  });

  it("model menu lists (none) then the catalogue, sorted, with display names", () => {
    useCatalog();
    const [group] = buildAdvisorGroups(cfg());
    const options = group!.rows[1]!.menu!();
    assert.equal(options[0]!.value, "");
    assert.deepEqual(options.slice(1).map((o) => o.value), ["opencode-go/deepseek-v4-pro", "router/zai/glm-5.3-flash"]);
    assert.equal(options[2]!.description, "glm-5.3-flash");
    assert.equal(options[1]!.description, undefined, "no name → no description noise");
  });

  it("model menu degrades to (none) without a registry", () => {
    const [group] = buildAdvisorGroups(cfg());
    assert.deepEqual(group!.rows[1]!.menu!().map((o) => o.value), [""]);
  });

  it("thinking menu offers the model default plus every real level, never :off", () => {
    const [group] = buildAdvisorGroups(cfg());
    const values = group!.rows[2]!.menu!().map((o) => o.value);
    assert.deepEqual(values, ["", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("fallback completions mirror the catalogue", () => {
    useCatalog();
    const [group] = buildAdvisorGroups(cfg());
    const items = group!.rows[3]!.completions!();
    assert.deepEqual(items.map((i) => i.value), ["opencode-go/deepseek-v4-pro", "router/zai/glm-5.3-flash"]);
  });

  it("row setters mutate the working copy", () => {
    const working = cfg({ model: "" });
    const [group] = buildAdvisorGroups(working);
    group!.rows[0]!.set(false);
    group!.rows[1]!.set("prov/model");
    group!.rows[2]!.set("high");
    group!.rows[3]!.set("prov/backup, prov/two");
    group!.rows[4]!.set("0");
    group!.rows[5]!.set("6");
    assert.deepEqual(working, { model: "prov/model", thinking: "high", fallbacks: "prov/backup, prov/two", enabled: false, minToolCalls: 0, immuneTurns: 6 });
  });

  it("number rows clamp garbage and negatives to the current value / zero", () => {
    const working = cfg();
    const [group] = buildAdvisorGroups(working);
    group!.rows[4]!.set("nonsense");
    group!.rows[5]!.set("-3");
    assert.equal(working.minToolCalls, 3, "garbage keeps the previous value");
    assert.equal(working.immuneTurns, 0, "negatives clamp to 0");
  });
});

describe("advisorConfig save", () => {
  it("no-ops unless an advisor. key was edited", async () => {
    const m = advisorConfig();
    await m.save(new Set(["ceulen.disabledTools.advisor"]), ctx());
    assert.deepEqual(notes, []);
    assert.equal(existsSync(join(home, "settings.json")), false);
  });

  it("notifies and does not rewrite when nothing changed", async () => {
    writeGlobal({ advisor: { models: ["prov/a"], watch: { minToolCalls: 3, immuneTurns: 3 } } });
    const m = advisorConfig();
    await m.save(new Set(["advisor.model"]), ctx());
    assert.equal(notes[0]!.message, "Advisor: no changes.");
    assert.equal(readGlobal().advisor.watch.minToolCalls, 3);
  });

  it("writes the section, applies it live, and reports the chain", async () => {
    const applied: AdvisorConfig[] = [];
    setAdvisorBridge({ read: () => ({ enabled: true, models: [], watch: { minToolCalls: 3, immuneTurns: 3 } }), apply: (next) => { applied.push(next); } });
    const m = advisorConfig();
    m.groups()[0]!.rows[1]!.set("router/zai/glm-5.3-flash");
    m.groups()[0]!.rows[2]!.set("high");
    m.groups()[0]!.rows[3]!.set("opencode-go/deepseek-v4-pro");
    m.groups()[0]!.rows[0]!.set(false);
    await m.save(new Set(["advisor.model", "advisor.thinking", "advisor.fallbacks", "advisor.enabled"]), ctx());
    assert.deepEqual(readGlobal().advisor, {
      enabled: false,
      models: ["router/zai/glm-5.3-flash:high", "opencode-go/deepseek-v4-pro"],
      watch: { minToolCalls: 3, immuneTurns: 3 },
    });
    assert.deepEqual(applied, [{ enabled: false, models: ["router/zai/glm-5.3-flash:high", "opencode-go/deepseek-v4-pro"], watch: { minToolCalls: 3, immuneTurns: 3 } }]);
    assert.match(notes[0]!.message, /Advisor saved to .*settings\.json: router\/zai\/glm-5\.3-flash:high → opencode-go\/deepseek-v4-pro/);
    assert.match(notes[0]!.message, /auto-review off/);
    assert.match(notes[0]!.message, /Applied to this session/);
  });

  it("clearing the primary drops the chain and says so", async () => {
    writeGlobal({ advisor: { models: ["prov/a"], watch: { minToolCalls: 3, immuneTurns: 3 } } });
    const m = advisorConfig();
    m.groups()[0]!.rows[1]!.set("");
    await m.save(new Set(["advisor.model"]), ctx());
    assert.equal(readGlobal().advisor.models, undefined);
    assert.match(notes[0]!.message, /chain cleared/);
  });

  it("warns when a trusted project file shadows the global save", async () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-advisor": { models: ["prov/project"] } }));
    const m = advisorConfig();
    m.groups()[0]!.rows[1]!.set("prov/a");
    const projectCtx = ctx();
    projectCtx.isProjectTrusted = () => true;
    await m.save(new Set(["advisor.model"]), projectCtx);
    assert.equal(notes[0]!.level, "warning");
    assert.match(notes[0]!.message, /pi-advisor.*overrides this save/s);
  });

  it("reports a live-apply failure without hiding the successful write", async () => {
    setAdvisorBridge({
      read: () => ({ enabled: true, models: [], watch: { minToolCalls: 3, immuneTurns: 3 } }),
      apply: () => { throw new Error("stale ctx"); },
    });
    const m = advisorConfig();
    m.groups()[0]!.rows[1]!.set("prov/a");
    await m.save(new Set(["advisor.model"]), ctx());
    assert.equal(readGlobal().advisor.models.join(), "prov/a");
    assert.match(notes[0]!.message, /live session update failed: stale ctx/);
  });

  it("reports a write failure and skips the live apply", async () => {
    writeFileSync(join(home, "settings.json"), "{broken");
    let applied = 0;
    setAdvisorBridge({ read: () => ({ enabled: true, models: [], watch: { minToolCalls: 3, immuneTurns: 3 } }), apply: () => { applied++; } });
    const m = advisorConfig();
    m.groups()[0]!.rows[1]!.set("prov/a");
    await m.save(new Set(["advisor.model"]), ctx());
    assert.equal(applied, 0);
    assert.equal(notes[0]!.level, "error");
    assert.match(notes[0]!.message, /Advisor save failed: .*not valid JSON/);
  });
});
