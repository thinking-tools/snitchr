import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import {
  EventLevel,
  type Bindings,
  type MachineStatus,
  type EventEntry,
  type AlertData,
  type HeartbeatData,
  type CfGeoProperties,
} from '../types';
import {
  sendNotifications,
  alertPayload,
  recoveryPayload,
  vapidKeysFromConfig,
  type NotifyDeps,
} from '../notifications';
import { isAuthed, timingSafeEqual } from '../crypto';
import { getConfig, storageFromConfig } from '../config';
import {
  validateEventLevel,
  validatePayload,
  validateHeartbeat,
  validateAlert,
  isFeatureEnabled,
  isDuplicateAlert,
  isOnline,
} from '../validators';
import { appendDiskSample, predictDiskFill } from '../disk-velocity';

const machines = new Hono<{ Bindings: Bindings }>();

// ── Ingestion (machine-authed) ──────────────────────────────────────────

machines.post(
  '/m/:id/ingest',
  bodyLimit({ maxSize: 8 * 1024, onError: c => c.json({ error: 'Payload too large' }, 413) }),
  async c => {
    const id = c.req.param('id');
    const config = await getConfig(c.env.SNITCHR_CONFIG);
    if (!config) return c.json({ error: 'Not configured' }, 500);

    const machine = config.machineList[id];
    if (!machine) return c.json({ error: 'Unknown machine' }, 404);

    const auth = c.req.header('Authorization');
    if (!auth?.startsWith('Bearer ') || !(await timingSafeEqual(auth.slice(7), machine.secret))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // backfill geo from Cloudflare cf object if missing
    let configDirty = false;
    if (machine.lat == null) {
      const cf = (c.req.raw as unknown as { cf?: CfGeoProperties }).cf;
      if (cf?.latitude && cf?.longitude) {
        machine.lat = Number(cf.latitude);
        machine.lng = Number(cf.longitude);
        if (cf.city) machine.city = cf.city;
        if (cf.country) machine.country = cf.country;
        configDirty = true;
      }
    }

    const store = storageFromConfig(config, c.env.SNITCHR_STORAGE);
    if (!store) return c.json({ error: 'Storage unavailable' }, 500);

    // ── Validate payload ──
    const body = await c.req.json<{ t: unknown; d: unknown }>();

    const levelResult = validateEventLevel(body.t);
    if (!levelResult.ok) return c.json({ error: levelResult.error }, 400);
    const t = levelResult.value;

    const payloadResult = validatePayload(body.d);
    if (!payloadResult.ok) return c.json({ error: payloadResult.error }, 400);
    const r = payloadResult.value;

    if (t === EventLevel.HEARTBEAT) {
      const hbResult = validateHeartbeat(r);
      if (!hbResult.ok) return c.json({ error: hbResult.error }, 400);
    } else {
      const alertResult = validateAlert(r);
      if (!alertResult.ok) return c.json({ error: alertResult.error }, 400);
    }

    const payload = body.d as HeartbeatData | AlertData;

    // Drop events whose feature is disabled server-side
    if (t > EventLevel.HEARTBEAT && t !== EventLevel.SHUTDOWN) {
      if (!isFeatureEnabled(config.agentFeatures, (payload as AlertData).type)) return c.json({ ok: true });
    }

    const ts = Date.now();
    const writes: Promise<unknown>[] = [];

    // ── Status update ──
    // Heartbeat: store full metrics. Shutdown: mark offline. Alert: update lastSeen only.
    if (t === EventLevel.SHUTDOWN) {
      // Preserve heartbeat data so dashboard still shows last-known metrics
      writes.push(
        store.get(`m/${id}/status.json`).then(raw => {
          let prev: MachineStatus = { lastSeen: 0 };
          if (raw)
            try {
              prev = JSON.parse(raw) as MachineStatus;
            } catch {
              /* corrupted — reset */
            }
          return store.put(`m/${id}/status.json`, JSON.stringify({ ...prev, lastSeen: 0 } satisfies MachineStatus));
        }),
      );
    } else if (t === EventLevel.HEARTBEAT) {
      // Merge snapshot fields: carry forward previous procList/portList/mountList/ttyList
      // when the new heartbeat omits them (agent only sends on change)
      writes.push(
        store.get(`m/${id}/status.json`).then(raw => {
          const hb = payload as HeartbeatData;
          let prevSamples: MachineStatus['diskSamples'];
          if (raw) {
            try {
              const prev = JSON.parse(raw) as MachineStatus;
              prevSamples = prev.diskSamples;
              if (prev.d) {
                if (hb.procList === undefined && prev.d.procList) hb.procList = prev.d.procList;
                if (hb.portList === undefined && prev.d.portList) hb.portList = prev.d.portList;
                if (hb.mountList === undefined && prev.d.mountList) hb.mountList = prev.d.mountList;
                if (hb.ttyList === undefined && prev.d.ttyList) hb.ttyList = prev.d.ttyList;
              }
            } catch {
              /* corrupted — skip merge */
            }
          }
          const diskSamples = hb.disk?.length ? appendDiskSample(prevSamples, ts, hb.disk[0]) : prevSamples;
          const status: MachineStatus = { lastSeen: ts, d: hb, diskSamples };
          return store.put(`m/${id}/status.json`, JSON.stringify(status));
        }),
      );
    } else {
      // Alert: preserve heartbeat metrics, only bump lastSeen
      writes.push(
        store.get(`m/${id}/status.json`).then(raw => {
          let prev: MachineStatus = { lastSeen: 0 };
          if (raw)
            try {
              prev = JSON.parse(raw) as MachineStatus;
            } catch {
              /* corrupted — reset */
            }
          return store.put(`m/${id}/status.json`, JSON.stringify({ ...prev, lastSeen: ts } satisfies MachineStatus));
        }),
      );
    }

    // ── Event log ──
    if (t > EventLevel.HEARTBEAT) {
      const entry: EventEntry = { t: t, ts, d: payload };
      const dt = new Date(ts);
      const pad = (n: number) => String(n).padStart(2, '0');
      const ymd = `${dt.getUTCFullYear()}/${pad(dt.getUTCMonth() + 1)}/${pad(dt.getUTCDate())}`;
      writes.push(store.put(`m/${id}/log/${ymd}/${ts}.json`, JSON.stringify(entry)));
    }

    // ── Alerts (with dedup) ──
    const threshold = config.alertThreshold ?? EventLevel.WARN;
    let isDup = false;
    if (t >= threshold && t !== EventLevel.SHUTDOWN) {
      const entry: EventEntry = { t: t, ts, d: payload };
      writes.push(
        store.get(`m/${id}/alerts.json`).then(raw => {
          let alerts: EventEntry[] = [];
          if (raw)
            try {
              alerts = JSON.parse(raw) as EventEntry[];
            } catch {
              /* corrupted, reset */
            }

          const windowMs = (config.heartbeatTimeout ?? 120) * 1000;
          isDup = isDuplicateAlert(alerts, payload as AlertData, ts, windowMs);
          if (isDup) return;

          alerts.unshift(entry);
          if (alerts.length > 100) alerts.length = 100;
          return store.put(`m/${id}/alerts.json`, JSON.stringify(alerts));
        }),
      );
    }

    await Promise.all(writes);

    // ── Push notification (skip duplicates) ──
    if (t >= threshold && t !== EventLevel.SHUTDOWN && !isDup && config.notifications) {
      const label = machine.label ?? id.slice(0, 8);
      const ad = payload as AlertData;
      const deps: NotifyDeps = { kv: c.env.SNITCHR_CONFIG, vapidKeys: vapidKeysFromConfig(config), contactEmail: c.env.VAPID_CONTACT };
      c.executionCtx.waitUntil(
        sendNotifications(
          config.notifications,
          alertPayload(t as EventLevel, label, ad.msg || `Event t:${t} on ${label}`),
          deps,
        ),
      );
    }

    // ── Recovery notification ──
    if (machine.notifiedDownAt) {
      machine.notifiedDownAt = undefined;
      configDirty = true;
      if (config.notifications) {
        const label = machine.label ?? id.slice(0, 8);
        const deps: NotifyDeps = { kv: c.env.SNITCHR_CONFIG, vapidKeys: vapidKeysFromConfig(config), contactEmail: c.env.VAPID_CONTACT };
        c.executionCtx.waitUntil(sendNotifications(config.notifications, recoveryPayload(label), deps));
      }
    }

    if (configDirty) await c.env.SNITCHR_CONFIG.put('config', JSON.stringify(config));

    return c.json({ ok: true });
  },
);

// ── Dashboard API (session-authed) ──────────────────────────────────────

machines.get('/api/machines', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config || !(await isAuthed(getCookie(c, 'session'), config.passwordHash))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const store = storageFromConfig(config, c.env.SNITCHR_STORAGE);
  if (!store) return c.json({ error: 'Storage unavailable' }, 500);

  const now = Date.now();
  const timeout = (config.heartbeatTimeout ?? 120) * 1000;

  const list = await Promise.all(
    Object.entries(config.machineList).map(async ([id, m]) => {
      const [status, alertRaw] = await Promise.all([
        store.getJSON<MachineStatus>(`m/${id}/status.json`),
        store.get(`m/${id}/alerts.json`),
      ]);
      let alertCount = 0;
      if (alertRaw)
        try {
          alertCount = (JSON.parse(alertRaw) as EventEntry[]).length;
        } catch {
          /* corrupted */
        }
      const online = isOnline(status?.lastSeen ?? 0, now, timeout);
      const diskPrediction = status?.diskSamples?.length ? predictDiskFill(status.diskSamples) : undefined;
      return {
        id,
        label: m.label,
        registeredAt: m.registeredAt,
        lat: m.lat,
        lng: m.lng,
        city: m.city,
        country: m.country,
        online,
        lastSeen: status?.lastSeen,
        d: status?.d,
        alertCount,
        diskPrediction,
      };
    }),
  );

  return c.json({
    machines: list,
    heartbeatTimeout: config.heartbeatTimeout ?? 120,
    alertThreshold: config.alertThreshold ?? EventLevel.WARN,
  });
});

machines.get('/api/machines/:id', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config || !(await isAuthed(getCookie(c, 'session'), config.passwordHash))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const id = c.req.param('id');
  const machine = config.machineList[id];
  if (!machine) return c.json({ error: 'Unknown machine' }, 404);

  const store = storageFromConfig(config, c.env.SNITCHR_STORAGE);
  if (!store) return c.json({ error: 'Storage unavailable' }, 500);

  const now = Date.now();
  const timeout = (config.heartbeatTimeout ?? 120) * 1000;

  const [status, alertRaw] = await Promise.all([
    store.getJSON<MachineStatus>(`m/${id}/status.json`),
    store.get(`m/${id}/alerts.json`),
  ]);

  let alerts: EventEntry[] = [];
  if (alertRaw)
    try {
      alerts = JSON.parse(alertRaw) as EventEntry[];
    } catch {
      /* corrupted */
    }
  const online = isOnline(status?.lastSeen ?? 0, now, timeout);
  const diskPrediction = status?.diskSamples?.length ? predictDiskFill(status.diskSamples) : undefined;

  return c.json({
    id,
    label: machine.label,
    registeredAt: machine.registeredAt,
    city: machine.city,
    country: machine.country,
    online,
    lastSeen: status?.lastSeen,
    d: status?.d,
    alerts,
    diskPrediction,
  });
});

machines.get('/api/machines/:id/events', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config || !(await isAuthed(getCookie(c, 'session'), config.passwordHash))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const id = c.req.param('id');
  if (!config.machineList[id]) return c.json({ error: 'Unknown machine' }, 404);

  const store = storageFromConfig(config, c.env.SNITCHR_STORAGE);
  if (!store) return c.json({ error: 'Storage unavailable' }, 500);

  const date = c.req.query('date');
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200);
  const cursor = c.req.query('cursor');

  const dt = date ? new Date(date + 'T00:00:00Z') : new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const prefix = `m/${id}/log/${dt.getUTCFullYear()}/${pad(dt.getUTCMonth() + 1)}/${pad(dt.getUTCDate())}/`;

  const res = await store.list(prefix, { limit, cursor, delimiter: '' });

  const events = await Promise.all(
    res.entries.map(async e => {
      const raw = await store.get(e.key);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as EventEntry;
      } catch {
        return null;
      }
    }),
  );

  return c.json({
    events: events.filter((e): e is EventEntry => e !== null),
    cursor: res.cursor,
    truncated: res.truncated,
  });
});

machines.get('/api/machines/:id/alerts', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config || !(await isAuthed(getCookie(c, 'session'), config.passwordHash))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const id = c.req.param('id');
  if (!config.machineList[id]) return c.json({ error: 'Unknown machine' }, 404);

  const store = storageFromConfig(config, c.env.SNITCHR_STORAGE);
  if (!store) return c.json({ error: 'Storage unavailable' }, 500);

  const raw = await store.get(`m/${id}/alerts.json`);
  let alerts: EventEntry[] = [];
  if (raw)
    try {
      alerts = JSON.parse(raw) as EventEntry[];
    } catch {
      /* corrupted */
    }
  return c.json({ alerts });
});

machines.patch('/api/machines/:id', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config || !(await isAuthed(getCookie(c, 'session'), config.passwordHash))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const id = c.req.param('id');
  const machine = config.machineList[id];
  if (!machine) return c.json({ error: 'Unknown machine' }, 404);

  const body = await c.req.json<{ label?: string }>();
  if (typeof body.label === 'string') {
    if (body.label.length > 100) return c.json({ error: 'Label too long' }, 400);
    machine.label = body.label.trim() || undefined;
  }
  await c.env.SNITCHR_CONFIG.put('config', JSON.stringify(config));
  return c.json({ ok: true });
});

machines.delete('/api/machines/:id', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config || !(await isAuthed(getCookie(c, 'session'), config.passwordHash))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const id = c.req.param('id');
  if (!config.machineList[id]) return c.json({ error: 'Unknown machine' }, 404);

  const store = storageFromConfig(config, c.env.SNITCHR_STORAGE);
  if (!store) return c.json({ error: 'Storage unavailable' }, 500);

  delete config.machineList[id];
  await Promise.all([c.env.SNITCHR_CONFIG.put('config', JSON.stringify(config)), store.deletePrefix(`m/${id}/`)]);
  return c.json({ ok: true });
});

machines.delete('/api/machines/:id/alerts', async c => {
  const config = await getConfig(c.env.SNITCHR_CONFIG);
  if (!config || !(await isAuthed(getCookie(c, 'session'), config.passwordHash))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const id = c.req.param('id');
  if (!config.machineList[id]) return c.json({ error: 'Unknown machine' }, 404);

  const store = storageFromConfig(config, c.env.SNITCHR_STORAGE);
  if (!store) return c.json({ error: 'Storage unavailable' }, 500);

  await store.delete(`m/${id}/alerts.json`);
  return c.json({ ok: true });
});

export { machines };
