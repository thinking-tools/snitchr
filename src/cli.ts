#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { startServer } from './serve';

const args = process.argv.slice(2);

const getArg = (name: string, fallback: string): string => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

const hasFlag = (name: string): boolean => args.includes(`--${name}`);

if (hasFlag('help') || hasFlag('h')) {
  console.log(
    `
snitchr — server monitoring gateway

Usage: snitchr [options]

Options:
  --port <number>      Port to listen on (default: 8787)
  --host <address>     Hostname to bind to (default: 0.0.0.0)
  --data-dir <path>    Data directory for config and storage (default: ./snitchr-data)
  --static-dir <path>  Static assets directory (default: auto-detected)
  --help               Show this help message

Examples:
  npx snitchr
  npx snitchr --port 3000 --data-dir /var/lib/snitchr
  bunx snitchr --port 8080
`.trim(),
  );
  process.exit(0);
}

const port = Number(getArg('port', '8787'));
const hostname = getArg('host', '0.0.0.0');
const dataDir = resolve(getArg('data-dir', './snitchr-data'));

// Resolve static dir: explicit flag > sibling static/ > package static/
const resolveStaticDir = (): string => {
  const explicit = getArg('static-dir', '');
  if (explicit) return resolve(explicit);

  // Check sibling to CWD (for dev / cloned repo)
  const cwdStatic = resolve('static');
  if (existsSync(cwdStatic)) return cwdStatic;

  // Check relative to this script (for npm package)
  const pkgStatic = resolve(join(__dirname, '..', 'static'));
  if (existsSync(pkgStatic)) return pkgStatic;

  console.error('Could not find static/ directory. Use --static-dir to specify.');
  process.exit(1);
};

const staticDir = resolveStaticDir();

// Ensure data directory exists
mkdirSync(dataDir, { recursive: true });

console.log(`Data directory: ${dataDir}`);
console.log(`Static assets:  ${staticDir}`);

startServer({ port, hostname, dataDir, staticDir });
