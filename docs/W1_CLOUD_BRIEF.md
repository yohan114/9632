Build Stage W1 of WorkshopOne: mechanic attendance and the daily tally.

REPO AND BRANCH
- Repo yohan114/9632. Start from main (it holds W0 and the crash-log change).
  Create branch claude/w1-attendance. Commit there and push that branch. Do NOT open a PR, do NOT
  merge, do NOT touch main. The owner tests it on the office server first.
- The full design is docs/WORKSHOPONE_PLAN.md (§3.1, §3.4, Stage W1 in §4, decisions in §5).
  This brief is the short version and wins where they differ.
- The repo is PUBLIC: never commit passwords, keys, database files or security plan documents.
- Node/Express + better-sqlite3, vanilla SPA in public/app.js. Tests: `npm test` (node --test).
  Two tests fail without the office database (monthly_cost_zero_value: "new / unpopulated month…"
  and "historical data (June 2026)…"). That is expected. Everything else must pass.
- The owner's English is a second language: keep screen text short and plain.

WHAT THE WORKSHOP GETS
1. Daily Work page, new card "Attendance & day tally". Pick a day; one row per ACTIVE mechanic:
   In, Out, Break, Worked, Booked on jobs, Difference, Status.
   - Quick fill: "All present 08:00-17:00" and "Copy yesterday".
   - Status per person: present / absent / leave / half_day / holiday, plus a note
     (a mechanic at a project site = present with a note "at site X").
2. The tally, per mechanic per day:
   - Matched: |worked - booked| <= tolerance (15 min).
   - Unbooked: worked > booked. One click books the rest to the General Workshop card
     (GENERAL-WS, legacy_ref 'general-workshop'), or records a reason.
   - Over-booked: booked > worked (always a mistake).
   - No attendance: work booked, no in/out recorded.
   - Absent with work: absent/leave but has booked work.
3. Day sign-off: a supervisor signs off a day once nobody is red. A signed-off day's attendance AND
   daily work are locked; unlocking needs attendance.unlock and a reason.
4. At the point of entry (Daily Work form, quick grid / bulk-log, job-card daily work): show each
   mechanic "attended 8.0 h · booked 6.5 h · 1.5 h left", and WARN (not block) if the entry would
   over-book them. Over-booking blocks only the sign-off.
5. Monthly Labour Working Hours table (public/app.js, "Monthly Labour Working Hours" card): add
   Attended, Booked and Utilisation % per mechanic.

HOW IT IS COUNTED (owner-confirmed rules, do not change)
- Worked = (Out - In) - Break. Out earlier than In = overnight shift. Absent/leave/holiday = 0.
  Split shifts (two in/out pairs) are NOT needed now.
- Booked = sum of job_daily_work.hours over every line that names the mechanic, general-workshop
  lines included, external lines (is_external) excluded.
- job_daily_work.hours is ALREADY PER PERSON. A crew line "Govinda, Vinod — 4" means 4 h EACH, and
  each named mechanic counts the full 4 h. Never divide by crew size, never multiply.
- Resolve names with src/lib/mechanics.js (splitMechanics, resolveMechanic). A name that does not
  resolve shows as "unmatched name" with a link to the Alias Queue; it is not silently dropped.
  Note splitMechanics does not split on spaces ("Theminda Krishna" is one token).
- LABOUR COSTING DOES NOT CHANGE. Job labour stays booked hours x rate (computeJobCost in
  src/lib/costing.js, crew = full hours each). Attendance only adds a check and a utilisation
  figure. A test must prove no job's labour cost changes.
- Only from the attendance start date (a setting). Days before it are never flagged; old imported
  daily work has duplicates and would show as false over-bookings.

DATA
- New tables in src/db/schema.sql (CREATE TABLE IF NOT EXISTS, same style as
  vehicle_lubricant_capacities):
  - mechanic_attendance: mechanic_id -> mechanics.id, work_date, time_in, time_out,
    break_minutes, status CHECK(present|absent|leave|half_day|holiday), note, recorded_by,
    created_at, updated_at, UNIQUE(mechanic_id, work_date).
  - workday_signoffs: work_date (unique), signed_by, signed_at, unlocked_by, unlocked_at,
    unlock_reason.
- Settings in the existing key/value `settings` table: attendance_enabled (feature flag; off =
  Daily Work behaves exactly as before), attendance_start_date, default shift 08:00-17:00,
  default break 60 min, tolerance 15 min.

PERMISSIONS (Stage 1 capabilities, src/lib/capabilities.js)
- Add with C(key, module, label, legacyRoles, group):
  attendance.record (legacy: workshop, manager) — enter/change today's and yesterday's attendance;
  attendance.signoff (workshop, manager); attendance.unlock (manager, operational_manager).
- Server: requireCap / hasCap. Screens: canDo('...'). A test FAILS if a route uses requireRole /
  hasRole or app.js uses can(role) — never check role names.
- Reading attendance follows the Daily Work module clearance (the daily-work routes are already
  API-gated by requireModule in src/server.js).
- Audit every attendance change, sign-off and unlock with audit.record({ userId, entity, entityId,
  action, before, after, reason }) (src/lib/audit.js).

WHERE TO PLUG IN
- New src/lib/attendance.js: the tally engine (worked, booked, status per mechanic per day; month
  summary). New routes file for: day grid GET/save, sign-off, unlock, month summary, and a small
  "hours left" lookup the entry forms call.
- The signed-off-day lock goes into the single daily-work guard W0 created:
  assertDailyWorkAllowed() in src/routes/dailywork.js (POST /, PATCH /:id, DELETE /:id,
  batch-update, bulk-log) and the job-card daily-work routes in src/routes/jobcards.js, which use
  jobstate.checkAdd(job, 'daily_work'). A locked day must refuse all of them, including a batch
  (refused whole, nothing saved).
- Use jobstate.openSql / notFinalSql / isOpen for any "is this job open" question; never write
  NOT IN ('CLOSED','REJECTED') inline (a W0 test scans for it).

TESTS (new test/w1_attendance.test.js; temp DB via process.env.DB_PATH like the other tests)
- crew line counts full hours for each named mechanic; overnight shift; absent with work;
  no attendance; unmatched name; general-workshop line counted, external line not;
  tolerance edge (exactly 15 min = matched);
- days before the start date are not flagged; flag off = Daily Work unchanged;
- no job's labour cost changes after attendance is recorded;
- a signed-off day refuses every daily-work write path and attendance edits; unlock needs the
  capability and a reason and is audited; sign-off is refused while anyone is red;
- permissions: a role without attendance.record gets 403.
- After the tests pass, break each key guard on purpose once and check a test fails.

WHEN DONE
Commit on claude/w1-attendance, push the branch, and report in plain English: what was built,
test results, anything you were unsure about. The office server update and the check against a
real week of data are done later on the office PC.
