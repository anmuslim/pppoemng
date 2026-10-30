import { IRouterDriver, RouterConfig, RouterSummary } from './types.js';
import { DemoDriver } from './demoDriver.js';
import { RouterosRestDriver } from './routerosRestDriver.js';
import { RouterosApiDriver } from './routerosApiDriver.js';
import { storage } from '../storage.js';
import { decrypt } from '../crypto.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { RouterConnectionError, errorMessage, notFound } from '../errors.js';

export interface CacheOpts {
  /** Kunci cache per router, mis. 'secrets'. Tanpa kunci = tanpa cache. */
  key?: string;
  ttlMs?: number;
}

interface Breaker {
  failures: number;
  openUntil: number;
  lastError: string;
  trips: number;
}

interface DriverEntry {
  driver: IRouterDriver;
  fingerprint: string;
}

/** Semaphore sederhana untuk membatasi jumlah router yang diakses bersamaan. */
class Semaphore {
  private waiting: Array<() => void> = [];
  private active = 0;
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RouterConnectionError(`Timeout menghubungi router ${label} (${Math.round(ms / 1000)} dtk)`, 'timeout')), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * Pusat akses ke router:
 *  - cache driver (otomatis dibuat ulang bila konfigurasi router berubah)
 *  - cache hasil baca berumur pendek + penggabungan request identik yang sedang berjalan
 *    (10 browser polling = 1 query ke router, bukan 10)
 *  - circuit breaker: router yang mati dilewati dengan cepat, bukan ditunggu 12 detik tiap request
 *  - batas paralelisme + timeout yang selalu dibersihkan
 */
class RouterConnectionManager {
  private drivers = new Map<string, DriverEntry>();
  private breakers = new Map<string, Breaker>();
  private cache = new Map<string, { value: unknown; expires: number }>();
  private inflight = new Map<string, Promise<unknown>>();
  private sem = new Semaphore(config.router.maxParallelRouters);

  /* ------------------------------ driver ------------------------------ */

  private fingerprint(c: RouterConfig): string {
    return [c.host, c.port, c.mode, c.username, c.encryptedPassword, c.isDemo ? 1 : 0].join('|');
  }

  public getDriver(routerConfig: RouterConfig): IRouterDriver {
    const fp = this.fingerprint(routerConfig);
    const existing = this.drivers.get(routerConfig.id);
    if (existing && existing.fingerprint === fp) return existing.driver;
    if (existing) {
      existing.driver.close().catch(() => undefined);
      this.dropCaches(routerConfig.id);
    }

    let driver: IRouterDriver;
    if (routerConfig.isDemo) {
      driver = new DemoDriver(routerConfig);
    } else {
      let password: string | undefined;
      try {
        password = routerConfig.encryptedPassword ? decrypt(routerConfig.encryptedPassword) : undefined;
      } catch (err) {
        throw new RouterConnectionError(errorMessage(err), 'auth');
      }
      driver = routerConfig.mode === 'REST' ? new RouterosRestDriver(routerConfig, password) : new RouterosApiDriver(routerConfig, password);
    }
    this.drivers.set(routerConfig.id, { driver, fingerprint: fp });
    return driver;
  }

  public invalidateRouter(routerId: string) {
    const e = this.drivers.get(routerId);
    if (e) e.driver.close().catch(() => undefined);
    this.drivers.delete(routerId);
    this.breakers.delete(routerId);
    this.dropCaches(routerId);
  }

  public clearAllDrivers() {
    for (const e of this.drivers.values()) e.driver.close().catch(() => undefined);
    this.drivers.clear();
    this.breakers.clear();
    this.cache.clear();
    this.inflight.clear();
  }

  public async shutdown() {
    const all = [...this.drivers.values()].map((e) => e.driver.close().catch(() => undefined));
    this.drivers.clear();
    await Promise.allSettled(all);
  }

  /** Hapus cache data sebuah router (dipanggil setelah mutasi agar daftar langsung segar). */
  public invalidateData(routerId?: string) {
    if (!routerId) return this.cache.clear();
    this.dropCaches(routerId);
  }

  private dropCaches(routerId: string) {
    const prefix = `${routerId}::`;
    for (const k of this.cache.keys()) if (k.startsWith(prefix)) this.cache.delete(k);
  }

  /* --------------------------- circuit breaker --------------------------- */

  private breakerFor(id: string): Breaker {
    let b = this.breakers.get(id);
    if (!b) {
      b = { failures: 0, openUntil: 0, lastError: '', trips: 0 };
      this.breakers.set(id, b);
    }
    return b;
  }

  private recordSuccess(id: string) {
    const b = this.breakers.get(id);
    if (b && (b.failures > 0 || b.trips > 0)) {
      this.breakers.delete(id);
      logger.info(`Router ${id} pulih (circuit breaker ditutup)`);
    }
  }

  private recordFailure(id: string, err: RouterConnectionError) {
    const b = this.breakerFor(id);
    b.failures++;
    b.lastError = err.message;
    const threshold = err.kind === 'auth' ? 1 : config.router.breakerFailureThreshold;
    if (b.failures >= threshold) {
      b.trips++;
      const base = err.kind === 'auth' ? 30_000 : config.router.breakerBaseCooldownMs;
      const cooldown = Math.min(config.router.breakerMaxCooldownMs, base * 2 ** Math.min(b.trips - 1, 6));
      b.openUntil = Date.now() + cooldown;
    }
  }

  private checkBreaker(c: RouterConfig) {
    const b = this.breakers.get(c.id);
    if (b && b.openUntil > Date.now()) {
      const sec = Math.ceil((b.openUntil - Date.now()) / 1000);
      throw new RouterConnectionError(`Router ${c.name} sedang tidak dapat dihubungi (coba lagi ${sec} dtk): ${b.lastError}`, 'network');
    }
    // openUntil lewat = half-open: satu request berikutnya menjadi percobaan.
  }

  public getBreakerState(routerId: string) {
    const b = this.breakers.get(routerId);
    return b ? { ...b, open: b.openUntil > Date.now() } : null;
  }

  /* ---------------------------- eksekusi ke router ---------------------------- */

  private markOnline(c: RouterConfig) {
    const wasOffline = c.status !== 'online';
    storage.updateRouterRuntime(c.id, { status: 'online', lastSeen: new Date().toISOString(), lastError: undefined });
    if (wasOffline) logger.info(`Router ${c.name} online`);
  }

  private markOffline(c: RouterConfig, err: RouterConnectionError) {
    if (c.status !== 'offline') logger.warn(`Router ${c.name} offline: ${err.message}`);
    storage.updateRouterRuntime(c.id, { status: 'offline', lastError: err.message });
  }

  /**
   * Jalankan satu operasi pada satu router dengan breaker, timeout, dan penandaan status.
   * `bypassBreaker` dipakai uji koneksi manual.
   */
  public async run<T>(c: RouterConfig, action: (driver: IRouterDriver) => Promise<T>, opts: { bypassBreaker?: boolean } = {}): Promise<T> {
    if (!opts.bypassBreaker) this.checkBreaker(c);
    const driver = this.getDriver(c);
    try {
      const result = await this.sem.run(() => withTimeout(action(driver), config.router.operationTimeoutMs, c.name));
      this.recordSuccess(c.id);
      this.markOnline(c);
      return result;
    } catch (err) {
      if (err instanceof RouterConnectionError) {
        this.recordFailure(c.id, err);
        this.markOffline(c, err);
      }
      throw err;
    }
  }

  /** Operasi tulis: sama seperti run, lalu cache router tersebut dibuang. */
  public async mutate<T>(c: RouterConfig, action: (driver: IRouterDriver) => Promise<T>): Promise<T> {
    try {
      return await this.run(c, action);
    } finally {
      this.dropCaches(c.id);
    }
  }

  /** Baca dengan cache TTL + coalescing request identik. */
  public async read<T>(c: RouterConfig, opts: CacheOpts, action: (driver: IRouterDriver) => Promise<T>): Promise<T> {
    const ttl = opts.ttlMs ?? 0;
    if (!opts.key || ttl <= 0) return this.run(c, action);

    const k = `${c.id}::${opts.key}`;
    const hit = this.cache.get(k);
    if (hit && hit.expires > Date.now()) return hit.value as T;

    const pending = this.inflight.get(k);
    if (pending) return pending as Promise<T>;

    const p = this.run(c, action)
      .then((value) => {
        this.cache.set(k, { value, expires: Date.now() + ttl });
        return value;
      })
      .finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  /* ------------------------------ util router ------------------------------ */

  public getRouterSummaries(): RouterSummary[] {
    return storage.getRouters().map((r) => ({
      id: r.id,
      name: r.name,
      host: r.host,
      port: r.port,
      mode: r.mode,
      notes: r.notes,
      isDemo: Boolean(r.isDemo),
      hasPassword: Boolean(r.encryptedPassword),
      status: r.status || 'online',
      lastSeen: r.lastSeen,
      lastError: r.lastError,
      identity: r.identity,
      version: r.version,
      uptime: r.uptime,
      cpuLoad: r.cpuLoad,
      freeMemory: r.freeMemory,
      totalMemory: r.totalMemory,
      boardName: r.boardName,
    }));
  }

  /** Router tunggal berdasarkan id; 'all' tidak diterima. */
  public requireRouter(routerId: string): RouterConfig {
    const r = storage.getRouter(routerId);
    if (!r) throw notFound(`Router '${routerId}' tidak ditemukan.`);
    return r;
  }

  public getTargets(routerId: string): RouterConfig[] {
    if (routerId === 'all') return storage.getRouters().slice();
    return [this.requireRouter(routerId)];
  }

  /**
   * Baca dari satu atau semua router. Kegagalan satu router tidak menggagalkan yang lain;
   * pesan error dikembalikan per router.
   */
  public async executeOnRouters<T>(
    routerId: string,
    action: (driver: IRouterDriver, config: RouterConfig) => Promise<T[]>,
    cache?: CacheOpts
  ): Promise<{ data: T[]; errors: Record<string, string> }> {
    const targets = this.getTargets(routerId);
    const errors: Record<string, string> = {};

    const settled = await Promise.allSettled(targets.map((c) => this.read(c, cache || {}, (d) => action(d, c))));

    const data: T[] = [];
    settled.forEach((res, i) => {
      if (res.status === 'fulfilled') data.push(...res.value);
      else errors[targets[i].name] = errorMessage(res.reason, 'Koneksi gagal');
    });

    // Satu router dipilih tetapi gagal total: biarkan error sampai ke klien (jangan tampil sebagai data kosong).
    if (routerId !== 'all' && Object.keys(errors).length > 0) {
      const only = settled[0] as PromiseRejectedResult;
      throw only.reason;
    }
    return { data, errors };
  }
}

export const routerManager = new RouterConnectionManager();
