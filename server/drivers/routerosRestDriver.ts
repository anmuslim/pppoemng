import http from 'http';
import https from 'https';
import { RouterConfig } from './types.js';
import { RouterosBaseDriver, ListOptions } from './routerosBaseDriver.js';
import { RouterConnectionError, RouterCommandError } from '../errors.js';
import { Row, clampCount } from './common.js';
import { config as appConfig } from '../config.js';

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * Transport REST API RouterOS v7 memakai node:http/https dengan keep-alive agent.
 * (fetch bawaan Node tidak bisa menerima sertifikat self-signed RouterOS tanpa dependensi tambahan,
 *  sehingga REST over HTTPS gagal pada konfigurasi default.)
 */
export class RouterosRestDriver extends RouterosBaseDriver {
  private agent: http.Agent | https.Agent;
  private isHttps: boolean;
  private host: string;
  private port: number;
  private authHeader: string;

  constructor(cfg: RouterConfig, password?: string) {
    super(cfg);
    this.isHttps = cfg.mode === 'API-SSL' || cfg.port === 443 || cfg.port === 8443;
    this.host = cfg.host;
    this.port = cfg.port || (this.isHttps ? 443 : 80);
    this.authHeader = `Basic ${Buffer.from(`${cfg.username}:${password || ''}`).toString('base64')}`;

    const common = { keepAlive: true, maxSockets: appConfig.router.poolSize, maxFreeSockets: 2, timeout: 60_000 };
    this.agent = this.isHttps
      ? new https.Agent({ ...common, rejectUnauthorized: appConfig.router.tlsVerify, ciphers: appConfig.router.tlsCiphers })
      : new http.Agent(common);
  }

  private request<T = any>(method: string, endpoint: string, body?: unknown, timeoutMs = appConfig.router.commandTimeoutMs): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const lib = this.isHttps ? https : http;
    const where = `${this.host}:${this.port}`;

    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn();
      };

      const req = lib.request(
        {
          host: this.host,
          port: this.port,
          method,
          path: `/rest${endpoint}`,
          agent: this.agent,
          headers: {
            Authorization: this.authHeader,
            Accept: 'application/json',
            ...(payload !== undefined
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy();
              finish(() => reject(new RouterConnectionError('Balasan REST router terlalu besar', 'protocol')));
              return;
            }
            chunks.push(c);
          });
          res.on('error', (e) => finish(() => reject(new RouterConnectionError(`Koneksi REST terputus: ${e.message}`, 'network'))));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode || 0;
            if (status === 401 || status === 403) {
              return finish(() =>
                reject(new RouterConnectionError('Login REST ditolak router (username/password salah atau tanpa izin "rest-api").', 'auth'))
              );
            }
            if (status >= 200 && status < 300) {
              if (!text) return finish(() => resolve({} as T));
              try {
                return finish(() => resolve(JSON.parse(text)));
              } catch {
                return finish(() => reject(new RouterConnectionError('Balasan REST bukan JSON yang valid', 'protocol')));
              }
            }
            let message = `HTTP ${status} ${res.statusMessage || ''}`.trim();
            try {
              const j = JSON.parse(text);
              message = j.detail || j.message || message;
            } catch {
              if (text) message = `${message} - ${text.slice(0, 120)}`;
            }
            // 404 pada /rest berarti service REST tidak ada (router < v7.1) atau path salah.
            if (status === 404 && /^\/?$|not found/i.test(message) && endpoint.split('/').length <= 3) {
              return finish(() => reject(new RouterCommandError(`${message} (pastikan RouterOS v7.1+ dan service www/www-ssl aktif)`)));
            }
            if (status >= 500 && status !== 500) {
              return finish(() => reject(new RouterConnectionError(message, 'network')));
            }
            finish(() => reject(new RouterCommandError(message)));
          });
        }
      );

      const timer = setTimeout(() => {
        req.destroy();
        finish(() =>
          reject(new RouterConnectionError(`Timeout menunggu router ${where} setelah ${Math.round(timeoutMs / 1000)} detik`, 'timeout'))
        );
      }, timeoutMs);

      req.on('error', (err: NodeJS.ErrnoException) => {
        const code = err.code || '';
        let e: RouterConnectionError;
        if (code === 'ECONNREFUSED') e = new RouterConnectionError(`Koneksi ditolak oleh ${where}. Pastikan service www/www-ssl aktif.`, 'refused');
        else if (code === 'ETIMEDOUT') e = new RouterConnectionError(`Timeout menghubungi ${where}`, 'timeout');
        else if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME_MISMATCH/i.test(code))
          e = new RouterConnectionError(`Sertifikat TLS router tidak tepercaya (${code}). Set ROUTEROS_TLS_VERIFY=false untuk sertifikat self-signed.`, 'protocol');
        else e = new RouterConnectionError(`Koneksi REST ke ${where} gagal: ${err.message || code}`, 'network');
        finish(() => reject(e));
      });

      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  private qs(opts: ListOptions): string {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query || {})) p.set(k, v);
    if (opts.proplist?.length) p.set('.proplist', opts.proplist.join(','));
    const s = p.toString();
    return s ? `?${s}` : '';
  }

  private async findId(path: string, name: string): Promise<string> {
    if (name.startsWith('*')) return name;
    const rows = await this.request<Row[]>('GET', `${path}${this.qs({ query: { name }, proplist: ['.id', 'name'] })}`);
    const hit = Array.isArray(rows) ? rows.find((r) => r.name === name) || rows[0] : undefined;
    if (!hit || !hit['.id']) throw new RouterCommandError(`Item '${name}' tidak ditemukan di router.`);
    return hit['.id'];
  }

  protected async list(path: string, opts: ListOptions = {}): Promise<Row[]> {
    const rows = await this.request<Row[]>('GET', `${path}${this.qs(opts)}`);
    return Array.isArray(rows) ? rows : [];
  }

  protected async add(path: string, params: Record<string, string>): Promise<void> {
    try {
      await this.request('PUT', path, params);
    } catch (err) {
      if (err instanceof RouterCommandError && /405|method not allowed/i.test(err.message)) {
        await this.request('POST', `${path}/add`, params);
        return;
      }
      throw err;
    }
  }

  protected async set(path: string, name: string, params: Record<string, string>): Promise<void> {
    const id = await this.findId(path, name);
    await this.request('PATCH', `${path}/${encodeURIComponent(id)}`, params);
  }

  protected async remove(path: string, name: string): Promise<void> {
    const id = await this.findId(path, name);
    await this.request('DELETE', `${path}/${encodeURIComponent(id)}`);
  }

  protected async setDisabled(path: string, name: string, disabled: boolean): Promise<void> {
    await this.set(path, name, { disabled: disabled ? 'yes' : 'no' });
  }

  protected async fetchResource() {
    const [resource, identity] = await Promise.all([
      this.request<Row>('GET', '/system/resource'),
      this.request<Row>('GET', '/system/identity').catch((e) => {
        if (e instanceof RouterConnectionError) throw e;
        return {} as Row;
      }),
    ]);
    return { resource, identity: identity?.name };
  }

  protected async monitorTraffic(iface: string): Promise<Row | null> {
    const r = await this.request<Row[] | Row>('POST', '/interface/monitor-traffic', { interface: iface, once: '' }, 8000);
    return Array.isArray(r) ? r[0] || null : r || null;
  }

  protected async runPing(address: string, count: number, size: number): Promise<Row[]> {
    const n = clampCount(count);
    const r = await this.request<Row[] | Row>('POST', '/ping', { address, count: String(n), size: String(size) }, n * 2500 + 6000);
    return Array.isArray(r) ? r : [r];
  }

  async close(): Promise<void> {
    this.agent.destroy();
  }
}
