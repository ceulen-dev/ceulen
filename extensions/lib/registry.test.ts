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
  // direct. A registry edit that silently reverts them must fail here.
  it("keeps the promoted hot tools out of every deferred list", async () => {
    const { MODULES } = await import("./registry.js");
    const allDeferred = new Set(MODULES.flatMap((m) => m.deferredTools ?? []));
    for (const hot of ["munin_search", "munin_get", "github", "ux_audit"]) {
      assert.equal(allDeferred.has(hot), false, `${hot} must stay direct`);
    }
  });
});

describe("MODULES load order", () => {
  // The steering entry must stay behind every before_agent_start prompt
  // rewriter (its ds-anchor bootstrap REPLACES the final prompt; a rewriter
  // loaded after it would append to the byte-identical minimal prompt, which
  // is exactly what serena/web used to do) and ahead of the non-rewriters
  // (config). Modules registering before_agent_start and loading BEFORE
  // steering: munin, advisor, ux, ponytail, subagent, plan, fff, serena, web,
  // rules, rtk — web is the last of them, hence the anchor below. rtk IS a
  // prompt rewriter (its before_agent_start appends the RTK note), so it must
  // sit before steering or the ds-anchor bootstrap loses byte-identity.
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
