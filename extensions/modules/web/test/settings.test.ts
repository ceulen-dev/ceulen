// The web settings layer: env > trusted project > global > default.
// Uses temp agent dirs / temp settings files; no network.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { lookupVar, readWebSettings, writeWebSection, ENV_TO_SETTINGS_KEY } from "../lib/settings";

// The settings layer reads agentDirs() from the shared registry, which honors
// PI_CODING_AGENT_DIR — point it at a temp dir per test.
let tmpDir = "";
let agentDir = "";
let projectDir = "";

function setup(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-settings-"));
  agentDir = path.join(tmpDir, "agent");
  projectDir = path.join(tmpDir, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // env.ts ingests <real agentDir>/.env.local at import — once the secrets
  // migration has run on this machine, FIRECRAWL_API_KEY etc. sit in the
  // test process env and "unset everywhere" is a lie. Scrub the mapped
  // vars for the suite's lifetime (the web module re-reads settings layers,
  // not env, for these assertions).
  for (const v of ["BRAVE_API_KEY", "FIRECRAWL_API_KEY", "CRAWL4AI_API_TOKEN", "GEMINI_WEB_SECURE_1PSID", "ZAI_API_KEY", "WEB_IMAGE_API_KEY", "WEB_CHAT_API_KEY", "SEARXNG_BASE_URL"]) delete process.env[v];
  // Trust: the real trust.json walk won't see our temp project → untrusted by
  // default. isProjectTrusted(cwd, dirs) is injected nowhere here, so trust
  // tests go through writeWebSection/readWebSettings with explicit trusted
  // flags where the API allows, and lookupVar's project layer is exercised by
  // planting a trust.json for the real walk.
  projectDir = fs.realpathSync(projectDir); // trust.json stores canonical paths
  fs.writeFileSync(
    path.join(agentDir, "trust.json"),
    JSON.stringify({ [projectDir]: true }),
    "utf8",
  );
}

function teardown(): void {
  delete process.env.PI_CODING_AGENT_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function writeGlobal(web: Record<string, unknown>): void {
  writeWebSection(web, path.join(agentDir, "settings.json"));
}

describe("web settings layer", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("every mapped env var points at a settings key", () => {
    assert.equal(Object.keys(ENV_TO_SETTINGS_KEY).length, 16);
    for (const key of Object.values(ENV_TO_SETTINGS_KEY)) {
      assert.ok(key.startsWith("searxng.") || key.startsWith("brave.") || key.startsWith("firecrawl.")
        || key.startsWith("crawl4ai.") || key.startsWith("gemini.") || key.startsWith("image.")
        || key.startsWith("chat."), key);
    }
  });

  it("env wins over settings", () => {
    process.env.BRAVE_API_KEY = "from-env";
    writeGlobal({ brave: { apiKey: "from-settings" } });
    try {
      const r = lookupVar("BRAVE_API_KEY", projectDir, false);
      assert.equal(r.value, "from-env");
      assert.equal(r.source, "env");
    } finally {
      delete process.env.BRAVE_API_KEY;
    }
  });

  it("global settings section resolves when env is unset", () => {
    writeGlobal({ brave: { apiKey: "from-settings" } });
    const r = lookupVar("BRAVE_API_KEY", projectDir, false);
    assert.equal(r.value, "from-settings");
    assert.equal(r.source, "global settings");
  });

  it("trusted project settings shadow global per field", () => {
    writeGlobal({ brave: { apiKey: "global" }, chat: { baseUrl: "https://global" } });
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".pi", "settings.json"),
      JSON.stringify({ web: { "brave.apiKey": "project" } }),
      "utf8",
    );
    const r = lookupVar("BRAVE_API_KEY", projectDir, true);
    assert.equal(r.value, "project");
    assert.equal(r.source, "project settings");
    // includeCwd=false → project layer skipped, global serves
    const g = lookupVar("BRAVE_API_KEY", projectDir, false);
    assert.equal(g.value, "global");
    // untouched field still comes from global
    const c = lookupVar("WEB_CHAT_API_BASE_URL", projectDir, true);
    assert.equal(c.value, "https://global");
  });

  it("untrusted project file is ignored (fail closed)", () => {
    writeGlobal({ brave: { apiKey: "global" } });
    fs.rmSync(path.join(agentDir, "trust.json"));
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".pi", "settings.json"),
      JSON.stringify({ web: { brave: { apiKey: "project" } } }),
      "utf8",
    );
    const r = lookupVar("BRAVE_API_KEY", projectDir, true);
    assert.equal(r.value, "global");
    assert.equal(r.source, "global settings");
  });

  it("unset everywhere → empty source (caller falls through to default)", () => {
    const r = lookupVar("FIRECRAWL_API_KEY", projectDir, true);
    assert.equal(r.value, undefined);
    assert.equal(r.source, "");
  });

  it("vars outside the map are env-only (no settings fallback)", () => {
    writeGlobal({ searxng: { baseUrl: "https://settings" } } as never);
    const r = lookupVar("GEMINI_WEB_COOKIE_STORE", projectDir, true);
    assert.equal(r.value, undefined);
  });

  it("readWebSettings merges global ⊕ trusted project", () => {
    writeGlobal({ brave: { apiKey: "g" }, chat: { baseUrl: "https://g" } });
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".pi", "settings.json"), JSON.stringify({ web: { chat: { baseUrl: "https://p" } } }));
    const merged = readWebSettings(projectDir, true);
    assert.equal(merged.brave && (merged.brave as Record<string, unknown>).apiKey, "g");
    assert.equal(merged.chat && (merged.chat as Record<string, unknown>).baseUrl, "https://p");
  });

  it("writeWebSection patches only given keys and clears empty values", () => {
    writeGlobal({ brave: { apiKey: "old", } });
    writeWebSection({ "brave.apiKey": "new", "chat.apiKey": "" }, path.join(agentDir, "settings.json"));
    const raw = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(raw.web["brave.apiKey"], "new");
    assert.ok(!("chat.apiKey" in raw.web));
    // key paths are FLAT (panel keys) — writeWebSection stores the panel key as-is
  });

  it("writeWebSection removes the web section when it becomes empty", () => {
    writeGlobal({ "brave.apiKey": "old" });
    writeWebSection({ "brave.apiKey": "" }, path.join(agentDir, "settings.json"));
    const raw = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.ok(!("web" in raw));
  });

  it("writeWebSection preserves unrelated settings and other modules' sections", () => {
    const file = path.join(agentDir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ ceulen: { disabled: [] }, other: 1, web: { "chat.apiKey": "k" } }));
    writeWebSection({ "chat.apiKey": "k2" }, file);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(raw.ceulen, { disabled: [] });
    assert.equal(raw.other, 1);
    assert.equal(raw.web["chat.apiKey"], "k2");
  });

  it("writeWebSection refuses to clobber a corrupt file", () => {
    const file = path.join(agentDir, "settings.json");
    fs.writeFileSync(file, "{ not json");
    assert.throws(() => writeWebSection({ "brave.apiKey": "x" }, file), /not valid JSON/);
    assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
  });
});
