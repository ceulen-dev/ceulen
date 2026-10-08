// think tool tests — definition shape, execute contract, collapsed rendering,
// the thinkTool gate on module load, and the kill-switch defaultActive.
//
// The agent dir is isolated for the WHOLE file (advisor catch: a test outside
// the gating describe would otherwise read the developer's real
// ~/.pi/agent/settings.json — a locally kill-switched `think` would fail it
// spuriously).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import steeringModule from "../index.js";
import { THINK_MARKER, thinkTool } from "../lib/think.js";
import { createFakePi, isolateAgentDir, setSteeringSettings } from "./harness.js";

describe("think tool", () => {
  let iso: { dir: string; restore: () => void };
  beforeEach(() => { iso = isolateAgentDir("ceulen-think-test-"); });
  afterEach(() => iso.restore());

  describe("definition", () => {
    it("has the OMP contract: private scratchpad, no promptSnippet", () => {
      const def = thinkTool();
      assert.equal(def.name, "think");
      assert.equal(def.label, "Think");
      assert.match(def.description, /scratchpad/i);
      assert.equal((def as Record<string, unknown>).promptSnippet, undefined, "omitted from Available tools (OMP parity)");
      assert.ok(Array.isArray(def.promptGuidelines) && def.promptGuidelines!.length > 0);
    });

    it("execute returns a minimal acknowledgment, never the thoughts", async () => {
      const def = thinkTool();
      const result = await def.execute();
      assert.deepEqual(result, { content: [{ type: "text", text: "—" }] });
    });

    it("renderers return pi-tui Text components wrapping the dim marker", () => {
      const def = thinkTool();
      const theme = { fg: (token: string, text: string) => `<${token}>${text}</>` };
      const call = def.renderCall({ thoughts: "abcd" }, theme);
      const result = def.renderResult(undefined as never, undefined as never, theme);
      // Regression (live 2026-10-05): a raw string here crashes the TUI with
      // "this.child.render is not a function" — Box needs a real Component.
      for (const c of [call, result]) {
        assert.equal(typeof c, "object");
        assert.equal(typeof (c as { render?: unknown }).render, "function", "must be a pi-tui Component");
        const rendered = (c as { render(width?: number): string[] }).render(80);
        assert.ok(Array.isArray(rendered) && rendered.every((l) => typeof l === "string"));
      }
      assert.match((call as unknown as { render(w: number): string[] }).render(80).join(""), /· think \(4 chars\)/);
      assert.match((result as unknown as { render(w: number): string[] }).render(80).join(""), /·/);
      // No theme → plain text (renderers must not crash on thin contexts).
      const plain = def.renderCall({ thoughts: "x" });
      assert.match((plain as unknown as { render(w: number): string[] }).render(80).join(""), /· think \(1 chars\)/);
    });

  });

  describe("module gating", () => {
    it("thinkTool: false (default) registers no think tool", () => {
      setSteeringSettings(iso.dir, {});
      const pi = createFakePi();
      assert.equal(pi.tools.length, 0, "no tool when the gate is off");
    });

    it("thinkTool: true registers the think tool", () => {
      setSteeringSettings(iso.dir, { thinkTool: true });
      const pi = createFakePi();
      assert.equal(pi.tools.length, 1);
      assert.equal(pi.tools[0]!.name, "think");
    });
  });
});
