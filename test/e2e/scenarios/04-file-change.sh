#!/usr/bin/env bash
# Scenario 4: File integrity monitoring — crontab, PAM, and logging config changes.

scenario "File Integrity Monitoring"

if [[ -z "${MACHINE_ID_E2E:-}" ]]; then
  fail "no machine ID from previous scenario"
  return 1
fi

# ── Crontab ──

api_clear_alerts "$MACHINE_ID_E2E" >/dev/null
in_agent bash -c 'echo "# e2e test change $(date +%s)" >> /etc/crontab'

# inotify sends crontab_change, polling fallback sends file_change
wait_for_any_alert "$MACHINE_ID_E2E" 120 "crontab change detected via API" "crontab_change" "file_change"

# ── PAM config ──

api_clear_alerts "$MACHINE_ID_E2E" >/dev/null
in_agent bash -c 'echo "# e2e pam test $(date +%s)" >> /etc/pam.d/su'

wait_for_any_alert "$MACHINE_ID_E2E" 120 "PAM config change detected via API" "file_change" "crontab_change"

# Note: rsyslog.conf test is in mock tests only (full Debian/Ubuntu containers).
# Minimal e2e containers don't ship rsyslog, so the file doesn't exist.
