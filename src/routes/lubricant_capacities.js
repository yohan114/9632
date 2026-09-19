'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireAuth, requireRole } = require('../lib/auth');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const audit = require('../lib/audit');

const router = express.Router();

// Helper to sanitize numeric values or null
const numOrNull = (v) => {
  if (v === '' || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Helper to sanitize string or null
const strOrNull = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
};

// ---- 1. List Vehicle Capacities & Summary -----------------------------------
router.get('/', requireAuth, asyncHandler((req, res) => {
  const q = String(req.query.q || '').trim();
  const category = String(req.query.category || '').trim();
  const basis = String(req.query.basis || '').trim();
  const limit = Math.min(Math.max(toInt(req.query.limit) || 200, 1), 1000);
  const offset = Math.max(toInt(req.query.offset) || 0, 0);

  const where = [];
  const params = [];

  if (category) {
    where.push('v.category = ?');
    params.push(category);
  }
  if (basis) {
    where.push('v.engine_oil_basis LIKE ?');
    params.push(`%${basis}%`);
  }
  if (q) {
    where.push(`(
      v.ec_no LIKE ? OR
      v.registration LIKE ? OR
      v.brand LIKE ? OR
      v.model LIKE ? OR
      v.category LIKE ? OR
      v.notes LIKE ? OR
      a.code LIKE ? OR
      a.registration LIKE ?
    )`);
    const term = `%${q}%`;
    params.push(term, term, term, term, term, term, term, term);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = get(
    `SELECT COUNT(*) AS total
       FROM vehicle_lubricant_capacities v
       LEFT JOIN assets a ON a.id = v.asset_id
     ${whereClause}`,
    ...params
  );
  const total = totalRow ? totalRow.total : 0;

  const items = all(
    `SELECT
        v.*,
        a.code AS asset_code,
        a.registration AS asset_registration,
        a.status AS asset_status,
        (
          COALESCE(v.engine_oil_l, 0) +
          COALESCE(v.gearbox_oil_l, 0) +
          COALESCE(v.diff_oil_l, 0) +
          COALESCE(v.front_axle_oil_l, 0) +
          COALESCE(v.hydraulic_oil_l, 0) +
          COALESCE(v.final_drive_oil_l, 0) +
          COALESCE(v.swing_oil_l, 0) +
          COALESCE(v.other_gearbox_oil_l, 0) +
          COALESCE(v.coolant_l, 0) +
          COALESCE(v.brake_fluid_l, 0)
        ) AS total_fluids_l
       FROM vehicle_lubricant_capacities v
       LEFT JOIN assets a ON a.id = v.asset_id
     ${whereClause}
     ORDER BY v.category ASC, v.ec_no ASC, v.registration ASC
     LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset
  );

  // Overall KPI aggregates (for top metric board)
  const summary = get(`SELECT
      COUNT(*) AS total_vehicles,
      COUNT(DISTINCT category) AS total_categories,
      COUNT(DISTINCT brand) AS total_brands,
      SUM(CASE WHEN engine_oil_l IS NOT NULL AND engine_oil_l > 0 THEN 1 ELSE 0 END) AS count_engine_oil,
      SUM(CASE WHEN hydraulic_oil_l IS NOT NULL AND hydraulic_oil_l > 0 THEN 1 ELSE 0 END) AS count_hydraulic,
      SUM(CASE WHEN gearbox_oil_l IS NOT NULL AND gearbox_oil_l > 0 THEN 1 ELSE 0 END) AS count_gearbox,
      SUM(CASE WHEN diff_oil_l IS NOT NULL AND diff_oil_l > 0 THEN 1 ELSE 0 END) AS count_diff,
      SUM(CASE WHEN engine_oil_basis LIKE 'Own record%' THEN 1 ELSE 0 END) AS count_own_records
    FROM vehicle_lubricant_capacities`);

  const categories = all(
    `SELECT category, COUNT(*) AS count
       FROM vehicle_lubricant_capacities
      WHERE category IS NOT NULL AND category != ''
      GROUP BY category
      ORDER BY category ASC`
  );

  res.json({
    items,
    total,
    limit,
    offset,
    categories,
    summary: summary || {},
  });
}));

// ---- 2. Single Vehicle Capacity Detail -------------------------------------
router.get('/:id', requireAuth, asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const item = get(
    `SELECT v.*, a.code AS asset_code, a.registration AS asset_registration, a.brand AS asset_brand, a.model_no AS asset_model
       FROM vehicle_lubricant_capacities v
       LEFT JOIN assets a ON a.id = v.asset_id
      WHERE v.id = ?`,
    id
  );
  if (!item) return res.status(404).json({ error: 'Vehicle capacity record not found' });

  res.json({ item });
}));

// ---- 5. Admin Create Vehicle Capacity --------------------------------------
router.post('/', requireRole('admin'), asyncHandler((req, res) => {
  const b = req.body || {};
  const ec_no = strOrNull(b.ec_no);
  const registration = strOrNull(b.registration);
  const category = strOrNull(b.category);

  if (!ec_no && !registration) {
    return res.status(400).json({ error: 'Either E&C vehicle number or registration is required' });
  }

  // Auto-resolve asset_id if possible
  let asset_id = toInt(b.asset_id);
  if (!asset_id) {
    if (ec_no) {
      const match = get('SELECT id FROM assets WHERE code = ? OR code_norm = ?', ec_no, ec_no.toUpperCase().replace(/[^A-Z0-9]/g, ''));
      if (match) asset_id = match.id;
    }
    if (!asset_id && registration) {
      const match = get('SELECT id FROM assets WHERE registration = ?', registration);
      if (match) asset_id = match.id;
    }
  }

  const info = run(
    `INSERT INTO vehicle_lubricant_capacities (
      asset_id, ec_no, registration, category, brand, model, year,
      engine_oil_l, engine_oil_grade, gearbox_oil_l, gearbox_oil_grade,
      diff_oil_l, diff_oil_grade, front_axle_oil_l, hydraulic_oil_l,
      final_drive_oil_l, swing_oil_l, other_gearbox_oil_l, coolant_l, brake_fluid_l,
      engine_oil_basis, engine_oil_records, notes, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    asset_id || null,
    ec_no,
    registration,
    category,
    strOrNull(b.brand),
    strOrNull(b.model),
    strOrNull(b.year),
    numOrNull(b.engine_oil_l),
    strOrNull(b.engine_oil_grade),
    numOrNull(b.gearbox_oil_l),
    strOrNull(b.gearbox_oil_grade),
    numOrNull(b.diff_oil_l),
    strOrNull(b.diff_oil_grade),
    numOrNull(b.front_axle_oil_l),
    numOrNull(b.hydraulic_oil_l),
    numOrNull(b.final_drive_oil_l),
    numOrNull(b.swing_oil_l),
    numOrNull(b.other_gearbox_oil_l),
    numOrNull(b.coolant_l),
    numOrNull(b.brake_fluid_l),
    strOrNull(b.engine_oil_basis) || 'Manual entry',
    toInt(b.engine_oil_records) || 0,
    strOrNull(b.notes),
    req.user.username
  );

  const created = get('SELECT * FROM vehicle_lubricant_capacities WHERE id = ?', info.lastInsertRowid);
  audit.record({
    userId: req.user.id,
    entity: 'vehicle_lubricant_capacity',
    entityId: info.lastInsertRowid,
    action: 'create',
    after: created,
  });

  res.status(201).json(created);
}));

// ---- 6. Admin Update Vehicle Capacity --------------------------------------
router.put('/:id', requireRole('admin'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const existing = get('SELECT * FROM vehicle_lubricant_capacities WHERE id = ?', id);
  if (!existing) return res.status(404).json({ error: 'Vehicle capacity record not found' });

  const b = req.body || {};
  const ec_no = strOrNull(b.ec_no) || existing.ec_no;
  const registration = strOrNull(b.registration) || existing.registration;
  const category = strOrNull(b.category) || existing.category;

  let asset_id = toInt(b.asset_id) || existing.asset_id;
  if (!asset_id) {
    if (ec_no) {
      const match = get('SELECT id FROM assets WHERE code = ?', ec_no);
      if (match) asset_id = match.id;
    }
  }

  run(
    `UPDATE vehicle_lubricant_capacities SET
      asset_id = ?,
      ec_no = ?,
      registration = ?,
      category = ?,
      brand = ?,
      model = ?,
      year = ?,
      engine_oil_l = ?,
      engine_oil_grade = ?,
      gearbox_oil_l = ?,
      gearbox_oil_grade = ?,
      diff_oil_l = ?,
      diff_oil_grade = ?,
      front_axle_oil_l = ?,
      hydraulic_oil_l = ?,
      final_drive_oil_l = ?,
      swing_oil_l = ?,
      other_gearbox_oil_l = ?,
      coolant_l = ?,
      brake_fluid_l = ?,
      engine_oil_basis = ?,
      engine_oil_records = ?,
      notes = ?,
      updated_by = ?,
      updated_at = datetime('now')
    WHERE id = ?`,
    asset_id || null,
    ec_no,
    registration,
    category,
    strOrNull(b.brand),
    strOrNull(b.model),
    strOrNull(b.year),
    numOrNull(b.engine_oil_l),
    strOrNull(b.engine_oil_grade),
    numOrNull(b.gearbox_oil_l),
    strOrNull(b.gearbox_oil_grade),
    numOrNull(b.diff_oil_l),
    strOrNull(b.diff_oil_grade),
    numOrNull(b.front_axle_oil_l),
    numOrNull(b.hydraulic_oil_l),
    numOrNull(b.final_drive_oil_l),
    numOrNull(b.swing_oil_l),
    numOrNull(b.other_gearbox_oil_l),
    numOrNull(b.coolant_l),
    numOrNull(b.brake_fluid_l),
    strOrNull(b.engine_oil_basis) || existing.engine_oil_basis,
    toInt(b.engine_oil_records) ?? existing.engine_oil_records,
    strOrNull(b.notes),
    req.user.username,
    id
  );

  const updated = get('SELECT * FROM vehicle_lubricant_capacities WHERE id = ?', id);
  audit.record({
    userId: req.user.id,
    entity: 'vehicle_lubricant_capacity',
    entityId: id,
    action: 'update',
    before: existing,
    after: updated,
  });

  res.json(updated);
}));

// ---- 7. Admin Delete Vehicle Capacity --------------------------------------
router.delete('/:id', requireRole('admin'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const existing = get('SELECT * FROM vehicle_lubricant_capacities WHERE id = ?', id);
  if (!existing) return res.status(404).json({ error: 'Vehicle capacity record not found' });

  run('DELETE FROM vehicle_lubricant_capacities WHERE id = ?', id);

  audit.record({
    userId: req.user.id,
    entity: 'vehicle_lubricant_capacity',
    entityId: id,
    action: 'delete',
    before: existing,
  });

  res.json({ ok: true });
}));

module.exports = router;
