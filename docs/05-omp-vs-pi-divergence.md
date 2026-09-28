# OMP vs Pi: Fork Distance & Backport Behavior

Date: 2026-09-27 · Companion: `01-research-report.md`, `02-extension-compatibility.md`, `04-pig-vs-omp.md`

## TL;DR

omp **is a true git fork of pi-mono** — created 2025-12-31, pushed *with* upstream history, and diverged at commit `e045a9f` on **2026-01-30** (pi-mono ≈ v0.55 era). Since that fork point it has merged **zero** Pi commits: all seven months of upstream evolution (v0.56 → 0.87) reaches omp only as **selective ports**. It deliberately maintains a Pi compatibility surface (import rewriter `legacy-pi-compat.ts`, `pi.extensions` manifests, `PI_CODING_AGENT_DIR`, compat divergences tracked as issues), and its own velocity (~300 commits/month, 10 releases in 9 days) exceeds Pi's.

## 1. Relationship model: forked once (Jan 2026), never merged since

| Fact | Evidence |
|---|---|
| True git fork of `badlogic/pi-mono`: shared history up to merge base `e045a9f` (2026-01-30) | GitHub compare API: merge base present and reachable in omp |
| Not a GitHub-*network* fork (`fork: false`, no parent) — repo was created fresh and pushed with pi-mono history | GitHub API 2026-09-27 |
| No evidence of any post-fork-point Pi merge in omp | SHA spot-test (3 recent Pi `main` commits → HTTP 422 in omp — indicative, not exhaustive) **+** no upstream-sync branches exist (only `farm/*`, `ci/*`, follow-ups) **+** every "sync"-titled PR resolved as downstream-into-omp, none merged. Ported Pi content would land as omp-authored commits with new SHAs, so absence is argued from the missing sync machinery, not SHA scans alone |
| No upstream-sync branches in omp | branch list: only `farm/*`, `ci/*`, follow-up branches |
| Packages renamed: `@mariozechner/pi-*` / `@earendil-works/pi-*` → `@oh-my-pi/pi-*` (workspace catalog) | `packages/coding-agent/package.json` on main |
| Own version scheme: **v18.x** — the version tells you nothing about which Pi is inside | releases v18.2.6 (2026-09-18) → v18.3.4 (2026-09-27) |
| "Sync"-titled PRs in omp are **downstream forks syncing *into* omp** (f5-sales-demo/xcsh #653/#663, Raudbjorn/omp #808, Fguedes90 #330), all closed-unmerged — not omp←Pi backports | PR head/base inspection 2026-09-27 |

Consequence: omp's **Pi-behavior baseline is ~January 2026** (≈ v0.55). Everything Pi shipped after that — including all the breaking extension-API changes that hurt us (0.86 `TranscriptContext`, 0.87 `SessionManager`/`ContextEditEntry`) — is *not* in omp unless individually ported. omp's relationship to Pi is behavioral compatibility by intent + cherry-picked ports, maintained as a product decision — the same maintenance posture we'd have with our own harness, with can1357 paying the bill.

## 2. Divergence inventory (how far it's gone)

| Area | Pi | omp |
|---|---|---|
| Core language | TypeScript throughout | TS surface + ~80k LOC Rust core (`@oh-my-pi/pi-natives` — in-process rg/glob/find/brush bash + 58 utils) |
| Edit tool | `str_replace`-family | **hashline** (content-hash anchors; +15pp avg over patch across 15/16 models) |
| Tool surface | ~13 built-in tools | 31 built-in tools + LSP ops (14) + DAP ops (28) |
| Subagents | SDK-level | First-class: worktree isolation, Agent Hub UI, schema-typed yields |
| Extension API | Pi 0.8x `ExtensionAPI` | pi-mono Jan-2026 API + omp additions + selective backports — **not** a superset of current Pi: `deliverAs`, `tool_approval_requested/resolved`, `agent_end.willContinue` exist; `before_agent_start.systemPrompt` is `string[]` vs Pi's `string` ([#12511](https://github.com/can1357/oh-my-pi/issues/12511)) |
| Schema builders | zod | zod-shim + arktype + typebox (all three) |
| Providers | Pi's set | 60+ |
| Config root | `~/.pi`, `.pi/` | `~/.omp`, `.omp/` (native); **legacy `.pi` partially accepted** in manifests/env |
| Reviewer model | — | advisor role wired into every turn |
| Memory | — | retain/learn/recall + engine backends |
| Velocity | ~0.93 releases/day | ~1.1 releases/day (10 in 9 days), ~300 commits/month |

**Verdict on "how far":** implementation-wise, far (Rust core, edit format, tool surface — a different product). Interface-wise, close by design (extension API is a superset with a handful of documented divergences).

## 3. Does omp backport from Pi? Yes — selectively and fast

Evidence from commit history, issue tracker, and release timeline (2026-09 sample):

| Upstream Pi change | Pi release | Landed in omp | Lag |
|---|---|---|---|
| Cache-warming strategy (Pi 0.86.0 headline feature) | 2026-09-19 | ported 2026-09-21 → merged #12699 2026-09-27 | **2–8 days** |
| `RegisteredTool.sourceInfo` compat fix | — | 2026-09-11 ("for upstream pi compat") | days |
| `before_agent_start.systemPrompt` divergence report | — | 2026-09-19 (#12511, closed = resolved) | days |
| Upstream-pi editor constructor in `CustomEditor` | — | 2026-07-14 | weeks |

Pattern: **compat-critical fixes are treated as bugs** (fast); **headline features are treated as backlog** (ported on merit, days-to-weeks); **architectural changes are not ported at all** (omp's session handling, compaction — snapcompact — and edit pipeline are its own). Roughly 2% of omp's ~300 monthly commits are upstream-port flavored — cherry-picking against a frozen Jan-2026 baseline, not tracking.

## 4. The compat layer (what actually protects our extensions)

From omp's `docs/extension-loading.md`:

- `src/extensibility/plugins/legacy-pi-compat.ts` — **in-place module-graph loading + host-package import rewriting**: an extension importing `@earendil-works/pi-*` / `@mariozechner/pi-*` is rewritten to omp's packages at load time.
- Package manifests: `pi.extensions` arrays still honored (alongside `omp.extensions`).
- `PI_CODING_AGENT_DIR` env var honored; `.omp/extensions` is the native discovery root (`.pi/extensions` is NOT auto-discovered — extension *paths* from manifests/settings still work).
- Upstream divergences are filed as issues titled "Compatibility report: …" and get closed fast.

For **our** 38 extensions this is close to ideal: they import nothing (plain JS, runtime `pi` object), so the only exposure is the event/method surface. But note the baseline caveat: omp carries the pi-mono Jan-2026 API plus additions — any Pi API *we* adopted after January (e.g. the 0.87 `SessionEntry.context_edit` machinery) would not exist there. Audited surface in doc 02 is old-stable APIs (`on`, `registerTool`, `sendUserMessage`, …), all present.

## 5. Implications for our decision

1. **Doc 04's verdict stands, with a sharpened caveat:** adopting omp means adopting a **Jan-2026 Pi base plus omp's own trajectory** — a large, deliberate fork distance — not "current Pi plus extras". It does not free us from treadmill-chasing; it swaps Pi's treadmill for a slightly faster one. Mitigation identical either way: **pin the base, sync on our schedule**.
2. **The compat layer de-risks wave 1 further**: even the one real import in our fleet (pi-classifier → `@earendil-works/pi-ai`) is covered by `legacy-pi-compat.ts` import rewriting. Keep it anyway as a canary for rewrite failures.
3. **Version-scheme opacity is a real cost**: omp v18.x gives no hint of embedded Pi behavior. For auditing, track omp's compat-report issues + their changelog, not version math.
4. **Fork-of-fork precedent exists and works**: third parties (sorcerai/oh-my-pi etc.) run standing "sync with upstream OMP vX.Y.Z and preserve custom integrations" workflows — merge-based, unlike omp↔Pi. That's the model we'd imitate if we fork omp: small divergence set + periodic disciplined merges.

## Sources

- GitHub API 2026-09-27: repo metadata (`fork: false`), releases (v18.2.6→v18.3.4), 300-commit sample, issue search
- omp docs: `extensions.md`, `extension-loading.md` (legacy-pi-compat.ts, pi.extensions, PI_CODING_AGENT_DIR)
- omp issues #12511 and port/backport commits (cache-warming #12699)
- Pi CHANGELOG 0.86.0 (local install) for cache-warming release date
