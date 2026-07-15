# WorkshopOne — Deployment (Steps 1 & 2)

One always-on Node.js service on a single designated PC/mini-PC owns the SQLite
database. Other PCs and phones on the same network use it through a browser —
**no client install.**

> Fill in the placeholders in **UPPERCASE** for your site — I don't invent your
> network, hardware, or people.

## 1. One-time setup on the server PC

```bash
# install Node 20+ and pm2 once
node -v                      # must be >= 20
npm install -g pm2

# in the app folder
npm ci                       # install dependencies
cp .env.example .env         # then edit .env (see below)
npm run migrate              # create the DB + schema
# (production data comes from the Phase 1/2 migration, not the demo seed)
```

`.env` for production (edit):

```
PORT=3000
HOST=0.0.0.0                 # bind all interfaces so the LAN can reach it
DB_PATH=./data/workshopone.db
SESSION_SECRET=<a long random string — change this>
BACKUP_INTERVAL_MINUTES=30
BACKUP_RETENTION=96
BACKUP_MIRROR_DIR=/mnt/backup-drive/workshopone   # 2nd location (external drive/share)
```

## 2. Run it under a process manager (restarts on crash and on boot)

**Option A — pm2 (Windows or Linux):**

```bash
pm2 start ecosystem.config.js     # start
pm2 save                          # remember it
pm2 startup                       # print the command to relaunch on boot — run it
```

| Action | Command |
|---|---|
| Status | `pm2 status` / `pm2 info workshopone` |
| Logs | `pm2 logs workshopone` (files in `logs/`) |
| Restart | `pm2 restart workshopone` |
| Stop | `pm2 stop workshopone` |

**Option B — systemd (Linux):** see `deploy/workshopone.service` (edit the two
placeholders, then `systemctl enable --now workshopone`; logs via
`journalctl -u workshopone -f`).

On start the server prints the reachable URLs, e.g.:

```
WorkshopOne listening on 0.0.0.0:3000
Reachable on this network at:
  http://localhost:3000
  http://192.168.1.50:3000     <-- the LAN URL to share
```

## 2b. Network access for other PCs & phones

1. **Give the server a stable address.** Either set a **static local IP** on the
   server (e.g. `192.168.1.50`) or add a **DHCP reservation** on the router for
   its MAC address. Otherwise its IP can change and the URL breaks.
2. **Open the port in the OS firewall** on the server:
   - Windows: *Windows Defender Firewall → Advanced → Inbound Rules → New Rule →
     Port → TCP 3000 → Allow* (Private profile).
   - Linux (ufw): `sudo ufw allow 3000/tcp`
3. **Confirm from a phone** on the same Wi-Fi: open `http://SERVER_IP:3000`.
   You should see the login screen. If not, re-check the firewall and that the
   phone is on the same network (not guest Wi-Fi).
4. The app is mobile-friendly; storekeepers/mechanics can use it from phones.

## 3. Hardware to-do (flagged)

- **Put the server on a UPS.** SQLite can corrupt if power is cut mid-write. A
  UPS that allows a clean shutdown is the single most important hardware item.
- Backups mirror to `BACKUP_MIRROR_DIR` — point it at an external drive or a
  network share so a snapshot survives a disk failure.

## 4. Backups & restore

See `deploy/RUNBOOK.md`. Backups run automatically every
`BACKUP_INTERVAL_MINUTES`. **A restore has been tested** with
`npm run restore -- --verify --latest` (row counts matched). Never rely on a
backup you haven't restored.

## Guardrails

- Exactly **one** process opens the DB file. Never put the raw `.db` on a share
  for other apps to open directly — they reach it through this app's API only.
- Keep the old `inventory.db` / `oilbook.db` / Excel archived read-only forever.
