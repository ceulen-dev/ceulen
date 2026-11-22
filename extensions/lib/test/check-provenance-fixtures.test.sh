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
case_() {
  desc="$1"; expected="$2"; body="$3"; grepCol="$4"; correctCol="$5"
  printf '%s\n| 1 | `%s` | %s | %s |\n' "$HEAD" "$body" "$grepCol" "$correctCol" > "$TMPDIR_T/t.md"
  set +e
  sh "$SCRIPT" "$TMPDIR_T/t.md" > "$TMPDIR_T/out" 2>&1
  rc=$?
  set -e
  if { [ "$expected" = 0 ] && [ "$rc" -eq 0 ]; } || { [ "$expected" != 0 ] && [ "$rc" -ne 0 ]; }; then
    echo "ok   [$desc] rc=$rc"
  else
    echo "FAIL [$desc] expected $([ "$expected" = 0 ] && echo 0 || echo non-zero), got $rc"
    sed 's/^/    /' "$TMPDIR_T/out"
    fail=1
  fi
}

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
# Row shape errors must not pass silently.
case_ "body not a single literal => fail"           1 "not-backticked" "match"                "pass"

[ "$fail" -eq 0 ] && { echo; echo "ALL PASS"; } || { echo >&2; echo "FAILURES PRESENT" >&2; exit 1; }
