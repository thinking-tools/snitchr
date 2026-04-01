import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryStorage, createStorage, resetMemoryStorage, type Storage } from './storage';
import type { R2BucketLike } from './types';

// ── Helper ──

const streamFrom = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode(text));
      ctrl.close();
    },
  });

const multiChunkStream = (chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(ctrl) {
      for (const chunk of chunks) ctrl.enqueue(new TextEncoder().encode(chunk));
      ctrl.close();
    },
  });

// ── InMemoryStorage ──

describe('InMemoryStorage', () => {
  let store: InMemoryStorage;

  beforeEach(() => {
    store = new InMemoryStorage();
  });

  // put / get

  it('stores and retrieves a string', async () => {
    await store.put('k', 'hello');
    expect(await store.get('k')).toBe('hello');
  });

  it('stores Uint8Array and retrieves as string', async () => {
    await store.put('k', new TextEncoder().encode('bytes'));
    expect(await store.get('k')).toBe('bytes');
  });

  it('stores ReadableStream and retrieves as string', async () => {
    await store.put('k', streamFrom('streamed'));
    expect(await store.get('k')).toBe('streamed');
  });

  it('stores multi-chunk ReadableStream', async () => {
    await store.put('k', multiChunkStream(['hello', ' ', 'world']));
    expect(await store.get('k')).toBe('hello world');
  });

  it('returns null for missing key', async () => {
    expect(await store.get('missing')).toBeNull();
  });

  it('overwrites existing key', async () => {
    await store.put('k', 'v1');
    await store.put('k', 'v2');
    expect(await store.get('k')).toBe('v2');
  });

  // getJSON

  it('parses stored JSON', async () => {
    await store.put('k', JSON.stringify({ a: 1 }));
    expect(await store.getJSON('k')).toEqual({ a: 1 });
  });

  it('returns null for missing key in getJSON', async () => {
    expect(await store.getJSON('missing')).toBeNull();
  });

  // list

  it('lists keys matching prefix', async () => {
    await store.put('a/1', 'x');
    await store.put('a/2', 'y');
    await store.put('b/1', 'z');
    const result = await store.list('a/');
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map(e => e.key)).toEqual(['a/1', 'a/2']);
    expect(result.truncated).toBe(false);
  });

  it('returns empty for unmatched prefix', async () => {
    await store.put('a/1', 'x');
    const result = await store.list('z/');
    expect(result.entries).toHaveLength(0);
  });

  it('paginates with limit', async () => {
    await store.put('k/a', '1');
    await store.put('k/b', '2');
    await store.put('k/c', '3');
    const page1 = await store.list('k/', { limit: 2 });
    expect(page1.entries).toHaveLength(2);
    expect(page1.truncated).toBe(true);
    expect(page1.cursor).toBeDefined();

    const page2 = await store.list('k/', { limit: 2, cursor: page1.cursor });
    expect(page2.entries).toHaveLength(1);
    expect(page2.truncated).toBe(false);
  });

  it('reports entry sizes', async () => {
    await store.put('k', 'hello');
    const result = await store.list('k');
    expect(result.entries[0].size).toBe(5);
  });

  // getLastEntry

  it('returns content of lexicographically last key', async () => {
    await store.put('log/a', 'first');
    await store.put('log/c', 'last');
    await store.put('log/b', 'middle');
    expect(await store.getLastEntry('log/')).toBe('last');
  });

  it('returns null when no keys match prefix', async () => {
    expect(await store.getLastEntry('empty/')).toBeNull();
  });

  // delete

  it('deletes an existing key', async () => {
    await store.put('k', 'v');
    expect(await store.delete('k')).toBe(true);
    expect(await store.get('k')).toBeNull();
  });

  it('returns false when deleting missing key', async () => {
    expect(await store.delete('missing')).toBe(false);
  });

  // deletePrefix

  it('deletes all keys under a prefix', async () => {
    await store.put('p/a', '1');
    await store.put('p/b', '2');
    await store.put('other', '3');
    expect(await store.deletePrefix('p/')).toBe(2);
    expect(await store.get('p/a')).toBeNull();
    expect(await store.get('other')).toBe('3');
  });

  it('returns 0 when no keys match prefix', async () => {
    expect(await store.deletePrefix('empty/')).toBe(0);
  });

  // clear

  it('clears all keys and returns count', async () => {
    await store.put('a', '1');
    await store.put('b', '2');
    expect(await store.clear()).toBe(2);
    expect(await store.get('a')).toBeNull();
  });

  it('returns 0 on empty store', async () => {
    expect(await store.clear()).toBe(0);
  });

  // test

  it('returns ok', async () => {
    expect(await store.test()).toEqual({ ok: true });
  });
});

// ── createStorage factory ──

describe('createStorage', () => {
  afterEach(() => {
    resetMemoryStorage();
  });

  it('returns InMemoryStorage for memory mode', () => {
    const s = createStorage({ mode: 'memory' });
    expect(s).toBeInstanceOf(InMemoryStorage);
  });

  it('returns same instance for repeated memory mode calls', () => {
    const a = createStorage({ mode: 'memory' });
    const b = createStorage({ mode: 'memory' });
    expect(a).toBe(b);
  });

  it('returns new instance after resetMemoryStorage', () => {
    const a = createStorage({ mode: 'memory' });
    resetMemoryStorage();
    const b = createStorage({ mode: 'memory' });
    expect(a).not.toBe(b);
  });

  it('returns a Storage for filesystem mode', () => {
    const s = createStorage({ mode: 'filesystem', dir: '/tmp/test-storage' });
    expect(s.put).toBeTypeOf('function');
    expect(s.get).toBeTypeOf('function');
  });

  it('returns a Storage for s3 mode', () => {
    const s = createStorage({
      mode: 's3',
      endpoint: 'https://s3.example.com',
      accessKey: 'ak',
      secretKey: 'sk',
      region: 'us-east-1',
    });
    expect(s.put).toBeTypeOf('function');
  });
});

// ── R2Storage (via createStorage with mock R2) ──

const createMockR2 = (): R2BucketLike => {
  const data = new Map<string, string>();
  return {
    async get(key: string) {
      const val = data.get(key);
      if (val === undefined) return null;
      return {
        text: async () => val,
        json: async <T>() => JSON.parse(val) as T,
      };
    },
    async put(key: string, body: string | ArrayBufferView | ArrayBuffer | ReadableStream) {
      if (typeof body === 'string') data.set(key, body);
      else if (body instanceof ArrayBuffer) data.set(key, new TextDecoder().decode(body));
      else if (ArrayBuffer.isView(body)) data.set(key, new TextDecoder().decode(body));
      else {
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        data.set(key, chunks.map(c => new TextDecoder().decode(c)).join(''));
      }
    },
    async list(opts: { prefix?: string; limit?: number; cursor?: string }) {
      const prefix = opts.prefix ?? '';
      const limit = opts.limit ?? 100;
      const startAfter = opts.cursor ?? '';
      const keys = [...data.keys()].filter(k => k.startsWith(prefix) && k > startAfter).sort();
      const page = keys.slice(0, limit);
      return {
        objects: page.map(key => ({ key, size: data.get(key)!.length, uploaded: new Date() })),
        truncated: keys.length > limit,
        cursor: page.at(-1) ?? '',
      };
    },
    async delete(key: string | string[]) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) data.delete(k);
    },
  };
};

describe('R2Storage', () => {
  let store: Storage;

  beforeEach(() => {
    store = createStorage({ mode: 'r2', r2: createMockR2() });
  });

  it('stores and retrieves a string', async () => {
    await store.put('k', 'hello');
    expect(await store.get('k')).toBe('hello');
  });

  it('returns null for missing key', async () => {
    expect(await store.get('missing')).toBeNull();
  });

  it('parses stored JSON', async () => {
    await store.put('k', JSON.stringify({ x: 1 }));
    expect(await store.getJSON('k')).toEqual({ x: 1 });
  });

  it('returns null for missing JSON key', async () => {
    expect(await store.getJSON('missing')).toBeNull();
  });

  it('lists keys under prefix', async () => {
    await store.put('a/1', 'x');
    await store.put('a/2', 'y');
    await store.put('b/1', 'z');
    const result = await store.list('a/');
    expect(result.entries.map(e => e.key)).toEqual(['a/1', 'a/2']);
  });

  it('paginates with cursor', async () => {
    await store.put('k/a', '1');
    await store.put('k/b', '2');
    await store.put('k/c', '3');
    const page1 = await store.list('k/', { limit: 2 });
    expect(page1.entries).toHaveLength(2);
    expect(page1.truncated).toBe(true);

    const page2 = await store.list('k/', { limit: 2, cursor: page1.cursor });
    expect(page2.entries).toHaveLength(1);
  });

  it('gets last entry under prefix', async () => {
    await store.put('log/a', 'first');
    await store.put('log/c', 'last');
    await store.put('log/b', 'middle');
    expect(await store.getLastEntry('log/')).toBe('last');
  });

  it('returns null for getLastEntry with no matches', async () => {
    expect(await store.getLastEntry('empty/')).toBeNull();
  });

  it('deletes a key', async () => {
    await store.put('k', 'v');
    expect(await store.delete('k')).toBe(true);
    expect(await store.get('k')).toBeNull();
  });

  it('deletes keys under prefix', async () => {
    await store.put('p/a', '1');
    await store.put('p/b', '2');
    await store.put('other', '3');
    expect(await store.deletePrefix('p/')).toBe(2);
    expect(await store.get('other')).toBe('3');
  });

  it('clears all keys', async () => {
    await store.put('a', '1');
    await store.put('b', '2');
    expect(await store.clear()).toBe(2);
  });

  it('passes connectivity test', async () => {
    expect(await store.test()).toEqual({ ok: true });
  });

  it('reports test failure when R2 throws', async () => {
    const broken: R2BucketLike = {
      ...createMockR2(),
      list: () => {
        throw new Error('R2 unavailable');
      },
    };
    const s = createStorage({ mode: 'r2', r2: broken });
    const result = await s.test();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('R2 unavailable');
  });
});

// ── FileStorage (via createStorage) ──

describe('FileStorage', () => {
  let store: Storage;
  let dir: string;

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    dir = await mkdtemp(join(tmpdir(), 'snitchr-storage-test-'));
    store = createStorage({ mode: 'filesystem', dir });
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  it('stores and retrieves string', async () => {
    await store.put('key.json', 'hello');
    expect(await store.get('key.json')).toBe('hello');
  });

  it('stores Uint8Array', async () => {
    await store.put('bin', new TextEncoder().encode('binary'));
    expect(await store.get('bin')).toBe('binary');
  });

  it('stores ReadableStream', async () => {
    await store.put('stream', streamFrom('streamed'));
    expect(await store.get('stream')).toBe('streamed');
  });

  it('returns null for missing key', async () => {
    expect(await store.get('nope')).toBeNull();
  });

  it('parses JSON', async () => {
    await store.put('data.json', JSON.stringify({ x: 42 }));
    expect(await store.getJSON('data.json')).toEqual({ x: 42 });
  });

  it('returns null for missing JSON key', async () => {
    expect(await store.getJSON('nope')).toBeNull();
  });

  it('creates nested directories', async () => {
    await store.put('a/b/c.json', 'nested');
    expect(await store.get('a/b/c.json')).toBe('nested');
  });

  it('lists keys under prefix', async () => {
    await store.put('p/a', '1');
    await store.put('p/b', '2');
    await store.put('other', '3');
    const result = await store.list('p/');
    expect(result.entries.map(e => e.key)).toEqual(['p/a', 'p/b']);
  });

  it('paginates with limit and cursor', async () => {
    await store.put('k/a', '1');
    await store.put('k/b', '2');
    await store.put('k/c', '3');
    const page1 = await store.list('k/', { limit: 2 });
    expect(page1.entries).toHaveLength(2);
    expect(page1.truncated).toBe(true);

    const page2 = await store.list('k/', { limit: 2, cursor: page1.cursor });
    expect(page2.entries).toHaveLength(1);
    expect(page2.truncated).toBe(false);
  });

  it('returns empty list for unmatched prefix', async () => {
    const result = await store.list('nope/');
    expect(result.entries).toHaveLength(0);
  });

  it('gets last entry under prefix', async () => {
    await store.put('log/a', 'first');
    await store.put('log/c', 'last');
    await store.put('log/b', 'middle');
    expect(await store.getLastEntry('log/')).toBe('last');
  });

  it('returns null for getLastEntry with no matches', async () => {
    expect(await store.getLastEntry('empty/')).toBeNull();
  });

  it('deletes a key', async () => {
    await store.put('k', 'v');
    expect(await store.delete('k')).toBe(true);
    expect(await store.get('k')).toBeNull();
  });

  it('returns false deleting missing key', async () => {
    expect(await store.delete('missing')).toBe(false);
  });

  it('deletes keys under prefix', async () => {
    await store.put('p/a', '1');
    await store.put('p/b', '2');
    await store.put('other', '3');
    expect(await store.deletePrefix('p/')).toBe(2);
    expect(await store.get('other')).toBe('3');
  });

  it('clears all keys', async () => {
    await store.put('a', '1');
    await store.put('b', '2');
    expect(await store.clear()).toBe(2);
  });

  it('passes connectivity test', async () => {
    expect(await store.test()).toEqual({ ok: true });
  });
});
