#!/bin/sh
# Contract test for scripts/smoke-install.sh.
#
# The script's whole value is that EVERY wrong answer is fatal — a version
# mismatch, a missing file, or a file that should have been deleted must all
# exit non-zero. These cases were added because a hand-rolled version of this
# check reported success while only printing its failures.
#
# Network-dependent (it installs from the registry), so it targets versions that
# already exist and keeps the assertion set small. Set SMOKE_TEST_VERSION to
# override the version under test.
#
# DELIBERATELY NOT wired into `npm test`: the rest of the suite is offline (the
# audit test points AUDIT_REGISTRY at a local fake server, the fixture check has
# no network at all), and a registry dependency in CI would make every push
# slower and flakier than the checks it protects. Run this as part of the RELEASE
# flow, after the tarball resolves — that is the moment it has something to
# prove.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
SCRIPT="$ROOT/scripts/smoke-install.sh"
VER="${SMOKE_TEST_VERSION:-0.29.2}"

fail=0
# expect <desc> <want-rc> [--expect-msg <substring>] -- <script args>...
#
# Exit status ALONE is not enough: every failure path in the script exits 1, so a
# transient registry error makes "missing --require" pass for the wrong reason.
# A case that cares WHICH check fired asserts its message too.
expect() {
  desc="$1"; want="$2"; shift 2
  wantMsg=""
  if [ "${1:-}" = "--expect-msg" ]; then wantMsg="$2"; shift 2; fi
  [ "${1:-}" = "--" ] && shift

  set +e
  sh "$SCRIPT" "$@" > "$TMPOUT" 2>&1
  rc=$?
  set -e

  # Exact comparison, not a "did it fail at all" test. Collapsing every negative
  # case to "non-zero" would let the usage path (2) pass while reporting 1, i.e.
  # it would stop pinning the documented distinction between a usage error and a
  # failed check.
  if [ "$rc" -ne "$want" ]; then
    echo "FAIL [$desc] expected rc=$want, got $rc"; sed 's/^/    /' "$TMPOUT"; fail=1; return
  fi
  if [ -n "$wantMsg" ] && ! grep -qF "$wantMsg" "$TMPOUT"; then
    echo "FAIL [$desc] exited $rc but without the expected message: $wantMsg"
    echo "     (a different failure — e.g. a registry error — cannot satisfy this case)"
    sed 's/^/    /' "$TMPOUT"; fail=1; return
  fi
  echo "ok   [$desc] rc=$rc${wantMsg:+ [$wantMsg]}"
}

TMPOUT=$(mktemp)
trap 'rm -f "$TMPOUT"' EXIT INT TERM

# Baseline: the real payload asserts clean.
expect "real payload => exit 0" 0 -- \
  "$VER" \
  --require extensions/modules/repair/lib/persistent-bash.ts \
  --forbid extensions/modules/steering/lib/anchor.ts

# A missing --require path must be fatal (this is the defect being pinned: the
# old inline check printed the miss and still exited 0).
expect "missing --require => its own message" 1 \
  --expect-msg "FAIL: missing scripts/does-not-exist.sh" -- \
  "$VER" --require scripts/does-not-exist.sh

# A --forbid path that IS present must be fatal (a deleted file must stay gone).
expect "violated --forbid => its own message" 1 \
  --expect-msg "unexpected extensions/modules/repair/lib/persistent-bash.ts" -- \
  "$VER" --forbid extensions/modules/repair/lib/persistent-bash.ts

# An install failure must be fatal, not silently skipped.
expect "nonexistent version => install-failure message" 1 \
  --expect-msg "FAIL: npm install ceulen@9.9.9 exited non-zero" -- \
  "9.9.9"

# A version mismatch must be fatal, exercised through the real CLI via
# --expect-version (install one version, assert another).
expect "version mismatch => its own message" 1 \
  --expect-msg "installed version $VER != requested 0.0.0-deliberately-wrong" -- \
  "$VER" --expect-version 0.0.0-deliberately-wrong

# Usage errors are distinguishable from check failures.
expect "no version argument => usage message" 2 \
  --expect-msg "usage: smoke-install.sh"

# The success path must actually SAY it checked the version, so a reader can
# tell a real pass from a vacuous one.
set +e
sh "$SCRIPT" "$VER" > "$TMPOUT" 2>&1
set -e
if grep -q "ok   version $VER" "$TMPOUT"; then
  echo "ok   [report] version assertion reported"
else
  echo "FAIL [report] no version line in the output"; sed 's/^/    /' "$TMPOUT"; fail=1
fi

[ "$fail" -eq 0 ] && { echo; echo "ALL PASS"; } || { echo >&2; echo "FAILURES PRESENT" >&2; exit 1; }
