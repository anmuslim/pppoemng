import fs from 'fs';
import path from 'path';
import type { Pool } from 'mysql2/promise';
import { RouterConfig } from './drivers/types.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { HttpError, conflict } from './errors.js';
import { encrypt, decryptDetailed, hashPassword, generatePassword, isKnownDefaultPasswordHash, randomId } from './crypto.js';
import {
  isMySQLEnabled,
  getMySQLPool,
  initMySQLTables,
  testMySQLConnection,
  closeMySQLPool,
  isTransientMySQLError,
  isDuplicateEntryError,
} from './mysql.js';

/* ------------------------------------------------------------------ *
 *  Tipe data
 * ------------------------------------------------------------------ */

export interface AuditLogItem {
  id: string;
  timestamp: string;
  username: string;
  routerId: string;
  routerName: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'DISCONNECT' | 'ENABLE' | 'DISABLE' | 'TEST';
  targetType: 'SECRET' | 'ACTIVE' | 'PROFILE' | 'QUEUE' | 'POOL' | 'ROUTER';
  targetName: string;
  details?: string;
}

export const ALL_MENU_KEYS = [
  'dashboard',
  'routers',
  'secrets',
  'active',
  'profiles',
  'queues',
  'pools',
  'audit',
  'users',
] as const;

export type MenuKey = (typeof ALL_MENU_KEYS)[number];
export type UserRole = 'superadmin' | 'operator' | 'technician';
export const USER_ROLES: UserRole[] = ['superadmin', 'operator', 'technician'];

export interface AdminUser {
  id: string;
  username: string;
  name: string;
  role: UserRole;
  /** scrypt$... (atau SHA-256 hex lama yang di-upgrade saat login berikutnya) */
  passwordHash: string;
  createdAt: string;
  allowedMenus: string[];
  status?: 'active' | 'suspended';
  lastLogin?: string;
}

interface RecentEvent {
  id: string;
  timestamp: string;
  type: 'connected' | 'disconnected';
  username: string;
  routerName: string;
  ipAddress: string;
}

type DemoStore = {
  secrets: any[];
  profiles: any[];
  queues: any[];
  pools: any[];
  active: any[];
};

interface AppDatabase {
  routers: RouterConfig[];
  users: AdminUser[];
  auditLogs: AuditLogItem[];
  recentEvents: RecentEvent[];
  demoData?: Record<string, DemoStore>;
}

const ROUTER_COLUMNS = [
  'name',
  'host',
  'port',
  'username',
  'encryptedPassword',
  'mode',
  'notes',
  'isDemo',
  'status',
  'lastSeen',
  'lastError',
  'identity',
  'version',
  'uptime',
  'cpuLoad',
  'freeMemory',
  'totalMemory',
  'boardName',
] as const;

type RouterColumn = (typeof ROUTER_COLUMNS)[number];
const ROUTER_COLUMN_SET = new Set<string>(ROUTER_COLUMNS);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const DEFAULT_OPERATOR_MENUS = ['dashboard', 'secrets', 'active'];

/* ------------------------------------------------------------------ *
 *  StorageManager
 *
 *  - Data utama dipegang di memori (baca cepat & sinkron).
 *  - Mutasi PENTING (user, router) ditulis ke penyimpanan DULU dan baru
 *    diterapkan ke memori -> API tidak pernah mengaku sukses bila gagal simpan.
 *  - Mutasi frekuensi tinggi (audit log, event, status router) memakai
 *    antrean berurutan / debounce agar tidak memblokir event loop.
 *  - Mode MySQL TIDAK pernah diam-diam beralih ke JSON (data tidak bercabang)
 *    kecuali DB_FALLBACK_JSON=true.
 * ------------------------------------------------------------------ */

class StorageManager {
  private db: AppDatabase = { routers: [], users: [], auditLogs: [], recentEvents: [] };
  private mode: 'mysql' | 'json' | 'uninitialized' = 'uninitialized';
  private initPromise: Promise<void> | null = null;

  // MySQL: antrean berurutan
  private chain: Promise<unknown> = Promise.resolve();
  private pendingWrites = 0;

  // JSON: tulis atomik + debounce
  private jsonTimer: NodeJS.Timeout | null = null;
  private jsonWriting: Promise<void> | null = null;
  private jsonDirty = false;
  private lastBackupAt = 0;

  private maintenanceTimer: NodeJS.Timeout | null = null;
  private runtimePersist = new Map<string, { at: number; status?: string }>();

  public lastWriteError?: { message: string; at: string };
  public failedWrites = 0;

  private get dataDir() {
    return config.dataDir;
  }
  private get dbFile() {
    return path.join(this.dataDir, 'db.json');
  }

  /* ----------------------------- init ----------------------------- */

  public init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit().catch((err) => {
        this.initPromise = null; // izinkan percobaan ulang
        throw err;
      });
    }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    if (isMySQLEnabled()) {
      const ok = await this.connectMySQLWithRetry();
      if (ok) {
        await initMySQLTables();
        await this.loadFromMySQL();
        this.mode = 'mysql';
        logger.info(
          `Terhubung ke MySQL. Memuat ${this.db.routers.length} router, ${this.db.users.length} pengguna, ${this.db.auditLogs.length} audit log.`
        );
      } else if (config.dbFallbackJson) {
        logger.warn('MySQL tidak dapat dihubungi. DB_FALLBACK_JSON=true -> memakai file JSON lokal (data/db.json).');
        this.mode = 'json';
        this.loadJson();
      } else {
        throw new Error(
          'Tidak dapat terhubung ke MySQL setelah beberapa percobaan. Periksa layanan MySQL & kredensial di .env ' +
            '(atau set DB_TYPE=json / DB_FALLBACK_JSON=true bila memang ingin memakai file JSON).'
        );
      }
    } else {
      this.mode = 'json';
      logger.info(`Mode penyimpanan: file JSON (${this.dbFile}). MySQL tidak dikonfigurasi.`);
      this.loadJson();
    }

    await this.bootstrapAdminIfNeeded();
    await this.migrateRouterSecrets();

    if (config.enableDemo && this.db.routers.length === 0) {
      await this.resetDemo();
      logger.info('ENABLE_DEMO=true: router demo ditambahkan.');
    }

    this.warnDefaultPasswords();
    await this.prune().catch((e) => logger.warn('Pruning awal gagal', { message: e?.message }));
    this.maintenanceTimer = setInterval(() => {
      this.prune().catch((e) => logger.warn('Pruning berkala gagal', { message: e?.message }));
    }, 6 * 60 * 60 * 1000);
    this.maintenanceTimer.unref();
  }

  private async connectMySQLWithRetry(): Promise<boolean> {
    const attempts = config.dbConnectRetries + 1;
    for (let i = 1; i <= attempts; i++) {
      const test = await testMySQLConnection();
      if (test.success) return true;
      logger.warn(`MySQL belum siap (percobaan ${i}/${attempts}): ${test.error}`);
      if (i < attempts) await sleep(config.dbConnectRetryDelayMs);
    }
    return false;
  }

  public getMode(): 'mysql' | 'json' | 'uninitialized' {
    return this.mode;
  }

  public getHealth() {
    return {
      mode: this.mode,
      pendingWrites: this.pendingWrites + (this.jsonDirty ? 1 : 0),
      failedWrites: this.failedWrites,
      lastWriteError: this.lastWriteError,
    };
  }

  /* --------------------------- memuat data --------------------------- */

  private async loadFromMySQL(): Promise<void> {
    const pool = getMySQLPool();
    if (!pool) return;

    const [userRows] = await pool.query('SELECT * FROM users');
    this.db.users = (userRows as any[]).map((r) => ({
      id: r.id,
      username: r.username,
      name: r.name,
      role: r.role,
      passwordHash: r.passwordHash,
      allowedMenus: this.parseMenus(r.allowedMenus, r.role),
      status: r.status || 'active',
      createdAt: r.createdAt,
      lastLogin: r.lastLogin || undefined,
    }));

    const [routerRows] = await pool.query('SELECT * FROM routers');
    this.db.routers = (routerRows as any[]).map((r) => ({
      id: r.id,
      name: r.name,
      host: r.host,
      port: Number(r.port) || 8728,
      username: r.username,
      encryptedPassword: r.encryptedPassword || undefined,
      mode: r.mode || 'API',
      notes: r.notes || '',
      isDemo: Boolean(r.isDemo),
      status: r.status || 'online',
      lastSeen: r.lastSeen || undefined,
      lastError: r.lastError || undefined,
      identity: r.identity || undefined,
      version: r.version || undefined,
      uptime: r.uptime || undefined,
      cpuLoad: Number(r.cpuLoad) || 0,
      freeMemory: Number(r.freeMemory) || 0,
      totalMemory: Number(r.totalMemory) || 0,
      boardName: r.boardName || undefined,
    }));

    const [auditRows] = await pool.query('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?', [
      config.auditCacheSize,
    ]);
    this.db.auditLogs = (auditRows as any[]).map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      username: r.username,
      routerId: r.routerId,
      routerName: r.routerName,
      action: r.action,
      targetType: r.targetType,
      targetName: r.targetName,
      details: r.details || undefined,
    }));

    const [eventRows] = await pool.query('SELECT * FROM recent_events ORDER BY timestamp DESC LIMIT 50');
    this.db.recentEvents = (eventRows as any[]).map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      type: r.type,
      username: r.username,
      routerName: r.routerName,
      ipAddress: r.ipAddress,
    }));

    const [demoRows] = await pool.query('SELECT * FROM demo_data');
    this.db.demoData = {};
    for (const d of demoRows as any[]) {
      try {
        this.db.demoData[d.routerId] = JSON.parse(d.dataJson);
      } catch {
        logger.warn(`demo_data untuk router ${d.routerId} rusak dan diabaikan`);
      }
    }
  }

  private parseMenus(raw: unknown, role: string): string[] {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) return parsed.filter((m) => typeof m === 'string');
    } catch {
      /* jatuh ke default */
    }
    return role === 'superadmin' ? [...ALL_MENU_KEYS] : [...DEFAULT_OPERATOR_MENUS];
  }

  private readJsonFile(file: string): AppDatabase | null {
    try {
      if (!fs.existsSync(file)) return null;
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed as AppDatabase;
    } catch (err: any) {
      logger.error(`Gagal membaca ${file}: ${err?.message}`);
      return null;
    }
  }

  private loadJson(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });

    let loaded = this.readJsonFile(this.dbFile);
    if (!loaded && fs.existsSync(this.dbFile)) {
      // File ada tetapi rusak: JANGAN ditimpa. Simpan salinan lalu coba cadangan.
      const quarantine = `${this.dbFile}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(this.dbFile, quarantine);
        logger.error(`db.json rusak. Salinan disimpan di ${quarantine}. Mencoba memulihkan dari db.json.bak ...`);
      } catch {
        /* abaikan */
      }
      loaded = this.readJsonFile(`${this.dbFile}.bak`);
      if (loaded) logger.warn('Berhasil memulihkan data dari db.json.bak');
    }

    const db = loaded || { routers: [], users: [], auditLogs: [], recentEvents: [] };
    this.db = {
      routers: Array.isArray(db.routers) ? db.routers : [],
      users: Array.isArray(db.users) ? db.users : [],
      auditLogs: Array.isArray(db.auditLogs) ? db.auditLogs : [],
      recentEvents: Array.isArray(db.recentEvents) ? db.recentEvents : [],
      demoData: db.demoData && typeof db.demoData === 'object' ? db.demoData : {},
    };

    let modified = false;
    for (const u of this.db.users) {
      if (!u.allowedMenus || u.allowedMenus.length === 0) {
        u.allowedMenus = u.role === 'superadmin' ? [...ALL_MENU_KEYS] : [...DEFAULT_OPERATOR_MENUS];
        modified = true;
      }
      if (!u.status) {
        u.status = 'active';
        modified = true;
      }
    }
    if (modified) this.markJsonDirty();
  }

  /* ------------------------ bootstrap & migrasi ------------------------ */

  private async bootstrapAdminIfNeeded(): Promise<void> {
    if (this.db.users.length > 0) return;

    const username = config.adminUsername || 'admin';
    const generated = !config.adminPassword;
    const password = config.adminPassword || generatePassword(16);
    const user = await this.createUser({
      username,
      name: 'Administrator Utama',
      role: 'superadmin',
      passwordHash: await hashPassword(password),
      allowedMenus: [...ALL_MENU_KEYS],
      status: 'active',
    });

    if (generated) {
      const line = '='.repeat(64);
      logger.warn(
        `\n${line}\n  AKUN SUPERADMIN PERTAMA DIBUAT\n  Username : ${user.username}\n  Password : ${password}\n` +
          `  Simpan password ini SEKARANG. Tidak akan ditampilkan lagi.\n  (Atau set ADMIN_PASSWORD di .env sebelum start pertama.)\n${line}`
      );
    } else {
      logger.info(`Akun superadmin '${user.username}' dibuat dari ADMIN_PASSWORD di .env`);
    }
  }

  /** Enkripsi ulang password router ke format AES-GCM & kunci saat ini. */
  private async migrateRouterSecrets(): Promise<void> {
    let migrated = 0;
    for (const r of [...this.db.routers]) {
      if (!r.encryptedPassword) continue;
      const res = decryptDetailed(r.encryptedPassword);
      if (!res.ok) {
        logger.error(
          `Password router '${r.name}' tidak dapat didekripsi (ENCRYPTION_KEY berubah?). Simpan ulang password router ini.`
        );
        continue;
      }
      if (res.needsReencrypt) {
        try {
          await this.updateRouter(r.id, { encryptedPassword: encrypt(res.value) });
          migrated++;
        } catch (err: any) {
          logger.warn(`Gagal migrasi enkripsi router '${r.name}': ${err?.message}`);
        }
      }
    }
    if (migrated > 0) logger.info(`Migrasi enkripsi: ${migrated} password router dipindah ke AES-256-GCM.`);
  }

  private warnDefaultPasswords(): void {
    const weak = this.db.users.filter((u) => isKnownDefaultPasswordHash(u.passwordHash));
    if (weak.length > 0) {
      logger.warn(
        `PERINGATAN KEAMANAN: akun [${weak.map((u) => u.username).join(', ')}] masih memakai password bawaan yang publik. ` +
          'Segera ganti lewat menu pengguna (ikon profil -> Ganti Password).'
      );
    }
  }

  public hasDefaultPassword(user: AdminUser): boolean {
    return isKnownDefaultPasswordHash(user.passwordHash);
  }

  /* ---------------------------- persistensi ---------------------------- */

  /** Jalankan operasi SQL secara berurutan dengan retry pada error sementara. */
  private sql<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const pool = getMySQLPool();
      if (!pool) throw new Error('Pool MySQL tidak tersedia');
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn(pool);
        } catch (err: any) {
          if (attempt < 3 && isTransientMySQLError(err)) {
            await sleep(250 * 2 ** attempt);
            continue;
          }
          throw err;
        }
      }
    };

    this.pendingWrites++;
    const p = this.chain.then(run);
    this.chain = p.then(
      () => undefined,
      () => undefined
    );
    return p.finally(() => {
      this.pendingWrites--;
    });
  }

  /** Versi "tembak dan lupakan": error dicatat, tidak dilempar. */
  private sqlQuiet(label: string, fn: (pool: Pool) => Promise<unknown>): void {
    this.sql(fn).catch((err: any) => {
      this.failedWrites++;
      this.lastWriteError = { message: `${label}: ${err?.message}`, at: new Date().toISOString() };
      logger.error(`MySQL ${label} gagal`, { message: err?.message, code: err?.code });
    });
  }

  private markJsonDirty(): void {
    if (this.mode === 'mysql') return;
    this.jsonDirty = true;
    if (this.jsonTimer) return;
    this.jsonTimer = setTimeout(() => {
      this.jsonTimer = null;
      this.writeJson().catch(() => undefined);
    }, 400);
    this.jsonTimer.unref();
  }

  /** Tulis db.json secara atomik (tmp + fsync + rename). Tidak pernah menghasilkan file setengah jadi. */
  private async writeJson(): Promise<void> {
    if (this.mode === 'mysql') return;
    if (this.jsonWriting) {
      await this.jsonWriting;
      if (!this.jsonDirty) return;
    }
    this.jsonDirty = false;
    const task = (async () => {
      const tmp = `${this.dbFile}.tmp`;
      try {
        await fs.promises.mkdir(this.dataDir, { recursive: true });
        const payload = JSON.stringify(this.db);

        if (Date.now() - this.lastBackupAt > 30 * 60 * 1000 && fs.existsSync(this.dbFile)) {
          await fs.promises.copyFile(this.dbFile, `${this.dbFile}.bak`).catch(() => undefined);
          this.lastBackupAt = Date.now();
        }

        const fh = await fs.promises.open(tmp, 'w', 0o600);
        try {
          await fh.writeFile(payload, 'utf-8');
          await fh.sync();
        } finally {
          await fh.close();
        }
        await fs.promises.rename(tmp, this.dbFile);
      } catch (err: any) {
        this.jsonDirty = true;
        this.failedWrites++;
        this.lastWriteError = { message: `db.json: ${err?.message}`, at: new Date().toISOString() };
        logger.error('Gagal menulis db.json', { message: err?.message });
        throw err;
      }
    })();
    this.jsonWriting = task.finally(() => {
      this.jsonWriting = null;
    });
    await this.jsonWriting;
  }

  /** Paksa tulis sekarang (dipakai untuk mutasi penting & saat shutdown). */
  public async flush(): Promise<void> {
    if (this.jsonTimer) {
      clearTimeout(this.jsonTimer);
      this.jsonTimer = null;
    }
    if (this.mode !== 'mysql' && (this.jsonDirty || this.jsonWriting)) {
      await this.writeJson();
    }
    await this.chain;
  }

  public async close(): Promise<void> {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    try {
      await this.flush();
    } catch (err: any) {
      logger.error('Flush saat shutdown gagal', { message: err?.message });
    }
    await closeMySQLPool();
  }

  /** Kompatibilitas lama. */
  public save(): void {
    this.markJsonDirty();
  }

  /** Untuk pengujian. */
  public async __resetForTests(): Promise<void> {
    await this.close();
    this.db = { routers: [], users: [], auditLogs: [], recentEvents: [] };
    this.mode = 'uninitialized';
    this.initPromise = null;
  }

  /* ---------------------------- pemeliharaan ---------------------------- */

  public async prune(): Promise<void> {
    const auditCutoff = new Date(Date.now() - config.auditRetentionDays * 86400_000).toISOString();
    const eventCutoff = new Date(Date.now() - config.eventRetentionDays * 86400_000).toISOString();

    this.db.auditLogs = this.db.auditLogs.filter((l) => l.timestamp >= auditCutoff).slice(0, config.auditCacheSize);
    this.db.recentEvents = this.db.recentEvents.filter((e) => e.timestamp >= eventCutoff).slice(0, 50);

    if (this.mode === 'mysql') {
      await this.sql(async (pool) => {
        for (let i = 0; i < 100; i++) {
          const [res] = await pool.query('DELETE FROM audit_logs WHERE timestamp < ? LIMIT 5000', [auditCutoff]);
          if (((res as any).affectedRows || 0) < 5000) break;
        }
        for (let i = 0; i < 100; i++) {
          const [res] = await pool.query('DELETE FROM recent_events WHERE timestamp < ? LIMIT 5000', [eventCutoff]);
          if (((res as any).affectedRows || 0) < 5000) break;
        }
      });
    } else {
      this.markJsonDirty();
    }
  }

  /* ------------------------------ routers ------------------------------ */

  public getRouters(): RouterConfig[] {
    return this.db.routers;
  }

  public getRouter(id: string): RouterConfig | undefined {
    return this.db.routers.find((r) => r.id === id);
  }

  public async addRouter(router: RouterConfig): Promise<RouterConfig> {
    if (this.db.routers.some((r) => r.name.toLowerCase() === router.name.toLowerCase())) {
      throw conflict(`Router dengan nama '${router.name}' sudah terdaftar.`);
    }

    if (this.mode === 'mysql') {
      try {
        await this.sql((pool) =>
          pool.query(
            `INSERT INTO routers (id, name, host, port, username, encryptedPassword, mode, notes, isDemo, status, lastSeen, lastError, identity, version, uptime, cpuLoad, freeMemory, totalMemory, boardName)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              router.id,
              router.name,
              router.host,
              router.port,
              router.username,
              router.encryptedPassword || null,
              router.mode,
              router.notes || '',
              router.isDemo ? 1 : 0,
              router.status || 'checking',
              router.lastSeen || new Date().toISOString(),
              router.lastError || null,
              router.identity || null,
              router.version || null,
              router.uptime || null,
              router.cpuLoad || 0,
              router.freeMemory || 0,
              router.totalMemory || 0,
              router.boardName || null,
            ]
          )
        );
      } catch (err: any) {
        if (isDuplicateEntryError(err)) throw conflict(`Router dengan nama '${router.name}' sudah terdaftar.`);
        throw err;
      }
      this.db.routers.push(router);
    } else {
      this.db.routers.push(router);
      this.markJsonDirty();
      await this.flush();
    }
    return router;
  }

  /** Update konfigurasi router (penting -> ditulis & ditunggu). */
  public async updateRouter(id: string, patch: Partial<RouterConfig>): Promise<RouterConfig> {
    const idx = this.db.routers.findIndex((r) => r.id === id);
    if (idx === -1) throw new HttpError(404, `Router dengan id '${id}' tidak ditemukan`);

    if (patch.name && this.db.routers.some((r) => r.id !== id && r.name.toLowerCase() === patch.name!.toLowerCase())) {
      throw conflict(`Router dengan nama '${patch.name}' sudah terdaftar.`);
    }

    const next: RouterConfig = { ...this.db.routers[idx], ...patch };

    if (this.mode === 'mysql') {
      try {
        await this.persistRouterPatch(id, patch);
      } catch (err: any) {
        if (isDuplicateEntryError(err)) throw conflict(`Router dengan nama '${patch.name}' sudah terdaftar.`);
        throw err;
      }
      this.db.routers[idx] = next;
    } else {
      this.db.routers[idx] = next;
      this.markJsonDirty();
      await this.flush();
    }
    return next;
  }

  /** Bangun query UPDATE dari patch (hanya kolom yang di-whitelist). null bila tidak ada yang berubah. */
  private buildRouterPatchQuery(id: string, patch: Partial<RouterConfig>): { text: string; values: unknown[] } | null {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!ROUTER_COLUMN_SET.has(k)) continue; // whitelist kolom: mencegah injeksi nama kolom
      fields.push(`\`${k as RouterColumn}\` = ?`);
      values.push(k === 'isDemo' ? (v ? 1 : 0) : v === undefined ? null : v);
    }
    if (fields.length === 0) return null;
    values.push(id);
    return { text: `UPDATE routers SET ${fields.join(', ')} WHERE id = ?`, values };
  }

  /** Antre & jalankan UPDATE router. JANGAN dipanggil dari dalam callback sql() (akan deadlock). */
  private persistRouterPatch(id: string, patch: Partial<RouterConfig>): Promise<unknown> {
    const q = this.buildRouterPatchQuery(id, patch);
    if (!q) return Promise.resolve();
    return this.sql((pool) => pool.query(q.text, q.values));
  }

  /**
   * Update status/telemetri router (frekuensi tinggi). Memori langsung; persist hanya
   * saat status berubah atau paling cepat 1x/menit -> tidak membanjiri disk/DB.
   */
  public updateRouterRuntime(id: string, patch: Partial<RouterConfig>): void {
    const idx = this.db.routers.findIndex((r) => r.id === id);
    if (idx === -1) return;
    const current = this.db.routers[idx];
    this.db.routers[idx] = { ...current, ...patch };

    const meta = this.runtimePersist.get(id);
    const statusChanged = patch.status !== undefined && patch.status !== current.status;
    const due = !meta || Date.now() - meta.at > 60_000;
    if (!statusChanged && !due) return;

    this.runtimePersist.set(id, { at: Date.now(), status: patch.status });
    if (this.mode === 'mysql') {
      const persistable: Partial<RouterConfig> = {};
      for (const k of Object.keys(patch)) {
        if (ROUTER_COLUMN_SET.has(k)) (persistable as any)[k] = (patch as any)[k];
      }
      const q = this.buildRouterPatchQuery(id, persistable);
      if (q) this.sqlQuiet('updateRouterRuntime', (pool) => pool.query(q.text, q.values));
    } else {
      this.markJsonDirty();
    }
  }

  public async deleteRouter(id: string): Promise<boolean> {
    if (!this.getRouter(id)) return false;
    if (this.mode === 'mysql') {
      await this.sql(async (pool) => {
        await pool.query('DELETE FROM routers WHERE id = ?', [id]);
        await pool.query('DELETE FROM demo_data WHERE routerId = ?', [id]);
      });
    }
    this.db.routers = this.db.routers.filter((r) => r.id !== id);
    if (this.db.demoData) delete this.db.demoData[id];
    this.runtimePersist.delete(id);
    if (this.mode !== 'mysql') {
      this.markJsonDirty();
      await this.flush();
    }
    return true;
  }

  /* ----------------------------- audit & event ----------------------------- */

  public getAuditLogs(): AuditLogItem[] {
    return this.db.auditLogs.slice();
  }

  public addAuditLog(item: Omit<AuditLogItem, 'id' | 'timestamp'>): void {
    const log: AuditLogItem = { ...item, id: randomId('log'), timestamp: new Date().toISOString() };
    this.db.auditLogs.unshift(log);
    if (this.db.auditLogs.length > config.auditCacheSize) {
      this.db.auditLogs.length = config.auditCacheSize;
    }

    if (this.mode === 'mysql') {
      this.sqlQuiet('addAuditLog', (pool) =>
        pool.query(
          'INSERT INTO audit_logs (id, timestamp, username, routerId, routerName, action, targetType, targetName, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            log.id,
            log.timestamp,
            log.username,
            log.routerId,
            log.routerName.slice(0, 128),
            log.action,
            log.targetType,
            log.targetName.slice(0, 128),
            log.details || null,
          ]
        )
      );
    } else {
      this.markJsonDirty();
    }
  }

  public getRecentEvents(): RecentEvent[] {
    return this.db.recentEvents;
  }

  public addRecentEvent(event: Omit<RecentEvent, 'id' | 'timestamp'>): void {
    const evt: RecentEvent = { ...event, id: randomId('evt'), timestamp: new Date().toISOString() };
    this.db.recentEvents.unshift(evt);
    if (this.db.recentEvents.length > 50) this.db.recentEvents.length = 50;

    if (this.mode === 'mysql') {
      this.sqlQuiet('addRecentEvent', (pool) =>
        pool.query(
          'INSERT INTO recent_events (id, timestamp, type, username, routerName, ipAddress) VALUES (?, ?, ?, ?, ?, ?)',
          [evt.id, evt.timestamp, evt.type, evt.username.slice(0, 64), evt.routerName.slice(0, 128), evt.ipAddress.slice(0, 64)]
        )
      );
    } else {
      this.markJsonDirty();
    }
  }

  public getUserSessionEvents(username: string) {
    const target = username.toLowerCase();
    const fromEvents = this.db.recentEvents
      .filter((e) => e.username.toLowerCase() === target)
      .map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        type: e.type,
        username: e.username,
        routerName: e.routerName,
        ipAddress: e.ipAddress,
        details: e.type === 'connected' ? 'PPPoE Client Terhubung' : 'PPPoE Client Terputus / Logged Out',
      }));

    const fromAudit = this.db.auditLogs
      .filter((l) => l.targetType === 'ACTIVE' && l.targetName.toLowerCase() === target)
      .map((l) => ({
        id: l.id,
        timestamp: l.timestamp,
        type: 'disconnected' as const,
        username: l.targetName,
        routerName: l.routerName,
        ipAddress: '—',
        details: l.details || `Sesi diputus oleh operator: ${l.username}`,
      }));

    return [...fromEvents, ...fromAudit].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  }

  /* -------------------------------- users -------------------------------- */

  public getUsers(): AdminUser[] {
    return this.db.users;
  }

  public getUser(username: string): AdminUser | undefined {
    const t = String(username || '').toLowerCase();
    return this.db.users.find((u) => u.username.toLowerCase() === t);
  }

  public getUserById(id: string): AdminUser | undefined {
    return this.db.users.find((u) => u.id === id);
  }

  public countActiveSuperadmins(excludeId?: string): number {
    return this.db.users.filter(
      (u) => u.role === 'superadmin' && (u.status || 'active') === 'active' && u.id !== excludeId
    ).length;
  }

  public async createUser(userData: {
    username: string;
    name: string;
    role: UserRole;
    passwordHash: string;
    allowedMenus: string[];
    status?: 'active' | 'suspended';
  }): Promise<AdminUser> {
    if (this.getUser(userData.username)) {
      throw conflict(`Username '${userData.username}' sudah digunakan.`);
    }

    const newUser: AdminUser = {
      id: randomId('user'),
      username: userData.username.toLowerCase().trim(),
      name: userData.name.trim(),
      role: userData.role,
      passwordHash: userData.passwordHash,
      allowedMenus: userData.allowedMenus?.length ? userData.allowedMenus : ['dashboard'],
      status: userData.status || 'active',
      createdAt: new Date().toISOString(),
    };

    if (this.mode === 'mysql') {
      try {
        await this.sql((pool) =>
          pool.query(
            'INSERT INTO users (id, username, name, role, passwordHash, allowedMenus, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
              newUser.id,
              newUser.username,
              newUser.name,
              newUser.role,
              newUser.passwordHash,
              JSON.stringify(newUser.allowedMenus),
              newUser.status,
              newUser.createdAt,
            ]
          )
        );
      } catch (err: any) {
        if (isDuplicateEntryError(err)) throw conflict(`Username '${newUser.username}' sudah digunakan.`);
        throw err;
      }
      this.db.users.push(newUser);
    } else {
      this.db.users.push(newUser);
      this.markJsonDirty();
      await this.flush();
    }
    return newUser;
  }

  public async updateUser(
    id: string,
    patch: {
      name?: string;
      role?: UserRole;
      passwordHash?: string;
      allowedMenus?: string[];
      status?: 'active' | 'suspended';
      lastLogin?: string;
    }
  ): Promise<AdminUser> {
    const idx = this.db.users.findIndex((u) => u.id === id);
    if (idx === -1) throw new HttpError(404, `User dengan ID '${id}' tidak ditemukan.`);

    const current = this.db.users[idx];
    const next: AdminUser = { ...current, ...patch, allowedMenus: patch.allowedMenus ?? current.allowedMenus };

    // Jangan pernah menyisakan sistem tanpa superadmin aktif.
    const wasActiveSuper = current.role === 'superadmin' && (current.status || 'active') === 'active';
    const stillActiveSuper = next.role === 'superadmin' && (next.status || 'active') === 'active';
    if (wasActiveSuper && !stillActiveSuper && this.countActiveSuperadmins(id) === 0) {
      throw conflict('Tidak dapat menonaktifkan/menurunkan superadmin aktif terakhir.');
    }

    if (this.mode === 'mysql') {
      const fields: string[] = [];
      const values: unknown[] = [];
      if (patch.name !== undefined) (fields.push('name = ?'), values.push(patch.name));
      if (patch.role !== undefined) (fields.push('role = ?'), values.push(patch.role));
      if (patch.passwordHash !== undefined) (fields.push('passwordHash = ?'), values.push(patch.passwordHash));
      if (patch.allowedMenus !== undefined) (fields.push('allowedMenus = ?'), values.push(JSON.stringify(patch.allowedMenus)));
      if (patch.status !== undefined) (fields.push('status = ?'), values.push(patch.status));
      if (patch.lastLogin !== undefined) (fields.push('lastLogin = ?'), values.push(patch.lastLogin));
      if (fields.length > 0) {
        values.push(id);
        await this.sql((pool) => pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values));
      }
      this.db.users[idx] = next;
    } else {
      this.db.users[idx] = next;
      this.markJsonDirty();
      // lastLogin tidak perlu ditunggu; perubahan lain ditunggu.
      if (Object.keys(patch).some((k) => k !== 'lastLogin')) await this.flush();
    }
    return next;
  }

  public async deleteUser(id: string): Promise<boolean> {
    const user = this.getUserById(id);
    if (!user) return false;
    if (user.role === 'superadmin' && (user.status || 'active') === 'active' && this.countActiveSuperadmins(id) === 0) {
      throw conflict('Tidak dapat menghapus superadmin aktif terakhir.');
    }

    if (this.mode === 'mysql') {
      await this.sql((pool) => pool.query('DELETE FROM users WHERE id = ?', [id]));
    }
    this.db.users = this.db.users.filter((u) => u.id !== id);
    if (this.mode !== 'mysql') {
      this.markJsonDirty();
      await this.flush();
    }
    return true;
  }

  public async updateUserPassword(username: string, newHash: string): Promise<boolean> {
    const user = this.getUser(username);
    if (!user) return false;
    await this.updateUser(user.id, { passwordHash: newHash });
    return true;
  }

  /* ----------------------------- demo data ----------------------------- */

  public getDemoData(routerId: string): DemoStore | undefined {
    return this.db.demoData?.[routerId];
  }

  public saveDemoData(routerId: string, data: DemoStore): void {
    if (!this.db.demoData) this.db.demoData = {};
    this.db.demoData[routerId] = data;

    if (this.mode === 'mysql') {
      this.sqlQuiet('saveDemoData', (pool) =>
        pool.query(
          'INSERT INTO demo_data (routerId, dataJson) VALUES (?, ?) ON DUPLICATE KEY UPDATE dataJson = VALUES(dataJson)',
          [routerId, JSON.stringify(data)]
        )
      );
    } else {
      this.markJsonDirty();
    }
  }

  /**
   * Reset router demo ke kondisi awal. HANYA menyentuh router bertanda isDemo;
   * router produksi tidak pernah disentuh.
   */
  public async resetDemo(): Promise<void> {
    const demoIds = this.db.routers.filter((r) => r.isDemo).map((r) => r.id);

    if (this.mode === 'mysql') {
      await this.sql(async (pool) => {
        if (demoIds.length > 0) {
          await pool.query('DELETE FROM routers WHERE id IN (?)', [demoIds]);
          await pool.query('DELETE FROM demo_data WHERE routerId IN (?)', [demoIds]);
        }
      });
    }
    this.db.routers = this.db.routers.filter((r) => !r.isDemo);
    this.db.demoData = {};

    const pass = encrypt('demoRouterPass123!');
    const now = new Date().toISOString();
    const demoRouters: RouterConfig[] = [
      {
        id: 'router-core-idc',
        name: 'Router-Core-IDC',
        host: '10.100.1.1',
        port: 443,
        username: 'api-pppoe',
        encryptedPassword: pass,
        mode: 'REST',
        notes: 'Core CCR2004 di Cyber IDC Lt. 2 (Koneksi REST API v7)',
        isDemo: true,
        status: 'online',
        lastSeen: now,
        identity: 'Mikrotik-Core-IDC',
        version: 'RouterOS v7.14.3 (stable)',
        uptime: '38d 14h 22m',
        cpuLoad: 16,
        freeMemory: 3120,
        totalMemory: 4096,
        boardName: 'CCR2004-16G-2S+',
      },
      {
        id: 'router-dist-utama',
        name: 'Router-Dist-Utama',
        host: '10.100.2.1',
        port: 8728,
        username: 'api-admin',
        encryptedPassword: pass,
        mode: 'API',
        notes: 'Distribusi Utama BSD City - RB4011 (Koneksi Winbox API port 8728)',
        isDemo: true,
        status: 'online',
        lastSeen: now,
        identity: 'Mikrotik-Dist-BSD',
        version: 'RouterOS v7.13.5 (stable)',
        uptime: '21d 08h 15m',
        cpuLoad: 22,
        freeMemory: 742,
        totalMemory: 1024,
        boardName: 'RB4011iGS+',
      },
      {
        id: 'router-pop-barat',
        name: 'Router-POP-Barat',
        host: '10.100.3.1',
        port: 8729,
        username: 'api-ssl-user',
        encryptedPassword: pass,
        mode: 'API-SSL',
        notes: 'POP Kalideres Tower A - RB760iGS (API-SSL port 8729)',
        isDemo: true,
        status: 'online',
        lastSeen: now,
        identity: 'Mikrotik-POP-Barat',
        version: 'RouterOS v7.12.1 (stable)',
        uptime: '14d 03h 48m',
        cpuLoad: 14,
        freeMemory: 382,
        totalMemory: 512,
        boardName: 'RB760iGS (hEX S)',
      },
    ];

    // Hindari bentrok nama dengan router produksi.
    const taken = new Set(this.db.routers.map((r) => r.name.toLowerCase()));
    for (const r of demoRouters) {
      if (taken.has(r.name.toLowerCase())) r.name = `${r.name}-Demo`;
      this.db.routers.push(r);
      if (this.mode === 'mysql') {
        await this.sql((pool) =>
          pool.query(
            `INSERT INTO routers (id, name, host, port, username, encryptedPassword, mode, notes, isDemo, status, lastSeen, identity, version, uptime, cpuLoad, freeMemory, totalMemory, boardName)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [r.id, r.name, r.host, r.port, r.username, r.encryptedPassword, r.mode, r.notes, 1, r.status, r.lastSeen, r.identity, r.version, r.uptime, r.cpuLoad, r.freeMemory, r.totalMemory, r.boardName]
          )
        );
      }
    }
    if (this.mode !== 'mysql') {
      this.markJsonDirty();
      await this.flush();
    }
  }
}

export const storage = new StorageManager();
