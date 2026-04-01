/** Runtime-agnostic static asset server interface. */
export interface AssetServer {
  fetch(url: URL | string): Promise<Response>;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.map': 'application/json',
};

const getMimeType = (ext: string): string => MIME_TYPES[ext] ?? 'application/octet-stream';

/**
 * Filesystem-backed asset server for Node.js and Bun.
 * Serves files from a directory on disk.
 */
export class FileAssetServer implements AssetServer {
  constructor(readonly root: string) {}

  async fetch(url: URL | string): Promise<Response> {
    const { readFile } = await import('node:fs/promises');
    const { join, extname, normalize } = await import('node:path');
    const parsed = typeof url === 'string' ? new URL(url, 'http://localhost') : url;
    const decoded = decodeURIComponent(parsed.pathname);
    const resolved = normalize(join(this.root, decoded));
    // Path traversal guard
    if (!resolved.startsWith(this.root)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await readFile(resolved);
      return new Response(data, {
        headers: { 'Content-Type': getMimeType(extname(resolved)) },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  }
}
