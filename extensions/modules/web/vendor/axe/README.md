# vendor/axe — axe-core 4.13.0

`axe.min.js` is the **unmodified** minified UMD build from the npm package
`axe-core@4.13.0` (MPL-2.0; see `LICENSE` and `LICENSE-3RD-PARTY.txt` in this
directory). Vendored per the bundle's no-runtime-dependency rule (the
readability/turndown precedent) so `web_a11y` can inject a real accessibility
audit into a rendered page without adding a dependency.

- Source: https://github.com/dequelabs/axe-core (npm: axe-core)
- Pinned: 4.13.0 (the version oh-my-pi's browser audit ships with)
- Loaded lazily at call time by `lib/a11y.ts` (`fs.readFileSync`, memoized) —
  never on the entry import graph.
- Runtime shape: evaluating the file in a page context defines `window.axe`;
  the runner then calls `axe.run(context, options)`.

Ceiling: one `Runtime.evaluate` audit of the main document — axe walks
same-origin iframes in-page itself; cross-origin frames are not audited
(oh-my-pi's puppeteer frame-walk is not ported). Bump versions by replacing
these files; nothing else changes.
