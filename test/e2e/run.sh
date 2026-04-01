#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$DIR/../.." && pwd)"
export PROJECT_ROOT

# ── Config ──

VARIANT="${VARIANT:-bun}"
GATEWAY_PORT="${GATEWAY_PORT:-8787}"
GATEWAY_URL="http://localhost:${GATEWAY_PORT}"
E2E_PASSWORD="e2e-test-password-42"
export VARIANT GATEWAY_PORT GATEWAY_URL E2E_PASSWORD

# S3 credentials (for CF variant)
S3_ENDPOINT="" S3_BUCKET="" S3_REGION="" S3_ACCESS_KEY="" S3_SECRET_KEY=""
export S3_ENDPOINT S3_BUCKET S3_REGION S3_ACCESS_KEY S3_SECRET_KEY

# ── Load libs ──

source "$DIR/lib/common.sh"
source "$DIR/lib/api.sh"
source "$DIR/lib/assert.sh"
source "$DIR/lib/gateway.sh"
source "$DIR/lib/agent.sh"

# ── Parse S3 credentials from .env ──

parse_s3_creds() {
  local env_file="${PROJECT_ROOT}/.env"
  if [[ ! -f "$env_file" ]]; then
    warn "No .env file found — S3 credentials unavailable"
    return 1
  fi
  local cred_line
  cred_line=$(grep '^BUCKET_ENV_S3=' "$env_file" | cut -d'=' -f2-)
  if [[ -z "$cred_line" ]]; then
    warn "BUCKET_ENV_S3 not found in .env"
    return 1
  fi
  IFS=',' read -r _provider S3_ACCESS_KEY S3_SECRET_KEY S3_ENDPOINT_WITH_BUCKET S3_REGION <<< "$cred_line"
  # s3mini uses the full URL (including bucket path) as endpoint
  S3_ENDPOINT="$S3_ENDPOINT_WITH_BUCKET"
  S3_BUCKET=$(basename "$S3_ENDPOINT_WITH_BUCKET")
  export S3_ENDPOINT S3_BUCKET S3_REGION S3_ACCESS_KEY S3_SECRET_KEY
  dim "S3: endpoint=${S3_ENDPOINT}, bucket=${S3_BUCKET}, region=${S3_REGION}"
}

# ── Cleanup ──

cleanup() {
  local exit_code=$?
  echo ""
  if (( exit_code != 0 )) && [[ -f "$GATEWAY_LOG" ]]; then
    warn "Gateway log (last 40 lines):"
    tail -40 "$GATEWAY_LOG" 2>/dev/null || true
  fi
  info "Cleaning up..."
  stop_agent
  stop_gateway
}

trap cleanup EXIT

# ── Variant dispatch ──

run_variant() {
  local variant="$1"
  VARIANT="$variant"
  export VARIANT

  echo -e "\n${B}========================================${RST}"
  echo -e "${B}  E2E: ${variant} variant${RST}"
  echo -e "${B}========================================${RST}"

  # Reset state
  MACHINE_ID_E2E=""
  SESSION=""
  stop_agent 2>/dev/null || true
  stop_gateway 2>/dev/null || true

  # Start gateway
  if [[ "$variant" == "bun" ]]; then
    start_bun_gateway "$GATEWAY_PORT"
  elif [[ "$variant" == "cf" ]]; then
    if [[ "${E2E_STORAGE_MODE:-s3}" != "r2" ]]; then
      parse_s3_creds || { fail "S3 credentials required for CF variant"; return 1; }
    fi
    start_cf_gateway "$GATEWAY_PORT"
  else
    warn "Unknown variant: ${variant}"
    return 1
  fi

  # Build and start agent
  build_agent
  start_agent

  # Run scenarios
  for scenario_file in "$DIR"/scenarios/*.sh; do
    source "$scenario_file"
  done

  # Teardown
  stop_agent
  stop_gateway
}

# ── Main ──

if [[ "${1:-}" == "--down" ]]; then
  cleanup
  exit 0
fi

info "snitchr real e2e tests"
dim "variant=${VARIANT}"

if [[ "$VARIANT" == "all" ]]; then
  run_variant "bun"
  run_variant "cf"
else
  run_variant "$VARIANT"
fi

print_summary
