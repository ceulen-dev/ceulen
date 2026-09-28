# Expanded Naming Round: π-Lineage Deep Cut (rev 5)

Date: 2026-09-28 (rev 5) · **DECIDED: `ceulen`** (confirmed by user, 2026-09-28) · Follows: `07-bundle-naming.md` revs 1–4 (twopi retracted, rudolph eliminated, ludolph/madhava pending). This round widens the field per user request — same methodology, all checks applied to every candidate, status-code-verified.

## New shortlist (all registry-clean unless noted)

| Name | The π story | npm | crates | PyPI | PATH/brew | GitHub exact | Companies |
|---|---|---|---|---|---|---|---|
| **ceulen** | Ludolph **van Ceulen**'s surname — the tombstone-digits man himself; "the Ceulen number" was π's name in parts of 17th-c. Germany | **free** | **free** | **free** | clear | 3 repos total, 0★ | none found |
| **wallis** | John Wallis — π's first infinite product (1655) and inventor of the **∞ symbol** | **free** | **free** | **free** | clear | personal sites only | only people (Michael Wallis, LinkedIn) |
| **plouffe** | Plouffe of **BBP** — compute any hex digit of π without computing any digit before it | **free** | **free** | **free** | clear | 51 fuzzy, all π-homage repos (8★ max) | a writer named Jim Plouffe |
| brouncker | Lord Brouncker — first continued-fraction for π, RS founding president | **free** | **free** | **free** | clear | **zero repos** — literally empty namespace | none |
| agnesi | Maria Agnesi — witch curve π (−1,1); first major female mathematician | **free** | **free** | **free** | clear | 1★ trivia | none |
| shanks | William Shanks — 707 digits, 527 right (the error found 92 yrs later) | free | free | free | clear | — | **semantically fatal**: a "shank" is a golf mis-hit / prison weapon |
| machin / viete / radian / kashi / etc. | (earlier rounds) | taken | — | — | — | — | — |

Also considered & eliminated fast: snell, lambert, huygens, vernier, astrolabe, sextant, azimuth, quadrature, cycloid, gyre, rota, orbis, leibniz, gregory, chudnovsky, spigot, cyclotomic — all registry-taken (instrument/concept names are heavily mined; the free ones were semantically wrong).

## Verdict: **`ceulen`** — with `wallis` as the safe-second *(DECIDED: ceulen, 2026-09-28)*

**The pitch**: Ludolph van Ceulen's tombstone carried π to 35 digits. His contemporaries literally called π *the Ludolphine number* — and in Germany, *die Ceulensche Zahl*. A bundle named **ceulen** is the same deepest lineage story as ludolph, minus the Rudolph-reindeer rhyme, minus the dormant PyPI binary, and with a **nearly empty namespace** (3 GitHub repos, 0 stars, total) — the rarest word on the board.

- Package: `@yourorg/ceulen` + bare npm `ceulen` (both free today — register same day)
- Command: `/ceulen config` — or plain `/config` inside the bundle
- Pronunciation: **KOY-len** (Dutch: "khoy-len") — two syllables, and unlike ludolph it doesn't trip the Rudolph pattern. English speakers will say "SOY-len/SEE-len" first-try; corrects in one hearing.
- The story keeps working with the misspelling problem fixed: no one else has claimed the tombstone man.

**Why not wallis (the safe-second):** equally clean, easier to say (WALL-is), inventing-the-∞-symbol is a genuinely great bundle metaphor ("everything, to infinity") — but it's a common English surname (806 fuzzy GitHub repos, a LinkedIn-full of Michael Wallises), so search uniquability is mediocre. Choose wallis over ceulen only if pronunciation-friendliness outranks uniqueness for you.

**Why not plouffe/brouncker/agnesi:** clean but the stories are weaker fits. BBP's "any digit without the preceding ones" is a *random-access* metaphor — cute for a database, wrong for "everything bundled". Brouncker's continued fractions don't say "bundle". Agnesi's "witch" is an unfortunate curve nickname.

**Standing from previous rounds** (unchanged): `ludolph` (one dormant-PyPI-binary caveat, best story, reindeer rhyme), `madhava` (fully clean, easy to say, common-name noise).

## Consolidated final table

| Rank | Name | Story | Clean-ness | Pronounceability | Uniquability |
|---|---|---|---|---|---|
| 1 | **ceulen** | tombstone π man himself | full sweep clean | medium (KOY-len) | **best** (3 repos total) |
| 2 | wallis | ∞ symbol inventor | full sweep clean | **best** (WALL-is) | medium (common surname) |
| 3 | madhava | π series pioneer | full sweep clean (incl. sdist) | good (ma-DHA-va) | medium (common given name) |
| 4 | ludolph | tombstone π man (given name) | 1 caveat (dormant PyPI bin) | good (LOO-dolf, reindeer rhyme) | good |
| 5 | plouffe | BBP random-access π | full sweep clean | medium (PLOOF) | good |

All five are npm-free today. Methods: status-code registry checks (npm/crates/PyPI), `which -a` PATH, brew formula+cask, GitHub exact-name, web company sweep, pronunciation assessment. Binary-in-package check (Rule 4: sdist inspection) pending only for PyPI-taken names — all five finalists are PyPI-free, so no artifacts to inspect.

Pre-commit: USPTO/EUIPO classes 9/42 sweep; same-day npm registration (bare name + org scope).
