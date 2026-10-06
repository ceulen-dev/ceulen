# vendor/pdfjs — pdf.js (pdfjs-dist) legacy build

`pdf.min.mjs` is the **unmodified** minified legacy ESM build from the npm
package `pdfjs-dist@4.10.38` (Apache-2.0; see `LICENSE`). Vendored per the
bundle's no-runtime-dependency rule (the vendor/axe precedent) so `read_pdf`
can extract PDF text locally without a poppler/pdftotext install — the CDP
viewer path renders blank in headless Chrome and `--virtual-time-budget`
hangs (live-probed 2026-10-06), so an in-process text engine is the only
reliable route.

- Source: https://github.com/mozilla/pdf.js (npm: pdfjs-dist)
- Pinned: 4.10.38, `legacy/build/pdf.min.mjs`
- Loaded LAZY (`fs.readFileSync` at first read_pdf call) — never on the
  entry import graph, same contract as vendor/axe.
- Runs WORKERLESS (no `pdf.worker` import; the legacy build degrades to
  in-thread parsing when no worker is wired — verified against a real PDF).
