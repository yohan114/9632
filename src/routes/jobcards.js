'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireAuth, requireCap, hasCap } = require('../lib/auth');
// The segregation-of-duties checks below exempt the admin. isAdmin() is the one admin test: routes
// no longer check role names (Stage 1).
const { isAdmin } = require('../lib/access_rules');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const audit = require('../lib/audit');
const aliases = require('../lib/aliases');
const mechanics = require('../lib/mechanics');
const jobstate = require('../lib/jobstate');
const closeLib = require('../lib/job_close');
const attendance = require('../lib/attendance');
const costing = require('../lib/costing');
const jobno = require('../lib/jobno');
const workshops = require('../lib/workshops');
const emitter = require('../lib/emitter');

const router = express.Router();

// Order by the job number itself — YYYY/M/(R|S)/seq — newest first: year, then month,
// then the sequence number (xxx), all compared numerically (so 12 > 6 and 383 > 59).
const JOB_NO_ORDER = `
  CAST(substr(j.job_no, 1, instr(j.job_no, '/') - 1) AS INTEGER) DESC,
  CAST(substr(substr(j.job_no, instr(j.job_no, '/') + 1), 1,
              instr(substr(j.job_no, instr(j.job_no, '/') + 1), '/') - 1) AS INTEGER) DESC,
  CAST(substr(j.job_no, instr(j.job_no, '/R/') + instr(j.job_no, '/S/') + 3) AS INTEGER) DESC,
  j.id DESC`;
// Same ordering applied to the outer query of the one-per-asset wrapper, where the rows
// have already lost their `j.` prefix.
const JOB_NO_ORDER_FLAT = JOB_NO_ORDER.replace(/\bj\./g, '');

// ---- helpers --------------------------------------------------------------

// The sequence runs through the YEAR, not the month — see src/lib/jobno.js. Shared with
// routes/jobrequests.js, which used to keep its own copy of this.
const jobNo = (type) => jobno.nextJobNo(type);

function loadJob(id) {
  return get(
    `SELECT j.*, a.code AS asset_code, a.code_norm AS asset_code_norm,
            a.registration AS asset_reg, a.ec_code AS asset_ec,
            p.name AS project_name, w.code AS workshop_code, w.name AS workshop_name
       FROM job_cards j
       LEFT JOIN assets a ON a.id = j.asset_id
       LEFT JOIN projects p ON p.id = j.project_id
       LEFT JOIN workshops w ON w.id = j.workshop_id
      WHERE j.id = ?`,
    id
  );
}

// Full close: the closure check has to pass. Returns null (may close) or the 409 body.
// Switched off (the flow before W2): only a card's FIRST close is checked — a card that was closed
// once already cleared it, or was closed by import / close-on-date, which never checked. Switched
// on, nothing needs that excuse any more (an unfinished card can be partly closed), so every live
// card is checked, including "work done is recorded"; only reopened imported history is excused.
function closeGate(job) {
  const readiness = costing.closureReadiness(job.id);
  if (readiness.ready) return null;
  const wasReopened = !!get('SELECT 1 v FROM job_reopens WHERE job_id = ? LIMIT 1', job.id);
  if (!jobstate.partialCloseEnabled()) {
    return wasReopened ? null : { error: 'Job is not fully priced — cannot close', missing: readiness.missing };
  }
  if (wasReopened && job.is_historical) return null;
  const n = readiness.missing.length;
  return {
    error: `Not ready to close fully — ${n} thing${n === 1 ? '' : 's'} still missing.`
      + (job.status === jobstate.PARTIAL ? '' : ' Partly close it instead, and close it fully once they are done.'),
    missing: readiness.missing,
  };
}

// The only two kinds of card. The letter in the job number (…/R/… or …/S/…) is set from this
// at creation and is never rewritten afterwards — the number is what is printed on the
// paperwork, so it stays put and a later type change is reported as a mismatch instead.
const JOB_TYPES = ['repair', 'service'];


// ---- list / create --------------------------------------------------------

router.get(
  '/',
  asyncHandler((req, res) => {
    const clauses = [];
    const params = [];
    for (const f of ['status', 'type', 'severity']) {
      if (req.query[f]) {
        clauses.push(`j.${f} = ?`);
        params.push(req.query[f]);
      }
    }
    if (req.query.asset_id) {
      clauses.push('j.asset_id = ?');
      params.push(toInt(req.query.asset_id));
    }
    if (req.query.project_id) {
      clauses.push('j.project_id = ?');
      params.push(toInt(req.query.project_id));
    }
    // Which workshop does the repair (multi-site Stage 2).
    if (req.query.workshop_id) {
      clauses.push('j.workshop_id = ?');
      params.push(toInt(req.query.workshop_id));
    }
    // Only currently-open job cards (for pickers that log against an active job).
    if (req.query.open === '1') clauses.push(jobstate.openSql('j'));
    // Free-text search across job number, vehicle and references. A vehicle the
    // user types (e.g. "LO-5981") may live in the asset's canonical code, its
    // registration, its ec_code, or only as an alias — so we check them all, plus
    // a normalised form (letters+digits only) so "LO 5981"/"lo-5981" also match.
    // LIKE is case-insensitive for ASCII in SQLite.
    if (req.query.q && String(req.query.q).trim()) {
      const raw = String(req.query.q).trim();
      const like = '%' + raw + '%';
      const normq = raw.replace(/[^a-z0-9]/gi, '').toUpperCase();
      const ors = ['j.job_no LIKE ?', 'a.code LIKE ?', 'a.registration LIKE ?', 'a.ec_code LIKE ?', 'j.ref LIKE ?', 'j.legacy_ref LIKE ?'];
      params.push(like, like, like, like, like, like);
      if (normq) {
        const normLike = '%' + normq + '%';
        ors.push('a.code_norm LIKE ?');
        params.push(normLike);
        ors.push('j.asset_id IN (SELECT asset_id FROM asset_aliases WHERE asset_id IS NOT NULL AND (raw_text LIKE ? OR raw_norm LIKE ?))');
        params.push(like, normLike);
      } else {
        ors.push('j.asset_id IN (SELECT asset_id FROM asset_aliases WHERE asset_id IS NOT NULL AND raw_text LIKE ?)');
        params.push(like);
      }
      clauses.push('(' + ors.join(' OR ') + ')');
    }
    // Date filters on the job date. requested_at is stored 'YYYY-MM-DD…' for both
    // imported history and live jobs, so substr() slices the year / month out.
    // Filter by the YEAR and MONTH encoded in the job number (YYYY/M/…), matching the sort.
    if (req.query.year) {
      clauses.push("substr(j.job_no, 1, instr(j.job_no, '/') - 1) = ?");
      params.push(String(req.query.year));
    }
    if (req.query.month) {
      clauses.push("CAST(substr(substr(j.job_no, instr(j.job_no, '/') + 1), 1, instr(substr(j.job_no, instr(j.job_no, '/') + 1), '/') - 1) AS INTEGER) = ?");
      params.push(toInt(req.query.month));
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const limit = toInt(req.query.limit, 500);
    const cols = `j.id, j.job_no, j.type, j.severity, j.status, j.description,
              j.total_cost, j.material_cost, j.labour_cost, j.requested_at, j.closed_at, j.completed_at,
              j.asset_id, j.workshop_id, w.code AS workshop_code,
              a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec, p.name AS project_name`;
    const from = `FROM job_cards j
         LEFT JOIN assets a ON a.id = j.asset_id
         LEFT JOIN projects p ON p.id = j.project_id
         LEFT JOIN workshops w ON w.id = j.workshop_id`;

    // One row per machine, for the pickers. A vehicle can be carrying two, three, even four
    // cards left open years apart, and offering all of them side by side just invites logging
    // today's work against a 2023 card. So we keep the newest card per asset and tell the
    // caller how many others exist, rather than hiding them silently.
    //
    // COALESCE(asset_id, -id), never asset_id alone: SQLite treats NULLs as equal inside a
    // partition, which would fold every container/general card (no asset) into one row.
    // The window runs over the ALREADY-FILTERED set, so typing an old job number in full
    // still finds that exact card — the collapse only ever applies within one search.
    const rows = req.query.one_per_asset === '1'
      ? all(
        `SELECT * FROM (
            SELECT ${cols},
                   ROW_NUMBER() OVER (PARTITION BY COALESCE(j.asset_id, -j.id)
                                          ORDER BY ${JOB_NO_ORDER}) AS rn,
                   CASE WHEN j.asset_id IS NULL THEN 0 ELSE (
                     SELECT COUNT(*) - 1 FROM job_cards s
                      WHERE s.asset_id = j.asset_id
                        AND ${jobstate.openSql('s')}) END AS open_siblings
              ${from}
             ${where})
          WHERE rn = 1
          ORDER BY ${JOB_NO_ORDER_FLAT}
          LIMIT ${limit}`,
        ...params
      )
      : all(
        `SELECT ${cols} ${from} ${where} ORDER BY ${JOB_NO_ORDER} LIMIT ${limit}`,
        ...params
      );
    res.json(rows);
  })
);

router.post(
  '/',
  requireAuth,
  requireCap('jobs.create'),
  asyncHandler((req, res) => {
    const b = req.body;
    require_(b, ['description']);
    const type = b.type === 'service' ? 'service' : 'repair';

    // Resolve the asset through the master resolver.
    let assetId = toInt(b.asset_id);
    let unresolved = null;
    if (!assetId && b.asset) {
      const r = aliases.resolveAsset(b.asset, { source: 'job_card' });
      assetId = r.assetId;
      if (!r.resolved) unresolved = { aliasId: r.aliasId, raw: b.asset };
    }

    // One open card per vehicle — the next fault waits until this one closes.
    const guard = jobstate.checkOneOpenJob(assetId);
    if (!guard.ok) return res.status(409).json({ error: guard.error, blocking_job: guard.blocking });
    // The workshop that does the repair: the one chosen, else the person's home workshop.
    const workshopId = workshops.forNew(req.user, b.workshop_id);

    const no = jobNo(type);
    const info = run(
      `INSERT INTO job_cards (job_no, ref, asset_id, project_id, site, type, severity, description,
                              status, requested_by, requested_by_user, workshop_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?, ?)`,
      no,
      b.ref || null,
      assetId || null,
      toInt(b.project_id),
      b.site || null,
      type,
      b.severity === 'major' || b.severity === 'minor' ? b.severity : null,
      b.description,
      b.requested_by || req.user.fullName || req.user.username,
      req.user.id,
      workshopId
    );
    audit.record({ userId: req.user.id, entity: 'job_card', entityId: info.lastInsertRowid, action: 'create', after: { job_no: no, workshop_id: workshopId } });
    emitter.emit('job_updated', { job_id: info.lastInsertRowid, action: 'create' });
    emitter.emit('dashboard_refresh', { reason: 'job_create' });
    res.status(201).json({ job: loadJob(info.lastInsertRowid), unresolved });
  })
);

// ---- vehicle conflicts ----------------------------------------------------
// Vehicles carrying more than one open card. These predate the one-open-card rule
// (which only stops NEW ones), so this is the backlog to work off. Registered
// before '/:id' so the literal path isn't swallowed by the param route.
router.get(
  '/duplicates',
  asyncHandler((_req, res) => {
    const vehicles = jobstate.duplicateOpenJobs();
    res.json({
      vehicles,
      vehicle_count: vehicles.length,
      job_count: vehicles.reduce((n, v) => n + v.open_count, 0),
    });
  })
);

// Stuck REQUESTED cards: the list with a suggestion for each, and applying what a person chose
// (src/lib/job_review.js). Nothing changes on its own. Registered before '/:id'.
router.get('/review/stuck', requireAuth, requireCap('jobs.triage'), asyncHandler((_req, res) => {
  res.json(require('../lib/job_review').listStuck());
}));

router.post('/review/apply', requireAuth, requireCap('jobs.triage'), asyncHandler((req, res) => {
  let done;
  try {
    done = require('../lib/job_review').applyReview(req.body.actions, {
      userId: req.user.id, reason: req.body.reason,
      approvalRole: hasCap(req.user, 'jobs.approve_operations') ? 'operational_manager' : 'transport_manager' });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message, problems: (e.extra && e.extra.problems) || [] });
    throw e;
  }
  for (const j of done.jobs) {
    audit.record({ userId: req.user.id, entity: 'job_card', entityId: j.id,
      action: j.action === 'reject' ? 'review_reject' : 'review_close',
      before: { status: 'REQUESTED' }, after: { status: j.action === 'reject' ? 'REJECTED' : 'CLOSED', completed_at: j.date },
      reason: req.body.reason, notify: false });
  }
  emitter.emit('dashboard_refresh', { reason: 'job_review' });
  res.json(done);
}));

// Partial close and reopen requests: on or off (jobstate.partialCloseEnabled). Registered before '/:id'.
router.get('/close-settings', asyncHandler((_req, res) => res.json({ partial_close_enabled: jobstate.partialCloseEnabled() })));
router.put('/close-settings', requireAuth, requireCap('jobs.settings'), asyncHandler((req, res) => {
  const before = jobstate.partialCloseEnabled();
  const on = closeLib.setEnabled(!!(req.body && (req.body.partial_close_enabled === true || req.body.partial_close_enabled === 1 || req.body.partial_close_enabled === '1')));
  audit.record({ userId: req.user.id, entity: 'settings', action: 'partial_close_switch', before: { partial_close_enabled: before }, after: { partial_close_enabled: on } });
  res.json({ partial_close_enabled: on });
}));

// Reopen requests waiting for a decision (the job card shows its own; this is the queue).
router.get('/reopen-requests', requireAuth, requireCap('jobs.reopen'), asyncHandler((req, res) => {
  res.json(closeLib.pendingRequests({ excludeRequester: isAdmin(req.user) ? null : req.user.id }));
}));

router.post('/reopen-requests/:rid/:decision', requireAuth, requireCap('jobs.reopen'), asyncHandler((req, res) => {
  const decision = req.params.decision;
  if (decision !== 'approve' && decision !== 'refuse') return res.status(404).json({ error: 'Not found' });
  let out;
  try {
    out = closeLib.decideReopen(toInt(req.params.rid), { user: req.user, approve: decision === 'approve', note: (req.body || {}).note, isAdmin: isAdmin(req.user) });
  } catch (e) {
    if (e.status && e.extra && e.extra.blocking_job) return res.status(e.status).json({ error: e.message, blocking_job: e.extra.blocking_job });
    throw e;
  }
  const r = out.request;
  audit.record({ userId: req.user.id, entity: 'job_reopen_request', entityId: r.id, action: decision === 'approve' ? 'approve' : 'refuse',
    after: { job_id: r.job_id, status: r.status }, reason: r.decision_note || null });
  if (decision === 'approve') {
    audit.record({ userId: req.user.id, entity: 'job_card', entityId: r.job_id, action: 'transition',
      before: { status: out.before.status }, after: { status: 'IN_PROGRESS' }, reason: `Reopen request #${r.id}: ${r.reason}` });
    emitter.emit('job_updated', { job_id: r.job_id, action: 'transition', status: 'IN_PROGRESS' });
    emitter.emit('dashboard_refresh', { reason: 'job_transition', status: 'IN_PROGRESS' });
  }
  res.json({ request: r, job: loadJob(r.job_id) });
}));

// Is this vehicle free to take a new job card? Lets the UI warn before the form is
// filled in rather than failing on save.
router.get(
  '/open-for/:assetId',
  asyncHandler((req, res) => {
    const blocking = jobstate.openJobFor(toInt(req.params.assetId));
    res.json({ blocked: !!blocking, blocking_job: blocking || null });
  })
);

// ---- detail ---------------------------------------------------------------

router.get(
  '/:id',
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const job = loadJob(id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const approvals = all('SELECT * FROM job_approvals WHERE job_id = ? ORDER BY id', id);
    const dailyWork = all('SELECT * FROM job_daily_work WHERE job_id = ? ORDER BY work_date, id', id);
    const parts = all('SELECT * FROM job_parts WHERE job_id = ? ORDER BY id', id);
    // MRN request lines behind this job (requested, on order, or received), linked by
    // job_id, job_parts attachment, or vehicle date window [job start - 7d ... job close + 7d].
    const mrnItems = all(
      `SELECT m.id AS mrn_id, m.mrn_no, m.req_date, m.approval_status,
              ml.id AS mrn_line_id, ml.description, ml.category, ml.qty, ml.qty_received,
              g.id AS grn_id, g.grn_no, g.delivery_date, g.unit_price,
              ROUND(COALESCE((SELECT SUM(i.qty) FROM issues i WHERE i.grn_id = g.id), 0), 2) AS qty_issued,
              ROUND(MAX(0, COALESCE(g.qty, ml.qty_received, 0) - COALESCE((SELECT SUM(i.qty) FROM issues i WHERE i.grn_id = g.id), 0)), 2) AS remaining_in_store
         FROM mrn_lines ml
         JOIN mrn m ON m.id = ml.mrn_id
         LEFT JOIN grn g ON g.mrn_line_id = ml.id
         JOIN job_cards j ON j.id = ?
        WHERE m.job_id = j.id
           OR ml.id IN (SELECT mrn_line_id FROM job_parts WHERE job_id = j.id AND mrn_line_id IS NOT NULL)
           OR (m.asset_id = j.asset_id AND date(m.req_date) BETWEEN date(j.requested_at, '-7 days')
                                                               AND date(COALESCE(j.closed_at, j.completed_at, date('now')), '+7 days'))
        ORDER BY m.id DESC, ml.id`,
      id
    );
    const labour = all('SELECT * FROM job_labour WHERE job_id = ? ORDER BY id', id);
    const oilIssues = all(
      `SELECT sl.*, pr.name AS product_name, pr.unit FROM stock_ledger sl
         JOIN products pr ON pr.id = sl.product_id
        WHERE sl.job_id = ? AND sl.kind = 'issue' ORDER BY sl.id`,
      id
    );
    const generalIssues = all(
      `SELECT g.*, si.name AS item_name FROM general_item_txns g
         JOIN store_items si ON si.id = g.store_item_id
        WHERE g.job_id = ? AND g.txn_type = 'issue' ORDER BY g.id`,
      id
    );
    const cost = costing.reconciledCost(id);
    const readiness = costing.closureReadiness(id);
    const snapshot = get('SELECT * FROM job_costs WHERE job_id = ? ORDER BY id DESC LIMIT 1', id);
    const unissued_shelf_parts = mrnItems.filter((m) => m.grn_id && m.remaining_in_store > 0.001);

    res.json({
      job,
      approvals,
      dailyWork,
      parts,
      mrnItems,
      unissued_shelf_parts,
      labour: cost.labourLines,
      labourStored: labour,
      oilIssues,
      generalIssues,
      cost,
      readiness,
      snapshot,
      nextStates: jobstate.nextStates(job.status),
      canReopen: jobstate.canReopen(req.user),
      // Partial close (W2): whether it is switched on, this card's reopen requests, and the cards
      // either side of a partial close — the one this continues, and the one continuing it.
      partialCloseEnabled: jobstate.partialCloseEnabled(),
      reopenRequests: closeLib.requestsFor(id),
      continues: job.continues_job_id ? get('SELECT id, job_no, status FROM job_cards WHERE id = ?', job.continues_job_id) : null,
      continuedAs: all('SELECT id, job_no, status FROM job_cards WHERE continues_job_id = ? ORDER BY id', id),
      workRecorded: closeLib.workRecorded(job),
      reopens: all(
        `SELECT r.*, u.username AS reopened_by_name FROM job_reopens r
           LEFT JOIN users u ON u.id = r.reopened_by
          WHERE r.job_id = ? ORDER BY r.id DESC`, id),
    });
  })
);

// ---- state transitions ----------------------------------------------------

router.post(
  '/:id/transition',
  requireAuth,
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const job = loadJob(id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const target = req.body.to;
    const reason = req.body.reason || null;

    if (target === jobstate.PARTIAL) {
      return res.status(400).json({ error: 'Use "Partly close" — it asks for a note and can open the vehicle\'s new job.' });
    }
    const check = jobstate.checkTransition(job.status, target, req.user);
    if (!check.ok) return res.status(400).json({ error: check.error });

    if (jobstate.isReopen(job.status, target)) {
      // With partial close switched on, a reopen is ASKED FOR and approved by somebody else.
      if (jobstate.partialCloseEnabled()) {
        return res.status(409).json({ error: 'Reopening now goes through a request: press "Request reopen", and another manager approves it.', use_request: true });
      }
      // Reopening a closed card is still "opening a job" for that vehicle.
      const blocked = closeLib.reopenBlocker(job);
      if (blocked) return res.status(blocked.status).json({ error: blocked.error, blocking_job: blocked.blocking_job });
      // A reopen rewrites cost history, so it must say why. Every other transition is
      // self-explanatory from the state pair; this one is not.
      if (!String(reason || '').trim()) {
        return res.status(400).json({ error: 'A reason is required to reopen a closed job' });
      }
      tx(() => closeLib.applyReopen(job, { userId: req.user.id, reason }));
      audit.record({ userId: req.user.id, entity: 'job_card', entityId: id, action: 'transition', before: { status: job.status }, after: { status: target }, reason });
      emitter.emit('job_updated', { job_id: id, action: 'transition', status: target });
      emitter.emit('dashboard_refresh', { reason: 'job_transition', status: target });
      return res.json({ ...loadJob(id), nextStates: jobstate.nextStates(target) });
    }

    // Closure gate. A card that was already closed once cleared this gate (or was closed by
    // import / close-on-date, which never enforced it) — re-blocking it would strand every
    // reopened legacy job in IN_PROGRESS forever, so the gate applies to first closures only.
    // With partial close switched on nothing is stranded (an unfinished card can be partly
    // closed), so the gate applies to every live card; only reopened imported history is excused.
    if (target === 'CLOSED') {
      const fail = closeGate(job);
      if (fail) return res.status(409).json(fail);
    }

    if (check.def.action === 'ops_approve') {
      const transRow = get(`SELECT approver_id FROM job_approvals WHERE job_id = ? AND role = 'transport_manager' AND decision = 'approved' ORDER BY id DESC LIMIT 1`, id);
      if (transRow && transRow.approver_id === req.user.id && !isAdmin(req.user)) {
        return res.status(403).json({ error: 'Segregation of duties violation: Operational approval cannot be given by the same person who gave Transport approval.' });
      }
    }

    tx(() => {
      const now = "datetime('now')";
      const sets = ["status = ?", "updated_at = " + now];
      const params = [target];

      switch (check.def.action) {
        case 'transport_approve':
          sets.push('approved_transport_at = ' + now);
          run(`INSERT INTO job_approvals (job_id, role, approver_id, decision, reason) VALUES (?, 'transport_manager', ?, 'approved', ?)`, id, req.user.id, reason);
          break;
        case 'ops_approve':
          sets.push('approved_ops_at = ' + now);
          run(`INSERT INTO job_approvals (job_id, role, approver_id, decision, reason) VALUES (?, 'operational_manager', ?, 'approved', ?)`, id, req.user.id, reason);
          break;
        case 'reject':
        case 'return': {
          const role = hasCap(req.user, 'jobs.approve_operations') ? 'operational_manager' : 'transport_manager';
          run(`INSERT INTO job_approvals (job_id, role, approver_id, decision, reason) VALUES (?, ?, ?, 'rejected', ?)`, id, role, req.user.id, reason);
          break;
        }
        case 'assign':
          break;
        case 'start_or_reopen':
          // (A reopen is handled above, by closeLib.applyReopen.)
          if (!job.started_at) sets.push('started_at = ' + now);
          run(`UPDATE assets SET status='under_repair' WHERE id = ? AND status <> 'decommissioned'`, job.asset_id);
          break;
        case 'mark_complete':
          // A card that was reopened goes back to the month it was first closed in, so a cost
          // report already issued for that month does not change behind the owner's back.
          if (job.original_completed_at) { sets.push('completed_at = ?'); params.push(job.original_completed_at); }
          else sets.push('completed_at = ' + now);
          break;
        case 'close':
          sets.push('closed_at = ' + now);
          run(`UPDATE job_reopens SET reclosed_at = datetime('now') WHERE job_id = ? AND reclosed_at IS NULL`, id);
          break;
        default:
          break;
      }

      run(`UPDATE job_cards SET ${sets.join(', ')} WHERE id = ?`, ...params, id);

      if (target === 'CLOSED') {
        costing.snapshotJobCost(id);
        run(`UPDATE assets SET status='active' WHERE id = ? AND status='under_repair'`, job.asset_id);
      }
    });

    audit.record({ userId: req.user.id, entity: 'job_card', entityId: id, action: 'transition', before: { status: job.status }, after: { status: target }, reason });
    emitter.emit('job_updated', { job_id: id, action: 'transition', status: target });
    emitter.emit('dashboard_refresh', { reason: 'job_transition', status: target });
    res.json({ ...loadJob(id), nextStates: jobstate.nextStates(target) });
  })
);

// Bulk transition multiple job cards (for triage & batch approval trays)
router.post(
  '/bulk-transition',
  requireAuth,
  asyncHandler((req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(toInt).filter(Boolean) : [];
    const target = req.body.to;
    const reason = req.body.reason ? String(req.body.reason).trim() : null;

    if (!ids.length) return res.status(400).json({ error: 'ids array required' });
    if (!jobstate.isValidState(target)) return res.status(400).json({ error: `Invalid target state: ${target}` });

    const succeeded = [];
    const failed = [];

    tx(() => {
      for (const id of ids) {
        const job = loadJob(id);
        if (!job) {
          failed.push({ id, error: 'Job not found' });
          continue;
        }

        if (target === jobstate.PARTIAL) {
          failed.push({ id, job_no: job.job_no, error: 'Partly close each card on its own (it asks for a note)' });
          continue;
        }
        const check = jobstate.checkTransition(job.status, target, req.user);
        if (!check.ok) {
          failed.push({ id, job_no: job.job_no, error: check.error });
          continue;
        }

        const isReopen = jobstate.isReopen(job.status, target);
        if (isReopen) {
          if (jobstate.partialCloseEnabled()) {
            failed.push({ id, job_no: job.job_no, error: 'Reopening goes through a request' });
            continue;
          }
          const blocked = closeLib.reopenBlocker(job);
          if (blocked) {
            failed.push({ id, job_no: job.job_no, error: blocked.error });
            continue;
          }
          if (!reason) {
            failed.push({ id, job_no: job.job_no, error: 'Reason required to reopen' });
            continue;
          }
        }

        if (target === 'CLOSED') {
          const fail = closeGate(job);
          if (fail) {
            failed.push({ id, job_no: job.job_no, error: jobstate.partialCloseEnabled() ? fail.error : 'Not fully priced or has unissued store shelf parts', missing: fail.missing });
            continue;
          }
        }

        if (check.def.action === 'ops_approve') {
          const transRow = get(`SELECT approver_id FROM job_approvals WHERE job_id = ? AND role = 'transport_manager' AND decision = 'approved' ORDER BY id DESC LIMIT 1`, id);
          if (transRow && transRow.approver_id === req.user.id && !isAdmin(req.user)) {
            failed.push({ id, job_no: job.job_no, error: 'Segregation of duties violation: Operational approval cannot be given by the same person who gave Transport approval.' });
            continue;
          }
        }

        const now = "datetime('now')";
        const sets = ["status = ?", "updated_at = " + now];
        const params = [target];

        switch (check.def.action) {
          case 'transport_approve':
            sets.push('approved_transport_at = ' + now);
            run(`INSERT INTO job_approvals (job_id, role, approver_id, decision, reason) VALUES (?, 'transport_manager', ?, 'approved', ?)`, id, req.user.id, reason);
            break;
          case 'ops_approve':
            sets.push('approved_ops_at = ' + now);
            run(`INSERT INTO job_approvals (job_id, role, approver_id, decision, reason) VALUES (?, 'operational_manager', ?, 'approved', ?)`, id, req.user.id, reason);
            break;
          case 'reject':
          case 'return': {
            const role = hasCap(req.user, 'jobs.approve_operations') ? 'operational_manager' : 'transport_manager';
            run(`INSERT INTO job_approvals (job_id, role, approver_id, decision, reason) VALUES (?, ?, ?, 'rejected', ?)`, id, role, req.user.id, reason);
            break;
          }
          case 'assign':
            break;
          case 'start_or_reopen':
            if (isReopen) {
              closeLib.applyReopen(job, { userId: req.user.id, reason });
              break;
            }
            if (!job.started_at) sets.push('started_at = ' + now);
            run(`UPDATE assets SET status='under_repair' WHERE id = ? AND status <> 'decommissioned'`, job.asset_id);
            break;
          case 'mark_complete':
            if (job.original_completed_at) { sets.push('completed_at = ?'); params.push(job.original_completed_at); }
            else sets.push('completed_at = ' + now);
            break;
          case 'close':
            sets.push('closed_at = ' + now);
            run(`UPDATE job_reopens SET reclosed_at = datetime('now') WHERE job_id = ? AND reclosed_at IS NULL`, id);
            break;
        }

        params.push(id);
        run(`UPDATE job_cards SET ${sets.join(', ')} WHERE id = ?`, ...params);

        if (target === 'CLOSED') {
          costing.snapshotJobCost(id);
          run(`UPDATE assets SET status='active' WHERE id = ? AND status='under_repair'`, job.asset_id);
        }

        audit.record({ userId: req.user.id, entity: 'job_card', entityId: id, action: 'bulk_transition', before: { status: job.status }, after: { status: target }, reason });
        emitter.emit('job_updated', { job_id: id, action: 'transition', status: target });
        succeeded.push({ id, job_no: job.job_no, prev_status: job.status, new_status: target });
      }
    });

    if (succeeded.length) {
      emitter.emit('dashboard_refresh', { reason: 'bulk_transition', count: succeeded.length });
    }

    res.json({
      ok: true,
      succeeded,
      failed,
      total: ids.length,
      success_count: succeeded.length,
      fail_count: failed.length
    });
  })
);

// Close a job card ON A CHOSEN (usually past) date — the correction tool for old cards that were
// finished in the yard but never closed in the system. Bypasses the step-by-step state machine
// (an old REQUESTED card can never legally reach CLOSED) but NOT the audit trail: the close is
// recorded with who/when/backdate. The date drives the monthly cost report (completed_at month).
// Unpriced lines don't block — they're returned as a warning so the office can price them later.
router.post(
  '/:id/close-on-date',
  requireAuth,
  requireCap('jobs.close_on_date'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const job = loadJob(id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status === 'CLOSED') return res.status(409).json({ error: 'Job is already closed (' + String(job.completed_at || '').slice(0, 10) + ')' });
    if (job.status === jobstate.PARTIAL) return res.status(409).json({ error: 'This job is partly closed — use "Close fully" once everything is priced.' });

    const date = String(req.body.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
      return res.status(400).json({ error: 'A valid close date (YYYY-MM-DD) is required' });
    }
    if (date > new Date().toISOString().slice(0, 10)) {
      return res.status(400).json({ error: 'Close date cannot be in the future' });
    }
    const reason = req.body.reason || null;

    const readiness = costing.closureReadiness(id);
    // W-D12: with partial close switched on, a live card that is not ready becomes PARTLY closed
    // on that date — a backdated FULL close needs the full check like any other. Imported history
    // closes as before.
    if (jobstate.partialCloseEnabled() && !job.is_historical && !readiness.ready) {
      const out = closeLib.partialClose(job, { user: req.user, note: reason, date,
        fromStatuses: jobstate.STATES.filter((st) => !jobstate.isFinal(st) && st !== jobstate.PARTIAL) });
      audit.record({
        userId: req.user.id, entity: 'job_card', entityId: id, action: 'partial_close_on_date',
        before: { status: job.status, completed_at: job.completed_at },
        after: { status: jobstate.PARTIAL, completed_at: date, partial_closed_at: date }, reason,
      });
      emitter.emit('job_updated', { job_id: id, action: 'partial_close', status: jobstate.PARTIAL });
      emitter.emit('dashboard_refresh', { reason: 'job_transition', status: jobstate.PARTIAL });
      const n = out.missing.length;
      return res.json({
        ...loadJob(id), nextStates: jobstate.nextStates(jobstate.PARTIAL), partly_closed: true,
        warning: `Partly closed on ${date} — ${n} thing${n === 1 ? '' : 's'} still missing. Close it fully once they are done.`,
        missing: out.missing,
      });
    }
    tx(() => {
      // The chosen date is explicit user intent, so it wins over the original-month anchor —
      // but the anchor is dropped at the same time, or a later re-close would silently pull
      // the card back to a month the user has just overridden.
      run(
        `UPDATE job_cards SET status = 'CLOSED', completed_at = ?, closed_at = ?,
                original_completed_at = NULL, updated_at = datetime('now') WHERE id = ?`,
        date, date, id
      );
      run(`UPDATE job_reopens SET reclosed_at = datetime('now') WHERE job_id = ? AND reclosed_at IS NULL`, id);
      costing.snapshotJobCost(id);
      run(`UPDATE assets SET status='active' WHERE id = ? AND status='under_repair'`, job.asset_id);
    });

    audit.record({
      userId: req.user.id, entity: 'job_card', entityId: id, action: 'close_on_date',
      before: { status: job.status, completed_at: job.completed_at },
      after: { status: 'CLOSED', completed_at: date }, reason,
    });
    emitter.emit('job_updated', { job_id: id, action: 'close_on_date', status: 'CLOSED' });
    emitter.emit('dashboard_refresh', { reason: 'job_transition', status: 'CLOSED' });
    res.json({
      ...loadJob(id),
      nextStates: jobstate.nextStates('CLOSED'),
      warning: readiness.ready ? null : `Closed with ${readiness.missing.length} unpriced line(s) — price them and totals will refresh.`,
      missing: readiness.ready ? [] : readiness.missing,
    });
  })
);

// ---- partial close and reopen requests (src/lib/job_close.js) --------------

// Partly close: the work is done and the vehicle has left, but prices or records are missing.
// Optionally opens the vehicle's new card at the same time, pointing back to this one.
router.post(
  '/:id/partial-close',
  requireAuth,
  requireCap('jobs.partial_close'),
  asyncHandler((req, res) => {
    if (!jobstate.partialCloseEnabled()) return res.status(409).json({ error: 'Partial close is switched off' });
    const id = toInt(req.params.id);
    const job = loadJob(id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const b = req.body || {};
    let out;
    try {
      out = closeLib.partialClose(job, { user: req.user, note: b.note, openNew: !!b.open_new,
        newJob: { description: b.new_description, type: b.new_type } });
    } catch (e) {
      if (e.status && e.extra && e.extra.blocking_job) return res.status(e.status).json({ error: e.message, blocking_job: e.extra.blocking_job });
      throw e;
    }
    audit.record({ userId: req.user.id, entity: 'job_card', entityId: id, action: 'partial_close',
      before: { status: job.status, completed_at: job.completed_at },
      after: { status: jobstate.PARTIAL, completed_at: out.job.completed_at, missing: out.missing.length, new_job_id: out.newJobId },
      reason: out.job.partial_note || null });
    let newJob = null;
    if (out.newJobId) {
      newJob = loadJob(out.newJobId);
      audit.record({ userId: req.user.id, entity: 'job_card', entityId: out.newJobId, action: 'create',
        after: { job_no: newJob.job_no, continues_job_id: id } });
    }
    emitter.emit('job_updated', { job_id: id, action: 'partial_close', status: jobstate.PARTIAL });
    emitter.emit('dashboard_refresh', { reason: 'job_transition', status: jobstate.PARTIAL });
    res.json({ ...loadJob(id), nextStates: jobstate.nextStates(jobstate.PARTIAL), missing: out.missing, new_job: newJob });
  })
);

// Ask for a partly closed or closed card to be reopened. Someone else holding jobs.reopen decides.
router.post(
  '/:id/reopen-request',
  requireAuth,
  requireCap('jobs.reopen_request'),
  asyncHandler((req, res) => {
    if (!jobstate.partialCloseEnabled()) return res.status(409).json({ error: 'Reopen requests are switched off — a manager reopens the job directly.' });
    const id = toInt(req.params.id);
    const job = loadJob(id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const r = closeLib.requestReopen(job, { userId: req.user.id, reason: (req.body || {}).reason });
    audit.record({ userId: req.user.id, entity: 'job_reopen_request', entityId: r.id, action: 'create',
      after: { job_id: id, job_no: job.job_no, job_status: job.status }, reason: r.reason });
    emitter.emit('dashboard_refresh', { reason: 'reopen_request' });
    res.status(201).json(r);
  })
);

// ---- daily work -----------------------------------------------------------

router.post(
  '/:id/daily-work',
  requireAuth,
  requireCap('jobs.dailywork'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const job = get('SELECT * FROM job_cards WHERE id = ?', id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const b = req.body;
    const workDate = b.work_date || new Date().toISOString().slice(0, 10);
    // The date matters on a partly closed card: work up to the partial-close day only.
    { const g = jobstate.checkAdd(job, 'daily_work', { user: req.user, dates: [workDate] }); if (!g.ok) return res.status(g.status).json(g.body); }
    const isExternal = b.is_external ? 1 : 0;
    // A signed-off day is locked (attendance, src/lib/attendance.js).
    { const g = attendance.checkDaysOpen([workDate]); if (!g.ok) return res.status(g.status).json(g.body); }
    const hours = toNum(b.hours, 0);

    // A single entry may list several mechanics ("Buddhika, Krishna"). Split into
    // one row per mechanic (each costs its own hours × rate). "/" is NOT a
    // separator — "Seethananda/seetha" is one person, handled by the resolver.
    let names = [];
    if (Array.isArray(b.mechanics)) names = b.mechanics.filter(Boolean);
    else if (b.mechanic) names = mechanics.splitMechanics(b.mechanic);

    const insertRows = [];
    if (isExternal || names.length === 0) {
      // external repair (no mechanic) or a labour line with no named mechanic
      insertRows.push(isExternal ? null : (b.mechanic || null));
    } else {
      for (const n of names) {
        const r = mechanics.resolveMechanic(n, { source: 'job_card' });
        insertRows.push(r.resolved ? r.name : n); // store canonical; queue unknowns
      }
    }

    // Owner's rule: each mechanic is charged the FULL hours at their own rate, so
    // every per-mechanic row keeps the full Time(Hrs) -> labour = H × Σ(crew rates).
    // (Matches the import model and dailywork.js; do NOT divide by crew size.)
    const perRowHours = isExternal ? 0 : hours;

    // The machine, recorded on the line itself. Defaults to the card's vehicle, which is right
    // almost always; the exception that makes it worth asking for is the GENERAL-WS card, which
    // has no vehicle of its own and is where every unassigned line is written.
    const lineAsset = toInt(b.asset_id) || job.asset_id || null;

    const created = tx(() => {
      const ids = [];
      for (const mech of insertRows) {
        const info = run(
          `INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value, asset_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id, workDate, mech, b.description || null, perRowHours, isExternal, isExternal ? toNum(b.external_value, 0) : 0, lineAsset
        );
        ids.push(info.lastInsertRowid);
      }
      return ids;
    });
    costing.refreshJobTotals(id);
    audit.record({ userId: req.user.id, entity: 'job_daily_work', entityId: created[0], action: 'create', after: { rows: created.length } });
    res.status(201).json(created.map((cid) => get('SELECT * FROM job_daily_work WHERE id = ?', cid)));
  })
);

/**
 * Taking a row OFF a job card, which is the exact inverse of attaching one.
 *
 * It used to DELETE. That threw the work away: a mechanic's four hours, or a receipt someone had
 * matched to a line, gone with no way back and nothing in the unassigned pool to re-claim. In
 * practice "remove" almost never means "this never happened" — it means "this is not THIS job's",
 * which is precisely what the catch-all is for. So the row moves there and can be claimed again by
 * the right card, using the picker that already exists.
 *
 * A genuine mistake can still be deleted outright — do it on the GENERAL-WS card itself, which is
 * the one place where "remove" really is the end of the line (see the guard in each handler).
 */
function settleAfterDetach(job, catchAllId) {
  // The months are read BEFORE the row moves, deliberately. vehicleMonthsForJob derives them from
  // the job's remaining rows, so a month whose only entry was the one being removed would no longer
  // be listed — and its bucket would keep the cost for ever, with nothing pointing at it.
  const months = costing.vehicleMonthsForJob(job.id, job.asset_id);
  return () => {
    costing.refreshJobTotals(job.id);
    if (catchAllId) costing.refreshJobTotals(catchAllId);
    for (const b of months) costing.recalcVehicleMonth(b.assetId, b.year, b.month);
  };
}

router.delete(
  '/:id/daily-work/:lineId',
  requireAuth,
  requireCap('jobs.dailywork'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const lineId = toInt(req.params.lineId);
    const job = get('SELECT * FROM job_cards WHERE id = ?', id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const row = get('SELECT * FROM job_daily_work WHERE id = ? AND job_id = ?', lineId, id);
    { const g = jobstate.checkAdd(job, 'daily_work', { user: req.user, dates: row ? [row.work_date] : [] }); if (!g.ok) return res.status(g.status).json(g.body); }
    if (!row) return res.status(404).json({ error: 'Entry not found on this job' });
    { const g = attendance.checkDaysOpen([row.work_date]); if (!g.ok) return res.status(g.status).json(g.body); }

    // ensure, not read: on a database that has never had a general entry the card does not exist,
    // and a 0 here would turn "send it back" into "destroy it".
    const gid = id === catchAllJobId() ? id : ensureCatchAllJobId();
    // On the catch-all there is nowhere further to send it, so removing means removing.
    const unlink = gid !== id;
    const settle = settleAfterDetach(job, unlink ? gid : null);

    if (unlink) run('UPDATE job_daily_work SET job_id = ? WHERE id = ?', gid, lineId);
    else run('DELETE FROM job_daily_work WHERE id = ?', lineId);
    settle();

    audit.record({ userId: req.user.id, entity: 'job_daily_work', entityId: lineId,
      action: unlink ? 'unlink' : 'delete', before: { job_id: id }, after: unlink ? { job_id: gid } : null });
    res.json({ ok: true, unlinked: !!unlink,
      message: unlink ? 'Moved to unassigned daily work' : 'Entry deleted' });
  })
);

// ---- work and goods nobody has put on a job yet ----------------------------
//
// Two things get recorded before anyone knows which job card they belong to:
//   * labour booked to the GENERAL-WS catch-all — 159 rows, most of them naming their
//     machine in the description ("AC-06 — Compressor clean and repair")
//   * goods received against a request that was never tied to a job — 914 receipts, and
//     870 of those DO name a vehicle on the request, so the right job is usually obvious
// Both used to be findable only by hunting. Now the job card's own Add buttons offer them,
// which is the moment someone actually knows where they belong.

const catchAllJobId = () => {
  const j = get("SELECT id FROM job_cards WHERE legacy_ref = 'general-workshop' LIMIT 1");
  return j ? j.id : 0;
};

/**
 * The catch-all, CREATING it if this database has never needed one.
 *
 * Nothing in the schema or the migrations makes this card — it is created lazily, by the first
 * general daily-work entry (routes/dailywork.js) or the first general stores issue
 * (routes/stores.js). So on a fresh install it does not exist, and a reader that returns 0 makes
 * "send this row back to the pool" silently become "delete this row": the unlink guard below reads
 * `gid && gid !== id`, and 0 is falsy. The screen would still promise the entry was kept.
 *
 * Detaching must therefore be able to create it, exactly as the other two writers do. Same job_no,
 * same legacy_ref, so all three converge on one card.
 */
function ensureCatchAllJobId() {
  const existing = catchAllJobId();
  if (existing) return existing;
  return run(`INSERT INTO job_cards (job_no, type, description, status, requested_by, requested_at, is_historical, synthesized_no, legacy_ref)
              VALUES ('GENERAL-WS', 'repair', 'General workshop (not vehicle-specific)', 'REQUESTED', 'system', date('now'), 0, 1, 'general-workshop')`).lastInsertRowid;
}

/**
 * Work nobody has put on a job yet, searchable BY VEHICLE.
 *
 * The vehicle is now a column on the line (job_daily_work.asset_id), recorded when the work is
 * written down. It used to be inferred from the description, and that was measured and thrown away:
 * over the 2,535 rows whose job card already names a vehicle the guess fired 86 times and was RIGHT
 * 7, because 223 registry rows are cost centres whose code carries no digit — so "Service bay door
 * fixing" became the asset "Service", and "AC-06 — Compressor clean and repair", the row the whole
 * feature was built around, resolved to nothing at all.
 *
 * The 159 rows already in the pool have no vehicle recorded, and are shown as unknown rather than
 * filled in with a guess. PATCH /api/daily-work/:id { asset_id } is how one gets named, by somebody
 * who actually recognises the work.
 *
 * The search still matches the description, because that is where the machine was written for ten
 * years, and it normalises punctuation both ways: AC06, ac-06, AC 06 and AC-06 all find each other.
 */
router.get('/unassigned/daily-work', requireAuth, asyncHandler((req, res) => {
  const gid = catchAllJobId();
  if (!gid) return res.json([]);
  const assetId = toInt(req.query.asset_id);
  const clauses = ['d.job_id = ?']; const params = [gid];

  if (req.query.q && String(req.query.q).trim()) {
    const raw = String(req.query.q).trim();
    const esc = (t) => t.replace(/[\\%_]/g, (c) => '\\' + c);
    const like = '%' + esc(raw) + '%';
    const ors = [
      `d.description LIKE ? ESCAPE '\\'`,
      `d.mechanic LIKE ? ESCAPE '\\'`,
      `a.code LIKE ? ESCAPE '\\'`,
      `a.registration LIKE ? ESCAPE '\\'`,
    ];
    params.push(like, like, like, like);
    const norm = aliases.normalize(raw);
    if (norm.length >= 2) {
      const normLike = '%' + esc(norm) + '%';
      // Punctuation stripped from BOTH sides, so it does not matter how either was typed.
      ors.push(`REPLACE(REPLACE(REPLACE(UPPER(d.description), '-', ''), ' ', ''), '/', '') LIKE ? ESCAPE '\\'`);
      ors.push(`a.code_norm LIKE ? ESCAPE '\\'`);
      params.push(normLike, normLike);
    }
    clauses.push('(' + ors.join(' OR ') + ')');
  }
  if (req.query.from) { clauses.push('date(d.work_date) >= date(?)'); params.push(String(req.query.from)); }
  if (req.query.to) { clauses.push('date(d.work_date) <= date(?)'); params.push(String(req.query.to)); }

  // This job's own machine first, then newest — the same ordering the parts picker uses, and for
  // the same reason: the line you are looking for is nearly always about the vehicle in front of
  // you. Ordered in SQL so the LIMIT cannot truncate the rows the sort was meant to surface.
  const ownFirst = assetId ? '(d.asset_id IS NOT NULL AND d.asset_id = ?) DESC,' : '';
  const orderParams = assetId ? [assetId] : [];

  res.json(all(
    `SELECT d.id, d.work_date, d.mechanic, d.description, d.hours, d.is_external, d.external_value,
            d.asset_id, a.code AS asset_code, a.registration AS asset_reg
       FROM job_daily_work d
       LEFT JOIN assets a ON a.id = d.asset_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY ${ownFirst} date(d.work_date) DESC, d.id DESC
      LIMIT ${toInt(req.query.limit, 200)}`, ...params, ...orderParams));
}));

router.get('/unassigned/parts', requireAuth, asyncHandler((req, res) => {
  const gid = catchAllJobId();
  const assetId = toInt(req.query.asset_id);
  const q = req.query.q && String(req.query.q).trim()
    ? '%' + String(req.query.q).trim().replace(/[\\%_]/g, (c) => '\\' + c) + '%' : null;
  const limit = toInt(req.query.limit, 200);

  // Goods received against a request with no job, and never booked to one.
  const recParams = [];
  let recWhere = `m.job_id IS NULL AND NOT EXISTS (SELECT 1 FROM job_parts jp WHERE jp.mrn_line_id = ml.id)`;
  if (q) { recWhere += ` AND (COALESCE(g.description, ml.description) LIKE ? ESCAPE '\\' OR m.mrn_no LIKE ? ESCAPE '\\' OR g.grn_no LIKE ? ESCAPE '\\')`; recParams.push(q, q, q); }
  const receipts = all(
    `SELECT 'receipt' AS kind, g.id AS id, g.grn_no, m.mrn_no, m.asset_id,
            a.code AS asset_code, a.registration AS asset_reg,
            COALESCE(g.description, ml.description) AS description,
            g.qty, g.unit_price, ROUND(g.qty * COALESCE(g.unit_price, 0), 2) AS value,
            date(NULLIF(g.delivery_date, '')) AS on_date, ml.category, ml.id AS mrn_line_id
       FROM grn g
       JOIN mrn_lines ml ON ml.id = g.mrn_line_id
       JOIN mrn m        ON m.id  = ml.mrn_id
       LEFT JOIN assets a ON a.id = m.asset_id
      WHERE ${recWhere}
      ORDER BY (m.asset_id IS NOT NULL AND m.asset_id = ?) DESC, date(NULLIF(g.delivery_date,'')) DESC, g.id DESC
      LIMIT ${limit}`, ...recParams, assetId || 0);

  // Lines already booked, but to the catch-all rather than to a real job.
  let parts = [];
  if (gid) {
    const pParams = [gid];
    let pWhere = 'p.job_id = ?';
    if (q) { pWhere += ` AND p.description LIKE ? ESCAPE '\\'`; pParams.push(q); }
    parts = all(
      `SELECT 'part' AS kind, p.id AS id, NULL AS grn_no, NULL AS mrn_no, NULL AS asset_id,
              NULL AS asset_code, NULL AS asset_reg, p.description, p.qty, p.unit_price,
              ROUND(p.qty * COALESCE(p.unit_price, 0), 2) AS value,
              date(p.created_at) AS on_date, NULL AS category, p.mrn_line_id
         FROM job_parts p WHERE ${pWhere}
        ORDER BY p.id DESC LIMIT ${limit}`, ...pParams);
  }
  res.json({ receipts, parts, for_asset_id: assetId || null });
}));

/** Recompute the job that lost the rows, the job that gained them, and the vehicle months. */
function settleAfterMove(fromJobId, toJobId, toAssetId) {
  if (fromJobId && fromJobId !== toJobId) costing.refreshJobTotals(fromJobId);
  costing.refreshJobTotals(toJobId);
  // Cost that was on nobody's vehicle is now on this one, so its months have to be redrawn.
  for (const b of costing.vehicleMonthsForJob(toJobId, toAssetId)) {
    costing.recalcVehicleMonth(b.assetId, b.year, b.month);
  }
}

router.post('/:id/daily-work/attach', requireAuth, requireCap('jobs.dailywork'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const job = get('SELECT * FROM job_cards WHERE id = ?', id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  { const g = jobstate.checkAdd(job, 'attach', { user: req.user }); if (!g.ok) return res.status(g.status).json(g.body); }
  const gid = catchAllJobId();
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(toInt).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Pick at least one entry' });

  // Only rows still sitting on the catch-all may be pulled across. Anything already on a real
  // job is somebody's costed work, and moving it from here would be a silent re-allocation.
  const rows = all(`SELECT * FROM job_daily_work WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const notFree = rows.filter((r) => r.job_id !== gid);
  if (rows.length !== ids.length || notFree.length) {
    return res.status(409).json({ error: 'Some of those entries are already on a job card — reload and try again' });
  }
  // Moving a line off the pool changes a signed-off day's daily work too.
  { const g = attendance.checkDaysOpen(rows.map((r) => r.work_date)); if (!g.ok) return res.status(g.status).json(g.body); }
  // Claiming a line for a card also settles which machine it was on — but only when the line does
  // not already say. A line that names a DIFFERENT vehicle from the card is somebody's record, and
  // overwriting it would erase the one signal that the wrong row is being attached.
  tx(() => {
    for (const r of rows) {
      if (r.asset_id == null && job.asset_id) {
        run('UPDATE job_daily_work SET job_id = ?, asset_id = ? WHERE id = ?', id, job.asset_id, r.id);
      } else {
        run('UPDATE job_daily_work SET job_id = ? WHERE id = ?', id, r.id);
      }
    }
  });
  settleAfterMove(gid, id, job.asset_id);
  audit.record({ userId: req.user.id, entity: 'job_daily_work', entityId: id, action: 'attach',
    before: { job_id: gid }, after: { job_id: id, rows: rows.length } });
  res.json({ attached: rows.length, hours: rows.reduce((s, r) => s + (Number(r.hours) || 0), 0) });
}));

router.post('/:id/parts/attach', requireAuth, requireCap('jobs.parts'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const job = get('SELECT * FROM job_cards WHERE id = ?', id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  { const g = jobstate.checkAdd(job, 'attach', { user: req.user }); if (!g.ok) return res.status(g.status).json(g.body); }
  const gid = catchAllJobId();
  const grnIds = (Array.isArray(req.body.receipts) ? req.body.receipts : []).map(toInt).filter(Boolean);
  const partIds = (Array.isArray(req.body.parts) ? req.body.parts : []).map(toInt).filter(Boolean);
  if (!grnIds.length && !partIds.length) return res.status(400).json({ error: 'Pick at least one item' });

  const receipts = grnIds.length ? all(
    `SELECT g.id, g.qty, g.unit_price, COALESCE(g.description, ml.description) AS description, ml.id AS mrn_line_id
       FROM grn g JOIN mrn_lines ml ON ml.id = g.mrn_line_id JOIN mrn m ON m.id = ml.mrn_id
      WHERE g.id IN (${grnIds.map(() => '?').join(',')})
        AND m.job_id IS NULL AND NOT EXISTS (SELECT 1 FROM job_parts jp WHERE jp.mrn_line_id = ml.id)`, ...grnIds) : [];
  if (receipts.length !== grnIds.length) {
    return res.status(409).json({ error: 'Some of those receipts are already on a job card — reload and try again' });
  }
  const parts = partIds.length ? all(
    `SELECT * FROM job_parts WHERE id IN (${partIds.map(() => '?').join(',')}) AND job_id = ?`, ...partIds, gid) : [];
  if (parts.length !== partIds.length) {
    return res.status(409).json({ error: 'Some of those items are already on a job card — reload and try again' });
  }

  tx(() => {
    for (const r of receipts) {
      // mrn_line_id is what keeps this receipt out of the unassigned list next time.
      run(`INSERT INTO job_parts (job_id, source_type, source_id, description, qty, unit_price, is_external_repair, mrn_line_id)
           VALUES (?, 'grn', ?, ?, ?, ?, 0, ?)`,
      id, r.id, r.description, r.qty, r.unit_price, r.mrn_line_id);
    }
    for (const p of parts) run('UPDATE job_parts SET job_id = ? WHERE id = ?', id, p.id);
  });
  settleAfterMove(parts.length ? gid : null, id, job.asset_id);
  audit.record({ userId: req.user.id, entity: 'job_parts', entityId: id, action: 'attach',
    after: { receipts: receipts.length, moved: parts.length } });
  res.json({ attached: receipts.length + parts.length,
    value: [...receipts, ...parts].reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.unit_price) || 0), 0) });
}));

// ---- parts (bridge to Stores / Oil / external) ----------------------------

router.post(
  '/:id/parts',
  requireAuth,
  requireCap('jobs.parts'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const job = get('SELECT * FROM job_cards WHERE id = ?', id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    { const g = jobstate.checkAdd(job, 'part', { user: req.user }); if (!g.ok) return res.status(g.status).json(g.body); }
    const b = req.body;
    require_(b, ['source_type', 'description']);
    const info = run(
      `INSERT INTO job_parts (job_id, source_type, source_id, description, qty, unit_price, is_external_repair)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      b.source_type,
      toInt(b.source_id),
      b.description,
      toNum(b.qty, 1),
      b.unit_price === undefined || b.unit_price === null || b.unit_price === '' ? null : toNum(b.unit_price),
      b.is_external_repair ? 1 : 0
    );
    costing.refreshJobTotals(id);
    audit.record({ userId: req.user.id, entity: 'job_parts', entityId: info.lastInsertRowid, action: 'create' });
    res.status(201).json(get('SELECT * FROM job_parts WHERE id = ?', info.lastInsertRowid));
  })
);

router.patch(
  '/:id/parts/:partId',
  requireAuth,
  requireCap('jobs.parts'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const partId = toInt(req.params.partId);
    const job = get('SELECT * FROM job_cards WHERE id = ?', id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    { const g = jobstate.checkAdd(job, 'price', { user: req.user }); if (!g.ok) return res.status(g.status).json(g.body); }
    const b = req.body;
    if (b.unit_price !== undefined) run('UPDATE job_parts SET unit_price = ? WHERE id = ? AND job_id = ?', b.unit_price === '' || b.unit_price === null ? null : toNum(b.unit_price), partId, id);
    if (b.qty !== undefined) run('UPDATE job_parts SET qty = ? WHERE id = ? AND job_id = ?', toNum(b.qty, 1), partId, id);
    costing.refreshJobTotals(id);
    res.json(get('SELECT * FROM job_parts WHERE id = ?', partId));
  })
);

router.delete(
  '/:id/parts/:partId',
  requireAuth,
  requireCap('jobs.parts'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const partId = toInt(req.params.partId);
    const job = get('SELECT * FROM job_cards WHERE id = ?', id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    { const g = jobstate.checkAdd(job, 'part', { user: req.user }); if (!g.ok) return res.status(g.status).json(g.body); }
    const row = get('SELECT * FROM job_parts WHERE id = ? AND job_id = ?', partId, id);
    if (!row) return res.status(404).json({ error: 'Item not found on this job' });

    const gid = id === catchAllJobId() ? id : ensureCatchAllJobId();
    const unlink = gid !== id;
    const settle = settleAfterDetach(job, unlink ? gid : null);

    // MOVED to the catch-all, not deleted — including receipt-sourced lines, which is the case
    // worth being careful about. Deleting one would drop its job_parts row, and a receipt with no
    // job_parts row carrying its mrn_line_id is how the pool decides something is unclaimed — so
    // it would come back as a *receipt* while the row that recorded the price and quantity was
    // gone. Moving it keeps one row, in one pool, with its figures intact. It also works when the
    // request DOES name a job (mrn.job_id set), where deleting would return it to nothing at all.
    if (unlink) run('UPDATE job_parts SET job_id = ? WHERE id = ?', gid, partId);
    else run('DELETE FROM job_parts WHERE id = ?', partId);
    settle();

    audit.record({ userId: req.user.id, entity: 'job_parts', entityId: partId,
      action: unlink ? 'unlink' : 'delete', before: { job_id: id }, after: unlink ? { job_id: gid } : null });
    res.json({ ok: true, unlinked: !!unlink,
      message: unlink ? 'Moved to unassigned parts' : 'Item deleted' });
  })
);

// ---- edit the card itself --------------------------------------------------
// Vehicle, description and type. Description is free text; the other two move money, so each
// carries a guard: reassigning the vehicle re-points the job's costs (and has to respect the
// one-open-card-per-vehicle rule), and switching to a service job swaps the labour basis from
// hours × rate to a single flat charge.
router.patch(
  '/:id',
  requireAuth,
  requireCap('jobs.edit'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const job = loadJob(id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    { const g = jobstate.checkAdd(job, 'edit', { user: req.user }); if (!g.ok) return res.status(g.status).json(g.body); }

    const b = req.body || {};
    const sets = [];
    const params = [];
    const before = { asset_id: job.asset_id, description: job.description, type: job.type, workshop_id: job.workshop_id };
    const warnings = [];

    // -- workshop (who does the repair)
    let newWorkshopId;
    if (b.workshop_id !== undefined && Number(b.workshop_id) !== job.workshop_id) {
      // A finished card stays with the workshop that did the work: its cost is already reported there.
      if (jobstate.isFinal(job.status)) return res.status(409).json({ error: 'A closed job card stays with the workshop that did the work.' });
      newWorkshopId = workshops.mustBeActive(b.workshop_id).id;
      sets.push('workshop_id = ?'); params.push(newWorkshopId);
    }

    // -- description
    if (b.description !== undefined) {
      const d = String(b.description || '').trim();
      if (!d) return res.status(400).json({ error: 'Description cannot be empty' });
      sets.push('description = ?'); params.push(d);
    }

    // -- type
    let newType = null;
    if (b.type !== undefined && b.type !== job.type) {
      newType = String(b.type || '').trim();
      if (!JOB_TYPES.includes(newType)) return res.status(400).json({ error: `Type must be one of: ${JOB_TYPES.join(', ')}` });
      // A service job's labour is ONE flat charge, so the daily-work hours stop counting the
      // moment the type changes. Say how much is at stake and make the caller confirm.
      if (newType === 'service' && job.flat_labour == null) {
        const hoursCost = costing.computeJobCost(id).labour_cost;
        if (hoursCost > 0 && !b.confirm_type_change) {
          return res.status(409).json({
            error: `Switching to a service job replaces the daily-work labour with a single flat charge. `
                 + `Rs ${hoursCost.toLocaleString()} of hours-based labour will stop counting until you set the flat amount.`,
            labour_at_risk: hoursCost, needs_confirm: true,
          });
        }
        if (hoursCost > 0) warnings.push(`Rs ${hoursCost.toLocaleString()} of hours-based labour no longer counts — set the service flat labour.`);
      }
      const letter = newType === 'service' ? 'S' : 'R';
      if (job.job_no && !String(job.job_no).includes('/' + letter + '/')) {
        warnings.push(`Job number ${job.job_no} keeps its original letter — it is on the printed paperwork, so it is not renumbered.`);
      }
      sets.push('type = ?'); params.push(newType);
    }

    // -- vehicle
    let newAssetId;
    if (b.asset_id !== undefined) {
      newAssetId = toInt(b.asset_id) || null;
      if (newAssetId !== job.asset_id) {
        if (newAssetId) {
          const a = get('SELECT id FROM assets WHERE id = ?', newAssetId);
          if (!a) return res.status(400).json({ error: 'Unknown vehicle' });
          // Moving an OPEN card onto a vehicle is opening a job for that vehicle.
          if (jobstate.isOpen(job.status)) {
            const guard = jobstate.checkOneOpenJob(newAssetId, { excludeJobId: id });
            if (!guard.ok) {
              return res.status(409).json({
                error: `Cannot move to that vehicle — ${guard.blocking.job_no} is already open for it.`,
                blocking_job: guard.blocking,
              });
            }
          }
        }
        sets.push('asset_id = ?'); params.push(newAssetId);
      } else newAssetId = undefined;
    }

    if (!sets.length) return res.json({ ...loadJob(id), warnings });

    // Buckets the job's money sits in BEFORE the move — they have to be recomputed after it,
    // or the vehicle it left keeps costs it no longer has.
    const oldBuckets = newAssetId !== undefined ? costing.vehicleMonthsForJob(id, job.asset_id) : [];

    tx(() => {
      run(`UPDATE job_cards SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...params, id);
      if (newAssetId !== undefined) {
        // The issues were raised against whatever vehicle the card named, so they follow it.
        run('UPDATE issues SET asset_id = ? WHERE job_id = ?', newAssetId, id);
        run('UPDATE stock_moves SET asset_id = ? WHERE job_id = ?', newAssetId, id);
      }
    });

    costing.refreshJobTotals(id);
    if (newAssetId !== undefined) {
      for (const b2 of oldBuckets) costing.recalcVehicleMonth(b2.assetId, b2.year, b2.month);
      for (const b2 of costing.vehicleMonthsForJob(id, newAssetId)) costing.recalcVehicleMonth(b2.assetId, b2.year, b2.month);
    }

    const after = { asset_id: newAssetId !== undefined ? newAssetId : job.asset_id, description: b.description, type: newType,
      workshop_id: newWorkshopId !== undefined ? newWorkshopId : job.workshop_id };
    audit.record({ userId: req.user.id, entity: 'job_card', entityId: id, action: 'edit', before, after, reason: req.body.reason || null });
    emitter.emit('job_updated', { job_id: id, action: 'edit' });
    emitter.emit('dashboard_refresh', { reason: 'job_edit' });
    res.json({ ...loadJob(id), warnings });
  })
);

// ---- service flat labour --------------------------------------------------

router.patch(
  '/:id/flat-labour',
  requireAuth,
  requireCap('jobs.flat_labour'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const job = get('SELECT * FROM job_cards WHERE id = ?', id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    { const g = jobstate.checkAdd(job, 'price', { user: req.user }); if (!g.ok) return res.status(g.status).json(g.body); }
    if (job.type !== 'service') return res.status(400).json({ error: 'Flat labour applies to service jobs only' });
    const amount = req.body.flat_labour === '' || req.body.flat_labour == null ? null : toNum(req.body.flat_labour);
    run('UPDATE job_cards SET flat_labour = ? WHERE id = ?', amount, id);
    costing.refreshJobTotals(id);
    audit.record({ userId: req.user.id, entity: 'job_card', entityId: id, action: 'set_flat_labour', after: { flat_labour: amount } });
    res.json(loadJob(id));
  })
);

// ---- cost breakdown -------------------------------------------------------

router.get(
  '/:id/cost',
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const job = get('SELECT * FROM job_cards WHERE id = ?', id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ cost: costing.reconciledCost(id), readiness: costing.closureReadiness(id) });
  })
);

module.exports = router;
