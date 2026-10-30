import { Router, Response } from 'express';
import { storage, ALL_MENU_KEYS, USER_ROLES, UserRole } from '../storage.js';
import { AuthenticatedRequest, publicUser } from '../auth.js';
import { hashPassword, MAX_PASSWORD_LENGTH } from '../crypto.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { asyncHandler, bodyOf, reqStr, optStr, actor } from './helpers.js';
import { MIN_PASSWORD_LENGTH } from './auth.js';

// Seluruh router ini dipasang dengan requireSuperadmin (lihat app.ts).
const router = Router();

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

function parseRole(v: unknown, fallback?: UserRole): UserRole {
  if (v === undefined || v === null || v === '') {
    if (fallback) return fallback;
    throw badRequest('Peran wajib diisi.');
  }
  if (!USER_ROLES.includes(v as UserRole)) throw badRequest(`Peran harus salah satu dari: ${USER_ROLES.join(', ')}.`);
  return v as UserRole;
}

function parseMenus(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw badRequest('Daftar menu harus berupa array.');
  const valid = new Set<string>(ALL_MENU_KEYS);
  const bad = v.filter((m) => typeof m !== 'string' || !valid.has(m));
  if (bad.length > 0) throw badRequest(`Menu tidak dikenal: ${bad.join(', ')}.`);
  return [...new Set(v as string[])];
}

function parseStatus(v: unknown): 'active' | 'suspended' | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (v !== 'active' && v !== 'suspended') throw badRequest("Status harus 'active' atau 'suspended'.");
  return v;
}

function checkPassword(p: unknown): string {
  if (typeof p !== 'string' || p.length < MIN_PASSWORD_LENGTH) throw badRequest(`Password minimal ${MIN_PASSWORD_LENGTH} karakter.`);
  if (p.length > MAX_PASSWORD_LENGTH) throw badRequest('Password terlalu panjang.');
  return p;
}

router.get('/', (_req, res: Response) => {
  res.json({ success: true, data: storage.getUsers().map(publicUser) });
});

router.post(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = bodyOf(req);
    const username = reqStr(b.username, 'Username', 64).toLowerCase();
    if (!USERNAME_PATTERN.test(username)) {
      throw badRequest('Username 3-64 karakter: huruf kecil, angka, titik, strip, atau garis bawah.');
    }
    const name = reqStr(b.name, 'Nama lengkap', 128);
    const password = checkPassword(b.password);
    const role = parseRole(b.role, 'operator');
    const menus = parseMenus(b.allowedMenus);

    const created = await storage.createUser({
      username,
      name,
      role,
      passwordHash: await hashPassword(password),
      allowedMenus: menus && menus.length > 0 ? menus : ['dashboard'],
      status: parseStatus(b.status) || 'active',
    });

    storage.addAuditLog({
      username: actor(req),
      routerId: 'system',
      routerName: 'Sistem',
      action: 'CREATE',
      targetType: 'ROUTER',
      targetName: created.username,
      details: `Membuat akun user baru '${created.username}' (${created.name}) dengan peran '${created.role}' dan akses: [${created.allowedMenus.join(', ')}]`,
    });
    res.status(201).json({ success: true, data: publicUser(created) });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const id = req.params.id;
    const target = storage.getUserById(id);
    if (!target) throw notFound('User tidak ditemukan.');
    const b = bodyOf(req);

    const patch: Parameters<typeof storage.updateUser>[1] = {};
    const name = optStr(b.name, 'Nama lengkap', 128);
    if (name) patch.name = name;
    if (b.role !== undefined && b.role !== '') patch.role = parseRole(b.role);
    const status = parseStatus(b.status);
    if (status) patch.status = status;
    const menus = parseMenus(b.allowedMenus);
    if (menus) patch.allowedMenus = menus;
    if (typeof b.password === 'string' && b.password.length > 0) patch.passwordHash = await hashPassword(checkPassword(b.password));

    // Cegah mengunci diri sendiri.
    if (req.user?.userId === id) {
      if (patch.role && patch.role !== target.role) throw badRequest('Anda tidak dapat mengubah peran akun Anda sendiri.');
      if (patch.status === 'suspended') throw badRequest('Anda tidak dapat menonaktifkan akun Anda sendiri.');
    }

    const updated = await storage.updateUser(id, patch);
    storage.addAuditLog({
      username: actor(req),
      routerId: 'system',
      routerName: 'Sistem',
      action: 'UPDATE',
      targetType: 'ROUTER',
      targetName: updated.username,
      details: `Memperbarui akun user '${updated.username}' (Status: ${updated.status}, Role: ${updated.role}, Menu: ${updated.allowedMenus.length} akses${patch.passwordHash ? ', password diganti' : ''})`,
    });
    res.json({ success: true, data: publicUser(updated) });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const id = req.params.id;
    const user = storage.getUserById(id);
    if (!user) throw notFound('User tidak ditemukan.');
    if (req.user?.userId === id) throw badRequest('Anda tidak dapat menghapus akun Anda sendiri saat sedang aktif.');

    if (!(await storage.deleteUser(id))) throw conflict('User tidak dapat dihapus.');
    storage.addAuditLog({
      username: actor(req),
      routerId: 'system',
      routerName: 'Sistem',
      action: 'DELETE',
      targetType: 'ROUTER',
      targetName: user.username,
      details: `Menghapus akun user '${user.username}' (${user.name}) dari sistem`,
    });
    res.json({ success: true, message: `User '${user.username}' berhasil dihapus.` });
  })
);

export default router;
