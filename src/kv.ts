/** Runtime-agnostic key-value store interface. */
export interface KVStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

// Node/Bun-only imports — lazily resolved so this module loads on CF too.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _fs: typeof import('node:fs/promises') | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _path: typeof import('node:path') | undefined;

const nodeImports = async () => {
  _fs ??= await import('node:fs/promises');
  _path ??= await import('node:path');
  return { fs: _fs, path: _path };
};

/**
 * File-backed KVStore for Node.js and Bun.
 * Each key is stored as a JSON file in the given directory.
 * TTL entries are expired on read (lazy expiration).
 */
export class FileKV implements KVStore {
  constructor(readonly dir: string) {}

  async get(key: string): Promise<string | null> {
    const { fs, path } = await nodeImports();
    const file = path.join(this.dir, `${key}.json`);
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const rec = JSON.parse(raw) as { value: string; expiresAt?: number };
      if (rec.expiresAt && Date.now() > rec.expiresAt) {
        await fs.unlink(file).catch(() => {});
        return null;
      }
      return rec.value;
    } catch {
      return null;
    }
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const { fs, path } = await nodeImports();
    await fs.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${key}.json`);
    const rec = {
      value,
      expiresAt: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined,
    };
    // Atomic write: temp file + rename (same dir = same filesystem = atomic on POSIX)
    const tmp = `${file}.${Date.now().toString(36)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(rec));
    await fs.rename(tmp, file);
  }

  async delete(key: string): Promise<void> {
    const { fs, path } = await nodeImports();
    await fs.unlink(path.join(this.dir, `${key}.json`)).catch(() => {});
  }
}

/** In-memory KVStore for testing and non-Cloudflare runtimes. */
export class InMemoryKV implements KVStore {
  readonly store = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Clear all entries. Useful for test teardown. */
  clear(): void {
    this.store.clear();
  }

  /** Number of stored entries. */
  get size(): number {
    return this.store.size;
  }
}
