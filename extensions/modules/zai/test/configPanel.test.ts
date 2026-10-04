// NEW for the ceulen port — the /config contribution: row shape/defaults, the
// global settings.json save path, and the live provider re-register on a
// baseUrl change (speed/signing/throttle are read per request).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import zaiModule from "../index.js";
import { zaiConfig, buildZaiGroups } from "../configPanel.js";
import { DEFAULT_BASE_URL, KNOWN_BASE_URLS } from "../lib/anthropic.js";

const ENV_KEYS = ["ZAI_ANTHROPIC_API_KEY", "ZAI_ANTHROPIC_BASE_URL", "PI_CODING_AGENT_DIR"] as const;

let dirs: string[] = [];
let saved: Record<string, string | undefined> = {};

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  dirs = [];
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fakePi() {
  const providers: Array<{ name: string; config: any }> = [];
  const pi = {
    registerProvider: (name: string, config: any) => providers.push({ name, config }),
    on: () => () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  return { pi, providers };
}

function saveCtx(cwd: string, trusted = true) {
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = {
    cwd,
    model: undefined,
    isProjectTrusted: () => trusted,
    ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
  } as unknown as ExtensionContext;
  return { ctx, notifications };
}

describe("buildZaiGroups", () => {
  const cfg = { baseUrl: DEFAULT_BASE_URL, speed: "fast" as const, signing: true, minIntervalMs: 1000 };

  it("renders one Providers section with the four owned rows and their defaults", () => {
    const groups = buildZaiGroups({ ...cfg });
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.tab, "Providers");
    assert.equal(groups[0]!.label, "Z.AI Coding Plan");
    assert.deepEqual(groups[0]!.rows.map((r) => r.key), [
      "zai.baseUrl", "zai.speed", "zai.signing", "zai.minIntervalMs",
    ]);
    const [baseUrl, speed, signing, gate] = groups[0]!.rows;
    assert.equal(baseUrl!.kind, "string");
    assert.equal(baseUrl!.defaultValue, DEFAULT_BASE_URL);
    assert.match(baseUrl!.description ?? "", /ZAI_ANTHROPIC_BASE_URL/);
    assert.equal(speed!.values?.join(","), "fast,standard");
    assert.equal(speed!.defaultValue, "fast");
    assert.equal(signing!.kind, "toggle");
    assert.equal(signing!.defaultValue, true);
    assert.match(signing!.warning ?? "", /fails open to unsigned/);
    assert.equal(gate!.kind, "number");
    assert.equal(gate!.defaultValue, 1000);
    assert.match(gate!.description ?? "", /0 disables/);
  });

  it("baseUrl menu offers exactly the known endpoints, each described", () => {
    const rows = buildZaiGroups({ ...cfg })[0]!.rows;
    const options = rows[0]!.menu!();
    assert.deepEqual(options.map((o) => o.value), [...KNOWN_BASE_URLS]);
    assert.ok(options.every((o) => (o.description ?? "").length > 0));
  });

  it("row setters mutate the working copy (baseUrl trimmed, gate numeric)", () => {
    const working = { ...cfg };
    const rows = buildZaiGroups(working)[0]!.rows;
    rows[0]!.set(" https://open.bigmodel.cn/api/anthropic/ ");
    rows[1]!.set("standard");
    rows[2]!.set(false);
    rows[3]!.set("250");
    assert.equal(working.baseUrl, "https://open.bigmodel.cn/api/anthropic/");
    assert.equal(working.speed, "standard");
    assert.equal(working.signing, false);
    assert.equal(working.minIntervalMs, 250);
  });
});

describe("zaiConfig save", () => {
  it("no-ops unless an owned key was edited", async () => {
    const agentDir = tempDir("zai-cfg-agent-");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const cwd = tempDir("zai-cfg-cwd-");
    const { pi } = fakePi();
    const { ctx, notifications } = saveCtx(cwd);
    const cfg = zaiConfig(pi);

    await cfg.save(new Set(["router.baseUrl", "ceulen.disabled"]), ctx);
    assert.equal(notifications.length, 0);
    assert.equal(existsSync(join(agentDir, "settings.json")), false, "no file written for foreign keys");
  });

  it("writes the changed fields into the GLOBAL settings.json and re-registers on a baseUrl change", async () => {
    const agentDir = tempDir("zai-cfg-agent-");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const cwd = tempDir("zai-cfg-cwd-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ ceulen: { disabled: ["fff"] }, zai: { speed: "fast" } }));

    const { pi, providers } = fakePi();
    zaiModule(pi); // load-time registration, like the real bundle
    assert.equal(providers.length, 1);

    const cfg = zaiConfig(pi);
    const rows = cfg.groups()[0]!.rows;
    rows.find((r) => r.key === "zai.baseUrl")!.set("https://zcode.z.ai/api/v1/ultra-zai/anthropic");
    rows.find((r) => r.key === "zai.signing")!.set(false);
    rows.find((r) => r.key === "zai.minIntervalMs")!.set(0);

    const { ctx, notifications } = saveCtx(cwd);
    await cfg.save(new Set(["zai.baseUrl", "zai.signing", "zai.minIntervalMs"]), ctx);

    const written = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    assert.deepEqual(written.ceulen, { disabled: ["fff"] }, "other sections preserved");
    assert.equal(written.zai.baseUrl, "https://zcode.z.ai/api/v1/ultra-zai/anthropic");
    assert.equal(written.zai.signing, false);
    assert.equal(written.zai.minIntervalMs, 0);
    assert.equal(written.zai.speed, "fast", "untouched field left exactly as it was");

    assert.equal(providers.length, 2, "baseUrl change live-applies via one extra registration");
    assert.equal(providers[1]!.name, "zai-anthropic");
    assert.equal(providers[1]!.config.baseUrl, "https://zcode.z.ai/api/v1/ultra-zai/anthropic");
    assert.match(notifications[0]!.message, /Z\.AI config saved to/);
    assert.equal(notifications[0]!.level, "info");
  });

  it("does not re-register when only per-request fields changed", async () => {
    const agentDir = tempDir("zai-cfg-agent-");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const cwd = tempDir("zai-cfg-cwd-");
    const { pi, providers } = fakePi();
    zaiModule(pi);

    const cfg = zaiConfig(pi);
    cfg.groups()[0]!.rows.find((r) => r.key === "zai.speed")!.set("standard");
    const { ctx } = saveCtx(cwd);
    await cfg.save(new Set(["zai.speed"]), ctx);

    assert.equal(providers.length, 1, "speed is read per request — no re-register");
    assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).zai.speed, "standard");
  });

  it("warns when env shadows the saved value", async () => {
    const agentDir = tempDir("zai-cfg-agent-");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.ZAI_ANTHROPIC_BASE_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic";
    const cwd = tempDir("zai-cfg-cwd-");
    const { pi } = fakePi();
    zaiModule(pi);

    const cfg = zaiConfig(pi);
    cfg.groups()[0]!.rows.find((r) => r.key === "zai.baseUrl")!.set("https://open.bigmodel.cn/api/anthropic");
    const { ctx, notifications } = saveCtx(cwd);
    await cfg.save(new Set(["zai.baseUrl"]), ctx);

    assert.equal(notifications[0]!.level, "warning");
    assert.match(notifications[0]!.message, /env/);
    assert.match(notifications[0]!.message, /Effective endpoint: https:\/\/zcode\.z\.ai/);
    assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).zai.baseUrl, "https://open.bigmodel.cn/api/anthropic");
  });

  it("discloses an untrusted project file that pi will ignore", async () => {
    const agentDir = tempDir("zai-cfg-agent-");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const cwd = tempDir("zai-cfg-cwd-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ zai: { baseUrl: "https://open.bigmodel.cn/api/anthropic" } }));

    const { pi } = fakePi();
    zaiModule(pi);
    const cfg = zaiConfig(pi);
    cfg.groups()[0]!.rows.find((r) => r.key === "zai.speed")!.set("standard");
    const { ctx, notifications } = saveCtx(cwd, false);
    await cfg.save(new Set(["zai.speed"]), ctx);

    assert.equal(notifications[0]!.level, "info");
    assert.match(notifications[0]!.message, /NOT trusted/);
  });

  it("baseline honors the trust helper (no phantom project values untrusted)", () => {
    const agentDir = tempDir("zai-trust-agent-");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const cwd = tempDir("zai-trust-cwd-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ zai: { baseUrl: "https://open.bigmodel.cn/api/anthropic" } }));
    const trustFile = join(agentDir, "trust.json");
    const prevCwd = process.cwd();
    process.chdir(cwd);
    try {
      writeFileSync(trustFile, JSON.stringify({ [process.cwd()]: true }));
      assert.equal(
        zaiConfig(fakePi().pi).groups()[0]!.rows[0]!.value,
        "https://open.bigmodel.cn/api/anthropic",
        "trusted → project value shown",
      );
      writeFileSync(trustFile, JSON.stringify({ [process.cwd()]: false }));
      assert.equal(zaiConfig(fakePi().pi).groups()[0]!.rows[0]!.value, DEFAULT_BASE_URL, "untrusted → project value ignored");
    } finally {
      process.chdir(prevCwd);
    }
  });
});
