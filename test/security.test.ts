import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'j'.repeat(48), ENCRYPTION_KEY: 'k'.repeat(48), LOG_LEVEL: 'error' });

const c = await import('../server/crypto.js');

function legacyCbc(text: string, secret: string) {
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return `${iv.toString('hex')}:${Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('hex')}`;
}

test('AES-GCM round trip; tiap enkripsi berbeda (IV acak)', () => {
  const a = c.encrypt('rahasia!');
  assert.ok(a.startsWith('v2:'));
  assert.notEqual(a, c.encrypt('rahasia!'));
  assert.equal(c.decrypt(a), 'rahasia!');
});

test('GCM mendeteksi data dimanipulasi (integritas)', () => {
  const parts = c.encrypt('rahasia!').split(':');
  parts[3] = (parts[3][0] === 'a' ? 'b' : 'a') + parts[3].slice(1);
  assert.equal(c.decryptDetailed(parts.join(':')).ok, false);
  assert.throws(() => c.decrypt(parts.join(':')));
});

test('migrasi: data CBC lama (kunci bawaan lama / kunci saat ini) tetap terbaca & ditandai perlu re-enkripsi', () => {
  const fromDefaultKey = legacyCbc('pw-lama', 'mikrotik-pppoe-aes-key-32chars!!');
  const r1 = c.decryptDetailed(fromDefaultKey);
  assert.deepEqual([r1.ok, r1.value, r1.needsReencrypt], [true, 'pw-lama', true]);

  const fromCurrentKey = legacyCbc('pw-lama2', 'k'.repeat(48));
  const r2 = c.decryptDetailed(fromCurrentKey);
  assert.deepEqual([r2.ok, r2.value, r2.needsReencrypt], [true, 'pw-lama2', true]);
  assert.equal(c.decryptDetailed(c.encrypt('baru')).needsReencrypt, false);
});

test('kunci salah -> gagal dengan pesan jelas, bukan string kosong diam-diam', () => {
  const other = legacyCbc('x', 'kunci-lain-yang-tidak-dikenal-sama-sekali');
  assert.equal(c.decryptDetailed(other).ok, false);
  assert.throws(() => c.decrypt(other), /tidak dapat didekripsi/);
});

test('password: scrypt+salt; hash SHA-256 lama diverifikasi dan ditandai upgrade', async () => {
  const h = await c.hashPassword('Sandi-Kuat-1');
  assert.ok(h.startsWith('scrypt$'));
  assert.notEqual(h, await c.hashPassword('Sandi-Kuat-1'), 'salt acak');
  assert.deepEqual(await c.verifyPassword('Sandi-Kuat-1', h), { ok: true, needsRehash: false });
  assert.equal((await c.verifyPassword('salah', h)).ok, false);

  const legacy = crypto.createHash('sha256').update('admin123').digest('hex');
  assert.deepEqual(await c.verifyPassword('admin123', legacy), { ok: true, needsRehash: true });
  assert.equal((await c.verifyPassword('x', legacy)).ok, false);
  assert.equal(c.isKnownDefaultPasswordHash(legacy), true);
  assert.equal(c.isKnownDefaultPasswordHash(h), false);
});

test('password: input aneh tidak membuat crash', async () => {
  assert.equal((await c.verifyPassword('x'.repeat(5000), 'scrypt$1$1$1$a$b')).ok, false);
  assert.equal((await c.verifyPassword('x', 'sampah')).ok, false);
  assert.equal((await c.verifyPassword('x', '')).ok, false);
  assert.equal((await c.verifyPassword(undefined as any, 'abc')).ok, false);
});

test('generatePassword: panjang & karakter aman', () => {
  const p = c.generatePassword(20);
  assert.equal(p.length, 20);
  assert.match(p, /^[A-Za-z0-9]+$/);
});
