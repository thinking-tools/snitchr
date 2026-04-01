import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../../app';
import {
  createTestEnv, setupConfig, getSessionCookie, addMachine,
  getStoredConfig, validHeartbeatPayload, validAlertPayload, jsonPatch, json,
} from '../helpers';
import type { Bindings } from '../../types';
import { InMemoryKV } from '../../kv';

const MACHINE_ID = 'test-machine-001';
const MACHINE_SECRET = 'a'.repeat(48);

const authed = (session: string) => ({ Cookie: `session=${session}` });

const ingest = (env: Bindings, payload: unknown) =>
  app.request(`/m/${MACHINE_ID}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MACHINE_SECRET}` },
    body: JSON.stringify(payload),
  }, env);

describe('Machines API', () => {
  let env: Bindings;
  let kv: InMemoryKV;
  let session: string;

  beforeEach(async () => {
    ({ env, kv } = createTestEnv());
    await setupConfig(kv);
    await addMachine(kv, MACHINE_ID, MACHINE_SECRET, 'test-box');
    session = await getSessionCookie(env);
  });

  describe('GET /api/machines', () => {
    it('lists registered machines', async () => {
      const res = await app.request('/api/machines', { headers: authed(session) }, env);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.machines).toHaveLength(1);
      expect(body.machines[0].id).toBe(MACHINE_ID);
      expect(body.machines[0].label).toBe('test-box');
    });

    it('includes heartbeat timeout and threshold', async () => {
      const res = await app.request('/api/machines', { headers: authed(session) }, env);
      const body = await json(res);
      expect(body.heartbeatTimeout).toBeDefined();
      expect(body.alertThreshold).toBeDefined();
    });

    it('shows machine as offline when no heartbeat', async () => {
      const res = await app.request('/api/machines', { headers: authed(session) }, env);
      const body = await json(res);
      expect(body.machines[0].online).toBe(false);
    });

    it('shows machine as online after heartbeat', async () => {
      await ingest(env, validHeartbeatPayload());
      const res = await app.request('/api/machines', { headers: authed(session) }, env);
      const body = await json(res);
      expect(body.machines[0].online).toBe(true);
    });
  });

  describe('GET /api/machines/:id', () => {
    it('returns machine detail', async () => {
      const res = await app.request(`/api/machines/${MACHINE_ID}`, { headers: authed(session) }, env);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.id).toBe(MACHINE_ID);
      expect(body.label).toBe('test-box');
    });

    it('returns 404 for unknown machine', async () => {
      const res = await app.request('/api/machines/nonexistent', { headers: authed(session) }, env);
      expect(res.status).toBe(404);
    });

    it('includes alerts after alert ingestion', async () => {
      await ingest(env, validAlertPayload('ssh_login', 'root login'));
      const res = await app.request(`/api/machines/${MACHINE_ID}`, { headers: authed(session) }, env);
      const body = await json(res);
      expect(body.alerts.length).toBeGreaterThanOrEqual(1);
      expect(body.alerts[0].d.type).toBe('ssh_login');
    });
  });

  describe('PATCH /api/machines/:id', () => {
    it('renames machine', async () => {
      const res = await app.request(
        `/api/machines/${MACHINE_ID}`,
        { ...jsonPatch({ label: 'new-name' }), headers: { ...authed(session), 'Content-Type': 'application/json' } },
        env,
      );
      expect(res.status).toBe(200);

      const config = await getStoredConfig(kv);
      expect(config.machineList[MACHINE_ID].label).toBe('new-name');
    });

    it('rejects label too long', async () => {
      const res = await app.request(
        `/api/machines/${MACHINE_ID}`,
        { ...jsonPatch({ label: 'x'.repeat(101) }), headers: { ...authed(session), 'Content-Type': 'application/json' } },
        env,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/machines/:id', () => {
    it('removes machine from config', async () => {
      const res = await app.request(
        `/api/machines/${MACHINE_ID}`,
        { method: 'DELETE', headers: authed(session) },
        env,
      );
      expect(res.status).toBe(200);

      const config = await getStoredConfig(kv);
      expect(config.machineList[MACHINE_ID]).toBeUndefined();
    });
  });

  describe('GET /api/machines/:id/events', () => {
    it('returns empty events when no alerts', async () => {
      const res = await app.request(`/api/machines/${MACHINE_ID}/events`, { headers: authed(session) }, env);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.events).toEqual([]);
      expect(body.truncated).toBe(false);
    });

    it('returns events after alert ingestion', async () => {
      await ingest(env, validAlertPayload('ssh_login', 'root login'));
      const res = await app.request(`/api/machines/${MACHINE_ID}/events`, { headers: authed(session) }, env);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.events.length).toBeGreaterThanOrEqual(1);
      expect(body.events[0].d.type).toBe('ssh_login');
    });

    it('returns 404 for unknown machine', async () => {
      const res = await app.request('/api/machines/nonexistent/events', { headers: authed(session) }, env);
      expect(res.status).toBe(404);
    });

    it('returns 401 without auth', async () => {
      const res = await app.request(`/api/machines/${MACHINE_ID}/events`, {}, env);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/machines/:id/alerts', () => {
    it('returns empty alerts initially', async () => {
      const res = await app.request(`/api/machines/${MACHINE_ID}/alerts`, { headers: authed(session) }, env);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.alerts).toEqual([]);
    });

    it('returns alerts after ingestion', async () => {
      await ingest(env, validAlertPayload('ssh_login', 'root login'));
      const res = await app.request(`/api/machines/${MACHINE_ID}/alerts`, { headers: authed(session) }, env);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.alerts.length).toBeGreaterThanOrEqual(1);
    });

    it('returns 404 for unknown machine', async () => {
      const res = await app.request('/api/machines/nonexistent/alerts', { headers: authed(session) }, env);
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/machines/:id/alerts', () => {
    it('clears alerts', async () => {
      await ingest(env, validAlertPayload());
      const res = await app.request(
        `/api/machines/${MACHINE_ID}/alerts`,
        { method: 'DELETE', headers: authed(session) },
        env,
      );
      expect(res.status).toBe(200);
    });
  });
});
