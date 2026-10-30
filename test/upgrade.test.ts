import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pppoe-upg-'));
fs.copyFileSync(new URL('./helpers/legacy-db.json', import.meta.url), path.join(tmp, 'db.json'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATA_DIR: tmp, DB_TYPE: 'json', LOG_LEVEL: 'error',
  JWT_SECRET: 'j'.repeat(48), ENCRYPTION_KEY: 'n'.repeat(48), // kunci BARU, berbeda dari kunci bawaan lama
});

const { storage } = await import('../server/storage.js');
const { decryptDetailed, verifyPassword } = await import('../server/crypto.js');

test('upgrade dari db.json versi lama: data utuh, enkripsi dimigrasikan, hash lama tetap bisa login & di-upgrade', async () => {
  const before = JSON.parse(fs.readFileSync(path.join(tmp, 'db.json'), 'utf-8'));
  await storage.init();

  assert.equal(storage.getRouters().length, before.routers.length, 'tidak ada router hilang');
  assert.equal(storage.getUsers().length, before.users.length, 'tidak ada user hilang');
  assert.equal(storage.getUsers().length > 0 && !storage.getUser('admin')!.passwordHash.startsWith('scrypt$'), true, 'hash lama dipertahankan sampai login');

  for (const r of storage.getRouters()) {
    if (!r.encryptedPassword) continue;
    assert.ok(r.encryptedPassword.startsWith('v2:'), `router ${r.name} dimigrasi ke GCM`);
    const d = decryptDetailed(r.encryptedPassword);
    assert.equal(d.ok && !d.needsReencrypt, true);
    assert.equal(d.value, 'demoRouterPass123!', 'isi password tidak berubah');
  }

  const admin = storage.getUser('admin')!;
  assert.equal(storage.hasDefaultPassword(admin), true, 'password default terdeteksi -> UI akan memperingatkan');
  assert.deepEqual(await verifyPassword('admin123', admin.passwordHash), { ok: true, needsRehash: true });
  await storage.close();
});

test('restart sungguhan: data & migrasi bertahan, tidak ada duplikasi, tidak ada seed demo otomatis', async () => {
  await storage.__resetForTests();
  const routersBefore = JSON.parse(fs.readFileSync(path.join(tmp, 'db.json'), 'utf-8')).routers.length;
  await storage.init();
  assert.equal(storage.getRouters().length, routersBefore);
  assert.equal(storage.getRouter('router-core-idc')?.encryptedPassword?.startsWith('v2:'), true);
  // tulis log audit, flush, restart -> log masih ada
  storage.addAuditLog({ username: 't', routerId: 'system', routerName: 'S', action: 'TEST', targetType: 'ROUTER', targetName: 'x', details: 'persist?' });
  await storage.close();
  await storage.__resetForTests();
  await storage.init();
  assert.ok(storage.getAuditLogs().some((l) => l.details === 'persist?'));
  await storage.close();
});

test('db.json rusak: tidak ditimpa, dipulihkan dari .bak bila ada, dan server tetap bisa start', async () => {
  await storage.__resetForTests();
  const f = path.join(tmp, 'db.json');
  fs.copyFileSync(f, `${f}.bak`);
  fs.writeFileSync(f, '{"routers": [ {BROKEN');
  await storage.init();
  assert.ok(storage.getRouters().length > 0, 'pulih dari cadangan');
  assert.ok(fs.readdirSync(tmp).some((n) => n.startsWith('db.json.corrupt-')), 'salinan file rusak disimpan untuk forensik');
  await storage.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
