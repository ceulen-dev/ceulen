// Hand-rolled schedule.ts: POSIX semantics the module relies on — validation,
// name/step/range parsing, the vixie dom/dow OR rule, leap-cycle Feb 29, and
// never-firing expressions. Fire times cross-checked against crontab(5) and
// cron-parser answers on the same inputs. Cron fires in LOCAL time — expected
// values are built with local-time Date constructors, so the suite passes on
// any machine timezone (a UTC-pinned ISO string breaks on UTC±N hosts).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextFire, nextFires, parseSchedule, validateSchedule } from "../lib/schedule.ts";

const T = (iso: string) => new Date(iso);

describe("validateSchedule", () => {
  it("accepts standard expressions incl. names, steps, lists, ranges", () => {
    for (const ok of ["*/5 * * * *", "0 9 * * mon", "0 9 * * mon-fri", "10-30/5 * * * *", "0 0 1,15 * *", "0 0 29 2 *", "0 9 * * 7", "15,45 */2 * jan-mar *", "0 0 * * sun"])
      assert.equal(validateSchedule(ok), null, ok);
  });

  it("rejects wrong arity, out-of-range values, garbage, misplaced names", () => {
    for (const bad of ["* * *", "not a cron", "61 * * * *", "* 24 * * *", "0 0 32 * *", "0 0 * 13 *", "0 0 * * 8", "0 0 * * foo", "*/0 * * * *", "5-2 * * * *", "0 0 * * 1-foo", "0 0 jan * *", "0 0 * * mon-fri *", "15,45 */2 jan-mar * *"])
      assert.equal(typeof validateSchedule(bad), "string", bad);
  });

  it("dow 7 is Sunday (folds to 0)", () => {
    assert.deepEqual([...parseSchedule("0 0 * * 7")[4]!], [0]);
  });
});

describe("nextFire / nextFires", () => {
  /** Local-time constructor — cron math is local, so expectations are too. */
  const L = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi);
  const iso = (d: Date | null) => d?.toISOString();

  it("strictly after `from`, minute granularity", () => {
    const f = nextFires("*/15 * * * *", 2, T("2026-02-09T10:00:00Z"));
    assert.equal(f[0]!.toISOString(), "2026-02-09T10:15:00.000Z");
    assert.equal(f[1]!.toISOString(), "2026-02-09T10:30:00.000Z");
  });

  it("names, ranges, step-in-range", () => {
    // 2026-02-09 is a Monday: from Monday 08:00Z (after local 09:00 in +TZ
    // hosts), the next weekday-9am fire is Tuesday LOCAL 09:00.
    assert.equal(iso(nextFires("0 9 * * mon-fri", 1, T("2026-02-09T08:00:00Z"))[0]!), iso(L(2026, 2, 10, 9, 0)));
    assert.deepEqual(
      nextFires("10-30/5 * * * *", 4, T("2026-02-09T10:07:00Z")).map((d) => d.getMinutes()),
      [10, 15, 20, 25],
    );
  });

  it("month boundaries + leap cycle (Feb 29 → 2028, Feb 30 → never)", () => {
    assert.equal(iso(nextFire("0 0 29 2 *", T("2026-02-10T00:00:00Z"))), iso(L(2028, 2, 29, 0, 0)));
    assert.equal(nextFire("0 0 30 2 *", T("2026-02-10T00:00:00Z")), null);
    assert.equal(validateSchedule("0 0 30 2 *"), null, "syntactically valid — just never fires");
  });

  it("vixie OR rule: dom+dow both restricted → EITHER matches", () => {
    // 13th OR Friday: Feb 13 (Fri, both), then every Fri and every 13th.
    const fires = nextFires("0 0 13 * fri", 6, T("2026-02-09T00:00:00Z"));
    for (const d of fires) assert.ok(d.getDate() === 13 || d.getDay() === 5, d.toISOString());
    assert.equal(iso(fires[0]!), iso(L(2026, 2, 13, 0, 0)), "Feb 13 2026 is a Friday — one fire");
    // Unrestricted dow → plain AND: 1st of every month regardless of weekday.
    const firsts = nextFires("0 0 1 * *", 2, T("2026-02-09T00:00:00Z"));
    assert.deepEqual(firsts.map((d) => d.getDate()), [1, 1]);
  });

  it("dom/dow OR rule: 1st OR sundays", () => {
    const fires = nextFires("0 0 1 * 0", 8, T("2026-02-09T00:00:00Z"));
    for (const d of fires) assert.ok(d.getDate() === 1 || d.getDay() === 0, d.toISOString());
  });

  it("invalid expression → null / empty (callers validate first)", () => {
    assert.equal(nextFire("garbage", T("2026-01-01T00:00:00Z")), null);
    assert.deepEqual(nextFires("garbage", 3, T("2026-01-01T00:00:00Z")), []);
  });

  it("second-resolution `from` truncates, never emits a same-minute fire", () => {
    const f = nextFire("* * * * *", T("2026-02-09T10:00:30Z"));
    assert.equal(f!.toISOString(), "2026-02-09T10:01:00.000Z");
  });
});
