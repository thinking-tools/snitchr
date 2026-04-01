import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../../app';
import { createTestEnv, setupConfig, getSessionCookie, addMachine, jsonPost, TEST_PASSWORD, json } from '../helpers';
import type { Bindings } from '../../types';
import { InMemoryKV } from '../../kv';

describe('Authentication', () => {
  let env: Bindings;
  let kv: InMemoryKV;

  beforeEach(async () => {
    ({ env, kv } = createTestEnv());
    await setupConfig(kv);
  });

  describe('POST /api/login', () => {
    it('succeeds with correct password', async () => {
      const res = await app.request('/api/login', jsonPost({ password: TEST_PASSWORD }), env);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.ok).toBe(true);
    });

    it('sets session cookie', async () => {
      const res = await app.request('/api/login', jsonPost({ password: TEST_PASSWORD }), env);
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('session=');
    });

    it('rejects wrong password', async () => {
      const res = await app.request('/api/login', jsonPost({ password: 'wrongpassword' }), env);
      expect(res.status).toBe(401);
    });

    it('rejects missing password', async () => {
      const res = await app.request('/api/login', jsonPost({}), env);
      expect(res.status).toBe(400);
    });

    it('rate limits after 5 attempts', async () => {
      for (let i = 0; i < 5; i++) {
        await app.request('/api/login', jsonPost({ password: 'wrong' }), env);
      }
      const res = await app.request('/api/login', jsonPost({ password: 'wrong' }), env);
      expect(res.status).toBe(429);
    });
  });

  describe('GET /api/logout', () => {
    it('redirects to root', async () => {
      const res = await app.request('/api/logout', { redirect: 'manual' }, env);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    });

    it('clears session cookie', async () => {
      const res = await app.request('/api/logout', { redirect: 'manual' }, env);
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('session=');
      expect(setCookie).toContain('Max-Age=0');
    });
  });

  describe('Protected endpoints without auth', () => {
    it('GET /api/config returns 401', async () => {
      const res = await app.request('/api/config', {}, env);
      expect(res.status).toBe(401);
    });

    it('GET /api/machines returns 401', async () => {
      const res = await app.request('/api/machines', {}, env);
      expect(res.status).toBe(401);
    });

    it('GET /api/settings returns 401', async () => {
      const res = await app.request('/api/settings', {}, env);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/config', () => {
    it('returns machine IDs and settings when authed', async () => {
      await addMachine(kv, 'machine-1', 'a'.repeat(48));
      const session = await getSessionCookie(env);
      const res = await app.request('/api/config', { headers: { Cookie: `session=${session}` } }, env);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.machineIds).toContain('machine-1');
      expect(body.alertThreshold).toBe(2);
      expect(body.storageMode).toBe('memory');
    });
  });
});
