#!/bin/sh
# Audit every published version's attestation endpoint.
#
# `verify-provenance.sh <version>` checks ONE release. This checks the whole
# history, which is what a claim like "no release before X has provenance"
# requires — a sample is not enough evidence for a universal.
#
# Classification is three-way, and only 404 means "absent":
#   attested  200 with a well-formed `attestations` array
#   absent    404 — the registry has no attestations for that version
#   ERROR     anything else: 429/5xx, connection failure, non-JSON body, or a
#             200 whose payload lacks a usable `attestations` array. These are
#             NOT evidence of absence.
#
# Exit: 0 = every version classified (attested or absent), 1 = at least one
# ERROR, or the packument could not be read. A universal claim may only be made
# from a 0 exit.
#
# Usage: scripts/audit-attestations.sh [package]
#        AUDIT_REGISTRY=http://127.0.0.1:8080 scripts/audit-attestations.sh
#        (AUDIT_REGISTRY overrides the registry base URL — used by the test.)
set -eu

PACKAGE="${1:-ceulen}"
REGISTRY="${AUDIT_REGISTRY:-https://registry.npmjs.org}"
SLSA="https://slsa.dev/provenance/v1"

if ! packument=$(curl -sS --max-time 60 "${REGISTRY}/${PACKAGE}"); then
  echo "FAIL: cannot read ${REGISTRY}/${PACKAGE}" >&2
  exit 1
fi

if ! versions=$(printf '%s' "$packument" | node -e '
let s = "";
process.stdin.on("data", (d) => { s += d; }).on("end", () => {
  let j;
  try { j = JSON.parse(s); } catch (e) { console.error("packument is not JSON"); process.exit(1); }
  const v = Object.keys(j.versions || {});
  if (v.length === 0) { console.error("packument lists no versions"); process.exit(1); }
  console.log(v.join("\n"));
});
'); then
  echo "FAIL: unusable packument at ${REGISTRY}/${PACKAGE}" >&2
  exit 1
fi

total=0
attested=0
with_slsa=0
absent=0
errors=0

printf '%-12s %-5s %s\n' VERSION HTTP RESULT
for v in $versions; do
  total=$((total + 1))

  if ! body=$(curl -sS --max-time 60 -w '\n%{http_code}' \
      "${REGISTRY}/-/npm/v1/attestations/${PACKAGE}@${v}"); then
    errors=$((errors + 1))
    printf '%-12s %-5s %s\n' "$v" "-" "ERROR: request failed"
    continue
  fi

  code=$(printf '%s\n' "$body" | tail -1)
  payload=$(printf '%s\n' "$body" | sed '$d')

  case "$code" in
    200)
      # A 200 is only evidence if the payload actually parses into a usable
      # attestations array; a malformed body must count as an error, never as
      # proof of provenance.
      verdict=$(printf '%s' "$payload" | node -e '
let s = "";
process.stdin.on("data", (d) => { s += d; }).on("end", () => {
  let j;
  try { j = JSON.parse(s); } catch (e) { console.log("BAD: body is not JSON"); return; }
  const list = j.attestations;
  if (!Array.isArray(list)) { console.log("BAD: no attestations array"); return; }
  if (list.length === 0) { console.log("BAD: empty attestations array"); return; }
  const preds = [];
  for (const a of list) {
    if (!a || typeof a.predicateType !== "string" || a.predicateType === "") {
      console.log("BAD: attestation without a predicateType");
      return;
    }
    preds.push(a.predicateType);
  }
  console.log("OK: " + preds.join(" | "));
});
')
      case "$verdict" in
        OK:*)
          attested=$((attested + 1))
          case "$verdict" in *"$SLSA"*) with_slsa=$((with_slsa + 1));; esac
          printf '%-12s %-5s %s\n' "$v" "$code" "${verdict#OK: }"
          ;;
        *)
          errors=$((errors + 1))
          printf '%-12s %-5s %s\n' "$v" "$code" "ERROR: malformed 200 — ${verdict#BAD: }"
          ;;
      esac
      ;;
    404)
      absent=$((absent + 1))
      printf '%-12s %-5s %s\n' "$v" "$code" "(no attestations)"
      ;;
    *)
      errors=$((errors + 1))
      printf '%-12s %-5s %s\n' "$v" "$code" "ERROR: unexpected status"
      ;;
  esac
done

echo
echo "total versions  : $total"
echo "attested (any)  : $attested"
echo "SLSA provenance : $with_slsa"
echo "absent (404)    : $absent"
echo "ERRORS          : $errors"

# Cover invariant: every version must land in exactly one bucket. If it does
# not, the tallies are not a complete record and no universal claim is valid.
if [ "$((attested + absent + errors))" -ne "$total" ]; then
  echo "FAIL: tallies ($((attested + absent + errors))) do not cover all versions ($total)" >&2
  exit 1
fi

if [ "$errors" -gt 0 ]; then
  echo "FAIL: $errors version(s) could not be classified — absence is NOT established for them" >&2
  exit 1
fi

echo "OK: every version classified (attested or absent)"
