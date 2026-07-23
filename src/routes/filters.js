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

// ---- reference lists that drive the paper service form --------------------
router.get('/reference', asyncHandler((_req, res) => {
  res.json({
    oils: all('SELECT name, unit FROM oil_list ORDER BY sort_order, id'),
    filterCategories: all('SELECT name FROM filter_category_list ORDER BY sort_order, id').map((r) => r.name),
    oilTypes: all('SELECT code, unit_price FROM oil_type_prices ORDER BY code'),
    labourRate: 20, sundryRate: 5,
  });
}));

// ---- oil consumption → Lubricants (stock_ledger) issue --------------------
function currentBalance(pid) {
  const r = get('SELECT balance_after FROM stock_ledger WHERE product_id = ? ORDER BY id DESC LIMIT 1', pid);
  return r ? r.balance_after : 0;
}
// Best-effort: match a service oil (type first, then name) to a WorkshopOne oil
// product. Products here mostly key on name ("HD-68 Hy/Oil Caltex"), not code.
function resolveProduct(oilName, oilType) {
  const N = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cands = [oilType, oilName].filter(Boolean).map(N).filter((x) => x.length >= 3);
  const prods = all('SELECT id, code, name FROM products');
  for (const cand of cands) {
    for (const p of prods) {
      const pc = N(p.code), pn = N(p.name);
      if (pc && pc.length >= 3 && cand.includes(pc)) return p.id;         // candidate contains the product code
      if (pn && pn.length >= 3 && (pn.includes(cand) || cand.includes(pn))) return p.id; // name ⊇ candidate (or vice-versa)
    }
  }
  return null;
}
// Post an oil issue tied to the service. Returns true if a product resolved.
function postOilIssue(oilName, oilType, liters, unitPrice, assetId, date, serviceId) {
  const pid = resolveProduct(oilName, oilType);
  if (!pid || !(liters > 0)) return false;
  const prev = currentBalance(pid);
  // consumer_type='service' marks this as a stock-only movement: the COST is owned
  // by the service record, so every oil-cost report excludes these to avoid double-counting.
  run(`INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, asset_id, consumer, consumer_type, job_id, txn_date, note)
       VALUES (?, 'issue', ?, ?, ?, ?, 'Service', 'service', NULL, ?, ?)`,
    pid, -Math.abs(liters), prev - Math.abs(liters), unitPrice || null, assetId || null,
    date, 'Service record #' + serviceId + (oilName ? ' · ' + oilName : ''));
  return true;
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
  const date = clean(b.service_date) || new Date().toISOString().slice(0, 10);
  const filters = (Array.isArray(b.filters) ? b.filters : []).filter((f) => clean(f.filter_no));
  const oils = (Array.isArray(b.oils) ? b.oils : []).filter((o) => clean(o.oil_name) && (toNum(o.qty, 0) > 0 || toNum(o.price, 0) > 0));
  const parts = (Array.isArray(b.parts) ? b.parts : []).filter((p) => clean(p.description));
  const labourRate = toNum(b.labour_rate, 20);
  const sundryRate = toNum(b.sundry_rate, 5);
  // Parts subtotal = filter lines (unit × qty) + oil lines (line total) + other costs.
  const filterSub = filters.reduce((s, f) => s + toNum(f.price, 0) * toNum(f.qty, 1), 0);
  const oilSub = oils.reduce((s, o) => s + toNum(o.price, 0), 0);
  const partSub = parts.reduce((s, p) => s + (toNum(p.amount, 0) || toNum(p.rate, 0) * toNum(p.qty, 0)), 0);
  const partsSubtotal = Math.round((filterSub + oilSub + partSub) * 100) / 100;
  const labourCharge = Math.round(partsSubtotal * labourRate) / 100;
  const sundryAmount = Math.round(partsSubtotal * sundryRate) / 100;
  const grandTotal = Math.round((partsSubtotal + labourCharge + sundryAmount) * 100) / 100;

  const out = tx(() => {
    const info = run(
      `INSERT INTO service_jobs (vehicle_label, asset_id, service_date, job_no, reg_id, model_no, meter_reading, next_service_meter,
                                 service_type, site_location, repair_details, upkeeping, labour_rate, sundry_rate,
                                 parts_subtotal, labour_charge, sundry_amount, grand_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      vehicleLabel, assetId || null, date, clean(b.job_no), clean(b.reg_id), clean(b.model_no),
      clean(b.meter_reading), clean(b.next_service_meter), clean(b.service_type), clean(b.site_location),
      clean(b.repair_details), clean(b.upkeeping), labourRate, sundryRate,
      partsSubtotal, labourCharge, sundryAmount, grandTotal
    );
    const sid = info.lastInsertRowid;
    let oilIssues = 0;
    for (const f of filters) {
      const fn = clean(f.filter_no);
      const price = f.price === '' || f.price == null ? null : toNum(f.price);
      run(`INSERT INTO service_filters (service_id, filter_no, filter_no_norm, category, action_type, qty, price)
           VALUES (?, ?, ?, ?, ?, ?, ?)`, sid, fn, normF(fn), clean(f.category), clean(f.xe) || clean(f.action_type), toNum(f.qty, 1), price || 0);
      bookTouch(fn, f.category, price, by); // auto-save number (+ price) to the book
    }
    for (const o of oils) {
      const on = clean(o.oil_name);
      const liters = toNum(o.qty, 0);
      run(`INSERT INTO service_oils (service_id, oil_name, oil_type, action_type, qty, price)
           VALUES (?, ?, ?, ?, ?, ?)`, sid, on, clean(o.oil_type), clean(o.cv) || clean(o.action_type), liters, toNum(o.price, 0));
      // Issue the lubricant against this service (reduces oil stock, traceable to the service id).
      const unit = liters > 0 ? toNum(o.price, 0) / liters : null;
      if (postOilIssue(on, clean(o.oil_type), liters, unit, assetId, date, sid)) oilIssues++;
    }
    for (const p of parts) {
      const amount = toNum(p.amount, 0) || toNum(p.rate, 0) * toNum(p.qty, 0);
      run(`INSERT INTO service_parts (service_id, description, unit, rate, qty, amount) VALUES (?, ?, ?, ?, ?, ?)`,
        sid, clean(p.description), clean(p.unit), toNum(p.rate, 0), toNum(p.qty, 0), Math.round(amount * 100) / 100);
    }
    return { sid, oilIssues };
  });
  audit.record({ userId: req.user && req.user.id, entity: 'service_job', entityId: out.sid, action: 'create', after: { asset_id: assetId, grand_total: grandTotal } });
  res.status(201).json({ service: get('SELECT * FROM service_jobs WHERE id = ?', out.sid), oil_issues: out.oilIssues });
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
  const parts = all('SELECT id, description, unit, rate, qty, amount FROM service_parts WHERE service_id = ? ORDER BY id', id);
  res.json({ service: job, filters, oils, parts });
}));

// Printable service form — matches the paper "Vehicle/Machinery Service Details".
router.get('/services/:id/print.html', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const s = get(`SELECT s.*, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec FROM service_jobs s LEFT JOIN assets a ON a.id = s.asset_id WHERE s.id = ?`, id);
  if (!s) return res.status(404).send('Service not found');
  const oils = all('SELECT oil_name, oil_type, action_type, qty, price FROM service_oils WHERE service_id = ? ORDER BY id', id);
  const filters = all(`SELECT f.category, f.filter_no, f.qty, f.action_type, p.unit_price book FROM service_filters f LEFT JOIN filter_prices p ON p.filter_no_norm=f.filter_no_norm WHERE f.service_id=? ORDER BY f.id`, id);
  const parts = all('SELECT description, unit, rate, qty, amount FROM service_parts WHERE service_id = ? ORDER BY id', id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const d = (v) => (v ? String(v).slice(0, 10) : '');
  const m = (n) => 'Rs ' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const veh = [s.asset_reg || s.reg_id, (s.asset_ec && s.asset_ec !== s.asset_reg) ? s.asset_ec : ''].filter(Boolean).join(' · ') || s.vehicle_label || s.asset_code || '';
  const oilRows = oils.map((o) => `<tr><td>${esc(o.oil_name)}</td><td>${esc(o.oil_type || '')}</td><td class="c">${esc(o.action_type || '')}</td><td class="num">${o.qty || ''}</td><td class="num">${o.price ? m(o.price) : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="c" style="color:#666">No oils recorded</td></tr>';
  const filRows = filters.map((f) => `<tr><td>${esc(f.category || '')}</td><td>${esc(f.filter_no || '')}</td><td class="num">${f.qty || ''}</td><td class="c">${esc(f.action_type || '')}</td><td class="num">${f.book ? m(f.book) : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="c" style="color:#666">No filters recorded</td></tr>';
  const partRows = parts.map((p, i) => `<tr><td class="c">${i + 1}</td><td>${esc(p.description || '')}</td><td>${esc(p.unit || '')}</td><td class="num">${p.rate ? m(p.rate) : ''}</td><td class="num">${p.qty || ''}</td><td class="num">${m(p.amount)}</td></tr>`).join('');
  const grand = s.grand_total || 0;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Service ${esc(d(s.service_date))} — ${esc(veh)}</title>
<style>
  @page { size: A4 portrait; margin: 10mm; } body { font-family: Arial, sans-serif; color:#000; font-size:11px; margin:0; }
  .sheet { border:1.5px solid #000; }
  .hd { text-align:center; font-weight:bold; padding:6px; border-bottom:1.5px solid #000; } .hd .co { font-size:15px; } .hd .ti { font-size:13px; }
  .meta { display:grid; grid-template-columns:1fr 1fr; } .meta div { padding:3px 8px; border-bottom:1px solid #000; } .meta b { display:inline-block; min-width:96px; }
  .meta div:nth-child(odd){ border-right:1px solid #000; }
  .cols { display:grid; grid-template-columns:1fr 1fr; } .cols > div:first-child { border-right:1.5px solid #000; }
  table { width:100%; border-collapse:collapse; } th,td { border:1px solid #000; padding:2px 5px; } th { background:#eee; font-size:10px; }
  td.c { text-align:center; } td.num { text-align:right; }
  .tot { display:flex; justify-content:flex-end; } .tot table { width:auto; } .tot td { border:none; padding:2px 10px; } .tot .g td { border-top:1.5px solid #000; font-weight:bold; }
  .foot { padding:5px 8px; border-top:1.5px solid #000; } .rd { min-height:48px; }
  button { padding:8px 14px; font-size:14px; margin:10px 0; cursor:pointer; } @media print { .noprint { display:none; } }
</style></head><body>
<button class="noprint" onclick="window.print()">🖨 Print / Save as PDF</button>
<div class="sheet">
  <div class="hd"><div class="co">Edward and Christie (Pvt) Ltd</div><div class="ti">Vehicle / Machinery Service Details</div></div>
  <div class="meta">
    <div><b>Date:</b> ${esc(d(s.service_date))}</div><div><b>Job/Service No.:</b> ${esc(s.job_no || '')}</div>
    <div><b>Reg. ID:</b> ${esc(s.asset_reg || s.reg_id || '')}</div><div><b>Meter Reading:</b> ${esc(s.meter_reading || '')}</div>
    <div><b>E&amp;C Code:</b> ${esc(s.asset_ec || '')}</div><div><b>Next Service at:</b> ${esc(s.next_service_meter || '')}</div>
    <div><b>Model:</b> ${esc(s.model_no || '')}</div><div><b>Service Type:</b> ${esc(s.service_type || '')}</div>
    <div><b>Vehicle:</b> ${esc(veh)}</div><div><b>Location (Site):</b> ${esc(s.site_location || '')}</div>
  </div>
  <div class="cols">
    <div><table><thead><tr><th>Oil Name</th><th>Type</th><th>C/V</th><th>Liters</th><th>Price</th></tr></thead><tbody>${oilRows}</tbody></table></div>
    <div><table><thead><tr><th>Filter</th><th>Filter No.</th><th>Qty</th><th>X/E</th><th>Price</th></tr></thead><tbody>${filRows}</tbody></table></div>
  </div>
  ${partRows ? `<table><thead><tr><th>No.</th><th>Description (Other Costs)</th><th>Unit</th><th>Rate</th><th>Qty</th><th>Amount</th></tr></thead><tbody>${partRows}</tbody></table>` : ''}
  <div class="tot"><table>
    <tr><td>Parts Subtotal</td><td class="num">${m(s.parts_subtotal)}</td></tr>
    <tr><td>Labour Charge (${s.labour_rate || 20}%)</td><td class="num">${m(s.labour_charge)}</td></tr>
    <tr><td>Sundry (${s.sundry_rate || 5}%)</td><td class="num">${m(s.sundry_amount)}</td></tr>
    <tr class="g"><td>Grand Total</td><td class="num">${m(grand)}</td></tr>
  </table></div>
  <div class="foot"><b>Up-keeping of Equipment/Vehicle:</b> ${esc(s.upkeeping || '')} &nbsp;&nbsp; (Good - G / Fair - F / Bad - B)
    <div style="margin-top:4px"><b>Vehicle/Machinery Repair Details:</b></div><div class="rd">${esc(s.repair_details || '')}</div></div>
</div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

module.exports = router;
