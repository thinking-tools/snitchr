import { describe, it, expect } from 'vitest';
import { str2uint8, toHex, fromHex, cshakeHash, hashPassword, createSession, isAuthed, compactToken, normalizeToken } from './crypto';

describe('str2uint8', () => {
  it('encodes ASCII string', () => {
    const result = str2uint8('abc');
    expect(result).toEqual(new Uint8Array([0x61, 0x62, 0x63]));
  });

  it('encodes empty string', () => {
    expect(str2uint8('')).toEqual(new Uint8Array([]));
  });

  it('encodes unicode', () => {
    const result = str2uint8('\u00e9');
    expect(result.length).toBeGreaterThan(1);
  });
});

describe('toHex', () => {
  it('converts bytes to hex', () => {
    expect(toHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe('deadbeef');
  });

  it('pads single-digit values', () => {
    expect(toHex(new Uint8Array([0x00, 0x01, 0x0f]))).toBe('00010f');
  });

  it('handles empty array', () => {
    expect(toHex(new Uint8Array([]))).toBe('');
  });
});

describe('fromHex', () => {
  it('converts hex to bytes', () => {
    expect(fromHex('deadbeef')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it('throws on odd-length hex', () => {
    expect(() => fromHex('abc')).toThrow('Invalid hex string');
  });

  it('throws on empty string', () => {
    expect(() => fromHex('')).toThrow('Invalid hex string');
  });

  it('roundtrips with toHex', () => {
    const original = new Uint8Array([0x00, 0x42, 0xff, 0x10, 0x99]);
    expect(fromHex(toHex(original))).toEqual(original);
  });
});

describe('cshakeHash', () => {
  it('produces deterministic output', () => {
    const salt = new Uint8Array([1, 2, 3]);
    const a = cshakeHash('hello', salt);
    const b = cshakeHash('hello', salt);
    expect(a).toBe(b);
  });

  it('produces different output for different inputs', () => {
    const salt = new Uint8Array([1, 2, 3]);
    const a = cshakeHash('hello', salt);
    const b = cshakeHash('world', salt);
    expect(a).not.toBe(b);
  });

  it('produces different output for different salts', () => {
    const a = cshakeHash('hello', new Uint8Array([1]));
    const b = cshakeHash('hello', new Uint8Array([2]));
    expect(a).not.toBe(b);
  });

  it('returns a hex string', () => {
    const result = cshakeHash('test', new Uint8Array([0]));
    expect(result).toMatch(/^[0-9a-f]+$/);
  });
});

describe('hashPassword', () => {
  it('produces deterministic output', async () => {
    const salt = new Uint8Array(32).fill(0x42);
    const a = await hashPassword('password123', salt);
    const b = await hashPassword('password123', salt);
    expect(a).toBe(b);
  });

  it('produces different output for different passwords', async () => {
    const salt = new Uint8Array(32).fill(0x42);
    const a = await hashPassword('password1', salt);
    const b = await hashPassword('password2', salt);
    expect(a).not.toBe(b);
  });

  it('produces different output for different salts', async () => {
    const a = await hashPassword('password', new Uint8Array(32).fill(0x01));
    const b = await hashPassword('password', new Uint8Array(32).fill(0x02));
    expect(a).not.toBe(b);
  });

  it('returns a hex string', async () => {
    const result = await hashPassword('test', new Uint8Array(32));
    expect(result).toMatch(/^[0-9a-f]+$/);
  });
});

describe('createSession + isAuthed', () => {
  it('creates a valid session that passes auth', async () => {
    const hash = await hashPassword('test', new Uint8Array(32));
    const session = await createSession(hash);
    expect(await isAuthed(session, hash)).toBe(true);
  });

  it('rejects undefined token', async () => {
    const hash = await hashPassword('test', new Uint8Array(32));
    expect(await isAuthed(undefined, hash)).toBe(false);
  });

  it('rejects tampered signature', async () => {
    const hash = await hashPassword('test', new Uint8Array(32));
    const session = await createSession(hash);
    const tampered = session.slice(0, -4) + 'ffff';
    expect(await isAuthed(tampered, hash)).toBe(false);
  });

  it('rejects token signed with wrong key', async () => {
    const hash1 = await hashPassword('password1', new Uint8Array(32));
    const hash2 = await hashPassword('password2', new Uint8Array(32));
    const session = await createSession(hash1);
    expect(await isAuthed(session, hash2)).toBe(false);
  });

  it('rejects malformed token without dot', async () => {
    const hash = await hashPassword('test', new Uint8Array(32));
    expect(await isAuthed('nodothere', hash)).toBe(false);
  });
});

describe('compactToken', () => {
  it('returns XXXXX-XXXXX format', () => {
    const token = compactToken();
    expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  });

  it('generates unique tokens', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => compactToken()));
    expect(tokens.size).toBe(50);
  });
});

describe('normalizeToken', () => {
  it('strips dashes and uppercases', () => {
    expect(normalizeToken('abcde-fghjk')).toBe('ABCDEFGHJK');
  });

  it('maps ambiguous chars O→0, I/L→1', () => {
    expect(normalizeToken('OILXX-XXXXX')).toBe('011XXXXXXX');
  });

  it('strips spaces', () => {
    expect(normalizeToken('ABC DE FGH JK')).toBe('ABCDEFGHJK');
  });

  it('normalized token matches stored form', () => {
    const token = compactToken();
    const stored = normalizeToken(token);
    expect(normalizeToken(token.toLowerCase())).toBe(stored);
    expect(normalizeToken(token.replace('-', ' '))).toBe(stored);
  });
});
