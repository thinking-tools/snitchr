#!/usr/bin/env bash
# Scenario 5: Mount detection — new device mount and unmount.

scenario "Mount Detection"

if [[ -z "${MACHINE_ID_E2E:-}" ]]; then
  fail "no machine ID from previous scenario"
  return 1
fi

# Verify findmnt is available in the container
if ! in_agent findmnt --version >/dev/null 2>&1; then
  fail "findmnt not available in container — skipping mount tests"
  return 0
fi

# Clear existing alerts
api_clear_alerts "$MACHINE_ID_E2E" >/dev/null

# Create a loopback ext4 device and mount it inside the container.
# Falls back to a bind mount if loop devices aren't available (e.g. Docker Desktop VM).
MOUNT_METHOD=""
if in_agent bash -c '
  dd if=/dev/zero of=/tmp/e2e-disk.img bs=1M count=2 2>/dev/null &&
  mkfs.ext4 -qF /tmp/e2e-disk.img 2>/dev/null &&
  mkdir -p /mnt/e2e-test &&
  mount -o loop /tmp/e2e-disk.img /mnt/e2e-test 2>/dev/null
' 2>/dev/null; then
  MOUNT_METHOD="loop"
  dim "mounted loopback ext4 at /mnt/e2e-test"
else
  # Fallback: bind-mount a real directory (shows as the root fs type)
  in_agent bash -c '
    mkdir -p /tmp/e2e-bind-src /mnt/e2e-test &&
    mount --bind /tmp/e2e-bind-src /mnt/e2e-test
  '
  MOUNT_METHOD="bind"
  dim "mounted bind at /mnt/e2e-test (loop unavailable)"
fi

# Verify the mount is visible
if ! in_agent findmnt /mnt/e2e-test >/dev/null 2>&1; then
  fail "mount not visible via findmnt — aborting"
  return 1
fi

# Wait for the agent to detect the new mount
wait_for_alert "$MACHINE_ID_E2E" "mount_change" 120 "new mount detected via API"

# Clear alerts and unmount
api_clear_alerts "$MACHINE_ID_E2E" >/dev/null

in_agent bash -c '
  umount /mnt/e2e-test 2>/dev/null
  rm -rf /tmp/e2e-disk.img /tmp/e2e-bind-src
  rmdir /mnt/e2e-test 2>/dev/null || true
'

# Wait for unmount detection
wait_for_alert "$MACHINE_ID_E2E" "mount_change" 120 "unmount detected via API"
