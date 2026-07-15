'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireRole } = require('../lib/auth');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const audit = require('../lib/audit');
const aliases = require('../lib/aliases');
const { sendXlsx } = require('../lib/export');

const router = express.Router();

// ---- numbering (continues existing sequences) -----------------------------
function nextMrnNo() {
  const r = get(`SELECT MAX(CAST(mrn_no AS INTEGER)) m FROM mrn WHERE mrn_no GLOB '[0-9]*'`);
  return String((r && r.m ? r.m : 167442) + 1);
}
function nextMtnNo() {
  const r = get(`SELECT MAX(CAST(mtn_no AS INTEGER)) m FROM mtn WHERE mtn_no GLOB '[0-9]*'`);
  return String((r && r.m ? r.m : 57814) + 1);
}
function resolveAssetId(body, prefix) {
  const idKey = prefix ? `${prefix}_asset_id` : 'asset_id';
  const textKey = prefix ? `${prefix}_asset` : 'asset';
  if (body[idKey]) return { assetId: toInt(body[idKey]), unresolved: null };
  if (body[textKey]) {
    const r = aliases.resolveAsset(body[textKey], { source: 'stores' });
    return { assetId: r.assetId, unresolved: r.resolved ? null : { aliasId: r.aliasId, raw: body[textKey] } };
  }
  return { assetId: null, unresolved: null };
}

router.get('/numbers', asyncHandler((_req, res) => res.json({ next_mrn: nextMrnNo(), next_mtn: nextMtnNo() })));

// ---- store items ----------------------------------------------------------
router.get('/items', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.q) { clauses.push('(name LIKE ? OR part_number LIKE ?)'); params.push('%' + req.query.q + '%', '%' + req.query.q + '%'); }
  if (req.query.is_general !== undefined) { clauses.push('is_general = ?'); params.push(toInt(req.query.is_general)); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(all(`SELECT * FROM store_items ${where} ORDER BY name LIMIT ${toInt(req.query.limit, 500)}`, ...params));
}));

router.post('/items', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['name']);
  const info = run(
    `INSERT INTO store_items (name, part_number, category, unit, rack, min_stock, is_general, balance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    b.name, b.part_number || null, b.category || null, b.unit || 'nos', b.rack || null,
    toNum(b.min_stock, 0), b.is_general ? 1 : 0, toNum(b.balance, 0)
  );
  audit.record({ userId: req.user.id, entity: 'store_item', entityId: info.lastInsertRowid, action: 'create' });
  res.status(201).json(get('SELECT * FROM store_items WHERE id = ?', info.lastInsertRowid));
}));

router.patch('/items/:id', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const sets = [];
  const params = [];
  for (const c of ['name', 'part_number', 'category', 'unit', 'rack', 'min_stock']) {
    if (req.body[c] !== undefined) { sets.push(`${c} = ?`); params.push(req.body[c]); }
  }
  if (sets.length) run(`UPDATE store_items SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  res.json(get('SELECT * FROM store_items WHERE id = ?', id));
}));

router.get('/items/:id/ledger', asyncHandler((req, res) =>
  res.json(all('SELECT * FROM general_item_txns WHERE store_item_id = ? ORDER BY id DESC', toInt(req.params.id)))));

router.post('/items/:id/txn', requireRole('storekeeper'), asyncHandler((req, res) => {
  const itemId = toInt(req.params.id);
  const item = get('SELECT * FROM store_items WHERE id = ?', itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const b = req.body;
  require_(b, ['txn_type', 'qty']);
  const qtyMag = Math.abs(toNum(b.qty, 0));
  const prevRow = get('SELECT balance_after FROM general_item_txns WHERE store_item_id = ? ORDER BY id DESC LIMIT 1', itemId);
  const prev = prevRow ? prevRow.balance_after : (item.balance || 0);
  let signedQty;
  let balanceAfter;
  switch (b.txn_type) {
    case 'receipt': signedQty = qtyMag; balanceAfter = prev + qtyMag; break;
    case 'issue': signedQty = -qtyMag; balanceAfter = prev - qtyMag; break;
    case 'opening': balanceAfter = qtyMag; signedQty = qtyMag - prev; break;
    case 'adjustment': balanceAfter = qtyMag; signedQty = qtyMag - prev; break;
    default: return res.status(400).json({ error: 'Invalid txn_type' });
  }
  const { assetId } = resolveAssetId(b);
  const result = tx(() => {
    const info = run(
      `INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, asset_id, job_id, unit_price, ref, txn_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      itemId, b.txn_type, signedQty, balanceAfter, assetId || null, toInt(b.job_id),
      b.unit_price === undefined || b.unit_price === '' ? null : toNum(b.unit_price), b.ref || null,
      b.txn_date || new Date().toISOString().slice(0, 10)
    );
    run('UPDATE store_items SET balance = ? WHERE id = ?', balanceAfter, itemId);
    return get('SELECT * FROM general_item_txns WHERE id = ?', info.lastInsertRowid);
  });
  audit.record({ userId: req.user.id, entity: 'general_item_txn', entityId: result.id, action: 'create' });
  res.status(201).json(result);
}));

router.get('/reorder', asyncHandler((_req, res) =>
  res.json(all('SELECT * FROM store_items WHERE is_general = 1 AND min_stock > 0 AND balance <= min_stock ORDER BY name'))));

// ---- MRN ------------------------------------------------------------------
router.get('/mrn', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.asset_id) { clauses.push('m.asset_id = ?'); params.push(toInt(req.query.asset_id)); }
  if (req.query.status) { clauses.push('m.status = ?'); params.push(req.query.status); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(all(
    `SELECT m.*, a.code AS asset_code, (SELECT COUNT(*) FROM mrn_lines ml WHERE ml.mrn_id = m.id) AS line_count
       FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id ${where} ORDER BY m.id DESC LIMIT ${toInt(req.query.limit, 300)}`,
    ...params
  ));
}));

router.post('/mrn', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['purpose']);
  const { assetId, unresolved } = resolveAssetId(b);
  const mrnNo = nextMrnNo();
  const result = tx(() => {
    const info = run(
      `INSERT INTO mrn (mrn_no, req_date, asset_id, project_id, job_id, purpose, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      mrnNo, b.req_date || new Date().toISOString().slice(0, 10), assetId || null,
      toInt(b.project_id), toInt(b.job_id), b.purpose, b.requested_by || null
    );
    const mrnId = info.lastInsertRowid;
    const lines = Array.isArray(b.lines) ? b.lines : [];
    for (const l of lines) {
      run('INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty, unit) VALUES (?, ?, ?, ?, ?)',
        mrnId, toInt(l.store_item_id), l.description || '', toNum(l.qty, 0), l.unit || 'nos');
    }
    return mrnId;
  });
  audit.record({ userId: req.user.id, entity: 'mrn', entityId: result, action: 'create', after: { mrn_no: mrnNo } });
  res.status(201).json({
    mrn: get('SELECT * FROM mrn WHERE id = ?', result),
    lines: all('SELECT * FROM mrn_lines WHERE mrn_id = ?', result),
    unresolved,
  });
}));

router.get('/mrn/:id', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const mrn = get('SELECT m.*, a.code AS asset_code FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id WHERE m.id = ?', id);
  if (!mrn) return res.status(404).json({ error: 'MRN not found' });
  res.json({ mrn, lines: all('SELECT * FROM mrn_lines WHERE mrn_id = ?', id) });
}));

router.post('/mrn/:id/lines', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  require_(req.body, ['description', 'qty']);
  const info = run('INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty, unit) VALUES (?, ?, ?, ?, ?)',
    id, toInt(req.body.store_item_id), req.body.description, toNum(req.body.qty, 0), req.body.unit || 'nos');
  res.status(201).json(get('SELECT * FROM mrn_lines WHERE id = ?', info.lastInsertRowid));
}));

// ---- GRN ------------------------------------------------------------------
router.get('/grn', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.mrn_id) { clauses.push('g.mrn_id = ?'); params.push(toInt(req.query.mrn_id)); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(all(
    `SELECT g.*, m.mrn_no, a.code AS asset_code FROM grn g
       LEFT JOIN mrn m ON m.id = g.mrn_id LEFT JOIN assets a ON a.id = m.asset_id
       ${where} ORDER BY g.id DESC LIMIT ${toInt(req.query.limit, 300)}`, ...params));
}));

router.post('/grn', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['qty']);
  const source = b.purchase_source;
  if (source && !['local_purchase', 'head_office', 'local_store'].includes(source)) {
    return res.status(400).json({ error: 'Invalid purchase_source' });
  }
  const result = tx(() => {
    const info = run(
      `INSERT INTO grn (grn_no, mrn_id, mrn_line_id, store_item_id, description, qty, unit_price, supplier, invoice_no, invoice_date, delivery_date, purchase_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.grn_no || null, toInt(b.mrn_id), toInt(b.mrn_line_id), toInt(b.store_item_id), b.description || null,
      toNum(b.qty, 0), b.unit_price === undefined || b.unit_price === '' ? null : toNum(b.unit_price),
      b.supplier || null, b.invoice_no || null, b.invoice_date || null, b.delivery_date || null, source || null
    );
    if (b.mrn_line_id) {
      run('UPDATE mrn_lines SET qty_received = qty_received + ? WHERE id = ?', toNum(b.qty, 0), toInt(b.mrn_line_id));
      const line = get('SELECT mrn_id FROM mrn_lines WHERE id = ?', toInt(b.mrn_line_id));
      if (line) {
        const open = get('SELECT COUNT(*) c FROM mrn_lines WHERE mrn_id = ? AND qty_received < qty', line.mrn_id);
        const any = get('SELECT COUNT(*) c FROM mrn_lines WHERE mrn_id = ? AND qty_received > 0', line.mrn_id);
        const status = open.c === 0 ? 'received' : (any.c > 0 ? 'partially_received' : 'open');
        run('UPDATE mrn SET status = ? WHERE id = ?', status, line.mrn_id);
      }
    }
    return info.lastInsertRowid;
  });
  audit.record({ userId: req.user.id, entity: 'grn', entityId: result, action: 'create' });
  res.status(201).json(get('SELECT * FROM grn WHERE id = ?', result));
}));

router.patch('/grn/:id', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const before = get('SELECT * FROM grn WHERE id = ?', id);
  if (!before) return res.status(404).json({ error: 'GRN not found' });
  const sets = [];
  const params = [];
  for (const c of ['unit_price', 'supplier', 'invoice_no', 'invoice_date', 'delivery_date', 'purchase_source']) {
    if (req.body[c] !== undefined) {
      sets.push(`${c} = ?`);
      params.push(c === 'unit_price' ? (req.body[c] === '' || req.body[c] === null ? null : toNum(req.body[c])) : req.body[c]);
    }
  }
  if (sets.length) run(`UPDATE grn SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  const after = get('SELECT * FROM grn WHERE id = ?', id);
  audit.record({ userId: req.user.id, entity: 'grn', entityId: id, action: 'update', before, after, reason: 'late pricing' });
  res.json(after);
}));

// ---- Issues ---------------------------------------------------------------
router.get('/issues', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.asset_id) { clauses.push('i.asset_id = ?'); params.push(toInt(req.query.asset_id)); }
  if (req.query.job_id) { clauses.push('i.job_id = ?'); params.push(toInt(req.query.job_id)); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(all(`SELECT i.*, a.code AS asset_code FROM issues i LEFT JOIN assets a ON a.id = i.asset_id ${where} ORDER BY i.id DESC LIMIT ${toInt(req.query.limit, 300)}`, ...params));
}));

router.post('/issues', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['description']);
  const { assetId, unresolved } = resolveAssetId(b);
  const info = run(
    `INSERT INTO issues (asset_id, job_id, store_item_id, description, qty, unit_price, issue_date, issued_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    assetId || null, toInt(b.job_id), toInt(b.store_item_id), b.description, toNum(b.qty, 1),
    b.unit_price === undefined || b.unit_price === '' ? null : toNum(b.unit_price),
    b.issue_date || new Date().toISOString().slice(0, 10), b.issued_by || null
  );
  audit.record({ userId: req.user.id, entity: 'issue', entityId: info.lastInsertRowid, action: 'create' });
  res.status(201).json({ issue: get('SELECT * FROM issues WHERE id = ?', info.lastInsertRowid), unresolved });
}));

// ---- MTN ------------------------------------------------------------------
router.get('/mtn', asyncHandler((req, res) => res.json(all(
  `SELECT t.*, af.code AS from_asset_code, at2.code AS to_asset_code FROM mtn t
     LEFT JOIN assets af ON af.id = t.from_asset_id LEFT JOIN assets at2 ON at2.id = t.to_asset_id
    ORDER BY t.id DESC LIMIT ${toInt(req.query.limit, 300)}`))));

router.post('/mtn', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['qty']);
  const from = resolveAssetId(b, 'from');
  const to = resolveAssetId(b, 'to');
  const mtnNo = nextMtnNo();
  const info = run(
    `INSERT INTO mtn (mtn_no, txn_date, store_item_id, description, qty, from_location, to_location, from_asset_id, to_asset_id, transferred_by, received_by, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    mtnNo, b.txn_date || new Date().toISOString().slice(0, 10), toInt(b.store_item_id), b.description || null,
    toNum(b.qty, 0), b.from_location || null, b.to_location || null, from.assetId || null, to.assetId || null,
    b.transferred_by || null, b.received_by || null, b.reason || null
  );
  audit.record({ userId: req.user.id, entity: 'mtn', entityId: info.lastInsertRowid, action: 'create', after: { mtn_no: mtnNo } });
  res.status(201).json(get('SELECT * FROM mtn WHERE id = ?', info.lastInsertRowid));
}));

// ---- exports --------------------------------------------------------------
router.get('/export/mrn.xlsx', asyncHandler(async (_req, res) => {
  const rows = all(`SELECT m.mrn_no, m.req_date, a.code AS asset_code, m.purpose, m.status FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id ORDER BY m.id DESC`);
  await sendXlsx(res, 'mrn.xlsx', [{
    name: 'MRN',
    columns: [
      { header: 'MRN No', key: 'mrn_no' }, { header: 'Date', key: 'req_date' },
      { header: 'Asset', key: 'asset_code' }, { header: 'Purpose', key: 'purpose' }, { header: 'Status', key: 'status' },
    ], rows,
  }]);
}));

module.exports = router;
