import { PppActive, PppProfile, PppSecret, SimpleQueue, IpPool, PingResult, PingPacket, RouterConfig } from './types.js';

export type Row = Record<string, any>;

export const isTrue = (v: unknown): boolean => v === true || v === 'true' || v === 'yes';

export function formatRate(bps: number): string {
  if (!bps || bps <= 0) return '0 bps';
  if (bps >= 1_000_000_000) return `${(bps / 1_000_000_000).toFixed(2)} Gbps`;
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(1)} kbps`;
  return `${Math.round(bps)} bps`;
}

/** Waktu ping RouterOS ("12ms", "1ms456us", "456us", "1s2ms") -> milidetik. */
export function parseRosTimeMs(t: unknown): number {
  if (t === undefined || t === null || t === '') return 0;
  const s = String(t);
  let total = 0;
  let matched = false;
  const re = /([\d.]+)\s*(ms|us|s)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    matched = true;
    const n = parseFloat(m[1]);
    total += m[2] === 'ms' ? n : m[2] === 'us' ? n / 1000 : n * 1000;
  }
  return matched ? +total.toFixed(3) : parseFloat(s) || 0;
}

/**
 * Penghitung bps dari selisih byte antar polling. Dibatasi ukurannya
 * (sebelumnya Map statis tumbuh tanpa batas -> kebocoran memori jangka panjang).
 */
class TrafficTracker {
  private map = new Map<string, { rx: number; tx: number; at: number }>();
  constructor(private maxEntries = 50_000, private ttlMs = 10 * 60_000) {}

  compute(key: string, rx: number, tx: number, now = Date.now()): { rxBps: number; txBps: number } {
    const prev = this.map.get(key);
    this.map.delete(key); // pindahkan ke posisi terbaru (urutan penyisipan)
    this.map.set(key, { rx, tx, at: now });
    if (this.map.size > this.maxEntries) this.prune(now);

    if (prev && rx >= prev.rx && tx >= prev.tx) {
      const dt = (now - prev.at) / 1000;
      if (dt > 0.5 && dt < 30) {
        return { rxBps: Math.round(((rx - prev.rx) * 8) / dt), txBps: Math.round(((tx - prev.tx) * 8) / dt) };
      }
    }
    return { rxBps: 0, txBps: 0 };
  }

  private prune(now: number) {
    for (const [k, v] of this.map) {
      if (now - v.at > this.ttlMs) this.map.delete(k);
      else break; // urutan penyisipan = urutan waktu
    }
    while (this.map.size > this.maxEntries) {
      const first = this.map.keys().next().value;
      if (first === undefined) break;
      this.map.delete(first);
    }
  }

  get size() {
    return this.map.size;
  }
}

export const trafficTracker = new TrafficTracker();

function splitPair(v: unknown): [number, number] | null {
  if (v === undefined || v === null) return null;
  const parts = String(v).split('/');
  if (parts.length < 2) return null;
  return [Number(parts[0]) || 0, Number(parts[1]) || 0];
}

/* ------------------------------ pemetaan data ------------------------------ */

export function mapSecret(item: Row, cfg: RouterConfig): PppSecret {
  return {
    name: item.name,
    password: item.password,
    service: item.service || 'any',
    profile: item.profile || 'default',
    localAddress: item['local-address'],
    remoteAddress: item['remote-address'],
    callerId: item['caller-id'],
    lastCallerId: item['last-caller-id'] || item['caller-id'],
    disabled: isTrue(item.disabled),
    comment: item.comment,
    lastLoggedOut: item['last-logged-out'],
    routerId: cfg.id,
    routerName: cfg.name,
  };
}

export function secretParams(s: Partial<PppSecret>, forCreate: boolean): Record<string, string> {
  const p: Record<string, string> = {};
  if (forCreate) {
    p.name = s.name as string;
    p.password = s.password || '';
    p.service = s.service || 'pppoe';
    p.profile = s.profile || 'default';
    p.disabled = s.disabled ? 'yes' : 'no';
    if (s.localAddress) p['local-address'] = s.localAddress;
    if (s.remoteAddress) p['remote-address'] = s.remoteAddress;
    if (s.callerId) p['caller-id'] = s.callerId;
    if (s.comment) p.comment = s.comment;
    return p;
  }
  if (s.name !== undefined) p.name = s.name;
  if (s.password !== undefined) p.password = s.password;
  if (s.service !== undefined) p.service = s.service;
  if (s.profile !== undefined) p.profile = s.profile;
  if (s.localAddress !== undefined) p['local-address'] = s.localAddress;
  if (s.remoteAddress !== undefined) p['remote-address'] = s.remoteAddress;
  if (s.callerId !== undefined) p['caller-id'] = s.callerId;
  if (s.comment !== undefined) p.comment = s.comment;
  if (s.disabled !== undefined) p.disabled = s.disabled ? 'yes' : 'no';
  return p;
}

export function mapProfile(item: Row, cfg: RouterConfig): PppProfile {
  return {
    name: item.name,
    localAddress: item['local-address'],
    remoteAddress: item['remote-address'],
    rateLimit: item['rate-limit'],
    parentQueue: item['parent-queue'],
    onlyOne: isTrue(item['only-one']),
    dnsServer: item['dns-server'],
    comment: item.comment,
    routerId: cfg.id,
    routerName: cfg.name,
  };
}

export function profileParams(p: Partial<PppProfile>, forCreate: boolean): Record<string, string> {
  const o: Record<string, string> = {};
  if (forCreate) {
    o.name = p.name as string;
    if (p.localAddress) o['local-address'] = p.localAddress;
    if (p.remoteAddress) o['remote-address'] = p.remoteAddress;
    if (p.rateLimit) o['rate-limit'] = p.rateLimit;
    if (p.parentQueue) o['parent-queue'] = p.parentQueue;
    if (p.onlyOne !== undefined) o['only-one'] = p.onlyOne ? 'yes' : 'no';
    if (p.dnsServer) o['dns-server'] = p.dnsServer;
    if (p.comment) o.comment = p.comment;
    return o;
  }
  if (p.name !== undefined) o.name = p.name;
  if (p.localAddress !== undefined) o['local-address'] = p.localAddress;
  if (p.remoteAddress !== undefined) o['remote-address'] = p.remoteAddress;
  if (p.rateLimit !== undefined) o['rate-limit'] = p.rateLimit;
  if (p.parentQueue !== undefined) o['parent-queue'] = p.parentQueue;
  if (p.onlyOne !== undefined) o['only-one'] = p.onlyOne ? 'yes' : 'no';
  if (p.dnsServer !== undefined) o['dns-server'] = p.dnsServer;
  if (p.comment !== undefined) o.comment = p.comment;
  return o;
}

export function mapQueue(item: Row, cfg: RouterConfig): SimpleQueue {
  return {
    name: item.name,
    target: item.target,
    maxLimit: item['max-limit'],
    limitAt: item['limit-at'],
    priority: item.priority,
    comment: item.comment,
    parent: item.parent && item.parent !== 'none' ? item.parent : undefined,
    routerId: cfg.id,
    routerName: cfg.name,
  };
}

export function queueParams(q: Partial<SimpleQueue>, forCreate: boolean): Record<string, string> {
  const o: Record<string, string> = {};
  if (forCreate) {
    o.name = q.name as string;
    o.target = q.target || '0.0.0.0/0';
    if (q.maxLimit) o['max-limit'] = q.maxLimit;
    if (q.limitAt) o['limit-at'] = q.limitAt;
    if (q.priority) o.priority = q.priority;
    if (q.parent) o.parent = q.parent;
    if (q.comment) o.comment = q.comment;
    return o;
  }
  if (q.name !== undefined) o.name = q.name;
  if (q.target !== undefined) o.target = q.target;
  if (q.maxLimit !== undefined) o['max-limit'] = q.maxLimit;
  if (q.limitAt !== undefined) o['limit-at'] = q.limitAt;
  if (q.priority !== undefined) o.priority = q.priority;
  if (q.parent !== undefined) o.parent = q.parent || 'none';
  if (q.comment !== undefined) o.comment = q.comment;
  return o;
}

export function mapPool(item: Row, cfg: RouterConfig): IpPool {
  return {
    name: item.name,
    ranges: item.ranges,
    nextPool: item['next-pool'] && item['next-pool'] !== 'none' ? item['next-pool'] : undefined,
    comment: item.comment,
    routerId: cfg.id,
    routerName: cfg.name,
  };
}

export function poolParams(p: Partial<IpPool>, forCreate: boolean): Record<string, string> {
  const o: Record<string, string> = {};
  if (forCreate) {
    o.name = p.name as string;
    o.ranges = p.ranges as string;
    if (p.nextPool) o['next-pool'] = p.nextPool;
    if (p.comment) o.comment = p.comment;
    return o;
  }
  if (p.name !== undefined) o.name = p.name;
  if (p.ranges !== undefined) o.ranges = p.ranges;
  if (p.nextPool !== undefined) o['next-pool'] = p.nextPool || 'none';
  if (p.comment !== undefined) o.comment = p.comment;
  return o;
}

/** Gabungkan daftar sesi aktif dengan laju trafik dari simple queue & profile dari secret. */
export function buildActive(
  activeRows: Row[],
  queueRows: Row[],
  profileByUser: Map<string, string>,
  cfg: RouterConfig
): PppActive[] {
  const queueMap = new Map<string, Row>();
  for (const q of queueRows) {
    if (!q) continue;
    if (q.name) {
      const lower = String(q.name).toLowerCase();
      queueMap.set(lower, q);
      queueMap.set(lower.replace(/^<pppoe-/, '').replace(/>$/, ''), q);
    }
    if (q.target) {
      const ip = String(q.target).split('/')[0].trim();
      if (ip) queueMap.set(ip, q);
    }
  }

  const now = Date.now();
  return activeRows
    .filter((item) => item && item.name)
    .map((item) => {
      const username = String(item.name);
      const lower = username.toLowerCase();
      const q = queueMap.get(`<pppoe-${lower}>`) || queueMap.get(lower) || (item.address ? queueMap.get(item.address) : undefined);

      let rxBps = 0;
      let txBps = 0;
      if (q) {
        const rate = splitPair(q.rate);
        if (rate) [rxBps, txBps] = rate;
        if (rxBps === 0 && txBps === 0) {
          const bytes = splitPair(q.bytes);
          if (bytes) ({ rxBps, txBps } = trafficTracker.compute(`${cfg.id}:::${username}`, bytes[0], bytes[1], now));
        }
      }

      return {
        name: username,
        service: item.service || 'pppoe',
        profile: item.profile || profileByUser.get(lower) || 'default',
        callerId: item['caller-id'],
        address: item.address,
        uptime: item.uptime,
        encoding: item.encoding,
        rxRate: formatRate(rxBps),
        txRate: formatRate(txBps),
        rxBps,
        txBps,
        downloadRate: formatRate(txBps),
        uploadRate: formatRate(rxBps),
        interfaceName: `<pppoe-${username}>`,
        routerId: cfg.id,
        routerName: cfg.name,
      };
    });
}

export function buildPingResult(
  rows: Row[],
  address: string,
  requestedCount: number,
  requestedSize: number,
  routerName: string
): PingResult {
  const packets: PingPacket[] = [];
  let received = 0;
  let min = Infinity;
  let max = 0;
  let sum = 0;

  rows.forEach((item, idx) => {
    if (!item) return;
    const timeMs = parseRosTimeMs(item.time);
    const replied = item.status ? item.status === 'reply' : timeMs > 0 || item.ttl !== undefined;
    if (replied) {
      received++;
      min = Math.min(min, timeMs);
      max = Math.max(max, timeMs);
      sum += timeMs;
    }
    packets.push({
      seq: idx + 1,
      host: item.host || address,
      size: Number(item.size) || requestedSize,
      ttl: Number(item.ttl) || 64,
      timeMs,
      status: replied ? 'reply' : 'timeout',
    });
  });

  const sent = Math.max(requestedCount, packets.length);
  return {
    target: address,
    routerName,
    sent,
    received,
    lost: sent - received,
    packetLoss: +(((sent - received) / sent) * 100).toFixed(0),
    minRtt: min === Infinity ? 0 : min,
    avgRtt: received > 0 ? +(sum / received).toFixed(1) : 0,
    maxRtt: max,
    packets,
    timestamp: Date.now(),
  };
}

export const clampCount = (n: unknown, max = 10) => Math.max(1, Math.min(max, Number(n) || 4));
export const clampSize = (n: unknown) => Math.max(28, Math.min(1500, Number(n) || 32));
