# pi-extensions → omp Compatibility Audit

Date: 2026-09-27 · Method: static scan of `pi-*.js` factories for Pi API usage (`pi.on(...)`, `pi.register*`, `ctx.*`), cross-referenced with omp's documented extension API (oh-my-pi/docs/extensions.md) and Pi 0.85–0.87 extension docs.

## Key structural finding

**Our extensions are plain JS with zero Pi package imports** (one exception: pi-classifier requires `@earendil-works/pi-ai`). They consume the `pi` object passed to the factory at runtime. Compatibility is therefore about **omp's runtime API surface**, not package imports.

## API surface we use (audited across 38 extensions)

| API | Uses | omp status |
|---|---|---|
| `pi.on(event, handler)` | 28 | ✅ core |
| `pi.registerCommand` | 9 | ✅ core |
| `pi.registerFlag` / `pi.getFlag` | 4/4 | ✅ core |
| `pi.exec` | 4 | ✅ core |
| `pi.sendUserMessage` | 3 | ✅ core (`deliverAs: steer/followUp/nextTurn/aside`) |
| `pi.appendEntry` | 3 | ✅ core |
| `pi.registerTool` | 2 | ✅ core (zod params) |
| `ctx.ui` | 29 | ✅ core |
| `ctx.sessionManager` | 1 | ✅ read-only |
| `ctx.abort/isIdle/hasUI/cwd` | few | ✅ core |
| `pi.getSetting` | 1 (pi-permission) | ⚠️ check omp name (`pi.settings`?) — verify in spike |
| `before_agent_start` event | 3 exts | ⚠️ omp: `systemPrompt` is `string[]` vs Pi `string` ([#12511](https://github.com/can1357/oh-my-pi/issues/12511)) — normalize on read |
| Extension API baseline | — | ⚠️ omp = pi-mono **Jan-2026** (≈v0.55) API + additions + selective ports; any Pi API we adopted post-Jan-2026 may be absent (see doc 05 §1) |
| `@earendil-works/pi-ai` import | 1 (pi-classifier) | ⚠️ swap to `@oh-my-pi/pi-ai` or de-import (see below) |

Events used: `session_start`(7), `tool_call`(3), `before_agent_start`(3), `agent_start`(2), `turn_start`(2), `message_end`(2), `input`(2), `agent_end`(2), `ui_prompt_start`, `tool_result`, `agent_settled`.

## Per-extension verdict

Categories: **drop** = omp feature replaces it · **mechanical** = runs with ≤ trivial changes · **spike** = needs a design decision, not just typing.

| Extension | Verdict | Notes |
|---|---|---|
| pi-a2a | spike | Tool + event surface; no omp equivalent. Validate RPC surface on omp. |
| pi-advisor | **drop** | omp advisor (#06) reads every turn, injects inline notes. |
| pi-agy | mechanical | CLI bridge via `pi.exec`; agnostic to host. |
| pi-attachments | mechanical | OS/clipboard plumbing; no Pi imports. |
| pi-budget | spike | Halt-on-cost hooks `agent_end`/`message_end`; omp has subscription usage tracking — overlap to resolve. |
| pi-checkpoint | spike | Git snapshot at turn boundaries (`turn_start`); verify omp turn lifecycle equivalence + entry-append timing. |
| pi-classifier | mechanical | Only ext importing `@earendil-works/pi-ai`; swap to omp's `@oh-my-pi/pi-ai` or drop the import. |
| pi-commandcode | mechanical | OpenAI-compatible provider registration. |
| pi-config-panel | mechanical | Self-contained kernel; no Pi imports. |
| pi-cron | mechanical | Fires prompts on schedule into live session (`sendUserMessage` semantics hold). |
| pi-evolve | mechanical | Trajectory capture via `tool_call`/`tool_result`; self-contained storage. |
| pi-fff | mechanical | FFF binary wrapper. |
| pi-hub | mechanical | Installer; reads package manifests. |
| pi-init | mechanical | Repo scan + prompt. |
| pi-kicad | mechanical | External binary bridge. |
| pi-model-tools | spike | Reasoning/thinking-level management — overlaps omp's model catalog + thinking controls; decide boundary. |
| pi-munin | mechanical | Direct SDK calls; no Pi API dependency. |
| pi-dashed entries (pi-notebooklm, pi-notify, pi-obsidian) | mechanical | External-API bridges or OS plumbing. |
| pi-permission | spike | `pi.getSetting` naming + `tool_call` block semantics; omp has its own approval flow (`tool_approval_requested/resolved` events) — align or de-scope. |
| pi-plan | spike | Read-only gating via `before_agent_start` + flags; omp plan mode overlap — decide keep vs drop. |
| pi-ponytail | mechanical | Prompt-injection hooks (`before_agent_start`); watch the string[] vs string divergence. |
| pi-references | mechanical | `before_agent_start` + alias roots; watch string[] divergence. |
| pi-review | mechanical | Worktree isolation via `pi.exec`. |
| pi-router | mechanical | Provider registration (OpenAI-compat). |
| pi-ponytail family (rtk/selfskills/themes) | mechanical | Self-contained or prompt-only. |
| pi-serena | mechanical | Persistent worker bridge; host-agnostic. |
| pi-sub | **drop** | omp subscription usage tracking replaces it. |
| pi-subagent | **drop** | omp first-class subagents + Agent Hub (#05) replace it. |
| pi-themes | mechanical | omp supports Pi themes. |
| pi-ux | mechanical | Design discipline via prompts + tools; `before_agent` prompt shaping — string[] watch. |
| pi-web | mechanical | SearXNG/Firecrawl/Crawl4AI bridges. |
| pi-windows-tools | mechanical | Windows-native plumbing. |

**Tally: 5 drop · 27 mechanical · 6 spike** (a2a, budget, checkpoint, model-tools, permission, plan).

## Porting order proposal

1. **Wave 1 (validate the surface):** pi-notify, pi-cron, pi-references, pi-ponytail, pi-classifier — together they touch every core API (events incl. `before_agent_start`, commands, flags, sendUserMessage, appendEntry, registerTool, settings read, the one pi-ai import). If these five load on omp, the other 22 mechanical ones follow.
2. **Wave 2:** the remaining mechanical extensions, batched by subsystem.
3. **Wave 3 (decisions before code):** the 6 spikes — each is an overlap/semantics question, not a typing one.
4. **Retire** the 5 drops after verifying omp equivalents meet our bar.
