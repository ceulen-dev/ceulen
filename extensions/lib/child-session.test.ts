import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beginChildFactory,
  childFactoryDepth,
  endChildFactory,
  isChildSession,
  markChildSession,
} from "./child-session.ts";

test("unmarked sessions are not children (host events run)", () => {
  const host = { id: "host" };
  assert.equal(isChildSession(host), false);
  // undefined/no-ctx callers (older hosts, tests) read as host too
  assert.equal(isChildSession(undefined), false);
  assert.equal(isChildSession(null), false);
});

test("marked session managers are children; other sessions are not", () => {
  const child = { id: "child" };
  const host = { id: "host" };
  markChildSession(child);
  assert.equal(isChildSession(child), true);
  assert.equal(isChildSession(host), false);
});

test("factory depth window opens and closes, floors at zero", () => {
  assert.equal(childFactoryDepth(), 0);
  beginChildFactory();
  beginChildFactory();
  assert.equal(childFactoryDepth(), 2);
  endChildFactory();
  endChildFactory();
  assert.equal(childFactoryDepth(), 0);
  endChildFactory(); // stray end must never go negative
  assert.equal(childFactoryDepth(), 0);
});

test("nested windows: inner finally does not close the outer window", () => {
  assert.equal(childFactoryDepth(), 0);
  beginChildFactory();
  try {
    beginChildFactory();
    try {
      assert.equal(childFactoryDepth(), 2);
    } finally {
      endChildFactory();
    }
    assert.equal(childFactoryDepth(), 1, "outer window still open");
  } finally {
    endChildFactory();
  }
  assert.equal(childFactoryDepth(), 0);
});
