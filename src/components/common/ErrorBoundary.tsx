import React from 'react';
import { TriangleAlert, RotateCw } from 'lucide-react';

interface State {
  error: Error | null;
}

/** Mencegah layar putih total: error render di satu halaman tidak menjatuhkan seluruh aplikasi. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Kesalahan tampilan:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="max-w-md mx-auto mt-16 p-6 rounded-xl border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/30 text-center">
        <TriangleAlert className="w-8 h-8 mx-auto text-rose-500 mb-3" />
        <h2 className="font-semibold text-slate-900 dark:text-white mb-1">Halaman ini mengalami kendala</h2>
        <p className="text-xs text-slate-600 dark:text-zinc-400 mb-4">Data Anda aman. Coba muat ulang halaman ini.</p>
        <button
          onClick={() => this.setState({ error: null })}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-semibold"
        >
          <RotateCw className="w-4 h-4" /> Coba Lagi
        </button>
      </div>
    );
  }
}
