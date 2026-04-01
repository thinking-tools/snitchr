import { InMemoryKV } from '../kv';
import { hashPassword, toHex, createSession } from '../crypto';
import { resetMemoryStorage } from '../storage';
import type { AssetServer } from '../assets';
import type { Bindings, Config } from '../types';
import { app } from '../app';

export const TEST_PASSWORD = 'testpassword123';
const TEST_SALT = new Uint8Array(32).fill(0x42);

let cachedHash: string | undefined;
let cachedSalt: string | undefined;

const getTestCredentials = async () => {
  if (!cachedHash) {
    cachedHash = await hashPassword(TEST_PASSWORD, TEST_SALT);
    cachedSalt = toHex(TEST_SALT);
  }
  return { hash: cachedHash, salt: cachedSalt! };
};

const mockAssets: AssetServer = {
  fetch: async () => new Response('<div>mock</div>', { status: 200 }),
};

export const createTestEnv = (): { env: Bindings; kv: InMemoryKV } => {
  resetMemoryStorage();
  const kv = new InMemoryKV();
  return {
    env: { SNITCHR_CONFIG: kv, ASSETS: mockAssets },
    kv,
  };
};

export const setupConfig = async (kv: InMemoryKV, overrides?: Partial<Config>): Promise<Config> => {
  const { hash, salt } = await getTestCredentials();
  const config: Config = {
    passwordHash: hash,
    passwordSalt: salt,
    storageMode: 'memory',
    userId: 'test-user-id',
    machineList: {},
    ...overrides,
  };
  await kv.put('config', JSON.stringify(config));
  return config;
};

export const getSessionCookie = async (env: Bindings): Promise<string> => {
  const res = await app.request(
    '/api/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    },
    env,
  );
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/session=([^;]+)/);
  if (!match) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  return match[1];
};

export const authedRequest = (
  path: string,
  session: string,
  init: RequestInit = {},
): [string, RequestInit, Bindings] => {
  const headers = new Headers(init.headers);
  headers.set('Cookie', `session=${session}`);
  return [path, { ...init, headers }, undefined as never];
};

export const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const jsonPatch = (body: unknown): RequestInit => ({
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const addMachine = async (kv: InMemoryKV, id: string, secret: string, label?: string) => {
  const raw = await kv.get('config');
  const config = JSON.parse(raw!) as Config;
  config.machineList[id] = { secret, registeredAt: Date.now(), label };
  await kv.put('config', JSON.stringify(config));
};

export const getStoredConfig = async (kv: InMemoryKV): Promise<Config> => {
  const raw = await kv.get('config');
  return JSON.parse(raw!) as Config;
};

export const validHeartbeatPayload = () => ({
  t: 0,
  d: {
    ts: Date.now(),
    cpu: 45.2,
    up: 123456,
    procs: 200,
    mem: [4096, 8192],
    disk: [50],
    load: [1.5, 1.2, 0.8],
    net: [1000, 2000],
    ports: '22,80,443',
    users: 'root',
  },
});

export const validAlertPayload = (type = 'ssh_login', msg = 'root logged in') => ({
  t: 2,
  d: { type, msg },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const json = <T = any>(res: Response): Promise<T> => res.json() as Promise<T>;
