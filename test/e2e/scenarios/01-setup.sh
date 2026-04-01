#!/usr/bin/env bash
# Scenario 1: Configure gateway, install agent, verify registration.

scenario "Setup & Registration"

# Configure the gateway
if [[ "$VARIANT" == "bun" ]]; then
  api_setup "$E2E_PASSWORD" "filesystem" && pass "gateway configured (filesystem)" || fail "gateway setup failed"
elif [[ "$VARIANT" == "cf" ]]; then
  _sm="${E2E_STORAGE_MODE:-s3}"
  if [[ "$_sm" == "r2" ]]; then
    api_setup "$E2E_PASSWORD" "r2" \
      && pass "gateway configured (r2)" || fail "gateway setup failed"
  else
    api_setup "$E2E_PASSWORD" "s3" \
      "s3Endpoint" "$S3_ENDPOINT" \
      "s3Bucket" "$S3_BUCKET" \
      "s3Region" "$S3_REGION" \
      "s3AccessKey" "$S3_ACCESS_KEY" \
      "s3SecretKey" "$S3_SECRET_KEY" \
      && pass "gateway configured (s3)" || fail "gateway setup failed"
  fi
fi

# Verify capabilities
_caps=$(curl -sS "${GATEWAY_URL}/api/capabilities")
_configured=$(json_val "$_caps" configured)
if [[ "$_configured" == "true" ]]; then
  pass "gateway reports configured=true"
else
  fail "gateway reports configured=${_configured}"
fi

# Generate install token and install agent
_token=$(api_install_token)
if [[ -z "$_token" ]]; then
  fail "failed to get install token"
  return 1
fi
dim "Install token: ${_token:0:16}..."

# Install agent into Docker container
install_agent "$_token"

# Wait a moment for registration
sleep 3

# Verify agent registered via dashboard API
wait_machine_online 30
