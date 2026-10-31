import { Router, Response } from 'express';
import { storage } from '../storage.js';
import { routerManager } from '../drivers/manager.js';
import { formatRate } from '../drivers/common.js';
import { RouterConnectionError, errorMessage } from '../errors.js';
import { config } from '../config.js';
import { asyncHandler } from './helpers.js';

const router = Router();

interface RouterSummaryRow {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'checking';
  activeCount: number;
  secretCount: number;
  disabledCount: number;
  cpuLoad: number;
  freeMemory: number;
  totalMemory: number;
  uptime: string;
  version: string;
  boardName: string;
  error?: string;
}

// Dashboard: tiap router dibaca paralel (dibatasi) dari cache bersama; router mati tidak menahan yang lain.
router.get(
  '/',
  asyncHandler(async (_req, res: Response) => {
    const routers = storage.getRouters().slice();
    let totalRxBps = 0;
    let totalTxBps = 0;

    const rows = await Promise.all(
      routers.map(async (r): Promise<RouterSummaryRow> => {
        try {
          const [resource, stats, active] = await Promise.all([
            routerManager.read(r, { key: 'resource', ttlMs: config.cache.resourceTtlMs }, (d) => d.getSystemResource()),
            routerManager.read(r, { key: 'secretStats', ttlMs: config.cache.secretsTtlMs * 2 }, (d) => d.getSecretStats()),
            routerManager.read(r, { key: 'active', ttlMs: config.cache.activeTtlMs }, (d) => d.getActive()),
          ]);

          for (const a of active) {
            totalRxBps += a.rxBps || 0;
            totalTxBps += a.txBps || 0;
          }

          // Telemetri disimpan ke memori (dipersist maksimal 1x/menit oleh storage).
          storage.updateRouterRuntime(r.id, {
            identity: resource.identity,
            version: resource.version,
            uptime: resource.uptime,
            cpuLoad: resource.cpuLoad,
            freeMemory: resource.freeMemory,
            totalMemory: resource.totalMemory,
            boardName: resource.boardName,
          });

          return {
            id: r.id,
            name: r.name,
            status: 'online',
            activeCount: active.length,
            secretCount: stats.total,
            disabledCount: stats.disabled,
            cpuLoad: resource.cpuLoad,
            freeMemory: resource.freeMemory,
            totalMemory: resource.totalMemory,
            uptime: resource.uptime,
            version: resource.version,
            boardName: resource.boardName,
          };
        } catch (err) {
          const connectionProblem = err instanceof RouterConnectionError;
          return {
            id: r.id,
            name: r.name,
            status: connectionProblem ? 'offline' : 'online',
            activeCount: 0,
            secretCount: 0,
            disabledCount: 0,
            cpuLoad: 0,
            freeMemory: 0,
            totalMemory: 0,
            uptime: '-',
            version: '-',
            boardName: '-',
            error: errorMessage(err, 'Router tidak dapat dihubungi'),
          };
        }
      })
    );

    const online = rows.filter((r) => r.status === 'online').length;
    const totalActive = rows.reduce((s, r) => s + r.activeCount, 0);
    const totalSecrets = rows.reduce((s, r) => s + r.secretCount, 0);
    const totalDisabled = rows.reduce((s, r) => s + r.disabledCount, 0);

    const totalTrafficRxMbps = +(totalRxBps / 1_000_000).toFixed(2);
    const totalTrafficTxMbps = +(totalTxBps / 1_000_000).toFixed(2);

    // Rekam titik tren realtime ke riwayat jangka panjang
    storage.recordSessionTrend({
      timestamp: new Date().toISOString(),
      totalActive,
      totalSecrets,
      totalTrafficRxMbps,
      totalTrafficTxMbps,
    });

    res.json({
      success: true,
      data: {
        stats: {
          totalRouters: routers.length,
          onlineRouters: online,
          offlineRouters: routers.length - online,
          totalSecrets,
          totalActive,
          totalDisabled,
          totalTrafficRx: formatRate(totalRxBps),
          totalTrafficTx: formatRate(totalTxBps),
          totalTrafficDownload: formatRate(totalTxBps),
          totalTrafficUpload: formatRate(totalRxBps),
          totalTrafficRxMbps,
          totalTrafficTxMbps,
          totalTraffic: formatRate(totalRxBps + totalTxBps),
        },
        routerSummaries: rows,
        recentEvents: storage.getRecentEvents(),
      },
    });
  })
);

// Endpoint riwayat tren sesi aktif dengan rentang waktu fleksibel (jam, harian, mingguan, bulanan, tahunan)
router.get(
  '/trends',
  asyncHandler(async (req, res: Response) => {
    const range = (req.query.range as string) || '24h';
    const trendData = storage.getSessionTrends(range);
    res.json({
      success: true,
      data: trendData,
    });
  })
);

export default router;

