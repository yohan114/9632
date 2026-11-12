# Fuel System + WorkshopOne: merge plan and step prompts

Written 2026-11-10 from a read of both repositories (WorkshopOne `main` at 81e8f2d,
Fuel-System-V2 `main` at 91a0f98) and the local development databases.

## 1. The goal

One report per vehicle per month:

| Line | Comes from |
|---|---|
| Hire revenue (rental) | Fuel system bills |
| Fuel recharged to the site | Fuel system bills |
| Diesel cost | Fuel system fuel issues |
| Repair and service cost (labour, parts, oil, filters, tyres, batteries, outside repair) | WorkshopOne |
| Driver / operator wage, hired-in rental, insurance, other | New input (neither system holds it today) |
| **Profit or loss** | Revenue minus all costs |

Plus one master dashboard for the administrator, with every other person seeing only
what their permissions allow.

## 2. Ground rules (every step follows these)

**Method**

1. Join the numbers and the login. Do not rewrite the fuel system inside WorkshopOne.
   The fuel system is about 40,000 lines with its own billing rules and 55 test files.
   Both apps keep running as they are; WorkshopOne becomes the place where the
   combined report and the master dashboard live.
2. Each system stays the owner of its own data. Fuel issues, tanks, rates and bills are
   entered only in the fuel system. Jobs, stores and services only in WorkshopOne.
   WorkshopOne holds a read-only copy of the fuel month figures, refreshed by a sync.
3. Start every step from the latest `origin/main` of the repository it changes. Do not
   build on the branch `merger/discovery-phase0` or on the untracked `backend/`,
   `frontend/`, `docker-compose.yml` in the office folder (see section 3).

**Numbers**

4. Vehicle identity is the E&C code, compared after normalising (upper case, letters and
   digits only), the same way `service_planner_client.codeKey` does it. A fuel vehicle
   that matches no WorkshopOne asset is never created automatically and never dropped:
   it goes to a review list, and its money shows on an "unmatched" line so the report
   total always equals the fuel system's own total.
5. Money: the fuel system stores LKR cents as integers, WorkshopOne stores rupees.
   Convert once, at the sync, and store both the cents and the source reference.
6. Months are Colombo months. Fuel issue dates are stored in UTC; convert to +05:30
   before choosing the month, or fuel issued in the evening lands in the wrong month.
7. The sync is an absolute recompute per month, never an increment. Fuel issues get
   voided and corrected after the fact and draft bills are regenerated; re-running the
   sync for a month must give the same answer every time.
8. Count each cost once.
   - Service cost comes only from WorkshopOne. The fuel system's service records are a
     copy pulled from WorkshopOne; never import them back.
   - Voided fuel issues are excluded.
   - Tax (SSCL, VAT) is not revenue.
   - Outside work cost stays excluded from company totals; outside repair charges count.
   - A reopened job stays in its original cost month.
9. Revenue is shown by bill status. In the local copy 710 of 714 bills are still DRAFT.
   Draft and issued revenue are separate columns; a draft is never shown as earned.
10. Every report ends with a reconciliation line: fuel cost in the report against the
    fuel system total for the month, repair cost against the WorkshopOne monthly cost
    report. If they differ, the report says so.

**Access**

11. New screens are new sections in the permission matrix plus capabilities, checked
    with `requireModule` / `requireCap`. No checks by role name. Admin has full access.
    Site-scoped users see only their own site's vehicles.

**Safety**

12. The server is the system of record. The office PC is development only. Nothing is
    written to a live database without a backup taken first and the owner's go-ahead.
13. The WorkshopOne repository is public. No database, token, password, IP address or
    hostname goes into a commit.
14. Every step ends with tests passing (`npm test` in WorkshopOne, `npm test` and
    `npm run typecheck` in the fuel system) and a short note of what was not verified.

## 3. What already exists (found during analysis)

**Already connected.** The fuel system pulls service jobs from WorkshopOne's database
every 5 minutes. WorkshopOne reads service-due status from the fuel system's
`/api/portal/service`. The fuel system also has `/api/portal/costs?month=YYYY-MM`,
which returns fuel cost and bill income per vehicle code, protected by a token. Nothing
in WorkshopOne reads it yet. `vehicle_monthly_costs.fuel_cost` exists and is zero on
every row.

**An earlier merge attempt, not finished.** Branch `merger/discovery-phase0` (9 Nov)
ported a small part of the fuel system into WorkshopOne and copied 35,463 fuel rows
into the office `core.db`. It should not be merged as it stands:

- The vehicle profitability query reads `job_cards.vehicle_id`, `job_costs.parts_cost`
  and `job_costs.outsourced_cost`. None of these columns exist (they are `asset_id`,
  `material_cost`, `external_cost`). The query sits inside `try { } catch { }`, so the
  error is swallowed and every vehicle shows zero repair cost.
- Revenue counts only bills with status `FINAL`. The copied bills are `DRAFT` or
  `ISSUED`, so revenue shows zero as well.
- Fuel tables were put in `core.db`; job costs live in the per-workshop database. One
  query cannot join them.
- "Seal period" writes an audit line and returns success without sealing anything.
- Driver wage and hired-in columns exist but nothing fills them.
- The billing port is 149 lines against roughly 5,000 in the fuel system (no split of a
  month across sites, no site attribution, no revisions, payments or credit notes).
- The copied data is a snapshot. The local fuel database it came from ends on
  3 September 2026.

Its useful ideas (identity mapping table, capability names, month snapshot table) are
reused in the steps below.

**A second attempt** sits untracked in the office folder: `backend/`, `frontend/`,
`docker-compose.yml`, `deploy-merged.sh` (a rewrite on PostgreSQL and Docker). It is not
used by this plan. Leave it in place until the owner decides; do not deploy it.

**Sizes (local development copies, read-only check)**

| | |
|---|---|
| Fuel system vehicles | 778 (9 hired-in) |
| WorkshopOne assets before the earlier attempt | 1,180 |
| Matched by E&C code | 536 |
| Matched by registration only | 9 |
| Not matched | 233, of which 171 have fuel issues and 15 have bills |
| Fuel issues | 14,446 (31 voided) |
| Bills | 714 for May to August 2026: 710 draft, 4 issued |
| Fuel system active users | 13 (3 admin, 9 site pump, 1 workshop); 4 share a username with WorkshopOne |
| Sites/projects | 37 in fuel, 12 in WorkshopOne before the attempt; 36 do not match by code or name |

Some unmatched "vehicles" are not vehicles: `SITE-WCP`, `GEN-KB`, `BOARD FORM WORK`.
They need a person to decide, which is why rule 4 exists.

**Stale checkouts.** This worktree is 139 commits behind `origin/main`. The local
fuel checkout `D:\Fuel-System-V2` is 26 commits behind its `origin/main` and has one
commit that was never pushed.

## 4. Decisions the owner must make

1. **Which bills count as revenue?** Recommended: issued and paid bills are "billed
   revenue"; drafts are shown beside them as "not yet invoiced".
2. **Where do driver and operator wages come from?** Neither system has them.
   Recommended: a simple monthly entry screen per vehicle (with Excel upload), also
   used for insurance, licence, lease and other fixed costs.
3. **Hired-in machines.** The fuel system records what E&C pays the owner. Recommended:
   bring it in as a cost line so a hired machine is not shown as pure profit.
4. **One login for both systems?** Recommended as a later step (step 7). Until then the
   master dashboard links to the fuel system and people sign in there as today.
5. **What to do with the two earlier attempts.** Recommended: keep the branch for
   reference, do not merge it; leave the Docker folders untouched and undeployed.
6. **Is the server running WorkshopOne in multi-database mode (`MULTIDB=1`)?** Step 0
   finds out; several later choices depend on it.

## 5. The process

| Step | Repository | Result |
|---|---|---|
| 0 | both, read-only | Facts from the live server; the earlier attempts parked; decisions recorded |
| 1 | Fuel-System-V2 | One feed that returns every vehicle's month: litres, fuel cost, revenue by status, hired-in cost |
| 2 | WorkshopOne | Fuel vehicle and site codes mapped to WorkshopOne assets and projects, with a review list |
| 3 | WorkshopOne | Month figures pulled from the feed and stored, with a sync status screen |
| 4 | WorkshopOne | Entry screen for driver wage and other monthly costs |
| 5 | WorkshopOne | Vehicle Monthly Profit and Loss report, on screen and in Excel |
| 6 | WorkshopOne | Master dashboard for the administrator, permission-gated |
| 7 | both | One login: WorkshopOne signs the user into the fuel system |
| 8 | WorkshopOne | Month seal, then deployment to the server |

Steps 1 and 2 can run at the same time. Steps 3 to 6 run in order. Step 7 is optional.
Run each prompt in a new session opened on the repository named in the table.

## 6. The prompts

Each prompt assumes this file is in the repository at `docs/FUEL_MERGE_PLAN.md`.

### Step 0. Baseline (read-only)

```text
Read docs/FUEL_MERGE_PLAN.md fully. This step changes no code and writes to no database.

Find out and report:
1. On the live server: which WorkshopOne commit is deployed, whether MULTIDB=1 is set,
   which database files exist and their sizes, which fuel system commit is deployed,
   and whether SERVICE_PLANNER_TOKEN / FUEL_PORTAL_TOKEN are set (names only, never
   print a value). I will run any command you give me on the server and paste the
   output; give me the commands one at a time, read-only only.
2. Call the fuel system's /api/portal/costs for last month through the server and tell
   me the count of cost rows and income rows, and the totals. Do not print the token.
3. In the office folder D:\Master system 1: list the untracked files from the earlier
   merge attempts and confirm none of them is referenced by the running app.
4. In D:\Fuel-System-V2: show the one unpushed commit and tell me whether it is already
   covered by origin/main.

Then update section 4 of docs/FUEL_MERGE_PLAN.md with the answers you found and list
the decisions still open. Ask me the open decisions one by one. Do not start step 1.
```

### Step 1. Fuel system: the vehicle-month feed

```text
Repository: Fuel-System-V2, from the latest origin/main. Read AGENTS.md first (this
Next.js version differs from older ones; read the guide in node_modules/next/dist/docs
before writing a route). Follow the ground rules in the WorkshopOne file
docs/FUEL_MERGE_PLAN.md section 2, which I will paste below.

Add GET /api/portal/vehicle-month?month=YYYY-MM, read-only, authorised by the same
x-portal-token check as /api/portal/costs. For each vehicle that has fuel issues,
bills or a posting in that Colombo month, return:
- code, registration, category, ownership (OWNED or HIRED)
- fuel: litres and cost in cents, voided issues excluded, month chosen by Colombo date
  using src/lib/colombo-date.ts
- bills: rental cents, fuel recharge cents and tax cents, each split into draft and
  issued-or-paid; billable units and their unit; billing mode and rate basis
- sites: the site or sites the vehicle was posted to in the month, with driver name
- hired-in: the hire charge for the month in cents when the vehicle is HIRED and the
  rate and dates allow it to be calculated; otherwise null with a reason
- sourceRef values stable enough for the caller to detect change
Also return month totals, and a generatedAt time.

Do not change any existing route, any billing rule or the database schema. Write
vitest tests covering: a voided issue is excluded; an issue at 23:00 Colombo time on
the last day stays in that month; a draft and an issued bill land in separate fields;
a wrong or missing token gets 401. Run npm test and npm run typecheck. Open a pull
request; do not deploy.

[paste section 2 of docs/FUEL_MERGE_PLAN.md here]
```

### Step 2. WorkshopOne: identity mapping

```text
Repository: WorkshopOne (yohan114/9632), new branch from the latest origin/main. Read
docs/FUEL_MERGE_PLAN.md fully and follow section 2.

Build the mapping between fuel system codes and WorkshopOne records.
1. A new migration (next free number after the highest in src/migrate on main; check,
   do not assume) creating a mapping table for two kinds of thing: vehicle and site.
   Each row: the fuel system code and label as received, the WorkshopOne asset or
   project it maps to (nullable), how it was matched (exact code, registration,
   manual, or "not a vehicle"), who decided and when. Find out from the code whether
   this belongs in the core database or elsewhere in multi-database mode, and say why.
2. A resolver in src/lib that matches by normalised E&C code first, then registration,
   reusing the existing alias logic where it fits. No match means a pending row; it
   never creates an asset or project.
3. A review screen listing pending rows with the fuel litres and bill count behind
   each, where a permitted user links a row to an existing asset or project, or marks
   it "not a vehicle". Gate it with a new capability, not a role name.
4. Tests: exact match, registration match, pending when nothing matches, a manual link
   survives a re-run, and no asset row is created by the resolver.

Do not import any fuel data in this step. Run npm test. Open a pull request.
```

### Step 3. WorkshopOne: the sync

```text
Repository: WorkshopOne, new branch from the latest origin/main (steps 1 and 2 merged).
Read docs/FUEL_MERGE_PLAN.md fully and follow section 2.

Pull the fuel system's vehicle-month feed into WorkshopOne.
1. A client in src/lib modelled on service_planner_client.js (same URL and token
   config, timeout, and honest failure reason).
2. A migration for a table holding one row per fuel vehicle code per month: the mapped
   asset id (nullable), litres, fuel cost, rental and fuel-recharge revenue split into
   draft and issued, hired-in cost, units, sites, the cents values as received, and
   the sync time. Unique on code and month.
3. A sync that replaces a whole month in one transaction (rules 5, 6, 7). It runs on a
   timer for the current and previous month, and on demand for any month by a user
   with the right capability. It must never overlap itself.
4. Decide from the code how fuel cost reaches existing reports without being counted
   twice. vehicle_monthly_costs.fuel_cost is zero today and the table's invariant is
   total_cost = sum of the component columns. Tell me your choice and why before
   writing it.
5. A status panel: last run, months synced, rows unmatched, and the difference between
   the feed's month total and what was stored (must be zero).
6. If the feed is unreachable the screens keep showing the last synced figures with
   their date; they never show zero as if it were real.

Tests: re-running a month changes nothing; a voided issue on the fuel side lowers the
month on the next sync; an unmatched code is stored and counted in the total; cents
convert to rupees exactly. Run npm test. Open a pull request.
```

### Step 4. WorkshopOne: driver wage and other monthly costs

```text
Repository: WorkshopOne, new branch from the latest origin/main. Read
docs/FUEL_MERGE_PLAN.md fully and follow section 2.

Add monthly costs that neither system records.
1. A migration for a table: asset, year, month, cost type (driver wage, operator wage,
   insurance, licence, lease, other), amount, note, who entered it and when. One row
   per asset, month and type.
2. A screen to enter and edit these per vehicle and month, and an Excel upload with a
   template; the upload shows what will change before it saves and never duplicates a
   row on a second upload.
3. A new section in the permission matrix for this screen. Wages are sensitive: users
   without the section see neither the screen nor these amounts in any report or
   export.
4. Every change is written to the audit log with the old and new amount.

Tests: the unique rule, upload twice gives the same rows, a user without the section
gets 403 on the API and the amounts are absent from report output. Run npm test.
```

### Step 5. WorkshopOne: Vehicle Monthly Profit and Loss

```text
Repository: WorkshopOne, new branch from the latest origin/main. Read
docs/FUEL_MERGE_PLAN.md fully and follow section 2.

Build the Vehicle Monthly Profit and Loss report.
Columns per vehicle for a chosen month: site(s); hours or km billed; rental revenue
issued; rental revenue draft; fuel recharged; litres; fuel cost; repair and service
cost broken into labour, parts, oil, filters, tyres and batteries, outside repair;
driver and other monthly costs by type; hired-in cost; total cost; profit or loss;
profit as a percentage of revenue. Then a year view for one vehicle, month by month.

Rules:
- Repair figures must come from the same code paths the existing Monthly Cost Report
  and job costing use, so the two reports agree. Read src/lib/costing.js,
  month_costs.js and monthly_cost_report.js before choosing. In multi-database mode a
  vehicle's repair cost is the sum across every workshop database.
- Fuel figures come only from the synced table of step 3.
- Rule 8 and rule 9 of the plan apply.
- A footer shows the three reconciliation checks of rule 10, each with its difference.
- An "unmatched" block lists fuel codes with money but no WorkshopOne asset.
- Site-scoped users see only their site's vehicles; wage columns appear only for users
  who hold the step 4 section.
- Excel export with the same numbers as the screen.

Tests on a small fixed dataset where the expected profit is worked out by hand in the
test file: a wet-hire vehicle, a dry-hire vehicle, a hired-in vehicle, a vehicle with
repair cost and no revenue, a reopened job, and an unmatched fuel code. Run npm test.
Show me the report for one real month from the development database before the pull
request.
```

### Step 6. WorkshopOne: master dashboard

```text
Repository: WorkshopOne, new branch from the latest origin/main. Read
docs/FUEL_MERGE_PLAN.md fully and follow section 2.

Build a master dashboard for the administrator.
- Company month to date: billed revenue, draft revenue, fuel cost, repair cost, other
  costs, profit; each compared with last month.
- Top and bottom ten vehicles by profit; vehicles with cost and no revenue.
- Fuel: litres today and this month, tanks below 20 percent, pending fuel requests and
  corrections (from the fuel system's /api/portal/summary).
- Workshop: open job cards, jobs waiting for approval, stock alerts (reuse what
  src/routes/dashboard.js already computes).
- Health: last fuel sync time, unmatched codes waiting for review, months not yet
  sealed.
- Tiles that open the fuel system screens in a new tab.

A new permission section "Master Dashboard", plus capabilities for the money tiles so
an admin can give someone the operational tiles without the financial ones. Each tile
is produced on the server only if the user may see it; hiding it in the browser is not
enough. Tests: a user without the section gets 403; a user with the section but
without the finance capability receives no money fields in the response body.
Run npm test and check the screen in the browser at phone and desktop width.
```

### Step 7. One login (optional)

```text
Read docs/FUEL_MERGE_PLAN.md fully and follow section 2. This step changes both
repositories; make one pull request in each.

Let a user signed in to WorkshopOne open the fuel system without a second password.
- WorkshopOne: on the Access Control board, a per-person "Fuel system access" setting
  holding the fuel role (ADMIN, ALLOCATOR, USER, SITE_PUMP, WORKSHOP), the site and
  the tank. Granting it follows the existing guardrails in src/lib/access_rules.js.
  An endpoint issues a single-use handoff token that expires in 60 seconds, signed
  with a secret shared by the two apps and kept only in each .env.
- Fuel system: an endpoint that verifies the token, finds or creates the matching
  user, applies role, site and tank from the token, and creates its normal session.
  The existing username and password login keeps working.
- Removing the setting in WorkshopOne deactivates the fuel user on next use.
- Both sides write an audit entry.

Before coding, write a short threat list (replay, token theft, role escalation, a
deactivated WorkshopOne user) and how each is closed, and show it to me.
Tests on both sides for each item in that list.
```

### Step 8. Month seal and deployment

```text
Repository: WorkshopOne, new branch from the latest origin/main. Read
docs/FUEL_MERGE_PLAN.md fully and follow section 2.

1. Sealing: a permitted user seals a month of the Profit and Loss report. Sealing
   stores the figures as shown; later syncs and edits do not change a sealed month,
   and the report marks it sealed with who and when. Reopening needs a reason and its
   own capability, and is audited. Tests for each of these.
2. Deployment: write the exact server steps for this release using deploy/update.sh:
   backup first, the new .env keys (names only), migrations in order, the first full
   sync, and the checks that prove it worked (the reconciliation differences are zero
   for the last closed month). Include how to roll back. I run the commands on the
   server myself; give them to me one at a time and wait for the output.
```

## 7. Later, if wanted

Once the report is trusted for two or three months, individual fuel screens can be
rebuilt inside WorkshopOne one at a time, each replacing its original only after both
give the same numbers for a full month. That decision does not need to be made now.
