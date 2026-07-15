# WorkshopOne — Cutover Plan (Step 5)

Goal: switch from the old Stores/Oil/Excel systems to WorkshopOne safely, with a
parallel-run window and a clean point where the new system becomes the single
system of record.

> Confirm the dates and the parallel-run length with the owner before starting.

## Prerequisites (must be true before cutover)

- Phases 1–3 built and the **initial migration has been run and verified**
  (row counts in-vs-out match; 20 assets spot-checked; a sample job's
  parts+oil+labour reconcile to its recorded total).
- `deploy/DEPLOY.md` done: server on a static IP, firewall open, reachable from
  a phone, running under pm2/systemd, on a UPS.
- Backups running + **a restore tested** (`npm run restore -- --verify --latest`).
- Real users created and seed passwords rotated (`scripts/admin.js`).
- Go-live acceptance passes (`npm run acceptance` — 8/8).

## Stage A — Parallel run (suggested 1–2 weeks)

- The team enters **new** activity (MRN/GRN/issues, oil ledger, job cards) into
  **WorkshopOne**.
- The old Stores/Oil/Excel stay **read-only reference** — no new writes.
- Daily: run the 2-minute health check (RUNBOOK) and confirm backups ran.
- Collect any data-mapping issues (unresolved vehicle/mechanic names show up in
  the **Resolver Queues** — clear them as they appear).

## Stage B — Cutover day (pick a date: **CUTOVER_DATE**)

1. **Freeze** the old systems fully (read-only, announce to the team).
2. **Final delta migration:** import anything entered into the old systems since
   the last migration run (same importers, same validation-target checks).
3. **Re-verify counts** in-vs-out; resolve any mismatch before proceeding.
4. Take a **named backup** (`npm run backup`) and label it "pre-go-live".
5. **Declare WorkshopOne the system of record.** All new work goes here only.

## Stage C — After go-live

- Keep the old `inventory.db` / `oilbook.db` / Excel files **archived read-only
  forever** as historical backup. **Never delete them.**
- Watch the "jobs awaiting price" list — it's the main thing that blocks job
  closure and month-end costs.
- Keep the Resolver Queues empty (link new vehicle/mechanic spellings promptly).

## Rollback (if something is seriously wrong on cutover day)

- Because the old systems were frozen read-only (not deleted), you can revert to
  them: un-freeze old systems, restore WorkshopOne's pre-go-live backup for
  later retry, and reschedule. No data is lost either way.
