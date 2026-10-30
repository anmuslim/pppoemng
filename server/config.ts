import 'dotenv/config';
import path from 'path';

/**
 * Konfigurasi terpusat + validasi saat startup.
 * Di mode production, secret yang lemah/hilang membuat server menolak berjalan
 * (lebih baik gagal jelas daripada diam-diam memakai kunci bawaan yang publik).
 */

const env = process.env;

/** Nilai bawaan lama yang tertanam di source code publik. TIDAK AMAN, hanya dipakai untuk migrasi/dev. */
export const LEGACY_JWT_SECRET = 'pppoe-manager-super-secret-jwt-key-2026';
export const LEGACY_ENCRYPTION_KEY = 'mikrotik-pppoe-aes-key-32chars!!';

const DEV_JWT_SECRET = 'dev-only-jwt-secret-do-not-use-in-production-0000';
const DEV_ENCRYPTION_KEY = 'dev-only-encryption-key-do-not-use-in-production-0000';

function int(name: string, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function bool(name: string, def = false): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const isProduction = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

const PLACEHOLDER = /^(changeme|ganti|replace|your[_-]|<hasil|example|secret$|password$)/i;

function isWeakSecret(v: string | undefined): boolean {
  if (!v) return true;
  if (v.length < 32) return true;
  if (v === LEGACY_JWT_SECRET || v === LEGACY_ENCRYPTION_KEY) return true;
  if (PLACEHOLDER.test(v)) return true;
  return false;
}

export function resolveDbType(): 'mysql' | 'json' {
  const explicit = (env.DB_TYPE || '').toLowerCase();
  if (explicit === 'json') return 'json';
  if (explicit === 'mysql') return 'mysql';
  const host = env.DB_HOST || env.MYSQL_HOST;
  const user = env.DB_USER || env.MYSQL_USER;
  const database = env.DB_NAME || env.MYSQL_DATABASE;
  return host && user && database ? 'mysql' : 'json';
}

export const config = {
  isProduction,
  isTest,
  port: int('PORT', 3000, 1, 65535),
  host: env.HOST || '0.0.0.0',

  jwtSecret: env.JWT_SECRET || DEV_JWT_SECRET,
  encryptionKey: env.ENCRYPTION_KEY || DEV_ENCRYPTION_KEY,
  jwtExpiresIn: env.JWT_EXPIRES_IN || '12h',

  /** Isi bila di belakang Nginx/Cloudflare: "1" (satu proxy), "loopback", atau daftar IP/CIDR. */
  trustProxy: env.TRUST_PROXY || (isProduction ? 'loopback' : false),

  dataDir: path.resolve(env.DATA_DIR || path.join(process.cwd(), 'data')),
  dbType: resolveDbType(),
  /** Izinkan beralih ke file JSON bila MySQL gagal. Default MATI: data tidak boleh bercabang diam-diam. */
  dbFallbackJson: bool('DB_FALLBACK_JSON', false),
  dbConnectRetries: int('DB_CONNECT_RETRIES', 10, 0, 100),
  dbConnectRetryDelayMs: int('DB_CONNECT_RETRY_DELAY_MS', 3000, 100, 60000),

  adminUsername: (env.ADMIN_USERNAME || 'admin').trim().toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD || '',

  enableDemo: bool('ENABLE_DEMO', false),

  auditRetentionDays: int('AUDIT_RETENTION_DAYS', 180, 1, 3650),
  eventRetentionDays: int('EVENT_RETENTION_DAYS', 30, 1, 3650),
  auditCacheSize: int('AUDIT_CACHE_SIZE', 1000, 100, 20000),

  loginMaxFailuresPerIp: int('LOGIN_MAX_FAILURES_PER_IP', 8, 1, 1000),
  loginMaxFailuresPerUser: int('LOGIN_MAX_FAILURES_PER_USER', 20, 1, 1000),
  loginLockMinutes: int('LOGIN_LOCK_MINUTES', 15, 1, 1440),
  apiRateLimitPerMinute: int('API_RATE_LIMIT_PER_MINUTE', 900, 30, 100000),

  router: {
    connectTimeoutMs: int('ROUTER_CONNECT_TIMEOUT_MS', 5000, 500, 60000),
    commandTimeoutMs: int('ROUTER_COMMAND_TIMEOUT_MS', 12000, 1000, 120000),
    /** Batas total satu operasi ke router (termasuk antre pool). */
    operationTimeoutMs: int('ROUTER_OP_TIMEOUT_MS', 15000, 2000, 180000),
    poolSize: int('ROUTER_POOL_SIZE', 3, 1, 10),
    idleCloseMs: int('ROUTER_IDLE_CLOSE_MS', 45000, 5000, 600000),
    maxParallelRouters: int('ROUTER_MAX_PARALLEL', 6, 1, 64),
    /** Verifikasi sertifikat TLS router (API-SSL & REST https). Default mati karena RouterOS memakai sertifikat self-signed. */
    tlsVerify: bool('ROUTEROS_TLS_VERIFY', false),
    /** Opsional: daftar cipher untuk RouterOS lama (mis. "DEFAULT:@SECLEVEL=0"). */
    tlsCiphers: env.ROUTEROS_TLS_CIPHERS || undefined,
    breakerFailureThreshold: int('ROUTER_BREAKER_THRESHOLD', 2, 1, 20),
    breakerBaseCooldownMs: int('ROUTER_BREAKER_COOLDOWN_MS', 5000, 500, 600000),
    breakerMaxCooldownMs: int('ROUTER_BREAKER_MAX_COOLDOWN_MS', 60000, 1000, 3600000),
  },

  cache: {
    secretsTtlMs: int('CACHE_SECRETS_TTL_MS', 15000, 0, 600000),
    activeTtlMs: int('CACHE_ACTIVE_TTL_MS', 3000, 0, 600000),
    configTtlMs: int('CACHE_CONFIG_TTL_MS', 10000, 0, 600000),
    resourceTtlMs: int('CACHE_RESOURCE_TTL_MS', 8000, 0, 600000),
  },
};

/**
 * Validasi konfigurasi. Mengembalikan daftar masalah FATAL (production) dan peringatan.
 */
export function validateConfig(): { fatal: string[]; warnings: string[] } {
  const fatal: string[] = [];
  const warnings: string[] = [];

  if (isProduction) {
    if (isWeakSecret(env.JWT_SECRET)) {
      fatal.push(
        'JWT_SECRET belum diatur / terlalu lemah (minimal 32 karakter acak). Buat dengan: openssl rand -hex 32'
      );
    }
    if (isWeakSecret(env.ENCRYPTION_KEY)) {
      fatal.push(
        'ENCRYPTION_KEY belum diatur / terlalu lemah (minimal 32 karakter acak). Buat dengan: openssl rand -hex 32'
      );
    }
    if (env.JWT_SECRET && env.ENCRYPTION_KEY && env.JWT_SECRET === env.ENCRYPTION_KEY) {
      warnings.push('JWT_SECRET dan ENCRYPTION_KEY sebaiknya berbeda.');
    }
  } else if (!isTest) {
    if (!env.JWT_SECRET || !env.ENCRYPTION_KEY) {
      warnings.push('JWT_SECRET/ENCRYPTION_KEY belum diatur: memakai kunci DEV sementara (jangan dipakai di production).');
    }
  }

  if (config.dbType === 'mysql' && !(env.DB_HOST || env.MYSQL_HOST)) {
    fatal.push('DB_TYPE=mysql tetapi DB_HOST belum diatur.');
  }
  if (config.router.tlsVerify === false && isProduction) {
    warnings.push(
      'Verifikasi TLS router dimatikan (ROUTEROS_TLS_VERIFY=false). Aman bila router di jaringan manajemen privat; aktifkan bila memakai sertifikat valid.'
    );
  }
  return { fatal, warnings };
}
