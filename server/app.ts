import express, { Express, Request, Response, NextFunction } from 'express';
import compression from 'compression';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { logger } from './logger.js';
import { storage } from './storage.js';
import { requireAuth, requireSuperadmin, requireMenu, requireMenuForWrites } from './auth.js';
import { apiRateLimiter } from './rateLimit.js';
import { HttpError, RouterConnectionError, RouterCommandError } from './errors.js';
import authRoutes from './routes/auth.js';
import routerRoutes from './routes/routers.js';
import secretsRoutes from './routes/secrets.js';
import activeRoutes from './routes/active.js';
import profilesRoutes from './routes/profiles.js';
import queuesRoutes from './routes/queues.js';
import poolsRoutes from './routes/pools.js';
import overviewRoutes from './routes/overview.js';
import auditRoutes from './routes/audit.js';
import usersRoutes from './routes/users.js';
import demoRoutes from './routes/demo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, '..');
const startedAt = Date.now();

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
}

/** Catat request lambat & error server; request normal hanya di level debug. */
function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const line = `${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${ms.toFixed(0)}ms`;
    if (res.statusCode >= 500) logger.error(line);
    else if (ms > 3000) logger.warn(`LAMBAT ${line}`);
    else logger.debug(line);
  });
  next();
}

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');

  const tp = config.trustProxy;
  app.set('trust proxy', typeof tp === 'string' && /^\d+$/.test(tp) ? Number(tp) : tp);

  app.use(securityHeaders);
  app.use(compression({ threshold: 1024 }));
  app.use(requestLogger);

  // Health check tanpa auth & tanpa rate limit (untuk monitoring / load balancer)
  app.get('/api/health', (_req, res) => {
    const h = storage.getHealth();
    const ready = h.mode !== 'uninitialized';
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'starting',
      app: 'PPPoE Manager',
      time: new Date().toISOString(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      storage: { mode: h.mode, healthy: h.failedWrites === 0 || !h.lastWriteError },
    });
  });

  app.use('/api', express.json({ limit: '1mb' }));
  app.use('/api', apiRateLimiter);

  // Auth: login publik; /me & /change-password menuntut token (diatur di dalam routes/auth.ts)
  app.use('/api/auth', authRoutes);

  // Rute terproteksi. Hak akses DITEGAKKAN DI SERVER (bukan hanya menyembunyikan menu di UI).
  app.use('/api/routers', requireAuth, routerRoutes);
  app.use('/api/routers/:routerId/ppp/secrets', requireAuth, requireMenu('secrets'), secretsRoutes);
  app.use('/api/routers/:routerId/ppp/active', requireAuth, requireMenuForWrites('active'), activeRoutes);
  app.use('/api/routers/:routerId/ppp/profiles', requireAuth, requireMenuForWrites('profiles'), profilesRoutes);
  app.use('/api/routers/:routerId/queues', requireAuth, requireMenuForWrites('queues'), queuesRoutes);
  app.use('/api/routers/:routerId/ip-pools', requireAuth, requireMenuForWrites('pools'), poolsRoutes);
  app.use('/api/overview', requireAuth, requireMenu('dashboard'), overviewRoutes);
  app.use('/api/audit-logs', requireAuth, requireMenu('audit'), auditRoutes);
  app.use('/api/users', requireAuth, requireSuperadmin, usersRoutes);
  app.use('/api/demo', requireAuth, requireSuperadmin, demoRoutes);

  app.use('/api', (_req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint tidak ditemukan.' });
  });

  return app;
}

/** Error handler pusat: tidak pernah membocorkan stack trace / detail internal ke klien. */
export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);

  let status = 500;
  let message = 'Terjadi kesalahan internal pada server.';

  if (err instanceof HttpError) {
    status = err.status;
    message = err.message;
  } else if (err instanceof RouterConnectionError) {
    status = 502;
    message = err.message;
  } else if (err instanceof RouterCommandError) {
    status = 400;
    message = err.message;
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    message = 'Format JSON tidak valid.';
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    message = 'Data yang dikirim terlalu besar.';
  } else {
    logger.error(`Error tak terduga pada ${req.method} ${req.originalUrl.split('?')[0]}`, {
      message: err?.message,
      stack: config.isProduction ? undefined : err?.stack,
    });
  }

  res.status(status).json({ success: false, error: message });
}

/** Pasang frontend: Vite (dev) atau berkas statis hasil build (production). Dipanggil SETELAH createApp(). */
export async function attachFrontend(app: Express): Promise<void> {
  if (!config.isProduction) {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa', root: projectRoot });
    app.use(vite.middlewares);
    return;
  }

  const distPath = path.join(projectRoot, 'dist');
  const indexFile = path.join(distPath, 'index.html');
  if (!fs.existsSync(indexFile)) {
    logger.error(`Folder dist/ tidak ditemukan (${distPath}). Jalankan "npm run build" terlebih dahulu.`);
  }

  app.use(
    express.static(distPath, {
      index: false,
      setHeaders: (res, filePath) => {
        // File ber-hash di /assets aman di-cache selamanya; index.html harus selalu dicek ulang.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    })
  );

  app.get('*', (req, res) => {
    if (req.path.startsWith('/assets/')) return res.status(404).end();
    if (!fs.existsSync(indexFile)) {
      return res.status(503).type('text/plain').send('Frontend belum dibuild. Jalankan: npm run build');
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexFile);
  });
}
