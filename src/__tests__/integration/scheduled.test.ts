import { describe, it, expect, beforeEach, vi } from 'vitest';
import { scheduled } from '../../scheduled';
import { createTestEnv, setupConfig, addMachine, getStoredConfig } from '../helpers';
import { storageFromConfig } from '../../config';
import type { Bindings, MachineStatus, DiskSample } from '../../types';
import { InMemoryKV } from '../../kv';

const MACHINE_ID = 'test-machine-001';
const MACHINE_SECRET = 'a'.repeat(48);

describe('Scheduled handler', () => {
  let env: Bindings;
  let kv: InMemoryKV;

  beforeEach(async () => {
    ({ env, kv } = createTestEnv());
    vi.restoreAllMocks();
  });

  const ntfyNotifications = { ntfy: { type: 'ntfy' as const, endpoint: 'https://ntfy.sh/test', enabled: true } };

  it('does nothing without notification channels', async () => {
    await setupConfig(kv);
    await addMachine(kv, MACHINE_ID, MACHINE_SECRET);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    await scheduled({} as ScheduledEvent, env);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends notification for down machine', async () => {
    await setupConfig(kv, { notifications: ntfyNotifications, heartbeatTimeout: 60, machineList: {} });
    await addMachine(kv, MACHINE_ID, MACHINE_SECRET, 'my-server');

    const config = await getStoredConfig(kv);
    const store = storageFromConfig(config);
    const oldStatus: MachineStatus = { lastSeen: Date.now() - 300_000 };
    await store!.put(`m/${MACHINE_ID}/status.json`, JSON.stringify(oldStatus));

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    await scheduled({} as ScheduledEvent, env);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://ntfy.sh/test');
    expect((init as RequestInit).headers).toHaveProperty('Title');
    expect(((init as RequestInit).headers as Record<string, string>).Title).toContain('DOWN');
  });

  it('marks machine as notifiedDownAt after notification', async () => {
    await setupConfig(kv, { notifications: ntfyNotifications, heartbeatTimeout: 60, machineList: {} });
    await addMachine(kv, MACHINE_ID, MACHINE_SECRET);

    const config = await getStoredConfig(kv);
    const store = storageFromConfig(config);
    await store!.put(`m/${MACHINE_ID}/status.json`, JSON.stringify({ lastSeen: Date.now() - 300_000 }));

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    await scheduled({} as ScheduledEvent, env);

    const updated = await getStoredConfig(kv);
    expect(updated.machineList[MACHINE_ID].notifiedDownAt).toBeDefined();
  });

  it('does not re-notify already notified machine', async () => {
    await setupConfig(kv, { notifications: ntfyNotifications, heartbeatTimeout: 60, machineList: {} });
    await addMachine(kv, MACHINE_ID, MACHINE_SECRET);

    const config = await getStoredConfig(kv);
    config.machineList[MACHINE_ID].notifiedDownAt = Date.now();
    await kv.put('config', JSON.stringify(config));

    const store = storageFromConfig(config);
    await store!.put(`m/${MACHINE_ID}/status.json`, JSON.stringify({ lastSeen: Date.now() - 300_000 }));

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    await scheduled({} as ScheduledEvent, env);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips machine with no status', async () => {
    await setupConfig(kv, { notifications: ntfyNotifications, machineList: {} });
    await addMachine(kv, MACHINE_ID, MACHINE_SECRET);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    await scheduled({} as ScheduledEvent, env);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('disk velocity alerts', () => {
    const makeDiskSamples = (count: number, startPct: number, pctPerSample: number): DiskSample[] => {
      const now = Date.now();
      return Array.from({ length: count }, (_, i) => [
        now - (count - 1 - i) * 300_000, // 5min intervals
        startPct + i * pctPerSample,
      ] as DiskSample);
    };

    it('sends disk fill alert when prediction is within 24h', async () => {
      await setupConfig(kv, { notifications: ntfyNotifications, heartbeatTimeout: 120, machineList: {} });
      await addMachine(kv, MACHINE_ID, MACHINE_SECRET, 'my-server');

      const config = await getStoredConfig(kv);
      const store = storageFromConfig(config);
      // 15 samples over 70min, rising fast: 70% → 85% → will hit 90% in ~5h
      const samples = makeDiskSamples(15, 70, 1);
      const status: MachineStatus = {
        lastSeen: Date.now(),
        d: { ts: Date.now(), cpu: 10, up: 1000, procs: 50, mem: [1000, 4000], disk: [85], load: [0.5, 0.5, 0.5], net: [100, 100], ports: '22', users: 'root' },
        diskSamples: samples,
      };
      await store!.put(`m/${MACHINE_ID}/status.json`, JSON.stringify(status));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
      await scheduled({} as ScheduledEvent, env);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [, init] = fetchSpy.mock.calls[0];
      expect(((init as RequestInit).headers as Record<string, string>).Title).toContain('DISK');
    });

    it('does not alert when disk is stable', async () => {
      await setupConfig(kv, { notifications: ntfyNotifications, heartbeatTimeout: 120, machineList: {} });
      await addMachine(kv, MACHINE_ID, MACHINE_SECRET);

      const config = await getStoredConfig(kv);
      const store = storageFromConfig(config);
      const samples = makeDiskSamples(15, 50, 0); // flat at 50%
      const status: MachineStatus = {
        lastSeen: Date.now(),
        d: { ts: Date.now(), cpu: 10, up: 1000, procs: 50, mem: [1000, 4000], disk: [50], load: [0.5, 0.5, 0.5], net: [100, 100], ports: '22', users: 'root' },
        diskSamples: samples,
      };
      await store!.put(`m/${MACHINE_ID}/status.json`, JSON.stringify(status));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
      await scheduled({} as ScheduledEvent, env);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does not re-alert if already notified', async () => {
      await setupConfig(kv, { notifications: ntfyNotifications, heartbeatTimeout: 120, machineList: {} });
      await addMachine(kv, MACHINE_ID, MACHINE_SECRET);

      // Set diskFillNotifiedAt
      const config = await getStoredConfig(kv);
      config.machineList[MACHINE_ID].diskFillNotifiedAt = Date.now();
      await kv.put('config', JSON.stringify(config));

      const store = storageFromConfig(config);
      const samples = makeDiskSamples(15, 70, 1);
      const status: MachineStatus = {
        lastSeen: Date.now(),
        d: { ts: Date.now(), cpu: 10, up: 1000, procs: 50, mem: [1000, 4000], disk: [85], load: [0.5, 0.5, 0.5], net: [100, 100], ports: '22', users: 'root' },
        diskSamples: samples,
      };
      await store!.put(`m/${MACHINE_ID}/status.json`, JSON.stringify(status));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
      await scheduled({} as ScheduledEvent, env);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('clears diskFillNotifiedAt when prediction is no longer concerning', async () => {
      await setupConfig(kv, { notifications: ntfyNotifications, heartbeatTimeout: 120, machineList: {} });
      await addMachine(kv, MACHINE_ID, MACHINE_SECRET);

      const config = await getStoredConfig(kv);
      config.machineList[MACHINE_ID].diskFillNotifiedAt = Date.now() - 86400_000;
      await kv.put('config', JSON.stringify(config));

      const store = storageFromConfig(config);
      // Disk shrinking — no longer concerning
      const samples = makeDiskSamples(15, 60, -0.5);
      const status: MachineStatus = {
        lastSeen: Date.now(),
        d: { ts: Date.now(), cpu: 10, up: 1000, procs: 50, mem: [1000, 4000], disk: [53], load: [0.5, 0.5, 0.5], net: [100, 100], ports: '22', users: 'root' },
        diskSamples: samples,
      };
      await store!.put(`m/${MACHINE_ID}/status.json`, JSON.stringify(status));

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
      await scheduled({} as ScheduledEvent, env);

      const updated = await getStoredConfig(kv);
      expect(updated.machineList[MACHINE_ID].diskFillNotifiedAt).toBeUndefined();
    });

    it('does not alert when disk is below 10%', async () => {
      await setupConfig(kv, { notifications: ntfyNotifications, heartbeatTimeout: 120, machineList: {} });
      await addMachine(kv, MACHINE_ID, MACHINE_SECRET);

      const config = await getStoredConfig(kv);
      const store = storageFromConfig(config);
      // Disk at 5%, technically "filling" fast but too low to matter
      const samples = makeDiskSamples(15, 1, 0.3);
      const status: MachineStatus = {
        lastSeen: Date.now(),
        d: { ts: Date.now(), cpu: 10, up: 1000, procs: 50, mem: [1000, 4000], disk: [5], load: [0.5, 0.5, 0.5], net: [100, 100], ports: '22', users: 'root' },
        diskSamples: samples,
      };
      await store!.put(`m/${MACHINE_ID}/status.json`, JSON.stringify(status));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
      await scheduled({} as ScheduledEvent, env);

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
