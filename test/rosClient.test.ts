import test from 'node:test';
import assert from 'node:assert/strict';
import { RosPool, RosConnection, SentenceParser, encodeSentence, encodeLength } from '../server/drivers/rosClient.js';
import { RouterCommandError, RouterConnectionError } from '../server/errors.js';
import { startMockRouteros } from './helpers/mockRouteros.js';

const opts = (port: number, extra: Record<string, unknown> = {}) => ({
  host: '127.0.0.1',
  port,
  user: 'api',
  password: 'secret',
  size: 3,
  idleCloseMs: 60_000,
  connectTimeoutMs: 1000,
  commandTimeoutMs: 1500,
  ...extra,
});

test('encodeLength / parser: panjang word 1-5 byte round-trip', () => {
  for (const len of [0, 1, 127, 128, 16383, 16384, 2097151, 2097152, 300000]) {
    const word = 'x'.repeat(len === 0 ? 1 : len);
    const parser = new SentenceParser();
    const out = parser.push(encodeSentence(['!re', `=k=${word}`]));
    assert.equal(out.length, 1);
    assert.equal(out[0][1], `=k=${word}`);
  }
  assert.equal(encodeLength(5).length, 1);
  assert.equal(encodeLength(200).length, 2);
});

test('parser: tahan data terpotong byte-per-byte', () => {
  const buf = Buffer.concat([encodeSentence(['!re', '=name=a']), encodeSentence(['!done'])]);
  const parser = new SentenceParser();
  const got: string[][] = [];
  for (const byte of buf) got.push(...parser.push(Buffer.from([byte])));
  assert.deepEqual(got, [['!re', '=name=a'], ['!done']]);
});

test('login modern + print + !empty (RouterOS 7.18+) menghasilkan array kosong, bukan error', async () => {
  const mock = await startMockRouteros({ emptyReply: true, tables: { '/ppp/active': [] } });
  const pool = new RosPool(opts(mock.port));
  const r = await pool.use((c) => c.write(['/ppp/active/print']));
  assert.deepEqual(r.rows, []);
  pool.close();
  await mock.close();
});

test('login challenge-response (RouterOS < 6.43)', async () => {
  const mock = await startMockRouteros({ legacyLogin: true, tables: { '/ppp/secret': [{ '.id': '*1', name: 'u1' }] } });
  const conn = await RosConnection.connect(opts(mock.port));
  const r = await conn.write(['/ppp/secret/print']);
  assert.equal(r.rows[0].name, 'u1');
  conn.close();
  await mock.close();
});

test('login salah -> RouterConnectionError kind=auth', async () => {
  const mock = await startMockRouteros();
  await assert.rejects(
    () => RosConnection.connect(opts(mock.port, { password: 'salah' })),
    (e: any) => e instanceof RouterConnectionError && e.kind === 'auth'
  );
  await mock.close();
});

test('!trap menjadi RouterCommandError dan koneksi tetap bisa dipakai ulang', async () => {
  const mock = await startMockRouteros({ tables: { '/ppp/secret': [{ '.id': '*1', name: 'dup' }] } });
  const pool = new RosPool(opts(mock.port));
  await assert.rejects(() => pool.use((c) => c.write(['/ppp/secret/add', '=name=dup'])), RouterCommandError);
  const r = await pool.use((c) => c.write(['/ppp/secret/print']));
  assert.equal(r.rows.length, 1);
  assert.equal(mock.stats.connections, 1, 'error perintah tidak boleh mematikan koneksi');
  pool.close();
  await mock.close();
});

test('balasan terpotong-potong tetap terbaca utuh', async () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ '.id': `*${i}`, name: `user${i}`, comment: 'x'.repeat(50) }));
  const mock = await startMockRouteros({ chunked: true, tables: { '/ppp/secret': rows } });
  const pool = new RosPool(opts(mock.port, { commandTimeoutMs: 10_000 }));
  const r = await pool.use((c) => c.write(['/ppp/secret/print']));
  assert.equal(r.rows.length, 200);
  assert.equal(r.rows[199].name, 'user199');
  pool.close();
  await mock.close();
});

test('pool memakai ulang koneksi (login sekali untuk banyak perintah berurutan)', async () => {
  const mock = await startMockRouteros({ tables: { '/ppp/secret': [{ '.id': '*1', name: 'a' }] } });
  const pool = new RosPool(opts(mock.port));
  for (let i = 0; i < 20; i++) await pool.use((c) => c.write(['/ppp/secret/print']));
  assert.equal(mock.stats.connections, 1);
  assert.equal(mock.stats.logins, 1);
  pool.close();
  await mock.close();
});

test('pool membatasi koneksi paralel & mengantrekan sisanya', async () => {
  const mock = await startMockRouteros({ tables: { '/ppp/secret': [{ '.id': '*1', name: 'a' }] } });
  const pool = new RosPool(opts(mock.port, { size: 2 }));
  const results = await Promise.all(Array.from({ length: 12 }, () => pool.use((c) => c.write(['/ppp/secret/print']))));
  assert.equal(results.length, 12);
  assert.ok(mock.stats.connections <= 2, `koneksi: ${mock.stats.connections}`);
  pool.close();
  await mock.close();
});

test('timeout perintah -> RouterConnectionError(timeout) dan koneksi dihancurkan (tanpa zombie)', async () => {
  const mock = await startMockRouteros({ hang: ['/ppp/active'] });
  const pool = new RosPool(opts(mock.port, { commandTimeoutMs: 300 }));
  const t0 = Date.now();
  await assert.rejects(
    () => pool.use((c) => c.write(['/ppp/active/print'])),
    (e: any) => e instanceof RouterConnectionError && e.kind === 'timeout'
  );
  assert.ok(Date.now() - t0 < 1500);
  // Perintah berikutnya tetap berjalan normal di koneksi baru.
  const r = await pool.use((c) => c.write(['/system/identity/print']));
  assert.equal(r.rows[0].name, 'Mock-Router');
  pool.close();
  await mock.close();
});

test('koneksi basi (router memutus) -> perintah baca diulang otomatis di koneksi baru', async () => {
  const mock = await startMockRouteros({ tables: { '/ppp/secret': [{ '.id': '*1', name: 'a' }] } });
  const pool = new RosPool(opts(mock.port));
  await pool.use((c) => c.write(['/ppp/secret/print']), { idempotent: true });
  mock.dropAll(); // router memutus semua koneksi
  await new Promise((r) => setTimeout(r, 50));
  const r = await pool.use((c) => c.write(['/ppp/secret/print']), { idempotent: true });
  assert.equal(r.rows.length, 1);
  pool.close();
  await mock.close();
});

test('router mati -> ECONNREFUSED dipetakan ke pesan jelas', async () => {
  const mock = await startMockRouteros();
  const port = mock.port;
  await mock.close();
  await assert.rejects(
    () => RosConnection.connect(opts(port)),
    (e: any) => e instanceof RouterConnectionError && e.kind === 'refused'
  );
});
