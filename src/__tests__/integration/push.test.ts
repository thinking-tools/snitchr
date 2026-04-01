import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../../app';
import { createTestEnv, setupConfig, getSessionCookie, getStoredConfig, jsonPost, jsonPatch, json } from '../helpers';
import type { Bindings } from '../../types';
import { InMemoryKV } from '../../kv';

const authed = (session: string) => ({ Cookie: `session=${session}` });

describe('Push notification API', () => {
  let env: Bindings;
  let kv: InMemoryKV;
  let session: string;

  beforeEach(async () => {
    ({ env, kv } = createTestEnv());
    await setupConfig(kv);
    session = await getSessionCookie(env);
  });

  describe('GET /api/push/vapid-key', () => {
    it('generates and returns VAPID public key', async () => {
      const res = await app.request('/api/push/vapid-key', { headers: authed(session) }, env);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.publicKey).toBeTruthy();
      expect(typeof body.publicKey).toBe('string');
    });

    it('returns same key on subsequent calls', async () => {
      const res1 = await app.request('/api/push/vapid-key', { headers: authed(session) }, env);
      const res2 = await app.request('/api/push/vapid-key', { headers: authed(session) }, env);
      const key1 = (await json(res1)).publicKey;
      const key2 = (await json(res2)).publicKey;
      expect(key1).toBe(key2);
    });

    it('stores keys in config', async () => {
      await app.request('/api/push/vapid-key', { headers: authed(session) }, env);
      const config = await getStoredConfig(kv);
      expect(config.vapidPublicKey).toBeTruthy();
      expect(config.vapidPrivateKey).toBeTruthy();
    });

    it('rejects without auth', async () => {
      const res = await app.request('/api/push/vapid-key', {}, env);
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/push/subscribe', () => {
    it('stores a subscription and returns { ok: true }', async () => {
      const sub = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/test123',
        keys: { p256dh: 'dGVzdC1wdWJsaWMta2V5', auth: 'dGVzdC1hdXRo' },
      };
      const res = await app.request(
        '/api/push/subscribe',
        { ...jsonPost(sub), headers: { ...authed(session), 'Content-Type': 'application/json' } },
        env,
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toEqual({ ok: true });

      const raw = await kv.get('push_subscriptions');
      const subs = JSON.parse(raw!);
      expect(subs).toHaveLength(1);
      expect(subs[0].endpoint).toBe(sub.endpoint);
    });

    it('auto-enables webpush channel', async () => {
      const sub = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/test',
        keys: { p256dh: 'dGVzdA', auth: 'dGVzdA' },
      };
      await app.request(
        '/api/push/subscribe',
        { ...jsonPost(sub), headers: { ...authed(session), 'Content-Type': 'application/json' } },
        env,
      );

      const config = await getStoredConfig(kv);
      expect(config.notifications?.webpush).toEqual({ type: 'webpush', enabled: true });
    });

    it('replaces duplicate endpoint', async () => {
      const sub1 = { endpoint: 'https://push.example.com/1', keys: { p256dh: 'a', auth: 'b' } };
      const sub2 = { endpoint: 'https://push.example.com/1', keys: { p256dh: 'c', auth: 'd' } };

      const opts = (body: unknown) => ({ ...jsonPost(body), headers: { ...authed(session), 'Content-Type': 'application/json' } });
      await app.request('/api/push/subscribe', opts(sub1), env);
      await app.request('/api/push/subscribe', opts(sub2), env);

      const raw = await kv.get('push_subscriptions');
      const subs = JSON.parse(raw!);
      expect(subs).toHaveLength(1);
      expect(subs[0].keys.p256dh).toBe('c');
    });

    it('rejects invalid subscription', async () => {
      const res = await app.request(
        '/api/push/subscribe',
        { ...jsonPost({ endpoint: 'test' }), headers: { ...authed(session), 'Content-Type': 'application/json' } },
        env,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/push/unsubscribe', () => {
    it('removes a subscription', async () => {
      const sub = { endpoint: 'https://push.example.com/1', keys: { p256dh: 'a', auth: 'b' } };
      await app.request(
        '/api/push/subscribe',
        { ...jsonPost(sub), headers: { ...authed(session), 'Content-Type': 'application/json' } },
        env,
      );

      const res = await app.request(
        '/api/push/unsubscribe',
        { ...jsonPost({ endpoint: sub.endpoint }), headers: { ...authed(session), 'Content-Type': 'application/json' } },
        env,
      );
      expect(res.status).toBe(200);

      const raw = await kv.get('push_subscriptions');
      const subs = JSON.parse(raw!);
      expect(subs).toHaveLength(0);
    });

    it('auto-disables webpush channel when last subscription removed', async () => {
      const sub = { endpoint: 'https://push.example.com/1', keys: { p256dh: 'a', auth: 'b' } };
      await app.request(
        '/api/push/subscribe',
        { ...jsonPost(sub), headers: { ...authed(session), 'Content-Type': 'application/json' } },
        env,
      );

      const before = await getStoredConfig(kv);
      expect(before.notifications?.webpush?.enabled).toBe(true);

      await app.request(
        '/api/push/unsubscribe',
        { ...jsonPost({ endpoint: sub.endpoint }), headers: { ...authed(session), 'Content-Type': 'application/json' } },
        env,
      );

      const after = await getStoredConfig(kv);
      expect(after.notifications?.webpush?.enabled).toBe(false);
    });

    it('keeps webpush enabled when other subscriptions remain', async () => {
      const opts = (body: unknown) => ({ ...jsonPost(body), headers: { ...authed(session), 'Content-Type': 'application/json' } });
      const sub1 = { endpoint: 'https://push.example.com/device-a', keys: { p256dh: 'a', auth: 'b' } };
      const sub2 = { endpoint: 'https://push.example.com/device-b', keys: { p256dh: 'c', auth: 'd' } };

      await app.request('/api/push/subscribe', opts(sub1), env);
      await app.request('/api/push/subscribe', opts(sub2), env);

      await app.request('/api/push/unsubscribe', opts({ endpoint: sub1.endpoint }), env);

      const config = await getStoredConfig(kv);
      expect(config.notifications?.webpush?.enabled).toBe(true);

      const raw = await kv.get('push_subscriptions');
      const subs = JSON.parse(raw!);
      expect(subs).toHaveLength(1);
      expect(subs[0].endpoint).toBe(sub2.endpoint);
    });
  });

  describe('multi-device: PATCH /api/settings preserves webpush', () => {
    it('does not overwrite webpush when saving other settings', async () => {
      const sub = { endpoint: 'https://push.example.com/device-a', keys: { p256dh: 'a', auth: 'b' } };
      await app.request(
        '/api/push/subscribe',
        { ...jsonPost(sub), headers: { ...authed(session), 'Content-Type': 'application/json' } },
        env,
      );

      const before = await getStoredConfig(kv);
      expect(before.notifications?.webpush?.enabled).toBe(true);

      // Save settings from a device without webpush — sends ntfy only, no webpush key
      await app.request(
        '/api/settings',
        {
          ...jsonPatch({ notifications: { ntfy: { type: 'ntfy', endpoint: 'https://ntfy.sh/t', enabled: true } } }),
          headers: { ...authed(session), 'Content-Type': 'application/json' },
        },
        env,
      );

      const after = await getStoredConfig(kv);
      expect(after.notifications?.webpush?.enabled).toBe(true);
      expect(after.notifications?.ntfy).toBeDefined();
    });

    it('ignores webpush in PATCH body and keeps server-side state', async () => {
      const sub = { endpoint: 'https://push.example.com/device-a', keys: { p256dh: 'a', auth: 'b' } };
      await app.request(
        '/api/push/subscribe',
        { ...jsonPost(sub), headers: { ...authed(session), 'Content-Type': 'application/json' } },
        env,
      );

      // Client tries to send webpush: { enabled: false } — should be ignored
      await app.request(
        '/api/settings',
        {
          ...jsonPatch({ notifications: { webpush: { type: 'webpush', enabled: false } } }),
          headers: { ...authed(session), 'Content-Type': 'application/json' },
        },
        env,
      );

      const config = await getStoredConfig(kv);
      expect(config.notifications?.webpush?.enabled).toBe(true);
    });
  });
});
