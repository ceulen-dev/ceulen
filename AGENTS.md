# AGENTS.md — ceulen

Agent-facing guide to this repo.

## What ceulen is

One **Pi bundle extension** (npm: `ceulen`): a single install whose feature modules are loaded by one entry, each kill-switchable via the `ceulen.disabled` settings key. Users install with `pi install npm:ceulen` — never `npm install -g`. Every module registers only through Pi's public extension API (peer dep `@earendil-works/pi-coding-agent >=0.99.1 <1.1.0`), so upstream Pi upgrades stay drop-in.

## Layout

```
extensions/
  index.ts               bundle entry: guarded() conflict guard, kill-switch, /ceulen command, module load loop
  lib/                   shared code (registry.ts — MODULES list + kill-switch settings I/O; panel.ts —
                         config-panel kernel, forked in-repo from @bacnh85/pi-config-panel 0.1.10:
                         split layout + row descriptions/warnings + enum rows + type-to-search;
                         env.ts — trust-gated .env ingestion)
  modules/<name>/        one directory per module (self-contained: index.ts, lib/, commands/, test/)
skills/                  skill directories shipped with the package (each module contributes its OWN
                         skill dirs via resources_discover — ponytail the six `ponytail*`, ux the four
                         `ux-*`, munin `munin` — never the skills/ root, so each kill-switch gates its
                         own skills)
themes/                 theme JSONs shipped with the package (declared via the package.json
                         `pi.themes` manifest — loaded by pi itself, no module, no kill-switch;
                         scripts/validate-themes.mjs runs in `npm test`)
```

## Module convention

- A module default-exports a factory `(pi: ExtensionAPI, deps?: ModuleLoadDeps) => void` (deps is rarely used — the config module reads the contribution map); it registers commands/tools/handlers and returns. Public extension API only.
- No external runtime dependencies — vendor shared code under `extensions/lib/` (with a `// ponytail: vendored from <pkg> <version>` header) rather than adding `dependencies`.
  One sanctioned exception: `@ff-labs/fff-node` (fff module) is a native FFI
  engine that cannot be vendored — pi's managed install installs real
  `dependencies` for npm packages.
- Tool registrations that should be per-tool toggleable list their canonical names on the module's `tools?: string[]` registry entry; names in `ceulen.disabledTools` (helpers in `extensions/lib/tools.ts`) register via `defaultActive: false`, and the config module's tool rows re-activate/deactivate them live with `setActiveTools` (no `/reload`).
- Tests: `node:test` + tsx, in `extensions/modules/<name>/test/`. The bundle root `package.json` `test` script globs them. Test dirs are excluded from `tsc --noEmit` when they use loose harness stubs (usage, ponytail); they run under tsx.
- To add a module: create `extensions/modules/<name>/`, append one entry to `MODULES` in `extensions/lib/registry.ts` under its category banner (each entry's `category` field is the OMP tab — the single source for /config tab placement, synthesized Enable-only sections, and /ceulen status grouping; pretty section names live in the config module's `PRETTY_OF` map). Order matters — usage reads the `router` provider, so router loads first; config loads last, it reads the contribution map. Add its test files to the `test` glob if not covered. The conflict guard covers you: a name another module already claimed throws at load.

### Classifier module (classifier)

Ported from `@bacnh85/pi-classifier` 0.2.3, rewired to the MODEL REGISTRY: the
router module (`extensions/modules/router/lib/systemone.ts` — slim vendored
System One transport, `// ponytail: vendored from @earendil-works/pi-ai 0.99.1`
header) registers `classifiers: {"typesafe-system-one": …}` on the router
provider and merges `GET <router.baseUrl>/v1/systemone/models` (404-fail-open)
into the catalog as `type: "classifier"` entries; models-store.json persists the
MIXED list and the offline restore branches on `type === "classifier"` (chat
entries keep the vision/reasoning remap). The classifier module itself has no
endpoint and no key code: the `classify` tool and the bash verdict
(audit-only — pi 1.0.0 has no per-call approval prompt, so the hook annotates
and logs, never gates) resolve models via `modelRegistry.getAvailableOfType/findOfType`
and ask through `modelRegistry.classify()` (never rejects). Settings stay in the
GLOBAL `classifier` section (`model`, `permission.{enabled,mode,threshold}` —
same keys/values as pi-classifier, migration-free; `planGate` is left untouched
for the future pi-plan port). Replaces the standalone package — if both are
installed, first tool registration wins.

### Advisor module (advisor)

Ported from `@bacnh85/pi-advisor` 0.3.8 (see `extensions/modules/advisor/`): the
turn-end reviewer (`agent_settled` → one isolated model call → at most ONE
severity-routed note, steered as a follow-up turn or deferred to a next-turn
aside inside the `immuneTurns` calm-down window), the emission guard
(content-free/dedupe/rate-limit, Unicode-folded normalization + omp-parity
filler list), the ordered model fallback chain, and the on-demand `advisor`
tool. OMP-parity hardening (2026-10-01 delta analysis): the reviewer SYSTEM
bans the omp noise classes (restating seen errors, intent/ceremony, scope
policing, unsolicited back-compat, second-guessing, partial work) and demands
cited evidence; `WatcherStats.usage` accumulates token/cost from the serving
`streamSimple` result (shown in `/advisor status`, per-call in the consult
tool result); `session_compact`/`session_before_switch` reseed the cursor and
clear the guard (skipped when the event's session id differs from the live
runtime's). The standalone `@bacnh85/pi-config-panel` models
editor and the `ModelSelectorComponent` picker are DROPPED — `/config` → Model
→ Advisor is the editor (`/advisor models` prints the chain, `/advisor
<provider/model[, …]>` still sets it).

**Settings**: the `advisor` section of the agent-dir settings.json (`enabled`,
`models` chain with an optional `:level` per entry,
`watch.{minToolCalls,immuneTurns}`), with a trusted project `.pi/settings.json`
overriding per field. The standalone `pi-advisor` section is a READ-ONLY legacy
alias — the new name wins per field inside a file, and the legacy
`watch.enabled` folds into `enabled` at read time so the runtime has exactly ONE
switch; the first save deletes the legacy section plus the legacy `model` string
and `watch.enabled` key (nothing left to shadow the new state). The pi-plan
`advisorModel` migration is deliberately NOT ported — pi-plan owns it when that
port lands.

**`/config` rows** (`advisor.*`; the Enable + tool rows are auto-generated):
`Review settled turns` (the background review; off = no review, the consult
tool keeps working), `Primary model`
(catalogue menu), `Thinking` (closed set, saved as the primary's `:level`
suffix), `Fallback chain` (comma-separated, inline model completions),
`watch.minToolCalls`, `watch.immuneTurns`. Saving writes the agent-dir file and
applies to the LIVE session through the module bridge (`setAdvisorBridge`: models
swapped, master → the session watch flag, cursor reseeded on a 0 → N chain, tool
availability re-synced) — no `/reload`. A trusted project file setting `advisor`
or `pi-advisor` is disclosed as shadowing the global save.

**Tool availability** is resolved by the module's `sync()` (session_start,
model_select, `/advisor on|off`): the `advisor` tool follows the CHAIN — a
configured advisor is always consultable on demand, also while `Review settled
turns`/`/advisor watch-off` has the background review off (pi-advisor's
semantics) — and it honors `ceulen.disabledTools` (its row is relabeled
`Consult tool` by the config module's `TOOL_PRETTY` map, since the bare name
`advisor` would sit right under the section of the same name). The per-tool
kill-switch always wins, so a toggle is never silently undone. The advisor
module is `core: true` (always loaded, no Enable row, `ceulen.disabled`
ignores it): its real off-switch is an empty `Primary model`.

**Isolated calls** go through the PUBLIC `ctx.modelRegistry.streamSimple`
(pi's own `prepareRequest` path: request-time auth + provider wiring) — no
`@earendil-works/pi-ai` import, so the bundle keeps zero runtime dependencies.
The entry/message customType is `ceulen-advisor`; the opencode session header
rides in the request options because the main loop's `transformHeaders` closure
is unreachable from an extension. The watch is TUI-only, fire-and-forget off the
settle barrier, pauses after 3 consecutive failures (`/advisor on` resumes), and
self-disarms on `session_shutdown` so an in-flight review never leaks into a
replaced session. omp's roster / per-advisor tool grants /
`maxNotesPerUpdate` / `syncBacklog` are NOT ported — an isolated advisor
`ToolSession` is not part of pi's public extension API.

## Munin module (munin)

Ported from `@bacnh85/pi-munin` 0.5.12 (see `extensions/modules/munin/`). Eight
`munin_*` tools (per-tool kill-switchable), `/munin-status`, the Munin Memory
Protocol injection (`before_agent_start`, only when configured), the `tool_result`
error sanitizer, and the `munin` skill (own `resources_discover` dir). The SDK is
VENDORED to `lib/sdk.ts` (`// ponytail: vendored from @kalera/munin-sdk 1.5.0`;
local change: capabilities cache keyed by `baseUrl|apiKey` — upstream cached one
global). dotenv was dropped: the bundle's `env.ts` already ingests trusted `.env`.

Config is PROJECT-level (unlike router's global writes): `munin.apiKey`,
`munin.project`, `munin.baseUrl` live in `<repo>/.pi/settings.json` under a
`munin` section, surfaced by `/config` on the **Memory** tab (`PRETTY_OF` icon
🪶 — fills the previously empty Memory slot in `PI_TAB_ORDER`). Precedence:
per-call params > `MUNIN_*` env > trusted project file > global agent-dir file >
default baseUrl. The project file is read ONLY when trusted (router's rule — an
untrusted checkout must not redirect where the API key is sent); the /config
save always targets `<ctx.cwd>/.pi/settings.json` and warns when the project is
untrusted (pi ignores the file until trusted). `/munin-status` discloses each
field's source without printing the key. Env contract is stable `MUNIN_*`
(same policy as `ponytail.*`).

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

`ceulen.disabled: string[]` in `~/.pi/agent/settings.json`, or `.pi/settings.json` in a **trusted** project (trust is read from `<agentDir>/trust.json`, walking up like pi; untrusted repos can't toggle modules). `/config` writes to whichever file currently carries the `ceulen` section (see the config-module section) — never a shadowed layer. The deprecated `"sub"` key is still treated as `"usage"`. **CORE modules** (`ModuleEntry.core: true`, today `composer`, `advisor`) are always loaded: `readDisabled`/`writeDisabled` filter them (a stale entry can't disable one), `nextDisabled` never lists them, and the config panel adds no Enable row. Note: Pi's SDK `ExtensionAPI` has no `getSetting` — `extensions/lib/registry.ts` reads settings.json directly.

## Yardmaster usage contract (usage module)

With `router.baseUrl` set to a yardmaster instance, the usage module polls `GET <baseUrl>/usage?provider=<prefix>` (Bearer = the router API key), falling back to aggregate `GET /usage` on per-provider 404, and to OmniRoute `GET <origin>/api/usage/om-usage` when no JSON usage endpoint exists. Response shape: `{windows: {session|weekly|monthly: {remaining_pct, reset_at}}, credits: {currency, balance}}`. The key needs yardmaster's usage permission. Renderer + parser live in `extensions/modules/usage/index.ts` (`parseGenericUsage`).

## Ponytail config (ponytail module)

Ponytail resolves its default mode from `PONYTAIL_DEFAULT_MODE`, then `~/.config/ponytail/config.json` (`{"defaultMode": "full", "quietStartup": false, "hideStatus": false}`; XDG_CONFIG_HOME respected), then `full`. `PONYTAIL_HIDE_STATUS`, `PONYTAIL_QUIET_STARTUP`, `PONYTAIL_SUBAGENT_SCOPE=off` override the config booleans. Config surface is deliberately NOT namespaced to `ceulen.*` — the `ponytail.*`/`PONYTAIL_*` names are the module's stable contract.

## UX config (ux module)

Ported from `@bacnh85/pi-ux` 0.6.6 (see `extensions/modules/ux/UPSTREAM`). Resolves its default mode from `PI_UX_DEFAULT_MODE`, then `~/.config/pi-ux/config.json` (`{"defaultMode": "strict", "quietStartup": false}`; XDG_CONFIG_HOME respected), then `strict`. `PI_UX_QUIET_STARTUP` overrides the saved boolean — same stable-contract policy as ponytail (standalone pi-ux settings carry over). **No status-bar footprint**: the module never calls `setStatus`, and upstream's `hideStatus` setting / `PI_UX_HIDE_STATUS` env are dropped. Bare `/ux` reports status (not upstream's reset-to-default); the default mode is owned by `/config` (Appearance → UX discipline), not a `/ux default` subcommand.

## Release flow

Bump `version` in `package.json` → commit → `git tag vX.Y.Z` → push → `gh release create vX.Y.Z` — the GitHub **release** (not the tag push) triggers `publish.yml` (npm publish, provenance on). CI (`ci.yml`) runs typecheck + tests on every push/PR.

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
  `completions` (inline suggestion picker for comma-separated free text),
  `mask` (secret row: value renders `••••` in the panel AND the `/config show`
  summary (config/index.ts masks in summaryLines; panel.ts:369 only blanks it
  for search filterText) — edit starts EMPTY, never prefills the secret,
  empty submit is a no-op).
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
  are surfaced (`externalEditor`, `sessionDir`, `branchSummary.*`,
  `httpProxy` have none — they stay config-file-only). THE ONE SANCTIONED
  EXCEPTION is `defaultTools` (extensions/modules/config/defaultTools.ts):
  SettingsManager exposes `getDefaultTools()` but no setter, so the Tools →
  "Built-in tools" section renders one toggle per built-in tool (read, bash,
  powershell, edit, write, grep, find, ls + the built-in extension tools
  codemode, tool_search; stock four default-on) over a working Set, and the
  save path hand-writes the resolved absolute list into the GLOBAL
  settings.json with the shared atomic-write pattern — stock-equal lists
  DELETE the key (pi's reset semantics; an empty array would mean NO tools).
  The same save applies the delta to the live session via
  `applyToolSwitches`, so a toggle needs no /reload. A plain defaultTools
  list only replaces the BUILT-IN startup selection — extension tools with
  `defaultActive: true` self-activate regardless, so ceulen's tools are
  never touched. `STOCK_DEFAULT_TOOLS` replicates pi's unexported
  DEFAULT_TOOL_NAMES.
  Coverage is full stock-`/settings` parity plus the setter-only extras:
  per-model thinking overrides (one row per override — `pi.modelThinkingLevels.
  <provider/id>` — plus an **Add model override** menu row; the clear option
  reverts to the default), Fullscreen wheel scrolling, and the extra
  resource-dir lists (extensions/skills/prompts/themes). Friendly choice forms
  mirror stock (`30 sec`…`disabled`, `Ask`/`Always trust`/`Never trust`, the
  padding/autocomplete/image-width sets, per-level thinking descriptions) —
  those constants are replicated locally because pi does not export them from
  its package root. OMP taxonomy holds: Providers · Protocol/Timeouts/Privacy,
  Tasks · Commands & Skills, Tools · Extensions, Context · Prompt templates.
- The panel kernel supports dynamic row sets via `ConfigPanelOpts
  .rebuildOnCommit` (`ConfigPanelModel.rebuild`): after any committed edit
  (toggle, menu pick, inline submit) the groups are rebuilt from `build` and
  swapped in — that is how per-model override rows appear/disappear on commit.
  `/config` turns it on; static row sets leave it off.
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
**Tasks** tab, `Ponytail` section) and **munin** (`munin.project`,
`munin.baseUrl`, `munin.apiKey` (masked, gitignore warning) — writes the
PROJECT `.pi/settings.json` `munin` section, effective immediately (config is
read per tool call, no reload); **Memory** tab, `Munin` section) and
**advisor** (`advisor.enabled`, `advisor.model`, `advisor.thinking`,
`advisor.fallbacks`, `advisor.watch.{minToolCalls,immuneTurns}` — writes the
GLOBAL `advisor` section (legacy `pi-advisor` migrated on first save), applied
live through the module bridge; **Model** tab, `Advisor` section) and
**classifier** (`classifier.model`, `classifier.permission.*`; **Model** tab,
`Classifier (Jev)` section). Modules
without a contribution factory get
a synthesized Enable-only section (usage → **Appearance** · `Usage footer`;
config → **Plugins** · `Ceulen config`). The per-module kill-switch rows are
NOT a standalone tab: `withEnableRow()` prepends the module's Enable row (key
`ceulen.disabled.<name>`, warning "Takes effect after /reload") to its own
section — a feature is turned on where it is configured. **composer**
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
