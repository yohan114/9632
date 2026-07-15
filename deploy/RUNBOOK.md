# WorkshopOne — Operator Runbook (Step 7)

A one-page guide for whoever runs the server day to day.

## The essentials

| Item | Value |
|---|---|
| App URL (share with the team) | `http://SERVER_IP:PORT` (e.g. `http://192.168.1.50:3000`) |
| Server PC | LOCATION / MACHINE_NAME |
| Process manager | pm2 (or systemd) |
| Backups folder | `backups/` (mirror: `BACKUP_MIRROR_DIR`) |
| Contact for problems | NAME / PHONE |

## Daily 2-minute health check

1. **Server up?** Open the app URL. If it doesn't load:
   `pm2 restart workshopone` (or `systemctl restart workshopone`).
2. **Backup ran?** Newest file in `backups/` is dated today/this hour:
   `ls -lt backups | head` — the top file should be recent.
3. **Anything stuck?** Log in → Dashboard → **"Awaiting Price (blocked)"**.
   Those job cards can't close until every line is priced — chase the prices.
4. **Resolver Queues empty?** Dashboard → Alias Queue. Link any pending
   vehicle or mechanic names so their costs land on the right asset/rate.

## Common tasks

**Add a user** (on the server):
```bash
npm run admin -- add-user jsmith 'TempPass1' storekeeper "J. Smith"
# roles: admin | storekeeper | transport_manager | operational_manager | workshop | manager | viewer
# the user is forced to set their own password at first login
```
Reset someone's password: `npm run admin -- set-password jsmith 'TempPass2'`
List users/roles: `npm run admin -- list`

**Check today's backup / take one now:** `npm run backup`

**Restart the server:** `pm2 restart workshopone` (logs: `pm2 logs workshopone`)

**Restore from a backup** (only if the DB is lost/corrupt):
```bash
# 1. see it will work (non-destructive):
npm run restore -- --verify --latest
# 2. stop the server, then replace the live DB:
pm2 stop workshopone
npm run restore -- --replace --yes --latest   # keeps a safety copy of the current DB
pm2 start workshopone
```

## Golden rules

- One server owns the database. Never open `data/workshopone.db` from another
  program or copy it onto a share for other apps.
- Keep the old systems (`inventory.db`, `oilbook.db`, the Excel files) archived
  read-only — never delete them.
- The server should be on a **UPS** — a power cut mid-write can corrupt the DB.
- Never trust a backup you haven't restored — the verify step above proves it.
