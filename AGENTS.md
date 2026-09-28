# AGENTS.md — ceulen

Agent-facing guide to this repo.

## What ceulen is

One **Pi bundle extension** (npm: `ceulen`): a single install that consolidates the pi-extensions fleet into modules loaded by one entry, each kill-switchable via the `ceulen.disabled` settings key. Users install with `pi install npm:ceulen` — never `npm install -g`. Every module registers only through Pi's public extension API (peer dep `@earendil-works/pi-coding-agent >=0.80.8 <0.88.0`), so upstream Pi upgrades stay drop-in.

## Layout

```
extensions/
  index.ts               bundle entry: MODULES registry, kill-switch, /ceulen command
  lib/                   vendored shared code (panel.ts — config-panel kernel)
  modules/<name>/        one directory per module (self-contained: index.ts, lib/, commands/, test/)
skills/                  skill directories shipped with the package (contributed via the ponytail
                         module's resources_discover handler — gated by its kill-switch)
```

## Module convention

- A module default-exports a factory `(pi: ExtensionAPI) => void`; it registers commands/tools/handlers and returns. Public extension API only.
- No external runtime dependencies — vendor shared code under `extensions/lib/` (with a `// ponytail: vendored from <pkg> <version>` header) rather than adding `dependencies`.
- Tests: `node:test` + tsx, in `extensions/modules/<name>/test/`. The bundle root `package.json` `test` script globs them. Test dirs are excluded from `tsc --noEmit` when they use loose harness stubs (sub, ponytail); they run under tsx.
- To add a module: copy its directory into `extensions/modules/<name>/`, fix its imports (panel → `../../../lib/panel.js`), append one entry to `MODULES` in `extensions/index.ts` (order matters — sub reads the `router` provider, so router loads first), add its test files to the `test` glob if not covered.

## Commands

- `npm install` — set up (dev deps only: tsx, typescript, @types/node, pi peer packages)
- `npm run typecheck` — `tsc --noEmit` over `extensions/**` (sub tests excluded: upstream pi-sub doesn't typecheck its tests; they run under tsx)
- `npm test` — router unit suite + 5 sub suites + 3 ponytail suites (node --test via tsx)
- `npm pack --dry-run` — verify the shipped file list (extensions/, skills/, README, LICENSE, CHANGELOG; no docs/)

## Settings / kill-switch

`ceulen.disabled: string[]` in `~/.pi/agent/settings.json`, or `.pi/settings.json` in a **trusted** project (trust is read from `<agentDir>/trust.json`, walking up like pi; untrusted repos can't toggle modules). Note: Pi's SDK `ExtensionAPI` has no `getSetting` — `extensions/index.ts` reads settings.json directly.

## Yardmaster usage contract (sub module)

With `router.baseUrl` set to a yardmaster instance, sub polls `GET <baseUrl>/usage?provider=<prefix>` (Bearer = the router API key), falling back to aggregate `GET /usage` on per-provider 404, and to OmniRoute `GET <origin>/api/usage/om-usage` when no JSON usage endpoint exists. Response shape: `{windows: {session|weekly|monthly: {remaining_pct, reset_at}}, credits: {currency, balance}}`. The key needs yardmaster's usage permission. Renderer + parser live in `extensions/modules/sub/index.ts` (`parseGenericUsage`).

## Ponytail config (ponytail module)

Ponytail resolves its default mode from `PONYTAIL_DEFAULT_MODE`, then `~/.config/ponytail/config.json` (`{"defaultMode": "full", "quietStartup": false, "hideStatus": false}`; XDG_CONFIG_HOME respected), then `full`. `PONYTAIL_HIDE_STATUS`, `PONYTAIL_QUIET_STARTUP`, `PONYTAIL_SUBAGENT_SCOPE=off` override the config booleans. Config surface is deliberately NOT namespaced to `ceulen.*` — existing pi-ponytail users keep their config.

## Release flow

Bump `version` in `package.json` → git tag → push; the GitHub release triggers `publish.yml` (npm publish, provenance on). CI (`ci.yml`) runs typecheck + tests on every push/PR.
