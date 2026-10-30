// Konfigurasi PM2 untuk PPPoE Manager.
// Semua variabel (JWT_SECRET, ENCRYPTION_KEY, DB_*, PORT, ...) dibaca dari file .env oleh server.ts.
module.exports = {
  apps: [
    {
      name: 'pppoe-manager',
      script: 'server.ts',
      interpreter: './node_modules/.bin/tsx',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
      // Satu proses (fork): pembatas login & cache bersifat in-memory, jadi jangan dijalankan mode cluster.
      exec_mode: 'fork',
      instances: 1,

      // Stabilitas jangka panjang
      autorestart: true,
      max_memory_restart: '600M', // restart bersih bila memori tak wajar (sebelum OOM menjatuhkan server)
      node_args: '--max-old-space-size=512',
      exp_backoff_restart_delay: 200, // jeda restart naik bertahap -> tidak "crash loop" membebani CPU
      max_restarts: 20,
      min_uptime: '20s', // restart < 20 detik dihitung sebagai gagal start
      kill_timeout: 20000, // beri waktu shutdown rapi (menyimpan data) sebelum SIGKILL
      listen_timeout: 30000,

      // Log
      time: true,
      merge_logs: true,
      out_file: './logs/out.log',
      error_file: './logs/error.log',
    },
  ],
};
