/**
 * Unit tests for the local Chrome capture engine (lib/chrome.ts).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildPdfArgs,
  buildScreenshotArgs,
  capturePdf,
  captureScreenshot,
  findChromeBinary,
  isLocalUrl,
  isSsrfBlocked,
  resolveEngine,
} from "../lib/chrome";

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

describe("isLocalUrl", () => {
  const local = [
    "http://localhost:3000",
    "http://localhost",
    "https://app.localhost:5173",
    "http://127.0.0.1:8080",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.50:4200",
    "http://169.254.1.1/",
    "http://0.0.0.0/",
    "http://[::1]:8080",
    "http://[fd00::1]:3000",
    "http://[fe80::1]:3000",
    "http://[::ffff:127.0.0.1]:8080",
    "http://[::ffff:7f00:1]:8080", // hex form — WHATWG URL canonicalization shape
    "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:10.0.0.5]/",
    "http://100.64.0.1/", // 100.64/10 CGNAT
    "http://100.127.255.254/", // 100.64/10 upper edge
    "http://198.18.0.1/", // 198.18/15 benchmarking
    "http://198.19.255.254/", // 198.18/15 upper edge
    "http://192.0.0.1/", // 192.0.0/24 IETF protocol assignments
    "http://[fec0::1]/", // decommissioned IPv6 site-local
    "file:///Users/me/project/index.html",
  ];
  for (const url of local) {
    it(`local: ${url}`, () => {
      assert.equal(isLocalUrl(url), true);
    });
  }

  const remote = [
    "https://example.com",
    "http://8.8.8.8/",
    "http://172.32.0.1/",
    "http://192.169.1.1/",
    "http://[2001:db8::1]/",
    "http://100.128.0.1/", // just above 100.64/10
    "http://198.20.0.1/", // just above 198.18/15
    "http://192.0.1.1/", // just above 192.0.0/24
    "https://developer.chrome.com/blog",
    "not a url",
  ];
  for (const url of remote) {
    it(`remote: ${url}`, () => {
      assert.equal(isLocalUrl(url), false);
    });
  }
});

describe("resolveEngine", () => {
  it("auto routes localhost to local", () => {
    assert.equal(resolveEngine("auto", "http://localhost:3000"), "local");
    assert.equal(resolveEngine(undefined, "http://127.0.0.1:8080"), "local");
    assert.equal(resolveEngine(undefined, "file:///tmp/x.html"), "local");
  });

  it("auto routes public URLs to daemon", () => {
    assert.equal(resolveEngine("auto", "https://example.com"), "daemon");
    assert.equal(resolveEngine(undefined, "https://example.com"), "daemon");
  });

  it("explicit engine wins over URL class", () => {
    assert.equal(resolveEngine("local", "https://example.com"), "local");
    assert.equal(resolveEngine("daemon", "http://localhost:3000"), "daemon");
  });
});

describe("isSsrfBlocked", () => {
  it("matches daemon SSRF rejections", () => {
    assert.equal(isSsrfBlocked(new Error("URL blocked (SSRF protection)")), true);
    assert.equal(isSsrfBlocked(new Error("request failed: SSRF protection triggered")), true);
    assert.equal(isSsrfBlocked(new Error("connection refused")), false);
    assert.equal(isSsrfBlocked("URL blocked by policy"), true);
  });
});

describe("buildScreenshotArgs", () => {
  const base = {
    chromePath: "/usr/bin/chrome",
    outPath: "/tmp/out.png",
    userDataDir: "/tmp/profile",
    url: "http://localhost:3000",
    width: 1280,
    height: 800,
  };

  it("builds headless screenshot command with defaults", () => {
    const args = buildScreenshotArgs(base);
    assert.equal(args[0], "/usr/bin/chrome");
    assert.ok(includes(args, "--headless"));
    assert.ok(includes(args, "--window-size=1280,800"));
    assert.ok(includes(args, "--screenshot=/tmp/out.png"));
    assert.ok(includes(args, "--user-data-dir=/tmp/profile"));
    assert.equal(args[args.length - 1], "http://localhost:3000");
    assert.ok(!includes(args.join(" "), "virtual-time-budget"));
  });

  it("fullPage uses the tall-window ceiling", () => {
    const args = buildScreenshotArgs({ ...base, fullPage: true });
    assert.ok(includes(args, "--window-size=1280,8000"));
  });

  it("waitForSec maps to virtual-time-budget", () => {
    const args = buildScreenshotArgs({ ...base, waitForSec: 2.5 });
    assert.ok(includes(args, "--virtual-time-budget=2500"));
  });

  it("reducedMotion forces the prefers-reduced-motion flag", () => {
    assert.ok(!includes(buildScreenshotArgs({ ...base }), "--force-prefers-reduced-motion"));
    assert.ok(includes(buildScreenshotArgs({ ...base, reducedMotion: true }), "--force-prefers-reduced-motion"));
  });
});

describe("buildPdfArgs", () => {
  it("builds print-to-pdf command without headers", () => {
    const args = buildPdfArgs({
      chromePath: "/usr/bin/chrome",
      outPath: "/tmp/out.pdf",
      userDataDir: "/tmp/profile",
      url: "http://localhost:3000",
    });
    assert.ok(includes(args, "--print-to-pdf=/tmp/out.pdf"));
    assert.ok(includes(args, "--no-pdf-header-footer"));
    assert.ok(!includes(args, "--force-prefers-reduced-motion"));
    assert.equal(args[args.length - 1], "http://localhost:3000");
  });

  it("reducedMotion forces the prefers-reduced-motion flag", () => {
    const args = buildPdfArgs({
      chromePath: "/usr/bin/chrome",
      outPath: "/tmp/out.pdf",
      userDataDir: "/tmp/profile",
      url: "http://localhost:3000",
      reducedMotion: true,
    });
    assert.ok(includes(args, "--force-prefers-reduced-motion"));
  });
});

describe("findChromeBinary", () => {
  it("prefers CHROME_PATH when it exists", () => {
    const fake = process.argv[0]; // some path that definitely exists
    process.env.CHROME_PATH = fake;
    try {
      assert.equal(findChromeBinary(), fake);
    } finally {
      delete process.env.CHROME_PATH;
    }
  });

  it("falls through when CHROME_PATH does not exist", () => {
    process.env.CHROME_PATH = "/nonexistent/chrome-binary-xyz";
    try {
      // On a dev machine with Chrome installed this finds the real binary;
      // in CI it returns null. Either way it must not return the bad path.
      const found = findChromeBinary();
      assert.notEqual(found, "/nonexistent/chrome-binary-xyz");
    } finally {
      delete process.env.CHROME_PATH;
    }
  });

  it("returns a string or null", () => {
    const found = findChromeBinary();
    assert.equal(found === null || typeof found === "string", true);
  });
});

describe("capture URL trust boundary", () => {
  it("rejects switch-like URLs before any spawn", async () => {
    try {
      await captureScreenshot({ url: "--proxy-server=http://evil", timeoutMs: 500 });
      assert.fail("should have thrown");
    } catch (err: any) {
      assert.ok(includes(err.message, "Invalid capture URL"));
      assert.ok(!includes(err.message, "Chrome"));
    }
  });

  it("rejects non-http/file schemes for PDF too", async () => {
    try {
      await capturePdf({ url: "chrome://settings", timeoutMs: 500 });
      assert.fail("should have thrown");
    } catch (err: any) {
      assert.ok(includes(err.message, "Invalid capture URL"));
    }
  });
});

describe("runChrome via stub binary", () => {
  const PAYLOAD = "FAKEPNGDATA";
  let dir: string;

  const writeStub = (body: string): string => {
    const p = path.join(dir, `stub-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };

  // Stub contract: writes the --screenshot= target, then (optionally) hangs.
  const writeAndMaybeHang = (hang: boolean): string =>
    writeStub(
      `for a in "$@"; do case "$a" in --screenshot=*) out="\${a#--screenshot=}" ;; esac; done\n` +
      `printf '${PAYLOAD}' > "$out"\n` +
      (hang ? "sleep 30\n" : ""),
    );

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-web-chrome-test-"));
  });

  afterEach(() => {
    delete process.env.CHROME_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves via the file-stability poll even when the binary never exits", async () => {
    process.env.CHROME_PATH = writeAndMaybeHang(true); // writes, then sleeps forever
    const cap = await captureScreenshot({ url: "http://localhost:9/x", timeoutMs: 10_000 });
    assert.equal(cap.base64, Buffer.from(PAYLOAD).toString("base64"));
  });

  it("rejects on timeout when no output file appears", async () => {
    process.env.CHROME_PATH = writeStub("sleep 30"); // never writes
    try {
      await captureScreenshot({ url: "http://localhost:9/x", timeoutMs: 700 });
      assert.fail("should have timed out");
    } catch (err: any) {
      assert.ok(includes(err.message, "timed out"));
    }
  });

  it("bounds the captured stderr to a ~1KB tail even after megabytes of noise (F7)", async () => {
    // The stub floods STDERR (~15MB, 25000 × 600B lines), then exits 1 without
    // writing the output file → the close handler builds the error message
    // from the retained tail.
    process.env.CHROME_PATH = writeStub(
      `echo "ERROR-TAIL-MARKER: chrome exploded" >&2\n` +
        `i=0\nwhile [ $i -lt 25000 ]; do\n` +
        `  echo 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' >&2\n` +
        `  i=$((i+1))\ndone\nexit 1\n`,
    );
    try {
      await captureScreenshot({ url: "http://localhost:9/x", timeoutMs: 10_000 });
      assert.fail("should have failed (no output file)");
    } catch (err: any) {
      assert.ok(includes(err.message, "Chrome exited with code 1"));
      // Retained stderr (message after the code prefix) is bounded, and the
      // newest bytes survived the clipping (tail, not head).
      const tail = String(err.message).split("Chrome exited with code 1: ")[1] ?? "";
      assert.ok(tail.length <= 1024, `stderr tail ${tail.length}B must be ≤ 1KB`);
      assert.ok(tail.includes("xxxx"), "newest stderr bytes retained");
    }
  });
});
