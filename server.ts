import { config, validateConfig } from './server/config.js';
import { logger } from './server/logger.js';
import { storage } from './server/storage.js';
import { routerManager } from './server/drivers/manager.js';
import { createApp, attachFrontend, errorHandler } from './server/app.js';

/** Error jaringan yang wajar terjadi saat berbicara dengan router/DB: dicatat, tidak mematikan proses. */
const BENIGN_NET_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED']);

let shuttingDown = false;

async function main() {
  const { fatal, warnings } = validateConfig();
  warnings.forEach((w) => logger.warn(w));
  if (fatal.length > 0) {
    logger.error('Konfigurasi tidak valid, server tidak dijalankan:');
    fatal.forEach((f) => logger.error(`  - ${f}`));
    process.exit(1);
  }

  // Storage HARUS siap sebelum menerima request (sebelumnya server sudah listen saat data belum dimuat).
  await storage.init();

  const app = createApp();
  await attachFrontend(app);
  app.use(errorHandler);

  const server = app.listen(config.port, config.host, () => {
    logger.info(`PPPoE Manager berjalan di http://${config.host}:${config.port} (${config.isProduction ? 'production' : 'development'}, storage: ${storage.getMode()})`);
  });

  // Timeout server agar koneksi menggantung tidak menumpuk
  server.keepAliveTimeout = 65_000; // > idle timeout Nginx/ELB (60 dtk)
  server.headersTimeout = 66_000;
  server.requestTimeout = 60_000;

  server.on('error', (err: NodeJS.ErrnoException) => {
    logger.error(err.code === 'EADDRINUSE' ? `Port ${config.port} sudah dipakai proses lain.` : `Server error: ${err.message}`);
    process.exit(1);
  });

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} diterima. Mematikan server dengan rapi...`);

    const force = setTimeout(() => {
      logger.error('Shutdown melebihi 15 detik, dipaksa keluar.');
      process.exit(1);
    }, 15_000);
    force.unref();

    server.close(); // berhenti menerima koneksi baru; request berjalan dilanjutkan
    (server as any).closeIdleConnections?.();
    try {
      await routerManager.shutdown();
      await storage.close(); // pastikan semua data tertulis
    } catch (err: any) {
      logger.error('Error saat shutdown', { message: err?.message });
    }
    logger.info('Shutdown selesai.');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason: any) => {
  logger.error('Unhandled promise rejection', { message: reason?.message || String(reason), stack: reason?.stack });
});

process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err?.code && BENIGN_NET_CODES.has(err.code)) {
    logger.warn(`Error jaringan tidak tertangani diabaikan: ${err.code} ${err.message}`);
    return;
  }
  // Keadaan proses tidak lagi dapat dipercaya: tulis data lalu keluar agar PM2 memulai ulang dengan bersih.
  logger.error('Uncaught exception, proses akan dimulai ulang', { message: err?.message, stack: err?.stack });
  storage
    .flush()
    .catch(() => undefined)
    .finally(() => process.exit(1));
});

main().catch((err) => {
  logger.error('Gagal memulai PPPoE Manager', { message: err?.message });
  process.exit(1);
});
