// /config save-path tests for the subagent contribution: roles diffing
// (pristine defaults never written; edited roles persist; clear-to-empty
// deletes), routing/timeout persistence, and the no-op guard.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type PanelRow = { key: string; value: unknown; set: (v: unknown) => void };

function withTempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ceulen-sub-cfg-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

const ctx = { ui: { notify: () => {} }, cwd: process.cwd(), isProjectTrusted: () => false } as never;

async function load() {
  return import("../configPanel.ts");
}

function row(groups: { rows: PanelRow[] }[], key: string): PanelRow {
  const r = groups[0]!.rows.find((x) => x.key === key);
  assert.ok(r, `row ${key} missing`);
  return r;
}

test("save: pristine defaults never leak into settings.json; edited role persists; clear-to-empty deletes", async () => {
  const dir = withTempAgentDir();
  try {
    const { subagentConfig } = await load();
    const file = join(dir, "settings.json");

    // 1. routing-only edit → no roles block written
    let cfg = subagentConfig();
    row(cfg.groups(), "subagent.routing.mode").set("off");
    await cfg.save(new Set(["subagent.routing.mode"]), ctx);
    let written = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(written.subagent.roles, undefined, "pristine roles must not be frozen into settings");
    assert.equal(written.subagent.routing.mode, "off");

    // 2. fast-chain edit → only fast persisted
    cfg = subagentConfig();
    row(cfg.groups(), "subagent.roles.fast").set("a/x, b/y");
    await cfg.save(new Set(["subagent.roles.fast"]), ctx);
    written = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(written.subagent.roles, { fast: ["a/x", "b/y"] });

    // 3. fresh open reads the override; clearing it deletes the key
    cfg = subagentConfig();
    const fast = row(cfg.groups(), "subagent.roles.fast");
    assert.equal(fast.value, "a/x, b/y");
    fast.set("");
    await cfg.save(new Set(["subagent.roles.fast"]), ctx);
    written = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(written.subagent.roles.fast, undefined, "cleared role must be deleted, not written empty");

    // 4. hard-cap + threshold persist; invalid values clamp
    cfg = subagentConfig();
    row(cfg.groups(), "subagent.hardTimeoutMins").set(200);
    row(cfg.groups(), "subagent.routing.threshold").set(5);
    await cfg.save(new Set(["subagent.hardTimeoutMins", "subagent.routing.threshold"]), ctx);
    written = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(written.subagent.hardTimeoutMins, 60);
    assert.equal(written.subagent.routing.threshold, 0.99);
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("save: no-op when nothing changed", async () => {
  const dir = withTempAgentDir();
  try {
    const { subagentConfig } = await load();
    const cfg = subagentConfig();
    const notes: string[] = [];
    const notifying = { ui: { notify: (m: string) => notes.push(m) } } as never;
    await cfg.save(new Set(["subagent.routing.model"]), notifying);
    assert.ok(notes.some((n) => n.includes("no changes")), "untouched panel must no-op");
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("save: not owned keys never touch the file", async () => {
  const dir = withTempAgentDir();
  try {
    const { subagentConfig } = await load();
    const cfg = subagentConfig();
    await cfg.save(new Set(["ponytail.defaultMode"]), ctx);
    assert.equal(await import("node:fs").then((fs) => fs.existsSync(join(dir, "settings.json"))), false);
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
