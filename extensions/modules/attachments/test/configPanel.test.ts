// attachments' /config contribution: row keys + Files tab, save routing
// (only attachments.* edits persist, working copy driven via row.set()),
// and the corrupt-file guard.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { applyRows } from "../../../lib/panel.js";
import { attachmentsConfig, buildAttachmentsGroups } from "../configPanel.js";
import { DEFAULTS, loadSettings } from "../lib/settings.js";

const realAgentDir = process.env.PI_CODING_AGENT_DIR;
let AGENT: string;

beforeEach(() => {
  AGENT = mkdtempSync(join(tmpdir(), "ceulen-att-cfg-"));
  process.env.PI_CODING_AGENT_DIR = AGENT;
});

after(() => {
  if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = realAgentDir;
});

const fakeCtx = (notified: string[] = []): any => ({
  cwd: AGENT,
  ui: { notify: (message: string) => { notified.push(message); } },
});

describe("attachments config panel", () => {
  it("rows: the five attachments keys on the Files tab", () => {
    const groups = buildAttachmentsGroups({ ...DEFAULTS });
    assert.equal(groups.length, 1);
    const group = groups[0];
    assert.equal(group.tab, "Files");
    assert.equal(group.label, "Attachments");
    assert.deepEqual(
      group.rows.map((r) => r.key),
      [
        "attachments.inlineTextFiles",
        "attachments.maxInlineBytes",
        "attachments.pasteFileShortcut",
        "attachments.pasteCollapseLines",
        "attachments.pasteCollapseChars",
      ],
    );
    assert.equal(group.rows[0].kind, "toggle");
    // The shortcut row carries the load-bound restart warning.
    assert.match(group.rows[2].warning ?? "", /restart/i);
  });

  it("applyRows round-trips a working copy", () => {
    const cfg = { ...DEFAULTS };
    const groups = buildAttachmentsGroups(cfg);
    const byKey = new Map(groups[0].rows.map((r) => [r.key, r]));
    byKey.get("attachments.inlineTextFiles")!.set(true);
    byKey.get("attachments.maxInlineBytes")!.set(5_000);
    byKey.get("attachments.pasteCollapseLines")!.set(0);
    applyRows(cfg, groups);
    assert.equal(cfg.inlineTextFiles, true);
    assert.equal(cfg.maxInlineBytes, 5_000);
    assert.equal(cfg.pasteCollapseLines, 0);
    assert.equal(cfg.pasteCollapseChars, DEFAULTS.pasteCollapseChars, "untouched field stays default");
  });

  it("save persists edited keys to the GLOBAL attachments section (rows driven first)", async () => {
    mkdirSync(AGENT, { recursive: true });
    writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ attachments: { pasteCollapseChars: 999 } }));
    const config = attachmentsConfig();
    // Drive the factory's OWN working copy through the row setters — a save
    // without set() would persist the fresh-from-disk defaults, not the edit.
    const byKey = new Map(config.groups()[0].rows.map((r) => [r.key, r]));
    byKey.get("attachments.inlineTextFiles")!.set(true);
    byKey.get("attachments.maxInlineBytes")!.set(5_000);
    await config.save(new Set(["attachments.inlineTextFiles", "attachments.maxInlineBytes"]), fakeCtx());
    const raw = JSON.parse(readFileSync(join(AGENT, "settings.json"), "utf8"));
    assert.equal(raw.attachments.inlineTextFiles, true);
    assert.equal(raw.attachments.maxInlineBytes, 5_000);
    assert.equal(raw.attachments.pasteCollapseChars, 999, "unrelated sibling key untouched");
  });

  it("save no-ops when no owned key was edited", async () => {
    const config = attachmentsConfig();
    const before = readSettingsIfExists();
    await config.save(new Set(["plan.savePlans"]), fakeCtx());
    assert.equal(readSettingsIfExists(), before, "file untouched");
  });

  it("loadSettings round-trips a written section", () => {
    mkdirSync(AGENT, { recursive: true });
    writeFileSync(
      join(AGENT, "settings.json"),
      JSON.stringify({ attachments: { inlineTextFiles: true, pasteCollapseLines: 42 } }),
    );
    const s = loadSettings();
    assert.equal(s.inlineTextFiles, true);
    assert.equal(s.pasteCollapseLines, 42);
    assert.equal(s.pasteFileShortcut, DEFAULTS.pasteFileShortcut, "unset field falls back");
  });

  it("corrupt settings.json refuses to clobber on save", async () => {
    mkdirSync(AGENT, { recursive: true });
    writeFileSync(join(AGENT, "settings.json"), "{not json");
    const config = attachmentsConfig();
    const byKey = new Map(config.groups()[0].rows.map((r) => [r.key, r]));
    byKey.get("attachments.inlineTextFiles")!.set(true);
    const notified: string[] = [];
    await config.save(new Set(["attachments.inlineTextFiles"]), fakeCtx(notified));
    assert.equal(notified.length, 1);
    assert.match(notified[0], /failed|not valid JSON/i);
    assert.equal(readFileSync(join(AGENT, "settings.json"), "utf8"), "{not json", "corrupt file untouched");
  });
});

function readSettingsIfExists(): string | undefined {
  try {
    return readFileSync(join(AGENT, "settings.json"), "utf8");
  } catch {
    return undefined;
  }
}
