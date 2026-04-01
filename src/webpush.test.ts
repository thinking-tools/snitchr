import { describe, it, expect } from 'vitest';
import { generateVapidKeys, signVapidJwt, encryptPayload, b64url, b64urlDecode } from './webpush';

describe('webpush', () => {
  describe('b64url', () => {
    it('encodes and decodes round-trip', () => {
      const data = new Uint8Array([0, 1, 2, 255, 128, 64]);
      const encoded = b64url(data);
      expect(encoded).not.toContain('+');
      expect(encoded).not.toContain('/');
      expect(encoded).not.toContain('=');
      const decoded = b64urlDecode(encoded);
      expect(decoded).toEqual(data);
    });

    it('handles empty input', () => {
      expect(b64url(new Uint8Array([]))).toBe('');
      expect(b64urlDecode('')).toEqual(new Uint8Array([]));
    });
  });

  describe('generateVapidKeys', () => {
    it('generates valid P-256 key pair', async () => {
      const keys = await generateVapidKeys();
      expect(keys.publicKey).toBeTruthy();
      expect(keys.privateKey).toBeTruthy();

      // Public key should be 65 bytes (uncompressed P-256 point)
      const pubBytes = b64urlDecode(keys.publicKey);
      expect(pubBytes.length).toBe(65);
      expect(pubBytes[0]).toBe(0x04); // uncompressed point prefix
    });

    it('generates unique keys each time', async () => {
      const a = await generateVapidKeys();
      const b = await generateVapidKeys();
      expect(a.publicKey).not.toBe(b.publicKey);
    });
  });

  describe('signVapidJwt', () => {
    it('produces a valid 3-part JWT', async () => {
      const keys = await generateVapidKeys();
      const jwt = await signVapidJwt(
        'https://fcm.googleapis.com/fcm/send/abc123',
        keys.privateKey,
        keys.publicKey,
        'mailto:test@example.com',
      );

      const parts = jwt.split('.');
      expect(parts).toHaveLength(3);

      // Decode header
      const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
      expect(header.typ).toBe('JWT');
      expect(header.alg).toBe('ES256');

      // Decode payload
      const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
      expect(payload.aud).toBe('https://fcm.googleapis.com');
      expect(payload.sub).toBe('mailto:test@example.com');
      expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

      // Signature should be 64 bytes (ES256 r||s)
      const sig = b64urlDecode(parts[2]);
      expect(sig.length).toBe(64);
    });
  });

  describe('encryptPayload', () => {
    it('produces correctly structured aes128gcm body', async () => {
      // Generate a fake subscriber key pair for testing
      const subKeys: any = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const subPub = new Uint8Array((await crypto.subtle.exportKey('raw', subKeys.publicKey)) as ArrayBuffer);
      const auth = crypto.getRandomValues(new Uint8Array(16));

      const subscription = {
        endpoint: 'https://example.com/push',
        keys: { p256dh: b64url(subPub), auth: b64url(auth) },
      };

      const plaintext = new TextEncoder().encode('Hello Web Push');
      const result = await encryptPayload(plaintext, subscription);

      // Body structure: salt(16) + rs(4) + idlen(1) + keyid(65) + ciphertext
      expect(result.body.length).toBeGreaterThan(86); // 16+4+1+65 = 86 header bytes
      expect(result.serverPublicKey.length).toBe(65);
      expect(result.salt.length).toBe(16);

      // Verify salt is at the beginning of the body
      expect(result.body.slice(0, 16)).toEqual(result.salt);

      // Verify record size is 4096 (big-endian)
      const rs = new DataView(result.body.buffer, result.body.byteOffset + 16, 4).getUint32(0, false);
      expect(rs).toBe(4096);

      // Verify idlen is 65
      expect(result.body[20]).toBe(65);

      // Verify server public key is in the body at offset 21
      expect(result.body.slice(21, 86)).toEqual(result.serverPublicKey);
    });
  });
});
