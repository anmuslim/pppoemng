import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'j'.repeat(48), ENCRYPTION_KEY: 'k'.repeat(48), LOG_LEVEL: 'error', ROUTER_COMMAND_TIMEOUT_MS: '1200' });

const { RouterosRestDriver } = await import('../server/drivers/routerosRestDriver.js');
const { RouterConnectionError, RouterCommandError } = await import('../server/errors.js');

type Row = Record<string, string>;
const secrets: Row[] = [{ '.id': '*1', name: 'a', profile: 'default', disabled: 'false' }];
const log: string[] = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Basic ${Buffer.from('api:pw').toString('base64')}`) return send(401, { error: 401 });
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    log.push(`${req.method} ${url.pathname}${url.search}`);
    const body = raw ? JSON.parse(raw) : {};
    if (url.pathname === '/rest/system/resource') return send(200, { version: '7.18', 'cpu-load': '3', 'free-memory': '1048576', 'total-memory': '2097152', uptime: '1d' });
    if (url.pathname === '/rest/system/identity') return send(200, { name: 'REST-Router' });
    if (url.pathname === '/rest/ppp/active') return send(200, []);
    if (url.pathname === '/rest/hang') return;
    if (url.pathname === '/rest/ppp/secret') {
      if (req.method === 'GET') {
        const name = url.searchParams.get('name');
        return send(200, secrets.filter((s) => !name || s.name === name));
      }
      if (req.method === 'PUT') {
        if (secrets.some((s) => s.name === body.name)) return send(400, { error: 400, message: 'Bad Request', detail: 'failure: already have such entry' });
        secrets.push({ '.id': `*${secrets.length + 1}`, ...body });
        return send(201, body);
      }
    }
    const m = /^\/rest\/ppp\/secret\/(.+)$/.exec(url.pathname);
    if (m) {
      const row = secrets.find((s) => s['.id'] === decodeURIComponent(m[1]));
      if (!row) return send(404, { error: 404, message: 'Not Found', detail: 'no such item' });
      if (req.method === 'PATCH') Object.assign(row, body);
      if (req.method === 'DELETE') secrets.splice(secrets.indexOf(row), 1);
      return send(200, {});
    }
    send(404, { error: 404, message: 'Not Found', detail: 'no such command or directory' });
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as any).port;
const { encrypt } = await import('../server/crypto.js');

const cfg: any = { id: 'r', name: 'REST', host: '127.0.0.1', port, username: 'api', mode: 'REST', encryptedPassword: encrypt('pw') };

test('REST: resource + identity + list kosong tanpa error', async () => {
  const d = new RouterosRestDriver(cfg, 'pw');
  const info = await d.getSystemResource();
  assert.equal(info.identity, 'REST-Router');
  assert.equal(info.totalMemory, 2);
  assert.deepEqual(await d.getActive(), []);
  await d.close();
});

test('REST: CRUD memakai lookup ?name= (bukan mengunduh seluruh tabel) dan menolak item yang tidak ada', async () => {
  const d = new RouterosRestDriver(cfg, 'pw');
  await d.createSecret({ name: 'b', password: 'x', service: 'pppoe', profile: 'default', disabled: false });
  await assert.rejects(() => d.createSecret({ name: 'b' } as any), (e: any) => e instanceof RouterCommandError && /already have/.test(e.message));
  log.length = 0;
  await d.setSecretDisabled('b', true);
  assert.ok(log.some((l) => l.includes('GET /rest/ppp/secret?name=b')), log.join(' | '));
  assert.equal(secrets.find((s) => s.name === 'b')!.disabled, 'yes');
  await d.deleteSecret('b');
  assert.equal(secrets.some((s) => s.name === 'b'), false);
  await assert.rejects(() => d.deleteSecret('tidak-ada'), RouterCommandError);
  const stats = await d.getSecretStats();
  assert.deepEqual(stats, { total: 1, disabled: 0 });
  await d.close();
});

test('REST: password salah -> error auth (kind=auth)', async () => {
  const d = new RouterosRestDriver(cfg, 'salah');
  await assert.rejects(() => d.getSystemResource(), (e: any) => e instanceof RouterConnectionError && e.kind === 'auth');
  await d.close();
});

test('REST: router tidak merespons -> timeout; port mati -> refused', async () => {
  const d = new RouterosRestDriver(cfg, 'pw');
  const t0 = Date.now();
  await assert.rejects(() => (d as any).request('GET', '/hang', undefined, 400), (e: any) => e.kind === 'timeout');
  assert.ok(Date.now() - t0 < 1500);
  const dead = new RouterosRestDriver({ ...cfg, port: 1 }, 'pw');
  await assert.rejects(() => dead.getSystemResource(), (e: any) => e instanceof RouterConnectionError && ['refused', 'network'].includes(e.kind));
  await d.close();
  await dead.close();
});

test.after(() => server.close());
