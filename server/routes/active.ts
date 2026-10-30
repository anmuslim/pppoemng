import { Router, Response } from 'express';
import { routerManager } from '../drivers/manager.js';
import { storage } from '../storage.js';
import { AuthenticatedRequest } from '../auth.js';
import { PppActive } from '../drivers/types.js';
import { badRequest } from '../errors.js';
import { formatRate } from '../drivers/common.js';
import {
  asyncHandler,
  bodyOf,
  cacheFor,
  reqStr,
  routerIdParam,
  explicitRouterId,
  resolveByName,
  routerLabel,
  actor,
  parseBulkItems,
  runBulk,
} from './helpers.js';

const router = Router({ mergeParams: true });

// GET active sessions
router.get(
  '/',
  asyncHandler(async (req, res: Response) => {
    const { data, errors } = await routerManager.executeOnRouters<PppActive>(routerIdParam(req), (d) => d.getActive(), cacheFor.active);
    res.json({ success: true, data, errors: Object.keys(errors).length > 0 ? errors : undefined });
  })
);

// POST ping dari router (didaftarkan sebelum '/:name/*' agar tidak tertangkap sebagai nama)
const HOST_PATTERN = /^(?:(?:\d{1,3}\.){3}\d{1,3}|[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;

router.post(
  '/ping',
  asyncHandler(async (req, res: Response) => {
    const b = bodyOf(req);
    const address = reqStr(b.address, 'Alamat IP tujuan', 253);
    if (!HOST_PATTERN.test(address)) throw badRequest('Format IP Address tidak valid.');

    const param = routerIdParam(req);
    let cfg;
    const explicit = explicitRouterId(req);
    if (explicit) cfg = routerManager.requireRouter(explicit);
    else if (param !== 'all') cfg = routerManager.requireRouter(param);
    else {
      const all = storage.getRouters();
      if (all.length === 1) cfg = all[0];
      else throw badRequest('Pilih router yang akan melakukan ping.');
    }

    const result = await routerManager.run(cfg, (d) => d.ping(address, Number(b.count) || 4, Number(b.size) || 32));
    res.json({ success: true, data: result });
  })
);

// POST bulk disconnect
router.post(
  '/bulk-disconnect',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const items = parseBulkItems(bodyOf(req).items);
    const param = routerIdParam(req);

    const { successCount, errors } = await runBulk(items, async (item) => {
      const cfg = await resolveByName(param, item.routerId, item.name, 'active');
      await routerManager.mutate(cfg, (d) => d.disconnectActive(item.name));
      storage.addRecentEvent({ type: 'disconnected', username: item.name, routerName: cfg.name, ipAddress: 'PPPoE Client' });
    });

    const label = routerLabel(param);
    storage.addAuditLog({
      username: actor(req),
      routerId: label.id,
      routerName: label.name,
      action: 'DISCONNECT',
      targetType: 'ACTIVE',
      targetName: `${successCount} sesi`,
      details: `Memutus massal ${successCount} dari ${items.length} sesi aktif`,
    });
    res.json({
      success: true,
      disconnectedCount: successCount,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
    });
  })
);

// GET riwayat sesi
router.get('/:name/history', (req, res: Response) => {
  res.json({ success: true, data: storage.getUserSessionEvents(req.params.name) });
});

// GET trafik realtime satu sesi
router.get(
  '/:name/traffic',
  asyncHandler(async (req, res: Response) => {
    const name = req.params.name;
    let cfg;
    try {
      cfg = await resolveByName(routerIdParam(req), explicitRouterId(req), name, 'active');
    } catch (err: any) {
      // Sesi sudah tidak ada di router mana pun: bukan error, cukup "tidak terhubung".
      if (err?.status === 404) {
        return res.json({
          success: true,
          data: {
            name,
            interfaceName: `<pppoe-${name}>`,
            connected: false,
            rxBps: 0,
            txBps: 0,
            uploadRate: formatRate(0),
            downloadRate: formatRate(0),
            timestamp: Date.now(),
          },
        });
      }
      throw err;
    }
    const traffic = await routerManager.run(cfg, (d) => d.getSessionTraffic(name));
    res.json({ success: true, data: traffic });
  })
);

// DELETE putuskan satu sesi
router.delete(
  '/:name',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const name = req.params.name;
    const cfg = await resolveByName(routerIdParam(req), explicitRouterId(req), name, 'active');
    await routerManager.mutate(cfg, (d) => d.disconnectActive(name));

    storage.addRecentEvent({ type: 'disconnected', username: name, routerName: cfg.name, ipAddress: 'PPPoE Client' });
    storage.addAuditLog({
      username: actor(req),
      routerId: cfg.id,
      routerName: cfg.name,
      action: 'DISCONNECT',
      targetType: 'ACTIVE',
      targetName: name,
      details: `Memutus sesi aktif '${name}' (Kick)`,
    });
    res.json({ success: true, message: `Sesi aktif '${name}' berhasil diputuskan.` });
  })
);

export default router;
