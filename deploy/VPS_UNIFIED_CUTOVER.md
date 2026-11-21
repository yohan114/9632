# WorkshopOne Unified VPS Cutover Runbook (Zero Data Loss)

- **Target VPS:** `167.71.206.10` (`ubuntu-s-1vcpu-2gb-sgp1`, SSH `root@167.71.206.10`)
- **New Unified Domain:** `https://erp.edchristerp.com` (`/opt/workshopone-unified/app` on `127.0.0.1:3400`, systemd unit `workshopone-unified.service`)
- **Legacy Site 1 Redirect:** `https://storesdb.ec-workshops.online` → `302` to `https://erp.edchristerp.com$request_uri`
- **Legacy Site 2 Redirect:** `https://fuelsystem.ec-workshops.online` → `302` to `https://erp.edchristerp.com/#/fuel`
- **Sibling App Protected:** `https://hy.edchristerp.com` (`hydraulic-system`, `:9999` under `pm2-root.service`) remains untouched; cutover runs `pm2 stop fuelsystem && pm2 save` and **never** stops `pm2-root.service`.
- **Release Branch:** `claude/pensive-faraday-p5hklm`

> **Golden Rule:** Never upload a local `.db` file onto the live VPS and overwrite live production transactions.
> Perform a **Hostinger DNS + Let's Encrypt Prep → Side-by-Side Stage & Rehearsal → Freeze → Snapshot Merge → Verify → Switch Nginx** cutover using `deploy/vps-cutover.sh` and `scripts/vps_cutover_merge.js`. Both original systems (`workshopone` & `fuelsystem`) stay intact on disk so rollback takes under 60 seconds.

---

## Ready-to-Drop Deploy Files Included

| File | Purpose |
|---|---|
| `deploy/workshopone-unified.service` | Production systemd unit for `/opt/workshopone-unified/app` (`User=workshopone`, `ExecStart=/usr/bin/node src/server.js`; `HOST`/`PORT`/`DB_PATH`/`PUBLIC_ORIGIN` live in `.env`). |
| `deploy/nginx-erp-unified.conf` | Nginx config for `erp.edchristerp.com` proxying to `http://127.0.0.1:3400` (`listen 443 ssl http2;`, Let's Encrypt TLS by default, `25m` uploads, WebSocket sync, `:80` → HTTPS redirect). |
| `deploy/nginx-storesdb-redirect.conf` | Post-cutover `302` redirect for `storesdb.ec-workshops.online` → `https://erp.edchristerp.com$request_uri` (preserves `cloudflare-real-ip.conf` and `default_server`). |
| `deploy/nginx-fuelsystem-redirect.conf` | Post-cutover `302` redirect for `fuelsystem.ec-workshops.online` → `https://erp.edchristerp.com/#/fuel` (no `502 Bad Gateway` for old bookmarks). |
| `deploy/vps-cutover.sh` | Guarded helper automating `preflight`, `setup-ssl`, `rehearsal`, `cutover`, and `rollback` (auto-detects `/var/lib/fuel-system/app.db`, `/var/www/certbot`, root PM2 vs `fuelapp`, `mfa.key`, and Let's Encrypt/Cloudflare TLS certs). |

---

## Step 0 — Hostinger DNS + Free Let's Encrypt TLS (`erp.edchristerp.com`)

Because `edchristerp.com` uses **Hostinger DNS directly** (not Cloudflare Proxy), visitors connect straight to your VPS Nginx (`167.71.206.10`), so **use an auto-renewing Let's Encrypt certificate**:

1. In **Hostinger hPanel → Domains → `edchristerp.com` → DNS / Nameservers**:
   - Confirm **`A | erp | 167.71.206.10`** exists once (do **not** add duplicate `A | erp` records):
     ```bash
     nslookup erp.edchristerp.com
     ```
2. On `167.71.206.10` (after staging `/opt/workshopone-unified/app` in Step 1 below), issue the free auto-renewing Let's Encrypt certificate with **zero downtime** to `storesdb`, `fuelsystem`, or `hydraulic-system` (uses `/var/www/certbot` webroot):
   ```bash
   sudo bash /opt/workshopone-unified/app/deploy/vps-cutover.sh setup-ssl --email your-email@domain.com
   ```

---

## Turnkey Workflow (`deploy/vps-cutover.sh`)

### Step 1 — Stage Code Side-by-Side (Zero Downtime, Anytime)

*(Important: run `/usr/bin/npm ci --omit=dev` with `PATH=/usr/bin:/bin` so `better-sqlite3` compiles cleanly against `/usr/bin/node` v20 ABI rather than `/opt/node-24/bin/node`.)*

```bash
sudo mkdir -p /opt/workshopone-unified
sudo chown -R workshopone:workshopone /opt/workshopone-unified
if [ -d /opt/workshopone-unified/app/.git ]; then
  sudo -u workshopone git -C /opt/workshopone-unified/app fetch origin && \
  sudo -u workshopone git -C /opt/workshopone-unified/app checkout claude/pensive-faraday-p5hklm && \
  sudo -u workshopone git -C /opt/workshopone-unified/app pull --ff-only
else
  sudo -u workshopone git clone -b claude/pensive-faraday-p5hklm https://github.com/yohan114/9632.git /opt/workshopone-unified/app
fi
sudo -u workshopone env PATH=/usr/bin:/bin bash -c 'cd /opt/workshopone-unified/app && /usr/bin/npm ci --omit=dev'
```

### Step 2 — Phase A: SSL Setup, Live Preflight & Zero-Downtime Rehearsal

Run during normal business hours while `storesdb.ec-workshops.online`, `fuelsystem.ec-workshops.online`, and `hy.edchristerp.com` stay live:

```bash
sudo bash /opt/workshopone-unified/app/deploy/vps-cutover.sh preflight
sudo bash /opt/workshopone-unified/app/deploy/vps-cutover.sh setup-ssl --email your-email@domain.com
sudo bash /opt/workshopone-unified/app/deploy/vps-cutover.sh rehearsal --force-env
```

Confirm `rehearsal` prints:
- `readyForCutover: true`
- `woRealMissingTotal: 0`, `fuelMissingTotal: 0`, `fuelValueMismatchTotal: 0`
- `Integrity check: ok`

### Step 3 — Phases B–C: Off-Peak Cutover Window (~15 Minutes)

```bash
sudo bash /opt/workshopone-unified/app/deploy/vps-cutover.sh cutover --force-env
```

Type `CUTOVER` when prompted. The script will:
1. Verify `erp.edchristerp.com` TLS cert exists on disk BEFORE interrupting live services (fail fast with zero downtime if missing).
2. Broadcast a maintenance warning to live WorkshopOne users.
3. Cleanly stop `workshopone` and **only** PM2 app `fuelsystem` (`pm2 stop fuelsystem && pm2 save`, leaving `pm2-root.service` and `hydraulic-system` running untouched).
4. Archive frozen SQLite `.backup` copies (`/opt/workshopone/data/workshopone.db` + `/var/lib/fuel-system/app.db`), `mfa.key`, and old Nginx configs into `/opt/backups/pre-cutover-<timestamp>/`, and copy `mfa.key` into `/opt/workshopone-unified/data/mfa.key`.
5. Merge the frozen databases (`--build-fresh`) into `/opt/workshopone-unified/data/workshopone_merged.db` and sync uploads (`/opt/workshopone/app/uploads`) + CCOM PDFs.
6. Run `--verify-only` — **aborts before starting `workshopone-unified` or changing Nginx if parity fails**.
7. Install & start `workshopone-unified.service`, wait for `http://127.0.0.1:3400/api/health`, install `/etc/nginx/sites-available/erp` (`erp.edchristerp.com` → `:3400`), convert `storesdb` (preserving `default_server`) & `fuelsystem` to `302` redirects into `erp.edchristerp.com`, run `nginx -t` (auto-restoring backups if invalid), and reload Nginx.
8. Disable auto-start on `workshopone` while leaving `/opt/workshopone` and `/var/www/fuelsystem` cold on disk for at least **30 days**.

### Step 4 — Phase D: 60-Second Emergency Rollback (If Needed)

```bash
sudo bash /opt/workshopone-unified/app/deploy/vps-cutover.sh rollback
```

---

## Manual Command Reference

```bash
# Write /opt/workshopone-unified/app/.env for erp.edchristerp.com
sudo -u workshopone tee /opt/workshopone-unified/app/.env > /dev/null <<'EOF'
PORT=3400
HOST=127.0.0.1
NODE_ENV=production
PUBLIC_ORIGIN=https://erp.edchristerp.com
MULTIDB=0
DB_PATH=/opt/workshopone-unified/data/workshopone_merged.db
UPLOAD_DIR=/opt/workshopone-unified/uploads
BACKUP_DIR=/opt/workshopone-unified/backups
BACKUP_INTERVAL_MINUTES=30
BACKUP_RETENTION=96
EOF

# Stop ONLY fuelsystem cleanly (never pm2-root.service)
sudo systemctl stop workshopone
pm2 stop fuelsystem && pm2 save

# Merge live DBs after cold backup to $CUTOVER_BAK
sudo -u workshopone /usr/bin/node /opt/workshopone-unified/app/scripts/vps_cutover_merge.js \
  --build-fresh \
  --wo-db "$CUTOVER_BAK/workshopone.db" \
  --fuel-db "$CUTOVER_BAK/fuelsystem_app.db" \
  --target-db /opt/workshopone-unified/data/workshopone_merged.db \
  --wo-uploads /opt/workshopone/app/uploads \
  --target-uploads /opt/workshopone-unified/uploads
```
