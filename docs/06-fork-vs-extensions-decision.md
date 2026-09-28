# Decision: Fork-and-Rebrand OMP vs Maintain OMP-Extensions

> **⚠ SUPERSEDED (2026-09-28, the day after):** after extended real-world OMP usage, the decision changed — **Pi core + one big consolidated bundle extension** (unified `/config`, selective OMP feature adoption). See `architecture/final-decision-pi-bundle-approach` in memory and the naming discussion that followed. The analysis below remains valid as the fork-vs-extensions comparison it set out to be; only its recommendation was overtaken by events.

Date: 2026-09-27 · Question: (A) fork omp, rebrand, trim, and periodically merge upstream omp — or (B) maintain an `omp-extensions` suite that layers on stock omp without touching its core?

## TL;DR

**(B) — omp-extensions, on stock omp — is the right first move.** Your entire 38-extension fleet is plain-JS runtime-object extensions using only the public API (`on`, `registerTool`, `registerCommand`, `registerFlag`, `sendUserMessage`, `appendEntry`, `exec`, `ctx.ui`) — including all six former "spikes" (a2a: 7 tools + 9 commands; plan: 2 tools + 9 commands + 1 flag; budget: `message_end`; permission: `tool_call` blocking — a pattern omp's own docs use as the canonical example). **Zero capability gap.** The fork (A) buys trim-control and rename rights you don't need yet, at the cost of a merge treadmill against a project shipping ~1.1 releases/day — the exact disease you're fleeing, just with a faster virus.

Keep (A) as a documented escalation path, not the starting point.

## The Yardmaster lesson, applied

Your own precedent: Omniroute doesn't do its jobs → you built Yardmaster. The successful pattern was **replace the failing component at the edge** — not fork the router and maintain a divergent core. Apply the same rule here: when stock omp ships something wrong or bloated, the first remedy is an extension that overrides/disables it (`disabledExtensions`, `setActiveTools`, tool-call blocking), and only a *persistent* failure of that route justifies touching core.

## Side-by-side

| Dimension | A: Fork + rebrand + trim | B: omp-extensions on stock omp |
|---|---|---|
| Initial cost | Rebrand sweep, CI, release infra, trim audit of a 25k-commit/650MB repo | ~Zero: wave-1 port already scoped (5 extensions touch every core API) |
| Upstream omp releases (~1.1/day) | Merge-or-drift decision every time; conflicts in trimmed areas are permanent scar tissue | Absorb for free; our code rides the public API with omp's own compat layer (`legacy-pi-compat.ts`) as extra armor |
| Getting stuff you don't want | You can delete it — *and* you must re-delete it after every merge | You can disable it (`disabledExtensions`, settings); binary stays bigger — **this is the real price of B** |
| Hashline/LSP/DAP/subagent R&D | You fund integration of omp's changes yourself | Free, continuously — this is the whole point |
| Vendor/model churn fixes | Yours | Theirs (they survive vendor bans for a living) |
| Identity | Your brand, your name (`hitch`) | Their brand; your suite is the brand ("the omp-extensions distro") |
| Lock-in risk | Low (MIT; you own the repo) | Low (MIT; extensions are portable back to Pi — they're plain JS) |
| Exit cost to A later | — | Cheap: extensions port *into* a fork unchanged; nothing is wasted |
| Waste you accept | Trimmed features rot; merges grow harder monotonically | Carrying omp's unused surface in the binary |

## Why B wins on the treadmill math

omp's velocity (~300 commits/month, 10 releases in 9 days) **exceeds Pi's** — the thing that drove you away from Pi. Forking omp re-creates the treadmill with a faster upstream:

- Every trim you make is a conflict at next merge (the Raudbjorn/omp sync PR #808: 336 upstream commits, **20 conflicts**, resolved by squash-flattening — and that fork only carried ~118 custom commits; trims are worse than additions).
- Third-party omp forks solve this with standing "sync-with-upstream + preserve integrations" workflows — real and workable, but it's a *paid maintenance role*, forever.

The extension path converts that recurring cost into a one-time port (days) plus occasional compat fixes against a documented, superset-stable API whose divergences omp itself tracks as "Compatibility report" issues.

## What you give up with B (be honest about it)

1. **Binary bloat stays** — omp's unused features ride along. Mitigation: `disabledExtensions` + not installing what you don't use; memory pain is bounded (it's a local CLI, not a server).
2. **No rename** — the product is `omp`, not `hitch`. Your identity lives in the suite name and a Piglet-style composition (YAML selection of your extensions + defaults → one install). If identity later matters enough, that's the trigger to execute path A.
3. **You can't fix omp core bugs same-day** — you file issues or carry a patch. For core-level wrongness that persists across releases, that's the second trigger for A.

## Escalation triggers (when to graduate B → A)

- An extension-blocking omp bug open >1 release cycle with no upstream fix.
- A needed hook/event omp won't add (would require core change).
- Branding/product identity becomes a requirement (external users, packaging).
- omp's core direction drifts against your needs repeatedly (the "Omniroute pattern" recurring at core level).

Until any trigger fires, B is strictly cheaper and loses nothing important.

## Recommended plan

1. Pin an omp version (e.g. v18.3.x line) as the supported base; upgrade on a fixed cadence (monthly or on-security), not per-release.
2. Port wave 1 (notify, cron, references, ponytail, classifier) — validates the entire API surface in one pass; `before_agent_start.systemPrompt` string[] normalize is the only known code change.
3. Port waves 2–3 (27 mechanical; then a2a, budget, checkpoint, model-tools, permission, plan — now confirmed plain-API, so they're port-and-test, not design).
4. Drop the 5 omp-replaced extensions (advisor, sub, subagent + budget/model-tools overlap candidates after testing omp's built-ins).
5. Ship as a composition: one install command that lays down your suite + settings + themes over stock omp.
6. Revisit this decision only on an escalation trigger.

## Postscript: the earlier fork-review verdicts still stand

- If a fork *does* become warranted later: MIT (Zechner → Bölük → Stencil Labs copyright chain) permits rebrand; keep notices; the merge workflow to imitate is Raudbjorn's squash-merge sync, with trims minimized (disable, don't delete, wherever possible) to keep future merges cheap.
- Doc 05's evidence wording already softened per review: "no *evidence of* any post-fork-point Pi merge" (SHA spot-test indicative + no sync branches + all sync-PRs resolved downstream).
