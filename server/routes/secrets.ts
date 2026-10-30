import { Router, Response } from 'express';
import { routerManager } from '../drivers/manager.js';
import { storage } from '../storage.js';
import { AuthenticatedRequest } from '../auth.js';
import { PppSecret } from '../drivers/types.js';
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

function secretPatch(b: Record<string, any>): Partial<PppSecret> {
  const patch: Partial<PppSecret> = {};
  const set = <K extends keyof PppSecret>(k: K, v: PppSecret[K] | undefined) => {
    if (v !== undefined) patch[k] = v;
  };
  set('name', patchStr(b.name, 'Nama secret', 128));
  set('password', patchStr(b.password, 'Password', 255));
  set('service', patchStr(b.service, 'Service', 32));
  set('profile', patchStr(b.profile, 'Profile', 128));
  set('localAddress', patchStr(b.localAddress, 'Local address', 64));
  set('remoteAddress', patchStr(b.remoteAddress, 'Remote address', 64));
  set('callerId', patchStr(b.callerId, 'Caller ID', 64));
  set('comment', patchStr(b.comment, 'Komentar', 255));
  if (b.disabled !== undefined) patch.disabled = Boolean(b.disabled);
  if (patch.name === '') throw badRequest('Nama secret tidak boleh kosong.');
  return patch;
}

// GET secrets
router.get(
  '/',
  asyncHandler(async (req, res: Response) => {
    const { data, errors } = await routerManager.executeOnRouters<PppSecret>(
      routerIdParam(req),
      (d) => d.getSecrets(),
      cacheFor.secrets
    );
    res.json({ success: true, data, errors: Object.keys(errors).length > 0 ? errors : undefined });
  })
);

// POST create secret
router.post(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = bodyOf(req);
    const name = reqStr(b.name, 'Nama secret (username PPPoE)', 128);
    const cfg = resolveForCreate(req);

    const created = await routerManager.mutate(cfg, (d) =>
      d.createSecret({
        name,
        password: patchStr(b.password, 'Password', 255) ?? '',
        service: optStr(b.service, 'Service', 32) || 'pppoe',
        profile: optStr(b.profile, 'Profile', 128) || 'default',
        localAddress: optStr(b.localAddress, 'Local address', 64),
        remoteAddress: optStr(b.remoteAddress, 'Remote address', 64),
        callerId: optStr(b.callerId, 'Caller ID', 64),
        disabled: Boolean(b.disabled),
        comment: optStr(b.comment, 'Komentar', 255),
      })
    );

    storage.addAuditLog({
      username: actor(req),
      routerId: cfg.id,
      routerName: cfg.name,
      action: 'CREATE',
      targetType: 'SECRET',
      targetName: created.name,
      details: `Membuat secret baru '${created.name}' dengan profile '${created.profile}'`,
    });
    res.status(201).json({ success: true, data: created });
  })
);

// PUT update secret
router.put(
  '/:name',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const name = req.params.name;
    const patch = secretPatch(bodyOf(req));
    const cfg = await resolveByName(routerIdParam(req), explicitRouterId(req), name, 'secrets');

    const updated = await routerManager.mutate(cfg, (d) => d.updateSecret(name, patch));

    const onlyToggle = Object.keys(patch).length === 1 && patch.disabled !== undefined;
    storage.addAuditLog({
      username: actor(req),
      routerId: cfg.id,
      routerName: cfg.name,
      action: onlyToggle ? (patch.disabled ? 'DISABLE' : 'ENABLE') : 'UPDATE',
      targetType: 'SECRET',
      targetName: name,
      details: onlyToggle
        ? `${patch.disabled ? 'Menonaktifkan' : 'Mengaktifkan'} secret '${name}'`
        : `Memperbarui secret '${name}'`,
    });
    res.json({ success: true, data: updated });
  })
);

// DELETE secret
router.delete(
  '/:name',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const name = req.params.name;
    const cfg = await resolveByName(routerIdParam(req), explicitRouterId(req), name, 'secrets');
    await routerManager.mutate(cfg, (d) => d.deleteSecret(name));

    storage.addAuditLog({
      username: actor(req),
      routerId: cfg.id,
      routerName: cfg.name,
      action: 'DELETE',
      targetType: 'SECRET',
      targetName: name,
      details: `Menghapus secret '${name}'`,
    });
    res.json({ success: true, message: `Secret '${name}' berhasil dihapus.` });
  })
);

// POST bulk action
router.post(
  '/bulk-action',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = bodyOf(req);
    const action = String(b.action || '');
    if (!['enable', 'disable', 'delete', 'change_profile'].includes(action)) throw badRequest('Aksi massal tidak dikenal.');
    const items = parseBulkItems(b.items);
    const targetProfile = optStr(b.targetProfile, 'Target profile', 128);
    if (action === 'change_profile' && !targetProfile) throw badRequest('Target profile tidak ditentukan.');

    const param = routerIdParam(req);
    const { successCount, errors } = await runBulk(items, async (item) => {
      const cfg = await resolveByName(param, item.routerId, item.name, 'secrets');
      await routerManager.mutate<unknown>(cfg, (d) => {
        if (action === 'enable') return d.setSecretDisabled(item.name, false);
        if (action === 'disable') return d.setSecretDisabled(item.name, true);
        if (action === 'delete') return d.deleteSecret(item.name);
        return d.updateSecret(item.name, { profile: targetProfile });
      });
    });

    const label = routerLabel(param);
    storage.addAuditLog({
      username: actor(req),
      routerId: label.id,
      routerName: label.name,
      action: action === 'delete' ? 'DELETE' : 'UPDATE',
      targetType: 'SECRET',
      targetName: `${items.length} secrets`,
      details: `Aksi massal [${action}] pada ${successCount} dari ${items.length} secret`,
    });

    res.json({ success: true, successCount, total: items.length, errors: Object.keys(errors).length > 0 ? errors : undefined });
  })
);

export default router;
