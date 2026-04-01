/**
 * Web Push (RFC 8291 + RFC 8188) via crypto.subtle.
 * Works on Cloudflare Workers, Node.js 18+, and Bun.
 *
 * Note: `as ArrayBuffer` casts are needed because @cloudflare/workers-types
 * defines BufferSource as Uint8Array<ArrayBuffer> which rejects ArrayBufferLike.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Base64url helpers ──────────────────────────────────────────────────

const b64url = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCodePoint(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

const b64urlDecode = (s: string): Uint8Array => {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.codePointAt(i)!;
  return bytes;
};

// ── VAPID key generation ───────────────────────────────────────────────

export type VapidKeys = { publicKey: string; privateKey: string };

/** Generate ECDSA P-256 VAPID key pair. Returns base64url-encoded keys. */
export const generateVapidKeys = async (): Promise<VapidKeys> => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const kp = pair as any;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  const jwk: any = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: b64url(pub), privateKey: jwk.d };
};

// ── VAPID JWT signing ──────────────────────────────────────────────────

const jsonB64url = (obj: Record<string, unknown>): string => b64url(new TextEncoder().encode(JSON.stringify(obj)));

/** Sign a VAPID JWT for the given push endpoint origin. */
export const signVapidJwt = async (
  endpoint: string,
  vapidPrivateKey: string,
  vapidPublicKey: string,
  sub: string,
): Promise<string> => {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;

  const header = jsonB64url({ typ: 'JWT', alg: 'ES256' });
  const payload = jsonB64url({ aud, exp, sub });
  const unsigned = `${header}.${payload}`;

  // Import the ECDSA private key from JWK
  const pubBytes = b64urlDecode(vapidPublicKey);
  const rawPub = await crypto.subtle.importKey(
    'raw',
    pubBytes.buffer as ArrayBuffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    [],
  );
  const pubJwk: any = await crypto.subtle.exportKey('jwk', rawPub);
  const privJwk = { ...pubJwk, d: vapidPrivateKey, key_ops: ['sign'] };
  const privKey = await crypto.subtle.importKey('jwk', privJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(sig)}`;
};

// ── Push payload encryption (RFC 8291 + RFC 8188 aes128gcm) ───────────

const concat = (...arrays: Uint8Array[]): Uint8Array => {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
};

const hkdfDerive = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey('raw', ikm.buffer as ArrayBuffer, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt.buffer as ArrayBuffer, info: info.buffer as ArrayBuffer },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
};

const RECORD_SIZE = 4096;

export type PushSubscriptionRecord = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/**
 * Encrypt a push message payload per RFC 8291 (aes128gcm).
 * Returns the full encrypted body including the content-coding header.
 */
export const encryptPayload = async (
  plaintext: Uint8Array,
  subscription: PushSubscriptionRecord,
): Promise<{ body: Uint8Array; serverPublicKey: Uint8Array; salt: Uint8Array }> => {
  const uaPublic = b64urlDecode(subscription.keys.p256dh);
  const authSecret = b64urlDecode(subscription.keys.auth);

  // Generate ephemeral ECDH key pair
  const serverKeys: any = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPub = new Uint8Array((await crypto.subtle.exportKey('raw', serverKeys.publicKey)) as ArrayBuffer);

  // Import subscriber public key for ECDH
  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic.buffer as ArrayBuffer,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  // ECDH shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey } as any,
    serverKeys.privateKey,
    256,
  );
  const sharedSecret = new Uint8Array(sharedBits);

  // HKDF #1: IKM from shared secret + auth
  const enc = new TextEncoder();
  const infoIkm = concat(enc.encode('WebPush: info\0'), uaPublic, serverPub);
  const ikm = await hkdfDerive(authSecret, sharedSecret, infoIkm, 32);

  // Random salt for this message
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF #2: CEK (16 bytes) and nonce (12 bytes)
  const cek = await hkdfDerive(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfDerive(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Pad plaintext with 0x02 delimiter (final record)
  const padded = concat(plaintext, new Uint8Array([2]));

  // AES-128-GCM encrypt
  const aesKey = await crypto.subtle.importKey('raw', cek.buffer as ArrayBuffer, 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce.buffer as ArrayBuffer }, aesKey, padded.buffer as ArrayBuffer),
  );

  // Build aes128gcm body: salt(16) || rs(4, BE) || idlen(1) || keyid(65) || ciphertext
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE, false);
  return { body: concat(salt, rs, new Uint8Array([65]), serverPub, encrypted), serverPublicKey: serverPub, salt };
};

// ── Send push notification ─────────────────────────────────────────────

export type WebPushResult = { endpoint: string; status: number; ok: boolean };

/** Send an encrypted push message to a single subscription. */
export const sendWebPush = async (
  subscription: PushSubscriptionRecord,
  payload: string,
  vapidKeys: VapidKeys,
  sub: string,
): Promise<WebPushResult> => {
  const plaintext = new TextEncoder().encode(payload);
  const { body } = await encryptPayload(plaintext, subscription);
  const jwt = await signVapidJwt(subscription.endpoint, vapidKeys.privateKey, vapidKeys.publicKey, sub);

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: `vapid t=${jwt},k=${vapidKeys.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'normal',
    },
    body,
  });

  return { endpoint: subscription.endpoint, status: res.status, ok: res.ok };
};

// Re-export for tests
export { b64url, b64urlDecode };
