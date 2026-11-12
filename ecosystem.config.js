// pm2 process definition — one always-on Node process that owns the SQLite DB.
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup   (to relaunch on boot)
module.exports = {
  apps: [
    {
      name: 'workshopone',
      script: 'src/server.js',
      instances: 1, // exactly one process may open the SQLite file
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 1949,
        HOST: '0.0.0.0',
        DB_PATH: './data/workshopone_merged.db',
      },
      out_file: 'logs/workshopone.out.log',
      error_file: 'logs/workshopone.err.log',
      time: true,
    },
  ],
};
