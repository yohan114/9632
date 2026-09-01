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

// Coerce any value to a finite number (blank/NaN -> 0); matches the report generator's helper.
const num = (v) => Number(v) || 0;

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
  // All job_parts (incl. external-REPAIR charges) are part lines — they now count in material_cost,
  // so the line items sum to the shown total.
  const parts = all(`SELECT * FROM job_parts WHERE job_id = ?`, id);
  const oil = all(`SELECT sl.*, pr.name product_name, pr.unit FROM stock_ledger sl JOIN products pr ON pr.id=sl.product_id WHERE sl.job_id = ? AND sl.kind='issue'`, id);
  const general = all(`SELECT g.*, si.name item_name FROM general_item_txns g JOIN store_items si ON si.id=g.store_item_id WHERE g.job_id = ? AND g.txn_type='issue'`, id);
  // "external" here = external WORK only (daily-work) — the owner's personally-tracked outside cost,
  // shown for reference but NOT in the total. External REPAIR is a normal counted part above.
  const external = all(`SELECT work_date, description, external_value FROM job_daily_work WHERE job_id = ? AND is_external = 1`, id).map((w) => ({ description: w.description, value: w.external_value }));
  return { job, asset_code: job.asset_code, labour_lines: cost.labourLines, part_lines: parts, oil_lines: oil, general_lines: general, external_lines: external, totals: cost };
}

// ---- Full Job Report -------------------------------------------------------
// The whole story of one job on a single page: what was asked for (MRN lines), what
// actually arrived (GRN receipts), what the mechanics did day by day, the oil and general
// items drawn, and the cost summary. The cost sheet above is the money view; this is the
// working record.
function jobReport(id) {
  const job = get(
    `SELECT j.*, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec,
            a.type AS asset_type, a.brand AS asset_brand, p.name AS project_name
       FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id LEFT JOIN projects p ON p.id = j.project_id
      WHERE j.id = ?`, id);
  if (!job) return null;
  const cost = costing.reconciledCost(id);

  // 1. Requested — MRN lines reached EITHER by an MRN raised against the job, OR by the parts
  //    allocated to it (job_parts.mrn_line_id). Most history links the second way, so both count.
  const requested = all(
    `SELECT DISTINCT ml.id, m.mrn_no, m.req_date, ml.description, ml.category, ml.qty,
            COALESCE(ml.qty_received,0) AS qty_received, (ml.qty - COALESCE(ml.qty_received,0)) AS pending,
            -- the source is usually only decided when the goods are received, so fall back to the GRN
            COALESCE(ml.purchase_source, m.purchase_source,
                     (SELECT g.purchase_source_norm FROM grn g
                       WHERE g.mrn_line_id = ml.id AND g.purchase_source_norm IS NOT NULL LIMIT 1)) AS source
       FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id
      WHERE m.job_id = ?
         OR ml.id IN (SELECT mrn_line_id FROM job_parts WHERE job_id = ? AND mrn_line_id IS NOT NULL)
      ORDER BY m.req_date, m.mrn_no, ml.id`, id, id);

  // 2. Received — the GRN receipts behind those lines (what physically came in).
  const received = all(
    `SELECT DISTINCT g.id, g.grn_no, g.description, g.qty, g.unit_price, g.supplier, g.invoice_no,
            g.delivery_date, COALESCE(g.purchase_source_norm, ml.purchase_source, m.purchase_source) AS source,
            m.mrn_no
       FROM grn g
       LEFT JOIN mrn m ON m.id = g.mrn_id
       LEFT JOIN mrn_lines ml ON ml.id = g.mrn_line_id
      WHERE m.job_id = ?
         OR g.id IN (SELECT source_id FROM job_parts WHERE job_id = ? AND source_type = 'grn')
      ORDER BY g.delivery_date, g.id`, id, id);

  // 3. What we did — the daily programme, newest last so it reads as a diary.
  const dailyWork = all(
    `SELECT work_date, mechanic, description, hours, is_external, external_value, outside_labour
       FROM job_daily_work WHERE job_id = ? ORDER BY work_date, id`, id);

  const parts = all('SELECT * FROM job_parts WHERE job_id = ?', id);
  const oil = all(
    `SELECT sl.txn_date, sl.qty, sl.unit_price, pr.name AS product_name, pr.unit
       FROM stock_ledger sl JOIN products pr ON pr.id = sl.product_id
      WHERE sl.job_id = ? AND sl.kind = 'issue' AND COALESCE(sl.voided,0) = 0 ORDER BY sl.txn_date`, id);
  const general = all(
    `SELECT g.txn_date, g.qty, g.unit_price, si.name AS item_name
       FROM general_item_txns g JOIN store_items si ON si.id = g.store_item_id
      WHERE g.job_id = ? AND g.txn_type = 'issue' ORDER BY g.txn_date`, id);

  const totals = {
    ...cost,
    hours: r2(dailyWork.reduce((s, w) => s + (Number(w.hours) || 0), 0)),
    requested_lines: requested.length,
    requested_qty: r2(requested.reduce((s, r) => s + (Number(r.qty) || 0), 0)),
    received_qty: r2(requested.reduce((s, r) => s + (Number(r.qty_received) || 0), 0)),
    pending_qty: r2(requested.reduce((s, r) => s + Math.max(0, Number(r.pending) || 0), 0)),
    received_value: r2(received.reduce((s, g) => s + (Number(g.qty) || 0) * (Number(g.unit_price) || 0), 0)),
    unpriced: received.filter((g) => g.unit_price == null).length,
    outside_labour: r2(dailyWork.reduce((s, w) => s + (Number(w.outside_labour) || 0), 0)),
  };
  return { job, requested, received, dailyWork, parts, oil, general, totals };
}

router.get('/job/:id/report', asyncHandler((req, res) => {
  const r = jobReport(toInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Job not found' });
  res.json(r);
}));

router.get('/job/:id/report.html', asyncHandler((req, res) => {
  const s = jobReport(toInt(req.params.id));
  if (!s) return res.status(404).send('Job not found');
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const m = (n) => 'Rs ' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const d = (v) => (v ? String(v).slice(0, 10) : '');
  const SRC = { head_office: 'Head Office', local_purchase: 'Local Purchase' };
  const j = s.job, t = s.totals;
  const veh = [j.asset_reg, (j.asset_ec && j.asset_ec !== j.asset_reg) ? j.asset_ec : ''].filter(Boolean).join(' · ') || j.asset_code || '—';
  const sect = (n, title, cols, rows, empty) => `<h2>${n}. ${esc(title)}</h2><table>
    <thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.h)}</th>`).join('')}</tr></thead>
    <tbody>${rows || `<tr><td colspan="${cols.length}" style="text-align:center;color:#666">${esc(empty)}</td></tr>`}</tbody></table>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Job Report ${esc(j.job_no)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  body{font-family:Arial,sans-serif;color:#000;font-size:12px;margin:0}
  h1{font-size:19px;margin:0 0 2px} h2{font-size:13px;margin:16px 0 5px;border-bottom:2px solid #333;padding-bottom:3px}
  .sub{color:#444;margin-bottom:8px}
  table{width:100%;border-collapse:collapse;margin-bottom:8px}
  th,td{border:1px solid #999;padding:4px 6px;vertical-align:top;text-align:left}
  th{background:#eee} td.num,th.num{text-align:right;white-space:nowrap}
  .hdr{display:flex;flex-wrap:wrap;gap:0;border:1px solid #999;margin-bottom:10px}
  .hdr div{padding:5px 9px;border-right:1px solid #ccc;min-width:120px} .hdr b{display:block;font-size:13px}
  .hdr span{color:#555;font-size:10px;text-transform:uppercase;letter-spacing:.05em}
  .tot{display:flex;gap:0;flex-wrap:wrap;border:1px solid #000;margin:8px 0}
  .tot div{padding:6px 10px;border-right:1px solid #ccc;min-width:110px} .tot b{display:block;font-size:14px}
  button{padding:8px 14px;font-size:14px;margin:10px 0;cursor:pointer}
  @media print{.noprint{display:none}}
</style></head><body>
<button class="noprint" onclick="window.print()">🖨 Print / Save as PDF</button>
<h1>Edward &amp; Christie (Pvt) Ltd — Job Report</h1>
<div class="sub">Job <b>${esc(j.job_no)}</b> · ${esc(veh)}${j.asset_type ? ' · ' + esc(j.asset_type) : ''}${j.project_name ? ' · ' + esc(j.project_name) : ''}</div>
<div class="hdr">
  <div><span>Status</span><b>${esc(j.status)}</b></div>
  <div><span>Type</span><b>${esc(j.type || '')}</b></div>
  <div><span>Requested</span><b>${d(j.requested_at) || '—'}</b></div>
  <div><span>Completed</span><b>${d(j.completed_at) || '—'}</b></div>
  <div><span>Mechanic-hours</span><b>${t.hours}</b></div>
  <div><span>Items requested</span><b>${t.requested_lines}</b></div>
</div>
<h2>Complaint / work requested</h2>
<p style="border:1px solid #999;padding:6px 9px;margin:0 0 6px">${esc(j.description || '—')}</p>

${sect(1, 'Spare parts REQUESTED (material requisitions)',
  [{ h: 'MRN No' }, { h: 'Req Date' }, { h: 'Item' }, { h: 'Category' }, { h: 'Source' }, { h: 'Qty', num: true }, { h: 'Received', num: true }, { h: 'Pending', num: true }],
  s.requested.map((r) => `<tr><td>${esc(r.mrn_no || '')}</td><td>${d(r.req_date)}</td><td>${esc(r.description || '')}</td><td>${esc(r.category || '')}</td><td>${esc(SRC[r.source] || '')}</td><td class="num">${r.qty}</td><td class="num">${r.qty_received}</td><td class="num">${r.pending > 0 ? '<b>' + r.pending + '</b>' : '—'}</td></tr>`).join(''),
  'No material requisitions raised against this job.')}

${sect(2, 'Spare parts RECEIVED (goods received)',
  [{ h: 'GRN / MRN' }, { h: 'Delivered' }, { h: 'Item' }, { h: 'Supplier' }, { h: 'Invoice' }, { h: 'Qty', num: true }, { h: 'Unit Price', num: true }, { h: 'Value', num: true }],
  s.received.map((g) => `<tr><td>${esc(g.grn_no || g.mrn_no || '')}</td><td>${d(g.delivery_date)}</td><td>${esc(g.description || '')}</td><td>${esc(g.supplier || '')}</td><td>${esc(g.invoice_no || '')}</td><td class="num">${g.qty}</td><td class="num">${g.unit_price == null ? 'awaiting' : m(g.unit_price)}</td><td class="num">${g.unit_price == null ? '—' : m((Number(g.qty) || 0) * g.unit_price)}</td></tr>`).join(''),
  'Nothing received against this job yet.')}

${sect(3, 'What we did — daily work',
  [{ h: 'Date' }, { h: 'Mechanic(s)' }, { h: 'Work done' }, { h: 'Hours', num: true }, { h: 'Outside labor', num: true }],
  s.dailyWork.map((w) => `<tr><td>${d(w.work_date)}</td><td>${esc(w.mechanic || (w.is_external ? '(outside)' : '—'))}</td><td>${esc(w.description || '')}</td><td class="num">${w.hours || 0}</td><td class="num">${w.outside_labour ? m(w.outside_labour) : '—'}</td></tr>`).join(''),
  'No daily work logged against this job.')}

${s.oil.length ? sect(4, 'Oil & lubricants issued',
  [{ h: 'Date' }, { h: 'Product' }, { h: 'Qty', num: true }, { h: 'Unit Price', num: true }, { h: 'Value', num: true }],
  s.oil.map((o) => `<tr><td>${d(o.txn_date)}</td><td>${esc(o.product_name)}</td><td class="num">${Math.abs(Number(o.qty) || 0)} ${esc(o.unit || '')}</td><td class="num">${o.unit_price == null ? '—' : m(o.unit_price)}</td><td class="num">${m(Math.abs(Number(o.qty) || 0) * (Number(o.unit_price) || 0))}</td></tr>`).join(''), '') : ''}

${s.general.length ? sect(5, 'General / store items issued',
  [{ h: 'Date' }, { h: 'Item' }, { h: 'Qty', num: true }, { h: 'Value', num: true }],
  s.general.map((g) => `<tr><td>${d(g.txn_date)}</td><td>${esc(g.item_name)}</td><td class="num">${Math.abs(Number(g.qty) || 0)}</td><td class="num">${m(Math.abs(Number(g.qty) || 0) * (Number(g.unit_price) || 0))}</td></tr>`).join(''), '') : ''}

<h2>Cost summary</h2>
<div class="tot">
  <div><span>Labour</span><b>${m(t.labour_cost)}</b></div>
  <div><span>Spare parts</span><b>${m(t.material_cost)}</b></div>
  <div><span>Oil &amp; lube</span><b>${m(t.oil_cost)}</b></div>
  <div><span>General</span><b>${m(t.general_cost)}</b></div>
  <div><span>TOTAL</span><b>${m(t.total_cost)}</b></div>
</div>
<p style="color:#555;font-size:11px;margin:4px 0 0">
  Requested ${t.requested_qty} item(s) · received ${t.received_qty} · pending ${t.pending_qty}${t.unpriced ? ` · ${t.unpriced} receipt(s) awaiting a price` : ''}${t.outside_labour ? ` · outside labor value ${m(t.outside_labour)}` : ''}.
</p>
<div style="margin-top:26px;display:flex;gap:40px">
  <div>…................................<br>Prepared By</div>
  <div>…................................<br>Checked By</div>
  <div>…................................<br>Approved By</div>
</div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

// ---- Jobs-attended summary (a date onward) ---------------------------------
// Every job we touched from ?from= onward — worked on, opened, closed, or had materials
// requested — with the same three views as the single-job report: parts requested, parts
// received, and the work done. ?detail=0 gives the one-line-per-job summary only.
// Current-era jobs (2026 onward — the older imported history is excluded), newest attended
// first. `from` is optional: give one to show only jobs touched on/after that date.
function jobsAttended(from, to) {
  const params = [];
  let window = '';
  if (from) {
    window = ` AND ( EXISTS (SELECT 1 FROM job_daily_work w WHERE w.job_id = j.id AND w.work_date >= ?)
                  OR substr(COALESCE(j.requested_at, j.created_at),1,10) >= ?
                  OR (j.status = 'CLOSED' AND substr(j.completed_at,1,10) >= ?)
                  OR EXISTS (SELECT 1 FROM mrn m WHERE m.job_id = j.id AND substr(m.req_date,1,10) >= ?) )`;
    params.push(from, from, from, from);
  }
  if (to) { window += ' AND substr(COALESCE(j.completed_at, j.requested_at, j.created_at),1,10) <= ?'; params.push(to); }

  const rows = all(
    `SELECT j.id, j.job_no, j.status, j.type, j.description, j.requested_at, j.completed_at,
            a.registration AS asset_reg, a.code AS asset_code, a.ec_code AS asset_ec, a.type AS asset_type,
            p.name AS project_name,
            (SELECT MAX(w.work_date) FROM job_daily_work w WHERE w.job_id = j.id) AS last_work
       FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id LEFT JOIN projects p ON p.id = j.project_id
      WHERE j.status <> 'REJECTED'
        AND CAST(substr(j.job_no, 1, instr(j.job_no, '/') - 1) AS INTEGER) >= 2026
        ${window}
      ORDER BY (last_work IS NULL),                                   -- worked-on jobs first…
               last_work DESC,                                        -- …newest attended at the top
               substr(COALESCE(j.completed_at, j.requested_at, j.created_at),1,10) DESC,
               j.id DESC`, ...params);
  return rows.map((r) => ({ ...r, detail: jobReport(r.id) }));
}

// ---- Ongoing jobs watchlist (delay points) ---------------------------------
// Every job still open that was raised within the last N months (default 8) — older
// never-closed history is deliberately left out. Ranked by how stalled it is, with the
// reason it is stuck: nothing started, waiting on parts, or simply idle.
function ongoingJobs(months) {
  const today = new Date().toISOString().slice(0, 10);
  const cutDate = new Date(today + 'T00:00:00Z');
  cutDate.setUTCMonth(cutDate.getUTCMonth() - (Number(months) || 8));
  const cut = cutDate.toISOString().slice(0, 10);
  const days = (from) => (from ? Math.round((new Date(today + 'T00:00:00Z') - new Date(String(from).slice(0, 10) + 'T00:00:00Z')) / 86400000) : null);

  // The job NUMBER carries the year/month the card was raised (YYYY/M/R/seq) and is the reliable
  // signal: 66 open cards share the placeholder date 2026-07-16 stamped by an import, which would
  // otherwise make 2023-2025 jobs look brand new. So the era filter runs off the number, and the
  // age is measured from the number's month whenever the recorded date disagrees with it.
  const rows = all(
    `SELECT j.id, j.job_no, j.status, j.type, j.description,
            substr(COALESCE(j.requested_at, j.created_at),1,10) AS opened,
            CAST(substr(j.job_no, 1, instr(j.job_no,'/') - 1) AS INTEGER) AS jn_year,
            CAST(substr(substr(j.job_no, instr(j.job_no,'/') + 1), 1,
                        instr(substr(j.job_no, instr(j.job_no,'/') + 1), '/') - 1) AS INTEGER) AS jn_month,
            a.registration AS asset_reg, a.code AS asset_code, a.ec_code AS asset_ec, a.type AS asset_type,
            p.name AS project_name,
            (SELECT MAX(w.work_date) FROM job_daily_work w WHERE w.job_id = j.id) AS last_work,
            (SELECT COUNT(*)         FROM job_daily_work w WHERE w.job_id = j.id) AS work_entries,
            (SELECT COALESCE(SUM(w.hours),0) FROM job_daily_work w WHERE w.job_id = j.id) AS hours,
            COALESCE(j.labour_cost,0) AS labour_cost, COALESCE(j.material_cost,0) AS material_cost,
            COALESCE(j.total_cost,0)  AS total_cost
       FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id LEFT JOIN projects p ON p.id = j.project_id
      WHERE j.status NOT IN ('CLOSED','REJECTED')
        AND j.job_no LIKE '____/%'
        AND (CAST(substr(j.job_no, 1, instr(j.job_no,'/') - 1) AS INTEGER) * 12
             + CAST(substr(substr(j.job_no, instr(j.job_no,'/') + 1), 1,
                           instr(substr(j.job_no, instr(j.job_no,'/') + 1), '/') - 1) AS INTEGER))
            >= (CAST(substr(?,1,4) AS INTEGER) * 12 + CAST(substr(?,6,2) AS INTEGER))`, cut, cut);

  const out = rows.map((j) => {
    // Outstanding materials — the usual reason a job sits. Same dual linkage as the job report.
    const pending = all(
      `SELECT DISTINCT ml.id, m.mrn_no, m.req_date, ml.description, ml.qty,
              COALESCE(ml.qty_received,0) AS qty_received, (ml.qty - COALESCE(ml.qty_received,0)) AS pending,
              COALESCE(ml.purchase_source, m.purchase_source,
                       (SELECT g.purchase_source_norm FROM grn g WHERE g.mrn_line_id = ml.id AND g.purchase_source_norm IS NOT NULL LIMIT 1)) AS source
         FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id
        WHERE (m.job_id = ? OR ml.id IN (SELECT mrn_line_id FROM job_parts WHERE job_id = ? AND mrn_line_id IS NOT NULL))
          AND COALESCE(ml.qty_received,0) < ml.qty
        ORDER BY m.req_date`, j.id, j.id);
    const requestedCount = get(
      `SELECT COUNT(DISTINCT ml.id) c FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id
        WHERE m.job_id = ? OR ml.id IN (SELECT mrn_line_id FROM job_parts WHERE job_id = ? AND mrn_line_id IS NOT NULL)`, j.id, j.id).c;

    // Raised-on: the job number's month is authoritative. If the recorded date sits more than
    // ~45 days away from it, that date is an import placeholder — flag it and age the job from
    // the number's month instead, so "days open" reflects reality.
    const jnStart = (j.jn_year && j.jn_month) ? `${j.jn_year}-${String(j.jn_month).padStart(2, '0')}-01` : null;
    const gap = (jnStart && j.opened) ? Math.abs(days(jnStart) - days(j.opened)) : 0;
    const dateSuspect = !!(jnStart && j.opened && gap > 45);
    const raised = dateSuspect ? jnStart : (j.opened || jnStart);
    const ageDays = days(raised) || 0;
    const idleDays = days(j.last_work || raised) || 0;
    const oldestPending = pending.length ? days(pending[0].req_date) : null;

    // Why is it sitting? Most actionable reason first.
    let flag, reason;
    if (pending.length && oldestPending != null && oldestPending > 21) { flag = 'CRITICAL'; reason = `Waiting ${pending.length} part(s) — oldest request ${oldestPending} days ago`; }
    else if (!j.work_entries && ageDays > 14) { flag = 'CRITICAL'; reason = `Not started — open ${ageDays} days, no work logged`; }
    else if (idleDays > 30) { flag = 'CRITICAL'; reason = `No work for ${idleDays} days`; }
    else if (pending.length) { flag = 'WATCH'; reason = `Waiting ${pending.length} part(s)`; }
    else if (!j.work_entries) { flag = 'WATCH'; reason = `Not started — open ${ageDays} days`; }
    else if (idleDays > 7) { flag = 'WATCH'; reason = `No work for ${idleDays} days`; }
    else { flag = 'ACTIVE'; reason = `Worked ${idleDays} day(s) ago`; }

    return { ...j, raised, dateSuspect, jnStart, ageDays, idleDays, pending, pendingLines: pending.length,
      pendingQty: r2(pending.reduce((s, p) => s + (Number(p.pending) || 0), 0)),
      requestedCount, oldestPending, flag, reason };
  });

  const rank = { CRITICAL: 0, WATCH: 1, ACTIVE: 2 };
  out.sort((a, b) => (rank[a.flag] - rank[b.flag]) || (b.idleDays - a.idleDays) || (b.ageDays - a.ageDays));
  return { today, cut, months: Number(months) || 8, jobs: out };
}

router.get('/ongoing-jobs.xlsx', asyncHandler(async (req, res) => {
  const { jobs, cut, months } = ongoingJobs(req.query.months);
  const SRC = { head_office: 'Head Office', local_purchase: 'Local Purchase' };
  await sendXlsx(res, `ongoing-jobs-${cut}.xlsx`, [
    {
      name: 'Ongoing jobs',
      columns: [
        { header: 'Priority', key: 'flag', width: 10 }, { header: 'Delay reason', key: 'reason', width: 42 },
        { header: 'Job No', key: 'job_no', width: 15 }, { header: 'Vehicle', key: 'vehicle', width: 18 },
        { header: 'Machine', key: 'asset_type', width: 16 }, { header: 'Work requested', key: 'description', width: 50 },
        { header: 'Status', key: 'status', width: 13 }, { header: 'Raised (from job no)', key: 'raised', width: 18 },
        { header: 'Date on card', key: 'opened', width: 13 }, { header: 'Date looks wrong?', key: 'dateFlag', width: 16 },
        { header: 'Days open', key: 'ageDays', width: 10 }, { header: 'Last attended', key: 'last_work', width: 12 },
        { header: 'Idle days', key: 'idleDays', width: 10 }, { header: 'Hours', key: 'hours', width: 9 },
        { header: 'Items requested', key: 'requestedCount', width: 14 }, { header: 'Parts pending', key: 'pendingLines', width: 12 },
        { header: 'Qty pending', key: 'pendingQty', width: 11 }, { header: 'Cost so far (Rs)', key: 'total_cost', width: 15 },
        { header: 'Project', key: 'project_name', width: 20 },
      ],
      rows: jobs.map((j) => ({ ...j, vehicle: j.asset_reg || j.asset_code || '', last_work: j.last_work || 'never',
        dateFlag: j.dateSuspect ? 'YES — placeholder' : '' })),
    },
    {
      name: 'Parts still pending',
      columns: [
        { header: 'Job No', key: 'job_no', width: 15 }, { header: 'Vehicle', key: 'vehicle', width: 18 },
        { header: 'MRN No', key: 'mrn_no', width: 13 }, { header: 'Requested', key: 'req_date', width: 12 },
        { header: 'Waiting days', key: 'waiting', width: 12 }, { header: 'Item', key: 'description', width: 42 },
        { header: 'Purchase from', key: 'source', width: 16 }, { header: 'Qty', key: 'qty', width: 8 },
        { header: 'Received', key: 'qty_received', width: 10 }, { header: 'Pending', key: 'pending', width: 9 },
      ],
      rows: jobs.flatMap((j) => j.pending.map((p) => ({
        job_no: j.job_no, vehicle: j.asset_reg || j.asset_code || '',
        mrn_no: p.mrn_no, req_date: String(p.req_date || '').slice(0, 10),
        waiting: p.req_date ? Math.round((new Date() - new Date(String(p.req_date).slice(0, 10))) / 86400000) : '',
        description: p.description, source: SRC[p.source] || '', qty: p.qty, qty_received: p.qty_received, pending: p.pending,
      }))),
    },
  ]);
}));

router.get('/ongoing-jobs.html', asyncHandler((req, res) => {
  const { jobs, today, cut, months } = ongoingJobs(req.query.months);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const m = (n) => 'Rs ' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const d = (v) => (v ? String(v).slice(0, 10) : '');
  const SRC = { head_office: 'Head Office', local_purchase: 'Local Purchase' };
  const veh = (j) => [j.asset_reg, (j.asset_ec && j.asset_ec !== j.asset_reg) ? j.asset_ec : ''].filter(Boolean).join(' · ') || j.asset_code || '—';
  const C = jobs.filter((j) => j.flag === 'CRITICAL'), W = jobs.filter((j) => j.flag === 'WATCH'), A = jobs.filter((j) => j.flag === 'ACTIVE');
  const waitingParts = jobs.filter((j) => j.pendingLines > 0);

  const row = (j) => `<tr class="${j.flag.toLowerCase()}">
    <td><b>${esc(j.flag)}</b></td><td class="w">${esc(j.reason)}</td>
    <td>${esc(j.job_no)}</td><td>${esc(veh(j))}</td>
    <td class="w">${esc(String(j.description || '').slice(0, 80))}</td>
    <td>${esc(j.raised)}${j.dateSuspect ? ` <span class="sus" title="The card's recorded date is ${esc(j.opened)}, which does not match the job number's month — taken from the job number instead">*</span>` : ''}</td><td class="num">${j.ageDays}</td>
    <td>${j.last_work ? esc(j.last_work) : '<i>never</i>'}</td><td class="num"><b>${j.idleDays}</b></td>
    <td class="num">${j.pendingLines || '—'}</td><td class="num">${j.total_cost ? m(j.total_cost) : '—'}</td></tr>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Ongoing Jobs — delay watchlist</title>
<style>
  @page{size:A4 landscape;margin:10mm} body{font-family:Arial,sans-serif;color:#000;font-size:11px;margin:0}
  h1{font-size:19px;margin:0 0 2px} h2{font-size:13px;margin:14px 0 5px;border-bottom:2px solid #333;padding-bottom:3px}
  .sub{color:#444;margin-bottom:8px}
  table{width:100%;border-collapse:collapse;margin-bottom:8px}
  th,td{border:1px solid #999;padding:3px 5px;text-align:left;vertical-align:top}
  th{background:#eee} td.num,th.num{text-align:right;white-space:nowrap} td.w{white-space:normal}
  tr.critical td{background:#fdeaea} tr.watch td{background:#fff6e5}
  .sus{color:#b00;font-weight:bold} .note{font-size:10.5px;color:#444;margin:2px 0 10px}
  .tot{display:flex;flex-wrap:wrap;border:1px solid #000;margin-bottom:10px}
  .tot div{padding:6px 10px;border-right:1px solid #ccc;min-width:112px} .tot b{display:block;font-size:15px}
  .tot span{color:#555;font-size:10px;text-transform:uppercase;letter-spacing:.05em}
  button{padding:8px 14px;font-size:14px;margin:10px 0;cursor:pointer}
  @media print{.noprint{display:none}}
</style></head><body>
<button class="noprint" onclick="window.print()">🖨 Print / Save as PDF</button>
<h1>Edward &amp; Christie (Pvt) Ltd — Ongoing Jobs &amp; Delay Points</h1>
<div class="sub">All jobs still open, raised since <b>${esc(cut)}</b> (last ${months} months) · as at ${esc(today)} · ${jobs.length} job(s) · older never-closed jobs excluded</div>
<div class="tot">
  <div><span>Ongoing jobs</span><b>${jobs.length}</b></div>
  <div><span>Critical</span><b style="color:#b00">${C.length}</b></div>
  <div><span>Watch</span><b style="color:#a60">${W.length}</b></div>
  <div><span>Active</span><b style="color:#070">${A.length}</b></div>
  <div><span>Waiting on parts</span><b>${waitingParts.length}</b></div>
  <div><span>Never started</span><b>${jobs.filter((j) => !j.work_entries).length}</b></div>
  <div><span>Cost so far</span><b>${m(jobs.reduce((s, j) => s + j.total_cost, 0))}</b></div>
</div>
<h2>Delay watchlist — most critical first</h2>
<div class="note">“Raised” is taken from the job number (YYYY/M/…), which is the reliable record of when the card was written.
${jobs.filter((j) => j.dateSuspect).length} card(s) marked <span class="sus">*</span> carry a stored date that disagrees with their number — an import placeholder — so their age is measured from the job number instead.</div>
<table><thead><tr><th>Priority</th><th>Delay reason</th><th>Job No</th><th>Vehicle</th><th>Work requested</th><th>Raised</th><th class="num">Days open</th><th>Last attended</th><th class="num">Idle</th><th class="num">Parts pending</th><th class="num">Cost so far</th></tr></thead>
<tbody>${jobs.map(row).join('') || '<tr><td colspan="11" style="text-align:center;color:#666">No ongoing jobs.</td></tr>'}</tbody></table>
${waitingParts.length ? `<h2>What they are waiting for — outstanding spare parts (${waitingParts.reduce((s, j) => s + j.pendingLines, 0)} line(s))</h2>
<table><thead><tr><th>Job No</th><th>Vehicle</th><th>MRN No</th><th>Requested</th><th class="num">Waiting days</th><th>Item</th><th>Purchase from</th><th class="num">Qty</th><th class="num">Recv</th><th class="num">Pending</th></tr></thead>
<tbody>${waitingParts.flatMap((j) => j.pending.map((p) => {
    const w = p.req_date ? Math.round((new Date(today) - new Date(String(p.req_date).slice(0, 10))) / 86400000) : '';
    return `<tr class="${w > 21 ? 'critical' : ''}"><td>${esc(j.job_no)}</td><td>${esc(veh(j))}</td><td>${esc(p.mrn_no || '')}</td><td>${d(p.req_date)}</td><td class="num"><b>${w}</b></td><td class="w">${esc(p.description || '')}</td><td>${esc(SRC[p.source] || '')}</td><td class="num">${p.qty}</td><td class="num">${p.qty_received}</td><td class="num"><b>${p.pending}</b></td></tr>`;
  })).join('')}</tbody></table>` : ''}
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

router.get('/jobs-summary.html', asyncHandler((req, res) => {
  // No ?from= means every current-era job; a date narrows it to jobs touched since then.
  const from = MDATE.test(String(req.query.from || '')) ? req.query.from : null;
  const to = MDATE.test(String(req.query.to || '')) ? req.query.to : null;
  const withDetail = String(req.query.detail || '1') !== '0';
  const jobs = jobsAttended(from, to);

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const m = (n) => 'Rs ' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const d = (v) => (v ? String(v).slice(0, 10) : '');
  const SRC = { head_office: 'Head Office', local_purchase: 'Local Purchase' };
  const veh = (j) => [j.asset_reg, (j.asset_ec && j.asset_ec !== j.asset_reg) ? j.asset_ec : ''].filter(Boolean).join(' · ') || j.asset_code || '—';

  const T = jobs.reduce((a, j) => {
    const t = j.detail.totals;
    a.hours += t.hours; a.req += t.requested_qty; a.recv += t.received_qty; a.pend += t.pending_qty;
    a.labour += t.labour_cost; a.material += t.material_cost; a.oil += t.oil_cost; a.total += t.total_cost;
    a.unpriced += t.unpriced;
    if (j.status === 'CLOSED') a.closed++; else a.open++;
    return a;
  }, { hours: 0, req: 0, recv: 0, pend: 0, labour: 0, material: 0, oil: 0, total: 0, unpriced: 0, closed: 0, open: 0 });

  const summaryRows = jobs.map((j) => {
    const t = j.detail.totals;
    return `<tr>
      <td>${esc(j.job_no)}</td><td>${esc(veh(j))}</td>
      <td><span class="st">${esc(j.status)}</span></td>
      <td class="w">${esc(String(j.description || '').slice(0, 90))}</td>
      <td><b>${d(j.last_work) || '—'}</b></td>
      <td class="num">${t.hours}</td>
      <td class="num">${t.requested_qty || '—'}</td>
      <td class="num">${t.pending_qty ? '<b>' + t.pending_qty + '</b>' : '—'}</td>
      <td class="num">${m(t.total_cost)}</td></tr>`;
  }).join('') || '<tr><td colspan="9" style="text-align:center;color:#666">No jobs attended in this period.</td></tr>';

  const block = (j) => {
    const s = j.detail, t = s.totals;
    const tbl = (title, cols, rows, empty) => `<div class="sh">${esc(title)}</div><table>
      <thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.h)}</th>`).join('')}</tr></thead>
      <tbody>${rows || `<tr><td colspan="${cols.length}" style="color:#777">${esc(empty)}</td></tr>`}</tbody></table>`;
    return `<div class="job">
      <div class="jh"><b style="font-size:13px">${esc(j.job_no)}</b> &nbsp; <b>${esc(veh(j))}</b>${j.asset_type ? ' · ' + esc(j.asset_type) : ''}
        &nbsp;<span class="st">${esc(j.status)}</span>
        <div class="meta">Last attended: <b>${d(j.last_work) || '—'}</b> · opened ${d(j.requested_at) || '—'}${j.completed_at ? ' · closed ' + d(j.completed_at) : ''}${j.project_name ? ' · ' + esc(j.project_name) : ''} · ${t.hours} hrs</div>
        <div class="desc">${esc(j.description || '')}</div></div>
      ${tbl('Spare parts REQUESTED', [{ h: 'MRN No' }, { h: 'Date' }, { h: 'Item' }, { h: 'Purchase from' }, { h: 'Qty', num: true }, { h: 'Recv', num: true }, { h: 'Pending', num: true }],
        s.requested.map((r) => `<tr><td>${esc(r.mrn_no || '')}</td><td>${d(r.req_date)}</td><td>${esc(r.description || '')}</td><td><b>${esc(SRC[r.source] || '— not set —')}</b></td><td class="num">${r.qty}</td><td class="num">${r.qty_received}</td><td class="num">${r.pending > 0 ? '<b>' + r.pending + '</b>' : '—'}</td></tr>`).join(''), 'no spare parts requested')}
      ${tbl('Spare parts RECEIVED', [{ h: 'Delivered' }, { h: 'Item' }, { h: 'Purchase from' }, { h: 'Supplier' }, { h: 'Qty', num: true }, { h: 'Unit', num: true }, { h: 'Value', num: true }],
        s.received.map((g) => `<tr><td>${d(g.delivery_date)}</td><td>${esc(g.description || '')}</td><td>${esc(SRC[g.source] || '')}</td><td>${esc(g.supplier || '')}</td><td class="num">${g.qty}</td><td class="num">${g.unit_price == null ? 'awaiting' : m(g.unit_price)}</td><td class="num">${g.unit_price == null ? '—' : m((Number(g.qty) || 0) * g.unit_price)}</td></tr>`).join(''), 'nothing received')}
      ${tbl('What we did (daily work)', [{ h: 'Date' }, { h: 'Mechanic(s)' }, { h: 'Work done' }, { h: 'Hrs', num: true }],
        s.dailyWork.map((w) => `<tr><td>${d(w.work_date)}</td><td>${esc(w.mechanic || '—')}</td><td>${esc(w.description || '')}</td><td class="num">${w.hours || 0}</td></tr>`).join(''), 'no work logged')}
      <div class="jt">Labour ${m(t.labour_cost)} · Spares ${m(t.material_cost)} · Oil ${m(t.oil_cost)} · <b>Total ${m(t.total_cost)}</b>${t.unpriced ? ` · ${t.unpriced} receipt(s) awaiting price` : ''}</div>
    </div>`;
  };

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Jobs Attended — from ${esc(from)}</title>
<style>
  @page{size:A4;margin:11mm} body{font-family:Arial,sans-serif;color:#000;font-size:11.5px;margin:0}
  h1{font-size:19px;margin:0 0 2px} h2{font-size:14px;margin:16px 0 6px;border-bottom:2px solid #333;padding-bottom:3px}
  .sub{color:#444;margin-bottom:8px}
  table{width:100%;border-collapse:collapse;margin-bottom:8px}
  th,td{border:1px solid #999;padding:3px 6px;text-align:left;vertical-align:top}
  th{background:#eee} td.num,th.num{text-align:right;white-space:nowrap} td.w{white-space:normal}
  .tot{display:flex;flex-wrap:wrap;border:1px solid #000;margin-bottom:10px}
  .tot div{padding:6px 10px;border-right:1px solid #ccc;min-width:104px} .tot b{display:block;font-size:14px}
  .tot span{color:#555;font-size:10px;text-transform:uppercase;letter-spacing:.05em}
  .job{border:1px solid #666;padding:7px 9px;margin-bottom:9px;page-break-inside:avoid}
  .jh{margin-bottom:5px} .jh .st{color:#1d5a73;font-weight:bold}
  .meta{color:#333;font-size:11px;margin-top:2px} .desc{color:#444;font-size:11px;margin-top:2px;font-style:italic}
  .sh{font-weight:bold;font-size:11px;margin:6px 0 3px}
  .jt{border-top:1px solid #999;padding-top:4px;font-size:11px}
  button{padding:8px 14px;font-size:14px;margin:10px 0;cursor:pointer}
  @media print{.noprint{display:none}}
</style></head><body>
<button class="noprint" onclick="window.print()">🖨 Print / Save as PDF</button>
<h1>Edward &amp; Christie (Pvt) Ltd — Jobs Attended</h1>
<div class="sub">${from ? 'From <b>' + esc(from) + '</b>' + (to ? ' to <b>' + esc(to) + '</b>' : ' onward') : 'All current jobs (2026 onward)'} · ${jobs.length} job(s) · most recently attended first</div>
<div class="tot">
  <div><span>Jobs</span><b>${jobs.length}</b></div>
  <div><span>Still open</span><b>${T.open}</b></div>
  <div><span>Closed</span><b>${T.closed}</b></div>
  <div><span>Mechanic-hours</span><b>${r2(T.hours)}</b></div>
  <div><span>Items requested</span><b>${r2(T.req)}</b></div>
  <div><span>Received</span><b>${r2(T.recv)}</b></div>
  <div><span>Still pending</span><b>${r2(T.pend)}</b></div>
  <div><span>Labour</span><b>${m(T.labour)}</b></div>
  <div><span>Spares</span><b>${m(T.material)}</b></div>
  <div><span>TOTAL</span><b>${m(T.total)}</b></div>
</div>
<h2>Summary — one line per job</h2>
<table><thead><tr><th>Job No</th><th>Vehicle</th><th>Status</th><th>Work</th><th>Last worked</th><th class="num">Hrs</th><th class="num">Items req</th><th class="num">Pending</th><th class="num">Job total</th></tr></thead>
<tbody>${summaryRows}</tbody></table>
${withDetail ? '<h2>Job by job — parts requested, parts received, work done</h2>' + jobs.map(block).join('') : ''}
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

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
    // requested_at is what the approver is actually deciding on: a card raised three weeks ago and
    // one raised this morning need different answers, and the row used to show neither.
    out.transport = all(`SELECT j.id, j.job_no, j.requested_at, j.description,
             a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec
        FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id
        WHERE j.status = 'REQUESTED' AND j.approved_transport_at IS NULL AND j.is_historical = 0 ORDER BY j.id DESC LIMIT 50`);
  }
  if (has('operational_manager')) {
    out.ops = all(`SELECT j.id, j.job_no, j.requested_at, j.description,
             a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec
        FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id
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

  // --- the rest of the day's picture: cards opened / closed, what's still to do, stores in/out ---
  const VEH = 'a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec';
  const opened = all(
    `SELECT j.job_no, j.description, j.status, ${VEH}
       FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id
      WHERE substr(COALESCE(j.requested_at, j.created_at),1,10) = ? ORDER BY j.id`, date);
  const closed = all(
    `SELECT j.job_no, j.description, ${VEH}, COALESCE(j.total_cost,0) total_cost
       FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id
      WHERE j.status = 'CLOSED' AND substr(j.completed_at,1,10) = ? ORDER BY j.id`, date);

  // Still to do — open cards that are actually live: worked or raised within the last 30 days.
  // (open_total counts every open card so nothing is hidden by that window.)
  const pending = all(
    `SELECT j.job_no, j.description, j.status, ${VEH},
            substr(COALESCE(j.requested_at, j.created_at),1,10) AS since,
            CAST(julianday(?) - julianday(substr(COALESCE(j.requested_at, j.created_at),1,10)) AS INTEGER) AS age_days,
            (SELECT MAX(w.work_date) FROM job_daily_work w WHERE w.job_id = j.id) AS last_work
       FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id
      WHERE j.status NOT IN ('CLOSED','REJECTED')
        AND substr(COALESCE(j.requested_at, j.created_at),1,10) <= ?
        AND (
          substr(COALESCE(j.requested_at, j.created_at),1,10) >= date(?, '-30 day')
          OR EXISTS (SELECT 1 FROM job_daily_work w WHERE w.job_id = j.id AND w.work_date >= date(?, '-30 day') AND w.work_date <= ?)
        )
      ORDER BY age_days DESC, j.job_no`, date, date, date, date, date);
  const open_total = get(
    `SELECT COUNT(*) c FROM job_cards
      WHERE status NOT IN ('CLOSED','REJECTED') AND substr(COALESCE(requested_at, created_at),1,10) <= ?`, date).c;

  // Requested today (MRN lines raised) and received today (GRN deliveries).
  const requested = all(
    `SELECT m.mrn_no, ml.description, ml.qty, ml.category, a.code AS asset_code,
            COALESCE(ml.purchase_source, m.purchase_source) AS source
       FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id LEFT JOIN assets a ON a.id = m.asset_id
      WHERE substr(m.req_date,1,10) = ? ORDER BY m.mrn_no, ml.id`, date);
  const received = all(
    `SELECT g.description, g.qty, g.unit_price, g.supplier, m.mrn_no, a.code AS asset_code,
            COALESCE(g.purchase_source_norm, m.purchase_source) AS source
       FROM grn g LEFT JOIN mrn m ON m.id = g.mrn_id LEFT JOIN assets a ON a.id = m.asset_id
      WHERE substr(g.delivery_date,1,10) = ? ORDER BY g.id`, date);

  const total_labour = lab.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const total_material = issues.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_price) || 0), 0);
  const total_oil = oil.reduce((s, o) => s + Math.abs(Number(o.qty) || 0) * (Number(o.unit_price) || 0), 0);
  const total_external = jobs.reduce((s, j) => s + j.external, 0);
  const total_hours = jobs.reduce((s, j) => s + j.hours, 0);
  const received_value = received.reduce((s, g) => s + (Number(g.qty) || 0) * (Number(g.unit_price) || 0), 0);
  return {
    date, jobs, issues, oil, opened, closed, pending, requested, received,
    totals: {
      jobs: jobs.length, hours: r2(total_hours), labour: r2(total_labour), external: r2(total_external),
      material: r2(total_material), oil: r2(total_oil),
      opened: opened.length, closed: closed.length, pending: pending.length, open_total,
      requested: requested.length, received: received.length, received_value: r2(received_value),
      received_unpriced: received.filter((g) => g.unit_price == null).length,
      // Outside/external work is excluded from the day's cost total (owner tracks it as a personal value).
      grand: r2(total_labour + total_material + total_oil),
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
  const SRC = { head_office: 'Head Office', local_purchase: 'Local Purchase' };
  // Keep the printed sheet short — the longest-waiting open jobs are the ones worth chasing.
  const pendingShown = rep.pending.slice(0, 25);
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
<h1>Edward &amp; Christie (Pvt) Ltd — Daily Report</h1>
<div class="sub">Date: <b>${esc(date)}</b> · ${t.jobs} job(s) worked · ${t.hours} mechanic-hours</div>
<div class="tot">
  <div>Jobs worked<b>${t.jobs}</b></div>
  <div>Opened<b>${t.opened}</b></div><div>Closed<b>${t.closed}</b></div>
  <div>Still open<b>${t.open_total}</b></div>
  <div>Requested<b>${t.requested}</b></div><div>Received<b>${t.received}</b></div>
  <div>Labour<b>${m(t.labour)}</b></div><div>Material<b>${m(t.material)}</b></div>
  <div>Oil &amp; Lube<b>${m(t.oil)}</b></div>
  <div>Day total<b>${m(t.grand)}</b></div>
</div>
<h3>1. Work done today</h3>
<table><thead><tr><th>Job No</th><th>Vehicle</th><th>Mechanic(s)</th><th>Work done</th><th class="num">Hours</th><th class="num">Labour</th></tr></thead>
<tbody>${jobRows}</tbody></table>
<h3>2. Jobs opened today (${rep.opened.length})</h3>
<table><thead><tr><th>Job No</th><th>Vehicle</th><th>Complaint / work requested</th><th>Status</th></tr></thead><tbody>${
  rep.opened.map((j) => `<tr><td>${esc(j.job_no)}</td><td>${esc(veh(j))}</td><td>${esc(j.description || '')}</td><td>${esc(j.status)}</td></tr>`).join('')
  || '<tr><td colspan="4" style="text-align:center;color:#666">No new job cards opened.</td></tr>'}</tbody></table>
<h3>3. Jobs closed today (${rep.closed.length})</h3>
<table><thead><tr><th>Job No</th><th>Vehicle</th><th>Work done</th><th class="num">Job total</th></tr></thead><tbody>${
  rep.closed.map((j) => `<tr><td>${esc(j.job_no)}</td><td>${esc(veh(j))}</td><td>${esc(j.description || '')}</td><td class="num">${m(j.total_cost)}</td></tr>`).join('')
  || '<tr><td colspan="4" style="text-align:center;color:#666">No jobs closed.</td></tr>'}</tbody></table>
<h3>4. Still to do — open jobs (${rep.pending.length} active${t.open_total > rep.pending.length ? ` of ${t.open_total} open in total` : ''})</h3>
<table><thead><tr><th>Job No</th><th>Vehicle</th><th>Work to do</th><th>Status</th><th>Opened</th><th class="num">Days</th><th>Last worked</th></tr></thead><tbody>${
  pendingShown.map((j) => `<tr><td>${esc(j.job_no)}</td><td>${esc(veh(j))}</td><td>${esc(j.description || '')}</td><td>${esc(j.status)}</td><td>${esc(j.since || '')}</td><td class="num">${j.age_days}</td><td>${esc(j.last_work || '—')}</td></tr>`).join('')
  || '<tr><td colspan="7" style="text-align:center;color:#666">Nothing open.</td></tr>'}${
  rep.pending.length > pendingShown.length ? `<tr><td colspan="7" style="color:#555">…and ${rep.pending.length - pendingShown.length} more open job(s) — longest-waiting shown first; full list in Job Cards.</td></tr>` : ''}</tbody></table>
<h3>5. Items requested today (${rep.requested.length})</h3>
<table><thead><tr><th>MRN No</th><th>Vehicle</th><th>Item</th><th>Category</th><th class="num">Qty</th><th>Source</th></tr></thead><tbody>${
  rep.requested.map((r) => `<tr><td>${esc(r.mrn_no || '')}</td><td>${esc(r.asset_code || '')}</td><td>${esc(r.description || '')}</td><td>${esc(r.category || '')}</td><td class="num">${r.qty}</td><td>${esc(SRC[r.source] || '')}</td></tr>`).join('')
  || '<tr><td colspan="6" style="text-align:center;color:#666">No material requests raised.</td></tr>'}</tbody></table>
<h3>6. Items received today (${rep.received.length}${t.received_unpriced ? ` · ${t.received_unpriced} awaiting price` : ''})</h3>
<table><thead><tr><th>MRN No</th><th>Vehicle</th><th>Item</th><th class="num">Qty</th><th>Supplier</th><th>Source</th><th class="num">Value</th></tr></thead><tbody>${
  rep.received.map((g) => `<tr><td>${esc(g.mrn_no || '')}</td><td>${esc(g.asset_code || '')}</td><td>${esc(g.description || '')}</td><td class="num">${g.qty}</td><td>${esc(g.supplier || '')}</td><td>${esc(SRC[g.source] || '')}</td><td class="num">${g.unit_price == null ? 'awaiting price' : m((Number(g.qty) || 0) * g.unit_price)}</td></tr>`).join('')
  || '<tr><td colspan="7" style="text-align:center;color:#666">Nothing received.</td></tr>'}</tbody></table>
${rep.issues.length ? `<h3>7. Materials issued out (${rep.issues.length})</h3><table><thead><tr><th>Item</th><th>Job</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Value</th></tr></thead><tbody>${rep.issues.map((i) => `<tr><td>${esc(i.description)}</td><td>${esc(i.job_no || '')}</td><td class="num">${i.qty}</td><td class="num">${i.unit_price == null ? '—' : m(i.unit_price)}</td><td class="num">${m((Number(i.qty) || 0) * (Number(i.unit_price) || 0))}</td></tr>`).join('')}</tbody></table>` : ''}
${rep.oil.length ? `<h3>8. Oil &amp; lubricants issued (${rep.oil.length})</h3><table><thead><tr><th>Product</th><th>Job</th><th class="num">Qty</th><th class="num">Value</th></tr></thead><tbody>${rep.oil.map((o) => `<tr><td>${esc(o.product)}</td><td>${esc(o.job_no || '')}</td><td class="num">${Math.abs(Number(o.qty) || 0)}</td><td class="num">${m(Math.abs(Number(o.qty) || 0) * (Number(o.unit_price) || 0))}</td></tr>`).join('')}</tbody></table>` : ''}
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
const MONTHLY_SHEETS = ['fuel', 'other', 'salary', 'daily_outside'];

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
  const { parts, total } = await monthlyReport.buildWorkbook(year, month);
  const repCLab = parts.repair.closed_total - (parts.repair.closed_jobs.reduce((a, b) => a + (num(b.material) + num(b.oil) + num(b.general) + num(b.other)), 0));
  const repPLab = parts.repair.pending_jobs.reduce((a, b) => a + num(b.labour), 0);
  const repCOut = parts.repair.closed_jobs.reduce((a, b) => a + num(b.outside_estimate), 0);
  const repPOut = parts.repair.pending_jobs.reduce((a, b) => a + num(b.outside_estimate), 0);
  const repOLab = num(parts.repair.other_labour_total);
  const repOOut = num(parts.repair.other_labour_outside);
  const svcLab = parts.service.sums.labour;
  const svcOut = parts.service.sums.outsideWithTrn;
  const totOurLab = repCLab + repPLab + repOLab + svcLab;
  const totOutEst = repCOut + repPOut + repOOut + svcOut;
  const totSaving = totOutEst - totOurLab;
  const savingPct = totOutEst > 0 ? (totSaving / totOutEst) : 0;

  const totWages = parts.salaries.sums.total;
  const totVehicles = parts.fuel.sums.cost + parts.fuel.sums.rental;
  const totOverheads = parts.other.sums.total;
  const totAbsorbed = totWages + totVehicles + totOverheads;
  const absorbedSaving = totOutEst - totAbsorbed;
  const absorbedPct = totOutEst > 0 ? (absorbedSaving / totOutEst) : 0;

  const preview = {
    profit_loss: {
      is_profit: absorbedSaving >= 0,
      saving_amount: Math.abs(absorbedSaving),
      saving_pct: Math.abs(absorbedPct),
      in_house_cost: totAbsorbed,
      outside_cost: totOutEst,
    },
    repair: {
      count: parts.repair.count, total: parts.repair.sums.total,
      closed_count: parts.repair.closed_count, closed_total: parts.repair.closed_total,
      pending_count: parts.repair.pending_count, pending_total: parts.repair.pending_total,
      other_labour_count: parts.repair.other_labour_count, other_labour_total: parts.repair.other_labour_total,
      spares_supply_count: parts.repair.spares_supply_count, spares_supply_total: parts.repair.spares_supply_total,
    },
    service: { count: parts.service.count, total: parts.service.sums.total },
    tyre: { count: parts.tyre.count, total: parts.tyre.sums.total },
    battery: { count: parts.battery.count, total: parts.battery.sums.total },
    oils: { count: parts.oils.count, total: parts.oils.sums.total, job_oil: parts.oils.job_oil, service_oil: parts.oils.service_oil },
    general: { count: parts.general.count, total: parts.general.sums.total, priced: parts.general.priced },
    fuel: { count: parts.fuel.count, total: parts.fuel.sums.cost },
    salary: { count: parts.salaries.count, staff_total: parts.salaries.sums.total, mechanic_total: parts.salaries.mechanic_total },
    other: { count: parts.other.count, total: parts.other.sums.total },
    total_cost: {
      our_labour: total.columns ? total.columns[3] : 0,
      materials: total.columns ? (total.columns[5] + total.columns[6] + total.columns[7]) : 0,
      overheads: total.columns ? total.columns[8] : 0,
      sundry: total.columns ? total.columns[9] : 0,
      grand_total: total.grand_total,
    },
    material_summary: {
      spares: parts.repair.sums.material,
      filters: parts.service.sums.filter,
      oils: parts.repair.sums.oil + parts.service.sums.oil + parts.oils.sums.total,
      tyres: parts.tyre.sums.total,
      batteries: parts.battery.sums.total,
      general: parts.general.sums.total,
      total_material: parts.repair.sums.material + parts.service.sums.filter + parts.repair.sums.oil + parts.service.sums.oil + parts.oils.sums.total + parts.tyre.sums.total + parts.battery.sums.total + parts.general.sums.total,
    },
    cost_comparison: {
      our_labour: totOurLab,
      outside_estimate: totOutEst,
      saving: totSaving,
      saving_pct: savingPct,
    },
    job_wise_comparison: {
      total_jobs: parts.repair.count + parts.service.count,
      labour_cost: totOurLab,
      outside_estimate: totOutEst,
      saving: totSaving,
    },
    grand_total: total.grand_total,
  };
  // Lists that drive the manual "outside labour price" editors — the month's daily-work vehicles and
  // service jobs, each with our labour and the currently-saved outside price.
  const daily_work = (parts.repair.other_labour || []).map((o) => ({ vehicle: o.reg, labour: num(o.labour), outside: num(o.outside) }));
  const service_jobs = (parts.service.service_jobs || []).map((s) => ({
    id: s.id, job_no: s.job_no, vehicle: s.reg || s.code || s.vehicle_label || '',
    labour: num(s.labour), outside: num(s.outside_estimate),
  }));
  res.json({ year, month, inputs, preview, daily_work, service_jobs });
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

// Save manual outside-labour prices for service jobs (service_jobs.outside_estimate). The daily-work
// outside prices ride on monthly_report_inputs (sheet 'daily_outside'); service prices live on the
// service row itself, so they get their own tiny endpoint. Body: { items: [{ id, outside }] }.
router.post('/service-outside', requireAuth, asyncHandler((req, res) => {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  let saved = 0;
  tx(() => {
    for (const it of items) {
      const id = toInt(it && it.id); if (!id) continue;
      const val = (it.outside == null || it.outside === '') ? null : toNum(it.outside);
      run('UPDATE service_jobs SET outside_estimate = ? WHERE id = ?', val, id);
      saved++;
    }
  });
  res.json({ ok: true, saved });
}));

// Monthly Repair Detail — an itemized "bill" for every repair job in the month (same Closed +
// Pending set as the report's Repair sheet), each broken into its labour / parts / oil / general
// line items with a per-job total and a grand total. Outside/external work cost is excluded
// (owner tracks it as a personal value). Printable / save-as-PDF.
router.get('/monthly-repair-detail.html', requireAuth, asyncHandler((req, res) => {
  const year = toInt(req.query.year), month = toInt(req.query.month);
  if (!validPeriod(year, month)) return res.status(400).send('year (YYYY) and month (1-12) are required');
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const period = `${monthlyReport.MONTHS[month]} ${year}`;
  // Order both sections by JOB NUMBER, lowest to highest. Job numbers are YEAR/MONTH/R/SEQ,
  // so compare each "/"-segment numerically (a plain string sort would place /R/10 before /R/2,
  // and 2026/6 before 2026/10 wrongly). Pure-numeric segments are zero-padded for the compare;
  // non-numeric segments (e.g. the "R", legacy refs) fall back to case-insensitive text order.
  const jobNoKey = (s) => String(s || '').split('/').map((t) => { t = t.trim(); return /^\d+$/.test(t) ? t.padStart(10, '0') : t.toLowerCase(); });
  const byJobNo = (a, b) => {
    const ka = jobNoKey(a.job_no), kb = jobNoKey(b.job_no);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const x = ka[i] || '', y = kb[i] || '';
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };
  const sparesIds = all(`SELECT id FROM job_cards
      WHERE substr(COALESCE(completed_at, requested_at, created_at),1,7) = ?
        AND (description LIKE 'Stores materials%' OR description LIKE 'auto-created container%' OR description LIKE 'Spares Supply%')
      ORDER BY completed_at, id`, ym).map((r) => r.id);

  const usedIds = [...closedIds, ...pendingIds, ...sparesIds];
  const usedIdsStr = usedIds.length > 0 ? usedIds.join(',') : '0';

  const otherLabour = all(`
    SELECT COALESCE(a.type, '') atype,
           COALESCE(a.registration, a.code, l.mechanic, 'Unassigned') reg,
           a.ec_code ec,
           p.name project,
           GROUP_CONCAT(DISTINCT j.description) desc,
           SUM(l.amount) labour
      FROM job_labour l
      LEFT JOIN job_cards j ON j.id = l.job_id
      LEFT JOIN assets a ON a.id = j.asset_id
      LEFT JOIN projects p ON p.id = j.project_id
     WHERE substr(l.work_date,1,7) = ?
       AND (l.job_id IS NULL OR l.job_id NOT IN (${usedIdsStr}))
     GROUP BY COALESCE(a.registration, a.code, l.mechanic)
     HAVING labour > 0
     ORDER BY labour DESC
  `, ym);

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const money = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const n2 = (n) => (Number(n) || 0).toLocaleString('en-US');
  const g = { labour: 0, material: 0, oil: 0, other: 0, total: 0, jobs: 0 };

  const renderJob = (id, se) => {
    const s = costSheet(id);
    if (!s) return '';
    const j = s.job;
    const other = (Number(j.general_cost) || 0) + (Number(j.other_cost) || 0);
    const total = (Number(j.labour_cost) || 0) + (Number(j.material_cost) || 0) + (Number(j.oil_cost) || 0) + other;
    g.labour += Number(j.labour_cost) || 0; g.material += Number(j.material_cost) || 0; g.oil += Number(j.oil_cost) || 0;
    g.other += other; g.total += total; g.jobs++;
    const line = (type, item, qty, rate, amt) => `<tr><td>${type}</td><td>${esc(item)}</td><td class="num">${qty}</td><td class="num">${rate}</td><td class="num">${money(amt)}</td></tr>`;
    const rows = [];
    for (const l of s.labour_lines) rows.push(line('Labour', (l.mechanic || '') + (l.work_date ? ` · ${String(l.work_date).slice(0, 10)}` : ''), n2(l.hours), money(l.rate), l.amount));
    for (const p of s.part_lines) rows.push(line('Part', p.description || '', n2(p.qty), money(p.unit_price), (Number(p.qty) || 0) * (Number(p.unit_price) || 0)));
    for (const o of s.oil_lines) rows.push(line('Oil', (o.product_name || '') + (o.unit ? ` (${o.unit})` : ''), n2(Math.abs(o.qty)), money(o.unit_price), Math.abs(Number(o.qty) || 0) * (Number(o.unit_price) || 0)));
    for (const gl of s.general_lines) rows.push(line('General', gl.item_name || '', n2(Math.abs(gl.qty)), money(gl.unit_price), Math.abs(Number(gl.qty) || 0) * (Number(gl.unit_price) || 0)));
    const body = rows.join('') || '<tr><td colspan="5" class="muted">No line items recorded.</td></tr>';
    return `<div class="job">
      <div class="jh"><b>${se}. Job ${esc(j.job_no)}</b> — ${esc(s.asset_code || '')}${j.project_name ? ` · ${esc(j.project_name)}` : ''} · <span class="st">${esc(j.status)}</span> · ${esc(String(j.completed_at || j.requested_at || '').slice(0, 10))}
        ${j.description ? `<div class="desc">${esc(j.description)}</div>` : ''}</div>
      <table class="det"><thead><tr><th>Type</th><th>Item / Description</th><th class="num">Qty</th><th class="num">Rate/Price</th><th class="num">Amount</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr class="jt"><td colspan="4">Job total — Labour ${money(j.labour_cost)} · Spare ${money(j.material_cost)} · Lube ${money(j.oil_cost)} · Other ${money(other)}</td><td class="num"><b>${money(total)}</b></td></tr></tfoot>
      </table></div>`;
  };

  const renderOtherLabour = () => {
    if (!otherLabour.length) return '<p class="muted">None.</p>';
    const rows = otherLabour.map((ol, i) => {
      g.labour += Number(ol.labour) || 0; g.total += Number(ol.labour) || 0;
      return `<tr><td>${i + 1}</td><td>${esc(ol.atype || '')}</td><td><b>${esc(ol.reg || '')}</b></td><td>${esc(ol.ec || '')}</td><td>${esc(ol.project || '')}</td><td>${esc(ol.desc || '')}</td><td class="num">${money(ol.labour)}</td></tr>`;
    }).join('');
    return `<table class="det"><thead><tr><th>#</th><th>Type</th><th>Vehicle</th><th>EC</th><th>Project</th><th>Description</th><th class="num">Labour Cost</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  };

  const section = (title, ids) => `<h2>${esc(title)} (${ids.length})</h2>${ids.length ? ids.map((id, i) => renderJob(id, i + 1)).join('') : '<p class="muted">None.</p>'}`;
  const closedHtml = section('Closed Jobs — completed & closed in ' + period, closedIds);
  const pendingHtml = section('Pending Jobs — repairs still in progress as of ' + period + ' (newest start first)', pendingIds);
  const sparesHtml = section('Spares Supply — stores materials issued (spare parts only, no repair) in ' + period, sparesIds);
  const otherHtml = `<h2>Other Labour — daily work in ${esc(period)} not on a job above (${otherLabour.length} vehicles)</h2>${renderOtherLabour()}`;

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
${otherHtml}
${sparesHtml}
<div class="grand"><table>
  <tr><td>Labour</td><td class="num">${money(g.labour)}</td></tr>
  <tr><td>Spare parts</td><td class="num">${money(g.material)}</td></tr>
  <tr><td>Lubricant</td><td class="num">${money(g.oil)}</td></tr>
  <tr><td>Other material</td><td class="num">${money(g.other)}</td></tr>
  <tr class="tot"><td>Grand total (${g.jobs} jobs)</td><td class="num">${money(g.total)}</td></tr>
</table></div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

module.exports = router;

// ---------------------------------------------------------------------------
// Daily reports — Pending Parts and the Maintenance Summery job record.
// Each day's copy is frozen so it still reads the same later, and the narrative
// columns carry forward until the supervisor edits them.
// ---------------------------------------------------------------------------
const daily = require('../lib/daily_reports');
const KINDS = ['pending_parts', 'job_summary', 'pending_price'];
const kindOf = (v) => (KINDS.includes(v) ? v : null);

// Today's live figures, or a saved day if one exists for that date.
router.get('/daily/:kind', requireAuth, asyncHandler((req, res) => {
  const kind = kindOf(req.params.kind);
  if (!kind) return res.status(404).json({ error: 'Unknown report' });
  const date = String(req.query.date || '').slice(0, 10) || null;
  const today = new Date().toISOString().slice(0, 10);
  // TODAY is always live and editable — the scheduler freezes a copy every hour, and reading
  // that copy back would leave the supervisor looking at a read-only sheet for the day they are
  // actually working on. Earlier days read their frozen copy, which is the point of keeping one.
  const isToday = !date || date === today;
  const saved = (!isToday && date) ? daily.readSnapshot(kind, date) : null;
  if (saved && !req.query.live) {
    return res.json({ ...saved.data, saved: true, generated_at: saved.generated_at, row_count: saved.row_count });
  }
  const lastSave = get('SELECT generated_at FROM daily_report_snapshots WHERE kind = ? AND report_date = ?', kind, date || today);
  res.json({ ...daily.build(kind, { asOf: date }), saved: false, last_saved_at: lastSave ? lastSave.generated_at : null });
}));

// Freeze the day. Running it again the same day replaces the copy, so it always holds the latest.
router.post('/daily/:kind/save', requireAuth, asyncHandler((req, res) => {
  const kind = kindOf(req.params.kind);
  if (!kind) return res.status(404).json({ error: 'Unknown report' });
  const snap = daily.snapshot(kind, { asOf: req.body && req.body.date, userId: req.user.id });
  res.json({ ok: true, ...snap });
}));

router.get('/daily/:kind/history', requireAuth, asyncHandler((req, res) => {
  const kind = kindOf(req.params.kind);
  if (!kind) return res.status(404).json({ error: 'Unknown report' });
  res.json(daily.history(kind, toInt(req.query.limit, 60)));
}));

// Its own path rather than "/daily/:kind.xlsx": that form is matched by the "/daily/:kind"
// route above with kind = "pending_parts.xlsx", which then fails the whitelist and 404s.
router.get('/daily/:kind/export.xlsx', requireAuth, asyncHandler(async (req, res) => {
  const kind = kindOf(req.params.kind);
  if (!kind) return res.status(404).send('Unknown report');
  const date = String(req.query.date || '').slice(0, 10) || null;
  const saved = date ? daily.readSnapshot(kind, date) : null;
  const data = saved && !req.query.live ? saved.data : daily.build(kind, { asOf: date });
  const wb = daily.workbookFor(kind, data);
  const name = kind === 'pending_parts' ? 'Pending parts' : 'Job report';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name} ${data.as_of}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

// The supervisor's running notes for a job — they persist and carry into every later day.
router.put('/daily/job-summary/notes/:jobId', requireAuth,
  require('../lib/auth').requireRole('workshop', 'operational_manager', 'manager', 'storekeeper'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.jobId);
    if (!get('SELECT 1 v FROM job_cards WHERE id = ?', id)) return res.status(404).json({ error: 'Job not found' });
    const b = req.body || {};
    const clean = (v) => (v == null ? null : String(v).trim().slice(0, 2000) || null);
    run(`INSERT INTO job_summary_notes (job_id, completed_repairs, pending_repairs, job_status, spare_parts, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           completed_repairs = excluded.completed_repairs, pending_repairs = excluded.pending_repairs,
           job_status = excluded.job_status, spare_parts = excluded.spare_parts,
           updated_at = datetime('now'), updated_by = excluded.updated_by`,
      id, clean(b.completed_repairs), clean(b.pending_repairs), clean(b.job_status), clean(b.spare_parts), req.user.id);
    res.json({ ok: true, notes: get('SELECT * FROM job_summary_notes WHERE job_id = ?', id) });
  }));

router.put('/daily/pending-parts/notes/:lineId', requireAuth,
  require('../lib/auth').requireRole('workshop', 'operational_manager', 'manager', 'storekeeper'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.lineId);
    if (!get('SELECT 1 v FROM mrn_lines WHERE id = ?', id)) return res.status(404).json({ error: 'Request line not found' });
    const remarks = req.body && req.body.remarks != null ? String(req.body.remarks).trim().slice(0, 500) || null : null;
    run(`INSERT INTO pending_part_notes (mrn_line_id, remarks, updated_by) VALUES (?, ?, ?)
         ON CONFLICT(mrn_line_id) DO UPDATE SET remarks = excluded.remarks,
           updated_at = datetime('now'), updated_by = excluded.updated_by`, id, remarks, req.user.id);
    res.json({ ok: true });
  }));

// A remark against a receipt still waiting for its price ("invoice chased", "supplier to confirm").
router.put('/daily/pending-price/notes/:grnId', requireAuth,
  require('../lib/auth').requireRole('workshop', 'operational_manager', 'manager', 'storekeeper'),
  asyncHandler((req, res) => {
    const id = toInt(req.params.grnId);
    if (!get('SELECT 1 v FROM grn WHERE id = ?', id)) return res.status(404).json({ error: 'Receipt not found' });
    const remarks = req.body && req.body.remarks != null ? String(req.body.remarks).trim().slice(0, 500) || null : null;
    run(`INSERT INTO receipt_price_notes (grn_id, remarks, updated_by) VALUES (?, ?, ?)
         ON CONFLICT(grn_id) DO UPDATE SET remarks = excluded.remarks,
           updated_at = datetime('now'), updated_by = excluded.updated_by`, id, remarks, req.user.id);
    res.json({ ok: true });
  }));
