'use strict';

const express = require('express');
const { get, all, run } = require('../db');
const { requireRole } = require('../lib/auth');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const audit = require('../lib/audit');
const aliases = require('../lib/aliases');
const { sendXlsx } = require('../lib/export');

const router = express.Router();

const MUTABLE = [
  'registration', 'ec_code', 'brand', 'type', 'model_no', 'capacity', 'yom',
  'serial_no', 'chassis_no', 'engine_no', 'asset_class', 'home_project_id',
  'current_project_id', 'status', 'running_hours', 'notes',
];

// Columns that must hold a number or nothing. An HTML <select>/<input> that the user left
// alone posts "" — storing that in a project FK fails the foreign key ("no project 0"), and
// in a number column it silently becomes text. "" means "not set", so it becomes NULL.
const NUMERIC = new Set(['home_project_id', 'current_project_id', 'running_hours', 'legacy_fleet_id', 'in_register']);
const cleanValue = (col, v) => {
  if (v === '' || v === null || v === undefined) return null;
  if (!NUMERIC.has(col)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function listAssets(query = {}) {
  const clauses = [];
  const params = [];
  if (query.q) {
    clauses.push('(a.code LIKE ? OR a.brand LIKE ? OR a.type LIKE ? OR a.registration LIKE ?)');
    const like = '%' + query.q + '%';
    params.push(like, like, like, like);
  }
  if (query.project_id) { clauses.push('a.current_project_id = ?'); params.push(toInt(query.project_id)); }
  if (query.status) { clauses.push('a.status = ?'); params.push(query.status); }
  if (query.asset_class) { clauses.push('a.asset_class = ?'); params.push(query.asset_class); }
  if (query.in_register !== undefined) { clauses.push('a.in_register = ?'); params.push(toInt(query.in_register)); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  return all(
    `SELECT a.*, p.name AS current_project,
            (SELECT COUNT(*) FROM job_cards j WHERE j.asset_id = a.id AND j.status NOT IN ('CLOSED','REJECTED')) AS open_jobs,
            (SELECT b.serial_no FROM batteries b WHERE b.current_asset_id = a.id AND b.state='installed' LIMIT 1) AS current_battery,
            (SELECT COALESCE(SUM(j.total_cost),0) FROM job_cards j WHERE j.asset_id = a.id) AS lifetime_cost
       FROM assets a
       LEFT JOIN projects p ON p.id = a.current_project_id
       ${where}
      ORDER BY a.code
      LIMIT ${toInt(query.limit, 200)}`,
    ...params
  );
}

router.get('/', asyncHandler((req, res) => res.json(listAssets(req.query))));

router.get('/export.xlsx', asyncHandler(async (req, res) => {
  const rows = listAssets({ ...req.query, limit: 100000 });
  await sendXlsx(res, 'assets.xlsx', [{
    name: 'Assets',
    columns: [
      { header: 'Code', key: 'code' }, { header: 'E&C No', key: 'ec_code' }, { header: 'Reg No', key: 'registration' },
      { header: 'Class', key: 'asset_class' },
      { header: 'Brand', key: 'brand' }, { header: 'Type', key: 'type' },
      { header: 'Project', key: 'current_project' }, { header: 'Status', key: 'status' },
      { header: 'Open Jobs', key: 'open_jobs' }, { header: 'Lifetime Cost', key: 'lifetime_cost' },
    ],
    rows,
  }]);
}));

// Lightweight typeahead for vehicle/asset pickers — code + registration only.
router.get('/search', asyncHandler((req, res) => {
  const q = String(req.query.q || '').trim();
  if (q) {
    const like = '%' + q + '%';
    return res.json(all(
      `SELECT id, code, registration, asset_class FROM assets
        WHERE code LIKE ? OR registration LIKE ? OR ec_code LIKE ?
        ORDER BY (code = ?) DESC, in_register DESC, code
        LIMIT ${toInt(req.query.limit, 20)}`,
      like, like, like, q));
  }
  res.json(all(`SELECT id, code, registration, asset_class FROM assets ORDER BY in_register DESC, code LIMIT ${toInt(req.query.limit, 20)}`));
}));

router.get('/:id', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const asset = get('SELECT * FROM assets WHERE id = ?', id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const current_project = asset.current_project_id ? get('SELECT * FROM projects WHERE id = ?', asset.current_project_id) : null;
  const current_battery = get(`SELECT * FROM batteries WHERE current_asset_id = ? AND state='installed' LIMIT 1`, id);
  const open_jobs = all(`SELECT id, job_no, type, status, description, total_cost FROM job_cards WHERE asset_id = ? AND status NOT IN ('CLOSED','REJECTED') ORDER BY id DESC`, id);
  const lc = get(
    `SELECT COALESCE(SUM(labour_cost),0) labour, COALESCE(SUM(material_cost),0) material,
            COALESCE(SUM(oil_cost),0) oil, COALESCE(SUM(general_cost),0) general,
            COALESCE(SUM(external_cost),0) external, COALESCE(SUM(total_cost),0) total
       FROM job_cards WHERE asset_id = ?`, id
  );

  // service due
  const spec = get('SELECT * FROM service_specs WHERE asset_id = ? ORDER BY id DESC LIMIT 1', id);
  let service_due = null;
  if (spec) {
    const rh = asset.running_hours || 0;
    const interval = spec.interval_hours || 0;
    service_due = {
      interval_hours: interval,
      running_hours: rh,
      due: interval > 0 ? rh >= interval : false,
      hours_remaining: interval > 0 ? Math.max(0, interval - rh) : null,
      expected_cost: spec.expected_cost,
    };
  }

  // unified timeline
  const timeline = [];
  for (const l of all(`SELECT sl.txn_date d, sl.kind, sl.qty, pr.name pn, pr.unit FROM stock_ledger sl JOIN products pr ON pr.id=sl.product_id WHERE sl.asset_id = ? ORDER BY sl.id DESC LIMIT 50`, id))
    timeline.push({ date: l.d, kind: 'oil', ref: l.kind, description: `${l.pn} ${Math.abs(l.qty)} ${l.unit}` });
  for (const i of all(`SELECT issue_date d, description, qty FROM issues WHERE asset_id = ? ORDER BY id DESC LIMIT 50`, id))
    timeline.push({ date: i.d, kind: 'issue', ref: null, description: `${i.description} x${i.qty}` });
  for (const m of all(`SELECT req_date d, mrn_no, purpose FROM mrn WHERE asset_id = ? ORDER BY id DESC LIMIT 50`, id))
    timeline.push({ date: m.d, kind: 'mrn', ref: m.mrn_no, description: m.purpose || 'Material request' });
  // A transfer reaches this machine either as the whole note's from/to, or through a single
  // item on it — one note routinely pulls parts off several machines at once, and each of
  // those belongs in that machine's history, described by the item rather than the note.
  for (const t of all(
    `SELECT t.txn_date d, t.mtn_no, COALESCE(l.description, t.description) AS description
       FROM mtn t
       LEFT JOIN mtn_lines l ON l.mtn_id = t.id AND (l.from_asset_id = ? OR l.to_asset_id = ?)
      WHERE t.from_asset_id = ? OR t.to_asset_id = ? OR l.id IS NOT NULL
      ORDER BY t.id DESC LIMIT 50`, id, id, id, id))
    timeline.push({ date: t.d, kind: 'mtn', ref: t.mtn_no, description: t.description || 'Transfer' });
  for (const e of all(`SELECT event_date d, event_type, reason FROM battery_events WHERE from_asset_id = ? OR to_asset_id = ? ORDER BY id DESC LIMIT 50`, id, id))
    timeline.push({ date: e.d, kind: 'battery', ref: e.event_type, description: e.reason || e.event_type });
  for (const j of all(`SELECT requested_at d, job_no, description, status FROM job_cards WHERE asset_id = ? ORDER BY id DESC LIMIT 50`, id))
    timeline.push({ date: (j.d || '').slice(0, 10), kind: 'job', ref: j.job_no, description: `${j.description || ''} [${j.status}]` });
  timeline.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  res.json({ asset, current_project, current_battery, open_jobs, lifetime_cost: lc, service_due, timeline: timeline.slice(0, 100) });
}));

router.post('/', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['code']);
  const norm = aliases.normalize(b.code);
  if (get('SELECT id FROM assets WHERE code_norm = ?', norm)) return res.status(409).json({ error: 'Asset code already exists' });
  const given = MUTABLE.filter((c) => b[c] !== undefined);
  const cols = ['code', 'code_norm', ...given];
  const vals = [b.code, norm, ...given.map((c) => cleanValue(c, b[c]))];
  const info = run(`INSERT INTO assets (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...vals);
  audit.record({ userId: req.user.id, entity: 'asset', entityId: info.lastInsertRowid, action: 'create', after: { code: b.code } });
  res.status(201).json(get('SELECT * FROM assets WHERE id = ?', info.lastInsertRowid));
}));

router.patch('/:id', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const before = get('SELECT * FROM assets WHERE id = ?', id);
  if (!before) return res.status(404).json({ error: 'Asset not found' });
  const sets = [];
  const params = [];
  for (const c of MUTABLE) {
    if (req.body[c] !== undefined) {
      sets.push(`${c} = ?`);
      params.push(cleanValue(c, req.body[c]));
    }
  }
  if (!sets.length) return res.json(before);
  sets.push("updated_at = datetime('now')");
  run(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  const after = get('SELECT * FROM assets WHERE id = ?', id);
  audit.record({ userId: req.user.id, entity: 'asset', entityId: id, action: 'update', before, after });
  res.json(after);
}));

module.exports = router;
