import type { Context, Next } from 'hono';
import type { Bindings } from './types';

type RateLimitOpts = {
  /** Time window in ms (must be >= 60 000 for KV TTL compat). */
  windowMs: number;
  /** Max requests per window per IP. */
  limit: number;
  /** KV key prefix (e.g. 'login'). */
  prefix: string;
};

type RateLimitRecord = { c: number; r: number };

/**
 * Per-IP rate limiter backed by KVStore.
 * Uses `cf-connecting-ip` for client identification, falls back to `x-forwarded-for`.
 */
export const rateLimit = ({ windowMs, limit, prefix }: RateLimitOpts) =>
  async (c: Context<{ Bindings: Bindings }>, next: Next) => {
    const ip = c.req.header('cf-connecting-ip')
      ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      ?? 'unknown';
    const key = `rl:${prefix}:${ip}`;
    const kv = c.env.SNITCHR_CONFIG;
    const now = Date.now();

    const raw = await kv.get(key);
    let rec: RateLimitRecord = { c: 0, r: now + windowMs };
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as RateLimitRecord;
        rec = now < parsed.r ? parsed : { c: 0, r: now + windowMs };
      } catch { /* corrupted — start fresh */ }
    }

    rec.c++;
    const ttl = Math.max(60, Math.ceil((rec.r - now) / 1000));
    await kv.put(key, JSON.stringify(rec), { expirationTtl: ttl });

    if (rec.c > limit) {
      c.header('Retry-After', String(ttl));
      return c.json({ error: 'Too many requests, please try again later' }, 429);
    }

    await next();
  };
