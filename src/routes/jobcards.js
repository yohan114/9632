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

const router = express.Router();

// Order by the job number itself — YYYY/M/(R|S)/seq — newest first: year, then month,
// then the sequence number (xxx), all compared numerically (so 12 > 6 and 383 > 59).
const JOB_NO_ORDER = `
  CAST(substr(j.job_no, 1, instr(j.job_no, '/') - 1) AS INTEGER) DESC,
  CAST(substr(substr(j.job_no, instr(j.job_no, '/') + 1), 1,
              instr(substr(j.job_no, instr(j.job_no, '/') + 1), '/') - 1) AS INTEGER) DESC,
  CAST(substr(j.job_no, instr(j.job_no, '/R/') + instr(j.job_no, '/S/') + 3) AS INTEGER) DESC,
  j.id DESC`;

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
            p.name AS project_name
       FROM job_cards j
       LEFT JOIN assets a ON a.id = j.asset_id
       LEFT JOIN projects p ON p.id = j.project_id
      WHERE j.id = ?`,
    id
  );
}

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
    const rows = all(
      `SELECT j.id, j.job_no, j.type, j.severity, j.status, j.description,
              j.total_cost, j.material_cost, j.labour_cost, j.requested_at, j.closed_at,
              a.code AS asset_code, p.name AS project_name
         FROM job_cards j
         LEFT JOIN assets a ON a.id = j.asset_id
         LEFT JOIN projects p ON p.id = j.project_id
         ${where}
        ORDER BY ${JOB_NO_ORDER}
        LIMIT ${toInt(req.query.limit, 500)}`,
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
    res.status(201).json({ job: loadJob(info.lastInsertRowid), unresolved });
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
    // to the job's date frame: [job start − 3 days … job close + 3 days].
    const mrnItems = all(
      `SELECT m.id AS mrn_id, m.mrn_no, m.req_date, ml.description, ml.category, ml.qty, ml.qty_received
         FROM job_parts jp
         JOIN mrn_lines ml ON ml.id = jp.mrn_line_id
         JOIN mrn m ON m.id = ml.mrn_id
         JOIN job_cards j ON j.id = jp.job_id
        WHERE jp.job_id = ? AND jp.mrn_line_id IS NOT NULL
          AND date(m.req_date) BETWEEN date(j.requested_at, '-3 days')
                                   AND date(COALESCE(j.closed_at, j.completed_at, j.requested_at), '+3 days')
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

    // Closure gate.
    if (target === 'CLOSED') {
      const readiness = costing.closureReadiness(id);
      if (!readiness.ready) {
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
          run(`UPDATE assets SET status='under_repair' WHERE id = ? AND status <> 'decommissioned'`, job.asset_id);
          break;
        case 'mark_complete':
          sets.push('completed_at = ' + now);
          break;
        case 'close':
          sets.push('closed_at = ' + now);
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
    res.json({ ...loadJob(id), nextStates: jobstate.nextStates(target) });
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

router.delete(
  '/:id/daily-work/:lineId',
  requireAuth,
  requireRole('workshop'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const job = get('SELECT * FROM job_cards WHERE id = ?', id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!editable(job, req.user)) return res.status(423).json({ error: 'Job is closed (locked)' });
    run('DELETE FROM job_daily_work WHERE id = ? AND job_id = ?', toInt(req.params.lineId), id);
    costing.refreshJobTotals(id);
    res.json({ ok: true });
  })
);

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
    const job = get('SELECT * FROM job_cards WHERE id = ?', id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!editable(job, req.user)) return res.status(423).json({ error: 'Job is closed (locked)' });
    run('DELETE FROM job_parts WHERE id = ? AND job_id = ?', toInt(req.params.partId), id);
    costing.refreshJobTotals(id);
    res.json({ ok: true });
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
