#!/usr/bin/env bash
# Docker agent lifecycle: build, start, install, stop.

AGENT_CONTAINER=""
COMPOSE_FILE="${PROJECT_ROOT}/test/e2e/docker-compose.yml"

# Build the agent Docker image.
build_agent() {
  info "Building agent container..."
  docker compose -f "$COMPOSE_FILE" build --quiet
}

# Start the agent container.
start_agent() {
  info "Starting agent container..."
  docker compose -f "$COMPOSE_FILE" up -d agent

  # Wait for systemd to be ready
  local elapsed=0
  for _ in $(seq 1 30); do
    if docker compose -f "$COMPOSE_FILE" exec -T agent \
      systemctl is-system-running --wait 2>/dev/null | grep -qE 'running|degraded'; then
      dim "Agent systemd ready (${elapsed}s)"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  dim "Agent systemd: $(docker compose -f "$COMPOSE_FILE" exec -T agent systemctl is-system-running 2>/dev/null || echo 'unknown')"
}

# Install the snitchr agent into the container using the real install flow.
# The install script is fetched from localhost, then the gateway URL is
# rewritten to host.docker.internal so the agent inside Docker can reach it.
install_agent() {
  local install_token="$1"
  local docker_gateway_url="http://host.docker.internal:${GATEWAY_PORT}"

  info "Installing agent via real install flow..."

  # Fetch install script from the real gateway (on localhost)
  local script
  script=$(curl -sS "${GATEWAY_URL}/agent?init=${install_token}")
  if [[ -z "$script" ]] || echo "$script" | grep -q "Invalid or expired"; then
    warn "Failed to fetch install script: ${script}"
    return 1
  fi

  # Rewrite the gateway URL to host.docker.internal for Docker networking
  script=$(echo "$script" | sed "s|http://localhost:${GATEWAY_PORT}|${docker_gateway_url}|g")

  # Run install script inside the container
  echo "$script" | docker compose -f "$COMPOSE_FILE" exec -T agent bash >/dev/null 2>&1

  # Patch heartbeat interval to 10s for faster testing
  docker compose -f "$COMPOSE_FILE" exec -T agent bash -c '
    sed -i "s/HEARTBEAT_INTERVAL=60/HEARTBEAT_INTERVAL=10/" /etc/snitchr/agent.conf
    systemctl restart snitchr-agent
  '
  dim "Agent installed, heartbeat interval set to 10s"
}

# Run a command inside the agent container.
in_agent() {
  docker compose -f "$COMPOSE_FILE" exec -T agent "$@" 2>/dev/null
}

# Stop and remove the agent container.
stop_agent() {
  dim "Stopping agent container..."
  docker compose -f "$COMPOSE_FILE" down --timeout 5 2>/dev/null || true
}
