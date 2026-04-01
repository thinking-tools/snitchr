#!/usr/bin/env bash
# Scenario 4: File integrity monitoring — crontab change.

scenario "File Integrity Monitoring"

if [[ -z "${MACHINE_ID_E2E:-}" ]]; then
  fail "no machine ID from previous scenario"
  return 1
fi

# Clear alerts
api_clear_alerts "$MACHINE_ID_E2E" >/dev/null

# Modify crontab inside the container
in_agent bash -c 'echo "# e2e test change $(date +%s)" >> /etc/crontab'

# inotify sends crontab_change, polling fallback sends file_change
wait_for_any_alert "$MACHINE_ID_E2E" 120 "crontab change detected via API" "crontab_change" "file_change"
