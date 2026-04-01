#!/usr/bin/env bash
# Scenario 4: Agent detects file integrity changes.

scenario "File integrity monitoring"

reset_events

# Modify a watched file
in_container debian bash -c 'echo "# test change" >> /etc/crontab'

# inotify path sends crontab_change (*/cron* match), polling sends file_change
wait_for_any_event 120 "crontab change detected" "type=crontab_change" "type=file_change"
