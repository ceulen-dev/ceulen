# AGENTS.md — ceulen

Agent-facing guide to this repo.

## What ceulen is

One **Pi bundle extension** (npm: `ceulen`): a single install whose feature modules are loaded by one entry, each kill-switchable via the `ceulen.disabled` settings key. Users install with `pi install npm:ceulen` — never `npm install -g`. Every module registers only through Pi's public extension API (peer dep `@earendil-works/pi-coding-agent >=0.80.8 <0.88.0`), so upstream Pi upgrades stay drop-in.

## Layout

```
extensions/
  index.ts               bundle entry: guarded() conflict guard, kill-switch, /ceulen command, module load loop
  lib/                   shared code (registry.ts — MODULES list + kill-switch settings I/O; panel.ts —
                         config-panel kernel, forked in-repo from @bacnh85/pi-config-panel 0.1.10:
                         split layout + row descriptions/warnings + enum rows + type-to-search;
                         env.ts — trust-gated .env ingestion)
  modules/<name>/        one directory per module (self-contained: index.ts, lib/, commands/, test/)
skills/                  skill directories shipped with the package (contributed via the ponytail
                         module's resources_discover handler — gated by its kill-switch)
```

## Module convention

- A module default-exports a factory `(pi: ExtensionAPI, deps?: ModuleLoadDeps) => void` (deps is rarely used — the config module reads the contribution map); it registers commands/tools/handlers and returns. Public extension API only.
- No external runtime dependencies — vendor shared code under `extensions/lib/` (with a `// ponytail: vendored from <pkg> <version>` header) rather than adding `dependencies`.
- Tests: `node:test` + tsx, in `extensions/modules/<name>/test/`. The bundle root `package.json` `test` script globs them. Test dirs are excluded from `tsc --noEmit` when they use loose harness stubs (usage, ponytail); they run under tsx.
- To add a module: create `extensions/modules/<name>/`, append one entry to `MODULES` in `extensions/lib/registry.ts` (order matters — usage reads the `router` provider, so router loads first; config loads last, it reads the contribution map), add its test files to the `test` glob if not covered. The conflict guard covers you: a name another module already claimed throws at load.

### Conflict rules (all modules share ONE extension object — duplicates silently overwrite without the guard)

- The bundle entry wraps each module's `pi` in `guarded()` (extensions/index.ts, one shared ownership map for the whole load loop): a name claimed by a DIFFERENT module throws at load; same-module re-claims pass (router re-registers its provider at runtime — that's the supported update path). Contract tests: `extensions/modules/router/test/guard.test.ts`.
- Generic slash-command subcommands take the module prefix (`router-status`, not `status`); distinctive bare names are fine (`/usage`, `/context`, `/ponytail`).
- Message/entry-renderer customTypes and status-bar keys take the `ceulen-` prefix (`ceulen-usage-status`).
- Settings keys are namespaced by module (`router.baseUrl`, `ceulen.disabled`); cross-extension names (customTypes, User-Agent) use `ceulen`, never `pi-<module>`.

## Commands

- `npm install` — set up (dev deps only: tsx, typescript, @types/node, pi peer packages)
- `npm run typecheck` — `tsc --noEmit` over `extensions/**` (usage tests excluded: loose harness stubs don't typecheck; they run under tsx)
- `npm test` — router unit + guard suites, usage suites, ponytail suites, config suites (node --test via tsx)
- `npm pack --dry-run` — verify the shipped file list (extensions/, skills/, README, LICENSE, CHANGELOG; no docs/)

## Settings / kill-switch

`ceulen.disabled: string[]` in `~/.pi/agent/settings.json`, or `.pi/settings.json` in a **trusted** project (trust is read from `<agentDir>/trust.json`, walking up like pi; untrusted repos can't toggle modules). `/config` writes to whichever file currently carries the `ceulen` section (see the config-module section) — never a shadowed layer. The deprecated `"sub"` key is still treated as `"usage"`. Note: Pi's SDK `ExtensionAPI` has no `getSetting` — `extensions/lib/registry.ts` reads settings.json directly.

## Yardmaster usage contract (usage module)

With `router.baseUrl` set to a yardmaster instance, the usage module polls `GET <baseUrl>/usage?provider=<prefix>` (Bearer = the router API key), falling back to aggregate `GET /usage` on per-provider 404, and to OmniRoute `GET <origin>/api/usage/om-usage` when no JSON usage endpoint exists. Response shape: `{windows: {session|weekly|monthly: {remaining_pct, reset_at}}, credits: {currency, balance}}`. The key needs yardmaster's usage permission. Renderer + parser live in `extensions/modules/usage/index.ts` (`parseGenericUsage`).

## Ponytail config (ponytail module)

Ponytail resolves its default mode from `PONYTAIL_DEFAULT_MODE`, then `~/.config/ponytail/config.json` (`{"defaultMode": "full", "quietStartup": false, "hideStatus": false}`; XDG_CONFIG_HOME respected), then `full`. `PONYTAIL_HIDE_STATUS`, `PONYTAIL_QUIET_STARTUP`, `PONYTAIL_SUBAGENT_SCOPE=off` override the config booleans. Config surface is deliberately NOT namespaced to `ceulen.*` — the `ponytail.*`/`PONYTAIL_*` names are the module's stable contract.

## Release flow

Bump `version` in `package.json` → git tag → push; the GitHub release triggers `publish.yml` (npm publish, provenance on). CI (`ci.yml`) runs typecheck + tests on every push/PR.

## Central config panel (config module)

The `config` module owns `/config` — a central settings panel rendered from
pi core settings + per-module contributions on top of `extensions/lib/panel.ts`,
categorized under OMP's settings taxonomy: **Appearance · Model · Interaction ·
Context · Files · Shell · Tools · Tasks · Providers · Plugins** (Memory is
omitted — pi exposes no writable memory settings; empty tabs don't render).
`/settings` is a Pi builtin; an extension command with that name is skipped in
autocomplete and renamed (`/settings:1`), never an override — `/config` is
unused by pi core.

Mechanism (registry + loader):

- `extensions/lib/registry.ts` owns `MODULES` (`{ name, load, config? }`);
  `extensions/index.ts` imports it and, for each enabled module, builds a
  `configContribs` map of `() => ModuleConfig` factories — each closing over
  THAT module's *guarded* `pi` (a save that re-registers a provider, e.g.
  router's, stays the owner's claim). The map is passed to every module factory
  as a second arg (`ModuleLoadDeps`); only the config module reads it.
- A contribution is `{ groups: () => PanelGroup[], save(editedKeys, ctx) }`.
  Row keys MUST be prefixed `<module>.` — `save()` receives the set of edited
  keys and no-ops unless one of its own is present.
- Row contract beyond `key/label/kind/value/set` (all optional, `row()` opts):
  `description` (one-liner in the panel's fixed 3-row footer), `warning`
  (caveat rendered warning-styled above the description + a ⚠ glyph on the
  row; reserve for real risk — reload requirements, env precedence), `values`
  (closed set: Enter opens the selection submenu, no free-text editing),
  `menu` (dynamic option provider — themes, models; overrides `values` for the
  submenu and is called LAZILY at open time), `preview` (live-preview hook
  fired per highlighted option while the submenu is open) + `previewCancel`
  (fired once on Esc so the row undoes its live preview — the row owns the
  restore; `set` owns the committed effect),
  `defaultValue` (values differing from it render warning-styled),
  `completions` (inline suggestion picker for comma-separated free text).
  `ModuleEntry.describe` gives the module one-liner used by its kill-switch row.
- Panel layout (v4, fullscreen BOXED frame + OMP's tab → section → rows
  hierarchy):
  the panel opens as a 100%×100% top-left OVERLAY (`ctx.ui.custom` with
  `{ overlay: true, overlayOptions: … }`) and renders a fixed-chrome frame
  exactly `max(14, getHeight())` rows tall — rounded top border with the title
  inset (`╭─ Title ─╮`) → boxed tab row → tee divider (`├──┤`) → boxed body →
  boxed description area → tee divider → boxed pinned key-hint footer →
  rounded bottom border (`╰──╯`); every content row is `│ … │` (OMP's
  overlay-box). `ConfigPanelModel.getHeight` reads `process.stdout.rows`
  (40 fallback; tests inject a constant). The body absorbs the remaining height
  (window budget derives from it — no fixed row cap); `FRAME_ROWS = 7 +
  DESC_ROWS` chrome rows. Adjacent `PanelGroup`s sharing a `tab` key merge into
  ONE tab (the tab chip shows the tab name + first icon); each group's `label`
  renders BOTH as a left-sidebar SECTION entry and as an in-pane underlined
  heading above its rows (OMP renders both). The sidebar width is PINNED across
  every tab (`min(22, longest section label) + 4`) so the `│` rail never jumps
  between tabs; it shows on any tab with sections and hides when the rows pane
  falls below 60 columns (OMP's threshold) — headings remain. Tabs show
  per-tab icons (`PanelGroup.icon`).
  `←/→`/`Tab`/`Shift+Tab` switch tabs (WRAPPING ring, OMP's TabBar) and use
  `matchesKey` from pi-tui — never raw byte compares (SS3 `\u001bOD` and kitty
  CSI-u otherwise break `←`). `PageUp`/`PageDown` jump sections (wrap; with one
  section they page through rows). The ACTIVE tab renders ` icon Label ` in
  `selectedBg`/bold-accent; on overflow, inactive tabs collapse to icon-only
  starting with those FARTHEST from the active one (OMP's TabBar) — the active
  tab keeps its full label. Rows OUTSIDE the active section get a dim wash
  (headings included). Each
  tab remembers its own selection; ↑/↓ is clamped to the tab. Fixed-height
  description area (3 rows: ⚠ warning, then description; hidden while the
  active tab is empty), type-to-search fuzzy filter across ALL tabs (flat
  match list; `←/→` jumps between matching categories; `Esc` clears first,
  snapping the tab to the selected row, a second `Esc` closes). The footer
  hint is PINNED as the frame's last content row and follows the mode
  (browse / filter / prompt / completions-edit / menu), with the dirty marker
  right-aligned on the same line; hints render `key` in accent + meaning in
  dim. The BROWSE hint derives from the active tab's row kinds: `Enter toggle`
  for toggle-only tabs, `Enter choose` when every actionable row is a
  toggle/enum/menu, `Enter change` otherwise, no Enter pair for info-only
  tabs, and no section jump with fewer than 2 sections (OMP's plugins tab
  shows different guidance than its setting tabs for the same reason).
  Row colors (OMP's settings-list theme): selected → accent; changed vs
  `defaultValue` → `warning` (label and value; on a selected+changed row the
  label stays accent, the value warns).
- Selection submenu (OMP's select submenu): Enter on a row with `values` or
  `menu` opens an in-frame option list — the row's label as an accent-bold
  heading, the highlighted option (`›` + text), per-option `description` in
  dim, `(current)` on the row's value, a `Type to search` line (live query
  with match count while typing). ↑/↓ browse (CLAMPED, no wrap), PageUp/Dn
  page, printable text filters option labels/values, ⌫ edits the query, Enter
  commits (the normal set + dirty + editedKeys path), Esc clears the query
  first and backs out on the second press. `preview` fires per highlighted
  option and `previewCancel` once on Esc — never on commit. The menu
  consumes every key while open (tabs can't switch beneath it), and the row
  stays selected so the fixed description area keeps rendering its
  description/warning (OMP keeps the setting context visible). An empty
  `menu()` falls back to the inline editor (string/number rows) or no-ops.
  The panel's own chrome follows a live preview for free: pi's theme object is
  a Proxy over a globalThis slot (`theme.js`), so every `theme.fg()` call reads
  the CURRENT theme — no refresh hook needed, the preview's `requestRender()`
  repaints with the new colors.
- Theme and Default-model rows upgrade to menus when the /config command
  supplies a `PiMenuLookup` built from its live `ExtensionContext`
  (`ctx.ui.getAllThemes/getTheme/setTheme`, `ctx.modelRegistry.getAvailable`):
  Theme previews via the Theme-INSTANCE form of `ctx.ui.setTheme` (live, no
  settings.json write) and commits via the NAME form (live + persist; the row
  also persists through the panel's own SettingsManager so the normal flush
  path stays authoritative). Default model renders/commits `provider/id`
  (`setDefaultModelAndProvider`); malformed values are ignored. Headless
  contexts (empty theme list, no model registry) fall back to plain text rows.
- Pi core settings are rows too (`extensions/modules/config/piSettings.ts`),
  backed by pi's OWN public `SettingsManager` (`SettingsManager.create(cwd,
  agentDir)`): typed getters give effective values (global ⊕ project), typed
  setters persist to the GLOBAL settings.json with pi's locking/atomicity, and
  `flush()` drains the write queue on save. Only settings WITH a typed setter
  are surfaced (`externalEditor`, `sessionDir`, `defaultTools`,
  `branchSummary.*`, `httpProxy` have none — they stay config-file-only).
- `/config` builds the panel per open: pi-settings groups + every module's
  groups (Enable row prepended to the module's first section) + plugins, sorted
  by `PI_TAB_ORDER`. Every contribution renders even while its module is
  DISABLED — the Enable row must stay reachable; only bundle load honors the
  kill-switch (after /reload). On save it writes the kill-switch first, flushes
  the pi SettingsManager, saves plugins, then runs each contribution's `save()`
  in its own try/catch — one failure never blocks the others.

Plugins group (`extensions/modules/config/plugins.ts`) — Pi-package on/off,
the "whole PI plugins" tab. Pi stores installed packages in the `packages`
array of settings.json; the load contract (Pi's `package-manager.js`
RESOURCE_TYPES / applyPackageFilter) is: string entry = load everything;
object with ALL FOUR resource arrays empty = "Empty array explicitly disables
all resources of this type" (the off form); patterns or partial empty arrays =
granular `pi config` setup; `autoload: false` = project filter delta. The
group renders one toggle row per package (project entries first, then global
— each row writes back to the file it came from), classifies filtered/delta
entries as read-only `info` rows ("custom filters"), and `/config show` lists
the same set. `flipPackage` encodes the string ⇄ all-empty-array forms.
Scope: global agent-dir file always; project `.pi/settings.json` only when
trusted (untrusted packages never load, so they must not show as active).
- `writeDisabled`/`readDisabled` resolve through ONE `disabledSource()`
  (trusted project `.pi/settings.json` when it carries a `ceulen` section,
  else the agent-dir file) so a toggle can never be shadowed by a higher-
  precedence layer. The project-file case is disclosed in the group label and
  the save notify.

Contributions today: **router** (`router.baseUrl`, `router.enableReasoning` —
save re-registers the provider, force-refreshes the catalog, revalidates the
active model; **Providers** tab, `Router` section) and **ponytail**
(`ponytail.defaultMode`, `ponytail.quietStartup`, `ponytail.hideStatus` —
writes its own `~/.config/ponytail/config.json`; applies next session;
**Tasks** tab, `Ponytail` section). Modules without a contribution factory get
a synthesized Enable-only section (usage → **Appearance** · `Usage footer`;
config → **Plugins** · `Ceulen config`). The per-module kill-switch rows are
NOT a standalone tab: `withEnableRow()` prepends the module's Enable row (key
`ceulen.disabled.<name>`, warning "Takes effect after /reload") to its own
section — a feature is turned on where it is configured. **Plugins**
(bundle-level, not a module contribution): Pi-package enable/disable, see
above.

Adding a contribution (the ONLY supported mechanism — there is no
`describeConfig()`; the loader wires this one):

1. Export a factory from the module: `export function myConfig(pi: ExtensionAPI): ModuleConfig`
   returning `{ groups: () => PanelGroup[]; save: (edited: Set<string>, ctx) => Promise<void> }`.
2. List it on the module's MODULES entry in `extensions/lib/registry.ts`:
   `{ name: "mymod", load: myModule, config: myConfig }`.

The loader calls the factory per `/config` open with the module's OWN guarded
`pi`, and only when the module is enabled. `save()` must no-op unless one of
its `<module>.`-prefixed keys is in `edited`. No config-module change is needed.
Usage has no writable settings and contributes nothing.
