#!/bin/sh
# Smoke-test the npm-installable tarball: install into a throwaway directory and
# assert the payload, with a non-zero exit for EVERY kind of wrong answer.
#
# Exists because AGENTS.md tells you to "install it from a clean directory and
# assert the payload" before calling a release shipped, and hand-rolling that
# check has repeatedly produced exit codes that meant nothing — capturing $?
# after a pipeline, or a node -e that only printed results without calling
# process.exit. Every assertion here is fatal.
#
# Checks, each independently fatal:
#   - npm install's own exit status (captured without a pipe)
#   - installed package.json version == the requested version
#   - every --require path exists in the installed package
#   - every --forbid path is ABSENT (deleted files must stay deleted)
#
# Usage: scripts/smoke-install.sh <version> [package]
#                                     [--require <path-in-package>]...
#                                     [--forbid <path-in-package>]...
# Exit: 0 = installed and every assertion held; 1 = a check failed; 2 = bad usage.
set -eu

VERSION=""
PACKAGE="ceulen"
REQUIRE=""
FORBID=""
# Version the installed package.json must report. Defaults to the version we
# install; --expect-version exists so the mismatch guard is testable through the
# real CLI instead of by poking at internals.
EXPECT_VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --require) REQUIRE="$REQUIRE $2"; shift 2 ;;
    --forbid)  FORBID="$FORBID $2";   shift 2 ;;
    --package) PACKAGE="$2";          shift 2 ;;
    --expect-version) EXPECT_VERSION="$2"; shift 2 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *)  [ -z "$VERSION" ] && VERSION="$1" || { echo "unexpected argument: $1" >&2; exit 2; }; shift ;;
  esac
done
[ -n "$VERSION" ] || { echo "usage: smoke-install.sh <version> [package] [--require p]... [--forbid p]... [--expect-version v]" >&2; exit 2; }
[ -n "$EXPECT_VERSION" ] || EXPECT_VERSION="$VERSION"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
cd "$WORK"

# npm's OWN exit status — no pipeline, so nothing can mask it.
if ! npm install "$PACKAGE@$VERSION" --no-save --loglevel=error > install.log 2>&1; then
  echo "FAIL: npm install $PACKAGE@$VERSION exited non-zero" >&2
  tail -20 install.log >&2
  exit 1
fi
echo "ok   npm install $PACKAGE@$VERSION — exit 0"

BASE="node_modules/$PACKAGE"
SMOKE_BASE="$BASE" SMOKE_VERSION="$EXPECT_VERSION" SMOKE_REQUIRE="$REQUIRE" SMOKE_FORBID="$FORBID" node -e '
const fs = require("fs");
const path = require("path");
const base = process.env.SMOKE_BASE;
const want = process.env.SMOKE_VERSION;
const split = (s) => (s || "").trim().split(/\s+/).filter(Boolean);
const require_ = split(process.env.SMOKE_REQUIRE);
const forbid = split(process.env.SMOKE_FORBID);

let bad = 0;
const fail = (m) => { console.error("FAIL: " + m); bad = 1; };

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8"));
} catch (e) {
  console.error("FAIL: cannot read the installed package.json — extraction failed");
  process.exit(1);
}

if (pkg.version !== want) fail("installed version " + pkg.version + " != requested " + want);
else console.log("ok   version " + pkg.version);

for (const f of require_) {
  if (fs.existsSync(path.join(base, f))) console.log("ok   present " + f);
  else fail("missing " + f);
}
for (const f of forbid) {
  if (fs.existsSync(path.join(base, f))) fail("unexpected " + f + " (should not ship)");
  else console.log("ok   absent " + f);
}

process.exit(bad ? 1 : 0);
'
