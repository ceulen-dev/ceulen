/** Regression tests for the in-process child-session contamination incident
 *  (2026-11): an inbound A2A dispatch (and any extension-loading subagent
 *  child) runs a child pi session in the HOST process. Pi re-invokes ceulen's
 *  factories for the child while ES-module scope stays shared, so a child's
 *  session_start / session_shutdown used to clobber host module-scope state —
 *  live symptom: the host TUI lost its whole status band (model · cwd · git ·
 *  context) after the first inbound dispatch, until restart.
 *
 *  Drive the REAL module handlers with a host ctx, then fire the same
 *  handlers with a ctx whose sessionManager is marked as a child, and assert
 *  the host state survived. */
import { describe, it } from "node:test";
import { assert } from "./chai.js";
import { markChildSession } from "../../../lib/child-session.ts";
import composerModule, { __liveCtxForTests } from "../../composer/index.ts";

/** Fire-the-registered-handlers harness (module.test.ts pattern). */
function harness(factory: (pi: any) => void, opts: Record<string, unknown> = {}) {
  const handlers = new Map<string, Array<(e: any, c: any) => any>>();
  factory({
    on: (event: string, handler: (e: any, c: any) => any) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    ...opts,
  });
  return {
    fire: async (event: string, e: any, ctx: any) => {
      for (const h of handlers.get(event) ?? []) await h(e, ctx);
    },
  };
}

function makeCtx(sessionManager: object, mode = "tui") {
  const calls: string[] = [];
  return {
    calls,
    mode,
    hasUI: mode === "tui",
    cwd: "/tmp/host",
    sessionManager,
    thinkingLevel: "medium",
    ui: {
      theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s },
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setEditorComponent: () => calls.push("setEditorComponent"),
      setFooter: () => calls.push("setFooter"),
    },
  };
}

describe("child-session contamination: composer liveCtx", () => {
  it("child session_start/shutdown never install or clear the host's liveCtx", async () => {
    const host = harness(composerModule as any, { getSettings: () => ({ compaction: { enabled: true } }) });
    const hostCtx = makeCtx({ id: "host" });
    await host.fire("session_start", {}, hostCtx);
    assert.equal(__liveCtxForTests(), hostCtx, "host session_start installed liveCtx");
    assert.ok(hostCtx.calls.includes("setEditorComponent"), "host start applied the shape");

    // Child lifecycle on the SAME module handlers (in-process child shares
    // this module scope — that is the incident's mechanism).
    const childCtx = makeCtx({ id: "child" }, "print");
    markChildSession(childCtx.sessionManager);
    await host.fire("session_start", {}, childCtx);
    assert.equal(__liveCtxForTests(), hostCtx, "child session_start did NOT overwrite liveCtx");
    assert.equal(
      childCtx.calls.includes("setEditorComponent"),
      false,
      "child session_start did not re-wrap the host editor",
    );

    await host.fire("session_shutdown", {}, childCtx);
    assert.notEqual(__liveCtxForTests(), undefined, "child session_shutdown did NOT clear liveCtx (the incident)");

    // Host teardown still honored (guard does not over-block).
    await host.fire("session_shutdown", {}, hostCtx);
    assert.equal(__liveCtxForTests(), undefined, "host shutdown still clears");
  });
});
