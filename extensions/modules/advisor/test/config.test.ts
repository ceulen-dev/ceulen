import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import {
  chainFromSettings,
  loadAdvisorSettings,
  parseModel,
  parseSection,
  projectShadow,
  readLayer,
  resolveSettings,
  settingsFromChain,
  splitThinkingSuffix,
  writeAdvisorSettings,
  THINKING_LEVELS,
  type AdvisorConfig,
} from "../lib/config.js";

const realAgentDir = process.env.PI_CODING_AGENT_DIR;
let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ceulen-advisor-agent-"));
  cwd = mkdtempSync(join(tmpdir(), "ceulen-advisor-repo-"));
  process.env.PI_CODING_AGENT_DIR = home;
});

after(() => {
  if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = realAgentDir;
});

function writeGlobal(body: unknown): string {
  const file = join(home, "settings.json");
  writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}

function writeProject(body: unknown): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(body, null, 2));
}

const readGlobal = (): any => JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
const CHAIN: AdvisorConfig = { enabled: true, models: ["prov/a", "prov/b"], watch: { minToolCalls: 2, immuneTurns: 5 } };

describe("advisor settings resolution", () => {
  it("returns defaults when nothing is configured", () => {
    assert.deepEqual(loadAdvisorSettings(cwd, true), { enabled: true, models: [], watch: { minToolCalls: 3, immuneTurns: 3 } });
  });

  it("reads the `advisor` section (chain + watch knobs)", () => {
    writeGlobal({ advisor: { models: ["prov/a", "prov/b"], watch: { minToolCalls: 5, immuneTurns: 1 } } });
    assert.deepEqual(loadAdvisorSettings(cwd, true), { enabled: true, models: ["prov/a", "prov/b"], watch: { minToolCalls: 5, immuneTurns: 1 } });
  });

  it("accepts comma-string chains, trims, and dedupes", () => {
    writeGlobal({ advisor: { models: "prov/a, prov/b ,prov/a," } });
    assert.deepEqual(loadAdvisorSettings(cwd, true).models, ["prov/a", "prov/b"]);
  });

  it("reads the legacy `pi-advisor` section (rename alias)", () => {
    writeGlobal({ "pi-advisor": { models: ["prov/legacy"], watch: { minToolCalls: 4 } } });
    assert.deepEqual(loadAdvisorSettings(cwd, true), { enabled: true, models: ["prov/legacy"], watch: { minToolCalls: 4, immuneTurns: 3 } });
  });

  it("the new section wins per field when both names are present", () => {
    writeGlobal({ "pi-advisor": { models: ["prov/legacy"], watch: { minToolCalls: 4, immuneTurns: 9 } }, advisor: { models: ["prov/current"] } });
    const cfg = loadAdvisorSettings(cwd, true);
    assert.deepEqual(cfg.models, ["prov/current"], "new models win");
    assert.equal(cfg.watch.minToolCalls, 4, "untouched legacy watch key survives");
    assert.equal(cfg.watch.immuneTurns, 9, "legacy immuneTurns survives");
  });

  it("legacy single `model` string wraps to a one-entry chain; `models` wins when both exist", () => {
    writeGlobal({ advisor: { model: "prov/legacy-model" } });
    assert.deepEqual(loadAdvisorSettings(cwd, true).models, ["prov/legacy-model"]);
    writeGlobal({ advisor: { model: "prov/legacy", models: ["prov/current"] } });
    assert.deepEqual(loadAdvisorSettings(cwd, true).models, ["prov/current"]);
  });

  it("legacy watch.enabled:false folds into the master switch", () => {
    writeGlobal({ "pi-advisor": { models: ["prov/a"], watch: { enabled: false } } });
    assert.equal(loadAdvisorSettings(cwd, true).enabled, false);
    writeGlobal({ advisor: { enabled: false, models: ["prov/a"], watch: { enabled: true } } });
    assert.equal(loadAdvisorSettings(cwd, true).enabled, false, "explicit master off wins over legacy on");
    writeGlobal({ advisor: { models: ["prov/a"] } });
    assert.equal(loadAdvisorSettings(cwd, true).enabled, true, "no legacy key → master defaults on");
  });

  it("trusted project settings override global per field; the project is ignored when untrusted", () => {
    writeGlobal({ advisor: { models: ["prov/global"], watch: { minToolCalls: 5 } } });
    writeProject({ advisor: { models: ["prov/project"] } });
    const trusted = loadAdvisorSettings(cwd, true);
    assert.deepEqual(trusted.models, ["prov/project"]);
    assert.equal(trusted.watch.minToolCalls, 5, "global watch keys survive the project merge");
    assert.deepEqual(loadAdvisorSettings(cwd, false).models, ["prov/global"], "untrusted project layer ignored");
  });

  it("invalid values fall back to defaults", () => {
    writeGlobal({ advisor: { models: "", watch: { minToolCalls: -2, immuneTurns: "lots", enabled: "nope" } } });
    assert.deepEqual(loadAdvisorSettings(cwd, true), { enabled: true, models: [], watch: { minToolCalls: 3, immuneTurns: 3 } });
  });

  it("parseSection/readLayer/resolveSettings are pure and total", () => {
    assert.deepEqual(parseSection(undefined), {});
    assert.deepEqual(parseSection("garbage"), {});
    assert.deepEqual(readLayer({ "pi-advisor": { model: "a/b" }, advisor: { enabled: false } }), { model: "a/b", enabled: false });
    assert.deepEqual(resolveSettings([]), { enabled: true, models: [], watch: { minToolCalls: 3, immuneTurns: 3 } });
  });
});

describe("writeAdvisorSettings", () => {
  it("writes the full section, deleting the legacy section and folded keys", () => {
    writeGlobal({ unrelated: "keep-me", "pi-advisor": { models: ["prov/legacy"], model: "prov/older", watch: { enabled: false, immuneTurns: 9 }, migrationVersion: 1 } });
    const file = writeAdvisorSettings(CHAIN);
    assert.equal(file, join(home, "settings.json"));
    const raw = readGlobal();
    assert.deepEqual(raw.advisor, { enabled: true, models: ["prov/a", "prov/b"], watch: { minToolCalls: 2, immuneTurns: 5 } });
    assert.equal(raw["pi-advisor"], undefined, "legacy section removed");
    assert.equal(raw.unrelated, "keep-me", "unrelated settings survive");
    assert.equal(raw.advisor.model, undefined);
    assert.equal(raw.advisor.watch.enabled, undefined);
  });

  it("an empty chain drops the models key (no unset-model shadows)", () => {
    writeGlobal({ advisor: { models: ["prov/a"] } });
    writeAdvisorSettings({ ...CHAIN, models: [] });
    assert.equal(readGlobal().advisor.models, undefined);
  });

  it("round-trips through loadAdvisorSettings", () => {
    writeAdvisorSettings(CHAIN);
    assert.deepEqual(loadAdvisorSettings(cwd, true), CHAIN);
    writeAdvisorSettings({ ...CHAIN, enabled: false, models: ["router/zai/glm-5.3-flash:high"] });
    assert.deepEqual(loadAdvisorSettings(cwd, true), { enabled: false, models: ["router/zai/glm-5.3-flash:high"], watch: { minToolCalls: 2, immuneTurns: 5 } });
  });

  it("refuses to clobber a corrupt settings file", () => {
    writeFileSync(join(home, "settings.json"), "{not json");
    assert.throws(() => writeAdvisorSettings(CHAIN), /not valid JSON/);
  });
});

describe("projectShadow", () => {
  it("reports the advisor sections a trusted project file sets", () => {
    assert.deepEqual(projectShadow(cwd, true), []);
    writeProject({ advisor: { models: ["prov/p"] } });
    assert.deepEqual(projectShadow(cwd, true), ["advisor"]);
    writeProject({ "pi-advisor": { models: ["prov/p"] } });
    assert.deepEqual(projectShadow(cwd, true), ["pi-advisor"]);
    assert.deepEqual(projectShadow(cwd, false), [], "untrusted repos never shadow");
  });
});

describe("chain rows ⇄ saved chain", () => {
  it("parses a primary :level into the thinking row", () => {
    assert.deepEqual(chainFromSettings(["router/zai/glm-5.3-flash:high", "prov/b"]), {
      model: "router/zai/glm-5.3-flash",
      thinking: "high",
      fallbacks: "prov/b",
    });
  });

  it("treats :off and no suffix as the model default", () => {
    assert.equal(chainFromSettings(["prov/a:off"]).thinking, "");
    assert.equal(chainFromSettings(["prov/a"]).thinking, "");
    assert.equal(chainFromSettings([]).model, "");
  });

  it("keeps openrouter :free ids intact and re-serializes pinned levels", () => {
    const chain = chainFromSettings(["openrouter/nvidia/nemotron:free"]);
    assert.equal(chain.model, "openrouter/nvidia/nemotron:free");
    assert.deepEqual(settingsFromChain(chain), ["openrouter/nvidia/nemotron:free"]);
    assert.deepEqual(settingsFromChain({ model: "prov/a", thinking: "max", fallbacks: "prov/b, prov/c:low, " }), ["prov/a:max", "prov/b", "prov/c:low"]);
  });

  it("drops blanks and dedupes on the way back", () => {
    assert.deepEqual(settingsFromChain({ model: "prov/a", thinking: "", fallbacks: "prov/a, , prov/b" }), ["prov/a", "prov/b"]);
    assert.deepEqual(settingsFromChain({ model: "", thinking: "high", fallbacks: "" }), [], "thinking without a model is dropped");
  });
});

describe("model ref parsing", () => {
  it("parseModel splits on the first slash and rejects malformed values", () => {
    assert.deepEqual(parseModel("prov/model-id"), { provider: "prov", id: "model-id" });
    assert.deepEqual(parseModel("router/zai/glm-5.3-flash"), { provider: "router", id: "zai/glm-5.3-flash" });
    assert.equal(parseModel("noseparator"), undefined);
    assert.equal(parseModel("/leading"), undefined);
    assert.equal(parseModel("trailing/"), undefined);
  });

  it("splitThinkingSuffix only accepts real levels", () => {
    assert.deepEqual(splitThinkingSuffix("prov/a:high"), { name: "prov/a", thinking: "high" });
    assert.deepEqual(splitThinkingSuffix("prov/a:hgh"), { name: "prov/a:hgh" });
    assert.deepEqual(splitThinkingSuffix("openrouter/x/y:free"), { name: "openrouter/x/y:free" });
    for (const level of THINKING_LEVELS) assert.equal(splitThinkingSuffix(`prov/a:${level}`).thinking, level);
  });
});
