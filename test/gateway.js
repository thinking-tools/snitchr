const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 8080;
const LOG_FILE = '/logs/requests.jsonl';
const SCRIPTS_DIR = '/scripts';

const C = {
  r: '\x1b[0m', d: '\x1b[2m',
  green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m',
};

let n = 0;
const events = [];

fs.mkdirSync('/logs', { recursive: true });

const server = http.createServer((req, res) => {
  // ── Static scripts ──
  if (req.method === 'GET' && req.url.startsWith('/static/scripts/')) {
    const file = path.join(SCRIPTS_DIR, req.url.replace('/static/scripts/', ''));
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(fs.readFileSync(file));
      console.log(`${C.d}GET ${req.url} → served${C.r}`);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  // ── Test API: query recorded events ──
  if (req.method === 'GET' && req.url === '/api/test/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events, count: events.length }));
    return;
  }

  // ── Test API: query events by type ──
  if (req.method === 'GET' && req.url.startsWith('/api/test/events?')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const type = params.get('type');
    const t = params.get('t');
    const source = params.get('source');
    let filtered = events;
    if (type) filtered = filtered.filter(e => e.body?.d?.type === type);
    if (t) filtered = filtered.filter(e => e.body?.t === Number(t));
    if (source) filtered = filtered.filter(e => e.source === source);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events: filtered, count: filtered.length }));
    return;
  }

  // ── Test API: reset events ──
  if (req.method === 'POST' && req.url === '/api/test/reset') {
    events.length = 0;
    n = 0;
    fs.writeFileSync(LOG_FILE, '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    console.log(`${C.yellow}━━━ RESET ━━━${C.r}`);
    return;
  }

  // ── All other requests: parse body and record ──
  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', () => {
    n++;
    const ts = new Date().toISOString();
    let parsed = null;
    try { parsed = body ? JSON.parse(body) : null; } catch {}

    // Extract machine ID from ingest URL
    const ingestMatch = req.url.match(/^\/m\/([^/]+)\/ingest$/);
    const source = ingestMatch ? ingestMatch[1] : undefined;

    const entry = { n, ts, method: req.method, path: req.url, source, body: parsed ?? (body || null) };
    events.push(entry);

    let color = C.d;
    let label = req.url;
    if (req.url === '/register' && req.method === 'POST') {
      color = C.green;
      label = 'REGISTER';
    } else if (ingestMatch) {
      const t = parsed?.t ?? -1;
      color = t === 0 ? C.cyan : t >= 3 ? C.red : C.yellow;
      label = t === 0 ? 'HEARTBEAT' : t === 5 ? 'SHUTDOWN' : `EVENT t:${t}`;
    }

    console.log(`${color}━━━ #${n} ${label} [${ts}] ━━━${C.r}`);
    console.log(`${C.d}${req.method} ${req.url}${C.r}`);
    if (parsed) console.log(JSON.stringify(parsed, null, 2));

    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');

    if (req.url === '/register' && req.method === 'POST') {
      const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      const id = `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
      const secret = hex(48);
      console.log(`${color}  → id: ${id}, secret: ${secret.slice(0, 12)}...${C.r}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, secret }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    }
  });
});

server.listen(PORT, () => {
  console.log(`${C.green}Mock gateway on :${PORT}${C.r}`);
  console.log(`${C.d}Logs → ${LOG_FILE}${C.r}`);
  console.log(`${C.d}Test API → /api/test/events, /api/test/reset${C.r}\n`);
});
