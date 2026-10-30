import { Router, Response } from 'express';
import { routerManager } from '../drivers/manager.js';
import { storage } from '../storage.js';
import { AuthenticatedRequest } from '../auth.js';
import { IpPool } from '../drivers/types.js';
import { badRequest } from '../errors.js';
import { logger } from '../logger.js';
import {
  asyncHandler,
  bodyOf,
  cacheFor,
  optStr,
  reqStr,
  patchStr,
  routerIdParam,
  explicitRouterId,
  resolveForCreate,
  resolveByName,
  actor,
} from './helpers.js';

const router = Router({ mergeParams: true });

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/** Contoh valid: 10.10.0.2-10.10.0.254, 192.168.1.0/24, 10.0.0.5 (dipisah koma). */
export function validateIpRange(rangeStr: string): boolean {
  if (!rangeStr) return false;
  return rangeStr.split(',').every((raw) => {
    const part = raw.trim();
    if (!part) return false;
    if (part.includes('-')) {
      const [a, b, ...rest] = part.split('-').map((s) => s.trim());
      return rest.length === 0 && IPV4.test(a) && IPV4.test(b);
    }
    if (part.includes('/')) {
      const [ip, mask] = part.split('/');
      const m = Number(mask);
      return IPV4.test(ip) && Number.isInteger(m) && m >= 0 && m <= 32;
    }
    return IPV4.test(part);
  });
}

const RANGE_ERROR =
  'Format IP Range tidak valid. Contoh format yang benar: 10.10.0.2-10.10.0.254 atau 192.168.1.50-192.168.1.150';

router.get(
  '/',
  asyncHandler(async (req, res: Response) => {
    const { data, errors } = await routerManager.executeOnRouters<IpPool>(routerIdParam(req), (d) => d.getPools(), cacheFor.pools);
    res.json({ success: true, data, errors: Object.keys(errors).length > 0 ? errors : undefined });
  })
);

router.post(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = bodyOf(req);
    const name = reqStr(b.name, 'Nama pool', 128);
    const ranges = reqStr(b.ranges, 'IP Range', 512);
    if (!validateIpRange(ranges)) throw badRequest(RANGE_ERROR);
    const nextPool = optStr(b.nextPool, 'Next pool', 128);
    const cfg = resolveForCreate(req);

    const created = await routerManager.mutate(cfg, async (d) => {
      const existing = await d.getPools();
      const dup = existing.find((p) => p.ranges === ranges);
      if (dup) logger.warn(`Range IP identik dengan pool '${dup.name}' pada router ${cfg.name}`);
      return d.createPool({
        name,
        ranges,
        nextPool: nextPool && nextPool !== 'none' ? nextPool : undefined,
        comment: optStr(b.comment, 'Komentar', 255),
      });
    });

    storage.addAuditLog({
      username: actor(req),
      routerId: cfg.id,
      routerName: cfg.name,
      action: 'CREATE',
      targetType: 'POOL',
      targetName: created.name,
      details: `Membuat IP Pool '${created.name}' dengan range '${created.ranges}'`,
    });
    res.status(201).json({ success: true, data: created });
  })
);

router.put(
  '/:name',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const name = req.params.name;
    const b = bodyOf(req);
    const patch: Partial<IpPool> = {};
    const pn = patchStr(b.name, 'Nama pool', 128);
    if (pn !== undefined) {
      if (!pn) throw badRequest('Nama pool tidak boleh kosong.');
      patch.name = pn;
    }
    const pr = patchStr(b.ranges, 'IP Range', 512);
    if (pr !== undefined) {
      if (!validateIpRange(pr)) throw badRequest(RANGE_ERROR);
      patch.ranges = pr;
    }
    const np = patchStr(b.nextPool, 'Next pool', 128);
    if (np !== undefined) patch.nextPool = np;
    const pc = patchStr(b.comment, 'Komentar', 255);
    if (pc !== undefined) patch.comment = pc;

    const cfg = await resolveByName(routerIdParam(req), explicitRouterId(req), name, 'pools');
    const updated = await routerManager.mutate(cfg, (d) => d.updatePool(name, patch));

    storage.addAuditLog({
      username: actor(req),
      routerId: cfg.id,
      routerName: cfg.name,
      action: 'UPDATE',
      targetType: 'POOL',
      targetName: name,
      details: `Memperbarui IP Pool '${name}'`,
    });
    res.json({ success: true, data: updated });
  })
);

router.delete(
  '/:name',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const name = req.params.name;
    const cfg = await resolveByName(routerIdParam(req), explicitRouterId(req), name, 'pools');
    await routerManager.mutate(cfg, (d) => d.deletePool(name));

    storage.addAuditLog({
      username: actor(req),
      routerId: cfg.id,
      routerName: cfg.name,
      action: 'DELETE',
      targetType: 'POOL',
      targetName: name,
      details: `Menghapus IP Pool '${name}'`,
    });
    res.json({ success: true, message: `IP Pool '${name}' berhasil dihapus.` });
  })
);

export default router;
