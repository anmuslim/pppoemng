import { Router, Response } from 'express';
import { storage } from '../storage.js';
import { routerManager } from '../drivers/manager.js';
import { AuthenticatedRequest } from '../auth.js';
import { asyncHandler, actor } from './helpers.js';

// Dipasang dengan requireSuperadmin. Hanya menyentuh router bertanda isDemo.
const router = Router();

router.post(
  '/reset-demo',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    for (const r of storage.getRouters().filter((x) => x.isDemo)) routerManager.invalidateRouter(r.id);
    await storage.resetDemo();
    routerManager.clearAllDrivers();

    storage.addAuditLog({
      username: actor(req),
      routerId: 'system',
      routerName: 'Sistem',
      action: 'UPDATE',
      targetType: 'ROUTER',
      targetName: 'Mode Demo',
      details: 'Reset data simulasi router demo ke konfigurasi awal (router produksi tidak tersentuh)',
    });
    res.json({ success: true, message: 'Data demo berhasil direset ke status awal.' });
  })
);

export default router;
