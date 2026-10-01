'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireCap } = require('../lib/auth');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const audit = require('../lib/audit');
const mechanics = require('../lib/mechanics');
const aliases = require('../lib/aliases');

const { requireModule } = require('../lib/permissions');
const router = express.Router();

// Canonical mechanics with their current rate and workshop (safe name dropdown for everyone, rates only for labour view).
router.get('/', asyncHandler((req, res) => {
  const permissions = require('../lib/permissions');
  const canSeeLabour = req.user && (req.user.roles.includes('admin') || permissions.meets(permissions.effectiveLevel(req.user, 'labour'), 'view'));
  const ws = require('../lib/workshops');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : null;
  const only = require('../lib/scope').onlyWorkshop(req.user) || toInt(req.query.workshop_id) || null;
  const dateLiteral = date ? `'${date}'` : "date('now')";
  const wsOn = ws.mechanicWorkshopSql('m', dateLiteral);
  const rateSql = canSeeLabour
    ? `(SELECT rate FROM labour_rates lr WHERE lr.mechanic = m.name ORDER BY effective_from DESC, id DESC LIMIT 1) AS rate`
    : `NULL AS rate`;

  const statusFilter = req.query.status ? String(req.query.status).toLowerCase() : null;
  const activeParam = req.query.active !== undefined ? req.query.active : null;
  const includeInactive = req.query.include_inactive === '1' || req.query.all === '1';

  const whereClauses = [];
  const params = [];

  if (only) {
    whereClauses.push('x.workshop_id = ?');
    params.push(only);
  }

  // Active / Resigned / Transferred filter logic
  if (!includeInactive) {
    if (activeParam === '1' || statusFilter === 'active') {
      if (date) {
        // Active on that specific date: was not marked resigned before this date
        whereClauses.push("(x.status = 'active' OR (x.left_date IS NOT NULL AND x.left_date > ?))");
        params.push(date);
      } else {
        whereClauses.push("(x.active = 1 AND x.status = 'active')");
      }
    } else if (activeParam === '0' || statusFilter === 'resigned') {
      whereClauses.push("(x.active = 0 OR x.status = 'resigned')");
    } else if (statusFilter && statusFilter !== 'all') {
      whereClauses.push("x.status = ?");
      params.push(statusFilter);
    }
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  res.json(all(
    `SELECT x.*,
            (SELECT w.name FROM workshops w WHERE w.id = x.workshop_id) AS workshop_name,
            (SELECT w.code FROM workshops w WHERE w.id = x.workshop_id) AS workshop_code
       FROM (SELECT m.*,
                    ${rateSql},
                    ${wsOn} AS workshop_id,
                    (SELECT MAX(mw.from_date) FROM mechanic_workshops mw WHERE mw.mechanic_id = m.id AND mw.from_date > '2000-01-01') AS last_move
               FROM mechanics m) x ${whereSql} ORDER BY x.active DESC, x.name`,
    ...params
  ));
}));

// Single mechanic details with transfer history and labour rate history
router.get('/:id', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const m = get('SELECT * FROM mechanics WHERE id = ?', id);
  if (!m) return res.status(404).json({ error: 'Mechanic not found' });
  const ws = require('../lib/workshops');
  const currentWsId = ws.mechanicWorkshop(id);
  const currentWs = currentWsId ? ws.byId(currentWsId) : null;
  const history = ws.mechanicHistory(id);
  const rates = all('SELECT * FROM labour_rates WHERE mechanic = ? ORDER BY effective_from DESC, id DESC', m.name);
  res.json({
    mechanic: {
      ...m,
      workshop_id: currentWsId,
      workshop_name: currentWs ? currentWs.name : null,
      workshop_code: currentWs ? currentWs.code : null,
    },
    transfers: history,
    rates,
  });
}));

router.post('/', requireCap('mechanics.create'), asyncHandler((req, res) => {
  require_(req.body, ['name']);
  const m = mechanics.findOrCreateMechanic(req.body.name);
  audit.record({ userId: req.user.id, entity: 'mechanic', entityId: m.id, action: 'create' });
  res.status(201).json(m);
}));

// Mark a labourer as Resigned / Left (hides from future daily workdone & attendance)
router.post('/:id/resign', requireCap('mechanics.create', 'mechanics.edit', 'labour.rates.edit', 'dailywork.edit'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const m = get('SELECT * FROM mechanics WHERE id = ?', id);
  if (!m) return res.status(404).json({ error: 'Mechanic not found' });
  const leftDate = req.body.left_date || new Date().toISOString().slice(0, 10);
  const leftReason = req.body.left_reason || 'Resigned';
  const notes = req.body.notes != null ? req.body.notes : m.notes;
  run(
    `UPDATE mechanics SET active = 0, status = 'resigned', left_date = ?, left_reason = ?, notes = ? WHERE id = ?`,
    leftDate, leftReason, notes, id
  );
  audit.record({ userId: req.user.id, entity: 'mechanic', entityId: id, action: 'resign', details: { leftDate, leftReason, notes } });
  res.json(get('SELECT * FROM mechanics WHERE id = ?', id));
}));

// Reinstate a previously departed labourer back to active status
router.post('/:id/reinstate', requireCap('mechanics.create', 'mechanics.edit', 'labour.rates.edit', 'dailywork.edit'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const m = get('SELECT * FROM mechanics WHERE id = ?', id);
  if (!m) return res.status(404).json({ error: 'Mechanic not found' });
  run(
    `UPDATE mechanics SET active = 1, status = 'active', left_date = NULL, left_reason = NULL WHERE id = ?`,
    id
  );
  audit.record({ userId: req.user.id, entity: 'mechanic', entityId: id, action: 'reinstate' });
  res.json(get('SELECT * FROM mechanics WHERE id = ?', id));
}));

// Transfer labourer to another site / workshop from a date
router.post('/:id/transfer', requireCap('mechanics.move', 'workshops.manage'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const m = get('SELECT * FROM mechanics WHERE id = ?', id);
  if (!m) return res.status(404).json({ error: 'Mechanic not found' });
  require_(req.body, ['workshop_id']);
  const targetWsId = toInt(req.body.workshop_id);
  const fromDate = req.body.from_date || new Date().toISOString().slice(0, 10);
  const note = req.body.note || 'Transferred to site workshop';
  const ws = require('../lib/workshops');
  const result = ws.moveMechanic(req.user, id, targetWsId, fromDate, note);
  // Ensure active status
  run(`UPDATE mechanics SET active = 1, status = 'active' WHERE id = ?`, id);
  audit.record({ userId: req.user.id, entity: 'mechanic', entityId: id, action: 'transfer', details: { targetWsId, fromDate, note } });
  res.json(result);
}));

// Update mechanic profile fields
router.patch('/:id', requireCap('mechanics.create', 'mechanics.edit', 'labour.rates.edit'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const m = get('SELECT * FROM mechanics WHERE id = ?', id);
  if (!m) return res.status(404).json({ error: 'Mechanic not found' });
  const b = req.body || {};
  if (b.name) {
    const norm = mechanics.normalizeMechanic(b.name);
    run('UPDATE mechanics SET name = ?, name_norm = ? WHERE id = ?', b.name, norm, id);
  }
  if (b.status !== undefined) run('UPDATE mechanics SET status = ? WHERE id = ?', b.status, id);
  if (b.left_date !== undefined) run('UPDATE mechanics SET left_date = ? WHERE id = ?', b.left_date, id);
  if (b.left_reason !== undefined) run('UPDATE mechanics SET left_reason = ? WHERE id = ?', b.left_reason, id);
  if (b.notes !== undefined) run('UPDATE mechanics SET notes = ? WHERE id = ?', b.notes, id);
  if (b.active !== undefined) run('UPDATE mechanics SET active = ? WHERE id = ?', b.active ? 1 : 0, id);
  audit.record({ userId: req.user.id, entity: 'mechanic', entityId: id, action: 'update', details: b });
  res.json(get('SELECT * FROM mechanics WHERE id = ?', id));
}));

// Preview a resolution (read-only).
router.post('/resolve', asyncHandler((req, res) => {
  require_(req.body, ['text']);
  res.json({ split: mechanics.splitMechanics(req.body.text), resolved: mechanics.lookupMechanic(req.body.text) });
}));

// Labour rates (effective-dated). Gated on labour clearance.
router.get('/rates', requireModule('labour'), asyncHandler((_req, res) =>
  res.json(all('SELECT * FROM labour_rates ORDER BY mechanic, effective_from DESC'))));

router.post('/rates', requireCap('labour.rates.edit'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['mechanic', 'rate']);
  const m = mechanics.findOrCreateMechanic(b.mechanic); // keep the registry in step
  const info = run('INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES (?, ?, ?)',
    m.name, toNum(b.rate), b.effective_from || new Date().toISOString().slice(0, 10));
  audit.record({ userId: req.user.id, entity: 'labour_rate', entityId: info.lastInsertRowid, action: 'create' });
  res.status(201).json(get('SELECT * FROM labour_rates WHERE id = ?', info.lastInsertRowid));
}));

// Labour names that appear in the daily-work log but have NO hourly rate yet. Gated on labour clearance.
router.get('/unassigned', requireModule('labour'), asyncHandler((_req, res) => {
  const rated = new Set(
    all('SELECT DISTINCT mechanic FROM labour_rates').map((r) => mechanics.normalizeMechanic(r.mechanic))
  );
  const acc = new Map(); // canonicalNorm -> { name, norm, entries, resolved, resolvedName }
  for (const row of all(
    `SELECT mechanic, COUNT(*) c FROM job_daily_work
      WHERE mechanic IS NOT NULL AND mechanic <> '' GROUP BY mechanic`
  )) {
    for (const raw of mechanics.splitMechanics(row.mechanic)) {
      const norm = mechanics.normalizeMechanic(raw);
      if (!norm) continue;
      const look = mechanics.lookupMechanic(raw);
      const canonicalNorm = look.resolved ? mechanics.normalizeMechanic(look.name) : norm;
      if (rated.has(canonicalNorm)) continue; // already has a rate
      const cur = acc.get(canonicalNorm) || {
        name: look.resolved ? look.name : raw, norm: canonicalNorm, entries: 0,
        resolved: look.resolved, resolvedName: look.resolved ? look.name : null,
      };
      cur.entries += row.c;
      acc.set(canonicalNorm, cur);
    }
  }
  res.json([...acc.values()].sort((a, b) => b.entries - a.entries));
}));

// The pending mechanic-name queue (mirrors the asset alias queue). Gated on aliases clearance.
router.get('/aliases', requireModule('aliases'), asyncHandler((req, res) => {
  res.json(aliases.queryAliasQueue({
    table: 'mechanic_aliases',
    targetTable: 'mechanics',
    targetIdCol: 'mechanic_id',
    targetNameCol: 'name',
    targetAlias: 'mechanic_name',
    resolved: req.query.resolved,
    q: req.query.q,
    limit: req.query.limit,
  }));
}));

router.post('/aliases/:id/link', requireCap('aliases.mechanic.resolve'), asyncHandler((req, res) => {
  require_(req.body, ['mechanic_id']);
  const id = toInt(req.params.id);
  if (!get('SELECT id FROM mechanic_aliases WHERE id = ?', id)) return res.status(404).json({ error: 'Alias not found' });
  if (!get('SELECT id FROM mechanics WHERE id = ?', toInt(req.body.mechanic_id))) return res.status(400).json({ error: 'Unknown mechanic' });
  const updated = mechanics.linkMechanicAlias(id, toInt(req.body.mechanic_id));
  audit.record({ userId: req.user.id, entity: 'mechanic_alias', entityId: id, action: 'link' });
  res.json(updated);
}));

module.exports = router;
