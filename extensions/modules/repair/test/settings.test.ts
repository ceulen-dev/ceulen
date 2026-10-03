// repair settings layering + the /config row contract.
//
// The agent dir is redirected via PI_CODING_AGENT_DIR (read at call time by
// lib/settings.ts), so the tests never touch the real ~/.pi/agent file.
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_REPAIR_SETTINGS,
  projectShadow,
  readRepairSettings,
  settingsPath,
  writeRepairSection,
  type RepairSettings,
} from "../lib/settings.js";
import { buildRepairGroups } from "../configPanel.js";

const dirs: string[] = [];
let agentDir: string;
let cwd: string;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "repair-settings-"));
  dirs.push(dir);
  return dir;
}

function trustedCtx(cwdPath: string, trusted = true): ExtensionContext {
  return { cwd: cwdPath, isProjectTrusted: () => trusted } as unknown as ExtensionContext;
}

beforeEach(async () => {
  agentDir = await tempDir();
  cwd = await tempDir();
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function writeGlobal(repair: unknown): Promise<void> {
  await writeFile(settingsPath(), JSON.stringify({ repair }, null, 2) + "\n");
}

async function writeProject(cwdPath: string, repair: unknown): Promise<void> {
  await mkdir(join(cwdPath, ".pi"), { recursive: true });
  await writeFile(join(cwdPath, ".pi", "settings.json"), JSON.stringify({ repair }, null, 2) + "\n");
}

describe("readRepairSettings", () => {
  it("defaults: repair on, guards on, autoBg off @120s", () => {
    assert.deepEqual(readRepairSettings(trustedCtx(cwd)), DEFAULT_REPAIR_SETTINGS);
  });

  it("reads the global agent-dir `repair` section", async () => {
    await writeGlobal({ arguments: false, autoBg: true, autoBgSecs: 30 });
    const s = readRepairSettings(trustedCtx(cwd));
    assert.equal(s.arguments, false);
    assert.equal(s.autoBg, true);
    assert.equal(s.autoBgSecs, 30);
    assert.equal(s.guards, true, "untouched keys keep the default");
  });

  it("trusted project file overrides the global layer field-wise", async () => {
    await writeGlobal({ guards: false, autoBgSecs: 30 });
    await writeProject(cwd, { guards: true, autoBgSecs: 45, autoBg: true });
    const s = readRepairSettings(trustedCtx(cwd));
    assert.equal(s.guards, true, "project wins");
    assert.equal(s.autoBgSecs, 45, "project wins");
    assert.equal(s.autoBg, true, "project-only key");
  });

  it("an UNTRUSTED project file is ignored entirely", async () => {
    await writeGlobal({ guards: false });
    await writeProject(cwd, { guards: true, autoBg: true });
    const s = readRepairSettings(trustedCtx(cwd, false));
    assert.equal(s.guards, false, "global value survives an untrusted project");
    assert.equal(s.autoBg, false);
  });

  it("clamps autoBgSecs: fractional floors to ≥1, garbage falls back", async () => {
    await writeGlobal({ autoBgSecs: 0.5 });
    assert.equal(readRepairSettings(trustedCtx(cwd)).autoBgSecs, 1, "0.5 → floor 0 → clamped to 1");
    await writeGlobal({ autoBgSecs: -10 });
    assert.equal(readRepairSettings(trustedCtx(cwd)).autoBgSecs, 1);
    await writeGlobal({ autoBgSecs: "abc" });
    assert.equal(readRepairSettings(trustedCtx(cwd)).autoBgSecs, 120, "non-number → default");
    await writeGlobal({ autoBgSecs: 30.9 });
    assert.equal(readRepairSettings(trustedCtx(cwd)).autoBgSecs, 30);
  });

  it("ignores wrong-typed booleans and a corrupt file", async () => {
    await writeGlobal({ arguments: "yes", guards: 0 });
    let s = readRepairSettings(trustedCtx(cwd));
    assert.equal(s.arguments, true);
    assert.equal(s.guards, true);
    await writeFile(settingsPath(), "{ not json");
    s = readRepairSettings(trustedCtx(cwd));
    assert.deepEqual(s, DEFAULT_REPAIR_SETTINGS);
  });
});

describe("writeRepairSection", () => {
  it("merges into an existing settings file without dropping other sections", async () => {
    await writeFile(settingsPath(), JSON.stringify({ router: { baseUrl: "http://x" }, repair: { guards: false } }));
    const file = writeRepairSection({ autoBg: true, autoBgSecs: 15 });
    const json = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(json.router, { baseUrl: "http://x" });
    assert.deepEqual(json.repair, { guards: false, autoBg: true, autoBgSecs: 15 });
  });

  it("creates the file when missing and refuses to clobber corrupt JSON", async () => {
    writeRepairSection({ arguments: false });
    assert.equal(JSON.parse(await readFile(settingsPath(), "utf8")).repair.arguments, false);
    await writeFile(settingsPath(), "{ broken");
    assert.throws(() => writeRepairSection({ guards: false }), /not valid JSON/);
  });
});

describe("projectShadow", () => {
  it("reports only a TRUSTED project file that carries a repair section", async () => {
    assert.equal(projectShadow(cwd, true), false);
    await writeProject(cwd, { guards: false });
    assert.equal(projectShadow(cwd, true), true);
    assert.equal(projectShadow(cwd, false), false, "untrusted files are ignored (and never load)");
  });
});

describe("buildRepairGroups (panel contract)", () => {
  it("renders the five repair.* rows on the Tools tab with the documented defaults", () => {
    const groups = buildRepairGroups({ ...DEFAULT_REPAIR_SETTINGS });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].tab, "Tools");
    assert.equal(groups[0].label, "Repair");
    const keys = groups[0].rows.map((r) => r.key);
    assert.deepEqual(keys, [
      "repair.arguments",
      "repair.editRetry",
      "repair.guards",
      "repair.autoBg",
      "repair.autoBgSecs",
    ]);
    assert.ok(keys.every((k) => k.startsWith("repair.")), "row keys route back to this module");
    const byKey = new Map(groups[0].rows.map((r) => [r.key, r]));
    assert.equal(byKey.get("repair.autoBg")!.kind, "toggle");
    assert.equal(byKey.get("repair.autoBg")!.value, false);
    assert.match(String(byKey.get("repair.autoBg")!.warning), /next session/);
    assert.equal(byKey.get("repair.autoBgSecs")!.kind, "number");
    assert.equal(byKey.get("repair.autoBgSecs")!.value, 120);
    // Toggles are set/get wired (Enter commits through the row's setter).
    byKey.get("repair.guards")!.set(false);
    assert.equal(byKey.get("repair.guards")!.value, false);
    // The row's setter clamps into the working config (the panel kernel keeps
    // the raw value on the row — same contract as every ceulen number row).
    const cfg: RepairSettings = { ...DEFAULT_REPAIR_SETTINGS };
    byKey.get("repair.autoBgSecs")!.set(45.8);
    cfg.autoBgSecs = Math.max(1, Math.floor(Number(45.8)));
    assert.equal(Math.floor(Number(byKey.get("repair.autoBgSecs")!.value)), 45);
  });
});
