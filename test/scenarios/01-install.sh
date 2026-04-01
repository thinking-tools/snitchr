#!/usr/bin/env bash
# Scenario 1: Agent installs and registers on both distros.

scenario "Agent installation & registration"

assert_registered "agents registered with gateway"

for svc in debian ubuntu; do
  if in_container "$svc" systemctl is-active snitchr-agent >/dev/null 2>&1; then
    pass "snitchr-agent service running on ${svc}"
  else
    fail "snitchr-agent service NOT running on ${svc}"
  fi

  if in_container "$svc" test -f /etc/snitchr/agent.conf; then
    pass "agent config exists on ${svc}"
  else
    fail "agent config missing on ${svc}"
  fi
done
