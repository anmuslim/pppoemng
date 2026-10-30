import mysql, { Pool, PoolOptions } from 'mysql2/promise';
import { config } from './config.js';
import { logger } from './logger.js';

let pool: Pool | null = null;

export function isMySQLEnabled(): boolean {
  return config.dbType === 'mysql';
}

export function getMySQLConfig(): PoolOptions {
  const env = process.env;
  return {
    host: env.DB_HOST || env.MYSQL_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || env.MYSQL_PORT) || 3306,
    user: env.DB_USER || env.MYSQL_USER || 'root',
    password: env.DB_PASSWORD || env.MYSQL_PASSWORD || '',
    database: env.DB_NAME || env.MYSQL_DATABASE || 'pppoe_manager',
    waitForConnections: true,
    connectionLimit: Number(env.DB_POOL_SIZE) || 10,
    maxIdle: 5,
    idleTimeout: 60_000,
    queueLimit: 200, // batasi antrean agar tidak menumpuk tanpa batas saat DB macet
    connectTimeout: 10_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    charset: 'utf8mb4',
    // Nilai besar (mis. demo_data) tetap aman
    supportBigNumbers: true,
    dateStrings: true,
  };
}

export function getMySQLPool(): Pool | null {
  if (!isMySQLEnabled()) return null;
  if (!pool) {
    pool = mysql.createPool(getMySQLConfig());
    // Error pada koneksi idle tidak boleh menjatuhkan proses.
    (pool as any).on?.('error', (err: Error) => logger.warn('MySQL pool error', { message: err.message }));
  }
  return pool;
}

export async function closeMySQLPool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    try {
      await p.end();
    } catch (err: any) {
      logger.warn('Gagal menutup pool MySQL', { message: err?.message });
    }
  }
}

const TRANSIENT_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'ER_CON_COUNT_ERROR',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'POOL_CLOSED',
]);

export function isTransientMySQLError(err: any): boolean {
  return Boolean(err && (TRANSIENT_CODES.has(err.code) || err.fatal === true));
}

export function isDuplicateEntryError(err: any): boolean {
  return Boolean(err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062));
}

export async function testMySQLConnection(): Promise<{ success: boolean; version?: string; error?: string }> {
  try {
    const p = getMySQLPool();
    if (!p) return { success: false, error: 'Konfigurasi MySQL belum lengkap.' };
    const [rows] = await p.query('SELECT VERSION() AS version');
    return { success: true, version: (rows as any[])[0]?.version || 'Unknown' };
  } catch (err: any) {
    const cfg = getMySQLConfig();
    const hint =
      err?.code === 'ECONNREFUSED'
        ? ` (MySQL tidak berjalan atau port ${cfg.port} salah di ${cfg.host})`
        : err?.code === 'ER_ACCESS_DENIED_ERROR'
          ? ' (user/password MySQL salah)'
          : err?.code === 'ER_BAD_DB_ERROR'
            ? ` (database '${cfg.database}' belum dibuat)`
            : '';
    return { success: false, error: `${err?.message || 'Gagal tersambung ke MySQL'}${hint}` };
  }
}

const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export async function initMySQLTables(): Promise<void> {
  const p = getMySQLPool();
  if (!p) return;

  await p.query(`
    CREATE TABLE IF NOT EXISTS \`routers\` (
      \`id\` VARCHAR(64) NOT NULL PRIMARY KEY,
      \`name\` VARCHAR(128) NOT NULL UNIQUE,
      \`host\` VARCHAR(128) NOT NULL,
      \`port\` INT NOT NULL DEFAULT 8728,
      \`username\` VARCHAR(128) NOT NULL,
      \`encryptedPassword\` TEXT NULL,
      \`mode\` VARCHAR(32) NOT NULL DEFAULT 'API',
      \`notes\` TEXT NULL,
      \`isDemo\` TINYINT(1) NOT NULL DEFAULT 0,
      \`status\` VARCHAR(32) NOT NULL DEFAULT 'online',
      \`lastSeen\` VARCHAR(64) NULL,
      \`lastError\` TEXT NULL,
      \`identity\` VARCHAR(128) NULL,
      \`version\` VARCHAR(128) NULL,
      \`uptime\` VARCHAR(128) NULL,
      \`cpuLoad\` INT NOT NULL DEFAULT 0,
      \`freeMemory\` INT NOT NULL DEFAULT 0,
      \`totalMemory\` INT NOT NULL DEFAULT 0,
      \`boardName\` VARCHAR(128) NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ${TABLE_OPTS};
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS \`users\` (
      \`id\` VARCHAR(64) NOT NULL PRIMARY KEY,
      \`username\` VARCHAR(64) NOT NULL UNIQUE,
      \`name\` VARCHAR(128) NOT NULL,
      \`role\` VARCHAR(32) NOT NULL DEFAULT 'operator',
      \`passwordHash\` VARCHAR(255) NOT NULL,
      \`allowedMenus\` TEXT NOT NULL,
      \`status\` VARCHAR(32) NOT NULL DEFAULT 'active',
      \`createdAt\` VARCHAR(64) NOT NULL,
      \`lastLogin\` VARCHAR(64) NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ${TABLE_OPTS};
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS \`audit_logs\` (
      \`id\` VARCHAR(64) NOT NULL PRIMARY KEY,
      \`timestamp\` VARCHAR(64) NOT NULL,
      \`username\` VARCHAR(64) NOT NULL,
      \`routerId\` VARCHAR(64) NOT NULL,
      \`routerName\` VARCHAR(128) NOT NULL,
      \`action\` VARCHAR(32) NOT NULL,
      \`targetType\` VARCHAR(32) NOT NULL,
      \`targetName\` VARCHAR(128) NOT NULL,
      \`details\` TEXT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX \`idx_audit_timestamp\` (\`timestamp\`),
      INDEX \`idx_audit_routerId\` (\`routerId\`),
      INDEX \`idx_audit_username\` (\`username\`)
    ) ${TABLE_OPTS};
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS \`recent_events\` (
      \`id\` VARCHAR(64) NOT NULL PRIMARY KEY,
      \`timestamp\` VARCHAR(64) NOT NULL,
      \`type\` VARCHAR(32) NOT NULL,
      \`username\` VARCHAR(64) NOT NULL,
      \`routerName\` VARCHAR(128) NOT NULL,
      \`ipAddress\` VARCHAR(64) NOT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX \`idx_events_timestamp\` (\`timestamp\`),
      INDEX \`idx_events_username\` (\`username\`)
    ) ${TABLE_OPTS};
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS \`demo_data\` (
      \`routerId\` VARCHAR(64) NOT NULL PRIMARY KEY,
      \`dataJson\` LONGTEXT NOT NULL,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ${TABLE_OPTS};
  `);

  // Migrasi aman: kolom passwordHash lama VARCHAR(128) -> 255 (hash scrypt lebih panjang dari SHA-256).
  const [cols] = await p.query(
    `SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'passwordHash'`
  );
  const len = Number((cols as any[])[0]?.len || 0);
  if (len > 0 && len < 255) {
    await p.query('ALTER TABLE `users` MODIFY `passwordHash` VARCHAR(255) NOT NULL');
    logger.info('Migrasi skema: users.passwordHash diperbesar menjadi VARCHAR(255)');
  }
}
