import { execSync } from 'node:child_process';

const toHex = arr => [...arr].map(b => b.toString(16).padStart(2, '0')).join('');

const password = 'snitchr123';
const salt = crypto.getRandomValues(new Uint8Array(32));
const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
  'deriveBits',
]);
const derived = await crypto.subtle.deriveBits(
  { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 },
  keyMaterial,
  256,
);
const hash = new Uint8Array(derived);

const day = 86400_000;
const m = (secret, label, daysAgo, lat, lng, city, country) => ({
  secret,
  label,
  registeredAt: Date.now() - day * daysAgo,
  lat,
  lng,
  city,
  country,
});

const machines = {
  'machine-debian-001': m('dev-secret-debian-001', 'web-prod-1', 14, 50.08, 14.43, 'Prague', 'CZ'),
  'machine-ubuntu-001': m('dev-secret-ubuntu-001', 'db-prod-1', 7, 37.77, -122.42, 'San Francisco', 'US'),
  'machine-debian-002': m('dev-secret-staging-002', 'worker-staging', 2, 1.35, 103.82, 'Singapore', 'SG'),
  'machine-debian-003': m('dev-secret-003', 'api-prod-1', 30, 51.51, -0.13, 'London', 'GB'),
  'machine-ubuntu-002': m('dev-secret-004', 'api-prod-2', 28, 48.86, 2.35, 'Paris', 'FR'),
  'machine-debian-004': m('dev-secret-005', 'cache-prod-1', 21, 35.68, 139.69, 'Tokyo', 'JP'),
  'machine-ubuntu-003': m('dev-secret-006', 'cache-prod-2', 20, -33.87, 151.21, 'Sydney', 'AU'),
  'machine-debian-005': m('dev-secret-007', 'queue-prod-1', 18, 52.52, 13.41, 'Berlin', 'DE'),
  'machine-ubuntu-004': m('dev-secret-008', 'queue-prod-2', 15, 40.71, -74.01, 'New York', 'US'),
  'machine-debian-006': m('dev-secret-009', 'db-replica-1', 12, 55.75, 37.62, 'Moscow', 'RU'),
  'machine-ubuntu-005': m('dev-secret-010', 'db-replica-2', 10, 19.43, -99.13, 'Mexico City', 'MX'),
  'machine-debian-007': m('dev-secret-011', 'monitor-1', 9, -23.55, -46.63, 'São Paulo', 'BR'),
  'machine-ubuntu-006': m('dev-secret-012', 'monitor-2', 8, 28.61, 77.23, 'New Delhi', 'IN'),
  'machine-debian-008': m('dev-secret-013', 'edge-eu-1', 6, 59.33, 18.07, 'Stockholm', 'SE'),
  'machine-ubuntu-007': m('dev-secret-014', 'edge-eu-2', 5, 41.39, 2.17, 'Barcelona', 'ES'),
  'machine-debian-009': m('dev-secret-015', 'edge-us-1', 4, 47.61, -122.33, 'Seattle', 'US'),
  'machine-ubuntu-008': m('dev-secret-016', 'edge-us-2', 3, 34.05, -118.24, 'Los Angeles', 'US'),
  'machine-debian-010': m('dev-secret-017', 'edge-asia-1', 2, 22.32, 114.17, 'Hong Kong', 'HK'),
  'machine-ubuntu-009': m('dev-secret-018', 'edge-asia-2', 1, 37.57, 126.98, 'Seoul', 'KR'),
  'machine-debian-011': m('dev-secret-019', 'backup-1', 1, -34.6, -58.38, 'Buenos Aires', 'AR'),
};

const config = {
  passwordHash: toHex(hash),
  passwordSalt: toHex(salt),
  userId: crypto.randomUUID(),
  machineList: machines,
  storageMode: 'r2',
  heartbeatTimeout: 120,
  alertThreshold: 2,
};

const json = JSON.stringify(config);
execSync(`wrangler kv key put --binding SNITCHR_CONFIG config '${json}' --local`, {
  stdio: 'inherit',
});

console.log('\n  Dev login:  password = snitchr123');
console.log(`  Machines:   ${Object.keys(machines).length} seeded`);
console.log('  Seed status: npm run seed:status  (requires dev server running)\n');
