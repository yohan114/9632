'use strict';

// ===========================================================================
// Job Card lifecycle — an explicit state machine (brief §6).
// A card only moves forward when the step's conditions are met; closure is
// gated by the costing engine (every consumed line must be priced).
// ===========================================================================

const { get, all } = require('../db');

const STATES = [
  'REQUESTED',
  'APPROVED_TRANSPORT',
  'APPROVED_OPERATIONS',
  'IN_WORKSHOP',
  'IN_PROGRESS',
  'WORK_COMPLETE',
  'PARTIALLY_CLOSED',
  'CLOSED',
  'REJECTED',
];

// ---- what "open" means ------------------------------------------------------------------------
//
// Two questions that used to be one line of SQL copied into eight files:
//
//   OPEN      the card holds the vehicle. The one-open-card rule, "open job cards" counts, the card
//             new daily work and stock issues land on.
//   NOT FINAL the card is not finished with: prices, parts or records may still come in, so it
//             belongs in "pending parts", "awaiting price" and similar lists.
//
// They part company at partial close (docs/WORKSHOPONE_PLAN.md, W2): a PARTIALLY_CLOSED card is
// NOT FINAL (prices and already-requested parts still come in) but no longer OPEN — the vehicle
// has left, and a new card may be opened for it. Every caller says which of the two it means, so
// this was changed here, once.
const FINAL_STATUSES = ['CLOSED', 'REJECTED'];
const NOT_OPEN_STATUSES = ['PARTIALLY_CLOSED', 'CLOSED', 'REJECTED'];
const PARTIAL = 'PARTIALLY_CLOSED';
// The two states a card is REOPENED from (back to IN_PROGRESS).
const REOPENABLE = ['CLOSED', PARTIAL];
const quoted = (list) => list.map((st) => `'${st}'`).join(', ');
const col = (alias) => (alias ? `${alias}.status` : 'status');
/** SQL: the card holds the vehicle. `alias` is the job_cards table alias, if any. */
const openSql = (alias) => `${col(alias)} NOT IN (${quoted(NOT_OPEN_STATUSES)})`;
/** SQL: the card is not finished with (prices, parts or records may still come in). */
const notFinalSql = (alias) => `${col(alias)} NOT IN (${quoted(FINAL_STATUSES)})`;
const isOpen = (status) => !NOT_OPEN_STATUSES.includes(status);
const isFinal = (status) => FINAL_STATUSES.includes(status);
const OPEN_STATUSES = STATES.filter(isOpen);
const OPEN_SQL = openSql();

// target -> { from:[...], cap:<capability>, action:label }
// Who may make each move is a CAPABILITY (src/lib/capabilities.js), not a list of role names, so a
// role an admin creates can be allowed a step. Admin holds every capability.
const TRANSITIONS = {
  APPROVED_TRANSPORT: { from: ['REQUESTED'], cap: 'jobs.approve_transport', action: 'transport_approve' },
  APPROVED_OPERATIONS: { from: ['APPROVED_TRANSPORT'], cap: 'jobs.approve_operations', action: 'ops_approve' },
  IN_WORKSHOP: { from: ['APPROVED_OPERATIONS'], cap: 'jobs.assign_workshop', action: 'assign' },
  IN_PROGRESS: {
    from: ['IN_WORKSHOP', 'WORK_COMPLETE', 'CLOSED', PARTIAL],
    cap: 'jobs.start',
    action: 'start_or_reopen',
  },
  WORK_COMPLETE: { from: ['IN_PROGRESS'], cap: 'jobs.complete', action: 'mark_complete' },
  // Partly close: work finished, the vehicle has left, prices or records still missing. It has
  // its own route (a note, and optionally a new card for the vehicle) — POST /jobs/:id/partial-close.
  PARTIALLY_CLOSED: { from: ['IN_PROGRESS', 'WORK_COMPLETE'], cap: 'jobs.partial_close', action: 'partial_close', ownRoute: true },
  CLOSED: { from: ['WORK_COMPLETE', PARTIAL], cap: 'jobs.close', action: 'close', gated: true },
  // Rejection at either approval step.
  REJECTED: { from: ['REQUESTED', 'APPROVED_TRANSPORT'], cap: 'jobs.reject', action: 'reject' },
  // A rejection can also bounce back to REQUESTED (with a reason).
  REQUESTED: { from: ['APPROVED_TRANSPORT', 'REJECTED'], cap: 'jobs.return', action: 'return' },
};

function isValidState(s) {
  return STATES.includes(s);
}

/** Which target states are reachable from `current`. */
function nextStates(current) {
  return Object.keys(TRANSITIONS).filter((to) => TRANSITIONS[to].from.includes(current));
}

// Who may reopen a CLOSED card. Wider than admin because the people who notice a card was
// closed by mistake are the office and the workshop, not the owner — but narrower than the
// whole staff, because a reopen changes what the monthly cost report shows. (Seeded to
// operational_manager, manager and workshop — the old REOPEN_ROLES.)
const REOPEN_CAP = 'jobs.reopen';

// The capabilities of whoever is asking: a user object (req.user, with .caps) or, for older
// callers and tests, a plain list of role names.
function capsFor(who) {
  const lib = require('./capabilities');
  if (Array.isArray(who)) return lib.capsForRoles(who);
  if (who && Array.isArray(who.caps)) return who.caps;
  return lib.capsForRoles((who && who.roles) || []);
}

/** Is current -> target a reopen (a closed or partly closed card going back to work)? */
const isReopen = (current, target) => target === 'IN_PROGRESS' && REOPENABLE.includes(current);

/**
 * Validate a transition. Reopening CLOSED / PARTIALLY_CLOSED -> IN_PROGRESS is restricted and audited.
 * @returns {{ok:boolean, error?:string, def?:object}}
 */
function checkTransition(current, target, who = []) {
  const def = TRANSITIONS[target];
  if (!def) return { ok: false, error: `Unknown target state ${target}` };
  if (!def.from.includes(current)) {
    return { ok: false, error: `Cannot move ${current} -> ${target}` };
  }
  const held = capsFor(who);
  const label = (cap) => require('./capabilities').get(cap).label;
  // Reopening a CLOSED (or partly closed) card is restricted and audited. The reopen permission is
  // the whole authority here — it must not then fall through to the target's own permission, which
  // is about who may START work, not who may undo a close.
  if (isReopen(current, target)) {
    if (held.includes(REOPEN_CAP)) return { ok: true, def };
    return { ok: false, error: `Reopening a closed job needs the permission "${label(REOPEN_CAP)}"` };
  }
  if (!held.includes(def.cap)) {
    return { ok: false, error: `Needs the permission "${label(def.cap)}"` };
  }
  return { ok: true, def };
}

// ---------------------------------------------------------------------------
// One open job card per vehicle.
//
// A vehicle in the workshop has ONE live card; the next fault waits until it is
// closed. Enforced where a card is born (raised directly, or created when a job
// request is approved) and when a closed card is reopened.
//
// Grandfathering: the rule counts what is open right now, so the vehicles that
// already carry more than one open card keep them — they simply cannot gain
// another. `duplicateOpenJobs()` lists them so they can be worked off.
// Container cards (asset_id NULL — general workshop, daily-work holders) are
// exempt: they belong to no vehicle.
// ---------------------------------------------------------------------------

/** The open card blocking new work on this vehicle, or null. */
function openJobFor(assetId, opts = {}) {
  if (!assetId) return null; // container cards belong to no vehicle
  const params = [assetId];
  let sql = `SELECT id, job_no, status, type, description, requested_at
               FROM job_cards WHERE asset_id = ? AND ${OPEN_SQL}`;
  if (opts.excludeJobId) { sql += ' AND id <> ?'; params.push(opts.excludeJobId); }
  return get(sql + ' ORDER BY id LIMIT 1', ...params);
}

/**
 * Guard for creating/reopening a card on a vehicle.
 * @returns {{ok:boolean, error?:string, blocking?:object}}
 */
function checkOneOpenJob(assetId, opts = {}) {
  const blocking = openJobFor(assetId, opts);
  if (!blocking) return { ok: true };
  return {
    ok: false,
    blocking,
    error: `This vehicle already has an open job card (${blocking.job_no} · ${blocking.status}). Close it before opening another.`,
  };
}

/** Vehicles carrying more than one open card — the backlog to work off. */
function duplicateOpenJobs() {
  const rows = all(
    `SELECT j.asset_id, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec,
            COUNT(*) AS open_count
       FROM job_cards j JOIN assets a ON a.id = j.asset_id
      WHERE j.asset_id IS NOT NULL AND ${OPEN_SQL.replace(/status/g, 'j.status')}
      GROUP BY j.asset_id HAVING COUNT(*) > 1
      ORDER BY open_count DESC, a.code`);
  for (const r of rows) {
    r.jobs = all(
      `SELECT j.id, j.job_no, j.status, j.type, j.description, j.requested_at, j.total_cost,
              CAST(julianday('now') - julianday(j.requested_at) AS INTEGER) AS age_days
         FROM job_cards j
        WHERE j.asset_id = ? AND ${OPEN_SQL.replace(/status/g, 'j.status')}
        ORDER BY j.requested_at, j.id`, r.asset_id);
  }
  return rows;
}

// ---- adding anything to a card ------------------------------------------------------------------
//
// ONE ANSWER TO "may this go on that card?". It used to be decided in each place that writes to a
// card, and the places disagreed: the job-card screen locked a CLOSED card (editable()), stores
// issues asked for a confirmation, the Daily Work page did not check at all — and a new material
// request or tyre/battery request could still be raised against a card closed months ago.
//
// Every write path now calls checkAdd() with the KIND of thing it adds. What a finished card allows,
// per kind:
//
//   refuse       a NEW request (MRN, a line added to an MRN, a tyre/battery request). A closed card is
//                finished with; asking for more on it is how material ends up on the wrong job.
//   edit_closed  the card's own lines and details (daily work, parts, prices, attaching, editing).
//                Needs "Change items on a CLOSED job card" (jobs.edit_closed) — the old editable()
//                rule, which only ever locked CLOSED (a REJECTED card stayed editable, and still is).
//   confirm      a late issue from stores: allowed once the person confirms (allow_closed), as before.
//
// A PARTLY CLOSED card (W2) has its own column, PARTIAL_RULES below.
const ADD_RULES = {
  mrn: 'refuse',
  tb_request: 'refuse',
  daily_work: 'edit_closed',
  part: 'edit_closed',
  price: 'edit_closed',
  attach: 'edit_closed',
  edit: 'edit_closed',
  issue: 'confirm',
  general: 'confirm',
};

// What a PARTLY CLOSED card allows (docs/WORKSHOPONE_PLAN.md §3.2). The work is done and the
// vehicle has left; what is still coming is prices, the parts already asked for, and the records.
//
//   allow         pricing any line; general rack items.
//   own_receipts  issuing from stores: only what was received against THIS card's own requests.
//                 Other shelf stock or oil is refused.
//   until_date    daily work dated on or before the partial-close day (catching up). Later work
//                 belongs on the vehicle's new card.
//   refuse        everything else: a new request (MRN, tyre/battery), a new part or external line,
//                 claiming unassigned work or receipts, changing the vehicle, description or type.
//                 Nobody's permission gets past it — reopen the card instead.
const PARTIAL_RULES = {
  mrn: 'refuse',
  tb_request: 'refuse',
  daily_work: 'until_date',
  part: 'refuse',
  price: 'allow',
  attach: 'refuse',
  edit: 'refuse',
  issue: 'own_receipts',
  general: 'allow',
};

/** The card now holding the vehicle — the one a partly closed card's new work goes on. */
function successorFor(job) {
  if (!job) return null;
  return get(`SELECT id, job_no, status FROM job_cards WHERE continues_job_id = ? AND ${OPEN_SQL} ORDER BY id DESC LIMIT 1`, job.id)
    || (job.asset_id ? openJobFor(job.asset_id, { excludeJobId: job.id }) : null)
    || null;
}

/** The day a card was partly closed (YYYY-MM-DD), or null. */
const partialDay = (job) => (job && job.partial_closed_at ? String(job.partial_closed_at).slice(0, 10) : null);

function checkPartial(job, kind, { dates = [], ownReceipts = false } = {}) {
  const rule = PARTIAL_RULES[kind];
  // The caller's row may be a narrow SELECT; what the rules need is read here.
  if (job.partial_closed_at === undefined || job.asset_id === undefined) {
    job = get('SELECT id, job_no, status, asset_id, partial_closed_at FROM job_cards WHERE id = ?', job.id) || job;
  }
  if (rule === 'allow') return { ok: true };
  if (rule === 'own_receipts' && ownReceipts) return { ok: true };
  const day = partialDay(job);
  const given = (dates || []).filter(Boolean).map((d) => String(d).slice(0, 10));
  if (rule === 'until_date' && given.length && day && given.every((d) => d <= day)) return { ok: true };
  const next = successorFor(job);
  const error = rule === 'until_date' && given.length && day
    ? `Job ${job.job_no} was partly closed on ${day}. Work after that date goes on the vehicle's new job${next ? ` (${next.job_no})` : ''}.`
    : `This job is partly closed. You can price items, receive what was already requested and add general items. `
      + `To add anything else, request a reopen${next ? ` — or use the vehicle's new job ${next.job_no}` : ''}.`;
  return { ok: false, status: 409, body: { error, job_no: job.job_no, job_status: job.status, partly_closed: true,
    successor: next ? { id: next.id, job_no: next.job_no } : null } };
}

/**
 * May `kind` be added to this card? Returns { ok: true } or { ok: false, status, body } — the HTTP
 * status and JSON body to answer with (the existing shapes, so the screens need no change).
 * @param {object} job        a job_cards row (needs id, job_no, status)
 * @param {string} kind       one of ADD_RULES
 * @param {{user?: object, allowClosed?: boolean, dates?: string[], ownReceipts?: boolean}} [opts]
 *        dates: the work dates a daily-work write touches; ownReceipts: every line issued comes
 *        from this card's own receipts. Both only matter on a partly closed card.
 */
function checkAdd(job, kind, { user = null, allowClosed = false, dates = [], ownReceipts = false } = {}) {
  const rule = ADD_RULES[kind];
  if (!rule) throw new Error(`jobstate.checkAdd: unknown kind "${kind}"`);
  if (!job) return { ok: false, status: 404, body: { error: 'Job not found' } };
  if (job.status === PARTIAL) return checkPartial(job, kind, { dates, ownReceipts });
  if (!isFinal(job.status)) return { ok: true };
  if (rule === 'refuse') {
    return { ok: false, status: 409, body: {
      error: `Job ${job.job_no} is ${job.status}. Reopen it to ask for more items, or raise the request on the vehicle's open job card.`,
      job_no: job.job_no, job_status: job.status,
    } };
  }
  if (rule === 'edit_closed') {
    if (job.status !== 'CLOSED') return { ok: true };
    if (capsFor(user).includes('jobs.edit_closed')) return { ok: true };
    return { ok: false, status: 423, body: { error: 'Job is closed (locked)' } };
  }
  // confirm
  if (allowClosed) return { ok: true };
  return { ok: false, status: 409, body: {
    error: `Job ${job.job_no} is ${job.status} — confirm to record a late issue against it`,
    job_no: job.job_no, job_status: job.status, needs_confirm: true,
  } };
}

// ---- the switch -----------------------------------------------------------------------------------
// Partial close, the stricter full close and reopen REQUESTS are switched on together (settings
// table). Off: closing and reopening work exactly as they did before W2. A card that was partly
// closed while it was on keeps its state and its rules either way.
const PARTIAL_FLAG = 'jobs_partial_close_enabled';
function partialCloseEnabled() {
  const r = get('SELECT value FROM settings WHERE key = ?', PARTIAL_FLAG);
  return !!r && r.value === '1';
}

/** Can this user reopen a closed card? Mirrors checkTransition's CLOSED gate exactly. */
function canReopen(who = []) {
  return capsFor(who).includes(REOPEN_CAP);
}

module.exports = {
  STATES, TRANSITIONS, OPEN_STATUSES, OPEN_SQL, REOPEN_CAP, PARTIAL, REOPENABLE,
  FINAL_STATUSES, openSql, notFinalSql, isOpen, isFinal, isReopen, ADD_RULES, PARTIAL_RULES, checkAdd,
  successorFor, partialDay, PARTIAL_FLAG, partialCloseEnabled,
  isValidState, nextStates, checkTransition, canReopen,
  openJobFor, checkOneOpenJob, duplicateOpenJobs,
};
