// NEW for the ceulen port — `zai` settings layering (env > trusted project
// .pi/settings.json > global agent-dir settings.json > default) and the atomic
// section writer.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_BASE_URL } from "../lib/anthropic.js";
import { DEFAULT_MIN_INTERVAL_MS } from "../lib/throttle.js";
import {
  getZaiSettings,
  globalSettingsPath,
  normalizeZaiBaseUrl,
  projectSettingsPath,
  readZaiSection,
  writeZaiSection,
} from "../lib/settings.js";

let dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A temp "global agent dir" + temp cwd, both isolated from the real ones. */
function scopes() {
  const agentDir = tempDir("zai-agent-");
  const cwd = tempDir("zai-project-");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  return { agentDir, cwd, global: join(agentDir, "settings.json"), project: join(cwd, ".pi", "settings.json") };
}

beforeEach(() => { dirs = []; });
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("getZaiSettings layering", () => {
  it("defaults: default endpoint, fast tier, signing on, 1000ms gate", () => {
    const s = scopes();
    const r = getZaiSettings({ cwd: s.cwd, env: {}, dirs: [s.agentDir] });
    assert.equal(r.baseUrl, DEFAULT_BASE_URL);
    assert.equal(r.speed, "fast");
    assert.equal(r.signing, true);
    assert.equal(r.minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
    assert.deepEqual(r.sources, { baseUrl: "default", speed: "default", signing: "default", minIntervalMs: "default" });
  });

  it("global settings.json is read, and a TRUSTED project file overrides it per field", () => {
    const s = scopes();
    writeFileSync(s.global, JSON.stringify({ zai: { baseUrl: "https://open.bigmodel.cn/api/anthropic", signing: false } }));
    writeFileSync(s.project, JSON.stringify({ zai: { speed: "standard", minIntervalMs: 250 } }));

    const trusted = getZaiSettings({ cwd: s.cwd, trusted: true, env: {}, dirs: [s.agentDir] });
    assert.equal(trusted.baseUrl, "https://open.bigmodel.cn/api/anthropic");
    assert.equal(trusted.sources.baseUrl, "global");
    assert.equal(trusted.speed, "standard");
    assert.equal(trusted.sources.speed, "project");
    assert.equal(trusted.minIntervalMs, 250);
    assert.equal(trusted.signing, false);
    assert.equal(trusted.projectTrusted, true);
    assert.equal(trusted.projectFile, projectSettingsPath(s.cwd));

    // Untrusted: the project file is invisible (an untrusted checkout must not
    // redirect the endpoint the credential is sent to).
    const untrusted = getZaiSettings({ cwd: s.cwd, trusted: false, env: {}, dirs: [s.agentDir] });
    assert.equal(untrusted.speed, "fast");
    assert.equal(untrusted.sources.speed, "default");
    assert.equal(untrusted.minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
    assert.equal(untrusted.sources.baseUrl, "global");
  });

  it("env wins per field, including falsy values (signing off, gate disabled)", () => {
    const s = scopes();
    writeFileSync(s.global, JSON.stringify({ zai: { baseUrl: "https://open.bigmodel.cn/api/anthropic", signing: true, minIntervalMs: 1000 } }));
    const r = getZaiSettings({
      cwd: s.cwd,
      trusted: true,
      env: {
        ZAI_ANTHROPIC_BASE_URL: "https://zcode.z.ai/api/v1/ultra-zai/anthropic/",
        ZAI_ANTHROPIC_SPEED: "standard",
        ZAI_ANTHROPIC_SIGNING: "0",
        ZAI_ANTHROPIC_MIN_INTERVAL_MS: "0",
      },
      dirs: [s.agentDir],
    });
    assert.equal(r.baseUrl, "https://zcode.z.ai/api/v1/ultra-zai/anthropic", "trailing slash trimmed");
    assert.equal(r.speed, "standard");
    assert.equal(r.signing, false);
    assert.equal(r.minIntervalMs, 0);
    assert.deepEqual(r.sources, { baseUrl: "env", speed: "env", signing: "env", minIntervalMs: "env" });
  });

  it("garbage env falls through to the next layer instead of forcing a default", () => {
    const s = scopes();
    writeFileSync(s.global, JSON.stringify({ zai: { speed: "standard", minIntervalMs: 700, signing: false } }));
    const r = getZaiSettings({
      cwd: s.cwd,
      env: { ZAI_ANTHROPIC_SPEED: "who-knows", ZAI_ANTHROPIC_MIN_INTERVAL_MS: "bogus", ZAI_ANTHROPIC_SIGNING: "maybe" },
      dirs: [s.agentDir],
    });
    assert.equal(r.speed, "standard");
    assert.equal(r.minIntervalMs, 700);
    assert.equal(r.signing, false);
    assert.equal(r.sources.speed, "global");
  });

  it("malformed settings files are treated as unconfigured, never as fatal", () => {
    const s = scopes();
    writeFileSync(s.global, "{ not json");
    writeFileSync(s.project, "{ not json");
    const r = getZaiSettings({ cwd: s.cwd, trusted: true, env: {}, dirs: [s.agentDir] });
    assert.equal(r.baseUrl, DEFAULT_BASE_URL);
    assert.equal(readZaiSection(s.global), null);
    assert.equal(readZaiSection(join(s.agentDir, "missing.json")), null);
  });

  it("globalSettingsPath resolves the first agent dir (PI_CODING_AGENT_DIR aware)", () => {
    assert.equal(globalSettingsPath(["/agents"]), join("/agents", "settings.json"));
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = "/tmp/ceulen-zai-global";
    try {
      assert.equal(globalSettingsPath(), join("/tmp/ceulen-zai-global", "settings.json"));
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  });
});

describe("writeZaiSection", () => {
  it("merges, preserving every other key and untouched zai fields", () => {
    const s = scopes();
    writeFileSync(s.global, JSON.stringify({ ceulen: { disabled: ["fff"] }, zai: { speed: "standard", signing: true } }));
    writeZaiSection({ baseUrl: "https://open.bigmodel.cn/api/anthropic/" }, s.global);

    const written = JSON.parse(readFileSync(s.global, "utf8"));
    assert.deepEqual(written.ceulen, { disabled: ["fff"] }, "other sections untouched");
    assert.equal(written.zai.baseUrl, "https://open.bigmodel.cn/api/anthropic", "normalized on write");
    assert.equal(written.zai.speed, "standard");
    assert.equal(written.zai.signing, true);
    assert.equal(existsSync(s.global + ".tmp"), false, "atomic tmp+rename leaves no temp file");
  });

  it("persists 0 (gate off) and false, and clears a field on empty string", () => {
    const s = scopes();
    writeZaiSection({ baseUrl: "", speed: "fast", signing: false, minIntervalMs: 0 }, s.global);
    const written = JSON.parse(readFileSync(s.global, "utf8"));
    assert.equal(written.zai.baseUrl, undefined, "empty string clears the key");
    assert.equal(written.zai.speed, "fast");
    assert.equal(written.zai.signing, false);
    assert.equal(written.zai.minIntervalMs, 0);
  });

  it("refuses to clobber a corrupt settings file (data-loss guard)", () => {
    const s = scopes();
    writeFileSync(s.global, "{ not json");
    assert.throws(() => writeZaiSection({ speed: "standard" }, s.global), /not valid JSON/);
    assert.equal(readFileSync(s.global, "utf8"), "{ not json", "file left untouched");
  });

  it("round-trips: what writeZaiSection writes is what getZaiSettings resolves", () => {
    const s = scopes();
    writeZaiSection({ baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic", speed: "standard", signing: false, minIntervalMs: 500 }, s.global);
    const r = getZaiSettings({ cwd: s.cwd, env: {}, dirs: [s.agentDir] });
    assert.equal(r.baseUrl, "https://zcode.z.ai/api/v1/zcode-plan/anthropic");
    assert.equal(r.speed, "standard");
    assert.equal(r.signing, false);
    assert.equal(r.minIntervalMs, 500);
    assert.deepEqual(r.sources, { baseUrl: "global", speed: "global", signing: "global", minIntervalMs: "global" });
  });
});

describe("normalizeZaiBaseUrl", () => {
  it("trims whitespace and trailing slashes only", () => {
    assert.equal(normalizeZaiBaseUrl("  https://api.z.ai/api/anthropic///  "), "https://api.z.ai/api/anthropic");
    assert.equal(normalizeZaiBaseUrl(""), "");
  });
});
