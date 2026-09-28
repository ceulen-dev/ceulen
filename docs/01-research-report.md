# Research: Own Harness vs Staying on Pi Upstream

Date: 2026-09-27 · Status: complete · Companion docs: `02-extension-compatibility.md`, `03-naming-deep-check.md`, `04-pig-vs-omp.md`

## TL;DR

**Do not write a harness from scratch.** The ecosystem already contains two cheaper paths that each solve our actual problem (Pi's ~1-release/day cadence breaking our 38 extensions):

- **Adopt [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi)** — a Pi fork that *is* "Pi + the pi-extensions idea pre-bundled" (33.4k★, Rust core, batteries included). Our extensions are Pi-TS-API-shaped, so porting is mostly mechanical.
- **Or fork [PiG](https://github.com/MichaelKinsy/PiG)** — a faithful Go port of Pi 0.87.1 with parity ledgers designed exactly to decouple our sync cadence from upstream's release cadence.

Either way: **pin upstream, sync on our schedule.** That — not a new language — is the cure for the treadmill.

## 1. Earendil manpower assessment: healthy; cadence is the enemy

| Signal | Finding |
|---|---|
| Company | Earendil Inc, Public Benefit Corporation, founded 2025 by Armin Ronacher (Flask, ex-Sentry) + Colin Daymond Hanna |
| Backers | Accel (Daniel Levine), Balderton (Daniel Waterhouse), founders of n8n, OpenClaw, Revolut, Sentry, Slack |
| Pi team | ~7: badlogic/Mario Zechner (3,769 commits), mitsuhiko (736), davidbrai (272), christianklotz (201), cristinaponcela (197), vegarsti (158) + community |
| Mario's stake | Joined 2026-04-08 as **major stakeholder**; explicitly chose Earendil to avoid a RoboVM-style OSS betrayal ([his post](https://mariozechner.at/posts/2026-04-08-ive-sold-out/)) |
| Health | 109,598★ · MIT · 13.9k forks · pushed daily · last 100 commits all within one month |

Sources: [announcement](https://earendil.com/posts/announcing-pi-and-lefos/), [aiwiki](https://aiwiki.ai/wiki/pi_agent), GitHub API 2026-09-27.

**Verdict:** Manpower is NOT the risk. A 7-person team maintains Pi comfortably. The risk for *us* is structural:

- **278 releases from 0.10.0 (2025-11-26) to 0.87.1 (2026-09-22) ≈ 0.93 releases/day for 10 months.**
- Breaking extension-API changes still land (0.87.0: removed `shouldStopAfterTurn`, changed `SessionManager` semantics, added `ContextEditEntry` to the `SessionEntry` union; 0.86.0: provider stream inputs `Context` → `TranscriptContext`).
- No small team can give downstream extension authors API stability at that cadence. **Our maintenance pain is the direct product of their velocity, not of fragility.**

Owning a harness removes the dependency but inherits 100% of the treadmill (model releases, provider auth churn, edit-format tuning, OS quirks). The forks below exist precisely because others hit this same wall.

## 2. The fork ecosystem (this changes the decision)

### oh-my-pi (omp) — can1357 / Stencil Labs — 33,413★ (created 2025-12-31)

Pi fork, batteries-included, ~80k-line Rust core under a TS surface: hashline (hash-anchored) edits, LSP wired into every write, DAP debugging (lldb/dlv/debugpy), persistent Python/Bun kernels that call back into agent tools, first-class subagents in worktrees + Agent Hub, advisor reviewer model, collab sessions over relay, in-process ripgrep/glob/find/brush-bash (zero fork-exec), ACP editor support, curated memory engines, 60+ providers.

The [harness-problem post](https://blog.can.ac/2026/02/12/the-harness-problem/) is the decisive datapoint for "harness quality ≈ model upgrade":

- Changing **only the edit format** (hashline vs OpenAI patch) moved **15/16 models, avg +15pp**.
- Grok Code Fast 1: 6.7% → 68.3% pass rate (10×). Grok 4 Fast: −61% output tokens.
- "The model is the moat. The harness is the bridge."

### PiG — MichaelKinsy (built at HPE) — 192★, first release 2026-09-17

Faithful **Go port of Pi 0.87.1**, one native binary, no Node. Package map mirrors Pi (`agent/ ai/ coding/ tui/`). **Runs Pi's TypeScript extensions unchanged**, plus Go, Rust, Python extension SDKs. Piglet compositions = named YAML selection of extensions/skills/prompts → distributable agent (our "ready harness" idea, already implemented). Parity machinery: `PORT_MAP.md`, `parity/coverage.md`, `parity/upstream-sync/` ledgers, `DIVERGENCES.md`.

Proves two things: (1) multi-language extension support is a solved pattern (in-process native SDKs + TS compat host), not research; (2) "track upstream without chasing it" has a working template.

## 3. Language survey

| Harness | Language | Rationale |
|---|---|---|
| Codex (OpenAI) | Rust (rewritten from TS 2025-06) | single binary, no Node, native sandbox: macOS Seatbelt + Linux Landlock/seccomp ([Simon Willison's analysis](https://simonwillison.net/2025/Nov/9/codex-sandbox-investigation/)) |
| Claude Code, Gemini CLI, OpenCode, Aider | TS / Python | iteration speed, ecosystem |
| Goose (Block → Linux Foundation), Forge | Rust | perf, single binary |
| Crush (Charm) | Go | bubbletea/lipgloss — strongest TUI stack anywhere; LSP, multi-model |
| Pi | TypeScript | extension ecosystem |
| PiG | Go | single binary + Pi TS extension compat |
| omp | TS + Rust core | hybrid: extension ecosystem + native perf |

Findings that cut against assumptions:

- **Sandboxing is not Rust-exclusive.** The Landlock maintainers themselves ship [`landlock-lsm/go-landlock`](https://github.com/landlock-lsm/go-landlock); macOS Seatbelt is driveable via `sandbox-exec` profiles from any language. Codex's Rust choice was partly "we rewrite everything anyway."
- **The TUI is the real differentiator**, and Go's Charm stack (bubbletea v2/lipgloss) leads; Rust ratatui is capable but more DIY.
- **Go beats Rust on total cost here**: fast compiles (matters while chasing a moving upstream), easy onboarding, goroutines for streaming loops, static binary. Rust's wins (memory, zero-GC) are marginal for an I/O-bound agent loop that waits on HTTP streams all day.
- **But our 38 extensions are TypeScript.** The deciding constraint is a TS compat host (PiG) or a TS-surfaced fork (omp) — not the core language.

## 4. Extension architecture

PiG's model (working code, adoptable):

1. **Native extensions** (Go/Rust/Python) register tools, commands, event handlers, flags, shortcuts, providers, UI contributions in-process.
2. **TS compatibility host** — Pi extensions run unchanged against compatible runtime modules.
3. **Compositions** (Piglets) — named, versioned selection of resources → one install for end users.

Yes: any language is supportable given a defined extension API + lifecycle hooks; MCP adds universal interop on top.

## 5. Recommendation

1. Don't build harness #3 from scratch — PiG (Go) and omp (batteries) already cover both halves of the idea.
2. Primary: **adopt omp as base**, port pi-extensions onto it (see `02-extension-compatibility.md` for the per-extension audit), retire the ~6 extensions omp replaces.
3. Alternative (if Go + full ownership is the goal): **fork PiG**, lean on its parity ledgers, run our TS extensions through its compat host (needs a validation spike first — compat host is young).
4. Either way: pin upstream, sync quarterly or on breaking-model events, publish our own composition.

## Sources

- earendil.com/posts/announcing-pi-and-lefos/ · mariozechner.at/posts/2026-04-08-ive-sold-out/ · lucumr.pocoo.org/2026/4/8/mario-and-earendil/
- blog.can.ac/2026/02/12/the-harness-problem/ · github.com/can1357/oh-my-pi · github.com/MichaelKinsy/PiG
- simonwillison.net/2025/Nov/9/codex-sandbox-investigation/ · github.com/landlock-lsm/go-landlock
- Local evidence: `@earendil-works/pi-coding-agent` 0.87.1 CHANGELOG (278 releases), GitHub API repo/contributor/commit stats 2026-09-27
