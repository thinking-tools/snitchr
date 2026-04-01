import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import type { Bindings } from './types';
import { isAuthed } from './crypto';
import { getConfig, serveAsset } from './config';
import { auth } from './routes/auth';
import { machines } from './routes/machines';
import { settings } from './routes/settings';

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', secureHeaders());
app.use('*', logger());

app.onError((err, c) => {
  if (err instanceof SyntaxError) return c.json({ error: 'Invalid JSON' }, 400);
  return c.json({ error: 'Internal error' }, 500);
});

app.get('/static/*', async c => {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(/^\/static/, '');
  const r = await c.env.ASSETS.fetch(url);
  return new Response(r.body, r);
});

app.get('/sw.js', async c => {
  const r = await c.env.ASSETS.fetch(new URL('/sw.js', c.req.url));
  return new Response(r.body, {
    status: r.status,
    headers: { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/', 'Cache-Control': 'no-cache' },
  });
});

app.get('/', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config) return serveAsset(c.env, c.req.url, '/setup.html');
  if (!(await isAuthed(getCookie(c, 'session'), config.passwordHash)))
    return serveAsset(c.env, c.req.url, '/login.html');
  return serveAsset(c.env, c.req.url, '/dashboard.html');
});

app.get('/settings', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config) return c.redirect('/');
  if (!(await isAuthed(getCookie(c, 'session'), config.passwordHash)))
    return serveAsset(c.env, c.req.url, '/login.html');
  return serveAsset(c.env, c.req.url, '/settings.html');
});

app.get('/machine/:id', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config) return c.redirect('/');
  if (!(await isAuthed(getCookie(c, 'session'), config.passwordHash)))
    return serveAsset(c.env, c.req.url, '/login.html');
  return serveAsset(c.env, c.req.url, '/machine.html');
});

app.route('', auth);
app.route('', machines);
app.route('', settings);

export { app };
