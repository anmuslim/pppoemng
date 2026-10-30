import { Request, Response, NextFunction, RequestHandler } from 'express';
import { routerManager, CacheOpts } from '../drivers/manager.js';
import { IRouterDriver, RouterConfig } from '../drivers/types.js';
import { storage } from '../storage.js';
import { AuthenticatedRequest } from '../auth.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { config } from '../config.js';

export const asyncHandler =
  (fn: (req: any, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

/* ------------------------------ validasi input ------------------------------ */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Ambil string terpangkas. undefined/null/'' -> undefined. Tipe lain atau terlalu panjang -> 400. */
export function optStr(value: unknown, label: string, max = 255): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`${label} harus berupa teks.`);
  const v = value.trim();
  if (!v) return undefined;
  if (v.length > max) throw badRequest(`${label} terlalu panjang (maksimal ${max} karakter).`);
  if (CONTROL_CHARS.test(v)) throw badRequest(`${label} mengandung karakter yang tidak diizinkan.`);
  return v;
}

export function reqStr(value: unknown, label: string, max = 255): string {
  const v = optStr(value, label, max);
  if (!v) throw badRequest(`${label} wajib diisi.`);
  return v;
}

/** String yang boleh dikosongkan secara eksplisit (untuk PATCH: '' berarti hapus nilai). */
export function patchStr(value: unknown, label: string, max = 255): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`${label} harus berupa teks.`);
  const v = value.trim();
  if (v.length > max) throw badRequest(`${label} terlalu panjang (maksimal ${max} karakter).`);
  if (CONTROL_CHARS.test(v)) throw badRequest(`${label} mengandung karakter yang tidak diizinkan.`);
  return v;
}

export function bodyOf(req: Request): Record<string, any> {
  const b = req.body;
  return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
}

/* ------------------------------ cache per jenis data ------------------------------ */

export const cacheFor = {
  secrets: { key: 'secrets', ttlMs: config.cache.secretsTtlMs } as CacheOpts,
  active: { key: 'active', ttlMs: config.cache.activeTtlMs } as CacheOpts,
  profiles: { key: 'profiles', ttlMs: config.cache.configTtlMs } as CacheOpts,
  queues: { key: 'queues', ttlMs: config.cache.configTtlMs } as CacheOpts,
  pools: { key: 'pools', ttlMs: config.cache.configTtlMs } as CacheOpts,
};

export type ResourceKind = keyof typeof cacheFor;

const listers: Record<ResourceKind, (d: IRouterDriver) => Promise<Array<{ name: string; routerId?: string }>>> = {
  secrets: (d) => d.getSecrets(),
  active: (d) => d.getActive(),
  profiles: (d) => d.getProfiles(),
  queues: (d) => d.getQueues(),
  pools: (d) => d.getPools(),
};

/* ------------------------------ resolusi router ------------------------------ */

export const routerIdParam = (req: Request): string => (req.params as any).routerId || 'all';

/** routerId eksplisit dari body/query (selain 'all'). */
export function explicitRouterId(req: Request): string | undefined {
  const fromBody = bodyOf(req).routerId;
  const fromQuery = req.query.routerId;
  for (const v of [fromBody, fromQuery]) {
    if (typeof v === 'string' && v && v !== 'all') return v;
  }
  return undefined;
}

/** Untuk membuat item baru: wajib jelas router tujuannya. */
export function resolveForCreate(req: Request): RouterConfig {
  const id = explicitRouterId(req) || (routerIdParam(req) !== 'all' ? routerIdParam(req) : undefined);
  if (!id) throw badRequest('Pilih router tujuan terlebih dahulu (mode "Semua Router" tidak bisa dipakai untuk membuat data).');
  return routerManager.requireRouter(id);
}

/**
 * Untuk mengubah/menghapus item bernama. Bila router tidak disebut dan mode "all",
 * dicari lewat daftar (ber-cache). Nama ganda di beberapa router -> 409 (TIDAK menebak router pertama).
 */
export async function resolveByName(
  routerParam: string,
  explicit: string | undefined,
  name: string,
  kind: ResourceKind
): Promise<RouterConfig> {
  if (explicit) return routerManager.requireRouter(explicit);
  if (routerParam !== 'all') return routerManager.requireRouter(routerParam);

  const { data } = await routerManager.executeOnRouters('all', (d) => listers[kind](d), cacheFor[kind]);
  const ids = [...new Set(data.filter((x) => x.name === name).map((x) => x.routerId))];
  if (ids.length === 0) throw notFound(`'${name}' tidak ditemukan di router mana pun.`);
  if (ids.length > 1) throw conflict(`'${name}' ada di ${ids.length} router. Pilih router spesifik terlebih dahulu.`);
  return routerManager.requireRouter(ids[0] as string);
}

export function routerLabel(routerParam: string): { id: string; name: string } {
  if (routerParam === 'all') return { id: 'all', name: 'Semua Router' };
  const r = storage.getRouter(routerParam);
  return { id: routerParam, name: r?.name || routerParam };
}

/* ------------------------------ audit & bulk ------------------------------ */

export const actor = (req: AuthenticatedRequest) => req.user?.username || 'system';

export const MAX_BULK_ITEMS = 2000;

export function parseBulkItems(raw: unknown): Array<{ name: string; routerId?: string }> {
  if (!Array.isArray(raw) || raw.length === 0) throw badRequest('Daftar item wajib diisi.');
  if (raw.length > MAX_BULK_ITEMS) throw badRequest(`Maksimal ${MAX_BULK_ITEMS} item per aksi massal.`);
  return raw.map((it, i) => {
    if (!it || typeof it !== 'object' || typeof (it as any).name !== 'string' || !(it as any).name) {
      throw badRequest(`Item ke-${i + 1} tidak valid.`);
    }
    const rid = (it as any).routerId;
    return { name: (it as any).name, routerId: typeof rid === 'string' && rid !== 'all' ? rid : undefined };
  });
}

/** Jalankan fungsi untuk banyak item dengan konkurensi terbatas; kumpulkan hasil per item. */
export async function runBulk<T extends { name: string }>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency = 4
): Promise<{ successCount: number; errors: Record<string, string> }> {
  let successCount = 0;
  const errors: Record<string, string> = {};
  let cursor = 0;

  const worker = async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      try {
        await fn(item);
        successCount++;
      } catch (err: any) {
        errors[item.name] = err?.message || 'Gagal';
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return { successCount, errors };
}
