import { describe, it, expect, beforeEach, vi } from 'vitest';
import { app } from '../../app';
import { createTestEnv, setupConfig, getSessionCookie, jsonPost, jsonPatch, TEST_PASSWORD, json } from '../helpers';
import type { Bindings } from '../../types';
import { InMemoryKV } from '../../kv';

const authed = (session: string) => ({ Cookie: `session=${session}` });

describe('Settings API', () => {
  let env: Bindings;
  let kv: InMemoryKV;
  let session: string;

  beforeEach(async () => {
    ({ env, kv } = createTestEnv());
    await setupConfig(kv);
    session = await getSessionCookie(env);
  });

  describe('GET /api/settings', () => {
    it('returns current settings', async () => {
      const res = await app.request('/api/settings', { headers: authed(session) }, env);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.alertThreshold).toBe(2);
      expect(body.heartbeatTimeout).toBe(120);
      expect(body.storageMode).toBe('memory');
    });

    it('rejects without auth', async () => {
      const res = await app.request('/api/settings', {}, env);
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /api/settings', () => {
    it('updates alert threshold', async () => {
      const res = await app.request(
        '/api/settings',
        { ...jsonPatch({ alertThreshold: 3 }), headers: { ...authed(session), 'Content-Type': 'application/json' } },
        env,
      );
      expect(res.status).toBe(200);

      const check = await app.request('/api/settings', { headers: authed(session) }, env);
      const body = await json(check);
      expect(body.alertThreshold).toBe(3);
    });

    it('updates heartbeat timeout', async () => {
      const res = await app.request(
        '/api/settings',
        {
          ...jsonPatch({ heartbeatTimeout: 300 }),
          headers: { ...authed(session), 'Content-Type': 'application/json' },
        },
        env,
      );
      expect(res.status).toBe(200);
    });

    it('updates notifications', async () => {
      const res = await app.request(
        '/api/settings',
        {
          ...jsonPatch({ notifications: { ntfy: { type: 'ntfy', endpoint: 'https://ntfy.sh/test', enabled: true } } }),
          headers: { ...authed(session), 'Content-Type': 'application/json' },
        },
        env,
      );
      expect(res.status).toBe(200);

      const check = await app.request('/api/settings', { headers: authed(session) }, env);
      const body = await json(check);
      expect(body.notifications.ntfy.endpoint).toBe('https://ntfy.sh/test');
    });

    it('rejects invalid threshold', async () => {
      const res = await app.request(
        '/api/settings',
        { ...jsonPatch({ alertThreshold: 5 }), headers: { ...authed(session), 'Content-Type': 'application/json' } },
        env,
      );
      expect(res.status).toBe(400);
    });

    it('rejects invalid heartbeat timeout', async () => {
      const res = await app.request(
        '/api/settings',
        { ...jsonPatch({ heartbeatTimeout: 10 }), headers: { ...authed(session), 'Content-Type': 'application/json' } },
        env,
      );
      expect(res.status).toBe(400);
    });

    it('rejects invalid notification channel', async () => {
      const res = await app.request(
        '/api/settings',
        {
          ...jsonPatch({ notifications: { ntfy: { type: 'ntfy', endpoint: 'not-a-url', enabled: true } } }),
          headers: { ...authed(session), 'Content-Type': 'application/json' },
        },
        env,
      );
      expect(res.status).toBe(400);
    });

    it('updates agent features', async () => {
      const res = await app.request(
        '/api/settings',
        {
          ...jsonPatch({ agentFeatures: { authWatch: false } }),
          headers: { ...authed(session), 'Content-Type': 'application/json' },
        },
        env,
      );
      expect(res.status).toBe(200);

      const check = await app.request('/api/settings', { headers: authed(session) }, env);
      const body = await json(check);
      expect(body.agentFeatures.authWatch).toBe(false);
    });

    it('toggles mountWatch feature', async () => {
      const res = await app.request(
        '/api/settings',
        {
          ...jsonPatch({ agentFeatures: { mountWatch: false } }),
          headers: { ...authed(session), 'Content-Type': 'application/json' },
        },
        env,
      );
      expect(res.status).toBe(200);

      const check = await app.request('/api/settings', { headers: authed(session) }, env);
      const body = await json(check);
      expect(body.agentFeatures.mountWatch).toBe(false);
    });
  });

  describe('POST /api/settings/password', () => {
    it('changes password', async () => {
      const res = await app.request(
        '/api/settings/password',
        {
          ...jsonPost({
            currentPassword: TEST_PASSWORD,
            newPassword: 'newpassword123',
            confirmPassword: 'newpassword123',
          }),
          headers: { ...authed(session), 'Content-Type': 'application/json' },
        },
        env,
      );
      expect(res.status).toBe(200);

      // Can login with new password
      const loginRes = await app.request('/api/login', jsonPost({ password: 'newpassword123' }), env);
      expect(loginRes.status).toBe(200);
    });

    it('rejects wrong current password', async () => {
      const res = await app.request(
        '/api/settings/password',
        {
          ...jsonPost({ currentPassword: 'wrong', newPassword: 'newpassword123', confirmPassword: 'newpassword123' }),
          headers: { ...authed(session), 'Content-Type': 'application/json' },
        },
        env,
      );
      expect(res.status).toBe(401);
    });

    it('rejects short new password', async () => {
      const res = await app.request(
        '/api/settings/password',
        {
          ...jsonPost({ currentPassword: TEST_PASSWORD, newPassword: 'short', confirmPassword: 'short' }),
          headers: { ...authed(session), 'Content-Type': 'application/json' },
        },
        env,
      );
      expect(res.status).toBe(400);
    });

    it('rejects mismatched passwords', async () => {
      const res = await app.request(
        '/api/settings/password',
        {
          ...jsonPost({
            currentPassword: TEST_PASSWORD,
            newPassword: 'newpassword123',
            confirmPassword: 'different123',
          }),
          headers: { ...authed(session), 'Content-Type': 'application/json' },
        },
        env,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/settings/reset', () => {
    it('factory resets with correct password', async () => {
      const res = await app.request(
        '/api/settings/reset',
        {
          ...jsonPost({ password: TEST_PASSWORD }),
          headers: { ...authed(session), 'Content-Type': 'application/json' },
        },
        env,
      );
      expect(res.status).toBe(200);

      // Config should be gone
      const raw = await kv.get('config');
      expect(raw).toBeNull();
    });

    it('rejects wrong password', async () => {
      const res = await app.request(
        '/api/settings/reset',
        {
          ...jsonPost({ password: 'wrongpassword' }),
          headers: { ...authed(session), 'Content-Type': 'application/json' },
        },
        env,
      );
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/version', () => {
    it('returns version info', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: '0.0.1' }), { status: 200 })),
      );
      try {
        const res = await app.request('/api/version', { headers: authed(session) }, env);
        expect(res.status).toBe(200);
        const body = await json(res);
        expect(body.current).toBeDefined();
        expect(body.runtime).toBeDefined();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('rejects without auth', async () => {
      const res = await app.request('/api/version', {}, env);
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/settings/test-notification', () => {
    it('rejects missing channel key', async () => {
      const res = await app.request(
        '/api/settings/test-notification',
        {
          ...jsonPost({}),
          headers: { ...authed(session), 'Content-Type': 'application/json' },
        },
        env,
      );
      expect(res.status).toBe(400);
    });

    it('rejects unknown channel', async () => {
      const res = await app.request(
        '/api/settings/test-notification',
        {
          ...jsonPost({ channel: 'nonexistent' }),
          headers: { ...authed(session), 'Content-Type': 'application/json' },
        },
        env,
      );
      expect(res.status).toBe(400);
    });
  });
});
