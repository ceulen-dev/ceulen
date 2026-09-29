# Changelog

## Unreleased

- **bundle**: trusted cwd `.env` ingestion (`loadCwdEnvFilesIfTrusted`) is now also registered at the bundle entry, before every module's `session_start` — sub previously loaded it in its own handler, which runs after router's, so a trusted repo's `.env`-provided `ROUTER_BASE_URL`/`ROUTER_ENABLE_REASONING` was invisible to router for the entire first session.
- **sub**: backported the nightly-review security fix from pi-sub — cwd `.env.local`/`.env` are no longer ingested at import time (an untrusted checkout could inject `ROUTER_MGMT_TOKEN` etc.); they now load in `session_start` only behind `ctx.isProjectTrusted()`, with global agent-dir env files still injected at import and trusted-cwd files overriding only those. Also backported the expired-Codex-JWT fix: a plan label no longer renders from a token whose `exp` has passed (shows `expired`).

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
