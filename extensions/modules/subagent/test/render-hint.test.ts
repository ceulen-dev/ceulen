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

// ── Chain report: per-step results ─────────────────────────────────────────
// `{previous}` only forwards one step, so intermediate findings must be carried
// by the result text itself; the final answer stays first for callers.

test("formatChainReport: final output first, then every step with its own report", async () => {
  const { formatChainReport } = await import("../lib/render.ts");
  const results: SubAgentResult[] = [
    { ...result({ agent: "scout" }), messages: [{ role: "assistant", content: [{ type: "text", text: "FINDINGS-1" }], stopReason: "stop" }] as never },
    { ...result({ agent: "planner" }), messages: [{ role: "assistant", content: [{ type: "text", text: "FINDINGS-2" }], stopReason: "stop" }] as never },
  ];
  const text = formatChainReport("FINDINGS-2", results);
  // Final answer leads.
  assert.ok(text.startsWith("FINDINGS-2"));
  // Both steps present, labeled with index/agent/status.
  assert.match(text, /## Chain steps \(2\)/);
  assert.match(text, /### Step 1\/2 — scout: completed\n\nFINDINGS-1/);
  assert.match(text, /### Step 2\/2 — planner: completed\n\nFINDINGS-2/);
});

test("formatChainReport: failure and pane-capture provenance are both surfaced", async () => {
  const { formatChainReport } = await import("../lib/render.ts");
  const results: SubAgentResult[] = [
    { ...result({ agent: "scout" }), status: "success", bestEffort: true, messages: [{ role: "assistant", content: [{ type: "text", text: "SCRAPED" }], stopReason: "stop" }] as never },
    { ...result({ agent: "worker" }), exitCode: 1, status: "error", stopReason: "timeout", errorMessage: "timed out", messages: [] },
  ];
  const text = formatChainReport("(no output)", results);
  assert.match(text, /Step 1\/2 — scout: completed ⚠ best-effort pane capture/);
  assert.match(text, /Step 2\/2 — worker: failed \(timeout\)/);
  assert.match(text, /timed out/);
});
