#!/usr/bin/env bash
set -euo pipefail

readonly SNITCHR_DIR="/etc/snitchr"
readonly AGENT_BIN="/usr/local/bin/snitchr-agent"
readonly SERVICE_NAME="snitchr-agent"

# --- These are injected by the server when generating the install script ---
SNITCHR_URL="__SNITCHR_URL__"
SNITCHR_TOKEN="__SNITCHR_TOKEN__"
# --------------------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
DIM='\033[0;90m'
RESET='\033[0m'

info() { echo -e "${GREEN}[snitchr]${RESET} $1"; }
warn() { echo -e "${RED}[snitchr]${RESET} $1"; }
dim()  { echo -e "${DIM}[snitchr]${RESET} $1"; }

[[ $EUID -eq 0 ]] || { warn "Run as root: sudo bash -c \"\$(curl -sSL ...)\""; exit 1; }

OS_TYPE=""

detect_os() {
  case "$(uname -s)" in
    Linux)  OS_TYPE="linux" ;;
    Darwin) OS_TYPE="darwin" ;;
    *)      warn "Unsupported OS: $(uname -s)"; exit 1 ;;
  esac
}

# ── Linux dependency checks ─────────────────────────────────────────────

check_deps_linux() {
  local missing=()
  for cmd in curl ss awk grep journalctl systemctl; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  if (( ${#missing[@]} > 0 )); then
    warn "Missing: ${missing[*]}"
    info "Installing..."
    apt-get update -qq && apt-get install -y -qq curl iproute2 gawk grep systemd >/dev/null 2>&1
  fi

  if ! command -v inotifywait &>/dev/null; then
    dim "Installing inotify-tools for real-time file monitoring..."
    apt-get install -y -qq inotify-tools >/dev/null 2>&1 || dim "inotify-tools unavailable — file changes detected by polling"
  fi
}

check_os_linux() {
  if [[ -f /etc/os-release ]]; then
    source /etc/os-release
    case "$ID" in
      debian|ubuntu|pop|linuxmint|kali|raspbian) ;;
      *) warn "Untested distro: $ID. Proceeding anyway..." ;;
    esac
  else
    warn "Cannot detect OS. Proceeding anyway..."
  fi
}

# ── macOS dependency checks ─────────────────────────────────────────────

check_deps_darwin() {
  local missing=()
  for cmd in curl awk grep; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  if (( ${#missing[@]} > 0 )); then
    warn "Missing required tools: ${missing[*]}"
    exit 1
  fi

  if ! command -v fswatch &>/dev/null; then
    if command -v brew &>/dev/null; then
      dim "Installing fswatch for real-time file monitoring..."
      brew install fswatch 2>/dev/null || dim "fswatch unavailable — file changes detected by polling"
    else
      dim "fswatch not found (install via: brew install fswatch) — file changes detected by polling"
    fi
  fi
}

check_os_darwin() {
  local ver
  ver=$(sw_vers -productVersion 2>/dev/null || echo "0")
  local major="${ver%%.*}"
  if (( major < 13 )); then
    warn "macOS ${ver} detected — macOS 13+ recommended. Proceeding anyway..."
  fi
}

# ── Shared install logic ────────────────────────────────────────────────

install_agent() {
  info "Installing snitchr-agent..."

  mkdir -p "$SNITCHR_DIR"
  chmod 700 "$SNITCHR_DIR"

  cat > "${SNITCHR_DIR}/agent.conf" <<EOF
SNITCHR_URL="${SNITCHR_URL}"
SNITCHR_TOKEN="${SNITCHR_TOKEN}"
HEARTBEAT_INTERVAL=60
EOF

  chmod 600 "${SNITCHR_DIR}/agent.conf"
  dim "Config written to ${SNITCHR_DIR}/agent.conf"

  # Download agent
  curl -sSf "${SNITCHR_URL}/static/scripts/snitchr-agent.sh" -o "$AGENT_BIN"
  chmod 755 "$AGENT_BIN"
  dim "Agent binary at ${AGENT_BIN}"

  # Download platform module
  curl -sSf "${SNITCHR_URL}/static/scripts/platform/${OS_TYPE}.sh" -o "${SNITCHR_DIR}/platform.sh"
  chmod 644 "${SNITCHR_DIR}/platform.sh"
  dim "Platform module (${OS_TYPE}) at ${SNITCHR_DIR}/platform.sh"
}

# ── Linux service (systemd) ─────────────────────────────────────────────

install_service_linux() {
  info "Creating systemd service..."

  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=snitchr security watchdog agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${AGENT_BIN}
Restart=always
RestartSec=10
TimeoutStopSec=5
KillMode=mixed
StandardOutput=journal
StandardError=journal
SyslogIdentifier=snitchr-agent

# no mount-namespace isolation — agent must see host mounts, files, and processes
NoNewPrivileges=no

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
  dim "Service enabled and started"
}

verify_linux() {
  sleep 2
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    info "snitchr-agent is running (PID $(cat /var/run/snitchr-agent.pid 2>/dev/null || echo '?'))"
    dim "Logs: journalctl -u ${SERVICE_NAME} -f"
    dim "Config: ${SNITCHR_DIR}/agent.conf"
    dim "Stop: systemctl stop ${SERVICE_NAME}"
    dim "Remove: systemctl disable ${SERVICE_NAME} --now && rm ${AGENT_BIN} && rm -rf ${SNITCHR_DIR}"
  else
    warn "Service failed to start. Check: journalctl -u ${SERVICE_NAME} -e"
    exit 1
  fi
}

# ── macOS service (launchd) ─────────────────────────────────────────────

install_service_darwin() {
  info "Creating launchd service..."

  local plist="/Library/LaunchDaemons/sh.snitchr.agent.plist"

  # Unload previous version if present
  launchctl bootout system/sh.snitchr.agent 2>/dev/null || true

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.snitchr.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${AGENT_BIN}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/log/snitchr-agent.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/snitchr-agent.log</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
EOF

  chmod 644 "$plist"
  launchctl bootstrap system "$plist"
  dim "LaunchDaemon loaded"
}

verify_darwin() {
  sleep 2
  if launchctl print system/sh.snitchr.agent 2>/dev/null | grep -q "state = running"; then
    info "snitchr-agent is running (PID $(cat /var/run/snitchr-agent.pid 2>/dev/null || echo '?'))"
    dim "Logs: cat /var/log/snitchr-agent.log"
    dim "Config: ${SNITCHR_DIR}/agent.conf"
    dim "Stop: sudo launchctl bootout system/sh.snitchr.agent"
    dim "Remove: sudo launchctl bootout system/sh.snitchr.agent && sudo rm ${AGENT_BIN} && sudo rm -rf ${SNITCHR_DIR}"
  else
    warn "Service failed to start. Check: cat /var/log/snitchr-agent.log"
    exit 1
  fi
}

# ── Main ────────────────────────────────────────────────────────────────

main() {
  echo ""
  echo -e "  ${GREEN}◇${RESET} snitchr agent installer"
  echo -e "  ${DIM}server: ${SNITCHR_URL}${RESET}"
  echo ""

  detect_os
  dim "Detected OS: ${OS_TYPE}"

  if [[ "$OS_TYPE" == "linux" ]]; then
    check_os_linux
    check_deps_linux
    install_agent
    install_service_linux
    verify_linux
  elif [[ "$OS_TYPE" == "darwin" ]]; then
    check_os_darwin
    check_deps_darwin
    install_agent
    install_service_darwin
    verify_darwin
  fi

  echo ""
  info "Done. She sees everything. ✓ ✓"
  echo ""
}

main "$@"
