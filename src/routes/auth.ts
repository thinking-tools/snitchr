import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Bindings, StorageMode, CfGeoProperties } from '../types';
import {
  toHex,
  fromHex,
  randomBytes,
  compactToken,
  normalizeToken,
  hashPassword,
  createSession,
  isAuthed,
  timingSafeEqual,
  COOKIE_OPTS,
} from '../crypto';
import { getConfig, storageFromConfig } from '../config';
import { rateLimit } from '../rate-limit';

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** Replace loopback hostnames with the machine's LAN IP so install scripts work from Docker / remote hosts. */
const resolveBaseUrl = (url: URL): string => {
  if (!LOOPBACK.test(url.hostname)) return url.origin;
  try {
    const { networkInterfaces } = require('node:os') as typeof import('node:os');
    const nets = networkInterfaces();
    for (const addrs of Object.values(nets)) {
      const v4 = addrs?.find(a => a.family === 'IPv4' && !a.internal);
      if (v4) return `${url.protocol}//${v4.address}:${url.port}`;
    }
  } catch {
    // CF Workers — no node:os, just use the origin as-is
  }
  return url.origin;
};

const auth = new Hono<{ Bindings: Bindings }>();

auth.get('/api/capabilities', async c => {
  const configured = !!(await getConfig(c.env.SNITCHR_CONFIG));
  return c.json({ r2Available: !!c.env.SNITCHR_STORAGE, filesystemAvailable: !!c.env.DATA_DIR, configured });
});

auth.post('/api/setup', async c => {
  if (await getConfig(c.env.SNITCHR_CONFIG)) return c.json({ error: 'Already configured' }, 403);

  const body = await c.req.json<Record<string, string>>();
  const { password, passwordConfirm, storageMode } = body;

  if (!password || password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400);
  if (password !== passwordConfirm) return c.json({ error: 'Passwords do not match' }, 400);

  const mode = storageMode as StorageMode;

  if (mode === 'r2') {
    if (!c.env.SNITCHR_STORAGE) return c.json({ error: 'R2 binding not available' }, 400);
  } else if (mode === 's3') {
    const { s3Endpoint, s3Bucket, s3Region, s3AccessKey, s3SecretKey } = body;
    if (!s3Endpoint || !s3Bucket || !s3Region || !s3AccessKey || !s3SecretKey) {
      return c.json({ error: 'All S3 fields are required' }, 400);
    }
  } else if (mode === 'filesystem') {
    if (!c.env.DATA_DIR) return c.json({ error: 'Filesystem storage not available in this deployment' }, 400);
  } else if (mode !== 'memory') {
    return c.json({ error: 'Invalid storage mode' }, 400);
  }

  const salt = randomBytes(32);
  const pwHash = await hashPassword(password, salt);
  const config = {
    passwordHash: pwHash,
    passwordSalt: toHex(salt),
    userId: crypto.randomUUID(),
    machineList: {} as Record<string, never>,
    storageMode: mode,
    ...(mode === 's3' && {
      s3Endpoint: body.s3Endpoint,
      s3Bucket: body.s3Bucket,
      s3AccessKey: body.s3AccessKey,
      s3SecretKey: body.s3SecretKey,
      s3Region: body.s3Region,
    }),
    ...(mode === 'filesystem' && { dataDir: c.env.DATA_DIR }),
  };

  const store = storageFromConfig(config, c.env.SNITCHR_STORAGE);
  if (!store) return c.json({ error: 'Storage configuration invalid' }, 400);
  const storageTest = await store.test();
  if (!storageTest.ok) return c.json({ error: `Storage test failed: ${storageTest.error}` }, 400);

  await c.env.SNITCHR_CONFIG.put('config', JSON.stringify(config));

  const session = await createSession(pwHash);
  setCookie(c, 'session', session, COOKIE_OPTS);
  return c.json({ ok: true });
});

auth.post('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, prefix: 'login' }), async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config?.passwordSalt || !config.passwordHash) return c.json({ error: 'Not configured' }, 400);
  const { password } = await c.req.json<{ password: string }>();
  if (typeof password !== 'string') return c.json({ error: 'Password required' }, 400);
  const salt = fromHex(config.passwordSalt);
  const hash = await hashPassword(password, salt);
  if (!(await timingSafeEqual(hash, config.passwordHash))) return c.json({ error: 'Invalid password' }, 401);
  const session = await createSession(config.passwordHash);
  setCookie(c, 'session', session, COOKIE_OPTS);
  return c.json({ ok: true });
});

auth.get('/api/logout', c => {
  deleteCookie(c, 'session', { path: '/', secure: true });
  return c.redirect('/');
});

auth.post('/api/install-token', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config || !(await isAuthed(getCookie(c, 'session'), config.passwordHash))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (config.pendingToken && config.pendingTokenDisplay) {
    return c.json({ token: config.pendingTokenDisplay });
  }
  const token = compactToken();
  config.pendingToken = normalizeToken(token);
  config.pendingTokenDisplay = token;
  await c.env.SNITCHR_CONFIG.put('config', JSON.stringify(config));
  return c.json({ token });
});

const handleInstallAgent = async (c: import('hono').Context<{ Bindings: Bindings }>) => {
  const token = c.req.query('init') || c.req.query('token');
  if (!token) return c.text('Token required', 400);

  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config?.pendingToken || config.pendingToken !== normalizeToken(token)) {
    return c.text('Invalid or expired token', 403);
  }

  const reqUrl = new URL(c.req.url);
  const baseUrl = resolveBaseUrl(reqUrl);
  const asset = await c.env.ASSETS.fetch(new URL('/scripts/install.sh', c.req.url));
  const script = (await asset.text())
    .replace('__SNITCHR_URL__', baseUrl)
    .replace('__SNITCHR_TOKEN__', normalizeToken(token));

  return new Response(script, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};

auth.get('/agent', handleInstallAgent);
auth.get('/install-agent', handleInstallAgent);

auth.post('/register', async c => {
  const body = await c.req.json<{ token: string; sysinfo: Record<string, unknown> }>();
  if (typeof body.token !== 'string' || !body.token) return c.json({ error: 'Token required' }, 400);

  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config?.pendingToken || config.pendingToken !== normalizeToken(body.token)) {
    return c.json({ error: 'Invalid or expired token' }, 403);
  }

  const id = crypto.randomUUID();
  const secret = toHex(randomBytes(24));
  const cf = (c.req.raw as unknown as { cf?: CfGeoProperties }).cf;
  const entry: import('../types').MachineEntry = { secret, registeredAt: Date.now() };
  if (cf?.latitude && cf?.longitude) {
    entry.lat = Number(cf.latitude);
    entry.lng = Number(cf.longitude);
    if (cf.city) entry.city = cf.city;
    if (cf.country) entry.country = cf.country;
  }
  config.machineList[id] = entry;
  config.pendingToken = undefined;
  config.pendingTokenDisplay = undefined;
  await c.env.SNITCHR_CONFIG.put('config', JSON.stringify(config));

  return c.json({ id, secret });
});

auth.get('/api/config', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config || !(await isAuthed(getCookie(c, 'session'), config.passwordHash))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const machineIds = Object.keys(config.machineList);
  return c.json({
    machineIds,
    alertThreshold: config.alertThreshold ?? 2,
    storageMode: config.storageMode,
  });
});

export { auth };
