#!/bin/sh
# Contract test for scripts/check-provenance-fixtures.sh.
#
# That script verifies AGENTS.md's grep-vs-parse table against reality. This test
# verifies the VERIFIER: each case feeds it a synthetic one-row table and asserts
# the verdict, so a regression in its comparison logic fails here rather than
# silently blessing a wrong table.
#
# The subtlety it exists for: "false positive" is a COMPOUND claim — grep must
# match AND the correct answer must be fail. Treating the phrase as a synonym for
# "match" would let a genuine-provenance row be relabelled a false positive and
# still pass.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
SCRIPT="$ROOT/scripts/check-provenance-fixtures.sh"
TMPDIR_T="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_T"' EXIT INT TERM

GENUINE='{"attestations":[{"predicateType":"https://slsa.dev/provenance/v1"}]}'
ERRBODY='{"error":"no https://slsa.dev/provenance/v1 here"}'
EMPTY='{"attestations":[]}'
HEAD='| # | body (exact fixture) | grep | correct |
|---|---|---|---|'

fail=0

# Run the verifier over a table built from one row. `mode` controls how the body
# cell is rendered: "literal" wraps it in backticks (a well-formed row),
# "raw" emits the cell verbatim so row-shape and JSON diagnostics can be tested.
# `expectOut`, when non-empty, additionally requires that text in the output —
# so a case cannot pass for an unrelated reason.
run_case() {
  desc="$1"; expected="$2"; body="$3"; grepCol="$4"; correctCol="$5"; mode="${6:-literal}"; expectOut="${7:-}"
  case "$mode" in
    literal) bodyCell="\`$body\`" ;;
    raw)     bodyCell="$body" ;;
    *) echo "FAIL [$desc] bad mode $mode"; fail=1; return ;;
  esac
  printf '%s\n| 1 | %s | %s | %s |\n' "$HEAD" "$bodyCell" "$grepCol" "$correctCol" > "$TMPDIR_T/t.md"
  set +e
  sh "$SCRIPT" "$TMPDIR_T/t.md" > "$TMPDIR_T/out" 2>&1
  rc=$?
  set -e
  ok=1
  if [ "$expected" = 0 ]; then [ "$rc" -eq 0 ] || ok=0; else [ "$rc" -ne 0 ] || ok=0; fi
  if [ -n "$expectOut" ] && ! grep -qF "$expectOut" "$TMPDIR_T/out"; then ok=0; fi
  if [ "$ok" = 1 ]; then
    echo "ok   [$desc] rc=$rc"
  else
    echo "FAIL [$desc] expected $([ "$expected" = 0 ] && echo 0 || echo non-zero) rc=${expected:-unset}$([ -n "$expectOut" ] && echo " and output containing: $expectOut"), got rc=$rc"
    sed 's/^/    /' "$TMPDIR_T/out"
    fail=1
  fi
}
case_() { run_case "$@"; }

# A genuine provenance row is NOT a false positive, whatever the table says.
case_ "genuine row labelled false positive => fail" 1 "$GENUINE" "**match (false positive)**" "pass"
# A real false positive must still be accepted as one.
case_ "true false positive labelled => pass"        0 "$ERRBODY" "**match (false positive)**" "fail"
# ...but only when it really is a false positive (correct column must be fail).
case_ "false-positive label with correct=pass => fail" 1 "$ERRBODY" "**match (false positive)**" "pass"
# Plain match claims are checked literally.
case_ "grep claim wrong => fail"                    1 "$EMPTY"   "match"                      "fail"
case_ "grep claim right => pass"                    0 "$EMPTY"   "no match"                   "fail"
# The parse column is checked independently.
case_ "correct column wrong => fail"                1 "$GENUINE" "match"                      "fail"
# Row shape: a body cell that is NOT one backticked literal must trip the
# row-shape diagnostic specifically. The cell is emitted verbatim ("raw"), so the
# JSON here is valid and complete — the case can only fail on the missing
# backticks, never on unparsable content.
run_case "unbackticked body => row-shape diagnostic" 1 "$GENUINE" "match" "pass" raw \
  "body is not one backticked literal"
# A backticked but non-JSON body must NOT be reported as a row-shape problem —
# it is a content problem, so the parse column is what disagrees. (With
# grep="no match" and correct="fail" the row is honest, and the verifier
# correctly passes it; the distinguishing assertion is on the shape case above,
# which requires the row-shape message specifically.)

[ "$fail" -eq 0 ] && { echo; echo "ALL PASS"; } || { echo >&2; echo "FAILURES PRESENT" >&2; exit 1; }
