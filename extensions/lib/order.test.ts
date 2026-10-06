// Load-order guard at the REGISTRATION level: the MODULES array order is the
// contract's proxy, but the real invariant is "no module that registers a
// before_agent_start handler loads after steering". This test loads every
// module against a recording fake pi (all pi methods no-op; .on records) and
// asserts the registration order directly — a module added to MODULES after
// steering with a prompt-rewriting handler fails HERE even if nobody updates
// the array-order assertions in registry.test.ts.
//
// Live incident class (reviewer 2026-10-06): rtk loaded after steering and
// its before_agent_start appended the RTK note to the ds-anchor's
// byte-identical minimal prompt, silently defeating the anchor.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("before_agent_start registration order (steering contract)", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "ceulen-order-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    // Neutral settings: all modules enabled, no ceulen section.
    writeFileSync(join(dir, "settings.json"), "{}");
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_CODING_AGENT_DIR;
  });

  it("no module registering before_agent_start loads after steering", async () => {
    const { MODULES } = await import("./registry.js");
    const registrations: { module: string; event: string }[] = [];
    const failures: string[] = [];

    const makePi = (mod: string) =>
      new Proxy({} as Record<string, unknown>, {
        get(_t, prop: string) {
          if (prop === "on") {
            return (event: string) => { registrations.push({ module: mod, event }); };
          }
          if (prop === "then") return undefined; // not a thenable
          return () => undefined; // no-op every other load-time pi call
        },
      });

    for (const m of MODULES) {
      try {
        (m.load as (pi: unknown, deps?: unknown) => void)(makePi(m.name), { configContribs: new Map() });
      } catch (err) {
        // A module needing more than the stub offers still REGISTERED its
        // handlers before failing (pi.on is called first); record and move on.
        failures.push(`${m.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const at = MODULES.findIndex((m) => m.name === "steering");
    const rewroteAfter = registrations.filter(
      (r) => r.event === "before_agent_start" && MODULES.findIndex((m) => m.name === r.module) > at,
    );
    assert.deepEqual(
      rewroteAfter.map((r) => r.module),
      [],
      `before_agent_start registered AFTER steering by: ${rewroteAfter.map((r) => r.module).join(", ")} — ` +
        "steering must be the last prompt rewriter (ds-anchor byte-identity). " +
        `(load failures tolerated: ${failures.length})`,
    );
    // Sanity: the harness captured real registrations from many modules.
    assert.ok(registrations.length > 30, `expected many registrations, saw ${registrations.length}`);
    assert.ok(registrations.some((r) => r.module === "rtk" && r.event === "before_agent_start"),
      "rtk's before_agent_start must be visible to this guard");
  });
});
