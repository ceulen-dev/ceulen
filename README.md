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
- Commands: `/router-status`, `/router-config` (interactive panel), `/router-reasoning`, `/router-model`

### usage — subscription-usage footer

A status footer showing subscription/provider usage (5-hour, weekly, monthly windows, credits). Commands: `/usage` (usage detail), `/context` (context-window detail).

**Yardmaster**: if `router.baseUrl` points at a yardmaster instance, the footer polls `GET <baseUrl>/usage?provider=<prefix>` (falling back to the aggregate `GET /usage`, then OmniRoute's `om-usage` endpoint) and renders remaining % per window plus credit balance:

```
Router · command-code 5h:82% W:64% M:31% M:$12.40
```

Needs a yardmaster API key with the **usage** permission — the same key you `/login router` with works if it has that permission.

### ponytail — lazy-senior-dev mode

Lazy mode for the agent itself: `/ponytail off|lite|full|ultra|review` switches the over-engineering discipline level (persisted per session); `stop ponytail` / `normal mode` deactivates. The active level is injected into the system prompt each turn, shown in the status bar, and inherited by subagents. Ships the six `ponytail*` skills (`/ponytail-review|audit|gain|debt|help`).

- Config: `~/.config/ponytail/config.json` or `PONYTAIL_*` envs
- Command: `/ponytail [mode|status|default <mode>]`

## Kill-switches

In `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{ "ceulen": { "disabled": ["usage"] } }
```

Disabled modules don't register anything; `/ceulen` lists what's active and disabled.

## Roadmap

Next: a `config` module owning `/config` — a central settings panel rendered from per-module descriptors.

## License

MIT
