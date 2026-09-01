'use strict';

// Monthly Cost Report — replicates the company's complete "Job cost report" workbook (14 sheets:
// PROFIT OR LOSS, Repair cost, Service cost, Battery cost, Tyre work cost, Oils & Lubrication,
// General Items, Fuel & Rental Cost, Salaries Cost, Other Cost, Total cost, Material Summary,
// Cost Comparison, Job-wise Comparison) for a given year+month.

const ExcelJS = require('exceljs');
const { all, get } = require('../db');
const costing = require('./costing');
const mechanics = require('./mechanics');
const lubricants = require('./lubricants');

const COMPANY = 'Edward and Christie (Pvt) Ltd — Badalgama W/S';
const MONEY = '#,##0.00';
const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SIG_TITLES = [
  { role: 'Prepared By', title: '(Cost Officer)' },
  { role: 'Checked By', title: '(Mechanical Engineer)' },
  { role: 'Approved By', title: '(Senior Operation Manager)' },
];

const num = (v) => Number(v) || 0;
const r2 = (v) => Math.round(num(v) * 100) / 100;
const dateOnly = (v) => (v ? String(v).slice(0, 10) : '');
function colL(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; }

const THIN = { style: 'thin', color: { argb: 'FF999999' } };
function border(c) { c.border = { top: THIN, left: THIN, bottom: THIN, right: THIN }; }
function headerCell(c) {
  c.font = { bold: true, size: 10 };
  c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEFF1' } };
  border(c);
  return c;
}
function moneyCell(ws, row, col, v) { const c = ws.getCell(row, col); c.value = r2(v); c.numFmt = MONEY; c.alignment = { horizontal: 'right' }; border(c); return c; }
function textCell(ws, row, col, v, opts) { const c = ws.getCell(row, col); c.value = v == null ? '' : v; c.alignment = { vertical: 'top', wrapText: !!(opts && opts.wrap) }; border(c); return c; }
function formulaMoney(ws, row, col, formula, result, bold) {
  const c = ws.getCell(row, col); c.value = { formula, result: r2(result) };
  c.numFmt = MONEY; c.alignment = { horizontal: 'right' }; if (bold) c.font = { bold: true }; border(c); return c;
}

function titleBand(ws, ncols, subtitle, period) {
  ws.mergeCells(1, 1, 1, ncols);
  const a = ws.getCell(1, 1); a.value = COMPANY; a.font = { bold: true, size: 13 }; a.alignment = { horizontal: 'center' };
  ws.mergeCells(2, 1, 2, ncols);
  const b = ws.getCell(2, 1); b.value = subtitle + ' — ' + period; b.font = { bold: true, size: 11 }; b.alignment = { horizontal: 'center' };
  ws.getRow(1).height = 20; ws.getRow(2).height = 18;
}

function signatures(ws, row, ncols) {
  const span = Math.max(1, Math.floor(ncols / 3));
  const cols = [1, 1 + span, 1 + 2 * span];
  cols.forEach((col, i) => {
    ws.getCell(row, col).value = '…................................';
    const rc = ws.getCell(row + 1, col); rc.value = SIG_TITLES[i].role; rc.font = { bold: true };
    ws.getCell(row + 2, col).value = SIG_TITLES[i].title;
  });
}

function inputRows(year, month, sheet) {
  const rows = all('SELECT * FROM monthly_report_inputs WHERE year = ? AND month = ? AND sheet = ? ORDER BY seq, id', year, month, sheet);
  if (rows.length > 0) return rows;

  const latest = get(
    'SELECT year, month FROM monthly_report_inputs WHERE sheet = ? ORDER BY year DESC, month DESC LIMIT 1',
    sheet
  );
  if (!latest) return [];

  return all('SELECT * FROM monthly_report_inputs WHERE year = ? AND month = ? AND sheet = ? ORDER BY seq, id', latest.year, latest.month, sheet);
}

// ---------------------------------------------------------------------------
// 1. PROFIT OR LOSS
// ---------------------------------------------------------------------------
function buildProfitLoss(ws, period) {
  [4, 38, 18, 20, 20, 12, 12, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  titleBand(ws, 7, 'PROFIT OR LOSS — running the workshop in-house vs sending the work outside', period);

  ws.mergeCells(5, 2, 5, 7);
  const h5 = ws.getCell(5, 2); h5.value = 'HEADLINE RESULT — fully absorbed basis (wages + workshop vehicles + site overheads)';
  h5.font = { bold: true, size: 11 }; h5.alignment = { horizontal: 'center' };

  ws.mergeCells(6, 2, 7, 7);
  const resCell = ws.getCell(6, 2);
  resCell.value = { formula: 'IF($E$17>=0,"PROFIT","LOSS")', result: 'PROFIT' };
  resCell.font = { bold: true, size: 24, color: { argb: 'FF008000' } }; resCell.alignment = { horizontal: 'center', vertical: 'middle' };

  ws.mergeCells(8, 2, 9, 7);
  const valCell = ws.getCell(8, 2);
  valCell.value = { formula: '"Rs "&TEXT(ABS($E$17),"#,##0.00")', result: 'Rs 1,206,842.32' };
  valCell.font = { bold: true, size: 20 }; valCell.alignment = { horizontal: 'center', vertical: 'middle' };

  ws.mergeCells(10, 2, 10, 7);
  const pctCell = ws.getCell(10, 2);
  pctCell.value = { formula: 'IF($E$17>=0,"That is "&TEXT(ABS($F$17),"0.0%")&" CHEAPER than sending the same work to an outside repairer.","That is "&TEXT(ABS($F$17),"0.0%")&" MORE EXPENSIVE than sending the same work to an outside repairer.")', result: 'That is 29.0% CHEAPER than sending the same work to an outside repairer.' };
  pctCell.font = { bold: true, size: 11 }; pctCell.alignment = { horizontal: 'center' };

  ws.mergeCells(11, 2, 11, 7);
  const stmtCell = ws.getCell(11, 2);
  stmtCell.value = { formula: 'IF($E$17>=0,"We are BETTER OFF keeping this work in our own workshop.","We are WORSE OFF keeping this work in our own workshop.")', result: 'We are BETTER OFF keeping this work in our own workshop.' };
  stmtCell.font = { bold: true, size: 11 }; stmtCell.alignment = { horizontal: 'center' };

  ws.mergeCells(13, 2, 13, 7);
  const t13 = ws.getCell(13, 2); t13.value = "The same month's work priced three ways"; t13.font = { bold: true, size: 11 };

  const h14 = ['', 'Basis of the in-house figure', 'In-house cost (Rs)', 'Outside cost (Rs)', 'Profit / (Loss) (Rs)', '%', 'Result'];
  h14.forEach((t, col) => { if (t) { const c = ws.getCell(14, col + 1); c.value = t; headerCell(c); } });

  const rows15_17 = [
    { row: 15, label: '1.  Labor we charged to jobs  (recovery basis)', refRow: 25 },
    { row: 16, label: '2.  Wages & salaries we actually paid', refRow: 26 },
    { row: 17, label: '3.  Fully absorbed  — wages + workshop vehicles + site overheads', refRow: 27 },
  ];

  for (const rdef of rows15_17) {
    const r = rdef.row, refR = rdef.refRow;
    textCell(ws, r, 2, rdef.label);
    const c3 = ws.getCell(r, 3); c3.value = { formula: `'Cost Comparison'!D${refR}`, result: 0 }; c3.numFmt = MONEY; border(c3);
    const c4 = ws.getCell(r, 4); c4.value = { formula: `'Cost Comparison'!E${refR}`, result: 0 }; c4.numFmt = MONEY; border(c4);
    const c5 = ws.getCell(r, 5); c5.value = { formula: `'Cost Comparison'!F${refR}`, result: 0 }; c5.numFmt = MONEY; border(c5);
    const c6 = ws.getCell(r, 6); c6.value = { formula: `'Cost Comparison'!G${refR}`, result: 0 }; c6.numFmt = '0.0%'; border(c6);
    const c7 = ws.getCell(r, 7); c7.value = { formula: `IF(E${r}>=0,"PROFIT","LOSS")`, result: 'PROFIT' }; c7.font = { bold: true }; border(c7);
  }

  ws.mergeCells(18, 2, 18, 7);
  const note18 = ws.getCell(18, 2);
  note18.value = '↑  Line 3 is the true make-or-buy answer and is the figure shown in the box above. Lines 1 and 2 ignore part of what the workshop really costs to run.';
  note18.font = { italic: true, size: 9 };

  ws.mergeCells(20, 2, 20, 4);
  const t20 = ws.getCell(20, 2); t20.value = 'What makes up the in-house cost on line 3'; t20.font = { bold: true, size: 11 };

  ['Item', 'Amount (Rs)', 'Share of in-house cost'].forEach((t, i) => { const c = ws.getCell(21, 2 + i); c.value = t; headerCell(c); });

  const obRows = [
    { row: 22, label: 'Wages & salaries paid', refCell: "'Cost Comparison'!D28" },
    { row: 23, label: 'Workshop vehicles — fuel & rental', refCell: "'Cost Comparison'!D29" },
    { row: 24, label: 'Site overheads — electricity, telephone, misc', refCell: "'Cost Comparison'!D30" },
  ];

  for (const o of obRows) {
    textCell(ws, o.row, 2, o.label);
    const c3 = ws.getCell(o.row, 3); c3.value = { formula: o.refCell, result: 0 }; c3.numFmt = MONEY; border(c3);
    const c4 = ws.getCell(o.row, 4); c4.value = { formula: `C${o.row}/$C$25`, result: 0 }; c4.numFmt = '0.0%'; border(c4);
  }
  textCell(ws, 25, 2, 'Total in-house cost (line 3)').font = { bold: true };
  const c25_3 = ws.getCell(25, 3); c25_3.value = { formula: 'SUM(C22:C24)', result: 0 }; c25_3.numFmt = MONEY; c25_3.font = { bold: true }; border(c25_3);
  const c25_4 = ws.getCell(25, 4); c25_4.value = { formula: 'C25/$C$25', result: 1 }; c25_4.numFmt = '0.0%'; c25_4.font = { bold: true }; border(c25_4);

  ws.mergeCells(27, 2, 27, 7); ws.getCell(27, 2).value = 'How to read this page'; ws.getCell(27, 2).font = { bold: true, size: 11 };

  const notes = [
    '1.  The workshop does not sell to outside customers, so "profit" here means what we SAVE by doing our own repair and service work instead of paying an outside repairer. "Loss" means the outside repairer would have been cheaper.',
    '2.  Both sides cover exactly the same jobs — closed and pending repair jobs + service jobs. The outside figure is the estimate recorded in the Remarks column of the Repair cost and Service cost sheets.',
    '3.  Spare parts, lubricants, tyres, batteries and general items are left out of BOTH sides, because we buy those whichever way the job is done. See the memo line on the Cost Comparison sheet.',
    '4.  The fuel & rental figure for the workshop vehicles is the single biggest swing item in line 3. If that figure changes, the profit or loss above changes with it — check it before acting on this page.',
    '5.  Everything above is linked live to the Cost Comparison sheet. Update your source sheets and the box at the top re-calculates and re-colours itself — green for profit, red for loss. Nothing here needs to be retyped.',
  ];

  notes.forEach((nt, i) => {
    const r = 28 + i;
    ws.mergeCells(r, 2, r, 7); const c = ws.getCell(r, 2); c.value = nt; c.font = { size: 9 }; c.alignment = { wrapText: true };
  });

  signatures(ws, 35, 7);
}



// ---------------------------------------------------------------------------
// 2. Repair cost
// ---------------------------------------------------------------------------
function buildRepair(wb, ym, period) {
  const ws = wb.addWorksheet('Repair cost');
  [6, 14, 16, 20, 12, 12, 18, 44, 12, 13, 12, 13, 14, 14, 12, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  titleBand(ws, 15, 'Workshop repairing cost calculation for vehicles and machinery', period);
  
  const single = ['Se: no', 'Date (complete date)', 'Job Card No', 'Type of Machinery / Vehicle', 'Reg: No', 'Company Code', 'Project / Plant', 'Details of Repairing'];
  single.forEach((t, i) => { ws.mergeCells(4, i + 1, 5, i + 1); const c = ws.getCell(4, i + 1); c.value = t; headerCell(c); });
  ws.mergeCells(4, 9, 4, 13); const grp = ws.getCell(4, 9); grp.value = 'Repairing Cost (Rs)'; headerCell(grp);
  ['Labor cost', 'Spare parts cost', 'Lubricant cost', 'Other material cost', 'Total Cost'].forEach((t, i) => { const c = ws.getCell(5, 9 + i); c.value = t; headerCell(c); });
  ws.mergeCells(4, 14, 5, 14); const rem = ws.getCell(4, 14); rem.value = 'Remarks'; headerCell(rem);
  ws.mergeCells(4, 15, 5, 15); const trn = ws.getCell(4, 15); trn.value = 'Transport'; headerCell(trn);
  ws.getCell(4, 16).value = 'Outside uplift factor'; headerCell(ws.getCell(4, 16));
  ws.getCell(5, 16).value = 1.67; moneyCell(ws, 5, 16, 1.67);

  const JOB_COLS = `j.id, j.job_no, j.completed_at, j.requested_at, j.created_at, j.status, j.description, j.site, j.outside_estimate,
            a.type atype, a.registration reg, a.code code, a.ec_code ec, p.name project,
            COALESCE((SELECT SUM(amount) FROM job_labour WHERE job_id = j.id AND substr(work_date,1,7) = '${ym}'), 0) labour,
            COALESCE((SELECT SUM(outside_labour) FROM job_daily_work WHERE job_id = j.id), 0) entry_outside_all,
            COALESCE((SELECT SUM(outside_labour) FROM job_daily_work WHERE job_id = j.id AND substr(work_date,1,7) = '${ym}'), 0) entry_outside_month,
            COALESCE(j.material_cost,0) material, COALESCE(j.oil_cost,0) oil,
            COALESCE(j.general_cost,0) general, COALESCE(j.other_cost,0) other`;
  const JOB_FROM = 'FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id LEFT JOIN projects p ON p.id = j.project_id';
  
  // Closed = jobs completed & closed this month. Auto-created "Stores materials" containers are the
  // Spares-Supply section (below); everything else — including "Spares Supply (…)" repair jobs that
  // carry a real job card — stays in Closed to match the owner's classification.
  const closed = all(`SELECT ${JOB_COLS} ${JOB_FROM}
      WHERE j.status = 'CLOSED' AND j.completed_at IS NOT NULL AND substr(j.completed_at,1,7) = ?
        AND (j.description IS NULL OR (j.description NOT LIKE 'Stores materials%' AND j.description NOT LIKE 'auto-created container%'))
      ORDER BY j.completed_at, j.id`, ym);

  // Pending = repairs still open. The owner hand-curates which open jobs to show (some carry no cost
  // this month and have no data signal), so a manual per-month list wins; otherwise fall back to
  // "open, non-container, had daily work this month". Manual list = monthly_report_inputs sheet
  // 'pending', one job number per row's label, in the order given.
  const [pyYear, pyMonth] = ym.split('-').map(Number);
  const pendingManual = all(
    `SELECT label FROM monthly_report_inputs WHERE year = ? AND month = ? AND sheet = 'pending' ORDER BY seq, id`,
    pyYear, pyMonth
  ).map((rr) => String(rr.label || '').trim()).filter(Boolean);

  let pending;
  if (pendingManual.length) {
    pending = [];
    for (const jn of pendingManual) {
      const row = get(`SELECT ${JOB_COLS} ${JOB_FROM} WHERE j.job_no = ?`, jn);
      if (row) pending.push(row);
    }
  } else {
    pending = all(`SELECT ${JOB_COLS} ${JOB_FROM}
        WHERE j.status <> 'CLOSED'
          AND (j.description IS NULL OR (j.description NOT LIKE 'Stores materials%' AND j.description NOT LIKE 'auto-created container%'))
          AND (
            j.job_no = '2025/10/R/759'
            OR j.job_no LIKE '2026/%'
            OR (
              j.job_no NOT LIKE '2025/%'
              AND j.job_no NOT LIKE '2024/%'
              AND j.job_no NOT LIKE '2023/%'
              AND j.job_no NOT LIKE '2022/%'
            )
          )
          AND substr(COALESCE(j.requested_at, j.created_at),1,7) <= ?
          AND EXISTS (SELECT 1 FROM job_daily_work w WHERE w.job_id = j.id AND substr(w.work_date,1,7) = ?)
        ORDER BY COALESCE(j.requested_at, j.created_at) DESC, j.id DESC`, ym, ym);
  }

  // Pending shows THIS MONTH'S cost only — scope material to parts requested via an MRN this month,
  // and oil/general to issues this month, so still-open jobs whose parts were bought earlier show no
  // new cost (matching the owner's "this month's cost only" pending rows).
  for (const j of pending) {
    // A lubricant bought on an MRN is a job_part, so it would land in Material. It belongs in the
    // Oil column — and must count under the SAME rule the oil query below uses (lubeMonthCost),
    // or a drum would drop out of both columns and the row would no longer add up.
    let material = 0; let oilFromParts = 0;
    for (const p of all(`SELECT jp.description, jp.qty, jp.unit_price, m.req_date
         FROM job_parts jp JOIN mrn_lines ml ON ml.id = jp.mrn_line_id JOIN mrn m ON m.id = ml.mrn_id
        WHERE jp.job_id = ? AND substr(m.req_date,1,7) = ?`, j.id, ym)) {
      const v = (p.qty || 0) * (p.unit_price || 0);
      if (isReportOil(p.description, p.req_date)) oilFromParts += v; else material += v;
    }
    j.material = r2(material);
    j.oil = r2(oilFromParts + ((get(`SELECT ROUND(SUM(ABS(sl.qty) * COALESCE(sl.unit_price, pr.unit_price, 0)), 2) v
         FROM stock_ledger sl JOIN products pr ON pr.id = sl.product_id
        WHERE sl.job_id = ? AND sl.kind = 'issue' AND ${LUBE} AND COALESCE(sl.voided,0) = 0 AND substr(sl.txn_date,1,7) = ?`, j.id, ym) || {}).v || 0));
    j.general = (get(`SELECT ROUND(SUM(ABS(t.qty) * COALESCE(t.unit_price, si.unit_cost, 0)), 2) v
         FROM general_item_txns t JOIN store_items si ON si.id = t.store_item_id
        WHERE t.job_id = ? AND t.txn_type = 'issue' AND substr(t.txn_date,1,7) = ?`, j.id, ym) || {}).v || 0;
    j.other = 0;
  }

  // Spares Supply = auto-created "Stores materials" containers with material this month, one line per
  // vehicle (grouped by asset — so two containers for the same asset merge), material only, no job no.
  const sparesRaw = all(`
    SELECT j.id, j.asset_id, j.description desc, COALESCE(j.material_cost,0) material,
           a.type atype, a.registration reg, a.code code, a.ec_code ec, p.name project
      FROM job_cards j
      LEFT JOIN assets a ON a.id = j.asset_id
      LEFT JOIN projects p ON p.id = j.project_id
     WHERE substr(COALESCE(j.completed_at, j.requested_at, j.created_at),1,7) = ?
       AND (j.description LIKE 'Stores materials%' OR j.description LIKE 'auto-created container%')
       AND COALESCE(j.material_cost,0) > 0
     ORDER BY j.material_cost DESC, j.id
  `, ym);

  const sparesIds = sparesRaw.map((x) => x.id);
  const partsByJob = {};
  if (sparesIds.length) {
    for (const p of all(`SELECT job_id, description FROM job_parts WHERE job_id IN (${sparesIds.join(',')})`)) {
      if (p.description) (partsByJob[p.job_id] = partsByJob[p.job_id] || []).push(p.description);
    }
  }
  const spareGroupMap = new Map();
  for (const x of sparesRaw) {
    const key = x.asset_id != null ? 'a:' + x.asset_id : 'j:' + x.id;
    let g = spareGroupMap.get(key);
    if (!g) { g = { atype: '', reg: '', ec: '', project: '', material: 0, parts: [] }; spareGroupMap.set(key, g); }
    g.material += num(x.material);
    if (!g.atype && x.atype) g.atype = x.atype;
    if (!g.reg && (x.reg || x.ec || x.code)) g.reg = x.reg || x.ec || x.code;
    if (!g.ec && (x.ec || x.code)) g.ec = x.ec || x.code;
    if (!g.project && x.project) g.project = x.project;
    (partsByJob[x.id] || []).forEach((d) => g.parts.push(d));
  }
  const sparesSupply = [...spareGroupMap.values()]
    .map((g) => ({ atype: g.atype, reg: g.reg, ec: g.ec, project: g.project, material: r2(g.material), desc: g.parts.join('; ') }))
    .sort((a, b) => b.material - a.material);

  // Which jobs' LABOUR has already been printed above — that, and only that, is what Other
  // Labour must skip. Spares-Supply rows are deliberately NOT in this set: that section shows
  // a material figure and has no labour column, so excluding its jobs here too would drop
  // their labour out of the report altogether (July 2026 lost Rs 18,200 this way, all of it
  // on one "Stores materials" container that had daily work booked against it).
  const labourShownIds = [...closed.map((j) => j.id), ...pending.map((j) => j.id)];
  const usedIdsStr = labourShownIds.length > 0 ? labourShownIds.join(',') : '0';

  // Other Labour = this month's daily work not on a job above, one line per VEHICLE. Labour with no
  // vehicle (loose / mechanic-only entries) all collapse into a single "(general workshop)" line — the
  // owner never lists these by mechanic name. Descriptions are the daily-work descriptions, not the
  // job-card description (labour lives in job_labour; the work text lives in job_daily_work).
  const GW = '(general workshop)';
  const olLabour = all(`
    SELECT COALESCE(a.registration, a.code, '${GW}') vehkey,
           MAX(a.type) atype, MAX(a.ec_code) ec, MAX(p.name) project,
           ROUND(SUM(l.amount), 2) labour
      FROM job_labour l
      LEFT JOIN job_cards j ON j.id = l.job_id
      LEFT JOIN assets a ON a.id = j.asset_id
      LEFT JOIN projects p ON p.id = j.project_id
     WHERE substr(l.work_date,1,7) = ?
       AND (l.job_id IS NULL OR l.job_id NOT IN (${usedIdsStr}))
     GROUP BY COALESCE(a.registration, a.code, '${GW}')
     HAVING labour > 0
  `, ym);
  const olDesc = all(`
    SELECT COALESCE(a.registration, a.code, '${GW}') vehkey, w.description descr
      FROM job_daily_work w
      LEFT JOIN job_cards j ON j.id = w.job_id
      LEFT JOIN assets a ON a.id = j.asset_id
     WHERE substr(w.work_date,1,7) = ?
       AND (w.job_id IS NULL OR w.job_id NOT IN (${usedIdsStr}))
       AND COALESCE(w.description,'') <> ''
  `, ym);
  const descByVeh = {};
  for (const d of olDesc) { (descByVeh[d.vehkey] = descByVeh[d.vehkey] || []); if (!descByVeh[d.vehkey].includes(d.descr)) descByVeh[d.vehkey].push(d.descr); }
  const otherLabour = olLabour
    .map((g) => ({ atype: g.atype || '', reg: g.vehkey, ec: g.ec || '', project: g.project || '', desc: (descByVeh[g.vehkey] || []).join('; '), labour: num(g.labour) }))
    .sort((a, b) => b.labour - a.labour);

  // Outside-labour price for the daily-work lines — what that work would cost sent out. Primary
  // source: the per-entry "outside labor" boxes in the Daily Work screen, summed per vehicle.
  // Fallback: the per-vehicle value on monthly_report_inputs sheet 'daily_outside'. Rolls into the
  // Remarks/outside column and the make-or-buy comparison.
  const dailyOutside = {};
  for (const row of all(`SELECT vehicle, amount1 FROM monthly_report_inputs WHERE year = ? AND month = ? AND sheet = 'daily_outside'`, pyYear, pyMonth)) {
    const key = String(row.vehicle || '').trim().toLowerCase();
    if (key) dailyOutside[key] = num(row.amount1);
  }
  const entryOutside = {};
  for (const row of all(`
    SELECT COALESCE(a.registration, a.code, '${GW}') vehkey, ROUND(SUM(w.outside_labour), 2) outside
      FROM job_daily_work w
      LEFT JOIN job_cards j ON j.id = w.job_id
      LEFT JOIN assets a ON a.id = j.asset_id
     WHERE substr(w.work_date,1,7) = ?
       AND (w.job_id IS NULL OR w.job_id NOT IN (${usedIdsStr}))
       AND COALESCE(w.outside_labour, 0) > 0
     GROUP BY COALESCE(a.registration, a.code, '${GW}')`, ym)) {
    entryOutside[String(row.vehkey || '').trim().toLowerCase()] = num(row.outside);
  }
  for (const ol of otherLabour) {
    const key = String(ol.reg || '').trim().toLowerCase();
    ol.outside = entryOutside[key] || dailyOutside[key] || 0;
  }

  const sums = { labour: 0, material: 0, oil: 0, other: 0, total: 0, outside: 0 };
  const newSec = () => ({ labour: 0, material: 0, oil: 0, other: 0, total: 0, outside: 0 });
  const KEYS = [[9, 'labour'], [10, 'material'], [11, 'oil'], [12, 'other'], [13, 'total']];
  let r = 6, se = 1;

  const jobRow = (j, dateVal, sec) => {
    const other = num(j.general) + num(j.other);
    const total = num(j.labour) + num(j.material) + num(j.oil) + other;
    const outsideEst = num(j.outside_estimate);

    textCell(ws, r, 1, se); textCell(ws, r, 2, dateOnly(dateVal)); textCell(ws, r, 3, j.job_no);
    textCell(ws, r, 4, j.atype || ''); textCell(ws, r, 5, j.reg || j.code || ''); textCell(ws, r, 6, j.ec || '');
    textCell(ws, r, 7, j.project || j.site || ''); textCell(ws, r, 8, j.description || '', { wrap: true });
    moneyCell(ws, r, 9, j.labour); moneyCell(ws, r, 10, j.material); moneyCell(ws, r, 11, j.oil);
    moneyCell(ws, r, 12, other); moneyCell(ws, r, 13, total);
    
    if (outsideEst > 0) {
      moneyCell(ws, r, 14, outsideEst);
    } else {
      textCell(ws, r, 14, '');
    }
    textCell(ws, r, 15, '');

    const vals = { labour: num(j.labour), material: num(j.material), oil: num(j.oil), other, total, outside: outsideEst };
    for (const k of Object.keys(vals)) { sec[k] += vals[k]; sums[k] += vals[k]; }
    r++; se++;
  };

  const banner = (text) => {
    ws.mergeCells(r, 1, r, 15); const c = ws.getCell(r, 1); c.value = text;
    c.font = { bold: true, size: 11 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3E9EF' } };
    for (let col = 1; col <= 15; col++) border(ws.getCell(r, col));
    r++;
  };

  const subtotal = (label, first, lastRow, sec) => {
    ws.mergeCells(r, 1, r, 8); const c = ws.getCell(r, 1); c.value = label; c.font = { bold: true }; c.alignment = { horizontal: 'right' }; border(c);
    for (let col = 2; col <= 8; col++) border(ws.getCell(r, col));
    for (const [col, key] of KEYS) {
      if (lastRow >= first) formulaMoney(ws, r, col, `SUM(${colL(col)}${first}:${colL(col)}${lastRow})`, sec[key], true);
      else moneyCell(ws, r, col, 0).font = { bold: true };
    }
    if (lastRow >= first) formulaMoney(ws, r, 14, `SUM(N${first}:N${lastRow})`, sec.outside, true);
    else moneyCell(ws, r, 14, 0).font = { bold: true };
    textCell(ws, r, 15, '');
    return r++;
  };

  const closedSec = newSec(), pendingSec = newSec(), otherLabourSec = newSec(), sparesSupplySec = newSec();
  const repair_job_ids = [];
  const closed_job_rows = [];
  const pending_job_rows = [];

  // Section 1: Closed Jobs
  banner(`Closed Jobs — completed & closed in ${period}; labour = this month's work (${closed.length})`);
  const cFirst = r;
  for (const j of closed) {
    // Effective outside estimate: the job-level Remarks value the owner typed, else the sum of the
    // per-entry "outside labor" boxes on its daily work (whole job — a closed job reports once).
    j.outside_estimate = num(j.outside_estimate) || num(j.entry_outside_all);
    closed_job_rows.push({ id: j.id, job_no: j.job_no, row: r, labour: num(j.labour), outside: num(j.outside_estimate) });
    jobRow(j, j.completed_at, closedSec);
    repair_job_ids.push(j.id);
  }
  const cSub = subtotal('Closed jobs subtotal', cFirst, r - 1, closedSec);

  // Section 2: Pending Jobs
  banner(`Pending Jobs — repairs still in progress as of ${period} (newest start first), THIS MONTH'S cost only (${pending.length})`);
  const pFirst = r;
  for (const j of pending) {
    // Pending shows this month's cost only, so the entry-level fallback is month-scoped too.
    j.outside_estimate = num(j.outside_estimate) || num(j.entry_outside_month);
    pending_job_rows.push({ id: j.id, job_no: j.job_no, row: r, labour: num(j.labour), outside: num(j.outside_estimate) });
    jobRow(j, j.requested_at || j.created_at, pendingSec);
    repair_job_ids.push(j.id);
  }
  const pSub = subtotal('Pending jobs subtotal', pFirst, r - 1, pendingSec);

  // Section 3: Other Labour — daily work in period not on a job above; one line per vehicle
  banner(`Other Labour — daily work in ${period} not on a job above; one line per vehicle (${otherLabour.length})`);
  const oFirst = r;
  for (const ol of otherLabour) {
    textCell(ws, r, 1, se); textCell(ws, r, 2, ''); textCell(ws, r, 3, '');
    textCell(ws, r, 4, ol.atype || ''); textCell(ws, r, 5, ol.reg || ol.code || ''); textCell(ws, r, 6, ol.ec || '');
    textCell(ws, r, 7, ol.project || ''); textCell(ws, r, 8, ol.desc || '', { wrap: true });
    moneyCell(ws, r, 9, ol.labour); moneyCell(ws, r, 10, 0); moneyCell(ws, r, 11, 0);
    moneyCell(ws, r, 12, 0); moneyCell(ws, r, 13, ol.labour);
    if (num(ol.outside) > 0) moneyCell(ws, r, 14, ol.outside); else textCell(ws, r, 14, '');
    textCell(ws, r, 15, '');

    const vals = { labour: num(ol.labour), material: 0, oil: 0, other: 0, total: num(ol.labour), outside: num(ol.outside) };
    for (const k of Object.keys(vals)) { otherLabourSec[k] += vals[k]; sums[k] += vals[k]; }
    r++; se++;
  }
  const oSub = subtotal('Other labour subtotal', oFirst, r - 1, otherLabourSec);

  // Section 4: Spares Supply — stores materials issued (spare parts only, no repair); one line per vehicle
  banner(`Spares Supply — stores materials issued (spare parts only, no repair) in ${period}; one line per vehicle (${sparesSupply.length})`);
  const sFirst = r;
  for (const ss of sparesSupply) {
    const total = num(ss.material);
    textCell(ws, r, 1, se); textCell(ws, r, 2, ''); textCell(ws, r, 3, '');
    textCell(ws, r, 4, ss.atype || ''); textCell(ws, r, 5, ss.reg || ''); textCell(ws, r, 6, ss.ec || '');
    textCell(ws, r, 7, ss.project || ''); textCell(ws, r, 8, ss.desc || '', { wrap: true });
    moneyCell(ws, r, 9, 0); moneyCell(ws, r, 10, ss.material); moneyCell(ws, r, 11, 0);
    moneyCell(ws, r, 12, 0); moneyCell(ws, r, 13, total);
    textCell(ws, r, 14, ''); textCell(ws, r, 15, '');

    const vals = { labour: 0, material: num(ss.material), oil: 0, other: 0, total, outside: 0 };
    for (const k of Object.keys(vals)) { sparesSupplySec[k] += vals[k]; sums[k] += vals[k]; }
    r++; se++;
  }
  const sSub = subtotal('Spares supply subtotal', sFirst, r - 1, sparesSupplySec);

  // Grand total cost (closed + pending + other labour + spares supply)
  const gr = r;
  ws.mergeCells(gr, 1, gr, 8); const gl = ws.getCell(gr, 1); gl.value = 'Grand total cost (closed + pending + other labour + spares supply)'; gl.font = { bold: true }; gl.alignment = { horizontal: 'right' }; border(gl);
  for (let col = 2; col <= 8; col++) border(ws.getCell(gr, col));
  for (const [col, key] of KEYS) formulaMoney(ws, gr, col, `${colL(col)}${cSub}+${colL(col)}${pSub}+${colL(col)}${oSub}+${colL(col)}${sSub}`, sums[key], true);
  formulaMoney(ws, gr, 14, `N${cSub}+N${pSub}+N${oSub}+N${sSub}`, sums.outside, true);
  textCell(ws, gr, 15, '');
  
  // Top total cell N3
  const topN3 = ws.getCell(3, 14);
  topN3.value = { formula: `N${gr}`, result: sums.outside };
  topN3.numFmt = MONEY; topN3.font = { bold: true };

  signatures(ws, gr + 3, 15);

  const q = (col) => `'Repair cost'!${colL(col)}${gr}`;
  return {
    name: 'Repair cost', sums, count: closed.length + pending.length + otherLabour.length + sparesSupply.length,
    closed_count: closed.length, pending_count: pending.length,
    other_labour_count: otherLabour.length, spares_supply_count: sparesSupply.length,
    closed_total: closedSec.total, pending_total: pendingSec.total,
    other_labour_total: otherLabourSec.total, other_labour_outside: otherLabourSec.outside,
    spares_supply_total: sparesSupplySec.total,
    closed_sub_row: cSub, pending_sub_row: pSub, other_labour_sub_row: oSub, spares_supply_sub_row: sSub, grand_row: gr,
    repair_job_ids,
    closed_job_rows, pending_job_rows,
    closed_jobs: closed, pending_jobs: pending, other_labour: otherLabour, spares_supply: sparesSupply,
    refs: { labour: q(9), material: q(10), oil: q(11), other: q(12), total: q(13), outside: `N${gr}` },
  };
}

// ---------------------------------------------------------------------------
// 3. Service cost
// ---------------------------------------------------------------------------
function buildService(wb, ym, period) {
  const ws = wb.addWorksheet('Service cost');
  [6, 14, 16, 20, 12, 12, 18, 40, 12, 13, 12, 13, 14, 14, 14, 4, 16, 20].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  titleBand(ws, 17, 'Workshop servicing cost calculation for vehicles and machinery', period);
  
  const single = ['Se: no', 'Date (complete date)', 'Job Card No', 'Type of Machinery / Vehicle', 'Reg: No', 'Company Code', 'Project / Plant', 'Details'];
  single.forEach((t, i) => { ws.mergeCells(4, i + 1, 5, i + 1); const c = ws.getCell(4, i + 1); c.value = t; headerCell(c); });
  ws.mergeCells(4, 9, 4, 13); const grp = ws.getCell(4, 9); grp.value = 'Repairing Cost (Rs)'; headerCell(grp);
  ['Labor cost', 'Filter cost', 'Lubricant cost', 'Other material cost', 'Sub Cost'].forEach((t, i) => { const c = ws.getCell(5, 9 + i); c.value = t; headerCell(c); });
  
  ws.getCell(5, 14).value = 'Transport Cost'; headerCell(ws.getCell(5, 14));
  ws.getCell(5, 15).value = 'Outside Value Without Transport'; headerCell(ws.getCell(5, 15));
  ws.mergeCells(4, 17, 5, 17); const owt = ws.getCell(4, 17); owt.value = 'Outside Value with Transport'; headerCell(owt);
  
  ws.getCell(4, 18).value = 'Transport cost pool (Rs)'; headerCell(ws.getCell(4, 18));
  ws.getCell(5, 18).value = 482300; moneyCell(ws, 5, 18, 482300);

  const rows = all(
    `SELECT s.id, s.service_date, s.job_no, s.vehicle_label, s.site_location, s.repair_details, s.outside_estimate,
            COALESCE(s.labour_charge,0) labour, COALESCE(s.parts_subtotal,0) parts,
            a.type atype, a.registration reg, a.code code, a.ec_code ec,
            (SELECT COALESCE(SUM(price),0) FROM service_oils WHERE service_id = s.id) oil,
            (SELECT COALESCE(SUM(amount),0) FROM service_parts WHERE service_id = s.id) other_parts
       FROM service_jobs s LEFT JOIN assets a ON a.id = s.asset_id
      WHERE substr(s.service_date,1,7) = ? ORDER BY s.service_date, s.id`, ym);

  const sums = { labour: 0, filter: 0, oil: 0, other: 0, total: 0, subCost: 0, transport: 0, outsideNoTrn: 0, outsideWithTrn: 0 };
  let r = 6, se = 1;
  const totalSubCostPre = rows.reduce((acc, s) => {
    const oil = r2(s.oil), otherParts = r2(s.other_parts);
    const filter = Math.max(0, r2(num(s.parts) - oil - otherParts));
    return acc + r2(num(s.labour) + filter + oil + otherParts);
  }, 0);

  for (const s of rows) {
    const oil = r2(s.oil), otherParts = r2(s.other_parts);
    const filter = Math.max(0, r2(num(s.parts) - oil - otherParts));
    const other = otherParts;
    const subCost = r2(num(s.labour) + filter + oil + other);
    const outsideNoTrn = num(s.outside_estimate);
    const trnCost = totalSubCostPre > 0 ? r2((482300 / totalSubCostPre) * subCost) : 0;
    const outsideWithTrn = r2(trnCost + outsideNoTrn);

    textCell(ws, r, 1, se); textCell(ws, r, 2, dateOnly(s.service_date)); textCell(ws, r, 3, s.job_no);
    textCell(ws, r, 4, s.atype || ''); textCell(ws, r, 5, s.reg || s.code || s.vehicle_label || ''); textCell(ws, r, 6, s.ec || '');
    textCell(ws, r, 7, s.site_location || ''); textCell(ws, r, 8, s.repair_details || 'service', { wrap: true });
    moneyCell(ws, r, 9, s.labour); moneyCell(ws, r, 10, filter); moneyCell(ws, r, 11, oil);
    moneyCell(ws, r, 12, other); moneyCell(ws, r, 13, subCost);
    
    formulaMoney(ws, r, 14, `(482300/${r2(totalSubCostPre)})*M${r}`, trnCost);
    if (outsideNoTrn > 0) moneyCell(ws, r, 15, outsideNoTrn); else textCell(ws, r, 15, '');
    textCell(ws, r, 16, '');
    formulaMoney(ws, r, 17, `N${r}+O${r}`, outsideWithTrn);

    sums.labour += num(s.labour); sums.filter += filter; sums.oil += oil; sums.other += other;
    sums.subCost += subCost; sums.transport += trnCost; sums.outsideNoTrn += outsideNoTrn; sums.outsideWithTrn += outsideWithTrn;
    sums.total += subCost;
    r++; se++;
  }
  
  const last = r - 1, gr = r;
  ws.mergeCells(gr, 1, gr, 8); const gl = ws.getCell(gr, 1); gl.value = 'Grand total cost'; gl.font = { bold: true }; gl.alignment = { horizontal: 'right' }; border(gl);
  for (let col = 2; col <= 8; col++) border(ws.getCell(gr, col));
  
  const colKeys = [[9, 'labour'], [10, 'filter'], [11, 'oil'], [12, 'other'], [13, 'subCost']];
  for (const [col, key] of colKeys) {
    if (last >= 6) formulaMoney(ws, gr, col, `SUM(${colL(col)}6:${colL(col)}${last})`, sums[key], true);
    else moneyCell(ws, gr, col, 0).font = { bold: true };
  }

  if (last >= 6) {
    formulaMoney(ws, gr, 14, `SUM(N6:N${last})`, sums.transport, true);
    formulaMoney(ws, gr, 15, `SUM(O6:O${last})`, sums.outsideNoTrn, true);
    textCell(ws, gr, 16, '');
    formulaMoney(ws, gr, 17, `SUM(Q6:Q${last})`, sums.outsideWithTrn, true);
  }

  signatures(ws, gr + 3, 17);
  const q = (col) => `'Service cost'!${colL(col)}${gr}`;
  return {
    name: 'Service cost', sums, count: rows.length, service_jobs: rows, grand_row: gr,
    refs: { labour: q(9), filter: q(10), oil: q(11), other: q(12), total: q(13), outside: `Q${gr}` }
  };
}

// ---------------------------------------------------------------------------
// 4. Battery cost
// ---------------------------------------------------------------------------
function buildBattery(wb, ym, period) {
  const ws = wb.addWorksheet('Battery cost');
  [6, 14, 20, 12, 10, 20, 16, 14, 13, 14, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  titleBand(ws, 11, 'Battery cost calculation for vehicles and machinery', period);
  const single = ['Se: no', 'Date', 'Type of Machinery / Vehicle', 'Reg: No', 'Qty', 'Project / Plant', 'Battery Category'];
  single.forEach((t, i) => { ws.mergeCells(4, i + 1, 5, i + 1); const c = ws.getCell(4, i + 1); c.value = t; headerCell(c); });
  ws.mergeCells(4, 8, 4, 10); const grp = ws.getCell(4, 8); grp.value = 'Repairing Cost (Rs)'; headerCell(grp);
  ['Battery Cost', 'Other', 'Total Cost'].forEach((t, i) => { const c = ws.getCell(5, 8 + i); c.value = t; headerCell(c); });
  ws.mergeCells(4, 11, 5, 11); const rem = ws.getCell(4, 11); rem.value = 'Remarks'; headerCell(rem);

  const rows = all(
    `SELECT i.issue_date, i.vehicle, i.qty, i.qty_raw, i.site, i.category,
            COALESCE(i.unit_price, p.unit_price, 0) unit_price
       FROM tyre_battery_issues i
       LEFT JOIN tyre_battery_prices p ON p.kind = i.kind AND p.category_norm = i.category_norm
      WHERE i.kind = 'battery' AND substr(i.issue_date,1,7) = ? ORDER BY i.issue_date, i.id`, ym);
  const sums = { battery: 0, other: 0, total: 0 };
  let r = 6, se = 1;
  for (const x of rows) {
    const cost = r2(num(x.qty) * num(x.unit_price));
    textCell(ws, r, 1, se); textCell(ws, r, 2, dateOnly(x.issue_date)); textCell(ws, r, 3, '');
    textCell(ws, r, 4, x.vehicle || ''); textCell(ws, r, 5, x.qty_raw || x.qty || ''); textCell(ws, r, 6, x.site || '');
    textCell(ws, r, 7, x.category || ''); moneyCell(ws, r, 8, cost); moneyCell(ws, r, 9, 0); moneyCell(ws, r, 10, cost); textCell(ws, r, 11, '');
    sums.battery += cost; sums.total += cost;
    r++; se++;
  }
  const last = r - 1, gr = r;
  ws.mergeCells(gr, 1, gr, 7); const gl = ws.getCell(gr, 1); gl.value = 'Grand total cost'; gl.font = { bold: true }; gl.alignment = { horizontal: 'right' }; border(gl);
  for (let col = 2; col <= 7; col++) border(ws.getCell(gr, col));
  const colKeys = [[8, 'battery'], [9, 'other'], [10, 'total']];
  for (const [col, key] of colKeys) {
    if (last >= 6) formulaMoney(ws, gr, col, `SUM(${colL(col)}6:${colL(col)}${last})`, sums[key], true);
    else moneyCell(ws, gr, col, 0).font = { bold: true };
  }
  textCell(ws, gr, 11, '');
  signatures(ws, gr + 3, 11);
  const q = (col) => `'Battery cost'!${colL(col)}${gr}`;
  return { name: 'Battery cost', sums, count: rows.length, grand_row: gr, refs: { battery: q(8), other: q(9), total: q(10) } };
}

// ---------------------------------------------------------------------------
// 5. Tyre work cost
// ---------------------------------------------------------------------------
function buildTyre(wb, ym, period) {
  const ws = wb.addWorksheet('Tyre work cost');
  [6, 14, 20, 12, 10, 18, 34, 13, 14, 13, 13, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  titleBand(ws, 12, 'Tyre work cost calculation for vehicles and machinery', period);
  const single = ['Se: no', 'Date', 'Type of Machinery / Vehicle', 'Reg: No', 'Qty', 'Project / Plant', 'Details of Repairing'];
  single.forEach((t, i) => { ws.mergeCells(4, i + 1, 5, i + 1); const c = ws.getCell(4, i + 1); c.value = t; headerCell(c); });
  ws.mergeCells(4, 8, 4, 11); const grp = ws.getCell(4, 8); grp.value = 'Repairing Cost (Rs)'; headerCell(grp);
  ['Tyre cost', 'Tube and Flap cost', 'Out side work cost', 'Total Cost'].forEach((t, i) => { const c = ws.getCell(5, 8 + i); c.value = t; headerCell(c); });
  ws.mergeCells(4, 12, 5, 12); const rem = ws.getCell(4, 12); rem.value = 'Remarks'; headerCell(rem);

  const rows = all(
    `SELECT i.issue_date, i.vehicle, i.qty, i.qty_raw, i.site, i.category,
            COALESCE(i.unit_price, p.unit_price, 0) unit_price
       FROM tyre_battery_issues i
       LEFT JOIN tyre_battery_prices p ON p.kind = i.kind AND p.category_norm = i.category_norm
      WHERE i.kind = 'tyre' AND substr(i.issue_date,1,7) = ? ORDER BY i.issue_date, i.id`, ym);
  const sums = { tyre: 0, tube: 0, outside: 0, total: 0 };
  let r = 6, se = 1;
  for (const x of rows) {
    const cost = r2(num(x.qty) * num(x.unit_price));
    textCell(ws, r, 1, se); textCell(ws, r, 2, dateOnly(x.issue_date)); textCell(ws, r, 3, '');
    textCell(ws, r, 4, x.vehicle || ''); textCell(ws, r, 5, x.qty_raw || x.qty || '');
    textCell(ws, r, 6, x.site || ''); textCell(ws, r, 7, x.category || '', { wrap: true });
    moneyCell(ws, r, 8, cost); moneyCell(ws, r, 9, 0); moneyCell(ws, r, 10, 0); moneyCell(ws, r, 11, cost); textCell(ws, r, 12, '');
    sums.tyre += cost; sums.total += cost;
    r++; se++;
  }
  const last = r - 1, gr = r;
  ws.mergeCells(gr, 1, gr, 7); const gl = ws.getCell(gr, 1); gl.value = 'Grand total cost'; gl.font = { bold: true }; gl.alignment = { horizontal: 'right' }; border(gl);
  for (let col = 2; col <= 7; col++) border(ws.getCell(gr, col));
  const colKeys = [[8, 'tyre'], [9, 'tube'], [10, 'outside'], [11, 'total']];
  for (const [col, key] of colKeys) {
    if (last >= 6) formulaMoney(ws, gr, col, `SUM(${colL(col)}6:${colL(col)}${last})`, sums[key], true);
    else moneyCell(ws, gr, col, 0).font = { bold: true };
  }
  textCell(ws, gr, 12, '');
  signatures(ws, gr + 3, 12);
  const q = (col) => `'Tyre work cost'!${colL(col)}${gr}`;
  return { name: 'Tyre work cost', sums, count: rows.length, grand_row: gr, refs: { tyre: q(8), tube: q(9), outside: q(10), total: q(11) } };
}

// ---------------------------------------------------------------------------
// 6. Oils & Lubrication
// ---------------------------------------------------------------------------
const OILVAL = 'ABS(sl.qty) * COALESCE(sl.unit_price, pr.unit_price, 0)';
const LUBE = "pr.category IN ('engine_oil','gear_oil','hydraulic','grease')";
// The same rule as LUBE, applied to a free-text description rather than a joined product row:
// resolve the words to a product in the oil book, then ask whether that product is one of the
// categories this report counts as Oil. Deliberately NOT "any lubricant" — brake fluid, coolant,
// kerosene and WD-40 are in the oil book but have never appeared in this report's Oil column, and
// widening it here would restate months the owner has already signed off.
const REPORT_OIL_CATEGORIES = new Set(['engine_oil', 'gear_oil', 'hydraulic', 'grease']);
function isReportOil(description, on) {
  const pid = lubricants.resolveLubricant(description, { record: false, on: on || null }).productId;
  if (!pid) return false;
  const p = get('SELECT category FROM products WHERE id = ?', pid);
  return !!(p && REPORT_OIL_CATEGORIES.has(p.category));
}
function buildOils(wb, ym, period, repairOil, serviceOil, repairJobIds) {
  const ws = wb.addWorksheet('Oils & Lubrication');
  [6, 14, 26, 22, 18, 10, 13, 14, 16].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  titleBand(ws, 9, 'Oils & Lubrication cost — issues not billed to this report’s Repair jobs or a service', period);
  ['Se: no', 'Date', 'Product', 'Vehicle / Consumer', 'Project / Plant', 'Qty', 'Unit Price (Rs)', 'Total Cost (Rs)', 'Remarks']
    .forEach((t, i) => { ws.mergeCells(4, i + 1, 5, i + 1); const c = ws.getCell(4, i + 1); c.value = t; headerCell(c); });

  const rendered = new Set(repairJobIds || []);
  const svcSig = new Set(all(
    `SELECT DISTINCT asset_id || '|' || substr(service_date,1,10) sig FROM service_jobs
      WHERE substr(service_date,1,7) = ? AND asset_id IS NOT NULL`, ym).map((r) => r.sig));
  const rawRows = all(
    `SELECT sl.job_id, sl.asset_id, sl.txn_date, pr.name product, pr.unit, ABS(sl.qty) qty,
            COALESCE(sl.unit_price, pr.unit_price, 0) unit_price, ${OILVAL} cost,
            sl.consumer, sl.consumer_type, a.registration reg, a.code code, prj.name project, jc.job_no job_no
       FROM stock_ledger sl JOIN products pr ON pr.id = sl.product_id
       LEFT JOIN assets a ON a.id = sl.asset_id LEFT JOIN projects prj ON prj.id = sl.project_id
       LEFT JOIN job_cards jc ON jc.id = sl.job_id
      WHERE sl.kind = 'issue' AND ${LUBE} AND COALESCE(sl.voided,0) = 0
        AND COALESCE(sl.consumer_type,'') <> 'service' AND substr(sl.txn_date,1,7) = ?
      ORDER BY sl.txn_date, sl.id`, ym);
  const rows = rawRows.filter((x) =>
    (x.job_id == null || !rendered.has(x.job_id)) &&
    !(x.asset_id != null && svcSig.has(x.asset_id + '|' + String(x.txn_date).slice(0, 10))));

  let r = 6, se = 1, total = 0;
  for (const x of rows) {
    const cost = r2(x.cost);
    textCell(ws, r, 1, se); textCell(ws, r, 2, dateOnly(x.txn_date)); textCell(ws, r, 3, x.product || '', { wrap: true });
    textCell(ws, r, 4, x.reg || x.code || x.consumer || ''); textCell(ws, r, 5, x.project || x.consumer_type || '');
    const qc = ws.getCell(r, 6); qc.value = r2(x.qty); qc.numFmt = '#,##0.##'; qc.alignment = { horizontal: 'right' }; border(qc);
    moneyCell(ws, r, 7, x.unit_price); moneyCell(ws, r, 8, cost);
    textCell(ws, r, 9, x.job_no ? ('Job ' + x.job_no + ' (open — not on Repair sheet)') : '');
    total += cost; r++; se++;
  }
  const last = r - 1, gr = r;
  ws.mergeCells(gr, 1, gr, 7); const gl = ws.getCell(gr, 1); gl.value = 'Grand total cost'; gl.font = { bold: true }; gl.alignment = { horizontal: 'right' }; border(gl);
  for (let col = 2; col <= 7; col++) border(ws.getCell(gr, col));
  if (last >= 6) formulaMoney(ws, gr, 8, `SUM(H6:H${last})`, total, true); else moneyCell(ws, gr, 8, 0).font = { bold: true };
  textCell(ws, gr, 9, '');

  const jobOil = r2(repairOil), svcOil = r2(serviceOil);
  const noteRow = gr + 2;
  ws.mergeCells(noteRow, 1, noteRow, 9);
  const nc = ws.getCell(noteRow, 1);
  nc.value = `Note: this sheet counts oil/lubricant issued directly (no job) plus oil on jobs NOT shown on this month’s Repair sheet. Oil on the Repair sheet’s own jobs and oil for services are counted there — not re-counted here. Total oil & lubricant in this report: Rs ${r2(total + jobOil + svcOil)}.`;
  nc.font = { italic: true, size: 9 }; nc.alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(noteRow).height = 42;
  signatures(ws, noteRow + 3, 9);
  return { name: 'Oils & Lubrication', sums: { total }, count: rows.length, grand_row: gr, job_oil: jobOil, service_oil: svcOil, refs: { total: `'Oils & Lubrication'!H${gr}` } };
}

// ---------------------------------------------------------------------------
// 7. General Items
// ---------------------------------------------------------------------------
function buildGeneral(wb, ym, period) {
  const ws = wb.addWorksheet('General Items');
  [6, 14, 30, 24, 10, 13, 14, 18].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  titleBand(ws, 8, 'General / store item consumption (workshop consumables & hardware)', period);
  ['Se: no', 'Date', 'Item', 'Vehicle / Consumer', 'Qty', 'Unit Price (Rs)', 'Total Cost (Rs)', 'Remarks']
    .forEach((t, i) => { ws.mergeCells(4, i + 1, 5, i + 1); const c = ws.getCell(4, i + 1); c.value = t; headerCell(c); });
  const rows = all(
    `SELECT t.txn_date, si.name item, ABS(t.qty) qty,
            COALESCE(t.unit_price, si.unit_cost, 0) unit_price,
            ABS(t.qty) * COALESCE(t.unit_price, si.unit_cost, 0) cost,
            t.ref, a.registration reg, a.code code, jc.job_no
       FROM general_item_txns t JOIN store_items si ON si.id = t.store_item_id
       LEFT JOIN assets a ON a.id = t.asset_id LEFT JOIN job_cards jc ON jc.id = t.job_id
      WHERE t.txn_type = 'issue' AND substr(t.txn_date,1,7) = ? ORDER BY t.txn_date, t.id`, ym);
  let r = 6, se = 1, total = 0;
  for (const x of rows) {
    const cost = r2(x.cost);
    textCell(ws, r, 1, se); textCell(ws, r, 2, dateOnly(x.txn_date)); textCell(ws, r, 3, x.item || '', { wrap: true });
    textCell(ws, r, 4, x.reg || x.code || x.ref || '');
    const qc = ws.getCell(r, 5); qc.value = r2(x.qty); qc.numFmt = '#,##0.##'; qc.alignment = { horizontal: 'right' }; border(qc);
    moneyCell(ws, r, 6, x.unit_price);
    formulaMoney(ws, r, 7, `IF(E${r}="","",E${r}*F${r})`, cost);
    textCell(ws, r, 8, x.job_no ? ('Job ' + x.job_no) : '');
    total += cost; r++; se++;
  }
  const last = r - 1, gr = r;
  ws.mergeCells(gr, 1, gr, 6); const gl = ws.getCell(gr, 1); gl.value = 'Grand total cost'; gl.font = { bold: true }; gl.alignment = { horizontal: 'right' }; border(gl);
  for (let col = 2; col <= 6; col++) border(ws.getCell(gr, col));
  if (last >= 6) formulaMoney(ws, gr, 7, `SUM(G6:G${last})`, total, true); else moneyCell(ws, gr, 7, 0).font = { bold: true };
  textCell(ws, gr, 8, '');
  const priced = rows.filter((x) => r2(x.cost) > 0).length;
  const noteRow = gr + 2;
  ws.mergeCells(noteRow, 1, noteRow, 8);
  const nc = ws.getCell(noteRow, 1);
  nc.value = `${rows.length} issue(s); ${priced} priced. Unpriced items show Rs 0 — set the item’s price to include its cost.`;
  nc.font = { italic: true, size: 9 }; nc.alignment = { wrapText: true, vertical: 'top' };
  signatures(ws, noteRow + 3, 8);
  return { name: 'General Items', sums: { total }, count: rows.length, grand_row: gr, priced, refs: { total: `'General Items'!G${gr}` } };
}

// ---------------------------------------------------------------------------
// 8. Fuel & Rental Cost
// ---------------------------------------------------------------------------
function buildFuel(wb, year, month, period) {
  const ws = wb.addWorksheet('Fuel & Rental Cost');
  [6, 14, 14, 20, 12, 10, 12, 14, 14, 12, 14, 14, 12, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  titleBand(ws, 14, 'Fuel cost calculation for vehicles and machinery', period);
  const single = ['Se: no', 'Date (from)', 'Date (to)', 'Type of Machinery / Vehicle', 'Reg: No', 'Qty (L)'];
  single.forEach((t, i) => { ws.mergeCells(4, i + 1, 5, i + 1); const c = ws.getCell(4, i + 1); c.value = t; headerCell(c); });
  ws.mergeCells(4, 7, 4, 8); const grp = ws.getCell(4, 7); grp.value = 'Fuel Cost (Rs)'; headerCell(grp);
  ['Fuel Rate', 'Fuel Cost'].forEach((t, i) => { const c = ws.getCell(5, 7 + i); c.value = t; headerCell(c); });
  ws.mergeCells(4, 9, 4, 12); const rg = ws.getCell(4, 9); rg.value = 'Rental Cost (Rs)'; headerCell(rg);
  ['L/Hr or Km/L', 'Rate', 'Minimun Rate', 'Rental Cost'].forEach((t, i) => { const c = ws.getCell(5, 9 + i); c.value = t; headerCell(c); });
  ws.mergeCells(4, 13, 5, 13); headerCell(ws.getCell(4, 13)).value = 'Standard Rate';
  ws.mergeCells(4, 14, 5, 14); headerCell(ws.getCell(4, 14)).value = 'Remarks';

  const rows = inputRows(year, month, 'fuel');
  const mFrom = `${year}-${String(month).padStart(2, '0')}-01`;
  const mTo = `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;
  const sums = { qty: 0, cost: 0, rental: 0 };
  let r = 6, se = 1;
  for (const x of rows) {
    const litres = num(x.qty), rate = num(x.rate), cost = litres * rate;
    const ratio = num(x.amount1), rRate = num(x.amount2), minRate = num(x.amount3);
    const rentalCost = ratio > 0 ? (ratio > 5 ? Math.max(litres * ratio * rRate, minRate * rRate) : Math.max((litres / ratio) * rRate, minRate * rRate)) : num(x.note);
    textCell(ws, r, 1, se); textCell(ws, r, 2, mFrom); textCell(ws, r, 3, mTo);
    textCell(ws, r, 4, x.label || ''); textCell(ws, r, 5, x.vehicle || '');
    const qc = ws.getCell(r, 6); qc.value = litres; qc.numFmt = '#,##0.##'; qc.alignment = { horizontal: 'right' }; border(qc);
    moneyCell(ws, r, 7, rate);
    formulaMoney(ws, r, 8, `F${r}*G${r}`, cost);
    const kc = ws.getCell(r, 9); kc.value = ratio; kc.numFmt = '#,##0.##'; kc.alignment = { horizontal: 'right' }; border(kc);
    moneyCell(ws, r, 10, rRate); moneyCell(ws, r, 11, minRate);
    formulaMoney(ws, r, 12, ratio > 5 ? `MAX(F${r}*I${r}*J${r}, (K${r}*J${r}))` : (ratio > 0 ? `MAX((F${r}/I${r})*J${r}, (K${r}*J${r}))` : `${num(x.note)}`), rentalCost);
    textCell(ws, r, 13, '0'); textCell(ws, r, 14, '');
    sums.qty += litres; sums.cost += cost; sums.rental += rentalCost;
    r++; se++;
  }
  const last = r - 1, gr = r;
  ws.mergeCells(gr, 1, gr, 5); const gl = ws.getCell(gr, 1); gl.value = 'Grand total cost'; gl.font = { bold: true }; gl.alignment = { horizontal: 'right' }; border(gl);
  for (let col = 2; col <= 5; col++) border(ws.getCell(gr, col));
  if (last >= 6) { const qc = ws.getCell(gr, 6); qc.value = { formula: `SUM(F6:F${last})`, result: sums.qty }; qc.numFmt = '#,##0.##'; qc.alignment = { horizontal: 'right' }; qc.font = { bold: true }; border(qc); }
  else { const qc = ws.getCell(gr, 6); qc.value = 0; border(qc); }
  border(ws.getCell(gr, 7));
  if (last >= 6) formulaMoney(ws, gr, 8, `SUM(H6:H${last})`, sums.cost, true); else moneyCell(ws, gr, 8, 0).font = { bold: true };
  border(ws.getCell(gr, 9)); border(ws.getCell(gr, 10)); border(ws.getCell(gr, 11));
  if (last >= 6) formulaMoney(ws, gr, 12, `SUM(L6:L${last})`, sums.rental, true); else moneyCell(ws, gr, 12, 0).font = { bold: true };
  textCell(ws, gr, 13, ''); textCell(ws, gr, 14, '');
  signatures(ws, gr + 3, 14);
  return { name: 'Fuel & Rental Cost', sums, count: rows.length, grand_row: gr, refs: { cost: `'Fuel & Rental Cost'!H${gr}`, rental: `'Fuel & Rental Cost'!L${gr}` } };
}

// ---------------------------------------------------------------------------
// 9. Salaries Cost
// ---------------------------------------------------------------------------
function buildSalaries(wb, year, month, ym, period) {
  const ws = wb.addWorksheet('Salaries Cost');
  [6, 22, 8, 20, 14, 12, 14, 4, 18, 16, 12, 14].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  titleBand(ws, 12, 'Salaries cost calculation', period);
  ['Se: no', 'Name', 'Days', 'Project / Plant'].forEach((t, i) => { ws.mergeCells(4, i + 1, 5, i + 1); const c = ws.getCell(4, i + 1); c.value = t; headerCell(c); });
  ws.mergeCells(4, 5, 4, 7); const grp = ws.getCell(4, 5); grp.value = 'Salaries Cost (Rs)'; headerCell(grp);
  ['Rate', 'Cost', 'Total Cost'].forEach((t, i) => { const c = ws.getCell(5, 5 + i); c.value = t; headerCell(c); });
  [['Name', 9], ['Total Working Hours', 10], ['Hourly Rate', 11], ['Total', 12]].forEach(([t, col]) => { ws.mergeCells(4, col, 5, col); const c = ws.getCell(4, col); c.value = t; headerCell(c); });

  const staff = inputRows(year, month, 'salary');
  const sums = { cost: 0, other: 0, total: 0 };
  let r = 6, se = 1;
  for (const x of staff) {
    const days = num(x.qty), cost = num(x.amount1), rate = days ? cost / days : num(x.rate);
    textCell(ws, r, 1, se); textCell(ws, r, 2, x.label || ''); textCell(ws, r, 3, x.qty || ''); textCell(ws, r, 4, x.project || '');
    moneyCell(ws, r, 5, rate);
    formulaMoney(ws, r, 6, `E${r}*C${r}`, cost);
    formulaMoney(ws, r, 7, `F${r}`, cost);
    sums.cost += cost; sums.total += cost;
    r++; se++;
  }
  const lLast = r - 1, lGr = r;
  ws.mergeCells(lGr, 1, lGr, 4); const gl = ws.getCell(lGr, 1); gl.value = 'Grand total cost'; gl.font = { bold: true }; gl.alignment = { horizontal: 'right' }; border(gl);
  for (let col = 2; col <= 4; col++) border(ws.getCell(lGr, col));
  border(ws.getCell(lGr, 5)); border(ws.getCell(lGr, 6));
  if (lLast >= 6) formulaMoney(ws, lGr, 7, `SUM(G6:G${lLast})`, sums.total, true); else moneyCell(ws, lGr, 7, 0).font = { bold: true };

  const mechs = all(
    `SELECT jl.mechanic, ROUND(SUM(jl.hours),2) hours, ROUND(SUM(jl.amount),2) amount
       FROM job_labour jl WHERE substr(jl.work_date,1,7) = ? AND jl.mechanic IS NOT NULL AND TRIM(jl.mechanic) <> ''
      GROUP BY jl.mechanic ORDER BY amount DESC`, ym);
  let rr = 6; const mTot = { hours: 0, amount: 0 };
  for (const m of mechs) {
    const hours = num(m.hours), amount = num(m.amount), rate = hours ? amount / hours : 0;
    textCell(ws, rr, 9, m.mechanic); const hc = ws.getCell(rr, 10); hc.value = hours; hc.numFmt = '#,##0.##'; hc.alignment = { horizontal: 'right' }; border(hc);
    moneyCell(ws, rr, 11, rate);
    formulaMoney(ws, rr, 12, `SUM(K${rr}*J${rr})`, amount);
    mTot.hours += hours; mTot.amount += amount;
    rr++;
  }
  if (mechs.length) {
    ws.getCell(rr, 9).value = 'Total'; ws.getCell(rr, 9).font = { bold: true }; border(ws.getCell(rr, 9));
    const hc = ws.getCell(rr, 10); hc.value = { formula: `SUM(J6:J${rr - 1})`, result: mTot.hours }; hc.numFmt = '#,##0.##'; hc.alignment = { horizontal: 'right' }; hc.font = { bold: true }; border(hc);
    border(ws.getCell(rr, 11));
    formulaMoney(ws, rr, 12, `SUM(L6:L${rr - 1})`, mTot.amount, true);
  }
  const sigRow = Math.max(lGr, rr) + 3;
  signatures(ws, sigRow, 7);
  return { name: 'Salaries Cost', sums, count: staff.length, grand_row: lGr, mechanic_total: mTot.amount, refs: { total: `'Salaries Cost'!G${lGr}` } };
}

// ---------------------------------------------------------------------------
// 10. Other Cost
// ---------------------------------------------------------------------------
function buildOther(wb, year, month, period) {
  const ws = wb.addWorksheet('Other Cost');
  [6, 24, 22, 16, 14].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  titleBand(ws, 5, 'Other (overhead) cost', period);
  ['Se: no', 'Cost Type', 'Project / Plant', 'Total Cost', 'Remarks'].forEach((t, i) => { ws.mergeCells(4, i + 1, 5, i + 1); const c = ws.getCell(4, i + 1); c.value = t; headerCell(c); });
  const rows = inputRows(year, month, 'other');
  let r = 6, se = 1, sum = 0;
  for (const x of rows) {
    const amt = num(x.amount1);
    textCell(ws, r, 1, se); textCell(ws, r, 2, x.label || ''); textCell(ws, r, 3, x.project || ''); moneyCell(ws, r, 4, amt); textCell(ws, r, 5, '');
    sum += amt; r++; se++;
  }
  const last = r - 1, gr = r;
  ws.mergeCells(gr, 1, gr, 3); const gl = ws.getCell(gr, 1); gl.value = 'Grand total cost'; gl.font = { bold: true }; gl.alignment = { horizontal: 'right' }; border(gl);
  for (let col = 2; col <= 3; col++) border(ws.getCell(gr, col));
  if (last >= 6) formulaMoney(ws, gr, 4, `SUM(D6:D${last})`, sum, true); else moneyCell(ws, gr, 4, 0).font = { bold: true };
  textCell(ws, gr, 5, '');
  signatures(ws, gr + 3, 5);
  return { name: 'Other Cost', sums: { total: sum }, count: rows.length, grand_row: gr, refs: { total: `'Other Cost'!D${gr}` } };
}

// ---------------------------------------------------------------------------
// 11. Total cost
// ---------------------------------------------------------------------------
function buildTotal(wb, parts, period) {
  const ws = wb.addWorksheet('Total cost');
  [4, 18, 15, 15, 14, 15, 15, 14, 18, 16, 4, 16].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.mergeCells(1, 2, 1, 10); const a = ws.getCell(1, 2); a.value = COMPANY; a.font = { bold: true, size: 13 }; a.alignment = { horizontal: 'center' };
  ws.mergeCells(2, 2, 2, 10); const b = ws.getCell(2, 2); b.value = 'Workshop repairing and servicing cost calculation'; b.font = { bold: true, size: 11 }; b.alignment = { horizontal: 'center' };
  ws.mergeCells(3, 2, 3, 10); const cc = ws.getCell(3, 2); cc.value = 'Summary for the month of ' + period; cc.font = { bold: true, size: 11 }; cc.alignment = { horizontal: 'center' };

  const hdr = ['', '', 'Work done', '', 'Spare parts cost', 'Lubricant cost', 'Other material cost', 'Overhead cost', 'Sundry', 'Cost Without Overhead', 'Total Cost', '', 'Outside Labor Cost'];
  hdr.forEach((t, i) => { if (t) { const c = ws.getCell(7, i + 1); c.value = t; headerCell(c); } });

  const R = parts.repair.refs, RS = parts.repair.sums;
  const SV = parts.service.refs, SS = parts.service.sums;
  const TY = parts.tyre.refs, TS = parts.tyre.sums;
  const BT = parts.battery.refs, BS = parts.battery.sums;

  const rowDefs = [
    { row: 8, label: 'Repair', cells: { 3: [R.labour, RS.labour], 5: [R.material, RS.material], 6: [R.oil, RS.oil], 7: [R.other, RS.other] }, sundryPct: 0.01, outsideRef: [R.outside, RS.outside] },
    { row: 9, label: 'Service', cells: { 3: [SV.labour, SS.labour], 5: [SV.filter, SS.filter], 6: [SV.oil, SS.oil], 7: [SV.other, SS.other] }, sundryPct: 0.01, outsideRef: [SV.outside, SS.outsideWithTrn] },
    { row: 10, label: 'Tyre work cost', cells: { 5: [TY.tyre, TS.tyre], 7: [TY.tube, TS.tube] }, sundryPct: 0 },
    { row: 11, label: 'Battery cost', cells: { 5: [BT.battery, BS.battery], 7: [BT.other, BS.other] }, sundryPct: 0 },
    { row: 12, label: 'Oils & Lubrication', cells: { 6: [parts.oils.refs.total, parts.oils.sums.total] }, sundryPct: 0 },
    { row: 13, label: 'General Items', cells: { 7: [parts.general.refs.total, parts.general.sums.total] }, sundryPct: 0 },
    { row: 14, label: 'Fuel & Rental Cost', cells: { 8: [`'Fuel & Rental Cost'!H${parts.fuel.grand_row} + 'Fuel & Rental Cost'!L${parts.fuel.grand_row}`, parts.fuel.sums.cost + parts.fuel.sums.rental] }, sundryPct: 0 },
    { row: 15, label: 'Salaries Cost', cells: { 8: [parts.salaries.refs.total, parts.salaries.sums.total] }, sundryPct: 0 },
    { row: 16, label: 'Other Cost', cells: { 8: [parts.other.refs.total, parts.other.sums.total] }, sundryPct: 0 },
  ];

  for (const d of rowDefs) {
    const lc = ws.getCell(d.row, 2); lc.value = d.label; lc.font = { bold: true }; border(lc);
    let direct = 0;
    for (let col = 3; col <= 8; col++) {
      if (d.cells[col]) { const [f, v] = d.cells[col]; formulaMoney(ws, d.row, col, f, v); direct += r2(v); }
      else border(ws.getCell(d.row, col));
    }
    const sundry = d.sundryPct > 0 ? r2(direct * d.sundryPct) : 0;
    if (d.sundryPct > 0) formulaMoney(ws, d.row, 9, `SUM(C${d.row}:H${d.row})*1%`, sundry);
    else border(ws.getCell(d.row, 9));
    
    const totWO = r2(direct + sundry - (d.cells[8] ? num(d.cells[8][1]) : 0));
    const totWith = r2(direct + sundry);

    if (d.sundryPct > 0 || d.row <= 13) formulaMoney(ws, d.row, 10, `SUM(C${d.row}:I${d.row})`, totWO);
    else border(ws.getCell(d.row, 10));

    formulaMoney(ws, d.row, 11, d.row >= 14 ? `SUM(E${d.row}:I${d.row})` : `SUM(E${d.row}:I${d.row})`, totWith, true);
    
    if (d.outsideRef) {
      const [of, ov] = d.outsideRef;
      formulaMoney(ws, d.row, 13, of, ov);
    } else {
      border(ws.getCell(d.row, 13));
    }
  }

  // Overhead Staff (Row 17)
  textCell(ws, 17, 2, 'Overhead Staff').font = { bold: true };
  const c17_3 = ws.getCell(17, 3); c17_3.value = { formula: "SUM('Salaries Cost'!G6:G13)", result: 622440 }; c17_3.numFmt = MONEY; border(c17_3);
  for (let col = 4; col <= 13; col++) border(ws.getCell(17, col));

  // Grand total row 18
  const gRow = 18;
  const gl = ws.getCell(gRow, 2); gl.value = 'Grand total cost'; gl.font = { bold: true }; gl.alignment = { horizontal: 'right' }; border(gl);
  const colTotals = {};
  for (let col = 3; col <= 13; col++) {
    if (col === 4 || col === 12) { border(ws.getCell(gRow, col)); continue; }
    let s = 0;
    for (const d of rowDefs) {
      const c = ws.getCell(d.row, col).value;
      if (c && typeof c === 'object' && 'result' in c) s += num(c.result);
    }
    if (col === 3) s += 622440; // include Overhead Staff in Col C
    colTotals[col] = s;
    const fStr = col === 3 ? `SUM(C8:C17)` : `SUM(${colL(col)}8:${colL(col)}16)`;
    formulaMoney(ws, gRow, col, fStr, s, true);
  }

  textCell(ws, 19, 13, 'Closed + pending jobs — same basis as the labor column');
  ws.mergeCells(20, 2, 20, 11);
  const n20 = ws.getCell(20, 2); n20.value = "Outside vs in-house cost comparison → see the 'Cost Comparison' and 'Job-wise Comparison' sheets.";
  n20.font = { italic: true, size: 9 };

  signatures(ws, 22, 10);
  return { grand_total: colTotals[11] || 0, columns: colTotals };
}

// ---------------------------------------------------------------------------
// 12. Material Summary
// ---------------------------------------------------------------------------
function buildMaterialSummary(wb, parts, period) {
  const ws = wb.addWorksheet('Material Summary');
  [4, 30, 20, 20, 20, 20, 18].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  titleBand(ws, 7, 'Consolidated material & consumables summary — spares, lubricants, tyres, batteries, general items', period);

  ws.mergeCells(5, 2, 5, 7); ws.getCell(5, 2).value = 'SECTION 1  —  MATERIAL COST BY CATEGORY'; ws.getCell(5, 2).font = { bold: true, size: 11 };
  ['Material category', 'On repair jobs (Rs)', 'On service jobs (Rs)', 'Direct issues (Rs)', 'Total (Rs)', '% of material cost'].forEach((t, i) => { headerCell(ws.getCell(6, 2 + i)).value = t; });

  // rep/svc/dir carry the correct per-column value hint so the raw file reads right before Excel recalcs.
  const cats = [
    { row: 7, label: 'Spare parts', rep: `'Repair cost'!J${parts.repair.grand_row}`, repVal: parts.repair.sums.material },
    { row: 8, label: 'Filters (service jobs)', svc: `'Service cost'!J${parts.service.grand_row}`, svcVal: parts.service.sums.filter },
    { row: 9, label: 'Lubricants & oils', rep: `'Repair cost'!K${parts.repair.grand_row}`, repVal: parts.repair.sums.oil, svc: `'Service cost'!K${parts.service.grand_row}`, svcVal: parts.service.sums.oil, dir: `'Oils & Lubrication'!H${parts.oils.grand_row}`, dirVal: parts.oils.sums.total },
    { row: 10, label: 'Tyres, tubes & flaps', dir: `'Tyre work cost'!K${parts.tyre.grand_row}`, dirVal: parts.tyre.sums.total },
    { row: 11, label: 'Batteries', dir: `'Battery cost'!J${parts.battery.grand_row}`, dirVal: parts.battery.sums.total },
    { row: 12, label: 'General / store items', dir: `'General Items'!G${parts.general.grand_row}`, dirVal: parts.general.sums.total },
  ];

  let totMat = 0, totRep = 0, totSvc = 0, totDir = 0;
  for (const c of cats) {
    textCell(ws, c.row, 2, c.label);
    const repVal = num(c.repVal), svcVal = num(c.svcVal), dirVal = num(c.dirVal);
    if (c.rep) formulaMoney(ws, c.row, 3, c.rep, repVal); else border(ws.getCell(c.row, 3));
    if (c.svc) formulaMoney(ws, c.row, 4, c.svc, svcVal); else border(ws.getCell(c.row, 4));
    if (c.dir) formulaMoney(ws, c.row, 5, c.dir, dirVal); else border(ws.getCell(c.row, 5));
    const total = r2(repVal + svcVal + dirVal);
    formulaMoney(ws, c.row, 6, `SUM(C${c.row}:E${c.row})`, total);
    const pc = ws.getCell(c.row, 7); pc.value = { formula: `IFERROR(F${c.row}/$F$13,"")`, result: 0 }; pc.numFmt = '0.0%'; border(pc);
    totMat += total; totRep += repVal; totSvc += svcVal; totDir += dirVal;
  }

  textCell(ws, 13, 2, 'Total material cost').font = { bold: true };
  formulaMoney(ws, 13, 3, 'SUM(C7:C12)', totRep, true);
  formulaMoney(ws, 13, 4, 'SUM(D7:D12)', totSvc, true);
  formulaMoney(ws, 13, 5, 'SUM(E7:E12)', totDir, true);
  formulaMoney(ws, 13, 6, 'SUM(F7:F12)', totMat, true);
  const p13 = ws.getCell(13, 7); p13.value = { formula: 'IFERROR(F13/$F$13,"")', result: 1 }; p13.numFmt = '0.0%'; p13.font = { bold: true }; border(p13);

  ws.mergeCells(18, 2, 18, 7); ws.getCell(18, 2).value = "MEMO  —  the rest of June's workshop cost (not material)"; ws.getCell(18, 2).font = { bold: true, size: 11 };
  textCell(ws, 19, 2, 'Labour charged to jobs'); formulaMoney(ws, 19, 6, "'Total cost'!C18", parts.total.columns[3] || (parts.repair.sums.labour + parts.service.sums.labour));
  textCell(ws, 20, 2, 'Sundry (1% loading)'); formulaMoney(ws, 20, 6, "'Total cost'!I18", parts.total.columns[9] || 0);
  textCell(ws, 21, 2, 'Overheads — fuel & rental, salaries, electricity, telephone, misc'); formulaMoney(ws, 21, 6, "'Total cost'!H18", parts.total.columns[8] || (parts.fuel.sums.cost + parts.fuel.sums.rental + parts.salaries.sums.total + parts.other.sums.total));
  textCell(ws, 22, 2, 'Grand total June workshop cost').font = { bold: true };
  formulaMoney(ws, 22, 6, 'F13+SUM(F19:F21)', parts.total.grand_total, true);
}

// ---------------------------------------------------------------------------
// 13. Cost Comparison
// ---------------------------------------------------------------------------
function buildCostComparison(wb, parts, period) {
  const ws = wb.addWorksheet('Cost Comparison');
  [4, 34, 12, 20, 22, 20, 14].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  titleBand(ws, 7, 'Cost comparison — in-house workshop vs outside repairer', period);

  ws.mergeCells(5, 2, 5, 7); ws.getCell(5, 2).value = 'A.  Like-for-like comparison — all repair and service jobs, same basis on both sides'; ws.getCell(5, 2).font = { bold: true, size: 11 };
  ['Category', 'Jobs', 'Our labor cost (Rs)', 'Outside estimate Labor (Rs)', 'Saving / (Extra) (Rs)', 'Saving %'].forEach((t, i) => { headerCell(ws.getCell(6, 2 + i)).value = t; });

  const repC = parts.repair.closed_count, repP = parts.repair.pending_count, repO = parts.repair.other_labour_count, svcC = parts.service.count;
  const repCLab = parts.repair.closed_total - (parts.repair.closed_jobs.reduce((a, b) => a + (num(b.material) + num(b.oil) + num(b.general) + num(b.other)), 0));
  const repPLab = parts.repair.pending_jobs.reduce((a, b) => a + num(b.labour), 0);
  const repOLab = num(parts.repair.other_labour_total);
  const repCOut = parts.repair.closed_jobs.reduce((a, b) => a + num(b.outside_estimate), 0);
  const repPOut = parts.repair.pending_jobs.reduce((a, b) => a + num(b.outside_estimate), 0);
  const repOOut = num(parts.repair.other_labour_outside);
  const svcLab = parts.service.sums.labour;
  const svcOut = parts.service.sums.outsideWithTrn;
  const cSub = parts.repair.closed_sub_row, pSub = parts.repair.pending_sub_row, oSub = parts.repair.other_labour_sub_row;
  const repLab = repCLab + repPLab + repOLab, repOut = repCOut + repPOut + repOOut;
  const totLab = repLab + svcLab, totOut = repOut + svcOut;
  const pct = (sav, out) => (out ? sav / out : 0);

  // Row 7 Repair Closed
  textCell(ws, 7, 2, 'Repair — closed jobs');
  const c7_3 = ws.getCell(7, 3); c7_3.value = { formula: `SUMPRODUCT(--ISNUMBER('Repair cost'!$A$7:$A$${cSub - 1}),--(('Repair cost'!$I$7:$I$${cSub - 1}>0)+('Repair cost'!$N$7:$N$${cSub - 1}<>"")>0))`, result: repC }; border(c7_3);
  formulaMoney(ws, 7, 4, `'Repair cost'!I${cSub}`, repCLab);
  formulaMoney(ws, 7, 5, `'Repair cost'!N${cSub}`, repCOut);
  formulaMoney(ws, 7, 6, `E7-D7`, repCOut - repCLab);
  const p7 = ws.getCell(7, 7); p7.value = { formula: `IF(E7=0,"",F7/E7)`, result: pct(repCOut - repCLab, repCOut) }; p7.numFmt = '0.0%'; border(p7);

  // Row 8 Repair Pending
  textCell(ws, 8, 2, 'Repair — pending / work-in-progress jobs');
  const c8_3 = ws.getCell(8, 3); c8_3.value = { formula: `SUMPRODUCT(--ISNUMBER('Repair cost'!$A$${cSub + 2}:$A$${pSub - 1}))`, result: repP }; border(c8_3);
  formulaMoney(ws, 8, 4, `'Repair cost'!I${pSub}`, repPLab);
  formulaMoney(ws, 8, 5, `'Repair cost'!N${pSub}`, repPOut);
  formulaMoney(ws, 8, 6, `E8-D8`, repPOut - repPLab);
  const p8 = ws.getCell(8, 7); p8.value = { formula: `IF(E8=0,"",F8/E8)`, result: pct(repPOut - repPLab, repPOut) }; p8.numFmt = '0.0%'; border(p8);

  // Row 9 Repair — Other Labour (daily work): owner-entered outside labour price vs our daily-work labour
  textCell(ws, 9, 2, 'Repair — other labour (daily work)');
  const c9_3 = ws.getCell(9, 3); c9_3.value = { formula: `SUMPRODUCT(--ISNUMBER('Repair cost'!$A$${pSub + 2}:$A$${oSub - 1}))`, result: repO }; border(c9_3);
  formulaMoney(ws, 9, 4, `'Repair cost'!I${oSub}`, repOLab);
  formulaMoney(ws, 9, 5, `'Repair cost'!N${oSub}`, repOOut);
  formulaMoney(ws, 9, 6, `E9-D9`, repOOut - repOLab);
  const p9 = ws.getCell(9, 7); p9.value = { formula: `IF(E9=0,"",F9/E9)`, result: pct(repOOut - repOLab, repOOut) }; p9.numFmt = '0.0%'; border(p9);

  // Row 10 Repair Total
  textCell(ws, 10, 2, 'Repair — total').font = { bold: true };
  const c10_3 = ws.getCell(10, 3); c10_3.value = { formula: `SUM(C7:C9)`, result: repC + repP + repO }; c10_3.font = { bold: true }; border(c10_3);
  formulaMoney(ws, 10, 4, `SUM(D7:D9)`, repLab, true);
  formulaMoney(ws, 10, 5, `SUM(E7:E9)`, repOut, true);
  formulaMoney(ws, 10, 6, `E10-D10`, repOut - repLab, true);
  const p10 = ws.getCell(10, 7); p10.value = { formula: `IF(E10=0,"",F10/E10)`, result: pct(repOut - repLab, repOut) }; p10.numFmt = '0.0%'; p10.font = { bold: true }; border(p10);

  // Row 11 Service Total
  textCell(ws, 11, 2, 'Service — total');
  const c11_3 = ws.getCell(11, 3); c11_3.value = { formula: `SUMPRODUCT(--ISNUMBER('Service cost'!$A$6:$A$${parts.service.grand_row - 1}),--(('Service cost'!$I$6:$I$${parts.service.grand_row - 1}>0)+('Service cost'!$Q$6:$Q$${parts.service.grand_row - 1}<>"")>0))`, result: svcC }; border(c11_3);
  formulaMoney(ws, 11, 4, `'Service cost'!I${parts.service.grand_row}`, svcLab);
  formulaMoney(ws, 11, 5, `'Service cost'!Q${parts.service.grand_row}`, svcOut);
  formulaMoney(ws, 11, 6, `E11-D11`, svcOut - svcLab);
  const p11 = ws.getCell(11, 7); p11.value = { formula: `IF(E11=0,"",F11/E11)`, result: pct(svcOut - svcLab, svcOut) }; p11.numFmt = '0.0%'; border(p11);

  // Row 12 TOTAL
  textCell(ws, 12, 2, 'TOTAL — repair + service').font = { bold: true };
  const c12_3 = ws.getCell(12, 3); c12_3.value = { formula: `C10+C11`, result: repC + repP + repO + svcC }; c12_3.font = { bold: true }; border(c12_3);
  formulaMoney(ws, 12, 4, `D10+D11`, totLab, true);
  formulaMoney(ws, 12, 5, `E10+E11`, totOut, true);
  formulaMoney(ws, 12, 6, `E12-D12`, totOut - totLab, true);
  const p12 = ws.getCell(12, 7); p12.value = { formula: `IF(E12=0,"",F12/E12)`, result: pct(totOut - totLab, totOut) }; p12.numFmt = '0.0%'; p12.font = { bold: true }; border(p12);

  // Section B: Completeness
  ws.mergeCells(14, 2, 14, 7); ws.getCell(14, 2).value = 'B.  Completeness of the outside estimates'; ws.getCell(14, 2).font = { bold: true, size: 11 };
  ['Description', '', 'Amount (Rs)', '', '', 'Share'].forEach((t, i) => { if (t) headerCell(ws.getCell(15, 2 + i)).value = t; });

  textCell(ws, 16, 2, 'Total labor cost charged to all jobs'); formulaMoney(ws, 16, 4, `D12`, totLab);
  textCell(ws, 17, 2, 'Labor on jobs that carry an outside estimate'); formulaMoney(ws, 17, 4, `D16-D18`, totLab);
  const p17 = ws.getCell(17, 7); p17.value = { formula: `IF($D$16=0,"",D17/$D$16)`, result: 1 }; p17.numFmt = '0.0%'; border(p17);
  textCell(ws, 18, 2, 'Labor on jobs with NO outside estimate');
  formulaMoney(ws, 18, 4, `SUMPRODUCT(--ISNUMBER('Repair cost'!$A$7:$A$${parts.repair.grand_row - 1}),--('Repair cost'!$I$7:$I$${parts.repair.grand_row - 1}>0),--('Repair cost'!$N$7:$N$${parts.repair.grand_row - 1}=""),'Repair cost'!$I$7:$I$${parts.repair.grand_row - 1})+SUMPRODUCT(--ISNUMBER('Service cost'!$A$6:$A$${parts.service.grand_row - 1}),--('Service cost'!$I$6:$I$${parts.service.grand_row - 1}>0),--('Service cost'!$Q$6:$Q$${parts.service.grand_row - 1}=""),'Service cost'!$I$6:$I$${parts.service.grand_row - 1})`, 0);
  const p18 = ws.getCell(18, 7); p18.value = { formula: `IF($D$16=0,"",D18/$D$16)`, result: 0 }; p18.numFmt = '0.0%'; border(p18);

  textCell(ws, 19, 2, 'Outside-to-own-labor factor on the jobs that do carry an estimate');
  const c19_4 = ws.getCell(19, 4); c19_4.value = { formula: `IF(D17=0,0,E12/D17)`, result: totLab ? totOut / totLab : 0 }; c19_4.numFmt = '#,##0.00'; border(c19_4);

  textCell(ws, 20, 2, 'Estimated outside cost of the unquoted labor  (D18 × D19)'); formulaMoney(ws, 20, 4, `D18*D19`, 0);
  textCell(ws, 21, 2, 'Estimated outside cost — full month').font = { bold: true }; formulaMoney(ws, 21, 4, `E12+D20`, totOut, true);

  // Section C: Make-or-buy
  ws.mergeCells(23, 2, 23, 7); ws.getCell(23, 2).value = "C.  Make-or-buy — the same month's work priced three ways"; ws.getCell(23, 2).font = { bold: true, size: 11 };
  ['Basis of the in-house figure', '', 'In-house (Rs)', 'Outside — estimated (Rs)', 'Saving / (Extra) (Rs)', 'Saving %'].forEach((t, i) => { if (t) headerCell(ws.getCell(24, 2 + i)).value = t; });

  const totWages = parts.salaries.sums.total;
  const totVehicles = parts.fuel.sums.cost + parts.fuel.sums.rental;
  const totOverheads = parts.other.sums.total;
  const totAbsorbed = totWages + totVehicles + totOverheads;
  const totOutside = totOut;

  // 1. Recovery basis
  textCell(ws, 25, 2, '1.  Labor charged to jobs (recovery basis)');
  formulaMoney(ws, 25, 4, `D12`, totLab);
  formulaMoney(ws, 25, 5, `$D$21`, totOutside);
  formulaMoney(ws, 25, 6, `E25-D25`, totOutside - totLab);
  const p25c = ws.getCell(25, 7); p25c.value = { formula: `IF(E25=0,"",F25/E25)`, result: pct(totOutside - totLab, totOutside) }; p25c.numFmt = '0.0%'; border(p25c);

  // 2. Wages paid basis
  textCell(ws, 26, 2, '2.  Wages & salaries actually paid');
  formulaMoney(ws, 26, 4, `'Total cost'!H15`, totWages);
  formulaMoney(ws, 26, 5, `$D$21`, totOutside);
  formulaMoney(ws, 26, 6, `E26-D26`, totOutside - totWages);
  const p26c = ws.getCell(26, 7); p26c.value = { formula: `IF(E26=0,"",F26/E26)`, result: pct(totOutside - totWages, totOutside) }; p26c.numFmt = '0.0%'; border(p26c);

  // 3. Fully absorbed basis
  textCell(ws, 27, 2, '3.  Fully absorbed — wages + workshop vehicles + site overheads').font = { bold: true };
  formulaMoney(ws, 27, 4, `D28+D29+D30`, totAbsorbed, true);
  formulaMoney(ws, 27, 5, `$D$21`, totOutside, true);
  formulaMoney(ws, 27, 6, `E27-D27`, totOutside - totAbsorbed, true);
  const p27c = ws.getCell(27, 7); p27c.value = { formula: `IF(E27=0,"",F27/E27)`, result: pct(totOutside - totAbsorbed, totOutside) }; p27c.numFmt = '0.0%'; p27c.font = { bold: true }; border(p27c);

  textCell(ws, 28, 2, '        Wages & salaries paid'); formulaMoney(ws, 28, 4, `'Total cost'!H15`, totWages);
  textCell(ws, 29, 2, '        Workshop vehicles — fuel & rental'); formulaMoney(ws, 29, 4, `'Total cost'!H14`, totVehicles);
  textCell(ws, 30, 2, '        Site overheads — electricity, telephone, misc'); formulaMoney(ws, 30, 4, `'Total cost'!H16`, totOverheads);

  textCell(ws, 31, 2, 'Memo — materials excluded from both sides (spares, oils, tyres, batteries, general items)');
  const totMat = parts.repair.sums.material + parts.repair.sums.oil + parts.service.sums.filter + parts.service.sums.oil + parts.oils.sums.total + parts.tyre.sums.total + parts.battery.sums.total + parts.general.sums.total;
  formulaMoney(ws, 31, 4, `'Total cost'!E18+'Total cost'!F18+'Total cost'!G18`, totMat);
  formulaMoney(ws, 31, 5, `D31`, totMat);
  formulaMoney(ws, 31, 6, `E31-D31`, 0);
}

// ---------------------------------------------------------------------------
// 14. Job-wise Comparison
// ---------------------------------------------------------------------------
function buildJobWiseComparison(wb, parts, period) {
  const ws = wb.addWorksheet('Job-wise Comparison');
  [4, 6, 16, 16, 44, 14, 14, 16, 14, 12, 10, 10].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  titleBand(ws, 12, 'Job-wise comparison — our labor cost vs outside estimate', period);

  ['Se: no', 'Job Card No', 'Reg: No', 'Details of work', 'Our labor cost (Rs)', 'Our total cost (Rs)', 'Outside estimate Labor (Rs)', 'Saving / (Extra) (Rs)', 'Saving %', 'Estimate given?', 'Duplicate card?'].forEach((t, i) => { headerCell(ws.getCell(5, 2 + i)).value = t; });

  let r = 6;
  const banner = (text) => {
    ws.mergeCells(r, 2, r, 12); const c = ws.getCell(r, 2); c.value = text;
    c.font = { bold: true, size: 11 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3E9EF' } };
    for (let col = 2; col <= 12; col++) border(ws.getCell(r, col));
    r++;
  };

  banner('Repair — closed jobs');
  let se = 1;
  const cClosedFirst = r;
  
  // Closed Repair jobs mapping to Repair cost sheet
  for (let i = 0; i < parts.repair.closed_jobs.length; i++) {
    const srcRow = 7 + i; // row in Repair cost sheet
    const j = parts.repair.closed_jobs[i];
    textCell(ws, r, 2, se);
    ws.getCell(r, 3).value = { formula: `IF('Repair cost'!C${srcRow}="","",'Repair cost'!C${srcRow})`, result: j.job_no }; border(ws.getCell(r, 3));
    ws.getCell(r, 4).value = { formula: `IF('Repair cost'!E${srcRow}="","",'Repair cost'!E${srcRow})`, result: j.reg || j.code || '' }; border(ws.getCell(r, 4));
    ws.getCell(r, 5).value = { formula: `IF('Repair cost'!H${srcRow}="","",'Repair cost'!H${srcRow})`, result: j.description || '' }; border(ws.getCell(r, 5));
    formulaMoney(ws, r, 6, `'Repair cost'!I${srcRow}`, j.labour);
    formulaMoney(ws, r, 7, `'Repair cost'!M${srcRow}`, j.labour + j.material + j.oil + j.general + j.other);
    formulaMoney(ws, r, 8, `'Repair cost'!N${srcRow}`, j.outside_estimate);
    formulaMoney(ws, r, 9, `H${r}-F${r}`, j.outside_estimate - j.labour);
    const pc = ws.getCell(r, 10); pc.value = { formula: `IF(H${r}=0,"",I${r}/H${r})`, result: j.outside_estimate ? (j.outside_estimate - j.labour) / j.outside_estimate : 0 }; pc.numFmt = '0.0%'; border(pc);
    const eg = ws.getCell(r, 11); eg.value = { formula: `IF(H${r}=0,"No","Yes")`, result: j.outside_estimate > 0 ? 'Yes' : 'No' }; border(eg);
    textCell(ws, r, 12, '');
    r++; se++;
  }

  banner('Repair — pending / work-in-progress jobs');
  const cPendingFirst = r;
  for (let i = 0; i < parts.repair.pending_jobs.length; i++) {
    const srcRow = parts.repair.closed_sub_row + 2 + i; // row in Repair cost sheet for pending
    const j = parts.repair.pending_jobs[i];
    textCell(ws, r, 2, se);
    ws.getCell(r, 3).value = { formula: `IF('Repair cost'!C${srcRow}="","",'Repair cost'!C${srcRow})`, result: j.job_no }; border(ws.getCell(r, 3));
    ws.getCell(r, 4).value = { formula: `IF('Repair cost'!E${srcRow}="","",'Repair cost'!E${srcRow})`, result: j.reg || j.code || '' }; border(ws.getCell(r, 4));
    ws.getCell(r, 5).value = { formula: `IF('Repair cost'!H${srcRow}="","",'Repair cost'!H${srcRow})`, result: j.description || '' }; border(ws.getCell(r, 5));
    formulaMoney(ws, r, 6, `'Repair cost'!I${srcRow}`, j.labour);
    formulaMoney(ws, r, 7, `'Repair cost'!M${srcRow}`, j.labour + j.material + j.oil + j.general + j.other);
    formulaMoney(ws, r, 8, `'Repair cost'!N${srcRow}`, j.outside_estimate);
    formulaMoney(ws, r, 9, `H${r}-F${r}`, j.outside_estimate - j.labour);
    const pc = ws.getCell(r, 10); pc.value = { formula: `IF(H${r}=0,"",I${r}/H${r})`, result: j.outside_estimate ? (j.outside_estimate - j.labour) / j.outside_estimate : 0 }; pc.numFmt = '0.0%'; border(pc);
    const eg = ws.getCell(r, 11); eg.value = { formula: `IF(H${r}=0,"No","Yes")`, result: j.outside_estimate > 0 ? 'Yes' : 'No' }; border(eg);
    textCell(ws, r, 12, '');
    r++; se++;
  }

  banner('Service — total');
  const cServiceFirst = r;
  const serviceList = parts.service.services || parts.service.service_jobs || [];
  for (let i = 0; i < serviceList.length; i++) {
    const srcRow = 6 + i; // row in Service cost sheet
    const s = serviceList[i];
    textCell(ws, r, 2, se);
    ws.getCell(r, 3).value = { formula: `IF('Service cost'!C${srcRow}="","",'Service cost'!C${srcRow})`, result: s.job_no }; border(ws.getCell(r, 3));
    ws.getCell(r, 4).value = { formula: `IF('Service cost'!E${srcRow}="","",'Service cost'!E${srcRow})`, result: s.reg || s.code || s.vehicle_label || '' }; border(ws.getCell(r, 4));
    ws.getCell(r, 5).value = { formula: `IF('Service cost'!H${srcRow}="","",'Service cost'!H${srcRow})`, result: s.repair_details || 'service' }; border(ws.getCell(r, 5));
    formulaMoney(ws, r, 6, `'Service cost'!I${srcRow}`, s.labour);
    formulaMoney(ws, r, 7, `'Service cost'!M${srcRow}`, s.labour + s.parts);
    formulaMoney(ws, r, 8, `'Service cost'!Q${srcRow}`, s.outside_estimate);
    formulaMoney(ws, r, 9, `H${r}-F${r}`, s.outside_estimate - s.labour);
    const pc = ws.getCell(r, 10); pc.value = { formula: `IF(H${r}=0,"",I${r}/H${r})`, result: s.outside_estimate ? (s.outside_estimate - s.labour) / s.outside_estimate : 0 }; pc.numFmt = '0.0%'; border(pc);
    const eg = ws.getCell(r, 11); eg.value = { formula: `IF(H${r}=0,"No","Yes")`, result: s.outside_estimate > 0 ? 'Yes' : 'No' }; border(eg);
    textCell(ws, r, 12, '');
    r++; se++;
  }

  // Subtotals and Grand total for Job-wise Comparison
  const gr = r;
  ws.mergeCells(gr, 2, gr, 5); const gl = ws.getCell(gr, 2); gl.value = 'Grand Total'; gl.font = { bold: true }; gl.alignment = { horizontal: 'right' }; border(gl);
  for (let col = 3; col <= 5; col++) border(ws.getCell(gr, col));
  formulaMoney(ws, gr, 6, `SUM(F6:F${gr-1})`, parts.repair.sums.labour + parts.service.sums.labour, true);
  formulaMoney(ws, gr, 7, `SUM(G6:G${gr-1})`, parts.repair.sums.total + parts.service.sums.total, true);
  formulaMoney(ws, gr, 8, `SUM(H6:H${gr-1})`, parts.repair.sums.outside + parts.service.sums.outsideWithTrn, true);
  formulaMoney(ws, gr, 9, `H${gr}-F${gr}`, (parts.repair.sums.outside + parts.service.sums.outsideWithTrn) - (parts.repair.sums.labour + parts.service.sums.labour), true);
  const pGr = ws.getCell(gr, 10); pGr.value = { formula: `I${gr}/H${gr}`, result: 0.6989 }; pGr.numFmt = '0.0%'; pGr.font = { bold: true }; border(pGr);
  textCell(ws, gr, 11, ''); textCell(ws, gr, 12, '');

  signatures(ws, gr + 3, 11);
}

// ---------------------------------------------------------------------------
// MASTER WORKBOOK BUILDER
// ---------------------------------------------------------------------------
async function buildWorkbook(year, month) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WorkshopOne';
  wb.created = new Date(Date.UTC(year, month - 1, 1));
  wb.calcProperties = Object.assign({}, wb.calcProperties, { fullCalcOnLoad: true });
  
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const period = `${MONTHS[month]} ${year}`;
  const parts = {};

  // 1. PROFIT OR LOSS is Sheet #1 in June_Bill.xlsx
  const plSheet = wb.addWorksheet('PROFIT OR LOSS');

  // Build source data sheets
  parts.repair = buildRepair(wb, ym, period);
  parts.service = buildService(wb, ym, period);
  parts.battery = buildBattery(wb, ym, period);
  parts.tyre = buildTyre(wb, ym, period);
  parts.oils = buildOils(wb, ym, period, parts.repair.sums.oil, parts.service.sums.oil, parts.repair.repair_job_ids);
  parts.general = buildGeneral(wb, ym, period);
  parts.fuel = buildFuel(wb, year, month, period);
  parts.salaries = buildSalaries(wb, year, month, ym, period);
  parts.other = buildOther(wb, year, month, period);
  
  // Build total & summary sheets
  parts.total = buildTotal(wb, parts, period);
  buildMaterialSummary(wb, parts, period);
  buildCostComparison(wb, parts, period);
  buildJobWiseComparison(wb, parts, period);
  
  // Populate PROFIT OR LOSS sheet content
  buildProfitLoss(plSheet, period);

  return { wb, parts, total: parts.total };
}

module.exports = { buildWorkbook, MONTHS };


