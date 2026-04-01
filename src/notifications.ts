import {
  EventLevel,
  EVENT_LEVEL_LABEL,
  type NotificationChannelConfig,
  type NotificationPayload,
} from './types';
import { randomBytes, toHex } from './crypto';
import type { KVStore } from './kv';
import { sendWebPush, type VapidKeys, type PushSubscriptionRecord } from './webpush';

export type NotifyDeps = { kv?: KVStore; vapidKeys?: VapidKeys; contactEmail?: string };

/** Extract VAPID keys from config, returns undefined if not set. */
export const vapidKeysFromConfig = (config: { vapidPublicKey?: string; vapidPrivateKey?: string }): VapidKeys | undefined =>
  config.vapidPublicKey && config.vapidPrivateKey
    ? { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey }
    : undefined;

// ── Channel interface ──────────────────────────────────────────────────

type NotificationChannel = {
  send: (payload: NotificationPayload) => Promise<void>;
};

// ── Channel factories ──────────────────────────────────────────────────

const createNtfyChannel = (endpoint: string): NotificationChannel => ({
  send: async (payload) => {
    const headers: Record<string, string> = {
      Title: payload.title,
      Priority: payload.priority,
    };
    if (payload.tags) headers.Tags = payload.tags;
    await fetch(endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers,
      body: payload.body,
    });
  },
});

const webhookBody = (payload: NotificationPayload): string =>
  JSON.stringify({
    id: `evt_${toHex(randomBytes(8))}`,
    event: payload.event,
    timestamp: new Date().toISOString(),
    machine: payload.machineId ? { id: payload.machineId, label: payload.machineLabel ?? payload.machineId } : undefined,
    level: payload.level,
    levelName: EVENT_LEVEL_LABEL[payload.level] ?? 'UNKNOWN',
    title: payload.title,
    body: payload.body,
    priority: payload.priority,
  });

const hmacSign = async (secret: string, content: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(content)));
  return `sha256=${Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('')}`;
};

const createWebhookChannel = (url: string, secret?: string): NotificationChannel => ({
  send: async (payload) => {
    const body = webhookBody(payload);
    const ts = Math.floor(Date.now() / 1000).toString();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret) {
      headers['X-Snitchr-Signature'] = await hmacSign(secret, `${ts}.${body}`);
      headers['X-Snitchr-Timestamp'] = ts;
    }
    await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5000), headers, body });
  },
});

const SLACK_COLOR: Record<string, string> = {
  urgent: '#dc2626',
  high: '#f97316',
  default: '#eab308',
  low: '#22c55e',
};

const slackColor = (payload: NotificationPayload): string => {
  if (payload.event === 'recovery') return '#22c55e';
  if (payload.event === 'down') return '#dc2626';
  return SLACK_COLOR[payload.priority] ?? '#6b7280';
};

const createSlackChannel = (webhookUrl: string): NotificationChannel => ({
  send: async (payload) => {
    const body = JSON.stringify({
      attachments: [
        {
          color: slackColor(payload),
          blocks: [
            { type: 'header', text: { type: 'plain_text', text: payload.title } },
            { type: 'section', text: { type: 'mrkdwn', text: payload.body } },
          ],
        },
      ],
    });
    await fetch(webhookUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  },
});

/** Network/timeout errors are transient — don't remove subscriptions for them. */
const isTransientError = (err: unknown): boolean => {
  if (err instanceof TypeError) return true; // network failure ("Failed to fetch")
  if (err instanceof DOMException) return err.name === 'AbortError' || err.name === 'TimeoutError';
  return false; // crypto/encoding errors (DataError, InvalidCharacterError, etc.) are permanent
};

const PUSH_SUBS_KEY = 'push_subscriptions';

const createWebPushChannel = (kv: KVStore, vapidKeys: VapidKeys, contact: string): NotificationChannel => ({
  send: async (payload) => {
    const raw = await kv.get(PUSH_SUBS_KEY);
    if (!raw) return;
    let subs: PushSubscriptionRecord[];
    try {
      subs = JSON.parse(raw) as PushSubscriptionRecord[];
    } catch {
      return;
    }
    if (!subs.length) return;

    const pushPayload = JSON.stringify({
      title: payload.title,
      body: payload.body,
      priority: payload.priority,
      tag: payload.event,
      url: '/',
    });

    const dead: string[] = [];
    const results = await Promise.allSettled(subs.map((sub) => sendWebPush(sub, pushPayload, vapidKeys, contact)));
    const anyFulfilled = results.some((r) => r.status === 'fulfilled');

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        if (r.value.status === 404 || r.value.status === 410) dead.push(subs[i].endpoint);
      } else if (anyFulfilled && !isTransientError(r.reason)) {
        // Crypto/encoding failure — subscription keys are bad, will never work.
        // Only clean when at least one sub reached HTTP (guards against systemic VAPID key issues).
        dead.push(subs[i].endpoint);
      }
    }

    if (dead.length) {
      const live = subs.filter((s) => !dead.includes(s.endpoint));
      await kv.put(PUSH_SUBS_KEY, JSON.stringify(live));
    }
  },
});

const channelFromConfig = (config: NotificationChannelConfig, deps?: NotifyDeps): NotificationChannel | null => {
  switch (config.type) {
    case 'ntfy':
      return createNtfyChannel(config.endpoint);
    case 'webhook':
      return createWebhookChannel(config.url, config.secret);
    case 'slack':
      return createSlackChannel(config.webhookUrl);
    case 'webpush': {
      if (!deps?.kv || !deps?.vapidKeys) return null;
      const raw = deps.contactEmail ?? '';
      const contact = raw.startsWith('mailto:') ? raw : `mailto:${raw || 'vapid-not-configured@localhost'}`;
      return createWebPushChannel(deps.kv, deps.vapidKeys, contact);
    }
    default:
      return null;
  }
};

// ── Fan-out ────────────────────────────────────────────────────────────

/** Check if any notification channel is enabled. */
export const hasEnabledChannels = (notifications: Record<string, NotificationChannelConfig>): boolean =>
  Object.values(notifications).some((ch) => ch.enabled);

/** Send payload to all enabled channels. Errors are caught per-channel. */
export const sendNotifications = async (
  notifications: Record<string, NotificationChannelConfig>,
  payload: NotificationPayload,
  deps?: NotifyDeps,
): Promise<void> => {
  const sends = Object.values(notifications)
    .filter((ch) => ch.enabled)
    .map((ch) => channelFromConfig(ch, deps))
    .filter((ch): ch is NotificationChannel => ch !== null)
    .map((ch) => ch.send(payload).catch(() => {}));
  await Promise.allSettled(sends);
};

/** Send test notification to a single channel by key. Returns error string or null. */
export const sendTestNotification = async (
  notifications: Record<string, NotificationChannelConfig>,
  channelKey: string,
  deps?: NotifyDeps,
): Promise<string | null> => {
  const config = notifications[channelKey];
  if (!config) return 'Unknown channel';

  const channel = channelFromConfig(config, deps);
  if (!channel) return 'Unsupported channel type';

  const payload: NotificationPayload = {
    event: 'test',
    title: 'snitchr',
    body: 'Test notification — your snitchr notifications are working!',
    priority: 'default',
    tags: 'white_check_mark',
    level: EventLevel.INFO,
    machineId: 'test',
    machineLabel: 'Test',
  };

  try {
    await channel.send(payload);
    return null;
  } catch {
    return 'Failed to reach endpoint';
  }
};

// ── Payload helpers ────────────────────────────────────────────────────

type MachineCtx = { machineId: string; machineLabel: string };

export const alertPayload = (level: EventLevel, label: string, msg: string, machine?: MachineCtx): NotificationPayload => ({
  event: 'alert',
  title: `${EVENT_LEVEL_LABEL[level] ?? 'ALERT'}: ${label}`,
  body: msg,
  priority: level >= EventLevel.ERROR ? 'high' : 'default',
  level,
  machineId: machine?.machineId,
  machineLabel: machine?.machineLabel,
});

export const recoveryPayload = (label: string, machine?: MachineCtx): NotificationPayload => ({
  event: 'recovery',
  title: `UP: ${label}`,
  body: `Machine ${label} is back online`,
  priority: 'default',
  tags: 'white_check_mark',
  level: EventLevel.INFO,
  machineId: machine?.machineId,
  machineLabel: machine?.machineLabel,
});

export const downPayload = (label: string, agoMinutes: number, machine?: MachineCtx): NotificationPayload => ({
  event: 'down',
  title: `DOWN: ${label}`,
  body: `Machine ${label} last seen ${agoMinutes}m ago`,
  priority: 'urgent',
  tags: 'red_circle',
  level: EventLevel.CRITICAL,
  machineId: machine?.machineId,
  machineLabel: machine?.machineLabel,
});

export const diskFillPayload = (label: string, currentPct: number, hoursLeft: number, machine?: MachineCtx): NotificationPayload => {
  const eta = hoursLeft < 1 ? `${Math.round(hoursLeft * 60)}m` : `${Math.round(hoursLeft)}h`;
  return {
    event: 'alert',
    title: `DISK: ${label}`,
    body: `Disk predicted to reach 90% in ~${eta} (currently ${currentPct}%)`,
    priority: hoursLeft <= 6 ? 'urgent' : 'high',
    tags: 'warning',
    level: hoursLeft <= 6 ? EventLevel.CRITICAL : EventLevel.WARN,
    machineId: machine?.machineId,
    machineLabel: machine?.machineLabel,
  };
};
