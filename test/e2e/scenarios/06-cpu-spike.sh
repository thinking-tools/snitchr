#!/usr/bin/env bash
# Scenario 6: CPU spike detection — saturate CPUs and verify alert.

scenario "CPU Spike Detection"

if [[ -z "${MACHINE_ID_E2E:-}" ]]; then
  fail "no machine ID from previous scenario"
  return 1
fi

# Clear existing alerts
api_clear_alerts "$MACHINE_ID_E2E" >/dev/null

# Spin busy loops on every available CPU
in_agent bash -c '
  pids=""
  for i in $(seq $(nproc)); do
    (while :; do :; done) &
    pids="$pids $!"
  done
  echo $pids > /tmp/cpu-stress-pids
'
dim "CPU stress started ($(in_agent nproc) cores)"

# Wait for the agent to detect the spike (agent samples every 10s)
wait_for_alert "$MACHINE_ID_E2E" "cpu_spike" 120 "CPU spike alert detected via API"

# Kill stress workers
in_agent bash -c 'kill $(cat /tmp/cpu-stress-pids 2>/dev/null) 2>/dev/null; rm -f /tmp/cpu-stress-pids' || true
