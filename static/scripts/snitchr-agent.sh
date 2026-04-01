#!/usr/bin/env bash
set -euo pipefail

readonly VERSION="0.2.0"
readonly CONFIG_DIR="/etc/snitchr"
readonly CONFIG_FILE="${CONFIG_DIR}/agent.conf"
readonly BASELINE_FILE="${CONFIG_DIR}/baseline.json"
readonly PID_FILE="/var/run/snitchr-agent.pid"
readonly LOG_TAG="snitchr-agent"

SNITCHR_URL=""
SNITCHR_TOKEN=""
MACHINE_SECRET=""
HEARTBEAT_INTERVAL=60
MACHINE_ID=""
REGISTERED=false
REGISTER_FAILURES=0
MAX_REGISTER_RETRIES=5
WATCH_AUTH_PID=""
WATCH_FILE_PID=""
REPORTED_FILE="${CONFIG_DIR}/reported"
LAST_CPU_ALERT=0
LAST_MEM_ALERT=0
LAST_DISK_ALERT=0
RESOURCE_COOLDOWN=300
# snapshot state — only sent in heartbeat when changed
PREV_PROC_LIST=""
PREV_PORT_LIST=""
PREV_MOUNT_LIST=""
PREV_TTY_LIST=""

# ── Shared utilities ────────────────────────────────────────────────────

die() { logger -t "$LOG_TAG" -p err "$1"; echo "[snitchr] ERROR: $1" >&2; exit 1; }
log() { logger -t "$LOG_TAG" "$1"; }

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

load_config() {
  [[ -f "$CONFIG_FILE" ]] || die "Config not found: $CONFIG_FILE"
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    value="${value%$'\r'}"
    value="${value#\"}" ; value="${value%\"}"
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
  SNITCHR_URL="${SNITCHR_URL%/}"
}

# ── Platform loading ────────────────────────────────────────────────────

load_platform() {
  local platform_file="${CONFIG_DIR}/platform.sh"
  if [[ ! -f "$platform_file" ]]; then
    die "Platform module not found: $platform_file (reinstall the agent)"
  fi
  # shellcheck source=/dev/null
  source "$platform_file"
}

# ── Network ─────────────────────────────────────────────────────────────

post() {
  local endpoint="$1" payload="$2" token="${3:-$MACHINE_SECRET}"
  curl -sf --max-time 10 \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "${SNITCHR_URL}${endpoint}" 2>/dev/null
}

ingest() {
  [[ "$REGISTERED" == true && -n "$MACHINE_ID" ]] || return 1
  local t="$1" d="$2"
  local code
  code=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${MACHINE_SECRET}" \
    -H "Content-Type: application/json" \
    -d "{\"t\":${t},\"d\":${d}}" \
    "${SNITCHR_URL}/m/${MACHINE_ID}/ingest" 2>/dev/null) || true

  if [[ "$code" == "404" ]]; then
    log "Machine unknown on server — will re-register"
    platform_sedi '/^MACHINE_ID=/d; /^MACHINE_SECRET=/d' "$CONFIG_FILE"
    MACHINE_ID="" MACHINE_SECRET="" REGISTERED=false REGISTER_FAILURES=0
    return 1
  fi
  [[ "$code" == "200" ]]
}

# ── Data collection ─────────────────────────────────────────────────────

collect_heartbeat() {
  local cpu mem disk load ports users net up procs ts
  cpu=$(get_cpu)
  IFS=',' read -r mem_used mem_total <<< "$(get_mem)"
  disk=$(get_disk)
  load=$(get_load)
  ports=$(get_ports)
  users=$(get_users)
  net=$(get_net)
  up=$(get_uptime)
  procs=$(get_procs)
  ts=$(date +%s)

  local base
  base=$(printf '{"ts":%d,"up":%s,"cpu":%s,"mem":[%s,%s],"disk":[%s],"load":[%s],"procs":%s,"net":[%s],"ports":"%s","users":"%s"' \
    "$ts" "$up" "$cpu" "$mem_used" "$mem_total" "$disk" "$load" "$procs" "$net" "$(json_escape "$ports")" "$(json_escape "$users")")

  # snapshot fields — only included when changed
  local cur_procs cur_ports cur_mounts cur_ttys snap=""
  cur_procs=$(get_proc_list)
  if [[ "$cur_procs" != "$PREV_PROC_LIST" ]]; then
    snap="${snap},\"procList\":\"$(json_escape "$cur_procs")\""
    PREV_PROC_LIST="$cur_procs"
  fi
  cur_ports=$(get_ports_detail)
  if [[ "$cur_ports" != "$PREV_PORT_LIST" ]]; then
    snap="${snap},\"portList\":[${cur_ports}]"
    PREV_PORT_LIST="$cur_ports"
  fi
  cur_mounts=$(get_mount_list)
  if [[ "$cur_mounts" != "$PREV_MOUNT_LIST" ]]; then
    snap="${snap},\"mountList\":[${cur_mounts}]"
    PREV_MOUNT_LIST="$cur_mounts"
  fi
  cur_ttys=$(get_tty_list)
  if [[ "$cur_ttys" != "$PREV_TTY_LIST" ]]; then
    snap="${snap},\"ttyList\":[${cur_ttys}]"
    PREV_TTY_LIST="$cur_ttys"
  fi

  printf '%s%s}' "$base" "$snap"
}

collect_baseline() {
  local procs ports
  procs=$(get_filtered_procs | paste -sd'|' -)
  ports=$(get_ports)
  printf '{"procs":"%s","ports":"%s","ts":%d}' "$procs" "$ports" "$(date +%s)"
}

# ── Registration ────────────────────────────────────────────────────────

register() {
  local sysinfo resp http_code
  sysinfo=$(collect_sysinfo)
  log "Registering with ${SNITCHR_URL}..."

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
    MACHINE_ID=$(echo "$resp" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
    MACHINE_SECRET=$(echo "$resp" | grep -o '"secret":"[^"]*"' | cut -d'"' -f4)
    if [[ -n "$MACHINE_ID" && -n "$MACHINE_SECRET" ]]; then
      if [[ ! "$MACHINE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
        log "Registration rejected: invalid machine ID format"
        MACHINE_ID="" ; MACHINE_SECRET="" ; return
      fi
      if [[ ! "$MACHINE_SECRET" =~ ^[0-9a-f]{48}$ ]]; then
        log "Registration rejected: invalid secret format"
        MACHINE_ID="" ; MACHINE_SECRET="" ; return
      fi
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

capture_baseline() {
  local baseline
  baseline=$(collect_baseline)
  echo "$baseline" > "$BASELINE_FILE"
  > "$REPORTED_FILE"
  log "Baseline captured: $(echo "$baseline" | wc -c) bytes"
}

check_process_diff() {
  [[ -f "$BASELINE_FILE" ]] || return 0
  local current baseline_procs new_procs
  current=$(get_filtered_procs)
  baseline_procs=$(grep -o '"procs":"[^"]*"' "$BASELINE_FILE" | cut -d'"' -f4 | tr '|' '\n' | sort)
  new_procs=$(comm -23 <(echo "$current") <(echo "$baseline_procs") | head -20)

  [[ -z "$new_procs" ]] && return 0

  while IFS= read -r proc; do
    [[ -z "$proc" ]] && continue
    grep -qxF "proc:$proc" "$REPORTED_FILE" 2>/dev/null && continue
    local user
    user=$(get_proc_user "$proc")
    ingest 2 \
      "$(printf '{"type":"new_process","msg":"New process not in baseline: %s (user: %s)"}' \
        "$(json_escape "$(echo "$proc" | head -c 200)")" "$(json_escape "${user:-unknown}")")" || true
    echo "proc:$proc" >> "$REPORTED_FILE"
  done <<< "$new_procs"
}

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

check_mount_diff() {
  local current prev new_mounts removed_mounts
  local state_file="${CONFIG_DIR}/mount_state"
  current=$(get_mounts)

  if [[ ! -f "$state_file" ]]; then
    echo "$current" > "$state_file"
    return 0
  fi

  prev=$(sort "$state_file")
  new_mounts=$(comm -23 <(echo "$current") <(echo "$prev"))
  removed_mounts=$(comm -23 <(echo "$prev") <(echo "$current"))

  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    local src tgt fstype
    IFS=':' read -r src tgt fstype <<< "$entry"
    ingest 2 \
      "$(printf '{"type":"mount_change","msg":"New mount: %s on %s (%s)"}' \
        "$(json_escape "$src")" "$(json_escape "$tgt")" "$(json_escape "$fstype")")" || true
  done <<< "$new_mounts"

  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    local src tgt fstype
    IFS=':' read -r src tgt fstype <<< "$entry"
    ingest 2 \
      "$(printf '{"type":"mount_change","msg":"Unmounted: %s from %s (%s)"}' \
        "$(json_escape "$src")" "$(json_escape "$tgt")" "$(json_escape "$fstype")")" || true
  done <<< "$removed_mounts"

  echo "$current" > "$state_file"
}

check_file_integrity() {
  local hashfile="${CONFIG_DIR}/file_hashes"
  local f

  while IFS= read -r f; do
    [[ -f "$f" ]] || continue
    local current_hash prev_hash
    current_hash=$(platform_hash_file "$f")
    prev_hash=$(grep "^${f} " "$hashfile" 2>/dev/null | awk '{print $2}' || true)

    if [[ -n "$prev_hash" && "$current_hash" != "$prev_hash" ]]; then
      ingest 3 \
        "$(printf '{"type":"file_change","msg":"File modified: %s"}' "$f")" || true
    fi

    if [[ -f "$hashfile" ]]; then
      platform_sedi "\|^${f} |d" "$hashfile"
    fi
    echo "${f} ${current_hash}" >> "$hashfile"
  done < <(platform_watched_files)

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

send_heartbeat() {
  local payload
  payload=$(collect_heartbeat)
  ingest 0 "$payload" || log "Heartbeat failed"
}

# ── Lifecycle ───────────────────────────────────────────────────────────

cleanup() {
  log "Shutting down..."
  if [[ "$REGISTERED" == true ]]; then
    curl -sf --max-time 3 \
      -H "Authorization: Bearer ${MACHINE_SECRET}" \
      -H "Content-Type: application/json" \
      -d '{"t":5,"d":{"type":"shutdown","msg":"Graceful shutdown"}}' \
      "${SNITCHR_URL}/m/${MACHINE_ID}/ingest" 2>/dev/null || true
  fi
  [[ -n "$WATCH_AUTH_PID" ]] && kill "$WATCH_AUTH_PID" 2>/dev/null
  [[ -n "$WATCH_FILE_PID" ]] && kill "$WATCH_FILE_PID" 2>/dev/null
  rm -f "$PID_FILE"
  exit 0
}

start_watchers() {
  watch_auth &
  WATCH_AUTH_PID=$!
  log "Auth watcher started (pid ${WATCH_AUTH_PID})"

  watch_files &
  WATCH_FILE_PID=$!
  log "File watcher started (pid ${WATCH_FILE_PID})"
}

# ── Main loop ───────────────────────────────────────────────────────────

main_loop() {
  local tick=0
  local baseline_interval=3600

  while true; do
    if [[ "$REGISTERED" != true ]]; then
      if (( REGISTER_FAILURES >= MAX_REGISTER_RETRIES )); then
        log "Registration failed ${MAX_REGISTER_RETRIES} times — stopping. Reinstall the agent with a fresh token."
        cleanup
      fi
      register
      if [[ "$REGISTERED" != true ]]; then
        REGISTER_FAILURES=$((REGISTER_FAILURES + 1))
        local backoff=$(( HEARTBEAT_INTERVAL * (1 << REGISTER_FAILURES) ))
        (( backoff > 600 )) && backoff=600
        log "Registration failed (${REGISTER_FAILURES}/${MAX_REGISTER_RETRIES}) — retrying in ${backoff}s"
        sleep "$backoff" & wait $! 2>/dev/null || true
        continue
      fi
      REGISTER_FAILURES=0
    fi

    # polling fallback: only runs if real-time watcher is not active
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

    check_process_diff
    check_port_diff
    check_mount_diff
    check_resources
    send_heartbeat

    if (( tick >= baseline_interval )); then
      capture_baseline
      tick=0
    fi

    sleep "$HEARTBEAT_INTERVAL" &
    wait $! 2>/dev/null || true
  done
}

main() {
  [[ $EUID -eq 0 ]] || die "Must run as root"

  trap cleanup SIGTERM SIGINT

  load_config
  load_platform

  echo $$ > "$PID_FILE"

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

  if [[ ! -f "$BASELINE_FILE" ]]; then
    sleep 1
    capture_baseline
  fi

  main_loop
}

main "$@"
