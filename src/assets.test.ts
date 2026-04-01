import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileAssetServer } from './assets';

describe('FileAssetServer', () => {
  let server: FileAssetServer;
  let dir: string;

  beforeEach(async () => {
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    dir = await mkdtemp(join(tmpdir(), 'snitchr-assets-test-'));
    await writeFile(join(dir, 'index.html'), '<h1>Hello</h1>');
    await writeFile(join(dir, 'app.css'), 'body {}');
    await writeFile(join(dir, 'data.json'), '{"ok":true}');
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'scripts', 'main.js'), 'console.log("hi")');
    server = new FileAssetServer(dir);
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  it('serves HTML with correct content type', async () => {
    const res = await server.fetch('http://localhost/index.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe('<h1>Hello</h1>');
  });

  it('serves CSS with correct content type', async () => {
    const res = await server.fetch('http://localhost/app.css');
    expect(res.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
  });

  it('serves JS from subdirectory', async () => {
    const res = await server.fetch('http://localhost/scripts/main.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8');
    expect(await res.text()).toBe('console.log("hi")');
  });

  it('serves JSON with correct content type', async () => {
    const res = await server.fetch('http://localhost/data.json');
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  });

  it('returns 404 for missing files', async () => {
    const res = await server.fetch('http://localhost/nope.txt');
    expect(res.status).toBe(404);
  });

  it('blocks path traversal via encoded dots', async () => {
    const res = await server.fetch('http://localhost/%2e%2e/%2e%2e/etc/passwd');
    expect([403, 404]).toContain(res.status);
  });

  it('accepts URL object', async () => {
    const res = await server.fetch(new URL('http://localhost/index.html'));
    expect(res.status).toBe(200);
  });

  it('returns octet-stream for unknown extensions', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await writeFile(join(dir, 'file.xyz'), 'data');
    const res = await server.fetch('http://localhost/file.xyz');
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
  });
});
