# WorkshopOne — Updated Plan (v2)

_Date: 2026-09-24 · replaces the order of work in `SECURITY_ACCESS_MULTISITE_PLAN.md` (v1).
The v1 document still holds the full detail for the multi-site stages (2–7); this plan says what is
done, what comes first now, and designs the two new features in full._

---

## 1. Summary

The security and access work from v1 (Stage 0 and nearly all of Stage 1) is **built, tested and merged
into `main`**, but **not yet deployed to the VPS**. Two workshop features now come **before** the
multi-site stages:

1. **Mechanic attendance and a daily tally.** Every mechanic's on-time and off-time is recorded each
   day. The hours they actually worked must match the hours booked on jobs in Daily Work, day by day.
2. **Partial close of a job card.** When a job's work is finished but its prices or records are not
   yet complete, it can be **partly closed**. That locks it (only prices, already-requested items and
   general items can still be added), frees the vehicle for a **new job**, and allows only a
   **reopen request**. **Full close** needs every item priced and the work done recorded.

These build on a short groundwork stage (**W0**) that fixes things both features depend on. The
biggest of those: 254 job cards are stuck in REQUESTED, and each one blocks a new job for its vehicle.

**Order:** deploy what is merged (now, in parallel) → W0 → W1 attendance → W2 partial close → W3 reports
→ approval limits → multi-site Stages 2–7.
**Effort for W0–W3:** about **21 developer-days** (4–5 weeks for one developer).

---

## 2. Where we are

| Item (v1 plan) | Status | Where |
|---|---|---|
| Stage 0 — security fixes (headers, CSRF check, XSS fix, passwords, sessions, backups, Cloudflare lock script) | ✅ merged | PR #4 |
| Stage 1 — custom roles and permissions (70 capabilities, roles as data, guardrails) | ✅ merged | PR #5 |
| Stage 1 — two-factor sign-in | ✅ merged | PR #6 |
| Phase 1 controls — segregation of duties, `/api` needs a session | ✅ merged | PR #7 |
| Stage 1 — signed-in devices, idle timeout, session expiry fix | ✅ merged | PR #8 |
| Vehicle lubricant capacities on `main` | ✅ merged | PR #9 |
| Crash log (start / stop / crash written to a file; a crash exits) | 🟡 built, **no PR yet** | branch `claude/crash-log` |
| **Deploy all of the above to the VPS** | ❌ **not done** | §4, Step 0 |
| Stage 1 — approval limits | ⏸ waits for your amounts (decision D7) | §4 |
| Stages 2–7 — workshops, sites, stores, scoping, reports, field, operations | ⏳ not started | v1 plan §4 |

The office server (port 1929) runs `claude/crash-log` = `main` + the crash log.

---

## 3. The two new features

### 3.1 Mechanic attendance and the daily tally (W1)

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

### 3.2 Partial close, full close and reopen requests (W2)

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

### 3.3 Groundwork both features need (W0)

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

   Each call site then chooses its meaning on purpose (table in §3.4).
3. **One guard for adding anything to a job**, `jobstate.checkAdd(job, kind, {date, user})`, called by
   every write path (there are about 20). Today the closed-job checks disagree: job-card screens use
   `editable()`, stores issues use `allow_closed`, and **a new MRN or a tyre/battery request can
   still be raised against a CLOSED job**. One guard fixes that now and carries the partial-close
   rules later.

### 3.4 How the features touch every linked section

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

---

## 4. Updated order of work

### Step 0 — Deploy what is merged (now, in parallel; your action on the VPS)

These fixes are on `main` but the live server does not have them yet:

1. Check the branch: `git -C /opt/workshopone/app branch --show-current` must say `main`.
2. `node scripts/admin.js audit-passwords`, and fix any account it lists.
3. `sudo bash /opt/workshopone/app/deploy/update.sh`.
4. Back up `/opt/workshopone/data/mfa.key`.
5. Run `deploy/cloudflare-refresh.sh` (dry run), then `--apply`.
6. Add the Cloudflare rate-limit rule, install the verify timer, and set up the off-site copy (`deploy/VPS.md`).
7. Enrol admin two-factor, then tick "Require" on the admin role.
8. Open and merge the crash-log PR (`claude/crash-log`).

### Stage W0 — Groundwork (3 days)

- **Goal:** one meaning of "open", one guard for adding to a job, and the stuck REQUESTED jobs cleared.
- **Tasks:**
  1. The review screen and bulk action for the 254 REQUESTED jobs (confirm first; audited).
  2. `OPEN_SQL` / `NOT_FINAL_SQL` helpers; replace the 8+ inline copies.
  3. `jobstate.checkAdd()`, wired into every write path. Refuse MRNs and tyre/battery requests on CLOSED jobs.
- **Rules:** *job-reopen-month-anchor* (reopen gates unchanged); *attach-unassigned-to-job* (moves still recompute).
- **Done when:**
  - a test calls every add path against a CLOSED job and each is refused, unless allowed on purpose;
  - no inline `NOT IN ('CLOSED','REJECTED')` is left.
- **Rollback:** normal `update.sh` rollback. The REQUESTED clean-up is audited and reversible, one job at a time.

### Stage W1 — Attendance and the daily tally (7 days)

- **Tasks:**
  1. Tables and settings.
  2. `lib/attendance.js`, the tally engine, using `splitMechanics` / `resolveMechanic`.
  3. Routes: day grid get/save, sign-off, unlock, month summary.
  4. The Attendance & tally card on Daily Work.
  5. Hours-left hints and warnings in the three entry forms.
  6. Attended, booked and utilisation columns in Monthly Labour Working Hours.
  7. Lock daily work on a signed-off day.
  8. Capabilities; audit; tests (the crew-line rule, overnight shift, absent with work, unmatched names).
- **Rules:** *daily-work-hours-are-manhours*, *workshopone-costing-rules* (no cost change), *list-each-thing-once*.
- **Done when:**
  - a sample week of real data tallies correctly;
  - crew lines count per person;
  - no job's labour cost changes;
  - a signed-off day refuses edits.
- **Rollback:** an attendance feature flag. Daily Work works exactly as before without it.

### Stage W2 — Partial close, full close and reopen requests (8 days)

- **Tasks:**
  1. The `PARTIALLY_CLOSED` state. SQLite cannot change a CHECK constraint, so `job_cards` is rebuilt
     in place with ids kept and foreign keys off during the swap. This is the same pattern
     `src/db/index.js` already uses for `tb_specs`. Run it on a staging copy first. *Alternative if
     you prefer no rebuild:* keep status WORK_COMPLETE plus a `partial_closed_at` flag. The W0 helpers
     make either work, but a real status is clearer on screens and in reports.
  2. The columns `partial_closed_at`, `partial_closed_by`, `partial_note`, `continues_job_id`.
  3. Transitions and capabilities.
  4. The partial-close rules inside `checkAdd`.
  5. The "work done recorded" closure rule.
  6. Full close.
  7. `job_reopen_requests` (request / approve / refuse, requester ≠ approver, one-open check on approve).
  8. "Open a new job for this vehicle" with the back-link.
  9. Job card UI: buttons, locked controls, status badge and colour, jobs-list filter, dashboard tile, approval queue.
  10. Tests: every allowed and refused action, the one-open rule, a reopen blocked by the new job, the report month.
- **Rules:** *job-reopen-month-anchor* (report month kept; reopen still needs a reason); *vehicle-monthly-costs-rollup*;
  *attach-unassigned-to-job*; *external-cost-excluded*.
- **Done when:**
  - a partly closed job refuses exactly the listed actions;
  - the vehicle gets a new job;
  - a full close is refused until everything is priced and the work is recorded;
  - an approved reopen works only when the vehicle has no other open job.
- **Rollback:** the old flow stays available behind a flag for one release. No partly closed job
  exists until someone uses the button.

### Stage W3 — Reports and dashboards (3 days)

- **Tasks:**
  1. Monthly cost report: partly closed jobs in Closed with a "prices pending" flag (per W-D9); an
     optional utilisation sheet.
  2. The day tally in the daily summary snapshot.
  3. Excel export of the tally.
  4. Dashboard tiles.
- **Rules:** *job-cost-report-gold-model* (section rules unchanged apart from the documented addition).
- **Done when:** the June 2026 report is unchanged, and a test month with a partly closed job shows it once, flagged.

### Then

1. **Approval limits** (Stage 1 remainder, needs D7).
2. **Multi-site Stages 2–7** as in the v1 plan. The attendance and partial-close designs already
   leave room for workshop scoping (Stage 3) and per-workshop mechanics (Stage 4).

---

## 5. Decisions needed from you

| # | Question | Recommended |
|---|---|---|
| W-D1 | Default shift and break? | 08:00–17:00, 60 min lunch |
| W-D2 | How close must worked and booked be to count as matched? | 15 minutes |
| W-D3 | When work would over-book a mechanic: warn or block? | Warn at entry; block the day sign-off |
| W-D4 | Day sign-off: who, by when, and does it lock the day? | Workshop supervisor, by the next morning; locked, manager unlocks with a reason |
| W-D5 | Who is tracked: all 32 mechanics, including staff and foremen at Rs 0? Helpers too? | All active mechanics |
| W-D6 | A mechanic working at a project site that day: present with hours, or a separate status? | Present, with a note "at site X" |
| W-D7 | Must some work done be recorded before a partial close? | Yes (or a written reason) |
| W-D8 | Daily work on a partly closed job: only dates up to the partial close? | Yes; later dates go on the new job |
| W-D9 | Which report month does a partly closed job belong to? | The partial-close month (Closed, flagged), with late prices landing in that month — the same principle as your reopen rule |
| W-D10 | Should fully CLOSED jobs also use reopen *requests*, instead of the direct reopen? | Yes, one flow for both |
| W-D11 | The 254 REQUESTED jobs: what to do with each group? | Imported with no activity in 90 days → reject "not carried out", after you review the list |
| W-D12 | "Close on date" (backdating) for an incomplete job? | Becomes "partly close on date"; a backdated full close needs the full check |
| W-D13 | Overnight or split shifts (two in/out pairs a day)? | Overnight yes; split shifts later if needed |

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Crew lines or unresolved names make the tally wrong | Same resolver as costing; an "unmatched names" list; tests on real crew lines |
| Old imported daily work over-books mechanics | The tally only runs from the attendance start date |
| One add path forgets the partial-close rule | A single `checkAdd` guard; a test calls every path |
| Changing the status CHECK on `job_cards` (table rebuild) | The in-place rebuild pattern already proven on `tb_specs` (ids and references kept); staging copy first; `update.sh` backup and rollback; or the flag alternative in W2 |
| Partly closed jobs slip through in reports | Two named helpers, not inline SQL; the report test covers a partly closed job |
| A reopen collides with the vehicle's new job | Approval checks the one-open rule and says which job to finish first |
| Staff find a second screen a chore | Quick-fill buttons; entry takes seconds; sign-off reminders on the dashboard |

---

## 7. Timeline (one developer)

| Week | Work |
|---|---|
| 0 | Step 0: deploy to the VPS (you) · crash-log PR |
| 1 | W0 groundwork · your answers to W-D1…W-D13 |
| 2–3 | W1 attendance and tally → test on the office server |
| 3–4 | W2 partial close and reopen requests → test on the office server |
| 5 | W3 reports and dashboards → PRs → deploy |
| 6+ | Approval limits, then multi-site Stages 2–7 (v1 plan) |
