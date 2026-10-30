# Changelog

## 1.1.0 — Perbaikan stabilitas, keamanan, dan responsivitas

### Bug kritis yang diperbaiki
- **Sesi tidak bertahan saat halaman dimuat ulang**: `/api/auth/me` dan `/api/auth/change-password` tidak pernah menjalankan autentikasi (selalu 401) sehingga setiap refresh mengeluarkan pengguna dan ganti password tidak mungkin dilakukan.
- **Reset demo menghapus router produksi**: `POST /api/demo/reset-demo` (dan `/api/audit-logs/reset-demo`) dapat dipanggil user mana pun dan menimpa seluruh daftar router. Kini hanya Superadmin dan hanya menyentuh router bertanda demo.
- **Aksi pada router yang salah**: pada mode "Semua Router", mengubah/menghapus item yang tak ditemukan jatuh ke router *pertama*. Kini 404 (tidak ada) atau 409 (nama ada di beberapa router; wajib pilih router).
- **Balasan `!empty` RouterOS v7.18+** menyebabkan error/hang pada hasil kosong. Klien RouterOS API ditulis ulang (pustaka `node-routeros` sudah discontinued).
- **REST over HTTPS gagal** pada sertifikat self-signed bawaan RouterOS (kini memakai `node:https` dengan opsi verifikasi).
- **Kegagalan `/ppp/active` tampil sebagai "0 user online"** (error ditelan). Kini error diteruskan.
- **Deadlock/ketidakkonsistenan penyimpanan**: tulis MySQL "tembak-lupakan" tanpa urutan; kegagalan tidak terlihat. Kini antrean berurutan, retry, dan mutasi penting menunggu hasil.
- Server `listen` sebelum data selesai dimuat; MySQL gagal → **diam-diam pindah ke JSON** sehingga data bercabang. Kini storage siap dulu; MySQL mati → retry lalu berhenti jelas.
- `connectTimeout` MySQL 800 ms (terlalu pendek) → 10 dtk.
- Grafik dashboard memakai **riwayat sintetis** (`sin()`); kini hanya data nyata.
- `schema.sql` menanam admin `admin123`; halaman login menampilkan & mengisi otomatis kredensial itu. Dihapus.

### Keamanan
- Hak akses ditegakkan **di server** (sebelumnya hanya menyembunyikan menu). Peran/status dibaca ulang tiap request; suspend/hapus user langsung berlaku.
- Kelola router & user: khusus Superadmin. Tidak bisa menghapus/menurunkan superadmin aktif terakhir.
- `JWT_SECRET`/`ENCRYPTION_KEY` wajib di production (kunci bawaan publik ditolak).
- Password: scrypt + salt (hash SHA-256 lama di-upgrade otomatis saat login). Enkripsi router: AES-256-GCM (data CBC lama dimigrasi otomatis).
- Pembatas login (per IP & per user), header keamanan, validasi input (tipe, panjang, port, mode, host), whitelist kolom SQL, token dicabut saat password berubah, tanpa bocor stack trace.
- Bootstrap admin: `ADMIN_PASSWORD` atau password acak satu kali di log; tidak ada akun bawaan.

### Stabilitas & performa
- Pool koneksi router yang dipakai ulang (sebelumnya 1 koneksi baru per perintah), cache hasil baca + penggabungan request identik, *circuit breaker*, batas paralelisme, timeout yang dibersihkan.
- Dashboard memakai `count`/`proplist` ringan, bukan mengunduh seluruh secret berkali-kali.
- Penyimpanan JSON atomik + cadangan otomatis + pemulihan dari file rusak; tulis di-debounce (sebelumnya menulis ulang seluruh file di setiap polling).
- Retensi audit log otomatis; cache terbatas; tracker trafik dibatasi (sebelumnya Map tumbuh tanpa batas).
- Graceful shutdown (SIGTERM/SIGINT menyimpan data), health check `/api/health`, logger terstruktur, konfigurasi PM2 (batas memori, backoff, kill_timeout).
- Frontend: polling berhenti saat tab tersembunyi, tanpa tumpang tindih & tanpa spinner tiap siklus, respons usang dibuang, timeout & dedupe request, error boundary, code-splitting (bundel utama 516 → 287 kB), font non-blocking, tinggi layar `dvh` untuk HP.
- UI baru: Ganti Password, banner peringatan password bawaan.

### Dependensi
- Dihapus: `node-routeros` (discontinued), `@google/genai`, `motion` (tidak dipakai). Ditambah: `compression`.

### Pengujian
- 42 tes otomatis (`npm test`): protokol RouterOS (termasuk `!empty`, login lama, timeout, koneksi basi), REST, kripto, upgrade dari `db.json` lama, API end-to-end + RBAC, dan jalur MySQL (`npm run test:mysql`).

### Perubahan perilaku (perlu diketahui)
- Pengguna login ulang sekali setelah upgrade. Password minimal 8 karakter (sebelumnya 6).
- Mode demo tidak aktif otomatis (`ENABLE_DEMO=true`).
- `data/` kini di `.gitignore`. Lihat README → "Upgrade dari Versi Lama".
