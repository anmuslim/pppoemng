import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { api } from '../api/client.ts';
import { useLoadGuard } from '../hooks/useAutoLoad.ts';
import { OverviewData, SessionTrendRecord, SessionTrendResponse } from '../types/index.ts';
import { useRouterContext } from '../context/RouterContext.tsx';
import {
  Server,
  KeyRound,
  Users,
  UserX,
  Activity,
  ArrowUpRight,
  ArrowDownLeft,
  Cpu,
  Clock,
  ExternalLink,
  RotateCw,
  TrendingUp,
  Download,
  Calendar,
  Gauge,
  Play,
  Pause,
  Database,
} from 'lucide-react';

export type TrendRange = '1h' | '24h' | '7d' | '30d' | '1y';

const RANGE_LABELS: Record<TrendRange, { label: string; full: string; stepDesc: string }> = {
  '1h': { label: '1 Jam', full: '1 Jam Terakhir', stepDesc: 'Tiap 1-2 menit' },
  '24h': { label: 'Harian', full: '24 Jam Terakhir', stepDesc: 'Tiap 20 menit' },
  '7d': { label: 'Mingguan', full: '7 Hari Terakhir', stepDesc: 'Tiap 2 jam' },
  '30d': { label: 'Bulanan', full: '30 Hari Terakhir', stepDesc: 'Tiap 8 jam' },
  '1y': { label: 'Tahunan', full: '1 Tahun Terakhir', stepDesc: 'Tiap 3-4 hari' },
};

const POLLING_INTERVALS = [
  { val: 1, label: '1s (Cepat)' },
  { val: 3, label: '3s' },
  { val: 5, label: '5s (Default)' },
  { val: 10, label: '10s' },
  { val: 30, label: '30s' },
  { val: 60, label: '60s' },
  { val: 0, label: 'Jeda (Pause)' },
];

export const DashboardView: React.FC<{ onNavigateTo: (tab: any) => void }> = ({ onNavigateTo }) => {
  const { refreshTick, setSelectedRouterId, triggerManualRefresh } = useRouterContext();
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Time range & polling interval states
  const [selectedRange, setSelectedRange] = useState<TrendRange>(() => {
    try {
      const saved = localStorage.getItem('pppoe_trend_range');
      if (saved && ['1h', '24h', '7d', '30d', '1y'].includes(saved)) {
        return saved as TrendRange;
      }
    } catch {}
    return '24h';
  });

  const [pollingIntervalSec, setPollingIntervalSec] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('pppoe_trend_interval');
      if (saved !== null && !isNaN(Number(saved))) {
        return Number(saved);
      }
    } catch {}
    return 5;
  });

  // Persistent historical trend state
  const [trendData, setTrendData] = useState<SessionTrendResponse | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const guard = useLoadGuard();

  const handleRangeChange = (range: TrendRange) => {
    setSelectedRange(range);
    try {
      localStorage.setItem('pppoe_trend_range', range);
    } catch {}
  };

  const handleIntervalChange = (val: number) => {
    setPollingIntervalSec(val);
    try {
      localStorage.setItem('pppoe_trend_interval', String(val));
    } catch {}
  };

  // Fetch overview & trend data
  const fetchData = useCallback(
    async (silent: boolean = false) => {
      const run = guard.start(silent);
      if (!run) return;
      try {
        if (!silent) setLoading(true);

        const [resOverview, resTrends] = await Promise.all([
          api.overview.get(),
          api.overview.getTrends(selectedRange),
        ]);

        if (!run.isCurrent()) return;

        if (resOverview.success && resOverview.data) {
          setData(resOverview.data);
          setError(null);
        }

        if (resTrends.success && resTrends.data) {
          setTrendData(resTrends.data);
        }
      } catch (err: any) {
        if (run.isCurrent()) {
          setError(err.message || 'Gagal memuat overview');
        }
      } finally {
        if (run.isCurrent()) setLoading(false);
        run.end();
      }
    },
    [guard, selectedRange]
  );

  // Initial load and on manual refreshTick or range change
  useEffect(() => {
    fetchData(false);
  }, [fetchData, refreshTick, selectedRange]);

  // Periodic polling timer
  useEffect(() => {
    if (pollingIntervalSec <= 0) return;
    const intervalId = setInterval(() => {
      fetchData(true);
    }, pollingIntervalSec * 1000);

    return () => clearInterval(intervalId);
  }, [fetchData, pollingIntervalSec]);

  const stats = data?.stats;

  // Format date labels nicely based on range
  const formatTimestamp = (ts: string, range: TrendRange) => {
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return ts;
      if (range === '1h') {
        return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }
      if (range === '24h') {
        return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      }
      if (range === '7d' || range === '30d') {
        return `${d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('id-ID', {
          hour: '2-digit',
          minute: '2-digit',
        })}`;
      }
      return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
      return ts;
    }
  };

  // Export CSV
  const handleExportCsv = () => {
    if (!trendData || trendData.points.length === 0) return;
    const headers = ['Timestamp', 'Waktu Lokal', 'Sesi Aktif (PPPoE)', 'Total Secrets', 'Download Mbps (Tx)', 'Upload Mbps (Rx)'];
    const rows = trendData.points.map((p) => [
      p.timestamp,
      `"${new Date(p.timestamp).toLocaleString('id-ID')}"`,
      p.totalActive,
      p.totalSecrets ?? '',
      p.totalTrafficRxMbps ?? '',
      p.totalTrafficTxMbps ?? '',
    ]);

    const csvContent =
      'data:text/csv;charset=utf-8,\uFEFF' +
      [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute(
      'download',
      `pppoe-sesi-tren-${selectedRange}-${new Date().toISOString().slice(0, 10)}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // SVG Chart Calculations
  const chartSvg = useMemo(() => {
    const pointsList = trendData?.points || [];
    if (pointsList.length < 2) return null;

    const counts = pointsList.map((h) => h.totalActive);
    const rawMin = Math.min(...counts);
    const rawMax = Math.max(...counts);
    const paddingVal = Math.max(2, Math.round((rawMax - rawMin) * 0.15));
    const min = Math.max(0, rawMin - paddingVal);
    const max = rawMax + paddingVal;
    const range = max - min || 1;

    const width = 640;
    const height = 160;
    const paddingX = 18;
    const paddingTop = 20;
    const paddingBottom = 22;

    const points = pointsList.map((h, i) => {
      const x = paddingX + (i / (pointsList.length - 1)) * (width - paddingX * 2);
      const y = height - paddingBottom - ((h.totalActive - min) / range) * (height - paddingTop - paddingBottom);
      return { x, y, record: h, index: i };
    });

    // Smooth cubic bezier spline
    let pathD = `M ${points[0].x} ${points[0].y}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];
      const mx = (p0.x + p1.x) / 2;
      pathD += ` C ${mx} ${p0.y}, ${mx} ${p1.y}, ${p1.x} ${p1.y}`;
    }

    const areaD = `${pathD} L ${points[points.length - 1].x} ${height - paddingBottom} L ${points[0].x} ${
      height - paddingBottom
    } Z`;

    return { points, pathD, areaD, min, max, width, height, paddingX, paddingTop, paddingBottom };
  }, [trendData]);

  // Selected or hovered point
  const currentHoveredPoint =
    hoveredIndex !== null && chartSvg && chartSvg.points[hoveredIndex]
      ? chartSvg.points[hoveredIndex]
      : null;

  return (
    <div className="space-y-6">
      {/* Top Banner / Title */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
            Dashboard PPPoE Central
          </h2>
          <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
            Monitoring performa jaringan dan status router MikroTik terpusat
          </p>
        </div>

        <button
          onClick={triggerManualRefresh}
          className="self-start sm:self-auto flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-zinc-200 bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-700 rounded-lg transition-colors shadow-2xs"
        >
          <RotateCw className="w-3.5 h-3.5 text-sky-500" />
          <span>Refresh Sekarang</span>
        </button>
      </div>

      {/* Top Progress Loading Indicator */}
      {loading && (
        <div className="h-1 w-full bg-sky-100/40 dark:bg-zinc-850 rounded-full overflow-hidden relative">
          <div className="h-full bg-gradient-to-r from-sky-500 via-indigo-500 to-sky-400 animate-progress-indeterminate" />
        </div>
      )}

      {error && (
        <div className="p-3.5 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900 rounded-lg text-xs text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      {/* 5 Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 sm:gap-4">
        {/* Router Online / Offline */}
        <div
          onClick={() => onNavigateTo('routers')}
          className="p-4 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-xl shadow-xs cursor-pointer hover:border-sky-500/50 transition-all"
        >
          <div className="flex items-center justify-between text-slate-500 dark:text-zinc-400">
            <span className="text-xs font-medium">Status Router</span>
            <Server className="w-4 h-4 text-sky-500" />
          </div>
          <div className="mt-2.5 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-slate-900 dark:text-white font-mono tabular-nums">
              {stats?.onlineRouters ?? 0}
            </span>
            <span className="text-xs text-slate-400 dark:text-zinc-500 font-mono">
              / {stats?.totalRouters ?? 0} Online
            </span>
          </div>
          <div className="mt-2 text-[11px] text-slate-500 dark:text-zinc-400">
            {stats && stats.offlineRouters > 0 ? (
              <span className="text-rose-500 font-semibold">{stats.offlineRouters} router offline</span>
            ) : (
              <span className="text-emerald-500 font-medium">Semua router normal</span>
            )}
          </div>
        </div>

        {/* Total Secret PPPoE */}
        <div
          onClick={() => onNavigateTo('secrets')}
          className="p-4 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-xl shadow-xs cursor-pointer hover:border-sky-500/50 transition-all"
        >
          <div className="flex items-center justify-between text-slate-500 dark:text-zinc-400">
            <span className="text-xs font-medium">Total Secrets</span>
            <KeyRound className="w-4 h-4 text-indigo-500" />
          </div>
          <div className="mt-2.5 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-slate-900 dark:text-white font-mono tabular-nums">
              {stats?.totalSecrets ?? 0}
            </span>
            <span className="text-xs text-slate-400 dark:text-zinc-500">akun</span>
          </div>
          <p className="mt-2 text-[11px] text-slate-400 dark:text-zinc-500">Terdaftar di seluruh router</p>
        </div>

        {/* Active Users */}
        <div
          onClick={() => onNavigateTo('active')}
          className="p-4 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-xl shadow-xs cursor-pointer hover:border-sky-500/50 transition-all"
        >
          <div className="flex items-center justify-between text-slate-500 dark:text-zinc-400">
            <span className="text-xs font-medium">User Aktif</span>
            <Users className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="mt-2.5 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-emerald-600 dark:text-emerald-400 font-mono tabular-nums">
              {stats?.totalActive ?? 0}
            </span>
            <span className="text-xs text-slate-400 dark:text-zinc-500">sesi</span>
          </div>
          <div className="mt-2 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span>
              {stats?.totalSecrets
                ? `${Math.round(((stats.totalActive || 0) / stats.totalSecrets) * 100)}% online`
                : '0%'}
            </span>
          </div>
        </div>

        {/* User Disabled */}
        <div
          onClick={() => onNavigateTo('secrets')}
          className="p-4 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-xl shadow-xs cursor-pointer hover:border-sky-500/50 transition-all"
        >
          <div className="flex items-center justify-between text-slate-500 dark:text-zinc-400">
            <span className="text-xs font-medium">User Disabled</span>
            <UserX className="w-4 h-4 text-amber-500" />
          </div>
          <div className="mt-2.5 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-amber-600 dark:text-amber-400 font-mono tabular-nums">
              {stats?.totalDisabled ?? 0}
            </span>
            <span className="text-xs text-slate-400 dark:text-zinc-500">user</span>
          </div>
          <p className="mt-2 text-[11px] text-slate-400 dark:text-zinc-500">Isolir / nonaktif</p>
        </div>

        {/* Total Traffic */}
        <div className="col-span-2 md:col-span-1 p-4 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-xl shadow-xs">
          <div className="flex items-center justify-between text-slate-500 dark:text-zinc-400">
            <span className="text-xs font-medium">Total Traffic</span>
            <Activity className="w-4 h-4 text-purple-500" />
          </div>
          <div className="mt-2.5 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-purple-600 dark:text-purple-400 font-mono tabular-nums">
              {stats?.totalTraffic ?? '0 Mbps'}
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between text-[10px] font-mono">
            <span
              className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-semibold"
              title="Total Download pelanggan (MikroTik Tx)"
            >
              <ArrowDownLeft className="w-3 h-3" /> DL: {stats?.totalTrafficTx || '0 bps'}
            </span>
            <span
              className="flex items-center gap-1 text-sky-600 dark:text-sky-400 font-semibold"
              title="Total Upload pelanggan (MikroTik Rx)"
            >
              <ArrowUpRight className="w-3 h-3" /> UL: {stats?.totalTrafficRx || '0 bps'}
            </span>
          </div>
        </div>
      </div>

      {/* Grid: Active Users Line Chart & Recent Activity Events */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Realtime Active Users Chart & Historical Trends */}
        <div className="lg:col-span-2 p-5 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-xl shadow-xs">
          {/* Header Bar with Range & Polling Controls */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-4">
            <div>
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-sky-500" />
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                  Tren Sesi PPPoE Aktif Realtime
                </h3>
                {trendData?.totalRecorded !== undefined && (
                  <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 font-mono font-medium">
                    <Database className="w-3 h-3 text-sky-500" />
                    <span>{trendData.totalRecorded.toLocaleString('id-ID')} titik terekam</span>
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5">
                Semua data dari awal terekam terpusat · {RANGE_LABELS[selectedRange].full} ({RANGE_LABELS[selectedRange].stepDesc})
              </p>
            </div>

            {/* Controls: Range selector, polling interval & CSV export */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Range Selector Pill Group */}
              <div className="flex items-center bg-slate-100 dark:bg-zinc-800/90 p-0.5 rounded-lg border border-slate-200 dark:border-zinc-700 text-xs">
                {(['1h', '24h', '7d', '30d', '1y'] as TrendRange[]).map((r) => {
                  const active = selectedRange === r;
                  return (
                    <button
                      key={r}
                      onClick={() => handleRangeChange(r)}
                      className={`px-2.5 py-1 rounded-md font-medium text-[11px] transition-all cursor-pointer ${
                        active
                          ? 'bg-sky-600 text-white font-semibold shadow-2xs'
                          : 'text-slate-600 dark:text-zinc-300 hover:text-slate-900 dark:hover:text-white'
                      }`}
                      title={RANGE_LABELS[r].full}
                    >
                      {RANGE_LABELS[r].label}
                    </button>
                  );
                })}
              </div>

              {/* Polling Interval Selector */}
              <div className="flex items-center gap-1 bg-white dark:bg-zinc-850 px-2 py-1 rounded-lg border border-slate-200 dark:border-zinc-700 text-xs">
                <Gauge className="w-3.5 h-3.5 text-amber-500" />
                <select
                  value={pollingIntervalSec}
                  onChange={(e) => handleIntervalChange(Number(e.target.value))}
                  className="bg-transparent text-[11px] font-mono text-slate-700 dark:text-zinc-200 focus:outline-hidden cursor-pointer"
                  title="Atur interval waktu auto-refresh polling grafik"
                >
                  {POLLING_INTERVALS.map((opt) => (
                    <option key={opt.val} value={opt.val} className="dark:bg-zinc-800">
                      Poll: {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Export CSV button */}
              <button
                onClick={handleExportCsv}
                disabled={!trendData || trendData.points.length === 0}
                className="p-1.5 text-slate-600 dark:text-zinc-300 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 border border-slate-200 dark:border-zinc-700 rounded-lg transition-colors cursor-pointer"
                title="Export riwayat data tren ke CSV"
                aria-label="Export CSV"
              >
                <Download className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Quick Metrics Bar (Current, Peak, Min, Avg) */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 text-xs">
            <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-zinc-850 border border-slate-200 dark:border-zinc-800 flex items-center justify-between">
              <div>
                <span className="text-[10px] text-slate-400 block font-medium">Saat Ini</span>
                <span className="font-mono font-bold text-base text-emerald-600 dark:text-emerald-400 tabular-nums">
                  {trendData?.stats.current ?? stats?.totalActive ?? 0}
                </span>
                <span className="text-[10px] text-slate-400 ml-1">Klien</span>
              </div>
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            </div>

            <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-zinc-850 border border-slate-200 dark:border-zinc-800">
              <span className="text-[10px] text-slate-400 block font-medium">Tertinggi (Puncak)</span>
              <div className="flex items-baseline gap-1">
                <span className="font-mono font-bold text-base text-sky-600 dark:text-sky-400 tabular-nums">
                  {trendData?.stats.max ?? stats?.totalActive ?? 0}
                </span>
                <span className="text-[10px] text-slate-400">Klien</span>
              </div>
              {trendData?.stats.peakTime && (
                <span className="text-[9px] text-slate-400 block truncate font-mono">
                  {formatTimestamp(trendData.stats.peakTime, selectedRange)}
                </span>
              )}
            </div>

            <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-zinc-850 border border-slate-200 dark:border-zinc-800">
              <span className="text-[10px] text-slate-400 block font-medium">Terendah</span>
              <div className="flex items-baseline gap-1">
                <span className="font-mono font-bold text-base text-amber-600 dark:text-amber-400 tabular-nums">
                  {trendData?.stats.min ?? 0}
                </span>
                <span className="text-[10px] text-slate-400">Klien</span>
              </div>
            </div>

            <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-zinc-850 border border-slate-200 dark:border-zinc-800">
              <span className="text-[10px] text-slate-400 block font-medium">Rata-rata Sesi</span>
              <div className="flex items-baseline gap-1">
                <span className="font-mono font-bold text-base text-purple-600 dark:text-purple-400 tabular-nums">
                  {trendData?.stats.avg ?? 0}
                </span>
                <span className="text-[10px] text-slate-400">Klien</span>
              </div>
            </div>
          </div>

          {/* SVG Line Chart with Interactive Mouse Movement & Hover Tooltip */}
          <div
            className="relative w-full h-48 bg-slate-50 dark:bg-zinc-850/60 rounded-lg p-2 border border-slate-200 dark:border-zinc-750 overflow-hidden cursor-crosshair select-none"
            onMouseLeave={() => setHoveredIndex(null)}
            onMouseMove={(e) => {
              if (!chartSvg || chartSvg.points.length === 0) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const relativeX = (e.clientX - rect.left) / rect.width;
              const idx = Math.min(
                chartSvg.points.length - 1,
                Math.max(0, Math.round(relativeX * (chartSvg.points.length - 1)))
              );
              setHoveredIndex(idx);
            }}
          >
            {chartSvg ? (
              <>
                <svg
                  viewBox={`0 0 ${chartSvg.width} ${chartSvg.height}`}
                  className="w-full h-full overflow-visible"
                  preserveAspectRatio="none"
                >
                  <defs>
                    <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.38" />
                      <stop offset="85%" stopColor="#0ea5e9" stopOpacity="0.04" />
                      <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0.0" />
                    </linearGradient>
                  </defs>

                  {/* Horizontal Grid lines */}
                  <line
                    x1={chartSvg.paddingX}
                    y1={chartSvg.paddingTop + 20}
                    x2={chartSvg.width - chartSvg.paddingX}
                    y2={chartSvg.paddingTop + 20}
                    stroke="currentColor"
                    className="text-slate-200 dark:text-zinc-750"
                    strokeDasharray="4 4"
                  />
                  <line
                    x1={chartSvg.paddingX}
                    y1={chartSvg.height / 2}
                    x2={chartSvg.width - chartSvg.paddingX}
                    y2={chartSvg.height / 2}
                    stroke="currentColor"
                    className="text-slate-200 dark:text-zinc-750"
                    strokeDasharray="4 4"
                  />
                  <line
                    x1={chartSvg.paddingX}
                    y1={chartSvg.height - chartSvg.paddingBottom}
                    x2={chartSvg.width - chartSvg.paddingX}
                    y2={chartSvg.height - chartSvg.paddingBottom}
                    stroke="currentColor"
                    className="text-slate-200 dark:text-zinc-750"
                    strokeDasharray="4 4"
                  />

                  {/* Area under curve */}
                  <path d={chartSvg.areaD} fill="url(#chartGradient)" />

                  {/* Smooth Curve */}
                  <path
                    d={chartSvg.pathD}
                    fill="none"
                    stroke="#0ea5e9"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />

                  {/* Vertical Hairline guide on Hover */}
                  {currentHoveredPoint && (
                    <line
                      x1={currentHoveredPoint.x}
                      y1={chartSvg.paddingTop}
                      x2={currentHoveredPoint.x}
                      y2={chartSvg.height - chartSvg.paddingBottom}
                      stroke="#38bdf8"
                      strokeWidth="1.5"
                      strokeDasharray="3 3"
                    />
                  )}

                  {/* Data Points (Highlight end point & hovered point) */}
                  {chartSvg.points.map((pt, idx) => {
                    const isLast = idx === chartSvg.points.length - 1;
                    const isHovered = hoveredIndex === idx;
                    if (!isLast && !isHovered && chartSvg.points.length > 40) return null;

                    return (
                      <circle
                        key={idx}
                        cx={pt.x}
                        cy={pt.y}
                        r={isHovered ? 5.5 : isLast ? 4 : 2.5}
                        className={
                          isHovered
                            ? 'fill-sky-400 stroke-white dark:stroke-zinc-900 stroke-2'
                            : isLast
                            ? 'fill-emerald-400 stroke-white dark:stroke-zinc-900 stroke-2'
                            : 'fill-sky-500'
                        }
                      />
                    );
                  })}
                </svg>

                {/* Floating Interactive Tooltip */}
                {currentHoveredPoint && (
                  <div
                    className="absolute pointer-events-none z-30 transition-all duration-75 shadow-xl rounded-lg bg-slate-900/95 dark:bg-zinc-800/95 text-white p-2.5 text-xs border border-slate-700 dark:border-zinc-700 min-w-[170px]"
                    style={{
                      left: `${Math.min(
                        80,
                        Math.max(10, (currentHoveredPoint.index / (chartSvg.points.length - 1)) * 100)
                      )}%`,
                      top: '12px',
                      transform: 'translateX(-50%)',
                    }}
                  >
                    <div className="text-[10px] text-slate-300 font-mono flex items-center justify-between pb-1 border-b border-slate-700">
                      <span>{formatTimestamp(currentHoveredPoint.record.timestamp, selectedRange)}</span>
                      <span className="text-emerald-400 font-semibold font-sans">PPPoE</span>
                    </div>

                    <div className="mt-1.5 flex items-baseline justify-between font-mono">
                      <span className="text-slate-400 text-[11px]">Sesi Aktif:</span>
                      <span className="text-emerald-400 font-bold text-sm">
                        {currentHoveredPoint.record.totalActive} Klien
                      </span>
                    </div>

                    {currentHoveredPoint.record.totalTrafficRxMbps !== undefined && (
                      <div className="mt-1 text-[10px] font-mono flex items-center justify-between text-slate-300">
                        <span className="flex items-center gap-1 text-emerald-400">
                          <ArrowDownLeft className="w-3 h-3" /> DL (Tx):
                        </span>
                        <span>{currentHoveredPoint.record.totalTrafficRxMbps} Mbps</span>
                      </div>
                    )}

                    {currentHoveredPoint.record.totalTrafficTxMbps !== undefined && (
                      <div className="text-[10px] font-mono flex items-center justify-between text-slate-300">
                        <span className="flex items-center gap-1 text-sky-400">
                          <ArrowUpRight className="w-3 h-3" /> UL (Rx):
                        </span>
                        <span>{currentHoveredPoint.record.totalTrafficTxMbps} Mbps</span>
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-slate-500 dark:text-zinc-400">
                Memuat riwayat sesi PPPoE...
              </div>
            )}
          </div>

          {/* Timeline markers at bottom */}
          <div className="mt-2.5 flex items-center justify-between text-[11px] text-slate-500 dark:text-zinc-400 font-mono">
            <span>
              {trendData?.points && trendData.points.length > 0
                ? formatTimestamp(trendData.points[0].timestamp, selectedRange)
                : 'Awal'}
            </span>
            <span className="text-slate-400 dark:text-zinc-500 font-sans text-[10px]">
              Rentang: {RANGE_LABELS[selectedRange].full} · Hover pada grafik untuk melihat rincian
            </span>
            <span>
              {trendData?.points && trendData.points.length > 0
                ? formatTimestamp(trendData.points[trendData.points.length - 1].timestamp, selectedRange)
                : 'Sekarang'}
            </span>
          </div>
        </div>

        {/* Recent Session Events */}
        <div className="p-5 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-xl shadow-xs flex flex-col justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2 mb-1">
              <Clock className="w-4 h-4 text-purple-500" />
              <span>Log Sesi Terkini</span>
            </h3>
            <p className="text-[11px] text-slate-500 dark:text-zinc-400 mb-4">
              Aktivitas koneksi dan pemutusan sesi terbaru
            </p>

            <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
              {data?.recentEvents && data.recentEvents.length > 0 ? (
                data.recentEvents.map((evt) => (
                  <div
                    key={evt.id}
                    className="p-2.5 rounded-lg bg-slate-50 dark:bg-zinc-850/70 border border-slate-200 dark:border-zinc-700 text-xs flex items-center justify-between"
                  >
                    <div className="min-w-0 pr-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            evt.type === 'connected' ? 'bg-emerald-500' : 'bg-rose-500'
                          }`}
                        />
                        <span className="font-semibold text-slate-900 dark:text-zinc-100 truncate font-mono">
                          {evt.username}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-500 dark:text-zinc-400 mt-0.5 truncate">
                        {evt.routerName} · {evt.ipAddress}
                      </p>
                    </div>

                    <div className="text-right shrink-0">
                      <span
                        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-xs ${
                          evt.type === 'connected'
                            ? 'text-emerald-700 bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300'
                            : 'text-rose-700 bg-rose-100 dark:bg-rose-950 dark:text-rose-300'
                        }`}
                      >
                        {evt.type === 'connected' ? 'Terhubung' : 'Terputus'}
                      </span>
                      <p className="text-[9px] text-slate-500 dark:text-zinc-400 mt-1 font-mono">
                        {new Date(evt.timestamp).toLocaleTimeString('id-ID')}
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-center py-8 text-xs text-slate-500 dark:text-zinc-400">
                  Belum ada aktivitas sesi tercatat.
                </div>
              )}
            </div>
          </div>

          <button
            onClick={() => onNavigateTo('audit')}
            className="mt-4 w-full py-2 text-center text-xs font-semibold text-sky-600 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-950/30 rounded-lg transition-colors border border-sky-200 dark:border-sky-900 cursor-pointer"
          >
            Lihat Riwayat Audit Lengkap →
          </button>
        </div>
      </div>

      {/* Summary Table Per Router */}
      <div className="p-5 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-xl shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
              Ringkasan Beban & Kapasitas Tiap Router
            </h3>
            <p className="text-[11px] text-slate-500 dark:text-zinc-400">
              Pantau utilisasi CPU, rasio pelanggan aktif, memori, dan uptime RouterOS
            </p>
          </div>
          <button
            onClick={() => onNavigateTo('routers')}
            className="text-xs font-semibold text-sky-600 dark:text-sky-400 hover:underline flex items-center gap-1 cursor-pointer"
          >
            <span>Kelola Router</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-zinc-800 text-slate-600 dark:text-zinc-400 text-[11px] font-semibold bg-slate-50/50 dark:bg-zinc-850/50">
                <th className="py-2.5 px-3">Nama Router</th>
                <th className="py-2.5 px-3">Status</th>
                <th className="py-2.5 px-3">User Aktif / Secret</th>
                <th className="py-2.5 px-3">Beban CPU</th>
                <th className="py-2.5 px-3">Free RAM</th>
                <th className="py-2.5 px-3">Uptime</th>
                <th className="py-2.5 px-3 text-right">Aksi Cepat</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-zinc-800 font-mono text-slate-700 dark:text-zinc-200">
              {data?.routerSummaries && data.routerSummaries.length > 0 ? (
                data.routerSummaries.map((r) => {
                  const isOnline = r.status === 'online';
                  const activePercent = r.secretCount > 0 ? Math.round((r.activeCount / r.secretCount) * 100) : 0;
                  return (
                    <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-zinc-800/50 transition-colors">
                      <td className="py-3 px-3">
                        <div className="font-semibold text-slate-900 dark:text-white">{r.name}</div>
                        <div className="text-[10px] text-slate-400 font-sans">{r.boardName || 'RouterOS'}</div>
                      </td>
                      <td className="py-3 px-3">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                            isOnline
                              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                              : 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300'
                          }`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-500' : 'bg-rose-500'}`}
                          />
                          {isOnline ? 'Online' : 'Offline'}
                        </span>
                      </td>
                      <td className="py-3 px-3 tabular-nums">
                        <div>
                          <strong>{r.activeCount}</strong> / {r.secretCount} ({activePercent}%)
                        </div>
                        <div className="w-28 bg-slate-200 dark:bg-zinc-700 h-1.5 rounded-full mt-1.5 overflow-hidden">
                          <div
                            className="bg-emerald-500 h-full rounded-full transition-all"
                            style={{ width: `${Math.min(100, activePercent)}%` }}
                          />
                        </div>
                      </td>
                      <td className="py-3 px-3 tabular-nums">
                        <div className="flex items-center gap-2">
                          <Cpu className="w-3.5 h-3.5 text-slate-400" />
                          <span>{r.cpuLoad}%</span>
                        </div>
                        <div className="w-20 bg-slate-200 dark:bg-zinc-700 h-1.5 rounded-full mt-1.5 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              r.cpuLoad > 75 ? 'bg-rose-500' : r.cpuLoad > 50 ? 'bg-amber-500' : 'bg-sky-500'
                            }`}
                            style={{ width: `${Math.min(100, r.cpuLoad)}%` }}
                          />
                        </div>
                      </td>
                      <td className="py-3 px-3 tabular-nums">
                        {r.freeMemory} MB / {r.totalMemory} MB
                      </td>
                      <td className="py-3 px-3 tabular-nums text-slate-600 dark:text-zinc-400">{r.uptime}</td>
                      <td className="py-3 px-3 text-right">
                        <button
                          onClick={() => {
                            setSelectedRouterId(r.id);
                            onNavigateTo('secrets');
                          }}
                          className="px-2.5 py-1 text-[11px] font-semibold text-sky-600 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-950/40 rounded-md border border-sky-200 dark:border-sky-800 transition-colors cursor-pointer"
                        >
                          Kelola Secrets
                        </button>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-400">
                    Memuat data router...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
