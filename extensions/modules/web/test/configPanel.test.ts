// web's /config contribution: 16 rows over a `web.`-prefixed key set, masked
// secrets, save that writes only changed fields to the global settings.json.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildWebGroups, diffWebPatch, readWebRowValues, webConfig } from "../configPanel";
import { writeWebSection } from "../lib/settings";

function tmpAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-panel-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const old = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  }
}

describe("web configPanel", () => {
  it("16 rows, all keys web.-prefixed, secrets masked", () => {
    const groups = buildWebGroups({});
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.label, "Web");
    assert.equal(groups[0]!.tab, "Tools");
    assert.equal(groups[0]!.icon, "🌍");
    const rows = groups[0]!.rows;
    assert.equal(rows.length, 16);
    for (const r of rows) assert.ok(r.key.startsWith("web."), r.key);
    const masked = rows.filter((r) => r.mask);
    assert.equal(masked.length, 7);
    for (const r of masked) assert.ok(/key|token|cookie/i.test(r.label), `secret row: ${r.label}`);
  });

  it("readWebRowValues: env wins, settings fallback, empty default", () => {
    const dir = tmpAgentDir();
    try {
      withEnv("BRAVE_API_KEY", "env-key", () => {
        writeWebSection({ "brave.apiKey": "settings-key", "chat.apiKey": "chat-key" }, path.join(dir, "settings.json"));
        const values = readWebRowValues("/nonexistent-project", false);
        assert.deepEqual(values["brave.apiKey"], { value: "env-key", source: "env" });
        assert.deepEqual(values["chat.apiKey"], { value: "chat-key", source: "global settings" });
        assert.deepEqual(values["gemini.proxy"], { value: "", source: "default" });
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  it("timeout rows are a CLOSED SET so an invalid value can't brick a tool", () => {
    // Live-found regression: a free-text 30 (ms) makes load*Config throw
    // ("must be an integer >= 1000"), disabling every Firecrawl/Crawl4AI tool.
    const groups = buildWebGroups({});
    for (const key of ["web.firecrawl.timeoutMs", "web.crawl4ai.timeoutMs"]) {
      const row = groups[0]!.rows.find((r) => r.key === key)!;
      const opts = row.menu?.() ?? [];
      assert.ok(opts.length >= 4, `${key} offers timed options`);
      for (const o of opts) assert.ok(Number(o.value) >= 1000, `${key} option ${o.value} >= 1000ms`);
      assert.ok(opts.some((o) => o.value === "60000"), `${key} includes the 60s default`);
    }
  });

  it("rows mutate the working copy; set() accepts numbers for number rows", () => {
    const groups = buildWebGroups({ "firecrawl.timeoutMs": "60000" });
    const row = groups[0]!.rows.find((r) => r.key === "web.firecrawl.timeoutMs")!;
    assert.equal(row.kind, "number");
    row.set(30000);
    assert.equal(row.value, 30000);
    const secret = groups[0]!.rows.find((r) => r.key === "web.brave.apiKey")!;
    secret.set("typed");
    assert.equal(secret.value, "typed");
  });

  it("save no-ops unless a web.* key was edited", async () => {
    const dir = tmpAgentDir();
    try {
      const cfg = webConfig();
      const notifications: string[] = [];
      const ctx = { cwd: "/nonexistent", ui: { notify: (m: string) => notifications.push(m) }, isProjectTrusted: () => false } as never;
      await cfg.save(new Set(["munin.apiKey"]), ctx);
      assert.equal(notifications.length, 0);
      assert.ok(!fs.existsSync(path.join(dir, "settings.json")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  it("save writes ONLY changed fields and discloses env overrides", async () => {
    const dir = tmpAgentDir();
    const old = process.env.BRAVE_API_KEY;
    process.env.BRAVE_API_KEY = "still-from-env";
    try {
      // Working copy built from effective values: env value shown for brave.
      const cfg = webConfig();
      const groups = cfg.groups();
      const brave = groups[0]!.rows.find((r) => r.key === "web.brave.apiKey")!;
      assert.equal(brave.value, "still-from-env");
      // User changes two rows (one env-backed, one plain).
      brave.set("panel-key");
      const timeout = groups[0]!.rows.find((r) => r.key === "web.crawl4ai.timeoutMs")!;
      timeout.set(45000);
      const notifications: string[] = [];
      const ctx = { cwd: "/nonexistent", ui: { notify: (m: string) => notifications.push(m) }, isProjectTrusted: () => false } as never;
      await cfg.save(new Set(["web.brave.apiKey", "web.crawl4ai.timeoutMs"]), ctx);
      // Secrets NEVER land in settings.json — brave (a secret row) goes to
      // .env.local; only the non-secret timeout hits settings.json.
      const envFile = fs.readFileSync(path.join(dir, ".env.local"), "utf8");
      assert.match(envFile, /BRAVE_API_KEY=panel-key/);
      const raw = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
      assert.equal(raw.web["brave.apiKey"], undefined, "secret must not be written to settings.json");
      assert.equal(raw.web["crawl4ai.timeoutMs"], 45000);
      assert.equal(Object.keys(raw.web).length, 1, "only the non-secret changed key written to settings.json");
      const note = notifications.join(" ");
      assert.ok(note.includes(".env.local"), note);
      assert.ok(note.includes("BRAVE_API_KEY"), "env override disclosed");
    } finally {
      if (old === undefined) delete process.env.BRAVE_API_KEY;
      else process.env.BRAVE_API_KEY = old;
      fs.rmSync(dir, { recursive: true, force: true });
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  it("diffWebPatch: free-text garbage on a number row leaves the key untouched", () => {
    // Live-found regression: parseInt('abc') || 0 wrote a 0 cap to disk, which
    // the consumer then clamped — silently clobbering the user's real value.
    const before = { "image.dailyCap": "20", "crawl4ai.timeoutMs": "60000", "brave.apiKey": "old" };
    assert.deepEqual(diffWebPatch({ ...before, "image.dailyCap": "abc" }, before), {}, "garbage number row skipped, never 0");
    // A real number still persists as a number; empty string still clears.
    assert.deepEqual(diffWebPatch({ ...before, "crawl4ai.timeoutMs": "45000" }, before), { "crawl4ai.timeoutMs": 45000 });
    assert.deepEqual(diffWebPatch({ ...before, "image.dailyCap": "" }, before), { "image.dailyCap": "" });
  });

  it("save keeps the stored cap when the panel edit is garbage ('abc' → no write)", async () => {
    const dir = tmpAgentDir();
    try {
      writeWebSection({ "image.dailyCap": 20 }, path.join(dir, "settings.json"));
      const cfg = webConfig();
      cfg.groups()[0]!.rows.find((r) => r.key === "web.image.dailyCap")!.set("abc");
      const ctx = { cwd: "/nonexistent", ui: { notify: () => {} }, isProjectTrusted: () => false } as never;
      await cfg.save(new Set(["web.image.dailyCap"]), ctx);
      const raw = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
      assert.equal(raw.web["image.dailyCap"], 20, "stored cap survives a garbage edit");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  it("discloses a NESTED project web entry that shadows the save", async () => {
    const dir = tmpAgentDir();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "web-nested-"));
    try {
      // Hand-written nested shape: the flat panel key is NOT a top-level key.
      fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ web: { brave: { apiKey: "nested-project-key" } } }));
      const cfg = webConfig();
      cfg.groups()[0]!.rows.find((r) => r.key === "web.brave.apiKey")!.set("panel-key");
      const notifications: string[] = [];
      const ctx = { cwd, ui: { notify: (m: string) => notifications.push(m) }, isProjectTrusted: () => true } as never;
      await cfg.save(new Set(["web.brave.apiKey"]), ctx);
      const note = notifications.join(" ");
      assert.match(note, /shadows: brave\.apiKey/, note);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  it("trusted save with no project web section reports no phantom shadow", async () => {
    const dir = tmpAgentDir();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "web-noproj-"));
    try {
      const cfg = webConfig();
      cfg.groups()[0]!.rows.find((r) => r.key === "web.brave.apiKey")!.set("panel-key");
      const notifications: string[] = [];
      const ctx = { cwd, ui: { notify: (m: string) => notifications.push(m) }, isProjectTrusted: () => true } as never;
      await cfg.save(new Set(["web.brave.apiKey"]), ctx);
      // Disclosure reads the PROJECT layer alone: a merged read would see the
      // key just written to global and call it a shadow.
      assert.doesNotMatch(notifications.join(" "), /shadows:/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });
});
