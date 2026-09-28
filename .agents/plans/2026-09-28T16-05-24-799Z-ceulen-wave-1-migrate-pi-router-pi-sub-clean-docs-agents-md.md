# ceulen wave 1: migrate pi-router + pi-sub, clean docs, AGENTS.md, pi-install-first

## Goal

Bring the first two production modules into the ceulen bundle:

- **router module** (from `pi-router`) — registers the generic `router` provider for any OpenAI-compatible router (`GET /v1/models` + `/v1/chat/completions`), commands `/router-status`, `/router-config`, `/router-reasoning`, `/router-model`.
- **sub module** (from `pi-sub`) — subscription-usage footer + `/sub` + `/context`; includes the **Yardmaster usage display** (`GET <router.baseUrl>/usage?provider=<prefix>`, OmniRoute om-usage fallback) — this satisfies the "display usage from our LLM proxy Yardmaster" requirement.

Plus housekeeping: delete the `docs/` research record, rewrite `README.md` around `pi install npm:ceulen` (never `npm install -g`), create `AGENTS.md`, wire real CI.

## Assumptions

- Target runtime is Pi (`@earendil-works/pi-coding-agent`), not omp — current session model.
- Command names keep their existing surface (`/router-*`, `/sub`) for muscle memory; the bundle-level command stays `/ceulen`.
- `pi install npm:ceulen` resolves npm dependencies, so zero external runtime deps is achievable by vendoring.

## Key findings (verified)

- `pi-router` v1.2.3: `extensions/index.ts` (75) + `lib/{client 390, config 113, migrate 92, provider 138, refresh 19}` + `commands/commands.ts` (260) + `test/unit.test.ts`. Depends on `@bacnh85/pi-config-panel` (single-file kernel, `extensions/lib/panel.ts`, 728 lines, only real export surface `openConfigPanel`/`row`/helpers). **User decision: vendor panel.ts into the bundle** → ceulen ships with no external runtime deps.
- `pi-sub` v0.1.52: single `extensions/index.ts` (1,998) + 5 node:test files. Imports only `@earendil-works/pi-coding-agent` + node stdlib. Yardmaster integration already inside (lines ~477, ~701–747: `GET <baseUrl>/usage?provider=<prefix>` JSON → windows + credits; OmniRoute `om-usage` fallback).
- `pi-sub` reads its own `../package.json` for the User-Agent version → path must be fixed to the bundle root (`../../../package.json` from `extensions/modules/sub/index.ts`).
- Tests are all `node:test` + tsx — same runner the bundle can use; no mocha except pi-config-panel's own test (skipped, see below).
- `pi install npm:<pkg>` is the documented Pi package install path (docs/packages.md); current ceulen README wrongly says `npm install -g ceulen`.
- ceulen today: scaffold `extensions/index.js` with a MODULES registry + `/ceulen` stub; `package.json` `files` lists CHANGELOG.md (doesn't exist); CI `npm test` is `continue-on-error`; `.gitignore` only covers `.env.local`; no tsconfig.
- Research docs (`docs/01..08`) are fully captured in Munin (`architecture/*` keys) and git history — safe to delete.

## Implementation steps

### 1. Delete research docs
`git rm -r docs/` (8 files). Remove the "Design record: docs/" line from README (handled in step 5).

### 2. Migrate router module
Copy into `extensions/modules/router/`:
- `index.ts`, `lib/{client,config,migrate,provider,refresh}.ts`, `commands/commands.ts`, `test/unit.test.ts`
- Skip: `scripts/probe-vision.mjs`, `test/live-refresh-e2e.ts`, `test/live-validation.ts` (live/manual harnesses — retrievable from pi-extensions git history if ever needed).
Fix-ups:
- `commands.ts`: `import … from "@bacnh85/pi-config-panel"` → `../../lib/panel.js`.
- No other path-relative package reads expected; grep `new URL(` across copied files to confirm.

### 3. Vendor config-panel kernel
Copy `pi-config-panel/extensions/lib/panel.ts` → `extensions/lib/panel.ts` verbatim (adjust only its imports if any). Do **not** port its mocha test — the router unit suite + manual panel check in verification cover it.
`// ponytail: vendored from @bacnh85/pi-config-panel <version>; fixed snapshot, re-vendor on upstream fixes.` header comment.

### 4. Migrate sub module
Copy into `extensions/modules/sub/`: `index.ts` + `test/{context,parsers,stale-ctx-regression,zai-anthropic-adapter,opencode-go-usage}.test.ts`.
Fix-ups:
- Version read: `new URL("../package.json", import.meta.url)` → `"../../../package.json"` (bundle root).
- Keep STATUS_KEY / message types / command names as-is.

### 5. Wire the bundle entry + kill-switches
Rewrite `extensions/index.js` → `extensions/index.ts`:
- Static imports of both module defaults; MODULES registry: `[ { name: "router", load: routerModule }, { name: "sub", load: subModule } ]` (router registered before sub — sub reads the `router` provider).
- Kill-switch: `pi.getSetting("ceulen")?.disabled` (array of module names) → skipped modules. This is the bundle's per-module kill-switch promise, minimal form.
- `/ceulen` stub lists active/disabled module names (no config UI yet).
- `package.json`: drop `main`; add `scripts`: `test` = `node --import tsx --test extensions/modules/router/test/unit.test.ts extensions/modules/sub/test/*.test.ts`, `typecheck` = `tsc --noEmit`; `peerDependencies`: `"@earendil-works/pi-coding-agent": ">=0.80.8 <0.88.0"` (pi-sub's verified range); `devDependencies`: tsx, typescript, @types/node; **no `dependencies`** (vendored panel); version → 0.2.0; add root `tsconfig.json` (base: pi-router's).

### 6. Rewrite README.md
- Install: `pi install npm:ceulen` (mention `pi update --extensions` for updates; `-l` for project scope). No npm-install path.
- Modules table: router (what it registers, config: `router.baseUrl` in settings.json / `ROUTER_BASE_URL`, key via `/login router` / `ROUTER_API_KEY`) and sub (footer, `/sub`, `/context`).
- **Yardmaster section**: footer shows usage via `GET <router.baseUrl>/usage?provider=<prefix>`; needs a yardmaster API key with the usage permission ("usage api → allowed"); OmniRoute fallback behavior; example footer line.
- Kill-switch snippet: `"ceulen": { "disabled": ["sub"] }` in settings.json.
- Roadmap line for later waves (one line, no docs/ link).

### 7. Create AGENTS.md
Agent-facing repo doc (~60 lines): what ceulen is + the one user install command; repo layout (`extensions/index.ts` entry, `extensions/modules/<name>/`, `extensions/lib/` vendored shared code); module convention (default-export factory `(pi) => void`, public extension API only, no external runtime deps, node:test + tsx); how to add a module (copy dir, append to MODULES); commands (`npm test`, `npm run typecheck`); release flow (bump version → git tag → `publish.yml` publishes to npm, provenance on); Yardmaster usage contract summary for debugging.

### 8. Housekeeping
- `.gitignore`: add `node_modules/`.
- `CHANGELOG.md`: create minimal (0.2.0 — router + sub merged, panel vendored; 0.1.0 — name reservation).
- `.github/workflows/ci.yml`: remove `continue-on-error` placeholder; run `npm run typecheck && npm test`.

## Verification plan

1. `npm install && npm run typecheck && npm test` — ported suites green (router unit + 5 sub suites).
2. Load check: `pi -e ./` in a scratch dir → `/router-status`, `/router-config` (panel renders), `/router-reasoning`, `/router-model`, `/sub`, `/ceulen` all respond.
3. **Yardmaster e2e** (user's instance): set `router.baseUrl` → `/login router` with a usage-permitted key → select a routed model → footer shows `Router · <prefix> R:..%/.. W:..% …` and `/sub` detail matches yardmaster's numbers. Credit upstream (e.g. deepseek) shows `M:$X.XX`.
4. Kill-switch: `"ceulen": {"disabled": ["sub"]}` → no footer, router still active; remove → restored.
5. `npm pack --dry-run` — ships `extensions/`, README, LICENSE, CHANGELOG; no docs/; `pi install npm:./` smoke-load.

## Risks / notes

- **Vendored panel drift**: fixed snapshot of pi-config-panel; upstream fixes require re-vendoring. Accepted by decision.
- pi-sub peer range pins the bundle to pi `>=0.80.8 <0.88.0` — honest, matches the verified surface.
- Renaming entry to `.ts` matches every migrated file and pi's loader; `pi.extensions: ["./extensions"]` discovery is unchanged.
- Rejected: keeping pi-config-panel as an npm dependency (user chose vendoring); porting mocha panel tests (no runner added for one file); porting live/e2e manual scripts (not CI-runnable).
