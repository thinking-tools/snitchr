import { createStorage, type Storage } from './storage';
import { toHex, randomBytes } from './crypto';
import { layout } from './layout';
import type { KVStore } from './kv';
import type { Bindings, Config, R2BucketLike } from './types';

export const getConfig = async (kv: KVStore): Promise<Config | null> => {
  const text = await kv.get('config');
  if (!text) return null;
  const raw = JSON.parse(text) as Config & { machineIdList?: string[] };
  if (!raw.storageMode) raw.storageMode = 's3';
  // auto-migrate legacy machineIdList → machineList
  if (!raw.machineList) {
    raw.machineList = {};
    if (raw.machineIdList) {
      for (const id of raw.machineIdList) raw.machineList[id] = { secret: toHex(randomBytes(24)), registeredAt: 0 };
      delete (raw as Record<string, unknown>).machineIdList;
    }
  }
  // auto-migrate ntfyEndpoint → notifications
  if (raw.ntfyEndpoint && !raw.notifications) {
    raw.notifications = { ntfy: { type: 'ntfy', endpoint: raw.ntfyEndpoint, enabled: true } };
    delete raw.ntfyEndpoint;
  }
  return raw as Config;
};

export const storageFromConfig = (config: Config, r2?: R2BucketLike): Storage | null => {
  if (config.storageMode === 'memory') return createStorage({ mode: 'memory' });
  if (config.storageMode === 'filesystem') {
    if (!config.dataDir) return null;
    return createStorage({ mode: 'filesystem', dir: config.dataDir });
  }
  if (config.storageMode === 'r2') {
    if (!r2) return null;
    return createStorage({ mode: 'r2', r2 });
  }
  if (!config.s3Endpoint || !config.s3AccessKey || !config.s3SecretKey) return null;
  return createStorage({
    mode: 's3',
    endpoint: config.s3Endpoint,
    accessKey: config.s3AccessKey,
    secretKey: config.s3SecretKey,
    region: config.s3Region ?? 'auto',
  });
};

const TITLES: Record<string, string> = {
  '/setup.html': 'Setup',
  '/login.html': 'Login',
  '/dashboard.html': 'Dashboard',
  '/machine.html': 'Machine',
  '/settings.html': 'Settings',
};

export const serveAsset = async (env: Bindings, url: string, path: string) => {
  const res = await env.ASSETS.fetch(new URL(path, url));
  const fragment = await res.text();
  const html = layout(TITLES[path] ?? 'snitchr', fragment);
  return new Response(html, {
    status: res.status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
};
