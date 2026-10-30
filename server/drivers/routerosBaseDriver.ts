import {
  IRouterDriver,
  RouterConfig,
  RouterConnectionTestResult,
  PppSecret,
  PppActive,
  PppProfile,
  SimpleQueue,
  IpPool,
  SessionTrafficInfo,
  PingResult,
} from './types.js';
import { RouterConnectionError, RouterCommandError, errorMessage } from '../errors.js';
import {
  Row,
  formatRate,
  mapSecret,
  secretParams,
  mapProfile,
  profileParams,
  mapQueue,
  queueParams,
  mapPool,
  poolParams,
  buildActive,
  buildPingResult,
  clampCount,
  clampSize,
  isTrue,
} from './common.js';

export interface ListOptions {
  query?: Record<string, string>;
  proplist?: string[];
}

/**
 * Logika bisnis RouterOS yang sama untuk transport API (TCP) maupun REST (HTTP).
 * Subclass hanya menyediakan primitif transport.
 */
export abstract class RouterosBaseDriver implements IRouterDriver {
  private profileMap: { at: number; map: Map<string, string> } | null = null;

  constructor(protected config: RouterConfig) {}

  /* ---- primitif transport ---- */
  protected abstract list(path: string, opts?: ListOptions): Promise<Row[]>;
  protected abstract add(path: string, params: Record<string, string>): Promise<void>;
  /** Ubah item berdasarkan nama (atau .id). */
  protected abstract set(path: string, name: string, params: Record<string, string>): Promise<void>;
  protected abstract remove(path: string, name: string): Promise<void>;
  protected abstract setDisabled(path: string, name: string, disabled: boolean): Promise<void>;
  protected abstract fetchResource(): Promise<{ resource: Row; identity?: string }>;
  protected abstract monitorTraffic(iface: string): Promise<Row | null>;
  protected abstract runPing(address: string, count: number, size: number): Promise<Row[]>;
  abstract close(): Promise<void>;

  /* ---- sistem ---- */
  async getSystemResource() {
    const { resource: res, identity } = await this.fetchResource();
    return {
      identity: identity || this.config.name,
      version: res.version || 'RouterOS',
      uptime: res.uptime || 'Unknown',
      cpuLoad: Number(res['cpu-load']) || 0,
      freeMemory: Math.round((Number(res['free-memory']) || 0) / 1048576),
      totalMemory: Math.round((Number(res['total-memory']) || 0) / 1048576),
      boardName: res['board-name'] || res.platform || 'MikroTik Router',
    };
  }

  async testConnection(): Promise<RouterConnectionTestResult> {
    try {
      return { success: true, ...(await this.getSystemResource()) };
    } catch (err) {
      return {
        success: false,
        identity: this.config.name,
        version: '',
        uptime: '',
        cpuLoad: 0,
        freeMemory: 0,
        totalMemory: 0,
        boardName: '',
        error: errorMessage(err, 'Koneksi ke router gagal'),
      };
    }
  }

  /* ---- PPP secret ---- */
  async getSecrets(): Promise<PppSecret[]> {
    return (await this.list('/ppp/secret')).map((r) => mapSecret(r, this.config));
  }

  async getSecretStats() {
    const rows = await this.list('/ppp/secret', { proplist: ['disabled'] });
    return { total: rows.length, disabled: rows.filter((r) => isTrue(r.disabled)).length };
  }

  async createSecret(secret: PppSecret): Promise<PppSecret> {
    await this.add('/ppp/secret', secretParams(secret, true));
    return { ...secret, routerId: this.config.id, routerName: this.config.name };
  }

  async updateSecret(name: string, secret: Partial<PppSecret>): Promise<PppSecret> {
    const params = secretParams(secret, false);
    if (params.name === name) delete params.name;
    if (Object.keys(params).length > 0) await this.set('/ppp/secret', name, params);
    return { name: secret.name || name, ...secret, routerId: this.config.id, routerName: this.config.name } as PppSecret;
  }

  async deleteSecret(name: string): Promise<boolean> {
    await this.remove('/ppp/secret', name);
    return true;
  }

  async setSecretDisabled(name: string, disabled: boolean): Promise<boolean> {
    await this.setDisabled('/ppp/secret', name, disabled);
    return true;
  }

  /* ---- sesi aktif ---- */
  private async getProfileByUser(): Promise<Map<string, string>> {
    const now = Date.now();
    if (this.profileMap && now - this.profileMap.at < 60_000) return this.profileMap.map;
    try {
      const rows = await this.list('/ppp/secret', { proplist: ['name', 'profile'] });
      const map = new Map<string, string>();
      for (const s of rows) if (s.name && s.profile) map.set(String(s.name).toLowerCase(), String(s.profile));
      this.profileMap = { at: now, map };
      return map;
    } catch {
      return this.profileMap?.map ?? new Map();
    }
  }

  async getActive(): Promise<PppActive[]> {
    const [active, queues, profiles] = await Promise.all([
      this.list('/ppp/active'), // wajib berhasil: kegagalan TIDAK boleh tampil sebagai "0 user online"
      this.list('/queue/simple', { proplist: ['name', 'target', 'rate', 'bytes'] }).catch(() => [] as Row[]),
      this.getProfileByUser(),
    ]);
    return buildActive(active, queues, profiles, this.config);
  }

  async disconnectActive(name: string): Promise<boolean> {
    await this.remove('/ppp/active', name);
    return true;
  }

  async getSessionTraffic(name: string): Promise<SessionTrafficInfo> {
    const iface = `<pppoe-${name}>`;
    let rxBps = 0;
    let txBps = 0;
    let rxBytes: number | undefined;
    let txBytes: number | undefined;

    const act = await this.list('/ppp/active', { query: { name }, proplist: ['name', 'uptime'] });
    const connected = act.length > 0;

    if (connected) {
      try {
        const mon = await this.monitorTraffic(iface);
        if (mon) {
          rxBps = Number(mon['rx-bits-per-second']) || 0;
          txBps = Number(mon['tx-bits-per-second']) || 0;
        }
      } catch (err) {
        if (err instanceof RouterConnectionError) throw err;
      }

      if (rxBps === 0 && txBps === 0) {
        try {
          const q = (await this.list('/queue/simple', { query: { name: iface }, proplist: ['name', 'rate', 'bytes'] }))[0];
          if (q) {
            const rate = String(q.rate || '').split('/');
            if (rate.length >= 2) [rxBps, txBps] = [Number(rate[0]) || 0, Number(rate[1]) || 0];
            const bytes = String(q.bytes || '').split('/');
            if (bytes.length >= 2) [rxBytes, txBytes] = [Number(bytes[0]) || 0, Number(bytes[1]) || 0];
          }
        } catch (err) {
          if (err instanceof RouterConnectionError) throw err;
        }
      }
    }

    return {
      name,
      interfaceName: iface,
      connected,
      rxBps,
      txBps,
      uploadRate: formatRate(rxBps),
      downloadRate: formatRate(txBps),
      rxBytes,
      txBytes,
      timestamp: Date.now(),
    };
  }

  /* ---- profile ---- */
  async getProfiles(): Promise<PppProfile[]> {
    return (await this.list('/ppp/profile')).map((r) => mapProfile(r, this.config));
  }
  async createProfile(profile: PppProfile): Promise<PppProfile> {
    await this.add('/ppp/profile', profileParams(profile, true));
    return { ...profile, routerId: this.config.id, routerName: this.config.name };
  }
  async updateProfile(name: string, profile: Partial<PppProfile>): Promise<PppProfile> {
    const params = profileParams(profile, false);
    if (params.name === name) delete params.name;
    if (Object.keys(params).length > 0) await this.set('/ppp/profile', name, params);
    return { name: profile.name || name, ...profile, routerId: this.config.id, routerName: this.config.name } as PppProfile;
  }
  async deleteProfile(name: string): Promise<boolean> {
    await this.remove('/ppp/profile', name);
    return true;
  }

  /* ---- simple queue ---- */
  async getQueues(): Promise<SimpleQueue[]> {
    return (await this.list('/queue/simple')).map((r) => mapQueue(r, this.config));
  }
  async createQueue(queue: SimpleQueue): Promise<SimpleQueue> {
    await this.add('/queue/simple', queueParams(queue, true));
    return { ...queue, routerId: this.config.id, routerName: this.config.name };
  }
  async updateQueue(name: string, queue: Partial<SimpleQueue>): Promise<SimpleQueue> {
    const params = queueParams(queue, false);
    if (params.name === name) delete params.name;
    if (Object.keys(params).length > 0) await this.set('/queue/simple', name, params);
    return { name: queue.name || name, ...queue, routerId: this.config.id, routerName: this.config.name } as SimpleQueue;
  }
  async deleteQueue(name: string): Promise<boolean> {
    await this.remove('/queue/simple', name);
    return true;
  }

  /* ---- ip pool ---- */
  async getPools(): Promise<IpPool[]> {
    return (await this.list('/ip/pool')).map((r) => mapPool(r, this.config));
  }
  async createPool(pool: IpPool): Promise<IpPool> {
    await this.add('/ip/pool', poolParams(pool, true));
    return { ...pool, routerId: this.config.id, routerName: this.config.name };
  }
  async updatePool(name: string, pool: Partial<IpPool>): Promise<IpPool> {
    const params = poolParams(pool, false);
    if (params.name === name) delete params.name;
    if (Object.keys(params).length > 0) await this.set('/ip/pool', name, params);
    return { name: pool.name || name, ...pool, routerId: this.config.id, routerName: this.config.name } as IpPool;
  }
  async deletePool(name: string): Promise<boolean> {
    await this.remove('/ip/pool', name);
    return true;
  }

  /* ---- ping ---- */
  async ping(address: string, count = 4, size = 32): Promise<PingResult> {
    const c = clampCount(count);
    const s = clampSize(size);
    try {
      const rows = await this.runPing(address, c, s);
      return buildPingResult(rows, address, c, s, this.config.name);
    } catch (err) {
      if (err instanceof RouterConnectionError || err instanceof RouterCommandError) throw err;
      throw new RouterCommandError(`Ping gagal: ${errorMessage(err)}`);
    }
  }
}
