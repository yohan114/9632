'use strict';

// Filter Price Book — every filter number ever used, with its price. Numbers
// missing a price are flagged; adding a price (or typing a brand-new number with
// one) upserts the book so it is remembered and auto-fills on the next service.

const express = require('express');
const { get, all, run, tx } = require('../db');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const audit = require('../lib/audit');
const aliases = require('../lib/aliases');

const router = express.Router();

const clean = (v) => (v == null ? null : String(v).trim() || null);
const normF = (s) => String(s || '').toUpperCase().replace(/\([^)]*\)/g, '').replace(/[^A-Z0-9]/g, '');

// A service's live cost = priced filters (book × qty) + oils (line total) + labour + sundry.
const COST_SQL = `(
    (SELECT COALESCE(SUM(COALESCE(p.unit_price,0) * COALESCE(f.qty,1)),0)
       FROM service_filters f LEFT JOIN filter_prices p ON p.filter_no_norm = f.filter_no_norm WHERE f.service_id = s.id)
  + (SELECT COALESCE(SUM(COALESCE(o.price,0)),0) FROM service_oils o WHERE o.service_id = s.id)
  + COALESCE(s.labour_charge,0) + COALESCE(s.sundry_amount,0))`;

// Record a filter number's use on the book: bump the usage count, fill/refresh its
// price when one is supplied, and create the entry if the number is new (the auto-save).
function bookTouch(filterNo, category, price, by) {
  const norm = normF(filterNo);
  if (!norm) return;
  const ex = get('SELECT id FROM filter_prices WHERE filter_no_norm = ?', norm);
  if (ex) {
    run(`UPDATE filter_prices SET uses = uses + 1, category = COALESCE(category, ?),
           unit_price = CASE WHEN ? IS NOT NULL AND ? > 0 THEN ? ELSE unit_price END,
           updated_by = COALESCE(?, updated_by), updated_at = datetime('now') WHERE id = ?`,
      clean(category), price, price, price, by, ex.id);
  } else {
    run(`INSERT INTO filter_prices (filter_no, filter_no_norm, category, unit_price, uses, source, updated_by)
         VALUES (?, ?, ?, ?, 1, 'service', ?)`, clean(filterNo), norm, clean(category), (price && price > 0) ? price : null, by);
  }
}

// ---- stats ----------------------------------------------------------------
router.get('/stats', asyncHandler((_req, res) => {
  const r = get(`SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN unit_price > 0 THEN 1 ELSE 0 END), 0) priced FROM filter_prices`);
  res.json({ total: r.total, priced: r.priced, missing: r.total - r.priced });
}));

// ---- price book -----------------------------------------------------------
router.get('/prices', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.q) { const like = '%' + String(req.query.q).trim() + '%'; clauses.push('(filter_no LIKE ? OR category LIKE ?)'); params.push(like, like); }
  if (req.query.missing === '1') clauses.push('(unit_price IS NULL OR unit_price = 0)');
  if (req.query.category) { clauses.push('category = ?'); params.push(req.query.category); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(all(
    `SELECT id, filter_no, category, unit_price, uses, source, notes, updated_by, updated_at,
            (unit_price IS NOT NULL AND unit_price > 0) AS has_price
       FROM filter_prices ${where}
      ORDER BY has_price ASC, uses DESC, filter_no LIMIT ${toInt(req.query.limit, 500)}`,
    ...params
  ));
}));

// Categories (for the add form + filter dropdown).
router.get('/categories', asyncHandler((_req, res) =>
  res.json(all(`SELECT category, COUNT(*) n FROM filter_prices WHERE category IS NOT NULL AND TRIM(category) <> '' GROUP BY category ORDER BY n DESC`).map((r) => r.category))));

// Look up a price by filter number (auto-fill).
router.get('/prices/lookup', asyncHandler((req, res) => {
  const norm = normF(req.query.no);
  if (!norm) return res.json({ found: false });
  const r = get('SELECT filter_no, category, unit_price FROM filter_prices WHERE filter_no_norm = ?', norm);
  res.json(r ? { found: true, filter_no: r.filter_no, category: r.category, unit_price: r.unit_price } : { found: false });
}));

// Add / update a filter price. Typing a NEW number here creates it (the learning
// catalogue); an existing number updates its price. This is the auto-save.
router.post('/prices', asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['filter_no']);
  const fn = clean(b.filter_no);
  const norm = normF(fn);
  if (!norm) return res.status(400).json({ error: 'Enter a filter number' });
  const price = b.unit_price === '' || b.unit_price == null ? null : toNum(b.unit_price);
  if (price != null && price < 0) return res.status(400).json({ error: 'Price cannot be negative' });
  const by = req.user ? (req.user.fullName || req.user.username) : null;
  const existing = get('SELECT id, uses FROM filter_prices WHERE filter_no_norm = ?', norm);
  if (existing) {
    run(`UPDATE filter_prices SET unit_price = ?, category = COALESCE(?, category), source = 'manual', updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
      price, clean(b.category), by, existing.id);
    audit.record({ userId: req.user && req.user.id, entity: 'filter_price', entityId: existing.id, action: 'update', after: { filter_no: fn, unit_price: price } });
    return res.json(get('SELECT *, (unit_price IS NOT NULL AND unit_price > 0) AS has_price FROM filter_prices WHERE id = ?', existing.id));
  }
  const info = run(`INSERT INTO filter_prices (filter_no, filter_no_norm, category, unit_price, uses, source, updated_by) VALUES (?, ?, ?, ?, 0, 'manual', ?)`,
    fn, norm, clean(b.category), price, by);
  audit.record({ userId: req.user && req.user.id, entity: 'filter_price', entityId: info.lastInsertRowid, action: 'create', after: { filter_no: fn, unit_price: price } });
  res.status(201).json(get('SELECT *, (unit_price IS NOT NULL AND unit_price > 0) AS has_price FROM filter_prices WHERE id = ?', info.lastInsertRowid));
}));

// ---- service records ------------------------------------------------------
router.get('/services', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.q) {
    const like = '%' + String(req.query.q).trim() + '%';
    clauses.push('(s.vehicle_label LIKE ? OR a.code LIKE ? OR s.site_location LIKE ? OR s.service_type LIKE ?)');
    params.push(like, like, like, like);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(all(
    `SELECT s.id, s.vehicle_label, s.service_date, s.service_type, s.site_location, s.grand_total,
            a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec,
            (SELECT COUNT(*) FROM service_filters f WHERE f.service_id = s.id) AS filter_count,
            (SELECT COUNT(*) FROM service_filters f LEFT JOIN filter_prices p ON p.filter_no_norm = f.filter_no_norm
               WHERE f.service_id = s.id AND COALESCE(p.unit_price, 0) = 0) AS missing_count,
            ${COST_SQL} AS computed_cost
       FROM service_jobs s LEFT JOIN assets a ON a.id = s.asset_id
       ${where} ORDER BY s.service_date DESC, s.id DESC LIMIT ${toInt(req.query.limit, 300)}`,
    ...params
  ));
}));

router.post('/services', asyncHandler((req, res) => {
  const b = req.body;
  let assetId = toInt(b.asset_id);
  let vehicleLabel = clean(b.vehicle_label);
  if (!assetId && b.asset) {
    const r = aliases.resolveAsset(b.asset, { source: 'service' });
    assetId = r.assetId;
    if (!vehicleLabel) vehicleLabel = clean(b.asset);
  }
  const by = req.user ? (req.user.fullName || req.user.username) : null;
  const filters = Array.isArray(b.filters) ? b.filters : [];
  const oils = Array.isArray(b.oils) ? b.oils : [];
  const result = tx(() => {
    const info = run(
      `INSERT INTO service_jobs (vehicle_label, asset_id, service_date, job_no, meter_reading, next_service_meter,
                                 service_type, site_location, repair_details, labour_charge, sundry_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      vehicleLabel, assetId || null, clean(b.service_date) || new Date().toISOString().slice(0, 10), clean(b.job_no),
      clean(b.meter_reading), clean(b.next_service_meter), clean(b.service_type), clean(b.site_location),
      clean(b.repair_details), toNum(b.labour_charge, 0), toNum(b.sundry_amount, 0)
    );
    const sid = info.lastInsertRowid;
    for (const f of filters) {
      const fn = clean(f.filter_no);
      if (!fn) continue;
      const price = f.price === '' || f.price == null ? null : toNum(f.price);
      run(`INSERT INTO service_filters (service_id, filter_no, filter_no_norm, category, qty, price)
           VALUES (?, ?, ?, ?, ?, ?)`, sid, fn, normF(fn), clean(f.category), toNum(f.qty, 1), price || 0);
      bookTouch(fn, f.category, price, by); // auto-save the number (+ price) to the book
    }
    for (const o of oils) {
      const on = clean(o.oil_name);
      if (!on) continue;
      run(`INSERT INTO service_oils (service_id, oil_name, oil_type, qty, price)
           VALUES (?, ?, ?, ?, ?)`, sid, on, clean(o.oil_type), toNum(o.qty, 0), toNum(o.price, 0));
    }
    return sid;
  });
  audit.record({ userId: req.user && req.user.id, entity: 'service_job', entityId: result, action: 'create', after: { asset_id: assetId } });
  res.status(201).json({ service: get('SELECT * FROM service_jobs WHERE id = ?', result) });
}));

router.get('/services/:id', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const job = get(
    `SELECT s.*, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec, ${COST_SQL} AS computed_cost
       FROM service_jobs s LEFT JOIN assets a ON a.id = s.asset_id WHERE s.id = ?`, id);
  if (!job) return res.status(404).json({ error: 'Service not found' });
  // Each filter line carries the book price so missing ones surface here too.
  const filters = all(
    `SELECT f.id, f.filter_no, f.filter_no_norm, f.category, f.action_type, f.qty,
            p.unit_price AS book_price
       FROM service_filters f LEFT JOIN filter_prices p ON p.filter_no_norm = f.filter_no_norm
      WHERE f.service_id = ? ORDER BY f.id`, id);
  const oils = all('SELECT id, oil_name, oil_type, action_type, qty, price FROM service_oils WHERE service_id = ? ORDER BY id', id);
  res.json({ service: job, filters, oils });
}));

module.exports = router;
