// web_a11y tests — the ported OMP normalize/trim/format half (pure), the lazy
// vendored axe source, the runner expression builder, and the CDP flow against
// the fake websocket server (cdp.test.ts harness pattern).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  axeSource,
  formatA11ySummary,
  normalizeA11yResult,
  runA11yAudit,
} from "../lib/a11y";
import type { WsLike } from "../lib/cdp";

// ── normalizeA11yResult ─────────────────────────────────────────────────────

const FIXTURE_VIOLATION = {
  id: "color-contrast",
  impact: "serious",
  help: "Elements must have sufficient color contrast",
  helpUrl: "https://dequeuniversity.com/rules/axe/4.13/color-contrast",
  tags: ["cat.color", "wcag2aa"],
  nodes: Array.from({ length: 12 }, (_, i) => ({
    target: [`#row-${i}`],
    html: `<div id="row-${i}">x</div>`,
    failureSummary: "Fix any of the following...",
  })),
};

const FIXTURE_RESULTS = {
  url: "http://localhost:8000/",
  testEngine: { name: "axe-core", version: "4.13.0" },
  violations: [FIXTURE_VIOLATION],
  incomplete: [{ id: "region", help: "page regions", helpUrl: "x", tags: [], nodes: [{ target: ["body"], html: "<body>", failureSummary: "" }] }],
  passes: [{ id: "html-lang", nodes: [{ target: ["html"], html: "<html>", failureSummary: "" }] }],
};

describe("normalizeA11yResult", () => {
  it("normalizes counts, engine, violations; caps nodes at 10 with real nodeCount", () => {
    const r = normalizeA11yResult("http://localhost:8000/", FIXTURE_RESULTS, false);
    assert.equal(r.url, "http://localhost:8000/");
    assert.deepEqual(r.engine, { name: "axe-core", version: "4.13.0" });
    assert.deepEqual(r.counts, { violations: 1, incomplete: 1, passes: 1 });
    assert.equal(r.violations.length, 1);
    const v = r.violations[0]!;
    assert.equal(v.id, "color-contrast");
    assert.equal(v.impact, "serious");
    assert.equal(v.nodeCount, 12, "true failing-node count");
    assert.equal(v.nodes.length, 10, "capped display");
    assert.equal(v.nodes[0]!.html.length, "<div id=\"row-0\">x</div>".length);
  });

  it("gates incomplete results behind includeIncomplete", () => {
    assert.equal(normalizeA11yResult("u", FIXTURE_RESULTS, false).incomplete.length, 0);
    assert.equal(normalizeA11yResult("u", FIXTURE_RESULTS, true).incomplete.length, 1);
  });

  it("tolerates partial/garbage axe payloads (defensive on optional fields)", () => {
    const r = normalizeA11yResult("http://x/", { violations: [{ id: "z" }] }, false);
    assert.equal(r.violations[0]!.id, "z");
    assert.equal(r.violations[0]!.impact, null);
    assert.equal(r.violations[0]!.nodeCount, 0);
    assert.equal(r.engine.version, "unknown");
    assert.equal(r.url, "http://x/");
  });
});

describe("formatA11ySummary", () => {
  it("renders the OMP summary: header, counts, per-violation lines, node targets, … more tail", () => {
    const text = formatA11ySummary(normalizeA11yResult("http://localhost:8000/", FIXTURE_RESULTS, false));
    assert.match(text, /--- BROWSER A11Y AUDIT/);
    assert.match(text, /url: http:\/\/localhost:8000\//);
    assert.match(text, /axe-core: 4\.13\.0  violations: 1  incomplete: 1  passes: 1/, "counts are raw even when the incomplete list is gated");
    assert.match(text, /\[serious\] color-contrast: Elements must have sufficient color contrast \(12 nodes\)/);
    assert.match(text, /- #row-0$/m);
    assert.match(text, /… and 2 more nodes/);
    assert.match(text, /--- END BROWSER A11Y AUDIT ---/);
    assert.doesNotMatch(text, /incomplete \(needs manual review\)/, "gated off");
  });

  it("lists incomplete results when included", () => {
    const text = formatA11ySummary(normalizeA11yResult("u", FIXTURE_RESULTS, true));
    assert.match(text, /incomplete \(needs manual review\):/);
    assert.match(text, /\[unknown\] region: page regions \(1 node\)/);
    assert.doesNotMatch(formatA11ySummary(normalizeA11yResult("u", FIXTURE_RESULTS, false)), /incomplete \(needs manual review\):/, "gated off");
  });

  it("shadow-root targets render with the >>> boundary", () => {
    const r = normalizeA11yResult("u", { violations: [{ id: "x", nodes: [{ target: [["#shadow-host", "#inner"]] }] }] }, false);
    assert.match(formatA11ySummary(r), /- #shadow-host >>> #inner/);
  });
});

// ── vendored source + runner expression ────────────────────────────────────

describe("axeSource", () => {
  it("reads the vendored 4.13.0 build lazily", () => {
    const src = axeSource();
    assert.ok(src.length > 500_000, "vendored axe.min.js loaded");
    assert.match(src, /axe v4\.13\.0/);
  });
});

describe("runner expression (via fake CDP server)", () => {
  it("bootstraps axe then runs it, returning the normalized report", async () => {
    const evals: string[] = [];
    const ws = new FakeWs();
    ws.onSend = (frame) => {
      const { method, id, params } = frame;
      if (method === "Target.createTarget") ws.reply(id, { targetId: "t1" });
      else if (method === "Target.attachToTarget") ws.reply(id, { sessionId: "s1" });
      else if (method === "Page.navigate") {
        ws.reply(id, { frameId: "f1" });
        ws.event("Page.loadEventFired", {}, "s1");
      } else if (method === "Runtime.evaluate") {
        const expr = String((params as { expression?: string }).expression ?? "");
        evals.push(expr.slice(0, 40));
        if (expr.startsWith("/*! axe")) ws.reply(id, { result: { type: "object", value: undefined } });
        else ws.reply(id, { result: { type: "string", value: JSON.stringify({ __axeOk: FIXTURE_RESULTS }) } });
      } else ws.reply(id, {});
    };
    const r = await runA11yAudit({ url: "http://localhost:8000/", wsFactory: () => ws, signal: undefined });
    assert.equal(evals.length, 2, "bootstrap + runner evaluate");
    assert.equal(r.violations[0]!.id, "color-contrast");
    // The runner carried the options: default = no runOnly (axe defaults).
    assert.ok(!evals[1]!.includes("runOnly"), "no tags → axe default tag set");
  });

  it("tags/selector flow into the runner expression", async () => {
    let runner = "";
    const ws = new FakeWs();
    ws.onSend = (frame) => {
      const { method, id, params } = frame;
      if (method === "Target.createTarget") ws.reply(id, { targetId: "t1" });
      else if (method === "Target.attachToTarget") ws.reply(id, { sessionId: "s1" });
      else if (method === "Page.navigate") {
        ws.reply(id, { frameId: "f1" });
        ws.event("Page.loadEventFired", {}, "s1");
      } else if (method === "Runtime.evaluate") {
        const expr = String((params as { expression?: string }).expression ?? "");
        if (expr.startsWith("/*! axe")) ws.reply(id, { result: { type: "object" } });
        else {
          runner = expr;
          ws.reply(id, { result: { type: "string", value: JSON.stringify({ __axeOk: FIXTURE_RESULTS }) } });
        }
      } else ws.reply(id, {});
    };
    await runA11yAudit({
      url: "http://localhost:8000/",
      tags: ["wcag2a", "wcag2aa"],
      rules: ["color-contrast"],
      selector: "main",
      wsFactory: () => ws,
    });
    assert.match(runner, /"runOnly":\{"type":"tag","values":\["wcag2a","wcag2aa"\]\}/);
    assert.match(runner, /"color-contrast":\{"enabled":true\}/);
    assert.match(runner, /include: \["main"\]/);
  });

  it("a rejected axe.run surfaces as a tool error (unwrapEvaluate path)", async () => {
    const ws = new FakeWs();
    ws.onSend = (frame) => {
      const { method, id, params } = frame;
      if (method === "Target.createTarget") ws.reply(id, { targetId: "t1" });
      else if (method === "Target.attachToTarget") ws.reply(id, { sessionId: "s1" });
      else if (method === "Page.navigate") {
        ws.reply(id, { frameId: "f1" });
        ws.event("Page.loadEventFired", {}, "s1");
      } else if (method === "Runtime.evaluate") {
        const expr = String((params as { expression?: string }).expression ?? "");
        if (expr.startsWith("/*! axe")) ws.reply(id, { result: { type: "object" } });
        else {
          ws.reply(id, { result: { type: "string", value: JSON.stringify({ __axeError: "axe bootstrap missing" }) } });
        }
      } else ws.reply(id, {});
    };
    await assert.rejects(
      runA11yAudit({ url: "http://localhost:8000/", wsFactory: () => ws }),
      /axe bootstrap missing/,
    );
  });
});

// ── FakeWs (copied minimal from cdp.test.ts — same harness contract) ────────

class FakeWs implements WsLike {
  onSend: ((frame: Record<string, any>) => void) | null = null;
  private listeners = new Map<string, Array<(ev?: { data?: unknown }) => void>>();

  addEventListener(type: string, fn: (ev?: { data?: unknown }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(fn);
    if (type === "open") queueMicrotask(() => this.emit("open"));
  }
  removeEventListener(type: string, fn: (ev?: { data?: unknown }) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  send(data: string) {
    const frame = JSON.parse(data);
    if (this.onSend) queueMicrotask(() => this.onSend!(frame));
  }
  close() {
    this.emit("close");
  }
  emit(type: string, ev?: { data?: unknown }) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  reply(id: number, result: Record<string, unknown>) {
    this.emit("message", { data: JSON.stringify({ id, result }) });
  }
  event(method: string, params: Record<string, unknown>, sessionId?: string) {
    this.emit("message", { data: JSON.stringify({ method, params, sessionId }) });
  }
}
