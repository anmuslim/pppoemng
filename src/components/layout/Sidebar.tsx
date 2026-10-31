import React, { useState } from 'react';
import {
  LayoutDashboard,
  Router as RouterIcon,
  KeyRound,
  Activity,
  Sliders,
  GitFork,
  Database,
  History,
  X,
  Radio,
  Server,
  Users,
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { useRouterContext } from '../../context/RouterContext.tsx';
import { useAuth } from '../../context/AuthContext.tsx';

export type NavTab =
  | 'dashboard'
  | 'routers'
  | 'secrets'
  | 'active'
  | 'profiles'
  | 'queues'
  | 'pools'
  | 'audit'
  | 'users';

interface SidebarProps {
  currentTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  mobileOpen,
  onCloseMobile,
}) => {
  const { routers, selectedRouterId } = useRouterContext();
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('pppoe_sidebar_collapsed') === 'true';
    } catch {
      return false;
    }
  });

  const toggleCollapse = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('pppoe_sidebar_collapsed', String(next));
      } catch {}
      return next;
    });
  };

  const navItems = [
    {
      id: 'dashboard' as NavTab,
      label: 'Dashboard',
      icon: <LayoutDashboard className="w-4 h-4" />,
      sublabel: 'Ringkasan & Metrik',
    },
    {
      id: 'routers' as NavTab,
      label: 'Router MikroTik',
      icon: <RouterIcon className="w-4 h-4" />,
      sublabel: `${routers.length} Terdaftar`,
    },
    {
      id: 'secrets' as NavTab,
      label: 'PPP Secrets',
      icon: <KeyRound className="w-4 h-4" />,
      sublabel: '/ppp/secret',
    },
    {
      id: 'active' as NavTab,
      label: 'PPP Active',
      icon: <Activity className="w-4 h-4" />,
      sublabel: 'Monitoring Realtime',
      pulse: true,
    },
    {
      id: 'profiles' as NavTab,
      label: 'PPP Profiles',
      icon: <Sliders className="w-4 h-4" />,
      sublabel: '/ppp/profile',
    },
    {
      id: 'queues' as NavTab,
      label: 'Simple Queues',
      icon: <GitFork className="w-4 h-4" />,
      sublabel: '/queue/simple',
    },
    {
      id: 'pools' as NavTab,
      label: 'IP Pool',
      icon: <Database className="w-4 h-4" />,
      sublabel: '/ip/pool',
    },
    {
      id: 'audit' as NavTab,
      label: 'Riwayat Aktivitas',
      icon: <History className="w-4 h-4" />,
      sublabel: 'Audit Log & Catatan',
    },
    {
      id: 'users' as NavTab,
      label: 'Manajemen User',
      icon: <Users className="w-4 h-4" />,
      sublabel: 'Hak Akses & Akun',
    },
  ];

  const { user } = useAuth();
  const isSuperadmin = user?.role === 'superadmin';
  const allowedMenus = user?.allowedMenus || ['dashboard'];

  const visibleNavItems = navItems.filter((item) => {
    if (isSuperadmin) return true;
    return allowedMenus.includes(item.id);
  });

  const onlineRoutersCount = routers.filter((r) => r.status === 'online').length;

  const renderNav = (collapsed: boolean) => (
    <div className="h-full flex flex-col justify-between p-2.5 select-none overflow-x-hidden">
      <div className="space-y-1">
        {/* Mobile close button (only in mobile drawer) */}
        <div className="lg:hidden flex items-center justify-between pb-3 mb-2 border-b border-slate-200 dark:border-zinc-800">
          <span className="font-semibold text-sm text-slate-800 dark:text-zinc-200">Menu Utama</span>
          <button
            onClick={onCloseMobile}
            className="p-1 text-slate-500 hover:text-slate-800 dark:hover:text-white"
            aria-label="Tutup menu"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Desktop Header Toggle Button */}
        <div className="hidden lg:flex items-center justify-between pb-2 mb-1 border-b border-slate-200 dark:border-zinc-800">
          {!collapsed && (
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-zinc-500 px-1">
              Navigasi
            </span>
          )}
          <button
            onClick={toggleCollapse}
            className={`p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors ${
              collapsed ? 'mx-auto' : 'ml-auto'
            }`}
            title={collapsed ? 'Perluas Navigasi (Expand Sidebar)' : 'Perkecil Navigasi (Minimize Sidebar)'}
            aria-label={collapsed ? 'Perluas Navigasi' : 'Perkecil Navigasi'}
          >
            {collapsed ? <ChevronRight className="w-4 h-4 text-sky-500" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>

        {/* Navigation list */}
        <nav className="space-y-1">
          {visibleNavItems.map((item) => {
            const isActive = currentTab === item.id;

            if (collapsed) {
              return (
                <div key={item.id} className="relative group">
                  <button
                    onClick={() => {
                      onSelectTab(item.id);
                      onCloseMobile();
                    }}
                    className={`w-full flex items-center justify-center p-2.5 rounded-lg text-xs font-medium transition-all relative ${
                      isActive
                        ? 'bg-sky-600 text-white shadow-xs'
                        : 'text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800/80 hover:text-slate-900 dark:hover:text-zinc-100'
                    }`}
                    aria-label={item.label}
                  >
                    <span className={`${isActive ? 'text-white' : 'text-slate-400 dark:text-zinc-500'}`}>
                      {item.icon}
                    </span>

                    {item.pulse && (
                      <span className="absolute top-1.5 right-1.5 flex h-2 w-2">
                        <span
                          className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                            isActive ? 'bg-white' : 'bg-emerald-400'
                          }`}
                        />
                        <span
                          className={`relative inline-flex rounded-full h-2 w-2 ${
                            isActive ? 'bg-white' : 'bg-emerald-500'
                          }`}
                        />
                      </span>
                    )}
                  </button>

                  {/* Floating tooltip badge on hover in collapsed mode */}
                  <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2.5 py-1.5 bg-slate-900 dark:bg-zinc-800 text-white rounded-md shadow-xl text-xs font-medium pointer-events-none hidden group-hover:flex flex-col z-50 whitespace-nowrap border border-slate-700 dark:border-zinc-700">
                    <span className="font-semibold text-slate-100">{item.label}</span>
                    <span className="text-[10px] text-slate-400 font-mono">{item.sublabel}</span>
                  </div>
                </div>
              );
            }

            return (
              <button
                key={item.id}
                onClick={() => {
                  onSelectTab(item.id);
                  onCloseMobile();
                }}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-all text-left ${
                  isActive
                    ? 'bg-sky-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800/80 hover:text-slate-900 dark:hover:text-zinc-100'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className={`${isActive ? 'text-white' : 'text-slate-400 dark:text-zinc-500'}`}>
                    {item.icon}
                  </span>
                  <div>
                    <span className="block leading-tight font-semibold">{item.label}</span>
                    <span
                      className={`text-[10px] block mt-0.5 leading-tight ${
                        isActive ? 'text-sky-100' : 'text-slate-500 dark:text-zinc-400 font-mono'
                      }`}
                    >
                      {item.sublabel}
                    </span>
                  </div>
                </div>

                {item.pulse && (
                  <span className="relative flex h-2 w-2">
                    <span
                      className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                        isActive ? 'bg-white' : 'bg-emerald-400'
                      }`}
                    />
                    <span
                      className={`relative inline-flex rounded-full h-2 w-2 ${
                        isActive ? 'bg-white' : 'bg-emerald-500'
                      }`}
                    />
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Router Status Widget at bottom */}
      <div className="pt-3 border-t border-slate-200 dark:border-zinc-800">
        {collapsed ? (
          <div className="relative group flex flex-col items-center">
            <div className="p-2 rounded-lg bg-slate-50 dark:bg-zinc-800/60 border border-slate-200 dark:border-zinc-800 flex flex-col items-center justify-center cursor-pointer">
              <Server className="w-4 h-4 text-sky-500" />
              <span className="text-[10px] font-mono font-bold text-emerald-600 dark:text-emerald-400 mt-1">
                {onlineRoutersCount}/{routers.length}
              </span>
            </div>

            {/* Tooltip on hover */}
            <div className="absolute left-full bottom-0 ml-2 p-2.5 bg-slate-900 dark:bg-zinc-800 text-white rounded-lg shadow-xl text-xs pointer-events-none hidden group-hover:block z-50 whitespace-nowrap border border-slate-700 dark:border-zinc-700">
              <div className="font-semibold text-slate-100 flex items-center gap-1.5 mb-1">
                <Server className="w-3.5 h-3.5 text-sky-400" />
                <span>Target: {selectedRouterId === 'all' ? 'SEMUA ROUTER' : 'SINGLE ROUTER'}</span>
              </div>
              <div className="text-[11px] text-slate-300 font-mono">
                Online: {onlineRoutersCount} / {routers.length}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                Mode Demo: {routers.some((r) => r.isDemo) ? 'Aktif' : 'Nonaktif'}
              </div>
            </div>
          </div>
        ) : (
          <div className="p-3 rounded-lg bg-slate-50 dark:bg-zinc-800/60 border border-slate-200 dark:border-zinc-800">
            <div className="flex items-center justify-between text-[11px] font-semibold text-slate-800 dark:text-zinc-200">
              <span className="flex items-center gap-1.5">
                <Server className="w-3.5 h-3.5 text-sky-500" />
                <span>Target Router</span>
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-sm bg-slate-200 dark:bg-zinc-700 text-slate-700 dark:text-zinc-200 font-bold">
                {selectedRouterId === 'all' ? 'SEMUA' : 'SINGLE'}
              </span>
            </div>
            <div className="mt-2 text-[11px] text-slate-600 dark:text-zinc-400 space-y-1">
              <div className="flex justify-between">
                <span>Router Online:</span>
                <span className="font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
                  {onlineRoutersCount} / {routers.length}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Mode Demo:</span>
                <span className="font-semibold text-slate-800 dark:text-zinc-200">
                  {routers.some((r) => r.isDemo) ? 'Aktif' : 'Nonaktif'}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className={`hidden lg:block shrink-0 bg-white dark:bg-zinc-900 border-r border-slate-200 dark:border-zinc-800 h-[calc(100vh-3.5rem)] sticky top-14 overflow-y-auto transition-[width] duration-200 ${
          isCollapsed ? 'w-16' : 'w-60'
        }`}
      >
        {renderNav(isCollapsed)}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-xs transition-opacity"
            onClick={onCloseMobile}
          />
          <div className="relative w-72 max-w-[80vw] bg-white dark:bg-zinc-900 border-r border-slate-200 dark:border-zinc-800 h-full shadow-2xl z-10 animate-in slide-in-from-left duration-200">
            {renderNav(false)}
          </div>
        </div>
      )}
    </>
  );
};
