# Ceulen

**The Pi coding agent, fully dressed.**

Pi's minimal core + one bundle extension carrying the complete toolkit, wired behind a single `/ceulen` command. Named for Ludolph van Ceulen, who computed π to 35 digits — they're carved on his tombstone.

## What it is

A [Pi](https://github.com/earendil-works/pi) distro in the form of one extension bundle:

- **One install** — the suite ships as a unit
- **One surface** — modules register into Pi's native UX: tools, commands, events
- **Selective adoption** — every module has an individual kill-switch; disable what you don't use
- **No core patches** — Pi's public extension API only, so upstream upgrades stay drop-in
- **Zero runtime dependencies** — everything is vendored

## Install

```sh
pi install npm:ceulen
```

Add `-l` to install into the current project instead of your user scope. Update with `pi update --extensions`. Then start Pi in your project directory — ceulen's modules load automatically.

## Modules

### router — any OpenAI-compatible router as a Pi provider

Registers the generic `router` provider (models via `GET /v1/models`, chat via `/v1/chat/completions`) against 9router, OmniRoute, yardmaster, or any OpenAI-compatible router.

- Config: `router.baseUrl` in `~/.pi/agent/settings.json` (or `ROUTER_BASE_URL` env)
- Auth: `/login router` in Pi (or `ROUTER_API_KEY` env)
- Commands: `/router-status`, `/router-model` — settings via `/config` (Providers tab)

### usage — subscription-usage footer

A status footer showing subscription/provider usage (5-hour, weekly, monthly windows, credits). Commands: `/usage` (usage detail), `/context` (context-window detail).

**Yardmaster**: if `router.baseUrl` points at a yardmaster instance, the footer polls `GET <baseUrl>/usage?provider=<prefix>` (falling back to the aggregate `GET /usage`, then OmniRoute's `om-usage` endpoint) and renders remaining % per window plus credit balance:

```
Router · command-code 5h:82% W:64% M:31% M:$12.40
```

Needs a yardmaster API key with the **usage** permission — the same key you `/login router` with works if it has that permission.

### composer — Composer Shape for the input editor

Re-chrome Pi's input editor from `/config` (Appearance → Composer Shape) with
OMP's full composer vocabulary — **Status Band** (default) · **Rounded Box** ·
**Claude Code** · **Pi** · **Borderless** · **Top Rule Dock** · **Compact
Field** · **Accent Rail** — each with OMP's own label and one-line
description in the selection menu. Browsing the Shape row previews the shape
right in the panel (rendered through the same chrome builders the live editor
uses — no drift); Enter applies it to the running editor immediately — text,
autocomplete and all app keybindings intact (the custom editor extends Pi's
`CustomEditor`) — and persists `composer.shape` to the global settings.json.
Status-bearing shapes (Band, Box, Claude, Top Rule Dock) show OMP's stock
status split, every segment carrying its icon (OMP's glyph set) — left group:
`π` brand · `(provider) model (thinking level)` · `📁` `~/`-relative directory · `⑂` git branch with
working-tree counts (`*3` unstaged / `+1` staged / `?2` untracked, warning
when dirty) · `⚡` Generation Rate (last response); right group: the context
window (`0.0%/1.0M (auto)`, color-stepped at 70%/90%). On the band the fill
covers the status chip only (the context figure sits on the bare surface), so
the band reads as a status strip rather than a title bar. On those
shapes the module also **replaces Pi's built-in footer** so the same info is
not printed twice: the band additionally carries the session token stats
(`↑40k ↓44 R64 CH0.2%`) and provider quota windows (`(router) R:59%/2H3M`,
minute-precision countdowns; usage module feeds it via a shared store), so
the narrowed footer keeps only the other extensions' status lines (rtk,
serena, ux, accordion, …). Shapes without an embedded band (Pi, Borderless,
Compact Field, Accent Rail) keep Pi's native footer untouched. The working
spinner stays visible in every shape. **Core module**: always loaded, no
kill-switch — a half-configured composer is worse than none.

- Config: `composer.shape` in `~/.pi/agent/settings.json` — via `/config` (Appearance tab)

### ponytail — lazy-senior-dev mode

Lazy mode for the agent itself: `/ponytail off|lite|full|ultra|review` switches the over-engineering discipline level (persisted per session); `stop ponytail` / `normal mode` deactivates. The active level is injected into the system prompt each turn, shown in the status bar, and inherited by subagents. Ships the six `ponytail*` skills (`/ponytail-review|audit|gain|debt|help`).

- Config: `~/.config/ponytail/config.json` or `PONYTAIL_*` envs
- Command: `/ponytail [mode|status]` — default mode via `/config` (Tasks tab)

### config — central settings panel

`/config` opens one fullscreen panel for **pi core settings and every ceulen
module** — the frame fills the terminal (boxed corners, tab row, pinned
key-hint footer), so the chat is replaced while you configure and comes back
untouched on close. Tabs follow OMP's settings taxonomy: **Appearance · Model ·
Interaction · Context · Shell · Tasks · Providers · Plugins** (empty
categories don't render). A tab with several settings groups shows them as a
left sidebar of sections with the underlined section headings repeated beside
the detail rows, OMP style; the sidebar geometry stays identical across tabs.

- **Appearance** — pi theme, display/editor/fullscreen/terminal-image settings, plus the usage-footer and composer module switches
- **Model** — default model/provider, thinking, network transport/timeouts, retry, cache warming
- **Interaction** — steering/follow-up modes, double-escape + tree filter, startup notices, trust & telemetry
- **Context / Shell** — auto-compact, shell path/prefix, npm command
- **Tasks** — ponytail (default mode `off/lite/full/ultra`, quiet startup, status-bar visibility; applies next session)
- **Providers** — router (base URL + thinking levels; saves re-register the provider and refresh the catalog live)
- **Plugins** — every installed Pi package (`packages` in settings.json) with an on/off
  toggle; disabling writes the package in Pi's all-empty-resource-list form. Packages
  with granular `pi config` filters or project filter deltas show as read-only
  ("custom filters"). Toggles apply after `/reload`.

Each module's on/off switch lives at the top of its own section (Router → Providers,
ponytail → Tasks, usage → Appearance, the config panel itself → Plugins) as an
**Enabled** row writing the `ceulen.disabled` list — a feature is turned on where
it is configured. Pi-core rows are backed by Pi's `SettingsManager` and save to the
global `settings.json`; they apply after `/reload` (or a new session).

Keyboard: `←→`/`Tab`/`Shift+Tab` switch tabs (wrapping), `↑↓` move, `PageUp`/
`PageDown` jump sections, `Enter` toggles a switch or opens the selection menu,
type any text to fuzzy-search across every tab (`←→` jumps between matching
categories), `Esc` saves and closes (a second `Esc` clears the search first).
Multi-choice rows (theme, thinking level, transport, model, …) open an
OMP-style **selection menu** in place: `↑↓` browse, type to filter, `Enter`
selects, `Esc` backs out. **Theme changes preview live** as you browse (the
whole terminal restyles; `Esc` restores the previous theme) and the model
picker lists `provider/id` from the model catalogue. Values differing
from their default render in warning color; rows that env vars can override
say so in the help area.

Pi's builtin `/settings` cannot be overridden by extensions (a colliding
command is renamed `/settings:1`); `/config` adds the ceulen modules around
pi's own settings. Non-TUI shells get a text summary (`/config show`).

## Kill-switches

In `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{ "ceulen": { "disabled": ["usage"] } }
```

Disabled modules don't register anything; `/ceulen` lists what's active and disabled. `/config` toggles the same list — it writes to whichever file currently carries the `ceulen` section (project file when that's the effective one, disclosed in the panel).

## License

MIT
