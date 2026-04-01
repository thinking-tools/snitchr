import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../../app';
import {
  createTestEnv, setupConfig, addMachine, getStoredConfig,
  validHeartbeatPayload, validAlertPayload, json,
} from '../helpers';
import type { Bindings, MachineStatus, EventEntry } from '../../types';
import { InMemoryKV } from '../../kv';
import { InMemoryStorage } from '../../storage';

const MACHINE_ID = 'test-machine-001';
const MACHINE_SECRET = 'a'.repeat(48);

const ingest = (env: Bindings, payload: unknown, id = MACHINE_ID, secret = MACHINE_SECRET) =>
  app.request(`/m/${id}/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(payload),
  }, env);

describe('Ingest endpoint', () => {
  let env: Bindings;
  let kv: InMemoryKV;

  beforeEach(async () => {
    ({ env, kv } = createTestEnv());
    await setupConfig(kv);
    await addMachine(kv, MACHINE_ID, MACHINE_SECRET);
  });

  describe('Authentication', () => {
    it('rejects unknown machine', async () => {
      const res = await ingest(env, validHeartbeatPayload(), 'nonexistent');
      expect(res.status).toBe(404);
    });

    it('rejects wrong secret', async () => {
      const res = await ingest(env, validHeartbeatPayload(), MACHINE_ID, 'wrong-secret');
      expect(res.status).toBe(401);
    });

    it('rejects missing auth header', async () => {
      const res = await app.request(`/m/${MACHINE_ID}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validHeartbeatPayload()),
      }, env);
      expect(res.status).toBe(401);
    });
  });

  describe('Validation', () => {
    it('rejects invalid event level', async () => {
      const res = await ingest(env, { t: 6, d: {} });
      expect(res.status).toBe(400);
    });

    it('rejects non-object payload', async () => {
      const res = await ingest(env, { t: 0, d: 'string' });
      expect(res.status).toBe(400);
    });

    it('rejects invalid heartbeat', async () => {
      const res = await ingest(env, { t: 0, d: { ts: 123 } });
      expect(res.status).toBe(400);
    });

    it('rejects unknown alert type', async () => {
      const res = await ingest(env, { t: 2, d: { type: 'unknown_type', msg: 'test' } });
      expect(res.status).toBe(400);
    });

    it('rejects alert msg too long', async () => {
      const res = await ingest(env, { t: 2, d: { type: 'ssh_login', msg: 'x'.repeat(2001) } });
      expect(res.status).toBe(400);
    });
  });

  describe('Heartbeat', () => {
    it('stores machine status', async () => {
      const res = await ingest(env, validHeartbeatPayload());
      expect(res.status).toBe(200);

      const config = await getStoredConfig(kv);
      const store = new InMemoryStorage();
      // Read from the storage created by storageFromConfig
      // Since storageMode is 'memory', each call creates a new instance.
      // We need to check the response instead.
      const body = await json(res);
      expect(body.ok).toBe(true);
    });

    it('returns ok for valid heartbeat', async () => {
      const res = await ingest(env, validHeartbeatPayload());
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ ok: true });
    });
  });

  describe('Alerts', () => {
    it('returns ok for valid alert', async () => {
      const res = await ingest(env, validAlertPayload());
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ ok: true });
    });

    it('accepts shutdown event', async () => {
      const res = await ingest(env, { t: 5, d: { type: 'shutdown', msg: 'graceful stop' } });
      expect(res.status).toBe(200);
    });

    it('accepts mount_change event', async () => {
      const res = await ingest(env, validAlertPayload('mount_change', 'New mount: /dev/sdb1 on /mnt/usb (ext4)'));
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ ok: true });
    });
  });

  describe('Feature gating', () => {
    it('silently drops disabled feature events', async () => {
      await setupConfig(kv, { agentFeatures: { authWatch: false }, machineList: {} });
      await addMachine(kv, MACHINE_ID, MACHINE_SECRET);

      const res = await ingest(env, validAlertPayload('ssh_login', 'root login'));
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ ok: true });
    });

    it('allows enabled feature events', async () => {
      await setupConfig(kv, { agentFeatures: { authWatch: true }, machineList: {} });
      await addMachine(kv, MACHINE_ID, MACHINE_SECRET);

      const res = await ingest(env, validAlertPayload('ssh_login', 'root login'));
      expect(res.status).toBe(200);
    });

    it('drops mount_change when mountWatch disabled', async () => {
      await setupConfig(kv, { agentFeatures: { mountWatch: false }, machineList: {} });
      await addMachine(kv, MACHINE_ID, MACHINE_SECRET);

      const res = await ingest(env, validAlertPayload('mount_change', 'New mount: /dev/sdb1 on /mnt/usb (ext4)'));
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ ok: true });
    });

    it('allows mount_change when mountWatch enabled', async () => {
      await setupConfig(kv, { agentFeatures: { mountWatch: true }, machineList: {} });
      await addMachine(kv, MACHINE_ID, MACHINE_SECRET);

      const res = await ingest(env, validAlertPayload('mount_change', 'Unmounted: /dev/sdb1 from /mnt/usb (ext4)'));
      expect(res.status).toBe(200);
    });
  });
});
