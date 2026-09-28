# PiG-Fork vs OMP-Fork: In-Depth Comparison

Date: 2026-09-27 · Question: if we own our harness, which base do we fork — PiG (Go port of Pi) or oh-my-pi (batteries-included Pi fork)?

## TL;DR

**Default: fork omp.** It is the fastest path to a "Pi + our pi-extensions pre-bundled" harness with the strongest engineering (hashline edits, LSP, DAP, subagents), a huge community (33.4k★), and the porting cost is small (27 mechanical + 6 spike + 5 drop, per `02-extension-compatibility.md`).

**Fork PiG only if Go + a small binary without Node is a hard requirement** — accepting a young compat host (released 2026-09-17), 192★ community, and the need to validate all 38 extensions against its TS extension host before trusting it.

## Dimension-by-dimension

| Dimension | oh-my-pi (omp) | PiG |
|---|---|---|
| Base | Pi fork (TS surface + ~80k LOC Rust core) | Faithful Go port of Pi 0.87.1 (parity-bound translation) |
| Stars / community | 33,413★, 3,559 forks, active daily | 192★, 13 forks, released 2026-09-17 |
| Maturity | ~9 months of real-world hardening | 10 days old |
| Upstream tracking | Manual sync from Pi; tracks Pi-compat divergences as issues (e.g. #12511) | **Structural**: PORT_MAP.md + parity ledgers + upstream-sync tracking + DIVERGENCES.md |
| Extension model | Pi TS extension API, extended (registerProvider, deliverAs, arktype/typebox) | **Runs Pi TS extensions unchanged** + Go/Rust/Python native SDKs |
| Piglet-style compositions | No direct equivalent (packages + skills) | **Piglets** — YAML resource selections → named agent → own binary |
| Edit tool | hashline (hash-anchored) — +15pp avg over patch across 15/16 models | Pi's edit tool as of 0.87.1 |
| LSP | Wired into every write (rename → workspace/willRenameFiles) | Port of Pi's LSP support (whatever 0.87.1 has) |
| DAP debugging | lldb/dlv/debugpy attach | None (Pi 0.38x has none either) |
| Subagents | First-class, worktrees, Agent Hub, schema-typed yields | Pi's subagent surface as ported |
| Sandbox | None shipped (same as Pi) | None (explicitly states "does not provide a security sandbox") |
| TUI | Pi TUI (mariozechner's ink-based) | Port of Pi TUI in Go |
| Install | curl/bun/brew/nix, macOS+Linux+Windows | curl/npm/go install, macOS+Linux, **Windows preview** |
| Traction | omp.sh marketing, benchmarks published, vendor bans survived | HPE origin, governance docs, serious parity discipline |
| License | MIT | MIT |
| Our TS extensions | Run with ≤ mechanical changes (per doc 02) | Unverified — compat host is 10 days old |

## The decisive argument each way

**For omp:** we are not building a harness to own Go; we're building it to stop chasing Pi. omp already absorbed the Pi treadmill for 9 months *and* pre-built the features we've been assembling as 38 extensions. Porting cost is measured in days (wave 1: 5 extensions touch every core API). Bonus: hashline alone is a +8–15pp edit-accuracy upgrade for every model we use.

**For PiG:** if the goal is a small, single Go binary with zero Node runtime — kiosk/CIED/air-gapped deploy, embedding into Go tooling — PiG is the only option of the two. Its parity-ledger machinery is also the best-in-class template for tracking Pi without chasing it, and Piglets are exactly our "ready harness" distribution idea.

## The hybrid (worth stating, not recommended now)

PiG-fork + port our extensions via its TS compat host + cherry-pick omp's innovations (hashline as the edit format first — it's self-contained in omp's edit tooling). Highest ceiling, highest cost: two sync tracks (PiG→Pi, ours→PiG) and a young compat host. Only if Go is a hard requirement.

## Decision rule

- Hard requirement "must be Go / no Node" → **fork PiG** (and budget a compat-host validation spike on our 38 extensions first).
- Otherwise → **fork omp**, port waves 1–3, retire drops, publish our composition.

## Sources

- github.com/can1357/oh-my-pi (README, docs/extensions.md) · github.com/MichaelKinsy/PiG (README, PORT_MAP.md, parity/, DIVERGENCES.md) · blog.can.ac/2026/02/12/the-harness-problem/
- oh-my-pi issue #12511 (before_agent_start divergence tracking)
