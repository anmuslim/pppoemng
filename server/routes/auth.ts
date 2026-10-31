import { Router, Response, Request } from 'express';
import { storage } from '../storage.js';
import { generateToken, publicUser, requireAuth, AuthenticatedRequest } from '../auth.js';
import { hashPassword, verifyPassword, burnPasswordCheck, MAX_PASSWORD_LENGTH } from '../crypto.js';
import { loginGuard } from '../rateLimit.js';
import { badRequest, forbidden, HttpError, unauthorized } from '../errors.js';
import { logger } from '../logger.js';
import { asyncHandler, bodyOf } from './helpers.js';

const router = Router();

export const MIN_PASSWORD_LENGTH = 8;

router.post(
  '/login',
  asyncHandler(async (req: Request, res: Response) => {
    const b = bodyOf(req);
    const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    if (!username || !password) throw badRequest('Username dan password wajib diisi.');
    if (username.length > 64 || password.length > MAX_PASSWORD_LENGTH) throw unauthorized('Username atau password salah.');

    const ip = req.ip || 'unknown';
    const lockedFor = loginGuard.check(ip, username);
    if (lockedFor > 0) {
      res.setHeader('Retry-After', String(lockedFor));
      throw new HttpError(429, `Terlalu banyak percobaan login gagal. Coba lagi dalam ${Math.ceil(lockedFor / 60)} menit.`);
    }

    const user = storage.getUser(username);
    if (!user) {
      await burnPasswordCheck(password); // samakan waktu respons
      loginGuard.fail(ip, username);
      logger.warn(`Login gagal (user tidak ada) dari ${ip}`);
      throw unauthorized('Username atau password salah.');
    }

    const check = await verifyPassword(password, user.passwordHash);
    if (!check.ok) {
      loginGuard.fail(ip, username);
      logger.warn(`Login gagal untuk '${username}' dari ${ip}`);
      throw unauthorized('Username atau password salah.');
    }
    if ((user.status || 'active') !== 'active') {
      throw forbidden('Akun Anda telah dinonaktifkan (suspended). Hubungi Superadmin.');
    }

    loginGuard.success(ip, username);

    // Upgrade hash lama (SHA-256 tanpa salt) ke scrypt secara transparan.
    const patch: { lastLogin: string; passwordHash?: string } = { lastLogin: new Date().toISOString() };
    if (check.needsRehash) patch.passwordHash = await hashPassword(password);
    const updated = await storage.updateUser(user.id, patch);

    storage.addAuditLog({
      username: updated.username,
      routerId: 'system',
      routerName: 'Sistem',
      action: 'TEST',
      targetType: 'ROUTER',
      targetName: updated.username,
      details: `Pengguna '${updated.username}' (${updated.name}) berhasil masuk ke sistem`,
    });

    res.json({ success: true, token: generateToken(updated), user: publicUser(updated) });
  })
);

router.get('/me', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const user = storage.getUserById(req.user!.userId);
  if (!user) throw unauthorized();
  res.json({ success: true, user: publicUser(user) });
});

router.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = bodyOf(req);
    const currentPassword = typeof b.currentPassword === 'string' ? b.currentPassword : '';
    const newPassword = typeof b.newPassword === 'string' ? b.newPassword : '';
    if (!currentPassword || !newPassword) throw badRequest('Password saat ini dan password baru wajib diisi.');
    if (newPassword.length < MIN_PASSWORD_LENGTH) throw badRequest(`Password baru minimal ${MIN_PASSWORD_LENGTH} karakter.`);
    if (newPassword.length > MAX_PASSWORD_LENGTH) throw badRequest('Password baru terlalu panjang.');
    if (newPassword === currentPassword) throw badRequest('Password baru harus berbeda dari password saat ini.');

    const user = storage.getUserById(req.user!.userId);
    if (!user) throw unauthorized();

    const ip = req.ip || 'unknown';
    const lockedFor = loginGuard.check(ip, user.username);
    if (lockedFor > 0) throw new HttpError(429, `Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil(lockedFor / 60)} menit.`);

    if (!(await verifyPassword(currentPassword, user.passwordHash)).ok) {
      loginGuard.fail(ip, user.username);
      throw badRequest('Password saat ini salah.');
    }

    const updated = await storage.updateUser(user.id, { passwordHash: await hashPassword(newPassword) });
    storage.addAuditLog({
      username: user.username,
      routerId: 'system',
      routerName: 'Sistem',
      action: 'UPDATE',
      targetType: 'ROUTER',
      targetName: user.username,
      details: 'Pengguna memperbarui kata sandi akun',
    });

    // Token lama otomatis tidak berlaku (versi token berubah); kirim token baru agar sesi ini tetap hidup.
    res.json({ success: true, message: 'Password berhasil diperbarui.', token: generateToken(updated), user: publicUser(updated) });
  })
);

export default router;
