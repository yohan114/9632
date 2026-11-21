# WorkshopOne Unified VPS Cutover Runbook (Zero Data Loss)

- **Target VPS:** `20.204.51.43` (SSH login: `yohanudara@20.204.51.43`)
- **New Unified Domain:** `https://erp.edchristerp.com` (`/opt/workshopone-unified/app` on `127.0.0.1:3400`, systemd unit `workshopone-unified.service`)
- **Legacy Site 1 Redirect:** `https://storesdb.ec-workshops.online` → `302` to `https://erp.edchristerp.com$request_uri`
- **Legacy Site 2 Redirect:** `https://fuelsystem.ec-workshops.online` → `302` to `https://erp.edchristerp.com/#/fuel`
- **Release Branch:** `claude/pensive-faraday-p5hklm`

> **Golden Rule:** Never upload a local `.db` file onto the live VPS and overwrite live production transactions.
> Perform a **Hostinger DNS + Let's Encrypt Prep → Side-by-Side Stage & Rehearsal → Freeze → Snapshot Merge → Verify → Switch Nginx** cutover using `deploy/vps-cutover.sh` and `scripts/vps_cutover_merge.js`. Both original systems (`workshopone` & `fuelsystem`) stay intact on disk so rollback takes under 60 seconds.

---

## Ready-to-Drop Deploy Files Included

| File | Purpose |
|---|---|
| `deploy/workshopone-unified.service` | Production systemd unit for `/opt/workshopone-unified/app` (`User=workshopone`, `ExecStart=/usr/bin/node src/server.js`; `HOST`/`PORT`/`DB_PATH`/`PUBLIC_ORIGIN` live in `.env`). |
| `deploy/nginx-erp-unified.conf` | Nginx config for `erp.edchristerp.com` proxying to `http://127.0.0.1:3400` (`listen 443 ssl http2;`, Let's Encrypt TLS by default, `25m` uploads, WebSocket sync, `:80` → HTTPS redirect). |
| `deploy/nginx-storesdb-redirect.conf` | Post-cutover `302` redirect for `storesdb.ec-workshops.online` → `https://erp.edchristerp.com$request_uri` (preserves `cloudflare-real-ip.conf`). |
| `deploy/nginx-fuelsystem-redirect.conf` | Post-cutover `302` redirect for `fuelsystem.ec-workshops.online` → `https://erp.edchristerp.com/#/fuel` (no `502 Bad Gateway` for old bookmarks). |
| `deploy/vps-cutover.sh` | Guarded helper automating `preflight`, `setup-ssl`, `rehearsal`, `cutover`, and `rollback` (auto-detects Let's Encrypt/Cloudflare TLS certs, single vs split WorkshopOne DBs, and preserves legacy TLS certs on redirects). |

---

## Step 0 — Hostinger DNS + Free Let's Encrypt TLS (`erp.edchristerp.com`)

Because `edchristerp.com` uses **Hostinger DNS directly** (not Cloudflare Proxy), visitors connect directly to your VPS Nginx, so **use an auto-renewing Let's Encrypt certificate** (a Cloudflare Origin Certificate would fail browser trust without Cloudflare proxy!).

1. In **Hostinger hPanel → Domains → `edchristerp.com` → DNS / Nameservers**:
   - **Edit the existing `A` record for `erp`** (do **not** add a second duplicate `A | erp` record!) from its previous IP to **`20.204.51.43`** (TTL `1800` or `300`, once nothing live relies on the old IP).
   - Verify DNS propagation shows `20.204.51.43`:
     ```bash
     nslookup erp.edchristerp.com
     ```
2. On the VPS (after cloning `/opt/workshopone-unified/app` in Step 1 below), issue the free auto-renewing Let's Encrypt certificate with **zero downtime** to `storesdb` or `fuelsystem`:
   ```bash
   sudo bash /opt/workshopone-unified/app/deploy/vps-cutover.sh setup-ssl --email your-email@domain.com
   ```
   *(Optional future note: If you ever move `edchristerp.com` onto Cloudflare DNS + orange-cloud proxy, save a Cloudflare Origin Certificate to `/etc/ssl/cloudflare/erp.edchristerp.com.pem` & `.key` instead and switch Cloudflare SSL/TLS to Full Strict.)*

---

## Turnkey Workflow (`deploy/vps-cutover.sh`)

### Step 1 — Stage Code Side-by-Side (Zero Downtime, Anytime)

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
sudo -u workshopone bash -c 'cd /opt/workshopone-unified/app && npm ci --omit=dev'
```

### Step 2 — Phase A: SSL Setup, Live Preflight & Zero-Downtime Rehearsal

Run during normal business hours while `storesdb.ec-workshops.online` and `fuelsystem.ec-workshops.online` stay live:

```bash
sudo bash /opt/workshopone-unified/app/deploy/vps-cutover.sh setup-ssl --email your-email@domain.com
sudo bash /opt/workshopone-unified/app/deploy/vps-cutover.sh preflight
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
3. Cleanly stop `workshopone` and `PM2_HOME=/home/fuelapp/.pm2` `fuelsystem`.
4. Archive frozen SQLite `.backup` copies + old Nginx configs into `/opt/backups/pre-cutover-<timestamp>/`.
5. Merge the frozen databases (`--build-fresh`) into `/opt/workshopone-unified/data/workshopone_merged.db` and sync uploads + CCOM PDFs (`/opt/workshopone-unified/app/data/outsourcing`).
6. Run `--verify-only` — **aborts before starting `workshopone-unified` or changing Nginx if parity fails**.
7. Install & start `workshopone-unified.service`, wait for `http://127.0.0.1:3400/api/health`, install `/etc/nginx/sites-available/erp` (`erp.edchristerp.com` → `:3400`), convert `storesdb` & `fuelsystem` to `302` redirects into `erp.edchristerp.com`, run `nginx -t` (auto-restoring backups if invalid), and reload Nginx.
8. Disable auto-start on the old units (`workshopone` & `pm2-fuelapp`) while leaving `/opt/workshopone` and `/var/www/fuelsystem` cold on disk for at least **30 days**.

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

# Issue Let's Encrypt cert & install Nginx configs manually after merge & --verify-only pass
sudo certbot certonly --webroot -w /var/www/html -d erp.edchristerp.com
sudo cp /opt/workshopone-unified/app/deploy/nginx-erp-unified.conf /etc/nginx/sites-available/erp
sudo ln -sf /etc/nginx/sites-available/erp /etc/nginx/sites-enabled/erp
sudo cp /opt/workshopone-unified/app/deploy/nginx-storesdb-redirect.conf /etc/nginx/sites-available/storesdb
sudo cp /opt/workshopone-unified/app/deploy/nginx-fuelsystem-redirect.conf /etc/nginx/sites-available/fuelsystem
sudo nginx -t && sudo systemctl reload nginx
```
