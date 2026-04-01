/**
 * Seeds fake heartbeat + event data into the running dev server.
 * Requires: npm run dev (in another terminal) + npm run seed (already run)
 */

const BASE = process.env.SNITCHR_URL || 'http://localhost:8787';

const ingest = async (id, secret, t, d) => {
  const res = await fetch(`${BASE}/m/${id}/ingest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ t, d }),
  });
  if (!res.ok) throw new Error(`${id} ingest t:${t} → ${res.status}`);
};

const now = Math.floor(Date.now() / 1000);
const rnd = (min, max) => +(min + Math.random() * (max - min)).toFixed(1);
const rndInt = (min, max) => Math.floor(min + Math.random() * (max - min));

const hb = (up, cpu, memUsed, memTotal, disk, procs, ports, users) => ({
  ts: now, up, cpu, mem: [memUsed, memTotal], disk: [disk],
  load: [rnd(0, cpu / 25), rnd(0, cpu / 30), rnd(0, cpu / 35)],
  procs, net: [rndInt(1e6, 5e9), rndInt(1e6, 3e9)], ports, users,
});

// EventLevel: 0=HEARTBEAT 1=INFO 2=WARN 3=ERROR 4=CRITICAL 5=SHUTDOWN
const eventTypes = [
  { t: 2, d: { type: 'ssh_login', msg: 'Accepted publickey for deploy from 10.0.1.5 port 54321' } },
  { t: 3, d: { type: 'file_change', msg: 'File modified: /etc/ssh/sshd_config' } },
  { t: 2, d: { type: 'new_port', msg: 'New listening port :9090 (prometheus)' } },
  { t: 2, d: { type: 'cpu_spike', msg: 'CPU at 94%' } },
  { t: 2, d: { type: 'ssh_login', msg: 'Accepted password for root from 203.0.113.42 port 22' } },
  { t: 3, d: { type: 'file_change', msg: 'File modified: /etc/passwd' } },
  { t: 2, d: { type: 'new_process', msg: 'New process: /usr/bin/nmap' } },
  { t: 2, d: { type: 'disk_high', msg: 'Disk at 92%' } },
];

const machines = [
  { id: 'machine-debian-001', secret: 'dev-secret-debian-001', heartbeat: hb(1_209_600, 23.4, 1420, 4096, 42, 187, '22,80,443', 'root,deploy'), events: [eventTypes[0]] },
  { id: 'machine-ubuntu-001', secret: 'dev-secret-ubuntu-001', heartbeat: hb(604_800, 67.8, 6800, 8192, 71, 312, '22,5432', 'root,postgres'), events: [eventTypes[1], eventTypes[2], eventTypes[3]] },
  { id: 'machine-debian-002', secret: 'dev-secret-staging-002', heartbeat: hb(172_800, 5.1, 512, 2048, 18, 94, '22,8080', 'root'), events: [] },
  { id: 'machine-debian-003', secret: 'dev-secret-003', heartbeat: hb(2_592_000, 45.2, 3200, 8192, 55, 241, '22,80,443,8443', 'root,www-data'), events: [eventTypes[4]] },
  { id: 'machine-ubuntu-002', secret: 'dev-secret-004', heartbeat: hb(2_419_200, 31.6, 2800, 4096, 38, 198, '22,80,443', 'root,deploy'), events: [] },
  { id: 'machine-debian-004', secret: 'dev-secret-005', heartbeat: hb(1_814_400, 12.3, 4500, 16384, 29, 156, '22,6379,11211', 'root,redis'), events: [eventTypes[6]] },
  { id: 'machine-ubuntu-003', secret: 'dev-secret-006', heartbeat: hb(1_728_000, 8.7, 2100, 8192, 22, 134, '22,6379', 'root'), events: [] },
  { id: 'machine-debian-005', secret: 'dev-secret-007', heartbeat: hb(1_555_200, 52.1, 3900, 8192, 61, 278, '22,5672,15672', 'root,rabbitmq'), events: [eventTypes[2]] },
  { id: 'machine-ubuntu-004', secret: 'dev-secret-008', heartbeat: hb(1_296_000, 78.3, 7200, 8192, 83, 345, '22,5672', 'root,rabbitmq,deploy'), events: [eventTypes[3], eventTypes[7]] },
  { id: 'machine-debian-006', secret: 'dev-secret-009', heartbeat: hb(1_036_800, 41.5, 5600, 16384, 44, 203, '22,5432,5433', 'root,postgres'), events: [eventTypes[5]] },
  { id: 'machine-ubuntu-005', secret: 'dev-secret-010', heartbeat: hb(864_000, 19.8, 1800, 4096, 31, 167, '22,5432', 'root,postgres'), events: [] },
  { id: 'machine-debian-007', secret: 'dev-secret-011', heartbeat: hb(777_600, 33.2, 2600, 4096, 47, 189, '22,3000,9090', 'root,grafana'), events: [eventTypes[0]] },
  { id: 'machine-ubuntu-006', secret: 'dev-secret-012', heartbeat: hb(691_200, 56.9, 5100, 8192, 63, 267, '22,3000,9090', 'root,prometheus'), events: [eventTypes[2]] },
  { id: 'machine-debian-008', secret: 'dev-secret-013', heartbeat: hb(518_400, 15.4, 980, 2048, 21, 112, '22,80,443', 'root'), events: [] },
  { id: 'machine-ubuntu-007', secret: 'dev-secret-014', heartbeat: hb(432_000, 27.6, 1700, 4096, 35, 145, '22,80,443', 'root,www-data'), events: [] },
  { id: 'machine-debian-009', secret: 'dev-secret-015', heartbeat: hb(345_600, 88.1, 7800, 8192, 91, 389, '22,80,443,8080', 'root,deploy'), events: [eventTypes[3], eventTypes[7], eventTypes[6]] },
  { id: 'machine-ubuntu-008', secret: 'dev-secret-016', heartbeat: hb(259_200, 62.4, 4200, 8192, 58, 234, '22,80,443', 'root,deploy'), events: [eventTypes[0]] },
  { id: 'machine-debian-010', secret: 'dev-secret-017', heartbeat: hb(172_800, 9.3, 1200, 4096, 15, 108, '22,80,8080', 'root'), events: [] },
  { id: 'machine-ubuntu-009', secret: 'dev-secret-018', heartbeat: hb(86_400, 38.7, 3100, 8192, 41, 201, '22,80,443', 'root,deploy'), events: [eventTypes[4]] },
  { id: 'machine-debian-011', secret: 'dev-secret-019', heartbeat: hb(86_400, 3.2, 680, 2048, 12, 87, '22', 'root'), events: [] },
];

try {
  for (const m of machines) {
    for (const ev of m.events) {
      await ingest(m.id, m.secret, ev.t, ev.d);
      console.log(`  ${m.id}  event t:${ev.t}  ${ev.d.type}`);
    }
    await ingest(m.id, m.secret, 0, m.heartbeat);
    console.log(`  ${m.id}  heartbeat  cpu:${m.heartbeat.cpu}%`);
  }
  console.log(`\n  ${machines.length} machines seeded. Refresh dashboard to see metrics.\n`);
} catch (e) {
  console.error(`\n  Failed: ${e.message}`);
  console.error('  Make sure dev server is running: npm run dev\n');
  process.exit(1);
}
