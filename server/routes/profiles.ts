import { Router, Response } from 'express';
import { routerManager } from '../drivers/manager.js';
import { storage } from '../storage.js';
import { AuthenticatedRequest } from '../auth.js';
import { PppProfile } from '../drivers/types.js';
import { badRequest } from '../errors.js';
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
  routerLabel,
  actor,
  parseBulkItems,
  runBulk,
} from './helpers.js';

const router = Router({ mergeParams: true });

function profilePatch(b: Record<string, any>): Partial<PppProfile> {
  const patch: Partial<PppProfile> = {};
  const set = <K extends keyof PppProfile>(k: K, v: PppProfile[K] | undefined) => {
    if (v !== undefined) patch[k] = v;
  };
  set('name', patchStr(b.name, 'Nama profile', 128));
  set('localAddress', patchStr(b.localAddress, 'Local address', 64));
  set('remoteAddress', patchStr(b.remoteAddress, 'Remote address', 128));
  set('rateLimit', patchStr(b.rateLimit, 'Rate limit', 128));
  set('parentQueue', patchStr(b.parentQueue, 'Parent queue', 128));
  set('dnsServer', patchStr(b.dnsServer, 'DNS server', 128));
  set('comment', patchStr(b.comment, 'Komentar', 255));
  if (b.onlyOne !== undefined) patch.onlyOne = Boolean(b.onlyOne);
  if (patch.name === '') throw badRequest('Nama profile tidak boleh kosong.');
  return patch;
}

// GET profiles + jumlah secret & sesi aktif (memakai cache bersama; tidak lagi mengunduh ulang tiap polling)
router.get(
  '/',
  asyncHandler(async (req, res: Response) => {
    const routerId = routerIdParam(req);
    const [profilesRes, secretsRes, activeRes] = await Promise.all([
      routerManager.executeOnRouters<PppProfile>(routerId, (d) => d.getProfiles(), cacheFor.profiles),
      routerManager.executeOnRouters<any>(routerId, (d) => d.getSecrets(), cacheFor.secrets).catch(() => ({ data: [] as any[], errors: {} })),
      routerManager.executeOnRouters<any>(routerId, (d) => d.getActive(), cacheFor.active).catch(() => ({ data: [] as any[], errors: {} })),
    ]);

    const userToProfile = new Map<string, string>();
    const secretsByKey = new Map<string, number>();
    const secretsByName = new Map<string, number>();
    for (const s of secretsRes.data) {
      const prof = s.profile || 'default';
      userToProfile.set(`${s.routerId || ''}:::${s.name}`, prof);
      userToProfile.set(s.name, prof);
      secretsByName.set(prof, (secretsByName.get(prof) || 0) + 1);
      const k = `${s.routerId || ''}:::${prof}`;
      secretsByKey.set(k, (secretsByKey.get(k) || 0) + 1);
    }

    const activeByKey = new Map<string, number>();
    const activeByName = new Map<string, number>();
    for (const a of activeRes.data) {
      const prof = userToProfile.get(`${a.routerId || ''}:::${a.name}`) || userToProfile.get(a.name) || a.profile || 'default';
      activeByName.set(prof, (activeByName.get(prof) || 0) + 1);
      const k = `${a.routerId || ''}:::${prof}`;
      activeByKey.set(k, (activeByKey.get(k) || 0) + 1);
    }

    const data = profilesRes.data.map((p) => {
      const k = `${p.routerId || ''}:::${p.name}`;
      return {
        ...p,
        secretCount: secretsByKey.has(k) ? secretsByKey.get(k)! : secretsByName.get(p.name) || 0,
        activeCount: activeByKey.has(k) ? activeByKey.get(k)! : activeByName.get(p.name) || 0,
      };
    });

    res.json({ success: true, data, errors: Object.keys(profilesRes.errors).length > 0 ? profilesRes.errors : undefined });
  })
);

// POST create profile
router.post(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = bodyOf(req);
    const name = reqStr(b.name, 'Nama profile', 128);
    const cfg = resolveForCreate(req);

    const created = await routerManager.mutate(cfg, (d) =>
      d.createProfile({
        name,
        localAddress: optStr(b.localAddress, 'Local address', 64),
        remoteAddress: optStr(b.remoteAddress, 'Remote address', 128),
        rateLimit: optStr(b.rateLimit, 'Rate limit', 128),
        parentQueue: optStr(b.parentQueue, 'Parent queue', 128),
        onlyOne: b.onlyOne !== undefined ? Boolean(b.onlyOne) : true,
        dnsServer: optStr(b.dnsServer, 'DNS server', 128),
        comment: optStr(b.comment, 'Komentar', 255),
      })
    );

    storage.addAuditLog({
      username: actor(req),
      routerId: cfg.id,
      routerName: cfg.name,
      action: 'CREATE',
      targetType: 'PROFILE',
      targetName: created.name,
      details: `Membuat PPP profile baru '${created.name}' (Rate: ${created.rateLimit || 'unlimited'})`,
    });
    res.status(201).json({ success: true, data: created });
  })
);

// PUT update profile
router.put(
  '/:name',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const name = req.params.name;
    const patch = profilePatch(bodyOf(req));
    const cfg = await resolveByName(routerIdParam(req), explicitRouterId(req), name, 'profiles');
    const updated = await routerManager.mutate(cfg, (d) => d.updateProfile(name, patch));

    storage.addAuditLog({
      username: actor(req),
      routerId: cfg.id,
      routerName: cfg.name,
      action: 'UPDATE',
      targetType: 'PROFILE',
      targetName: name,
      details: `Memperbarui profile '${name}'`,
    });
    res.json({ success: true, data: updated });
  })
);

// DELETE profile
router.delete(
  '/:name',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const name = req.params.name;
    const cfg = await resolveByName(routerIdParam(req), explicitRouterId(req), name, 'profiles');
    await routerManager.mutate(cfg, (d) => d.deleteProfile(name));

    storage.addAuditLog({
      username: actor(req),
      routerId: cfg.id,
      routerName: cfg.name,
      action: 'DELETE',
      targetType: 'PROFILE',
      targetName: name,
      details: `Menghapus profile '${name}'`,
    });
    res.json({ success: true, message: `Profile '${name}' berhasil dihapus.` });
  })
);

// POST bulk action
router.post(
  '/bulk-action',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = bodyOf(req);
    const action = String(b.action || '');
    const valid = ['change_dns', 'change_rate_limit', 'change_local_address', 'change_remote_address', 'delete'];
    if (!valid.includes(action)) throw badRequest('Aksi massal tidak dikenal.');
    const items = parseBulkItems(b.items);

    let patch: Partial<PppProfile> = {};
    if (action === 'change_dns') {
      if (b.dnsServer === undefined) throw badRequest('DNS Server tidak ditentukan.');
      patch = { dnsServer: patchStr(b.dnsServer, 'DNS server', 128) };
    } else if (action === 'change_rate_limit') {
      const v = optStr(b.rateLimit, 'Rate limit', 128);
      if (!v) throw badRequest('Limitasi bandwidth tidak ditentukan.');
      patch = { rateLimit: v };
    } else if (action === 'change_local_address') {
      if (b.localAddress === undefined) throw badRequest('Local Address tidak ditentukan.');
      patch = { localAddress: patchStr(b.localAddress, 'Local address', 64) };
    } else if (action === 'change_remote_address') {
      if (b.remoteAddress === undefined) throw badRequest('Remote Address (Pool) tidak ditentukan.');
      patch = { remoteAddress: patchStr(b.remoteAddress, 'Remote address', 128) };
    }

    const param = routerIdParam(req);
    const { successCount, errors } = await runBulk(items, async (item) => {
      const cfg = await resolveByName(param, item.routerId, item.name, 'profiles');
      await routerManager.mutate<unknown>(cfg, (d) => (action === 'delete' ? d.deleteProfile(item.name) : d.updateProfile(item.name, patch)));
    });

    const label = routerLabel(param);
    storage.addAuditLog({
      username: actor(req),
      routerId: label.id,
      routerName: label.name,
      action: action === 'delete' ? 'DELETE' : 'UPDATE',
      targetType: 'PROFILE',
      targetName: `${items.length} profiles`,
      details: `Aksi massal [${action}] pada ${successCount} dari ${items.length} profile`,
    });
    res.json({ success: true, successCount, total: items.length, errors: Object.keys(errors).length > 0 ? errors : undefined });
  })
);

export default router;
