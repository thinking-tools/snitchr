#!/usr/bin/env bash
# Real gateway API wrappers.
# Requires: GATEWAY_URL, SESSION (set after login).

SESSION=""

# POST /api/setup — configure the gateway.
# Sets SESSION on success.
api_setup() {
  local password="$1" storage_mode="$2"
  shift 2
  local extra_fields=""
  while [[ $# -gt 0 ]]; do
    extra_fields="${extra_fields}, \"$1\": \"$2\""
    shift 2
  done

  local body="{\"password\": \"${password}\", \"passwordConfirm\": \"${password}\", \"storageMode\": \"${storage_mode}\"${extra_fields}}"
  local resp headers
  resp=$(curl -sS -D /dev/stderr -X POST "${GATEWAY_URL}/api/setup" \
    -H 'Content-Type: application/json' \
    -d "$body" 2>/tmp/e2e_headers)
  headers=$(cat /tmp/e2e_headers)

  local ok
  ok=$(json_val "$resp" ok)
  if [[ "$ok" != "true" ]]; then
    local err
    err=$(json_val "$resp" error)
    warn "Setup failed: ${err:-$resp}"
    return 1
  fi

  SESSION=$(printf '%s' "$headers" | grep -i 'set-cookie' | sed 's/.*session=\([^;]*\).*/\1/' | head -1)
  if [[ -z "$SESSION" ]]; then
    warn "Setup succeeded but no session cookie returned"
    return 1
  fi
  dim "Session: ${SESSION:0:20}..."
}

# POST /api/login
api_login() {
  local password="$1"
  local resp headers
  resp=$(curl -sS -D /dev/stderr -X POST "${GATEWAY_URL}/api/login" \
    -H 'Content-Type: application/json' \
    -d "{\"password\": \"${password}\"}" 2>/tmp/e2e_headers)
  headers=$(cat /tmp/e2e_headers)

  local ok
  ok=$(json_val "$resp" ok)
  if [[ "$ok" != "true" ]]; then
    local err
    err=$(json_val "$resp" error)
    warn "Login failed: ${err:-$resp}"
    return 1
  fi

  SESSION=$(printf '%s' "$headers" | grep -i 'set-cookie' | sed 's/.*session=\([^;]*\).*/\1/' | head -1)
}

# Authenticated GET helper.
api_get() {
  local path="$1"
  curl -sS -H "Cookie: session=${SESSION}" "${GATEWAY_URL}${path}"
}

# Authenticated POST helper.
api_post() {
  local path="$1"
  shift
  curl -sS -H "Cookie: session=${SESSION}" -H 'Content-Type: application/json' \
    -X POST "${GATEWAY_URL}${path}" "$@"
}

# Authenticated DELETE helper.
api_delete() {
  local path="$1"
  curl -sS -H "Cookie: session=${SESSION}" -X DELETE "${GATEWAY_URL}${path}"
}

# POST /api/install-token — get a one-time install token.
api_install_token() {
  local resp
  resp=$(api_post "/api/install-token")
  json_val "$resp" token
}

# GET /api/machines — list all machines.
api_machines() {
  api_get "/api/machines"
}

# GET /api/machines/:id — single machine details.
api_machine() {
  local id="$1"
  api_get "/api/machines/${id}"
}

# GET /api/machines/:id/alerts — machine alerts.
api_alerts() {
  local id="$1"
  api_get "/api/machines/${id}/alerts"
}

# DELETE /api/machines/:id/alerts — clear alerts.
api_clear_alerts() {
  local id="$1"
  api_delete "/api/machines/${id}/alerts"
}
