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
      // ANYTHING SET HERE BEATS .env. The loader in src/config.js only fills in keys that are not
      // already in the real environment, so a value in this file silently wins — the same trap
      // deploy/workshopone.service documents.
      //
      // That is why HOST and PORT are NOT set here. This file used to carry HOST: '0.0.0.0',
      // which is right for the LAN mini-PC but overrode the HOST=127.0.0.1 that deploy/VPS.md
      // asks of a public server: the app sat on the public interface beside nginx, with TLS
      // bypassed and only the firewall keeping it private. `ss -ltnp | grep 3000` read
      // 0.0.0.0:3000 on the live server for exactly this reason. Each deployment states its own
      // in .env, where VPS.md and DEPLOY.md both tell people to look.
      //
      // Changing this file does not move a process already running: pm2 keeps the environment it
      // was started with, so `pm2 restart` carries the old HOST over. It takes
      // `pm2 delete workshopone && pm2 start ecosystem.config.js`.
      env: {
        NODE_ENV: 'production',
      },
      out_file: 'logs/workshopone.out.log',
      error_file: 'logs/workshopone.err.log',
      time: true,
    },
  ],
};
