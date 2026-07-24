'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const config = require('../config');
const { requireRole } = require('../lib/auth');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const audit = require('../lib/audit');
const aliases = require('../lib/aliases');
const costing = require('../lib/costing');
const emitter = require('../lib/emitter');
const { sendXlsx } = require('../lib/export');

const router = express.Router();

function currentBalance(productId) {
  const r = get('SELECT balance_after FROM stock_ledger WHERE product_id = ? ORDER BY id DESC LIMIT 1', productId);
  return r ? r.balance_after : 0;
}

// ---- products -------------------------------------------------------------
router.get('/products', asyncHandler((_req, res) => {
  const rows = all('SELECT * FROM products ORDER BY name');
  for (const p of rows) p.current_balance = currentBalance(p.id);
  res.json(rows);
}));

router.post('/products', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['name']);
  const result = tx(() => {
    const info = run(
      `INSERT INTO products (code, name, sheet_name, unit, category, reorder_level, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      b.code || null, b.name, b.sheet_name || null, b.unit || 'L', b.category || null, toNum(b.reorder_level, 0),
      b.unit_price === undefined || b.unit_price === '' ? null : toNum(b.unit_price)
    );
    const pid = info.lastInsertRowid;
    if (b.unit_price !== undefined && b.unit_price !== '' && b.unit_price !== null) {
      run('INSERT INTO product_prices (product_id, unit_price, effective_from) VALUES (?, ?, ?)',
        pid, toNum(b.unit_price), new Date().toISOString().slice(0, 10));
    }
    return pid;
  });
  audit.record({ userId: req.user.id, entity: 'product', entityId: result, action: 'create' });
  res.status(201).json(get('SELECT * FROM products WHERE id = ?', result));
}));

router.patch('/products/:id', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const before = get('SELECT * FROM products WHERE id = ?', id);
  if (!before) return res.status(404).json({ error: 'Product not found' });
  const b = req.body;
  tx(() => {
    const sets = [];
    const params = [];
    for (const c of ['code', 'name', 'sheet_name', 'unit', 'category', 'reorder_level', 'unit_price']) {
      if (b[c] !== undefined) { sets.push(`${c} = ?`); params.push(b[c]); }
    }
    if (sets.length) run(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    if (b.unit_price !== undefined && b.unit_price !== '' && b.unit_price !== null && Number(b.unit_price) !== before.unit_price) {
      run('INSERT INTO product_prices (product_id, unit_price, effective_from) VALUES (?, ?, ?)',
        id, toNum(b.unit_price), new Date().toISOString().slice(0, 10));
    }
  });
  const after = get('SELECT * FROM products WHERE id = ?', id);
  audit.record({ userId: req.user.id, entity: 'product', entityId: id, action: 'update', before, after });
  res.json(after);
}));

router.get('/products/:id/prices', asyncHandler((req, res) =>
  res.json(all('SELECT * FROM product_prices WHERE product_id = ? ORDER BY effective_from DESC, id DESC', toInt(req.params.id)))));

router.post('/products/:id/prices', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  require_(req.body, ['unit_price']);
  const eff = req.body.effective_from || new Date().toISOString().slice(0, 10);
  tx(() => {
    run('INSERT INTO product_prices (product_id, unit_price, effective_from) VALUES (?, ?, ?)', id, toNum(req.body.unit_price), eff);
    run('UPDATE products SET unit_price = ? WHERE id = ?', toNum(req.body.unit_price), id);
  });
  audit.record({ userId: req.user.id, entity: 'product_price', entityId: id, action: 'create' });
  res.status(201).json(get('SELECT * FROM products WHERE id = ?', id));
}));

// ---- ledger ---------------------------------------------------------------
router.get('/ledger', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.product_id) { clauses.push('sl.product_id = ?'); params.push(toInt(req.query.product_id)); }
  if (req.query.asset_id) { clauses.push('sl.asset_id = ?'); params.push(toInt(req.query.asset_id)); }
  if (req.query.from) { clauses.push('sl.txn_date >= ?'); params.push(req.query.from); }
  if (req.query.to) { clauses.push('sl.txn_date <= ?'); params.push(req.query.to); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(all(
    `SELECT sl.*, pr.name AS product_name, pr.unit, a.code AS asset_code FROM stock_ledger sl
       JOIN products pr ON pr.id = sl.product_id LEFT JOIN assets a ON a.id = sl.asset_id
       ${where} ORDER BY sl.id DESC LIMIT ${toInt(req.query.limit, 300)}`, ...params));
}));

router.post('/ledger', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['product_id', 'kind', 'qty']);
  const productId = toInt(b.product_id);
  if (!get('SELECT id FROM products WHERE id = ?', productId)) return res.status(400).json({ error: 'Unknown product' });
  const qtyMag = Math.abs(toNum(b.qty, 0));
  const prev = currentBalance(productId);
  let signed;
  let balanceAfter;
  switch (b.kind) {
    case 'receipt':
    case 'transfer': signed = qtyMag; balanceAfter = prev + qtyMag; break;
    case 'issue': signed = -qtyMag; balanceAfter = prev - qtyMag; break;
    case 'opening':
    case 'adjustment': balanceAfter = qtyMag; signed = qtyMag - prev; break;
    default: return res.status(400).json({ error: 'Invalid kind' });
  }
  const txnDate = b.txn_date || new Date().toISOString().slice(0, 10);
  let assetId = toInt(b.asset_id);
  let unresolved = null;
  if (!assetId && toInt(b.job_id)) { const j = get('SELECT asset_id FROM job_cards WHERE id = ?', toInt(b.job_id)); assetId = j ? j.asset_id : null; }
  if (!assetId && b.asset) {
    const r = aliases.resolveAsset(b.asset, { source: 'oil' });
    assetId = r.assetId;
    if (!r.resolved) unresolved = { aliasId: r.aliasId, raw: b.asset };
  }
  const unitPrice = b.unit_price === undefined || b.unit_price === '' ? costing.productPriceOn(productId, txnDate) : toNum(b.unit_price);
  // Rollup period + guards. Service-consumed oil is accounted under the service record's
  // cost, so it is NOT rolled into the vehicle's oil_cost bucket (avoids double count).
  const [yr, mo] = txnDate.split('-').map((n) => parseInt(n, 10));
  const validPeriod = /^\d{4}-\d{2}-\d{2}/.test(txnDate) && yr >= 1900 && mo >= 1 && mo <= 12;
  const isService = b.consumer_type === 'service';
  const lineCost = qtyMag * (unitPrice || 0);

  const ledgerId = tx(() => {
    const info = run(
      `INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, asset_id, project_id, job_id, consumer, consumer_type, mr_no, mtn_no, txn_date, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      productId, b.kind, signed, balanceAfter, unitPrice == null ? null : unitPrice, assetId || null,
      toInt(b.project_id), toInt(b.job_id), b.consumer || null, b.consumer_type || null, b.mr_no || null, b.mtn_no || null, txnDate, b.note || null
    );
    // Keep the denormalised balance in lock-step with the ledger (source of truth stays
    // balance_after; stock_qty simply mirrors the latest balance so lookups are cheap).
    run('UPDATE products SET stock_qty = ? WHERE id = ?', balanceAfter, productId);
    // Issue to a vehicle → roll the oil cost into that month's bucket (component += Δ,
    // total += Δ; single basis qty × unit_price — see lib vehicle_monthly_costs invariant).
    if (b.kind === 'issue' && assetId && validPeriod && !isService) {
      run(
        `INSERT INTO vehicle_monthly_costs (asset_id, year, month, oil_cost, total_cost)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(asset_id, year, month) DO UPDATE SET
           oil_cost = oil_cost + excluded.oil_cost,
           total_cost = total_cost + excluded.oil_cost,
           updated_at = datetime('now')`,
        assetId, yr, mo, lineCost, lineCost
      );
    }
    return info.lastInsertRowid;
  });
  audit.record({ userId: req.user.id, entity: 'stock_ledger', entityId: ledgerId, action: 'create', after: { kind: b.kind, balance: balanceAfter } });
  emitter.emit('oil_updated', { product_id: productId, kind: b.kind, balance: balanceAfter, asset_id: assetId || null });
  emitter.emit('dashboard_refresh', { reason: 'oil_' + b.kind, asset_id: assetId || null, year: yr, month: mo });
  res.status(201).json({ ledger: get('SELECT * FROM stock_ledger WHERE id = ?', ledgerId), unresolved });
}));

router.get('/balances', asyncHandler((_req, res) => {
  const rows = all('SELECT id, name, unit, reorder_level FROM products ORDER BY name');
  res.json(rows.map((p) => ({ product_id: p.id, name: p.name, unit: p.unit, balance: currentBalance(p.id), reorder_level: p.reorder_level })));
}));

// ---- stock summary / low stock / consumption (oil-stock page) --------------
// green OK / orange Low / red Critical, by stock_qty vs reorder_level.
const oilStatus = (qty, reorder) => (qty <= 0 ? 'critical' : (reorder > 0 && qty <= reorder ? 'low' : 'ok'));
const OIL_STOCK_COLS = `id, code, name, sheet_name, unit, category, COALESCE(reorder_level,0) AS reorder_level,
  COALESCE(unit_price,0) AS unit_price, COALESCE(stock_qty,0) AS stock_qty,
  ROUND(COALESCE(stock_qty,0) * COALESCE(unit_price,0), 2) AS total_value`;

// Products with current stock + valuation, grouped by category, plus headline totals.
router.get('/stock-summary', asyncHandler((_req, res) => {
  const products = all(`SELECT ${OIL_STOCK_COLS} FROM products WHERE active = 1 ORDER BY category, name`);
  const groups = {};
  let totalLitres = 0, totalValue = 0, lowCount = 0;
  for (const p of products) {
    p.status = oilStatus(p.stock_qty, p.reorder_level);
    totalLitres += p.stock_qty; totalValue += p.total_value;
    if (p.status !== 'ok') lowCount++;
    const c = p.category || 'other';
    if (!groups[c]) groups[c] = { category: c, litres: 0, value: 0, count: 0, products: [] };
    groups[c].products.push(p); groups[c].litres += p.stock_qty; groups[c].value += p.total_value; groups[c].count++;
  }
  const round2 = (n) => Math.round(n * 100) / 100;
  res.json({
    summary: { total_products: products.length, total_litres: round2(totalLitres), total_value: round2(totalValue), low_stock_count: lowCount },
    groups: Object.values(groups).map((g) => ({ ...g, litres: round2(g.litres), value: round2(g.value) })),
  });
}));

// Products at or below their reorder level (or out of stock).
router.get('/low-stock', asyncHandler((_req, res) => {
  const rows = all(`SELECT ${OIL_STOCK_COLS} FROM products
     WHERE active = 1 AND (COALESCE(stock_qty,0) <= 0 OR (COALESCE(reorder_level,0) > 0 AND COALESCE(stock_qty,0) <= reorder_level))
     ORDER BY (COALESCE(stock_qty,0) - COALESCE(reorder_level,0)) ASC, name`);
  for (const r of rows) r.status = oilStatus(r.stock_qty, r.reorder_level);
  res.json(rows);
}));

// Oil consumption for one month: issued litres + cost by product, category and vehicle.
// Physical consumption, so ALL non-voided issues count (voided entries excluded).
router.get('/consumption/:year/:month', asyncHandler((req, res) => {
  const year = toInt(req.params.year), month = toInt(req.params.month);
  if (!(year >= 1900 && month >= 1 && month <= 12)) return res.status(400).json({ error: 'Invalid year/month' });
  const ym = String(year) + '-' + String(month).padStart(2, '0'); // 'YYYY-MM'
  const CONS = `SUM(ABS(sl.qty))`;
  const COST = `SUM(ABS(sl.qty) * COALESCE(sl.unit_price, p.unit_price, 0))`;
  const where = `sl.kind = 'issue' AND COALESCE(sl.voided,0) = 0 AND substr(sl.txn_date,1,7) = ?`;
  const by_product = all(
    `SELECT p.id AS product_id, p.name, p.category, p.unit, ROUND(${CONS},2) AS litres, ROUND(${COST},2) AS cost
       FROM stock_ledger sl JOIN products p ON p.id = sl.product_id
      WHERE ${where} GROUP BY p.id ORDER BY litres DESC`, ym);
  const by_category = all(
    `SELECT COALESCE(p.category,'other') AS category, ROUND(${CONS},2) AS litres, ROUND(${COST},2) AS cost
       FROM stock_ledger sl JOIN products p ON p.id = sl.product_id
      WHERE ${where} GROUP BY 1 ORDER BY litres DESC`, ym);
  const by_vehicle = all(
    `SELECT sl.asset_id, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec,
            ROUND(${CONS},2) AS litres, ROUND(${COST},2) AS cost
       FROM stock_ledger sl JOIN products p ON p.id = sl.product_id LEFT JOIN assets a ON a.id = sl.asset_id
      WHERE ${where} AND sl.asset_id IS NOT NULL GROUP BY sl.asset_id ORDER BY litres DESC LIMIT 50`, ym);
  res.json({ year, month, by_product, by_category, by_vehicle });
}));

// ---- stock counts ---------------------------------------------------------
router.get('/counts', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.period) { clauses.push('sc.period = ?'); params.push(req.query.period); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(all(`SELECT sc.*, pr.name AS product_name FROM stock_counts sc JOIN products pr ON pr.id = sc.product_id ${where} ORDER BY sc.period DESC, pr.name`, ...params));
}));

router.post('/counts', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['product_id', 'period', 'counted_qty']);
  const productId = toInt(b.product_id);
  const counted = toNum(b.counted_qty, 0);
  const book = currentBalance(productId);
  const variance = counted - book;
  const result = tx(() => {
    run(
      `INSERT INTO stock_counts (product_id, period, book_qty, counted_qty, variance, note, counted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(product_id, period) DO UPDATE SET book_qty=excluded.book_qty, counted_qty=excluded.counted_qty,
         variance=excluded.variance, note=excluded.note, counted_by=excluded.counted_by`,
      productId, b.period, book, counted, variance, b.note || null, b.counted_by || null
    );
    if (b.post_adjustment && variance !== 0) {
      run(
        `INSERT INTO stock_ledger (product_id, kind, qty, balance_after, txn_date, note)
         VALUES (?, 'adjustment', ?, ?, ?, ?)`,
        productId, variance, counted, new Date().toISOString().slice(0, 10), `Stock count adjustment ${b.period}`
      );
      // Keep the denormalised balance in step with the adjustment.
      run('UPDATE products SET stock_qty = ? WHERE id = ?', counted, productId);
    }
    return get('SELECT * FROM stock_counts WHERE product_id = ? AND period = ?', productId, b.period);
  });
  audit.record({ userId: req.user.id, entity: 'stock_count', entityId: result.id, action: 'create' });
  if (b.post_adjustment && variance !== 0) emitter.emit('oil_updated', { product_id: productId, kind: 'adjustment', balance: counted });
  res.status(201).json(result);
}));

// ---- forecast -------------------------------------------------------------
router.get('/forecast', asyncHandler((_req, res) => {
  const windowDays = config.forecastWindowDays;
  const since = new Date(Date.now() - windowDays * 86400 * 1000).toISOString().slice(0, 10);
  const products = all('SELECT * FROM products ORDER BY name');
  const out = products.map((p) => {
    const consRow = get(
      `SELECT COALESCE(SUM(ABS(qty)),0) c FROM stock_ledger WHERE product_id = ? AND kind = 'issue' AND txn_date >= ?`,
      p.id, since
    );
    const consumption = consRow.c || 0;
    const dailyRate = consumption / windowDays;
    const balance = currentBalance(p.id);
    const daysOfCover = dailyRate > 0 ? balance / dailyRate : null;
    const low = (daysOfCover != null && daysOfCover <= config.lowStockDays) || (p.reorder_level > 0 && balance <= p.reorder_level);
    return {
      product_id: p.id, name: p.name, unit: p.unit, balance,
      reorder_level: p.reorder_level, consumption_window: consumption,
      daily_rate: Math.round(dailyRate * 100) / 100,
      days_of_cover: daysOfCover == null ? null : Math.round(daysOfCover),
      low, suggested_reorder: low,
    };
  });
  out.sort((a, b) => (a.low === b.low ? (a.days_of_cover ?? 1e9) - (b.days_of_cover ?? 1e9) : (a.low ? -1 : 1)));
  res.json({ window_days: windowDays, low_stock_days: config.lowStockDays, products: out });
}));

router.get('/export/ledger.xlsx', asyncHandler(async (_req, res) => {
  const rows = all(`SELECT sl.txn_date, pr.name AS product, sl.kind, sl.qty, sl.balance_after, sl.unit_price, a.code AS asset FROM stock_ledger sl JOIN products pr ON pr.id=sl.product_id LEFT JOIN assets a ON a.id=sl.asset_id ORDER BY sl.id DESC`);
  await sendXlsx(res, 'oil-ledger.xlsx', [{
    name: 'Ledger',
    columns: [
      { header: 'Date', key: 'txn_date' }, { header: 'Product', key: 'product' },
      { header: 'Kind', key: 'kind' }, { header: 'Qty', key: 'qty' },
      { header: 'Balance', key: 'balance_after' }, { header: 'Unit Price', key: 'unit_price' },
      { header: 'Asset', key: 'asset' },
    ], rows,
  }]);
}));

module.exports = router;
