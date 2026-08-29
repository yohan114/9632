# WorkshopOne on the VPS — storesdb.ec-workshops.online

The existing `DEPLOY.md` describes a mini-PC on the workshop LAN. This is the other case: one
server on the open internet, reached by name over HTTPS.

**What changes when it goes public.** On the LAN, to reach the login page you had to be standing in
the building. Behind a domain name, the login page is found by scanners within hours of the DNS
resolving. Three things follow, and all three are already done in the code:

- every seeded account had `password == username`, including `admin/admin` — **all rotated**;
- the login page now refuses a run of wrong guesses (`src/lib/ratelimit.js`);
- the live-update socket only accepts the site's own origin in production (`PUBLIC_ORIGIN`).

> `SESSION_SECRET` does **nothing** — session tokens are 32 random bytes stored server-side, not
> signed values. Older notes told you to change it before go-live; ignore that and spend the
> attention on the password rotation above, which was the real exposure.

---

## Server facts

| | |
|---|---|
| Host | `20.204.51.43` |
| Name | `storesdb.ec-workshops.online` |
| App listens on | `127.0.0.1:3000` — **not** the public interface |
| Public ports | 80 and 443 only, both nginx |

---

## 1. Point the name at the server

Before anything else, so the certificate can be issued:

```
A    storesdb    20.204.51.43
```

Check it from your own machine — a certificate request against a name that still points elsewhere
fails in a way that is tiresome to unpick:

```bash
nslookup storesdb.ec-workshops.online
```

## 2. Prepare the server

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx certbot python3-certbot-nginx git curl ufw

# Node 20+ — better-sqlite3 is compiled, so the build tools are not optional
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3

sudo adduser --system --group --home /opt/workshopone workshopone
```

## 3. The firewall — before the app is running, not after

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'      # 80 and 443
sudo ufw enable
sudo ufw status                  # 3000 must NOT appear
```

The app binds to `127.0.0.1` (step 5), so port 3000 is unreachable from outside even if the
firewall were wrong. Both, deliberately.

## 4. The code

```bash
sudo -u workshopone git clone https://github.com/yohan114/9632.git /opt/workshopone/app
cd /opt/workshopone/app
sudo -u workshopone git checkout feature/spa-native-views
sudo -u workshopone npm ci --omit=dev
```

## 5. Configuration

```bash
sudo -u workshopone cp .env.example .env
sudo -u workshopone nano .env
```

```ini
PORT=3000
HOST=127.0.0.1                                        # nginx reaches it; the internet does not
NODE_ENV=production
PUBLIC_ORIGIN=https://storesdb.ec-workshops.online     # pins the live-update socket
DB_PATH=/opt/workshopone/data/workshopone.db
BACKUP_DIR=/opt/workshopone/backups
BACKUP_INTERVAL_MINUTES=30
BACKUP_RETENTION=96
```

`HOST=127.0.0.1` is the important line. The LAN default of `0.0.0.0` would put the app itself on
the public internet beside nginx, bypassing TLS entirely.

## 6. Carry the data across

The workshop is not starting from nothing — ten years of history, the tyre catalogue, the corrected
balances and the accounts all live in the database on the office PC.

**On the office PC**, take a clean copy. SQLite in WAL mode keeps recent writes in a side file, so
copying `workshopone.db` alone gives a database missing its most recent work:

```bash
cd "D:/Master system 1"
node scripts/backup.js          # writes a consistent single file to backups/
```

Send the newest file from `backups/` to the server (about 44 MB):

```bash
scp backups/workshopone-<newest>.db root@20.204.51.43:/tmp/w1.db
```

**On the server:**

```bash
sudo mkdir -p /opt/workshopone/data /opt/workshopone/backups
sudo mv /tmp/w1.db /opt/workshopone/data/workshopone.db
sudo chown -R workshopone:workshopone /opt/workshopone

# prove it arrived whole before trusting it
sudo -u workshopone sqlite3 /opt/workshopone/data/workshopone.db "PRAGMA integrity_check; SELECT COUNT(*) FROM job_cards; SELECT COUNT(*) FROM tyre_battery_issues;"
```

Expect `ok`, and counts matching the office PC. Migrations run by themselves at first start and are
additive — nothing is dropped.

## 7. Run it

```bash
sudo cp deploy/workshopone.service /etc/systemd/system/
sudo nano /etc/systemd/system/workshopone.service     # User=workshopone, WorkingDirectory=/opt/workshopone/app
sudo systemctl daemon-reload
sudo systemctl enable --now workshopone
systemctl status workshopone
journalctl -u workshopone -f
```

## 8. nginx, then the certificate

```bash
sudo cp deploy/nginx-storesdb.conf /etc/nginx/sites-available/storesdb
sudo ln -s /etc/nginx/sites-available/storesdb /etc/nginx/sites-enabled/storesdb
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Check `http://storesdb.ec-workshops.online` loads. **Then** ask for the certificate:

```bash
sudo certbot --nginx -d storesdb.ec-workshops.online
sudo certbot renew --dry-run
```

## 9. Before you hand out the address

- [ ] `https://` loads and the padlock is clean
- [ ] Signing in sets a cookie marked **Secure** (browser dev tools → Application → Cookies)
- [ ] `curl http://20.204.51.43:3000` from your own machine **times out**
- [ ] Eight wrong passwords in a row are answered with "Try again in 15 minutes"
- [ ] Every person signs in once and sets their own password
- [ ] A backup file has appeared in `/opt/workshopone/backups` within the half-hour

## Afterwards

| | |
|---|---|
| Logs | `journalctl -u workshopone -f` |
| Restart | `sudo systemctl restart workshopone` |
| Update | `git pull && npm ci --omit=dev && sudo systemctl restart workshopone` |
| Backups | every 30 min to `/opt/workshopone/backups`, 96 kept (two days) |

**Those backups are on the same machine as the database.** That protects against a mistake in the
app; it does nothing about losing the server. Copy them somewhere else on a schedule — that is a
separate job, and worth doing before this holds the only copy of the workshop's records.
