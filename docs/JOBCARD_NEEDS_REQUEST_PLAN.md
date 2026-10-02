# Plan — a job card is opened by the workshop, and only from an approved job request

_Status: plan only. Nothing is built yet._

---

## 1. What is being changed

The approval road stays exactly as it is today:

| Step | Who signs | Capability |
|---|---|---|
| **RQ** — raise the request | Transport Assistant Manager | `jobrequests.create` |
| **Certify** | Transport Manager | `jobrequests.certify` |
| **Approve** | Operational Manager | `jobrequests.approve` |

Two things change after that:

1. **Approval no longer makes the job card.** Today `POST /api/job-requests/:id/approve`
   inserts a job card itself (`src/routes/jobrequests.js:183`). It will stop doing that. An
   approved request sits in a new queue — *approved, waiting for the workshop* — until the
   workshop opens the card.
2. **A job card can only be opened by the workshop, and only against an approved job
   request.** `POST /api/jobs` will require a `job_request_id` that is approved and not yet
   linked to a card. No request, no card.

So: **request → certify → approve → (workshop) job card**, with the card carrying a
permanent link back to the request it came from.

---

## 2. Where the code is today

| What | Where |
|---|---|
| The 3-stage request flow, and the auto-create on approval | `src/routes/jobrequests.js` (approve: lines 161–215) |
| The direct "New Job Card" route | `src/routes/jobcards.js:179–224` (`requireCap('jobs.create')`) |
| Who may open a card | `src/lib/capabilities.js:45` — `jobs.create`, template `['transport_manager', 'workshop']` |
| The request → card pointer | `job_requests.job_id` (`src/db/index.js:64`) |
| The Requests list and its steps | `src/lib/jobs_flow.js` (`STEPS`, `shapeRequest`, `counts`) |
| The Requests tab and the modals | `public/app.js` — `newJobModal` (3920), Requests toolbar (1689), JR detail (9161) |
| Lifecycle / transitions | `src/lib/jobstate.js` (`TRANSITIONS`) |

---

## 3. Decisions to confirm

These change the amount of work, so they are called out rather than assumed. The
recommendation is what the plan below is written against.

| # | Question | Recommendation |
|---|---|---|
| **D1** | **Field breakdowns.** A machine stops at a site and `src/lib/field.js:212` opens a card on the spot, with no request. Must it now wait for a 3-stage approval? | **Exempt.** A breakdown cannot wait for three signatures. The card is already flagged `breakdown = 1`, and the plan keeps that one door open. (If you want the paperwork to catch up, we can later let a request be *attached* to an existing breakdown card.) |
| **D2** | **Cards already in the live database** at `REQUESTED` or `APPROVED_TRANSPORT`, raised the old way. | **Let them finish the old way.** `jobs.approve_transport` / `jobs.approve_operations` and those two statuses stay, so the backlog drains. Only *new* cards need a request. |
| **D3** | **The card's starting status.** The request already carries both approvals. | **`APPROVED_OPERATIONS`** — the same status the auto-create uses today, so the road, the Monitor and the "approved, not started" counter keep working unchanged. The workshop then presses "In workshop" as it does now. The modal will offer a tick to do both in one go. |
| **D4** | **The one-open-card-per-vehicle rule.** Today it blocks *approval*. | **Move it to card creation.** Approval becomes a soft warning (the same wording the request form already uses), so an approved request is never stuck behind an unrelated open card; the hard block bites when the workshop opens the card. |
| **D5** | **Container and imported cards** (`GENERAL-WS`, `auto-container-labour`, migrations, seed). | **Exempt.** They are cost containers and history, not repairs. The rule lives in the route, not as a `NOT NULL` column, precisely so these are untouched. |

---

## 4. The work, step by step

### 4.1 Database — `src/db/index.js`

- Add the forward pointer, with the repo's idempotent helper:
  `ensureColumn('job_cards', 'job_request_id', 'INTEGER REFERENCES job_requests(id)')`
  plus `CREATE INDEX IF NOT EXISTS idx_jobs_job_request ON job_cards(job_request_id)`.
- **Backfill** from the existing reverse pointer, so every card ever made by an approval
  keeps its link:
  `UPDATE job_cards SET job_request_id = (SELECT r.id FROM job_requests r WHERE r.job_id = job_cards.id) WHERE job_request_id IS NULL`.
- `job_requests.job_id` **stays** — `jobs_flow.js`, `routes/dashboard.js`,
  `routes/reports.js`, `lib/operations.js` and the printable form all read it. Both
  pointers are written in the same transaction and must agree.
- No `NOT NULL`, no trigger. The gate is a route check (see D5).

### 4.2 Approval stops making the card — `src/routes/jobrequests.js`

- In `/:id/approve`: delete the `INSERT INTO job_cards`, the two mirrored `job_approvals`
  rows and the `costing.refreshJobTotals` call. It now only stamps the request
  `approved` + the approver's e-signature, and writes the `job_request_approvals` row.
- Replace the hard one-open-card block with the same soft `open_job` heads-up the create
  route already returns (D4).
- The response becomes `{ request, open_job }` — no `job` key. The front end reads
  `r.job.job_no` today (`public/app.js:9226`); that toast changes to
  "approved — the workshop can now open the job card".
- Fix the two comment blocks at the top of the file and in `src/migrate/20_job_requests.js`
  that say approval "auto-creates a job card".

### 4.3 The card is opened from a request — `src/routes/jobcards.js`

`POST /api/jobs` keeps `requireCap('jobs.create')` and gains a gate, in this order, before
anything is written:

1. `job_request_id` is required → `400` "A job card is opened from an approved job
   request. Pick the request."
2. The request must exist and be within reach — reuse `scope.jobRequestRefusal` → `403`.
3. `approval_status` must be `approved` → `409`, naming the step it is waiting at
   ("waiting for the Transport Manager to certify" / "for the Operational Manager").
4. It must not already have a card → `409` with a link to that card.
5. The one-open-card guard on the request's vehicle → `409` with `blocking_job` (unchanged
   shape, so the front end's existing handling keeps working).

The insert then takes **the request's own** vehicle, project, type, severity and
description — not the body — so the card cannot drift from the signed paper. The workshop
may still choose the workshop that does the repair, and may add to the description
(appended, with the request's text kept). Status `APPROVED_OPERATIONS`, with
`approved_transport_at` / `approved_ops_at` stamped from the request's certify/approve
times rather than `datetime('now')` — the card should carry the dates that were signed.

In the same transaction: the two mirrored `job_approvals` rows (moved here verbatim from
the approve route), `job_cards.job_request_id`, and `job_requests.job_id`.

Optional tick in the modal: *take it into the workshop now* → one extra
`IN_WORKSHOP` transition, gated by `jobs.assign_workshop`.

### 4.4 Only the workshop — `src/lib/capabilities.js`, `src/routes/access.js`

- `jobs.create`: template drops `transport_manager`, leaving `['workshop']`; the label
  becomes "Open a job card from an approved job request".
- **This does not revoke anything on its own.** `seedCapabilities()` is
  `INSERT OR IGNORE`, and a revoked capability is stored as `granted = 0` rather than
  deleted — so the existing `(transport_manager, jobs.create, 1)` row survives. A
  migration step must explicitly write
  `setCapability('transport_manager', 'jobs.create', false)`, once. Same for any custom
  role an admin has already given it: the migration should report which roles hold it so
  you can decide, rather than silently stripping them.
- `src/routes/access.js:185,189`: drop `jobs.create` from the `operator` preset and leave
  it in `manager` only if you want managers to be able to; the presets are starting
  templates, not live permissions, so this only affects newly created roles.

### 4.5 The queue the workshop works from — `src/lib/jobs_flow.js`

- Split the `approved` step in two: **`to_open`** (approved, `job_id IS NULL`) and
  `approved` (the card exists). Add `to_open` to `STEPS` and to `OPEN_STEPS`, so it counts
  as work waiting and appears on the Monitor.
- `WAITING.to_open = 'Workshop to open the job card'`.
- `shapeRequest` gains `can.open_card = step === 'to_open' && hasCap(user, 'jobs.create')`.
- `roadOf` needs one small addition: a `to_open` request has passed *requested* and
  *approved*, and waits at *in workshop*. Today `roadOf(null)` stops at *approved*. Add an
  `approved: true` option rather than inventing a fake status.
- `counts()` splits its `approved` tally on `job_id IS NULL`.

### 4.6 Screens — `public/app.js`

1. **`newJobModal` (3920)** → rewritten as *Open job card from an approved job request*:
   a picker of the approved-and-unlinked requests in reach (new
   `GET /api/job-requests?step=to_open`, or reuse `/api/job-flow/requests?step=to_open`),
   showing JR no · vehicle · work. On pick, the vehicle, type, severity, project and
   description are shown **read-only** from the request. The vehicle picker, the type and
   severity selects and the free-text description go away — they are the request's now.
   The workshop select and the one-open-card block panel stay as they are.
2. **Requests toolbar (1689)** and **Job Cards toolbar (2075)**: the `+ New Job Card`
   button opens the picker. On the Job Cards page it reads "+ Open job card from request".
   When nothing is waiting it is disabled with the reason, rather than hidden.
3. **New `to_open` step pill** in the Requests tab, with its count — this is the
   workshop's inbox.
4. **JR detail (9161)**: when `approved` and no card yet, show
   "✅ Approved — waiting for the workshop to open the job card", with an *Open job card*
   button for whoever holds `jobs.create`. The existing
   "✅ Approved — job card created: …" line stays for the linked case.
5. **Sign modal (9205)**: the line "Approving will create the job card and route it to the
   workshop" becomes "Approving clears this request — the workshop then opens the job
   card." The approve toast loses `r.job.job_no`.
6. **Job card detail**: show the request it came from — `JR-0007` as a link next to the
   job number — so the card and the signed paper are one click apart.
7. **Printable job request** (`jobrequests.js` print.html): the "Job Card" cell's
   `(created on approval)` placeholder becomes `(opened by the workshop)`.

### 4.7 Dashboard — `src/routes/dashboard.js`

Add a workshop-facing block to the inflow group, keyed on `jobs.create`: approved requests
with no card yet, same row shape as the existing `jr_certify` / `jr_approve` entries,
`action: 'Open job card'`. Without it the workshop has no prompt that work is waiting.

### 4.8 The exempt doors stay open

No change to these, but each needs a one-line comment saying *why* it is exempt, so the
next reader does not "fix" it:

| File | What | Why exempt |
|---|---|---|
| `src/lib/field.js:212` | breakdown at a site | D1 — cannot wait for three signatures |
| `src/lib/job_close.js:139` | continuation card at partial close | inherits the parent's `job_request_id`, so the chain stays traceable. Still gated by `jobs.create` |
| `src/lib/workshops.js:114`, `src/routes/stores.js:99` | the `GENERAL-WS` container | a cost container, not a repair |
| `src/routes/dailywork.js:153` | the monthly `auto-container-labour` card | same, and created `CLOSED` |
| `src/migrate/*`, `src/db/seed.js` | imported history and demo data | `is_historical` / seeded |

---

## 5. Tests

**Rewritten** (they currently assert that approval makes the card):

| File | Line | Change |
|---|---|---|
| `test/jobs_p1_flow.test.js` | 323–333 | approval returns no `job`; the row moves to `to_open`; opening the card then moves it to `approved` |
| `test/one_open_job.test.js` | 145–161 | approval now succeeds with a warning; the **card creation** is what gets the `409` |
| `test/stage2_workshops.test.js` | 179 | the card's workshop is checked after the workshop opens it |
| `test/stage3_scoping.test.js` | 190, 198 | same, and another workshop's approved request cannot be opened |
| `test/dashboard_and_section_access.test.js` | 165–209 | the `jobs.create` preset/label assertions |

**New — `test/jobcard_from_request.test.js`:**

- no `job_request_id` → `400`
- a request still `requested` or `certified` → `409`, naming the step it waits at
- a `rejected` request → `409`
- a request that already has a card → `409`, carrying that card
- a role without `jobs.create` (the Transport Manager, after the migration) → `403`
- another workshop's request, with the separate-workshops switch on → `403`
- the vehicle has an open card → `409` with `blocking_job`
- the happy path: status `APPROVED_OPERATIONS`; vehicle, type, severity and description
  taken from the request, not the body; both `job_approvals` rows present; both pointers
  set and agreeing; `approved_*_at` carrying the signed dates
- the exempt doors still work: a breakdown card, a partial-close continuation card (with
  the parent's `job_request_id` inherited) and the `GENERAL-WS` container
- the migration: the backfill links an old approval-made card, and
  `transport_manager` no longer holds `jobs.create`

`npm test` is `node --test`; `test/public_js_syntax.test.js` will catch front-end syntax
slips.

---

## 6. Order of work

1. Schema column, index and backfill (4.1) — on its own, changes no behaviour.
2. The new gate on `POST /api/jobs` (4.3) + the capability change and its migration (4.4).
3. Approval stops making the card (4.2).
4. The `to_open` step and counts (4.5).
5. Screens (4.6) and the dashboard block (4.7).
6. Tests (5), then `README.md` (the demo-account table at line 31 still reads
   "Transport Manager (raise + first approval)") and `docs/WORKSHOPONE_PLAN.md`.

Steps 2 and 3 land together: between them, either no card can be made at all, or two can.

---

## 7. What you will see afterwards

- **Transport Assistant Manager** — unchanged: raises the request.
- **Transport Manager** — certifies. **Can no longer open a job card.**
- **Operational Manager** — approves. The approval no longer makes a card; it clears the
  request for the workshop.
- **Workshop** — a new inbox: *approved requests waiting for a job card*. One button opens
  the card, pre-filled from the signed request, already past both approval gates.
- Every new job card names the job request it came from, and every approved request names
  the card it became.
