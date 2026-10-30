import { Router, Response } from 'express';
import { storage } from '../storage.js';
import { routerManager } from '../drivers/manager.js';
import { encrypt, randomId } from '../crypto.js';
import { AuthenticatedRequest, requireSuperadmin, requireMenu } from '../auth.js';
import { RouterConfig, ConnectionMode } from '../drivers/types.js';
import { badRequest, notFound, errorMessage } from '../errors.js';
import { logger } from '../logger.js';
import { asyncHandler, bodyOf, optStr, reqStr, actor } from './helpers.js';

const router = Router();

const MODES: ConnectionMode[] = ['API', 'API-SSL', 'REST'];
const HOST_PATTERN = /^(?:[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|[0-9A-Fa-f:]{2,45})$/;

function parsePort(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw badRequest('Port harus berupa angka 1-65535.');
  return n;
}

function parseHost(v: unknown): string {
  const host = reqStr(v, 'Host/IP', 253);
  if (!HOST_PATTERN.test(host)) throw badRequest('Format host/IP tidak valid.');
  return host;
}

function parseMode(v: unknown, fallback: ConnectionMode = 'API'): ConnectionMode {
  if (v === undefined || v === null || v === '') return fallback;
  if (!MODES.includes(v as ConnectionMode)) throw badRequest(`Mode koneksi harus salah satu dari: ${MODES.join(', ')}.`);
  return v as ConnectionMode;
}

const toPublic = (r: RouterConfig) => ({
  id: r.id,
  name: r.name,
  host: r.host,
  port: r.port,
  mode: r.mode,
  notes: r.notes,
  isDemo: Boolean(r.isDemo),
  hasPassword: Boolean(r.encryptedPassword),
  status: r.status,
});

/** Cek koneksi di latar belakang agar status router baru/ diubah segera akurat tanpa menahan response. */
function refreshInBackground(id: string) {
  const cfg = storage.getRouter(id);
  if (!cfg) return;
  routerManager
    .run(cfg, (d) => d.getSystemResource(), { bypassBreaker: true })
    .then((info) => storage.updateRouterRuntime(id, { ...info, status: 'online', lastSeen: new Date().toISOString(), lastError: undefined }))
    .catch((err) => logger.debug(`Cek awal router ${cfg.name} gagal: ${errorMessage(err)}`));
}

// GET semua router (semua user login; dipakai selector router di header)
router.get('/', (_req, res: Response) => {
  res.json({ success: true, data: routerManager.getRouterSummaries() });
});

// POST create router (Superadmin)
router.post(
  '/',
  requireSuperadmin,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = bodyOf(req);
    const name = reqStr(b.name, 'Nama router', 128);
    const mode = parseMode(b.mode);
    const defaultPort = mode === 'API-SSL' ? 8729 : mode === 'REST' ? 443 : 8728;
    const password = typeof b.password === 'string' ? b.password : '';
    if (password.length > 255) throw badRequest('Password router terlalu panjang.');

    const newRouter: RouterConfig = {
      id: randomId('router'),
      name,
      host: parseHost(b.host),
      port: parsePort(b.port, defaultPort),
      username: reqStr(b.username, 'Username', 128),
      encryptedPassword: password ? encrypt(password) : undefined,
      mode,
      notes: optStr(b.notes, 'Catatan', 1000) || '',
      isDemo: Boolean(b.isDemo),
      status: 'checking',
      lastSeen: new Date().toISOString(),
    };

    await storage.addRouter(newRouter);
    storage.addAuditLog({
      username: actor(req),
      routerId: newRouter.id,
      routerName: newRouter.name,
      action: 'CREATE',
      targetType: 'ROUTER',
      targetName: newRouter.name,
      details: `Menambahkan router baru ${newRouter.name} (${newRouter.host}:${newRouter.port}) dengan mode ${newRouter.mode}`,
    });

    if (!newRouter.isDemo) refreshInBackground(newRouter.id);
    res.status(201).json({ success: true, data: toPublic(newRouter) });
  })
);

// PUT update router (Superadmin)
router.put(
  '/:id',
  requireSuperadmin,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    if (!storage.getRouter(id)) throw notFound('Router tidak ditemukan.');
    const b = bodyOf(req);

    const patch: Partial<RouterConfig> = {};
    if (b.name !== undefined) patch.name = reqStr(b.name, 'Nama router', 128);
    if (b.host !== undefined) patch.host = parseHost(b.host);
    if (b.mode !== undefined && b.mode !== '') patch.mode = parseMode(b.mode);
    if (b.port !== undefined && b.port !== '' && b.port !== null) patch.port = parsePort(b.port, 8728);
    if (b.username !== undefined) patch.username = reqStr(b.username, 'Username', 128);
    if (typeof b.password === 'string' && b.password) {
      if (b.password.length > 255) throw badRequest('Password router terlalu panjang.');
      patch.encryptedPassword = encrypt(b.password);
    }
    if (b.notes !== undefined) patch.notes = optStr(b.notes, 'Catatan', 1000) || '';
    if (b.isDemo !== undefined) patch.isDemo = Boolean(b.isDemo);

    const updated = await storage.updateRouter(id, patch);
    routerManager.invalidateRouter(id);

    storage.addAuditLog({
      username: actor(req),
      routerId: updated.id,
      routerName: updated.name,
      action: 'UPDATE',
      targetType: 'ROUTER',
      targetName: updated.name,
      details: `Memperbarui konfigurasi router ${updated.name}`,
    });

    if (!updated.isDemo) refreshInBackground(id);
    res.json({ success: true, data: toPublic(updated) });
  })
);

// DELETE router (Superadmin)
router.delete(
  '/:id',
  requireSuperadmin,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    const current = storage.getRouter(id);
    if (!current) throw notFound('Router tidak ditemukan.');

    await storage.deleteRouter(id);
    routerManager.invalidateRouter(id);

    storage.addAuditLog({
      username: actor(req),
      routerId: current.id,
      routerName: current.name,
      action: 'DELETE',
      targetType: 'ROUTER',
      targetName: current.name,
      details: `Menghapus router ${current.name} dari sistem`,
    });
    res.json({ success: true, message: `Router '${current.name}' berhasil dihapus.` });
  })
);

// POST test koneksi (menu Router)
router.post(
  '/:id/test',
  requireMenu('routers'),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const current = storage.getRouter(req.params.id);
    if (!current) throw notFound('Router tidak ditemukan.');

    try {
      const info = await routerManager.run(current, (d) => d.getSystemResource(), { bypassBreaker: true });
      const result = { success: true as const, ...info };
      storage.updateRouterRuntime(current.id, { ...info, status: 'online', lastSeen: new Date().toISOString(), lastError: undefined });
      storage.addAuditLog({
        username: actor(req),
        routerId: current.id,
        routerName: current.name,
        action: 'TEST',
        targetType: 'ROUTER',
        targetName: current.name,
        details: `Uji koneksi sukses: ${info.identity} (${info.version}), CPU: ${info.cpuLoad}%`,
      });
      res.json({ success: true, data: result });
    } catch (err) {
      const message = errorMessage(err, 'Gagal menghubungi router');
      res.status(502).json({
        success: false,
        error: message,
        data: { success: false, identity: current.name, version: '', uptime: '', cpuLoad: 0, freeMemory: 0, totalMemory: 0, boardName: '', error: message },
      });
    }
  })
);

export default router;
