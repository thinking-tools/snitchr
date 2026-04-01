#!/usr/bin/env bash
# Polling assertions using real dashboard APIs.

# Wait for at least one machine to appear online.
# Usage: wait_machine_online <timeout_sec>
wait_machine_online() {
  local timeout="${1:-60}"
  local elapsed=0
  while (( elapsed < timeout )); do
    local resp
    resp=$(api_machines 2>/dev/null || echo '{}')
    local machines
    machines=$(printf '%s' "$resp" | sed -n 's/.*"machines":\[\(.*\)\].*/\1/p')
    if printf '%s' "$machines" | grep -q '"online":true'; then
      MACHINE_ID_E2E=$(printf '%s' "$machines" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
      pass "machine online (${elapsed}s, id=${MACHINE_ID_E2E:0:8}...)"
      return 0
    fi
    sleep 3
    ((elapsed += 3))
  done
  fail "no machine came online after ${timeout}s"
  return 1
}

# Wait for heartbeat data to include cpu/mem metrics.
# Usage: wait_heartbeat_data <machine_id> <timeout_sec>
wait_heartbeat_data() {
  local id="$1" timeout="${2:-60}"
  local elapsed=0
  while (( elapsed < timeout )); do
    local resp
    resp=$(api_machine "$id" 2>/dev/null || echo '{}')
    if printf '%s' "$resp" | grep -q '"cpu":'; then
      pass "heartbeat data received (${elapsed}s)"
      return 0
    fi
    sleep 3
    ((elapsed += 3))
  done
  fail "no heartbeat data after ${timeout}s"
  return 1
}

# Wait for a specific alert type to appear.
# Usage: wait_for_alert <machine_id> <alert_type> <timeout_sec> <description>
wait_for_alert() {
  local id="$1" alert_type="$2" timeout="${3:-120}" desc="$4"
  local elapsed=0
  while (( elapsed < timeout )); do
    local resp
    resp=$(api_alerts "$id" 2>/dev/null || echo '{"alerts":[]}')
    if printf '%s' "$resp" | grep -q "\"type\":\"${alert_type}\""; then
      pass "${desc} (${elapsed}s)"
      return 0
    fi
    sleep 3
    ((elapsed += 3))
  done
  fail "${desc} (not found after ${timeout}s)"
  return 1
}

# Wait for any of multiple alert types.
# Usage: wait_for_any_alert <machine_id> <timeout_sec> <description> <type1> [type2] ...
wait_for_any_alert() {
  local id="$1" timeout="$2" desc="$3"
  shift 3
  local types=("$@")
  local elapsed=0
  while (( elapsed < timeout )); do
    local resp
    resp=$(api_alerts "$id" 2>/dev/null || echo '{"alerts":[]}')
    for t in "${types[@]}"; do
      if printf '%s' "$resp" | grep -q "\"type\":\"${t}\""; then
        pass "${desc} (type=${t}, ${elapsed}s)"
        return 0
      fi
    done
    sleep 3
    ((elapsed += 3))
  done
  fail "${desc} (none of [${types[*]}] after ${timeout}s)"
  return 1
}

# Assert machine is offline (lastSeen=0 or online=false).
# Usage: assert_machine_offline <machine_id> <description>
assert_machine_offline() {
  local id="$1" desc="$2"
  local resp
  resp=$(api_machine "$id" 2>/dev/null || echo '{}')
  local online
  online=$(json_val "$resp" online)
  if [[ "$online" == "false" ]]; then
    pass "${desc}"
  else
    fail "${desc} (online=${online})"
  fi
}

# Assert machine is online.
assert_machine_online() {
  local id="$1" desc="$2"
  local resp
  resp=$(api_machine "$id" 2>/dev/null || echo '{}')
  local online
  online=$(json_val "$resp" online)
  if [[ "$online" == "true" ]]; then
    pass "${desc}"
  else
    fail "${desc} (online=${online})"
  fi
}
