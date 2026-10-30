import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { storage, AdminUser, ALL_MENU_KEYS } from './storage.js';
import { config } from './config.js';
import { unauthorized, forbidden } from './errors.js';

export interface AuthPayload {
  userId: string;
  username: string;
  name: string;
  role: string;
  allowedMenus: string[];
}

export interface AuthenticatedRequest extends Request {
  user?: AuthPayload;
}

/** Berubah setiap password diganti -> token lama otomatis tidak berlaku lagi. */
function tokenVersion(user: AdminUser): string {
  return crypto.createHash('sha256').update(`${user.passwordHash}:${config.jwtSecret}`).digest('hex').slice(0, 16);
}

export function generateToken(user: AdminUser): string {
  return jwt.sign({ sub: user.id, tv: tokenVersion(user) }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'],
    algorithm: 'HS256',
  });
}

export function publicUser(user: AdminUser) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    allowedMenus: user.role === 'superadmin' ? [...ALL_MENU_KEYS] : user.allowedMenus || [],
    status: user.status || 'active',
    lastLogin: user.lastLogin,
    createdAt: user.createdAt,
    mustChangePassword: storage.hasDefaultPassword(user),
  };
}

/**
 * Wajib login. Peran, menu, dan status SELALU dibaca ulang dari penyimpanan,
 * jadi perubahan hak akses / suspend / hapus user berlaku seketika (bukan menunggu token kedaluwarsa).
 */
export function requireAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next(unauthorized());

  let decoded: jwt.JwtPayload;
  try {
    decoded = jwt.verify(header.slice(7), config.jwtSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
  } catch {
    return next(unauthorized('Sesi login telah kedaluwarsa atau tidak valid.'));
  }

  const user = typeof decoded.sub === 'string' ? storage.getUserById(decoded.sub) : undefined;
  if (!user || decoded.tv !== tokenVersion(user)) {
    return next(unauthorized('Sesi login tidak valid. Silakan login ulang.'));
  }
  if ((user.status || 'active') !== 'active') {
    return next(unauthorized('Akun Anda dinonaktifkan. Hubungi Superadmin.'));
  }

  req.user = {
    userId: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    allowedMenus: user.role === 'superadmin' ? [...ALL_MENU_KEYS] : user.allowedMenus || [],
  };
  next();
}

export function requireSuperadmin(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'superadmin') return next(forbidden('Akses khusus untuk Superadmin.'));
  next();
}

/** User harus memiliki minimal satu dari menu yang disebut (superadmin selalu lolos). */
export function requireMenu(...menus: string[]) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role === 'superadmin') return next();
    if (menus.some((m) => req.user!.allowedMenus.includes(m))) return next();
    next(forbidden('Anda tidak memiliki akses ke menu ini.'));
  };
}

/** Terapkan requireMenu hanya untuk method tulis (POST/PUT/PATCH/DELETE). Baca cukup login. */
export function requireMenuForWrites(...menus: string[]) {
  const check = requireMenu(...menus);
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    check(req, res, next);
  };
}
