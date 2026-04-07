#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# snitchr-agent.sh — Lightweight server monitoring agent
#
# This is the main agent daemon that runs on monitored machines. It:
#   1. Registers itself with a remote snitchr gateway (Cloudflare Worker / Node / Bun)
#   2. Sends periodic heartbeats with system metrics (CPU, memory, disk, network, etc.)
#   3. Detects security-relevant events (new processes, open ports, file changes,
#      auth events like SSH logins/sudo) and reports them as alerts
#   4. Maintains a baseline snapshot of processes/ports to detect drift
#
# Requires: bash 4+, curl, root privileges
# Config:   /etc/snitchr/agent.conf (SNITCHR_URL, SNITCHR_TOKEN, etc.)
# Platform: sources /etc/snitchr/platform.sh (linux.sh or darwin.sh) for OS-specific
#           metric collection, watchers, and utilities
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────────────
readonly VERSION="0.2.0"
readonly CONFIG_DIR="/etc/snitchr"
readonly CONFIG_FILE="${CONFIG_DIR}/agent.conf"    # key=value config written during install
readonly BASELINE_FILE="${CONFIG_DIR}/baseline.json" # snapshot of "known good" processes & ports
readonly PID_FILE="/var/run/snitchr-agent.pid"     # prevents duplicate instances
readonly LOG_TAG="snitchr-agent"                   # syslog tag for all log messages

# ── Runtime state (mutable globals) ───────────────────────────────────────
SNITCHR_URL=""              # gateway base URL (e.g. https://snitchr.example.com)
SNITCHR_TOKEN=""            # one-time registration token (used only during initial registration)
MACHINE_SECRET=""           # per-machine Bearer token (received after registration, used for all API calls)
HEARTBEAT_INTERVAL=60       # seconds between heartbeat cycles (configurable in agent.conf)
MACHINE_ID=""               # UUID assigned by the gateway during registration
REGISTERED=false            # whether this agent has a valid machine ID + secret
REGISTER_FAILURES=0         # consecutive failed registration attempts (triggers exponential backoff)
MAX_REGISTER_RETRIES=5      # give up after this many consecutive registration failures
WATCH_AUTH_PID=""            # PID of the background real-time auth event watcher (journalctl -f / log stream)
WATCH_FILE_PID=""            # PID of the background real-time file change watcher (inotifywait / fswatch)
REPORTED_FILE="${CONFIG_DIR}/reported" # tracks already-reported process/port diffs to avoid duplicates

# Resource alert cooldowns — prevents flooding when a metric stays above threshold
LAST_CPU_ALERT=0
LAST_MEM_ALERT=0
LAST_DISK_ALERT=0
RESOURCE_COOLDOWN=300       # 5 minutes between repeated alerts for the same resource type

# Snapshot state — these are diffed each heartbeat cycle; only included in the
# heartbeat payload when they change (bandwidth optimization for the gateway)
PREV_PROC_LIST=""
PREV_PORT_LIST=""
PREV_MOUNT_LIST=""
PREV_TTY_LIST=""

# ── Shared utilities ────────────────────────────────────────────────────

# Fatal error: log to syslog + stderr, then exit
die() { logger -t "$LOG_TAG" -p err "$1"; echo "[snitchr] ERROR: $1" >&2; exit 1; }
# Non-fatal log: writes to syslog only
log() { logger -t "$LOG_TAG" "$1"; }

# Escape a string for safe embedding in JSON values.
# Handles backslashes, quotes, newlines, carriage returns, and tabs.
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

# Parse /etc/snitchr/agent.conf (key=value format) into global variables.
# The config file is written by the install script and updated during registration
# (MACHINE_ID and MACHINE_SECRET are appended after successful registration).
load_config() {
  [[ -f "$CONFIG_FILE" ]] || die "Config not found: $CONFIG_FILE"
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    value="${value%$'\r'}"          # strip trailing CR (Windows line endings)
    value="${value#\"}" ; value="${value%\"}"  # strip surrounding quotes
    case "$key" in
      SNITCHR_URL)       SNITCHR_URL="$value" ;;
      SNITCHR_TOKEN)     SNITCHR_TOKEN="$value" ;;
      MACHINE_ID)         MACHINE_ID="$value" ;;
      MACHINE_SECRET)     MACHINE_SECRET="$value" ;;
      HEARTBEAT_INTERVAL) HEARTBEAT_INTERVAL="$value" ;;
    esac
  done < "$CONFIG_FILE"
  [[ -n "$SNITCHR_URL" ]] || die "SNITCHR_URL not set in config"
  [[ -n "$SNITCHR_TOKEN" ]] || die "SNITCHR_TOKEN not set in config"
  SNITCHR_URL="${SNITCHR_URL%/}"  # normalize: strip trailing slash
}

# ── Platform loading ────────────────────────────────────────────────────

# Source the OS-specific platform module (linux.sh or darwin.sh).
# The install script symlinks the correct one to /etc/snitchr/platform.sh.
# This module provides all the get_* metric functions, watch_auth, watch_files,
# collect_sysinfo, file integrity helpers, and platform_sedi.
load_platform() {
  local platform_file="${CONFIG_DIR}/platform.sh"
  if [[ ! -f "$platform_file" ]]; then
    die "Platform module not found: $platform_file (reinstall the agent)"
  fi
  # shellcheck source=/dev/null
  source "$platform_file"
}

# ── Network ─────────────────────────────────────────────────────────────

# Generic authenticated POST to the gateway. Used during registration.
post() {
  local endpoint="$1" payload="$2" token="${3:-$MACHINE_SECRET}"
  curl -sf --max-time 10 \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "${SNITCHR_URL}${endpoint}" 2>/dev/null
}

# Send an event to the gateway's ingest endpoint: POST /m/{id}/ingest
# $1 = event type (t): 0=heartbeat, 1-4=alert severity levels, 5=shutdown
# $2 = JSON payload (d): the event data
# Returns 0 on success (HTTP 200), 1 on failure.
# Special case: HTTP 404 means the machine was deleted server-side — triggers
# re-registration by clearing credentials from config and resetting state.
ingest() {
  [[ "$REGISTERED" == true && -n "$MACHINE_ID" ]] || return 1
  local t="$1" d="$2"
  local code
  code=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${MACHINE_SECRET}" \
    -H "Content-Type: application/json" \
    -d "{\"t\":${t},\"d\":${d}}" \
    "${SNITCHR_URL}/m/${MACHINE_ID}/ingest" 2>/dev/null) || true

  # Machine was deleted on the server — wipe local credentials and re-register
  if [[ "$code" == "404" ]]; then
    log "Machine unknown on server — will re-register"
    platform_sedi '/^MACHINE_ID=/d; /^MACHINE_SECRET=/d' "$CONFIG_FILE"
    MACHINE_ID="" MACHINE_SECRET="" REGISTERED=false REGISTER_FAILURES=0
    return 1
  fi
  [[ "$code" == "200" ]]
}

# ── Data collection ─────────────────────────────────────────────────────

# Build the JSON payload for a heartbeat event (t=0).
# Collects all system metrics via platform-specific get_* functions and
# assembles them into a single JSON object.
#
# Snapshot fields (procList, portList, mountList, ttyList) are only included
# when their values have changed since the last heartbeat — this reduces
# payload size and gateway storage for idle machines.
collect_heartbeat() {
  # Gather core metrics from platform module
  local cpu mem disk load ports users net up procs ts
  cpu=$(get_cpu)
  IFS=',' read -r mem_used mem_total <<< "$(get_mem)"
  disk=$(get_disk)
  load=$(get_load)
  ports=$(get_ports)             # comma-separated listening port numbers
  users=$(get_users)             # comma-separated logged-in usernames
  net=$(get_net)                 # rx_bytes,tx_bytes since boot
  up=$(get_uptime)               # seconds since boot
  procs=$(get_procs)             # total process count
  ts=$(date +%s)

  # Always-present fields
  local base
  base=$(printf '{"ts":%d,"up":%s,"cpu":%s,"mem":[%s,%s],"disk":[%s],"load":[%s],"procs":%s,"net":[%s],"ports":"%s","users":"%s"' \
    "$ts" "$up" "$cpu" "$mem_used" "$mem_total" "$disk" "$load" "$procs" "$net" "$(json_escape "$ports")" "$(json_escape "$users")")

  # Snapshot fields — diff against previous values, only append if changed
  local cur_procs cur_ports cur_mounts cur_ttys snap=""
  cur_procs=$(get_proc_list)     # pipe-delimited list of unique process names
  if [[ "$cur_procs" != "$PREV_PROC_LIST" ]]; then
    snap="${snap},\"procList\":\"$(json_escape "$cur_procs")\""
    PREV_PROC_LIST="$cur_procs"
  fi
  cur_ports=$(get_ports_detail)  # JSON array of {port, addr, proc} objects
  if [[ "$cur_ports" != "$PREV_PORT_LIST" ]]; then
    snap="${snap},\"portList\":[${cur_ports}]"
    PREV_PORT_LIST="$cur_ports"
  fi
  cur_mounts=$(get_mount_list)   # JSON array of {src, target, fs} objects
  if [[ "$cur_mounts" != "$PREV_MOUNT_LIST" ]]; then
    snap="${snap},\"mountList\":[${cur_mounts}]"
    PREV_MOUNT_LIST="$cur_mounts"
  fi
  cur_ttys=$(get_tty_list)       # JSON array of {user, tty, from, login} objects
  if [[ "$cur_ttys" != "$PREV_TTY_LIST" ]]; then
    snap="${snap},\"ttyList\":[${cur_ttys}]"
    PREV_TTY_LIST="$cur_ttys"
  fi

  printf '%s%s}' "$base" "$snap"
}

# Capture a "known good" snapshot of running processes and listening ports.
# Used as the reference point for check_process_diff() and check_port_diff()
# to detect new/unexpected processes and ports.
collect_baseline() {
  local procs ports
  procs=$(get_filtered_procs | paste -sd'|' -)  # pipe-delimited process names
  ports=$(get_ports)                              # comma-delimited port numbers
  printf '{"procs":"%s","ports":"%s","ts":%d}' "$procs" "$ports" "$(date +%s)"
}

# ── Registration ────────────────────────────────────────────────────────

# Register this machine with the snitchr gateway.
#
# Flow:
#   1. Collect system info (hostname, OS, CPU cores, RAM, disk) via platform module
#   2. POST to /register with the one-time install token + sysinfo
#   3. Gateway responds with {id: UUID, secret: 48-hex-char Bearer token}
#   4. Validate response format (UUIDv4 for ID, 48 hex chars for secret)
#   5. Persist credentials to agent.conf for future runs
#
# The one-time token (SNITCHR_TOKEN) is generated in the dashboard and can only
# be used once. After registration, all further API calls use MACHINE_SECRET.
register() {
  local sysinfo resp http_code
  sysinfo=$(collect_sysinfo)
  log "Registering with ${SNITCHR_URL}..."

  # Use a temp file for the response body since curl -o and -w can't both go to stdout
  local tmpfile="/tmp/snitchr_reg_$$"
  http_code=$(curl -s --max-time 10 -o "$tmpfile" -w '%{http_code}' \
    -H "Authorization: Bearer ${SNITCHR_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"${SNITCHR_TOKEN}\",\"sysinfo\":${sysinfo}}" \
    "${SNITCHR_URL}/register" 2>/dev/null) || http_code="000"
  resp=$(cat "$tmpfile" 2>/dev/null || true)
  rm -f "$tmpfile"

  if [[ "$http_code" == "000" ]]; then
    log "Registration failed: gateway unreachable at ${SNITCHR_URL}"
  elif [[ "$http_code" != "200" ]]; then
    log "Registration failed: HTTP ${http_code} — ${resp}"
  elif [[ -n "$resp" ]]; then
    # Parse machine ID and secret from JSON response (lightweight grep — no jq dependency)
    MACHINE_ID=$(echo "$resp" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
    MACHINE_SECRET=$(echo "$resp" | grep -o '"secret":"[^"]*"' | cut -d'"' -f4)
    if [[ -n "$MACHINE_ID" && -n "$MACHINE_SECRET" ]]; then
      # Validate server response format to guard against injection or corrupt data
      if [[ ! "$MACHINE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
        log "Registration rejected: invalid machine ID format"
        MACHINE_ID="" ; MACHINE_SECRET="" ; return
      fi
      if [[ ! "$MACHINE_SECRET" =~ ^[0-9a-f]{48}$ ]]; then
        log "Registration rejected: invalid secret format"
        MACHINE_ID="" ; MACHINE_SECRET="" ; return
      fi
      # Persist credentials so the agent can restart without re-registering
      echo "MACHINE_ID=\"${MACHINE_ID}\"" >> "$CONFIG_FILE"
      echo "MACHINE_SECRET=\"${MACHINE_SECRET}\"" >> "$CONFIG_FILE"
      log "Registered as ${MACHINE_ID}"
      REGISTERED=true
    fi
  fi

  if [[ "$REGISTERED" != true ]]; then
    log "Registration failed — will retry on next heartbeat"
  fi
}

# ── Security checks ────────────────────────────────────────────────────
# These functions detect anomalies by comparing current system state against
# a known baseline or previous state. Each sends alerts via ingest() when
# deviations are found. Alert severity levels: 2=warning, 3=important.

# Save current processes and ports as the "known good" baseline.
# Called at startup and refreshed every hour (baseline_interval in main_loop).
# Also resets the reported-alerts file so previously-reported diffs can fire again.
capture_baseline() {
  local baseline
  baseline=$(collect_baseline)
  echo "$baseline" > "$BASELINE_FILE"
  > "$REPORTED_FILE"  # truncate — all diffs are now relative to the new baseline
  log "Baseline captured: $(echo "$baseline" | wc -c) bytes"
}

# Compare currently running processes against the baseline.
# New processes not in the baseline are reported as level-2 alerts.
# Each process is only reported once (tracked in REPORTED_FILE) until baseline refresh.
check_process_diff() {
  [[ -f "$BASELINE_FILE" ]] || return 0
  local current baseline_procs new_procs
  current=$(get_filtered_procs)
  baseline_procs=$(grep -o '"procs":"[^"]*"' "$BASELINE_FILE" | cut -d'"' -f4 | tr '|' '\n' | sort)
  new_procs=$(comm -23 <(echo "$current") <(echo "$baseline_procs") | head -20)

  [[ -z "$new_procs" ]] && return 0

  while IFS= read -r proc; do
    [[ -z "$proc" ]] && continue
    grep -qxF "proc:$proc" "$REPORTED_FILE" 2>/dev/null && continue  # already reported
    local user
    user=$(get_proc_user "$proc")
    ingest 2 \
      "$(printf '{"type":"new_process","msg":"New process not in baseline: %s (user: %s)"}' \
        "$(json_escape "$(echo "$proc" | head -c 200)")" "$(json_escape "${user:-unknown}")")" || true
    echo "proc:$proc" >> "$REPORTED_FILE"  # mark as reported
  done <<< "$new_procs"
}

# Compare currently listening ports against the baseline.
# New ports not in the baseline are reported as level-2 alerts.
# Dedup logic mirrors check_process_diff (tracked in REPORTED_FILE).
check_port_diff() {
  [[ -f "$BASELINE_FILE" ]] || return 0
  local current baseline_ports new_ports
  current=$(get_ports | tr ',' '\n' | sort)
  baseline_ports=$(grep -o '"ports":"[^"]*"' "$BASELINE_FILE" | cut -d'"' -f4 | tr ',' '\n' | sort)
  new_ports=$(comm -23 <(echo "$current") <(echo "$baseline_ports"))

  [[ -z "$new_ports" ]] && return 0

  while IFS= read -r port; do
    [[ -z "$port" ]] && continue
    grep -qxF "port:$port" "$REPORTED_FILE" 2>/dev/null && continue
    local proc_name
    proc_name=$(get_port_proc "$port")
    ingest 2 \
      "$(printf '{"type":"new_port","msg":"New listening port :%s (%s)"}' \
        "$port" "$(json_escape "${proc_name:-unknown}")")" || true
    echo "port:$port" >> "$REPORTED_FILE"
  done <<< "$new_ports"
}

# Detect filesystem mount changes (new mounts and unmounts).
# Maintains its own state file (mount_state) separate from the baseline,
# since mounts can change legitimately (USB drives, NFS, etc.) and
# each change should be reported exactly once.
check_mount_diff() {
  local current prev new_mounts removed_mounts
  local state_file="${CONFIG_DIR}/mount_state"
  current=$(get_mounts)

  # First run: save current state as reference, nothing to diff
  if [[ ! -f "$state_file" ]]; then
    echo "$current" > "$state_file"
    return 0
  fi

  prev=$(sort "$state_file")
  new_mounts=$(comm -23 <(echo "$current") <(echo "$prev"))
  removed_mounts=$(comm -23 <(echo "$prev") <(echo "$current"))

  # Report newly appeared mounts
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    local src tgt fstype
    IFS=':' read -r src tgt fstype <<< "$entry"
    ingest 2 \
      "$(printf '{"type":"mount_change","msg":"New mount: %s on %s (%s)"}' \
        "$(json_escape "$src")" "$(json_escape "$tgt")" "$(json_escape "$fstype")")" || true
  done <<< "$new_mounts"

  # Report disappeared mounts
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    local src tgt fstype
    IFS=':' read -r src tgt fstype <<< "$entry"
    ingest 2 \
      "$(printf '{"type":"mount_change","msg":"Unmounted: %s from %s (%s)"}' \
        "$(json_escape "$src")" "$(json_escape "$tgt")" "$(json_escape "$fstype")")" || true
  done <<< "$removed_mounts"

  echo "$current" > "$state_file"  # update reference for next cycle
}

# File integrity monitoring (FIM) — detect modifications to security-critical files.
# Computes SHA-256 hashes of watched files and directories, compares against
# previously stored hashes, and sends level-3 alerts on any change.
#
# Two categories:
#   1. Individual files (platform_watched_files): /etc/passwd, /etc/shadow, sshd_config, etc.
#   2. Watched directories (platform_watched_dirs): crontab dirs, pam.d, etc. — all files within
#
# This is the polling fallback; real-time detection uses inotifywait/fswatch (watch_files).
check_file_integrity() {
  local hashfile="${CONFIG_DIR}/file_hashes"
  local f

  # Check individual security-critical files
  while IFS= read -r f; do
    [[ -f "$f" ]] || continue
    local current_hash prev_hash
    current_hash=$(platform_hash_file "$f")
    prev_hash=$(grep "^${f} " "$hashfile" 2>/dev/null | awk '{print $2}' || true)

    if [[ -n "$prev_hash" && "$current_hash" != "$prev_hash" ]]; then
      ingest 3 \
        "$(printf '{"type":"file_change","msg":"File modified: %s"}' "$f")" || true
    fi

    # Update stored hash (delete old entry, append new)
    if [[ -f "$hashfile" ]]; then
      platform_sedi "\|^${f} |d" "$hashfile"
    fi
    echo "${f} ${current_hash}" >> "$hashfile"
  done < <(platform_watched_files)

  # Check all files in watched directories (crontabs, pam configs, etc.)
  while IFS= read -r d; do
    [[ -d "$d" ]] || continue
    find "$d" -type f 2>/dev/null | while read -r f; do
      local current_hash prev_hash
      current_hash=$(platform_hash_file "$f")
      prev_hash=$(grep "^${f} " "$hashfile" 2>/dev/null | awk '{print $2}' || true)

      if [[ -n "$prev_hash" && "$current_hash" != "$prev_hash" ]]; then
        ingest 3 \
          "$(printf '{"type":"crontab_change","msg":"Crontab modified: %s"}' "$f")" || true
      fi

      platform_sedi "\|^${f} |d" "$hashfile" 2>/dev/null || true
      echo "${f} ${current_hash}" >> "$hashfile"
    done
  done < <(platform_watched_dirs)
}

# Check CPU, memory, and disk usage against >90% thresholds.
# Sends level-2 alerts when a resource exceeds the threshold, but respects
# a 5-minute cooldown (RESOURCE_COOLDOWN) per resource type to prevent alert storms
# during sustained high usage.
check_resources() {
  local now
  now=$(date +%s)

  local cpu_val
  cpu_val=$(awk "BEGIN{printf \"%d\", $(get_cpu)}")
  if (( cpu_val > 90 )) && (( now - LAST_CPU_ALERT >= RESOURCE_COOLDOWN )); then
    ingest 2 \
      "$(printf '{"type":"cpu_spike","msg":"CPU at %d%%"}' "$cpu_val")" || true
    LAST_CPU_ALERT=$now
  fi

  local mem_pct
  IFS=',' read -r mem_used mem_total <<< "$(get_mem)"
  mem_pct=$(awk "BEGIN{printf \"%d\", 100*${mem_used}/${mem_total}}")
  if (( mem_pct > 90 )) && (( now - LAST_MEM_ALERT >= RESOURCE_COOLDOWN )); then
    ingest 2 \
      "$(printf '{"type":"mem_spike","msg":"Memory at %d%% (%dMB/%dMB)"}' \
        "$mem_pct" "$mem_used" "$mem_total")" || true
    LAST_MEM_ALERT=$now
  fi

  local disk_pct
  disk_pct=$(get_disk)
  if (( disk_pct > 90 )) && (( now - LAST_DISK_ALERT >= RESOURCE_COOLDOWN )); then
    ingest 2 \
      "$(printf '{"type":"disk_high","msg":"Disk at %d%%"}' "$disk_pct")" || true
    LAST_DISK_ALERT=$now
  fi
}

# ── Heartbeat ───────────────────────────────────────────────────────────

# Send a heartbeat (t=0) with full system metrics to the gateway.
send_heartbeat() {
  local payload
  payload=$(collect_heartbeat)
  ingest 0 "$payload" || log "Heartbeat failed"
}

# ── Lifecycle ───────────────────────────────────────────────────────────

# Signal handler for SIGTERM/SIGINT — ensures graceful shutdown.
# Sends a t=5 shutdown event to the gateway so the dashboard can show the machine
# as intentionally offline (vs. unreachable), then kills background watchers.
cleanup() {
  log "Shutting down..."
  if [[ "$REGISTERED" == true ]]; then
    curl -sf --max-time 3 \
      -H "Authorization: Bearer ${MACHINE_SECRET}" \
      -H "Content-Type: application/json" \
      -d '{"t":5,"d":{"type":"shutdown","msg":"Graceful shutdown"}}' \
      "${SNITCHR_URL}/m/${MACHINE_ID}/ingest" 2>/dev/null || true
  fi
  # Terminate background watcher subprocesses
  [[ -n "$WATCH_AUTH_PID" ]] && kill "$WATCH_AUTH_PID" 2>/dev/null
  [[ -n "$WATCH_FILE_PID" ]] && kill "$WATCH_FILE_PID" 2>/dev/null
  rm -f "$PID_FILE"
  exit 0
}

# Launch background subprocesses for real-time event detection.
# These run continuously in the background (journalctl -f / inotifywait / fswatch)
# and call ingest() directly when events occur — no polling delay.
# If the required tools aren't installed, the watcher exits silently and
# main_loop falls back to polling-based detection.
start_watchers() {
  watch_auth &
  WATCH_AUTH_PID=$!
  log "Auth watcher started (pid ${WATCH_AUTH_PID})"

  watch_files &
  WATCH_FILE_PID=$!
  log "File watcher started (pid ${WATCH_FILE_PID})"
}

# ── Main loop ───────────────────────────────────────────────────────────

# Core event loop. Each iteration:
#   1. Ensure we're registered (retry with exponential backoff if not)
#   2. Run security checks (auth events, process/port/mount diffs, file integrity, resources)
#   3. Send a heartbeat with current metrics
#   4. Refresh the baseline snapshot every hour
#   5. Sleep for HEARTBEAT_INTERVAL seconds
#
# The sleep is backgrounded + waited so that SIGTERM/SIGINT can interrupt it
# immediately (bash only handles signals between commands, not during sleep).
main_loop() {
  local tick=0
  local baseline_interval=3600  # refresh baseline every hour

  while true; do
    # ── Registration retry with exponential backoff ──
    # If the machine was deleted server-side (404 from ingest), or if initial
    # registration failed, this block handles retries before resuming normal operation.
    if [[ "$REGISTERED" != true ]]; then
      if (( REGISTER_FAILURES >= MAX_REGISTER_RETRIES )); then
        log "Registration failed ${MAX_REGISTER_RETRIES} times — stopping. Reinstall the agent with a fresh token."
        cleanup
      fi
      register
      if [[ "$REGISTERED" != true ]]; then
        REGISTER_FAILURES=$((REGISTER_FAILURES + 1))
        local backoff=$(( HEARTBEAT_INTERVAL * (1 << REGISTER_FAILURES) ))  # 60s, 120s, 240s...
        (( backoff > 600 )) && backoff=600  # cap at 10 minutes
        log "Registration failed (${REGISTER_FAILURES}/${MAX_REGISTER_RETRIES}) — retrying in ${backoff}s"
        sleep "$backoff" & wait $! 2>/dev/null || true
        continue
      fi
      REGISTER_FAILURES=0
    fi

    # ── Auth & file integrity polling (fallback mode) ──
    # The real-time watchers (watch_auth, watch_files) run as background processes.
    # If they're still alive, skip polling. If they've died (tool not installed,
    # journalctl/inotifywait unavailable), fall back to periodic polling here.
    if [[ -z "$WATCH_AUTH_PID" ]]; then
      check_auth_events
    elif ! kill -0 "$WATCH_AUTH_PID" 2>/dev/null; then
      WATCH_AUTH_PID=""
      check_auth_events
    fi
    if [[ -z "$WATCH_FILE_PID" ]]; then
      check_file_integrity
    elif ! kill -0 "$WATCH_FILE_PID" 2>/dev/null; then
      WATCH_FILE_PID=""
      check_file_integrity
    fi

    tick=$((tick + HEARTBEAT_INTERVAL))

    # ── Security checks (run every heartbeat cycle) ──
    check_process_diff   # detect new processes not in baseline
    check_port_diff      # detect new listening ports not in baseline
    check_mount_diff     # detect mounted/unmounted filesystems
    check_resources      # alert on CPU/memory/disk >90%
    send_heartbeat       # send system metrics to gateway

    # ── Periodic baseline refresh (every hour) ──
    if (( tick >= baseline_interval )); then
      capture_baseline
      tick=0
    fi

    # Sleep between cycles — backgrounded so signals can interrupt immediately
    sleep "$HEARTBEAT_INTERVAL" &
    wait $! 2>/dev/null || true
  done
}

# ── Entry point ────────────────────────────────────────────────────────────
#
# Startup sequence:
#   1. Require root (needed for reading /proc, /etc/shadow, ss, journalctl, etc.)
#   2. Install signal handlers for graceful shutdown
#   3. Load config (agent.conf) and platform module (linux.sh or darwin.sh)
#   4. Write PID file (prevents duplicate instances, used by systemd/launchd)
#   5. Register with gateway if not already registered (MACHINE_ID not in config)
#   6. Launch real-time background watchers (auth events + file changes)
#   7. Capture initial baseline if first run
#   8. Enter the main heartbeat + security check loop
main() {
  [[ $EUID -eq 0 ]] || die "Must run as root"

  trap cleanup SIGTERM SIGINT

  load_config
  load_platform

  echo $$ > "$PID_FILE"

  # If MACHINE_ID is already in config (from a previous run), skip registration
  if [[ -z "${MACHINE_ID:-}" ]]; then
    register
  else
    REGISTERED=true
  fi

  if [[ "$REGISTERED" != true ]]; then
    die "Cannot start without registration"
  fi

  log "Started v${VERSION} — machine=${MACHINE_ID} interval=${HEARTBEAT_INTERVAL}s os=$(uname -s)"
  start_watchers

  # First run: wait 1s for watchers to initialize, then capture initial baseline
  if [[ ! -f "$BASELINE_FILE" ]]; then
    sleep 1
    capture_baseline
  fi

  main_loop
}

main "$@"
