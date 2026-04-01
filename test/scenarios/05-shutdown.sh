#!/usr/bin/env bash
# Scenario 5: Agent sends shutdown event on stop.

scenario "Graceful shutdown"

reset_events

# Stop the agent service (not the container)
in_container debian systemctl stop snitchr-agent

# Wait for shutdown event (t=5)
wait_for_event "t=5" 1 15 "shutdown event received"

# Restart agent for any subsequent scenarios
in_container debian systemctl start snitchr-agent
