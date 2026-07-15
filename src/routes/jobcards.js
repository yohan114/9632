'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireAuth, requireRole, hasRole } = require('../lib/auth');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const audit = require('../lib/audit');
const aliases = require('../lib/aliases');
const jobstate = require('../lib/jobstate');
const costing = require('../lib/costing');

const router = express.Router();

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
  return hasRole(user, 'admin'); // closed cards are locked; admin edits are audited
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
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const rows = all(
      `SELECT j.id, j.job_no, j.type, j.severity, j.status, j.description,
              j.total_cost, j.requested_at, j.closed_at,
              a.code AS asset_code, p.name AS project_name
         FROM job_cards j
         LEFT JOIN assets a ON a.id = j.asset_id
         LEFT JOIN projects p ON p.id = j.project_id
         ${where}
        ORDER BY j.id DESC
        LIMIT ${toInt(req.query.limit, 200)}`,
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
    const cost = costing.computeJobCost(id);
    const readiness = costing.closureReadiness(id);
    const snapshot = get('SELECT * FROM job_costs WHERE job_id = ? ORDER BY id DESC LIMIT 1', id);

    res.json({
      job,
      approvals,
      dailyWork,
      parts,
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
    const info = run(
      `INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      b.work_date || new Date().toISOString().slice(0, 10),
      b.mechanic || null,
      b.description || null,
      toNum(b.hours, 0),
      isExternal,
      isExternal ? toNum(b.external_value, 0) : 0
    );
    costing.refreshJobTotals(id);
    audit.record({ userId: req.user.id, entity: 'job_daily_work', entityId: info.lastInsertRowid, action: 'create' });
    res.status(201).json(get('SELECT * FROM job_daily_work WHERE id = ?', info.lastInsertRowid));
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

// ---- cost breakdown -------------------------------------------------------

router.get(
  '/:id/cost',
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    const job = get('SELECT * FROM job_cards WHERE id = ?', id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ cost: costing.computeJobCost(id), readiness: costing.closureReadiness(id) });
  })
);

module.exports = router;
