#!/usr/bin/env bash
# Scenario 3: Agent detects and reports auth events.

scenario "Auth event detection"

reset_events

# Trigger a failed SSH login attempt on the debian container
# Writing directly to auth log since sshd isn't running in test containers
in_container debian bash -c '
  echo "$(date "+%b %d %H:%M:%S") debian sshd[9999]: Failed password for root from 10.0.0.1 port 22 ssh2" >> /var/log/auth.log
  logger -t sshd "Failed password for invalid user hacker from 192.168.1.100 port 4444 ssh2"
'

# Wait for the agent to pick it up (next heartbeat cycle or watcher)
wait_for_event "type=ssh_fail" 1 120 "SSH failure event detected"
