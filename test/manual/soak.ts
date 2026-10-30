/**
 * Uji beban/ketahanan manual:  npx tsx test/manual/soak.ts [detik]
 * Router tiruan 3000 secret + 800 sesi aktif, banyak klien paralel, lalu router dimatikan/dihidupkan berulang.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startMockRouteros } from '../helpers/mockRouteros.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pppoe-soak-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATA_DIR: tmp, DB_TYPE: 'json', LOG_LEVEL: 'error',
  JWT_SECRET: 'j'.repeat(48), ENCRYPTION_KEY: 'e'.repeat(48), ADMIN_PASSWORD: 'AdminPass123',
  ROUTER_CONNECT_TIMEOUT_MS: '800', ROUTER_COMMAND_TIMEOUT_MS: '3000', API_RATE_LIMIT_PER_MINUTE: '1000000',
});
const DURATION = (Number(process.argv[2]) || 20) * 1000;

const secrets = Array.from({ length: 3000 }, (_, i) => ({ '.id': `*${i}`, name: `user${i}`, password: 'pw', profile: 'p10', service: 'pppoe', disabled: i % 25 === 0 ? 'true' : 'false', comment: 'pelanggan perumahan blok A' }));
const active = Array.from({ length: 800 }, (_, i) => ({ '.id': `*a${i}`, name: `user${i}`, service: 'pppoe', 'caller-id': `AA:BB:CC:00:${(i >> 8).toString(16)}:${(i & 255).toString(16)}`, address: `10.10.${i >> 8}.${i & 255}`, uptime: '3h2m' }));
const queues = Array.from({ length: 800 }, (_, i) => ({ '.id': `*q${i}`, name: `<pppoe-user${i}>`, target: `10.10.${i >> 8}.${i & 255}/32`, rate: `${i * 1000}/${i * 5000}`, bytes: `${i * 1e6}/${i * 5e6}` }));
const mock = await startMockRouteros({ emptyReply: true, tables: { '/ppp/secret': secrets, '/ppp/active': active, '/queue/simple': queues, '/ppp/profile': [{ '.id': '*p', name: 'p10' }] } });

const { storage } = await import('../../server/storage.js');
const { routerManager } = await import('../../server/drivers/manager.js');
const { createApp, errorHandler } = await import('../../server/app.js');
await storage.init();
const app = createApp();
app.use(errorHandler);
const server = await new Promise<any>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

const api = async (method: string, url: string, token?: string, body?: unknown) => {
  const t0 = performance.now();
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, json, ms: performance.now() - t0 };
};

const token = (await api('POST', '/api/auth/login', undefined, { username: 'admin', password: 'AdminPass123' })).json.token;
const add = await api('POST', '/api/routers', token, { name: 'CORE', host: '127.0.0.1', port: mock.port, username: 'api', password: 'secret', mode: 'API' });
const rid = add.json.data.id;

const pct = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0;
const mb = () => (process.memoryUsage().rss / 1048576).toFixed(0);
const heapAfterGc = () => { (global as any).gc?.(); return (process.memoryUsage().heapUsed / 1048576).toFixed(1); };
const stats = { ok: 0, fail: 0, lat: [] as number[] };

async function phase(name: string, workers: number, ms: number, paths: Array<[string, string]>) {
  stats.ok = 0; stats.fail = 0; stats.lat = [];
  const c0 = mock.stats.connections, cmd0 = mock.stats.commands.length;
  const end = Date.now() + ms;
  await Promise.all(Array.from({ length: workers }, async (_, w) => {
    let i = w;
    while (Date.now() < end) {
      const [m, u] = paths[i++ % paths.length];
      const r = await api(m, u, token);
      r.status === 200 ? stats.ok++ : stats.fail++;
      stats.lat.push(r.ms);
    }
  }));
  console.log(`${name.padEnd(34)} req=${String(stats.ok + stats.fail).padStart(6)} gagal=${String(stats.fail).padStart(4)} p50=${pct(stats.lat, .5).toFixed(0).padStart(4)}ms p95=${pct(stats.lat, .95).toFixed(0).padStart(4)}ms | koneksi baru ke router=${mock.stats.connections - c0} perintah ke router=${mock.stats.commands.length - cmd0} | RSS=${mb()}MB heap(setelah GC)=${heapAfterGc()}MB`);
}

console.log(`Router tiruan: ${secrets.length} secret, ${active.length} sesi aktif. Durasi tiap fase ~${DURATION / 1000}s\n`);
const mixed: Array<[string, string]> = [['GET', '/api/overview'], ['GET', `/api/routers/${rid}/ppp/active`], ['GET', `/api/routers/${rid}/ppp/secrets`], ['GET', `/api/routers/${rid}/ppp/profiles`], ['GET', '/api/routers']];
const rss0 = Number(mb());
await phase('30 klien (dashboard+secrets+active)', 30, DURATION, mixed);
await phase('100 klien paralel', 100, DURATION / 2, mixed);
for (let i = 2; i <= 4; i++) await phase(`ulang beban #${i} (30 klien)`, 30, DURATION / 2, mixed);

// Router putus-nyambung: pastikan pulih & tidak ada kebocoran koneksi
console.log('\nRouter dimatikan, lalu dihidupkan lagi 3x ...');
let recovered = 0;
for (let round = 0; round < 3; round++) {
  mock.dropAll();
  const down = await startMockRouteros({ tables: {} }); await down.close(); // port acak, tidak dipakai
  const t0 = Date.now();
  let okAfter = 0;
  while (Date.now() - t0 < 6000) {
    const r = await api('GET', `/api/routers/${rid}/ppp/active`, token);
    if (r.status === 200) { okAfter++; break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (okAfter) recovered++;
}
console.log(`pulih otomatis setelah koneksi diputus: ${recovered}/3 ronde`);
console.log(`koneksi terbuka ke router sekarang: ${mock.stats.openNow} (batas pool = 3)`);

global.gc?.();
const rss1 = Number(mb());
console.log(`\nMemori RSS: awal ${rss0}MB -> akhir ${rss1}MB`);
await new Promise((r) => server.close(r));
await routerManager.shutdown(); await mock.close(); await storage.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
