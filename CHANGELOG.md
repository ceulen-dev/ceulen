# Changelog

## 0.2.0 — 2026-09-28

Wave 1: first two production modules merged into the bundle.

- **router** (from pi-router 1.2.3): generic `router` provider for any OpenAI-compatible router (`/v1/models` + `/v1/chat/completions`), commands `/router-status`, `/router-config`, `/router-reasoning`, `/router-model`.
- **sub** (from pi-sub 0.1.52): subscription-usage footer + `/sub` + `/context`, including the Yardmaster usage display (`GET <router.baseUrl>/usage?provider=<prefix>`).
- `@bacnh85/pi-config-panel` vendored into `extensions/lib/panel.ts` — ceulen ships with zero runtime dependencies.
- Kill-switch: `"ceulen": { "disabled": ["sub"] }` in settings.json skips modules.
- Research `docs/` removed (captured in git history and project memory).

## 0.1.0 — 2026-09-21

Name reservation + bundle scaffold.
