'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireRole } = require('../lib/auth');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const audit = require('../lib/audit');
const mechanics = require('../lib/mechanics');

const router = express.Router();

// Canonical mechanics with their current rate.
router.get('/', asyncHandler((_req, res) => {
  res.json(all(
    `SELECT m.*,
            (SELECT rate FROM labour_rates lr WHERE lr.mechanic = m.name ORDER BY effective_from DESC, id DESC LIMIT 1) AS rate
       FROM mechanics m ORDER BY m.name`
  ));
}));

router.post('/', requireRole('admin', 'manager'), asyncHandler((req, res) => {
  require_(req.body, ['name']);
  const m = mechanics.findOrCreateMechanic(req.body.name);
  audit.record({ userId: req.user.id, entity: 'mechanic', entityId: m.id, action: 'create' });
  res.status(201).json(m);
}));

// Preview a resolution (read-only).
router.post('/resolve', asyncHandler((req, res) => {
  require_(req.body, ['text']);
  res.json({ split: mechanics.splitMechanics(req.body.text), resolved: mechanics.lookupMechanic(req.body.text) });
}));

// Labour rates (effective-dated).
router.get('/rates', asyncHandler((_req, res) =>
  res.json(all('SELECT * FROM labour_rates ORDER BY mechanic, effective_from DESC'))));

router.post('/rates', requireRole('admin', 'manager'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['mechanic', 'rate']);
  const m = mechanics.findOrCreateMechanic(b.mechanic); // keep the registry in step
  const info = run('INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES (?, ?, ?)',
    m.name, toNum(b.rate), b.effective_from || new Date().toISOString().slice(0, 10));
  audit.record({ userId: req.user.id, entity: 'labour_rate', entityId: info.lastInsertRowid, action: 'create' });
  res.status(201).json(get('SELECT * FROM labour_rates WHERE id = ?', info.lastInsertRowid));
}));

// Labour names that appear in the daily-work log but have NO hourly rate yet.
// Split the crew strings ("Buddhika, Krishna") into individuals, resolve each to a
// canonical mechanic, and flag those without a current rate — the owner's to-do list.
router.get('/unassigned', asyncHandler((_req, res) => {
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

// The pending mechanic-name queue (mirrors the asset alias queue).
router.get('/aliases', asyncHandler((req, res) => {
  const resolved = req.query.resolved;
  const where = resolved === undefined ? '' : 'WHERE ma.resolved = ' + (toInt(resolved) ? 1 : 0);
  res.json(all(
    `SELECT ma.*, m.name AS mechanic_name FROM mechanic_aliases ma
       LEFT JOIN mechanics m ON m.id = ma.mechanic_id ${where}
      ORDER BY ma.resolved ASC, ma.hit_count DESC`
  ));
}));

router.post('/aliases/:id/link', requireRole('storekeeper', 'manager'), asyncHandler((req, res) => {
  require_(req.body, ['mechanic_id']);
  const id = toInt(req.params.id);
  if (!get('SELECT id FROM mechanic_aliases WHERE id = ?', id)) return res.status(404).json({ error: 'Alias not found' });
  if (!get('SELECT id FROM mechanics WHERE id = ?', toInt(req.body.mechanic_id))) return res.status(400).json({ error: 'Unknown mechanic' });
  const updated = mechanics.linkMechanicAlias(id, toInt(req.body.mechanic_id));
  audit.record({ userId: req.user.id, entity: 'mechanic_alias', entityId: id, action: 'link' });
  res.json(updated);
}));

module.exports = router;
