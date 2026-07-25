'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireAuth } = require('../lib/auth');
const { asyncHandler, toInt, toNum } = require('../lib/http');
const config = require('../config');
const costing = require('../lib/costing');
const intelligence = require('../lib/intelligence');
const { sendXlsx } = require('../lib/export');
const monthlyReport = require('../lib/monthly_cost_report');

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
    needs_attention: intelligence.needsAttentionSummary(),
  });
}));

// ---- advisory intelligence (Phase 5 §1/§4) — read-only, flags only --------
router.get('/service-due', asyncHandler((_req, res) => res.json(intelligence.serviceDue())));

router.get('/anomalies', asyncHandler((_req, res) => res.json({
  unusual_consumption: intelligence.unusualConsumption(),
  duplicate_mrn: intelligence.duplicateMrn(),
  grn_price_spikes: intelligence.grnPriceSpikes(),
  thresholds: {
    consumption_factor: config.anomalyConsumptionFactor,
    price_spike_factor: config.anomalyPriceSpikeFactor,
    note: 'Thresholds are business calls — set ANOMALY_CONSUMPTION_FACTOR / ANOMALY_PRICE_SPIKE_FACTOR in .env',
  },
})));

router.get('/integrity', asyncHandler((_req, res) => res.json(intelligence.integrityCheck())));

// ---- cost reports ---------------------------------------------------------
const COST_COLS = [
  { header: 'Labour', key: 'labour' }, { header: 'Material', key: 'material' },
  { header: 'Oil', key: 'oil' }, { header: 'General', key: 'general' },
  { header: 'External', key: 'external' }, { header: 'Other/Recorded', key: 'other' },
  { header: 'Total', key: 'total' },
];

router.get('/cost/by-asset', asyncHandler(async (req, res) => {
  const rows = all(
    `SELECT j.asset_id, a.code AS asset_code,
            COALESCE(SUM(j.labour_cost),0) labour, COALESCE(SUM(j.material_cost),0) material,
            COALESCE(SUM(j.oil_cost),0) oil, COALESCE(SUM(j.general_cost),0) general,
            COALESCE(SUM(j.external_cost),0) external, COALESCE(SUM(j.other_cost),0) other,
            COALESCE(SUM(j.total_cost),0) total,
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
            COALESCE(SUM(j.external_cost),0) external, COALESCE(SUM(j.other_cost),0) other,
            COALESCE(SUM(j.total_cost),0) total
       FROM job_cards j LEFT JOIN projects p ON p.id = j.project_id
      GROUP BY j.project_id ORDER BY total DESC`
  );
  if (req.query.format === 'xlsx') {
    return sendXlsx(res, 'cost-by-project.xlsx', [{ name: 'By Project', columns: [{ header: 'Project', key: 'project' }, ...COST_COLS], rows }]);
  }
  res.json(rows);
}));

router.get('/cost/by-site', asyncHandler(async (req, res) => {
  const rows = all(
    `SELECT COALESCE(NULLIF(TRIM(site),''),'(no site)') site,
            COALESCE(SUM(j.labour_cost),0) labour, COALESCE(SUM(j.material_cost),0) material,
            COALESCE(SUM(j.oil_cost),0) oil, COALESCE(SUM(j.general_cost),0) general,
            COALESCE(SUM(j.external_cost),0) external, COALESCE(SUM(j.other_cost),0) other,
            COALESCE(SUM(j.total_cost),0) total, COUNT(*) jobs
       FROM job_cards j GROUP BY 1 ORDER BY total DESC`
  );
  if (req.query.format === 'xlsx') {
    return sendXlsx(res, 'cost-by-site.xlsx', [{ name: 'By Site', columns: [{ header: 'Site', key: 'site' }, ...COST_COLS, { header: 'Jobs', key: 'jobs' }], rows }]);
  }
  res.json(rows);
}));

router.get('/cost/by-source', asyncHandler(async (req, res) => {
  const rows = all(
    `SELECT CASE
              WHEN purchase_source_norm IN ('head_office','direct_purchase','mixed') THEN 'Head Office'
              WHEN purchase_source_norm IN ('local_purchase','local_store') THEN 'Local Purchase'
              ELSE '(unspecified)'
            END purchase_source,
            COALESCE(SUM(qty*unit_price),0) total, COUNT(*) lines
       FROM grn WHERE unit_price IS NOT NULL
      GROUP BY 1 ORDER BY total DESC`
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
  const cost = costing.reconciledCost(id);
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
  ${t.other_cost ? `<tr><td>Other / Recorded</td><td class="num">${money(t.other_cost)}</td></tr>` : ''}
  <tr class="tot"><td>TOTAL</td><td class="num">${money(t.total_cost)}</td></tr>
</table></div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

// ---- monthly cost analytics (transaction-dated; drill-down) ----------------
// Total = Labour + Head Office + Local Purchase + Oil, all attributed to the month
// the work was done / the goods were received / the oil was issued.
const MONTH_RE = /^\d{4}-\d{2}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const OIL_VAL = 'ABS(sl.qty) * COALESCE(sl.unit_price, pr.unit_price, 0)';
// Oil issued for a service is costed inside the service (Service column), so its
// stock-ledger issue is stock-only — excluded from every oil COST aggregation.
const OIL_NOT_SERVICE = "COALESCE(sl.consumer_type,'') <> 'service'";

router.get('/monthly', asyncHandler((_req, res) => {
  const map = new Map();
  const M = (m) => { if (!map.has(m)) map.set(m, { month: m, labour: 0, head_office: 0, local_purchase: 0, oil: 0, jobs: 0, service: 0 }); return map.get(m); };
  for (const r of all(`SELECT substr(work_date,1,7) m, ROUND(SUM(amount),2) v FROM job_labour WHERE work_date IS NOT NULL GROUP BY m`)) if (r.m) M(r.m).labour = r.v || 0;
  for (const r of all(`SELECT substr(delivery_date,1,7) m, purchase_source_norm src, ROUND(SUM(qty*unit_price),2) v
                         FROM grn WHERE unit_price IS NOT NULL AND delivery_date IS NOT NULL GROUP BY m, src`)) {
    if (!r.m) continue; const o = M(r.m);
    if (r.src === 'head_office') o.head_office += r.v || 0; else if (r.src === 'local_purchase') o.local_purchase += r.v || 0;
  }
  for (const r of all(`SELECT substr(sl.txn_date,1,7) m, ROUND(SUM(${OIL_VAL}),2) v FROM stock_ledger sl
                         JOIN products pr ON pr.id = sl.product_id
                        WHERE sl.kind='issue' AND sl.txn_date IS NOT NULL AND ${OIL_NOT_SERVICE} GROUP BY m`)) if (r.m) M(r.m).oil = r.v || 0;
  for (const r of all(`SELECT substr(requested_at,1,7) m, COUNT(*) c FROM job_cards WHERE requested_at IS NOT NULL GROUP BY m`)) if (r.m) M(r.m).jobs = r.c || 0;
  // Service records — cost computed live: priced filters (book × qty) + oils + labour + sundry, by service month.
  for (const r of all(`SELECT substr(j.service_date,1,7) m, ROUND(SUM(COALESCE(p.unit_price,0) * COALESCE(f.qty,1)),2) v
                         FROM service_filters f JOIN service_jobs j ON j.id = f.service_id
                         LEFT JOIN filter_prices p ON p.filter_no_norm = f.filter_no_norm
                        WHERE j.service_date IS NOT NULL GROUP BY m`)) if (r.m) M(r.m).service += (r.v || 0);
  for (const r of all(`SELECT substr(j.service_date,1,7) m, ROUND(SUM(COALESCE(o.price,0)),2) v
                         FROM service_oils o JOIN service_jobs j ON j.id = o.service_id
                        WHERE j.service_date IS NOT NULL GROUP BY m`)) if (r.m) M(r.m).service += (r.v || 0);
  for (const r of all(`SELECT substr(service_date,1,7) m, ROUND(SUM(COALESCE(labour_charge,0)) + SUM(COALESCE(sundry_amount,0)),2) v
                         FROM service_jobs WHERE service_date IS NOT NULL GROUP BY m`)) if (r.m) M(r.m).service += (r.v || 0);
  const tm = new Date().toISOString().slice(0, 7);
  const months = [...map.values()]
    .map((o) => ({ ...o, service: r2(o.service), total: r2(o.labour + o.head_office + o.local_purchase + o.oil + o.service) }))
    .filter((o) => o.month <= tm) // drop spurious future-dated (data-error) months
    .sort((a, b) => b.month.localeCompare(a.month));
  res.json({ this_month: months.find((x) => x.month === tm) || { month: tm, labour: 0, head_office: 0, local_purchase: 0, oil: 0, jobs: 0, service: 0, total: 0 }, months });
}));

router.get('/monthly/:month/assets', asyncHandler((req, res) => {
  const month = String(req.params.month);
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const map = new Map();
  const A = (id) => { if (!map.has(id)) map.set(id, { asset_id: id, labour: 0, material: 0, oil: 0 }); return map.get(id); };
  for (const r of all(`SELECT j.asset_id id, ROUND(SUM(jl.amount),2) v FROM job_labour jl JOIN job_cards j ON j.id=jl.job_id
                        WHERE j.asset_id IS NOT NULL AND substr(jl.work_date,1,7)=? GROUP BY j.asset_id`, month)) A(r.id).labour = r.v || 0;
  for (const r of all(`SELECT m.asset_id id, ROUND(SUM(g.qty*g.unit_price),2) v FROM grn g JOIN mrn m ON m.id=g.mrn_id
                        WHERE m.asset_id IS NOT NULL AND g.unit_price IS NOT NULL AND substr(g.delivery_date,1,7)=? GROUP BY m.asset_id`, month)) A(r.id).material = r.v || 0;
  for (const r of all(`SELECT sl.asset_id id, ROUND(SUM(${OIL_VAL}),2) v FROM stock_ledger sl JOIN products pr ON pr.id=sl.product_id
                        WHERE sl.asset_id IS NOT NULL AND sl.kind='issue' AND ${OIL_NOT_SERVICE} AND substr(sl.txn_date,1,7)=? GROUP BY sl.asset_id`, month)) A(r.id).oil = r.v || 0;
  const assets = [...map.values()].map((o) => {
    const a = get('SELECT code FROM assets WHERE id=?', o.asset_id);
    return { ...o, asset_code: a ? a.code : '(unlinked)', total: r2(o.labour + o.material + o.oil) };
  }).sort((a, b) => b.total - a.total);
  res.json({ month, assets });
}));

router.get('/monthly/:month/asset/:id', asyncHandler((req, res) => {
  const month = String(req.params.month); const id = toInt(req.params.id);
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const asset = get('SELECT code, registration, ec_code FROM assets WHERE id=?', id);
  const labour_lines = all(`SELECT jl.work_date, jl.mechanic, jl.hours, jl.rate, jl.amount, j.job_no
                              FROM job_labour jl JOIN job_cards j ON j.id=jl.job_id
                             WHERE j.asset_id=? AND substr(jl.work_date,1,7)=? ORDER BY jl.work_date, jl.id`, id, month);
  const material_lines = all(`SELECT g.delivery_date, g.description, g.qty, g.unit_price, g.supplier, g.purchase_source_norm source, m.mrn_no
                                FROM grn g JOIN mrn m ON m.id=g.mrn_id
                               WHERE m.asset_id=? AND g.unit_price IS NOT NULL AND substr(g.delivery_date,1,7)=? ORDER BY g.delivery_date, g.id`, id, month);
  const oil_lines = all(`SELECT sl.txn_date, pr.name product, pr.unit, ABS(sl.qty) qty, COALESCE(sl.unit_price, pr.unit_price) unit_price
                           FROM stock_ledger sl JOIN products pr ON pr.id=sl.product_id
                          WHERE sl.asset_id=? AND sl.kind='issue' AND ${OIL_NOT_SERVICE} AND substr(sl.txn_date,1,7)=? ORDER BY sl.txn_date, sl.id`, id, month);
  const labour = labour_lines.reduce((s, l) => s + (l.amount || 0), 0);
  const material = material_lines.reduce((s, l) => s + (l.qty || 0) * (l.unit_price || 0), 0);
  const oil = oil_lines.reduce((s, l) => s + (l.qty || 0) * (l.unit_price || 0), 0);
  res.json({ month, asset_id: id, asset_code: asset ? asset.code : '(unlinked)',
    asset_reg: asset ? asset.registration : null, asset_ec: asset ? asset.ec_code : null,
    labour: r2(labour), material: r2(material), oil: r2(oil), total: r2(labour + material + oil),
    labour_lines, material_lines, oil_lines });
}));

// ---- role-aware "pending your approval" queue (for the dashboard) ----------
// Only live, in-flow MRNs (a real requester name) count — imported history has none.
router.get('/pending-approvals', asyncHandler((req, res) => {
  const roles = (req.user && req.user.roles) || [];
  const has = (r) => roles.includes('admin') || roles.includes(r);
  const out = { certify: [], approve: [], transport: [], ops: [], jr_certify: [], jr_approve: [] };
  const INFLOW = "approval_status = 'requested' AND requested_by IS NOT NULL AND TRIM(requested_by) <> ''";
  const lineCount = '(SELECT COUNT(*) FROM mrn_lines ml WHERE ml.mrn_id = m.id) lines';
  if (has('workshop') || has('manager')) {
    out.certify = all(`SELECT m.id, m.mrn_no, m.req_date, m.requested_by, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec, ${lineCount}
        FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id WHERE ${INFLOW} ORDER BY m.req_date DESC, m.id DESC LIMIT 50`);
  }
  if (has('operational_manager') || has('manager')) {
    out.approve = all(`SELECT m.id, m.mrn_no, m.req_date, m.requested_by, m.certified_by, m.certified_at, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec, ${lineCount}
        FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id WHERE m.approval_status = 'certified' ORDER BY m.certified_at DESC, m.id DESC LIMIT 50`);
  }
  if (has('transport_manager')) {
    out.transport = all(`SELECT j.id, j.job_no, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id
        WHERE j.status = 'REQUESTED' AND j.approved_transport_at IS NULL AND j.is_historical = 0 ORDER BY j.id DESC LIMIT 50`);
  }
  if (has('operational_manager')) {
    out.ops = all(`SELECT j.id, j.job_no, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id
        WHERE j.approved_transport_at IS NOT NULL AND j.approved_ops_at IS NULL AND j.is_historical = 0 ORDER BY j.id DESC LIMIT 50`);
  }
  // Job Requests (Transport): Transport Manager certifies → Operational Manager approves.
  if (has('transport_manager')) {
    out.jr_certify = all(`SELECT r.id, r.jr_no, r.req_date, r.requested_by, r.description,
          a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec
        FROM job_requests r LEFT JOIN assets a ON a.id = r.asset_id
        WHERE r.approval_status = 'requested' ORDER BY r.id DESC LIMIT 50`);
  }
  if (has('operational_manager') || has('manager')) {
    out.jr_approve = all(`SELECT r.id, r.jr_no, r.req_date, r.requested_by, r.certified_by, r.description,
          a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec
        FROM job_requests r LEFT JOIN assets a ON a.id = r.asset_id
        WHERE r.approval_status = 'certified' ORDER BY r.id DESC LIMIT 50`);
  }
  out.total = out.certify.length + out.approve.length + out.transport.length + out.ops.length
            + out.jr_certify.length + out.jr_approve.length;
  out.is_approver = has('workshop') || has('operational_manager') || has('transport_manager') || has('manager');
  res.json(out);
}));

// ---- Daily Progress Report -------------------------------------------------
// One day's workshop output: jobs worked, mechanic hours, costed labour, plus
// materials + oil issued that day, with a printable sheet.
function dailyProgress(date) {
  const work = all(
    `SELECT w.job_id, j.job_no, j.type, j.status, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec,
            p.name AS project_name, w.mechanic, w.description, w.hours, w.is_external, w.external_value
       FROM job_daily_work w JOIN job_cards j ON j.id = w.job_id
       LEFT JOIN assets a ON a.id = j.asset_id LEFT JOIN projects p ON p.id = j.project_id
      WHERE w.work_date = ? ORDER BY j.job_no, w.id`, date);
  const lab = all(`SELECT job_id, COALESCE(SUM(amount),0) amount FROM job_labour WHERE work_date = ? GROUP BY job_id`, date);
  const labByJob = {}; for (const l of lab) labByJob[l.job_id] = l.amount;
  const issues = all(
    `SELECT i.description, i.qty, i.unit_price, j.job_no, a.code AS asset_code
       FROM issues i LEFT JOIN job_cards j ON j.id = i.job_id LEFT JOIN assets a ON a.id = i.asset_id
      WHERE i.issue_date = ? ORDER BY i.id`, date);
  const oil = all(
    `SELECT pr.name AS product, sl.qty, sl.unit_price, j.job_no, a.code AS asset_code
       FROM stock_ledger sl JOIN products pr ON pr.id = sl.product_id
       LEFT JOIN job_cards j ON j.id = sl.job_id LEFT JOIN assets a ON a.id = sl.asset_id
      WHERE sl.txn_date = ? AND sl.kind = 'issue' AND ${OIL_NOT_SERVICE} ORDER BY sl.id`, date);
  const jobsMap = {};
  for (const w of work) {
    const g = jobsMap[w.job_id] || (jobsMap[w.job_id] = {
      job_id: w.job_id, job_no: w.job_no, type: w.type, status: w.status,
      asset_code: w.asset_code, asset_reg: w.asset_reg, asset_ec: w.asset_ec, project_name: w.project_name,
      mechanics: [], tasks: [], hours: 0, external: 0, labour: r2(labByJob[w.job_id] || 0),
    });
    if (w.mechanic && !g.mechanics.includes(w.mechanic)) g.mechanics.push(w.mechanic);
    g.tasks.push({ mechanic: w.mechanic, description: w.description, hours: w.hours, is_external: w.is_external, external_value: w.external_value });
    g.hours = r2(g.hours + (Number(w.hours) || 0));
    g.external = r2(g.external + (Number(w.external_value) || 0));
  }
  const jobs = Object.values(jobsMap);
  const total_labour = lab.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const total_material = issues.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_price) || 0), 0);
  const total_oil = oil.reduce((s, o) => s + Math.abs(Number(o.qty) || 0) * (Number(o.unit_price) || 0), 0);
  const total_external = jobs.reduce((s, j) => s + j.external, 0);
  const total_hours = jobs.reduce((s, j) => s + j.hours, 0);
  return {
    date, jobs, issues, oil,
    totals: {
      jobs: jobs.length, hours: r2(total_hours), labour: r2(total_labour), external: r2(total_external),
      material: r2(total_material), oil: r2(total_oil), grand: r2(total_labour + total_external + total_material + total_oil),
    },
  };
}

const MDATE = /^\d{4}-\d{2}-\d{2}$/;
router.get('/daily-progress', asyncHandler((req, res) => {
  const date = String(req.query.date || '').slice(0, 10);
  if (!MDATE.test(date)) return res.status(400).json({ error: 'A valid ?date=YYYY-MM-DD is required' });
  res.json(dailyProgress(date));
}));

router.get('/daily-progress/print.html', asyncHandler((req, res) => {
  const date = String(req.query.date || '').slice(0, 10);
  if (!MDATE.test(date)) return res.status(400).send('A valid ?date=YYYY-MM-DD is required');
  const rep = dailyProgress(date);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const m = (n) => 'Rs ' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const veh = (j) => [j.asset_reg, (j.asset_ec && j.asset_ec !== j.asset_reg) ? j.asset_ec : ''].filter(Boolean).join(' · ') || j.asset_code || '';
  const jobRows = rep.jobs.map((j) => `<tr>
      <td>${esc(j.job_no)}</td><td>${esc(veh(j))}</td><td>${esc(j.mechanics.join(', '))}</td>
      <td>${j.tasks.map((t) => esc(t.description || (t.is_external ? 'External repair' : ''))).filter(Boolean).join('; ')}</td>
      <td class="num">${j.hours}</td><td class="num">${m(j.labour)}</td></tr>`).join('') ||
    '<tr><td colspan="6" style="text-align:center;color:#666">No work logged this day.</td></tr>';
  const t = rep.totals;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Daily Progress ${esc(date)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  body { font-family: Arial, sans-serif; color:#000; font-size:12px; margin:0; }
  h1 { font-size:18px; margin:0 0 2px; } .sub { color:#444; margin-bottom:10px; }
  table { width:100%; border-collapse:collapse; margin-bottom:14px; }
  th,td { border:1px solid #000; padding:4px 6px; vertical-align:top; } th { background:#f0f0f0; text-align:left; }
  td.num, th.num { text-align:right; }
  .tot { display:flex; gap:16px; flex-wrap:wrap; margin-bottom:10px; }
  .tot div { border:1px solid #000; padding:6px 10px; } .tot b { display:block; font-size:15px; }
  button { padding:8px 14px; font-size:14px; margin:10px 0; cursor:pointer; }
  @media print { .noprint { display:none; } }
</style></head><body>
<button class="noprint" onclick="window.print()">🖨 Print / Save as PDF</button>
<h1>Edward &amp; Christie (Pvt) Ltd — Daily Progress Report</h1>
<div class="sub">Date: <b>${esc(date)}</b> · ${t.jobs} job(s) worked · ${t.hours} mechanic-hours</div>
<div class="tot">
  <div>Labour<b>${m(t.labour)}</b></div><div>Material<b>${m(t.material)}</b></div>
  <div>Oil &amp; Lube<b>${m(t.oil)}</b></div><div>External<b>${m(t.external)}</b></div>
  <div>Total<b>${m(t.grand)}</b></div>
</div>
<table><thead><tr><th>Job No</th><th>Vehicle</th><th>Mechanic(s)</th><th>Work done</th><th class="num">Hours</th><th class="num">Labour</th></tr></thead>
<tbody>${jobRows}</tbody></table>
${rep.issues.length ? `<h3>Materials issued</h3><table><thead><tr><th>Item</th><th>Job</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Value</th></tr></thead><tbody>${rep.issues.map((i) => `<tr><td>${esc(i.description)}</td><td>${esc(i.job_no || '')}</td><td class="num">${i.qty}</td><td class="num">${i.unit_price == null ? '—' : m(i.unit_price)}</td><td class="num">${m((Number(i.qty) || 0) * (Number(i.unit_price) || 0))}</td></tr>`).join('')}</tbody></table>` : ''}
${rep.oil.length ? `<h3>Oil &amp; lubricants issued</h3><table><thead><tr><th>Product</th><th>Job</th><th class="num">Qty</th><th class="num">Value</th></tr></thead><tbody>${rep.oil.map((o) => `<tr><td>${esc(o.product)}</td><td>${esc(o.job_no || '')}</td><td class="num">${Math.abs(Number(o.qty) || 0)}</td><td class="num">${m(Math.abs(Number(o.qty) || 0) * (Number(o.unit_price) || 0))}</td></tr>`).join('')}</tbody></table>` : ''}
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

// ---- Reverse Costing — per-vehicle cost teardown ---------------------------
// Where did an asset's spend go? Decompose lifetime cost into buckets, rank the
// jobs, parts and mechanics that drove it. A "should-cost" style breakdown.
function assetTeardown(id) {
  const asset = get('SELECT id, code, registration, ec_code, brand, type, asset_class FROM assets WHERE id = ?', id);
  if (!asset) return null;
  const buckets = get(
    `SELECT COALESCE(SUM(labour_cost),0) labour, COALESCE(SUM(material_cost),0) material,
            COALESCE(SUM(oil_cost),0) oil, COALESCE(SUM(general_cost),0) general,
            COALESCE(SUM(external_cost),0) external, COALESCE(SUM(other_cost),0) other,
            COALESCE(SUM(total_cost),0) total, COUNT(*) jobs
       FROM job_cards WHERE asset_id = ?`, id);
  const jobs = all(
    `SELECT id, job_no, type, status, requested_at, labour_cost, material_cost, oil_cost, external_cost, total_cost
       FROM job_cards WHERE asset_id = ? ORDER BY total_cost DESC LIMIT 50`, id);
  const parts = all(
    `SELECT jp.description, COUNT(*) lines, COALESCE(SUM(jp.qty * jp.unit_price),0) value
       FROM job_parts jp JOIN job_cards j ON j.id = jp.job_id
      WHERE j.asset_id = ? AND jp.unit_price IS NOT NULL AND jp.description IS NOT NULL
      GROUP BY LOWER(jp.description) ORDER BY value DESC LIMIT 10`, id);
  const mechanics = all(
    `SELECT jl.mechanic, COALESCE(SUM(jl.hours),0) hours, COALESCE(SUM(jl.amount),0) amount
       FROM job_labour jl JOIN job_cards j ON j.id = jl.job_id
      WHERE j.asset_id = ? AND jl.mechanic IS NOT NULL
      GROUP BY jl.mechanic ORDER BY amount DESC LIMIT 10`, id);
  return { asset, buckets, jobs, parts, mechanics };
}

router.get('/teardown/asset/:id', asyncHandler((req, res) => {
  const t = assetTeardown(toInt(req.params.id));
  if (!t) return res.status(404).json({ error: 'Asset not found' });
  res.json(t);
}));

router.get('/teardown/asset/:id/print.html', asyncHandler((req, res) => {
  const t = assetTeardown(toInt(req.params.id));
  if (!t) return res.status(404).send('Asset not found');
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const m = (n) => 'Rs ' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const b = t.buckets;
  const veh = [t.asset.registration, (t.asset.ec_code && t.asset.ec_code !== t.asset.registration) ? t.asset.ec_code : ''].filter(Boolean).join(' · ') || t.asset.code;
  const pc = (n) => b.total > 0 ? (100 * (Number(n) || 0) / b.total).toFixed(1) + '%' : '—';
  const bucketRow = (label, val) => `<tr><td>${label}</td><td class="num">${m(val)}</td><td class="num">${pc(val)}</td></tr>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Cost Teardown ${esc(veh)}</title>
<style>
  @page { size: A4; margin: 12mm; } body { font-family: Arial, sans-serif; color:#000; font-size:12px; margin:0; }
  h1 { font-size:18px; margin:0 0 2px; } .sub { color:#444; margin-bottom:10px; }
  table { width:100%; border-collapse:collapse; margin-bottom:14px; } th,td { border:1px solid #000; padding:4px 6px; } th { background:#f0f0f0; text-align:left; }
  td.num, th.num { text-align:right; } button { padding:8px 14px; font-size:14px; margin:10px 0; cursor:pointer; }
  @media print { .noprint { display:none; } }
</style></head><body>
<button class="noprint" onclick="window.print()">🖨 Print / Save as PDF</button>
<h1>Edward &amp; Christie (Pvt) Ltd — Cost Teardown</h1>
<div class="sub">Vehicle: <b>${esc(veh)}</b> · ${esc([t.asset.brand, t.asset.type].filter(Boolean).join(' '))} · ${b.jobs} job(s) · lifetime <b>${m(b.total)}</b></div>
<table><thead><tr><th>Cost bucket</th><th class="num">Amount</th><th class="num">Share</th></tr></thead><tbody>
  ${bucketRow('Labour', b.labour)}${bucketRow('Material', b.material)}${bucketRow('Oil &amp; Lube', b.oil)}${bucketRow('General', b.general)}${bucketRow('External repair', b.external)}${bucketRow('Other', b.other)}
  <tr><td><b>Total</b></td><td class="num"><b>${m(b.total)}</b></td><td class="num">100%</td></tr></tbody></table>
${t.jobs.length ? `<h3>Jobs by cost</h3><table><thead><tr><th>Job No</th><th>Type</th><th class="num">Labour</th><th class="num">Material</th><th class="num">Oil</th><th class="num">External</th><th class="num">Total</th></tr></thead><tbody>${t.jobs.map((j) => `<tr><td>${esc(j.job_no)}</td><td>${esc(j.type)}</td><td class="num">${m(j.labour_cost)}</td><td class="num">${m(j.material_cost)}</td><td class="num">${m(j.oil_cost)}</td><td class="num">${m(j.external_cost)}</td><td class="num"><b>${m(j.total_cost)}</b></td></tr>`).join('')}</tbody></table>` : ''}
${t.parts.length ? `<h3>Top parts by value</h3><table><thead><tr><th>Part</th><th class="num">Lines</th><th class="num">Value</th></tr></thead><tbody>${t.parts.map((p) => `<tr><td>${esc(p.description)}</td><td class="num">${p.lines}</td><td class="num">${m(p.value)}</td></tr>`).join('')}</tbody></table>` : ''}
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

// ===========================================================================
// Rollup / valuation / analysis reports (read from vehicle_monthly_costs, the stock
// tables, mrn and issues). These four carry requireAuth explicitly — the rest of this
// router is historically ungated, but cost/valuation data should not be anonymous.
// ===========================================================================

// 1) Complete per-vehicle cost from the monthly rollup. month optional (full year).
router.get('/vehicle-cost-complete', requireAuth, asyncHandler((req, res) => {
  const assetId = toInt(req.query.asset_id);
  const year = toInt(req.query.year);
  if (!assetId || !year) return res.status(400).json({ error: 'asset_id and year are required' });
  const month = req.query.month ? toInt(req.query.month) : null;
  const asset = get('SELECT id, code, registration, ec_code FROM assets WHERE id = ?', assetId);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  const where = 'asset_id = ? AND year = ?' + (month ? ' AND month = ?' : '');
  const params = month ? [assetId, year, month] : [assetId, year];
  const SUMS = ['fuel_cost', 'oil_cost', 'filter_cost', 'battery_cost', 'parts_cost', 'labour_cost', 'total_cost']
    .map((c) => `ROUND(COALESCE(SUM(${c}),0),2) AS ${c}`).join(', ');
  const cost_summary = get(`SELECT ${SUMS} FROM vehicle_monthly_costs WHERE ${where}`, ...params);
  const monthly_breakdown = all(
    `SELECT month, ROUND(fuel_cost,2) fuel_cost, ROUND(oil_cost,2) oil_cost, ROUND(filter_cost,2) filter_cost,
            ROUND(battery_cost,2) battery_cost, ROUND(parts_cost,2) parts_cost, ROUND(labour_cost,2) labour_cost,
            ROUND(total_cost,2) total_cost
       FROM vehicle_monthly_costs WHERE ${where} ORDER BY month`, ...params);
  res.json({ asset, year, month, cost_summary, monthly_breakdown });
}));

// 2) Inventory valuation across general stock, oil and filters.
router.get('/stock-valuation', requireAuth, asyncHandler((_req, res) => {
  const general = get(`SELECT COUNT(*) items, ROUND(COALESCE(SUM(balance * COALESCE(unit_cost,0)),0),2) value
     FROM store_items WHERE is_general = 1`);
  const oil = get(`SELECT COUNT(*) items, ROUND(COALESCE(SUM(COALESCE(stock_qty,0) * COALESCE(unit_price,0)),0),2) value
     FROM products WHERE active = 1`);
  const filter = get(`SELECT COUNT(*) items, ROUND(COALESCE(SUM(qty_in_stock * COALESCE(unit_cost,0)),0),2) value
     FROM filter_stock`);
  const grand_total = Math.round((general.value + oil.value + filter.value) * 100) / 100;
  const by_category = all(`
    SELECT category, kind, ROUND(SUM(value),2) value, SUM(items) items FROM (
      SELECT COALESCE(NULLIF(TRIM(category),''),'Uncategorised') category, 'general' kind, balance * COALESCE(unit_cost,0) value, 1 items FROM store_items WHERE is_general = 1
      UNION ALL
      SELECT COALESCE(NULLIF(TRIM(category),''),'Oil') category, 'oil' kind, COALESCE(stock_qty,0) * COALESCE(unit_price,0) value, 1 items FROM products WHERE active = 1
      UNION ALL
      SELECT COALESCE(NULLIF(TRIM(brand),''),'Filter') category, 'filter' kind, qty_in_stock * COALESCE(unit_cost,0) value, 1 items FROM filter_stock
    ) GROUP BY category, kind HAVING SUM(value) > 0 ORDER BY value DESC`);
  res.json({
    general_parts_value: general.value, oil_value: oil.value, filter_value: filter.value, grand_total,
    counts: { general: general.items, oil: oil.items, filter: filter.items },
    by_category,
  });
}));

// 3) MRN analysis — status mix, avg time to certify, top requested items.
router.get('/mrn-analysis', requireAuth, asyncHandler((req, res) => {
  const year = req.query.year ? toInt(req.query.year) : null;
  const month = req.query.month ? toInt(req.query.month) : null;
  const mc = [];
  const mp = [];
  if (year) { mc.push("CAST(strftime('%Y', m.req_date) AS INTEGER) = ?"); mp.push(year); }
  if (month) { mc.push("CAST(strftime('%m', m.req_date) AS INTEGER) = ?"); mp.push(month); }
  const andClause = mc.length ? ' AND ' + mc.join(' AND ') : '';

  const by_status = all(
    `SELECT m.approval_status, COUNT(*) count FROM mrn m ${mc.length ? 'WHERE ' + mc.join(' AND ') : ''}
      GROUP BY m.approval_status ORDER BY count DESC`, ...mp);
  const timing = get(
    `SELECT COUNT(*) n, ROUND(AVG(julianday(m.certified_at) - julianday(m.req_date)),2) avg_days_to_certify
       FROM mrn m WHERE m.certified_at IS NOT NULL AND m.req_date IS NOT NULL${andClause}`, ...mp);
  const top_requested_items = all(
    `SELECT TRIM(ml.description) description, COUNT(*) times, ROUND(SUM(ml.qty),2) total_qty
       FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id
      WHERE ml.description IS NOT NULL AND TRIM(ml.description) <> ''${andClause}
      GROUP BY LOWER(TRIM(ml.description)) ORDER BY times DESC LIMIT 10`, ...mp);
  res.json({ year, month, by_status, timing, top_requested_items });
}));

// 4) Issues for one vehicle — list, category breakdown, date timeline.
router.get('/issues-by-vehicle', requireAuth, asyncHandler((req, res) => {
  const assetId = toInt(req.query.asset_id);
  if (!assetId) return res.status(400).json({ error: 'asset_id is required' });
  const asset = get('SELECT id, code, registration, ec_code FROM assets WHERE id = ?', assetId);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const clauses = ['i.asset_id = ?'];
  const params = [assetId];
  if (req.query.from_date) { clauses.push('i.issue_date >= ?'); params.push(req.query.from_date); }
  if (req.query.to_date) { clauses.push('i.issue_date <= ?'); params.push(req.query.to_date); }
  const where = 'WHERE ' + clauses.join(' AND ');
  const COST = 'i.qty * COALESCE(i.unit_price, 0)';

  const summary = get(`SELECT COUNT(*) count, ROUND(COALESCE(SUM(i.qty),0),2) total_qty, ROUND(COALESCE(SUM(${COST}),0),2) total_cost FROM issues i ${where}`, ...params);
  const issues = all(
    `SELECT i.id, i.issue_date, i.description, i.category, i.qty, i.unit_price, ROUND(${COST},2) total_cost, j.job_no
       FROM issues i LEFT JOIN job_cards j ON j.id = i.job_id ${where}
      ORDER BY i.issue_date DESC, i.id DESC LIMIT 1000`, ...params);
  const by_category = all(
    `SELECT COALESCE(NULLIF(TRIM(i.category),''),'Uncategorised') category, COUNT(*) count,
            ROUND(SUM(i.qty),2) qty, ROUND(SUM(${COST}),2) total_cost
       FROM issues i ${where} GROUP BY 1 ORDER BY total_cost DESC`, ...params);
  const timeline = all(
    `SELECT i.issue_date date, COUNT(*) count, ROUND(SUM(${COST}),2) total_cost
       FROM issues i ${where} GROUP BY i.issue_date ORDER BY i.issue_date`, ...params);
  res.json({ asset, summary, issues, by_category, timeline });
}));

// ===========================================================================
// Monthly Cost Report — the company's 8-sheet "Job cost report" workbook, generated
// for any year+month. Data-backed sheets (Repair/Service/Salaries-hours) come from live
// data; the five sheets the system can't source from transactions (Tyre, Battery, Fuel,
// Other/overhead, Staff/Security salaries) are entered via /monthly-inputs and stored in
// monthly_report_inputs. See src/lib/monthly_cost_report.js for the layout + column map.
// ===========================================================================
// Tyre & Battery are auto-sourced from the issue ledger (tyre_battery_issues); only these three
// sheets are entered by hand.
const MONTHLY_SHEETS = ['fuel', 'other', 'salary'];

function validPeriod(year, month) {
  return Number.isInteger(year) && year >= 2000 && year <= 2100 && Number.isInteger(month) && month >= 1 && month <= 12;
}

// Download the workbook for a period.
router.get('/monthly-cost.xlsx', requireAuth, asyncHandler(async (req, res) => {
  const year = toInt(req.query.year), month = toInt(req.query.month);
  if (!validPeriod(year, month)) return res.status(400).json({ error: 'year (YYYY) and month (1-12) are required' });
  const { wb } = await monthlyReport.buildWorkbook(year, month);
  const fname = `Job-cost-report-${monthlyReport.MONTHS[month]}-${year}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  await wb.xlsx.write(res);
  res.end();
}));

// Fetch the saved manual inputs for a period, plus a live totals preview (all 8 sheets).
router.get('/monthly-inputs', requireAuth, asyncHandler(async (req, res) => {
  const year = toInt(req.query.year), month = toInt(req.query.month);
  if (!validPeriod(year, month)) return res.status(400).json({ error: 'year and month are required' });
  const inputs = {};
  for (const sheet of MONTHLY_SHEETS) {
    inputs[sheet] = all(
      `SELECT id, seq, line_date, vehicle, label, project, qty, rate, amount1, amount2, amount3, note
         FROM monthly_report_inputs WHERE year = ? AND month = ? AND sheet = ? ORDER BY seq, id`, year, month, sheet);
  }
  // Live preview of every sheet's grand totals (so the UI can show what the download will contain).
  const { parts, total } = await monthlyReport.buildWorkbook(year, month);
  const preview = {
    repair: {
      count: parts.repair.count, total: parts.repair.sums.total,
      closed_count: parts.repair.closed_count, closed_total: parts.repair.closed_total,
      pending_count: parts.repair.pending_count, pending_total: parts.repair.pending_total,
    },
    service: { count: parts.service.count, total: parts.service.sums.total },
    tyre: { count: parts.tyre.count, total: parts.tyre.sums.total },
    battery: { count: parts.battery.count, total: parts.battery.sums.total },
    oils: { count: parts.oils.count, total: parts.oils.sums.total, job_oil: parts.oils.job_oil, service_oil: parts.oils.service_oil },
    fuel: { count: parts.fuel.count, total: parts.fuel.sums.cost },
    salary: { count: parts.salaries.count, staff_total: parts.salaries.sums.total, mechanic_total: parts.salaries.mechanic_total },
    other: { count: parts.other.count, total: parts.other.sums.total },
    grand_total: total.grand_total,
  };
  res.json({ year, month, inputs, preview });
}));

// Replace all saved lines for one (year, month, sheet). Body: { year, month, sheet, lines:[...] }.
router.post('/monthly-inputs', requireAuth, asyncHandler((req, res) => {
  const b = req.body || {};
  const year = toInt(b.year), month = toInt(b.month), sheet = String(b.sheet || '');
  if (!validPeriod(year, month)) return res.status(400).json({ error: 'year and month are required' });
  if (!MONTHLY_SHEETS.includes(sheet)) return res.status(400).json({ error: 'sheet must be one of ' + MONTHLY_SHEETS.join(', ') });
  // Keep only well-formed line objects — a null/primitive element must not crash the insert (→ 500).
  const lines = (Array.isArray(b.lines) ? b.lines : []).filter((ln) => ln && typeof ln === 'object');
  // Coerce every text field to a string or null — a non-string (object/array/boolean) field value
  // would otherwise reach better-sqlite3's bind and throw (→ 500 instead of a clean save).
  const s = (v) => (v == null || typeof v === 'object') ? null : String(v);
  tx(() => {
    run('DELETE FROM monthly_report_inputs WHERE year = ? AND month = ? AND sheet = ?', year, month, sheet);
    let seq = 0;
    for (const ln of lines) {
      run(
        `INSERT INTO monthly_report_inputs (year, month, sheet, seq, line_date, vehicle, label, project, qty, rate, amount1, amount2, amount3, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        year, month, sheet, seq++,
        s(ln.line_date), s(ln.vehicle), s(ln.label), s(ln.project), s(ln.qty),
        ln.rate == null || ln.rate === '' ? null : toNum(ln.rate),
        toNum(ln.amount1) || 0, toNum(ln.amount2) || 0, toNum(ln.amount3) || 0, s(ln.note));
    }
  });
  res.json({ ok: true, sheet, saved: lines.length });
}));

// Monthly Repair Detail — an itemized "bill" for every repair job in the month (same Closed +
// Pending set as the report's Repair sheet), each broken into its labour / parts / oil / general /
// external line items with a per-job total and a grand total. Printable / save-as-PDF.
router.get('/monthly-repair-detail.html', requireAuth, asyncHandler((req, res) => {
  const year = toInt(req.query.year), month = toInt(req.query.month);
  if (!validPeriod(year, month)) return res.status(400).send('year (YYYY) and month (1-12) are required');
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const period = `${monthlyReport.MONTHS[month]} ${year}`;
  const closedIds = all(`SELECT id FROM job_cards WHERE status = 'CLOSED' AND completed_at IS NOT NULL AND substr(completed_at,1,7) = ? ORDER BY completed_at, id`, ym).map((r) => r.id);
  const pendingIds = all(`SELECT id FROM job_cards WHERE status NOT IN ('CLOSED','REJECTED') AND id IN (SELECT DISTINCT job_id FROM job_labour WHERE substr(work_date,1,7) = ?) ORDER BY COALESCE(requested_at, created_at), id`, ym).map((r) => r.id);

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const money = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const n2 = (n) => (Number(n) || 0).toLocaleString('en-US');
  const g = { labour: 0, material: 0, oil: 0, other: 0, external: 0, total: 0, jobs: 0 };

  const renderJob = (id, se) => {
    const s = costSheet(id);
    if (!s) return '';
    const j = s.job;
    const other = (Number(j.general_cost) || 0) + (Number(j.other_cost) || 0);
    const total = (Number(j.labour_cost) || 0) + (Number(j.material_cost) || 0) + (Number(j.oil_cost) || 0) + other + (Number(j.external_cost) || 0);
    g.labour += Number(j.labour_cost) || 0; g.material += Number(j.material_cost) || 0; g.oil += Number(j.oil_cost) || 0;
    g.other += other; g.external += Number(j.external_cost) || 0; g.total += total; g.jobs++;
    const line = (type, item, qty, rate, amt) => `<tr><td>${type}</td><td>${esc(item)}</td><td class="num">${qty}</td><td class="num">${rate}</td><td class="num">${money(amt)}</td></tr>`;
    const rows = [];
    for (const l of s.labour_lines) rows.push(line('Labour', (l.mechanic || '') + (l.work_date ? ` · ${String(l.work_date).slice(0, 10)}` : ''), n2(l.hours), money(l.rate), l.amount));
    for (const p of s.part_lines) rows.push(line('Part', p.description || '', n2(p.qty), money(p.unit_price), (Number(p.qty) || 0) * (Number(p.unit_price) || 0)));
    for (const o of s.oil_lines) rows.push(line('Oil', (o.product_name || '') + (o.unit ? ` (${o.unit})` : ''), n2(Math.abs(o.qty)), money(o.unit_price), Math.abs(Number(o.qty) || 0) * (Number(o.unit_price) || 0)));
    for (const gl of s.general_lines) rows.push(line('General', gl.item_name || '', n2(Math.abs(gl.qty)), money(gl.unit_price), Math.abs(Number(gl.qty) || 0) * (Number(gl.unit_price) || 0)));
    for (const e of s.external_lines) rows.push(line('External', e.description || 'External repair', '', '', e.value));
    const body = rows.join('') || '<tr><td colspan="5" class="muted">No line items recorded.</td></tr>';
    return `<div class="job">
      <div class="jh"><b>${se}. Job ${esc(j.job_no)}</b> — ${esc(s.asset_code || '')}${j.project_name ? ` · ${esc(j.project_name)}` : ''} · <span class="st">${esc(j.status)}</span> · ${esc(String(j.completed_at || j.requested_at || '').slice(0, 10))}
        ${j.description ? `<div class="desc">${esc(j.description)}</div>` : ''}</div>
      <table class="det"><thead><tr><th>Type</th><th>Item / Description</th><th class="num">Qty</th><th class="num">Rate/Price</th><th class="num">Amount</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr class="jt"><td colspan="4">Job total — Labour ${money(j.labour_cost)} · Spare ${money(j.material_cost)} · Lube ${money(j.oil_cost)} · Other ${money(other)} · Outside ${money(j.external_cost)}</td><td class="num"><b>${money(total)}</b></td></tr></tfoot>
      </table></div>`;
  };
  const section = (title, ids) => `<h2>${esc(title)} (${ids.length})</h2>${ids.length ? ids.map((id, i) => renderJob(id, i + 1)).join('') : '<p class="muted">None.</p>'}`;
  const closedHtml = section('Closed Jobs — completed & closed in ' + period, closedIds);
  const pendingHtml = section('Pending Jobs — work-in-progress worked in ' + period, pendingIds);

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Repair Detail ${esc(period)}</title>
<style>
  @page { size: A4; margin: 12mm; } body { font-family: Arial, sans-serif; color:#000; font-size:11px; margin:0; }
  h1 { font-size:17px; margin:0 0 2px; } h2 { font-size:13px; margin:16px 0 6px; border-bottom:2px solid #333; padding-bottom:2px; }
  .sub { color:#444; margin-bottom:8px; } button { padding:8px 14px; font-size:14px; margin:10px 0; cursor:pointer; }
  .job { border:1px solid #bbb; border-radius:4px; padding:6px 8px; margin:0 0 8px; break-inside:avoid; }
  .jh { margin-bottom:4px; } .jh .st { color:#1d5a73; font-weight:bold; } .desc { color:#555; font-size:10px; margin-top:2px; }
  table.det { width:100%; border-collapse:collapse; } .det th,.det td { border:1px solid #ccc; padding:2px 5px; }
  .det th { background:#f0f0f0; text-align:left; } td.num,th.num { text-align:right; white-space:nowrap; }
  .det tfoot .jt td { background:#f7f7f7; font-weight:bold; } .muted { color:#999; }
  .grand { margin-top:14px; border-top:3px double #333; padding-top:8px; }
  .grand table { width:auto; margin-left:auto; border-collapse:collapse; } .grand td { padding:3px 12px; } .grand .tot { font-size:15px; font-weight:bold; border-top:2px solid #333; }
  @media print { .noprint { display:none; } }
</style></head><body>
<button class="noprint" onclick="window.print()">🖨 Print / Save as PDF</button>
<h1>Edward &amp; Christie (Pvt) Ltd — Badalgama W/S</h1>
<div class="sub">Monthly Repair Detail — <b>${esc(period)}</b> · ${g.jobs} job(s)</div>
${closedHtml}
${pendingHtml}
<div class="grand"><table>
  <tr><td>Labour</td><td class="num">${money(g.labour)}</td></tr>
  <tr><td>Spare parts</td><td class="num">${money(g.material)}</td></tr>
  <tr><td>Lubricant</td><td class="num">${money(g.oil)}</td></tr>
  <tr><td>Other material</td><td class="num">${money(g.other)}</td></tr>
  <tr><td>Outside work</td><td class="num">${money(g.external)}</td></tr>
  <tr class="tot"><td>Grand total (${g.jobs} jobs)</td><td class="num">${money(g.total)}</td></tr>
</table></div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

module.exports = router;
