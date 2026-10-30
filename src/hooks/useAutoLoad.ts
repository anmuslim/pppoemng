import { useEffect, useMemo, useRef } from 'react';

export interface LoadRun {
  /** false bila konteks sudah berganti (mis. router lain dipilih) -> hasil harus dibuang. */
  isCurrent: () => boolean;
  end: () => void;
}

/**
 * Pengaman pemuatan data untuk view yang polling:
 *  - pemuatan senyap (polling berkala) TIDAK ditumpuk bila yang sebelumnya masih berjalan
 *  - hasil usang (router sudah berganti / ada pemuatan baru) dibuang, tidak menimpa data baru
 */
export function useLoadGuard() {
  const seq = useRef(0);
  const active = useRef(0);

  return useMemo(
    () => ({
      start(silent: boolean): LoadRun | null {
        if (silent && active.current > 0) return null; // jangan menumpuk request polling
        const mine = silent ? seq.current : ++seq.current;
        active.current++;
        let ended = false;
        return {
          isCurrent: () => mine === seq.current,
          end: () => {
            if (!ended) {
              ended = true;
              active.current--;
            }
          },
        };
      },
    }),
    []
  );
}

/**
 * Panggil `load(silent)` saat pertama kali dan saat `key` berubah (silent=false -> tampilkan loading),
 * serta setiap `tick` berubah (silent=true -> perbarui diam-diam di latar belakang).
 */
export function useAutoLoad(load: (silent: boolean) => void | Promise<void>, key: string, tick: number) {
  const prev = useRef<{ key: string } | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const silent = prev.current !== null && prev.current.key === key;
    prev.current = { key };
    void loadRef.current(silent);
  }, [key, tick]);
}
