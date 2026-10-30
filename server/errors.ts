/**
 * Hierarki error aplikasi. Dipakai agar error handler pusat bisa memetakan
 * jenis kegagalan ke status HTTP yang tepat dan agar circuit breaker router
 * hanya "menghitung" kegagalan koneksi (bukan kesalahan perintah biasa).
 */

/** Error HTTP yang aman ditampilkan ke klien. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'Akses ditolak. Token autentikasi diperlukan.') => new HttpError(401, msg);
export const forbidden = (msg = 'Anda tidak memiliki izin untuk aksi ini.') => new HttpError(403, msg);
export const notFound = (msg = 'Data tidak ditemukan.') => new HttpError(404, msg);
export const conflict = (msg: string) => new HttpError(409, msg);

/**
 * Gagal terhubung / berkomunikasi dengan router (timeout, ECONNREFUSED, login ditolak, dsb).
 * Hanya error jenis ini yang membuka circuit breaker dan menandai router "offline".
 */
export class RouterConnectionError extends Error {
  constructor(
    message: string,
    public readonly kind: 'timeout' | 'refused' | 'auth' | 'network' | 'protocol' = 'network'
  ) {
    super(message);
    this.name = 'RouterConnectionError';
  }
}

/** Router merespons, tetapi menolak perintah (mis. "already have such name"). Bukan masalah koneksi. */
export class RouterCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouterCommandError';
  }
}

export function errorMessage(err: unknown, fallback = 'Terjadi kesalahan'): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return fallback;
}
