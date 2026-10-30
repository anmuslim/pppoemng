import React, { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { ChangePasswordModal } from './ChangePasswordModal.tsx';

/** Muncul selama akun masih memakai password bawaan lama (admin123 dsb.) yang tertanam di source code publik. */
export const PasswordWarningBanner: React.FC = () => {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  if (!user?.mustChangePassword) return null;

  return (
    <>
      <div role="alert" className="bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900 px-3 sm:px-6 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-amber-800 dark:text-amber-200">
        <TriangleAlert className="w-4 h-4 shrink-0" />
        <span className="flex-1 min-w-[12rem]">
          Akun Anda masih memakai <strong>password bawaan yang diketahui publik</strong>. Segera ganti agar sistem tidak mudah diambil alih.
        </span>
        <button onClick={() => setOpen(true)} className="px-3 py-1 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-semibold">
          Ganti Sekarang
        </button>
      </div>
      <ChangePasswordModal isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
};
