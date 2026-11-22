#!/bin/sh
# Contract test for scripts/audit-attestations.sh against a local fake registry.
#
# The audit's whole value is that it FAILS when the data is not trustworthy, so
# each case here pins one way that could go wrong: a 429/500 must not be read as
# "absent", a malformed 200 must not be read as "attested", and the exit status
# must go non-zero in both.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
SCRIPT="$ROOT/scripts/audit-attestations.sh"
PORT="${TEST_PORT:-18931}"
BASE="http://127.0.0.1:${PORT}"
SLSA="https://slsa.dev/provenance/v1"
PUBLISH="https://github.com/npm/attestation/tree/main/specs/publish/v0.1"

fail=0
check() {
  desc="$1"; expected_rc="$2"; shift 2
  set +e
  out=$(AUDIT_REGISTRY="$BASE" sh "$SCRIPT" "$@" 2>&1)
  rc=$?
  set -e
  if [ "$expected_rc" = "0" ] && [ "$rc" -ne 0 ]; then
    echo "FAIL [$desc] expected rc=0, got $rc"; echo "$out" | sed 's/^/    /'; fail=1; return
  fi
  if [ "$expected_rc" != "0" ] && [ "$rc" -eq 0 ]; then
    echo "FAIL [$desc] expected non-zero rc, got 0"; echo "$out" | sed 's/^/    /'; fail=1; return
  fi
  echo "ok   [$desc] rc=$rc"
}

# Serve fixture responses with a tiny node server; routes are set per case.
start_server() {
  node -e '
const http = require("http");
const base = process.argv[1];
const fixtures = JSON.parse(process.argv[2]);
http.createServer((req, res) => {
  const url = new URL(req.url, base);
  const path = url.pathname;
  const f = fixtures[path];
  if (!f) { res.writeHead(500); res.end("no fixture"); return; }
  if (f.truncate) {
    // Promise a body far larger than we send, then kill the socket: curl sees
    // its HTTP status AND a transfer failure on the same response.
    res.writeHead(f.status, { "content-type": "application/json", "content-length": "5000" });
    // A partial JSON fragment; the point is the socket dies mid-body.
    res.write(f.partial || "{\"error\":\"trunc");
    setTimeout(() => res.socket.destroy(), 20);
    return;
  }
  res.writeHead(f.status, { "content-type": "application/json" });
  res.end(typeof f.body === "string" ? f.body : JSON.stringify(f.body));
}).listen(Number(process.argv[3]), "127.0.0.1");
' "$BASE" "$1" "$PORT" &
  SERVER_PID=$!
  # Wait for the listener instead of sleeping blindly.
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    curl -sS -o /dev/null "$BASE/__ping" 2>/dev/null && break
    sleep 0.1
  done
}

stop_server() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}

packument() {
  node -e 'console.log(JSON.stringify({versions: Object.fromEntries(process.argv.slice(1).map(v=>[v,{}]))}))' "$@"
}

attested_body() {
  node -e 'console.log(JSON.stringify({attestations: process.argv.slice(1).map(p=>({predicateType:p}))}))' "$@"
}

# ---- case 1: clean history — one attested, one absent => exit 0 -----------------
PK=$(packument 1.0.0 2.0.0)
GOOD=$(attested_body "$PUBLISH" "$SLSA")
start_server "{\"/pkg\":{\"status\":200,\"body\":$PK},\"/-/npm/v1/attestations/pkg@1.0.0\":{\"status\":200,\"body\":$GOOD},\"/-/npm/v1/attestations/pkg@2.0.0\":{\"status\":404,\"body\":{\"error\":\"Not found\"}}}"
check "clean history => exit 0" 0 pkg
out_clean="$out"
stop_server

# ---- case 2: a 429 must NOT be counted as absent => non-zero -------------------
start_server "{\"/pkg\":{\"status\":200,\"body\":$PK},\"/-/npm/v1/attestations/pkg@1.0.0\":{\"status\":200,\"body\":$GOOD},\"/-/npm/v1/attestations/pkg@2.0.0\":{\"status\":429,\"body\":{\"error\":\"rate limited\"}}}"
check "429 => non-zero" 1 pkg
out_429="$out"
stop_server

# ---- case 3: a 500 must NOT be counted as absent => non-zero -------------------
start_server "{\"/pkg\":{\"status\":200,\"body\":$PK},\"/-/npm/v1/attestations/pkg@1.0.0\":{\"status\":200,\"body\":$GOOD},\"/-/npm/v1/attestations/pkg@2.0.0\":{\"status\":500,\"body\":{\"error\":\"boom\"}}}"
check "500 => non-zero" 1 pkg
stop_server

# ---- case 4: malformed 200 (not JSON) must NOT count as attested => non-zero ---
start_server "{\"/pkg\":{\"status\":200,\"body\":$PK},\"/-/npm/v1/attestations/pkg@1.0.0\":{\"status\":200,\"body\":\"not json at all\"},\"/-/npm/v1/attestations/pkg@2.0.0\":{\"status\":404,\"body\":{}}}"
check "malformed 200 (non-JSON) => non-zero" 1 pkg
stop_server

# ---- case 5: 200 without an attestations array => non-zero ---------------------
start_server "{\"/pkg\":{\"status\":200,\"body\":$PK},\"/-/npm/v1/attestations/pkg@1.0.0\":{\"status\":200,\"body\":{\"ok\":true}},\"/-/npm/v1/attestations/pkg@2.0.0\":{\"status\":404,\"body\":{}}}"
check "200 without attestations array => non-zero" 1 pkg
stop_server

# ---- case 6: 200 with an empty array => non-zero -------------------------------
start_server "{\"/pkg\":{\"status\":200,\"body\":$PK},\"/-/npm/v1/attestations/pkg@1.0.0\":{\"status\":200,\"body\":{\"attestations\":[]}},\"/-/npm/v1/attestations/pkg@2.0.0\":{\"status\":404,\"body\":{}}}"
check "200 with empty attestations => non-zero" 1 pkg
stop_server

# ---- case 7: attestation lacking predicateType => non-zero --------------------
start_server "{\"/pkg\":{\"status\":200,\"body\":$PK},\"/-/npm/v1/attestations/pkg@1.0.0\":{\"status\":200,\"body\":{\"attestations\":[{},{}]}},\"/-/npm/v1/attestations/pkg@2.0.0\":{\"status\":404,\"body\":{}}}"
check "attestation without predicateType => non-zero" 1 pkg
stop_server

# ---- case 8: unusable packument => non-zero -----------------------------------
start_server "{\"/pkg\":{\"status\":500,\"body\":\"nope\"},\"/-/npm/v1/attestations/pkg@1.0.0\":{\"status\":404,\"body\":{}}}"
check "unreadable packument => non-zero" 1 pkg
stop_server

# ---- case 9: TRUNCATED body on a 404 => non-zero ------------------------------
# curl reports BOTH an HTTP status (404) and a transfer failure (exit 18) when a
# body is cut short — measured: `curl -sS -w '%{http_code}'` prints 404 while
# exiting 18. The transfer failure must take precedence, or reading the status
# alone files this version as "absent" and a broken audit looks clean.
start_server "{\"/pkg\":{\"status\":200,\"body\":$PK},\"/-/npm/v1/attestations/pkg@1.0.0\":{\"status\":404,\"body\":{}},\"/-/npm/v1/attestations/pkg@2.0.0\":{\"status\":404,\"truncate\":true}}"
check "truncated 404 body (transport failure) => non-zero" 1 pkg
out_trunc="$out"
stop_server

# ---- assertions on the clean-history report content ---------------------------
for want in "total versions  : 2" "attested (any)  : 1" "SLSA provenance : 1" "absent (404)    : 1" "ERRORS          : 0" "OK: every version classified"; do
  if printf '%s' "$out_clean" | grep -qF "$want"; then
    echo "ok   [clean report] $want"
  else
    echo "FAIL [clean report] missing: $want"; printf '%s\n' "$out_clean" | sed 's/^/    /'; fail=1
  fi
done

# ---- a 429 must be reported as an ERROR, never as absent ---------------------
if printf '%s' "$out_429" | grep -q "429.*ERROR"; then
  echo "ok   [429 row] classified as ERROR"
else
  echo "FAIL [429 row] not labelled ERROR"; printf '%s\n' "$out_429" | sed 's/^/    /'; fail=1
fi
# The fixture is one 200 and one 429, so a correct audit reports absent=0. If
# the 429 were miscounted as absent this would say 1.
if printf '%s' "$out_429" | grep -q "absent (404)    : 0"; then
  echo "ok   [429 case] 429 did not enter the absent tally (absent=0)"
else
  echo "FAIL [429 case] the 429 leaked into the absent tally"; printf '%s\n' "$out_429" | sed 's/^/    /'; fail=1
fi
if printf '%s' "$out_429" | grep -q "ERRORS          : 1"; then
  echo "ok   [429 case] counted in the ERROR tally"
else
  echo "FAIL [429 case] not counted in the ERROR tally"; printf '%s\n' "$out_429" | sed 's/^/    /'; fail=1
fi
if printf '%s' "$out_trunc" | grep -q "absent (404)    : 1"; then
  echo "ok   [truncated case] transport failure did not enter the absent tally"
else
  echo "FAIL [truncated case] a truncated 404 was counted as absent"; printf '%s\n' "$out_trunc" | sed 's/^/    /'; fail=1
fi
if printf '%s' "$out_trunc" | grep -q "ERRORS          : 1"; then
  echo "ok   [truncated case] counted in the ERROR tally"
else
  echo "FAIL [truncated case] not counted in the ERROR tally"; printf '%s\n' "$out_trunc" | sed 's/^/    /'; fail=1
fi

[ "$fail" -eq 0 ] && echo && echo "ALL PASS" || { echo >&2; echo "FAILURES PRESENT" >&2; exit 1; }
