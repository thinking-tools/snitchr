import { S3mini } from 's3mini';

export type ListEntry = {
  key: string;
  size: number;
  lastModified: Date;
};

export type ListResult = {
  entries: ListEntry[];
  cursor?: string;
  truncated: boolean;
};

export type StorageTestResult = { ok: boolean; error?: string };

export type StorageData = string | Uint8Array | ReadableStream;

export type ListOptions = { limit?: number; cursor?: string; delimiter?: string };

/** Drain a ReadableStream into a single Uint8Array. */
const drainStream = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return merged;
};

export interface Storage {
  /** Write JSON-serializable data or raw bytes to a key. */
  put(key: string, data: StorageData): Promise<void>;
  /** Read a key as UTF-8 string. Returns null if not found. */
  get(key: string): Promise<string | null>;
  /** Read and JSON-parse a key. Returns null if not found. */
  getJSON<T = unknown>(key: string): Promise<T | null>;
  /** Paginated listing of keys under a prefix. */
  list(prefix: string, opts?: ListOptions): Promise<ListResult>;
  /** Get the content of the last (lexicographically greatest) key under a prefix. */
  getLastEntry(prefix: string): Promise<string | null>;
  /** Delete a single key. Returns true if deleted. */
  delete(key: string): Promise<boolean>;
  /** Delete all keys under a prefix. Returns count of deleted keys. */
  deletePrefix(prefix: string): Promise<number>;
  /** Delete everything in the bucket. Returns count of deleted keys. */
  clear(): Promise<number>;
  /** Connectivity/permission check. */
  test(): Promise<StorageTestResult>;
}

// ── R2 ──────────────────────────────────────────────────────────────────

class R2Storage implements Storage {
  constructor(readonly r2: import('./types').R2BucketLike) {}

  async put(key: string, data: StorageData): Promise<void> {
    await this.r2.put(key, data);
  }

  async get(key: string): Promise<string | null> {
    const obj = await this.r2.get(key);
    return obj ? obj.text() : null;
  }

  async getJSON<T = unknown>(key: string): Promise<T | null> {
    const obj = await this.r2.get(key);
    return obj ? obj.json<T>() : null;
  }

  async list(prefix: string, opts: ListOptions = {}): Promise<ListResult> {
    const res = await this.r2.list({
      prefix,
      limit: opts.limit ?? 100,
      cursor: opts.cursor,
      delimiter: opts.delimiter,
    });
    return {
      entries: res.objects.map(o => ({ key: o.key, size: o.size, lastModified: o.uploaded })),
      cursor: res.truncated ? res.cursor : undefined,
      truncated: res.truncated,
    };
  }

  async getLastEntry(prefix: string): Promise<string | null> {
    let lastKey: string | undefined;
    let cursor: string | undefined;
    for (;;) {
      const res = await this.r2.list({ prefix, limit: 1000, cursor });
      for (const o of res.objects) lastKey = o.key;
      if (!res.truncated) break;
      cursor = res.cursor;
    }
    return lastKey ? this.get(lastKey) : null;
  }

  async delete(key: string): Promise<boolean> {
    await this.r2.delete(key);
    return true;
  }

  async deletePrefix(prefix: string): Promise<number> {
    let count = 0;
    let cursor: string | undefined;
    for (;;) {
      const res = await this.r2.list({ prefix, limit: 1000, cursor });
      const keys = res.objects.map(o => o.key);
      if (keys.length) {
        await this.r2.delete(keys);
        count += keys.length;
      }
      if (!res.truncated) break;
      cursor = res.cursor;
    }
    return count;
  }

  async clear(): Promise<number> {
    return this.deletePrefix('');
  }

  async test(): Promise<StorageTestResult> {
    try {
      await this.r2.list({ limit: 1 });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'R2 connection failed' };
    }
  }
}

// ── S3 ──────────────────────────────────────────────────────────────────

class S3Storage implements Storage {
  readonly s3: S3mini;

  constructor(endpoint: string, accessKey: string, secretKey: string, region: string) {
    this.s3 = new S3mini({
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      endpoint,
      region,
    });
  }

  async put(key: string, data: StorageData): Promise<void> {
    await this.s3.putObject(key, data, 'application/json');
  }

  async get(key: string): Promise<string | null> {
    return this.s3.getObject(key);
  }

  async getJSON<T = unknown>(key: string): Promise<T | null> {
    return this.s3.getObjectJSON<T>(key);
  }

  async list(prefix: string, opts: ListOptions = {}): Promise<ListResult> {
    const res = await this.s3.listObjectsPaged(opts.delimiter ?? '/', prefix, opts.limit ?? 100, opts.cursor);
    if (!res) return { entries: [], truncated: false };
    return {
      entries: (res.objects ?? []).map(o => ({ key: o.Key, size: o.Size, lastModified: o.LastModified })),
      cursor: res.nextContinuationToken,
      truncated: !!res.nextContinuationToken,
    };
  }

  async getLastEntry(prefix: string): Promise<string | null> {
    const all = await this.s3.listObjects('/', prefix);
    if (!all?.length) return null;
    return this.get(all.at(-1)!.Key);
  }

  async delete(key: string): Promise<boolean> {
    return this.s3.deleteObject(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    const all = await this.s3.listObjects('/', prefix);
    if (!all?.length) return 0;
    const keys = all.map(o => o.Key);
    const results = await this.s3.deleteObjects(keys);
    return results.filter(Boolean).length;
  }

  async clear(): Promise<number> {
    return this.deletePrefix('');
  }

  async test(): Promise<StorageTestResult> {
    try {
      const exists = await this.s3.bucketExists();
      return exists ? { ok: true } : { ok: false, error: 'Bucket not found' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' };
    }
  }
}

// ── In-Memory ────────────────────────────────────────────────────────────

export class InMemoryStorage implements Storage {
  readonly store = new Map<string, string>();

  async put(key: string, data: StorageData): Promise<void> {
    if (typeof data === 'string') {
      this.store.set(key, data);
      return;
    }
    const bytes = data instanceof Uint8Array ? data : await drainStream(data);
    this.store.set(key, new TextDecoder().decode(bytes));
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async getJSON<T = unknown>(key: string): Promise<T | null> {
    const raw = this.store.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async list(prefix: string, opts: ListOptions = {}): Promise<ListResult> {
    const limit = opts.limit ?? 100;
    const startAfter = opts.cursor ?? '';
    const keys = [...this.store.keys()]
      .filter(k => k.startsWith(prefix) && k > startAfter)
      .sort((a, b) => a.localeCompare(b));
    const page = keys.slice(0, limit);
    return {
      entries: page.map(key => ({ key, size: this.store.get(key)!.length, lastModified: new Date() })),
      cursor: page.length === limit ? page.at(-1) : undefined,
      truncated: page.length === limit && keys.length > limit,
    };
  }

  async getLastEntry(prefix: string): Promise<string | null> {
    const keys = [...this.store.keys()].filter(k => k.startsWith(prefix)).sort((a, b) => a.localeCompare(b));
    if (!keys.length) return null;
    return this.store.get(keys.at(-1)!) ?? null;
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let count = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  async clear(): Promise<number> {
    const count = this.store.size;
    this.store.clear();
    return count;
  }

  async test(): Promise<StorageTestResult> {
    return { ok: true };
  }
}

// ── Filesystem ────────────────────────────────────────────────────────

class FileStorage implements Storage {
  constructor(readonly dir: string) {}

  private async fs() {
    return import('node:fs/promises');
  }

  private async resolvePath(key: string) {
    const { join } = await import('node:path');
    return join(this.dir, key);
  }

  async put(key: string, data: StorageData): Promise<void> {
    const fs = await this.fs();
    const file = await this.resolvePath(key);
    const { dirname } = await import('node:path');
    await fs.mkdir(dirname(file), { recursive: true });
    const content = data instanceof ReadableStream ? await drainStream(data) : data;
    const tmp = `${file}.${Date.now().toString(36)}.tmp`;
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, file);
  }

  async get(key: string): Promise<string | null> {
    const fs = await this.fs();
    try {
      return await fs.readFile(await this.resolvePath(key), 'utf-8');
    } catch {
      return null;
    }
  }

  async getJSON<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async list(prefix: string, opts: ListOptions = {}): Promise<ListResult> {
    const limit = opts.limit ?? 100;
    const startAfter = opts.cursor ?? '';
    const keys = await this.collectKeys(prefix);
    const filtered = keys.filter(k => k > startAfter).sort((a, b) => a.localeCompare(b));
    const page = filtered.slice(0, limit);
    const fs = await this.fs();
    const entries: ListEntry[] = [];
    for (const key of page) {
      try {
        const stat = await fs.stat(await this.resolvePath(key));
        entries.push({ key, size: stat.size, lastModified: stat.mtime });
      } catch {
        entries.push({ key, size: 0, lastModified: new Date() });
      }
    }
    return {
      entries,
      cursor: page.length === limit ? page.at(-1) : undefined,
      truncated: page.length === limit && filtered.length > limit,
    };
  }

  async getLastEntry(prefix: string): Promise<string | null> {
    const keys = (await this.collectKeys(prefix)).sort((a, b) => a.localeCompare(b));
    if (!keys.length) return null;
    return this.get(keys.at(-1)!);
  }

  async delete(key: string): Promise<boolean> {
    const fs = await this.fs();
    try {
      await fs.unlink(await this.resolvePath(key));
      return true;
    } catch {
      return false;
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.collectKeys(prefix);
    let count = 0;
    for (const key of keys) {
      if (await this.delete(key)) count++;
    }
    return count;
  }

  async clear(): Promise<number> {
    return this.deletePrefix('');
  }

  async test(): Promise<StorageTestResult> {
    const fs = await this.fs();
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.access(this.dir);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Directory access failed' };
    }
  }

  /** Recursively collect all keys (relative paths) under a prefix. */
  private async collectKeys(prefix: string): Promise<string[]> {
    const fs = await this.fs();
    const { join, relative } = await import('node:path');
    const base = join(this.dir, prefix);
    const keys: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else {
          const key = relative(this.dir, full);
          if (key.startsWith(prefix)) keys.push(key);
        }
      }
    };
    // Walk from the deepest existing ancestor of the prefix path
    try {
      await fs.access(base);
      await walk(base);
    } catch {
      // Prefix dir doesn't exist — walk from storage root and filter
      await walk(this.dir);
    }
    return keys.filter(k => k.startsWith(prefix));
  }
}

// ── Factory ─────────────────────────────────────────────────────────────

let _memoryStore: InMemoryStorage | null = null;

/** Reset the shared in-memory storage instance. Call in test teardown. */
export const resetMemoryStorage = () => {
  _memoryStore = null;
};

type R2Opts = { mode: 'r2'; r2: import('./types').R2BucketLike };
type S3Opts = { mode: 's3'; endpoint: string; accessKey: string; secretKey: string; region: string };
type MemoryOpts = { mode: 'memory' };
type FileOpts = { mode: 'filesystem'; dir: string };

export const createStorage = (opts: R2Opts | S3Opts | MemoryOpts | FileOpts): Storage => {
  if (opts.mode === 'r2') return new R2Storage(opts.r2);
  if (opts.mode === 'filesystem') return new FileStorage(opts.dir);
  if (opts.mode === 'memory') {
    _memoryStore ??= new InMemoryStorage();
    return _memoryStore;
  }
  return new S3Storage(opts.endpoint, opts.accessKey, opts.secretKey, opts.region);
};
