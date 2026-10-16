'use strict';

const express = require('express');
const jobstate = require('../lib/jobstate');
const { get, all, run, tx } = require('../db');
const { requireCap } = require('../lib/auth');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const audit = require('../lib/audit');
const aliases = require('../lib/aliases');
const { sendXlsx } = require('../lib/export');

const router = express.Router();

const MUTABLE = [
  'registration', 'ec_code', 'brand', 'type', 'model_no', 'capacity', 'yom',
  'serial_no', 'chassis_no', 'engine_no', 'asset_class', 'home_project_id',
  'current_project_id', 'status', 'running_hours', 'notes', 'in_register',
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
            (SELECT COUNT(*) FROM job_cards j WHERE j.asset_id = a.id AND ${jobstate.openSql('j')}) AS open_jobs,
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

// Without Assets, the list is for the pickers: which vehicle, not what it has cost.
const PICKER_FIELDS = ['id', 'code', 'registration', 'ec_code', 'asset_class', 'type', 'brand'];
router.get('/', asyncHandler((req, res) => {
  const rows = listAssets(req.query);
  if (require('../lib/permissions').reaches(req.user, 'assets')) return res.json(rows);
  res.json(rows.map((r) => Object.fromEntries(PICKER_FIELDS.filter((k) => k in r).map((k) => [k, r[k]]))));
}));

router.get('/export.xlsx', requireCap('assets.export', 'assets.view'), asyncHandler(async (req, res) => {
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

router.get('/:id', requireCap('assets.view'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const asset = get('SELECT * FROM assets WHERE id = ?', id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const current_project = asset.current_project_id ? get('SELECT * FROM projects WHERE id = ?', asset.current_project_id) : null;
  const current_battery = get(`SELECT * FROM batteries WHERE current_asset_id = ? AND state='installed' LIMIT 1`, id);
  // A vehicle is shared by every workshop (Stage 3), so all its cards are listed — but a card of
  // another workshop shows only its number, status and workshop: no description, no cost, no link.
  const scope = require('../lib/scope');
  const WS = '(SELECT name FROM workshops w WHERE w.id = job_cards.workshop_id) AS workshop_name, workshop_id';
  const veil = (j) => {
    if (scope.mayReach(req.user, j.workshop_id)) {
      return { ...j, reachable: true, read_only: scope.isReadOnly(req.user, j.workshop_id) };
    }
    if (scope.mayRead(req.user, j.workshop_id, 'job')) {
      return { ...j, reachable: true, read_only: true };
    }
    return { id: j.id, job_no: j.job_no, status: j.status, type: j.type, workshop_name: j.workshop_name, workshop_id: j.workshop_id, reachable: false };
  };
  const open_jobs = all(`SELECT id, job_no, type, status, description, total_cost, ${WS} FROM job_cards WHERE asset_id = ? AND ${jobstate.openSql()} ORDER BY id DESC`, id).map(veil);
  // Partly closed (W2): the vehicle has left them, but prices or records are still to come.
  const partly_closed_jobs = all(`SELECT id, job_no, type, status, description, total_cost, partial_closed_at, ${WS} FROM job_cards WHERE asset_id = ? AND status = ? ORDER BY id DESC`, id, jobstate.PARTIAL).map(veil);
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
  for (const m of all(`SELECT req_date d, mrn_no, purpose, workshop_id,
                              (SELECT name FROM workshops w WHERE w.id = mrn.workshop_id) AS workshop_name
                         FROM mrn WHERE asset_id = ? ORDER BY id DESC LIMIT 50`, id)) {
    // Another workshop's request (Stage 3): its number and workshop only.
    const mine = scope.mayReach(req.user, m.workshop_id);
    timeline.push({ date: m.d, kind: 'mrn', ref: m.mrn_no,
      description: mine ? (m.purpose || 'Material request') : `Material request at ${m.workshop_name || 'another workshop'}` });
  }
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
  for (const j of all(`SELECT requested_at d, job_no, description, status, ${WS} FROM job_cards WHERE asset_id = ? ORDER BY id DESC LIMIT 50`, id)) {
    const mine = scope.mayReach(req.user, j.workshop_id);
    timeline.push({ date: (j.d || '').slice(0, 10), kind: 'job', ref: j.job_no,
      description: mine ? `${j.description || ''} [${j.status}]` : `[${j.status}] at ${j.workshop_name || 'another workshop'}` });
  }
  timeline.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  // Stage 7: where the machine stands (a site of its project, if one is set) and every move.
  const ops = require('../lib/operations');
  const place = { key: ops.keyOf(asset.current_project_id, asset.current_site_id), label: ops.labelOf(ops.keyOf(asset.current_project_id, asset.current_site_id)) };
  res.json({ asset, current_project, current_battery, open_jobs, partly_closed_jobs, lifetime_cost: lc, service_due, timeline: timeline.slice(0, 100),
    place, moves: ops.history(id) });
}));

router.post('/', requireCap('assets.create'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['code']);
  const norm = aliases.normalize(b.code);
  if (get('SELECT id FROM assets WHERE code_norm = ?', norm)) return res.status(409).json({ error: 'Asset code already exists' });

  // Default in_register to 1 when adding an asset manually from UI/API unless explicitly set to 0
  const inRegister = b.in_register !== undefined ? (Number(b.in_register) ? 1 : 0) : 1;
  const given = MUTABLE.filter((c) => c !== 'in_register' && b[c] !== undefined);
  const cols = ['code', 'code_norm', 'in_register', ...given];
  const vals = [b.code, norm, inRegister, ...given.map((c) => cleanValue(c, b[c]))];
  const info = run(`INSERT INTO assets (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...vals);
  const newAssetId = info.lastInsertRowid;

  // Auto-resolve any pending aliases that match the new asset's code or registration
  const regNorm = b.registration ? aliases.normalize(b.registration) : null;
  const pending = all(
    'SELECT id FROM asset_aliases WHERE (raw_norm = ? OR (raw_norm = ? AND ? IS NOT NULL)) AND resolved = 0',
    norm, regNorm, regNorm
  );
  for (const p of pending) {
    aliases.linkAlias(p.id, newAssetId);
  }
  // Record canonical code and registration aliases as resolved
  aliases.bumpAlias(norm, b.code, newAssetId, true, 'manual');
  if (regNorm && regNorm !== norm) {
    aliases.bumpAlias(regNorm, b.registration, newAssetId, true, 'manual');
  }

  audit.record({ userId: req.user.id, entity: 'asset', entityId: newAssetId, action: 'create', after: { code: b.code, in_register: inRegister } });
  res.status(201).json(get('SELECT * FROM assets WHERE id = ?', newAssetId));
}));

router.patch('/:id', requireCap('assets.edit'), asyncHandler((req, res) => {
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
  tx(() => {
    run(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    // Stage 7: a new project set here is a move today, kept in the machine's history.
    require('../lib/operations').recordEdit(req.user, before, get('SELECT * FROM assets WHERE id = ?', id));
  });
  const after = get('SELECT * FROM assets WHERE id = ?', id);
  audit.record({ userId: req.user.id, entity: 'asset', entityId: id, action: 'update', before, after });
  res.json(after);
}));

// Vehicle documents & statutory renewal compliance (Phase 3)
router.get('/:id/documents', requireCap('vehicle_docs.view'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const asset = get('SELECT id FROM assets WHERE id = ?', id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const today = req.query.today ? String(req.query.today).trim() : undefined;
  const docs = require('../lib/vehicle_documents').getVehicleDocuments(id, { today });
  res.json(docs);
}));

router.get('/:id/erl-checklist', requireCap('vehicle_docs.view'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const asset = get('SELECT id FROM assets WHERE id = ?', id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const targetDate = req.query.targetDate || req.query.target_date;
  const evaluation = require('../lib/vehicle_documents').evaluateErlChecklist(id, { targetDate });
  res.json(evaluation);
}));

// Initialize asset_images table in core database
try {
  run(`
    CREATE TABLE IF NOT EXISTS core.asset_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'exterior',
      title TEXT,
      description TEXT,
      file_size INTEGER,
      uploaded_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  run(`CREATE INDEX IF NOT EXISTS core.idx_asset_images_asset ON asset_images(asset_id)`);
  run(`CREATE INDEX IF NOT EXISTS core.idx_asset_images_category ON asset_images(category)`);
} catch (e) {
  console.error('Failed to init asset_images table:', e);
}

// Multi-category image gallery endpoints (Images 2 & 4)
router.get('/:id/images', requireCap('assets.view'), asyncHandler((req, res) => {
  const assetId = toInt(req.params.id);
  const asset = get('SELECT id FROM assets WHERE id = ?', assetId);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const category = req.query.category ? String(req.query.category).trim() : null;
  let sql = `
    SELECT ai.*, u.full_name AS uploaded_by_name, u.username AS uploaded_by_username
      FROM core.asset_images ai
      LEFT JOIN core.users u ON u.id = ai.uploaded_by
     WHERE ai.asset_id = ?
  `;
  const params = [assetId];
  if (category && category !== 'all') {
    sql += ` AND ai.category = ?`;
    params.push(category);
  }
  sql += ` ORDER BY ai.created_at DESC`;
  const images = all(sql, ...params);
  res.json({ asset_id: assetId, images });
}));

router.post('/:id/images', requireCap('assets.photo.upload', 'assets.edit'), asyncHandler((req, res) => {
  const assetId = toInt(req.params.id);
  const asset = get('SELECT id FROM assets WHERE id = ?', assetId);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  require_(req.body, ['url']);
  const url = String(req.body.url).trim();
  const category = (req.body.category || 'exterior').toLowerCase().trim();
  const title = (req.body.title || '').trim() || null;
  const description = (req.body.description || '').trim() || null;
  const fileSize = req.body.file_size ? toInt(req.body.file_size) : null;
  const info = run(
    `INSERT INTO core.asset_images (asset_id, url, category, title, description, file_size, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    assetId, url, category, title, description, fileSize, req.user ? req.user.id : null
  );
  const created = get('SELECT * FROM core.asset_images WHERE id = ?', info.lastInsertRowid);
  audit.record({ userId: req.user ? req.user.id : null, entity: 'asset_image', entityId: created.id, action: 'upload', after: { assetId, category, title } });
  res.status(201).json(created);
}));

router.patch('/images/:imageId', requireCap('assets.photo.upload', 'assets.edit'), asyncHandler((req, res) => {
  const imageId = toInt(req.params.imageId);
  const before = get('SELECT * FROM core.asset_images WHERE id = ?', imageId);
  if (!before) return res.status(404).json({ error: 'Image not found' });
  const title = req.body.title !== undefined ? req.body.title : before.title;
  const category = req.body.category !== undefined ? req.body.category.toLowerCase().trim() : before.category;
  const description = req.body.description !== undefined ? req.body.description : before.description;
  run(
    `UPDATE core.asset_images SET title = ?, category = ?, description = ? WHERE id = ?`,
    title, category, description, imageId
  );
  const after = get('SELECT * FROM core.asset_images WHERE id = ?', imageId);
  audit.record({ userId: req.user ? req.user.id : null, entity: 'asset_image', entityId: imageId, action: 'update', before, after });
  res.json(after);
}));

router.delete('/images/:imageId', requireCap('assets.photo.upload', 'assets.edit'), asyncHandler((req, res) => {
  const imageId = toInt(req.params.imageId);
  const before = get('SELECT * FROM core.asset_images WHERE id = ?', imageId);
  if (!before) return res.status(404).json({ error: 'Image not found' });
  run('DELETE FROM core.asset_images WHERE id = ?', imageId);
  audit.record({ userId: req.user ? req.user.id : null, entity: 'asset_image', entityId: imageId, action: 'delete', before });
  res.json({ ok: true, deleted_id: imageId });
}));

// Delete asset (or soft-decommission if linked to work orders or documents)
router.delete('/:id', requireCap('assets.delete'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const asset = get('SELECT * FROM assets WHERE id = ?', id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  const hasJobs = get('SELECT 1 FROM job_cards WHERE asset_id = ? LIMIT 1', id);
  const hasDocs = get('SELECT 1 FROM vehicle_documents WHERE asset_id = ? LIMIT 1', id);
  if (hasJobs || hasDocs) {
    run("UPDATE assets SET status = 'scrapped', in_register = 0, updated_at = datetime('now') WHERE id = ?", id);
    audit.record({ userId: req.user.id, entity: 'asset', entityId: id, action: 'deactivate', before: asset });
    return res.json({ ok: true, deactivated: true, message: 'Asset has historical records; decommissioned and archived instead of purged' });
  }

  run('DELETE FROM assets WHERE id = ?', id);
  audit.record({ userId: req.user.id, entity: 'asset', entityId: id, action: 'delete', before: asset });
  res.json({ ok: true, deleted: true });
}));

module.exports = router;
