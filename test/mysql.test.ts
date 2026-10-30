import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { execFileSync } from 'child_process';

// Dijalankan hanya bila ada MySQL/MariaDB uji:  TEST_MYSQL=1 npm test
const enabled = process.env.TEST_MYSQL === '1';

Object.assign(process.env, {
  NODE_ENV: 'test', DB_TYPE: 'mysql', DB_HOST: '127.0.0.1', DB_USER: 'pppoe', DB_PASSWORD: 'dbpass123', DB_NAME: 'pppoe_test',
  DB_CONNECT_RETRIES: '1', DB_CONNECT_RETRY_DELAY_MS: '200', LOG_LEVEL: 'error',
  JWT_SECRET: 'j'.repeat(48), ENCRYPTION_KEY: 'm'.repeat(48), ADMIN_PASSWORD: 'AdminPass123',
});

const sql = (q: string) => execFileSync('mariadb', ['-e', q], { encoding: 'utf-8' });

test('MySQL: skema lama (dari schema.sql repo) + data lama -> upgrade mulus', { skip: !enabled }, async () => {
  sql('DROP DATABASE IF EXISTS pppoe_test; CREATE DATABASE pppoe_test CHARACTER SET utf8mb4;');
  const ddl = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf-8').replace(/pppoe_manager/g, 'pppoe_test');
  execFileSync('mariadb', [], { input: ddl });
  const crypto = await import('crypto');
  const sha = crypto.createHash('sha256').update('admin123').digest('hex');
  sql(`USE pppoe_test; INSERT INTO users (id,username,name,role,passwordHash,allowedMenus,status,createdAt) VALUES ('u1','admin','Admin','superadmin','${sha}','["dashboard"]','active','2025-01-01');`);

  const { storage } = await import('../server/storage.js');
  const { encrypt } = await import('../server/crypto.js');
  await storage.init();
  assert.equal(storage.getMode(), 'mysql');
  assert.equal(storage.getUsers().length, 1, 'tidak membuat admin kedua karena user sudah ada');
  assert.equal(storage.hasDefaultPassword(storage.getUser('admin')!), true);

  // router: tambah, ubah, duplikat nama
  await storage.addRouter({ id: 'r1', name: 'Core', host: '10.0.0.1', port: 8728, username: 'api', encryptedPassword: encrypt('pw'), mode: 'API', notes: '', status: 'checking' } as any);
  await assert.rejects(() => storage.addRouter({ id: 'r2', name: 'core', host: 'x', port: 1, username: 'u', mode: 'API', status: 'online' } as any), /sudah terdaftar/);
  await storage.updateRouter('r1', { host: '10.0.0.2', ['name`=1 --' as any]: 'inj', port: 9000 });
  assert.equal(sql("SELECT host,port FROM pppoe_test.routers WHERE id='r1'").includes('10.0.0.2\t9000'), true);

  // audit + runtime status + restart
  storage.addAuditLog({ username: 'a', routerId: 'r1', routerName: 'Core', action: 'CREATE', targetType: 'SECRET', targetName: 's', details: 'd' });
  storage.updateRouterRuntime('r1', { status: 'offline', lastError: 'mati' });
  await storage.flush();
  await storage.__resetForTests();
  await storage.init();
  assert.equal(storage.getRouter('r1')!.host, '10.0.0.2');
  assert.equal(storage.getRouter('r1')!.status, 'offline');
  assert.ok(storage.getAuditLogs().some((l) => l.targetName === 's'));

  // user ops + superadmin terakhir terlindungi
  const u = await storage.createUser({ username: 'op', name: 'Op', role: 'operator', passwordHash: 'x', allowedMenus: ['dashboard'] });
  await assert.rejects(() => storage.createUser({ username: 'OP', name: 'Op', role: 'operator', passwordHash: 'x', allowedMenus: [] }), /sudah digunakan/);
  await assert.rejects(() => storage.updateUser('u1', { status: 'suspended' }), /terakhir/);
  await storage.deleteUser(u.id);
  assert.equal(sql("SELECT COUNT(*) c FROM pppoe_test.users").includes('1'), true);

  // retensi: log lama dihapus
  sql("INSERT INTO pppoe_test.audit_logs (id,timestamp,username,routerId,routerName,action,targetType,targetName) VALUES ('old','2000-01-01T00:00:00.000Z','a','r','r','CREATE','SECRET','old')");
  await storage.prune();
  await storage.flush();
  assert.equal(sql("SELECT COUNT(*) c FROM pppoe_test.audit_logs WHERE id='old'").includes('0'), true);

  // beban: 300 audit log bersamaan tidak hilang & berurutan
  for (let i = 0; i < 300; i++) storage.addAuditLog({ username: 'load', routerId: 'r1', routerName: 'Core', action: 'UPDATE', targetType: 'SECRET', targetName: `n${i}` });
  await storage.flush();
  assert.equal(sql("SELECT COUNT(*) c FROM pppoe_test.audit_logs WHERE username='load'").includes('300'), true);
  await storage.close();
});

test('MySQL mati: init gagal jelas (TIDAK diam-diam pindah ke JSON)', { skip: !enabled }, async () => {
  const { execFileSync: ex } = await import('child_process');
  const out = ex(process.execPath, ['--import', 'tsx', '-e', `
    process.env.DB_PORT='3999'; process.env.DB_CONNECT_RETRIES='1'; process.env.DB_CONNECT_RETRY_DELAY_MS='100';
    const { storage } = await import('./server/storage.js');
    try { await storage.init(); console.log('INIT_OK'); } catch (e) { console.log('INIT_FAILED:' + e.message.slice(0, 40)); }
    process.exit(0);
  `, '--input-type=module'], { encoding: 'utf-8', env: { ...process.env, DATA_DIR: '/tmp/should-not-be-used' } });
  assert.match(out, /INIT_FAILED:Tidak dapat terhubung ke MySQL/);
  assert.equal(fs.existsSync('/tmp/should-not-be-used/db.json'), false, 'tidak boleh membuat db.json cadangan diam-diam');
});
