// Expand-hint rendering: the "(… to expand)" hint follows the HOST's
// configured keybinding (pi 1.5.x `KeybindingHints.keyText`) and falls back to
// the literal "Ctrl+O" when no render context supplies one (pi <1.5, widget and
// thread renderers). A null theme renders plain text, so assertions read the
// raw strings — same convention as widget.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { expandKeyLabel, renderSingleResult } from "../lib/render.ts";
import type { SubAgentResult } from "../lib/runner.ts";
import type { Text } from "@earendil-works/pi-tui";

const plainTheme = {
  fg: (_c: string, text: string) => text,
  bold: (text: string) => text,
};

function result(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
  return {
    agent: "scout",
    task: "Recon the registry module",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 3, turns: 1 },
    ...overrides,
  };
}

const renderText = (component: unknown): string => (component as Text).render(100).join("\n");

test("expandKeyLabel: host keybinding wins, literal is the fallback", () => {
  assert.equal(expandKeyLabel({ keyText: () => "ctrl+o" }), "ctrl+o");
  assert.equal(expandKeyLabel({ keyText: () => "" }), "Ctrl+O", "empty key list falls back");
  assert.equal(expandKeyLabel({ keyText: () => { throw new Error("boom"); } }), "Ctrl+O", "throwing context falls back");
  assert.equal(expandKeyLabel(undefined), "Ctrl+O", "no context (widget/thread renderers, older pi)");
});

test("renderSingleResult: collapsed hint uses the configured expand key", () => {
  const r = result({
    messages: [{ role: "assistant", content: [{ type: "text", text: "## Heading only" }] } as never],
  });
  // Host-configured key (a rebind) replaces the hardcoded literal.
  const rebinded = renderText(renderSingleResult(r, false, plainTheme, undefined, "ctrl+shift+e"));
  assert.match(rebinded, /ctrl\+shift\+e to expand/);
  assert.doesNotMatch(rebinded, /Ctrl\+O/);
  // Default parameter keeps today's behavior for callers without a context.
  const fallback = renderText(renderSingleResult(r, false, plainTheme));
  assert.match(fallback, /Ctrl\+O to expand/);
});
