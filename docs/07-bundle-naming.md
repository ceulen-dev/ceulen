# Bundle Naming Deep-Check (Pi-core + one-bundle-extension product) — REVISED

Date: 2026-09-28 (rev 4) · Product: Pi coding-agent core + our 38 extensions consolidated into one bundle with unified `/config` (decision `architecture/final-decision-pi-bundle-approach`). Companion: `03-naming-deep-check.md`.

> **✅ FINAL (2026-09-28): the bundle is `ceulen`** — decided in `08-expanded-naming.md` after the expanded round. See doc 08 for the full final board and registration actions.

## Retraction

**`twopi` (rev 1's winner) is disqualified.** Graphviz ships a `twopi` radial-layout binary — installed on this machine at `/opt/homebrew/bin/twopi` (graphviz 16.0.0) and on essentially every dev machine with graphviz installed. A PATH-binary collision with a ubiquitous package is fatal for a CLI product. Rev 1 also booked a failed web sweep (brave returned 0 results on an OR-query) as "no companies found" — methodology error, corrected below.

Rev 1's registry table remains valid (status-code-verified) except the verdict row; this rev re-runs the decision with the missing check.

## Verdict (rev 4): **`ludolph`, now with a disclosed PyPI-binary collision — decision required**

**The π name to end π names**: Ludolph van Ceulen (1540–1610) spent his life computing π to 35 digits — carved on his tombstone. His constant was literally called *the Ludolphine number* (Ludolphsche Zahl) for two centuries. A Pi-harness bundle named ludolph is the deepest-cut lineage joke available. Verdict after rev-4 artifact inspection: **usable if we accept the disclosed PyPI collision; fall back to `madhava` if not.**

The collision, precisely scoped: the dormant (2017) PyPI package `ludolph` ships a PATH binary via distutils `scripts=` — anyone who has ever `pip install`ed that bot has a `ludolph` executable. That's the same collision *class* that killed twopi, but with a much smaller blast radius: a 9-years-dormant monitoring bot (42★) versus graphviz's near-ubiquity. Our product is an npm package invoked through `pi` — we ship no competing `ludolph` binary — so the practical risk is name confusion and pip-vs-npm install shadows, not PATH breakage. Registry state that remains clean: npm **FREE**, crates.io **FREE**, no brew formula, no companies, GitHub exact-name max 42★ (the same bot).

| Check | Result (2026-09-28, status-code-verified) |
|---|---|
| npm `ludolph` | **FREE** |
| crates.io `ludolph` | **FREE** |
| PyPI `ludolph` | ❌ TAKEN — "Monitoring Jabber Bot" (erigones/Ludolph), dormant since 2017 (v1.0.1, 2017-07-20). **Ships a PATH binary**: released sdist setup.py line 65 `scripts=['bin/ludolph']` (distutils scripts=) — `pip install ludolph` installs an executable `ludolph` into PATH. Same collision class that killed twopi, smaller blast radius (a dormant Python bot vs graphviz's ubiquity) — but no longer cleanable to "no collision" |
| Binary collision (`which -a`) | **none** |
| brew standalone formula | none |
| GitHub exact-name | 5 repos, largest 42★ (a 2010s Python Jabber bot, unmaintained) — no category collision |
| AI/startup space (web sweep) | no Ludolph companies; only generic startup-listicle noise |

**Why it wins over the field:**

- `madhava` (runner-up) — Madhava of Sangamagrama, the π series pioneer. Equally great story. PyPI-taken by a dormant 2023 hobby package ("Madhava Formula to find π", v0.0.1) whose sdist ships **no** `scripts=`/`entry_points`/bin files → no PATH binary. It loses to ludolph only on search uniquability: a common Indian given name (LinkedIn directories, "Madhava Group of Companies"). If the ludolph PyPI binary is disqualifying, madhava is the fallback.
- `viete` — registries clean, but viete.io startup collision (unchanged from rev 1).
- `buffon` — clean but the needle-probability joke doesn't say "Pi lineage".
- `toma`, `twopi`, `tau`, `cinch`, `hitch`, `radian`, `kai`, `machin`, `milu`, `kashi` — eliminated (see eliminations table below).

## Practical surface

- Package: `@yourorg/ludolph` (npm `ludolph` also free today — register both same day)
- Command: `/ludolph config` (or plain `/config` inside the bundle)
- The pitch writes itself: *"Ludolph spent his life on the digits of π. We spent ours on the tools around it."*
- Tombstone aesthetics: `π ≈ 3.14159265358979323846 264338327950288` makes a good ASCII logo / loading spinner.

## Full eliminations ledger (both rounds)

| Name | Fate |
|---|---|
| twopi | **DQ after winning rev 1** — graphviz PATH binary (`twopi(1)`, radial layouts) |
| toma | Toma Auto — YC W24, $17M a16z, AI voice agents; owns "toma AI" search |
| tau | Hugging Face Tau coding agent (doc 03) |
| cinch | macOS window manager, ~15y brand (doc 03) |
| hitch | named the never-built Go harness concept; dead (doc 03) |
| cockpit | Fedora Cockpit (naming discussion, pre-doc-07) |
| radian / kai / machin | registries taken (doc 07 rev 1) |
| milu | npm taken + Milu Health AI company |
| kashi | npm actively maintained (v6.0.0, 2026-09-12) |
| viete | viete.io dev-tools startup + Chengdu Viete Tech |
| madhava | clean but common given name → weak search uniquability (runner-up) |
| forge/crush/goose/rig/jig | taken (doc 01/03 rounds) |
| rudolph | Eliminated on user proposal (2026-09-28): npm taken (dormant UI lib), crates taken, PyPI taken by **RuDOLPH multimodal transformer** (AI-space collision), **airbnb/rudolph** (113★, Santa sync server with its own `rudolph` CLI) in the dev-tool namespace, permanent reindeer association — and the historical link is void: the mathematician is Ludolph van Ceulen, not Rudolph (different Germanic name). Renaming to Rudolph would sever the lineage joke that motivated the name |

## Methodology addendum (three rules from these failures)

1. **PATH-binary check is mandatory** for CLI names: `which -a <name>` locally + check major package managers for binaries *inside* packages (brew formula file lists, apt `dpkg -S`), not just standalone formulas. A name that collides in PATH is dead regardless of registry availability.
2. **A failed search is not a clean result.** Brave/SearXNG returning 0 results or erroring must be recorded as "unchecked", never "no collisions found". Rev 1's "zero AI/startup collisions" for twopi rested partly on exactly that error.
3. *(rev 3)* Apply the full registry sweep to the **winner**, not just eliminated candidates — rev 2 checked PyPI for toma but not for ludolph/madhava until review caught it. "Clean" claims inherit every check the losers got.
4. *(rev 4)* **Binary checks must inspect the released artifact, not the repo HEAD, and must cover all three mechanisms**: `entry_points`/`console_scripts`, distutils `scripts=`, and bin files in the file list. Rev 3 grepped only `entry_points` on master and declared "no console-script binary" — the released sdist's `scripts=['bin/ludolph']` (line 65) proved otherwise. Download the sdist, list the files, read the setup.py that shipped.

Pre-commit (not legal advice): USPTO/EUIPO sweep for "ludolph" in classes 9/42; npm `ludolph` + org scope same-day registration.
