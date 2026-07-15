'use strict';

const express = require('express');
const { get, all } = require('../db');
const { asyncHandler, toInt } = require('../lib/http');
const costing = require('../lib/costing');
const { sendXlsx } = require('../lib/export');

const router = express.Router();

function currentBalance(productId) {
  const r = get('SELECT balance_after FROM stock_ledger WHERE product_id = ? ORDER BY id DESC LIMIT 1', productId);
  return r ? r.balance_after : 0;
}

// ---- dashboard ------------------------------------------------------------
router.get('/dashboard', asyncHandler((_req, res) => {
  const jobs_by_status = all(`SELECT status, COUNT(*) count FROM job_cards GROUP BY status`);

  const awaiting = all(
    `SELECT j.id, j.job_no, a.code AS asset_code FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id
      WHERE j.status = 'WORK_COMPLETE' ORDER BY j.id DESC`
  ).map((j) => ({ ...j, missing_count: costing.closureReadiness(j.id).missing.length }));

  const products = all('SELECT * FROM products');
  const low_stock_oil = products
    .map((p) => ({ id: p.id, name: p.name, unit: p.unit, balance: currentBalance(p.id), reorder_level: p.reorder_level }))
    .filter((p) => p.reorder_level > 0 && p.balance <= p.reorder_level);

  const today = new Date().toISOString().slice(0, 10);
  const in60 = new Date(Date.now() + 60 * 86400 * 1000).toISOString().slice(0, 10);
  const batteries_warranty = all(
    `SELECT b.serial_no, b.warranty_date, a.code AS asset_code FROM batteries b LEFT JOIN assets a ON a.id=b.current_asset_id
      WHERE b.warranty_date IS NOT NULL AND b.warranty_date >= ? AND b.warranty_date <= ? AND b.state <> 'decommissioned'
      ORDER BY b.warranty_date`, today, in60
  );

  const month_cost_by_project = all(
    `SELECT COALESCE(p.name, '(unassigned)') project, COALESCE(SUM(j.total_cost),0) total
       FROM job_cards j LEFT JOIN projects p ON p.id = j.project_id
      WHERE strftime('%Y-%m', j.requested_at) = strftime('%Y-%m','now')
      GROUP BY j.project_id ORDER BY total DESC`
  );

  const open_jobs_count = get(`SELECT COUNT(*) c FROM job_cards WHERE status NOT IN ('CLOSED','REJECTED')`).c;
  const closed_this_month_count = get(
    `SELECT COUNT(*) c FROM job_cards WHERE status='CLOSED' AND strftime('%Y-%m', closed_at) = strftime('%Y-%m','now')`
  ).c;

  res.json({
    jobs_by_status, awaiting_price: awaiting, low_stock_oil, batteries_warranty,
    month_cost_by_project, open_jobs_count, closed_this_month_count,
  });
}));

// ---- cost reports ---------------------------------------------------------
const COST_COLS = [
  { header: 'Labour', key: 'labour' }, { header: 'Material', key: 'material' },
  { header: 'Oil', key: 'oil' }, { header: 'General', key: 'general' },
  { header: 'External', key: 'external' }, { header: 'Total', key: 'total' },
];

router.get('/cost/by-asset', asyncHandler(async (req, res) => {
  const rows = all(
    `SELECT j.asset_id, a.code AS asset_code,
            COALESCE(SUM(j.labour_cost),0) labour, COALESCE(SUM(j.material_cost),0) material,
            COALESCE(SUM(j.oil_cost),0) oil, COALESCE(SUM(j.general_cost),0) general,
            COALESCE(SUM(j.external_cost),0) external, COALESCE(SUM(j.total_cost),0) total,
            COUNT(*) job_count
       FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id
      GROUP BY j.asset_id ORDER BY total DESC`
  );
  if (req.query.format === 'xlsx') {
    return sendXlsx(res, 'cost-by-asset.xlsx', [{ name: 'By Asset', columns: [{ header: 'Asset', key: 'asset_code' }, ...COST_COLS, { header: 'Jobs', key: 'job_count' }], rows }]);
  }
  res.json(rows);
}));

router.get('/cost/by-project', asyncHandler(async (req, res) => {
  const rows = all(
    `SELECT j.project_id, COALESCE(p.name,'(unassigned)') project,
            COALESCE(SUM(j.labour_cost),0) labour, COALESCE(SUM(j.material_cost),0) material,
            COALESCE(SUM(j.oil_cost),0) oil, COALESCE(SUM(j.general_cost),0) general,
            COALESCE(SUM(j.external_cost),0) external, COALESCE(SUM(j.total_cost),0) total
       FROM job_cards j LEFT JOIN projects p ON p.id = j.project_id
      GROUP BY j.project_id ORDER BY total DESC`
  );
  if (req.query.format === 'xlsx') {
    return sendXlsx(res, 'cost-by-project.xlsx', [{ name: 'By Project', columns: [{ header: 'Project', key: 'project' }, ...COST_COLS], rows }]);
  }
  res.json(rows);
}));

router.get('/cost/by-source', asyncHandler(async (req, res) => {
  const rows = all(
    `SELECT COALESCE(purchase_source,'(unspecified)') purchase_source, COALESCE(SUM(qty*unit_price),0) total, COUNT(*) lines
       FROM grn WHERE unit_price IS NOT NULL GROUP BY purchase_source ORDER BY total DESC`
  );
  if (req.query.format === 'xlsx') {
    return sendXlsx(res, 'cost-by-source.xlsx', [{ name: 'By Source', columns: [{ header: 'Purchase Source', key: 'purchase_source' }, { header: 'Total', key: 'total' }, { header: 'Lines', key: 'lines' }], rows }]);
  }
  res.json(rows);
}));

// ---- variance -------------------------------------------------------------
router.get('/variance', asyncHandler((req, res) => {
  const threshold = req.query.threshold ? Number(req.query.threshold) : 0.001;
  res.json(all(
    `SELECT sc.id, pr.name AS product, sc.period, sc.book_qty, sc.counted_qty, sc.variance
       FROM stock_counts sc JOIN products pr ON pr.id = sc.product_id
      WHERE ABS(sc.variance) > ? ORDER BY ABS(sc.variance) DESC`, threshold
  ));
}));

// ---- auto-generated job cost sheet ---------------------------------------
function costSheet(id) {
  const job = get(
    `SELECT j.*, a.code AS asset_code, p.name AS project_name FROM job_cards j
       LEFT JOIN assets a ON a.id = j.asset_id LEFT JOIN projects p ON p.id = j.project_id WHERE j.id = ?`, id
  );
  if (!job) return null;
  const cost = costing.computeJobCost(id);
  const parts = all(`SELECT * FROM job_parts WHERE job_id = ? AND source_type IN ('grn','issue') AND is_external_repair = 0`, id);
  const oil = all(`SELECT sl.*, pr.name product_name, pr.unit FROM stock_ledger sl JOIN products pr ON pr.id=sl.product_id WHERE sl.job_id = ? AND sl.kind='issue'`, id);
  const general = all(`SELECT g.*, si.name item_name FROM general_item_txns g JOIN store_items si ON si.id=g.store_item_id WHERE g.job_id = ? AND g.txn_type='issue'`, id);
  const external = [
    ...all(`SELECT work_date, description, external_value FROM job_daily_work WHERE job_id = ? AND is_external = 1`, id).map((w) => ({ description: w.description, value: w.external_value })),
    ...all(`SELECT description, qty, unit_price FROM job_parts WHERE job_id = ? AND is_external_repair = 1`, id).map((p) => ({ description: p.description, value: (p.qty || 0) * (p.unit_price || 0) })),
  ];
  return { job, asset_code: job.asset_code, labour_lines: cost.labourLines, part_lines: parts, oil_lines: oil, general_lines: general, external_lines: external, totals: cost };
}

router.get('/job/:id/costsheet', asyncHandler((req, res) => {
  const sheet = costSheet(toInt(req.params.id));
  if (!sheet) return res.status(404).json({ error: 'Job not found' });
  res.json(sheet);
}));

router.get('/job/:id/costsheet.html', asyncHandler((req, res) => {
  const s = costSheet(toInt(req.params.id));
  if (!s) return res.status(404).send('Job not found');
  const money = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const t = s.totals;
  const rows = (arr, cells) => arr.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="9" class="muted">— none —</td></tr>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Job Cost Sheet ${esc(s.job.job_no)}</title>
<style>
  body{font-family:system-ui,Arial,sans-serif;margin:24px;color:#1a1a1a}
  h1{font-size:20px;margin:0 0 4px} h2{font-size:14px;margin:18px 0 6px;border-bottom:2px solid #333;padding-bottom:3px}
  .meta{color:#555;font-size:13px;margin-bottom:8px} .meta b{color:#111}
  table{width:100%;border-collapse:collapse;font-size:13px} th,td{border:1px solid #ccc;padding:5px 8px;text-align:left}
  th{background:#f0f0f0} td.num,th.num{text-align:right} .muted{color:#999;text-align:center}
  .grand{margin-top:16px;font-size:15px} .grand table{width:auto;margin-left:auto} .grand td{border:none;padding:3px 10px}
  .grand .tot{font-weight:bold;font-size:18px;border-top:2px solid #333}
  @media print{.noprint{display:none}}
  button{padding:8px 14px;font-size:14px;cursor:pointer;margin-bottom:12px}
</style></head><body>
<button class="noprint" onclick="window.print()">Print / Save PDF</button>
<h1>Job Cost Sheet — ${esc(s.job.job_no)}</h1>
<div class="meta">
  <b>Asset:</b> ${esc(s.asset_code || '—')} &nbsp; <b>Project:</b> ${esc(s.job.project_name || '—')} &nbsp;
  <b>Type:</b> ${esc(s.job.type)} &nbsp; <b>Status:</b> ${esc(s.job.status)}<br>
  <b>Description:</b> ${esc(s.job.description || '')}
</div>
<h2>Labour</h2>
<table><thead><tr><th>Date</th><th>Mechanic</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
<tbody>${rows(s.labour_lines, (r) => [esc(r.work_date || ''), esc(r.mechanic || ''), `<div class="num">${r.hours}</div>`, `<div class="num">${money(r.rate)}</div>`, `<div class="num">${money(r.amount)}</div>`])}</tbody></table>
<h2>Material (Spare Parts)</h2>
<table><thead><tr><th>Description</th><th>Source</th><th class="num">Qty</th><th class="num">Unit Price</th><th class="num">Amount</th></tr></thead>
<tbody>${rows(s.part_lines, (r) => [esc(r.description || ''), esc(r.source_type), `<div class="num">${r.qty}</div>`, `<div class="num">${money(r.unit_price)}</div>`, `<div class="num">${money((r.qty || 0) * (r.unit_price || 0))}</div>`])}</tbody></table>
<h2>Oil &amp; Lubricant</h2>
<table><thead><tr><th>Product</th><th class="num">Qty</th><th>Unit</th><th class="num">Unit Price</th><th class="num">Amount</th></tr></thead>
<tbody>${rows(s.oil_lines, (r) => [esc(r.product_name), `<div class="num">${Math.abs(r.qty)}</div>`, esc(r.unit), `<div class="num">${money(r.unit_price)}</div>`, `<div class="num">${money(Math.abs(r.qty) * (r.unit_price || 0))}</div>`])}</tbody></table>
<h2>General Items</h2>
<table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit Price</th><th class="num">Amount</th></tr></thead>
<tbody>${rows(s.general_lines, (r) => [esc(r.item_name), `<div class="num">${Math.abs(r.qty)}</div>`, `<div class="num">${money(r.unit_price)}</div>`, `<div class="num">${money(Math.abs(r.qty) * (r.unit_price || 0))}</div>`])}</tbody></table>
<h2>External Repairs</h2>
<table><thead><tr><th>Description</th><th class="num">Value</th></tr></thead>
<tbody>${rows(s.external_lines, (r) => [esc(r.description || ''), `<div class="num">${money(r.value)}</div>`])}</tbody></table>
<div class="grand"><table>
  <tr><td>Labour</td><td class="num">${money(t.labour_cost)}</td></tr>
  <tr><td>Material</td><td class="num">${money(t.material_cost)}</td></tr>
  <tr><td>Oil</td><td class="num">${money(t.oil_cost)}</td></tr>
  <tr><td>General</td><td class="num">${money(t.general_cost)}</td></tr>
  <tr><td>External</td><td class="num">${money(t.external_cost)}</td></tr>
  <tr class="tot"><td>TOTAL</td><td class="num">${money(t.total_cost)}</td></tr>
</table></div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

module.exports = router;
