import { serve } from '@hono/node-server';
import { app } from './app';
import { scheduled } from './scheduled';
import { FileKV } from './kv';
import { FileAssetServer } from './assets';
import type { Bindings } from './types';

export type ServeOptions = {
  port?: number;
  hostname?: string;
  dataDir: string;
  staticDir: string;
};

const CRON_INTERVAL_MS = 5 * 60 * 1000;

/** Start the snitchr gateway on Node.js or Bun. */
export const startServer = (opts: ServeOptions) => {
  const { port = 8787, hostname = '0.0.0.0', dataDir, staticDir } = opts;

  const bindings: Bindings = {
    SNITCHR_CONFIG: new FileKV(dataDir),
    ASSETS: new FileAssetServer(staticDir),
    DATA_DIR: dataDir,
    VAPID_CONTACT: process.env.VAPID_CONTACT,
  };

  const server = serve(
    {
      fetch: (req) => app.fetch(req, bindings),
      port,
      hostname,
    },
    (info) => {
      console.log(`snitchr gateway listening on http://${info.address}:${info.port}`);
    },
  );

  // Scheduled cron — check for down machines every 5 minutes
  const cron = setInterval(() => {
    scheduled(null, bindings).catch(err => {
      console.error('Scheduled check failed:', err);
    });
  }, CRON_INTERVAL_MS);

  // Graceful shutdown
  const shutdown = () => {
    clearInterval(cron);
    server.close();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, shutdown };
};
