#!/usr/bin/env bash
# Scenario 5: Graceful agent shutdown — machine goes offline.

scenario "Graceful Shutdown"

if [[ -z "${MACHINE_ID_E2E:-}" ]]; then
  fail "no machine ID from previous scenario"
  return 1
fi

# Stop the agent service (not the container)
in_agent systemctl stop snitchr-agent

# Give it a moment to send the shutdown event
sleep 3

# Verify machine is now offline
assert_machine_offline "$MACHINE_ID_E2E" "machine offline after agent stop"

# Restart agent and verify recovery
in_agent systemctl start snitchr-agent
sleep 5

_elapsed=0
_recovered=false
while (( _elapsed < 30 )); do
  _resp=$(api_machine "$MACHINE_ID_E2E" 2>/dev/null || echo '{}')
  _online=$(json_val "$_resp" online)
  if [[ "$_online" == "true" ]]; then
    _recovered=true
    break
  fi
  sleep 3
  ((_elapsed += 3))
done

if [[ "$_recovered" == "true" ]]; then
  pass "machine recovered after agent restart (${_elapsed}s)"
else
  fail "machine did not recover after ${_elapsed}s"
fi
