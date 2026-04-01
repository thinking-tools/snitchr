#!/usr/bin/env bash
# Scenario 3: Trigger auth events and verify via alerts API.

scenario "Auth Event Detection"

if [[ -z "${MACHINE_ID_E2E:-}" ]]; then
  fail "no machine ID from previous scenario"
  return 1
fi

# Clear existing alerts
api_clear_alerts "$MACHINE_ID_E2E" >/dev/null

# Inject a failed SSH login into auth log inside the container
in_agent bash -c '
  echo "'"$(date "+%b %d %H:%M:%S")"' ubuntu sshd[9999]: Failed password for root from 10.0.0.1 port 22 ssh2" >> /var/log/auth.log
  logger -t sshd "Failed password for invalid user hacker from 192.168.1.100 port 4444 ssh2"
'

# Wait for the agent to pick it up and send to gateway
wait_for_alert "$MACHINE_ID_E2E" "ssh_fail" 120 "SSH failure alert detected via API"
