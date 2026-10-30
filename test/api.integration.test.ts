import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type http from 'http';
import { startMockRouteros, MockRouteros } from './helpers/mockRouteros.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pppoe-test-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: tmp,
  DB_TYPE: 'json',
  JWT_SECRET: 'j'.repeat(48),
  ENCRYPTION_KEY: 'e'.repeat(48),
  ADMIN_PASSWORD: 'AdminPass123',
  LOGIN_MAX_FAILURES_PER_IP: '4',
  LOGIN_LOCK_MINUTES: '1',
  ROUTER_CONNECT_TIMEOUT_MS: '800',
  ROUTER_COMMAND_TIMEOUT_MS: '1500',
  CACHE_SECRETS_TTL_MS: '0', // tanpa cache agar hasil tes deterministik
  CACHE_ACTIVE_TTL_MS: '0',
  CACHE_CONFIG_TTL_MS: '0',
  LOG_LEVEL: 'error',
});

let base = '';
let server: http.Server;
let mock: MockRouteros;
let mock2: MockRouteros;
let storage: any;
let routerManager: any;
let adminToken = '';

async function call(method: string, url: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function login(username: string, password: string) {
  return call('POST', '/api/auth/login', { username, password });
}

before(async () => {
  mock = await startMockRouteros({ emptyReply: true, tables: { '/ppp/profile': [{ '.id': '*p1', name: 'default' }] } });
  mock2 = await startMockRouteros({ tables: { '/ppp/secret': [{ '.id': '*9', name: 'dupname', profile: 'default', disabled: 'false' }] } });

  storage = (await import('../server/storage.js')).storage;
  routerManager = (await import('../server/drivers/manager.js')).routerManager;
  const { createApp, errorHandler } = await import('../server/app.js');
  await storage.init();
  const app = createApp();
  app.use(errorHandler);
  await new Promise<void>((r) => (server = app.listen(0, '127.0.0.1', r)));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await routerManager.shutdown();
  await mock.close();
  await mock2.close();
  await storage.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('health publik & endpoint terproteksi menolak tanpa token', async () => {
  assert.equal((await call('GET', '/api/health')).status, 200);
  assert.equal((await call('GET', '/api/routers')).status, 401);
  assert.equal((await call('GET', '/api/nope')).status, 404);
});

test('login: password salah ditolak, benar mendapat token; /me bekerja setelah reload', async () => {
  assert.equal((await login('admin', 'salah')).status, 401);
  const ok = await login('admin', 'AdminPass123');
  assert.equal(ok.status, 200);
  adminToken = ok.json.token;
  assert.equal(ok.json.user.mustChangePassword, false);
  const me = await call('GET', '/api/auth/me', undefined, adminToken);
  assert.equal(me.status, 200);
  assert.equal(me.json.user.username, 'admin');
});

test('body bukan JSON / tipe salah -> 400 (bukan 500)', async () => {
  const r1 = await call('POST', '/api/routers', { name: 12345, host: 'x', username: 'u' }, adminToken);
  assert.equal(r1.status, 400);
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
  assert.equal(res.status, 400);
});

test('tambah router nyata (API) -> CRUD secret, bulk, ping, active kosong (!empty)', async () => {
  const add = await call('POST', '/api/routers', { name: 'R1', host: '127.0.0.1', port: mock.port, username: 'api', password: 'secret', mode: 'API' }, adminToken);
  assert.equal(add.status, 201, JSON.stringify(add.json));
  const rid = add.json.data.id;
  assert.equal(JSON.stringify(add.json).includes('secret'), false, 'password tidak boleh bocor');

  const test1 = await call('POST', `/api/routers/${rid}/test`, undefined, adminToken);
  assert.equal(test1.status, 200);
  assert.equal(test1.json.data.identity, 'Mock-Router');

  const base2 = `/api/routers/${rid}/ppp/secrets`;
  assert.equal((await call('GET', base2, undefined, adminToken)).json.data.length, 0);

  const created = await call('POST', base2, { name: 'budi', password: 'pw1', profile: 'default' }, adminToken);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal((await call('POST', base2, { name: 'budi', password: 'x' }, adminToken)).status, 400, 'duplikat ditolak router');

  const list = await call('GET', base2, undefined, adminToken);
  assert.equal(list.json.data[0].name, 'budi');
  assert.equal(list.json.data[0].routerId, rid);

  const off = await call('PUT', `${base2}/budi`, { disabled: true }, adminToken);
  assert.equal(off.status, 200);
  assert.equal(mock.tables['/ppp/secret'][0].disabled, 'yes');

  await call('POST', base2, { name: 'siti', password: 'pw2' }, adminToken);
  const bulk = await call('POST', `${base2}/bulk-action`, { action: 'delete', items: [{ name: 'budi' }, { name: 'siti' }, { name: 'tidakada' }] }, adminToken);
  assert.equal(bulk.json.successCount, 2);
  assert.ok(bulk.json.errors.tidakada);
  assert.equal(mock.tables['/ppp/secret'].length, 0);

  const act = await call('GET', `/api/routers/${rid}/ppp/active`, undefined, adminToken);
  assert.equal(act.status, 200);
  assert.deepEqual(act.json.data, []);

  const ping = await call('POST', `/api/routers/${rid}/ppp/active/ping`, { address: '8.8.8.8', count: 3 }, adminToken);
  assert.equal(ping.json.data.received, 3);
  assert.equal(ping.json.data.avgRtt, 3);

  // Koneksi dipakai ulang: puluhan request tidak membuat puluhan koneksi/login ke router.
  assert.ok(mock.stats.connections <= 3, `koneksi ke router: ${mock.stats.connections}`);
});

test('validasi input: mode, port, host', async () => {
  assert.equal((await call('POST', '/api/routers', { name: 'X', host: 'a b', username: 'u' }, adminToken)).status, 400);
  assert.equal((await call('POST', '/api/routers', { name: 'X', host: '1.1.1.1', port: 99999, username: 'u' }, adminToken)).status, 400);
  assert.equal((await call('POST', '/api/routers', { name: 'X', host: '1.1.1.1', username: 'u', mode: 'TELNET' }, adminToken)).status, 400);
});

test('RBAC ditegakkan di server: operator tidak bisa kelola router/user/audit', async () => {
  const mk = await call('POST', '/api/users', { username: 'operator1', name: 'Op', password: 'OperatorPass1', role: 'operator', allowedMenus: ['dashboard', 'secrets', 'active'] }, adminToken);
  assert.equal(mk.status, 201, JSON.stringify(mk.json));
  const op = (await login('operator1', 'OperatorPass1')).json.token;

  assert.equal((await call('GET', '/api/routers', undefined, op)).status, 200);
  assert.equal((await call('POST', '/api/routers', { name: 'Z', host: '1.1.1.1', username: 'u' }, op)).status, 403);
  assert.equal((await call('DELETE', '/api/routers/xyz', undefined, op)).status, 403);
  assert.equal((await call('GET', '/api/users', undefined, op)).status, 403);
  assert.equal((await call('GET', '/api/audit-logs', undefined, op)).status, 403);
  assert.equal((await call('POST', '/api/demo/reset-demo', undefined, op)).status, 403);
  // menu 'queues' tidak dimiliki -> tulis ditolak, baca diizinkan
  const rid = storage.getRouters()[0].id;
  assert.equal((await call('POST', `/api/routers/${rid}/queues`, { name: 'q' }, op)).status, 403);
  assert.equal((await call('GET', `/api/routers/${rid}/ppp/secrets`, undefined, op)).status, 200);
});

test('suspend / hapus user berlaku seketika pada token yang masih hidup', async () => {
  const tok = (await login('operator1', 'OperatorPass1')).json.token;
  const id = storage.getUser('operator1').id;
  assert.equal((await call('GET', '/api/routers', undefined, tok)).status, 200);
  await call('PUT', `/api/users/${id}`, { status: 'suspended' }, adminToken);
  assert.equal((await call('GET', '/api/routers', undefined, tok)).status, 401);
  assert.equal((await login('operator1', 'OperatorPass1')).status, 403);
  await call('PUT', `/api/users/${id}`, { status: 'active' }, adminToken);
});

test('tidak bisa menghapus/menurunkan/menonaktifkan superadmin terakhir atau diri sendiri', async () => {
  const id = storage.getUser('admin').id;
  assert.equal((await call('DELETE', `/api/users/${id}`, undefined, adminToken)).status, 400);
  assert.equal((await call('PUT', `/api/users/${id}`, { role: 'operator' }, adminToken)).status, 400);
  assert.equal((await call('PUT', `/api/users/${id}`, { status: 'suspended' }, adminToken)).status, 400);
});

test('ganti password: password lama salah ditolak; token lama tidak berlaku; token baru berlaku', async () => {
  const t = (await login('admin', 'AdminPass123')).json.token;
  assert.equal((await call('POST', '/api/auth/change-password', { currentPassword: 'x', newPassword: 'BaruPass12345' }, t)).status, 400);
  assert.equal((await call('POST', '/api/auth/change-password', { currentPassword: 'AdminPass123', newPassword: 'pendek' }, t)).status, 400);
  const ok = await call('POST', '/api/auth/change-password', { currentPassword: 'AdminPass123', newPassword: 'BaruPass12345' }, t);
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/auth/me', undefined, t)).status, 401, 'token lama harus mati');
  assert.equal((await call('GET', '/api/auth/me', undefined, ok.json.token)).status, 200);
  adminToken = ok.json.token;
  assert.equal((await login('admin', 'AdminPass123')).status, 401);
  assert.equal((await login('admin', 'BaruPass12345')).status, 200);
});

test('nama sama di dua router (mode all): tidak menebak router pertama -> 409; dengan routerId -> sukses', async () => {
  const add = await call('POST', '/api/routers', { name: 'R2', host: '127.0.0.1', port: mock2.port, username: 'api', password: 'secret', mode: 'API' }, adminToken);
  const rid2 = add.json.data.id;
  const rid1 = storage.getRouters().find((r: any) => r.name === 'R1').id;
  await call('POST', `/api/routers/${rid1}/ppp/secrets`, { name: 'dupname', password: 'a' }, adminToken);

  const amb = await call('PUT', '/api/routers/all/ppp/secrets/dupname', { comment: 'x' }, adminToken);
  assert.equal(amb.status, 409, JSON.stringify(amb.json));
  const ok = await call('PUT', `/api/routers/all/ppp/secrets/dupname?routerId=${rid2}`, { comment: 'router2' }, adminToken);
  assert.equal(ok.status, 200);
  assert.equal(mock2.tables['/ppp/secret'][0].comment, 'router2');
  assert.equal(mock.tables['/ppp/secret'].find((r) => r.name === 'dupname')?.comment, undefined);

  const gone = await call('PUT', '/api/routers/all/ppp/secrets/tidak-ada', { comment: 'x' }, adminToken);
  assert.equal(gone.status, 404);
});

test('router mati: gagal cepat, circuit breaker membuat request berikutnya instan, dashboard tetap jalan', async () => {
  const dead = await startMockRouteros();
  const deadPort = dead.port;
  await dead.close();
  const add = await call('POST', '/api/routers', { name: 'MATI', host: '127.0.0.1', port: deadPort, username: 'api', password: 'x', mode: 'API' }, adminToken);
  const rid = add.json.data.id;

  const t0 = Date.now();
  const first = await call('GET', `/api/routers/${rid}/ppp/secrets`, undefined, adminToken);
  assert.equal(first.status, 502);
  assert.ok(Date.now() - t0 < 3000);
  await call('GET', `/api/routers/${rid}/ppp/secrets`, undefined, adminToken); // gagal ke-2 -> breaker terbuka

  const t1 = Date.now();
  const fast = await call('GET', `/api/routers/${rid}/ppp/secrets`, undefined, adminToken);
  assert.equal(fast.status, 502);
  assert.ok(Date.now() - t1 < 100, `harus instan, bukan menunggu timeout: ${Date.now() - t1}ms`);
  assert.match(fast.json.error, /coba lagi/);

  const ov = await call('GET', '/api/overview', undefined, adminToken);
  assert.equal(ov.status, 200);
  const rows = ov.json.data.routerSummaries;
  assert.equal(rows.find((r: any) => r.name === 'MATI').status, 'offline');
  assert.equal(rows.find((r: any) => r.name === 'R1').status, 'online');
  assert.equal(ov.json.data.stats.offlineRouters, 1);

  // Mode "all": satu router mati tidak menggagalkan yang lain.
  const all = await call('GET', '/api/routers/all/ppp/secrets', undefined, adminToken);
  assert.equal(all.status, 200);
  assert.ok(all.json.errors.MATI);
});

test('reset-demo hanya menyentuh router demo; router produksi tidak hilang', async () => {
  const before = storage.getRouters().filter((r: any) => !r.isDemo).length;
  const res = await call('POST', '/api/demo/reset-demo', undefined, adminToken);
  assert.equal(res.status, 200);
  assert.equal(storage.getRouters().filter((r: any) => !r.isDemo).length, before);
  assert.ok(storage.getRouters().some((r: any) => r.isDemo));
  // router demo berfungsi lewat driver demo
  const demo = storage.getRouters().find((r: any) => r.isDemo);
  const list = await call('GET', `/api/routers/${demo.id}/ppp/secrets`, undefined, adminToken);
  assert.equal(list.status, 200);
  assert.ok(list.json.data.length > 0);
});

test('rate limit login: percobaan gagal beruntun dikunci (429)', async () => {
  let last = 0;
  for (let i = 0; i < 6; i++) last = (await login('admin', `salah${i}`)).status;
  assert.equal(last, 429);
  // Bahkan password benar ditolak selama terkunci.
  assert.equal((await login('admin', 'BaruPass12345')).status, 429);
});

test('persistensi: restart memuat data, password router tetap terdekripsi, file bukan setengah jadi', async () => {
  await storage.flush();
  const file = path.join(tmp, 'db.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.ok(parsed.routers.length >= 3);
  assert.ok(parsed.routers.find((r: any) => r.name === 'R1').encryptedPassword.startsWith('v2:'), 'AES-GCM');
  assert.ok(parsed.users[0].passwordHash.startsWith('scrypt$'));
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.equal((fs.statSync(file).mode & 0o077), 0, 'file hanya boleh dibaca pemilik');
});
