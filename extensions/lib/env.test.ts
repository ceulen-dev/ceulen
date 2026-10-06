// migrateSecretsFromSettings: plaintext secrets leave settings.json for
// <agentDir>/.env.local, idempotently, without touching non-secret rows.

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { migrateSecretsFromSettings, writeSecretEnvs, readSecretEnvs } from "./env.ts";

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ceulen-env-test-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

test("migrate: web + a2a secrets move to .env.local; URLs stay; idempotent", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
      web: {
        "brave.apiKey": "brave-secret",
        "firecrawl.baseUrl": "https://firecrawl.example",
        "firecrawl.apiKey": "fc-secret",
        "crawl4ai.timeoutMs": 30000,
      },
      a2a: {
        server: { enabled: false, port: 9900 },
        discovery: {
          gateways: {
            remote: { enabled: true, url: "http://gw:9920", token: "agw-plain", heartbeatSec: 60 },
          },
        },
      },
      theme: "default",
    }));

    migrateSecretsFromSettings();

    const envText = fs.readFileSync(path.join(dir, ".env.local"), "utf8");
    assert.match(envText, /BRAVE_API_KEY=brave-secret/);
    assert.match(envText, /FIRECRAWL_API_KEY=fc-secret/);
    assert.match(envText, /A2A_GATEWAY_REMOTE_TOKEN=agw-plain/);

    const raw = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    assert.equal(raw.web["brave.apiKey"], undefined, "brave key scrubbed");
    assert.equal(raw.web["firecrawl.apiKey"], undefined, "firecrawl key scrubbed");
    assert.equal(raw.web["firecrawl.baseUrl"], "https://firecrawl.example", "URL stays");
    assert.equal(raw.web["crawl4ai.timeoutMs"], 30000, "timeout stays");
    assert.equal(raw.a2a.discovery.gateways.remote.url, "http://gw:9920", "gateway URL stays");
    assert.equal(raw.a2a.discovery.gateways.remote.token, undefined, "gateway token scrubbed");
    assert.equal(raw.a2a.server.port, 9900, "server config stays");
    assert.equal(raw.theme, "default", "unrelated keys stay");

    // Idempotent: second run is a no-op (nothing left to migrate).
    migrateSecretsFromSettings();
    const raw2 = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    assert.deepEqual(raw2, raw);
    const env2 = fs.readFileSync(path.join(dir, ".env.local"), "utf8");
    assert.equal(env2, envText, "no duplicate env lines");

    // Nested hand-written web secrets also migrate (onlyAbsent: the first
    // BRAVE_API_KEY already written wins — correct env precedence — but the
    // nested settings copy is still scrubbed to one source of truth).
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
      web: { brave: { apiKey: "nested-secret" } },
    }));
    migrateSecretsFromSettings();
    assert.doesNotMatch(fs.readFileSync(path.join(dir, ".env.local"), "utf8"), /nested-secret/, "first migrated value wins (onlyAbsent)");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).web, undefined,
      "empty nested web section removed — secret gone from settings.json");
  } finally {
    delete process.env.BRAVE_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.A2A_GATEWAY_REMOTE_TOKEN;
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_CODING_AGENT_DIR;
  }
});

test("migrate: onlyAbsent honors a hand-placed .env.local value", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, ".env.local"), "BRAVE_API_KEY=hand-placed\n");
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ web: { "brave.apiKey": "from-settings" } }));

    migrateSecretsFromSettings();

    const envText = fs.readFileSync(path.join(dir, ".env.local"), "utf8");
    assert.match(envText, /BRAVE_API_KEY=hand-placed/, "hand-placed value wins");
    assert.doesNotMatch(envText, /from-settings/);
    // The settings copy is still scrubbed — one source of truth (the web
    // section disappears entirely when the secret was its only key).
    const after = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    assert.ok(!(after.web && after.web["brave.apiKey"]), "settings copy scrubbed");
  } finally {
    delete process.env.BRAVE_API_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_CODING_AGENT_DIR;
  }
});

test("migrate: missing/corrupt settings.json is a silent no-op", () => {
  const dir = tmpDir();
  try {
    assert.doesNotThrow(() => migrateSecretsFromSettings()); // no file at all
    fs.writeFileSync(path.join(dir, "settings.json"), "{not json");
    assert.doesNotThrow(() => migrateSecretsFromSettings());
    assert.ok(!fs.existsSync(path.join(dir, ".env.local")), "corrupt file wrote nothing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_CODING_AGENT_DIR;
  }
});

test("writeSecretEnvs: upsert + create + onlyAbsent semantics, 0600", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, ".env.local"), "EXISTING=old\n# comment\n");
    const written = writeSecretEnvs({ NEW: "v1" }, { agentDir: dir });
    assert.deepEqual(written, ["NEW"]);
    writeSecretEnvs({ NEW: "v2" }, { agentDir: dir });
    const text = fs.readFileSync(path.join(dir, ".env.local"), "utf8");
    assert.match(text, /EXISTING=old/, "other lines preserved");
    assert.match(text, /NEW=v2/, "upsert replaces in place");
    assert.doesNotMatch(text, /NEW=v1/);
    // onlyAbsent keeps the existing value.
    writeSecretEnvs({ NEW: "v3", FRESH: "x" }, { agentDir: dir, onlyAbsent: true });
    const text2 = fs.readFileSync(path.join(dir, ".env.local"), "utf8");
    assert.match(text2, /NEW=v2/);
    assert.match(text2, /FRESH=x/);
    assert.equal(process.env.NEW, "v2", "process.env mirrors the surviving value");
    // Mode check.
    const mode = fs.statSync(path.join(dir, ".env.local")).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.deepEqual(readSecretEnvs(dir).NEW, "v2");
    // Newline-bearing values are rejected, not written corrupt.
    writeSecretEnvs({ BAD: "line1\nline2" }, { agentDir: dir });
    assert.doesNotMatch(fs.readFileSync(path.join(dir, ".env.local"), "utf8"), /BAD=/);
  } finally {
    delete process.env.NEW;
    delete process.env.FRESH;
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_CODING_AGENT_DIR;
  }
});
