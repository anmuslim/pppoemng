import { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import { AuthenticatedRequest } from './auth.js';

/**
 * Pembatas laju in-memory (cukup untuk satu proses; PM2 fork mode = 1 proses).
 * Memori dibatasi: entri kedaluwarsa dibersihkan berkala.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export function createRateLimiter(opts: { windowMs: number; max: number; key: (req: Request) => string; message?: string }) {
  const buckets = new Map<string, Bucket>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, Math.max(10_000, opts.windowMs));
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const k = opts.key(req);
    let b = buckets.get(k);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(k, b);
    }
    b.count++;
    if (b.count > opts.max) {
      const retry = Math.ceil((b.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({ success: false, error: opts.message || `Terlalu banyak permintaan. Coba lagi dalam ${retry} detik.` });
    }
    next();
  };
}

export const apiRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: config.apiRateLimitPerMinute,
  key: (req) => (req as AuthenticatedRequest).user?.userId || req.ip || 'unknown',
});

/** Pelacak kegagalan login: kunci per-IP dan per-username, dengan penguncian sementara. */
class FailureTracker {
  private map = new Map<string, { count: number; first: number; lockedUntil: number }>();
  constructor(private windowMs: number, private lockMs: number) {
    const t = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.map) if (v.lockedUntil <= now && now - v.first > this.windowMs) this.map.delete(k);
    }, 60_000);
    t.unref();
  }

  /** Detik tersisa bila terkunci, 0 bila tidak. */
  lockedSeconds(key: string): number {
    const v = this.map.get(key);
    if (!v) return 0;
    const left = v.lockedUntil - Date.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  fail(key: string, max: number) {
    const now = Date.now();
    let v = this.map.get(key);
    if (!v || now - v.first > this.windowMs) v = { count: 0, first: now, lockedUntil: 0 };
    v.count++;
    if (v.count >= max) {
      v.lockedUntil = now + this.lockMs;
      v.count = 0;
      v.first = now;
    }
    this.map.set(key, v);
  }

  reset(key: string) {
    this.map.delete(key);
  }
}

const lockMs = config.loginLockMinutes * 60_000;
const tracker = new FailureTracker(lockMs, lockMs);

export const loginGuard = {
  check(ip: string, username: string): number {
    return Math.max(tracker.lockedSeconds(`ip:${ip}`), tracker.lockedSeconds(`user:${username}`));
  },
  fail(ip: string, username: string) {
    tracker.fail(`ip:${ip}`, config.loginMaxFailuresPerIp);
    if (username) tracker.fail(`user:${username}`, config.loginMaxFailuresPerUser);
  },
  success(ip: string, username: string) {
    tracker.reset(`ip:${ip}`);
    tracker.reset(`user:${username}`);
  },
};
