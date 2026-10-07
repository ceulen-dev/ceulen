// read_pdf — local PDF text extraction via the vendored pdf.js build.
//
// ponytail: the plan's CDP-viewer path was live-probed and is DEAD — headless
// Chrome renders file:// PDFs as a blank frame (out-of-process viewer never
// paints) and --virtual-time-budget hangs outright (2026-10-06). The honest
// text-only shape is the vendored pdf.js engine (vendor/pdfjs/README): zero
// deps, zero external binaries, workerless. Page IMAGES are out of scope —
// scanned PDFs come back as "no extractable text" with that explanation.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface PdfPageText {
  page: number;
  lines: string[];
  chars: number;
}

export interface PdfReadResult {
  path: string;
  totalPages: number;
  pages: PdfPageText[];
  /** Pages where text extraction found nothing (scanned/image PDFs). */
  emptyPages: number[];
}

export interface ReadPdfOpts {
  path: string;
  /** 1-based pages to extract, pre-validated by the caller. */
  pages: number[];
  signal?: AbortSignal;
  /** Test seam — swap the vendored engine. */
  engine?: PdfEngine;
}

/** The slice of the pdf.js API the tool uses. */
export interface PdfEngine {
  getDocument(src: { data: Uint8Array; verbosity?: number }): { promise: Promise<PdfDocument> };
}

export interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy?(): Promise<void>;
}

export interface PdfPage {
  getTextContent(): Promise<{ items: Array<{ str?: string; transform?: number[] }> }>;
}

// ── Engine load (lazy — never on the entry import graph, vendor/axe rule) ──

let cachedEngine: PdfEngine | undefined;

export async function loadPdfEngine(): Promise<PdfEngine> {
  if (cachedEngine) return cachedEngine;
  // fileURLToPath(import.meta.url) → lib/pdf.ts; vendor sits at ../vendor.
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../vendor/pdfjs/pdf.min.mjs");
  // Lazily dynamic-import the vendored module by FILE URL so the bundler /
  // typechecker never sees a static dependency.
  // pathToFileURL (not string concat): spaces/`#` in the install path must
  // be %-encoded or the lazy pdf.js import resolves a broken URL.
  const mod = (await import(pathToFileURL(file).href)) as PdfEngine & Record<string, unknown>;
  cachedEngine = mod;
  return mod;
}

/** Test hook: forget the cached engine (module state outlives a test). */
export function resetPdfEngineCache(): void {
  cachedEngine = undefined;
}

// ── Page text ───────────────────────────────────────────────────────────────

/**
 * Reconstruct reading-order lines from pdf.js text items: group by rounded
 * baseline y (desc order — PDF y grows upward), then sort runs by x within a
 * line. Exported for tests.
 */
export function itemsToLines(items: Array<{ str?: string; transform?: number[] }>): string[] {
  const lines = new Map<number, Array<{ x: number; s: string }>>();
  for (const item of items) {
    if (!item.str) continue;
    const t = item.transform;
    if (!t) continue;
    const y = Math.round(t[5]!);
    if (!lines.has(y)) lines.set(y, []);
    lines.get(y)!.push({ x: t[4]!, s: item.str });
  }
  return [...lines.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, parts]) =>
      parts
        .sort((p, q) => p.x - q.x)
        .map((p) => p.s)
        .join(" ")
        .replace(/ +/g, " ")
        .trim(),
    )
    .filter((l) => l.length > 0);
}

/** Extract text for the requested pages. One engine instantiation per call. */
export async function readPdfText(opts: ReadPdfOpts): Promise<PdfReadResult> {
  const engine = opts.engine ?? (await loadPdfEngine());
  const data = new Uint8Array(readFileSync(opts.path));
  // verbosity 0 (ERRORS) silences the benign canvas/DOMMatrix polyfill
  // warnings the legacy build prints on Node (text extraction needs none of
  // them — those gates only matter for page RENDERING, which we don't do).
  const doc = await engine.getDocument({ data, verbosity: 0 }).promise;
  try {
    const pages: PdfPageText[] = [];
    const emptyPages: number[] = [];
    for (const n of opts.pages) {
      if (n < 1 || n > doc.numPages) throw new Error(`page ${n} out of range (1-${doc.numPages})`);
      if (opts.signal?.aborted) throw new Error("read_pdf aborted");
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const lines = itemsToLines(tc.items);
      const chars = lines.reduce((a, l) => a + l.length, 0);
      pages.push({ page: n, lines, chars });
      if (chars === 0) emptyPages.push(n);
    }
    return { path: opts.path, totalPages: doc.numPages, pages, emptyPages };
  } finally {
    await doc.destroy?.().catch(() => {});
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

const MAX_CHARS_PER_PAGE = 16_000;

/** Model-facing text. Exported for tests. */
export function formatPdfText(result: PdfReadResult): string {
  const lines = [`${result.path} — ${result.totalPages} page(s), showing ${result.pages.length}`];
  for (const page of result.pages) {
    lines.push("", `── page ${page.page} ──`);
    let budget = MAX_CHARS_PER_PAGE;
    for (const l of page.lines) {
      if (budget <= 0) {
        lines.push(`[… page ${page.page} truncated at ${MAX_CHARS_PER_PAGE} chars …]`);
        break;
      }
      const slice = l.length > budget ? l.slice(0, budget) : l;
      lines.push(slice);
      budget -= slice.length + 1;
    }
    if (page.chars === 0) lines.push("(no extractable text — likely a scanned/image page)");
  }
  if (result.emptyPages.length > 0) {
    lines.push(`[empty pages: ${result.emptyPages.join(", ")}]`);
  }
  return lines.join("\n");
}

/** Parse a `pages` param: "3" | "1-5" | "2,4,6-8" → 1-based list (cap 10,
 *  caller-enforced). Exported for tests. */
export function parsePagesParam(raw: string | undefined, totalPages: number): number[] {
  if (!raw || !raw.trim()) {
    return Array.from({ length: Math.min(5, totalPages) }, (_, i) => i + 1);
  }
  const out: number[] = [];
  for (const part of raw.split(",")) {
    const p = part.trim();
    const range = /^(\d+)-(\d+)$/.exec(p);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      for (let n = a; n <= b; n++) out.push(n);
    } else if (/^\d+$/.test(p)) {
      out.push(Number(p));
    } else {
      throw new Error(`invalid pages spec "${part}" — use "3", "1-5", or "2,4,6-8"`);
    }
  }
  const unique = [...new Set(out)].filter((n) => n >= 1 && n <= totalPages);
  if (unique.length === 0) throw new Error(`no valid pages in "${raw}" (document has ${totalPages} page(s))`);
  return unique.slice(0, 10);
}
