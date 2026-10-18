---
name: review
description: Post-completion verification gate. When a plan finishes executing, a substantial multi-file task is done, or before claiming "done" on non-trivial work — dispatch an independent reviewer pass over the working diff. Use when the user says "review before done", "verify the implementation", or when a plan-mode task completes.
---

# review — verify before done

The implementing session must not be its own verifier. An agent that says
"implementation complete" has not been verified — a fresh-context reviewer
checks the work against what was actually asked.

## When it fires

- An approved plan finishes executing (plan-mode exit → execution complete).
- Any substantial task ends: multi-file change, new module, security-relevant
  edit, or ≥ ~15 minutes of unattended agent work.
- Small single-file edits do NOT need this — deterministic checks suffice.

## The gate (one pass, one loop)

1. Capture scope: `git diff` (staged+unstaged) plus untracked files; if a
   plan file exists (`.pi/plans/`), read its acceptance criteria.
2. Dispatch the `reviewer` subagent (read-only, fresh context) with:
   - the diff scope,
   - the plan's acceptance criteria or the original task statement,
   - instruction to return severity-ranked, evidence-required findings
     (its built-in output contract already enforces this).
3. Optional, when tests exist: dispatch `tester` in parallel for
   typecheck/tests — deterministic evidence beats model judgment.
4. Triage findings: fix `critical`/`high`/`blocking` only. Medium/low go to
   the final report, not the revision loop.
5. ONE revision loop: fix, re-dispatch reviewer over the new delta only.
   A second round of findings → stop and report; do not spiral.
6. Final report to the user: reviewer verdict, what was fixed, what was
   deferred — the human reviews the diff last. This gate raises confidence;
   it does not replace the human.

## Noise controls (why one reviewer, not nine)

- ONE reviewer pass per gate. Parallel review fans burn tokens for <50%
  useful findings (measured; the 9-agent setups needed heavy tuning to hit 75%).
- Review AGAINST the plan/task acceptance criteria — not open-ended style.
- Evidence required (file:line) — discard findings without it.
- Advisor already reviews every settled turn; this gate adds only the
  task-end, whole-diff, fresh-context pass. Never stack both on the same turn.
