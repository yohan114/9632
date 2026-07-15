# WorkshopOne — Central Workshop Master System

**Edward & Christie (Pvt) Ltd — Central Work Shop, Badalgama**

A single master system that unifies the three previously-disconnected systems
(Stores/Inventory, Oil & Lubricant Stock Book, and Job Cards) so that **every
part, litre, battery and labour hour rolls up to the asset and the job card**.

> **The core insight:** the **ASSET** is the master key, the **JOB CARD** is the
> hub, and everything rolls up to **COST**. Every part, litre, battery, transfer,
> labour-hour and external repair points at *one canonical asset* and (for repair
> work) *one job card*, which automatically sums labour + material + oil + general
> + external into a single, gated total.

---

## Quick start

```bash
npm install          # installs deps (better-sqlite3, express, exceljs, bcryptjs)
npm run reset        # create the SQLite DB, apply schema, seed demo data
npm start            # http://localhost:3000
```

Then open http://localhost:3000 and sign in. Demo accounts (username = password):

| Login | Roles |
|---|---|
| `admin` / `admin` | Administrator (everything) |
| `store` / `store` | Storekeeper |
| `transport` / `transport` | Transport Manager (raise + first approval) |
| `ops` / `ops` | Operational Manager (second approval) + Manager |
| `mech` / `mech` | Workshop / Mechanic Supervisor |
| `viewer` / `viewer` | Read-only |

```bash
npm test             # run the automated test suite (node --test)
npm run migrate      # apply schema only (idempotent)
npm run migrate -- --reset   # drop and recreate the DB file
npm run seed         # seed demo data (skips if already seeded; --force to override)
npm run dev          # start with --watch for development
```

Configuration is via `.env` (see `.env.example`) — port, DB path, session
lifetime, upload/backup dirs, and the forecasting windows (90-day window,
14-day low-stock threshold, matching the existing Oil & Lubricant settings).

## Deployment & operations (Phase 4)

Runs as one always-on Node process on a single PC that owns the SQLite file;
other PCs/phones use it via browser over the LAN. Full guides in `deploy/`:

- **`deploy/DEPLOY.md`** — server packaging (pm2 `ecosystem.config.js` /
  systemd `deploy/workshopone.service`), binding `0.0.0.0`, static IP + firewall
  for LAN access, and the UPS note.
- **`deploy/CUTOVER.md`** — parallel-run then switch-over plan; old systems kept
  archived read-only.
- **`deploy/RUNBOOK.md`** — operator one-pager: URL, add a user, daily 2-min
  health check, restart, restore.

Operational scripts:

```bash
npm run backup                          # take a DB snapshot now
npm run restore -- --verify --latest    # prove a restore works (non-destructive)
npm run restore -- --replace --yes --latest   # restore into the live DB (stop server first)
npm run admin -- create-admin boss 'TempPass1'   # real admin (forced pw change on first login)
npm run admin -- rotate-seed            # force pw change on all demo accounts before go-live
npm run acceptance                      # run the go-live acceptance checklist (8 checks)
```

Backups run automatically every `BACKUP_INTERVAL_MINUTES` (default 30) with
retention and an optional second-location mirror; a restore is verifiable with
one command. New/created users are forced to change their password on first
login (enforced server-side).

---

## Architecture

```
              ┌───────────────────────────┐
              │  FLEET / ASSET REGISTRY    │  ← the master (canonical id + alias resolver)
              └─────────────┬─────────────┘
   ┌───────────┬────────────┼────────────┬───────────┐
   ▼           ▼            ▼            ▼           ▼
 STORES      OIL &       BATTERY      PROJECTS    USERS &
 (MRN→GRN→   LUBRICANT   LIFECYCLE    & SITES     ROLES
  Issue→MTN) (ledger,    (merged)
             count,
             forecast)
   └───────────┴────────────┼────────────┘
                            ▼
                 ┌────────────────────┐
                 │  JOB CARD (the hub)│  request → approve×2 → workshop →
                 │  + state machine   │  daily work → parts → CLOSE (gated)
                 └─────────┬──────────┘
                           ▼
                 ┌────────────────────┐
                 │   COSTING ENGINE   │  labour+material+oil+general+external
                 └─────────┬──────────┘
                           ▼
                 ┌────────────────────┐
                 │ ANALYTICS & EXPORTS│  cost/asset, cost/project, forecast, radar
                 └────────────────────┘
```

**Layout**

```
src/
  config.js            env-driven config (zero-dependency .env loader)
  server.js            Express app: wiring, static SPA, backups
  db/
    schema.sql         the one unified schema (PostgreSQL-portable)
    index.js           better-sqlite3 connection + helpers (get/all/run/tx)
    migrate.js         `npm run migrate`
    seed.js            demo data grounded in the real codes from the brief
  lib/
    aliases.js         the learning alias resolver (the glue)
    auth.js            password hashing, DB-backed sessions, role guards
    jobstate.js        the job-card state machine
    costing.js         the costing engine + the closure gate
    audit.js           full audit trail
    backup.js          automatic timestamped DB snapshots with retention
    export.js          Excel export (ExcelJS)
    http.js            asyncHandler, validation, error handler
  routes/              one Express Router per module (auth, assets, aliases,
                       projects, stores, oil, batteries, jobcards, users, reports)
public/                the SPA (index.html, styles.css, app.js) — no build step
test/                  node:test unit + HTTP end-to-end tests
```

---

## The two things that make it a *master* system

### 1. The learning alias resolver (`src/lib/aliases.js`)

The same physical vehicle used to be tracked three different ways with no
shared identity. Every module now resolves any raw vehicle string through one
resolver:

1. exact match on `code_norm` (uppercase, symbols stripped: `28-4314` → `284314`),
2. a previously-resolved alias, or an extracted code token (`28-4314 Double Cab`),
3. otherwise it **queues a pending alias** for a human to link — never lost.

Every resolved link bumps `hit_count`, so common variants auto-resolve next
time. Unresolved names surface in the **Alias Queue** screen. This is the single
piece of glue that lets the three datasets finally join.

### 2. The job-card lifecycle with a hard closure gate

`REQUESTED → APPROVED_TRANSPORT → APPROVED_OPERATIONS → IN_WORKSHOP → IN_PROGRESS
→ WORK_COMPLETE → CLOSED` (with `REJECTED`). Implemented as an explicit state
machine (`src/lib/jobstate.js`): a card only moves forward when the step's
role + state conditions are met.

**A job closes only when every consumed line is fully documented and priced:**
every requested part has a GRN, every GRN/oil/general line has a price, every
labour line has a rate, and external values are entered. If anything is unpriced
the close is rejected with `409` and the card lists exactly what's missing. On
close, a **frozen cost snapshot** is written so historical job costs never shift
when prices change later. Reopening a closed card is admin-only and audited.

---

## The costing engine (`src/lib/costing.js`)

```
labour_cost   = Σ (daily_work.hours × labour_rate(mechanic, on the work date))
material_cost = Σ (job_parts grn/issue: qty × unit_price)
oil_cost      = Σ (oil-ledger issues to this job: qty × price on the txn date)
general_cost  = Σ (general items issued to this job: qty × price)
external_cost = Σ (daily_work external value) + Σ (job_parts marked external repair)
TOTAL_COST    = labour + material + oil + general + external
```

Prices use the value **effective on the transaction date** (full price history
in `product_prices` and `labour_rates.effective_from`), never today's price.
Each source table contributes to exactly one bucket, so there is no double
counting. Reporting splits by **purchase source** (Local Purchase / Head Office /
Local Store) and by **project**.

---

## Roles & permissions

| Role | Can do |
|---|---|
| Admin | Everything; reopen closed jobs (audited); manage users, prices, aliases |
| Storekeeper | MRN/GRN/Issue/MTN, oil ledger, counts, batteries, general items, link aliases |
| Transport Manager | Raise job cards; first approval |
| Operational Manager | Second approval; view all costs |
| Workshop / Mechanic supervisor | Assign jobs, log daily work, request parts, mark complete |
| Viewer | Read-only dashboards & reports |

A user can hold several roles; every state transition records the acting user.
The server enforces roles on every mutation; the UI hides controls the user
can't use.

---

## Reports & exports

Home dashboard (open jobs by status, jobs awaiting price, low-stock lubricants,
battery warranty radar, this-month cost by project); Asset 360 (unified timeline
+ lifetime cost + current battery + service-due); Project cost roll-ups;
Oil forecast (days-of-cover + reorder suggestions); cost per asset / project /
purchase source; stock variance flags. Every report exports to **Excel**
(`.xlsx`), and each job card has a one-click **printable cost sheet**
(`/api/reports/job/:id/costsheet.html` → print to PDF).

---

## Tech stack

- **Backend:** Node.js + Express, single consolidated service.
- **Database:** SQLite (single file, easy backup — matches the current setup).
  The schema uses only standard SQL types and app-side normalisation, so it
  **ports cleanly to PostgreSQL** when concurrent multi-writer access is needed.
- **Frontend:** a dependency-free vanilla-JS SPA (mobile-friendly, works on
  shop-floor PCs and phones; light/dark aware).
- **Auth:** username/password (bcrypt) + DB-backed sessions + role checks.
- **Backups:** automatic timestamped SQLite snapshots with retention.
- **Exports:** ExcelJS for `.xlsx`; printable HTML for PDF.

---

## What's built vs. deferred

This delivery implements the **architectural heart end-to-end** — roughly the
brief's Phases 1–3 plus much of Phase 4:

**Built**
- Consolidated DB + the full unified schema (all §4 entities).
- Asset registry + the learning alias resolver + Asset 360 with unified timeline.
- Users / roles / DB-backed sessions / full audit log.
- Stores (MRN → GRN → Issue → MTN, general-item running-balance ledger, reorder
  alerts, continuing document numbering ~167xxx / ~57xxx, purchase-source field,
  late pricing).
- Oil & Lubricant (running-balance ledger, monthly stock count + variance, price
  history, forecasting with days-of-cover and reorder suggestions).
- Battery lifecycle (the two old systems merged into one; whereis-serial,
  warranty radar, full event history).
- Job cards: entity + explicit state machine + two-step approval + daily work +
  labour costing + the parts/oil bridge + the closure gate + frozen snapshots.
- Costing engine with price-on-date and by-source / by-project splits.
- Dashboards, cost reports, Excel exports, printable job cost sheet.
- Automated tests (unit + HTTP end-to-end) and automatic DB backups.

**Deferred / next steps**
- **Actual data migration:** the brief references real source files
  (`inventory.db`, `oilbook.db`, `Job_Record.xlsx`, `Daily_Work_Done_updated.xlsx`).
  Those files are **not present in this repository**, so the system is seeded
  with representative data drawn from the real codes in the brief. The migration
  entry points are ready: `aliases.findOrCreateAsset` / `resolveAsset` union and
  de-duplicate codes, and each module's `POST` accepts the source shapes. Point
  an ETL script at the real `.db`/`.xlsx` files following the §12 order and the
  ~12,000 records flow in.
- Photo upload UI (the schema + `/uploads` static serving + `photo_path` fields
  are in place; the multipart upload endpoint is the remaining piece).
- **PostgreSQL migration** — deliberately not done. The schema is designed to
  port (money `REAL` → `numeric` is the one correctness upgrade to make then),
  but on a single-server LAN with a handful of writers SQLite is the right choice;
  migrate only when concurrency actually strains it (see Phase 5 §5).

## Advisory intelligence (Phase 5)

A read-only **Needs Attention** screen (and dashboard panel) that flags — never
auto-corrects — via `src/lib/intelligence.js`:

- **Global service-due list** — fleet-wide machines due/overdue from
  `service_specs` + running hours, with the expected service cost.
- **Unusual consumption** — each asset×lubricant's recent rate vs **that asset's
  own** history (not a fleet average); flagged above a configurable factor.
- **Duplicate MRN** — repeated MRN numbers and likely double-entries
  (same asset + item + qty + date).
- **GRN price spike** — a unit price beyond a factor of the item's recent average.
- **Integrity check** — orphaned references, ledger balances that don't
  reconcile, and jobs closed without a cost snapshot.

Thresholds (`ANOMALY_CONSUMPTION_FACTOR`, `ANOMALY_PRICE_SPIKE_FACTOR`) are
business calls set in `.env`.

### Assumptions made (per the brief's "ask before assuming" guardrail)

Because this was built from the brief without a live Q&A, the following
reasonable assumptions were made and should be confirmed with the owner:

1. **Job numbering** `YYYY/M/R/seq` — `seq` continues per (year, month, type).
   Historical numbers are preserved verbatim on import.
2. **Currency** is shown as `Rs` (LKR). No tax handling is included (none was
   specified).
3. **Battery↔MTN link:** a battery transfer records an `mtn_ref` string but does
   not auto-create a Stores MTN document (kept as a manual, explicit step to
   avoid duplicate numbering). Can be automated on request.
4. **PDF export** is delivered as a print-optimised HTML cost sheet (print → PDF)
   rather than a server-generated PDF binary, to keep the dependency surface
   small.
5. **Approval overrides / reopen:** only `admin` can reopen a `CLOSED` job, and
   every such action is audited.
