import type { R2BucketLike, Bindings } from './types';
import type { KVStore } from './kv';
import { app } from './app';
import { scheduled } from './scheduled';

export { app } from './app';

type CloudflareBindings = {
  SNITCHR_CONFIG: KVNamespace;
  SNITCHR_STORAGE?: R2BucketLike;
  ASSETS: Fetcher;
  VAPID_CONTACT?: string;
};

/** Wraps a Cloudflare KVNamespace behind the generic KVStore interface. */
class CloudflareKV implements KVStore {
  constructor(readonly kv: KVNamespace) {}

  get(key: string): Promise<string | null> {
    return this.kv.get(key, 'text');
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    await this.kv.put(key, value, opts?.expirationTtl ? { expirationTtl: opts.expirationTtl } : undefined);
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}

const wrapBindings = (raw: CloudflareBindings): Bindings => ({
  SNITCHR_CONFIG: new CloudflareKV(raw.SNITCHR_CONFIG),
  SNITCHR_STORAGE: raw.SNITCHR_STORAGE,
  ASSETS: { fetch: (url: URL | string) => raw.ASSETS.fetch(url) },
  VAPID_CONTACT: raw.VAPID_CONTACT,
});

export default {
  fetch: (req: Request, raw: CloudflareBindings, ctx: ExecutionContext) => app.fetch(req, wrapBindings(raw), ctx),
  scheduled: (event: ScheduledEvent, raw: CloudflareBindings, ctx: ExecutionContext) =>
    scheduled(event, wrapBindings(raw)),
};
