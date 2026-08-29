'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireAuth, requireRole, hasRole } = require('../lib/auth');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const audit = require('../lib/audit');
const aliases = require('../lib/aliases');
const mechanics = require('../lib/mechanics');
const jobstate = require('../lib/jobstate');
const costing = require('../lib/costing');
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

function jobNo(type) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const letter = type === 'service' ? 'S' : 'R';
  const prefix = `${year}/${month}/${letter}/`;
  const rows = all('SELECT job_no FROM job_cards WHERE job_no LIKE ?', prefix + '%');
  let max = 0;
  for (const r of rows) {
    const seq = parseInt(String(r.job_no).split('/').pop(), 10);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return prefix + (max + 1);
}

function loadJob(id) {
  return get(
    `SELECT j.*, a.code AS asset_code, a.code_norm AS asset_code_norm,
            a.registration AS asset_reg, a.ec_code AS asset_ec,
            p.name AS project_name
       FROM job_cards j
       LEFT JOIN assets a ON a.id = j.asset_id
       LEFT JOIN projects p ON p.id = j.project_id
      WHERE j.id = ?`,
    id
  );
}

// The only two kinds of card. The letter in the job number (…/R/… or …/S/…) is set from this
// at creation and is never rewritten afterwards — the number is what is printed on the
// paperwork, so it stays put and a later type change is reported as a mismatch instead.
const JOB_TYPES = ['repair', 'service'];

function editable(job, user) {
  if (job.status !== 'CLOSED') return true;
  // Closed cards can still receive items/edits from the managing roles (admin
  // included via hasRole); all such edits are audited. Historical totals are kept.
  return hasRole(user, 'workshop', 'storekeeper', 'manager');
}

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
    // Only currently-open job cards (for pickers that log against an active job).
    if (req.query.open === '1') clauses.push("j.status NOT IN ('CLOSED', 'REJECTED')");
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
              j.asset_id,
              a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec, p.name AS project_name`;
    const from = `FROM job_cards j
         LEFT JOIN assets a ON a.id = j.asset_id
         LEFT JOIN projects p ON p.id = j.project_id`;

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
                        AND s.status NOT IN ('CLOSED', 'REJECTED')) END AS open_siblings
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
  requireRole('transport_manager', 'workshop'),
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

    const no = jobNo(type);
    const info = run(
      `INSERT INTO job_cards (job_no, ref, asset_id, project_id, site, type, severity, description,
                              status, requested_by, requested_by_user)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?)`,
      no,
      b.ref || null,
      assetId || null,
      toInt(b.project_id),
      b.site || null,
      type,
      b.severity === 'major' || b.severity === 'minor' ? b.severity : null,
      b.description,
      b.requested_by || req.user.fullName || req.user.username,
      req.user.id
    );
    audit.record({ userId: req.user.id, entity: 'job_card', entityId: info.lastInsertRowid, action: 'create', after: { job_no: no } });
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
    // MRN request lines behind this job's assigned items (the request side), limited
    // to the job's date frame: [job start − 3 days … job close + 3 days]. While the card is
    // OPEN the frame runs to today — otherwise a reopened card (whose close dates are cleared)
    // would collapse to requested_at + 3 days and hide the parts it was reopened to add.
    const mrnItems = all(
      `SELECT m.id AS mrn_id, m.mrn_no, m.req_date, ml.description, ml.category, ml.qty, ml.qty_received
         FROM job_parts jp
         JOIN mrn_lines ml ON ml.id = jp.mrn_line_id
         JOIN mrn m ON m.id = ml.mrn_id
         JOIN job_cards j ON j.id = jp.job_id
        WHERE jp.job_id = ? AND jp.mrn_line_id IS NOT NULL
          AND date(m.req_date) BETWEEN date(j.requested_at, '-3 days')
                                   AND date(COALESCE(j.closed_at, j.completed_at, date('now')), '+3 days')
        ORDER BY CAST(m.mrn_no AS INTEGER), m.mrn_no, ml.id`,
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

    res.json({
      job,
      approvals,
      dailyWork,
      parts,
      mrnItems,
      labour: cost.labourLines,
      labourStored: labour,
      oilIssues,
      generalIssues,
      cost,
      readiness,
      snapshot,
      nextStates: jobstate.nextStates(job.status),
      canReopen: jobstate.canReopen(req.user.roles),
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

    const check = jobstate.checkTransition(job.status, target, req.user.roles);
    if (!check.ok) return res.status(400).json({ error: check.error });

    const isReopen = job.status === 'CLOSED' && target === 'IN_PROGRESS';
    if (isReopen) {
      // Reopening a closed card is still "opening a job" for that vehicle.
      const guard = jobstate.checkOneOpenJob(job.asset_id, { excludeJobId: id });
      if (!guard.ok) {
        return res.status(409).json({
          error: `Cannot reopen — ${guard.blocking.job_no} is already open for this vehicle.`,
          blocking_job: guard.blocking,
        });
      }
      // A reopen rewrites cost history, so it must say why. Every other transition is
      // self-explanatory from the state pair; this one is not.
      if (!String(reason || '').trim()) {
        return res.status(400).json({ error: 'A reason is required to reopen a closed job' });
      }
    }

    // Closure gate. A card that was already closed once cleared this gate (or was closed by
    // import / close-on-date, which never enforced it) — re-blocking it would strand every
    // reopened legacy job in IN_PROGRESS forever, so the gate applies to first closures only.
    if (target === 'CLOSED') {
      const wasReopened = get('SELECT 1 v FROM job_reopens WHERE job_id = ? LIMIT 1', id);
      const readiness = costing.closureReadiness(id);
      if (!readiness.ready && !wasReopened) {
        return res.status(409).json({ error: 'Job is not fully priced — cannot close', missing: readiness.missing });
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
          const role = hasRole(req.user, 'operational_manager') ? 'operational_manager' : 'transport_manager';
          run(`INSERT INTO job_approvals (job_id, role, approver_id, decision, reason) VALUES (?, ?, ?, 'rejected', ?)`, id, role, req.user.id, reason);
          break;
        }
        case 'assign':
          break;
        case 'start_or_reopen':
          if (!job.started_at) sets.push('started_at = ' + now);
          if (isReopen) {
            // Remember the close being undone, then clear it. Leaving completed_at/closed_at
            // set on an IN_PROGRESS card makes the status and the dates disagree everywhere
            // (dashboard counts, the closed-this-month figure, and the card's own MRN window,
            // which would otherwise stay clipped at the old close date and hide the very parts
            // the job was reopened to add).
            run(
              `INSERT INTO job_reopens (job_id, reopened_by, reason, prev_status, prev_completed_at, prev_closed_at, prev_total_cost)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              id, req.user.id, String(reason).trim(), job.status, job.completed_at, job.closed_at, job.total_cost);
            // First reopen wins: the anchor is the month the card was ORIGINALLY closed in.
            if (!job.original_completed_at && job.completed_at) {
              sets.push('original_completed_at = ?');
              params.push(job.completed_at);
            }
            sets.push('completed_at = NULL', 'closed_at = NULL');
          }
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

// Close a job card ON A CHOSEN (usually past) date — the correction tool for old cards that were
// finished in the yard but never closed in the system. Bypasses the step-by-step state machine
// (an old REQUESTED card can never legally reach CLOSED) but NOT the audit trail: the close is
// recorded with who/when/backdate. The date drives the monthly cost report (completed_at month).
// Unpriced lines don't block — they're returned as a warning so the office can price them later.
router.post(
  '/:id/close-on-date',
  requireAuth,
  requireRole('admin', 'operational_manager', 'workshop', 'manager'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const job = loadJob(id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status === 'CLOSED') return res.status(409).json({ error: 'Job is already closed (' + String(job.completed_at || '').slice(0, 10) + ')' });

    const date = String(req.body.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
      return res.status(400).json({ error: 'A valid close date (YYYY-MM-DD) is required' });
    }
    if (date > new Date().toISOString().slice(0, 10)) {
      return res.status(400).json({ error: 'Close date cannot be in the future' });
    }
    const reason = req.body.reason || null;

    const readiness = costing.closureReadiness(id);
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

// ---- daily work -----------------------------------------------------------

router.post(
  '/:id/daily-work',
  requireAuth,
  requireRole('workshop'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const job = get('SELECT * FROM job_cards WHERE id = ?', id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!editable(job, req.user)) return res.status(423).json({ error: 'Job is closed (locked)' });
    const b = req.body;
    const isExternal = b.is_external ? 1 : 0;
    const workDate = b.work_date || new Date().toISOString().slice(0, 10);
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

    const created = tx(() => {
      const ids = [];
      for (const mech of insertRows) {
        const info = run(
          `INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          id, workDate, mech, b.description || null, perRowHours, isExternal, isExternal ? toNum(b.external_value, 0) : 0
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
  requireRole('workshop'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const lineId = toInt(req.params.lineId);
    const job = get('SELECT * FROM job_cards WHERE id = ?', id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!editable(job, req.user)) return res.status(423).json({ error: 'Job is closed (locked)' });
    const row = get('SELECT * FROM job_daily_work WHERE id = ? AND job_id = ?', lineId, id);
    if (!row) return res.status(404).json({ error: 'Entry not found on this job' });

    const gid = catchAllJobId();
    // On the catch-all there is nowhere further to send it, so removing means removing.
    const unlink = gid && gid !== id;
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
 * Which vehicle a piece of unassigned labour is about, READ-ONLY.
 *
 * job_daily_work has no asset column — the machine is written into the description, the way the
 * paper sheets always did it ("AC-06 — Compressor clean and repair"). That is fine for reading one
 * line and useless for finding all of a vehicle's work, which is exactly what someone standing at
 * a job card wants: "what else was done on AC-06 that nobody has claimed?"
 *
 * Deliberately NOT aliases.resolveAsset(). That one learns as it goes — it writes an alias row and
 * bumps a hit count on every call — and a GET that renders a list must not teach the resolver
 * anything, or merely opening a picker rewrites the alias table and inflates the counts that decide
 * how future text resolves. This reads the same two tables and writes nothing.
 */
function vehicleGuesser() {
  const byNorm = new Map();
  for (const a of all('SELECT id, code, code_norm, registration FROM assets')) {
    if (a.code_norm) byNorm.set(a.code_norm, a);
  }
  const aliasToAsset = new Map();
  for (const r of all('SELECT raw_norm, asset_id FROM asset_aliases WHERE resolved = 1 AND asset_id IS NOT NULL')) {
    aliasToAsset.set(r.raw_norm, r.asset_id);
  }
  const byId = new Map([...byNorm.values()].map((a) => [a.id, a]));

  return (text) => {
    if (!text) return null;
    // The code is usually the first thing on the line, before a dash — but not always, so the
    // extracted token is tried too.
    const head = String(text).split(/[-—–:,(]/)[0];
    for (const candidate of [aliases.extractCode(text), head, String(text).split(/\s+/)[0]]) {
      const norm = aliases.normalize(candidate);
      if (!norm || norm.length < 2) continue;
      const direct = byNorm.get(norm);
      if (direct) return direct;
      const viaAlias = aliasToAsset.get(norm);
      if (viaAlias && byId.has(viaAlias)) return byId.get(viaAlias);
    }
    return null;
  };
}

router.get('/unassigned/daily-work', requireAuth, asyncHandler((req, res) => {
  const gid = catchAllJobId();
  if (!gid) return res.json([]);
  const assetId = toInt(req.query.asset_id);
  const limit = toInt(req.query.limit, 200);
  const qRaw = req.query.q && String(req.query.q).trim() ? String(req.query.q).trim() : null;

  // Dates still narrow in SQL. The text search does NOT, because it has to match the vehicle as
  // well, and the vehicle is not a column — it is worked out from the description below.
  const clauses = ['d.job_id = ?']; const params = [gid];
  if (req.query.from) { clauses.push('date(d.work_date) >= date(?)'); params.push(String(req.query.from)); }
  if (req.query.to) { clauses.push('date(d.work_date) <= date(?)'); params.push(String(req.query.to)); }

  const guess = vehicleGuesser();
  let rows = all(
    `SELECT d.id, d.work_date, d.mechanic, d.description, d.hours, d.is_external, d.external_value
       FROM job_daily_work d
      WHERE ${clauses.join(' AND ')}
      ORDER BY date(d.work_date) DESC, d.id DESC`, ...params
  ).map((r) => {
    const a = guess(r.description);
    return { ...r, asset_id: a ? a.id : null, asset_code: a ? a.code : null, asset_reg: a ? a.registration : null };
  });

  if (qRaw) {
    const needle = qRaw.toLowerCase();
    const norm = aliases.normalize(qRaw);
    rows = rows.filter((r) =>
      String(r.description || '').toLowerCase().includes(needle)
      || String(r.mechanic || '').toLowerCase().includes(needle)
      || String(r.asset_code || '').toLowerCase().includes(needle)
      || String(r.asset_reg || '').toLowerCase().includes(needle)
      // "AC06" should find "AC-06" — punctuation is not something anyone types consistently.
      || (norm.length >= 2 && aliases.normalize(r.asset_code).includes(norm)));
  }

  // This job's own vehicle first. The parts picker does the same, and it is the whole value of
  // both — the line you want is almost always about the machine in front of you.
  if (assetId) {
    rows.sort((a, b) => (b.asset_id === assetId) - (a.asset_id === assetId));
  }
  res.json(rows.slice(0, limit));
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

router.post('/:id/daily-work/attach', requireAuth, requireRole('workshop'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const job = get('SELECT * FROM job_cards WHERE id = ?', id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!editable(job, req.user)) return res.status(423).json({ error: 'Job is closed (locked)' });
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
  tx(() => { for (const r of rows) run('UPDATE job_daily_work SET job_id = ? WHERE id = ?', id, r.id); });
  settleAfterMove(gid, id, job.asset_id);
  audit.record({ userId: req.user.id, entity: 'job_daily_work', entityId: id, action: 'attach',
    before: { job_id: gid }, after: { job_id: id, rows: rows.length } });
  res.json({ attached: rows.length, hours: rows.reduce((s, r) => s + (Number(r.hours) || 0), 0) });
}));

router.post('/:id/parts/attach', requireAuth, requireRole('workshop', 'storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const job = get('SELECT * FROM job_cards WHERE id = ?', id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!editable(job, req.user)) return res.status(423).json({ error: 'Job is closed (locked)' });
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
  requireRole('workshop', 'storekeeper'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const job = get('SELECT * FROM job_cards WHERE id = ?', id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!editable(job, req.user)) return res.status(423).json({ error: 'Job is closed (locked)' });
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
  requireRole('workshop', 'storekeeper'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const partId = toInt(req.params.partId);
    const job = get('SELECT * FROM job_cards WHERE id = ?', id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!editable(job, req.user)) return res.status(423).json({ error: 'Job is closed (locked)' });
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
  requireRole('workshop', 'storekeeper'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const partId = toInt(req.params.partId);
    const job = get('SELECT * FROM job_cards WHERE id = ?', id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!editable(job, req.user)) return res.status(423).json({ error: 'Job is closed (locked)' });
    const row = get('SELECT * FROM job_parts WHERE id = ? AND job_id = ?', partId, id);
    if (!row) return res.status(404).json({ error: 'Item not found on this job' });

    const gid = catchAllJobId();
    const unlink = gid && gid !== id;
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
  requireRole('workshop', 'operational_manager', 'manager'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const job = loadJob(id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!editable(job, req.user)) return res.status(423).json({ error: 'Job is closed (locked)' });

    const b = req.body || {};
    const sets = [];
    const params = [];
    const before = { asset_id: job.asset_id, description: job.description, type: job.type };
    const warnings = [];

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
          if (job.status !== 'CLOSED' && job.status !== 'REJECTED') {
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

    const after = { asset_id: newAssetId !== undefined ? newAssetId : job.asset_id, description: b.description, type: newType };
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
  requireRole('workshop', 'operational_manager'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const job = get('SELECT * FROM job_cards WHERE id = ?', id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!editable(job, req.user)) return res.status(423).json({ error: 'Job is closed (locked)' });
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
