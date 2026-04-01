#!/usr/bin/env bash
# Scenario 4: Agent detects file integrity changes.

scenario "File integrity monitoring"

reset_events

# Modify a watched file
in_container debian bash -c 'echo "# test change" >> /etc/crontab'

# inotify path sends crontab_change (*/cron* match), polling sends file_change
wait_for_any_event 120 "crontab change detected" "type=crontab_change" "type=file_change"

# ── PAM config ──

reset_events
in_container debian bash -c 'echo "# snitchr test" >> /etc/pam.d/su'

# inotify sends file_change, polling sends crontab_change (dir-based)
wait_for_any_event 120 "PAM config change detected" "type=file_change" "type=crontab_change"

# ── Logging config ──

reset_events
in_container debian bash -c 'echo "# snitchr test" >> /etc/rsyslog.conf'

# rsyslog.conf is a watched file — always file_change
wait_for_event "type=file_change" 1 120 "logging config change detected"
