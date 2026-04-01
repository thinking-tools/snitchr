import { EventLevel, EVENT_FEATURE_MAP, type AgentFeatures, type AlertData, type EventEntry, type NotificationChannelConfig } from './types';

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
const err = (error: string): Err => ({ ok: false, error });

export const validateEventLevel = (t: unknown): Result<EventLevel> => {
  if (typeof t !== 'number' || !Number.isInteger(t) || t < 0 || t > 5) return err('Invalid event level');
  return ok(t as EventLevel);
};

export const validatePayload = (d: unknown): Result<Record<string, unknown>> => {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return err('Missing payload');
  return ok(d as Record<string, unknown>);
};

export const validateHeartbeat = (r: Record<string, unknown>): Result<true> => {
  if (
    typeof r.ts !== 'number' ||
    typeof r.cpu !== 'number' ||
    typeof r.up !== 'number' ||
    typeof r.procs !== 'number' ||
    !Array.isArray(r.mem) ||
    r.mem.length < 2 ||
    !Array.isArray(r.disk) ||
    r.disk.length < 1 ||
    !Array.isArray(r.load) ||
    r.load.length < 3 ||
    !Array.isArray(r.net) ||
    r.net.length < 2 ||
    typeof r.ports !== 'string' ||
    r.ports.length > 2000 ||
    typeof r.users !== 'string' ||
    r.users.length > 1000
  )
    return err('Invalid heartbeat');
  if (r.procList !== undefined && (typeof r.procList !== 'string' || r.procList.length > 50_000)) return err('Invalid procList');
  if (r.portList !== undefined && (!Array.isArray(r.portList) || r.portList.length > 500)) return err('Invalid portList');
  if (r.mountList !== undefined && (!Array.isArray(r.mountList) || r.mountList.length > 500)) return err('Invalid mountList');
  if (r.ttyList !== undefined && (!Array.isArray(r.ttyList) || r.ttyList.length > 500)) return err('Invalid ttyList');
  return ok(true);
};

export const validateAlert = (r: Record<string, unknown>): Result<true> => {
  if (typeof r.type !== 'string' || typeof r.msg !== 'string') return err('Invalid alert');
  if (r.type !== 'shutdown' && !(r.type in EVENT_FEATURE_MAP)) return err('Unknown event type');
  if ((r.msg as string).length > 2000) return err('Message too long');
  return ok(true);
};

export const isFeatureEnabled = (agentFeatures: AgentFeatures | undefined, eventType: string): boolean => {
  const feature = EVENT_FEATURE_MAP[eventType];
  if (!feature) return true;
  return agentFeatures?.[feature] !== false;
};

export const isDuplicateAlert = (
  alerts: EventEntry[],
  alert: AlertData,
  ts: number,
  windowMs: number,
): boolean =>
  alerts.some(a => {
    const prev = a.d as AlertData;
    return prev?.type === alert.type && prev?.msg === alert.msg && ts - a.ts < windowMs;
  });

export const isOnline = (lastSeen: number, now: number, timeoutMs: number): boolean =>
  lastSeen > 0 && now - lastSeen <= timeoutMs;

export const validateAlertThreshold = (v: unknown): Result<number> => {
  const t = Number(v);
  if (!Number.isInteger(t) || t < 1 || t > 4) return err('Alert threshold must be 1\u20134');
  return ok(t);
};

export const validateHeartbeatTimeout = (v: unknown): Result<number> => {
  const t = Number(v);
  if (!Number.isInteger(t) || t < 30 || t > 3600) return err('Heartbeat timeout must be 30\u20133600s');
  return ok(t);
};

export const validateNtfyEndpoint = (v: unknown): Result<string> => {
  if (typeof v !== 'string') return err('Invalid endpoint URL');
  const ep = v.trim();
  if (ep && !/^https?:\/\/.+/.test(ep)) return err('Invalid endpoint URL');
  return ok(ep || '');
};

const validateHttpUrl = (v: unknown): Result<string> => {
  if (typeof v !== 'string' || !v.trim()) return err('URL required');
  if (!/^https?:\/\/.+/.test(v.trim())) return err('Invalid URL');
  return ok(v.trim());
};

export const validateNotificationChannel = (ch: unknown): Result<NotificationChannelConfig> => {
  if (!ch || typeof ch !== 'object') return err('Invalid channel config');
  const c = ch as Record<string, unknown>;
  if (typeof c.enabled !== 'boolean') return err('enabled must be boolean');

  switch (c.type) {
    case 'ntfy': {
      const r = validateHttpUrl(c.endpoint);
      return r.ok ? ok({ type: 'ntfy', endpoint: r.value, enabled: c.enabled } as NotificationChannelConfig) : r;
    }
    case 'webhook': {
      const r = validateHttpUrl(c.url);
      if (!r.ok) return r;
      if (c.secret !== undefined && typeof c.secret !== 'string') return err('secret must be string');
      return ok({ type: 'webhook', url: r.value, secret: c.secret as string | undefined, enabled: c.enabled } as NotificationChannelConfig);
    }
    case 'slack': {
      const r = validateHttpUrl(c.webhookUrl);
      if (!r.ok) return r;
      if (!r.value.startsWith('https://hooks.slack.com/')) return err('Must be a Slack webhook URL');
      return ok({ type: 'slack', webhookUrl: r.value, enabled: c.enabled } as NotificationChannelConfig);
    }
    case 'webpush':
      return ok({ type: 'webpush', enabled: c.enabled } as NotificationChannelConfig);
    default:
      return err('Unknown channel type');
  }
};
