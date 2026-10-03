// `steering` settings — layering (global ← trusted project), the writer's
// merge/atomicity guarantees, and the /config contribution's rows + save path.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  DEFAULT_STEERING_SETTINGS,
  projectOverridesSteering,
  projectSettingsPath,
  readSteeringSettings,
  writeSteeringSection,
} from "../lib/settings.js";
import { buildSteeringGroups, steeringConfig } from "../configPanel.js";

let AGENT: string;
let REPO: string;
const realAgentDir = process.env.PI_CODING_AGENT_DIR;

before(() => {
  AGENT = mkdtempSync(join(tmpdir(), "ceulen-steering-settings-"));
  process.env.PI_CODING_AGENT_DIR = AGENT;
  REPO = mkdtempSync(join(tmpdir(), "ceulen-steering-repo-"));
});
after(() => {
  if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = realAgentDir;
  rmSync(AGENT, { recursive: true, force: true });
  rmSync(REPO, { recursive: true, force: true });
});
beforeEach(() => {
  writeFileSync(join(AGENT, "settings.json"), "{}");
  rmSync(projectSettingsPath(REPO), { force: true });
});

const globalFile = () => join(AGENT, "settings.json");
const writeGlobal = (body: unknown) => writeFileSync(globalFile(), JSON.stringify(body, null, 2));
const writeProject = (body: unknown) => {
  mkdirSync(join(REPO, ".pi"), { recursive: true });
  writeFileSync(projectSettingsPath(REPO), JSON.stringify(body, null, 2));
};
const readBack = () => JSON.parse(readFileSync(globalFile(), "utf8"));

describe("readSteeringSettings layering", () => {
  it("defaults when nothing is configured", () => {
    assert.deepEqual(readSteeringSettings(), DEFAULT_STEERING_SETTINGS);
    assert.deepEqual(DEFAULT_STEERING_SETTINGS, {
      firstToolHints: true,
      selectionGuidance: true,
      superpower: false,
      superpowerPrompt: "",
      strictSerena: false,
      stripReasoning: true,
      dsAnchor: true,
      weNeed: false,
    });
  });

  it("reads the global section, ignoring unknown keys and bad types", () => {
    writeGlobal({ steering: { superpower: true, superpowerPrompt: "  custom  ", dsAnchor: "yes", strictSerena: 1, firstToolHints: false } });
    const s = readSteeringSettings();
    assert.equal(s.superpower, true);
    assert.equal(s.superpowerPrompt, "custom", "trimmed");
    assert.equal(s.dsAnchor, true, "non-boolean ignored → default");
    assert.equal(s.strictSerena, false, "non-boolean ignored → default");
    assert.equal(s.firstToolHints, false);
  });

  it("a TRUSTED project file overrides the global section per field", () => {
    writeGlobal({ steering: { superpower: true, weNeed: true, stripReasoning: false } });
    writeProject({ steering: { superpower: false, stripReasoning: true } });
    const s = readSteeringSettings({ cwd: REPO, isProjectTrusted: () => true });
    assert.equal(s.superpower, false, "project wins");
    assert.equal(s.stripReasoning, true, "project wins");
    assert.equal(s.weNeed, true, "untouched field falls through to global");
  });

  it("an UNTRUSTED project file is ignored entirely", () => {
    writeProject({ steering: { dsAnchor: false, superpower: true } });
    const s = readSteeringSettings({ cwd: REPO, isProjectTrusted: () => false });
    assert.deepEqual(s, DEFAULT_STEERING_SETTINGS);
    assert.equal(projectOverridesSteering(REPO, false), false, "untrusted project never disclosed as shadowing");
  });

  it("a corrupt file falls back to defaults", () => {
    writeFileSync(globalFile(), "{ not json");
    assert.deepEqual(readSteeringSettings(), DEFAULT_STEERING_SETTINGS);
  });
});

describe("writeSteeringSection", () => {
  it("merges into the file without clobbering siblings", () => {
    writeGlobal({ theme: "dark", router: { baseUrl: "http://x/v1" }, steering: { weNeed: true } });
    writeSteeringSection({ superpower: true, superpowerPrompt: "go loud" });
    const s = readBack();
    assert.equal(s.theme, "dark");
    assert.equal(s.router.baseUrl, "http://x/v1");
    assert.equal(s.steering.weNeed, true, "existing steering keys survive");
    assert.equal(s.steering.superpower, true);
    assert.equal(s.steering.superpowerPrompt, "go loud");
  });

  it("writes only the patched keys and refuses to clobber a corrupt file", () => {
    writeSteeringSection({ dsAnchor: false });
    assert.deepEqual(readBack().steering, { dsAnchor: false }, "one key patched, nothing else written");
    writeFileSync(globalFile(), "{ not json");
    assert.throws(() => writeSteeringSection({ superpower: true }), /not valid JSON/);
  });
});

describe("projectOverridesSteering", () => {
  it("is true only for a trusted project that actually sets steering.*", () => {
    writeProject({ steering: { dsAnchor: false } });
    assert.equal(projectOverridesSteering(REPO, true), true);
    writeProject({ munin: { project: "x" } });
    assert.equal(projectOverridesSteering(REPO, true), false, "another module's section is not a steering override");
  });
});

describe("/config contribution", () => {
  it("exposes every owned row under the Model tab, all keys steering.-prefixed", () => {
    const groups = buildSteeringGroups(structuredClone(DEFAULT_STEERING_SETTINGS));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].label, "Steering");
    assert.equal(groups[0].tab, "Model");
    const keys = groups[0].rows.map((r) => r.key);
    assert.deepEqual(keys, [
      "steering.firstToolHints",
      "steering.selectionGuidance",
      "steering.superpower",
      "steering.superpowerPrompt",
      "steering.strictSerena",
      "steering.stripReasoning",
      "steering.dsAnchor",
      "steering.weNeed",
    ]);
    const anchor = groups[0].rows.find((r) => r.key === "steering.dsAnchor")!;
    assert.equal(anchor.kind, "toggle");
    assert.equal(anchor.defaultValue, true);
    assert.match(anchor.warning!, /Repair module must be enabled/);
    // No Enable row here — the config module prepends it.
    assert.equal(keys.some((k) => k.startsWith("ceulen.disabled")), false);
  });

  it("row setters mutate the working copy", () => {
    const cfg = structuredClone(DEFAULT_STEERING_SETTINGS);
    const rows = buildSteeringGroups(cfg)[0].rows;
    rows.find((r) => r.key === "steering.superpower")!.set(true);
    rows.find((r) => r.key === "steering.superpowerPrompt")!.set(" loud ");
    assert.equal(cfg.superpower, true);
    assert.equal(cfg.superpowerPrompt, "loud");
  });

  it("save writes the changed keys to the global file and discloses a project override", async () => {
    writeProject({ steering: { dsAnchor: false } });
    const contrib = steeringConfig();
    const rows = contrib.groups()[0].rows;
    rows.find((r) => r.key === "steering.stripReasoning")!.set(false);
    const notes: string[] = [];
    const ctx: any = {
      cwd: REPO,
      isProjectTrusted: () => true,
      ui: { notify: (m: string) => notes.push(m) },
    };
    await contrib.save(new Set(["steering.stripReasoning"]), ctx);
    assert.deepEqual(readBack().steering, { stripReasoning: false }, "only the edited key is written");
    assert.match(notes[0], /Steering saved to/);
    assert.match(notes[0], /overrides these values/);
  });

  it("save no-ops when no owned key was edited, and reports no changes", async () => {
    const contrib = steeringConfig();
    const notes: string[] = [];
    const ctx: any = { cwd: REPO, isProjectTrusted: () => false, ui: { notify: (m: string) => notes.push(m) } };
    await contrib.save(new Set(["subagent.routing.mode"]), ctx);
    assert.equal(notes.length, 0, "foreign key → silent no-op");
    await contrib.save(new Set(["steering.superpower"]), ctx);
    assert.deepEqual(notes, ["No changes."]);
    assert.equal(readBack().steering, undefined, "nothing written");
  });
});
