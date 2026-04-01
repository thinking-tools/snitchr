#!/usr/bin/env bash
# Shared helpers: colors, logging, json extraction.

G='\033[0;32m'
R_C='\033[0;31m'
Y='\033[0;33m'
D='\033[0;90m'
B='\033[1m'
RST='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0

info() { echo -e "${G}>${RST} $1"; }
warn() { echo -e "${Y}>${RST} $1"; }
dim()  { echo -e "${D}  $1${RST}"; }
pass() { ((PASS_COUNT++)); echo -e "  ${G}+${RST} $1"; }
fail() { ((FAIL_COUNT++)); echo -e "  ${R_C}x${RST} $1"; }
scenario() { echo -e "\n${B}> $1${RST}"; }

# Extract a top-level JSON value by key (no jq dependency).
# Usage: json_val '{"a":1}' a => 1
json_val() {
  local json="$1" key="$2"
  # Handle string values (with quotes)
  local val
  val=$(printf '%s' "$json" | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p")
  if [[ -n "$val" ]]; then
    printf '%s' "$val"
    return
  fi
  # Handle numeric/boolean/null values
  val=$(printf '%s' "$json" | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\([^,}]*\).*/\1/p")
  printf '%s' "$val"
}

# Extract array length from a JSON array field.
# Usage: json_arr_len '{"a":[1,2,3]}' a => 3
json_arr_len() {
  local json="$1" key="$2"
  local arr
  arr=$(printf '%s' "$json" | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\(\[[^]]*\]\).*/\1/p")
  if [[ -z "$arr" || "$arr" == "[]" ]]; then
    echo 0
    return
  fi
  # Count commas + 1
  local commas
  commas=$(printf '%s' "$arr" | tr -cd ',' | wc -c | tr -d ' ')
  echo $((commas + 1))
}

print_summary() {
  local total=$((PASS_COUNT + FAIL_COUNT))
  echo ""
  echo -e "${B}--- Results ---${RST}"
  echo -e "  ${G}${PASS_COUNT} passed${RST}, ${R_C}${FAIL_COUNT} failed${RST} (${total} total)"
  echo ""
  if (( FAIL_COUNT > 0 )); then
    return 1
  fi
}
