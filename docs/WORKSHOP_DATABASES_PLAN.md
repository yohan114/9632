# Plan — every workshop on its own database

_Status: plan only. Nothing is built. Supersedes `docs/SITE_WORKSHOPS_PLAN.md`, which kept one
shared database; its read-only "view other workshops" idea is carried into §7.4 here._

---

## 0. In one page

**What you asked for.** Creating a sub-workshop automatically creates a **separate database** for
it, and all of that workshop's data lives there. Access to the **main store** is given to a workshop
from the **admin section**, one workshop at a time. Secure, accurate, and complete.

**What I recommend.** Build it — it fits what you want, and done this way it is genuinely safer than
what you have now. But it is the largest change the system has had, so it goes in **phases, each one
shippable**, and the live data is split only after the method has been proved on a copy.

**Why it is safer, not just separate.** Today a site sees only its own work because every screen
remembers to add "this workshop only" to its query. Forget it once and a site reads another site's
data. With a database per workshop, a site's request is given **a connection to its own file and
nothing else** — the other workshops' data is not in the connection at all, so there is nothing to
forget. That is isolation by construction, not by care.

**What it costs, measured on this codebase** (§1 has the evidence):

| | |
|---|---|
| Tables | 105 → **36 shared** (one core file) + **69 per workshop** (one file each). All 105 classified, none left over. |
| Database-enforced links lost | **109** foreign keys would cross from a workshop file into the core file. 25 become in-file checks; **84 must be checked by the app** and verified nightly. |
| Code that must change | **118 writes** to shared tables, in 31 files, plus the head-office lists and company reports that read across every workshop (§7.5). **Most of the other ~2,000 queries need no change** — proved below. |
| Things that stop being one transaction | Anything touching two workshops: transfers between stores, drawing from the main store, the one-open-card-per-vehicle rule. Each needs its own careful mechanism (§7). |
| Preconditions | Node **22 or newer** on the server, for the encrypting database driver. |

---

## 1. The evidence

Every claim in this plan was checked against this codebase or tested on this machine.

| Checked | Result |
|---|---|
| Can existing SQL keep working across two files? | **Yes.** Opening a workshop's file and attaching the core file, an unchanged `SELECT … FROM job_cards j LEFT JOIN assets a …` returned the right rows — the job card from the workshop file, the vehicle from core. SQLite finds an unqualified table in whichever file has it. This is what keeps most queries untouched; a query that should see *every* workshop's rows (a company report) now sees one, and is reworked (§7.5). |
| Can a site connection be stopped from writing shared data? | **Yes.** Per-connection temporary triggers on a core table refused `INSERT`, `UPDATE` and `DELETE` through the site connection — qualified or not — while the core's own connection wrote the same table normally. The design installs the same guard on all 36 shared tables; §12 tests every one. |
| …and the limit of that | The guard can be dropped by raw SQL on that same connection. So it stops **mistakes in our code**, not code that sets out to bypass it — site code must never be handed a raw SQL executor (§9.2 makes that a test). |
| Can "view another workshop, never change it" be enforced below the app? | **Yes.** A connection opened read-only refused a `DELETE` with `SQLITE_READONLY`, from the driver itself. |
| Does per-workshop encryption hold? | **Yes**, with `better-sqlite3-multiple-ciphers` (v13): no key → `SQLITE_NOTADB`; wrong key → `SQLITE_NOTADB`; and the job number written into the file did not appear in the raw file or its write-ahead log. Two files, two different keys, joined in one query. |
| Can core be attached read-only by URI instead? | **No** — `file:…?mode=ro` fails with `SQLITE_CANTOPEN` on both drivers here. That is why the guard is the triggers above. |
| How many files can one connection attach? | **10** (`MAX_ATTACHED=10`). So reports across every workshop open separate connections and merge, rather than attaching them all (§7.5). |
| Is a commit across two files atomic? | **Not as a set.** The system runs SQLite in WAL mode, where each file commits atomically but two files together do not. This is the reason for §7's mechanisms. |
| Encryption driver requirement | `engines: node >=22`. The server's Node version must be checked first. |

---

## 2. Three ways to build it

| | **A. A SQLite file per workshop** *(recommended)* | **B. PostgreSQL, a schema per workshop** | **C. One SQLite file, hardened** |
|---|---|---|---|
| A workshop's data is kept apart by… | its own file; a site connection holds no other workshop's data | database roles and grants, enforced by the database server outside the app | a `workshop_id` filter on every query |
| A forgotten filter… | cannot leak — the data is not in the connection | cannot leak | **leaks** |
| Links between a workshop's records and shared ones | checked by the app, verified nightly (84) | real foreign keys | real foreign keys |
| Transfer between two workshops | a two-step, self-repairing process (§7.2) | one real transaction | one real transaction |
| Encryption at rest | a key per workshop | per column, or the disk | one key for everything |
| Back up / restore / archive one workshop alone | **yes** | yes | no |
| Size of the change | the data layer, 118 writes, and the new mechanisms; ~2,000 queries unchanged | **every database call becomes asynchronous** and SQL dialect changes throughout — close to rewriting the data layer and every route | smallest — the previous plan |
| Runs on the current 2 GB server | yes | yes, plus a database server to look after | yes |

**Recommendation: A.** It is what you asked for, it removes the whole class of "forgot to filter"
mistakes, it gives each workshop its own key, backup and archive, and it keeps the system's
synchronous design, so most of the code is untouched. **B** is the stronger design in the long run —
isolation enforced by a separate database server, real foreign keys, real transactions — and is the
right move if the company grows to many sites with many people working at once. It is a separate,
larger project; nothing in A blocks moving to B later.

---

## 3. The layout on disk

```
/opt/workshopone/data/
  core.db                     the shared registry: people, access, vehicles, the catalogue (36 tables)
  workshops/
    CW.db                     Central Workshop — everything recorded until now moves here
    MTR.db                    Muthur Workshop — created empty when the workshop is added
    …                         one file per workshop
  keys/
    master.key                the key that unlocks every other key (§9.1) — never backed up with the data
  archive/                    retired workshops' files, read-only
```

**Why Central gets its own file too, rather than staying where it is.** Leaving Central's records in
the same file as the shared tables would mean every site connection attaches that file — and could
*read* Central's requests, stock and purchasing through it. The write guard does not stop reads. So
the shared tables go in a file of their own, and Central becomes a workshop like any other. This is
the one change to existing data, and §11 Phase 2 is entirely about doing it safely.

---

## 4. What lives where

**Core (shared, one file) — 36 tables.** Things that mean the same thing at every workshop.

| Group | Tables |
|---|---|
| People and access | users, roles, user_roles, role_capabilities, role_permissions, user_capabilities, user_permissions, sessions, auth_challenges, mfa_recovery_codes, user_seen_marks, approval_limits |
| Organisation | workshops, projects, sites, settings *(company-wide settings only)* |
| Vehicles — they move between workshops | assets, asset_aliases, asset_moves, vehicle_lubricant_capacities, service_specs, tb_specs |
| Catalogue and price lists — an item is the same item everywhere | store_items, item_categories, stock_items, products, product_prices, oil_list, oil_type_prices, lubricant_aliases, filter_catalogue, filter_category_list, filter_xrefs, filter_prices, tyre_battery_prices |
| Company audit | audit_log *(actions on shared data and between workshops)* |

**Each workshop (one file each) — 69 tables.** Everything that is the workshop's own.

| Group | Tables |
|---|---|
| Job cards and requests | job_cards, job_approvals, job_costs, job_daily_work, job_hold_reasons, job_labour, job_parts, job_reopen_requests, job_reopens, job_requests, job_request_approvals, job_summary_notes, job_workshop_moves, historical_job_costs, pending_part_notes |
| Mechanics, labour, attendance | mechanics, mechanic_aliases, mechanic_workshops, labour_rates, mechanic_attendance, workday_signoffs |
| Stores documents | mrn, mrn_lines, mrn_approvals, mrn_line_invoices, mrn_line_priority_history, grn, grn_approvals, grn_vouchers, issues, issue_returns, min_notes, min_approvals, mtn, mtn_lines, mtn_approvals, receipt_price_notes |
| Stock, counts, disposal | stock_moves, stock_ledger, stock_opening, stock_counts, store_counts, store_reorder, count_sessions, count_lines, general_item_txns, disposals, disposal_lines, filter_stock |
| Tyres and batteries | batteries, battery_events, battery_photos, tyres, tyre_events, tyre_photos, tyre_battery_issues, tb_request_lines, tb_returns |
| Service records | service_jobs, service_attachments, service_filters, service_oils, service_parts |
| Tools and toolboxes | workshop_tools, tool_issue_logs, tool_scrap_requests |
| Reports kept per workshop | daily_report_snapshots, monthly_report_inputs, vehicle_monthly_costs |

**New tables this design adds.**

| Where | Table | Holds |
|---|---|---|
| core | `workshop_databases` | each workshop's file, schema version, key reference, state (provisioning / live / archived), created and verified dates |
| core | `workshop_keys` | each workshop's data key, **wrapped** by the master key (§9.1) |
| core | `store_access_grants` | which workshop may use which store, how, how much, until when (§6) |
| core | `store_access_usage` | every draw made under a grant, against its limits |
| core | `vehicle_holds` | the one open job card each vehicle has, at whichever workshop (§7.1) |
| core | `transfers` | every movement between two workshops and the step it has reached (§7.2) |
| core | `integrity_runs` | the nightly verifier's results (§8.2) |
| each workshop | `ws_meta` | which workshop this file belongs to, written once at birth |
| each workshop | `audit_log` | the workshop's own trail, hash-chained (§9.3) |
| each workshop | `settings` | the workshop's own switches (attendance, partial close, …) |

---

## 5. Creating a sub-workshop — fully automatic

**Admin → Workshops → + Add workshop** becomes one guided form and one server-side operation that
either completes entirely or leaves nothing behind.

**The form asks:**

1. **Code, name, place** — as now.
2. **Who runs it** — the people to move to it now (more can be added later).
3. **Its store** — opening date (today by default). A new workshop always has its own store; drawing
   from the main store is a separate, explicit grant (§6), not a default.
4. **Main store access** — optional: create a grant now (§6), pending approval.
5. **Job card numbering** — its prefix, e.g. `MTR` → `MTR/2026/10/R/1` (decision D3).

**What the server does, in order:**

| Step | Action | If it fails |
|---|---|---|
| 1 | Reserve the code in `workshop_databases` as **provisioning** | nothing to undo |
| 2 | Generate a fresh 256-bit data key; store it **wrapped** in `workshop_keys` | delete the reservation |
| 3 | Create `workshops/<CODE>.db`, encrypted with that key, permissions `600` | delete key and reservation |
| 4 | Apply the workshop schema; record its schema version | delete the file, key and reservation |
| 5 | Write `ws_meta` — this file belongs to workshop N — and install the in-file guards (§8.1) | as above |
| 6 | Open the store from the chosen date; write the first, empty audit entry (the chain's root) | as above |
| 7 | Move the chosen people to it; create any main-store grant as **pending** | as above |
| 8 | Run the verifier on the new file (§8.2): opens with its key, schema current, guards present, empty | as above |
| 9 | Mark the workshop **live**; record all of it in the company audit | — |

A half-made workshop cannot exist: until step 9 nobody can be sent to it, and if any step fails the
file, the key and the reservation are removed and the form says which step failed and why.

**Afterwards**, the Workshops page shows each workshop's file size, schema version, last backup, last
verified, and a **readiness line** for a new one — *no mechanics · no stock · no grant approved* — each
linking to the screen that fixes it.

**Starting fresh** needs no special work: the new file is empty. No mechanics, no daily work, no
purchasing, no stock, no job cards — exactly as asked.

---

## 6. Main store access — granted from the admin section

A workshop draws nothing from the main store unless an admin has granted it, and every grant is
specific, limited, approved by a second person, dated, and revocable.

**Admin → Workshops → [workshop] → Main store access**

| Field | Meaning |
|---|---|
| **May see** | the main store's stock levels (read-only — §7.4's read-only connection, stock tables only) |
| **May request** | raise a request against the main store |
| **May draw** | have goods issued to it from the main store |
| **Covering** | everything, or chosen categories, or chosen items |
| **Limits** | most per line; most value per month |
| **Valid** | from a date, until a date (or open-ended) |
| **Granted by / approved by** | two different admins — the two-person rule; one admin cannot grant and approve |
| **State** | pending → active → suspended / revoked / expired, every change with a reason |

**How a draw works.** The site raises a request against the main store; the main store's storekeeper
issues it as a **transfer** to the site (§7.2), which the site accepts. The grant is checked at each
step — still active, item covered, within the line and monthly limits — and the draw is recorded in
`store_access_usage` against the grant. The goods leave Central's stock and enter the site's at the
main store's cost, so each workshop's job cards carry the true cost.

**What the admin sees:** every grant, its use against its limits this month, grants nearing their end
date (a warning 14 days out), and a full history. Suspending a grant stops new draws at once;
transfers already dispatched still arrive, so nothing is stranded in between.

---

## 7. Work that crosses two workshops

Each of these touches two files, and two files cannot commit as one (§1). Each therefore gets a
mechanism that is **safe to repeat**, **checkable afterwards**, and **repaired automatically** when
something stops halfway.

### 7.1 One open job card per vehicle — across every workshop

The rule that a vehicle has one open card holds across all workshops today. With separate files, it
moves to `vehicle_holds` in core: one row per vehicle, primary key on the vehicle, so two workshops
cannot both claim it — the database refuses the second.

Opening a card: **claim the hold in core** → write the card in the workshop file → if that write
fails, **release the hold**. Closing or partly closing releases it. The nightly verifier compares
holds with the open cards in every file and repairs any difference, reporting it. At cut-over, every
open card already on the book becomes a hold.

### 7.2 Transfers between two workshops' stores

Today a transfer already leaves one store when dispatched and enters the other when accepted. That
two-step shape is what makes it safe here:

| Step | Writes | Recorded in core `transfers` |
|---|---|---|
| Create | the note, in the sending workshop's file | `draft`, with a unique transfer id |
| Dispatch | stock **out**, in the sender's file, stamped with the transfer id | `dispatched` |
| Accept | stock **in**, in the receiver's file, stamped with the transfer id | `accepted` |

Each movement row carries the transfer id under a **unique** constraint, so repeating a step can never
post it twice. A **reconciler** runs every few minutes and nightly: a transfer marked dispatched must
have its out-movement; one marked accepted must have its in-movement; out and in quantities must
match. Anything stuck or mismatched is completed from what the records prove, or raised on the
dashboard for a person when they do not prove enough.

### 7.3 Drawing from the main store

A transfer (§7.2) whose sender is the main store, checked against the grant (§6) at request, dispatch
and accept.

### 7.4 Seeing other workshops' job cards and service records

For the workshops allowed to look (decision D5), a request opens the other workshop's file **read-only**
— the driver refuses any write (§1) — and exposes only job cards, service records and their details
through a narrow reading function. Everything else of another workshop is never opened at all.

On screen: an "All workshops" view on Job Cards and Service Records; another workshop's record opens
with a band — *"Muthur Workshop's job card — you can read it, not change it"* — and no action buttons.

### 7.5 Head office — every workshop at once

Head office chooses which workshop it is working in, from a switcher in the top bar. Every switch is
recorded, and a banner says which workshop is open, so nobody records Central's work into Muthur by
mistake. Site staff do not have the switcher.

Company-wide reports (the Monthly Cost report, dashboards) open each workshop's file read-only in
turn and combine the results — not by attaching them all, which stops at 10 (§1).

### 7.6 Handing over between workshops

Moving a **vehicle** changes its location in core. Moving a **job card** or a **mechanic** to another
workshop is a handover: the receiving workshop gets a new record linked to the old one, the old one
is closed with a note of where it went, and history stays where it happened.

---

## 8. Accuracy — keeping what the database used to guarantee

### 8.1 The 109 links that cross files

| Link to | Count | How it is kept true |
|---|---|---|
| `workshops` | 25 | **Enforced inside each file.** Each file knows whose it is (`ws_meta`), and triggers refuse any row carrying a different workshop id. A record cannot land in the wrong workshop's file. |
| `users` | 40 | checked by the app when written (does this person exist); verified nightly |
| `assets` | 25 | checked when written (does this vehicle exist, is it active); verified nightly |
| `store_items` | 7 | as above |
| `projects` | 5 | as above |
| `tb_specs` | 4 | as above |
| `products` | 2 | as above |
| `item_categories` | 1 | as above |

Shared records that workshop records point at are **never deleted**, only retired — which is already
how vehicles, people and catalogue items are handled — so a valid link cannot later dangle.

### 8.2 The nightly verifier

Runs every night and on demand from the admin section, and reports on `/api/health` and the
dashboard:

- `PRAGMA integrity_check` and `foreign_key_check` on every file;
- the 84 app-checked links — any record pointing at something that does not exist;
- every file opens with its own key, and only its own;
- every file's schema version matches the code's;
- every file's `ws_meta` matches its registry entry;
- vehicle holds against open cards in every file (§7.1);
- every transfer balanced (§7.2);
- every audit chain intact (§9.3).

### 8.3 Numbering

Each workshop numbers its own cards and documents in its own file, so no counter is shared between
files. Central's numbers stay exactly as they are (`2026/10/R/7`); a site's carry its prefix
(`MTR/2026/10/R/1`), so a number on paper says where it came from (decision D3).

### 8.4 Never the wrong file

Every database call resolves its file from the request's workshop. **A call made outside any workshop
is refused**, never quietly sent to Central — the mistake that would put a site's data into the main
book without anyone noticing. Background work (backups, the reconciler, the verifier) names the
workshop it is working on explicitly.

---

## 9. Security — the hardened options

### 9.1 Encryption at rest, a key per workshop

- Every file encrypted (SQLCipher-compatible, via `better-sqlite3-multiple-ciphers`).
- Each workshop has its **own random 256-bit data key**; core has its own.
- Data keys are stored **wrapped** — encrypted by one **master key** — in `workshop_keys`. The master
  key lives outside the data: in the environment, or `keys/master.key` (permissions `600`, owned by
  the service account) — the same custody the two-factor key already has.
- **A copy of the data alone is useless.** A backup, the office PC's copy, a lost disk: without the
  master key, every file reads as noise. Proved above (§1).
- **Rotation**: a workshop's key, or the master key, can be changed from the admin section; files
  are re-encrypted in place and the old key retired.

### 9.2 Each connection can do only its job

| Connection | Can read | Can write |
|---|---|---|
| A workshop's own | its own file, and core | **its own file only** — core writes refused by per-connection guards (§1) |
| Looking at another workshop | that workshop's job cards and services, through one function | **nothing** — opened read-only, refused by the driver |
| Core | core | core — used only by admin, head office and the core functions |

Site code is never handed a raw SQL executor, so it cannot remove its own guard. A test fails the
build if any route or library outside the data layer reaches for one.

### 9.3 A tamper-evident audit trail

Every audit entry stores the fingerprint (SHA-256) of the entry before it. Changing or deleting any
past entry breaks every fingerprint after it, and the verifier says exactly where. Each file's latest
fingerprint is also recorded in core and in every backup's manifest, so even replacing a whole file's
trail is caught.

### 9.4 Who works where

- A person's workshop is fixed on their session. Site staff work in their own workshop and cannot
  change it.
- Head office switches workshop explicitly; every switch is audited and shown on screen.
- Grants (§6) need two different admins.
- Retiring a workshop archives its file read-only; it can be read for history and reinstated by an
  admin, never silently written to.

### 9.5 Backups that can be trusted

- Every file backed up together, on the existing schedule, with a **manifest**: each file's SHA-256,
  schema version and audit fingerprint.
- Backups are copies of encrypted files, so they are encrypted too; the master key is never in them.
- Restore the **whole set**, or **one workshop alone** without touching the others.
- A **weekly automatic restore test**: restore the latest set to a scratch folder, open every file
  with its key, run the verifier, and report the result.

### 9.6 What this does not protect against

Plainly, so nobody relies on it for the wrong thing:

- **Someone in control of the running server can read everything.** The app must hold the keys to
  work. Encryption at rest protects copies — backups, the office copy, a stolen disk — not a server
  already broken into. Keeping the server patched, the firewall, two-factor sign-in and Cloudflare
  remain the defence there.
- **The guards stop mistakes in our code, not code written to get round them.** They make the common
  error — a missing check, a wrong query — impossible to ship; they are not a sandbox.
- **Losing the master key loses all the data.** That is the price of real encryption. It must be kept
  in the password manager **and** written down and locked away, and the restore test proves the copy
  works.

---

## 10. Running it

- **Updates.** `deploy/update.sh` learns to migrate **every** file. If any file fails, every file is
  put back to before the update and the old version restarted — no workshop is ever left on a
  different schema from the rest. The server refuses to open a workshop whose file is not on the
  current schema.
- **Memory.** Each open file has its own cache. It is capped per connection, other workshops' files
  are opened only when looked at and closed again when idle — comfortable on the current 2 GB server
  for the expected handful of workshops.
- **Health.** `/api/health` reports each file: opens, schema current, last backup, last verified,
  size.

---

## 11. Phases — each one shippable

The system works after every phase. Nothing in an earlier phase depends on a later decision.

| Phase | What it delivers | Size | Risk |
|---|---|---|---|
| **0 — Groundwork** | Node 22 on the server. Switch to the encrypting driver (same API) — not yet encrypting. Every database call resolves its file from the request's workshop; for now every workshop resolves to today's single file, so **nothing changes for anyone**. Calls outside a workshop refused. | L | low — no data moves |
| **1 — Shared writes through core** | The 118 writes to shared tables go through core functions. The few workshop actions that write shared data are reworked: vehicle status from holds (§7.1), settings split into company and workshop, audit split into company and workshop. | M | low |
| **2 — The split** | Build `core.db` and `CW.db` from the live database **on a copy**: every row copied, row counts and checksums compared table by table, the original kept untouched. Files encrypted from birth if D1 is yes. Rehearsed until clean, then done in a short maintenance window with the original as the way back. Verifier and per-file backups go live. | L | **the one risky step** — controlled by rehearsal, checksums and an untouched original |
| **3 — Adding a workshop** | §5: the automatic, all-or-nothing creation of a workshop and its database. | M | low |
| **4 — Isolation live** | Site requests get only their own connection. Head office switcher. Vehicle holds. Per-workshop numbering. | M | medium — covered by the route-walking tests in §12 |
| **5 — Main store access** | §6: grants in the admin section, the two-person rule, limits, usage, draws as transfers. | M | low |
| **6 — Between workshops** | §7.2 transfers between any two workshops with the reconciler; §7.4 read-only viewing; §7.6 handovers. | M | medium |
| **7 — Hardening** | Key rotation, the hash-chained audit, encrypted verified backups and the weekly restore test. | M | low |
| **8 — Company reports** | §7.5: head-office reports across every workshop. | S | low |

---

## 12. Tests

The existing suite (1,008 passing; the one failure needs a browser this build machine lacks) is the
safety net for Phase 0, and must stay exactly as green with every database call rerouted. New:

- **Isolation, walked from the routers themselves:** for every route, as a site user, prove it reads
  and writes only its own file — so a route added later is covered without anyone remembering to add
  it.
- **Guards:** a site connection's write to every one of the 36 shared tables is refused; a read-only
  connection's write to every workshop table is refused; a row with the wrong workshop id is refused
  by every workshop table; a call outside a workshop is refused.
- **The split:** on a copy of a realistic database, every table's row count and checksum identical
  before and after; every link resolves; the original byte-for-byte unchanged.
- **Adding a workshop:** succeeds completely; and failing at **each** of the nine steps leaves no
  file, no key and no registry row behind.
- **Transfers:** stop the process at every step of every transfer and prove the reconciler finishes or
  reports it, never doubles it.
- **Holds:** two workshops opening a card for one vehicle at the same moment — exactly one wins.
- **Grants:** each limit, expiry, suspension and the two-person rule.
- **Encryption:** no key, wrong key, rotated key; no plaintext in any file or log.
- **Audit chain:** altering, deleting or reordering one entry is detected, and located.
- **Backup:** restore the whole set and one workshop alone; the weekly restore test.

---

## 13. Decisions to confirm

| # | Question | Recommendation |
|---|---|---|
| **D1** | **Encrypt every workshop's file?** Needs Node 22 on the server and master-key custody (§9.6). | **Yes.** Backups and the office copy are the likeliest place data escapes, and this makes them useless without the key. |
| **D2** | **Central gets its own file** rather than staying beside the shared tables (§3). | **Yes** — otherwise every site connection can read Central's data. |
| **D3** | **Numbering**: each site prefixes its numbers (`MTR/2026/10/R/1`); Central's stay as they are. | **Yes** — a number on paper then says where it came from. |
| **D4** | **Main store grants need two admins**, and carry limits per line and per month. | **Yes.** |
| **D5** | **Which workshops may read other workshops' job cards and service records**, and do they see costs? | Every site reads every other's, costs included — as in the previous plan. |
| **D6** | **Mechanics are entirely per workshop**; moving one is a handover, history stays. | **Yes** — matches "fresh mechanics". |
| **D7** | **New catalogue items** created at a site go into the shared catalogue at once, flagged for head office to review. | **Yes** — work is not held up, and the catalogue stays clean. |
| **D8** | **Option A now**, with B (PostgreSQL) kept open for later. | **Yes.** |

---

## 14. Risks

| Risk | What stops it |
|---|---|
| The live split goes wrong | Rehearsed on copies until clean; every table counted and checksummed; the original never touched and is the way back. |
| The master key is lost | Two copies — password manager and locked away; the weekly restore test proves the key opens the backups. |
| A transfer stops halfway | Unique transfer ids make every step safe to repeat; the reconciler completes or reports it. |
| Workshops end up on different schemas | Every file migrated together or none; the server refuses a file not on the current schema. |
| A route reads the wrong workshop | Calls outside a workshop refused; in-file workshop guards; route-walking isolation tests. |
| The server runs short of memory | Capped cache per file; other workshops' files opened only when looked at. |
| The server's Node is older than 22 | Checked before Phase 0 begins; upgraded first if needed. |
