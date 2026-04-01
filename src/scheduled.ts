import type { Bindings, MachineStatus } from './types';
import { getConfig, storageFromConfig } from './config';
import { hasEnabledChannels, sendNotifications, downPayload, diskFillPayload, vapidKeysFromConfig } from './notifications';
import { predictDiskFill, hasMinAlertWindow, DEFAULT_DISK_THRESHOLD } from './disk-velocity';
import { isFeatureEnabled } from './validators';

export const scheduled = async (_event: unknown, env: Bindings) => {
  const config = await getConfig(env.SNITCHR_CONFIG);
  if (!config?.notifications || !hasEnabledChannels(config.notifications)) return;

  const store = storageFromConfig(config, env.SNITCHR_STORAGE);
  if (!store) return;

  const now = Date.now();
  const timeout = (config.heartbeatTimeout ?? 120) * 1000;
  let changed = false;

  const deps = { kv: env.SNITCHR_CONFIG, vapidKeys: vapidKeysFromConfig(config), contactEmail: env.VAPID_CONTACT };
  const diskEnabled = isFeatureEnabled(config.agentFeatures, 'disk_high');
  const horizon = 24; // hours

  for (const [id, machine] of Object.entries(config.machineList)) {
    const status = await store.getJSON<MachineStatus>(`m/${id}/status.json`);
    if (!status?.lastSeen) continue;

    // ── Down detection ──
    const stale = now - status.lastSeen > timeout;
    if (stale && !machine.notifiedDownAt) {
      const label = machine.label ?? id.slice(0, 8);
      const mctx = { machineId: id, machineLabel: label };
      const ago = Math.round((now - status.lastSeen) / 60000);
      await sendNotifications(config.notifications, downPayload(label, ago, mctx), deps);
      machine.notifiedDownAt = now;
      changed = true;
    }

    // ── Disk velocity alert ──
    if (diskEnabled && status.diskSamples?.length && hasMinAlertWindow(status.diskSamples)) {
      const prediction = predictDiskFill(status.diskSamples, DEFAULT_DISK_THRESHOLD);
      const isConcerning = prediction.trend === 'filling'
        && prediction.hoursToThreshold !== null
        && prediction.hoursToThreshold <= horizon
        && (status.d?.disk?.[0] ?? 0) > 10;

      if (isConcerning && !machine.diskFillNotifiedAt) {
        const label = machine.label ?? id.slice(0, 8);
        const mctx = { machineId: id, machineLabel: label };
        const currentPct = status.d?.disk?.[0] ?? 0;
        await sendNotifications(config.notifications, diskFillPayload(label, currentPct, prediction.hoursToThreshold!, mctx), deps);
        machine.diskFillNotifiedAt = now;
        changed = true;
      } else if (!isConcerning && machine.diskFillNotifiedAt) {
        machine.diskFillNotifiedAt = undefined;
        changed = true;
      }
    }
  }

  if (changed) {
    await env.SNITCHR_CONFIG.put('config', JSON.stringify(config));
  }
};
