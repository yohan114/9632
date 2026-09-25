'use strict';

// ===========================================================================
// Job Cards: the Monitor and one list of everything waiting for a decision (job cards plan, Part 1).
//
// Every job walks the same road:
//
//   Requested → Approved → In workshop → Working → Work done → Prices in → Closed
//
// It starts one of two ways. A JOB REQUEST (JR) is raised by transport, certified by the Transport
// Manager and approved by the Operational Manager; that approval makes the card. A CARD RAISED
// DIRECTLY is approved by transport and then by operations. The Requests list shows both side by
// side, with the reopen requests waiting for a manager and the requested cards that never moved
// (src/lib/job_review.js). Nothing new is stored: every row is read from the request, the card and
// their approvals, and each button calls the route that already does that step.
//
// Imported history is left out (JC-D10): an imported card is never a to-do — except a stuck one,
// which is exactly what the review screen is for.
// ===========================================================================

const { get, all } = require('../db');
const scope = require('./scope');
const jobstate = require('./jobstate');
const review = require('./job_review');
const { meets, levelForRoles } = require('./permissions');

const isAdmin = (user) => require('./access_rules').isAdmin(user);
const hasCap = (user, cap) => require('./auth').hasCap(user, cap);
/** May this person see a module's records at all (the same test as requireModule's GET; admin: always)? */
const sees = (user, module) => meets(levelForRoles((user && user.roles) || [], module), 'view');
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const day10 = (v) => (v ? String(v).slice(0, 10) : null);
const daysSince = (d, now = today()) => (d ? Math.max(0, Math.round((Date.parse(now) - Date.parse(day10(d))) / 86400000)) : null);

// ---- the road ------------------------------------------------------------------------------------
const ROAD = [['requested', 'Requested'], ['approved', 'Approved'], ['workshop', 'In workshop'], ['working', 'Working'],
  ['done', 'Work done'], ['priced', 'Prices in'], ['closed', 'Closed']];
// The milestone a card's status waits at (its index in ROAD); CLOSED has passed them all.
const AT = { REQUESTED: 1, APPROVED_TRANSPORT: 1, APPROVED_OPERATIONS: 2, IN_WORKSHOP: 3, IN_PROGRESS: 3,
  WORK_COMPLETE: 5, PARTIALLY_CLOSED: 5, CLOSED: ROAD.length };

/** The road of a card by its status — or of a request not yet a card (`status` null). */
function roadOf(status, { rejected = false } = {}) {
  const now = rejected || status === 'REJECTED' ? -1 : (status ? AT[status] : 1);
  return ROAD.map(([key, label], i) => {
    let state;
    if (now === -1) state = i === 0 ? 'done' : (i === 1 ? 'stop' : 'todo');
    else state = i < now ? 'done' : (i === now ? 'now' : 'todo');
    return { key, label, state };
  });
}

// ---- the Requests list ---------------------------------------------------------------------------
//   open         everything waiting for somebody's decision: the next five together
//   to_certify   job requests waiting for the Transport Manager
//   to_approve   job requests waiting for the Operational Manager
//   transport    cards raised directly, waiting for transport approval
//   operations   cards approved by transport, waiting for operations
//   reopen       reopen requests waiting for a manager
//   stuck        requested cards that never moved (older than the review screen's limit)
//   approved     job requests approved: each made its card
//   rejected     job requests and cards turned down
const STEPS = ['open', 'to_certify', 'to_approve', 'transport', 'operations', 'reopen', 'stuck', 'approved', 'rejected'];
const OPEN_STEPS = ['to_certify', 'to_approve', 'transport', 'operations', 'reopen'];
const TODO = OPEN_STEPS.concat(['stuck']);
const WAITING = {
  to_certify: 'Transport Manager to certify', to_approve: 'Operational Manager to approve',
  transport: 'Transport approval', operations: 'Operations approval', reopen: 'A manager to decide the reopen',
  stuck: 'Review: raised long ago, nothing done', approved: 'Approved — card made', rejected: 'Rejected',
};

const ASSET = 'a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec';

/** Job requests of the given approval statuses, within the person's reach. */
function requestRows(user, statuses, f) {
  const w = [`r.approval_status IN (${statuses.map(() => '?').join(',')})`];
  const p = [...statuses];
  const own = scope.filter(user, 'r.workshop_id', { store: false });
  if (own.sql) { w.push(own.sql); p.push(...own.params); }
  if (f.workshop_id) { w.push('r.workshop_id = ?'); p.push(Number(f.workshop_id)); }
  if (f.type) { w.push('r.type = ?'); p.push(f.type); }
  if (f.q) {
    w.push('(r.jr_no LIKE ? OR r.description LIKE ? OR r.requested_by LIKE ? OR a.code LIKE ? OR a.registration LIKE ? OR a.ec_code LIKE ? OR j.job_no LIKE ?)');
    for (let i = 0; i < 7; i++) p.push(f.q);
  }
  return all(
    `SELECT r.id, r.jr_no AS no, r.req_date, r.type, r.severity, r.priority, r.description, r.requested_by,
            r.approval_status, r.certified_by, r.certified_at, r.approved_by, r.approved_at, r.workshop_id, r.asset_id,
            r.job_id, j.job_no, j.status AS job_status, ${ASSET}, w.code AS workshop_code,
            (SELECT x.approver_id FROM job_request_approvals x WHERE x.job_request_id = r.id AND x.stage = 'certify'
                AND x.decision = 'approved' ORDER BY x.id DESC LIMIT 1) AS certifier_id,
            (SELECT x.reason FROM job_request_approvals x WHERE x.job_request_id = r.id AND x.decision = 'rejected'
              ORDER BY x.id DESC LIMIT 1) AS reject_reason,
            (SELECT x.created_at FROM job_request_approvals x WHERE x.job_request_id = r.id AND x.decision = 'rejected'
              ORDER BY x.id DESC LIMIT 1) AS rejected_at
       FROM job_requests r LEFT JOIN assets a ON a.id = r.asset_id LEFT JOIN job_cards j ON j.id = r.job_id
       LEFT JOIN workshops w ON w.id = r.workshop_id
      WHERE ${w.join(' AND ')}`, ...p);
}

/** Cards of the given statuses, within the person's reach (imported ones too: rowsFor decides). */
function cardRows(user, statuses, f) {
  const w = [`j.status IN (${statuses.map(() => '?').join(',')})`, `NOT ${review.CONTAINER_SQL}`];
  const p = [...statuses];
  const own = scope.filter(user, 'j.workshop_id');
  if (own.sql) { w.push(own.sql); p.push(...own.params); }
  if (f.workshop_id) { w.push('j.workshop_id = ?'); p.push(Number(f.workshop_id)); }
  if (f.type) { w.push('j.type = ?'); p.push(f.type); }
  if (f.q) {
    w.push('(j.job_no LIKE ? OR j.description LIKE ? OR j.requested_by LIKE ? OR a.code LIKE ? OR a.registration LIKE ? OR a.ec_code LIKE ?)');
    for (let i = 0; i < 6; i++) p.push(f.q);
  }
  return all(
    `SELECT j.id, j.job_no AS no, j.requested_at, j.type, j.severity, j.description, j.requested_by, j.status,
            j.approved_transport_at, j.updated_at, j.workshop_id, j.asset_id, j.is_historical, ${ASSET}, w.code AS workshop_code,
            COALESCE(j.total_cost, 0) AS total_cost,
            (SELECT x.approver_id FROM job_approvals x WHERE x.job_id = j.id AND x.role = 'transport_manager'
                AND x.decision = 'approved' ORDER BY x.id DESC LIMIT 1) AS transport_by,
            (SELECT x.reason FROM job_approvals x WHERE x.job_id = j.id AND x.decision = 'rejected' ORDER BY x.id DESC LIMIT 1) AS reject_reason,
            (SELECT x.created_at FROM job_approvals x WHERE x.job_id = j.id AND x.decision = 'rejected' ORDER BY x.id DESC LIMIT 1) AS rejected_at,
            ${review.ACTIVITY_COLS}
       FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id LEFT JOIN workshops w ON w.id = j.workshop_id
      WHERE ${w.join(' AND ')}`, ...p);
}

/** Reopen requests waiting for a decision, within the person's reach. */
function reopenRows(user, f) {
  const w = ["r.status = 'pending'"];
  const p = [];
  const own = scope.filter(user, 'j.workshop_id');
  if (own.sql) { w.push(own.sql); p.push(...own.params); }
  if (f.workshop_id) { w.push('j.workshop_id = ?'); p.push(Number(f.workshop_id)); }
  if (f.type) { w.push('j.type = ?'); p.push(f.type); }
  if (f.q) {
    w.push('(j.job_no LIKE ? OR j.description LIKE ? OR r.reason LIKE ? OR a.code LIKE ? OR a.registration LIKE ? OR a.ec_code LIKE ?)');
    for (let i = 0; i < 6; i++) p.push(f.q);
  }
  return all(
    `SELECT r.id, r.reason, r.requested_at, r.requested_by AS requester_id, COALESCE(u.full_name, u.username) AS requested_by,
            j.id AS job_id, j.job_no AS no, j.type, j.severity, j.description, j.status AS job_status, j.workshop_id, j.asset_id,
            ${ASSET}, w.code AS workshop_code
       FROM job_reopen_requests r JOIN job_cards j ON j.id = r.job_id LEFT JOIN users u ON u.id = r.requested_by
       LEFT JOIN assets a ON a.id = j.asset_id LEFT JOIN workshops w ON w.id = j.workshop_id
      WHERE ${w.join(' AND ')}`, ...p);
}

const may = (user, from, to) => jobstate.checkTransition(from, to, user).ok;
const vehicle = (r) => ({ asset_id: r.asset_id, asset_code: r.asset_code, asset_reg: r.asset_reg, asset_ec: r.asset_ec });

function shapeRequest(user, r, now) {
  const step = { requested: 'to_certify', certified: 'to_approve', approved: 'approved', rejected: 'rejected' }[r.approval_status];
  const since = step === 'to_approve' ? r.certified_at : (step === 'approved' ? r.approved_at : (step === 'rejected' ? r.rejected_at : r.req_date));
  const mine = !isAdmin(user) && r.certifier_id != null && r.certifier_id === user.id;
  const open = step === 'to_certify' || step === 'to_approve';
  return {
    kind: 'jr', id: r.id, no: r.no, date: day10(r.req_date), type: r.type, severity: r.severity, priority: r.priority,
    description: r.description, requested_by: r.requested_by, workshop_id: r.workshop_id, workshop_code: r.workshop_code,
    ...vehicle(r), step, waiting_for: WAITING[step], since: day10(since), days: open ? daysSince(since, now) : null,
    job_id: r.job_id, job_no: r.job_no, reject_reason: r.reject_reason,
    note: step === 'to_approve' && mine ? 'You certified it — another manager approves.' : null,
    road: roadOf(step === 'approved' ? r.job_status : null, { rejected: step === 'rejected' }),
    link: '#/jobrequests/' + r.id,
    can: {
      certify: step === 'to_certify' && hasCap(user, 'jobrequests.certify'),
      approve: step === 'to_approve' && hasCap(user, 'jobrequests.approve') && !mine,
      reject: open && hasCap(user, 'jobrequests.reject'),
    },
  };
}

function shapeCard(user, r, now) {
  let step;
  if (r.status === 'REQUESTED') step = review.isStuck(r, now) ? 'stuck' : 'transport';
  else if (r.status === 'APPROVED_TRANSPORT') step = 'operations';
  else step = 'rejected';
  const since = step === 'operations' ? r.approved_transport_at : (step === 'rejected' ? (r.rejected_at || r.updated_at) : r.requested_at);
  const mine = !isAdmin(user) && r.transport_by != null && r.transport_by === user.id;
  const open = step === 'transport' || step === 'operations';
  return {
    kind: 'card', id: r.id, no: r.no, date: day10(r.requested_at), type: r.type, severity: r.severity, priority: null,
    description: r.description, requested_by: r.requested_by, workshop_id: r.workshop_id, workshop_code: r.workshop_code,
    ...vehicle(r), step, waiting_for: WAITING[step], since: day10(since), days: step === 'rejected' ? null : daysSince(since, now),
    imported: !!r.is_historical, job_id: r.id, job_no: r.no, reject_reason: r.reject_reason,
    note: step === 'operations' && mine ? 'You gave the transport approval — another manager approves.' : null,
    road: roadOf(r.status), link: '#/jobs/' + r.id,
    can: {
      transport: step === 'transport' && may(user, r.status, 'APPROVED_TRANSPORT'),
      operations: step === 'operations' && may(user, r.status, 'APPROVED_OPERATIONS') && !mine,
      reject: open && may(user, r.status, 'REJECTED'),
      review: step === 'stuck' && hasCap(user, 'jobs.triage'),
    },
  };
}

function shapeReopen(user, r, now) {
  const mine = !isAdmin(user) && r.requester_id != null && r.requester_id === user.id;
  return {
    kind: 'reopen', id: r.id, no: r.no, date: day10(r.requested_at), type: r.type, severity: r.severity, priority: null,
    description: r.description, requested_by: r.requested_by, workshop_id: r.workshop_id, workshop_code: r.workshop_code,
    ...vehicle(r), step: 'reopen', waiting_for: WAITING.reopen, since: day10(r.requested_at), days: daysSince(r.requested_at, now),
    job_id: r.job_id, job_no: r.no, reason: r.reason,
    note: mine ? 'You asked for it — another manager decides.' : null,
    road: roadOf(r.job_status), link: '#/jobs/' + r.job_id,
    can: { reopen: hasCap(user, 'jobs.reopen') && !mine },
  };
}

/**
 * Every row of the given steps the person may see: job requests only with the Job Requests module,
 * cards and reopen requests only with the Job Cards module (JC-D2 — as the pages were).
 */
function rowsFor(user, steps, f = {}) {
  const now = today();
  const want = (s) => steps.includes(s);
  const out = [];
  if (sees(user, 'jobrequests')) {
    const st = [['requested', 'to_certify'], ['certified', 'to_approve'], ['approved', 'approved'], ['rejected', 'rejected']]
      .filter(([, s]) => want(s)).map(([a]) => a);
    if (st.length) out.push(...requestRows(user, st, f).map((r) => shapeRequest(user, r, now)));
  }
  if (sees(user, 'jobs')) {
    const st = [];
    if (want('transport') || want('stuck')) st.push('REQUESTED');
    if (want('operations')) st.push('APPROVED_TRANSPORT');
    if (want('rejected')) st.push('REJECTED');
    if (st.length) {
      // Stuck cards are the review screen's list, imported ones included; nothing else imported shows.
      out.push(...cardRows(user, st, f).map((r) => shapeCard(user, r, now))
        .filter((r) => want(r.step) && (!r.imported || r.step === 'stuck')));
    }
    if (want('reopen')) out.push(...reopenRows(user, f).map((r) => shapeReopen(user, r, now)));
  }
  return out;
}

/** query: step (see STEPS; default open), q, type, workshop_id, limit. */
function requests(user, query = {}) {
  const step = STEPS.includes(query.step) ? query.step : 'open';
  const f = {
    q: String(query.q || '').trim() ? '%' + String(query.q).trim() + '%' : null,
    type: ['repair', 'service'].includes(query.type) ? query.type : null,
    workshop_id: query.workshop_id ? Number(query.workshop_id) : null,
  };
  const rows = rowsFor(user, step === 'open' ? OPEN_STEPS : [step], f);
  // A to-do list: the longest waiting first. A record of decisions: the newest first.
  const done = step === 'approved' || step === 'rejected';
  rows.sort((a, b) => (done ? String(b.since || '').localeCompare(String(a.since || ''))
    : String(a.since || '').localeCompare(String(b.since || ''))) || (a.no > b.no ? 1 : -1));
  const limit = Math.min(Math.max(Number(query.limit) || 300, 1), 5000);
  return rows.slice(0, limit);
}

/** How many rows wait at each step (the pills over the list, and the Monitor). */
function counts(user) {
  const n = Object.fromEntries(STEPS.map((s) => [s, 0]));
  for (const r of rowsFor(user, TODO)) n[r.step]++;
  n.open = OPEN_STEPS.reduce((t, s) => t + n[s], 0);
  if (sees(user, 'jobrequests')) {
    const own = scope.filter(user, 'workshop_id', { store: false });
    for (const [st, key] of [['approved', 'approved'], ['rejected', 'rejected']]) {
      n[key] += get(`SELECT COUNT(*) c FROM job_requests WHERE approval_status = ?${own.sql ? ' AND ' + own.sql : ''}`, st, ...own.params).c;
    }
  }
  if (sees(user, 'jobs')) {
    const own = scope.filter(user, 'j.workshop_id');
    n.rejected += get(`SELECT COUNT(*) c FROM job_cards j WHERE j.status = 'REJECTED' AND COALESCE(j.is_historical, 0) = 0
                         AND NOT ${review.CONTAINER_SQL}${own.sql ? ' AND ' + own.sql : ''}`, ...own.params).c;
  }
  return n;
}

// ---- the Monitor -----------------------------------------------------------------------------------
/**
 * What is waiting at each step, in the person's workshops (head office: all). A part is null when
 * the person may not see it: requests without Job Requests, the rest without Job Cards.
 */
function monitor(user) {
  const seesJobs = sees(user, 'jobs');
  const n = counts(user);
  const out = {
    sees: { jobs: seesJobs, jobrequests: sees(user, 'jobrequests') },
    requests: { to_certify: n.to_certify, to_approve: n.to_approve, transport: n.transport, operations: n.operations, reopen: n.reopen, open: n.open },
    workshop: null, finishing: null, watch: null,
  };
  const r = scope.reach(user);
  out.scope = r && r.length === 1 ? { id: r[0], label: (get('SELECT name FROM workshops WHERE id = ?', r[0]) || {}).name || null } : null;
  if (!seesJobs) return out;
  const own = scope.filter(user, 'j.workshop_id');
  const LIVE = `COALESCE(j.is_historical, 0) = 0 AND NOT ${review.CONTAINER_SQL}${own.sql ? ' AND ' + own.sql : ''}`;
  const c = get(
    `SELECT SUM(j.status IN ('APPROVED_OPERATIONS','IN_WORKSHOP')) AS waiting_to_start,
            SUM(j.status = 'IN_PROGRESS') AS in_progress,
            SUM(j.status = 'WORK_COMPLETE') AS work_done,
            SUM(j.status = 'PARTIALLY_CLOSED') AS partly_closed,
            SUM(${jobstate.openSql('j')} AND EXISTS (SELECT 1 FROM job_daily_work d WHERE d.job_id = j.id
                  AND d.work_date = date('now', 'localtime'))) AS worked_today
       FROM job_cards j WHERE ${LIVE}`, ...own.params);
  for (const k of Object.keys(c)) c[k] = c[k] || 0;
  out.workshop = { waiting_to_start: c.waiting_to_start, in_progress: c.in_progress, worked_today: c.worked_today };
  out.finishing = { work_done: c.work_done, partly_closed: c.partly_closed };
  const fieldInUse = !!get('SELECT 1 x FROM job_cards WHERE field = 1 LIMIT 1');
  out.watch = {
    breakdowns_down: fieldInUse ? require('./field').downCount(user) : null,
    reopen: n.reopen,
    stuck: n.stuck,
    two_open: jobstate.duplicateOpenJobs({ workshopId: r }).length,
  };
  return out;
}

module.exports = { ROAD, STEPS, OPEN_STEPS, roadOf, requests, counts, monitor, sees };
