import { RouterConfig } from './types.js';
import { RouterosBaseDriver, ListOptions } from './routerosBaseDriver.js';
import { RosPool, RosConnection, RosRow } from './rosClient.js';
import { RouterCommandError } from '../errors.js';
import { Row, clampCount } from './common.js';
import { config as appConfig } from '../config.js';

/** Transport RouterOS API (TCP 8728 / TLS 8729) dengan pool koneksi yang dipakai ulang. */
export class RouterosApiDriver extends RouterosBaseDriver {
  private pool: RosPool;

  constructor(cfg: RouterConfig, password?: string) {
    super(cfg);
    const useTls = cfg.mode === 'API-SSL';
    this.pool = new RosPool({
      host: cfg.host,
      port: cfg.port || (useTls ? 8729 : 8728),
      user: cfg.username,
      password: password || '',
      tls: useTls,
      rejectUnauthorized: appConfig.router.tlsVerify,
      ciphers: appConfig.router.tlsCiphers,
      connectTimeoutMs: appConfig.router.connectTimeoutMs,
      commandTimeoutMs: appConfig.router.commandTimeoutMs,
      size: appConfig.router.poolSize,
      idleCloseMs: appConfig.router.idleCloseMs,
    });
  }

  private static words(path: string, verb: string, params: Record<string, string> = {}, extra: string[] = []): string[] {
    const w = [`${path}/${verb}`];
    for (const [k, v] of Object.entries(params)) w.push(`=${k}=${v}`);
    return [...w, ...extra];
  }

  private async findId(conn: RosConnection, path: string, name: string): Promise<string> {
    if (name.startsWith('*')) return name; // sudah berupa .id
    const r = await conn.write([`${path}/print`, '=.proplist=.id,name', `?name=${name}`]);
    const hit = r.rows.find((x) => x.name === name) || r.rows[0];
    if (!hit || !hit['.id']) throw new RouterCommandError(`Item '${name}' tidak ditemukan di router.`);
    return hit['.id'];
  }

  protected async list(path: string, opts: ListOptions = {}): Promise<Row[]> {
    const words = [`${path}/print`];
    if (opts.proplist?.length) words.push(`=.proplist=${opts.proplist.join(',')}`);
    for (const [k, v] of Object.entries(opts.query || {})) words.push(`?${k}=${v}`);
    const r = await this.pool.use((c) => c.write(words), { idempotent: true });
    return r.rows as RosRow[];
  }

  protected async add(path: string, params: Record<string, string>): Promise<void> {
    await this.pool.use((c) => c.write(RouterosApiDriver.words(path, 'add', params)));
  }

  protected async set(path: string, name: string, params: Record<string, string>): Promise<void> {
    await this.pool.use(async (c) => {
      const id = await this.findId(c, path, name);
      await c.write(RouterosApiDriver.words(path, 'set', { '.id': id, ...params }));
    });
  }

  protected async remove(path: string, name: string): Promise<void> {
    await this.pool.use(async (c) => {
      const id = await this.findId(c, path, name);
      await c.write(RouterosApiDriver.words(path, 'remove', { '.id': id }));
    });
  }

  protected async setDisabled(path: string, name: string, disabled: boolean): Promise<void> {
    await this.pool.use(async (c) => {
      const id = await this.findId(c, path, name);
      await c.write(RouterosApiDriver.words(path, disabled ? 'disable' : 'enable', { '.id': id }));
    });
  }

  protected async fetchResource() {
    return this.pool.use(
      async (c) => {
        const res = (await c.write(['/system/resource/print'])).rows[0] || {};
        const identity = (await c.write(['/system/identity/print']).catch(() => ({ rows: [] as RosRow[] }))).rows[0]?.name;
        return { resource: res as Row, identity };
      },
      { idempotent: true }
    );
  }

  protected async monitorTraffic(iface: string): Promise<Row | null> {
    const r = await this.pool.use((c) => c.write(['/interface/monitor-traffic', `=interface=${iface}`, '=once=']), {
      idempotent: true,
    });
    return r.rows[0] || null;
  }

  protected async runPing(address: string, count: number, size: number): Promise<Row[]> {
    const n = clampCount(count);
    const r = await this.pool.use((c) =>
      c.write(['/ping', `=address=${address}`, `=count=${n}`, `=size=${size}`], n * 2500 + 6000)
    );
    return r.rows;
  }

  async close(): Promise<void> {
    this.pool.close();
  }
}
