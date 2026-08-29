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
# no certbot — Cloudflare issues the origin certificate.
# sqlite3 is the command-line client, separate from the database itself: the app carries its own
# copy through better-sqlite3, but steps 6b and 9 check the data by hand and need this.
sudo apt install -y nginx git curl ufw sqlite3

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

**Write the file whole. Do not copy `.env.example` and add to it** — that is how this went wrong
once already. Paste this as a single block:

```bash
sudo -u workshopone tee /opt/workshopone/app/.env > /dev/null <<'EOF'
PORT=3000
HOST=127.0.0.1
NODE_ENV=production
PUBLIC_ORIGIN=https://storesdb.ec-workshops.online
DB_PATH=/opt/workshopone/data/workshopone.db
BACKUP_DIR=/opt/workshopone/backups
BACKUP_INTERVAL_MINUTES=30
BACKUP_RETENTION=96
EOF
```

Then check what the app **resolved**, not what you typed:

```bash
sudo -u workshopone node -e 'const c=require("/opt/workshopone/app/src/config");console.log(c.host, c.dbPath, c.backupDir)'
```

Must print exactly:

```
127.0.0.1 /opt/workshopone/data/workshopone.db /opt/workshopone/backups
```

> **Why a heredoc instead of `cp` + `nano`.** `.env.example` ships live values for `HOST`,
> `DB_PATH` and `BACKUP_DIR`. Append your own below them and you get each key twice — and this
> file is read top to bottom, so on the cut-over the *example's* values won. The app bound
> `0.0.0.0` and opened `./data/workshopone.db`: a brand-new empty database beside the code, while
> the 47 MB file carried across in step 6 sat unused. It started perfectly and rejected every
> correct password, because there were no accounts in it to match.
>
> The loader now takes the last setting of a key and warns about the duplicate, so that exact trap
> is closed — but writing the file whole means there is nothing to resolve in the first place.
> Note also that comments must be on their own line: `HOST=127.0.0.1 # note` used to put the note
> inside the value. Also fixed, and also avoided entirely by the block above.

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

The unit ships with two placeholders. Fill them in with `sed` rather than opening an editor — the
absolute source path matters, because you are standing in your own home directory and cannot `cd`
into the app:

```bash
sudo cp /opt/workshopone/app/deploy/workshopone.service /etc/systemd/system/workshopone.service && sudo sed -i 's|REPLACE_WITH_SERVICE_USER|workshopone|; s|REPLACE_WITH_APP_DIR|/opt/workshopone/app|' /etc/systemd/system/workshopone.service && grep -E '^(User|WorkingDirectory|Environment)=' /etc/systemd/system/workshopone.service
```

That must echo `User=workshopone` and `WorkingDirectory=/opt/workshopone/app`, with no
`REPLACE_WITH_` left. (With a *relative* `deploy/...` path the `cp` fails, the editor then opens an
empty buffer with no placeholders to fill in, and `systemctl enable` reports a unit that does not
exist — by which time the `cp` error has scrolled away.)

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now workshopone && systemctl status workshopone --no-pager
```

```bash
journalctl -u workshopone -n 20 --no-pager
```

The startup lines name the database and count the accounts in it. **You want `(9 user accounts)`.**
`0` means the wrong `DB_PATH` — a new empty database, and every password will be refused as
incorrect. Go back to step 5.

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
{ curl -sf https://www.cloudflare.com/ips-v4; echo; curl -sf https://www.cloudflare.com/ips-v6; echo; } | tr -d '\r' | grep -E '^[0-9a-fA-F.:]+/[0-9]{1,3}$' | sed 's|^|set_real_ip_from |; s|$|;|' | sudo tee /etc/nginx/cloudflare-real-ip.conf > /dev/null && echo 'real_ip_header CF-Connecting-IP;' | sudo tee -a /etc/nginx/cloudflare-real-ip.conf > /dev/null && grep -c set_real_ip_from /etc/nginx/cloudflare-real-ip.conf
```

That prints a count, currently about 22. **If it prints 0, stop.** nginx would start with an empty
list, every request would look like it came from Cloudflare, and the rate limiter would count the
whole internet as one caller — silently, with nothing else to tell you.

Three details in that line are load-bearing, and the middle one cost a failed `nginx -t`:

- the bare `echo` after each `curl` — **neither Cloudflare file ends in a newline**, so a plain
  `>>` append glues the last IPv4 range onto the first IPv6 one, giving
  `set_real_ip_from 131.0.72.0/222400:cb00::/32;` and
  `nginx: [emerg] host not found in set_real_ip_from`. The same collision silently swallows
  `2400:cb00::/32`, so even a config that *did* load would be missing a live Cloudflare range;
- `grep -E` for a CIDR shape — if a fetch fails you get an empty file rather than an HTML error
  page pasted into your nginx config;
- `curl -sf` rather than `-s`, so an HTTP error is a failure instead of a body to parse.

```bash
sudo cp /opt/workshopone/app/deploy/nginx-storesdb.conf /etc/nginx/sites-available/storesdb && sudo ln -sf /etc/nginx/sites-available/storesdb /etc/nginx/sites-enabled/storesdb && sudo rm -f /etc/nginx/sites-enabled/default
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Cloudflare adds ranges from time to time; re-run the generation line after a change, or monthly.

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
- [ ] The app sees the real visitor address, not a Cloudflare one. Sign in, then:

      sudo -u workshopone sqlite3 /opt/workshopone/data/workshopone.db "SELECT ip, created_at FROM sessions ORDER BY id DESC LIMIT 1;"

      It must show **your own public address** — `curl -s ifconfig.me` from the office PC to see
      what that is. A `104.x`, `172.6x.x` or `162.158.x` value means the real-IP block is not
      working and the rate limiter is counting every visitor on the internet as one person.
      The `sudo -u workshopone` matters: `/opt/workshopone` is the service account's home and your
      own login cannot read into it.
- [ ] Eight wrong passwords in a row are answered with "Try again in 15 minutes"
- [ ] Every person signs in once and sets their own password
- [ ] A backup file has appeared within the half-hour: `sudo -u workshopone ls -l /opt/workshopone/backups`

## When nobody can sign in

Start here, always:

```bash
sudo -u workshopone bash -c 'cd /opt/workshopone/app && node scripts/doctor.js'
```

It prints which database is open, how big it is, how many accounts are in it, the bind address and
the addresses of recent sign-ins. `0 user accounts` means the wrong `DB_PATH` — go back to step 5.

If the doctor is happy and the website still refuses everyone, **ask the app directly**, with no
browser, no Cloudflare and no nginx in the way:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3000/api/auth/login -H 'content-type: application/json' -d '{"username":"admin","password":"<the password you set>"}'
```

- `200` — the app is fine. **Then the website is not reaching this app.** See below.
- `401` — the app really is refusing: wrong password, or it is on a different database than the
  doctor examined (check `journalctl -u workshopone -n 20`, which prints the path the *service*
  opened rather than the one a separate command resolves).
- `429` — rate-limited by earlier failed attempts. That state is in memory:
  `sudo systemctl restart workshopone` clears it at once.

### `200` on the app but `401` through the website

Something other than this app is answering the domain. Compare the two directly — if the page
served publicly differs from the one the app serves, they are not the same program:

```bash
curl -s http://127.0.0.1:3000/app.js | grep -c 'Demo: admin/admin'      # the app on this machine
curl -sk https://storesdb.ec-workshops.online/app.js | grep -c 'Demo: admin/admin'   # what the world sees
```

Then find out who is really listening, and where nginx is sending traffic:

```bash
sudo ss -ltnp | grep -E 'nginx|node'
sudo grep -rn 'proxy_pass|server_name' /etc/nginx/sites-enabled/ /etc/nginx/conf.d/
sudo nginx -t
```

Two `node` processes means an earlier deployment is still running and holding the port that nginx
proxies to. Stop it, and make sure it cannot come back at boot (`systemctl list-units | grep -i
workshop`, and check for pm2: `pm2 list`).

**And check `nginx -t` even if you ran it before.** A failed `nginx -t` means the reload never
happened, so nginx is still serving the configuration it had in memory — including its old
`proxy_pass`. Deleting `sites-enabled/default` and adding the new site changes nothing until a
reload actually succeeds. This is easy to miss because every subsequent command looks like it
worked.

## Running it from here on

**The server is the system of record.** Since the cut-over, the workshop's real figures live in
`/opt/workshopone/data/workshopone.db` on the VPS. The copy on the office PC is a development
machine and nothing more — see "The office copy" below, because leaving it in use is the one thing
that can still ruin this quietly.

### Updating

```bash
sudo bash /opt/workshopone/app/deploy/update.sh
```

**The very first time, that file is not there yet** — it arrives in the update it is meant to
apply, and a script cannot pull itself into existence. Bootstrap once by hand, then never again:

```bash
sudo -u workshopone git -C /opt/workshopone/app pull && sudo -u workshopone bash -c 'cd /opt/workshopone/app && npm ci --omit=dev' && sudo systemctl restart workshopone
```

Backs up, fetches, installs, restarts, and then **checks that it worked** — the app answering, the
right database, accounts present, nginx up. If any check fails it puts the previous version back
and says so. Do not update by hand: `git pull && systemctl restart` has no backup and no verdict,
and a bad deploy is then discovered by a storekeeper rather than by you.

It refuses if someone has edited files directly on the server, rather than discarding their work.

### Day to day

| | |
|---|---|
| Logs | `journalctl -u workshopone -f` |
| Restart | `sudo systemctl restart workshopone` |
| Diagnose ("nobody can sign in") | `sudo -u workshopone bash -c 'cd /opt/workshopone/app && node scripts/doctor.js'` |
| Add people | `sudo -u workshopone bash -c 'cd /opt/workshopone/app && node scripts/create_staff.js --file staff.csv --apply'` |
| Reset one password | `sudo -u workshopone bash -c 'cd /opt/workshopone/app && node scripts/admin.js set-password <user> "<temporary>"'` |
| Backup now | `sudo -u workshopone bash -c 'cd /opt/workshopone/app && node scripts/backup.js'` |
| Backups | automatic every 30 min to `/opt/workshopone/backups`, 96 kept (two days) |

### Importing data, and any script that writes

Every script here is dry-run by default and needs `--apply`. Run them **on the server**, against the
server's database, and take a backup first — `update.sh` does that for you but a manual import does
not:

```bash
sudo -u workshopone bash -c 'cd /opt/workshopone/app && node scripts/backup.js && node scripts/<script>.js'      # dry run
sudo -u workshopone bash -c 'cd /opt/workshopone/app && node scripts/<script>.js --apply'
```

Spreadsheets to import go up with `scp` from the office PC — **run that on the PC, not in the ssh
session**:

```bash
scp "D:/path/to/file.xlsx" yohanudara@20.204.51.43:/tmp/
sudo mv /tmp/file.xlsx /opt/workshopone/app/sources/ && sudo chown workshopone:workshopone /opt/workshopone/app/sources/file.xlsx
```

### The office copy

`D:\Master system 1` still has its own database and its own backup scheduler. Nothing connects the
two, nothing syncs, and neither will ever complain — so anything entered there is invisible to the
workshop and will be lost.

Use it for development only, and start it on a port nobody has bookmarked:

```bash
PORT=1929 node src/server.js
```

If the office PC is ever to take live entry again, that is a cut-over — copy the server's database
down the same way step 6 copied it up — not something to drift into.

### Off-site backups

The automatic backups sit on the same machine as the database. That covers a mistake in the app; it
covers nothing about losing the server. Copy them somewhere else on a schedule — from the office PC,
for instance:

```bash
scp yohanudara@20.204.51.43:/opt/workshopone/backups/$(ssh yohanudara@20.204.51.43 'ls -t /opt/workshopone/backups | head -1') "D:/WorkshopOne-offsite/"
```

Worth doing now rather than later: this is the only copy of ten years of records.

**Those backups are on the same machine as the database.** That protects against a mistake in the
app; it does nothing about losing the server. Copy them somewhere else on a schedule — that is a
separate job, and worth doing before this holds the only copy of the workshop's records.
