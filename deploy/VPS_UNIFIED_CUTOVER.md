# WorkshopOne Unified VPS Cutover Runbook (Zero Data Loss)

Target VPS: `20.204.51.43` (`storesdb.ec-workshops.online` + Fuel-System-V2 `:3300`)
New Unified Service: `/opt/workshopone-unified/` running on `127.0.0.1:3400`

> **Golden Rule:** Never upload a local `workshopone_merged.db` onto the live VPS and overwrite live production transactions.
> Instead, perform a **Side-by-Side Stage → Freeze → Snapshot Merge → Verify → Switch Traffic** cutover using `scripts/vps_cutover_merge.js`. Both original systems and their databases stay **read-only / intact** on disk so rollback takes under 60 seconds.

---

## Phase A — Stage Unified App & Live Rehearsal (Zero Downtime)

Run during normal hours while both old systems continue running normally:

```bash
# 1. Deploy unified code side-by-side in /opt/workshopone-unified (never overwrite /opt/workshopone or /var/www/fuelsystem)
sudo mkdir -p /opt/workshopone-unified/data /opt/workshopone-unified/backups /opt/workshopone-unified/uploads
sudo chown -R workshopone:workshopone /opt/workshopone-unified

# Clone / copy the unified 9632-Fuel-Merged codebase into /opt/workshopone-unified/app
sudo -u workshopone bash -c 'cd /opt/workshopone-unified/app && npm ci --omit=dev'

# 2. Write /opt/workshopone-unified/app/.env on a separate loopback port (3400)
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

# 3. Take SAFE online rehearsal snapshots without stopping either old service
rm -f /tmp/rehearsal_wo.db /tmp/rehearsal_fuel.db /tmp/rehearsal_merged.db
sqlite3 /opt/workshopone/data/workshopone.db ".backup /tmp/rehearsal_wo.db"
sqlite3 /var/www/fuelsystem/data/app.db ".backup /tmp/rehearsal_fuel.db"

# 4. Run rehearsal merge + full parity check against the /tmp copies
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

Confirm the rehearsal prints:
- `readyForCutover: true`
- `woRealMissingTotal: 0`, `fuelMissingTotal: 0`, `fuelValueMismatchTotal: 0`
- `Integrity check: ok`

*(Note: If the live VPS WorkshopOne uses split DBs `core.db` / `workshops/CW.db` / `MTR.db` instead of a single `workshopone.db`, replace `--wo-db` with `--core-db`, `--cw-db`, `--mtr-db`.)*

---

## Phase B — Cutover Window (~15–30 Minutes Off-Peak)

### 1. Broadcast 2-Minute Maintenance Notice
```bash
cd /opt/workshopone/app
sudo -u workshopone PORT=3000 node scripts/broadcast_maintenance.js 120 \
  "System upgrading to unified WorkshopOne + Fuel Suite in 2 minutes. Please save and finish your entry now."
```

### 2. Temporarily Shut Down Both Old Servers (Clean WAL Flush)
```bash
# Stop old WorkshopOne service
sudo systemctl stop workshopone

# Stop old Fuel-System-V2 service (isolated PM2 under fuelapp — NEVER run as root!)
sudo -u fuelapp PM2_HOME=/home/fuelapp/.pm2 /opt/node-24/bin/npx pm2 stop fuelsystem
```

### 3. Archive Frozen Pre-Cutover Backups (Keep Cold Copy on Disk)
```bash
CUTOVER_BAK="/opt/backups/pre-cutover-$(date +%Y%m%d-%H%M%S)"
sudo mkdir -p "$CUTOVER_BAK"
sqlite3 /opt/workshopone/data/workshopone.db ".backup $CUTOVER_BAK/workshopone.db"
sqlite3 /var/www/fuelsystem/data/app.db ".backup $CUTOVER_BAK/fuelsystem_app.db"
ls -la "$CUTOVER_BAK"
```

### 4. Execute Final Production Merge & Copy Attachments
```bash
cd /opt/workshopone-unified/app
sudo -u workshopone node scripts/vps_cutover_merge.js \
  --build-fresh \
  --wo-db /opt/workshopone/data/workshopone.db \
  --fuel-db /var/www/fuelsystem/data/app.db \
  --target-db /opt/workshopone-unified/data/workshopone_merged.db \
  --wo-uploads /opt/workshopone/uploads \
  --target-uploads /opt/workshopone-unified/uploads \
  --wo-outsourcing /opt/workshopone/data/outsourcing \
  --target-outsourcing /opt/workshopone-unified/data/outsourcing
```

### 5. Run Mandatory Parity Verification Before Going Live
```bash
sudo -u workshopone node scripts/vps_cutover_merge.js \
  --verify-only \
  --wo-db /opt/workshopone/data/workshopone.db \
  --fuel-db /var/www/fuelsystem/data/app.db \
  --target-db /opt/workshopone-unified/data/workshopone_merged.db
```
**Do NOT proceed unless exit code is `0` and `readyForCutover: true`.**

---

## Phase C — Bring Unified System Online & Redirect Old Domains

### 1. Start & Enable Unified Systemd Service
Copy `deploy/workshopone.service` to `/etc/systemd/system/workshopone-unified.service` with:
- `User=workshopone`
- `WorkingDirectory=/opt/workshopone-unified/app`
- `ExecStart=/usr/bin/node src/server.js` (ensure matching Node major version for `better-sqlite3`, or `/opt/node-24/bin/node` if compiled with Node 24)

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now workshopone-unified
curl -fsS http://127.0.0.1:3400/api/health
```

### 2. Switch Nginx Traffic & Redirect Fuel Users
1. In `/etc/nginx/sites-available/storesdb`, update `proxy_pass http://127.0.0.1:3000;` → `proxy_pass http://127.0.0.1:3400;`.
2. In your old Fuel Nginx server block (`location /`), replace `proxy_pass http://127.0.0.1:3300;` with a clean temporary redirect so bookmarks land directly inside the new Fuel Operations screen instead of `502 Bad Gateway`:
   ```nginx
   location / {
       return 302 https://storesdb.ec-workshops.online/#/fuel;
   }
   ```
3. Reload Nginx safely:
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

### 3. Prevent Old Servers Auto-Starting on Reboot (Keep Stopped & Cold Archived)
```bash
sudo systemctl disable workshopone
sudo systemctl stop pm2-fuelapp && sudo systemctl disable pm2-fuelapp
```
Leave `/opt/workshopone` and `/var/www/fuelsystem` untouched on disk for at least **30 days** before archiving offline.

---

## Phase D — 60-Second Emergency Rollback

If an unexpected issue occurs immediately after switching traffic:
```bash
sudo systemctl stop workshopone-unified
# Restore previous Nginx vhost configs (proxy_pass back to :3000/:1929 and :3300)
sudo nginx -t && sudo systemctl reload nginx

# Re-start both original services cleanly
sudo systemctl enable --now workshopone
sudo systemctl enable --now pm2-fuelapp || true
sudo -u fuelapp PM2_HOME=/home/fuelapp/.pm2 /opt/node-24/bin/npx pm2 start fuelsystem
```
