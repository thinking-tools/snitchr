import { cshake256 } from '@noble/hashes/sha3-addons.js';

export const str2uint8 = (str: string): Uint8Array => new TextEncoder().encode(str);

export const toHex = (arr: Uint8Array): string => [...arr].map(b => b.toString(16).padStart(2, '0')).join('');

export const fromHex = (hex: string): Uint8Array => {
  if (!hex || hex.length % 2 !== 0) throw new Error('Invalid hex string');
  const a = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < a.length; i++) {
    const hi = hex.codePointAt(i * 2)!;
    const lo = hex.codePointAt(i * 2 + 1)!;
    a[i] = (((hi & 0xf) + (hi >> 6) * 9) << 4) | ((lo & 0xf) + (lo >> 6) * 9);
  }
  return a;
};

export const randomBytes = (len: number): Uint8Array => {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return arr;
};

/** Crockford Base32 alphabet — case-insensitive, no ambiguous chars (0/O/I/L excluded). */
const CB32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Generate a compact, human-typeable token (Crockford Base32, 48-bit entropy → 10 chars). */
export const compactToken = (): string => {
  const bytes = randomBytes(6);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  const chars: string[] = [];
  for (let i = 0; i < 10; i++) {
    chars.unshift(CB32[Number(bits & 31n)]);
    bits >>= 5n;
  }
  return chars.slice(0, 5).join('') + '-' + chars.slice(5).join('');
};

/** Normalize a user-supplied Crockford Base32 token for comparison. */
export const normalizeToken = (raw: string): string =>
  raw
    .toUpperCase()
    .replaceAll('-', '')
    .replaceAll(' ', '')
    .replaceAll('O', '0')
    .replaceAll('I', '1')
    .replaceAll('L', '1');

const MAGIC = str2uint8('snitchr_sh_salt_v1');
const SHAKE_LEN = 128;

/** CSHAKE256-based hash — retained for non-password use cases. */
export const cshakeHash = (data: string, salt: Uint8Array): string =>
  toHex(
    cshake256(str2uint8(data), {
      personalization: new Uint8Array([...MAGIC, ...salt]),
      dkLen: SHAKE_LEN,
    }),
  );

/**
 * Timing-safe string comparison via HMAC sign + verify.
 * Uses an ephemeral random key so even non-constant-time verify leaks nothing about the inputs.
 * Works on all runtimes (CF Workers, Node.js, Bun) — pure Web Crypto API.
 */
export const timingSafeEqual = async (a: string, b: string): Promise<boolean> => {
  const enc = new TextEncoder();
  const key = (await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])) as CryptoKey;
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(a));
  return crypto.subtle.verify('HMAC', key, sig, enc.encode(b));
};

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_BITS = 256;

/** PBKDF2-HMAC-SHA-256 password hash (100 000 iterations, 256-bit output). */
export const hashPassword = async (password: string, salt: Uint8Array): Promise<string> => {
  const keyMaterial = await crypto.subtle.importKey('raw', str2uint8(password).buffer as ArrayBuffer, 'PBKDF2', false, [
    'deriveBits',
  ]);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt.buffer as ArrayBuffer, iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    PBKDF2_KEY_BITS,
  );
  return toHex(new Uint8Array(derived));
};

const hmacSign = async (payload: string, secret: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return toHex(new Uint8Array(sig));
};

export const SESSION_TTL = 24 * 60 * 60;

export const COOKIE_OPTS = {
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'Strict' as const,
  maxAge: SESSION_TTL,
};

export const createSession = async (passwordHash: string): Promise<string> => {
  const expires = String(Date.now() + SESSION_TTL * 1000);
  const sig = await hmacSign(expires, passwordHash);
  return `${expires}.${sig}`;
};

const verifySession = async (token: string, passwordHash: string): Promise<boolean> => {
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const expires = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (Date.now() > Number(expires)) return false;
  const expected = await hmacSign(expires, passwordHash);
  return timingSafeEqual(sig, expected);
};

export const isAuthed = (token: string | undefined, passwordHash: string): Promise<boolean> =>
  token ? verifySession(token, passwordHash) : Promise.resolve(false);
