import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryKV, FileKV } from './kv';

describe('InMemoryKV', () => {
  let kv: InMemoryKV;

  beforeEach(() => {
    kv = new InMemoryKV();
  });

  it('returns null for missing key', async () => {
    expect(await kv.get('missing')).toBeNull();
  });

  it('stores and retrieves a value', async () => {
    await kv.put('key', 'value');
    expect(await kv.get('key')).toBe('value');
  });

  it('overwrites existing value', async () => {
    await kv.put('key', 'v1');
    await kv.put('key', 'v2');
    expect(await kv.get('key')).toBe('v2');
  });

  it('deletes a key', async () => {
    await kv.put('key', 'value');
    await kv.delete('key');
    expect(await kv.get('key')).toBeNull();
  });

  it('delete is idempotent for missing key', async () => {
    await kv.delete('missing');
    expect(await kv.get('missing')).toBeNull();
  });

  it('stores and retrieves JSON via string serialization', async () => {
    const data = { name: 'test', count: 42 };
    await kv.put('config', JSON.stringify(data));
    const raw = await kv.get('config');
    expect(JSON.parse(raw!)).toEqual(data);
  });

  it('expires entries after TTL', async () => {
    vi.useFakeTimers();
    try {
      await kv.put('temp', 'value', { expirationTtl: 60 });
      expect(await kv.get('temp')).toBe('value');

      vi.advanceTimersByTime(61_000);
      expect(await kv.get('temp')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps entry before TTL expires', async () => {
    vi.useFakeTimers();
    try {
      await kv.put('temp', 'value', { expirationTtl: 60 });
      vi.advanceTimersByTime(30_000);
      expect(await kv.get('temp')).toBe('value');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears all entries', async () => {
    await kv.put('a', '1');
    await kv.put('b', '2');
    kv.clear();
    expect(kv.size).toBe(0);
    expect(await kv.get('a')).toBeNull();
  });

  it('reports size', async () => {
    expect(kv.size).toBe(0);
    await kv.put('a', '1');
    expect(kv.size).toBe(1);
    await kv.put('b', '2');
    expect(kv.size).toBe(2);
  });
});

describe('FileKV', () => {
  let kv: FileKV;
  let dir: string;

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    dir = await mkdtemp(join(tmpdir(), 'snitchr-kv-test-'));
    kv = new FileKV(dir);
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null for missing key', async () => {
    expect(await kv.get('missing')).toBeNull();
  });

  it('stores and retrieves a value', async () => {
    await kv.put('key', 'value');
    expect(await kv.get('key')).toBe('value');
  });

  it('overwrites existing value', async () => {
    await kv.put('key', 'v1');
    await kv.put('key', 'v2');
    expect(await kv.get('key')).toBe('v2');
  });

  it('deletes a key', async () => {
    await kv.put('key', 'value');
    await kv.delete('key');
    expect(await kv.get('key')).toBeNull();
  });

  it('delete is idempotent for missing key', async () => {
    await kv.delete('missing');
    expect(await kv.get('missing')).toBeNull();
  });

  it('stores and retrieves JSON via string serialization', async () => {
    const data = { name: 'test', count: 42 };
    await kv.put('config', JSON.stringify(data));
    const raw = await kv.get('config');
    expect(JSON.parse(raw!)).toEqual(data);
  });

  it('expires entries after TTL', async () => {
    vi.useFakeTimers();
    try {
      await kv.put('temp', 'value', { expirationTtl: 60 });
      expect(await kv.get('temp')).toBe('value');

      vi.advanceTimersByTime(61_000);
      expect(await kv.get('temp')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps entry before TTL expires', async () => {
    vi.useFakeTimers();
    try {
      await kv.put('temp', 'value', { expirationTtl: 60 });
      vi.advanceTimersByTime(30_000);
      expect(await kv.get('temp')).toBe('value');
    } finally {
      vi.useRealTimers();
    }
  });
});
