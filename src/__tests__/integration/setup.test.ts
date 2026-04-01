import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../../app';
import { createTestEnv, jsonPost, getStoredConfig, json } from '../helpers';
import type { Bindings } from '../../types';
import { InMemoryKV } from '../../kv';

describe('Setup wizard', () => {
  let env: Bindings;
  let kv: InMemoryKV;

  beforeEach(() => {
    ({ env, kv } = createTestEnv());
  });

  it('GET /api/capabilities reports unconfigured', async () => {
    const res = await app.request('/api/capabilities', {}, env);
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.configured).toBe(false);
    expect(body.r2Available).toBe(false);
  });

  it('POST /api/setup with memory mode succeeds', async () => {
    const res = await app.request(
      '/api/setup',
      jsonPost({ password: 'testpassword123', passwordConfirm: 'testpassword123', storageMode: 'memory' }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);

    const config = await getStoredConfig(kv);
    expect(config.storageMode).toBe('memory');
    expect(config.passwordHash).toBeTruthy();
    expect(config.machineList).toEqual({});
  });

  it('sets session cookie after setup', async () => {
    const res = await app.request(
      '/api/setup',
      jsonPost({ password: 'testpassword123', passwordConfirm: 'testpassword123', storageMode: 'memory' }),
      env,
    );
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('session=');
    expect(setCookie).toContain('HttpOnly');
  });

  it('rejects short password', async () => {
    const res = await app.request(
      '/api/setup',
      jsonPost({ password: 'short', passwordConfirm: 'short', storageMode: 'memory' }),
      env,
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain('8 characters');
  });

  it('rejects mismatched passwords', async () => {
    const res = await app.request(
      '/api/setup',
      jsonPost({ password: 'testpassword123', passwordConfirm: 'different123', storageMode: 'memory' }),
      env,
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain('do not match');
  });

  it('rejects invalid storage mode', async () => {
    const res = await app.request(
      '/api/setup',
      jsonPost({ password: 'testpassword123', passwordConfirm: 'testpassword123', storageMode: 'invalid' }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects R2 mode without R2 binding', async () => {
    const res = await app.request(
      '/api/setup',
      jsonPost({ password: 'testpassword123', passwordConfirm: 'testpassword123', storageMode: 'r2' }),
      env,
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain('R2 binding');
  });

  it('rejects filesystem mode without DATA_DIR', async () => {
    const res = await app.request(
      '/api/setup',
      jsonPost({ password: 'testpassword123', passwordConfirm: 'testpassword123', storageMode: 'filesystem' }),
      env,
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain('Filesystem');
  });

  it('rejects S3 mode with missing fields', async () => {
    const res = await app.request(
      '/api/setup',
      jsonPost({
        password: 'testpassword123',
        passwordConfirm: 'testpassword123',
        storageMode: 's3',
        s3Endpoint: 'https://s3.example.com',
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain('S3 fields');
  });

  it('rejects setup when already configured', async () => {
    await app.request(
      '/api/setup',
      jsonPost({ password: 'testpassword123', passwordConfirm: 'testpassword123', storageMode: 'memory' }),
      env,
    );
    const res = await app.request(
      '/api/setup',
      jsonPost({ password: 'testpassword123', passwordConfirm: 'testpassword123', storageMode: 'memory' }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('GET /api/capabilities reports configured after setup', async () => {
    await app.request(
      '/api/setup',
      jsonPost({ password: 'testpassword123', passwordConfirm: 'testpassword123', storageMode: 'memory' }),
      env,
    );
    const res = await app.request('/api/capabilities', {}, env);
    const body = await json(res);
    expect(body.configured).toBe(true);
  });
});
