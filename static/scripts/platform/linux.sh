#!/usr/bin/env bash
# Platform module: Linux
# Provides metric collectors, security watchers, and utilities for Linux systems.
# Sourced by snitchr-agent.sh — all functions here are part of the platform interface.

# ── Metric collectors ───────────────────────────────────────────────────

get_cpu() {
  local c1 c2 idle1 idle2 total1 total2
  read -r _ c1 <<< "$(head -1 /proc/stat)"
  idle1=$(echo "$c1" | awk '{print $4}')
  total1=$(echo "$c1" | awk '{s=0; for(i=1;i<=NF;i++) s+=$i; print s}')
  sleep 1
  read -r _ c2 <<< "$(head -1 /proc/stat)"
  idle2=$(echo "$c2" | awk '{print $4}')
  total2=$(echo "$c2" | awk '{s=0; for(i=1;i<=NF;i++) s+=$i; print s}')
  awk "BEGIN{printf \"%.1f\", 100*(1-($idle2-$idle1)/($total2-$total1))}"
}

get_mem() {
  awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{printf "%d,%d",(t-a)/1024,t/1024}' /proc/meminfo
}

get_disk() {
  df -BM --output=pcent,target / | tail -1 | awk '{gsub(/%/,""); printf "%d", $1}'
}

get_load() {
  cut -d' ' -f1-3 /proc/loadavg | tr ' ' ','
}

get_net() {
  awk '/:/{rx+=$2; tx+=$10} END{printf "%d,%d",rx,tx}' /proc/net/dev
}

get_uptime() {
  awk '{printf "%d",$1}' /proc/uptime
}

get_procs() {
  find /proc -maxdepth 1 -regex '/proc/[0-9]+' 2>/dev/null | wc -l
}

# ── Snapshot collectors ─────────────────────────────────────────────────

get_ports() {
  ss -tlnp4 2>/dev/null | awk 'NR>1{split($4,a,":"); print a[length(a)]}' | sort -un | paste -sd, - || echo ""
}

get_mounts() {
  findmnt -rno SOURCE,TARGET,FSTYPE 2>/dev/null \
    | grep -vE ' (proc|sysfs|devpts|cgroup2?|tmpfs|devtmpfs|securityfs|debugfs|tracefs|pstore|configfs|fusectl|hugetlbfs|mqueue|binfmt_misc|autofs|nsfs|bpf|overlay|squashfs|ramfs|rpc_pipefs|nfsd|efivarfs)$' \
    | awk '{print $1 ":" $2 ":" $3}' | sort || echo ""
}

get_users() {
  who 2>/dev/null | awk '{print $1}' | sort -u | paste -sd, - || echo ""
}

get_proc_list() {
  ps -eo pgid=,comm= --no-headers 2>/dev/null \
    | awk -v pgid="$$" '$1+0 != pgid+0 {print $2}' | sort -u | paste -sd'|' -
}

get_ports_detail() {
  ss -tlnp4 2>/dev/null | awk 'NR>1{
    split($4,a,":")
    port=a[length(a)]
    addr=substr($4,1,length($4)-length(port)-1)
    proc="unknown"
    if(match($0,/users:\(\("([^"]+)"/,m)) proc=m[1]
    printf "{\"port\":%s,\"addr\":\"%s\",\"proc\":\"%s\"},", port, addr, proc
  }' | sed 's/,$//'
}

get_mount_list() {
  findmnt -rno SOURCE,TARGET,FSTYPE 2>/dev/null \
    | grep -vE ' (proc|sysfs|devpts|cgroup2?|tmpfs|devtmpfs|securityfs|debugfs|tracefs|pstore|configfs|fusectl|hugetlbfs|mqueue|binfmt_misc|autofs|nsfs|bpf|overlay|squashfs|ramfs|rpc_pipefs|nfsd|efivarfs)$' \
    | awk '{printf "{\"src\":\"%s\",\"target\":\"%s\",\"fs\":\"%s\"},", $1, $2, $3}' | sed 's/,$//'
}

get_tty_list() {
  who 2>/dev/null | awk '{
    user=$1; tty=$2; from=($NF ~ /^\(/) ? substr($NF,2,length($NF)-2) : "";
    ts=$3 " " $4
    printf "{\"user\":\"%s\",\"tty\":\"%s\",\"from\":\"%s\",\"login\":\"%s\"},", user, tty, from, ts
  }' | sed 's/,$//'
}

collect_sysinfo() {
  local hn fqdn os kernel arch cores ram_mb disk_gb
  hn=$(hostname -s 2>/dev/null || cat /etc/hostname)
  fqdn=$(hostname -f 2>/dev/null || echo "$hn")
  os=$(grep PRETTY_NAME /etc/os-release 2>/dev/null | cut -d'"' -f2 || echo "unknown")
  kernel=$(uname -r)
  arch=$(uname -m)
  cores=$(nproc)
  ram_mb=$(awk '/MemTotal/{printf "%d",$2/1024}' /proc/meminfo)
  disk_gb=$(df -BG --output=size / | tail -1 | tr -dc '0-9')

  printf '{"hostname":"%s","fqdn":"%s","os":"%s","kernel":"%s","arch":"%s","cores":%d,"ram_mb":%d,"disk_gb":%d}' \
    "$(json_escape "$hn")" "$(json_escape "$fqdn")" "$(json_escape "$os")" "$(json_escape "$kernel")" "$(json_escape "$arch")" "$cores" "$ram_mb" "$disk_gb"
}

# ── Process / port helpers ──────────────────────────────────────────────

get_filtered_procs() {
  ps -eo pgid=,comm= --no-headers 2>/dev/null \
    | awk -v pgid="$$" '$1+0 != pgid+0 {print $2}' | sort -u
}

get_proc_user() {
  ps -eo user=,comm= --no-headers 2>/dev/null \
    | awk -v p="$1" '$2 == p {print $1; exit}'
}

get_port_proc() {
  ss -tlnp4 "sport = :$1" 2>/dev/null \
    | awk 'NR>1{match($0,/users:\(\("([^"]+)"/,a); print a[1]}' | head -1
}

# ── File integrity ──────────────────────────────────────────────────────

platform_watched_files() {
  local files=(
    /etc/passwd /etc/group /etc/shadow /etc/sudoers
    /etc/ssh/sshd_config /root/.ssh/authorized_keys /etc/crontab
  )
  printf '%s\n' "${files[@]}"
}

platform_watched_dirs() {
  local dirs=(/var/spool/cron/crontabs /etc/cron.d)
  printf '%s\n' "${dirs[@]}"
}

platform_hash_file() {
  sha256sum "$1" 2>/dev/null | awk '{print $1}'
}

platform_sedi() {
  sed -i "$@"
}

# ── Security watchers ──────────────────────────────────────────────────

check_auth_events() {
  journalctl SYSLOG_IDENTIFIER=sshd + SYSLOG_IDENTIFIER=sudo + SYSLOG_IDENTIFIER=su + SYSLOG_IDENTIFIER=su-l \
    --since "$(date -d "-${HEARTBEAT_INTERVAL} seconds" '+%Y-%m-%d %H:%M:%S')" \
    --no-pager --output json 2>/dev/null | while IFS= read -r line; do
    local msg unit ident
    msg=$(echo "$line" | grep -o '"MESSAGE":"[^"]*"' | cut -d'"' -f4 || true)
    unit=$(echo "$line" | grep -o '"_SYSTEMD_UNIT":"[^"]*"' | cut -d'"' -f4 || true)
    ident=$(echo "$line" | grep -o '"SYSLOG_IDENTIFIER":"[^"]*"' | cut -d'"' -f4 || true)
    [[ -z "$msg" ]] && continue

    local etype="" t=0
    case "$msg" in
      *"Accepted "*)              t=2; etype="ssh_login" ;;
      *"Failed password"*)        t=2; etype="ssh_fail" ;;
      *"session opened"*sudo*)    t=2; etype="sudo" ;;
      *"session opened"*"su:"*)   t=2; etype="su" ;;
      *"session opened"*"su-l:"*) t=2; etype="su" ;;
      *"Successful su for"*)      t=2; etype="su" ;;
      *"FAILED su for"*)          t=2; etype="su" ;;
      *"FAILED SU"*)              t=2; etype="su" ;;
      *"authentication failure"*) t=2; etype="auth_fail" ;;
    esac

    [[ -z "$etype" ]] && continue

    ingest "$t" \
      "$(printf '{"type":"%s","msg":"%s","unit":"%s"}' \
        "$etype" "$(json_escape "$(echo "$msg" | head -c 500)")" "$(json_escape "${ident:-${unit}}")")" || true
  done
}

watch_auth() {
  if ! command -v journalctl &>/dev/null; then
    log "journalctl not found — auth events detected by polling only"
    return
  fi
  journalctl SYSLOG_IDENTIFIER=sshd + SYSLOG_IDENTIFIER=sudo + SYSLOG_IDENTIFIER=su + SYSLOG_IDENTIFIER=su-l \
    -f --output json --since "now" 2>/dev/null | while IFS= read -r line; do
    local msg unit ident
    msg=$(echo "$line" | grep -o '"MESSAGE":"[^"]*"' | cut -d'"' -f4 || true)
    unit=$(echo "$line" | grep -o '"_SYSTEMD_UNIT":"[^"]*"' | cut -d'"' -f4 || true)
    ident=$(echo "$line" | grep -o '"SYSLOG_IDENTIFIER":"[^"]*"' | cut -d'"' -f4 || true)
    [[ -z "$msg" ]] && continue

    local etype="" t=0
    case "$msg" in
      *"Accepted "*)              t=2; etype="ssh_login" ;;
      *"Failed password"*)        t=2; etype="ssh_fail" ;;
      *"session opened"*sudo*)    t=2; etype="sudo" ;;
      *"session opened"*"su:"*)   t=2; etype="su" ;;
      *"session opened"*"su-l:"*) t=2; etype="su" ;;
      *"Successful su for"*)      t=2; etype="su" ;;
      *"FAILED su for"*)          t=2; etype="su" ;;
      *"FAILED SU"*)              t=2; etype="su" ;;
      *"authentication failure"*) t=2; etype="auth_fail" ;;
    esac
    [[ -z "$etype" ]] && continue

    ingest "$t" \
      "$(printf '{"type":"%s","msg":"%s","unit":"%s"}' \
        "$etype" "$(json_escape "$(echo "$msg" | head -c 500)")" "$(json_escape "${ident:-${unit}}")")" || true
  done
}

watch_files() {
  if ! command -v inotifywait &>/dev/null; then
    log "inotifywait not found — file changes detected by polling only"
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

  inotifywait -m -q -e modify,create,delete,move "${targets[@]}" 2>/dev/null | while read -r dir events filename; do
    local path="${dir}${filename}"
    local etype="file_change"
    [[ "$path" == */cron* ]] && etype="crontab_change"
    ingest 3 \
      "$(printf '{"type":"%s","msg":"File modified: %s (%s)"}' \
        "$etype" "$(json_escape "$path")" "$(json_escape "$events")")" || true
  done
}
