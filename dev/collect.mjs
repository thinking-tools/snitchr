import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const LOGS = 'test/logs/requests.jsonl';
const OUT = 'dev/fixtures';

let raw;
try {
  raw = readFileSync(LOGS, 'utf-8').trim();
} catch {
  console.error(`No logs found at ${LOGS}. Run "npm run test:agent" first.`);
  process.exit(1);
}

const logs = raw.split('\n').map(JSON.parse);
mkdirSync(OUT, { recursive: true });

const machines = logs.filter(e => e.path === '/register').map(e => e.body);
const heartbeats = logs.filter(e => e.path.includes('/heartbeat')).map(e => ({ path: e.path, ...e.body }));
const events = logs.filter(e => e.path.includes('/event')).map(e => ({ path: e.path, ...e.body }));

writeFileSync(`${OUT}/machines.json`, JSON.stringify(machines, null, 2));
writeFileSync(`${OUT}/heartbeats.json`, JSON.stringify(heartbeats, null, 2));
writeFileSync(`${OUT}/events.json`, JSON.stringify(events, null, 2));

console.log(`Collected: ${machines.length} machines, ${heartbeats.length} heartbeats, ${events.length} events`);
console.log(`Saved to ${OUT}/`);
