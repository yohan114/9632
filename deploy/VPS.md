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

## 1. Cloudflare, and what it changes

`storesdb.ec-workshops.online` is proxied by Cloudflare (orange cloud), and that is the chosen
setup. It hides the server's address and absorbs traffic before it reaches you. It also means:

    visitor  --https-->  Cloudflare  --https-->  your nginx  --http-->  app on 127.0.0.1:3000

**Both encrypted hops matter.** In the dashboard set **SSL/TLS -> Overview -> Full (Strict)**.
Do NOT leave it on *Flexible*: that carries Cloudflare-to-origin as plain HTTP across the public
internet while showing the visitor a padlock, which is worse than no padlock because it looks safe.

There is no certbot in this path. Cloudflare issues the origin certificate instead:
**SSL/TLS -> Origin Server -> Create Certificate**, then on the server:

```bash
sudo mkdir -p /etc/ssl/cloudflare
sudo nano /etc/ssl/cloudflare/storesdb.pem     # paste the certificate
sudo nano /etc/ssl/cloudflare/storesdb.key     # paste the private key
sudo chmod 600 /etc/ssl/cloudflare/storesdb.key
```

Point the DNS record at the server, proxy left **on**:

```
A    storesdb    20.204.51.43    Proxied (orange cloud)
```

> Today the name answers with a redirect loop, which is what Cloudflare does when the origin
> behind it is not serving anything yet. That resolves itself once nginx is up at step 8.

## 2. Prepare the server

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx git curl ufw     # no certbot — Cloudflare issues the origin certificate

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

`/opt/workshopone` is the service account's home and your login cannot read into it — `cd` there
returns "Permission denied" for anyone but root. Rather than loosening the permissions, every
command below names the directory instead of relying on the working directory.

```bash
sudo -u workshopone git clone -b feature/spa-native-views https://github.com/yohan114/9632.git /opt/workshopone/app
sudo -u workshopone bash -c 'cd /opt/workshopone/app && npm ci --omit=dev'
```

Already cloned? `git clone` refuses a non-empty directory, which is what you want — it is telling
you the code is there. Update it in place instead:

```bash
sudo -u workshopone git -C /opt/workshopone/app pull
sudo -u workshopone bash -c 'cd /opt/workshopone/app && npm ci --omit=dev'
```

> **`npm audit` will report advisories, and npm will suggest `npm audit fix --force`. Do not run
> it.** It downgrades exceljs to 3.4.0, a major version backwards, and exceljs is required by
> `src/lib/export.js`, `src/lib/daily_reports.js`, `src/lib/monthly_cost_report.js` and
> migration 030. The remaining advisory (uuid, missing buffer bounds check in v3/v5/v6 when `buf`
> is supplied) is not on any path this app takes — exceljs uses v4 and passes no buffer.

## 5. Configuration

```bash
sudo -u workshopone cp /opt/workshopone/app/.env.example /opt/workshopone/app/.env
sudo -u workshopone nano /opt/workshopone/app/.env
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

### 6a. On the OFFICE PC — a Windows terminal, not the ssh session

The two commands below fail on the server: there is no `D:` drive there, and `scp`-ing from the
server to itself will sit asking for a password that will not work. Close or minimise the ssh
window if that helps keep them apart.

SQLite in WAL mode keeps recent writes in a side file, so copying `workshopone.db` by hand gives a
database missing its most recent work. Take a proper snapshot:

```bash
cd "D:/Master system 1" && node scripts/backup.js
```

Send the newest file from `backups/` (about 47 MB), signing in as **your own login** — root
password authentication is normally disabled, which is why `root@` is refused:

```bash
scp "D:/Master system 1/backups/workshopone-<newest>.db" yohanudara@20.204.51.43:/tmp/w1.db
```

### 6b. On the SERVER — back in the ssh session

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

Then check what it actually bound to, because a value set in the unit file beats `.env` — the loader
in `src/config.js` only fills in keys the environment does not already have:

```bash
sudo ss -ltnp | grep 3000
```

Must read `127.0.0.1:3000`. If it says `0.0.0.0:3000` the app is on the public interface beside
nginx and only the firewall is keeping it off the internet — look for a `HOST=` line in the unit
file and delete it, then `sudo systemctl daemon-reload && sudo systemctl restart workshopone`.

## 8. nginx

The visitor's real address has to survive the trip, or the login rate limiter will treat the whole
internet as one caller. nginx learns it from Cloudflare's `CF-Connecting-IP` header, but only
trusts that header from Cloudflare's own networks — so generate the list rather than typing it:

```bash
curl -s https://www.cloudflare.com/ips-v4 > /tmp/cf.txt
curl -s https://www.cloudflare.com/ips-v6 >> /tmp/cf.txt
sed 's|^|set_real_ip_from |; s|$|;|' /tmp/cf.txt | sudo tee /etc/nginx/cloudflare-real-ip.conf
echo 'real_ip_header CF-Connecting-IP;' | sudo tee -a /etc/nginx/cloudflare-real-ip.conf
cat /etc/nginx/cloudflare-real-ip.conf      # sanity-check it is a list of CIDRs, not an error page

sudo cp deploy/nginx-storesdb.conf /etc/nginx/sites-available/storesdb
sudo ln -s /etc/nginx/sites-available/storesdb /etc/nginx/sites-enabled/storesdb
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Cloudflare adds ranges from time to time; re-run the first command after a change, or monthly.

### Optional, and worth it: refuse anyone who bypasses Cloudflare

With the proxy on, the only legitimate traffic to port 443 comes from Cloudflare. Anyone who
discovers `20.204.51.43` can otherwise talk to the origin directly and skip everything Cloudflare
is there to do:

```bash
for ip in $(curl -s https://www.cloudflare.com/ips-v4) $(curl -s https://www.cloudflare.com/ips-v6); do
  sudo ufw allow from $ip to any port 443 proto tcp
done
sudo ufw delete allow 'Nginx Full'      # drop the open 80/443 rule from step 3
sudo ufw allow 80/tcp                   # leave 80 open only if you want the redirect to work
```

## 9. Before you hand out the address

- [ ] `https://` loads and the padlock is clean
- [ ] Signing in sets a cookie marked **Secure** (browser dev tools → Application → Cookies)
- [ ] `curl http://20.204.51.43:3000` from your own machine **times out**
- [ ] The app sees the real visitor address, not a Cloudflare one — sign in, then check the newest
      row: `sqlite3 /opt/workshopone/data/workshopone.db "SELECT ip FROM sessions ORDER BY id DESC LIMIT 1;"`
      If that shows a Cloudflare address, the real-IP block is not working and the rate limiter is
      counting every visitor as the same person
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
