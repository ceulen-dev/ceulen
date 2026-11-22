#!/bin/sh
# Audit every published version's attestation endpoint.
#
# `verify-provenance.sh <version>` checks ONE release. This checks the whole
# history, which is what a claim like "no release before X has provenance"
# requires — a sample is not enough evidence for a universal.
#
# Usage: scripts/audit-attestations.sh [package]
# Exit: 0 = audit completed (see the report), 1 = request failure.
set -eu

PACKAGE="${1:-ceulen}"
REGISTRY="https://registry.npmjs.org"

versions=$(curl -sS "${REGISTRY}/${PACKAGE}" | node -e '
let s = "";
process.stdin.on("data", (d) => { s += d; }).on("end", () => {
  const j = JSON.parse(s);
  console.log(Object.keys(j.versions).join("\n"));
});
') || { echo "FAIL: cannot read ${REGISTRY}/${PACKAGE}" >&2; exit 1; }

total=0
with_slsa=0
with_any=0
notfound=0

printf '%-10s %-5s %s\n' VERSION HTTP PREDICATES
for v in $versions; do
  total=$((total + 1))
  body=$(curl -sS -w '\n%{http_code}' "${REGISTRY}/-/npm/v1/attestations/${PACKAGE}@${v}")
  code=$(printf '%s\n' "$body" | tail -1)
  payload=$(printf '%s\n' "$body" | sed '$d')
  if [ "$code" = "200" ]; then
    preds=$(printf '%s' "$payload" | node -e '
let s = "";
process.stdin.on("data", (d) => { s += d; }).on("end", () => {
  try {
    const p = (JSON.parse(s).attestations || []).map((a) => a.predicateType);
    console.log(p.length ? p.join(" | ") : "(empty)");
  } catch (e) { console.log("(unparsable)"); }
});
')
    with_any=$((with_any + 1))
    case "$preds" in *slsa.dev/provenance/v1*) with_slsa=$((with_slsa + 1));; esac
    printf '%-10s %-5s %s\n' "$v" "$code" "$preds"
  else
    notfound=$((notfound + 1))
    printf '%-10s %-5s %s\n' "$v" "$code" "$( [ "$code" = "404" ] && echo '(no attestations)' || echo '(request failed)')"
  fi
done

echo
echo "total versions : $total"
echo "attested (any) : $with_any"
echo "SLSA provenance: $with_slsa"
echo "no attestations: $notfound"

# Universal claims are only supportable when every version was actually read.
if [ "$((with_any + notfound))" -ne "$total" ]; then
  echo "WARN: some versions returned neither 200 nor 404 — the tallies above do not cover the full set" >&2
fi
