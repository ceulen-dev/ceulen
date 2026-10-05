// attachments module wiring: the ceulen- widget key, the node:test conversion
// invariants, and the registry entry shape.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { MODULES } from "../../../lib/registry.js";
import attachmentsModule from "../index.js";

let TMP: string;

before(() => {
  TMP = mkdtempSync(join(tmpdir(), "ceulen-att-mod-"));
  mkdirSync(join(TMP, "agent"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = join(TMP, "agent");
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
  if (process.env.PI_CODING_AGENT_DIR === join(TMP, "agent")) delete process.env.PI_CODING_AGENT_DIR;
});

describe("attachments module wiring", () => {
  it("registers in the MODULES registry on the Files tab with its config factory", () => {
    const entry = MODULES.find((m) => m.name === "attachments");
    assert.ok(entry, "registry entry exists");
    assert.equal(entry.category, "Files");
    assert.equal(entry.load, attachmentsModule);
    assert.ok(entry.config, "config factory wired");
    assert.ok(!("tools" in entry) || entry.tools === undefined, "no tools to per-toggle");
    assert.ok(!entry.core, "kill-switchable");
  });

  it("widget key is ceulen-prefixed (source scan — no pi- attachments key)", () => {
    const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    assert.ok(src.includes('"ceulen-attachments"'), "ceulen-attachments widget key present");
    assert.ok(!src.includes('"pi-attachments"'), "upstream widget key gone");
    assert.ok(!src.includes("pi-attachments-test"), "no upstream temp-dir prefix");
  });

  it("factory registers the shortcut + input/session handlers via guarded pi surface", () => {
    const registered: string[] = [];
    const shortcuts: string[] = [];
    attachmentsModule({
      on: (event: string) => registered.push(event),
      registerShortcut: (key: string) => shortcuts.push(key),
    } as any);
    assert.deepEqual(registered.sort(), ["input", "session_start"]);
    assert.equal(shortcuts.length, 1);
  });
});
