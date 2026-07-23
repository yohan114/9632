'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireRole, hasRole } = require('../lib/auth');
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

// ---- Category breakdown (for the Categories tab) --------------------------
const CAT = "COALESCE(NULLIF(TRIM(category),''),'(uncategorised)')";
router.get('/categories', asyncHandler((_req, res) => {
  res.json({
    lines: all(`SELECT ${CAT} category, COUNT(*) lines, COUNT(DISTINCT description) distinct_items,
                       ROUND(COALESCE(SUM(qty),0),1) qty, ROUND(COALESCE(SUM(qty_received),0),1) received
                  FROM mrn_lines GROUP BY category ORDER BY lines DESC`),
    issues: all(`SELECT ${CAT} category, COUNT(*) issues, ROUND(COALESCE(SUM(qty),0),1) qty
                   FROM issues GROUP BY category ORDER BY issues DESC`),
    transfers: all(`SELECT ${CAT} category, COUNT(*) transfers, ROUND(COALESCE(SUM(qty),0),1) qty
                      FROM mtn GROUP BY category ORDER BY transfers DESC`),
    catalogue: all(`SELECT ${CAT} category, COUNT(*) items FROM store_items GROUP BY category ORDER BY items DESC`),
  });
}));

// ---- General item catalogue (deduped MRN items, each with an item number) --
// The consolidated master built from every MRN request description: synonym /
// spelling variants merged, all part numbers unioned, classified and numbered
// (see migrate/14_item_catalogue). These are the rows where item_no IS NOT NULL.
const CAT_KIND = "COALESCE(NULLIF(TRIM(catalogue_kind),''),'part')";

router.get('/catalogue/facets', asyncHandler((_req, res) => {
  res.json({
    total: get('SELECT COUNT(*) c FROM store_items WHERE item_no IS NOT NULL').c,
    by_kind: all(`SELECT ${CAT_KIND} kind, COUNT(*) count FROM store_items WHERE item_no IS NOT NULL GROUP BY kind ORDER BY count DESC`),
    categories: all(`SELECT ${CAT} category, COUNT(*) count FROM store_items WHERE item_no IS NOT NULL GROUP BY category ORDER BY category`),
  });
}));

router.get('/catalogue', asyncHandler((req, res) => {
  const clauses = ['item_no IS NOT NULL'];
  const params = [];
  if (req.query.q && String(req.query.q).trim()) {
    const like = '%' + String(req.query.q).trim() + '%';
    clauses.push('(item_no LIKE ? OR name LIKE ? OR part_numbers LIKE ?)');
    params.push(like, like, like);
  }
  if (req.query.category) { clauses.push(`${CAT} = ?`); params.push(req.query.category); }
  if (req.query.kind) { clauses.push(`${CAT_KIND} = ?`); params.push(req.query.kind); }
  const where = 'WHERE ' + clauses.join(' AND ');
  res.json(all(
    `SELECT id, item_no, name, category, catalogue_kind, req_count, part_numbers, part_number, unit, is_general, balance
       FROM store_items ${where} ORDER BY item_no LIMIT ${toInt(req.query.limit, 2000)}`, ...params));
}));

router.get('/export/catalogue.xlsx', asyncHandler(async (_req, res) => {
  const rows = all(`SELECT item_no, name, category, ${CAT_KIND} kind, req_count AS requests, COALESCE(part_numbers,'') part_numbers
                      FROM store_items WHERE item_no IS NOT NULL ORDER BY item_no`);
  await sendXlsx(res, 'item_catalogue.xlsx', [{
    name: 'Item Catalogue',
    columns: [
      { header: 'Item No', key: 'item_no' }, { header: 'Item Name', key: 'name' },
      { header: 'Category', key: 'category' }, { header: 'Kind', key: 'kind' },
      { header: 'Requests', key: 'requests' }, { header: 'Part Numbers', key: 'part_numbers' },
    ], rows,
  }]);
}));

// ---- MRN ------------------------------------------------------------------
// Two consolidated purchase sources: Head Office (absorbs Direct Purchase) and
// Local Purchase (absorbs Local Store).
const PURCHASE_SOURCES = ['head_office', 'local_purchase'];
function purchaseSourceNorm(s) {
  s = String(s == null ? '' : s).trim().toLowerCase();
  if (!s) return null;
  if (s.includes('direct') || s.includes('head office') || s === 'head_office') return 'head_office';
  if (s.includes('local')) return 'local_purchase'; // local purchase OR local store
  return 'head_office'; // combos / anything else roll up to Head Office
}
const MRN_SORTS = {
  date_desc: 'm.req_date DESC, m.id DESC',
  date_asc: 'm.req_date ASC, m.id ASC',
  mrn_desc: 'CAST(m.mrn_no AS INTEGER) DESC, m.id DESC',
  mrn_asc: 'CAST(m.mrn_no AS INTEGER) ASC, m.id ASC',
};

router.get('/mrn', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.asset_id) { clauses.push('m.asset_id = ?'); params.push(toInt(req.query.asset_id)); }
  if (req.query.status) { clauses.push('m.status = ?'); params.push(req.query.status); }
  // Free-text search: MRN number, vehicle, purpose, or any item description on the MRN.
  if (req.query.q && String(req.query.q).trim()) {
    const like = '%' + String(req.query.q).trim() + '%';
    clauses.push(`(m.mrn_no LIKE ? OR a.code LIKE ? OR m.purpose LIKE ?
                   OR EXISTS (SELECT 1 FROM mrn_lines ml WHERE ml.mrn_id = m.id AND ml.description LIKE ?))`);
    params.push(like, like, like, like);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const order = MRN_SORTS[req.query.sort] || 'm.id DESC';
  res.json(all(
    `SELECT m.*, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec,
            (SELECT COUNT(*)            FROM mrn_lines ml WHERE ml.mrn_id = m.id) AS line_count,
            (SELECT COALESCE(SUM(qty),0)          FROM mrn_lines ml WHERE ml.mrn_id = m.id) AS qty_requested,
            (SELECT COALESCE(SUM(qty_received),0) FROM mrn_lines ml WHERE ml.mrn_id = m.id) AS qty_received
       FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id ${where} ORDER BY ${order} LIMIT ${toInt(req.query.limit, 300)}`,
    ...params
  ));
}));

router.post('/mrn', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  // Request target: 'general' (store stock) or 'vehicle' (against a job card, which sets the vehicle).
  const requestType = b.request_type === 'general' ? 'general' : 'vehicle';
  const jobId = requestType === 'vehicle' ? toInt(b.job_id) : null;
  let assetId = null, unresolved = null;
  if (jobId) { const job = get('SELECT asset_id FROM job_cards WHERE id = ?', jobId); assetId = job ? job.asset_id : null; }
  else if (requestType === 'vehicle') { const r = resolveAssetId(b); assetId = r.assetId; unresolved = r.unresolved; }
  const mrnNo = String(b.mrn_no || '').trim() || nextMrnNo();
  if (get('SELECT id FROM mrn WHERE mrn_no = ?', mrnNo)) {
    return res.status(409).json({ error: `MRN number ${mrnNo} already exists` });
  }
  const source = b.purchase_source || null;
  if (source && !PURCHASE_SOURCES.includes(source)) return res.status(400).json({ error: 'Invalid purchase_source' });
  // Record the requesting storekeeper (also marks this as a live, in-flow MRN vs imported history).
  const ru = get('SELECT full_name, username FROM users WHERE id = ?', req.user.id);
  const reqBy = String(b.requested_by || '').trim() || (ru ? (ru.full_name || ru.username) : null);
  const result = tx(() => {
    const info = run(
      `INSERT INTO mrn (mrn_no, req_date, asset_id, project_id, job_id, purpose, requested_by, purchase_source, required_date, request_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      mrnNo, b.req_date || new Date().toISOString().slice(0, 10), assetId || null,
      toInt(b.project_id), jobId, b.purpose || null, reqBy, source, b.required_date || null, requestType
    );
    const mrnId = info.lastInsertRowid;
    const lines = Array.isArray(b.lines) ? b.lines : [];
    const lineSrcs = new Set();
    for (const l of lines) {
      const ls = PURCHASE_SOURCES.includes(l.purchase_source) ? l.purchase_source : (source || null);
      if (ls) lineSrcs.add(ls);
      run('INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty, unit, category, purchase_source) VALUES (?, ?, ?, ?, ?, ?, ?)',
        mrnId, toInt(l.store_item_id), l.description || '', toNum(l.qty, 0), l.unit || 'nos', l.category || null, ls);
    }
    // Header source = the single source if every line agrees, else leave the given/default.
    if (lineSrcs.size === 1) run('UPDATE mrn SET purchase_source = ? WHERE id = ?', [...lineSrcs][0], mrnId);
    // Requester's e-signature (the SK who raised it).
    const uSig = get('SELECT signature FROM users WHERE id = ?', req.user.id);
    if (uSig && uSig.signature) run('UPDATE mrn SET requested_sig = ? WHERE id = ?', uSig.signature, mrnId);
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
  const mrn = get('SELECT m.*, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id WHERE m.id = ?', id);
  if (!mrn) return res.status(404).json({ error: 'MRN not found' });
  res.json({
    mrn,
    lines: all('SELECT * FROM mrn_lines WHERE mrn_id = ? ORDER BY id', id),
    grns: all('SELECT * FROM grn WHERE mrn_id = ? ORDER BY id', id),
    approvals: all('SELECT a.*, u.username FROM mrn_approvals a LEFT JOIN users u ON u.id = a.approver_id WHERE a.mrn_id = ? ORDER BY a.id', id),
  });
}));

// ---- MRN approval flow (e-signatures + logging) ----------------------------
// SK requests (create) → Workshop certifies → Operational Manager approves.
const signer = (userId) => { const u = get('SELECT full_name, username, signature FROM users WHERE id = ?', userId); return { name: u ? (u.full_name || u.username) : 'user', sig: u ? u.signature : null }; };

router.post('/mrn/:id/certify', requireRole('workshop', 'manager'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const mrn = get('SELECT * FROM mrn WHERE id = ?', id);
  if (!mrn) return res.status(404).json({ error: 'MRN not found' });
  if (mrn.approval_status === 'approved') return res.status(409).json({ error: 'Already approved — cannot re-certify' });
  const s = signer(req.user.id); const sig = req.body.signature || s.sig || null;
  tx(() => {
    run(`UPDATE mrn SET approval_status = 'certified', certified_by = ?, certified_at = datetime('now'), certified_sig = ? WHERE id = ?`, s.name, sig, id);
    run(`INSERT INTO mrn_approvals (mrn_id, stage, role, approver_id, signed_name, signature, decision, reason) VALUES (?, 'certify', 'workshop', ?, ?, ?, 'approved', ?)`, id, req.user.id, s.name, sig, req.body.reason || null);
  });
  audit.record({ userId: req.user.id, entity: 'mrn', entityId: id, action: 'certify', after: { certified_by: s.name }, reason: req.body.reason });
  res.json(get('SELECT * FROM mrn WHERE id = ?', id));
}));

router.post('/mrn/:id/approve', requireRole('operational_manager', 'manager'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const mrn = get('SELECT * FROM mrn WHERE id = ?', id);
  if (!mrn) return res.status(404).json({ error: 'MRN not found' });
  if (mrn.approval_status !== 'certified') return res.status(409).json({ error: 'MRN must be certified (Workshop Engineer) before Operational Manager approval' });
  const s = signer(req.user.id); const sig = req.body.signature || s.sig || null;
  tx(() => {
    run(`UPDATE mrn SET approval_status = 'approved', approved_by = ?, approved_at = datetime('now'), approved_sig = ? WHERE id = ?`, s.name, sig, id);
    run(`INSERT INTO mrn_approvals (mrn_id, stage, role, approver_id, signed_name, signature, decision, reason) VALUES (?, 'approve', 'operational_manager', ?, ?, ?, 'approved', ?)`, id, req.user.id, s.name, sig, req.body.reason || null);
  });
  audit.record({ userId: req.user.id, entity: 'mrn', entityId: id, action: 'approve', after: { approved_by: s.name }, reason: req.body.reason });
  res.json(get('SELECT * FROM mrn WHERE id = ?', id));
}));

router.post('/mrn/:id/reject', requireRole('workshop', 'operational_manager', 'manager'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const mrn = get('SELECT * FROM mrn WHERE id = ?', id);
  if (!mrn) return res.status(404).json({ error: 'MRN not found' });
  if (!String(req.body.reason || '').trim()) return res.status(400).json({ error: 'A reason is required to reject' });
  const s = signer(req.user.id);
  const asApprover = hasRole(req.user, 'operational_manager') || hasRole(req.user, 'manager');
  const stage = asApprover ? 'approve' : 'certify';
  tx(() => {
    run(`UPDATE mrn SET approval_status = 'rejected' WHERE id = ?`, id);
    run(`INSERT INTO mrn_approvals (mrn_id, stage, role, approver_id, signed_name, signature, decision, reason) VALUES (?, ?, ?, ?, ?, ?, 'rejected', ?)`,
      id, stage, asApprover ? 'operational_manager' : 'workshop', req.user.id, s.name, req.body.signature || s.sig || null, req.body.reason);
  });
  audit.record({ userId: req.user.id, entity: 'mrn', entityId: id, action: 'reject', after: { by: s.name }, reason: req.body.reason });
  res.json(get('SELECT * FROM mrn WHERE id = ?', id));
}));

// Printable Material Requisition form (matches the paper EC1.ST.FO.01 layout).
router.get('/mrn/:id/print.html', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const mrn = get('SELECT m.*, a.code AS asset_code, p.name AS project_name FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = ?', id);
  if (!mrn) return res.status(404).send('MRN not found');
  const lines = all('SELECT * FROM mrn_lines WHERE mrn_id = ? ORDER BY id', id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const d = (v) => (v ? String(v).slice(0, 10) : '');
  const srcLbl = (s) => (s === 'head_office' ? 'H/O' : s === 'local_purchase' ? 'Local' : '');
  const lineSrcs = [...new Set(lines.map((l) => l.purchase_source).filter(Boolean))];
  const srcTag = lineSrcs.length === 1 ? srcLbl(lineSrcs[0]) : lineSrcs.length > 1 ? 'Mixed' : srcLbl(mrn.purchase_source);
  const MIN_ROWS = 12;
  const rowHtml = (l, i) => `<tr>
    <td class="c">${i + 1}</td>
    <td>${esc(l ? l.description : '')}</td>
    <td class="c">${esc(l ? (l.unit || 'nos') : '')}</td>
    <td class="c">${l ? srcLbl(l.purchase_source || mrn.purchase_source) : ''}</td>
    <td class="num">${l && l.qty_received ? l.qty_received : ''}</td>
    <td></td>
    <td class="num">${l && l.qty ? l.qty : ''}</td>
    <td></td></tr>`;
  const rows = [];
  for (let i = 0; i < Math.max(MIN_ROWS, lines.length); i++) rows.push(rowHtml(lines[i], i));
  const sigBlock = (title, name, dateVal, designation, sigImg, isLast) => `
    <div class="${isLast ? '' : 'l'}"><b>${title}</b>
      ${sigImg ? `<div style="height:36px;margin:2px 0"><img src="${sigImg}" style="max-height:36px;max-width:160px"></div>`
        : '<div class="sig-line" style="margin-top:22px">Signature</div>'}
      <div class="rowline"><span class="k">Name:</span> ${name ? esc(name) + (sigImg ? '' : ' <span style="color:#0a7a0a;font-size:9px">&#10003; e-signed</span>') : ''}</div>
      <div class="rowline"><span class="k">Designation:</span> ${esc(designation)}</div>
      <div class="rowline"><span class="k">Date:</span> ${dateVal ? esc(d(dateVal)) : ''}</div></div>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>MRN ${esc(mrn.mrn_no)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  body { font-family: Arial, sans-serif; color: #000; margin: 0; font-size: 12px; }
  .sheet { border: 1.5px solid #000; }
  .hd { display: flex; align-items: stretch; border-bottom: 1.5px solid #000; }
  .hd .co { flex: 1; padding: 6px 10px; font-weight: bold; font-size: 15px; border-right: 1.5px solid #000; display:flex; align-items:center; }
  .hd .ti { width: 210px; padding: 6px 10px; font-weight: bold; font-size: 15px; display:flex; align-items:center; justify-content:center; }
  .meta { display: grid; grid-template-columns: 1fr 1fr 1fr; border-bottom: 1.5px solid #000; }
  .meta div { padding: 4px 10px; border-right: 1px solid #000; }
  .meta div:last-child { border-right: none; }
  .meta b { display:inline-block; min-width: 64px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #000; padding: 4px 6px; vertical-align: top; }
  th { background: #f0f0f0; font-size: 11px; text-align: center; }
  td.c { text-align: center; } td.num { text-align: right; }
  td:nth-child(2) { min-width: 260px; }
  tbody td { height: 22px; }
  .sign { display: grid; grid-template-columns: 1fr 1fr 1fr; border-top: 1.5px solid #000; }
  .sign > div { padding: 8px 10px; }
  .sign .l { border-right: 1.5px solid #000; }
  .sig-line { margin-top: 26px; border-top: 1px solid #000; padding-top: 2px; font-size: 11px; }
  .foot { display:flex; justify-content: space-between; padding: 4px 10px; border-top: 1.5px solid #000; font-size: 10px; color:#222; }
  .rowline { display:flex; gap:6px; margin: 6px 0; font-size: 11px; } .rowline .k { min-width: 78px; }
  button { padding: 8px 14px; font-size: 14px; margin: 10px; cursor: pointer; }
  @media print { .noprint { display: none; } }
</style></head>
<body>
<button class="noprint" onclick="window.print()">🖨 Print / Save as PDF</button>
<div class="sheet">
  <div class="hd"><div class="co">Edward and Christie (Pvt) Ltd</div><div class="ti">Material Requisition</div></div>
  <div class="meta">
    <div><b>Project:</b> ${esc(mrn.project_name || mrn.purpose || '')}</div>
    <div><b>Date:</b> ${esc(d(mrn.req_date))}</div>
    <div><b>MR No.:</b> ${esc(mrn.mrn_no)} ${srcTag ? '&nbsp; <b>' + srcTag + '</b>' : ''}</div>
    <div><b>Vehicle:</b> ${esc(mrn.asset_code || '')}</div>
    <div><b>Required Date:</b> ${esc(d(mrn.required_date))}</div>
    <div><b>Requested by:</b> ${esc(mrn.requested_by || '')}</div>
  </div>
  <table>
    <thead><tr>
      <th style="width:34px">Item No.</th><th>Description</th><th style="width:40px">Unit</th><th style="width:44px">Source</th>
      <th style="width:66px">Received Qty (Cumulative)</th><th style="width:56px">Available Qty</th>
      <th style="width:56px">Required Qty</th><th style="width:66px">Required Date</th>
    </tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>
  <div class="sign">
    ${sigBlock('Requested By', mrn.requested_by, mrn.req_date, 'Storekeeper', mrn.requested_sig, false)}
    ${sigBlock('Certified By', mrn.certified_by, mrn.certified_at, 'Workshop Engineer', mrn.certified_sig, false)}
    ${sigBlock('Approved By', mrn.approved_by, mrn.approved_at, 'Operational Manager', mrn.approved_sig, true)}
  </div>
  <div class="foot"><span>Doc. No.: EC1.ST.FO.01</span><span>Date of Issue: 2018.11.14</span></div>
</div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
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
  if (req.query.awaiting === '1') clauses.push('g.unit_price IS NULL');
  if (req.query.source && PURCHASE_SOURCES.includes(req.query.source)) { clauses.push('g.purchase_source_norm = ?'); params.push(req.query.source); }
  if (req.query.q && String(req.query.q).trim()) {
    const like = '%' + String(req.query.q).trim() + '%';
    clauses.push('(g.grn_no LIKE ? OR g.description LIKE ? OR g.supplier LIKE ? OR m.mrn_no LIKE ? OR a.code LIKE ?)');
    params.push(like, like, like, like, like);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(all(
    `SELECT g.*, m.mrn_no, m.req_date AS mrn_req_date, a.code AS asset_code FROM grn g
       LEFT JOIN mrn m ON m.id = g.mrn_id LEFT JOIN assets a ON a.id = m.asset_id
       ${where} ORDER BY g.id DESC LIMIT ${toInt(req.query.limit, 500)}`, ...params));
}));

// Count of GRN records still awaiting a price (for the badge / progress), split by source.
router.get('/grn/awaiting-count', asyncHandler((_req, res) =>
  res.json({
    awaiting: get('SELECT COUNT(*) c FROM grn WHERE unit_price IS NULL').c,
    total: get('SELECT COUNT(*) c FROM grn').c,
    by_source: all(`SELECT COALESCE(purchase_source_norm,'(unset)') source, COUNT(*) awaiting
                      FROM grn WHERE unit_price IS NULL GROUP BY 1 ORDER BY awaiting DESC`),
    awaiting_grn: get('SELECT COUNT(*) c FROM mrn_lines WHERE COALESCE(qty_received,0) < qty').c,
  })));

// Items requested but not yet received (awaiting a GRN), with the request date.
router.get('/awaiting-grn', asyncHandler((req, res) => {
  const clauses = ['COALESCE(ml.qty_received,0) < ml.qty', "COALESCE(m.approval_status,'') <> 'rejected'"];
  const params = [];
  if (req.query.source && PURCHASE_SOURCES.includes(req.query.source)) { clauses.push('COALESCE(ml.purchase_source, m.purchase_source) = ?'); params.push(req.query.source); }
  if (req.query.q && String(req.query.q).trim()) {
    const like = '%' + String(req.query.q).trim() + '%';
    clauses.push('(m.mrn_no LIKE ? OR ml.description LIKE ? OR a.code LIKE ?)');
    params.push(like, like, like);
  }
  res.json(all(
    `SELECT ml.id, ml.description, ml.qty, ml.qty_received, ml.category,
            m.id AS mrn_id, m.mrn_no, m.req_date, COALESCE(ml.purchase_source, m.purchase_source) AS purchase_source, a.code AS asset_code
       FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id LEFT JOIN assets a ON a.id = m.asset_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY m.req_date DESC, m.mrn_no LIMIT ${toInt(req.query.limit, 500)}`, ...params));
}));

// ---- Pending purchases (partial + not received), split by purchase source ----
// Source of a pending line = the source of any GRN it already has (partial receipts),
// else the MRN header's intended purchase_source, else unsourced (chosen on receipt).
function pendingRows(query) {
  const outer = [];
  const params = [];
  const src = query.source;
  if (src === 'unsourced') outer.push('source IS NULL');
  else if (src && PURCHASE_SOURCES.includes(src)) { outer.push('source = ?'); params.push(src); }
  if (query.status === 'partial') outer.push("status = 'partial'");
  else if (query.status === 'not_received') outer.push("status = 'not_received'");
  if (query.q && String(query.q).trim()) {
    const like = '%' + String(query.q).trim() + '%';
    outer.push('(mrn_no LIKE ? OR description LIKE ? OR asset_code LIKE ?)');
    params.push(like, like, like);
  }
  const where = outer.length ? 'WHERE ' + outer.join(' AND ') : '';
  return all(
    `SELECT * FROM (
       SELECT ml.id, m.id AS mrn_id, m.mrn_no, m.req_date, a.code AS asset_code, ml.description, ml.category,
              ml.qty AS ordered, COALESCE(ml.qty_received,0) AS received, (ml.qty - COALESCE(ml.qty_received,0)) AS pending,
              CASE WHEN COALESCE(ml.qty_received,0) > 0 THEN 'partial' ELSE 'not_received' END AS status,
              COALESCE((SELECT g.purchase_source_norm FROM grn g WHERE g.mrn_line_id = ml.id AND g.purchase_source_norm IS NOT NULL LIMIT 1), ml.purchase_source, m.purchase_source) AS source,
              (SELECT g.supplier FROM grn g WHERE g.mrn_line_id = ml.id AND g.supplier IS NOT NULL LIMIT 1) AS supplier,
              (SELECT MAX(g.delivery_date) FROM grn g WHERE g.mrn_line_id = ml.id) AS last_received
         FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id LEFT JOIN assets a ON a.id = m.asset_id
        WHERE COALESCE(ml.qty_received,0) < ml.qty AND COALESCE(m.approval_status,'') <> 'rejected'
     ) ${where} ORDER BY source, req_date DESC, mrn_no LIMIT ${toInt(query.limit, 2000)}`, ...params);
}

router.get('/pending', asyncHandler((req, res) => res.json(pendingRows(req.query))));

router.get('/pending/summary', asyncHandler((_req, res) => {
  res.json(all(
    `SELECT source, status, COUNT(*) count FROM (
       SELECT CASE WHEN COALESCE(ml.qty_received,0) > 0 THEN 'partial' ELSE 'not_received' END AS status,
              COALESCE((SELECT g.purchase_source_norm FROM grn g WHERE g.mrn_line_id = ml.id AND g.purchase_source_norm IS NOT NULL LIMIT 1), ml.purchase_source, m.purchase_source) AS source
         FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id
        WHERE COALESCE(ml.qty_received,0) < ml.qty AND COALESCE(m.approval_status,'') <> 'rejected'
     ) GROUP BY source, status`));
}));

// Set an MRN's intended purchase source (so not-received items can be planned/printed).
router.patch('/mrn/:id', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const mrn = get('SELECT * FROM mrn WHERE id = ?', id);
  if (!mrn) return res.status(404).json({ error: 'MRN not found' });
  if (req.body.purchase_source !== undefined) {
    const s = req.body.purchase_source || null;
    if (s && !PURCHASE_SOURCES.includes(s)) return res.status(400).json({ error: 'Invalid purchase_source' });
    run('UPDATE mrn SET purchase_source = ? WHERE id = ?', s, id);
    audit.record({ userId: req.user.id, entity: 'mrn', entityId: id, action: 'update', before: { purchase_source: mrn.purchase_source }, after: { purchase_source: s }, reason: 'set purchase source' });
  }
  res.json(get('SELECT * FROM mrn WHERE id = ?', id));
}));

// Set ONE MRN line's purchase source (mixed-source MRNs — per item).
router.patch('/mrn/line/:id', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const line = get('SELECT * FROM mrn_lines WHERE id = ?', id);
  if (!line) return res.status(404).json({ error: 'MRN line not found' });
  if (req.body.purchase_source !== undefined) {
    const s = req.body.purchase_source || null;
    if (s && !PURCHASE_SOURCES.includes(s)) return res.status(400).json({ error: 'Invalid purchase_source' });
    run('UPDATE mrn_lines SET purchase_source = ? WHERE id = ?', s, id);
  }
  res.json(get('SELECT * FROM mrn_lines WHERE id = ?', id));
}));

// Printable pending-purchases list, grouped by source.
router.get('/pending/print.html', asyncHandler((req, res) => {
  const rows = pendingRows({ ...req.query, limit: 5000 });
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const d = (v) => (v ? String(v).slice(0, 10) : '');
  const label = { head_office: 'Head Office', local_purchase: 'Local Purchase' };
  const groups = { head_office: [], local_purchase: [], unsourced: [] };
  for (const r of rows) (groups[r.source] || groups.unsourced).push(r);
  const section = (title, list) => !list.length ? '' : `
    <h2>${esc(title)} — ${list.length} item(s)</h2>
    <table><thead><tr><th>MRN</th><th>Req Date</th><th>Vehicle</th><th>Item</th><th class="num">Ordered</th><th class="num">Received</th><th class="num">Pending</th><th>Status</th><th>Supplier</th></tr></thead>
    <tbody>${list.map((r) => `<tr><td>${esc(r.mrn_no)}</td><td>${d(r.req_date)}</td><td>${esc(r.asset_code || '')}</td><td>${esc(r.description)}</td><td class="num">${r.ordered}</td><td class="num">${r.received}</td><td class="num"><b>${r.pending}</b></td><td>${r.status === 'partial' ? 'Partial' : 'Not received'}</td><td>${esc(r.supplier || '')}</td></tr>`).join('')}</tbody></table>`;
  const which = req.query.source && label[req.query.source] ? label[req.query.source] : 'All Sources';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Pending Purchases — ${esc(which)}</title>
<style>body{font-family:system-ui,Arial,sans-serif;margin:22px;color:#111}h1{font-size:19px;margin:0 0 2px}h2{font-size:14px;margin:18px 0 6px;border-bottom:2px solid #333;padding-bottom:3px}
.meta{color:#555;font-size:12px;margin-bottom:8px}table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px}th,td{border:1px solid #bbb;padding:4px 7px;text-align:left}th{background:#eee}td.num,th.num{text-align:right}
button{padding:8px 14px;font-size:14px;cursor:pointer;margin-bottom:10px}@media print{.noprint{display:none}}</style></head>
<body><button class="noprint" onclick="window.print()">Print / Save PDF</button>
<h1>Pending Purchases — ${esc(which)}</h1>
<div class="meta">Edward &amp; Christie · items requested but not fully received (partial + not received) · ${rows.length} item(s)</div>
${req.query.source ? section(which, groups[req.query.source] || []) : section('Head Office', groups.head_office) + section('Local Purchase', groups.local_purchase) + section('Not Sourced Yet', groups.unsourced)}
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

router.post('/grn', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['qty']);
  const source = b.purchase_source;
  if (source && !PURCHASE_SOURCES.includes(source)) {
    return res.status(400).json({ error: 'Invalid purchase_source' });
  }
  const result = tx(() => {
    const info = run(
      `INSERT INTO grn (grn_no, mrn_id, mrn_line_id, store_item_id, description, qty, unit_price, supplier, invoice_no, invoice_date, delivery_date, purchase_source, purchase_source_norm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.grn_no || null, toInt(b.mrn_id), toInt(b.mrn_line_id), toInt(b.store_item_id), b.description || null,
      toNum(b.qty, 0), b.unit_price === undefined || b.unit_price === '' ? null : toNum(b.unit_price),
      b.supplier || null, b.invoice_no || null, b.invoice_date || null, b.delivery_date || null, source || null, purchaseSourceNorm(source)
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
  if (req.body.purchase_source !== undefined && req.body.purchase_source && !PURCHASE_SOURCES.includes(req.body.purchase_source)) {
    return res.status(400).json({ error: 'Invalid purchase_source' });
  }
  const sets = [];
  const params = [];
  for (const c of ['unit_price', 'supplier', 'invoice_no', 'invoice_date', 'delivery_date', 'purchase_source']) {
    if (req.body[c] !== undefined) {
      sets.push(`${c} = ?`);
      params.push(c === 'unit_price' ? (req.body[c] === '' || req.body[c] === null ? null : toNum(req.body[c])) : req.body[c]);
    }
  }
  // Keep the normalised bucket in step when the source changes.
  if (req.body.purchase_source !== undefined) {
    sets.push('purchase_source_norm = ?');
    params.push(purchaseSourceNorm(req.body.purchase_source));
  }
  // Stamp when a price is first entered (procurement tracking).
  if (req.body.unit_price !== undefined && before.unit_price == null && req.body.unit_price !== '' && req.body.unit_price !== null && before.priced_at == null) {
    sets.push("priced_at = datetime('now')");
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
  if (req.query.q && String(req.query.q).trim()) {
    const like = '%' + String(req.query.q).trim() + '%';
    clauses.push('(a.code LIKE ? OR i.description LIKE ? OR i.issued_by LIKE ? OR i.category LIKE ?)');
    params.push(like, like, like, like);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(all(`SELECT i.*, a.code AS asset_code FROM issues i LEFT JOIN assets a ON a.id = i.asset_id ${where} ORDER BY i.id DESC LIMIT ${toInt(req.query.limit, 500)}`, ...params));
}));

router.post('/issues', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['description']);
  const { assetId, unresolved } = resolveAssetId(b);
  const info = run(
    `INSERT INTO issues (asset_id, job_id, store_item_id, description, qty, unit_price, issue_date, issued_by, category)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    assetId || null, toInt(b.job_id), toInt(b.store_item_id), b.description, toNum(b.qty, 1),
    b.unit_price === undefined || b.unit_price === '' ? null : toNum(b.unit_price),
    b.issue_date || new Date().toISOString().slice(0, 10), b.issued_by || null, b.category || null
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
