# WorkshopOne Unified VPS Cutover Runbook (Zero Data Loss)

- **Target VPS:** `20.204.51.43` (SSH login: `yohanudara@20.204.51.43`)
- **Live Site 1 (WorkshopOne):** `https://storesdb.ec-workshops.online` (`workshopone` systemd unit)
- **Live Site 2 (Fuel-System-V2):** `https://fuelsystem.ec-workshops.online` (`fuelsystem` under PM2 user `fuelapp`, `PM2_HOME=/home/fuelapp/.pm2`, port `:3300`)
- **New Unified Service:** `/opt/workshopone-unified/app` listening on `127.0.0.1:3400` (`workshopone-unified.service`)
- **Release Branch:** `claude/pensive-faraday-p5hklm`

> **Golden Rule:** Never upload a local `.db` file onto the live VPS and overwrite live production transactions.
> Perform a **Side-by-Side Stage → Freeze → Snapshot Merge → Verify → Switch Traffic** cutover using `deploy/vps-cutover.sh` and `scripts/vps_cutover_merge.js`. Both original systems and their databases remain **read-only / intact** on disk so rollback takes under 60 seconds.

---

## Ready-to-Drop Deploy Files Included

| File | Purpose |
|---|---|
| `deploy/workshopone-unified.service` | Production systemd unit for `/opt/workshopone-unified/app` (`User=workshopone`, `ExecStart=/usr/bin/node src/server.js`; `HOST`/`PORT`/`DB_PATH` live in `.env`). |
| `deploy/nginx-storesdb-unified.conf` | Nginx config for `storesdb.ec-workshops.online` proxying to `http://127.0.0.1:3400` (`listen 443 ssl http2;`, Cloudflare real-ip, 25 MB uploads, WebSocket sync). |
| `deploy/nginx-fuelsystem-redirect.conf` | Clean `302` redirect for `fuelsystem.ec-workshops.online` → `https://storesdb.ec-workshops.online/#/fuel` (no `502 Bad Gateway` for old bookmarks). |
| `deploy/vps-cutover.sh` | Guarded helper automating `preflight`, `rehearsal`, `cutover`, and `rollback` (auto-detects single vs split WorkshopOne DBs + preserves existing Fuel TLS certs). |

---

## Turnkey Workflow (`deploy/vps-cutover.sh`)

### Step 1 — Stage Code Side-by-Side (Zero Downtime, Anytime)

```bash
sudo mkdir -p /opt/workshopone-unified
sudo chown -R workshopone:workshopone /opt/workshopone-unified
sudo -u workshopone git clone -b claude/pensive-faraday-p5hklm https://github.com/yohan114/9632.git /opt/workshopone-unified/app
sudo -u workshopone bash -c 'cd /opt/workshopone-unified/app && npm ci --omit=dev'
```

*(Already cloned? Pull updates cleanly:)*
```bash
sudo -u workshopone git -C /opt/workshopone-unified/app pull --ff-only
sudo -u workshopone bash -c 'cd /opt/workshopone-unified/app && npm ci --omit=dev'
```

### Step 2 — Phase A: Live Preflight & Zero-Downtime Rehearsal

Run during normal business hours while `storesdb.ec-workshops.online` and `fuelsystem.ec-workshops.online` keep running undisturbed:

```bash
sudo bash /opt/workshopone-unified/app/deploy/vps-cutover.sh preflight
sudo bash /opt/workshopone-unified/app/deploy/vps-cutover.sh rehearsal
```

Confirm the rehearsal prints:
- `readyForCutover: true`
- `woRealMissingTotal: 0`, `fuelMissingTotal: 0`, `fuelValueMismatchTotal: 0`
- `Integrity check: ok`

### Step 3 — Phases B–C: Off-Peak Cutover Window (~15 Minutes)

Run off-peak when ready to pause both legacy systems, snapshot the latest real-time transactions, verify 100% parity, start `workshopone-unified`, and switch Nginx:

```bash
sudo bash /opt/workshopone-unified/app/deploy/vps-cutover.sh cutover
```

Type `CUTOVER` when prompted. The script will:
1. Broadcast a 2-minute maintenance notice to live WorkshopOne users.
2. Cleanly stop `workshopone` and `PM2_HOME=/home/fuelapp/.pm2` `fuelsystem`.
3. Archive frozen SQLite `.backup` copies + old Nginx configs into `/opt/backups/pre-cutover-<timestamp>/`.
4. Merge the frozen databases (`--build-fresh`) into `/opt/workshopone-unified/data/workshopone_merged.db` and sync uploads + CCOM outsourcing PDFs (`/opt/workshopone-unified/app/data/outsourcing`).
5. Run `--verify-only` — **aborts automatically before touching systemd or Nginx if `readyForCutover` is not `true`**.
6. Install & start `workshopone-unified.service`, verify `http://127.0.0.1:3400/api/health`, update Nginx (`storesdb.ec-workshops.online` → `:3400`, `fuelsystem.ec-workshops.online` → `302` to `/#/fuel`), run `nginx -t` (auto-restoring backups if invalid), and reload Nginx.
7. Disable auto-start on the old units (`workshopone` & `pm2-fuelapp`) while keeping `/opt/workshopone` and `/var/www/fuelsystem` cold and untouched on disk for at least **30 days**.

### Step 4 — Phase D: 60-Second Emergency Rollback (If Needed)

```bash
sudo bash /opt/workshopone-unified/app/deploy/vps-cutover.sh rollback
```

---

## Manual Command Reference (Transparent Step-by-Step)

### Phase A — Manual Rehearsal Snapshot & Parity Check

```bash
sudo mkdir -p /opt/workshopone-unified/data /opt/workshopone-unified/backups /opt/workshopone-unified/uploads /opt/workshopone-unified/app/data/outsourcing
sudo chown -R workshopone:workshopone /opt/workshopone-unified

sudo -u workshopone tee /opt/workshopone-unified/app/.env > /dev/null <<'EOF'
PORT=3400
HOST=127.0.0.1
NODE_ENV=production
PUBLIC_ORIGIN=https://storesdb.ec-workshops.online
MULTIDB=0
DB_PATH=/opt/workshopone-unified/data/workshopone_merged.db
UPLOAD_DIR=/opt/workshopone-unified/uploads
BACKUP_DIR=/opt/workshopone-unified/backups
BACKUP_INTERVAL_MINUTES=30
BACKUP_RETENTION=96
EOF

rm -f /tmp/rehearsal_wo.db /tmp/rehearsal_fuel.db /tmp/rehearsal_merged.db
sqlite3 /opt/workshopone/data/workshopone.db ".backup /tmp/rehearsal_wo.db"
sqlite3 /var/www/fuelsystem/data/app.db ".backup /tmp/rehearsal_fuel.db"

cd /opt/workshopone-unified/app
node scripts/vps_cutover_merge.js \
  --build-fresh \
  --wo-db /tmp/rehearsal_wo.db \
  --fuel-db /tmp/rehearsal_fuel.db \
  --target-db /tmp/rehearsal_merged.db

node scripts/vps_cutover_merge.js \
  --verify-only \
  --wo-db /tmp/rehearsal_wo.db \
  --fuel-db /tmp/rehearsal_fuel.db \
  --target-db /tmp/rehearsal_merged.db
```

*(Note: If the live VPS WorkshopOne uses split DBs `core.db` / `workshops/CW.db` / `MTR.db`, pass `--core-db`, `--cw-db`, `--mtr-db` instead of `--wo-db`.)*

### Phases B–C — Manual Freeze, Merge, Start & Nginx Switch

```bash
# 1. Broadcast notice & stop both old servers cleanly
cd /opt/workshopone/app
sudo -u workshopone PORT=3000 node scripts/broadcast_maintenance.js 120 \
  "System upgrading to unified WorkshopOne + Fuel Suite in 2 minutes. Please save and finish your entry now."
sudo systemctl stop workshopone
sudo -u fuelapp PM2_HOME=/home/fuelapp/.pm2 /opt/node-24/bin/npx pm2 stop fuelsystem

# 2. Cold backup
CUTOVER_BAK="/opt/backups/pre-cutover-$(date +%Y%m%d-%H%M%S)"
sudo mkdir -p "$CUTOVER_BAK"
sqlite3 /opt/workshopone/data/workshopone.db ".backup $CUTOVER_BAK/workshopone.db"
sqlite3 /var/www/fuelsystem/data/app.db ".backup $CUTOVER_BAK/fuelsystem_app.db"

# 3. Merge + attachments + parity check
cd /opt/workshopone-unified/app
sudo -u workshopone node scripts/vps_cutover_merge.js \
  --build-fresh \
  --wo-db /opt/workshopone/data/workshopone.db \
  --fuel-db /var/www/fuelsystem/data/app.db \
  --target-db /opt/workshopone-unified/data/workshopone_merged.db \
  --wo-uploads /opt/workshopone/uploads \
  --target-uploads /opt/workshopone-unified/uploads \
  --wo-outsourcing /opt/workshopone/app/data/outsourcing \
  --target-outsourcing /opt/workshopone-unified/app/data/outsourcing

sudo -u workshopone node scripts/vps_cutover_merge.js \
  --verify-only \
  --wo-db /opt/workshopone/data/workshopone.db \
  --fuel-db /var/www/fuelsystem/data/app.db \
  --target-db /opt/workshopone-unified/data/workshopone_merged.db

# 4. Install unified systemd unit & switch Nginx
sudo cp /opt/workshopone-unified/app/deploy/workshopone-unified.service /etc/systemd/system/workshopone-unified.service
sudo systemctl daemon-reload && sudo systemctl enable --now workshopone-unified
curl -fsS http://127.0.0.1:3400/api/health

sudo cp /opt/workshopone-unified/app/deploy/nginx-storesdb-unified.conf /etc/nginx/sites-available/storesdb
sudo cp /opt/workshopone-unified/app/deploy/nginx-fuelsystem-redirect.conf /etc/nginx/sites-available/fuelsystem
sudo nginx -t && sudo systemctl reload nginx

sudo systemctl disable workshopone
sudo systemctl stop pm2-fuelapp && sudo systemctl disable pm2-fuelapp
```
