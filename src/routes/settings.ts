import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { getRuntimeKey } from 'hono/adapter';
import type { Bindings, AgentFeatures, NotificationChannelConfig } from '../types';
import { AGENT_FEATURES_DEFAULT } from '../types';
import { isAuthed, hashPassword, fromHex, toHex, randomBytes, createSession, COOKIE_OPTS } from '../crypto';
import { getConfig, storageFromConfig } from '../config';
import { validateAlertThreshold, validateHeartbeatTimeout, validateNotificationChannel } from '../validators';
import { sendTestNotification, vapidKeysFromConfig } from '../notifications';
import { generateVapidKeys, type PushSubscriptionRecord } from '../webpush';
import { APP_VERSION, BUILD_COMMIT, BUILD_TIME } from '../version';

const PUSH_SUBS_KEY = 'push_subscriptions';
const VERSION_CACHE_KEY = 'npm_version_cache';
const VERSION_CACHE_MS = 24 * 60 * 60 * 1000;

const FEATURE_KEYS = Object.keys(AGENT_FEATURES_DEFAULT) as (keyof AgentFeatures)[];

const settings = new Hono<{ Bindings: Bindings }>();

/** Returns settings for the settings page. */
settings.get('/api/settings', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config || !(await isAuthed(getCookie(c, 'session'), config.passwordHash))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return c.json({
    alertThreshold: config.alertThreshold ?? 2,
    heartbeatTimeout: config.heartbeatTimeout ?? 120,
    notifications: config.notifications ?? {},
    agentFeatures: { ...AGENT_FEATURES_DEFAULT, ...config.agentFeatures },
    storageMode: config.storageMode,
    machineCount: Object.keys(config.machineList).length,
  });
});

/** Update monitoring, notification, and feature settings. */
settings.patch('/api/settings', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config || !(await isAuthed(getCookie(c, 'session'), config.passwordHash))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.json<{
    alertThreshold?: number;
    heartbeatTimeout?: number;
    notifications?: Record<string, NotificationChannelConfig>;
    agentFeatures?: Partial<AgentFeatures>;
  }>();

  if (body.alertThreshold !== undefined) {
    const r = validateAlertThreshold(body.alertThreshold);
    if (!r.ok) return c.json({ error: r.error }, 400);
    config.alertThreshold = r.value;
  }

  if (body.heartbeatTimeout !== undefined) {
    const r = validateHeartbeatTimeout(body.heartbeatTimeout);
    if (!r.ok) return c.json({ error: r.error }, 400);
    config.heartbeatTimeout = r.value;
  }

  if (body.notifications !== undefined) {
    const existingWebpush = config.notifications?.webpush;
    const { webpush: _, ...rest } = body.notifications;
    for (const [key, ch] of Object.entries(rest)) {
      const r = validateNotificationChannel(ch);
      if (!r.ok) return c.json({ error: `${key}: ${r.error}` }, 400);
    }
    config.notifications = existingWebpush ? { ...rest, webpush: existingWebpush } : rest;
    delete config.ntfyEndpoint;
  }

  if (body.agentFeatures !== undefined) {
    const merged = { ...AGENT_FEATURES_DEFAULT, ...config.agentFeatures };
    for (const k of FEATURE_KEYS) {
      if (typeof body.agentFeatures[k] === 'boolean') merged[k] = body.agentFeatures[k];
    }
    config.agentFeatures = merged;
  }

  await c.env.SNITCHR_CONFIG.put('config', JSON.stringify(config));
  return c.json({ ok: true });
});

/** Change admin password. */
settings.post('/api/settings/password', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config || !(await isAuthed(getCookie(c, 'session'), config.passwordHash))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { currentPassword, newPassword, confirmPassword } = await c.req.json<{
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
  }>();
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || typeof confirmPassword !== 'string') {
    return c.json({ error: 'All password fields required' }, 400);
  }

  const salt = fromHex(config.passwordSalt);
  if ((await hashPassword(currentPassword, salt)) !== config.passwordHash) {
    return c.json({ error: 'Current password is incorrect' }, 401);
  }
  if (!newPassword || newPassword.length < 8)
    return c.json({ error: 'New password must be at least 8 characters' }, 400);
  if (newPassword !== confirmPassword) return c.json({ error: 'Passwords do not match' }, 400);

  const newSalt = randomBytes(32);
  config.passwordHash = await hashPassword(newPassword, newSalt);
  config.passwordSalt = toHex(newSalt);
  await c.env.SNITCHR_CONFIG.put('config', JSON.stringify(config));

  const session = await createSession(config.passwordHash);
  setCookie(c, 'session', session, COOKIE_OPTS);
  return c.json({ ok: true });
});

/** Send a test notification to a specific channel. */
settings.post('/api/settings/test-notification', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config || !(await isAuthed(getCookie(c, 'session'), config.passwordHash))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { channel } = await c.req.json<{ channel: string }>();
  if (!channel) return c.json({ error: 'Channel key required' }, 400);
  if (!config.notifications?.[channel]) return c.json({ error: 'Unknown channel' }, 400);

  const deps = { kv: c.env.SNITCHR_CONFIG, vapidKeys: vapidKeysFromConfig(config), contactEmail: c.env.VAPID_CONTACT };
  const err = await sendTestNotification(config.notifications, channel, deps);
  return err ? c.json({ error: err }, 400) : c.json({ ok: true });
});

// ── Push notification endpoints ────────────────────────────────────────

/** Returns the VAPID public key, generating one if needed. */
settings.get('/api/push/vapid-key', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config || !(await isAuthed(getCookie(c, 'session'), config.passwordHash))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!config.vapidPublicKey || !config.vapidPrivateKey) {
    const keys = await generateVapidKeys();
    config.vapidPublicKey = keys.publicKey;
    config.vapidPrivateKey = keys.privateKey;
    await c.env.SNITCHR_CONFIG.put('config', JSON.stringify(config));
  }

  return c.json({ publicKey: config.vapidPublicKey });
});

/** Store a push subscription from the browser. */
settings.post('/api/push/subscribe', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config || !(await isAuthed(getCookie(c, 'session'), config.passwordHash))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const sub = await c.req.json<PushSubscriptionRecord>();
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return c.json({ error: 'Invalid subscription' }, 400);
  }

  const raw = await c.env.SNITCHR_CONFIG.get(PUSH_SUBS_KEY);
  let subs: PushSubscriptionRecord[] = [];
  if (raw)
    try {
      subs = JSON.parse(raw) as PushSubscriptionRecord[];
    } catch {
      /* reset */
    }

  // Replace if same endpoint exists, otherwise append
  subs = subs.filter(s => s.endpoint !== sub.endpoint);
  subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });

  // Cap at 50 subscriptions
  if (subs.length > 50) subs = subs.slice(-50);
  await c.env.SNITCHR_CONFIG.put(PUSH_SUBS_KEY, JSON.stringify(subs));

  // Auto-enable webpush channel if not already present
  config.notifications ??= {};
  if (!config.notifications.webpush) {
    config.notifications.webpush = { type: 'webpush', enabled: true };
    await c.env.SNITCHR_CONFIG.put('config', JSON.stringify(config));
  }

  return c.json({ ok: true });
});

/** Remove a push subscription. */
settings.post('/api/push/unsubscribe', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config || !(await isAuthed(getCookie(c, 'session'), config.passwordHash))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { endpoint } = await c.req.json<{ endpoint: string }>();
  if (!endpoint) return c.json({ error: 'Endpoint required' }, 400);

  const raw = await c.env.SNITCHR_CONFIG.get(PUSH_SUBS_KEY);
  if (raw) {
    let subs: PushSubscriptionRecord[] = [];
    try {
      subs = JSON.parse(raw) as PushSubscriptionRecord[];
    } catch {
      /* reset */
    }
    subs = subs.filter(s => s.endpoint !== endpoint);
    await c.env.SNITCHR_CONFIG.put(PUSH_SUBS_KEY, JSON.stringify(subs));

    if (subs.length === 0 && config.notifications?.webpush) {
      config.notifications.webpush = { type: 'webpush', enabled: false };
      await c.env.SNITCHR_CONFIG.put('config', JSON.stringify(config));
    }
  }

  return c.json({ ok: true });
});

// ── Version check ─────────────────────────────────────────────────────

const semverGt = (a: string, b: string): boolean => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
};

/** Returns current version, latest npm version, and runtime info. */
settings.get('/api/version', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config || !(await isAuthed(getCookie(c, 'session'), config.passwordHash))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let latest: string | null = null;
  const cached = await c.env.SNITCHR_CONFIG.get(VERSION_CACHE_KEY);
  if (cached) {
    try {
      const { version, checkedAt } = JSON.parse(cached) as { version: string; checkedAt: number };
      if (Date.now() - checkedAt < VERSION_CACHE_MS) latest = version;
    } catch {
      /* expired or corrupted */
    }
  }

  if (latest === null) {
    try {
      const res = await fetch('https://registry.npmjs.org/snitchr/latest', {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = (await res.json()) as { version: string };
        latest = data.version;
        await c.env.SNITCHR_CONFIG.put(VERSION_CACHE_KEY, JSON.stringify({ version: latest, checkedAt: Date.now() }));
      }
    } catch {
      /* npm unreachable — non-critical */
    }
  }

  return c.json({
    current: APP_VERSION,
    latest,
    updateAvailable: latest ? semverGt(latest, APP_VERSION) : false,
    runtime: getRuntimeKey(),
    commit: BUILD_COMMIT,
    buildTime: BUILD_TIME,
  });
});

/** Factory reset \u2014 deletes all data and configuration. */
settings.post('/api/settings/reset', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config || !(await isAuthed(getCookie(c, 'session'), config.passwordHash))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { password } = await c.req.json<{ password: string }>();
  if (typeof password !== 'string') return c.json({ error: 'Password required' }, 400);
  const salt = fromHex(config.passwordSalt);
  if ((await hashPassword(password, salt)) !== config.passwordHash) {
    return c.json({ error: 'Invalid password' }, 401);
  }

  const store = storageFromConfig(config, c.env.SNITCHR_STORAGE);
  if (store) await store.clear();
  await c.env.SNITCHR_CONFIG.delete('config');
  deleteCookie(c, 'session', { path: '/', secure: true });
  return c.json({ ok: true });
});

export { settings };
