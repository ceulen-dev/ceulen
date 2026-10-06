// notify module unit tests — pure lib functions plus notify() with injected
// fakes. No real spawns, no PATH probes, no desktop notifications.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appleQuote, buildDarwinArgs, buildNotifySendArgs, notify } from "../lib/notify.js";

describe("appleQuote", () => {
  it("wraps in double quotes", () => {
    assert.equal(appleQuote("hello"), '"hello"');
  });
  it("escapes internal double quotes and backslashes", () => {
    assert.equal(appleQuote('say "hi"'), '"say \\"hi\\""');
    assert.equal(appleQuote("back\\slash"), '"back\\\\slash"');
  });
});

describe("buildDarwinArgs", () => {
  it("builds the display notification script", () => {
    assert.deepEqual(buildDarwinArgs("pi", "done", false), ["-e", `display notification "done" with title "pi"`]);
  });
  it("appends the Glass sound when sound=true", () => {
    assert.deepEqual(buildDarwinArgs("pi", "done", true), ["-e", `display notification "done" with title "pi" sound name "Glass"`]);
  });
  it("quotes the title safely", () => {
    const [, script] = buildDarwinArgs("Bob's", "hi", false);
    assert.ok(script.includes('"Bob\'s"'));
  });
});

describe("buildNotifySendArgs", () => {
  it("uses -a Pi and passes title then message", () => {
    assert.deepEqual(buildNotifySendArgs("pi", "done", false), ["-a", "Pi", "pi", "done"]);
  });
  it("ignores sound (no portable flag)", () => {
    assert.deepEqual(buildNotifySendArgs("pi", "done", true), ["-a", "Pi", "pi", "done"]);
  });
});

describe("notify", () => {
  it("darwin: resolves via osascript when spawnFn succeeds", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const r = await notify({
      title: "pi",
      message: "done",
      sound: true,
      platform: "darwin",
      spawnFn: async (cmd, args) => {
        calls.push({ cmd, args });
      },
    });
    assert.deepEqual(r, { ok: true, via: "osascript" });
    assert.deepEqual(calls, [{ cmd: "osascript", args: buildDarwinArgs("pi", "done", true) }]);
  });

  it("darwin: falls back to bell when spawnFn errors, note carries the failure", async () => {
    const r = await notify({
      message: "done",
      platform: "darwin",
      spawnFn: async () => {
        throw new Error("osascript: not allowed");
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.via, "bell");
    assert.match(r.note ?? "", /osascript: not allowed/);
  });

  it("linux: probe miss → bell fallback with note", async () => {
    const r = await notify({
      message: "done",
      platform: "linux",
      probeFn: () => false,
      spawnFn: async () => {
        throw new Error("fakeGh: must not spawn when the probe misses");
      },
    });
    assert.deepEqual(r, { ok: true, via: "bell", note: "notify-send not found on PATH — rang the terminal bell instead" });
  });

  it("linux: probe hit → notify-send path", async () => {
    const calls: string[][] = [];
    const r = await notify({
      title: "pi",
      message: "done",
      platform: "linux",
      probeFn: () => true,
      spawnFn: async (_cmd, args) => {
        calls.push(args);
      },
    });
    assert.deepEqual(r, { ok: true, via: "notify-send" });
    assert.deepEqual(calls, [buildNotifySendArgs("pi", "done", false)]);
  });
});
