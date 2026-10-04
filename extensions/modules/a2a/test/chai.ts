/**
 * Chai-assert compat shim — lets the upstream mocha+chai suites run under
 * node:test with ONLY the import line changed
 * (`import { assert } from "chai"` → `from "./chai.js"`).
 *
 * Semantics match chai's assert (loose == for equal, deep loose for
 * deepEqual), NOT node's strict variants. The one that bites (web-port
 * lesson): `include` must handle string substring, array membership, AND
 * object-subset (chai to.include on an object) — object-subset here means
 * "every key/value of subset appears in superset" (chai's behavior via
 * deep-eql on each key).
 */

import nodeAssert from "node:assert";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** chai deep-equal (loose, structural) — node's loose deepEqual is the same contract. */
function deepEqual(a: unknown, b: unknown): boolean {
  try {
    nodeAssert.deepEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

function includeValue(haystack: unknown, needle: unknown, negated: boolean): void {
  let included: boolean;
  if (typeof haystack === "string") included = haystack.includes(String(needle));
  else if (Array.isArray(haystack)) {
    included = haystack.some((item) =>
      isObject(needle) && isObject(item) ? deepEqual(item, needle) : item === needle,
    );
  } else if (isObject(haystack) && isObject(needle)) {
    included = Object.entries(needle).every(([k, v]) => k in haystack && deepEqual(haystack[k], v));
  } else included = false;
  if (negated) nodeAssert.ok(!included, `expected ${JSON.stringify(haystack)} to NOT include ${JSON.stringify(needle)}`);
  else nodeAssert.ok(included, `expected ${JSON.stringify(haystack)} to include ${JSON.stringify(needle)}`);
}

/** node assert treats an EXPLICIT undefined message as a type error when the
 *  assertion fails (chai allows omitting it) — drop undefined before calling. */
function m(msg?: string): string | undefined {
  return msg === undefined ? undefined : msg;
}

export const assert = {
  ok: (v: unknown, msg?: string) => nodeAssert.ok(v, m(msg)),
  equal: (a: unknown, b: unknown, msg?: string) => nodeAssert.equal(a, b, m(msg)),
  notEqual: (a: unknown, b: unknown, msg?: string) => nodeAssert.notEqual(a, b, m(msg)),
  strictEqual: (a: unknown, b: unknown, msg?: string) => nodeAssert.strictEqual(a, b, m(msg)),
  notStrictEqual: (a: unknown, b: unknown, msg?: string) => nodeAssert.notStrictEqual(a, b, m(msg)),
  deepEqual: (a: unknown, b: unknown, msg?: string) => nodeAssert.deepEqual(a, b, m(msg)),
  notDeepEqual: (a: unknown, b: unknown, msg?: string) => nodeAssert.notDeepEqual(a, b, m(msg)),
  isTrue: (v: unknown, msg?: string) => msg === undefined ? nodeAssert.strictEqual(v, true) : nodeAssert.strictEqual(v, true, m(msg)),
  isFalse: (v: unknown, msg?: string) => msg === undefined ? nodeAssert.strictEqual(v, false) : nodeAssert.strictEqual(v, false, m(msg)),
  isOk: (v: unknown, msg?: string) => nodeAssert.ok(v, m(msg)),
  isNotOk: (v: unknown, msg?: string) => nodeAssert.ok(!v, m(msg)),
  isNull: (v: unknown, msg?: string) => msg === undefined ? nodeAssert.strictEqual(v, null) : nodeAssert.strictEqual(v, null, m(msg)),
  isNotNull: (v: unknown, msg?: string) => msg === undefined ? nodeAssert.notStrictEqual(v, null) : nodeAssert.notStrictEqual(v, null, m(msg)),
  isUndefined: (v: unknown, msg?: string) => msg === undefined ? nodeAssert.strictEqual(v, undefined) : nodeAssert.strictEqual(v, undefined, m(msg)),
  isDefined: (v: unknown, msg?: string) => msg === undefined ? nodeAssert.notStrictEqual(v, undefined) : nodeAssert.notStrictEqual(v, undefined, m(msg)),
  isString: (v: unknown, msg?: string) => nodeAssert.equal(typeof v, "string", m(msg)),
  include: (haystack: unknown, needle: unknown, msg?: string) => {
    try { includeValue(haystack, needle, false); } catch (e) { throw new Error(msg ? `${msg}: ${(e as Error).message}` : (e as Error).message); }
  },
  notInclude: (haystack: unknown, needle: unknown, msg?: string) => {
    try { includeValue(haystack, needle, true); } catch (e) { throw new Error(msg ? `${msg}: ${(e as Error).message}` : (e as Error).message); }
  },
  includeMembers: (superset: unknown[], subset: unknown[], msg?: string) => {
    for (const item of subset) includeValue(superset, item, false);
    if (msg) nodeAssert.ok(true, m(msg));
  },
  lengthOf: (v: { length: number }, n: number, msg?: string) => nodeAssert.equal(v.length, n, m(msg)),
  match: (v: string, re: RegExp, msg?: string) => nodeAssert.match(String(v), re, m(msg)),
  notMatch: (v: string, re: RegExp, msg?: string) => nodeAssert.doesNotMatch(String(v), re, m(msg)),
  exists: (v: unknown, msg?: string) => nodeAssert.ok(v != null, m(msg)),
  notExists: (v: unknown, msg?: string) => nodeAssert.ok(v == null, m(msg)),
  isAtLeast: (v: number, n: number, msg?: string) => nodeAssert.ok(v >= n, msg ?? `expected ${v} >= ${n}`),
  isAtMost: (v: number, n: number, msg?: string) => nodeAssert.ok(v <= n, msg ?? `expected ${v} <= ${n}`),
  isAbove: (v: number, n: number, msg?: string) => nodeAssert.ok(v > n, msg ?? `expected ${v} > ${n}`),
  isBelow: (v: number, n: number, msg?: string) => nodeAssert.ok(v < n, msg ?? `expected ${v} < ${n}`),
  isNotEmpty: (v: unknown, msg?: string) => {
    const n = typeof v === "string" || Array.isArray(v) ? v.length : isObject(v) ? Object.keys(v).length : 0;
    nodeAssert.ok(n > 0, m(msg));
  },
  isEmpty: (v: unknown, msg?: string) => {
    const n = typeof v === "string" || Array.isArray(v) ? v.length : isObject(v) ? Object.keys(v).length : 0;
    nodeAssert.equal(n, 0, m(msg));
  },
  throws: (fn: () => unknown, err?: RegExp | Error, msg?: string) => {
    nodeAssert.throws(fn, err as never, m(msg));
  },
  doesNotThrow: (fn: () => unknown, msg?: string) => {
    nodeAssert.doesNotThrow(fn, m(msg));
  },
  fail: (msg?: string) => nodeAssert.fail(msg),
};
