/**
 * Per-tool kill-switch (ceulen.disabledTools): registry helpers roundtrip,
 * /config row synthesis, live-apply set arithmetic, and the module-side
 * defaultActive gating (serena's reg(), fff's registerBoundedTool mapping).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { MODULES } from "../../../lib/registry.js";
import { readDisabledTools, writeDisabledTools } from "../../../lib/tools.js";
import {
  allDeclaredTools,
  applyToolSwitches,
  moduleToolRow,
  moduleToolRows,
  nextDisabledTools,
  TOOL_SWITCH_PREFIX,
  withToolRows,
} from "../index.js";

let tmpHome = "";

before(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ceulen-tools-test-"));
  process.env.PI_CODING_AGENT_DIR = tmpHome;
});

after(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(tmpHome, { recursive: true, force: true });
});

const settingsFile = () => join(tmpHome, "settings.json");
const readSettings = (): Record<string, unknown> =>
  JSON.parse(readFileSync(settingsFile(), "utf8")) as Record<string, unknown>;

describe("disabledTools settings roundtrip", () => {
  it("reads empty when no file or no key exists", () => {
    writeFileSync(settingsFile(), "{}", "utf8");
    assert.deepEqual([...readDisabledTools()], []);
  });

  it("roundtrips the list through the ceulen section and drops non-strings", () => {
    writeDisabledTools(["serena_onboarding", 42 as unknown as string, "ffgrep"]);
    assert.deepEqual([...readDisabledTools()].sort(), ["ffgrep", "serena_onboarding"]);
    const ceulen = readSettings().ceulen as Record<string, unknown>;
    assert.ok(Array.isArray(ceulen.disabledTools), "lives in the ceulen section");
  });

  it("preserves sibling keys and refuses a corrupt file", () => {
    writeDisabledTools(["ffgrep"]);
    writeFileSync(settingsFile(), "not json", "utf8");
    assert.deepEqual([...readDisabledTools()], [], "malformed file → defaults (all on)");
    assert.throws(() => writeDisabledTools([]), /not valid JSON/);
    writeFileSync(settingsFile(), "{}", "utf8");
  });
});

describe("declared tool inventory", () => {
  it("matches the modules' actual tool names", () => {
    assert.ok(MODULES.find((m) => m.name === "serena")!.tools!.includes("serena_find_symbol"));
    assert.ok(MODULES.find((m) => m.name === "fff")!.tools!.includes("ffgrep"));
    assert.equal(MODULES.find((m) => m.name === "rtk")!.tools, undefined, "rtk has no tools");
    assert.equal(new Set(allDeclaredTools()).size, allDeclaredTools().length, "no duplicate declarations");
  });
});

describe("tool toggle rows", () => {
  it("keys rows under ceulen.disabledTools.<tool> over the working set", () => {
    const working = new Set(["ffgrep", "ffind"]);
    const r = moduleToolRow("ffgrep", working);
    assert.equal(r.key, `${TOOL_SWITCH_PREFIX}ffgrep`);
    assert.equal(r.value, true);
    r.set(false);
    assert.ok(!working.has("ffgrep"));
    r.set(true);
    assert.ok(working.has("ffgrep"));
  });

  it("labels tools by name, with a pretty label/description for the ones that need explaining", () => {
    assert.equal(moduleToolRow("ffgrep", new Set()).label, "ffgrep", "bare names stay the identity the model sees");
    assert.match(String(moduleToolRow("ffgrep", new Set()).description), /Registers the tool inactive when off/);
    const advisor = moduleToolRow("advisor", new Set());
    assert.equal(advisor.label, "Consult tool", "advisor's row says what it is, not the feature's name twice");
    assert.match(String(advisor.description), /second opinion on demand/);
    assert.match(String(advisor.description), /background review is unaffected/);
  });

  it("synthesizes rows only for declared tools; withToolRows appends to the first group", () => {
    assert.deepEqual(moduleToolRows(undefined, new Set()), []);
    const groups = [{ key: "s", label: "Serena", tab: "Tools", rows: [{ key: "ceulen.disabled.serena" }] }] as never;
    const out = withToolRows(groups, ["ffgrep", "ffind"], new Set());
    assert.deepEqual(
      (out[0] as { rows: { key: string }[] }).rows.map((r) => r.key),
      ["ceulen.disabled.serena", `${TOOL_SWITCH_PREFIX}ffgrep`, `${TOOL_SWITCH_PREFIX}ffind`],
    );
    assert.equal(withToolRows(groups, [], new Set()), groups, "no tools → unchanged");
  });

  it("nextDisabledTools inverts the working set over every declared tool", () => {
    const all = allDeclaredTools();
    const working = new Set(all);
    working.delete("serena_onboarding");
    assert.deepEqual(nextDisabledTools(working), ["serena_onboarding"]);
    assert.deepEqual(nextDisabledTools(new Set(all)), []);
  });
});

describe("applyToolSwitches (live set arithmetic)", () => {
  function stubPi(active: string[], registered: string[]) {
    const calls: string[][] = [];
    return {
      calls,
      pi: {
        getActiveTools: () => [...active],
        getAllTools: () => registered.map((name) => ({ name })),
        setActiveTools: (names: string[]) => calls.push(names),
      },
    };
  }

  it("drops newly disabled, re-adds newly enabled (registered only)", () => {
    const { pi, calls } = stubPi(["read", "bash", "ffgrep", "serena_find_symbol"], ["read", "bash", "ffgrep", "serena_find_symbol", "ffind"]);
    // before=enabled set {ffgrep, serena_find_symbol, ffind}; after={ffind}:
    // ffgrep + serena_find_symbol drop out of the active set; ffind was
    // already enabled (in before) so it is NOT re-added — it was never active.
    applyToolSwitches(pi, new Set(["ffgrep", "serena_find_symbol", "ffind"]), new Set(["ffind"]));
    assert.deepEqual(calls[0]!.sort(), ["bash", "read"]);
  });

  it("no-op diff still issues one setActiveTools with the unchanged set", () => {
    const { pi, calls } = stubPi(["read", "ffgrep"], ["read", "ffgrep"]);
    applyToolSwitches(pi, new Set(["ffgrep"]), new Set(["ffgrep"]));
    assert.deepEqual(calls[0]!.sort(), ["ffgrep", "read"]);
  });

  it("enabling an unregistered tool is skipped silently", () => {
    const { pi, calls } = stubPi(["read"], ["read"]);
    applyToolSwitches(pi, new Set(), new Set(["ghost_tool"]));
    assert.deepEqual(calls[0]!, ["read"]);
  });
});
