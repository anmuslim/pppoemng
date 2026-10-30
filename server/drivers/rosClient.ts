import net from 'net';
import tls from 'tls';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { RouterConnectionError, RouterCommandError } from '../errors.js';

/* ------------------------------------------------------------------ *
 *  Klien protokol RouterOS API (port 8728 / 8729-SSL).
 *
 *  Ditulis sendiri karena pustaka `node-routeros` sudah dihentikan dan
 *  tidak mengenal balasan `!empty` yang dikirim RouterOS v7.18+ untuk
 *  hasil kosong (membuat perintah error/menggantung).
 *
 *  Fitur:
 *   - Parser stream (tahan paket terpotong / banyak kalimat dalam satu chunk)
 *   - Login modern (>= 6.43) dan challenge-response lama (< 6.43)
 *   - Timeout per perintah, penghancuran koneksi saat timeout (tanpa zombie)
 *   - Pool koneksi per router: dipakai ulang, ditutup saat idle, retry untuk
 *     perintah baca bila koneksi basi
 * ------------------------------------------------------------------ */

export type RosRow = Record<string, string>;

export interface RosReply {
  rows: RosRow[];
  /** Atribut pada kalimat !done (mis. `ret` untuk count-only / add). */
  done: RosRow;
}

export interface RosConnectOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  tls?: boolean;
  rejectUnauthorized?: boolean;
  ciphers?: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}

const MAX_WORD_BYTES = 8 * 1024 * 1024;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 500_000;

/* --------------------------- encode / decode --------------------------- */

export function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x4000) return Buffer.from([(len >> 8) | 0x80, len & 0xff]);
  if (len < 0x200000) return Buffer.from([(len >> 16) | 0xc0, (len >> 8) & 0xff, len & 0xff]);
  if (len < 0x10000000) {
    return Buffer.from([(len >> 24) | 0xe0, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  }
  const b = Buffer.alloc(5);
  b[0] = 0xf0;
  b.writeUInt32BE(len, 1);
  return b;
}

export function encodeSentence(words: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const w of words) {
    const body = Buffer.from(w, 'utf8');
    parts.push(encodeLength(body.length), body);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** Parser stream: masukkan chunk, dapatkan kalimat (array word) yang sudah lengkap. */
export class SentenceParser {
  private buf: Buffer = Buffer.alloc(0);
  private words: string[] = [];

  push(chunk: Buffer): string[][] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    if (this.buf.length > MAX_BUFFER_BYTES) {
      throw new RouterConnectionError('Balasan router terlalu besar', 'protocol');
    }

    const sentences: string[][] = [];
    let pos = 0;

    for (;;) {
      if (pos >= this.buf.length) break;
      const b = this.buf[pos];
      let len: number;
      let hdr: number;

      if (b < 0x80) {
        len = b;
        hdr = 1;
      } else if ((b & 0xc0) === 0x80) {
        if (pos + 2 > this.buf.length) break;
        len = ((b & 0x3f) << 8) | this.buf[pos + 1];
        hdr = 2;
      } else if ((b & 0xe0) === 0xc0) {
        if (pos + 3 > this.buf.length) break;
        len = ((b & 0x1f) << 16) | (this.buf[pos + 1] << 8) | this.buf[pos + 2];
        hdr = 3;
      } else if ((b & 0xf0) === 0xe0) {
        if (pos + 4 > this.buf.length) break;
        len = ((b & 0x0f) << 24) | (this.buf[pos + 1] << 16) | (this.buf[pos + 2] << 8) | this.buf[pos + 3];
        hdr = 4;
      } else if (b === 0xf0) {
        if (pos + 5 > this.buf.length) break;
        len = this.buf.readUInt32BE(pos + 1);
        hdr = 5;
      } else {
        throw new RouterConnectionError('Protokol RouterOS tidak valid (byte kontrol tak dikenal)', 'protocol');
      }

      if (len > MAX_WORD_BYTES) throw new RouterConnectionError('Word RouterOS terlalu besar', 'protocol');
      if (len === 0) {
        // akhir kalimat
        pos += hdr;
        sentences.push(this.words);
        this.words = [];
        continue;
      }
      if (pos + hdr + len > this.buf.length) break; // tunggu sisa data
      this.words.push(this.buf.toString('utf8', pos + hdr, pos + hdr + len));
      pos += hdr + len;
    }

    this.buf = pos >= this.buf.length ? Buffer.alloc(0) : this.buf.subarray(pos);
    return sentences;
  }
}

function parseAttrs(words: string[]): RosRow {
  const out: RosRow = {};
  for (const w of words) {
    if (w.charCodeAt(0) !== 61 /* '=' */) continue;
    const idx = w.indexOf('=', 1);
    if (idx === -1) continue;
    out[w.slice(1, idx)] = w.slice(idx + 1);
  }
  return out;
}

/* ------------------------------- koneksi ------------------------------- */

function mapSocketError(err: NodeJS.ErrnoException, host: string, port: number): RouterConnectionError {
  const code = err.code || '';
  const where = `${host}:${port}`;
  if (code === 'ECONNREFUSED') {
    return new RouterConnectionError(`Koneksi ditolak oleh ${where}. Pastikan service API aktif di router.`, 'refused');
  }
  if (code === 'ETIMEDOUT') return new RouterConnectionError(`Timeout menghubungi ${where}`, 'timeout');
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new RouterConnectionError(`Router ${where} tidak dapat dijangkau (${code})`, 'network');
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME_MISMATCH/i.test(code)) {
    return new RouterConnectionError(
      `Sertifikat TLS router ${where} tidak tepercaya (${code}). Set ROUTEROS_TLS_VERIFY=false bila memakai sertifikat self-signed.`,
      'protocol'
    );
  }
  return new RouterConnectionError(`Koneksi ke ${where} gagal: ${err.message || code}`, 'network');
}

interface Pending {
  resolve: (r: RosReply) => void;
  reject: (e: Error) => void;
  rows: RosRow[];
  trap?: string;
  timer: NodeJS.Timeout;
}

export class RosConnection extends EventEmitter {
  private socket!: net.Socket;
  private parser = new SentenceParser();
  private pending: Pending | null = null;
  public closed = false;
  public uses = 0;
  public lastUsed = Date.now();

  private constructor(private opts: RosConnectOptions) {
    super();
  }

  static async connect(opts: RosConnectOptions): Promise<RosConnection> {
    const conn = new RosConnection(opts);
    await conn.open();
    try {
      await conn.login();
    } catch (err) {
      conn.destroy();
      throw err;
    }
    return conn;
  }

  private open(): Promise<void> {
    const { host, port } = this.opts;
    const connectTimeout = this.opts.connectTimeoutMs ?? 5000;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          this.socket?.destroy();
        } catch {
          /* abaikan */
        }
        reject(e);
      };
      const ok = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(
        () => fail(new RouterConnectionError(`Timeout menghubungi ${host}:${port} (${connectTimeout} ms)`, 'timeout')),
        connectTimeout
      );

      try {
        if (this.opts.tls) {
          this.socket = tls.connect({
            host,
            port,
            rejectUnauthorized: this.opts.rejectUnauthorized ?? false,
            ciphers: this.opts.ciphers,
            servername: net.isIP(host) ? undefined : host,
          });
          this.socket.once('secureConnect', ok);
        } else {
          this.socket = net.connect({ host, port });
          this.socket.once('connect', ok);
        }
      } catch (err: any) {
        fail(mapSocketError(err, host, port));
        return;
      }

      this.socket.setNoDelay(true);
      this.socket.setKeepAlive(true, 15_000);

      // Handler error SELALU terpasang: error socket tidak boleh jadi uncaughtException.
      this.socket.on('error', (err: NodeJS.ErrnoException) => {
        const mapped = mapSocketError(err, host, port);
        if (!settled) return fail(mapped);
        this.fail(mapped);
      });
      this.socket.on('close', () => {
        if (!settled) return fail(new RouterConnectionError(`Koneksi ke ${host}:${port} ditutup`, 'network'));
        this.fail(new RouterConnectionError('Koneksi ditutup oleh router', 'network'));
      });
      this.socket.on('data', (chunk) => this.onData(chunk));
    });
  }

  private async login(): Promise<void> {
    const { user, password } = this.opts;
    try {
      const first = await this.write(['/login', `=name=${user}`, `=password=${password}`]);
      const challenge = first.done.ret;
      if (challenge) {
        // RouterOS < 6.43: challenge-response MD5
        const md5 = crypto.createHash('md5');
        md5.update(Buffer.from([0]));
        md5.update(password, 'utf8');
        md5.update(Buffer.from(challenge, 'hex'));
        await this.write(['/login', `=name=${user}`, `=response=00${md5.digest('hex')}`]);
      }
    } catch (err) {
      if (err instanceof RouterCommandError) {
        throw new RouterConnectionError(
          `Login ditolak router (${err.message}). Periksa username/password & hak akses API user.`,
          'auth'
        );
      }
      throw err;
    }
  }

  private onData(chunk: Buffer) {
    let sentences: string[][];
    try {
      sentences = this.parser.push(chunk);
    } catch (err: any) {
      this.fail(err instanceof RouterConnectionError ? err : new RouterConnectionError(err.message, 'protocol'));
      return;
    }
    for (const words of sentences) this.onSentence(words);
  }

  private onSentence(words: string[]) {
    const p = this.pending;
    if (!p || words.length === 0) return;
    const type = words[0];

    switch (type) {
      case '!re':
        if (p.rows.length >= MAX_ROWS) {
          this.fail(new RouterConnectionError('Jumlah baris balasan melebihi batas aman', 'protocol'));
          return;
        }
        p.rows.push(parseAttrs(words.slice(1)));
        break;
      case '!empty':
        // RouterOS v7.18+: hasil kosong. Akan diikuti !done.
        break;
      case '!trap': {
        const a = parseAttrs(words.slice(1));
        p.trap = a.message || 'Perintah ditolak router';
        break;
      }
      case '!done': {
        const done = parseAttrs(words.slice(1));
        clearTimeout(p.timer);
        this.pending = null;
        this.lastUsed = Date.now();
        if (p.trap !== undefined) p.reject(new RouterCommandError(p.trap));
        else p.resolve({ rows: p.rows, done });
        break;
      }
      case '!fatal':
        this.fail(new RouterConnectionError(`Router menutup koneksi: ${words[1] || 'fatal'}`, 'protocol'));
        break;
      default:
        break;
    }
  }

  /** Kirim satu perintah dan tunggu balasan lengkap. Satu perintah dalam satu waktu per koneksi. */
  write(words: string[], timeoutMs?: number): Promise<RosReply> {
    if (this.closed) {
      return Promise.reject(new RouterConnectionError('Koneksi router sudah tertutup', 'network'));
    }
    if (this.pending) {
      return Promise.reject(new Error('Internal: perintah bersamaan pada satu koneksi'));
    }
    const limit = timeoutMs ?? this.opts.commandTimeoutMs ?? 12_000;

    return new Promise<RosReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Koneksi dihancurkan agar balasan terlambat tidak mencemari perintah berikutnya.
        this.fail(
          new RouterConnectionError(`Timeout menunggu balasan router setelah ${Math.round(limit / 1000)} detik`, 'timeout')
        );
      }, limit);
      this.pending = { resolve, reject, rows: [], timer };
      this.uses++;
      this.socket.write(encodeSentence(words), (err) => {
        if (err) this.fail(mapSocketError(err as NodeJS.ErrnoException, this.opts.host, this.opts.port));
      });
    });
  }

  private fail(err: Error) {
    const p = this.pending;
    this.pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.destroy();
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket?.destroy();
    } catch {
      /* abaikan */
    }
    this.emit('close');
  }

  /** Tutup baik-baik. */
  close() {
    if (this.closed) return;
    try {
      this.socket.write(encodeSentence(['/quit']));
    } catch {
      /* abaikan */
    }
    this.destroy();
  }
}

/* --------------------------------- pool --------------------------------- */

interface Waiter {
  resolve: (c: RosConnection) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RosPoolOptions extends RosConnectOptions {
  size: number;
  idleCloseMs: number;
}

export class RosPool {
  private idle: RosConnection[] = [];
  private live = 0; // idle + dipakai + sedang connect
  private waiters: Waiter[] = [];
  private closed = false;
  private idleTimers = new Map<RosConnection, NodeJS.Timeout>();

  constructor(private opts: RosPoolOptions) {}

  private async acquire(timeoutMs: number): Promise<RosConnection> {
    if (this.closed) throw new RouterConnectionError('Pool koneksi router sudah ditutup', 'network');

    while (this.idle.length > 0) {
      const c = this.idle.pop()!;
      this.clearIdleTimer(c);
      if (!c.closed) return c;
    }

    if (this.live < this.opts.size) {
      this.live++;
      try {
        const c = await RosConnection.connect(this.opts);
        c.once('close', () => {
          this.live--;
          this.idle = this.idle.filter((x) => x !== c);
          this.clearIdleTimer(c);
          this.pump();
        });
        return c;
      } catch (err) {
        this.live--;
        this.pump();
        throw err;
      }
    }

    return new Promise<RosConnection>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new RouterConnectionError('Antrean koneksi ke router penuh (router sibuk)', 'timeout'));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  /** Bangunkan penunggu bila ada slot kosong. */
  private pump() {
    while (this.waiters.length > 0 && !this.closed) {
      if (this.idle.length > 0) {
        const c = this.idle.pop()!;
        this.clearIdleTimer(c);
        if (c.closed) continue;
        const w = this.waiters.shift()!;
        clearTimeout(w.timer);
        w.resolve(c);
      } else if (this.live < this.opts.size) {
        const w = this.waiters.shift()!;
        clearTimeout(w.timer);
        this.live++;
        RosConnection.connect(this.opts).then(
          (c) => {
            c.once('close', () => {
              this.live--;
              this.idle = this.idle.filter((x) => x !== c);
              this.clearIdleTimer(c);
              this.pump();
            });
            w.resolve(c);
          },
          (err) => {
            this.live--;
            w.reject(err);
            this.pump();
          }
        );
      } else {
        break;
      }
    }
  }

  private release(c: RosConnection) {
    if (c.closed || this.closed) {
      c.destroy();
      return;
    }
    if (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      w.resolve(c);
      return;
    }
    this.idle.push(c);
    const t = setTimeout(() => c.close(), this.opts.idleCloseMs);
    t.unref();
    this.idleTimers.set(c, t);
  }

  private clearIdleTimer(c: RosConnection) {
    const t = this.idleTimers.get(c);
    if (t) {
      clearTimeout(t);
      this.idleTimers.delete(c);
    }
  }

  /**
   * Jalankan `fn` dengan satu koneksi eksklusif.
   * `idempotent: true` (perintah baca) -> bila koneksi hasil pakai-ulang ternyata basi,
   * diulang sekali dengan koneksi baru. Perintah tulis TIDAK diulang otomatis.
   */
  async use<T>(fn: (conn: RosConnection) => Promise<T>, opts: { idempotent?: boolean; acquireTimeoutMs?: number } = {}): Promise<T> {
    const acquireTimeout = opts.acquireTimeoutMs ?? 10_000;
    for (let attempt = 0; ; attempt++) {
      const conn = await this.acquire(acquireTimeout);
      const reused = conn.uses > 1; // 1 = hanya login
      try {
        const result = await fn(conn);
        this.release(conn);
        return result;
      } catch (err) {
        const connectionLevel = err instanceof RouterConnectionError;
        if (connectionLevel) conn.destroy();
        else this.release(conn); // error perintah biasa: koneksi masih sehat
        const staleRetry =
          connectionLevel && opts.idempotent && reused && attempt === 0 && (err as RouterConnectionError).kind !== 'timeout';
        if (staleRetry) continue;
        throw err;
      }
    }
  }

  close() {
    this.closed = true;
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new RouterConnectionError('Pool koneksi ditutup', 'network'));
    }
    this.waiters = [];
    for (const c of this.idle) {
      this.clearIdleTimer(c);
      c.close();
    }
    this.idle = [];
  }

  stats() {
    return { live: this.live, idle: this.idle.length, waiting: this.waiters.length };
  }
}
