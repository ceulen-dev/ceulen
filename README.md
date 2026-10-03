# Ceulen

**The Pi coding agent, fully dressed.**

One extension bundle that turns [Pi](https://github.com/earendil-works/pi) into a fully equipped coding agent: a router provider, a second-model reviewer, long-term memory, usage display, themes, and a central settings panel — one install, one command surface, most modules individually switchable.

Named for Ludolph van Ceulen, who computed π to 35 digits — they're carved on his tombstone.

## Install

```sh
pi install npm:ceulen
```

Add `-l` to install into the current project instead of your user scope. Update with `pi update --extensions`. Then start Pi in your project — the modules load automatically.

## Quick start

```sh
/config                  # one panel for pi core + every ceulen module
/ceulen                  # which modules are active
```

Most modules work out of the box. Two need credentials; one is optionally configured:

- **router** — set `router.baseUrl` (via `/config` → Providers, or `ROUTER_BASE_URL` env), then `/login router`.
- **munin** — set project + API key via `/config` → Memory (saved to `<repo>/.pi/settings.json`).
- **web** — optional: set search/extract backends via `/config` → Tools → Web (SearXNG/Brave/Firecrawl/Crawl4AI). Works with only one backend configured; `web_status` reports what is ready.

## Modules

### router — any OpenAI-compatible router as a Pi provider

Use 9router, OmniRoute, yardmaster, or any OpenAI-compatible endpoint as a normal Pi provider: models appear in `/model`, chat goes through `/v1/chat/completions`.

- Config: `/config` → Providers (base URL + thinking levels; a save re-registers and refreshes live)
- Auth: `/login router` or `ROUTER_API_KEY` env
- Commands: `/router-status`, `/router-model`

If the router serves System One decision models (yardmaster's `GET /v1/systemone/models`), they're listed as classifier models for the `classify` tool — never mixed into the chat picker.

### classifier — decision models (Jev) for typed answers

The `classify` tool asks a System One decision model typed questions (yes-probability, multiple choice with confidence, scored position) and gets calibrated answers instead of prose — useful for routing, verification, and gating decisions inside scripts and codemode.

It also audits bash commands (reversible? serves the task?) to `~/.pi/agent/classifier.log`. This is **observation only** — it never blocks or approves anything.

- Config: `/config` → Model → Classifier (Jev)
- Needs the router module configured

### advisor — a second pair of eyes

After each turn with real work, a separate reviewer model reads the transcript and may raise **one** note — `nit` (consider), `concern` (address or justify), `blocker` (fix first) — or stay silent. A dedupe/rate-limit guard keeps it quiet; the reviewer never uses your primary model.

- Tool: `advisor` — consult the reviewer on demand
- Config: `/config` → Model → Advisor (reviewer model, fallback chain, watch knobs — applies live)
- Commands: `/advisor [model[, model…]|models|on|off|status]`
- Turn it off: clear the Primary model row

### usage — subscription usage in the footer

A status footer with provider usage: 5-hour / weekly / monthly windows, credits, and a generation-rate indicator. `/usage` for detail, `/context` for a context-window breakdown. Supports openai-codex, opencode-go, z.ai, Command Code, and router/yardmaster (needs a key with usage permission).

### composer — a proper input editor

Pick the input editor's look from `/config` → Appearance → Composer Shape: Status Band (default), Rounded Box, Claude Code, Pi, Borderless, and more — with live preview while you browse. Status-bearing shapes show model, directory, git branch + working-tree state, generation rate, and context usage in one strip. Always on.

### munin — long-term memory

`munin_search` / `munin_get` / `munin_store` / `munin_list` / `munin_recent` / `munin_share` / `munin_delete` / `munin_capabilities`, plus a memory protocol that teaches the agent when to search and what's worth storing. `/munin-status` shows where each config field comes from (never the key itself).

- Config: `/config` → Memory — **project-level** (`<repo>/.pi/settings.json`; add it to `.gitignore`). Read only when the project is trusted; `MUNIN_*` env vars override.

### ponytail — lazy-senior-dev mode

`/ponytail off|lite|full|ultra` switches an over-engineering discipline: simplest solution that works, stdlib first, no speculative abstraction. Also ships `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`, `/ponytail-gain` skills. Deactivate with `stop ponytail`.

### ux — anti-slop UI discipline

`/ux off|lite|strict` injects a UI design method (tokens only, full interaction states, no AI-slop tells) for any UI work; `strict` blocks handoff until the deterministic `ux_audit` tool passes (APCA contrast, token, and state gates — no model needed). Ships the `ux-*` skills. Deactivate with `stop ux`.

### plan — read-only plan mode

`/plan` (or `--plan`, `ctrl+alt+p`) switches a read-only planning mode: research tools and read-only bash run untouched, file mutators hard-block, unknown commands ask first. The agent produces a reviewable plan via `write_plan` and can resolve ambiguities with `ask_user_question`; `/plan-approve current|new` executes it in this session or a fresh one. Plans land in `.pi/plans/` by default — **Save plans** in `/config` → Tasks → Plan mode decides which ones hit disk (`all` drafts, `approved` only finalized ones, `none` conversation-only). Plan-only model/thinking and `/plan-auto` autonomous approval are config rows too.

### web — unified web tools

`web_search` (adaptive SearXNG → Brave → Firecrawl), `web_extract`, `web_map`, `web_crawl`, `web_screenshot`, `web_pdf`, `web_interact` (real headless-Chrome click/type/evaluate for verifying UI behaviour), `web_research` (Gemini web + Deep Research), `web_image`, `web_chat`, `web_status`. Backend-routing guidance is injected only while a web tool is active.

- Config: `/config` → Tools → **Web** — 16 provider rows (endpoints, keys, timeouts, Gemini cookie, image/chat providers). Written to the global `web` settings section and read per tool call, so saves apply without `/reload`; `BRAVE_API_KEY`, `SEARXNG_BASE_URL`, `FIRECRAWL_*`, `CRAWL4AI_*`, `GEMINI_WEB_*`, `ZAI_API_KEY`, `WEB_IMAGE_*`, `WEB_CHAT_*` env vars still win. Secrets are masked. Individual tools toggle from the same section.
- Static extraction uses vendored readability/turndown (no extra install); `jsdom` and `gemini-reverse` are the module's only runtime dependencies.

### serena / fff / rtk — code navigation & search (bundled tools)

- **serena** — semantic code tools (find symbol, references, rename, diagnostics) via a persistent language-server worker
- **fff** — fast fuzzy file/content search (`ffgrep`, `fffind`) feeding the built-in grep/find experience and `@`-mention completions
- **rtk** — transparently rewrites shell commands to save tokens (`/rtk status`, `RTK_DISABLED=1` to bypass)

### config — the settings panel

`/config` opens one fullscreen panel covering **pi core settings and every ceulen module**, organized in tabs (Appearance · Model · Interaction · Memory · Context · Shell · Tasks · Providers · Plugins).

- Theme and composer changes preview live while you browse; tool toggles apply immediately
- Module on/off switches and pi-core rows take effect after `/reload`
- Type any text to fuzzy-search every tab; `Esc` saves and closes
- Non-TUI contexts get a text summary: `/config show`

## Themes

104 themes ship with the package — select them in Pi's `/theme` picker or `/config` (Appearance → Theme; previews live). Includes the Ayu/Catppuccin ports and the 100-theme oh-my-pi collection.

## Turning modules off

```json
{ "ceulen": { "disabled": ["munin", "ponytail"] } }
```

In `~/.pi/agent/settings.json` or a trusted project's `.pi/settings.json`. `/ceulen` lists what's active; `/config` toggles the same list. Individual tools can be toggled too (Tools tab). Disabled modules register nothing.

The core set — router, usage, ux, classifier, composer, advisor, and the `/config` panel itself — is always on and never appears in the kill-switch list.

## License

MIT
