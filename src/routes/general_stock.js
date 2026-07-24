'use strict';

// General Stock — items in store_items with is_general = 1 (stationery, tools,
// safety gear, cleaning supplies, general consumables). Stock movements are
// recorded in general_item_txns; every change emits 'stock_updated' so live
// clients can refresh. Mounted under requireModule('stores') in server.js.

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireRole } = require('../lib/auth');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const audit = require('../lib/audit');
const emitter = require('../lib/emitter');

const router = express.Router();

// green OK / orange Low / red Critical
const statusOf = (balance, min) => (balance <= 0 ? 'critical' : (balance <= (Number(min) || 0) ? 'low' : 'ok'));

// total_value is a generated column (absent from PRAGMA table_info) — compute it
// explicitly so the SELECT is unambiguous regardless of the SQLite build.
const ITEM_COLS = `id, item_no, name, category, unit, balance, min_stock,
  COALESCE(unit_cost, 0) AS unit_cost, ROUND(balance * COALESCE(unit_cost, 0), 2) AS total_value,
  rack AS location, part_number, description`;

// One item with its computed status attached.
const oneItem = (id) => {
  const r = get(`SELECT ${ITEM_COLS} FROM store_items WHERE id = ?`, id);
  if (r) r.status = statusOf(r.balance, r.min_stock);
  return r;
};

// ---- list -----------------------------------------------------------------
router.get('/items', asyncHandler((req, res) => {
  const clauses = ['is_general = 1'];
  const params = [];
  if (req.query.q) {
    const like = '%' + String(req.query.q).trim() + '%';
    clauses.push('(name LIKE ? OR item_no LIKE ? OR category LIKE ? OR part_number LIKE ?)');
    params.push(like, like, like, like);
  }
  if (req.query.category) { clauses.push('category = ?'); params.push(req.query.category); }
  if (req.query.low_stock === '1') clauses.push('balance <= COALESCE(min_stock, 0)');
  const rows = all(
    `SELECT ${ITEM_COLS} FROM store_items WHERE ${clauses.join(' AND ')} ORDER BY name LIMIT ${toInt(req.query.limit, 1000)}`,
    ...params
  );
  for (const r of rows) r.status = statusOf(r.balance, r.min_stock);
  res.json(rows);
}));

// Distinct categories (for the filter dropdown).
router.get('/categories', asyncHandler((_req, res) =>
  res.json(all(`SELECT category, COUNT(*) n FROM store_items WHERE is_general = 1 AND category IS NOT NULL AND TRIM(category) <> '' GROUP BY category ORDER BY category`).map((r) => r.category))));

// ---- single item + full ledger --------------------------------------------
router.get('/items/:id', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const item = get(`SELECT ${ITEM_COLS} FROM store_items WHERE id = ? AND is_general = 1`, id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  item.status = statusOf(item.balance, item.min_stock);
  const ledger = all(
    `SELECT id, txn_type, qty, balance_after, unit_price, ref, txn_date, created_at
       FROM general_item_txns WHERE store_item_id = ? ORDER BY id DESC LIMIT 500`, id);
  res.json({ item, ledger });
}));

// ---- create ---------------------------------------------------------------
router.post('/items', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['name']);
  const givenNo = b.item_no && String(b.item_no).trim();
  const opening = toNum(b.balance, 0);
  const unitCost = toNum(b.unit_cost, 0);
  const result = tx(() => {
    const info = run(
      `INSERT INTO store_items (name, category, unit, min_stock, balance, unit_cost, rack, part_number, description, is_general, item_no, catalogue_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'general')`,
      b.name, b.category || null, b.unit || 'nos', toNum(b.min_stock, 0), opening, unitCost,
      b.location || b.rack || null, b.part_number || null, b.description || null, givenNo || null
    );
    const id = info.lastInsertRowid;
    // Auto item number: GS-0001 …
    if (!givenNo) run(`UPDATE store_items SET item_no = ? WHERE id = ?`, 'GS-' + String(id).padStart(4, '0'), id);
    // Record the opening balance as a ledger row so history is complete.
    if (opening > 0) run(
      `INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, unit_price, ref, txn_date)
       VALUES (?, 'opening', ?, ?, ?, 'opening', date('now'))`, id, opening, opening, unitCost || null);
    return id;
  });
  audit.record({ userId: req.user.id, entity: 'store_item', entityId: result, action: 'create', after: { name: b.name, is_general: 1 } });
  emitter.emit('stock_updated', { item_id: result, action: 'create' });
  res.status(201).json(oneItem(result));
}));

// ---- adjust stock ---------------------------------------------------------
router.post('/items/:id/adjust', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const item = get('SELECT id, name, balance, min_stock FROM store_items WHERE id = ? AND is_general = 1', id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const b = req.body;
  const kind = ['receipt', 'issue', 'adjustment'].includes(b.txn_type) ? b.txn_type : null;
  if (!kind) return res.status(400).json({ error: 'txn_type must be receipt, issue or adjustment' });
  const qtyMag = Math.abs(toNum(b.qty, 0));
  if (kind !== 'adjustment' && !(qtyMag > 0)) return res.status(400).json({ error: 'Enter a quantity greater than 0' });

  const prev = Number(item.balance) || 0;
  let signed;
  let balanceAfter;
  if (kind === 'receipt') { signed = qtyMag; balanceAfter = prev + qtyMag; }
  else if (kind === 'issue') { signed = -qtyMag; balanceAfter = prev - qtyMag; }
  else { balanceAfter = qtyMag; signed = qtyMag - prev; } // adjustment sets the absolute count

  const out = tx(() => {
    run(
      `INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, unit_price, ref, txn_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, kind, signed, balanceAfter,
      b.unit_price === '' || b.unit_price == null ? null : toNum(b.unit_price),
      b.reason || null, b.txn_date || new Date().toISOString().slice(0, 10)
    );
    run(`UPDATE store_items SET balance = ? WHERE id = ?`, balanceAfter, id);
    return balanceAfter;
  });
  audit.record({ userId: req.user.id, entity: 'store_item', entityId: id, action: 'stock_adjust', after: { kind, qty: signed, balance: out }, reason: b.reason });
  emitter.emit('stock_updated', { item_id: id, action: 'adjust', kind, balance: out });
  res.status(201).json(oneItem(id));
}));

// ---- summary (KPI cards) --------------------------------------------------
router.get('/summary', asyncHandler((_req, res) => {
  const s = get(`SELECT
      COUNT(*) AS total_items,
      ROUND(COALESCE(SUM(balance * COALESCE(unit_cost, 0)), 0), 2) AS total_value,
      COALESCE(SUM(CASE WHEN balance <= COALESCE(min_stock, 0) THEN 1 ELSE 0 END), 0) AS low_stock_count,
      COUNT(DISTINCT CASE WHEN category IS NOT NULL AND TRIM(category) <> '' THEN category END) AS categories
    FROM store_items WHERE is_general = 1`);
  res.json(s);
}));

// ---- low stock ------------------------------------------------------------
router.get('/low-stock', asyncHandler((_req, res) => {
  const rows = all(`SELECT ${ITEM_COLS} FROM store_items
     WHERE is_general = 1 AND balance <= COALESCE(min_stock, 0)
     ORDER BY (balance - COALESCE(min_stock, 0)) ASC, name`);
  for (const r of rows) r.status = statusOf(r.balance, r.min_stock);
  res.json(rows);
}));

module.exports = router;
