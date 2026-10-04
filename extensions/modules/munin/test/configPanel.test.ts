// NEW for the ceulen port — panel groups shape, effective-value display, and
// the project-level save path (write target, patch diffing, trust + env notes).

import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { projectSettingsPath } from "../lib/helpers.js";
import { buildMuninGroups, muninConfig, readMuninSettings, type MuninSettings } from "../configPanel.js";

const ENV_KEYS = ["MUNIN_API_KEY", "MUNIN_PROJECT", "MUNIN_BASE_URL", "PI_CODING_AGENT_DIR"] as const;

describe("buildMuninGroups", () => {
  it("renders the Memory tab with masked apiKey row", () => {
    const cfg: MuninSettings = { project: "p", baseUrl: "https://x.test", apiKey: "k" };
    const groups = buildMuninGroups(cfg);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.tab, "Memory");
    assert.equal(groups[0]!.label, "Munin");
    assert.deepEqual(groups[0]!.rows.map((r) => r.key), ["munin.project", "munin.baseUrl", "munin.apiKey"]);
    const keyRow = groups[0]!.rows[2]!;
    assert.equal(keyRow.mask, true);
    assert.match(keyRow.warning ?? "", /\.gitignore/);
    assert.equal(groups[0]!.rows[1]!.defaultValue, "https://munin.kalera.ai");
  });

  it("row setters mutate the working copy", () => {
    const cfg: MuninSettings = { project: "", baseUrl: "https://munin.kalera.ai", apiKey: "" };
    const groups = buildMuninGroups(cfg);
    groups[0]!.rows[0]!.set("new-project");
    groups[0]!.rows[2]!.set(" new-key ");
    assert.equal(cfg.project, "new-project");
    assert.equal(cfg.apiKey, "new-key");
  });
});

describe("readMuninSettings", () => {
  let dirs: string[];
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    dirs = [];
    originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("returns effective values (env beats project file) and defaults when unconfigured", () => {
    const cwd = mkdtempSync(join(tmpdir(), "munin-panel-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(projectSettingsPath(cwd), JSON.stringify({ munin: { apiKey: "pk", project: "pp" } }));
    process.env.MUNIN_PROJECT = "env-project";
    const eff = readMuninSettings(cwd, true);
    assert.equal(eff.project, "env-project");
    assert.equal(eff.apiKey, "pk");
    assert.equal(eff.baseUrl, "https://munin.kalera.ai");

    process.env.MUNIN_PROJECT = undefined;
    const none = readMuninSettings(join(cwd, "nowhere"), false);
    assert.deepEqual(none, { project: "", baseUrl: "https://munin.kalera.ai", apiKey: "" });
  });

  it("muninConfig resolves the trust flag itself (no phantom project values untrusted)", () => {
    // The factory gets no ctx, so the baseline must resolve trust through the
    // shared helper — a hardcoded `true` shows a trusted-project value in an
    // UNTRUSTED checkout (the phantom-value bug class).
    const agentDir = mkdtempSync(join(tmpdir(), "munin-agent-"));
    const cwd = mkdtempSync(join(tmpdir(), "munin-trust-"));
    dirs.push(agentDir, cwd);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.MUNIN_API_KEY = "env-key"; // keep getMuninConfig from throwing
    process.env.MUNIN_PROJECT = "env-id";
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(projectSettingsPath(cwd), JSON.stringify({ munin: { baseUrl: "https://project.test" } }));
    const prevCwd = process.cwd();
    process.chdir(cwd);
    const baseUrlRow = () => muninConfig().groups()[0]!.rows[1]!.value;
    try {
      writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [process.cwd()]: true }));
      assert.equal(baseUrlRow(), "https://project.test", "trusted → project value shown");
      writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [process.cwd()]: false }));
      assert.equal(baseUrlRow(), "https://munin.kalera.ai", "untrusted → project value ignored");
    } finally {
      process.chdir(prevCwd);
    }
  });
});

describe("muninConfig save", () => {
  let dirs: string[];
  let originalEnv: Record<string, string | undefined>;
  let cwd: string;

  beforeEach(() => {
    dirs = [];
    originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    cwd = mkdtempSync(join(tmpdir(), "munin-save-"));
    dirs.push(cwd);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function saveCtx(trusted: boolean, notify?: (m: string, l?: string) => void) {
    return {
      isProjectTrusted: () => trusted,
      cwd,
      ui: { notify: notify ?? (() => {}) },
    } as any;
  }

  it("no-ops without owned keys", async () => {
    const contrib = muninConfig();
    const foreign = new Set<string>(["router.baseUrl"]);
    await contrib.save(foreign, saveCtx(true));
    assert.equal(readFileSyncSafe(projectSettingsPath(cwd)), null);
  });

  it("writes changed fields to the project file; untrusted save warns", async () => {
    const notes: { message: string; level?: string }[] = [];
    const contrib = muninConfig();
    // Simulate the panel edit: mutate the working copy the rows close over.
    const groups = contrib.groups();
    groups[0]!.rows[0]!.set("saved-project");
    groups[0]!.rows[1]!.set("https://saved.example.test");
    groups[0]!.rows[2]!.set("saved-key");
    await contrib.save(new Set(["munin.project"]), saveCtx(false, (message, level) => notes.push({ message, level })));

    const json = JSON.parse(readFileSync(projectSettingsPath(cwd), "utf8"));
    assert.equal(json.munin.project, "saved-project");
    assert.equal(json.munin.baseUrl, "https://saved.example.test");
    assert.equal(json.munin.apiKey, "saved-key");
    const note = notes[0]!;
    assert.match(note.message, /saved to .*\.pi\/settings\.json/);
    assert.match(note.message, /NOT trusted/);
    assert.equal(note.level, "warning");
  });

  it("trusted save notifies info and preserves sibling settings", async () => {
    const notes: string[] = [];
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(projectSettingsPath(cwd), JSON.stringify({ ceulen: { disabled: ["rtk"] } }));
    const contrib = muninConfig();
    const groups = contrib.groups();
    groups[0]!.rows[0]!.set("tp");
    await contrib.save(new Set(["munin.project"]), saveCtx(true, (m) => notes.push(m)));
    const json = JSON.parse(readFileSync(projectSettingsPath(cwd), "utf8"));
    assert.deepEqual(json.ceulen, { disabled: ["rtk"] });
    assert.equal(json.munin.project, "tp");
    assert.match(notes[0]!, /saved to/);
    assert.doesNotMatch(notes[0]!, /NOT trusted/);
  });

  it("env presence appends the override caveat", async () => {
    const notes: string[] = [];
    process.env.MUNIN_API_KEY = "env-key";
    const contrib = muninConfig();
    const groups = contrib.groups();
    groups[0]!.rows[2]!.set("saved-key");
    await contrib.save(new Set(["munin.apiKey"]), saveCtx(true, (m) => notes.push(m)));
    assert.match(notes[0]!, /MUNIN_\* env vars override/);
  });

  function readFileSyncSafe(file: string): string | null {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }
});
