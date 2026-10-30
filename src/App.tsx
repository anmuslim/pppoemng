import React, { Suspense, lazy, useState } from 'react';
import { ThemeProvider } from './context/ThemeContext.tsx';
import { AuthProvider, useAuth } from './context/AuthContext.tsx';
import { RouterProvider } from './context/RouterContext.tsx';
import { ToastProvider } from './components/common/Toast.tsx';
import { Header } from './components/layout/Header.tsx';
import { Sidebar, NavTab } from './components/layout/Sidebar.tsx';
import { DashboardView } from './views/DashboardView.tsx';
const RoutersView = lazy(() => import('./views/RoutersView.tsx').then((m) => ({ default: m.RoutersView })));
const SecretsView = lazy(() => import('./views/SecretsView.tsx').then((m) => ({ default: m.SecretsView })));
const ActiveView = lazy(() => import('./views/ActiveView.tsx').then((m) => ({ default: m.ActiveView })));
const ProfilesView = lazy(() => import('./views/ProfilesView.tsx').then((m) => ({ default: m.ProfilesView })));
const QueuesView = lazy(() => import('./views/QueuesView.tsx').then((m) => ({ default: m.QueuesView })));
const PoolsView = lazy(() => import('./views/PoolsView.tsx').then((m) => ({ default: m.PoolsView })));
const AuditLogView = lazy(() => import('./views/AuditLogView.tsx').then((m) => ({ default: m.AuditLogView })));
const UsersView = lazy(() => import('./views/UsersView.tsx').then((m) => ({ default: m.UsersView })));
import { LoginView } from './views/LoginView.tsx';
import { ErrorBoundary } from './components/common/ErrorBoundary.tsx';
import { PasswordWarningBanner } from './components/layout/PasswordWarningBanner.tsx';
import { Loader2 } from 'lucide-react';

const MainLayout: React.FC = () => {
  const { user, loading } = useAuth();
  const [currentTab, setCurrentTab] = useState<NavTab>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [tabLoading, setTabLoading] = useState(false);

  const handleSelectTab = (tab: NavTab) => {
    if (tab !== currentTab) {
      setTabLoading(true);
      setCurrentTab(tab);
      window.setTimeout(() => setTabLoading(false), 450);
    }
  };

  // Auto redirect if current tab is restricted for this user
  React.useEffect(() => {
    if (user && user.role !== 'superadmin' && user.allowedMenus && user.allowedMenus.length > 0) {
      if (!user.allowedMenus.includes(currentTab)) {
        setCurrentTab(user.allowedMenus[0] as NavTab);
      }
    }
  }, [user, currentTab]);

  const canView = (tab: NavTab) =>
    !!user && (user.role === 'superadmin' || !user.allowedMenus || user.allowedMenus.includes(tab));

  if (loading) {
    return (
      <div className="min-h-dvh w-full flex items-center justify-center bg-slate-50 dark:bg-zinc-950 text-slate-800 dark:text-zinc-200">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-sky-500 animate-spin" />
          <p className="text-xs font-medium">Memuat PPPoE Manager...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginView />;
  }

  return (
    <RouterProvider>
      <div className="min-h-dvh bg-slate-50 dark:bg-zinc-950 text-slate-900 dark:text-zinc-100 flex flex-col font-sans transition-colors">
        <Header onToggleMobileMenu={() => setMobileMenuOpen((prev) => !prev)} />

        {/* Global Menu Loading Progress Bar */}
        <div
          className={`h-0.5 w-full bg-slate-100 dark:bg-zinc-900 overflow-hidden relative z-40 transition-opacity duration-200 ${
            tabLoading ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          {tabLoading && (
            <div className="h-full bg-gradient-to-r from-sky-500 via-indigo-500 to-sky-400 animate-progress-indeterminate" />
          )}
        </div>

        <PasswordWarningBanner />

        <div className="flex-1 flex overflow-hidden">
          <Sidebar
            currentTab={currentTab}
            onSelectTab={handleSelectTab}
            mobileOpen={mobileMenuOpen}
            onCloseMobile={() => setMobileMenuOpen(false)}
          />

          <main className="flex-1 min-w-0 p-3 sm:p-6 lg:p-8 overflow-y-auto max-w-[1600px] w-full mx-auto">
            {/* key=currentTab: error boundary di-reset saat pindah halaman. Menu yang tidak diizinkan tidak dirender
                (tidak memicu request yang pasti ditolak server). */}
            <ErrorBoundary key={currentTab}>
              <Suspense
                fallback={
                  <div className="flex items-center justify-center py-24">
                    <Loader2 className="w-6 h-6 text-sky-500 animate-spin" />
                  </div>
                }
              >
              {currentTab === 'dashboard' && canView('dashboard') && <DashboardView onNavigateTo={handleSelectTab} />}
              {currentTab === 'routers' && canView('routers') && <RoutersView />}
              {currentTab === 'secrets' && canView('secrets') && <SecretsView />}
              {currentTab === 'active' && canView('active') && <ActiveView />}
              {currentTab === 'profiles' && canView('profiles') && <ProfilesView />}
              {currentTab === 'queues' && canView('queues') && <QueuesView />}
              {currentTab === 'pools' && canView('pools') && <PoolsView />}
              {currentTab === 'audit' && canView('audit') && <AuditLogView />}
              {currentTab === 'users' && canView('users') && <UsersView />}
              </Suspense>
            </ErrorBoundary>
          </main>
        </div>
      </div>
    </RouterProvider>
  );
};

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <MainLayout />
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
