# Ceulen

**The Pi coding agent, fully dressed.**

Pi's minimal core + one bundle extension carrying the complete toolkit — everything wired behind a single `/ceulen` command. Named for Ludolph van Ceulen, who spent his life computing π to 35 digits (they're carved on his tombstone); in 17th-century Germany, π was literally called *die Ceulensche Zahl*.

## What it is

A [Pi](https://github.com/earendil-works/pi) distro in the form of one extension bundle:

- **One install** — no assembling separate extensions; the suite ships as a unit
- **One surface** — modules register cleanly into Pi's native UX: tools, commands, events
- **Selective adoption** — every module has an individual kill-switch; disable what you don't use, keep the rest of the bundle intact
- **No core patches** — ceulen rides Pi's public extension API only, so upstream Pi upgrades stay drop-in
- **Zero runtime dependencies** — everything (including the config-panel kernel) is vendored

## Install

```sh
pi install npm:ceulen
```

Add `-l` to install into the current project instead of your user scope. Update with `pi update --extensions`.

Then start Pi in your project directory — ceulen's modules load automatically.

## Modules

### router — any OpenAI-compatible router as a Pi provider

Registers the generic `router` provider (discovers models via `GET /v1/models`, chats via `/v1/chat/completions`) against 9router, OmniRoute, yardmaster, or any OpenAI-compatible router.

- Config: `router.baseUrl` in `~/.pi/agent/settings.json` (or `ROUTER_BASE_URL` env)
- Auth: `/login router` in Pi (or `ROUTER_API_KEY` env)
- Commands: `/router-status`, `/router-config` (interactive panel), `/router-reasoning`, `/router-model`

### sub — subscription-usage footer

A status footer showing subscription/provider usage (5-hour, weekly, monthly windows, credits) for known providers, plus the **Yardmaster usage display** below. Commands: `/sub` (usage detail), `/context` (context-window detail).

### Yardmaster usage

If your `router.baseUrl` points at a yardmaster instance, the sub footer shows your proxy usage directly: it polls `GET <router.baseUrl>/usage?provider=<prefix>` (falling back to the aggregate `GET /usage`, and to OmniRoute's `om-usage` endpoint when the JSON form isn't served) and renders remaining % per window plus credit balance, e.g.

```
Router · command-code 5h:82% W:64% M:31% M:$12.40
```

This needs a yardmaster API key with the **usage** permission (Admin → usage api → allowed) — the same key you `/login router` with works if it has that permission.

### ponytail — lazy-senior-dev mode

Lazy mode for the agent itself: `/ponytail off|lite|full|ultra|review` switches the over-engineering discipline level (persisted per session, restored on resume); `stop ponytail` / `normal mode` deactivates. The active level is injected into the system prompt each turn, shown in the status bar, and inherited by subagents. Ships the six `ponytail*` skills in-package (`/ponytail`, `/ponytail-review|audit|gain|debt|help`).

- Config: `~/.config/ponytail/config.json` (`defaultMode`, `quietStartup`, `hideStatus`) — or env: `PONYTAIL_DEFAULT_MODE`, `PONYTAIL_QUIET_STARTUP`, `PONYTAIL_HIDE_STATUS`, `PONYTAIL_SUBAGENT_SCOPE=off` to disable subagent injection
- Command: `/ponytail [mode|status|default <mode>]` (review is session-only)

## Kill-switches

In `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{ "ceulen": { "disabled": ["sub"] } }
```

Disabled modules don't register anything; `/ceulen` lists what's active and disabled.

## Roadmap

Wave 1 ships router + sub; wave 2 adds ponytail (skills included). Later waves consolidate the remaining pi-extensions fleet (notify, cron, references, …).

## License

MIT
