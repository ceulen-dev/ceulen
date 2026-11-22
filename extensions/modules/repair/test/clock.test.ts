// Time context: timestamp/duration formatting and the refresh window.
//
// pi injects no model-visible date/time anywhere (dist/core/system-prompt.js
// renders with `timestamp: 0`), which is the whole reason this exists. DSH
// parity: ISO stamp + numeric offset + IANA zone, compact elapsed, 10-minute
// default refresh.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_CLOCK_REFRESH_MS,
  formatDuration,
  formatTimestamp,
  renderClock,
  shouldInject,
} from "../lib/clock.js";

describe("formatDuration", () => {
  it("emits compact whole-second units", () => {
    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(7_000), "7s");
    assert.equal(formatDuration(90_000), "1m 30s");
    assert.equal(formatDuration(3_661_000), "1h 1m 1s");
    assert.equal(formatDuration(90_061_000), "1d 1h 1m 1s");
  });

  it("clamps a backward clock reading instead of emitting a negative span", () => {
    assert.equal(formatDuration(-5_000), "0s");
  });
});

describe("formatTimestamp", () => {
  it("renders an ISO stamp with a numeric offset and the zone name", () => {
    const stamp = formatTimestamp(Date.UTC(2026, 10, 23, 3, 30, 0), "Asia/Bangkok");
    assert.match(stamp, /^2026-11-23T10:30:00\+07:00 \(Asia\/Bangkok\)$/);
  });

  it("renders UTC with a +00:00 offset", () => {
    const stamp = formatTimestamp(Date.UTC(2026, 10, 23, 3, 30, 0), "UTC");
    assert.match(stamp, /^2026-11-23T03:30:00\+00:00 \(UTC\)$/);
  });

  it("falls back to the process zone for an unknown zone rather than dropping the clock", () => {
    const stamp = formatTimestamp(Date.UTC(2026, 10, 23, 3, 30, 0), "Not/AZone");
    assert.match(stamp, /^2026-11-23T\d{2}:30:00[+-]\d{2}:\d{2} \(/);
  });
});

describe("renderClock", () => {
  it("emits the two load-bearing lines", () => {
    const body = renderClock(Date.UTC(2026, 10, 23, 3, 30, 0), 8_130_000, "UTC");
    const lines = body.split("\n");
    assert.match(lines[0]!, /^Time: 2026-11-23T03:30:00\+00:00 \(UTC\)$/);
    assert.equal(lines[1], "Elapsed since last activity: 2h 15m 30s");
  });

  it("reports an unavailable elapsed span on the first injection", () => {
    assert.match(renderClock(Date.now(), undefined, "UTC"), /Elapsed since last activity: unavailable/);
  });
});

describe("refresh window", () => {
  const now = 1_000_000_000;

  it("injects on the first call", () => {
    assert.equal(shouldInject(undefined, now, DEFAULT_CLOCK_REFRESH_MS), true);
  });

  it("suppresses inside the window and allows at the boundary", () => {
    const state = { lastInjection: now - 60_000 };
    assert.equal(shouldInject(state, now, DEFAULT_CLOCK_REFRESH_MS), false);
    assert.equal(shouldInject({ lastInjection: now - DEFAULT_CLOCK_REFRESH_MS }, now, DEFAULT_CLOCK_REFRESH_MS), true);
  });

  it("treats a non-positive interval as every-step", () => {
    assert.equal(shouldInject({ lastInjection: now }, now, 0), true);
  });

  it("does not park forever when the wall clock moves backwards", () => {
    assert.equal(shouldInject({ lastInjection: now + 60_000 }, now, DEFAULT_CLOCK_REFRESH_MS), true);
  });

  it("defaults to 10 minutes (DSH refreshIntervalMs)", () => {
    assert.equal(DEFAULT_CLOCK_REFRESH_MS, 600_000);
  });
});
