#!/usr/bin/env bash
# Smoke test for deploy/compose/canopy.yaml, the stack of separate services. Expects it to be up and healthy:
#   docker compose -f deploy/compose/canopy.yaml up -d --build --wait
#   deploy/compose/canopy-smoke.sh
# Checks each service through the edge, then stops realtime and api in turn to show that the others keep
# answering, that the edge reports only the stopped service as unavailable, and that each service drains
# and exits 0 on SIGTERM. Leaves the stack up and healthy.
set -euo pipefail

compose=(docker compose -f "$(dirname "$0")/canopy.yaml")
base="http://localhost:${CANOPY_PORT:-8080}"
api_metrics="http://localhost:${CANOPY_METRICS_PORT:-9464}/metrics"
realtime_metrics="http://localhost:${CANOPY_REALTIME_METRICS_PORT:-9465}/metrics"
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

# The status of a plain GET of the realtime endpoint: a running realtime service refuses it without a
# WebSocket upgrade (4xx), while the edge answers 503 when the service is down.
realtime_status() {
  curl -sS -o /dev/null -w '%{http_code}' "$base/realtime/v1"
}

# Stops one service, checks that it drained and exited 0, and leaves it stopped.
stop_and_check() {
  local service="$1"
  "${compose[@]}" stop "$service" >/dev/null
  local container code logs
  container="$("${compose[@]}" ps -a -q "$service")"
  code="$(docker inspect "$container" --format '{{.State.ExitCode}}')"
  [[ "$code" == "0" ]] || fail "$service exited with $code after SIGTERM"
  logs="$("${compose[@]}" logs "$service")"
  [[ "$logs" == *'"msg":"draining","signal":"SIGTERM"'* ]] || fail "$service logged no draining line"
  [[ "$logs" == *'"msg":"stopped"'* ]] || fail "$service logged no stopped line"
  echo "ok  $service drained and exited 0 on SIGTERM"
}

expect "edge health" 200 ok "" "$base/edge/healthz"
expect healthz 200 ok "" "$base/healthz"
expect readyz 200 ready "" "$base/readyz"
expect "insert with the secret key" 201 "" "\"_id\":\"$id\"" -X POST "$base/rest/v1/notes" \
  -H "apikey: $secret" -H "content-type: application/json" \
  -d "{\"_id\":\"$id\",\"ownerId\":\"user_1\",\"text\":\"hello\"}"
expect "read with the secret key" 200 "" "\"_id\":\"$id\"" "$base/rest/v1/notes/$id" -H "apikey: $secret"
expect "policies hide the note from anon" 200 "" '^\{"data":\[\],' "$base/rest/v1/notes" \
  -H "apikey: $publishable"
expect "an unknown key is refused" 401 "" "" "$base/rest/v1/notes" -H "apikey: pk_wrong"
expect "studio through the edge" 200 "" "<html" "$base/studio/"
expect "api metrics" 200 "" 'canopy_build_info\{runtime="bun"' "$api_metrics"
expect "realtime metrics" 200 "" 'canopy_build_info\{runtime="bun"' "$realtime_metrics"
status="$(realtime_status)"
[[ "$status" =~ ^4 ]] || fail "realtime answered a plain GET with $status, not a 4xx refusal"
echo "ok  realtime answers through the edge"

stop_and_check realtime
expect "REST keeps working without realtime" 201 "" "\"_id\":\"$id-2\"" -X POST "$base/rest/v1/notes" \
  -H "apikey: $secret" -H "content-type: application/json" \
  -d "{\"_id\":\"$id-2\",\"ownerId\":\"user_1\",\"text\":\"still here\"}"
expect "the edge reports realtime as unavailable" 503 "" '"code":"CANOPY_UNAVAILABLE"' "$base/realtime/v1"
"${compose[@]}" up -d --no-build --wait --wait-timeout 120 realtime >/dev/null

stop_and_check api
status="$(realtime_status)"
[[ "$status" =~ ^4 ]] || fail "realtime answered $status while api was stopped"
echo "ok  realtime keeps working without api"
expect "studio keeps working without api" 200 "" "<html" "$base/studio/"
expect "the edge reports the API as unavailable" 503 "" '"code":"CANOPY_UNAVAILABLE"' "$base/rest/v1/notes" \
  -H "apikey: $secret"
"${compose[@]}" up -d --no-build --wait --wait-timeout 120 api >/dev/null
expect "the API is back" 200 "" "\"_id\":\"$id-2\"" "$base/rest/v1/notes/$id-2" -H "apikey: $secret"
