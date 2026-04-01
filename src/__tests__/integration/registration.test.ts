import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../../app';
import { createTestEnv, setupConfig, getSessionCookie, jsonPost, getStoredConfig, json } from '../helpers';
import type { Bindings } from '../../types';
import { InMemoryKV } from '../../kv';

describe('Machine registration', () => {
  let env: Bindings;
  let kv: InMemoryKV;
  let session: string;

  beforeEach(async () => {
    ({ env, kv } = createTestEnv());
    await setupConfig(kv);
    session = await getSessionCookie(env);
  });

  describe('POST /api/install-token', () => {
    it('generates install token', async () => {
      const res = await app.request(
        '/api/install-token',
        { method: 'POST', headers: { Cookie: `session=${session}` } },
        env,
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.token).toBeTruthy();
      expect(body.token).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    });

    it('stores token in config', async () => {
      const res = await app.request(
        '/api/install-token',
        { method: 'POST', headers: { Cookie: `session=${session}` } },
        env,
      );
      const { token } = await json(res);
      const config = await getStoredConfig(kv);
      expect(config.pendingToken).toBe(token.replace('-', ''));
    });

    it('returns existing pending token on second call', async () => {
      const res1 = await app.request(
        '/api/install-token',
        { method: 'POST', headers: { Cookie: `session=${session}` } },
        env,
      );
      const { token: token1 } = await json(res1);

      const res2 = await app.request(
        '/api/install-token',
        { method: 'POST', headers: { Cookie: `session=${session}` } },
        env,
      );
      const { token: token2 } = await json(res2);

      expect(token2).toBe(token1);
    });

    it('rejects without auth', async () => {
      const res = await app.request('/api/install-token', { method: 'POST' }, env);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /agent', () => {
    it('returns install script with injected URL and token', async () => {
      const tokenRes = await app.request(
        '/api/install-token',
        { method: 'POST', headers: { Cookie: `session=${session}` } },
        env,
      );
      const { token } = await json(tokenRes);

      const res = await app.request(`/agent?init=${token}`, {}, env);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
    });

    it('supports legacy /install-agent?token= route', async () => {
      const tokenRes = await app.request(
        '/api/install-token',
        { method: 'POST', headers: { Cookie: `session=${session}` } },
        env,
      );
      const { token } = await json(tokenRes);

      const res = await app.request(`/install-agent?token=${token}`, {}, env);
      expect(res.status).toBe(200);
    });

    it('rejects invalid token', async () => {
      const res = await app.request('/agent?init=invalid', {}, env);
      expect(res.status).toBe(403);
    });

    it('rejects missing token', async () => {
      const res = await app.request('/agent', {}, env);
      expect(res.status).toBe(400);
    });
  });

  describe('POST /register', () => {
    it('registers machine with valid token', async () => {
      const tokenRes = await app.request(
        '/api/install-token',
        { method: 'POST', headers: { Cookie: `session=${session}` } },
        env,
      );
      const { token } = await json(tokenRes);

      const res = await app.request('/register', jsonPost({ token, sysinfo: { hostname: 'test-box' } }), env);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.id).toBeTruthy();
      expect(body.secret).toBeTruthy();
      expect(body.secret.length).toBe(48);
    });

    it('adds machine to config', async () => {
      const tokenRes = await app.request(
        '/api/install-token',
        { method: 'POST', headers: { Cookie: `session=${session}` } },
        env,
      );
      const { token } = await json(tokenRes);

      const { id } = await json(await app.request('/register', jsonPost({ token, sysinfo: {} }), env));

      const config = await getStoredConfig(kv);
      expect(config.machineList[id]).toBeDefined();
      expect(config.machineList[id].secret).toBeTruthy();
      expect(config.pendingToken).toBeUndefined();
    });

    it('rejects invalid token', async () => {
      const res = await app.request('/register', jsonPost({ token: 'bad-token', sysinfo: {} }), env);
      expect(res.status).toBe(403);
    });

    it('rejects reuse of consumed token', async () => {
      const tokenRes = await app.request(
        '/api/install-token',
        { method: 'POST', headers: { Cookie: `session=${session}` } },
        env,
      );
      const { token } = await json(tokenRes);

      await app.request('/register', jsonPost({ token, sysinfo: {} }), env);
      const res = await app.request('/register', jsonPost({ token, sysinfo: {} }), env);
      expect(res.status).toBe(403);
    });
  });
});
