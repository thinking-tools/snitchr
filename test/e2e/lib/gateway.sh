#!/usr/bin/env bash
# Gateway lifecycle: start/stop for Bun and CF Workers variants.

GATEWAY_PID=""
GATEWAY_LOG="/tmp/e2e_gateway.log"

# Start gateway via Bun + filesystem storage.
start_bun_gateway() {
  local port="${1:-8787}"
  local data_dir="/tmp/e2e_snitchr_data"
  local static_dir="${PROJECT_ROOT}/static"

  rm -rf "$data_dir"
  mkdir -p "$data_dir"

  info "Starting Bun gateway on :${port}..."
  cd "$PROJECT_ROOT"
  bun run src/cli.ts --port "$port" --data-dir "$data_dir" --static-dir "$static_dir" \
    > "$GATEWAY_LOG" 2>&1 &
  GATEWAY_PID=$!

  # Wait for gateway to be ready
  local elapsed=0
  while (( elapsed < 15 )); do
    if curl -sf "http://localhost:${port}/api/capabilities" >/dev/null 2>&1; then
      dim "Bun gateway ready (PID=${GATEWAY_PID}, ${elapsed}s)"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  warn "Bun gateway failed to start. Log:"
  tail -20 "$GATEWAY_LOG"
  return 1
}

# Start gateway via wrangler dev (CF Workers).
start_cf_gateway() {
  local port="${1:-8787}"

  info "Starting CF Workers gateway on :${port}..."
  cd "$PROJECT_ROOT"

  # Clean miniflare state for fresh KV
  rm -rf .wrangler/state

  npx wrangler dev --port "$port" --ip 0.0.0.0 --local \
    > "$GATEWAY_LOG" 2>&1 &
  GATEWAY_PID=$!

  # wrangler dev takes longer to start
  local elapsed=0
  while (( elapsed < 30 )); do
    if curl -sf "http://localhost:${port}/api/capabilities" >/dev/null 2>&1; then
      dim "CF Workers gateway ready (PID=${GATEWAY_PID}, ${elapsed}s)"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  warn "CF Workers gateway failed to start. Log:"
  tail -30 "$GATEWAY_LOG"
  return 1
}

# Stop gateway.
stop_gateway() {
  if [[ -n "$GATEWAY_PID" ]]; then
    dim "Stopping gateway (PID=${GATEWAY_PID})..."
    kill "$GATEWAY_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" 2>/dev/null || true
    GATEWAY_PID=""
  fi
}
