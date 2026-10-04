# Vendored dependencies — a2a module

Pure-JS upstream packages, vendored (ceulen rule: zero runtime dependencies).
Flat `vendored_deps/` layout — NEVER `node_modules` (npm pack and the repo
.gitignore exclude that name at any depth).

| package | version | source | local deltas |
|---|---|---|---|
| bonjour-service | 1.4.4 | `node_modules/bonjour-service/dist/**` | `dist/lib/mdns-server.js`: 2 bare requires → relative paths |
| multicast-dns | 7.2.5 | `node_modules/multicast-dns/index.js` | `require('dns-packet'/'thunky')` → relative paths |
| dns-packet | 5.4.x | `node_modules/dns-packet/{index.js,lib/*.js}` | `require('@leichtgewicht/ip-codec')` → relative path |
| @leichtgewicht/ip-codec | 2.x | `node_modules/@leichtgewicht/ip-codec/index.cjs` | none |
| fast-deep-equal | 3.1.3 (es6 build) | `node_modules/fast-deep-equal/es6/index.js` | header comment |
| thunky | 1.0.2 | `node_modules/thunky/index.js` | none |

`vendor/package.json` is `{"type":"commonjs"}` — REQUIRED: without it the CJS
vendor files inherit the bundle's `type: module` and `require()` returns an
empty namespace (web-module gotcha).
