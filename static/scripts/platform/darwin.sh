#!/usr/bin/env bash
# Platform module: macOS (Darwin)
# Provides metric collectors, security watchers, and utilities for macOS systems.
# Sourced by snitchr-agent.sh — all functions here are part of the platform interface.

# ── Metric collectors ───────────────────────────────────────────────────

get_cpu() {
  # Two samples 1s apart — first is cumulative since boot, second is the delta
  top -l 2 -n 0 -s 1 2>/dev/null | grep "CPU usage" | tail -1 \
    | awk '{gsub(/%/,""); printf "%.1f", $3 + $5}'
}

get_mem() {
  local vm_output page_size total_bytes
  vm_output=$(vm_stat)
  page_size=$(echo "$vm_output" | head -1 | sed 's/[^0-9]//g')
  total_bytes=$(sysctl -n hw.memsize)
  local total_mb=$((total_bytes / 1024 / 1024))

  local active wired compressed speculative
  active=$(echo "$vm_output" | awk '/Pages active:/{gsub(/\./,"",$NF); print $NF}')
  wired=$(echo "$vm_output" | awk '/Pages wired down:/{gsub(/\./,"",$NF); print $NF}')
  compressed=$(echo "$vm_output" | awk '/Pages occupied by compressor:/{gsub(/\./,"",$NF); print $NF}')
  speculative=$(echo "$vm_output" | awk '/Pages speculative:/{gsub(/\./,"",$NF); print $NF}')

  local used_pages=$(( ${active:-0} + ${wired:-0} + ${compressed:-0} + ${speculative:-0} ))
  local used_mb=$(( used_pages * page_size / 1024 / 1024 ))

  printf '%d,%d' "$used_mb" "$total_mb"
}

get_disk() {
  # macOS df: columns are Filesystem, total, used, avail, capacity%, iused, ifree, %iused, mount
  df -k / | tail -1 | awk '{gsub(/%/,""); print $5}'
}

get_load() {
  # macOS sysctl outputs: { 2.33 2.12 2.29 }
  sysctl -n vm.loadavg | awk '{print $2","$3","$4}'
}

get_net() {
  # Link rows: NF=10 (no MAC) → Ibytes=$6, Obytes=$9; NF=11 (has MAC) → Ibytes=$7, Obytes=$10
  netstat -ib | awk '/<Link#/ && $1 !~ /^lo/ {
    if(NF>=11) {rx+=$7; tx+=$10} else {rx+=$6; tx+=$9}
  } END{printf "%d,%d",rx,tx}'
}

get_uptime() {
  local boot_sec now
  boot_sec=$(sysctl -n kern.boottime | sed 's/.*sec = \([0-9]*\).*/\1/')
  now=$(date +%s)
  echo $((now - boot_sec))
}

get_procs() {
  ps -Axo pid= 2>/dev/null | wc -l | tr -d ' '
}

# ── Snapshot collectors ─────────────────────────────────────────────────

get_ports() {
  lsof -iTCP -sTCP:LISTEN -nP 2>/dev/null \
    | awk 'NR>1{split($9,a,":"); print a[length(a)]}' | sort -un | paste -sd, - || echo ""
}

get_mounts() {
  # macOS mount format: device on mountpoint (fstype, options...)
  mount 2>/dev/null | grep -vE '(devfs|autofs|map |com\.apple)' | while IFS= read -r line; do
    local dev rest target fs
    dev="${line%% on *}"
    rest="${line#* on }"
    target="${rest%% (*}"
    fs="${rest##*(}"
    fs="${fs%%,*}"
    fs="${fs%%)*}"
    echo "${dev}:${target}:${fs}"
  done | sort || echo ""
}

get_users() {
  who 2>/dev/null | awk '{print $1}' | sort -u | paste -sd, - || echo ""
}

get_proc_list() {
  # macOS ps shows full path — extract basename
  ps -Ao pgid=,comm= 2>/dev/null \
    | awk -v pgid="$$" '$1+0 != pgid+0 {n=split($2,a,"/"); print a[n]}' | sort -u | paste -sd'|' -
}

get_ports_detail() {
  # Deduplicate by port (lsof shows both IPv4 and IPv6 entries)
  lsof -iTCP -sTCP:LISTEN -nP 2>/dev/null | awk 'NR>1{
    split($9,a,":")
    port=a[length(a)]
    if(seen[port]++) next
    addr=($9 ~ /^\*:/) ? "*" : substr($9,1,length($9)-length(port)-1)
    proc=$1
    printf "{\"port\":%s,\"addr\":\"%s\",\"proc\":\"%s\"},", port, addr, proc
  }' | sed 's/,$//'
}

get_mount_list() {
  mount 2>/dev/null | grep -vE '(devfs|autofs|map |com\.apple)' | while IFS= read -r line; do
    local dev rest target fs
    dev="${line%% on *}"
    rest="${line#* on }"
    target="${rest%% (*}"
    fs="${rest##*(}"
    fs="${fs%%,*}"
    fs="${fs%%)*}"
    printf '{"src":"%s","target":"%s","fs":"%s"},' "$dev" "$target" "$fs"
  done | sed 's/,$//'
}

get_tty_list() {
  # macOS who: user terminal Mon DD HH:MM (no remote host typically)
  who 2>/dev/null | awk '{
    user=$1; tty=$2; from=""
    ts=$3 " " $4
    printf "{\"user\":\"%s\",\"tty\":\"%s\",\"from\":\"%s\",\"login\":\"%s\"},", user, tty, from, ts
  }' | sed 's/,$//'
}

collect_sysinfo() {
  local hn fqdn os kernel arch cores ram_mb disk_gb
  hn=$(hostname -s 2>/dev/null || hostname)
  fqdn=$(hostname -f 2>/dev/null || echo "$hn")
  os="macOS $(sw_vers -productVersion 2>/dev/null || echo 'unknown')"
  kernel=$(uname -r)
  arch=$(uname -m)
  cores=$(sysctl -n hw.ncpu)
  ram_mb=$(($(sysctl -n hw.memsize) / 1024 / 1024))
  disk_gb=$(df -g / | tail -1 | awk '{print $2}')

  printf '{"hostname":"%s","fqdn":"%s","os":"%s","kernel":"%s","arch":"%s","cores":%d,"ram_mb":%d,"disk_gb":%d}' \
    "$(json_escape "$hn")" "$(json_escape "$fqdn")" "$(json_escape "$os")" "$(json_escape "$kernel")" "$(json_escape "$arch")" "$cores" "$ram_mb" "$disk_gb"
}

# ── Process / port helpers ──────────────────────────────────────────────

get_filtered_procs() {
  # macOS ps shows full path — extract basename
  ps -Ao pgid=,comm= 2>/dev/null \
    | awk -v pgid="$$" '$1+0 != pgid+0 {n=split($2,a,"/"); print a[n]}' | sort -u
}

get_proc_user() {
  ps -Ao user=,comm= 2>/dev/null \
    | awk -v p="$1" '{n=split($2,a,"/"); if(a[n]==p) {print $1; exit}}'
}

get_port_proc() {
  lsof -iTCP:"$1" -sTCP:LISTEN -nP 2>/dev/null | awk 'NR>1{print $1; exit}'
}

# ── File integrity ──────────────────────────────────────────────────────

platform_watched_files() {
  local files=(
    /etc/sudoers
    /etc/ssh/sshd_config
    /var/root/.ssh/authorized_keys
    /etc/hosts
    /etc/passwd
    /etc/group
    /etc/syslog.conf
  )
  printf '%s\n' "${files[@]}"
}

platform_watched_dirs() {
  local dirs=(
    /Library/LaunchDaemons
    /Library/LaunchAgents
    /etc/pam.d
    /Library/Preferences/Logging
  )
  printf '%s\n' "${dirs[@]}"
}

platform_hash_file() {
  shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
}

platform_sedi() {
  sed -i '' "$@"
}

# ── Security watchers ──────────────────────────────────────────────────

check_auth_events() {
  # macOS Unified Logging — must use full path (zsh shadows 'log' as builtin)
  /usr/bin/log show \
    --predicate 'process == "sshd" OR process == "sudo" OR process == "su" OR process == "login" OR process == "authorizationhost"' \
    --style syslog --last "${HEARTBEAT_INTERVAL}s" 2>/dev/null | while IFS= read -r line; do
    # skip header lines
    [[ "$line" == Filtering* || "$line" == Timestamp* || -z "$line" ]] && continue

    local etype="" t=0
    case "$line" in
      *"Accepted "*)              t=2; etype="ssh_login" ;;
      *"Failed password"*)        t=2; etype="ssh_fail" ;;
      *"session opened"*sudo*)    t=2; etype="sudo" ;;
      *"session opened"*"su:"*)   t=2; etype="su" ;;
      *"authentication failure"*) t=2; etype="auth_fail" ;;
      *"FAILED SU"*)              t=2; etype="su" ;;
    esac
    [[ -z "$etype" ]] && continue

    ingest "$t" \
      "$(printf '{"type":"%s","msg":"%s"}' \
        "$etype" "$(json_escape "$(echo "$line" | head -c 500)")")" || true
  done
}

watch_auth() {
  # Real-time auth event stream via macOS Unified Logging
  /usr/bin/log stream \
    --predicate 'process == "sshd" OR process == "sudo" OR process == "su" OR process == "login" OR process == "authorizationhost"' \
    --style syslog 2>/dev/null | while IFS= read -r line; do
    # skip header lines
    [[ "$line" == Filtering* || "$line" == Timestamp* || -z "$line" ]] && continue

    local etype="" t=0
    case "$line" in
      *"Accepted "*)              t=2; etype="ssh_login" ;;
      *"Failed password"*)        t=2; etype="ssh_fail" ;;
      *"session opened"*sudo*)    t=2; etype="sudo" ;;
      *"session opened"*"su:"*)   t=2; etype="su" ;;
      *"authentication failure"*) t=2; etype="auth_fail" ;;
      *"FAILED SU"*)              t=2; etype="su" ;;
    esac
    [[ -z "$etype" ]] && continue

    ingest "$t" \
      "$(printf '{"type":"%s","msg":"%s"}' \
        "$etype" "$(json_escape "$(echo "$line" | head -c 500)")")" || true
  done
}

watch_files() {
  if ! command -v fswatch &>/dev/null; then
    log "fswatch not found — file changes detected by polling only (install via: brew install fswatch)"
    return
  fi

  local targets=()
  while IFS= read -r f; do
    [[ -f "$f" ]] && targets+=("$f")
  done < <(platform_watched_files)
  while IFS= read -r d; do
    [[ -d "$d" ]] && targets+=("$d")
  done < <(platform_watched_dirs)
  (( ${#targets[@]} == 0 )) && return

  fswatch -0 "${targets[@]}" 2>/dev/null | while IFS= read -r -d '' path; do
    local etype="file_change"
    [[ "$path" == */cron* || "$path" == */LaunchDaemons/* || "$path" == */LaunchAgents/* ]] && etype="crontab_change"
    ingest 3 \
      "$(printf '{"type":"%s","msg":"File modified: %s"}' \
        "$etype" "$(json_escape "$path")")" || true
  done
}
