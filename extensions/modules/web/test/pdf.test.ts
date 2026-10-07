// read_pdf unit tests — C12 regression: the lazy pdf.js engine import must go
// through pathToFileURL (an unencoded `file://` string breaks on spaces in
// the install path). Verified by loading the vendored engine from a vendor
// directory whose name carries a space — no valid PDF is needed: the import
// resolving at all is the regression, so getDocument is never asserted.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { itemsToLines, parsePagesParam, resetPdfEngineCache, formatPdfText } from "../lib/pdf.js";
import type { PdfEngine } from "../lib/pdf.js";

const dir = mkdtempSync(path.join(tmpdir(), "ceulen-web-pdf-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// The vendored pdfjs (source of truth for the copy).
const vendorPdfjs = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([^/]:)/, "$1")),
  "../vendor/pdfjs",
);

describe("pdf engine load (C12)", () => {
  // A spaced vendor dir: `file://` + raw path would split at the space and
  // fail the dynamic import; pathToFileURL percent-encodes it.
  const spacedVendor = path.join(dir, "vendor space", "vendor", "pdfjs");

  before(() => {
    cpSync(vendorPdfjs, spacedVendor, { recursive: true });
  });

  it("loadPdfEngine resolves from an install path containing a space", async () => {
    // Point the module at the spaced copy: loadPdfEngine derives the vendor
    // path from import.meta.url, so the test re-imports the lib FROM the
    // spaced directory (mirroring the module layout: lib/ beside vendor/).
    const libCopy = path.join(dir, "vendor space", "lib");
    cpSync(path.join(vendorPdfjs, "..", "..", "lib", "pdf.ts"), path.join(libCopy, "pdf.ts"));
    const mod = await import(`file://${encodeURI(libCopy)}/pdf.ts`).catch(() => null);
    assert.ok(mod, "spaced-path lib import resolves");
    const engine: PdfEngine = await mod!.loadPdfEngine();
    assert.ok(engine, "engine resolved through the encoded file URL");
    assert.equal(typeof engine.getDocument, "function");
    // getDocument is deliberately NOT called here — a real PDF is out of
    // scope for this regression; the import resolving IS the fix proof.
    resetPdfEngineCache();
  });
});

describe("pdf formatting helpers", () => {
  it("itemsToLines groups by baseline y, sorts by x, joins runs", () => {
    const lines = itemsToLines([
      { str: "world", transform: [1, 0, 0, 1, 120, 100] },
      { str: "hello", transform: [1, 0, 0, 1, 10, 100] },
      { str: "next", transform: [1, 0, 0, 1, 10, 90] },
      { str: "", transform: [1, 0, 0, 1, 0, 80] },
    ]);
    assert.deepEqual(lines, ["hello world", "next"]);
  });

  it("parsePagesParam: default first 5, ranges, cap 10, out-of-range dropped", () => {
    assert.deepEqual(parsePagesParam(undefined, 12), [1, 2, 3, 4, 5]);
    assert.deepEqual(parsePagesParam("3", 12), [3]);
    assert.deepEqual(parsePagesParam("2,4,6-8", 12), [2, 4, 6, 7, 8]);
    assert.deepEqual(parsePagesParam("1-3", 2), [1, 2], "clamped to the document");
    assert.throws(() => parsePagesParam("abc", 5), /invalid pages spec/);
    assert.throws(() => parsePagesParam("40-50", 5), /no valid pages/);
  });

  it("formatPdfText notes empty pages", () => {
    const out = formatPdfText({
      path: "x.pdf",
      totalPages: 2,
      pages: [
        { page: 1, lines: ["text"], chars: 4 },
        { page: 2, lines: [], chars: 0 },
      ],
      emptyPages: [2],
    });
    assert.match(out, /2 page\(s\), showing 2/);
    assert.match(out, /no extractable text/);
    assert.match(out, /\[empty pages: 2\]/);
  });
});
