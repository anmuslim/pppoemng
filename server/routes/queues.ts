import { Router, Response } from 'express';
import { routerManager } from '../drivers/manager.js';
import { storage } from '../storage.js';
import { AuthenticatedRequest } from '../auth.js';
import { SimpleQueue } from '../drivers/types.js';
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
  actor,
} from './helpers.js';

const router = Router({ mergeParams: true });

function queuePatch(b: Record<string, any>): Partial<SimpleQueue> {
  const patch: Partial<SimpleQueue> = {};
  const set = <K extends keyof SimpleQueue>(k: K, v: SimpleQueue[K] | undefined) => {
    if (v !== undefined) patch[k] = v;
  };
  set('name', patchStr(b.name, 'Nama queue', 128));
  set('target', patchStr(b.target, 'Target', 255));
  set('maxLimit', patchStr(b.maxLimit, 'Max limit', 64));
  set('limitAt', patchStr(b.limitAt, 'Limit at', 64));
  set('priority', patchStr(b.priority, 'Priority', 16));
  set('parent', patchStr(b.parent, 'Parent', 128));
  set('comment', patchStr(b.comment, 'Komentar', 255));
  if (patch.name === '') throw badRequest('Nama queue tidak boleh kosong.');
  return patch;
}

router.get(
  '/',
  asyncHandler(async (req, res: Response) => {
    const { data, errors } = await routerManager.executeOnRouters<SimpleQueue>(routerIdParam(req), (d) => d.getQueues(), cacheFor.queues);
    res.json({ success: true, data, errors: Object.keys(errors).length > 0 ? errors : undefined });
  })
);

router.post(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = bodyOf(req);
    const name = reqStr(b.name, 'Nama queue', 128);
    const cfg = resolveForCreate(req);
    const parent = optStr(b.parent, 'Parent', 128);

    const created = await routerManager.mutate(cfg, (d) =>
      d.createQueue({
        name,
        target: optStr(b.target, 'Target', 255) || '0.0.0.0/0',
        maxLimit: optStr(b.maxLimit, 'Max limit', 64),
        limitAt: optStr(b.limitAt, 'Limit at', 64),
        priority: optStr(b.priority, 'Priority', 16) || '8',
        parent: parent && parent !== 'none' ? parent : undefined,
        comment: optStr(b.comment, 'Komentar', 255),
      })
    );

    storage.addAuditLog({
      username: actor(req),
      routerId: cfg.id,
      routerName: cfg.name,
      action: 'CREATE',
      targetType: 'QUEUE',
      targetName: created.name,
      details: `Membuat Simple Queue '${created.name}' (${created.maxLimit || 'unlimited'})`,
    });
    res.status(201).json({ success: true, data: created });
  })
);

router.put(
  '/:name',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const name = req.params.name;
    const patch = queuePatch(bodyOf(req));
    const cfg = await resolveByName(routerIdParam(req), explicitRouterId(req), name, 'queues');
    const updated = await routerManager.mutate(cfg, (d) => d.updateQueue(name, patch));

    storage.addAuditLog({
      username: actor(req),
      routerId: cfg.id,
      routerName: cfg.name,
      action: 'UPDATE',
      targetType: 'QUEUE',
      targetName: name,
      details: `Memperbarui Simple Queue '${name}'`,
    });
    res.json({ success: true, data: updated });
  })
);

router.delete(
  '/:name',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const name = req.params.name;
    const cfg = await resolveByName(routerIdParam(req), explicitRouterId(req), name, 'queues');
    await routerManager.mutate(cfg, (d) => d.deleteQueue(name));

    storage.addAuditLog({
      username: actor(req),
      routerId: cfg.id,
      routerName: cfg.name,
      action: 'DELETE',
      targetType: 'QUEUE',
      targetName: name,
      details: `Menghapus Simple Queue '${name}'`,
    });
    res.json({ success: true, message: `Queue '${name}' berhasil dihapus.` });
  })
);

export default router;
