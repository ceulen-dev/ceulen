# Changelog

## 0.6.0

- **munin** (new module, ported from `@bacnh85/pi-munin` 0.5.12): Munin
  long-term memory — eight `munin_*` tools (search/get/store/list/recent/
  delete/capabilities/share, each per-tool toggleable in `/config`),
  `/munin-status`, the Munin Memory Protocol injected into the system prompt
  while Munin is configured, the `tool_result` error sanitizer, and the `munin`
  skill (kill-switch gated via `resources_discover`). The `@kalera/munin-sdk`
  client is vendored (152 lines, zero deps; capabilities cache now keyed by
  `baseUrl|apiKey`) and dotenv dropped (ceulen's trust-gated `.env` ingestion
  covers it) — no new runtime dependency. **Config is project-level**:
  `munin.project`/`munin.baseUrl`/`munin.apiKey` saved to
  `<repo>/.pi/settings.json` via `/config` (new **Memory** tab, masked key row
  with a gitignore warning), read only when the project is trusted; precedence
  per-call params > `MUNIN_*` env > project file > global file > default.
  Applies immediately — config resolves per tool call, no reload.

## Unreleased
- **composer**: the line above the band is now a full usage line — token
  stats + provider quota windows flush LEFT (`↑1.9M ↓377k R69M W2.0k CH99.6%
  · (router) R:59%/2H3M`), Generation Rate justified RIGHT (`⚡ N tok/s`),
  split by the composer's stock left/right groups. `CH` (cache-hit share of
  the latest assistant prompt) joins the stats figures; cost stays `/usage`-
  only. Under width pressure the left group sheds whole segments (usage →
  stats) while the rate stands; rate alone still right-justifies. The band
  itself stays identity-only (π · model · dir · git + context%).
- **ux** (new module, ported from `@bacnh85/pi-ux` 0.6.6): anti-slop UI/UX
  design discipline — `/ux off|lite|strict` (session-persisted, `stop ux` /
  `normal mode` deactivates) injects the ux-design method into the system
  prompt each turn; strict blocks handoff until the `ux_audit` tool passes
  (deterministic APCA-contrast / token / state / slop-tell gates, no model).
  Ships the four `ux-*` skills (`ux-design`, `ux-presets`, `ux-routing`,
  `ux-capture`) through `resources_discover`, gated by the module kill-switch.
  Configured in `/config` (Appearance → UX discipline: default mode,
  quiet startup; per-tool toggle for `ux_audit`) — persists to
  `~/.config/pi-ux/config.json` with `PI_UX_*` env overrides, so standalone
  pi-ux settings carry over. **No status-bar footprint** (upstream's status
  segment, `hideStatus` setting and `PI_UX_HIDE_STATUS` are dropped), and
  bare `/ux` reports status instead of resetting (ponytail #99 precedent);
  `/ux default <mode>` is gone — the central panel owns defaults. The
  ponytail module's skill contribution was narrowed from the whole `skills/`
  root to its own six `ponytail*` dirs so the ux kill-switch actually gates
  the ux skills.
- **themes** (new package resource): 104 selectable themes ship with the bundle —
  the 4 from `@bacnh85/pi-themes` (`pi-dark`, `pi-mirage`, `pi-light`,
  `pi-catppuccin-mocha`) plus 100 from oh-my-pi's collection (`dark-*` /
  `light-*` families + stone/gem one-offs). Loaded by pi itself via the
  package manifest (`pi.themes`) — no module, no kill-switch; select in
  `/theme` or `/config` (Appearance → Theme, live preview). omp copies were
  re-pointed at pi's theme schema and their 8-digit RGBA `selectedBg`
  (poimandres pair) truncated to 6-digit hex (pi's `parseColor` rejects
  alpha). `scripts/validate-themes.mjs` (in `npm test`) enforces name
  uniqueness, no builtin collisions (`dark`/`light`/`system`), the full
  pi-required token set, and resolvable color values across all 104.
- **serena, fff, rtk** (new modules, ported from the pi-extensions monorepo):
  Serena semantic code tools (`serena_*`, Python worker), FFF fuzzy
  file/content search (`ffgrep`, `ffind`, `fff_multi_grep`, `resolve_file`,
  `related_files` + @-mention completions), and RTK bash-command rewriting
  (`/rtk`). Every tool they register gets a **per-tool toggle row in /config**
  (Tools · Serena / FFF search, Shell · RTK sections): toggling writes
  `ceulen.disabledTools` and applies to the running session immediately via
  `setActiveTools` (disabled tools re-register inactive on every load, so the
  setting survives restarts without a /reload). rtk has no tools — its surface
  is the module Enable row. No status-bar entries — the modules stay silent
  in the footer. First runtime dependency: `@ff-labs/fff-node`
  (native FFI engine, unvendorable); `typebox` joins the peer deps (pi aliases
  it at runtime). Serena/fff tests converted to the repo's `node:test` + tsx
  convention; rtk's were already `node:test`.
- **config**: stock-`/settings` parity — every pi setting with a typed
  `SettingsManager` setter is now a `/config` row. New: **per-model thinking
  overrides** (one row per model + an **Add model override** row whose menu
  lists catalog models; the clear option reverts to the default — rows appear
  and disappear on commit via the kernel's new `rebuildOnCommit`), **Fullscreen
  wheel scrolling**, and the extra-resource-dir lists (**Extension dirs**,
  **Skill dirs**, **Template dirs**, **Theme dirs**). Stock choice UX: HTTP idle
  timeout renders the labeled choices (`30 sec`…`disabled`), Default project
  trust `Ask`/`Always trust`/`Never trust`, editor padding / autocomplete /
  image width as stock choice sets, and thinking levels carry their per-level
  descriptions (`off` … `max`, ~token hints). OMP taxonomy: transport →
  **Providers · Protocol**, HTTP idle timeout → **Providers · Timeouts**,
  telemetry/analytics → **Providers · Privacy**, skill commands + skill dirs →
  **Tasks · Commands & Skills**, extension dirs → **Tools · Extensions**,
  template dirs → **Context · Prompt templates**; descriptions now match pi's
  own stock `/settings` copy. Kernel: `ConfigPanelOpts.rebuildOnCommit` +
  `ConfigPanelModel.rebuild` rebuild the row set after any committed edit
  (toggle, menu pick, inline submit) — used by the dynamic per-model rows.
- **composer** (new CORE module): Composer Shape for the input editor with
  OMP's full vocabulary and copy — **Status Band** (default) · **Rounded Box**
  · **Claude Code** · **Pi** · **Borderless** · **Top Rule Dock** · **Compact
  Field** · **Accent Rail**. Browsing the Shape row renders a live preview
  block in the panel through the same chrome builders the running editor
  uses (no drift); Enter applies to the running editor immediately
  (text/autocomplete/app keybindings preserved via `CustomEditor`
  duck-typing) and persists `composer.shape`. Side borders, prompt gutters
  and filled surfaces are composed by re-laying the editor out at the
  shape's content width and wrapping each row — the cursor marker survives,
  so wrapping and hardware-cursor placement stay exact. Status-bearing
  shapes show OMP's stock status split with icons on every segment — left
  group: `π` brand · `(provider) model (thinking level)` (level live via `thinking_level_select`; `off` hidden; the provider prefix is skipped when the display name already carries it) · `📁` cwd · `⑂` branch + working-tree counts
  (`*N`/`+N`/`?N`, warning when dirty) · provider quota windows (`(router)
  R:59%/2H3M`, fed by the usage module) · session token stats (`↑40k ↓44 R64
  CH0.2%`) · `⚡` Generation Rate; right group: the context window
  (`0.0%/1.0M (auto)`, stepped at 70%/90%). The band fills the
  status chip only, not the whole line. On status-bearing
  shapes the module replaces Pi's built-in footer with a narrowed one —
  the other extensions' statuses only, since cwd/branch/
  model/context%/token-stats/quota-windows are already in the band;
  non-embedding shapes keep the
  native footer. The working spinner stays visible in every shape. Always on:
  no kill-switch (a half-configured composer is worse than none).
- **config**: rows can carry a `previewLines` hook — a read-only preview
  block under the rows pane / selection menu that follows the highlighted
  option (OMP's settings-screen preview window).
- **registry**: modules are categorized — `ModuleEntry.category` (the OMP
  tab) is now the single source for /config tab placement, synthesized
  Enable-only sections, and `/ceulen` status grouping (now rendered per
  category: `Providers: router · Appearance: usage, composer · …`).
- **config**: multi-choice rows now open an **OMP-style selection menu**
  instead of cycling — press Enter on Theme, Default thinking level, Transport,
  Mermaid mode, ponytail mode, … and the panel swaps to a full option list:
  `↑↓` browse (clamped), typing filters options live, `Enter` selects and
  `Esc` backs out (clearing the filter first). The row's description/warning
  stays visible below the menu, options can carry their own one-line
  descriptions, the current value is marked `(current)`, and the footer
  switches to the menu's key hints. **Theme previews live while browsing** —
  moving through the theme list restyles the whole terminal (panel included)
  immediately, `Esc` restores the previous theme, and `Enter` persists it.
  The Default model row opens a `provider/id` picker built from the model
  catalogue (`ctx.modelRegistry`), writing provider + model as one pair.
  Everything goes through pi's public extension API (`ctx.ui.getAllThemes`/
  `getTheme`/`setTheme`, `ctx.modelRegistry.getAvailable`).
- **config**: `/config` now spans **pi core settings + ceulen modules** under
  OMP's taxonomy — tabs are Appearance · Model · Interaction · Context · Shell ·
  Tasks · Providers · Plugins (empty categories don't render). Pi-core rows are
  backed by Pi's own public `SettingsManager` (theme, thinking, transport/retry,
  steering, trust & telemetry, shell, images, fullscreen…), so they read the
  effective global ⊕ project value and save to the global `settings.json` via
  Pi's typed setters (apply after `/reload`). The standalone **Modules** kill-switch
  tab is gone: each module's **Enabled** row now sits at the top of its own
  section — Router → Providers, ponytail → Tasks, usage → Appearance, the config
  panel → Plugins — and stays visible (and togglable) even while the module is
  off.
- **config**: OMP-parity chrome pass — the frame is a closed box
  (`╭─┤│╰─╯`, every content row `│ … │`); section headings render underlined
  in-pane beside the sidebar (OMP shows both) with rows outside the active
  section dim-washed; the sidebar width is pinned across every tab so the `│`
  rail never jumps, and hides below a 60-column rows pane (headings remain);
  changed-from-default values render warning-colored on the label too (a
  selected+changed row keeps an accent label + warning value); the tab bar
  collapses inactive tabs to icons starting farthest from the active one (the
  active tab keeps its label); and the browse footer hint now derives from the
  active tab (`Enter toggle` for toggle/enum-only tabs, no Enter pair for
  read-only tabs, no section jump for single-section tabs).
- **config**: `/config` is now a fullscreen panel (OMP `/settings` parity): the
  frame fills the terminal as a 100%×100% overlay — title border, tab row, and a
  pinned key-hint footer as the last row (the hints follow the mode: browse,
  search, inline edit, action prompt), with the unsaved-changes marker
  right-aligned on that footer. The rows pane is height-driven (it grows with a
  taller terminal instead of the fixed 18-row window), and the chat underneath
  is untouched while the panel is open.
- **router/ponytail**: individual config commands removed now that `/config` is
  the single settings surface — `/router-config` and `/router-reasoning` are the
  Providers tab's Router section, `/ponytail default <mode>` is the Tasks tab's
  Default-mode row.
  `/router-status`, `/router-model`, and `/ponytail <mode>|status` are unchanged
  (status / model picking / session-mode switching, not persisted config).
- **config**: `/config` now follows OMP's tab → section → rows hierarchy, and tab
  navigation actually works in every terminal. Fixes: `←`/`→` used raw escape-byte
  comparisons, so application-cursor-mode (SS3 `\u001bOD`) and kitty-protocol
  terminals never moved backward — navigation now goes through pi-tui's `matchesKey`
  (CSI/SS3/CSI-u all match), and tab stepping WRAPS like OMP's TabBar instead of
  clamping. Structure: adjacent groups sharing a `tab` merge into one tab
  (Router's Endpoint + Models are now one Router section under the Providers tab), each group's label renders
  as a left-sidebar section beside its detail rows, `PageUp`/`PageDown` jump
  sections, and rows outside the active section get OMP's dim wash. Plugins splits
  into Project/Global sections under one 📦 tab.
- **config**: tab bar polish — per-group icons (`PanelGroup.icon`; the bundled
  groups use 🌐 Router / 🦥 Ponytail / 📦 Plugins),
  active tab inverse-highlighted (`selectedBg`, falls back to bold accent) with
  an icon-only fallback on narrow bars, a middle accent heading naming the
  category being configured (icon + label + setting count), and footer key
  hints that color each key glyph in accent with its meaning dimmed (OMP
  style). Also fixes the description area leaking a neighbor row's text while
  the active tab is empty, and enables `←/→` category jumps during search in
  the keybinding-less input path.
- **config**: `/config` is now TABBED — one tab per category (Modules, Endpoint, Models,
  Ponytail, Plugins…) with `←/→`/`Tab`/`Shift+Tab` switching, so each category renders
  in its own view instead of one long mixed list. Per-tab selection memory, ↑/↓ clamped
  to the active tab, active-tab highlighting (inverse/selectedBg), narrow-terminal tab
  windowing with `…` edge markers, and a single-group panel that renders no tab bar.
  Search still spans all tabs; `←/→` during a search jumps between matching categories,
  and clearing it snaps the panel to the selected row's tab.
- **config**: new **Plugins** group in the `/config` panel — every installed Pi package
  (`packages` in settings.json, project entries first when trusted) gets an on/off toggle.
  Off writes Pi's whole-off form (`{source, extensions: [], skills: [], prompts: [], themes: []}`
  — the load contract's "empty array disables all resources"), on restores the plain
  string; each row writes back to the file its entry lives in, atomically, refusing a
  corrupt file. Packages carrying granular `pi config` filters or `autoload: false`
  project deltas render as read-only "custom filters" rows. New kernel `info` row kind
  (display-only derived state); `/config show` lists plugins too.
- **config**: `/config` panel v2 — OMP-style split layout (module rail + rows pane with a dim wash outside the active group, selection-derived active section, fixed 3-row help area showing the selected row's description/warning), enum rows (`Enter` cycles a closed value set — ponytail default mode no longer accepts free text), changed-vs-default values rendered warning-styled, `←→`/`Tab` section jumps, type-to-search fuzzy filter (printable text; `Esc` clears, then closes), width-dependent flat fallback below 60 pane columns. Kernel `extensions/lib/panel.ts` is now a fork evolved in-repo (was: fixed vendor snapshot of `@bacnh85/pi-config-panel` 0.1.10). Rows gain optional `description`/`warning`/`values`/`defaultValue`; `ModuleEntry.describe` feeds each module's kill-switch help line; `/config show` appends help text.
- **config** (new module): `/config` — one central settings panel for every ceulen module, on top of the vendored panel kernel. Module kill-switches (writes `ceulen.disabled` to the effective settings layer — project when trusted and it carries the section, else agent dir; disclosed in the panel), router endpoint + thinking levels (save re-registers the provider, force-refreshes the catalog, revalidates the active model), ponytail default mode / quiet startup / status bar (own config file; next session). Non-TUI/multi-arg shells get `/config show` text. `/settings` is a Pi builtin and cannot be overridden by extensions — `/config` is the ceulen surface.
- **bundle**: `MODULES` registry + kill-switch settings I/O moved from `extensions/index.ts` to `extensions/lib/registry.ts` (the config module iterates it without a circular import). Modules may now declare `config?: (pi) => ModuleConfig` — a `{ groups(), save(editedKeys, ctx) }` contribution; the loader hands each module a `ModuleLoadDeps` map whose factories close over that module's own guarded `pi`.
- **router**: panel + save logic extracted to `modules/router/configPanel.ts` (`buildRouterGroups`/`saveRouterConfig`), the central panel's single save path; `writeRouterSection` moved from `commands/commands.ts` to `lib/config.ts`.
- **ponytail**: `writeConfigBools` helper added to `lib/config.ts`; central-panel contribution for `defaultMode`/`quietStartup`/`hideStatus`.

- **usage** (renamed from **sub**): the module and its command are now `/usage` (`/sub` survives only as the deprecated kill-switch key `"sub"` → treated as `"usage"`). Status-bar key is `ceulen-usage`; message customTypes are `ceulen-usage-status` / `ceulen-usage-context`; User-Agent is `ceulen/x.y.z`. Sessions recorded before this change replay the old `pi-sub-*` messages as raw text (the renderer was renamed with the module).
- **bundle**: new cross-module duplicate-registration guard — all ceulen modules share one extension object, where a repeated name silently overwrites; a claim by a DIFFERENT module now throws at load (same-module re-claims stay legal, e.g. router's runtime provider refresh). Env ingestion (`.env.local`/`.env`, trust-gated) moved to `extensions/lib/env.ts` — bundle infrastructure, no longer exported from a feature module.
- **bundle**: trusted cwd `.env` ingestion (`loadCwdEnvFilesIfTrusted`) is now also registered at the bundle entry, before every module's `session_start` — sub previously loaded it in its own handler, which runs after router's, so a trusted repo's `.env`-provided `ROUTER_BASE_URL`/`ROUTER_ENABLE_REASONING` was invisible to router for the entire first session.
- **sub**: backported the nightly-review security fix from pi-sub — cwd `.env.local`/`.env` are no longer ingested at import time (an untrusted checkout could inject `ROUTER_MGMT_TOKEN` etc.); they now load in `session_start` only behind `ctx.isProjectTrusted()`, with global agent-dir env files still injected at import and trusted-cwd files overriding only those. Also backported the expired-Codex-JWT fix: a plan label no longer renders from a token whose `exp` has passed (shows `expired`).

## 0.5.1 — 2026-09-30

- Widened pi peer range from `^0.99.1` to `>=0.99.1 <0.101.0`: caret on a
  0.x dependency is patch-only (≥0.99.1 <0.100.0), too narrow for pi's fast
  minor releases. No other changes.

## 0.5.0 — 2026-09-30

- **pi 0.99.1 compatibility**: peer dependencies widened from
  `>=0.80.8 <0.88.0` to `^0.99.1` for both
  `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` (range
  corrected to `>=0.99.1 <0.101.0` in 0.5.1). No code changes — all surfaces verified:
  registration API (guarded() claims), composer `CustomEditor` duck-typing,
  theme Proxy/`setTheme` semantics, `session_start` re-fire, trust.json
  gating, jiti extension loading (the 0.99 tsx→type-stripping switch affects
  pi's own build only). 306 tests + live `pi --mode rpc` smoke pass.

## 0.3.0 — 2026-09-28

Wave 2: ponytail merged into the bundle.

- **ponytail** (from pi-ponytail 0.1.17, fork of DietrichGebert/ponytail 4.9.0): lazy-senior-dev mode — `/ponytail off|lite|full|ultra|review` switcher (session-persisted), status-bar indicator, per-turn system-prompt injection, subagent instruction inheritance. The six `ponytail*` skills ship in-package and register through the module's `resources_discover` handler, so the kill-switch removes them along with the commands.
- Commands: `/ponytail [mode|status|default <mode>]`, plus `/ponytail-review|audit|gain|debt|help` skill aliases.
- Config unchanged (`~/.config/ponytail/config.json`, `PONYTAIL_*` envs) — existing pi-ponytail users keep everything; kill-switch via `"ceulen": { "disabled": ["ponytail"] }`.

## 0.2.0 — 2026-09-28

Wave 1: first two production modules merged into the bundle.

- **router** (from pi-router 1.2.3): generic `router` provider for any OpenAI-compatible router (`/v1/models` + `/v1/chat/completions`), commands `/router-status`, `/router-config`, `/router-reasoning`, `/router-model`.
- **sub** (from pi-sub 0.1.52): subscription-usage footer + `/sub` + `/context`, including the Yardmaster usage display (`GET <router.baseUrl>/usage?provider=<prefix>`).
- `@bacnh85/pi-config-panel` vendored into `extensions/lib/panel.ts` — ceulen ships with zero runtime dependencies.
- Kill-switch: `"ceulen": { "disabled": ["sub"] }` in settings.json skips modules.
- Research `docs/` removed (captured in git history and project memory).

## 0.1.0 — 2026-09-21

Name reservation + bundle scaffold.
