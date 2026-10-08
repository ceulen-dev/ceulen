# Ceulen

**The Pi coding agent, fully dressed.**

One extension bundle that turns [Pi](https://github.com/earendil-works/pi) into a fully equipped coding agent: a router provider, a second-model reviewer, long-term memory, subagent delegation with multi-session repo safety, usage display, themes, and a central settings panel — one install, one command surface, most modules individually switchable.

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

### subagent — delegate work, safely

One `subagent` tool fans work out to specialized agents — `scout` (recon), `tester`, `worker`, `planner`, `reviewer` — in three modes: single, parallel (up to 8 tasks), or chained pipelines. Background tasks report liveness (`operation:"status"/"wait"/"cancel"`); when Pi runs inside herdr, tasks can delegate to visible interactive panes instead. Model tier and thinking effort are routed per task by the classifier module; `/subagent` manages roles, `/agent` inspects threads.

Multi-session repo safety (isolated children never clobber you or each other):

- **Worktree sandbox** — `sandbox:"worktree"` runs the child in a copy-on-write clone of your working tree (macOS `clonefile` — near-zero time and disk; carries your uncommitted changes, `node_modules`, and `.env` for free), falling back to a detached git worktree elsewhere. The child's changes come back as a patch; `merge:"3way"` applies it to your checkout with conflicts **reported, never silently resolved**.
- **Baseline carry** — on the worktree fallback the parent's uncommitted state is composed as pure reads (`git diff`/`--no-index`) and seeded into the sandbox, so children never work a stale tree and patches merge cleanly.
- **`.worktreeinclude`** — gitignore-style file listing copied into fresh worktrees (env files, configs).
- **Repo lock + GC** — parent-mutating git operations serialize per repo (no `index.lock` races between parallel children); crashed runs' sandboxes are swept on session start. `/subagent worktrees [clean]` lists or forces the sweep.
- **Write freshness guard** (repair module) — a `write` to a file another session changed since you last read it fails with a re-read-first error instead of clobbering.
- **Conflict footer** (repair module) — full-file reads surface unresolved `<<<<<<<` conflict markers automatically.

Config: `/config` → Tasks → Subagents (model pools, routing, timeouts).

### repair — tool-call hardening

Wraps the built-in read/write/edit/grep/find/ls/bash once each: schema argument repair, edit-mismatch trim-tolerant retry with `apply_patch` escalation, destructive-bash + guessed-path guards, and read path suffixes — `file.ts:50`, `:50-200`, `:50+150`, `:-60` (tail), comma-joined ranges, `:raw`, and `:conflicts` (list merge-conflict blocks). Registers `apply_patch` (Codex-style V4D diffs) and `str_replace_editor` as standalone tools. Config: `/config` → Tools → Repair.

### steering — model-family guidance

Provider-agnostic deepseek/glm family detection with first-tool hints, reasoning stripping, error categorization + recovery hints, and the ds-anchor two-phase bootstrap for DeepSeek minimal mode. `/steering` shows status.

### zai — Z.AI provider (GLM)

Registers a `zai-anthropic` provider serving GLM through Z.ai's Anthropic endpoint: explicit prompt caching, `speed:"fast"` serving tier, effort-based reasoning, a cross-process rate-limit throttle, and optional ZCode request signing. `/zai` = status; config in `/config` → Providers.

### ux — anti-slop UI discipline

`/ux off|lite|strict` injects a UI design method (tokens only, full interaction states, no AI-slop tells) for any UI work; `strict` blocks handoff until the deterministic `ux_audit` tool passes (APCA contrast, token, and state gates — no model needed). Ships the `ux-*` skills. Deactivate with `stop ux`.

### plan — read-only plan mode

`/plan` (or `--plan`, `ctrl+alt+p`) switches a read-only planning mode: research tools and read-only bash run untouched, file mutators hard-block, unknown commands ask first. The agent produces a reviewable plan via `write_plan` and can resolve ambiguities with `ask_user_question`; `/plan-approve current|new` executes it in this session or a fresh one. Plans land in `.pi/plans/` by default — **Save plans** in `/config` → Tasks → Plan mode decides which ones hit disk (`all` drafts, `approved` only finalized ones, `none` conversation-only). Plan-only model/thinking and `/plan-auto` autonomous approval are config rows too.

### web — unified web tools

`web_search` (adaptive SearXNG → Brave → Firecrawl), `web_extract`, `web_map`, `web_crawl`, `web_screenshot`, `web_pdf`, `web_interact` (real headless-Chrome click/type/evaluate for verifying UI behaviour), `web_research` (Gemini web + Deep Research), `web_image`, `web_chat`, `web_status`. Backend-routing guidance is injected only while a web tool is active.

- Config: `/config` → Tools → **Web** — 16 provider rows (endpoints, keys, timeouts, Gemini cookie, image/chat providers). Written to the global `web` settings section and read per tool call, so saves apply without `/reload`; `BRAVE_API_KEY`, `SEARXNG_BASE_URL`, `FIRECRAWL_*`, `CRAWL4AI_*`, `GEMINI_WEB_*`, `ZAI_API_KEY`, `WEB_IMAGE_*`, `WEB_CHAT_*` env vars still win. Secrets are masked. Cold tools load on demand via `tool_search`.
- Static extraction uses vendored readability/turndown (no extra install); `jsdom` and `gemini-reverse` are the module's only runtime dependencies.

### a2a — Agent2Agent protocol

Talk to remote agents (Hermes, ADK, LangChain, CrewAI, any A2A peer): 7 outbound tools (`a2a_call` with async dispatch, `a2a_status`, `a2a_discover`, `a2a_list`, `a2a_history`, `a2a_orchestrate` fan-out, `a2a_peers`) and an opt-in inbound server that serves isolated child sessions. Discovery spans a local registry, mDNS, and a2a-switchboard gateways. `/a2a-help` for everything; config in `/config` → Tasks → A2A.

### todo — phased task board

One `todo` tool tracks an ordered phase list with `blockedBy` edges, auto-start, and a live TUI HUD; `/todo` prints the board. Follows the batch contract (call it alongside real work, never alone).

### rules — sticky rules + rulebook

`<dir>/.pi/RULES.md` files (walking to repo root, plus a user-level file) inject sticky rules into every request; `## name` sections with a `description:` line become an on-demand rulebook served by the `rule_get` tool. Edits apply without `/reload`; `/rules` = status.

### gh — GitHub (read-only)

One `github` tool over the `gh` CLI: `repo_view`, `file_read`, `pr_view`, `pr_diff`, issue/PR/code/commit/repo search with date qualifiers, and `run_watch` for Actions runs with failed-job log tails. Zero npm deps; fails open when `gh` is absent. Mutating flows stay with bash `gh` — which keeps the tool auto-allowed in plan mode.

### attachments — paste files into prompts

Pasting file paths (or big text) collapses to `[[attach:name]]` tokens with a tray widget; on submit they become real image parts, path chips, or inline file blocks. `alt+shift+v` pastes clipboard file references. Config: `/config` → Files → Attachments.

### cron — scheduled jobs

The `cron` tool + `/cron` manage recurring prompts in `<agentDir>/cron/jobs.json` (vixie-cron schedules, hand-rolled matcher — zero deps). Jobs fire as follow-up turns; pinned jobs run headless in their own Pi process. `/cron test` previews fire times; config in `/config` → Tasks → Cron.

### permission — config-driven tool permissions

Opt-in `permission` settings section: allow/ask/deny rules per tool with wildcards, an `external_directory` deny boundary, and a doom-loop guard on repeated identical calls. No section = no opinion. Headless asks fail closed; `--yolo`/`--auto` auto-approve.

### serena / fff / rtk — code navigation & search (bundled tools)

- **serena** — semantic code tools (find symbol, references, rename, diagnostics) via a persistent language-server worker
- **fff** — fast fuzzy file/content search (`ffgrep`, `fffind`) feeding the built-in grep/find experience and `@`-mention completions
- **rtk** — transparently rewrites shell commands to save tokens (`/rtk status`, `RTK_DISABLED=1` to bypass)

### config — the settings panel

`/config` opens one fullscreen panel covering **pi core settings and every ceulen module**, organized in tabs (Appearance · Model · Interaction · Memory · Context · Shell · Tasks · Providers · Plugins).

- Theme and composer changes preview live while you browse; pi built-in tool toggles apply immediately
- Module on/off switches and pi-core rows take effect after `/reload`
- Type any text to fuzzy-search every tab; `Esc` saves and closes
- Non-TUI contexts get a text summary: `/config show`

## Themes

104 themes ship with the package — select them in Pi's `/theme` picker or `/config` (Appearance → Theme; previews live). Includes the Ayu/Catppuccin ports and the 100-theme oh-my-pi collection.

## Turning modules off

```json
{ "ceulen": { "disabled": ["munin", "ponytail"] } }
```

In `~/.pi/agent/settings.json` or a trusted project's `.pi/settings.json` — a settings-only escape hatch for a broken module (no UI). `/ceulen` lists what's active. Disabled modules register nothing.

The core set — router, usage, ux, classifier, composer, advisor, and the `/config` panel itself — is always on and never appears in the kill-switch list.

**Tool loading**: most tools register *deferred* — not declared to the model, loaded on demand by `tool_search` (pi activates it for you). Only the hot core (subagent, todo, web search/extract/screenshot/interact, fffgrep/fffind, plan/repair tools, advisor, classify, think) is declared every request, keeping the standing token cost small no matter how many tools ceulen ships.

## License

MIT
