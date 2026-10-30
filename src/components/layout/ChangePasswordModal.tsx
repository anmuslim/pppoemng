import React, { useState } from 'react';
import { Modal } from '../common/Modal.tsx';
import { useAuth } from '../../context/AuthContext.tsx';
import { useToast } from '../common/Toast.tsx';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const MIN_LENGTH = 8;

export const ChangePasswordModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const { changePassword } = useAuth();
  const { success } = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const close = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
    onClose();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next.length < MIN_LENGTH) return setError(`Password baru minimal ${MIN_LENGTH} karakter.`);
    if (next !== confirm) return setError('Konfirmasi password tidak sama.');
    if (next === current) return setError('Password baru harus berbeda dari password saat ini.');

    setSaving(true);
    try {
      await changePassword(current, next);
      success('Password Diperbarui', 'Gunakan password baru pada login berikutnya.');
      close();
    } catch (err: any) {
      setError(err.message || 'Gagal mengganti password.');
    } finally {
      setSaving(false);
    }
  };

  const input =
    'w-full px-3 py-2.5 bg-slate-50 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-700 rounded-xl text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 focus:outline-hidden';

  return (
    <Modal isOpen={isOpen} onClose={close} title="Ganti Password" subtitle="Password baru berlaku segera; sesi di perangkat lain akan keluar." maxWidth="md">
      <form onSubmit={submit} className="space-y-3 text-sm">
        <div>
          <label className="block font-semibold text-slate-700 dark:text-zinc-300 mb-1.5">Password Saat Ini</label>
          <input type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={input} />
        </div>
        <div>
          <label className="block font-semibold text-slate-700 dark:text-zinc-300 mb-1.5">Password Baru</label>
          <input type="password" required autoComplete="new-password" minLength={MIN_LENGTH} value={next} onChange={(e) => setNext(e.target.value)} placeholder={`Minimal ${MIN_LENGTH} karakter`} className={input} />
        </div>
        <div>
          <label className="block font-semibold text-slate-700 dark:text-zinc-300 mb-1.5">Ulangi Password Baru</label>
          <input type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={input} />
        </div>

        {error && (
          <div role="alert" className="p-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-xs">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={close} className="px-4 py-2 rounded-lg text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800">
            Batal
          </button>
          <button type="submit" disabled={saving} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold disabled:opacity-50">
            {saving ? 'Menyimpan...' : 'Simpan Password'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
