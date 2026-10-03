/**
 * Unit tests for the CDP interaction engine (lib/cdp.ts).
 *
 * Pure helpers are tested directly; runInteraction runs end-to-end against a
 * fake CDP server over a fake websocket (CHROME_PATH points at a stub that
 * writes DevToolsActivePort and hangs) — no real Chrome, no network.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildPressEvents,
  CdpConnection,
  readDevToolsPortFile,
  runInteraction,
  unwrapEvaluate,
  validateSteps,
  waitForLoad,
  type StepOutcome,
  type WsLike,
} from "../lib/cdp";

// chai-compat helpers (assert-based)
function includes(haystack: unknown, needle: unknown): boolean {
  if (typeof haystack === "string") return haystack.includes(String(needle));
  if (Array.isArray(haystack)) return (haystack as unknown[]).some((v) => {
    if (typeof v === "string" && typeof needle === "string") return v.includes(needle);
    if (v === needle) return true;
    // chai's to.include on an array does DEEP membership for objects.
    if (v && needle && typeof v === "object" && typeof needle === "object") {
      try { assert.deepStrictEqual(v, needle); return true; } catch { return false; }
    }
    return false;
  });
  // chai's to.include on an OBJECT target: needle's properties are a subset.
  if (haystack && typeof haystack === "object" && needle && typeof needle === "object") {
    return deepIncludes(haystack, needle as Record<string, unknown>);
  }
  return false;
}
function lengthOf(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") return v.length;
  if (v && typeof v === "object" && "length" in (v as Record<string, unknown>)) return Number((v as Record<string, unknown>).length);
  if (v && typeof v === "object" && "size" in (v as Record<string, unknown>)) return Number((v as Record<string, unknown>).size);
  throw new Error("lengthOf: value has no length/size");
}
/** Deep "includes" — every own key of `part` must exist on `obj` with a
 *  deep-equal value (chai's to.deep.include for object subjects). */
function deepIncludes(obj: unknown, part: Record<string, unknown>): boolean {
  if (Array.isArray(obj)) return includes(obj, part); // deep membership
  if (typeof obj !== "object" || obj === null) return false;
  return Object.entries(part).every(([k, v]) => {
    try { assert.deepStrictEqual((obj as Record<string, unknown>)[k], v); return true; } catch { return false; }
  });
}

// ── Fake websocket that speaks just enough CDP for the tests ─────────────

class FakeWs implements WsLike {
  sent: Array<Record<string, any>> = [];
  onSend: ((frame: Record<string, any>) => void) | null = null;
  private listeners = new Map<string, Array<(ev?: { data?: unknown }) => void>>();

  addEventListener(type: string, fn: (ev?: { data?: unknown }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(fn);
    // A real websocket emits "open" once connected — fake it immediately.
    if (type === "open") queueMicrotask(() => this.emit("open"));
  }
  removeEventListener(type: string, fn: (ev?: { data?: unknown }) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  send(data: string) {
    const frame = JSON.parse(data);
    this.sent.push(frame);
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
  replyError(id: number, message: string) {
    this.emit("message", { data: JSON.stringify({ id, error: { message } }) });
  }
  event(method: string, params: Record<string, unknown>, sessionId?: string) {
    this.emit("message", { data: JSON.stringify({ method, params, sessionId }) });
  }
}

/** Wire a FakeWs with canned CDP responses for a standard successful run. */
function fakeCdpServer(ws: FakeWs) {
  ws.onSend = (frame) => {
    const { method, id, params } = frame;
    if (method === "Target.createTarget") ws.reply(id, { targetId: "t1" });
    else if (method === "Target.attachToTarget") ws.reply(id, { sessionId: "s1" });
    else if (method === "Page.navigate") {
      ws.reply(id, { frameId: "f1" });
      // Real Chrome fires frameNavigated for the initial main-frame navigation.
      ws.event("Page.frameNavigated", { frame: { url: "http://localhost:3000/" } }, "s1");
      ws.event("Page.loadEventFired", {}, "s1");
    } else if (method === "Runtime.evaluate") {
      const expr = String((params as any)?.expression ?? "");
      if (expr.includes("getBoundingClientRect")) {
        ws.reply(id, { result: { type: "object", value: { x: 100, y: 50 } } });
      } else if (expr.includes("scrollWidth")) {
        ws.reply(id, { result: { type: "string", value: JSON.stringify({ scrollWidth: 390, innerWidth: 390 }) } });
      } else {
        ws.reply(id, { result: { type: "number", value: 2 } });
      }
    } else if (method === "Page.captureScreenshot") {
      ws.reply(id, { data: "UklGRh==" });
    } else {
      ws.reply(id, {});
    }
  };
}

const rejectMsg = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    return String((err as Error).message);
  }
  throw new Error("expected promise to reject");
};

// ── Pure helpers ─────────────────────────────────────────────────────────

describe("readDevToolsPortFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-web-cdp-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("parses port + ws path", () => {
    writeFileSync(path.join(dir, "DevToolsActivePort"), "9222\n/devtools/browser/abc");
    assert.deepEqual(readDevToolsPortFile(dir), { port: 9222, wsPath: "/devtools/browser/abc" });
  });

  it("returns null when the file is missing", () => {
    assert.equal(readDevToolsPortFile(dir), null);
  });

  it("returns null on garbage (file can exist before Chrome fills it)", () => {
    writeFileSync(path.join(dir, "DevToolsActivePort"), "");
    assert.equal(readDevToolsPortFile(dir), null);
    writeFileSync(path.join(dir, "DevToolsActivePort"), "not-a-port\n/x");
    assert.equal(readDevToolsPortFile(dir), null);
  });
});

describe("unwrapEvaluate", () => {
  it("unwraps the nested {result:{result:{value}}} shape", () => {
    assert.equal(unwrapEvaluate({ result: { type: "number", value: 42 } }), 42);
    assert.equal(unwrapEvaluate({ result: { type: "string", value: "copied" } }), "copied");
    assert.equal(unwrapEvaluate({ result: { type: "undefined" } }), undefined);
  });

  it("surfaces exceptionDetails loudly instead of returning undefined", () => {
    let err: any;
    try {
      unwrapEvaluate({
        result: { type: "object" },
        exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: x is not defined" } },
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.ok(includes(String(err.message), "x is not defined"));
  });
});

describe("buildPressEvents", () => {
  it("maps Enter to keyDown(+text)/keyUp with the right virtual key code", () => {
    const { down, up } = buildPressEvents("Enter");
    assert.ok(includes(down, { type: "keyDown", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }));
    assert.ok(includes(up, { type: "keyUp", code: "Enter", windowsVirtualKeyCode: 13 }));
    assert.ok(((up) as any)?.hasOwnProperty?.("text") !== true);
  });

  it("single characters carry their text; special keys use rawKeyDown", () => {
    const a = buildPressEvents("a");
    assert.ok(includes(a.down, { type: "keyDown", text: "a", windowsVirtualKeyCode: 65 }));
    const tab = buildPressEvents("Tab");
    assert.ok(includes(tab.down, { type: "rawKeyDown", windowsVirtualKeyCode: 9 }));
  });

  it("digits map to Digit codes so e.code gates fire", () => {
    const one = buildPressEvents("1");
    assert.ok(includes(one.down, { code: "Digit1", windowsVirtualKeyCode: 49, text: "1" }));
    assert.ok(includes(buildPressEvents("a").down, { code: "KeyA" }));
  });

  it("rejects unknown multi-character keys", () => {
    assert.throws(() => buildPressEvents("CapsLock"), /unsupported key/);
  });

  it('"Space" alias produces identical events to " "', () => {
    assert.deepEqual(buildPressEvents("Space"), buildPressEvents(" "));
  });
});

describe("validateSteps", () => {
  it("accepts well-formed steps", () => {
    validateSteps([
      { click: "#btn" },
      { type: { selector: "#name", text: "hi" } },
      { press: "Enter" },
      { evaluate: "1+1", label: "sum" },
      { wait_for: "#done" },
      { wait_for: 250 },
      { dialog: "accept" },
      { dialog: "dismiss" },
      { screenshot: true },
    ]);
  });

  it("rejects zero or unknown action keys", () => {
    assert.throws(() => validateSteps([{}] as any), /steps\[0\] must have exactly one action key/);
    assert.throws(() => validateSteps([{ scroll: "#a" } as any]), /steps\[0\] must have exactly one action key/);
  });

  it("auto-splits multi-action steps into sequential steps, order preserved", () => {
    const steps = [{ click: "#a", press: "Enter" }] as any[];
    const split = validateSteps(steps);
    assert.strictEqual(split, 1);
    assert.deepStrictEqual(steps, [{ click: "#a" }, { press: "Enter" }]);
    const mixed = [{ click: "#x", screenshot: true, wait_for: "#y" }] as any[];
    assert.strictEqual(validateSteps(mixed), 1);
    assert.deepStrictEqual(mixed, [{ click: "#x" }, { screenshot: true }, { wait_for: "#y" }]);
  });

  it("still rejects multi-action steps that also carry an unknown key", () => {
    assert.throws(() => validateSteps([{ click: "#a", scroll: "#b" } as any]), /steps\[0\] must have exactly one action key/);
  });

  it("rejects malformed payloads", () => {
    assert.throws(() => validateSteps([{ click: 5 } as any]), /selector string/);
    assert.throws(() => validateSteps([{ type: { text: "x" } } as any]), /selector, text/);
    assert.throws(() => validateSteps([{ wait_for: true } as any]), /selector string or a millisecond number/);
    assert.throws(() => validateSteps([{ dialog: "maybe" } as any]), /"accept" or "dismiss"/);
  });
});

describe("CdpConnection over a fake websocket", () => {
  it("matches responses to requests by id and dispatches events to listeners", async () => {
    const ws = new FakeWs();
    const conn = await CdpConnection.connect("ws://fake", () => ws);

    const events: any[] = [];
    conn.on("Page.loadEventFired", (params, sid) => events.push({ params, sid }));

    const p1 = conn.send("Target.createTarget", { url: "about:blank" });
    const p2 = conn.send("Page.navigate", { url: "http://x/" }, "s1");
    ws.reply(1, { targetId: "t1" });
    ws.reply(2, { frameId: "f1" });
    assert.deepEqual(await p1, { targetId: "t1" });
    assert.deepEqual(await p2, { frameId: "f1" });
    assert.ok(includes(ws.sent[0], { method: "Target.createTarget" }));
    assert.ok(deepIncludes(ws.sent[1], { method: "Page.navigate", sessionId: "s1" }));

    ws.event("Page.loadEventFired", { frameId: "f1" }, "s1");
    assert.equal(lengthOf(events), 1);
    assert.equal(events[0].sid, "s1");

    const p3 = conn.send("Runtime.evaluate");
    ws.replyError(3, "Bad params");
    assert.match(String(await rejectMsg(p3)), /Bad params/);

    const p4 = conn.send("Runtime.evaluate");
    ws.close();
    assert.match(String(await rejectMsg(p4)), /closed/);
  });

  it("waitForLoad: orphaned timer rejection is pre-handled (pi-crash regression 2026-09-20)", async () => {
    const ws = new FakeWs();
    const conn = await CdpConnection.connect("ws://fake", () => ws);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    // Deliberately not awaited — simulates Page.navigate rejecting first so the
    // caller skips `await loaded`; the 20ms timer then rejects with no consumer.
    const loaded = waitForLoad(conn, "s1", 20);
    try {
      await new Promise((r) => setTimeout(r, 60));
      assert.deepEqual(unhandled, []); // unpatched: contains the timeout Error
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    // Normal path intact: awaiting still throws (timeout still surfaces).
    assert.match(String(await rejectMsg(loaded)), /Navigation timed out after 0\.02s/);
  });
});

// ── runInteraction end-to-end against the fake CDP server ────────────────

describe("runInteraction (fake CDP server)", () => {
  let dir: string;
  let originalChromePath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-web-cdp-run-"));
    originalChromePath = process.env.CHROME_PATH;
    // Stub Chrome: publish DevToolsActivePort into the profile dir, then hang.
    const stub = path.join(dir, "stub-chrome.sh");
    writeFileSync(
      stub,
      `#!/bin/sh\nfor a in "$@"; do case "$a" in --user-data-dir=*) prof="\${a#--user-data-dir=}" ;; esac; done\n` +
        `mkdir -p "$prof"\nprintf '9222\\n/devtools/browser/fake' > "$prof/DevToolsActivePort"\nsleep 30\n`,
    );
    chmodSync(stub, 0o755);
    process.env.CHROME_PATH = stub;
  });

  afterEach(() => {
    if (originalChromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = originalChromePath;
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the full lifecycle: launch, emulate, navigate, click, evaluate, probe, screenshot", async () => {
    const ws = new FakeWs();
    fakeCdpServer(ws);
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [{ click: "#btn" }, { evaluate: "1+1", label: "sum" }],
      viewport: { width: 390, height: 844 },
      reducedMotion: true,
      grant: ["clipboard-read"],
      wsFactory: () => ws,
    });

    assert.deepEqual(result.outcomes.map((o) => o.ok), [true, true]);
    assert.equal(result.outcomes[1].value, 2);
    assert.equal(result.screenshot, "UklGRh==");
    assert.deepEqual(result.probe, { scrollWidth: 390, innerWidth: 390 });
    // The initial main-frame navigation must NOT be reported as a step navigation.
    assert.equal(result.navigatedTo, undefined);

    const methods = ws.sent.map((f) => f.method);
    // Emulation before navigation (honest viewport, no entrance-animation blanks)
    assert.ok((methods.indexOf("Emulation.setDeviceMetricsOverride")) < (methods.indexOf("Page.navigate")));
    assert.ok((methods.indexOf("Emulation.setEmulatedMedia")) < (methods.indexOf("Page.navigate")));
    assert.ok(includes(ws.sent.find((f) => f.method === "Emulation.setDeviceMetricsOverride")?.params, {
      width: 390,
      height: 844,
    }));
    // Trusted click at the element center over the page session
    const pressed = ws.sent.filter((f) => f.method === "Input.dispatchMouseEvent");
    assert.deepEqual(pressed.map((f) => f.params.type), ["mousePressed", "mouseReleased"]);
    assert.ok(includes(pressed[0].params, { x: 100, y: 50, button: "left" }));
    assert.equal(pressed[0].sessionId, "s1");
    // Permissions granted at browser level (no sessionId), aliased to CDP names
    assert.deepEqual(ws.sent.find((f) => f.method === "Browser.grantPermissions")?.params, {
      permissions: ["clipboardReadWrite"],
    });
    // No screenshot step → exactly one automatic final capture
    assert.equal(lengthOf(ws.sent.filter((f) => f.method === "Page.captureScreenshot")), 1);
  });

  it("resolves with outcomes + screenshot intact and an empty probe when the probe evaluate fails", async () => {
    const ws = new FakeWs();
    fakeCdpServer(ws);
    const realOnSend = ws.onSend!;
    ws.onSend = (frame) => {
      // Probe evaluate (identified by its scrollWidth expression) throws.
      if (frame.method === "Runtime.evaluate" && String(frame.params?.expression ?? "").includes("scrollWidth")) {
        return ws.reply(frame.id, {
          result: { type: "object" },
          exceptionDetails: { text: "Uncaught", exception: { description: "Error: target crashed" } },
        });
      }
      realOnSend(frame);
    };
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [{ evaluate: "1+1" }],
      wsFactory: () => ws,
    });
    assert.deepEqual(result.outcomes.map((o) => o.ok), [true]);
    assert.equal(result.screenshot, "UklGRh==");
    assert.deepEqual(result.probe, {});
  });

  it("fails a click on a hidden (zero-size) element instead of clicking at (0,0)", async () => {
    const ws = new FakeWs();
    ws.onSend = (frame) => {
      const { method, id, params } = frame;
      if (method === "Target.createTarget") return ws.reply(id, { targetId: "t1" });
      if (method === "Target.attachToTarget") return ws.reply(id, { sessionId: "s1" });
      if (method === "Page.navigate") {
        ws.reply(id, {});
        ws.event("Page.loadEventFired", {}, "s1");
        return;
      }
      if (method === "Runtime.evaluate" && String(params?.expression ?? "").includes("getBoundingClientRect")) {
        // The visibility-check expression turns a 0x0 rect into the sentinel.
        return ws.reply(id, { result: { type: "object", value: { hidden: true } } });
      }
      ws.reply(id, {});
    };
    const result = await runInteraction({ url: "http://localhost:3000/", steps: [{ click: "#hidden" }], wsFactory: () => ws });
    assert.equal(result.outcomes[0].ok, false);
    assert.match(String(result.outcomes[0].error), /not visible/);
    assert.equal(lengthOf(ws.sent.filter((f) => f.method === "Input.dispatchMouseEvent")), 0);
  });

  it("treats {screenshot:false} as a declined capture (dropped; auto-final still runs)", async () => {
    const ws = new FakeWs();
    fakeCdpServer(ws);
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [{ screenshot: false } as any],
      wsFactory: () => ws,
    });
    assert.equal(lengthOf(result.outcomes), 0);
    assert.equal(result.screenshot, "UklGRh==");
    assert.equal(lengthOf(ws.sent.filter((f) => f.method === "Page.captureScreenshot")), 1);
  });

  it("distinguishes a missing element from a non-focusable one on type steps", async () => {
    const run = async (evalValue: unknown): Promise<StepOutcome> => {
      const ws = new FakeWs();
      ws.onSend = (frame) => {
        const { method, id, params } = frame;
        if (method === "Target.createTarget") return ws.reply(id, { targetId: "t1" });
        if (method === "Target.attachToTarget") return ws.reply(id, { sessionId: "s1" });
        if (method === "Page.navigate") {
          ws.reply(id, {});
          ws.event("Page.loadEventFired", {}, "s1");
          return;
        }
        if (method === "Runtime.evaluate" && String(params?.expression ?? "").includes("focus")) {
          return ws.reply(id, { result: { type: "object", value: evalValue } });
        }
        ws.reply(id, {});
      };
      const r = await runInteraction({ url: "http://localhost:3000/", steps: [{ type: { selector: "#x", text: "hi" } }], wsFactory: () => ws });
      return r.outcomes[0];
    };
    const missing = await run({ missing: true });
    assert.equal(missing.ok, false);
    assert.match(String(missing.error), /no element matches/);
    const notFocusable = await run({ focused: false });
    assert.equal(notFocusable.ok, false);
    assert.match(String(notFocusable.error), /not focusable/);
  });

  it("fails fast on a broken step and says why", async () => {
    const ws = new FakeWs();
    ws.onSend = (frame) => {
      const { method, id, params } = frame;
      if (method === "Target.createTarget") return ws.reply(id, { targetId: "t1" });
      if (method === "Target.attachToTarget") return ws.reply(id, { sessionId: "s1" });
      if (method === "Page.navigate") {
        ws.reply(id, {});
        ws.event("Page.loadEventFired", {}, "s1");
        return;
      }
      if (method === "Runtime.evaluate") {
        // click's rect lookup → element missing
        return ws.reply(id, { result: { type: "object", value: null } });
      }
      ws.reply(id, {});
    };
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [{ click: "#missing" }, { evaluate: "1+1" }],
      wsFactory: () => ws,
    });
    assert.equal(result.outcomes[0].ok, false);
    assert.match(String(result.outcomes[0].error), /no element matches #missing/);
    assert.equal(lengthOf(result.outcomes), 1); // stopped, later steps not run
  });

  it("maps the flattened wait_ms schema field onto wait_for", async () => {
    const ws = new FakeWs();
    fakeCdpServer(ws);
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [{ wait_ms: 10 } as any],
      wsFactory: () => ws,
    });
    assert.deepEqual(result.outcomes.map((o) => o.ok), [true]);
    assert.match(String(result.outcomes[0].label), /wait_for 10/);
  });

  it("aliases friendly permission names to CDP names and annotates mid-step navigation", async () => {
    const ws = new FakeWs();
    ws.onSend = (frame) => {
      const { method, id, params } = frame;
      if (method === "Target.createTarget") return ws.reply(id, { targetId: "t1" });
      if (method === "Target.attachToTarget") return ws.reply(id, { sessionId: "s1" });
      if (method === "Page.navigate") {
        ws.reply(id, {});
        ws.event("Page.loadEventFired", {}, "s1");
        return;
      }
      if (method === "Browser.grantPermissions") {
        // Capture what actually went over the wire, then ack.
        (ws as any).grantReceived = (params as any).permissions;
        return ws.reply(id, {});
      }
      if (method === "Runtime.evaluate" && String(params?.expression ?? "").includes("1+1")) {
        // The step's evaluate triggers a navigation (form-submit style):
        // first an IFRAME navigates (must be ignored), then the main frame.
        ws.event("Page.frameNavigated", { frame: { url: "http://cdn.example.com/ad", parentId: "f-parent" } }, "s1");
        ws.event("Page.frameNavigated", { frame: { url: "http://localhost:3000/submitted" } }, "s1");
      }
      ws.reply(id, {});
    };
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [{ evaluate: "1+1" }],
      grant: ["clipboard-read", "clipboard-write"],
      wsFactory: () => ws,
    });
    assert.deepEqual((ws as any).grantReceived, ["clipboardReadWrite", "clipboardSanitizedWrite"]);
    assert.equal(result.navigatedTo, "http://localhost:3000/submitted"); // not the iframe URL
  });

  it("ignores iframe/subframe navigations entirely (no false ⚠)", async () => {
    const ws = new FakeWs();
    ws.onSend = (frame) => {
      const { method, id, params } = frame;
      if (method === "Target.createTarget") return ws.reply(id, { targetId: "t1" });
      if (method === "Target.attachToTarget") return ws.reply(id, { sessionId: "s1" });
      if (method === "Page.navigate") {
        ws.reply(id, {});
        ws.event("Page.loadEventFired", {}, "s1");
        return;
      }
      if (method === "Runtime.evaluate" && String(params?.expression ?? "").includes("scrollWidth")) {
        // An ad iframe refreshes during the probe — subframe, has parentId.
        ws.event("Page.frameNavigated", { frame: { url: "http://cdn.example.com/ad", parentId: "f-parent" } }, "s1");
      }
      ws.reply(id, {});
    };
    const result = await runInteraction({ url: "http://localhost:3000/", steps: [{ evaluate: "1+1" }], wsFactory: () => ws });
    assert.equal(result.navigatedTo, undefined);
  });

  it("rejects switch-like URLs before launching Chrome", async () => {
    let err: any;
    try {
      await runInteraction({ url: "--remote-debugging-port=9222", wsFactory: () => new FakeWs() });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.ok(includes(String(err.message), "Invalid capture URL"));
  });

  it("auto-dismisses a native confirm() opened by a click and reports it on the step", async () => {
    const ws = new FakeWs();
    ws.onSend = (frame) => {
      const { method, id, params } = frame;
      if (method === "Target.createTarget") return ws.reply(id, { targetId: "t1" });
      if (method === "Target.attachToTarget") return ws.reply(id, { sessionId: "s1" });
      if (method === "Page.navigate") {
        ws.reply(id, {});
        ws.event("Page.loadEventFired", {}, "s1");
        return;
      }
      if (method === "Runtime.evaluate" && String(params?.expression ?? "").includes("getBoundingClientRect")) {
        // The click's rect lookup: element found at (100, 50).
        return ws.reply(id, { result: { type: "object", value: { x: 100, y: 50 } } });
      }
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
        // Real Chrome: the page's onclick called confirm() — renderer blocks until answered.
        ws.event("Page.javascriptDialogOpening", { type: "confirm", message: "Delete this opportunity?" }, "s1");
        return ws.reply(id, {});
      }
      ws.reply(id, {});
    };
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [{ click: "#delete" }, { evaluate: "1+1", label: "after" }],
      wsFactory: () => ws,
    });
    // Safe default: dismissed (destructive stays blocked)…
    const answer = ws.sent.find((f) => f.method === "Page.handleJavaScriptDialog");
    assert.ok(deepIncludes(answer?.params, { accept: false }));
    // …reported on the step and at run level, and the run continued past it.
    assert.deepEqual(result.outcomes[0].dialogs, ['confirm("Delete this opportunity?") → dismissed']);
    assert.deepEqual(result.dialogs, ['confirm("Delete this opportunity?") → dismissed']);
    assert.equal(result.outcomes[1].ok, true);
  });

  it("answers a dialog with the armed {dialog} step and reverts to dismiss after one consumption", async () => {
    const accepts: boolean[] = [];
    const ws = new FakeWs();
    ws.onSend = (frame) => {
      const { method, id, params } = frame;
      if (method === "Target.createTarget") return ws.reply(id, { targetId: "t1" });
      if (method === "Target.attachToTarget") return ws.reply(id, { sessionId: "s1" });
      if (method === "Page.navigate") {
        ws.reply(id, {});
        ws.event("Page.loadEventFired", {}, "s1");
        return;
      }
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
        ws.event("Page.javascriptDialogOpening", { type: "confirm", message: "Delete?" }, "s1");
        return ws.reply(id, {});
      }
      if (method === "Runtime.evaluate" && String(params?.expression ?? "").includes("getBoundingClientRect")) {
        return ws.reply(id, { result: { type: "object", value: { x: 100, y: 50 } } });
      }
      if (method === "Runtime.evaluate" && String(params?.expression ?? "").includes("openAnother")) {
        ws.event("Page.javascriptDialogOpening", { type: "confirm", message: "Again?" }, "s1");
        return ws.reply(id, { result: { type: "number", value: 1 } });
      }
      if (method === "Page.handleJavaScriptDialog") {
        accepts.push(Boolean((params as any).accept));
        return ws.reply(id, {});
      }
      ws.reply(id, {});
    };
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [
        { dialog: "accept" },
        { click: "#delete" },
        { evaluate: "window.openAnother()", label: "second" },
      ] as any,
      wsFactory: () => ws,
    });
    // Armed accept consumed by the first dialog; the second falls back to dismiss.
    assert.deepEqual(accepts, [true, false]);
    assert.equal(result.outcomes[0].label, "dialog accept");
    assert.deepEqual(result.dialogs, ['confirm("Delete?") → accepted', 'confirm("Again?") → dismissed']);
  });

  it("fails a step that exceeds the per-step timeout instead of hanging the run", async () => {
    const ws = new FakeWs();
    let wedged = false;
    ws.onSend = (frame) => {
      const { method, id, params } = frame;
      if (method === "Target.createTarget") return ws.reply(id, { targetId: "t1" });
      if (method === "Target.attachToTarget") return ws.reply(id, { sessionId: "s1" });
      if (method === "Page.navigate") {
        ws.reply(id, {});
        ws.event("Page.loadEventFired", {}, "s1");
        return;
      }
      // Simulate a fully wedged renderer (dialog race / hung evaluate): the
      // blocked step AND every post-loop frame (overflow probe, auto-final
      // screenshot) never answer — runInteraction must still resolve.
      if (method === "Runtime.evaluate" && String(params?.expression ?? "") === "blocked") wedged = true;
      if (wedged && (method === "Runtime.evaluate" || method === "Page.captureScreenshot")) return;
      ws.reply(id, {});
    };
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [{ evaluate: "1+1" }, { evaluate: "blocked" }, { evaluate: "1+2" }],
      stepTimeoutMs: 150,
      wsFactory: () => ws,
    });
    assert.equal(lengthOf(result.outcomes), 2); // stopped at the timed-out step
    assert.equal(result.outcomes[0].ok, true);
    assert.equal(result.outcomes[1].ok, false);
    assert.match(String(result.outcomes[1].error), /timed out after/);
    // Bounded probe + auto-final: the run resolves promptly with outcomes
    // intact, an empty probe, and no PNG (instead of hanging forever).
    assert.deepEqual(result.probe, {});
    assert.equal(result.screenshot, undefined);
  });

  it("expires an unconsumed {dialog} arm at the next step boundary", async () => {
    const accepts: boolean[] = [];
    const ws = new FakeWs();
    ws.onSend = (frame) => {
      const { method, id, params } = frame;
      if (method === "Target.createTarget") return ws.reply(id, { targetId: "t1" });
      if (method === "Target.attachToTarget") return ws.reply(id, { sessionId: "s1" });
      if (method === "Page.navigate") {
        ws.reply(id, {});
        ws.event("Page.loadEventFired", {}, "s1");
        return;
      }
      if (method === "Runtime.evaluate" && String(params?.expression ?? "").includes("openAnother")) {
        // An UNRELATED dialog steps after the armed click never happened —
        // the arm must have expired, so this falls back to dismiss.
        ws.event("Page.javascriptDialogOpening", { type: "beforeunload", message: "Leave?" }, "s1");
        return ws.reply(id, { result: { type: "number", value: 1 } });
      }
      if (method === "Page.handleJavaScriptDialog") {
        accepts.push(Boolean((params as any).accept));
        return ws.reply(id, {});
      }
      ws.reply(id, {});
    };
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [
        { dialog: "accept" },
        { evaluate: "1+1", label: "no dialog here" },
        { evaluate: "window.openAnother()", label: "unrelated dialog" },
      ] as any,
      wsFactory: () => ws,
    });
    assert.deepEqual(accepts, [false]); // NOT accepted
    assert.deepEqual(result.dialogs, ['beforeunload("Leave?") → dismissed']);
  });
});
