# Naming Deep-Check

Date: 2026-09-27 · Candidates from doc 01: cinch, tau, yoke, hitch. All registries checked 2026-09-27.

## Verdict

**`hitch`** — the only candidate that survives all checks with zero meaningful collisions in the coding-agent / dev-tool space. **Second: `yoke`** (clean in category; only cross-domain noise).

**`cinch`** is eliminated by a soft but real collision (long-established macOS window manager on homebrew) despite the best semantics. **`tau`** is eliminated by a same-category direct hit.

## Scorecard

| Name | Semantics | npm | crates.io | GitHub coding-agent | Same-category collision | Verdict |
|---|---|---|---|---|---|---|
| **hitch** | to hitch a wagon — literal harness verb; "hit it" kin | taken v0.0.1 (dormant) | taken (48 dl, dormant) | none found | **none found** | **Winner** |
| **yoke** | literal harness synonym; 4 letters | taken v0.0.1 (dormant) | taken (609M dl — servo's yoke crate, unrelated domain) | none found | none found | Runner-up |
| cinch | harness girth + "easy" — best double meaning | taken v0.1.1 (dormant) | taken (44 dl) | none found | ⚠️ macOS window manager "Cinch" (homebrew cask, ~15y brand presence) | Eliminated |
| tau | τ = 2π — pi-lineage wink | taken v1.0.0 (dormant) | taken (16k dl) | direct hits (repos analyzing it) | **Hugging Face "Tau" coding agent** | Eliminated |

## Notes

- Bare npm names taken by dormant packages are **not blockers**: publish scoped as `@<org>/hitch` (org scope), binary still `hitch`. Same trick PiG uses (`@pi-in-go/pig`).
- `yoke`'s crates.io hit is servo's `yoke` crate (609M downloads) — big number, unrelated domain (borrowed-data abstraction in Servo). Only matters if we ever publish Rust crates under the bare name.
- cinch's macOS collision: verify current homebrew cask status before final commit if we ever revisit it.
- Already-taken in category from doc 01: rig, forge, crush, goose, codex, phi, jig.

## Trademark quick-check (pre-commit, not legal advice)

Before final commit: USPTO TESS + EUIPO search for "hitch" in IC 009/042 (software, dev tools); note GoDaddy/hitch "hitch" products exist in unrelated verticals (recruiting, dating) — different classes, low risk, but run the search.
