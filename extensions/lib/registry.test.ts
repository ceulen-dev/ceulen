// Registry helpers: the trust walk must restart from cwd for EVERY candidate
// agent dir (the walk mutates its cursor up to `/`, so a shared cursor made
// dir #2 probe the filesystem root and fail closed).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), "ceulen-registry-test-" + process.pid);
// project = <ROOT>/proj; dirs probed in order dirA (no matching entry) → dirB.
const PROJECT = join(ROOT, "proj");
const DIR_A = join(ROOT, "agentA");
const DIR_B = join(ROOT, "agentB");

before(() => {
  rmSync(ROOT, { recursive: true, force: true });
  for (const d of [PROJECT, DIR_A, DIR_B]) mkdirSync(d, { recursive: true });
});
after(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe("isProjectTrusted", () => {
  it("second agent dir is probed from cwd, not from the first dir's walk root", async () => {
    const { isProjectTrusted } = await import("./registry.js");
    // dirA carries a trust.json that says NOTHING about PROJECT — its walk
    // reaches '/' and must not leak that cursor into dirB's probe.
    writeFileSync(join(DIR_A, "trust.json"), JSON.stringify({ "/somewhere/else": true }));
    writeFileSync(join(DIR_B, "trust.json"), JSON.stringify({ [PROJECT]: true }));
    assert.equal(isProjectTrusted(PROJECT, [DIR_A, DIR_B]), true, "declared boolean for the entry in dir #2");

    writeFileSync(join(DIR_B, "trust.json"), JSON.stringify({ [PROJECT]: false }));
    assert.equal(isProjectTrusted(PROJECT, [DIR_A, DIR_B]), false, "explicit false honoured too");
  });

  it("single-dir behaviour unchanged: parent-walk hit, miss, unreadable → false", async () => {
    const { isProjectTrusted } = await import("./registry.js");
    const nested = join(PROJECT, "a", "b");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(DIR_A, "trust.json"), JSON.stringify({ [PROJECT]: true }));
    assert.equal(isProjectTrusted(nested, [DIR_A]), true, "walk finds the ancestor entry");
    assert.equal(isProjectTrusted(join(ROOT, "nope"), [DIR_A]), false, "no entry → fail closed");
    assert.equal(isProjectTrusted(PROJECT, [join(ROOT, "missing-dir")]), false, "absent trust.json → false");
    const bad = join(ROOT, "bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "trust.json"), "{not json");
    assert.equal(isProjectTrusted(PROJECT, [bad]), false, "malformed json → false");
  });
});

describe("deferredTools tiers", () => {
  // 2026-10-08 usage re-eval: these four were promoted from deferred to
  // direct. 2026-10-12 munin-loop incident: munin_store joined them — a
  // deferred store vanished from the live schema across plan-mode/branch
  // restores and the model looped on the read neighbors. A registry edit that
  // silently reverts any of these must fail here.
  it("keeps the promoted hot tools out of every deferred list", async () => {
    const { MODULES } = await import("./registry.js");
    const allDeferred = new Set(MODULES.flatMap((m) => m.deferredTools ?? []));
    for (const hot of ["munin_search", "munin_get", "munin_store", "github", "ux_audit"]) {
      assert.equal(allDeferred.has(hot), false, `${hot} must stay direct`);
    }
  });

  // 2026-11-18 usage re-eval: the seven serena navigation tools were promoted
  // direct — 56 sessions crossed the tool_search gate 8 times and invoked
  // serena_* ONCE. Serena-first navigation runs BEFORE read/grep, so the tools
  // it replaces can never surface it. A registry edit reverting this must fail.
  it("keeps serena's navigation tools direct, its editing tail deferred", async () => {
    const { MODULES } = await import("./registry.js");
    const allDeferred = new Set(MODULES.flatMap((m) => m.deferredTools ?? []));
    for (const nav of [
      "serena_get_symbols_overview", "serena_find_symbol", "serena_find_referencing_symbols",
      "serena_find_declaration", "serena_find_implementations",
      "serena_search_for_pattern", "serena_get_diagnostics_for_file",
    ]) {
      assert.equal(allDeferred.has(nav), false, `${nav} must stay direct`);
    }
    for (const cold of ["serena_rename_symbol", "serena_replace_symbol_body", "serena_onboarding"]) {
      assert.equal(allDeferred.has(cold), true, `${cold} stays deferred`);
    }
  });
});

describe("MODULES load order", () => {
  // Steering sees the prompt and loadout after the other composers run.
  it("steering is the last prompt rewriter, after rtk, before config", async () => {
    const { MODULES } = await import("./registry.js");
    const at = (name: string) => MODULES.findIndex((m) => m.name === name);
    assert.ok(at("steering") > at("web"), "steering loads after the last rewriter (web)");
    assert.ok(at("steering") > at("serena") && at("steering") > at("plan"));
    assert.ok(at("steering") > at("rtk"), "rtk (a prompt rewriter) loads before steering");
    assert.ok(at("steering") > at("rules"), "rules (prompt composer) loads before steering");
    assert.equal(MODULES.at(-1)!.name, "config", "config stays last");
  });
});
