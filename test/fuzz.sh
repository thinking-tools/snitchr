#!/usr/bin/env bash
set -euo pipefail

PORT="${FUZZ_PORT:-8787}"
DATA_DIR="/tmp/snitchr-fuzz-$$"
PASSWORD="fuzzpass-$(date +%s)"
SPEC="docs/openapi-gateway.yaml"
GW_PID=""

cleanup() {
  [ -n "$GW_PID" ] && kill "$GW_PID" 2>/dev/null || true
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

# ── Preflight ──────────────────────────────────────────────────────────
if ! docker info >/dev/null 2>&1; then
  echo "Error: Docker is not running" >&2; exit 1
fi
if [ ! -f "$SPEC" ]; then
  echo "Error: $SPEC not found (run from project root)" >&2; exit 1
fi

# ── Build & start gateway ─────────────────────────────────────────────
echo "Building..."
npm run build:node --silent

echo "Starting gateway on :$PORT..."
node dist/cli.js --port "$PORT" --data-dir "$DATA_DIR" >/dev/null 2>&1 &
GW_PID=$!

# Wait for readiness
for i in $(seq 1 30); do
  curl -sf "http://localhost:$PORT/api/capabilities" >/dev/null 2>&1 && break
  [ "$i" -eq 30 ] && { echo "Error: Gateway failed to start" >&2; exit 1; }
  sleep 1
done

# ── Bootstrap ──────────────────────────────────────────────────────────
BASE="http://localhost:$PORT"

curl -sf -X POST "$BASE/api/setup" \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$PASSWORD\",\"passwordConfirm\":\"$PASSWORD\",\"storageMode\":\"memory\"}" >/dev/null

SESSION=$(curl -sf -D - -X POST "$BASE/api/login" \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$PASSWORD\"}" \
  | grep -i '^set-cookie:.*session=' | sed 's/.*session=\([^;]*\).*/\1/')

TOKEN=$(curl -sf -X POST "$BASE/api/install-token" \
  -H "Cookie: session=$SESSION" | jq -r '.token')

REG=$(curl -sf -X POST "$BASE/register" \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"sysinfo\":{\"hostname\":\"fuzz-host\",\"os\":\"Ubuntu 22.04\"}}")
MACHINE_ID=$(echo "$REG" | jq -r '.id')
MACHINE_SECRET=$(echo "$REG" | jq -r '.secret')

# Seed heartbeat + alert so GET endpoints return real data
NOW_MS=$(($(date +%s) * 1000))
curl -sf -X POST "$BASE/m/$MACHINE_ID/ingest" \
  -H "Authorization: Bearer $MACHINE_SECRET" \
  -H 'Content-Type: application/json' \
  -d "{\"t\":0,\"d\":{\"ts\":$NOW_MS,\"up\":3600,\"cpu\":12.5,\"mem\":[4096,8192],\"disk\":[45],\"load\":[1.2,0.8,0.6],\"procs\":142,\"net\":[1073741824,536870912],\"ports\":\"22,80\",\"users\":\"root\"}}" >/dev/null

curl -sf -X POST "$BASE/m/$MACHINE_ID/ingest" \
  -H "Authorization: Bearer $MACHINE_SECRET" \
  -H 'Content-Type: application/json' \
  -d "{\"t\":2,\"d\":{\"type\":\"ssh_login\",\"msg\":\"Accepted publickey for root from 10.0.0.1 port 54321\"}}" >/dev/null

echo "Gateway bootstrapped (machine=$MACHINE_ID)"

# ── Fuzz ───────────────────────────────────────────────────────────────
echo "Running schemathesis..."
docker run --rm \
  -v "$(pwd)/$SPEC:/spec.yaml:ro" \
  schemathesis/schemathesis:stable \
  run /spec.yaml \
  --url "http://host.docker.internal:$PORT" \
  --checks all \
  -H "Cookie: session=$SESSION" \
  -H "Authorization: Bearer $MACHINE_SECRET" \
  --exclude-path "/api/setup" \
  --exclude-path "/api/logout" \
  --exclude-path "/api/settings/reset" \
  --exclude-path "/api/settings/password" \
  --exclude-path "/install-agent" \
  --max-response-time 5
