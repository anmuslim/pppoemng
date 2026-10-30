import crypto from 'crypto';
import { promisify } from 'util';
import { config, LEGACY_ENCRYPTION_KEY } from './config.js';

/* ------------------------------------------------------------------ *
 *  Enkripsi password router (AES-256-GCM, terautentikasi)
 *
 *  Format baru   : v2:<iv hex>:<authTag hex>:<ciphertext hex>
 *  Format lama   : <iv hex>:<ciphertext hex>   (AES-256-CBC, tanpa autentikasi)
 *
 *  Data lama tetap bisa dibaca (kompatibel mundur) dan akan dimigrasikan
 *  otomatis ke format baru oleh storage saat startup.
 * ------------------------------------------------------------------ */

function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

const currentKey = deriveKey(config.encryptionKey);
const legacyKey = deriveKey(LEGACY_ENCRYPTION_KEY);

export function encrypt(text: string): string {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', currentKey, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptV2(payload: string, key: Buffer): string | null {
  try {
    const [, ivHex, tagHex, dataHex] = payload.split(':');
    if (!ivHex || !tagHex || dataHex === undefined) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function decryptLegacyCbc(payload: string, key: Buffer): string | null {
  try {
    const parts = payload.split(':');
    if (parts.length !== 2) return null;
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(parts[0], 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(parts[1], 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export interface DecryptResult {
  ok: boolean;
  value: string;
  /** true bila payload masih format lama atau dienkripsi dengan kunci bawaan lama. */
  needsReencrypt: boolean;
}

export function decryptDetailed(payload: string | undefined | null): DecryptResult {
  if (!payload) return { ok: true, value: '', needsReencrypt: false };

  if (payload.startsWith('v2:')) {
    const cur = decryptV2(payload, currentKey);
    if (cur !== null) return { ok: true, value: cur, needsReencrypt: false };
    const old = decryptV2(payload, legacyKey);
    if (old !== null) return { ok: true, value: old, needsReencrypt: true };
    return { ok: false, value: '', needsReencrypt: false };
  }

  const cur = decryptLegacyCbc(payload, currentKey);
  if (cur !== null) return { ok: true, value: cur, needsReencrypt: true };
  const old = decryptLegacyCbc(payload, legacyKey);
  if (old !== null) return { ok: true, value: old, needsReencrypt: true };
  return { ok: false, value: '', needsReencrypt: false };
}

/** Dekripsi; melempar error jelas bila gagal (mis. ENCRYPTION_KEY berubah). */
export function decrypt(payload: string | undefined | null): string {
  const res = decryptDetailed(payload);
  if (!res.ok) {
    throw new Error(
      'Password router tidak dapat didekripsi (ENCRYPTION_KEY kemungkinan berubah). Simpan ulang password router tersebut.'
    );
  }
  return res.value;
}

/* ------------------------------------------------------------------ *
 *  Hash password pengguna (scrypt + salt acak)
 *
 *  Format : scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
 *  Hash lama (SHA-256 tanpa salt, 64 hex) masih bisa diverifikasi dan
 *  otomatis di-upgrade saat pengguna berhasil login.
 * ------------------------------------------------------------------ */

const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions
) => Promise<Buffer>;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;

export const MAX_PASSWORD_LENGTH = 256;

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(plain, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function sha256Hex(plain: string): string {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface PasswordCheck {
  ok: boolean;
  needsRehash: boolean;
}

export async function verifyPassword(plain: string, stored: string | undefined | null): Promise<PasswordCheck> {
  if (typeof plain !== 'string' || !stored) return { ok: false, needsRehash: false };
  if (plain.length > MAX_PASSWORD_LENGTH) return { ok: false, needsRehash: false };

  if (stored.startsWith('scrypt$')) {
    const [, n, r, p, saltB64, hashB64] = stored.split('$');
    try {
      const expected = Buffer.from(hashB64, 'base64');
      const actual = await scryptAsync(plain, Buffer.from(saltB64, 'base64'), expected.length, {
        N: Number(n),
        r: Number(r),
        p: Number(p),
      });
      const ok = safeEqual(actual, expected);
      const weaker = Number(n) < SCRYPT_N || Number(r) < SCRYPT_R;
      return { ok, needsRehash: ok && weaker };
    } catch {
      return { ok: false, needsRehash: false };
    }
  }

  if (/^[0-9a-f]{64}$/i.test(stored)) {
    const ok = safeEqual(Buffer.from(sha256Hex(plain), 'hex'), Buffer.from(stored.toLowerCase(), 'hex'));
    return { ok, needsRehash: ok };
  }
  return { ok: false, needsRehash: false };
}

let dummyHashPromise: Promise<string> | null = null;
/** Menyamakan waktu respons login saat username tidak ada (mencegah user enumeration via timing). */
export async function burnPasswordCheck(plain: string): Promise<void> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('dummy-password-for-timing');
  await verifyPassword(plain, await dummyHashPromise);
}

/** Hash SHA-256 dari password default yang dulu tertanam di source code. */
const KNOWN_DEFAULT_HASHES = new Set(['admin123', 'operator123', 'teknisi123'].map(sha256Hex));
export function isKnownDefaultPasswordHash(stored: string | undefined | null): boolean {
  return Boolean(stored && KNOWN_DEFAULT_HASHES.has(stored.toLowerCase()));
}

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export function generatePassword(length = 16): string {
  let out = '';
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

export function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
