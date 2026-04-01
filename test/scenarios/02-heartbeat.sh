#!/usr/bin/env bash
# Scenario 2: Agent sends heartbeats with valid structure.

scenario "Heartbeat delivery"

# Wait up to 90s for at least 1 heartbeat (agent sends every 60s)
wait_for_event "t=0" 1 90 "at least 1 heartbeat received"
