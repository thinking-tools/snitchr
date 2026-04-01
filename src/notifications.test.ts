import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendNotifications, sendTestNotification, alertPayload, recoveryPayload, downPayload, hasEnabledChannels } from './notifications';
import { EventLevel, type NotificationChannelConfig } from './types';
import { InMemoryKV } from './kv';
import type { WebPushResult } from './webpush';

vi.mock('./webpush', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./webpush')>();
  return { ...orig, sendWebPush: vi.fn() };
});
import { sendWebPush } from './webpush';

describe('notifications', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('hasEnabledChannels', () => {
    it('returns true when at least one channel is enabled', () => {
      expect(hasEnabledChannels({ ntfy: { type: 'ntfy', endpoint: 'https://ntfy.sh/t', enabled: true } })).toBe(true);
    });

    it('returns false when all channels are disabled', () => {
      expect(hasEnabledChannels({ ntfy: { type: 'ntfy', endpoint: 'https://ntfy.sh/t', enabled: false } })).toBe(false);
    });

    it('returns false for empty record', () => {
      expect(hasEnabledChannels({})).toBe(false);
    });
  });

  describe('sendNotifications', () => {
    it('sends to enabled ntfy channel', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
      const channels: Record<string, NotificationChannelConfig> = {
        ntfy: { type: 'ntfy', endpoint: 'https://ntfy.sh/test', enabled: true },
      };

      await sendNotifications(channels, alertPayload(EventLevel.WARN, 'srv1', 'SSH login'));

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://ntfy.sh/test');
      expect((init as RequestInit).method).toBe('POST');
      expect((init as RequestInit).body).toBe('SSH login');
      expect(((init as RequestInit).headers as Record<string, string>).Title).toBe('WARN: srv1');
    });

    it('skips disabled channels', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
      const channels: Record<string, NotificationChannelConfig> = {
        ntfy: { type: 'ntfy', endpoint: 'https://ntfy.sh/test', enabled: false },
      };

      await sendNotifications(channels, alertPayload(EventLevel.WARN, 'srv1', 'test'));
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('catches per-channel errors without throwing', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));
      const channels: Record<string, NotificationChannelConfig> = {
        ntfy: { type: 'ntfy', endpoint: 'https://ntfy.sh/test', enabled: true },
      };

      await expect(sendNotifications(channels, alertPayload(EventLevel.ERROR, 'srv', 'fail'))).resolves.toBeUndefined();
    });
  });

  describe('sendTestNotification', () => {
    it('sends test payload to the specified channel', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
      const channels: Record<string, NotificationChannelConfig> = {
        ntfy: { type: 'ntfy', endpoint: 'https://ntfy.sh/test', enabled: true },
      };

      const err = await sendTestNotification(channels, 'ntfy');
      expect(err).toBeNull();
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('returns error for unknown channel key', async () => {
      const err = await sendTestNotification({}, 'missing');
      expect(err).toBe('Unknown channel');
    });

    it('returns error when fetch fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout'));
      const channels: Record<string, NotificationChannelConfig> = {
        ntfy: { type: 'ntfy', endpoint: 'https://ntfy.sh/test', enabled: true },
      };

      const err = await sendTestNotification(channels, 'ntfy');
      expect(err).toBe('Failed to reach endpoint');
    });
  });

  describe('webhook channel', () => {
    it('sends JSON payload to webhook URL with machine context', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
      const channels: Record<string, NotificationChannelConfig> = {
        wh: { type: 'webhook', url: 'https://example.com/hook', enabled: true },
      };

      await sendNotifications(channels, alertPayload(EventLevel.WARN, 'srv1', 'test alert', { machineId: 'srv1', machineLabel: 'srv1' }));

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://example.com/hook');
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers).not.toHaveProperty('X-Snitchr-Signature');
      expect(headers).not.toHaveProperty('X-Snitchr-Timestamp');

      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.id).toMatch(/^evt_[0-9a-f]{16}$/);
      expect(body.event).toBe('alert');
      expect(body.title).toBe('WARN: srv1');
      expect(body.body).toBe('test alert');
      expect(body.level).toBe(EventLevel.WARN);
      expect(body.levelName).toBe('WARN');
      expect(body.machine).toEqual({ id: 'srv1', label: 'srv1' });
      expect(body.timestamp).toBeDefined();
    });

    it('adds HMAC signature and timestamp when secret is set', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
      const channels: Record<string, NotificationChannelConfig> = {
        wh: { type: 'webhook', url: 'https://example.com/hook', secret: 'mysecret', enabled: true },
      };

      await sendNotifications(channels, alertPayload(EventLevel.ERROR, 'db', 'down'));

      const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers['X-Snitchr-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(headers['X-Snitchr-Timestamp']).toMatch(/^\d+$/);
    });

    it('signs timestamp.body for replay protection', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
      const channels: Record<string, NotificationChannelConfig> = {
        wh: { type: 'webhook', url: 'https://example.com/hook', secret: 'testsecret', enabled: true },
      };

      await sendNotifications(channels, alertPayload(EventLevel.WARN, 'x', 'y'));

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      const ts = headers['X-Snitchr-Timestamp'];
      const rawBody = init.body as string;

      // Verify signature matches timestamp.body
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode('testsecret'),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${rawBody}`)));
      const expected = `sha256=${Array.from(sig, b => b.toString(16).padStart(2, '0')).join('')}`;
      expect(headers['X-Snitchr-Signature']).toBe(expected);
    });

    it('omits machine field when no machine context', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
      const channels: Record<string, NotificationChannelConfig> = {
        wh: { type: 'webhook', url: 'https://example.com/hook', enabled: true },
      };

      await sendNotifications(channels, alertPayload(EventLevel.WARN, 'srv1', 'test'));

      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.machine).toBeUndefined();
    });
  });

  describe('slack channel', () => {
    it('sends Block Kit payload to Slack webhook', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
      const channels: Record<string, NotificationChannelConfig> = {
        slack: { type: 'slack', webhookUrl: 'https://hooks.slack.com/services/T/B/x', enabled: true },
      };

      await sendNotifications(channels, downPayload('web-1', 3));

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://hooks.slack.com/services/T/B/x');
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.attachments[0].color).toBe('#dc2626');
      expect(body.attachments[0].blocks[0].text.text).toBe('DOWN: web-1');
    });

    it('uses green color for recovery events', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
      const channels: Record<string, NotificationChannelConfig> = {
        slack: { type: 'slack', webhookUrl: 'https://hooks.slack.com/services/T/B/x', enabled: true },
      };

      await sendNotifications(channels, recoveryPayload('db-1'));

      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.attachments[0].color).toBe('#22c55e');
    });

    it('uses default color for non-recovery/non-down alert', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
      const channels: Record<string, NotificationChannelConfig> = {
        slack: { type: 'slack', webhookUrl: 'https://hooks.slack.com/services/T/B/x', enabled: true },
      };

      await sendNotifications(channels, alertPayload(EventLevel.INFO, 'srv', 'info event'));

      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.attachments[0].color).toBe('#eab308');
    });

    it('uses fallback color for unknown priority', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
      const channels: Record<string, NotificationChannelConfig> = {
        slack: { type: 'slack', webhookUrl: 'https://hooks.slack.com/services/T/B/x', enabled: true },
      };

      const payload = { ...alertPayload(EventLevel.INFO, 'x', 'y'), priority: 'unknown' as never };
      await sendNotifications(channels, payload);

      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.attachments[0].color).toBe('#6b7280');
    });
  });

  describe('webpush dead subscription cleanup', () => {
    const mockSendWebPush = sendWebPush as ReturnType<typeof vi.fn>;
    const SUBS_KEY = 'push_subscriptions';

    const makeSub = (id: string) => ({
      endpoint: `https://push.example.com/${id}`,
      keys: { p256dh: 'dGVzdA', auth: 'dGVzdA' },
    });

    const webpushChannels: Record<string, NotificationChannelConfig> = {
      webpush: { type: 'webpush', enabled: true },
    };

    const makeDeps = (kv: InMemoryKV) => ({
      kv,
      vapidKeys: { publicKey: 'pubkey', privateKey: 'privkey' },
    });

    const okResult = (endpoint: string): WebPushResult => ({ endpoint, status: 201, ok: true });
    const goneResult = (endpoint: string): WebPushResult => ({ endpoint, status: 410, ok: false });
    const notFoundResult = (endpoint: string): WebPushResult => ({ endpoint, status: 404, ok: false });

    it('removes subscriptions that return 410 Gone', async () => {
      const kv = new InMemoryKV();
      const subs = [makeSub('alive'), makeSub('dead')];
      await kv.put(SUBS_KEY, JSON.stringify(subs));

      mockSendWebPush
        .mockResolvedValueOnce(okResult(subs[0].endpoint))
        .mockResolvedValueOnce(goneResult(subs[1].endpoint));

      await sendNotifications(webpushChannels, alertPayload(EventLevel.WARN, 'srv', 'test'), makeDeps(kv));

      const remaining = JSON.parse((await kv.get(SUBS_KEY))!);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].endpoint).toBe(subs[0].endpoint);
    });

    it('removes subscriptions that return 404 Not Found', async () => {
      const kv = new InMemoryKV();
      const subs = [makeSub('alive'), makeSub('gone')];
      await kv.put(SUBS_KEY, JSON.stringify(subs));

      mockSendWebPush
        .mockResolvedValueOnce(okResult(subs[0].endpoint))
        .mockResolvedValueOnce(notFoundResult(subs[1].endpoint));

      await sendNotifications(webpushChannels, alertPayload(EventLevel.WARN, 'srv', 'test'), makeDeps(kv));

      const remaining = JSON.parse((await kv.get(SUBS_KEY))!);
      expect(remaining).toHaveLength(1);
    });

    it('removes subscription with crypto error when others succeed', async () => {
      const kv = new InMemoryKV();
      const subs = [makeSub('good'), makeSub('bad-keys')];
      await kv.put(SUBS_KEY, JSON.stringify(subs));

      mockSendWebPush
        .mockResolvedValueOnce(okResult(subs[0].endpoint))
        .mockRejectedValueOnce(new DOMException('Invalid key data', 'DataError'));

      await sendNotifications(webpushChannels, alertPayload(EventLevel.WARN, 'srv', 'test'), makeDeps(kv));

      const remaining = JSON.parse((await kv.get(SUBS_KEY))!);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].endpoint).toBe(subs[0].endpoint);
    });

    it('keeps subscription on transient network error', async () => {
      const kv = new InMemoryKV();
      const subs = [makeSub('good'), makeSub('temp-down')];
      await kv.put(SUBS_KEY, JSON.stringify(subs));

      mockSendWebPush
        .mockResolvedValueOnce(okResult(subs[0].endpoint))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await sendNotifications(webpushChannels, alertPayload(EventLevel.WARN, 'srv', 'test'), makeDeps(kv));

      const remaining = JSON.parse((await kv.get(SUBS_KEY))!);
      expect(remaining).toHaveLength(2);
    });

    it('keeps subscription on timeout error', async () => {
      const kv = new InMemoryKV();
      const subs = [makeSub('good'), makeSub('slow')];
      await kv.put(SUBS_KEY, JSON.stringify(subs));

      mockSendWebPush
        .mockResolvedValueOnce(okResult(subs[0].endpoint))
        .mockRejectedValueOnce(new DOMException('Signal timed out', 'TimeoutError'));

      await sendNotifications(webpushChannels, alertPayload(EventLevel.WARN, 'srv', 'test'), makeDeps(kv));

      const remaining = JSON.parse((await kv.get(SUBS_KEY))!);
      expect(remaining).toHaveLength(2);
    });

    it('does not wipe all subs when every send rejects (systemic VAPID failure)', async () => {
      const kv = new InMemoryKV();
      const subs = [makeSub('a'), makeSub('b'), makeSub('c')];
      await kv.put(SUBS_KEY, JSON.stringify(subs));

      mockSendWebPush.mockRejectedValue(new DOMException('Bad key', 'DataError'));

      await sendNotifications(webpushChannels, alertPayload(EventLevel.WARN, 'srv', 'test'), makeDeps(kv));

      const remaining = JSON.parse((await kv.get(SUBS_KEY))!);
      expect(remaining).toHaveLength(3);
    });

    it('keeps subs untouched when all succeed', async () => {
      const kv = new InMemoryKV();
      const subs = [makeSub('a'), makeSub('b')];
      await kv.put(SUBS_KEY, JSON.stringify(subs));

      mockSendWebPush.mockImplementation((sub: { endpoint: string }) =>
        Promise.resolve(okResult(sub.endpoint)),
      );

      await sendNotifications(webpushChannels, alertPayload(EventLevel.WARN, 'srv', 'test'), makeDeps(kv));

      const remaining = JSON.parse((await kv.get(SUBS_KEY))!);
      expect(remaining).toHaveLength(2);
    });
  });

  describe('unknown channel type', () => {
    it('skips channels with unrecognized type', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
      const channels: Record<string, NotificationChannelConfig> = {
        bad: { type: 'unknown' as never, enabled: true },
      };

      await sendNotifications(channels, alertPayload(EventLevel.WARN, 'x', 'y'));
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('webpush edge cases', () => {
    const mockSendWebPush = sendWebPush as ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockSendWebPush.mockClear();
    });

    it('handles corrupt subscription JSON gracefully', async () => {
      const kv = new InMemoryKV();
      await kv.put('push_subscriptions', 'not valid json{{{');

      const channels: Record<string, NotificationChannelConfig> = {
        webpush: { type: 'webpush', enabled: true },
      };

      await expect(
        sendNotifications(channels, alertPayload(EventLevel.WARN, 'x', 'y'), {
          kv,
          vapidKeys: { publicKey: 'pk', privateKey: 'sk' },
        }),
      ).resolves.toBeUndefined();
    });

    it('handles empty subscription list', async () => {
      const kv = new InMemoryKV();
      await kv.put('push_subscriptions', '[]');

      const channels: Record<string, NotificationChannelConfig> = {
        webpush: { type: 'webpush', enabled: true },
      };

      await sendNotifications(channels, alertPayload(EventLevel.WARN, 'x', 'y'), {
        kv,
        vapidKeys: { publicKey: 'pk', privateKey: 'sk' },
      });
      expect(mockSendWebPush).not.toHaveBeenCalled();
    });
  });

  describe('payload helpers', () => {
    it('alertPayload sets high priority for ERROR+', () => {
      const p = alertPayload(EventLevel.ERROR, 'srv', 'disk full');
      expect(p.event).toBe('alert');
      expect(p.priority).toBe('high');
      expect(p.title).toBe('ERROR: srv');
      expect(p.body).toBe('disk full');
    });

    it('alertPayload sets default priority for WARN', () => {
      expect(alertPayload(EventLevel.WARN, 'x', 'y').priority).toBe('default');
    });

    it('alertPayload includes machine context when provided', () => {
      const p = alertPayload(EventLevel.WARN, 'web-1', 'test', { machineId: 'abc', machineLabel: 'web-1' });
      expect(p.machineId).toBe('abc');
      expect(p.machineLabel).toBe('web-1');
    });

    it('recoveryPayload has correct shape', () => {
      const p = recoveryPayload('web-1');
      expect(p.event).toBe('recovery');
      expect(p.title).toBe('UP: web-1');
      expect(p.tags).toBe('white_check_mark');
    });

    it('recoveryPayload includes machine context when provided', () => {
      const p = recoveryPayload('web-1', { machineId: 'abc', machineLabel: 'web-1' });
      expect(p.machineId).toBe('abc');
    });

    it('downPayload has correct shape', () => {
      const p = downPayload('db-1', 5);
      expect(p.event).toBe('down');
      expect(p.title).toBe('DOWN: db-1');
      expect(p.priority).toBe('urgent');
      expect(p.body).toContain('5m ago');
    });

    it('downPayload includes machine context when provided', () => {
      const p = downPayload('db-1', 5, { machineId: 'db1', machineLabel: 'db-1' });
      expect(p.machineId).toBe('db1');
      expect(p.machineLabel).toBe('db-1');
    });
  });
});
