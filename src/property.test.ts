import { test } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import fc from 'fast-check';
import { toHex, fromHex, normalizeToken, cshakeHash, hashPassword } from './crypto';
import {
  validateEventLevel,
  validateAlertThreshold,
  validateHeartbeatTimeout,
  validateNtfyEndpoint,
  isOnline,
} from './validators';
import { diskSlope, predictDiskFill, appendDiskSample, MAX_DISK_SAMPLES } from './disk-velocity';
import type { DiskSample } from './types';

// ── Crypto ────────────────────────────────────────────────────────────

describe('toHex / fromHex', () => {
  test.prop([fc.uint8Array({ minLength: 1, maxLength: 512 })])('roundtrips for any non-empty byte sequence', bytes => {
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });

  test('empty Uint8Array produces empty hex and fromHex rejects it', () => {
    expect(toHex(new Uint8Array(0))).toBe('');
    expect(() => fromHex('')).toThrow('Invalid hex string');
  });

  test.prop([fc.uint8Array({ minLength: 1, maxLength: 256 })])('produces lowercase hex of correct length', bytes => {
    const hex = toHex(bytes);
    expect(hex).toMatch(/^[0-9a-f]*$/);
    expect(hex.length).toBe(bytes.length * 2);
  });
});

describe('normalizeToken', () => {
  test.prop([fc.string({ minLength: 0, maxLength: 50 })])('is idempotent', raw => {
    const once = normalizeToken(raw);
    expect(normalizeToken(once)).toBe(once);
  });

  test.prop([fc.string({ minLength: 0, maxLength: 50 })])('output has no dashes, spaces, O, I, or L', raw => {
    const norm = normalizeToken(raw);
    expect(norm).not.toMatch(/[-\sOIL]/);
  });

  test.prop([fc.string({ minLength: 1, maxLength: 20 })])(
    'case-insensitive: upper and lower produce same result',
    raw => {
      expect(normalizeToken(raw.toLowerCase())).toBe(normalizeToken(raw.toUpperCase()));
    },
  );
});

describe('cshakeHash', () => {
  test.prop([fc.string({ minLength: 0, maxLength: 100 }), fc.uint8Array({ minLength: 1, maxLength: 64 })])(
    'always returns 256-char hex string',
    (data, salt) => {
      const hash = cshakeHash(data, salt);
      expect(hash).toMatch(/^[0-9a-f]{256}$/);
    },
  );

  test.prop([fc.string({ minLength: 1, maxLength: 100 }), fc.uint8Array({ minLength: 1, maxLength: 32 })])(
    'deterministic for same inputs',
    (data, salt) => {
      expect(cshakeHash(data, salt)).toBe(cshakeHash(data, salt));
    },
  );
});

describe('hashPassword', () => {
  test.prop(
    [fc.string({ minLength: 1, maxLength: 10 }), fc.uint8Array({ minLength: 32, maxLength: 32 })],
    { numRuns: 5 },
  )('returns 64-char hex (256-bit) and is deterministic', async (password, salt) => {
    const hash = await hashPassword(password, salt);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashPassword(password, salt)).toBe(hash);
  });
});

// ── Validators ────────────────────────────────────────────────────────

describe('validateEventLevel', () => {
  test.prop([fc.integer({ min: 0, max: 5 })])('accepts valid levels 0-5', level => {
    const r = validateEventLevel(level);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(level);
  });

  test.prop([fc.oneof(fc.integer({ min: 6 }), fc.integer({ max: -1 }), fc.double())])(
    'rejects out-of-range or non-integer',
    v => {
      if (Number.isInteger(v) && v >= 0 && v <= 5) return; // skip valid values
      expect(validateEventLevel(v).ok).toBe(false);
    },
  );
});

describe('validateAlertThreshold', () => {
  test.prop([fc.integer({ min: 1, max: 4 })])('accepts 1-4', v => {
    const r = validateAlertThreshold(v);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(v);
  });

  test.prop([fc.oneof(fc.integer({ min: 5 }), fc.integer({ max: 0 }))])('rejects outside 1-4', v => {
    expect(validateAlertThreshold(v).ok).toBe(false);
  });
});

describe('validateHeartbeatTimeout', () => {
  test.prop([fc.integer({ min: 30, max: 3600 })])('accepts 30-3600', v => {
    const r = validateHeartbeatTimeout(v);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(v);
  });

  test.prop([fc.oneof(fc.integer({ min: 3601 }), fc.integer({ max: 29 }))])('rejects outside 30-3600', v => {
    expect(validateHeartbeatTimeout(v).ok).toBe(false);
  });
});

describe('validateNtfyEndpoint', () => {
  test.prop([fc.webUrl()])('accepts valid HTTP URLs', url => {
    expect(validateNtfyEndpoint(url).ok).toBe(true);
  });

  test.prop([fc.string().filter(s => !!s.trim() && !/^https?:\/\/.+/.test(s.trim()))])(
    'rejects non-empty non-HTTP strings',
    s => {
      expect(validateNtfyEndpoint(s).ok).toBe(false);
    },
  );
});

describe('isOnline', () => {
  test.prop([fc.integer({ min: 1 }), fc.integer({ min: 1 })])(
    'online iff within timeout window',
    (lastSeen, timeoutMs) => {
      const now = lastSeen + timeoutMs;
      expect(isOnline(lastSeen, now, timeoutMs)).toBe(true);
      expect(isOnline(lastSeen, now + 1, timeoutMs)).toBe(false);
    },
  );

  test.prop([fc.integer({ max: 0 }), fc.integer(), fc.integer({ min: 1 })])(
    'always offline if lastSeen <= 0',
    (lastSeen, now, timeout) => {
      expect(isOnline(lastSeen, now, timeout)).toBe(false);
    },
  );
});

// ── Disk Velocity ─────────────────────────────────────────────────────

describe('diskSlope', () => {
  test.prop([fc.array(fc.tuple(fc.integer(), fc.integer({ min: 0, max: 100 })), { minLength: 0, maxLength: 2 })])(
    'returns null with fewer than 3 samples',
    samples => {
      expect(diskSlope(samples as DiskSample[])).toBeNull();
    },
  );

  test.prop([
    fc.integer({ min: 1000, max: 1_000_000 }),
    fc.integer({ min: 0, max: 100 }),
    fc.integer({ min: 3, max: 50 }),
    fc.integer({ min: 1000, max: 60_000 }),
  ])('constant value yields slope ≈ 0', (t0, pct, count, interval) => {
    const samples: DiskSample[] = Array.from({ length: count }, (_, i) => [t0 + i * interval, pct]);
    const slope = diskSlope(samples);
    expect(slope).not.toBeNull();
    expect(Math.abs(slope!)).toBeLessThan(1e-6);
  });

  test.prop([
    fc.integer({ min: 1000, max: 1_000_000 }),
    fc.integer({ min: 0, max: 50 }),
    fc.integer({ min: 1, max: 10 }),
    fc.integer({ min: 5000, max: 60_000 }),
  ])('strictly increasing values yield positive slope', (t0, startPct, step, interval) => {
    const samples: DiskSample[] = Array.from({ length: 5 }, (_, i) => [t0 + i * interval, startPct + i * step]);
    const slope = diskSlope(samples);
    expect(slope).not.toBeNull();
    expect(slope!).toBeGreaterThan(0);
  });
});

describe('predictDiskFill', () => {
  test.prop([fc.array(fc.tuple(fc.integer(), fc.integer({ min: 0, max: 100 })), { minLength: 0, maxLength: 2 })])(
    'insufficient samples → stable with null hours',
    samples => {
      const pred = predictDiskFill(samples as DiskSample[]);
      expect(pred.trend).toBe('stable');
      expect(pred.hoursToThreshold).toBeNull();
    },
  );

  test('filling trend returns non-null hoursToThreshold', () => {
    const now = Date.now();
    const samples: DiskSample[] = [
      [now - 3_600_000, 50],
      [now - 1_800_000, 60],
      [now, 70],
    ];
    const pred = predictDiskFill(samples);
    expect(pred.trend).toBe('filling');
    expect(pred.hoursToThreshold).not.toBeNull();
    expect(pred.hoursToThreshold!).toBeGreaterThan(0);
  });
});

describe('appendDiskSample', () => {
  test.prop([
    fc.array(fc.tuple(fc.integer(), fc.integer({ min: 0, max: 100 })), { minLength: 0, maxLength: MAX_DISK_SAMPLES }),
    fc.integer(),
    fc.integer({ min: 0, max: 100 }),
  ])('length never exceeds MAX_DISK_SAMPLES and new sample is last', (existing, ts, pct) => {
    const result = appendDiskSample([...existing] as DiskSample[], ts, pct);
    expect(result.length).toBeLessThanOrEqual(MAX_DISK_SAMPLES);
    expect(result.at(-1)).toEqual([ts, pct]);
  });

  test.prop([fc.integer(), fc.integer({ min: 0, max: 100 })])(
    'undefined input creates single-element array',
    (ts, pct) => {
      const result = appendDiskSample(undefined, ts, pct);
      expect(result).toEqual([[ts, pct]]);
    },
  );
});
