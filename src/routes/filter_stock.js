'use strict';

// Filter Stock — a dedicated filter inventory (distinct from filters.js, which prices
// service_specs). Stock lives in filter_stock; every movement is recorded in
// filter_stock_ledger with a running balance_after. It opens the filter shelf at the cut-over
// (src/lib/stock.js). Issuing from here was retired in the stores plan, Part 3: a filter leaves on
// the service record or from Stores → Issue. Mounted under requireModule('filters') in server.js.

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireCap } = require('../lib/auth');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const audit = require('../lib/audit');
const emitter = require('../lib/emitter');

const router = express.Router();

// green OK / orange Low / red Critical, by qty vs reorder level.
const statusOf = (qty, reorder) => (qty <= 0 ? 'critical' : (qty <= (Number(reorder) || 0) ? 'low' : 'ok'));

// stock_value is computed explicitly (qty × unit_cost) so callers get a valuation
// without a generated column.
const COLS = `id, filter_type, brand, part_no, unit, qty_in_stock, reorder_level,
  COALESCE(unit_cost, 0) AS unit_cost, ROUND(qty_in_stock * COALESCE(unit_cost, 0), 2) AS stock_value,
  supplier, compatible_assets, created_at, updated_at`;

const oneFilter = (id) => {
  const r = get(`SELECT ${COLS} FROM filter_stock WHERE id = ?`, id);
  if (r) r.status = statusOf(r.qty_in_stock, r.reorder_level);
  return r;
};

// ---- list -----------------------------------------------------------------
router.get('/', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.q && String(req.query.q).trim()) {
    const like = '%' + String(req.query.q).trim() + '%';
    clauses.push('(filter_type LIKE ? OR brand LIKE ? OR part_no LIKE ? OR compatible_assets LIKE ?)');
    params.push(like, like, like, like);
  }
  if (req.query.low_stock === '1') clauses.push('qty_in_stock <= COALESCE(reorder_level, 0)');
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const rows = all(`SELECT ${COLS} FROM filter_stock ${where} ORDER BY filter_type LIMIT ${toInt(req.query.limit, 1000)}`, ...params);
  for (const r of rows) r.status = statusOf(r.qty_in_stock, r.reorder_level);
  res.json(rows);
}));

// ---- summary (KPI cards) --------------------------------------------------
router.get('/summary', asyncHandler((_req, res) => {
  const s = get(`SELECT
      COUNT(*) AS total_types,
      ROUND(COALESCE(SUM(qty_in_stock * COALESCE(unit_cost, 0)), 0), 2) AS total_value,
      COALESCE(SUM(CASE WHEN qty_in_stock <= COALESCE(reorder_level, 0) THEN 1 ELSE 0 END), 0) AS low_stock_count
    FROM filter_stock`);
  res.json(s);
}));

// ---- low stock ------------------------------------------------------------
router.get('/low-stock', asyncHandler((_req, res) => {
  const rows = all(`SELECT ${COLS} FROM filter_stock
     WHERE qty_in_stock <= COALESCE(reorder_level, 0)
     ORDER BY (qty_in_stock - COALESCE(reorder_level, 0)) ASC, filter_type`);
  for (const r of rows) r.status = statusOf(r.qty_in_stock, r.reorder_level);
  res.json(rows);
}));

// ---- ledger for one filter type -------------------------------------------
router.get('/:id/ledger', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const filter = oneFilter(id);
  if (!filter) return res.status(404).json({ error: 'Filter type not found' });
  const ledger = all(
    `SELECT l.id, l.kind, l.qty, l.balance_after, l.unit_price, l.note, l.txn_date, l.created_at,
            l.asset_id, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec,
            l.job_id, j.job_no
       FROM filter_stock_ledger l
       LEFT JOIN assets a ON a.id = l.asset_id
       LEFT JOIN job_cards j ON j.id = l.job_id
      WHERE l.filter_id = ? ORDER BY l.id DESC LIMIT 500`, id);
  res.json({ filter, ledger });
}));

// ---- create a new filter type ---------------------------------------------
router.post('/', requireCap('filters.stock.edit'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['filter_type']);
  const opening = toNum(b.qty_in_stock, 0);
  const unitCost = toNum(b.unit_cost, 0);
  const id = tx(() => {
    const info = run(
      `INSERT INTO filter_stock (filter_type, brand, part_no, unit, qty_in_stock, reorder_level, unit_cost, supplier, compatible_assets)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.filter_type, b.brand || null, b.part_no || null, b.unit || 'nos',
      opening, toNum(b.reorder_level, 5), unitCost, b.supplier || null, b.compatible_assets || null
    );
    const newId = info.lastInsertRowid;
    // Record the opening balance as a receipt so the ledger is complete from day one.
    if (opening > 0) run(
      `INSERT INTO filter_stock_ledger (filter_id, kind, qty, balance_after, unit_price, note, txn_date)
       VALUES (?, 'receipt', ?, ?, ?, 'opening balance', date('now'))`, newId, opening, opening, unitCost || null);
    require('../lib/stock').sync({ filter_stock: [newId] });
    return newId;
  });
  audit.record({ userId: req.user.id, entity: 'filter_stock', entityId: id, action: 'create', after: { filter_type: b.filter_type } });
  emitter.emit('filter_updated', { filter_id: id, action: 'create' });
  res.status(201).json(oneFilter(id));
}));

// ---- receive stock --------------------------------------------------------
router.post('/:id/receive', requireCap('filters.stock.receive'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const f = get('SELECT id, qty_in_stock, unit_cost FROM filter_stock WHERE id = ?', id);
  if (!f) return res.status(404).json({ error: 'Filter type not found' });
  const b = req.body;
  const qty = Math.abs(toNum(b.qty, 0));
  if (!(qty > 0)) return res.status(400).json({ error: 'Enter a quantity greater than 0' });
  const priceGiven = !(b.unit_cost === '' || b.unit_cost == null);
  const unitPrice = priceGiven ? toNum(b.unit_cost) : (f.unit_cost || null);
  const note = [b.supplier ? ('Supplier: ' + b.supplier) : '', b.invoice_no ? ('Inv: ' + b.invoice_no) : '']
    .filter(Boolean).join(' · ') || null;
  const balanceAfter = (Number(f.qty_in_stock) || 0) + qty;
  tx(() => {
    run(
      `INSERT INTO filter_stock_ledger (filter_id, kind, qty, balance_after, unit_price, note, txn_date)
       VALUES (?, 'receipt', ?, ?, ?, ?, ?)`,
      id, qty, balanceAfter, unitPrice, note, b.date || new Date().toISOString().slice(0, 10));
    // Update stock; refresh unit_cost / supplier only when the receipt supplied them.
    run(
      `UPDATE filter_stock SET qty_in_stock = ?, unit_cost = COALESCE(?, unit_cost),
              supplier = COALESCE(?, supplier), updated_at = datetime('now') WHERE id = ?`,
      balanceAfter, priceGiven ? toNum(b.unit_cost) : null, b.supplier || null, id);
    // The register opens the filter shelf at the cut-over (src/lib/stock.js 4b): keep that in step.
    require('../lib/stock').sync({ filter_stock: [id] });
  });
  audit.record({ userId: req.user.id, entity: 'filter_stock', entityId: id, action: 'receive', after: { qty, balance: balanceAfter } });
  emitter.emit('filter_updated', { filter_id: id, action: 'receive', balance: balanceAfter });
  res.status(201).json(oneFilter(id));
}));

// ---- issue stock to a vehicle / job ---------------------------------------
// RETIRED (stores plan, Part 3): a filter leaves the store one way — on the service record, or from
// Stores → Issue — and both take it off the store's own shelf, under the one issue rule. This door
// only lowered the register's count, which the stock never saw.
router.post('/:id/issue', requireCap('filters.stock.issue'), asyncHandler((_req, res) => {
  res.status(410).json({ error: 'Filters are issued on the Service record, or from Stores → Issue, now. Both take them off the store\'s stock.' });
}));

module.exports = router;
