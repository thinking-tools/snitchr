import { describe, it, expect } from 'vitest';
import {
  validateEventLevel,
  validatePayload,
  validateHeartbeat,
  validateAlert,
  isFeatureEnabled,
  isDuplicateAlert,
  isOnline,
  validateAlertThreshold,
  validateHeartbeatTimeout,
  validateNtfyEndpoint,
  validateNotificationChannel,
} from './validators';
import { EventLevel, type EventEntry, type AlertData } from './types';

// ── Helpers ──

const validHeartbeat = (): Record<string, unknown> => ({
  ts: Date.now(),
  cpu: 45.2,
  up: 123456,
  procs: 200,
  mem: [4096, 8192],
  disk: [50],
  load: [1.5, 1.2, 0.8],
  net: [1000, 2000],
  ports: '22,80,443',
  users: 'root',
});

const alertEntry = (type: string, msg: string, ts: number): EventEntry => ({
  t: EventLevel.WARN,
  ts,
  d: { type, msg } as AlertData,
});

// ── Tests ──

describe('validateEventLevel', () => {
  it.each([0, 1, 2, 3, 4, 5])('accepts valid level %d', level => {
    const r = validateEventLevel(level);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(level);
  });

  it.each([-1, 6, 1.5, NaN, Infinity])('rejects invalid number %d', val => {
    expect(validateEventLevel(val).ok).toBe(false);
  });

  it.each(['0', null, undefined, {}, []])('rejects non-number %s', val => {
    expect(validateEventLevel(val).ok).toBe(false);
  });
});

describe('validatePayload', () => {
  it('accepts plain object', () => {
    expect(validatePayload({ a: 1 }).ok).toBe(true);
  });

  it('rejects null', () => {
    expect(validatePayload(null).ok).toBe(false);
  });

  it('rejects array', () => {
    expect(validatePayload([1, 2]).ok).toBe(false);
  });

  it('rejects string', () => {
    expect(validatePayload('hello').ok).toBe(false);
  });

  it('rejects undefined', () => {
    expect(validatePayload(undefined).ok).toBe(false);
  });
});

describe('validateHeartbeat', () => {
  it('accepts valid heartbeat', () => {
    expect(validateHeartbeat(validHeartbeat()).ok).toBe(true);
  });

  it('rejects missing ts', () => {
    const hb = validHeartbeat();
    delete hb.ts;
    expect(validateHeartbeat(hb).ok).toBe(false);
  });

  it('rejects missing cpu', () => {
    const hb = validHeartbeat();
    delete hb.cpu;
    expect(validateHeartbeat(hb).ok).toBe(false);
  });

  it('rejects mem with < 2 elements', () => {
    const hb = validHeartbeat();
    hb.mem = [100];
    expect(validateHeartbeat(hb).ok).toBe(false);
  });

  it('rejects empty disk array', () => {
    const hb = validHeartbeat();
    hb.disk = [];
    expect(validateHeartbeat(hb).ok).toBe(false);
  });

  it('rejects load with < 3 elements', () => {
    const hb = validHeartbeat();
    hb.load = [1, 2];
    expect(validateHeartbeat(hb).ok).toBe(false);
  });

  it('rejects net with < 2 elements', () => {
    const hb = validHeartbeat();
    hb.net = [100];
    expect(validateHeartbeat(hb).ok).toBe(false);
  });

  it('rejects ports longer than 2000 chars', () => {
    const hb = validHeartbeat();
    hb.ports = 'x'.repeat(2001);
    expect(validateHeartbeat(hb).ok).toBe(false);
  });

  it('rejects users longer than 1000 chars', () => {
    const hb = validHeartbeat();
    hb.users = 'x'.repeat(1001);
    expect(validateHeartbeat(hb).ok).toBe(false);
  });

  it('rejects non-number procs', () => {
    const hb = validHeartbeat();
    hb.procs = 'many';
    expect(validateHeartbeat(hb).ok).toBe(false);
  });

  it('rejects procList longer than 50KB', () => {
    const hb = validHeartbeat();
    hb.procList = 'x'.repeat(50_001);
    expect(validateHeartbeat(hb).ok).toBe(false);
  });

  it('accepts procList within limit', () => {
    const hb = validHeartbeat();
    hb.procList = 'sshd|nginx|node';
    expect(validateHeartbeat(hb).ok).toBe(true);
  });

  it('rejects portList with more than 500 entries', () => {
    const hb = validHeartbeat();
    hb.portList = Array.from({ length: 501 }, (_, i) => ({ port: i, addr: '0.0.0.0', proc: 'test' }));
    expect(validateHeartbeat(hb).ok).toBe(false);
  });

  it('rejects mountList with more than 500 entries', () => {
    const hb = validHeartbeat();
    hb.mountList = Array.from({ length: 501 }, () => ({ src: '/dev/sda', target: '/mnt', fs: 'ext4' }));
    expect(validateHeartbeat(hb).ok).toBe(false);
  });

  it('rejects ttyList with more than 500 entries', () => {
    const hb = validHeartbeat();
    hb.ttyList = Array.from({ length: 501 }, () => ({ user: 'root', tty: 'pts/0', from: '::1', login: 0 }));
    expect(validateHeartbeat(hb).ok).toBe(false);
  });
});

describe('validateAlert', () => {
  it('accepts valid alert', () => {
    expect(validateAlert({ type: 'ssh_login', msg: 'root login' }).ok).toBe(true);
  });

  it('accepts shutdown type', () => {
    expect(validateAlert({ type: 'shutdown', msg: 'graceful stop' }).ok).toBe(true);
  });

  it('rejects missing type', () => {
    expect(validateAlert({ msg: 'no type' }).ok).toBe(false);
  });

  it('rejects missing msg', () => {
    expect(validateAlert({ type: 'ssh_login' }).ok).toBe(false);
  });

  it('rejects unknown event type', () => {
    const r = validateAlert({ type: 'unknown_event', msg: 'test' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Unknown event type');
  });

  it('rejects msg longer than 2000 chars', () => {
    const r = validateAlert({ type: 'ssh_login', msg: 'x'.repeat(2001) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Message too long');
  });
});

describe('isFeatureEnabled', () => {
  it('returns true when features undefined', () => {
    expect(isFeatureEnabled(undefined, 'ssh_login')).toBe(true);
  });

  it('returns true when feature not explicitly disabled', () => {
    expect(isFeatureEnabled({}, 'ssh_login')).toBe(true);
  });

  it('returns false when feature explicitly disabled', () => {
    expect(isFeatureEnabled({ authWatch: false }, 'ssh_login')).toBe(false);
  });

  it('returns true when feature explicitly enabled', () => {
    expect(isFeatureEnabled({ authWatch: true }, 'ssh_login')).toBe(true);
  });

  it('returns true for unknown event type', () => {
    expect(isFeatureEnabled({ authWatch: false }, 'unknown_type')).toBe(true);
  });
});

describe('isDuplicateAlert', () => {
  const now = 1000000;
  const window = 120000;

  it('detects duplicate within window', () => {
    const alerts = [alertEntry('ssh_login', 'root login', now - 60000)];
    expect(isDuplicateAlert(alerts, { type: 'ssh_login', msg: 'root login' }, now, window)).toBe(true);
  });

  it('allows same alert outside window', () => {
    const alerts = [alertEntry('ssh_login', 'root login', now - 200000)];
    expect(isDuplicateAlert(alerts, { type: 'ssh_login', msg: 'root login' }, now, window)).toBe(false);
  });

  it('allows different type within window', () => {
    const alerts = [alertEntry('ssh_fail', 'auth failed', now - 60000)];
    expect(isDuplicateAlert(alerts, { type: 'ssh_login', msg: 'auth failed' }, now, window)).toBe(false);
  });

  it('allows different msg within window', () => {
    const alerts = [alertEntry('ssh_login', 'root login', now - 60000)];
    expect(isDuplicateAlert(alerts, { type: 'ssh_login', msg: 'admin login' }, now, window)).toBe(false);
  });

  it('returns false for empty alerts', () => {
    expect(isDuplicateAlert([], { type: 'ssh_login', msg: 'test' }, now, window)).toBe(false);
  });
});

describe('isOnline', () => {
  it('returns true within timeout', () => {
    expect(isOnline(1000, 1050, 100)).toBe(true);
  });

  it('returns true at exact timeout boundary', () => {
    expect(isOnline(1000, 1100, 100)).toBe(true);
  });

  it('returns false beyond timeout', () => {
    expect(isOnline(1000, 1200, 100)).toBe(false);
  });

  it('returns false when lastSeen is 0', () => {
    expect(isOnline(0, 1000, 100)).toBe(false);
  });

  it('returns false when lastSeen is negative', () => {
    expect(isOnline(-1, 1000, 100)).toBe(false);
  });
});

describe('validateAlertThreshold', () => {
  it.each([1, 2, 3, 4])('accepts valid threshold %d', val => {
    const r = validateAlertThreshold(val);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(val);
  });

  it.each([0, 5, -1, 1.5, NaN])('rejects invalid value %d', val => {
    expect(validateAlertThreshold(val).ok).toBe(false);
  });
});

describe('validateHeartbeatTimeout', () => {
  it.each([30, 120, 3600])('accepts valid timeout %d', val => {
    const r = validateHeartbeatTimeout(val);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(val);
  });

  it.each([29, 3601, 0, -1, 60.5, NaN])('rejects invalid value %d', val => {
    expect(validateHeartbeatTimeout(val).ok).toBe(false);
  });
});

describe('validateNtfyEndpoint', () => {
  it('accepts valid http URL', () => {
    const r = validateNtfyEndpoint('http://ntfy.example.com/topic');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('http://ntfy.example.com/topic');
  });

  it('accepts valid https URL', () => {
    const r = validateNtfyEndpoint('https://ntfy.sh/mytopic');
    expect(r.ok).toBe(true);
  });

  it('accepts empty string', () => {
    const r = validateNtfyEndpoint('');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('');
  });

  it('trims whitespace', () => {
    const r = validateNtfyEndpoint('  https://ntfy.sh/topic  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('https://ntfy.sh/topic');
  });

  it('rejects non-http URL', () => {
    expect(validateNtfyEndpoint('ftp://example.com').ok).toBe(false);
  });

  it('rejects plain text', () => {
    expect(validateNtfyEndpoint('not a url').ok).toBe(false);
  });

  it('rejects non-string', () => {
    expect(validateNtfyEndpoint(123).ok).toBe(false);
  });
});

describe('validateNotificationChannel', () => {
  it('rejects null', () => {
    expect(validateNotificationChannel(null).ok).toBe(false);
  });

  it('rejects non-object', () => {
    expect(validateNotificationChannel('string').ok).toBe(false);
  });

  it('rejects missing enabled', () => {
    expect(validateNotificationChannel({ type: 'ntfy', endpoint: 'https://ntfy.sh/t' }).ok).toBe(false);
  });

  it('accepts valid ntfy channel', () => {
    const r = validateNotificationChannel({ type: 'ntfy', endpoint: 'https://ntfy.sh/topic', enabled: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ type: 'ntfy', endpoint: 'https://ntfy.sh/topic' });
  });

  it('rejects ntfy with invalid URL', () => {
    expect(validateNotificationChannel({ type: 'ntfy', endpoint: 'not-url', enabled: true }).ok).toBe(false);
  });

  it('accepts valid webhook channel', () => {
    const r = validateNotificationChannel({ type: 'webhook', url: 'https://example.com/hook', enabled: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ type: 'webhook', url: 'https://example.com/hook' });
  });

  it('accepts webhook with secret', () => {
    const r = validateNotificationChannel({
      type: 'webhook',
      url: 'https://example.com/hook',
      secret: 's3cret',
      enabled: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ type: 'webhook', secret: 's3cret' });
  });

  it('rejects webhook with non-string secret', () => {
    expect(
      validateNotificationChannel({ type: 'webhook', url: 'https://example.com/hook', secret: 123, enabled: true }).ok,
    ).toBe(false);
  });

  it('rejects webhook with invalid URL', () => {
    expect(validateNotificationChannel({ type: 'webhook', url: 'bad', enabled: true }).ok).toBe(false);
  });

  it('accepts valid slack channel', () => {
    const r = validateNotificationChannel({
      type: 'slack',
      webhookUrl: 'https://hooks.slack.com/services/T/B/x',
      enabled: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ type: 'slack' });
  });

  it('rejects slack with non-slack URL', () => {
    const r = validateNotificationChannel({ type: 'slack', webhookUrl: 'https://example.com/hook', enabled: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Must be a Slack webhook URL');
  });

  it('rejects slack with invalid URL', () => {
    expect(validateNotificationChannel({ type: 'slack', webhookUrl: 'bad', enabled: true }).ok).toBe(false);
  });

  it('accepts webpush channel', () => {
    const r = validateNotificationChannel({ type: 'webpush', enabled: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ type: 'webpush' });
  });

  it('rejects unknown channel type', () => {
    const r = validateNotificationChannel({ type: 'telegram', enabled: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Unknown channel type');
  });
});
