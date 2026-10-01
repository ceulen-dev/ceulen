/**
 * Composer footer: the narrowed replacement for pi's built-in footer on
 * status-bearing shapes. The band carries identity · context · token stats ·
 * quota windows; the footer keeps only the other extensions' statuses.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ComposerFooter, EMPTY_TOTALS, sessionTotals, statsLine, type SessionTotals } from "../lib/footer.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const assistant = (usage: unknown) => ({ type: "message", message: { role: "assistant", usage: usage as never } });

describe("session totals (band stats source)", () => {
  it("sums usage entries, assistant/toolResult messages and summaries (pi parity)", () => {
    const entries = [
      { type: "message", message: { role: "user" } },
      assistant({ input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 }),
      { type: "message", message: { role: "toolResult", usage: { input: 10, output: 5 } } },
      { type: "usage", usage: { input: 1, output: 2 } },
      { type: "compaction", usage: { input: 7, output: 8 } },
      { type: "branch_summary", usage: { input: 3, output: 4 } },
    ];
    const t = sessionTotals(entries as never);
    assert.equal(t.input, 121);
    assert.equal(t.output, 69);
    assert.equal(t.cacheRead, 1000);
    assert.equal(t.cacheWrite, 200);
    // CH = cacheRead / (input + cacheRead + cacheWrite) of the LATEST assistant prompt.
    assert.ok(Math.abs((t.cacheHitRate ?? 0) - (1000 / 1300) * 100) < 1e-9, `cacheHitRate ${t.cacheHitRate}`);
  });

  it("tolerates garbage usage and an empty session", () => {
    const entries = [
      assistant({ input: "x", output: Number.NaN }),
      assistant(undefined as never),
      { type: "message", message: { role: "assistant" } },
    ];
    const t = sessionTotals(entries as never);
    assert.equal(t.input, 0);
    assert.equal(t.output, 0);
    assert.deepEqual(sessionTotals([]), EMPTY_TOTALS);
  });

  it("statsLine formats the band's token figures and is empty before any usage", () => {
    assert.equal(statsLine(EMPTY_TOTALS), "");
    const line = statsLine({ input: 12_000, output: 4_000, cacheRead: 100_000, cacheWrite: 2_000, cacheHitRate: 97.1 });
    assert.equal(line, "↑12k ↓4.0k R100k W2.0k");
    // Cost and cache-hit are NOT band figures (footer-only).
    const noCost: SessionTotals = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    assert.equal(statsLine(noCost), "↑1 ↓1");
  });
});

describe("ComposerFooter render", () => {
  const footer = (over: Partial<ConstructorParameters<typeof ComposerFooter>[0]> = {}) =>
    new ComposerFooter({
      statuses: () => [],
      ...over,
    });

  it("prints ONLY the other extensions' statuses — no band info", () => {
    const f = footer({ statuses: () => ["rtk ✓", "serena ✓", "🎨 ux: STRICT"] });
    const lines = f.render(80).map(plain);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], "rtk ✓  serena ✓  🎨 ux: STRICT");
    // Nothing the band owns leaks in here.
    for (const l of lines) {
      assert.ok(!/\d+\.\d%\/|\bmain\b|glm|↑|R\d|CH/i.test(l), `no duplicated band info: ${l}`);
    }
  });

  it("drops blank statuses, sanitizes control chars, truncates to width", () => {
    const f = footer({
      statuses: () => ["  ", "a\tb\nc", "x".repeat(200)],
    });
    const lines = f.render(30).map(plain);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.startsWith("a b c"), lines[0]);
    assert.ok(lines[0]!.length <= 31, `truncated: ${lines[0]!.length}`);
  });

  it("renders nothing at all for a fresh session with no statuses", () => {
    assert.deepEqual(footer().render(80), []);
  });

  it("never throws when a data getter throws", () => {
    const f = footer({
      statuses: () => {
        throw new Error("boom");
      },
    });
    assert.deepEqual(f.render(80), []);
  });
});
