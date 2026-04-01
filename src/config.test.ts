import { describe, it, expect, beforeEach } from 'vitest';
import { getConfig, storageFromConfig } from './config';
import { InMemoryKV } from './kv';
import type { Config } from './types';

const baseConfig = (): Config => ({
  passwordHash: 'abc123',
  passwordSalt: 'def456',
  storageMode: 's3',
  userId: 'user-1',
  machineList: {},
  s3Endpoint: 'https://s3.example.com',
  s3AccessKey: 'access',
  s3SecretKey: 'secret',
});

describe('getConfig', () => {
  let kv: InMemoryKV;

  beforeEach(() => {
    kv = new InMemoryKV();
  });

  it('returns null when no config exists', async () => {
    expect(await getConfig(kv)).toBeNull();
  });

  it('returns config when stored', async () => {
    const config = baseConfig();
    await kv.put('config', JSON.stringify(config));
    const result = await getConfig(kv);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-1');
  });

  it('defaults storageMode to s3 if missing', async () => {
    const config = baseConfig();
    delete (config as Record<string, unknown>).storageMode;
    await kv.put('config', JSON.stringify(config));
    const result = await getConfig(kv);
    expect(result!.storageMode).toBe('s3');
  });

  it('migrates legacy machineIdList to machineList', async () => {
    const legacy = {
      ...baseConfig(),
      machineList: undefined,
      machineIdList: ['machine-1', 'machine-2'],
    };
    delete (legacy as Record<string, unknown>).machineList;
    await kv.put('config', JSON.stringify(legacy));

    const result = await getConfig(kv);
    expect(result!.machineList).toBeDefined();
    expect(Object.keys(result!.machineList)).toHaveLength(2);
    expect(result!.machineList['machine-1']).toBeDefined();
    expect(result!.machineList['machine-1'].registeredAt).toBe(0);
    expect(result!.machineList['machine-1'].secret).toMatch(/^[0-9a-f]+$/);
  });

  it('initializes empty machineList if missing', async () => {
    const config = baseConfig();
    delete (config as Record<string, unknown>).machineList;
    await kv.put('config', JSON.stringify(config));
    const result = await getConfig(kv);
    expect(result!.machineList).toEqual({});
  });

  it('migrates legacy ntfyEndpoint to notifications', async () => {
    const config = { ...baseConfig(), ntfyEndpoint: 'https://ntfy.sh/test' } as Record<string, unknown>;
    await kv.put('config', JSON.stringify(config));
    const result = await getConfig(kv);
    expect(result!.notifications).toBeDefined();
    expect(result!.notifications!.ntfy).toMatchObject({ type: 'ntfy', endpoint: 'https://ntfy.sh/test', enabled: true });
    expect(result!.ntfyEndpoint).toBeUndefined();
  });
});

describe('storageFromConfig', () => {
  it('returns null for r2 mode without bucket', () => {
    const config = { ...baseConfig(), storageMode: 'r2' as const };
    expect(storageFromConfig(config)).toBeNull();
  });

  it('returns null for s3 mode without endpoint', () => {
    const config = baseConfig();
    delete config.s3Endpoint;
    expect(storageFromConfig(config)).toBeNull();
  });

  it('returns null for s3 mode without access key', () => {
    const config = baseConfig();
    delete config.s3AccessKey;
    expect(storageFromConfig(config)).toBeNull();
  });

  it('returns null for s3 mode without secret key', () => {
    const config = baseConfig();
    delete config.s3SecretKey;
    expect(storageFromConfig(config)).toBeNull();
  });

  it('returns Storage for valid s3 config', () => {
    const storage = storageFromConfig(baseConfig());
    expect(storage).not.toBeNull();
    expect(storage!.put).toBeTypeOf('function');
    expect(storage!.get).toBeTypeOf('function');
  });

  it('returns Storage for memory mode', () => {
    const config = { ...baseConfig(), storageMode: 'memory' as const };
    const storage = storageFromConfig(config);
    expect(storage).not.toBeNull();
  });

  it('returns Storage for filesystem mode with dataDir', () => {
    const config = { ...baseConfig(), storageMode: 'filesystem' as const, dataDir: '/tmp/test' };
    const storage = storageFromConfig(config);
    expect(storage).not.toBeNull();
  });

  it('returns null for filesystem mode without dataDir', () => {
    const config = { ...baseConfig(), storageMode: 'filesystem' as const };
    expect(storageFromConfig(config)).toBeNull();
  });

  it('returns Storage for r2 mode with bucket', () => {
    const mockR2 = { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ objects: [], truncated: false, cursor: '' }) };
    const config = { ...baseConfig(), storageMode: 'r2' as const };
    const storage = storageFromConfig(config, mockR2);
    expect(storage).not.toBeNull();
  });
});
