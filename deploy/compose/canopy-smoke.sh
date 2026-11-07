#!/usr/bin/env bash
# Smoke test for deploy/compose/canopy.yaml. Expects the stack to be up and healthy:
#   docker compose -f deploy/compose/canopy.yaml up -d --build --wait
#   deploy/compose/canopy-smoke.sh
# Then stops the canopy service and checks that it drained and exited 0.
set -euo pipefail

compose=(docker compose -f "$(dirname "$0")/canopy.yaml")
base="http://localhost:${CANOPY_PORT:-8080}"
metrics="http://localhost:${CANOPY_METRICS_PORT:-9464}/metrics"
secret="${CANOPY_SECRET_KEYS:-sk_dev_change_me}"
publishable="${CANOPY_PUBLISHABLE_KEYS:-pk_dev}"
id="smoke-$RANDOM$RANDOM"

fail() {
  echo "canopy smoke test failed: $1" >&2
  exit 1
}

expect() {
  local name="$1" status="$2" body="$3" pattern="$4"
  shift 4
  local out code
  out="$(curl -sS -w '\n%{http_code}' "$@")"
  code="${out##*$'\n'}"
  out="${out%$'\n'*}"
  [[ "$code" == "$status" ]] || fail "$name: expected HTTP $status, got $code: $out"
  [[ -z "$body" || "$out" == "$body" ]] || fail "$name: expected body $body, got $out"
  [[ -z "$pattern" || "$out" =~ $pattern ]] || fail "$name: expected $pattern in $out"
  echo "ok  $name"
}

expect healthz 200 ok "" "$base/healthz"
expect readyz 200 ready "" "$base/readyz"
expect "insert with the secret key" 201 "" "\"_id\":\"$id\"" -X POST "$base/rest/v1/notes" \
  -H "apikey: $secret" -H "content-type: application/json" \
  -d "{\"_id\":\"$id\",\"ownerId\":\"user_1\",\"text\":\"hello\"}"
expect "read with the secret key" 200 "" "\"_id\":\"$id\"" "$base/rest/v1/notes/$id" -H "apikey: $secret"
expect "policies hide the note from anon" 200 "" '^\{"data":\[\],' "$base/rest/v1/notes" \
  -H "apikey: $publishable"
expect "an unknown key is refused" 401 "" "" "$base/rest/v1/notes" -H "apikey: pk_wrong"
expect metrics 200 "" 'canopy_build_info\{runtime="bun"' "$metrics"

"${compose[@]}" stop canopy >/dev/null
container="$("${compose[@]}" ps -a -q canopy)"
code="$(docker inspect "$container" --format '{{.State.ExitCode}}')"
[[ "$code" == "0" ]] || fail "canopy exited with $code after SIGTERM"
logs="$("${compose[@]}" logs canopy)"
[[ "$logs" == *'"msg":"draining","signal":"SIGTERM"'* ]] || fail "no draining log line"
[[ "$logs" == *'"msg":"stopped"'* ]] || fail "no stopped log line"
echo "ok  drained and exited 0 on SIGTERM"
