import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../../app';
import { createTestEnv, setupConfig, addMachine, getSessionCookie, validHeartbeatPayload, json } from '../helpers';
import type { Bindings, HeartbeatData } from '../../types';
import { InMemoryKV } from '../../kv';

const MACHINE_ID = 'snap-machine-001';
const MACHINE_SECRET = 'b'.repeat(48);

const ingest = (env: Bindings, payload: unknown) =>
  app.request(
    `/m/${MACHINE_ID}/ingest`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MACHINE_SECRET}` },
      body: JSON.stringify(payload),
    },
    env,
  );

const getMachine = (env: Bindings, session: string) =>
  app.request(
    `/api/machines/${MACHINE_ID}`,
    {
      headers: { Cookie: `session=${session}` },
    },
    env,
  );

const heartbeatWith = (snapshot: Partial<HeartbeatData>) => {
  const base = validHeartbeatPayload();
  return { ...base, d: { ...base.d, ...snapshot } };
};

describe('Snapshot fields in heartbeat', () => {
  let env: Bindings;
  let kv: InMemoryKV;
  let session: string;

  beforeEach(async () => {
    ({ env, kv } = createTestEnv());
    await setupConfig(kv);
    await addMachine(kv, MACHINE_ID, MACHINE_SECRET);
    session = await getSessionCookie(env);
  });

  it('accepts heartbeat with procList', async () => {
    const res = await ingest(env, heartbeatWith({ procList: 'nginx|sshd|cron' }));
    expect(res.status).toBe(200);
  });

  it('accepts heartbeat with portList', async () => {
    const payload = heartbeatWith({
      portList: [
        { port: 22, addr: '0.0.0.0', proc: 'sshd' },
        { port: 80, addr: '0.0.0.0', proc: 'nginx' },
      ],
    });
    const res = await ingest(env, payload);
    expect(res.status).toBe(200);
  });

  it('accepts heartbeat with mountList', async () => {
    const payload = heartbeatWith({
      mountList: [{ src: '/dev/sda1', target: '/', fs: 'ext4' }],
    });
    const res = await ingest(env, payload);
    expect(res.status).toBe(200);
  });

  it('accepts heartbeat with ttyList', async () => {
    const payload = heartbeatWith({
      ttyList: [{ user: 'root', tty: 'pts/0', from: '10.0.0.1', login: 1700000000 }],
    });
    const res = await ingest(env, payload);
    expect(res.status).toBe(200);
  });

  it('rejects invalid procList type', async () => {
    const res = await ingest(env, heartbeatWith({ procList: 123 as unknown as string }));
    expect(res.status).toBe(400);
  });

  it('rejects invalid portList type', async () => {
    const res = await ingest(env, heartbeatWith({ portList: 'not-array' as unknown as [] }));
    expect(res.status).toBe(400);
  });

  it('stores snapshot fields and returns them via API', async () => {
    await ingest(
      env,
      heartbeatWith({
        procList: 'nginx|sshd',
        portList: [{ port: 22, addr: '0.0.0.0', proc: 'sshd' }],
        mountList: [{ src: '/dev/sda1', target: '/', fs: 'ext4' }],
        ttyList: [{ user: 'root', tty: 'pts/0', from: '10.0.0.1', login: 1700000000 }],
      }),
    );

    const res = await getMachine(env, session);
    const body = await json(res);
    expect(body.d.procList).toBe('nginx|sshd');
    expect(body.d.portList).toEqual([{ port: 22, addr: '0.0.0.0', proc: 'sshd' }]);
    expect(body.d.mountList).toEqual([{ src: '/dev/sda1', target: '/', fs: 'ext4' }]);
    expect(body.d.ttyList).toEqual([{ user: 'root', tty: 'pts/0', from: '10.0.0.1', login: 1700000000 }]);
  });

  it('preserves snapshot fields when next heartbeat omits them', async () => {
    // first heartbeat with snapshot
    await ingest(
      env,
      heartbeatWith({
        procList: 'nginx|sshd',
        portList: [{ port: 22, addr: '0.0.0.0', proc: 'sshd' }],
      }),
    );

    // second heartbeat without snapshot
    await ingest(env, validHeartbeatPayload());

    const res = await getMachine(env, session);
    const body = await json(res);
    expect(body.d.procList).toBe('nginx|sshd');
    expect(body.d.portList).toEqual([{ port: 22, addr: '0.0.0.0', proc: 'sshd' }]);
  });

  it('updates snapshot fields when new heartbeat includes them', async () => {
    await ingest(env, heartbeatWith({ procList: 'nginx|sshd' }));
    await ingest(env, heartbeatWith({ procList: 'nginx|sshd|postgres' }));

    const res = await getMachine(env, session);
    const body = await json(res);
    expect(body.d.procList).toBe('nginx|sshd|postgres');
  });

  it('accepts heartbeat without any snapshot fields (backward compat)', async () => {
    const res = await ingest(env, validHeartbeatPayload());
    expect(res.status).toBe(200);

    const detail = await getMachine(env, session);
    const body = await json(detail);
    expect(body.d.procList).toBeUndefined();
    expect(body.d.portList).toBeUndefined();
  });
});
