// Repeat-tool-reminder: canonicalization, thresholds, and the chain contract.
//
// DSH parity points worth pinning: deep key-sort makes property order
// irrelevant; only EXACT repeats count; nested calls are skipped; a new user
// message resets the chain; munin tools are excluded (their own dampener owns
// them, and it BLOCKS where this only advises).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ARGUMENTS_PREVIEW_CHARS,
  REPEAT_THRESHOLDS,
  advanceChain,
  callKey,
  canonicalizeArguments,
  isTrackedTool,
  reminderFor,
  sortJsonValue,
} from "../lib/repeat-reminder.js";

describe("canonicalization", () => {
  it("ignores property order at every depth", () => {
    const a = { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } };
    const b = { a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 };
    assert.equal(canonicalizeArguments(a), canonicalizeArguments(b));
    assert.equal(callKey("grep", a), callKey("grep", b));
  });

  it("keeps array order significant (it is semantic)", () => {
    assert.notEqual(canonicalizeArguments([1, 2]), canonicalizeArguments([2, 1]));
  });

  it("distinguishes different tools with identical arguments", () => {
    assert.notEqual(callKey("read", { path: "a" }), callKey("grep", { path: "a" }));
  });

  it("sorts nested objects without dropping values", () => {
    assert.deepEqual(sortJsonValue({ z: { b: 1, a: 2 }, y: null }), { y: null, z: { a: 2, b: 1 } });
  });
});

describe("chain", () => {
  it("fires the gentle reminder on the first threshold only", () => {
    let chain;
    const footers: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const out = advanceChain(chain, "bash", { command: "ls" });
      assert.ok(out);
      chain = out.chain;
      if (out.footer) footers.push(out.footer);
    }
    assert.equal(footers.length, 1);
    assert.match(footers[0]!, /Same tool call repeated/);
    assert.doesNotMatch(footers[0]!, /consecutive_calls/);
  });

  it("escalates to the detailed reminder at the later thresholds", () => {
    let chain;
    const seen: number[] = [];
    for (let i = 1; i <= REPEAT_THRESHOLDS[REPEAT_THRESHOLDS.length - 1]; i++) {
      const out = advanceChain(chain, "grep", { pattern: "x" });
      assert.ok(out);
      chain = out.chain;
      if (out.footer) seen.push(i);
    }
    assert.deepEqual(seen, [...REPEAT_THRESHOLDS]);
    const detailed = reminderFor("grep", 5, '{"pattern":"x"}');
    assert.match(detailed!, /consecutive_calls: 5/);
    assert.match(detailed!, /tool: grep/);
  });

  it("resets when a different call intervenes", () => {
    const first = advanceChain(undefined, "bash", { command: "ls" })!;
    const second = advanceChain(first.chain, "bash", { command: "pwd" })!;
    assert.equal(second.chain.count, 1, "a different call restarts the chain");
    // Returning to the original call counts from 1 again, not 3.
    const third = advanceChain(second.chain, "bash", { command: "pwd" })!;
    assert.equal(third.chain.count, 2);
  });

  it("excludes munin tools (their dampener owns them)", () => {
    assert.equal(isTrackedTool("munin_search"), false);
    assert.equal(isTrackedTool("munin_get"), false);
    assert.equal(isTrackedTool("bash"), true);
    assert.equal(advanceChain(undefined, "munin_search", { query: "x" }), undefined);
  });

  it("caps the quoted arguments", () => {
    const huge = JSON.stringify({ body: "y".repeat(2000) });
    const footer = reminderFor("write", 5, huge)!;
    assert.ok(footer.includes(`+${huge.length - ARGUMENTS_PREVIEW_CHARS} more chars`));
    assert.ok(footer.length < huge.length);
  });

  it("does not fire on non-threshold counts", () => {
    assert.equal(reminderFor("bash", 1, "{}"), undefined);
    assert.equal(reminderFor("bash", 2, "{}"), undefined);
    assert.equal(reminderFor("bash", 4, "{}"), undefined);
    assert.equal(reminderFor("bash", 9, "{}"), undefined);
  });
});
