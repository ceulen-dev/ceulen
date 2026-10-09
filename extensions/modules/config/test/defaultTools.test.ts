/**
 * Built-in tools rows (`defaultTools` setting): working-set toggles, the
 * deterministic next list, and the atomic global-settings write — including
 * the reset semantics (stock-equal list deletes the key) and the corrupt-file
 * guard.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  builtinToolRows,
  DEFAULT_TOOLS_PREFIX,
  nextDefaultTools,
  startupToolSet,
  STOCK_DEFAULT_TOOLS,
  writeDefaultTools,
} from "../defaultTools.js";

const STOCK = ["read", "bash", "edit", "write"];

function tmpFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "ceulen-deftools-")), "settings.json");
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

describe("startupToolSet", () => {
  it("falls back to the stock four when no layer sets defaultTools", () => {
    assert.deepEqual([...startupToolSet(SettingsManager.inMemory())], STOCK);
  });

  it("resolves explicit lists and +name/-name deltas against the stock four", () => {
    assert.deepEqual([...startupToolSet(SettingsManager.inMemory({ defaultTools: ["read", "grep"] }))], ["read", "grep"]);
    assert.deepEqual(
      [...startupToolSet(SettingsManager.inMemory({ defaultTools: ["+codemode", "-write"] }))],
      ["read", "bash", "edit", "codemode"],
    );
  });
});

describe("builtinToolRows", () => {
  it("renders one toggle per built-in tool, stock four default-on", () => {
    const rows = builtinToolRows(new Set(startupToolSet(SettingsManager.inMemory())));
    assert.equal(rows.length, 9, "tool_search has no row — ceulen owns its activation");
    const byKey = new Map(rows.map((r) => [r.key, r]));
    for (const name of STOCK) {
      const r = byKey.get(`${DEFAULT_TOOLS_PREFIX}${name}`)!;
      assert.equal(r.value, true, `${name} on`);
      assert.equal(r.defaultValue, true, `${name} is a stock default`);
    }
    const codemode = byKey.get(`${DEFAULT_TOOLS_PREFIX}codemode`)!;
    assert.equal(codemode.value, false, "codemode off by default");
    assert.equal(codemode.defaultValue, false, "codemode is not a stock default");
    assert.ok(codemode.description?.includes("MCP"), "codemode blurb mentions MCP auto-activation");
  });

  it("toggles mutate the working set in place", () => {
    const working = new Set(STOCK);
    const rows = builtinToolRows(working);
    const grep = rows.find((r) => r.key === `${DEFAULT_TOOLS_PREFIX}grep`)!;
    grep.set(true);
    assert.ok(working.has("grep"));
    grep.set(false);
    assert.ok(!working.has("grep"));
  });
});

describe("nextDefaultTools", () => {
  it("keeps BUILTIN_TOOLS render order regardless of toggle order", () => {
    const working = new Set(["write", "grep", "read"]);
    assert.deepEqual(nextDefaultTools(working), ["read", "write", "grep"]);
  });

  it("round-trips through the panel state", () => {
    const working = startupToolSet(SettingsManager.inMemory({ defaultTools: ["+codemode", "+grep"] }));
    assert.deepEqual(nextDefaultTools(working), [...STOCK, "grep", "codemode"]);
  });

  it("preserves non-builtin names from the user's defaultTools through a toggle save", () => {
    // A bare list may carry arbitrary names (pi accepts them) — toggling a
    // builtin must not silently delete them.
    const working = startupToolSet(SettingsManager.inMemory({ defaultTools: ["+codemode", "github"] }));
    const rows = builtinToolRows(working);
    rows.find((r) => r.key === `${DEFAULT_TOOLS_PREFIX}grep`)!.set(true);
    const list = nextDefaultTools(working);
    assert.ok(list.includes("github"), "arbitrary name survives");
    assert.ok(list.includes("grep"), "toggled builtin included");

    const file = tmpFile();
    writeDefaultTools(list, file);
    assert.deepEqual(readJson(file).defaultTools, list, "round-trip keeps both");
    rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

describe("writeDefaultTools", () => {
  it("preserves sibling keys and writes the absolute list", () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ theme: "dark", defaultTools: ["+codemode"] }, null, 2) + "\n");
    writeDefaultTools([...STOCK, "grep", "codemode"], file);
    const json = readJson(file);
    assert.equal(json.theme, "dark");
    assert.deepEqual(json.defaultTools, [...STOCK, "grep", "codemode"]);
    rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("deletes the key when the list equals the stock four (reset semantics)", () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ theme: "dark", defaultTools: ["+codemode", "+grep"] }, null, 2) + "\n");
    writeDefaultTools([...STOCK], file);
    const json = readJson(file);
    assert.equal(json.theme, "dark");
    assert.ok(!("defaultTools" in json));
    rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("creates the file when missing and throws on a corrupt one", () => {
    const file = tmpFile();
    writeDefaultTools([...STOCK, "grep"], file);
    assert.deepEqual(readJson(file).defaultTools, [...STOCK, "grep"]);
    rmSync(path.dirname(file), { recursive: true, force: true });

    const bad = tmpFile();
    writeFileSync(bad, "{ not json");
    assert.throws(() => writeDefaultTools([...STOCK], bad), /not valid JSON/);
    rmSync(path.dirname(bad), { recursive: true, force: true });
  });

  it("exports the stock defaults matching pi's DEFAULT_TOOL_NAMES", () => {
    assert.deepEqual([...STOCK_DEFAULT_TOOLS], STOCK);
  });
});
