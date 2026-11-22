#!/bin/sh
# Re-run BOTH provenance matchers over the exact fixture bodies printed in
# AGENTS.md's "What a raw grep gets wrong" table.
#
# The table is the claim; this script is its check. It extracts each row's JSON
# literal straight out of AGENTS.md — no fixtures duplicated here, so the table
# cannot drift from the measurement — then runs the historical substring matcher
# and the documented parse matcher on that literal and compares both results
# with the row's own columns.
#
# Usage: scripts/check-provenance-fixtures.sh [path-to-AGENTS.md]
# Exit: 0 = every row reproduced; 1 = a row disagreed or the table changed shape.
set -eu

DOC="${1:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/AGENTS.md}"
[ -f "$DOC" ] || { echo "FAIL: no such file: $DOC" >&2; exit 1; }

# Emit one TSV row per fixture: number <TAB> body <TAB> grep-claim <TAB> correct-claim
rows=$(node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n");
const head = lines.findIndex((l) => l.includes("body (exact fixture)"));
if (head < 0) { console.error("FAIL: fixture table not found"); process.exit(1); }
const out = [];
for (let i = head + 2; i < lines.length; i++) {
  if (!lines[i].startsWith("|")) break;
  const cells = lines[i].split("|").map((c) => c.trim());
  const n = cells[1];
  const m = /^`(.+)`$/.exec(cells[2] || "");
  if (!m) { console.error("FAIL: row " + n + " body is not one backticked literal"); process.exit(1); }
  out.push([n, m[1], cells[3], cells[4]].join("\t"));
}
if (!out.length) { console.error("FAIL: fixture table has no rows"); process.exit(1); }
console.log(out.join("\n"));
' "$DOC") || exit 1

parse() {
  node -e '
let s = "";
process.stdin.on("data", (d) => { s += d; }).on("end", () => {
  let j;
  try { j = JSON.parse(s); } catch (e) { process.exit(1); }
  const l = j.attestations;
  if (!Array.isArray(l)) process.exit(1);
  process.exit(l.some((a) => a && a.predicateType === "https://slsa.dev/provenance/v1") ? 0 : 1);
});
'
}

fail=0
printf '%-3s %-10s %-10s %-10s %-10s %s\n' ROW GREP-MEAS GREP-DOC PARSE-MEAS PARSE-DOC VERDICT
printf '%s\n' "$rows" | while IFS="$(printf '\t')" read -r n body grepClaim correctClaim; do
  [ -n "${n:-}" ] || continue
  if printf '%s' "$body" | grep -q 'https://slsa.dev/provenance/v1'; then measuredGrep="match"; else measuredGrep="no match"; fi
  if printf '%s' "$body" | parse; then measuredParse="pass"; else measuredParse="fail"; fi

  # A "false positive" is a COMPOUND claim, not a synonym for "match": grep must
  # match AND the correct answer must be fail. Normalizing it to "match" would
  # let a genuine-provenance row be relabelled a false positive and still pass.
  case "$grepClaim" in
    *"false positive"*) expectGrep="match"; expectParseForFalsePositive="fail" ;;
    *)                  expectGrep="$grepClaim"; expectParseForFalsePositive="" ;;
  esac

  verdict=ok
  [ "$measuredGrep" = "$expectGrep" ] || { verdict="MISMATCH(grep)"; fail=1; }
  [ "$measuredParse" = "$correctClaim" ] || { verdict="MISMATCH(parse)"; fail=1; }
  if [ -n "$expectParseForFalsePositive" ] && [ "$measuredParse" != "$expectParseForFalsePositive" ]; then
    verdict="BAD(false-positive-claim)"; fail=1
  fi
  printf '%-3s %-10s %-10s %-10s %-10s %s\n' "$n" "$measuredGrep" "$grepClaim" "$measuredParse" "$correctClaim" "$verdict"
  # Signal out of the subshell via a file so the exit status survives the pipe.
  [ "$verdict" = ok ] || echo "$n" >> "${TMP:-/tmp}/.prov-fixture-fails.$$"
done

status=0
if [ -f "${TMP:-/tmp}/.prov-fixture-fails.$$" ]; then
  echo >&2
  echo "FAIL: rows $(tr '\n' ' ' < "${TMP:-/tmp}/.prov-fixture-fails.$$")disagree with the table" >&2
  rm -f "${TMP:-/tmp}/.prov-fixture-fails.$$"
  status=1
else
  echo
  echo "OK: every table row reproduced (grep claim AND parse result)"
fi
exit "$status"
