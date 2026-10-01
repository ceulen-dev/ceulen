// NEW for the ceulen port — covers the settings.json-based config resolution
// (env > trusted project file > global file > default), the untrusted-project
// gate, and writeMuninSection's atomic merge semantics.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getMuninConfig,
  projectSettingsPath,
  readMuninSection,
  writeMuninSection,
} from "../lib/helpers.js";

const ENV_KEYS = ["MUNIN_API_KEY", "MUNIN_PROJECT", "MUNIN_BASE_URL", "PI_CODING_AGENT_DIR", "HOME"] as const;

describe("munin settings resolution", () => {
  let dirs: string[];
  let originalEnv: Record<string, string | undefined>;
  let cwd: string;

  beforeEach(() => {
    dirs = [];
    originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    cwd = mkdtempSync(join(tmpdir(), "munin-cwd-"));
    dirs.push(cwd);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function agentDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "munin-agent-"));
    dirs.push(dir);
    return dir;
  }

  function writeJson(file: string, json: unknown): void {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(json, null, 2));
  }

  it("resolves env over project over global over default", () => {
    const agent = agentDir();
    writeJson(projectSettingsPath(cwd), { munin: { apiKey: "proj-key", project: "proj-id", baseUrl: "https://proj.example.test" } });
    writeJson(join(agent, "settings.json"), { munin: { apiKey: "global-key", project: "global-id", baseUrl: "https://global.example.test" } });

    // All three fields from project (trusted).
    const fromProject = getMuninConfig({}, cwd, true, { agentDirs: [agent] });
    assert.deepEqual(fromProject.sources, { apiKey: "project", projectId: "project", baseUrl: "project" });
    assert.equal(fromProject.apiKey, "proj-key");

    // Env wins per-field.
    process.env.MUNIN_API_KEY = "env-key";
    const withEnv = getMuninConfig({}, cwd, true, { agentDirs: [agent] });
    assert.equal(withEnv.apiKey, "env-key");
    assert.equal(withEnv.projectId, "proj-id");
    assert.equal(withEnv.sources.apiKey, "env");
    delete process.env.MUNIN_API_KEY;

    // Untrusted project → global used instead (no env in play).
    const untrusted = getMuninConfig({}, cwd, false, { agentDirs: [agent] });
    assert.deepEqual(untrusted.sources, { apiKey: "global", projectId: "global", baseUrl: "global" });
    assert.equal(untrusted.apiKey, "global-key");

    // Nothing anywhere → defaults error with pointers (baseUrl would default).
    assert.throws(() => getMuninConfig({}, cwd, false, { agentDirs: [agentDir()] }), /\/config → Memory/);
  });

  it("project file is ignored entirely when untrusted (credential-safety)", () => {
    const agent = agentDir();
    writeJson(projectSettingsPath(cwd), { munin: { apiKey: "evil-key", project: "evil-id", baseUrl: "https://evil.example.test" } });
    writeJson(join(agent, "settings.json"), { munin: { apiKey: "safe-key", project: "safe-id" } });
    const cfg = getMuninConfig({}, cwd, false, { agentDirs: [agent] });
    // Project file values are invisible; the global file fills the gap instead.
    assert.equal(cfg.projectId, "safe-id");
    assert.equal(cfg.apiKey, "safe-key");
    assert.notEqual(cfg.baseUrl, "https://evil.example.test");
    assert.throws(
      () => getMuninConfig({}, cwd, false, { agentDirs: [agentDir()] }),
      /Munin API key is not configured/,
    );
  });

  it("explicit params beat every layer; base_url still requires api_key", () => {
    const agent = agentDir();
    writeJson(projectSettingsPath(cwd), { munin: { apiKey: "proj-key", project: "proj-id" } });
    const cfg = getMuninConfig({ project: "param-id" }, cwd, true, { agentDirs: [agent] });
    assert.equal(cfg.projectId, "param-id");
    assert.equal(cfg.sources.projectId, "param");
    assert.equal(cfg.sources.apiKey, "project");
    assert.throws(() => getMuninConfig({ base_url: "https://x.test", project: "p" }, cwd, true, { agentDirs: [agent] }), /explicit api_key/);
  });

  it("global file alone fills unconfigured fields", () => {
    const agent = agentDir();
    writeJson(join(agent, "settings.json"), { munin: { apiKey: "g-key", project: "g-id" } });
    const cfg = getMuninConfig({}, cwd, false, { agentDirs: [agent] });
    assert.deepEqual(cfg.sources, { apiKey: "global", projectId: "global", baseUrl: "default" });
    assert.equal(cfg.baseUrl, "https://munin.kalera.ai");
  });

  it("readMuninSection tolerates missing/malformed files and non-string values", () => {
    assert.equal(readMuninSection(join(cwd, "missing.json")), null);
    writeFileSync(join(cwd, "bad.json"), "{not json");
    assert.equal(readMuninSection(join(cwd, "bad.json")), null);
    writeJson(join(cwd, "ok.json"), { other: 1, munin: { apiKey: 123, project: "p", baseUrl: "" } });
    assert.deepEqual(readMuninSection(join(cwd, "ok.json")), { project: "p" });
  });
});

describe("writeMuninSection", () => {
  let dir: string;
  let dirs: string[];

  beforeEach(() => {
    dirs = [];
    dir = mkdtempSync(join(tmpdir(), "munin-write-"));
    dirs.push(dir);
  });

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("creates the file and preserves sibling keys on merge", () => {
    const file = join(dir, ".pi", "settings.json");
    writeMuninSection({ apiKey: "k", project: "p" }, file);
    writeMuninSection({ baseUrl: "https://x.test" }, file);
    const json = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(json.munin, { apiKey: "k", project: "p", baseUrl: "https://x.test" });
    // No tmp residue.
    assert.equal(existsSync(file + ".tmp"), false);
  });

  it("never clobbers other top-level sections", () => {
    const file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ ceulen: { disabled: ["rtk"] }, router: { baseUrl: "http://r" } }));
    writeMuninSection({ project: "p" }, file);
    const json = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(json.ceulen, { disabled: ["rtk"] });
    assert.deepEqual(json.router, { baseUrl: "http://r" });
    assert.equal(json.munin.project, "p");
  });

  it("empty-string patch clears the field", () => {
    const file = join(dir, "settings.json");
    writeMuninSection({ project: "p" }, file);
    writeMuninSection({ project: "" }, file);
    const json = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(json.munin, {});
  });

  it("refuses to overwrite a corrupt file", () => {
    const file = join(dir, "settings.json");
    writeFileSync(file, "{corrupt");
    assert.throws(() => writeMuninSection({ project: "p" }, file), /not valid JSON/);
    assert.equal(readFileSync(file, "utf8"), "{corrupt");
  });
});
