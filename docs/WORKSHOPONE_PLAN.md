# WorkshopOne — Plan (v3)

_Date: 2026-09-24 · status after every stage was built. It replaces v2 (same file), which set the order
of work. The first plan, `SECURITY_ACCESS_MULTISITE_PLAN.md` (v1), is not in this repository because
the repository is public; §4 and §5 record the multi-site stages as they were built and the decisions
chosen._

---

## 1. Summary

- **Everything in the plan is built, tested and merged into `main`:** the security work (Stage 0 and
  Stage 1), the groundwork W0, attendance W1, partial close W2, reports W3, approval limits, and the
  multi-site Stages 2–7.
- **None of it is on the live server yet.** That is the next step, and it is your action (§3).
- **After the update, nothing changes on its own.** Each new feature is off, empty or unused until you
  switch it on (§3.4). With one workshop, every screen looks as before, plus the new Field Work and
  Operations pages.
- A few extras were put off on purpose (§6). Build them only if you want them.

---

## 2. Where we are

| Item | Status | PR |
|---|---|---|
| Stage 0 — security fixes (headers, CSRF check, XSS fix, passwords, sessions, backups, Cloudflare lock script) | ✅ merged | #4 |
| Stage 1 — custom roles and permissions | ✅ merged | #5 |
| Stage 1 — two-factor sign-in | ✅ merged | #6 |
| Phase 1 controls — segregation of duties, `/api` needs a session | ✅ merged | #7 |
| Stage 1 — signed-in devices, idle timeout, session expiry fix | ✅ merged | #8 |
| Vehicle lubricant capacities | ✅ merged | #9 |
| Crash log (start, stop and crash written to a file; a crash exits) | ✅ merged | with #11 |
| W0 — groundwork: one meaning of "open", one add guard, stuck-card review screen | ✅ merged | with #11 |
| W1 — mechanic attendance and the daily tally | ✅ merged | #10 |
| W2 — partial close, full close and reopen requests | ✅ merged | #11 |
| W3 — reports and dashboards | ✅ merged | #12 |
| Stage 1 — approval limits | ✅ merged; **your amounts (D7) are still to be typed in** | #14 |
| Stage 2 — workshops and sites | ✅ merged | #15 |
| Stage 3 — each workshop sees its own work ("Separate workshops") | ✅ merged | #16 |
| Stage 4 part A — attendance and sign-off per workshop | ✅ merged | #17 |
| Stage 4 part B — a store per workshop | ✅ merged | #18 |
| Stage 5 — reports per workshop | ✅ merged | #19 |
| Stage 6 — field work (breakdowns, repairs at the site) | ✅ merged | #20 |
| Stage 7 — operations (machine moves, site fleet, workshops at a glance, handovers) | ✅ merged | #21 |
| **Deploy all of the above to the live server** | ❌ **not done** | §3 |

Test suite on `main`: all tests pass except the 2 in `monthly_cost_zero_value`, which need the office
database and fail the same way without it.

---

## 3. Deploy and switch on (your action)

### 3.1 Before the update

1. Check the branch: `git -C /opt/workshopone/app branch --show-current` must say `main`.
2. **Take your own full backup of the database and of `mfa.key`.** `update.sh` also makes a backup,
   but several tables are rebuilt on the first start (§3.2), so keep a copy of your own.
3. **Try the update on a copy first** (the office server, or a copy of the live database), because of
   the table rebuilds.
4. Download the **June 2026 Job Cost report** from the live server, to compare after the update.
5. `node scripts/admin.js audit-passwords`, and fix any account it lists.

### 3.2 The update, and what changes in the database

1. `sudo bash /opt/workshopone/app/deploy/update.sh`.
2. On the first start, the database changes **once**. Each change keeps every row and every id, and
   does not run again on later starts. Roughly in this order:

| From | What changes on the first start |
|---|---|
| W1 | New tables `mechanic_attendance` and `workday_signoffs`. |
| W2 | `job_cards` is **rebuilt** so a card can be PARTIALLY_CLOSED: every card, id, link and index kept. Four new columns on `job_cards`; new table `job_reopen_requests`. |
| Approval limits | New table `approval_limits` (empty: no limits until you type them in). |
| Stage 2 | New tables `workshops` and `mechanic_workshops`. **Central Workshop — Badalgama** is created and given every existing user, job card, request and mechanic. Workshop columns on `users`, `job_cards` and `mrn`. Transfer notes get proper from/to places; old notes are matched where the name is clear, the rest stay as text. |
| Stage 3 | `job_requests.workshop_id`. The "Separate workshops" switch starts **off**. |
| Stage 4 part A | `workday_signoffs` is **rebuilt** per workshop; existing sign-offs are kept as whole-company ones. |
| Stage 4 part B | Store columns on `workshops` and on every source of stock movements. All stock recorded so far is Central's. New tables `store_counts` and `store_reorder`. |
| Stage 5 | `daily_report_snapshots` is **rebuilt** per workshop; saved days are kept as whole-company copies. `monthly_report_inputs.workshop_id`: all inputs entered so far are Central's. |
| Stage 6 | Field columns on `job_cards`, a `travel` column on `job_daily_work`. `job_parts` is **rebuilt** so a returned part can be recorded: every line, id and index kept. New table `issue_returns`. |
| Stage 7 | `assets.current_site_id` (empty). New tables `asset_moves` and `job_workshop_moves`. No past moves are made up. |

3. Finish the rest of the old Step 0:
   - back up `/opt/workshopone/data/mfa.key` (again, now on the new version);
   - run `deploy/cloudflare-refresh.sh` (dry run), then `--apply`;
   - add the Cloudflare rate-limit rule, install the verify timer, and set up the off-site copy (`deploy/VPS.md`);
   - enrol admin two-factor, then tick "Require" on the admin role.

### 3.3 After the update: check

- The **June 2026 Job Cost report** is the same as the one you downloaded before.
- Open the job card list, one job card, Stores and the dashboard. They look as before.
- The new pages are there: **Field Work** and **Operations**.

### 3.4 Switch on, one at a time

| # | What | Where | Notes |
|---|---|---|---|
| 1 | Clear the stuck REQUESTED job cards (W-D11) | Job Cards → 🧹 Review stuck cards | Do this first. A stuck card blocks a new job for its vehicle, and a card opened in the app counts as "down" on the Operations board until it is finished. |
| 2 | Attendance | Daily Work → Attendance & day tally → ⚙ | Set the start date, shift, break and tolerance. Days before the start date are never flagged. |
| 3 | Partial close | Job Cards → ⚙ Partial close | |
| 4 | Approval limits (D7) | Access Control → Approval limits | Type in how much each role may approve. |
| 5 | Field vehicle rate | Field Work → Set rate… | Km entered before a rate is set are not charged. |
| 6 | A second workshop | Workshops → Add | Then: **Store…** (its own store from a date, or use another's), move its mechanics (with the date), and set each user's home workshop on Users & Roles. |
| 7 | Separate workshops | Workshops → Separate workshops | Only after step 6 is complete. People outside head office then see only their own workshop's work. |

---

## 4. The multi-site stages as built

- **Stage 2 — workshops and sites.** A Workshops list (add, rename, retire). A **workshop** repairs
  vehicles and has its own mechanics; a **site** is one of your projects (and its sub-sites), where
  vehicles work. Each user has a home workshop (or all, for head office); each mechanic has a
  workshop, with the date of every move; each job card and material request says which workshop does
  the work. Transfer notes name places from the list. With one workshop, the pickers and filters stay
  hidden.
- **Stage 3 — each workshop sees its own work.** With "Separate workshops" on, people outside head
  office see only their workshop's job cards, requests, daily work and approval queues. A vehicle's
  page still lists all its cards, but another workshop's card shows only its number, status and
  workshop. The one-open-card rule stays across all workshops.
- **Stage 4 — attendance and stores per workshop.** Each workshop signs off its own days. Each workshop
  has its own store or uses another's. Receipts go to the store of the request's workshop, issues come
  out of the store of the job's workshop, and a transfer note between two stores moves the stock.
  Counts and reorder levels are per store; store staff see the workshops their store serves.
- **Stage 5 — reports per workshop.** The Reports page and Daily Progress get a workshop picker (head
  office: any workshop or all). Daily reports and their saved copies, the Job Cost workbook and the
  monthly inputs are per workshop; the workshops' workbooks add up to the company one. The company
  workbook gains a "Workshops compared" sheet. Vehicle reports stay whole-company.
- **Stage 6 — field work.** A job card can be "In the field" at a project or site. **Report a
  breakdown** opens a field card at once; approvals follow. Three times on the card (reported, mechanic
  arrived, working again) give the response time and downtime. Travel is a daily-work line marked
  Travel. Field vehicle km × a rate per km is charged as field transport. A Field Work board and a
  dashboard tile show machines still down. Unused parts go back to the store with a return, off the
  job's cost. A "Field work" sheet appears in months with field work.
- **Stage 7 — operations.** **Move machine** sends a machine to another project or site from a date;
  every move is kept. The **Operations** page has: **Site fleet** (what each machine is doing now and
  the month's availability per site, counted in machine-days where the machine stood each day);
  **Workshops at a glance** for head office (each number opens its list); and **Job handovers**
  (sending a card to another workshop needs a reason, and both workshops see it). Cards imported
  from the old job book do not count as downtime: the import stamped them all with the same day.

---

## 5. Decisions

All the answers below are the recommended ones, which you accepted. Only **D7** is still open.

### Open

| # | Question | Status |
|---|---|---|
| D7 | Approval amounts: how much each role may approve | **Open.** Type them in on Access Control → Approval limits. Until then, approvals work as before. |

### Workshop features (W0–W3)

| # | Question | Chosen |
|---|---|---|
| W-D1 | Default shift and break? | 08:00–17:00, 60 min lunch |
| W-D2 | How close must worked and booked be to count as matched? | 15 minutes |
| W-D3 | When work would over-book a mechanic: warn or block? | Warn at entry; block the day sign-off |
| W-D4 | Day sign-off: who, by when, and does it lock the day? | Workshop supervisor, by the next morning; locked, manager unlocks with a reason |
| W-D5 | Who is tracked? | All active mechanics |
| W-D6 | A mechanic working at a project site that day? | Present, with a note "at site X" |
| W-D7 | Must some work done be recorded before a partial close? | Yes (or a written reason) |
| W-D8 | Daily work on a partly closed job? | Only dates up to the partial close; later dates go on the new job |
| W-D9 | Which report month does a partly closed job belong to? | The partial-close month (Closed, flagged), with late prices landing in that month |
| W-D10 | Should fully CLOSED jobs also use reopen *requests*? | Yes, one flow for both |
| W-D11 | The 254 REQUESTED jobs? | Imported with no activity in 90 days → reject "not carried out", after you review the list |
| W-D12 | "Close on date" (backdating) for an incomplete job? | Becomes "partly close on date"; a backdated full close needs the full check |
| W-D13 | Overnight or split shifts? | Overnight yes; split shifts later if needed (§6) |

### Multi-site (Stages 2–7)

| # | Question | Chosen |
|---|---|---|
| S2-D1 | Which workshops exist now? | Only Central Workshop; add others when they open |
| S2-D2 | A project with a mechanic but no store (e.g. CEP-03 Wadakada)? | A site; the mechanic belongs to Central and works "at site X" |
| S2-D3 | Who is "All workshops" (head office)? | Admin, Manager, Operational Manager, Purchasing |
| S2-D4 | Can a user belong to two workshops? | No: one home workshop, or all |
| S2-D5 | When a mechanic moves, keep the date? | Yes |
| S2-D6 | Does a vehicle belong to a workshop? | No; it belongs to a project or site, and the job card says which workshop repairs it |
| S2-D7 | Stock per workshop in Stage 2? | No, Stage 4 |
| S3-D1 | Another workshop's job card, opened from a link? | Refused, saying which workshop it belongs to |
| S3-D2 | A vehicle's history page? | All its cards; other workshops' cards show only number, status and workshop |
| S3-D3 | One open job card per vehicle: per workshop or across all? | Across all |
| S3-D4 | Daily work mechanic list? | Only mechanics of the job card's workshop on that date |
| S3-D5 | Approval queues? | Own workshop only; head office sees all |
| S3-D6 | Reports in Stage 3? | Unchanged (Stage 5 splits them) |
| S3-D7 | Switch? | "Separate workshops", off until you turn it on |
| S4-D1 | Two parts? | Yes: A (attendance) first, then B (stores) |
| S4-D2 | Who signs off a workshop's day? | That workshop's supervisor; head office can sign any |
| S4-D3 | A mechanic lent to another workshop for a day? | Attendance stays with their own workshop; hours on the other workshop's cards still count as booked |
| S4-D4 | Does every workshop get its own store? | Its own, or it uses another's |
| S4-D5 | A transfer between two stores? | One step, on the transfer date |
| S4-D6 | Reorder levels per store? | Yes |
| S4-D7 | Oil per store too? | Yes, like all other stock |
| S5-D1 | Which reports split per workshop? | Daily Reports, the Job Cost report (with Repair Detail and the reconciler), Daily Progress |
| S5-D2 | Which workshop does a cost belong to? | The job card's workshop; with no job card, the workshop of the store it came from |
| S5-D3 | Monthly inputs: who enters them? | Each workshop its own; head office for any; existing lines are Central's |
| S5-D4 | The All-workshops workbook? | As today, plus "Workshops compared" when there are 2 or more workshops |
| S5-D5 | Who sees which workshop's reports? | Head office: any and the total; others with "Separate workshops" on: their own |
| S5-D6 | Signature titles on the workbook? | The same for every workshop (per-workshop titles later, §6) |
| S6-D1 | How is a field job marked? | A job card setting "In the field" plus the site |
| S6-D2 | Must a breakdown wait for the job request steps? | No: it opens a field job card at once; approvals follow |
| S6-D3 | Who may report a breakdown? | Transport managers and their assistants, workshop supervisors, head office |
| S6-D4 | Travel time? | A "Travel" line in Daily Work, costed at the mechanic's rate, shown apart |
| S6-D5 | Field vehicle cost? | Optional km × a rate per km (a setting) |
| S6-D6 | Which times are recorded? | Reported, arrived, working again |
| S6-D7 | Parts taken to the site? | Issued as today; unused parts returned to the store |
| S7-D1 | What does Stage 7 cover? | Machine moves, site fleet board, workshops at a glance, job handovers |
| S7-D2 | Who can move a machine? | Transport manager, operational manager, manager (and admin) |
| S7-D3 | When is a machine "down"? | From the day its repair card is opened (or the breakdown reported) until the work is complete; services apart |
| S7-D4 | How is availability measured? | In days (machine-days); hours later (§6) |
| S7-D5 | Who sees "Workshops at a glance"? | Head office only |
| S7-D6 | A job sent to another workshop: what moves? | The whole card with its costs; a reason is required and kept |
| S7-D7 | A mechanic helping another workshop for a few days? | No new feature: use Move with a date, then move them back |
| S7-D8 | A daily machine log (hours, fuel)? | Not in Stage 7 (§6) |

---

## 6. Later — only if you want them

| Extra | Why it was left out |
|---|---|
| Split shifts (two in/out pairs a day) | W-D13: overnight shifts are handled; split shifts were not needed yet |
| A daily machine log (hours worked, fuel per machine per day) | S7-D8: it needs site staff to enter data every day |
| Availability in hours instead of days | S7-D4: days are reliable with today's data; hours need exact start and end times |
| Signature titles per workshop on the Job Cost workbook | S5-D6: the same titles for every workshop for now |
| Per-store figures on the older stock pages (Stock Cockpit, general items, filters, oil balances) | Stage 4: these still show whole-company totals; with several stores, a line on each page says so |
| "In transit" for transfers between stores | S4-D5: a transfer is one step for now |

---

## 7. Risks at deploy

| Risk | Mitigation |
|---|---|
| A table rebuild fails on the live data (`job_cards`, `workday_signoffs`, `daily_report_snapshots`, `job_parts`) | Each rebuild runs in one transaction, so a failure leaves the old table as it was; the `job_cards` and `job_parts` rebuilds also check that every row and reference is kept. Try on a copy first (§3.1); `update.sh` backup and rollback |
| The June 2026 report changes | Compare before and after (§3.1, §3.3); report tests guard it |
| Stuck REQUESTED cards block new jobs and show machines as down | Clear them first (§3.4, step 1) |
| "Separate workshops" turned on before people have their home workshop | Turn it on last (§3.4, step 7); head office always sees everything |
| Staff find the new screens a chore | Switch features on one at a time, with a few days in between |

---

## Appendix — the design of W0–W2, as agreed before building

The sections below are the v2 design, kept for reference. The code follows them; where details
changed while building, the code and its tests are the final word.

### A. The two new features

#### A.1 Mechanic attendance and the daily tally (W1)

**What the workshop gets**

- **Daily Work → "Attendance & day tally"**: pick a day and see every active mechanic, with the columns
  **In**, **Out**, **Break**, **Worked**, **Booked on jobs**, **Difference** and **Status**.
  - Quick fill: "All present 08:00–17:00", or "Copy yesterday".
  - Mark someone absent, on leave or on a half day.
- **The tally, per mechanic per day:**

  | Status | Meaning |
  |---|---|
  | ✅ **Matched** | worked hours = booked hours (within the tolerance, e.g. 15 min) |
  | 🟡 **Unbooked** | at work but not all hours are on jobs. One click books the rest to *General workshop*, or records a reason |
  | 🔴 **Over-booked** | more hours on jobs than they were at work — always a mistake (typing, a crew line, or a duplicated import) |
  | 🔴 **No attendance** | work booked but no in/out recorded |
  | 🔴 **Absent with work** | marked absent or on leave, but has booked work |

- **Day sign-off** (recommended): a supervisor closes the day once nobody is red. After sign-off,
  that day's attendance and daily work are locked; a manager can unlock them with a reason.
- **At the point of entry:** while adding work done (Daily Work form, quick grid, job card), each
  mechanic shows "attended 8.0 h · booked 6.5 h · **1.5 h left**", with a warning if the entry would
  over-book them.
- **Monthly Labour Working Hours** table: add **Attended**, **Booked** and **Utilisation %** per mechanic.

**How it is counted** (this must follow the existing rules)

- **Worked** = (Out − In) − Break. Out before In means an overnight shift. Absent or leave = 0.
- **Booked** = the sum of `job_daily_work.hours` over every line that names the mechanic, general
  workshop lines included, external lines excluded. A line can name a crew ("Govinda, Vinod"). Each
  named mechanic counts that line's hours, because `hours` is already **per person** (memory:
  *daily-work-hours-are-manhours*; costing rule 1, "each mechanic is charged the full hours").
  Names are resolved with `lib/mechanics` (`splitMechanics` / `resolveMechanic`). A name that cannot
  be resolved shows as "unmatched name", with a link to the Alias Queue.
- **Labour costing does not change.** Job labour stays booked hours × rate. Attendance adds a check
  and a utilisation figure; it does not move money (memory: *workshopone-costing-rules* — do not touch).
- **Only from the go-live date:** days before attendance started are not flagged.

**Data**

- New table `mechanic_attendance`:
  - `mechanic_id` → `mechanics.id`, `work_date`, `time_in`, `time_out`, `break_minutes`;
  - `status` (present / absent / leave / half_day / holiday), `note`, `recorded_by`, timestamps;
  - `UNIQUE(mechanic_id, work_date)`.
- New table `workday_signoffs`: `work_date`, `signed_by`, `signed_at`, `unlocked_by`, `unlock_reason`.
- Settings: default shift, default break, tally tolerance, attendance start date, and whether an
  over-booking **warns** or **blocks** (decision W-D3).
- Ready for multi-site: the mechanic's workshop (Stage 4) decides whose attendance each workshop sees.

**Permissions** (the Stage 1 capability system)

- `attendance.record`: enter and change today's and yesterday's attendance. Default holders: workshop, manager.
- `attendance.signoff`: sign off a day. Default: workshop, manager.
- `attendance.unlock`: change a signed-off day, with a reason. Default: manager, operational manager.
- Reading attendance follows the **Daily Work** section clearance.

#### A.2 Partial close, full close and reopen requests (W2)

**What changes for a job card**

```
IN_PROGRESS / WORK_COMPLETE ──"Partly close"──► PARTIALLY_CLOSED ──"Close fully"──► CLOSED
                                                      │
                                    "Request reopen" ─┴─► (approved) ─► IN_PROGRESS
```

- **Partly close** is for when the work is finished and the vehicle has left, but prices or records
  are still missing.
  - The modal lists exactly what is outstanding (the existing closure check).
  - It takes a note and offers **"Open a new job for this vehicle now"**. The new card points back to
    the old one with `continues_job_id`.
  - It records `partial_closed_at` and `partial_closed_by`. The completion date for reports is the
    partial-close date (decision W-D9).
- **While a job is PARTIALLY_CLOSED:**

  | Still allowed | Refused (with a clear message) |
  |---|---|
  | Price any existing line (parts, GRN, oil, general, service flat labour) | New MRN / material request on this job |
  | Receive (GRN) items that were already requested on this job | New tyre or battery request on this job |
  | Issue those received items to this job | Issuing other shelf stock or oil to this job |
  | Add **general items** (general rack issues) | New external or part lines; claiming unassigned receipts |
  | Daily work dated on or before the partial-close date (catching up, decision W-D8) | Daily work after that date — it goes on the vehicle's new job |
  | Request a reopen | Changing the vehicle, description or type |

  The message says: *"This job is partly closed. You can price items, receive what was already
  requested and add general items. To add anything else, request a reopen — or use the vehicle's
  new job 2026/9/R/612."*
- **Close fully:** allowed only when the closure check passes. That is the existing check (every
  requested line received, every shelf part issued, every part, oil and general line priced, labour
  rates, flat labour for services) **plus a new rule: work done is recorded**. For a repair that
  means at least one daily-work line; for a service, the flat labour. It applies to live jobs, not
  imported history.
- **Reopen request:** anyone who can edit jobs asks, with a reason. It appears in *Pending your
  approval* for holders of `jobs.reopen`. The requester cannot approve their own request (like the
  Phase 1 controls).
  - Approving returns the job to IN_PROGRESS, but **only if the vehicle has no other open job**. If
    the new job is still open, the approver is told to finish or close it first.
  - A reopened job keeps its original report month (memory: *job-reopen-month-anchor*).
- **The vehicle is free:** PARTIALLY_CLOSED does **not** count as open for the one-open-job rule, so
  a new job, or a job request approval, is allowed straight away.

**Permissions**

- `jobs.partial_close`: default holders are those of `jobs.close` (operational manager, workshop).
- `jobs.reopen_request`: default holders are those of `jobs.edit` (workshop, operational manager, manager).
- Approving a reopen: `jobs.reopen` (existing).

#### A.3 Groundwork both features need (W0)

1. **The 254 stuck REQUESTED job cards.** Most are imported history (imported with no end date).
   Each one blocks a new job for its vehicle, and would block the "new job after partial close"
   flow. Build a review screen:
   - list them with age, activity and cost;
   - suggest *Close*, *Reject (not carried out)* or *Keep*;
   - the owner confirms in bulk (decision W-D11). Nothing changes without that confirmation.
2. **One definition of "open".** Today `status NOT IN ('CLOSED','REJECTED')` is written separately in
   at least 8 places: the dashboard, reports (5×), assets, daily reports, daily-work job matching,
   the monthly report and the stores issue guard. Replace them with two named helpers in
   `lib/jobstate.js`:
   - `OPEN_SQL`: blocks the vehicle; excludes PARTIALLY_CLOSED;
   - `NOT_FINAL_SQL`: not fully closed yet; includes PARTIALLY_CLOSED.

   Each call site then chooses its meaning on purpose (table in §A.4).
3. **One guard for adding anything to a job**, `jobstate.checkAdd(job, kind, {date, user})`, called by
   every write path (there are about 20). Today the closed-job checks disagree: job-card screens use
   `editable()`, stores issues use `allow_closed`, and **a new MRN or a tyre/battery request can
   still be raised against a CLOSED job**. One guard fixes that now and carries the partial-close
   rules later.

#### A.4 How the features touch every linked section

| Section / file | Attendance (W1) | Partial close (W2) |
|---|---|---|
| Daily Work page (`public/app.js` Daily Work, `src/routes/dailywork.js`) | New Attendance & tally card; hours left and warning in the add forms; attended, booked and utilisation columns | Job matching (`jobForEntry`) treats a partly closed job as not open; its window ends at `partial_closed_at` |
| Daily work entry (`POST /daily-work`, `/bulk-log`, `/batch-update`, job-card daily work) | Over-booking warning or block (W-D3); a signed-off day is locked | `checkAdd('daily_work', date)` |
| Job card detail (`public/app.js`, `src/routes/jobcards.js`) | Shows attended vs booked for its mechanics (optional) | Partly close / Close fully / Request reopen buttons; locked add buttons; "continued as" link |
| State machine (`src/lib/jobstate.js`) | — | New state, transitions, `OPEN_SQL` / `NOT_FINAL_SQL`, `checkAdd` |
| Closure check (`src/lib/costing.js closureReadiness`) | — | Adds "work done recorded"; used by full close |
| One-open-job rule (`jobstate.checkOneOpenJob`; job create; job request approve) | — | Partly closed does not block |
| Stores: MRN, issues, stock issue, GRN (`src/routes/stores.js`) | — | MRN refused; GRN and issue of this job's own receipts allowed; other issues refused |
| Tyres & batteries (`src/routes/tyre_battery_requests.js`), stock cockpit reorder MRN | — | Refused on partly closed (and on CLOSED — the W0 fix) |
| Oil (`src/routes/oil.js`), general stock (`general_item_txns`) | — | Oil refused; **general items allowed** |
| Attach unassigned labour or receipts (`/parts/attach`, `/daily-work/attach`) | — | Refused |
| Costing refresh, vehicle-month rollup (`refreshJobTotals`, `recalcVehicleMonth`) | Unchanged | Unchanged — prices still roll up |
| Dashboard (`src/routes/dashboard.js`, `reports.js` counts) | "Today's tally: 3 red" tile | "Partly closed — awaiting prices" tile; open-job count excludes partly closed |
| Pending your approval (`reports.js /pending-approvals`) | Day sign-offs waiting (optional) | **Reopen requests** |
| Monthly cost report (`src/lib/monthly_cost_report.js`) | Optional "Attendance & utilisation" sheet; labour cost unchanged | Partly closed jobs in the **Closed** section of their partial-close month, flagged "prices pending" (W-D9) |
| Daily reports (`src/lib/daily_reports.js`) | Day tally in the daily summary snapshot | Partly closed jobs in "pending parts / prices" |
| Assets (`src/routes/assets.js` open jobs) | — | Partly closed shown separately from open |
| Permissions (`src/lib/capabilities.js`) | `attendance.record` / `signoff` / `unlock` | `jobs.partial_close`, `jobs.reopen_request` |
| Audit log | Every attendance change, sign-off and unlock | Partial close, full close, reopen request, approve, refuse |
| Imports / re-sync scripts (memory: *daily-work-reimport-hazard*) | The tally exposes duplicated rows (over-booked) | Imported history is not affected |
