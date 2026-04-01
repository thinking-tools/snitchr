#!/usr/bin/env bash
# Scenario 2: Verify heartbeat data via real dashboard API.

scenario "Heartbeat Data"

if [[ -z "${MACHINE_ID_E2E:-}" ]]; then
  fail "no machine ID from previous scenario"
  return 1
fi

# Wait for heartbeat data with CPU/mem metrics
wait_heartbeat_data "$MACHINE_ID_E2E" 30

# Verify machine detail fields
_resp=$(api_machine "$MACHINE_ID_E2E")

for field in cpu mem load procs; do
  if printf '%s' "$_resp" | grep -q "\"${field}\":"; then
    pass "heartbeat field: ${field}"
  else
    fail "missing heartbeat field: ${field}"
  fi
done

# Verify online status
assert_machine_online "$MACHINE_ID_E2E" "machine shows online"
