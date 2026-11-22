#!/bin/sh
# Verify a ceulen release carries SLSA provenance, not just an npm signature.
#
# HTTP 200 alone is NOT sufficient. The endpoint can carry two DISTINCT
# attestations: npm's own publish recording
# (`https://github.com/npm/attestation/.../publish/v0.1`) and the SLSA build
# provenance. Only the latter is a build-provenance claim, so a 200 — or a
# `publish/v0.1` by itself — does not establish it. The claim is satisfied only
# by the presence of the `https://slsa.dev/provenance/v1` predicate.
#
# Usage: scripts/verify-provenance.sh <version> [package]
set -eu

VERSION="${1:?usage: verify-provenance.sh <version> [package]}"
PACKAGE="${2:-ceulen}"
SLSA="https://slsa.dev/provenance/v1"
URL="https://registry.npmjs.org/-/npm/v1/attestations/${PACKAGE}@${VERSION}"

body=$(curl -sS -w '\n%{http_code}' "$URL") || { echo "FAIL $PACKAGE@$VERSION: request failed" >&2; exit 1; }
code=$(printf '%s\n' "$body" | tail -1)
payload=$(printf '%s\n' "$body" | sed '$d')

if [ "$code" != "200" ]; then
  echo "FAIL $PACKAGE@$VERSION: attestation endpoint returned HTTP $code" >&2
  exit 1
fi

printf '%s' "$payload" | node -e '
let s = "";
process.stdin.on("data", (d) => { s += d; }).on("end", () => {
  const want = process.argv[1];
  let preds = [];
  try { preds = (JSON.parse(s).attestations || []).map((a) => a.predicateType); } catch (e) {
    console.error("FAIL: response is not valid JSON");
    process.exit(1);
  }
  const hasSlsa = preds.includes(want);
  console.log("predicates:", preds.join(", ") || "(none)");
  if (!hasSlsa) {
    console.error(`FAIL: HTTP 200 but no ${want} predicate — a publish-only attestation does not establish provenance`);
    process.exit(1);
  }
  console.log(`OK: ${want} present`);
});
' "$SLSA"
