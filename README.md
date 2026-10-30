# PPPoE Manager - Manajemen MikroTik Multi-Router (Node.js & MySQL)

Aplikasi web full-stack modern untuk mengelola banyak router MikroTik secara terpusat dari satu dashboard. Dilengkapi dengan antarmuka bergaya Winbox/RouterOS yang responsif, visualisasi performa jaringan, aksi massal (*bulk actions*), dan dukungan database **MySQL / MariaDB**.

---

## Fitur Utama

1. **Multi-Router Management**:
   - Agregasi data dari banyak router sekaligus dalam mode **"Semua Router"** atau pantau per router individual.
   - Dukungan tiga mode koneksi: **Winbox API (port 8728)**, **API-SSL (port 8729)**, dan **RouterOS v7 REST API (port 443 / 80)**.
   - Kredensial router disimpan terenkripsi dengan **AES-256-GCM** (terautentikasi) di server dan tidak pernah dikirim mentah ke browser.
   - Uji koneksi langsung (*Test Connection*) menampilkan System Identity, Versi RouterOS, Model Board, Uptime, CPU Load, dan Free RAM.

2. **Dukungan Database MySQL & JSON Dual-Mode**:
   - Terintegrasi penuh dengan **MySQL 8.x / MariaDB 10.x** untuk ketahanan data produksi, konkurensi tinggi, dan kemudahan backup database ISP/RT-RW Net.
   - Auto-migrasi skema: Tabel dibuat otomatis saat aplikasi pertama kali dijalankan.
   - Mode file `data/db.json` bila MySQL tidak dikonfigurasi (ditulis atomik + cadangan otomatis). Bila MySQL *dikonfigurasi* tetapi mati, server mencoba ulang lalu berhenti jelas (tidak diam-diam pindah ke file JSON sehingga data tidak bercabang).

3. **Dashboard Monitoring Realtime**:
   - Metrik komprehensif: status router online/offline, total akun secret, user online, user terisolir/disabled, dan total traffic (Rx/Tx).
   - Grafik tren pengguna aktif realtime (SVG Bezier curve) dengan polling berkala yang dapat disesuaikan.
   - Tabel utilisasi CPU dan alokasi memori per router.
   - Log sesi terkini (koneksi masuk / terputus).

4. **PPP Secrets (`/ppp/secret`)**:
   - CRUD lengkap: Name, Password (dengan reveal toggle), Service, Profile, Local Address, Remote Address, Caller ID, Disabled, Comment.
   - Indikator status **Aktif / Offline** otomatis berdasarkan pencocokan sesi.
   - Aksi Massal (*Bulk Actions*): Aktifkan massal, nonaktifkan (isolir), ganti profile massal, dan hapus massal.
   - Fitur **Import CSV** dan **Export CSV**.

5. **PPP Active (`/ppp/active`)**:
   - Monitoring pelanggan online secara realtime dengan laju traffic Tx/Rx per klien (sinkronisasi queue dinamis).
   - Fitur **Kick / Disconnect** per klien atau **Bulk Disconnect** seluruh sesi aktif.

6. **PPP Profiles (`/ppp/profile`)**:
   - CRUD profil bandwidth dan konfigurasi pool IP.
   - Aksi Massal: Ganti DNS massal, ganti limitasi bandwidth massal, ganti Local/Remote address massal, dan hapus massal.

7. **Simple Queues & IP Pools**:
   - Manajemen hierarki antrean bandwidth parent-child.
   - Pengelolaan IP Pool dinamis untuk alokasi IP pelanggan PPPoE.

8. **Hak Akses Multi-User & Audit Trail**:
   - Role-Based Access Control: `Superadmin`, `Operator`, `Technician`.
   - Pembatasan menu per user **ditegakkan di server** (bukan hanya disembunyikan di tampilan); perubahan hak akses / suspend berlaku seketika.
   - Perlindungan brute-force login, hash password scrypt, dan sesi otomatis tidak berlaku setelah password diganti.
   - Catatan audit lengkap setiap perubahan konfigurasi router.

---

## Panduan Lengkap Instalasi di Ubuntu Server (MySQL)

Panduan ini berlaku untuk **Ubuntu Server 20.04, 22.04, atau 24.04 LTS**.

### Langkah 1: Update Sistem & Install Paket Pendukung
Buka terminal SSH server Ubuntu Anda dan jalankan:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git build-essential ufw
```

---

### Langkah 2: Install Node.js (Versi 20 LTS atau 22 LTS)
Gunakan NodeSource repository:

```bash
# Tambahkan repo Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -

# Install Node.js & npm
sudo apt install -y nodejs

# Verifikasi versi terpasang
node -v   # Minimal v20.x atau v22.x
npm -v
```

---

### Langkah 3: Install & Amankan MySQL Server

```bash
# Install MySQL Server
sudo apt install -y mysql-server

# Pastikan service MySQL berjalan
sudo systemctl enable --now mysql
sudo systemctl status mysql
```

Amankan instalasi MySQL (opsional namun disarankan):
```bash
sudo mysql_secure_installation
```

---

### Langkah 4: Buat Database & User MySQL untuk PPPoE Manager

Masuk ke konsol MySQL sebagai root:
```bash
sudo mysql
```

Jalankan perintah SQL berikut (ganti `PasswordKuatAnda123!` dengan password aman pilihan Anda):

```sql
-- 1. Buat database dengan encoding UTF8mb4
CREATE DATABASE pppoe_manager CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 2. Buat user khusus aplikasi
CREATE USER 'pppoe_user'@'localhost' IDENTIFIED BY 'PasswordKuatAnda123!';

-- 3. Berikan hak akses penuh ke database pppoe_manager
GRANT ALL PRIVILEGES ON pppoe_manager.* TO 'pppoe_user'@'localhost';
FLUSH PRIVILEGES;

-- 4. Keluar dari MySQL
EXIT;
```

---

### Langkah 5: Clone Repositori & Install Dependencies

Pilih direktori instalasi (misalnya di `/var/www/pppoe-manager` atau di home directory `~/pppoe-manager`):

```bash
# Clone source code
git clone https://github.com/anmuslim/whusnetpppoemanager.git /var/www/pppoe-manager

# Pindah ke direktori proyek
cd /var/www/pppoe-manager

# Install seluruh dependency
npm install
```

---

### Langkah 6: Konfigurasi File Lingkungan (`.env`)

Buat dua secret acak terlebih dahulu (jalankan dua kali, satu untuk `JWT_SECRET`, satu untuk `ENCRYPTION_KEY`):
```bash
openssl rand -hex 32
```

Salin template konfigurasi lalu isi:
```bash
cp .env.example .env
nano .env
chmod 600 .env
```

> **Penting:** Jangan ubah `ENCRYPTION_KEY` setelah router ditambahkan. Password router yang sudah tersimpan tidak bisa didekripsi dengan kunci baru.

Sesuaikan isi file `.env` (daftar lengkap ada di `.env.example`):
```env
PORT=3000
NODE_ENV=production

# Dua nilai BERBEDA, masing-masing hasil `openssl rand -hex 32`
JWT_SECRET=<hasil openssl pertama>
ENCRYPTION_KEY=<hasil openssl kedua>

# Password akun superadmin pertama. Bila dikosongkan, dibuat password acak
# yang dicetak SEKALI di log (lihat Langkah 10).
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<password kuat pilihan Anda>

# Konfigurasi Database MySQL
DB_TYPE=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=pppoe_user
DB_PASSWORD=PasswordKuatAnda123!
DB_NAME=pppoe_manager
```
> Di mode `production`, server **menolak berjalan** bila `JWT_SECRET` / `ENCRYPTION_KEY` kosong atau kurang dari 32 karakter. Ini disengaja: kunci bawaan lama tertanam di source code publik.

Simpan file dengan menekan `Ctrl + O`, lalu `Enter`, kemudian keluar dengan `Ctrl + X`.

---

### Langkah 7: Inisialisasi Database & Build Frontend

Jalankan skrip pemeriksaan koneksi & pembuatan tabel otomatis:
```bash
npm run db:init
```
*Output akan menampilkan:*
```text
✅ Berhasil terhubung ke MySQL Server! (Versi: 8.0.x)
✅ Semua tabel database berhasil diverifikasi/dibuat:
   - routers
   - users
   - audit_logs
   - recent_events
   - demo_data
🎉 Database MySQL siap digunakan oleh PPPoE Manager!
```

Selanjutnya, bangun aplikasi frontend (hasilnya di folder `dist/`):
```bash
npm run build
```

---

### Langkah 8: Jalankan Aplikasi di Latar Belakang (PM2)

Gunakan **PM2 Process Manager** agar aplikasi otomatis berjalan di background dan otomatis menyala kembali jika server reboot:

```bash
# Install PM2 secara global
sudo npm install -g pm2

# Jalankan aplikasi PPPoE Manager (memakai ecosystem.config.cjs)
pm2 start ecosystem.config.cjs

# Simpan status PM2 agar berjalan otomatis saat boot
pm2 save
pm2 startup
```
*(Salin dan jalankan perintah `sudo env PATH=...` yang ditampilkan oleh output `pm2 startup` jika ada).*

Untuk memantau log aplikasi kapan saja:
```bash
pm2 logs pppoe-manager
pm2 status
```

---

### Langkah 9: Konfigurasi Nginx Reverse Proxy & Domain/IP (Opsional namun Sangat Direkomendasikan)

Install Nginx:
```bash
sudo apt install -y nginx
```

Buat konfigurasi virtual host baru:
```bash
sudo nano /etc/nginx/sites-available/pppoe-manager
```

Isikan konfigurasi berikut (ganti `pppoe.domainanda.com` dengan domain Anda atau IP server):
```nginx
server {
    listen 80;
    server_name pppoe.domainanda.com;

    client_max_body_size 2M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";          # keep-alive ke aplikasi (lebih cepat)
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
    }
}
```
> Aplikasi membaca IP klien dari header `X-Forwarded-For` (`TRUST_PROXY=loopback` di `.env`) untuk pembatas login. Bila di depan Nginx masih ada proxy lain (mis. Cloudflare), sesuaikan `TRUST_PROXY` (lihat `.env.example`).

Aktifkan konfigurasi dan restart Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/pppoe-manager /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

Jika memiliki domain, pasang sertifikat SSL gratis (HTTPS):
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d pppoe.domainanda.com
```

Buka port firewall:
```bash
sudo ufw allow 'Nginx Full'
sudo ufw allow 22/tcp
sudo ufw enable
```

---

### Langkah 10: Akses Aplikasi & Login Pertama Kali

1. Buka browser: `http://ip-server-anda` (atau `https://pppoe.domainanda.com`). Jika belum memakai Nginx, gunakan `http://ip-server-anda:3000`.
2. Login dengan akun superadmin pertama:
   - **Username**: nilai `ADMIN_USERNAME` (default `admin`)
   - **Password**: nilai `ADMIN_PASSWORD` di `.env`. Bila Anda mengosongkannya, lihat password acak yang dibuat otomatis (hanya tampil sekali):
     ```bash
     pm2 logs pppoe-manager --lines 200 --nostream | grep -A4 "AKUN SUPERADMIN"
     ```
3. Ganti password kapan saja lewat **ikon profil (kanan atas) → Ganti Password**.

> Tidak ada lagi akun/password bawaan. Bila Anda meng-upgrade dari versi lama dan akun masih memakai `admin123`, muncul banner peringatan sampai password diganti.

---

## Konfigurasi di MikroTik RouterOS

Agar PPPoE Manager dapat terhubung ke MikroTik Anda, jalankan perintah berikut di Terminal Winbox atau SSH MikroTik:

```routeros
# 1. Aktifkan service API standar MikroTik (port 8728)
/ip service enable api

# 2. Buat grup dengan hak akses yang dibutuhkan
/user group add name=pppoe-api-group policy=api,read,write,!ftp,!reboot,!policy,!test,!winbox,!password,!sniff

# 3. Buat user API khusus untuk PPPoE Manager
/user add name=api-pppoe group=pppoe-api-group password="GantiPasswordKuat123!" address=IP_SERVER_UBUNTU/32
```

*(Ganti `IP_SERVER_UBUNTU` dengan IP server PPPoE Manager agar API MikroTik hanya bisa diakses dari server tersebut. Jangan gunakan `0.0.0.0/0`.)*

---

## Perintah Perawatan (Maintenance)

- **Cek Status Database**: `npm run db:init`
- **Cek kesehatan aplikasi**: `curl -s http://127.0.0.1:3000/api/health`
- **Restart Aplikasi**: `pm2 restart pppoe-manager` (shutdown rapi: data tertulis sebelum proses berhenti)
- **Update Aplikasi**:
  ```bash
  git pull && npm install && npm run build && pm2 restart pppoe-manager
  ```
- **Cek Log Realtime**: `pm2 logs pppoe-manager`
- **Backup Database MySQL**:
  ```bash
  mysqldump -u pppoe_user -p pppoe_manager > backup_pppoe_$(date +%F).sql
  ```
- **Restore Database MySQL**:
  ```bash
  mysql -u pppoe_user -p pppoe_manager < backup_pppoe_2026-10-26.sql
  ```
- **Backup mode JSON**: salin folder `data/` (berisi `db.json` dan `db.json.bak`). Backup `.env` secara terpisah: **tanpa `ENCRYPTION_KEY` yang sama, password router tidak bisa dibuka**.
- **Rotasi log PM2** (disarankan, sekali saja): `pm2 install pm2-logrotate`
- **Jalankan tes** (pengembangan): `npm test` (tes jalur MySQL: `npm run test:mysql` dengan MariaDB/MySQL uji).

---

## Upgrade dari Versi Lama (PENTING, baca sebelum `git pull`)

1. **Backup dulu** (data & kunci):
   ```bash
   cp -a data data-backup-$(date +%F) 2>/dev/null   # mode JSON
   cp .env .env.backup
   mysqldump -u pppoe_user -p pppoe_manager > backup_sebelum_upgrade.sql   # mode MySQL
   ```
2. File `data/db.json` dulu ikut tercatat di git. Agar `git pull` tidak menimpa/menghapus data Anda:
   ```bash
   cp data/db.json /tmp/db.json.save
   git checkout -- data/db.json 2>/dev/null; git pull
   mkdir -p data && cp /tmp/db.json.save data/db.json   # kembalikan data Anda
   ```
3. **Isi `JWT_SECRET` dan `ENCRYPTION_KEY`** di `.env` bila belum (production wajib). Bila sebelumnya Anda belum pernah mengisinya (memakai kunci bawaan lama), isi dengan nilai baru: password router lama **tetap terbaca** dan otomatis dimigrasi ke AES-256-GCM saat start pertama.
4. `npm install && npm run build && pm2 restart pppoe-manager --update-env`
5. Efek upgrade yang perlu Anda ketahui:
   - Semua pengguna perlu **login ulang** satu kali (format token berubah).
   - Hash password lama otomatis di-upgrade ke scrypt saat masing-masing pengguna berhasil login.
   - Bila akun masih memakai `admin123`/`operator123`/`teknisi123`, ada banner peringatan. **Segera ganti.**
   - Hak akses sekarang dicek di server: akun **Technician/Operator** hanya bisa mengubah data pada menu yang diizinkan; **tambah/ubah/hapus router dan kelola user hanya Superadmin**.
   - Mode demo tidak lagi aktif otomatis (`ENABLE_DEMO=true` bila diperlukan).

---

## Catatan Keamanan & Stabilitas

- Hak akses ditegakkan di sisi server; token dicek ulang terhadap data pengguna di setiap request.
- Login dibatasi (8 gagal/IP dan 20 gagal/user → terkunci 15 menit; dapat diatur di `.env`).
- Koneksi ke router memakai **pool koneksi yang dipakai ulang** (sebelumnya satu koneksi baru per perintah), cache hasil baca berumur pendek, dan *circuit breaker*: router yang mati dilewati cepat, bukan ditunggu belasan detik pada setiap request, dan tidak menghambat router lain.
- Klien RouterOS API bawaan sendiri (pustaka `node-routeros` sudah dihentikan dan tidak mengenal balasan `!empty` dari RouterOS v7.18+).
- Verifikasi TLS router default-nya mati karena RouterOS memakai sertifikat self-signed. Aman bila router berada di jaringan manajemen privat; aktifkan `ROUTEROS_TLS_VERIFY=true` bila memakai sertifikat valid. Batasi akses API router dengan `address=IP_SERVER/32` (lihat bagian MikroTik).
- Token login disimpan di `localStorage` browser. Akses aplikasi hanya lewat HTTPS bila dibuka dari internet.

## Troubleshooting

| Gejala | Penyebab & solusi |
|---|---|
| Server langsung berhenti saat start dengan pesan `JWT_SECRET belum diatur` | Isi `JWT_SECRET` & `ENCRYPTION_KEY` di `.env` (`openssl rand -hex 32`). |
| `Tidak dapat terhubung ke MySQL setelah beberapa percobaan` | MySQL belum jalan / kredensial salah. `sudo systemctl status mysql`, cek `DB_*` di `.env`, jalankan `npm run db:init`. |
| Router tampil *offline*, pesan `coba lagi N dtk` | Circuit breaker aktif setelah router gagal dihubungi; otomatis dicoba lagi. Tombol **Test Connection** di menu Router mencoba langsung. |
| `Login ditolak router` | Username/password API router salah, atau user MikroTik tidak punya policy `api`/`read`/`write`, atau `address=` pada user tidak mencakup IP server. |
| `Sertifikat TLS router tidak tepercaya` | Pakai `ROUTEROS_TLS_VERIFY=false` (sertifikat self-signed) atau pasang sertifikat valid di router. |
| `Password router tidak dapat didekripsi` | `ENCRYPTION_KEY` berbeda dari saat router dibuat. Pulihkan kunci lama, atau edit router dan simpan ulang passwordnya. |
| `Terlalu banyak percobaan login gagal` | Tunggu masa kunci (default 15 menit), atau restart aplikasi untuk membersihkan kunci. |
