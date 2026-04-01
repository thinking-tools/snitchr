#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
NAME="snitchr-sandbox"
IMAGE="snitchr-sandbox:latest"

G='\033[0;32m'
D='\033[0;90m'
R='\033[0m'
info() { echo -e "${G}[sandbox]${R} $1"; }
dim()  { echo -e "${D}[sandbox]${R} $1"; }

if [[ "${1:-}" == "--wipe" ]]; then
  docker rm -f "$NAME" 2>/dev/null && info "Removed $NAME" || dim "Nothing to remove"
  exit 0
fi

# Build image if needed (reuses test/Dockerfile.debian)
if ! docker image inspect "$IMAGE" &>/dev/null; then
  info "Building sandbox image..."
  docker build -q -t "$IMAGE" -f "$DIR/test/Dockerfile.debian" "$DIR"
fi

# Reuse existing container or create new one
if docker ps -a --format '{{.Names}}' | grep -q "^${NAME}$"; then
  if ! docker ps --format '{{.Names}}' | grep -q "^${NAME}$"; then
    info "Starting existing sandbox..."
    docker start "$NAME" >/dev/null
    sleep 2
  else
    dim "Sandbox already running"
  fi
else
  info "Creating sandbox..."
  docker run -d \
    --name "$NAME" \
    --privileged \
    --tmpfs /run --tmpfs /tmp \
    --add-host=host.docker.internal:host-gateway \
    "$IMAGE" >/dev/null
  sleep 3
fi

echo ""
info "Sandbox ready"
dim "  Host URL (from inside container): http://host.docker.internal:8787"
dim "  Wipe:   npm run sandbox:wipe"
dim "  Tip:    run 'npm run dev' in another terminal first"
echo ""
info "Dropping into shell..."
echo ""

docker exec -it "$NAME" bash || true

echo ""
dim "Container kept. Data persists until 'npm run sandbox:wipe'."
