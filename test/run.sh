#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

GATEWAY_INTERNAL="http://gateway:8080"
GATEWAY_URL="http://localhost:8080"
export GATEWAY_URL
TOKEN="test-tok-$(date +%s)"

G='\033[0;32m'
R_C='\033[0;31m'
D='\033[0;90m'
B='\033[1m'
RST='\033[0m'

info() { echo -e "${G}▸${RST} $1"; }
dim()  { echo -e "${D}  $1${RST}"; }

source "$DIR/assert.sh"

cleanup() {
  echo ""
  info "Stopping containers..."
  docker compose down --timeout 5 2>/dev/null || true
}

if [[ "${1:-}" == "--down" ]]; then
  cleanup
  exit 0
fi

trap cleanup EXIT

# ── Build & start ──

info "Building containers..."
docker compose build --quiet

info "Starting gateway..."
docker compose up -d gateway
sleep 2

info "Starting agent containers..."
docker compose up -d debian ubuntu

info "Waiting for systemd..."
for svc in debian ubuntu; do
  for _ in $(seq 1 30); do
    if docker compose exec -T "$svc" systemctl is-system-running --wait 2>/dev/null | grep -qE 'running|degraded'; then
      break
    fi
    sleep 1
  done
  dim "$svc: $(docker compose exec -T "$svc" systemctl is-system-running 2>/dev/null || echo 'starting')"
done

# ── Install agent on both distros ──

info "Installing agent..."
INSTALL=$(sed \
  -e "s|__SNITCHR_URL__|${GATEWAY_INTERNAL}|g" \
  -e "s|__SNITCHR_TOKEN__|${TOKEN}|g" \
  ../static/scripts/install.sh)

for svc in debian ubuntu; do
  dim "installing on ${svc}..."
  echo "$INSTALL" | docker compose exec -T "$svc" bash >/dev/null 2>&1
done

# Wait for agent to start and register
sleep 5

# ── Run scenarios ──

echo -e "\n${B}━━━ Agent E2E Tests ━━━${RST}"

for scenario in "$DIR"/scenarios/*.sh; do
  source "$scenario"
done

# ── Summary ──

print_summary
