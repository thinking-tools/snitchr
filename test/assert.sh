#!/usr/bin/env bash
# Assertion helpers for agent e2e tests.
# Source this file; requires GATEWAY_URL to be set.

PASS_COUNT=0
FAIL_COUNT=0

G='\033[0;32m'
R_C='\033[0;31m'
Y='\033[0;33m'
D='\033[0;90m'
B='\033[1m'
RST='\033[0m'

pass() { ((PASS_COUNT++)); echo -e "  ${G}✓${RST} $1"; }
fail() { ((FAIL_COUNT++)); echo -e "  ${R_C}✗${RST} $1"; }

scenario() { echo -e "\n${B}▸ $1${RST}"; }

# Fetch JSON from gateway and extract a field via node (no curl|node pipe).
# Usage: gateway_count <url_path>
#   Fetches the URL, parses JSON, prints .count
# Usage: gateway_eval <url_path> <js_expression>
#   Fetches the URL, passes body to node via argv for custom extraction
gateway_count() {
  local body
  body=$(curl -sf "$1" 2>/dev/null) || { echo 0; return; }
  node -e "console.log(JSON.parse(process.argv[1]).count)" "$body" 2>/dev/null || echo 0
}

gateway_eval() {
  local body
  body=$(curl -sf "$1" 2>/dev/null) || { echo 0; return; }
  node -e "$2" "$body" 2>/dev/null || echo 0
}

# Wait for events matching a filter to appear at the gateway.
# Usage: wait_for_event <query_params> <min_count> <timeout_sec> <description>
# Example: wait_for_event "t=0" 1 90 "heartbeat received"
wait_for_event() {
  local query="$1" min="$2" timeout="$3" desc="$4"
  local elapsed=0
  while (( elapsed < timeout )); do
    local count
    count=$(gateway_count "${GATEWAY_URL}/api/test/events?${query}")
    if (( count >= min )); then
      pass "${desc} (${count} events, ${elapsed}s)"
      return 0
    fi
    sleep 2
    ((elapsed += 2))
  done
  fail "${desc} (expected >=${min}, got ${count:-0} after ${timeout}s)"
  return 1
}

# Wait for any of multiple event filters to match.
# Usage: wait_for_any_event <timeout_sec> <description> <query1> [query2] ...
wait_for_any_event() {
  local timeout="$1" desc="$2"; shift 2
  local queries=("$@")
  local elapsed=0
  while (( elapsed < timeout )); do
    for query in "${queries[@]}"; do
      local count
      count=$(gateway_count "${GATEWAY_URL}/api/test/events?${query}")
      if (( count >= 1 )); then
        pass "${desc} (${count} events, ${elapsed}s)"
        return 0
      fi
    done
    sleep 2
    ((elapsed += 2))
  done
  fail "${desc} (no match after ${timeout}s)"
  return 1
}

# Assert event count is in expected range.
# Usage: assert_count <query_params> <min> <max> <description>
assert_count() {
  local query="$1" min="$2" max="$3" desc="$4"
  local count
  count=$(gateway_count "${GATEWAY_URL}/api/test/events?${query}")
  if (( count >= min && count <= max )); then
    pass "${desc} (count=${count})"
  else
    fail "${desc} (expected ${min}-${max}, got ${count})"
  fi
}

# Assert agent registered (check gateway log has a register event).
assert_registered() {
  local desc="$1"
  local count
  count=$(gateway_eval "${GATEWAY_URL}/api/test/events" \
    "const d=JSON.parse(process.argv[1]);console.log(d.events.filter(e=>e.path==='/register').length)")
  if (( count >= 1 )); then
    pass "${desc} (${count} registrations)"
  else
    fail "${desc}"
  fi
}

# Reset event log between scenarios.
reset_events() {
  curl -sf -X POST "${GATEWAY_URL}/api/test/reset" >/dev/null 2>&1
}

# Print final summary and exit with appropriate code.
print_summary() {
  local total=$((PASS_COUNT + FAIL_COUNT))
  echo ""
  echo -e "${B}━━━ Results ━━━${RST}"
  echo -e "  ${G}${PASS_COUNT} passed${RST}, ${R_C}${FAIL_COUNT} failed${RST} (${total} total)"
  echo ""
  if (( FAIL_COUNT > 0 )); then
    exit 1
  fi
}

# Execute a command inside a container.
# Usage: in_container <service> <command...>
in_container() {
  local svc="$1"; shift
  docker compose exec -T "$svc" "$@" 2>/dev/null
}
