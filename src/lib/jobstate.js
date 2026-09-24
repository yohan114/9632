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
  'CLOSED',
  'REJECTED',
];

// A card is "open" until it is closed or rejected — the single definition every
// open-job check and picker uses.
const OPEN_STATUSES = STATES.filter((s) => s !== 'CLOSED' && s !== 'REJECTED');
const OPEN_SQL = "status NOT IN ('CLOSED', 'REJECTED')";

// target -> { from:[...], cap:<capability>, action:label }
// Who may make each move is a CAPABILITY (src/lib/capabilities.js), not a list of role names, so a
// role an admin creates can be allowed a step. Admin holds every capability.
const TRANSITIONS = {
  APPROVED_TRANSPORT: { from: ['REQUESTED'], cap: 'jobs.approve_transport', action: 'transport_approve' },
  APPROVED_OPERATIONS: { from: ['APPROVED_TRANSPORT'], cap: 'jobs.approve_operations', action: 'ops_approve' },
  IN_WORKSHOP: { from: ['APPROVED_OPERATIONS'], cap: 'jobs.assign_workshop', action: 'assign' },
  IN_PROGRESS: {
    from: ['IN_WORKSHOP', 'WORK_COMPLETE', 'CLOSED'],
    cap: 'jobs.start',
    action: 'start_or_reopen',
  },
  WORK_COMPLETE: { from: ['IN_PROGRESS'], cap: 'jobs.complete', action: 'mark_complete' },
  CLOSED: { from: ['WORK_COMPLETE'], cap: 'jobs.close', action: 'close', gated: true },
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

/**
 * Validate a transition. Reopening CLOSED -> IN_PROGRESS is restricted and audited.
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
  // Reopening a CLOSED card is restricted and audited. The reopen permission is the whole
  // authority here — it must not then fall through to the target's own permission, which is about
  // who may START work, not who may undo a close.
  if (current === 'CLOSED') {
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

/** Can this user reopen a closed card? Mirrors checkTransition's CLOSED gate exactly. */
function canReopen(who = []) {
  return capsFor(who).includes(REOPEN_CAP);
}

module.exports = {
  STATES, TRANSITIONS, OPEN_STATUSES, OPEN_SQL, REOPEN_CAP,
  isValidState, nextStates, checkTransition, canReopen,
  openJobFor, checkOneOpenJob, duplicateOpenJobs,
};
