'use strict';

// Monthly Cost Report — replicates the company's "Job cost report" workbook (8 sheets:
// Repair, Service, Tyre, Battery, Fuel, Salaries, Other, Total) for a given year+month.
//
// Data-backed sheets are computed from live data:
//   Repair  ← job_cards completed in the month (+ an "Ongoing Job Labour" row for WIP)
//   Service ← service_jobs in the month (labour + filter + lubricant + other; sundry excluded
//             on the sheet — the Total sheet applies the uniform 10% Sundry, as in the original)
//   Salaries (right "Actual" table) ← job_labour aggregated per mechanic in the month
// The five sheets the system can't source from transactions read from monthly_report_inputs:
//   Tyre, Battery, Fuel, Other (overhead), Salaries (left Staff/Security lump-sum table).
//
// Every grand total is written as a live Excel formula AND a pre-computed { result },
// so the workbook shows correct figures immediately and stays a formula workbook.

const ExcelJS = require('exceljs');
const { all, get } = require('../db');

const COMPANY = 'Edward and Christie (Pvt) Ltd — Badalgama W/S';
const MONEY = '#,##0.00';
const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SIG_TITLES = [
  { role: 'Prepared By', title: '(Cost Officer)' },
  { role: 'Checked By', title: '(Mechanical Engineer)' },
  { role: 'Approved By', title: '(Senior Operation Manager)' },
];

const num = (v) => Number(v) || 0;
const r2 = (v) => Math.round(num(v) * 100) / 100;   // 2-dp round — kills float noise (e.g. 5.4e-10)
const fmtMoney = (v) => r2(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateOnly = (v) => (v ? String(v).slice(0, 10) : '');
function colL(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; }

const THIN = { style: 'thin', color: { argb: 'FF999999' } };
function border(c) { c.border = { top: THIN, left: THIN, bottom: THIN, right: THIN }; }
function headerCell(c) {
  c.font = { bold: true, size: 10 };
  c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEFF1' } };
  border(c);
}
function moneyCell(ws, row, col, v) { const c = ws.getCell(row, col); c.value = r2(v); c.numFmt = MONEY; c.alignment = { horizontal: 'right' }; border(c); return c; }
function textCell(ws, row, col, v, opts) { const c = ws.getCell(row, col); c.value = v == null ? '' : v; c.alignment = { vertical: 'top', wrapText: !!(opts && opts.wrap) }; border(c); return c; }
function formulaMoney(ws, row, col, formula, result, bold) {
  const c = ws.getCell(row, col); c.value = { formula, result: r2(result) };
  c.numFmt = MONEY; c.alignment = { horizontal: 'right' }; if (bold) c.font = { bold: true }; border(c); return c;
}

// Company + subtitle band across the first two rows.
function titleBand(ws, ncols, subtitle, period) {
  ws.mergeCells(1, 1, 1, ncols);
  const a = ws.getCell(1, 1); a.value = COMPANY; a.font = { bold: true, size: 13 }; a.alignment = { horizontal: 'center' };
  ws.mergeCells(2, 1, 2, ncols);
  const b = ws.getCell(2, 1); b.value = subtitle + ' — ' + period; b.font = { bold: true, size: 11 }; b.alignment = { horizontal: 'center' };
  ws.getRow(1).height = 20; ws.getRow(2).height = 18;
}

// Standard three-column signature block starting at `row`.
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
  return all('SELECT * FROM monthly_report_inputs WHERE year = ? AND month = ? AND sheet = ? ORDER BY seq, id', year, month, sheet);
}

// ---------------------------------------------------------------------------
// Repair cost
// ---------------------------------------------------------------------------
function buildRepair(wb, ym, period) {
  const ws = wb.addWorksheet('Repair cost');
  [6, 14, 16, 20, 12, 12, 18, 44, 12, 13, 12, 13, 13, 14, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  titleBand(ws, 15, 'Workshop repairing cost calculation for vehicles and machinery', period);
  const single = ['Se: no', 'Date (complete date)', 'Job Card No', 'Type of Machinery / Vehicle', 'Reg: No', 'Company Code', 'Project / Plant', 'Details of Repairing'];
  single.forEach((t, i) => { ws.mergeCells(4, i + 1, 5, i + 1); const c = ws.getCell(4, i + 1); c.value = t; headerCell(c); });
  ws.mergeCells(4, 9, 4, 14); const grp = ws.getCell(4, 9); grp.value = 'Repairing Cost (Rs)'; headerCell(grp);
  ['Labor cost', 'Spare parts cost', 'Lubricant cost', 'Other material cost', 'Out side work cost', 'Total Cost'].forEach((t, i) => { const c = ws.getCell(5, 9 + i); c.value = t; headerCell(c); });
  ws.mergeCells(4, 15, 5, 15); const rem = ws.getCell(4, 15); rem.value = 'Remarks'; headerCell(rem);

  // Two sections: CLOSED (status CLOSED, completed in the month — final costs) and
  // PENDING (open jobs worked in the month — costs accrued to date). Grand total = both.
  const JOB_COLS = `j.id, j.job_no, j.completed_at, j.requested_at, j.created_at, j.status, j.description, j.site,
            a.type atype, a.registration reg, a.code code, a.ec_code ec, p.name project,
            COALESCE(j.labour_cost,0) labour, COALESCE(j.material_cost,0) material, COALESCE(j.oil_cost,0) oil,
            COALESCE(j.general_cost,0) general, COALESCE(j.other_cost,0) other, COALESCE(j.external_cost,0) external`;
  const JOB_FROM = 'FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id LEFT JOIN projects p ON p.id = j.project_id';
  const closed = all(`SELECT ${JOB_COLS} ${JOB_FROM}
      WHERE j.status = 'CLOSED' AND j.completed_at IS NOT NULL AND substr(j.completed_at,1,7) = ?
      ORDER BY j.completed_at, j.id`, ym);
  const pending = all(`SELECT ${JOB_COLS} ${JOB_FROM}
      WHERE j.status NOT IN ('CLOSED','REJECTED')
        AND j.id IN (SELECT DISTINCT job_id FROM job_labour WHERE substr(work_date,1,7) = ?)
      ORDER BY COALESCE(j.requested_at, j.created_at), j.id`, ym);

  const sums = { labour: 0, material: 0, oil: 0, other: 0, external: 0, total: 0 };
  const newSec = () => ({ labour: 0, material: 0, oil: 0, other: 0, external: 0, total: 0 });
  const KEYS = [[9, 'labour'], [10, 'material'], [11, 'oil'], [12, 'other'], [13, 'external'], [14, 'total']];
  let r = 6, se = 1;

  const jobRow = (j, dateVal, sec) => {
    const other = num(j.general) + num(j.other);
    const total = num(j.labour) + num(j.material) + num(j.oil) + other + num(j.external);
    textCell(ws, r, 1, se); textCell(ws, r, 2, dateOnly(dateVal)); textCell(ws, r, 3, j.job_no);
    textCell(ws, r, 4, j.atype || ''); textCell(ws, r, 5, j.reg || j.code || ''); textCell(ws, r, 6, j.ec || '');
    textCell(ws, r, 7, j.project || j.site || ''); textCell(ws, r, 8, j.description || '', { wrap: true });
    moneyCell(ws, r, 9, j.labour); moneyCell(ws, r, 10, j.material); moneyCell(ws, r, 11, j.oil);
    moneyCell(ws, r, 12, other); moneyCell(ws, r, 13, j.external); moneyCell(ws, r, 14, total); textCell(ws, r, 15, '');
    const vals = { labour: num(j.labour), material: num(j.material), oil: num(j.oil), other, external: num(j.external), total };
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
    textCell(ws, r, 15, ''); return r++;
  };

  const closedSec = newSec(), pendingSec = newSec();
  banner(`Closed Jobs — completed & closed in ${period} (${closed.length})`);
  const cFirst = r; for (const j of closed) jobRow(j, j.completed_at, closedSec);
  const cSub = subtotal('Closed jobs subtotal', cFirst, r - 1, closedSec);
  banner(`Pending Jobs — open / work-in-progress worked in ${period}, cost accrued to date (${pending.length})`);
  const pFirst = r; for (const j of pending) jobRow(j, j.requested_at || j.created_at, pendingSec);
  const pSub = subtotal('Pending jobs subtotal', pFirst, r - 1, pendingSec);

  // Grand total = closed subtotal + pending subtotal (NOT a contiguous SUM — that would
  // re-add the banner/subtotal rows). Reference the two subtotal cells directly.
  const gr = r;
  ws.mergeCells(gr, 1, gr, 8); const gl = ws.getCell(gr, 1); gl.value = 'Grand total cost (closed + pending)'; gl.font = { bold: true }; gl.alignment = { horizontal: 'right' }; border(gl);
  for (let col = 2; col <= 8; col++) border(ws.getCell(gr, col));
  for (const [col, key] of KEYS) formulaMoney(ws, gr, col, `${colL(col)}${cSub}+${colL(col)}${pSub}`, sums[key], true);
  textCell(ws, gr, 15, '');
  signatures(ws, gr + 3, 15);
  const q = (col) => `'Repair cost'!${colL(col)}${gr}`;
  return {
    name: 'Repair cost', sums, count: closed.length + pending.length,
    closed_count: closed.length, pending_count: pending.length,
    closed_total: closedSec.total, pending_total: pendingSec.total,
    // Jobs actually shown on this sheet — their oil is in the Lubricant column, so the Oils sheet
    // must EXCLUDE these (and only these) job ids to avoid double-count while still catching oil on
    // jobs that never appear here (REQUESTED/no-labour, rejected, closed in another month).
    repair_job_ids: closed.concat(pending).map((j) => j.id),
    refs: { labour: q(9), material: q(10), oil: q(11), other: q(12), external: q(13), total: q(14) },
  };
}

// ---------------------------------------------------------------------------
// Service cost
// ---------------------------------------------------------------------------
function buildService(wb, ym, period) {
  const ws = wb.addWorksheet('Service cost');
  [6, 14, 16, 20, 12, 12, 18, 40, 12, 13, 12, 13, 12, 14, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  titleBand(ws, 15, 'Workshop servicing cost calculation for vehicles and machinery', period);
  const single = ['Se: no', 'Date (complete date)', 'Job Card No', 'Type of Machinery / Vehicle', 'Reg: No', 'Company Code', 'Project / Plant', 'Details'];
  single.forEach((t, i) => { ws.mergeCells(4, i + 1, 5, i + 1); const c = ws.getCell(4, i + 1); c.value = t; headerCell(c); });
  ws.mergeCells(4, 9, 4, 14); const grp = ws.getCell(4, 9); grp.value = 'Repairing Cost (Rs)'; headerCell(grp);
  ['Labor cost', 'Filter cost', 'Lubricant cost', 'Other material cost', 'Out side work cost', 'Total Cost'].forEach((t, i) => { const c = ws.getCell(5, 9 + i); c.value = t; headerCell(c); });
  ws.mergeCells(4, 15, 5, 15); const rem = ws.getCell(4, 15); rem.value = 'Remarks'; headerCell(rem);

  // parts_subtotal is authoritative in BOTH data conventions (legacy import stored filter.price as a
  // LINE total; the live service form stores it as a UNIT price with a separate qty). Oil.price and
  // service_parts.amount are line totals in both. So derive Filter = parts_subtotal − oil − other_parts;
  // this reconciles regardless of the filter convention (avoids under/over-counting qty>1 filter lines).
  const rows = all(
    `SELECT s.id, s.service_date, s.job_no, s.vehicle_label, s.site_location, s.repair_details,
            COALESCE(s.labour_charge,0) labour, COALESCE(s.parts_subtotal,0) parts,
            a.type atype, a.registration reg, a.code code, a.ec_code ec,
            (SELECT COALESCE(SUM(price),0) FROM service_oils WHERE service_id = s.id) oil,
            (SELECT COALESCE(SUM(amount),0) FROM service_parts WHERE service_id = s.id) other_parts
       FROM service_jobs s LEFT JOIN assets a ON a.id = s.asset_id
      WHERE substr(s.service_date,1,7) = ? ORDER BY s.service_date, s.id`, ym);

  const sums = { labour: 0, filter: 0, oil: 0, other: 0, external: 0, total: 0 };
  let r = 6, se = 1;
  for (const s of rows) {
    const oil = r2(s.oil), otherParts = r2(s.other_parts);
    const filter = Math.max(0, r2(num(s.parts) - oil - otherParts));
    const other = otherParts;
    const total = r2(num(s.labour) + filter + oil + other);
    textCell(ws, r, 1, se); textCell(ws, r, 2, dateOnly(s.service_date)); textCell(ws, r, 3, s.job_no);
    textCell(ws, r, 4, s.atype || ''); textCell(ws, r, 5, s.reg || s.code || s.vehicle_label || ''); textCell(ws, r, 6, s.ec || '');
    textCell(ws, r, 7, s.site_location || ''); textCell(ws, r, 8, s.repair_details || 'service', { wrap: true });
    moneyCell(ws, r, 9, s.labour); moneyCell(ws, r, 10, filter); moneyCell(ws, r, 11, oil);
    moneyCell(ws, r, 12, other); moneyCell(ws, r, 13, 0); moneyCell(ws, r, 14, total); textCell(ws, r, 15, '');
    sums.labour += num(s.labour); sums.filter += filter; sums.oil += oil; sums.other += other; sums.total += total;
    r++; se++;
  }
  const last = r - 1, gr = r;
  ws.mergeCells(gr, 1, gr, 8); const gl = ws.getCell(gr, 1); gl.value = 'Grand total cost'; gl.font = { bold: true }; gl.alignment = { horizontal: 'right' }; border(gl);
  for (let col = 2; col <= 8; col++) border(ws.getCell(gr, col));
  const colKeys = [[9, 'labour'], [10, 'filter'], [11, 'oil'], [12, 'other'], [13, 'external'], [14, 'total']];
  for (const [col, key] of colKeys) {
    if (last >= 6) formulaMoney(ws, gr, col, `SUM(${colL(col)}6:${colL(col)}${last})`, sums[key], true);
    else moneyCell(ws, gr, col, 0).font = { bold: true };
  }
  textCell(ws, gr, 15, '');
  signatures(ws, gr + 3, 15);
  const q = (col) => `'Service cost'!${colL(col)}${gr}`;
  return { name: 'Service cost', sums, count: rows.length, refs: { labour: q(9), filter: q(10), oil: q(11), other: q(12), external: q(13), total: q(14) } };
}

// ---------------------------------------------------------------------------
// Tyre work cost (from monthly_report_inputs)
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

  // Auto-sourced from the tyre issue ledger. Tyre cost = qty × price (per-issue override, else category price).
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
  return { name: 'Tyre work cost', sums, count: rows.length, refs: { tyre: q(8), tube: q(9), outside: q(10), total: q(11) } };
}

// ---------------------------------------------------------------------------
// Battery cost (from monthly_report_inputs)
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

  // Auto-sourced from the battery issue ledger. Battery cost = qty × price (per-issue override, else category price).
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
  return { name: 'Battery cost', sums, count: rows.length, refs: { battery: q(8), other: q(9), total: q(10) } };
}

// ---------------------------------------------------------------------------
// Fuel cost (from monthly_report_inputs; fuel cost = qty litres × rate)
// ---------------------------------------------------------------------------
function buildFuel(wb, year, month, period) {
  const ws = wb.addWorksheet('Fuel Cost');
  [6, 14, 14, 20, 12, 10, 12, 14, 13, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  titleBand(ws, 10, 'Fuel cost calculation for vehicles and machinery', period);
  const single = ['Se: no', 'Date (from)', 'Date (to)', 'Type of Machinery / Vehicle', 'Reg: No', 'Qty (L)'];
  single.forEach((t, i) => { ws.mergeCells(4, i + 1, 5, i + 1); const c = ws.getCell(4, i + 1); c.value = t; headerCell(c); });
  ws.mergeCells(4, 7, 4, 8); const grp = ws.getCell(4, 7); grp.value = 'Fuel Cost (Rs)'; headerCell(grp);
  ['Fuel Rate', 'Fuel Cost'].forEach((t, i) => { const c = ws.getCell(5, 7 + i); c.value = t; headerCell(c); });
  ws.mergeCells(4, 9, 5, 9); const sr = ws.getCell(4, 9); sr.value = 'Standard Rate'; headerCell(sr);
  ws.mergeCells(4, 10, 5, 10); const rem = ws.getCell(4, 10); rem.value = 'Remarks'; headerCell(rem);

  const rows = inputRows(year, month, 'fuel');
  const mFrom = `${year}-${String(month).padStart(2, '0')}-01`;
  const mTo = `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;
  const sums = { qty: 0, cost: 0 };
  let r = 6, se = 1;
  for (const x of rows) {
    const litres = num(x.qty), rate = num(x.rate), cost = litres * rate;
    textCell(ws, r, 1, se); textCell(ws, r, 2, mFrom); textCell(ws, r, 3, mTo);
    textCell(ws, r, 4, x.label || ''); textCell(ws, r, 5, x.vehicle || '');
    const qc = ws.getCell(r, 6); qc.value = litres; qc.numFmt = '#,##0.##'; qc.alignment = { horizontal: 'right' }; border(qc);
    moneyCell(ws, r, 7, rate);
    formulaMoney(ws, r, 8, `F${r}*G${r}`, cost);
    moneyCell(ws, r, 9, x.amount2); textCell(ws, r, 10, '');
    sums.qty += litres; sums.cost += cost;
    r++; se++;
  }
  const last = r - 1, gr = r;
  ws.mergeCells(gr, 1, gr, 5); const gl = ws.getCell(gr, 1); gl.value = 'Grand total cost'; gl.font = { bold: true }; gl.alignment = { horizontal: 'right' }; border(gl);
  for (let col = 2; col <= 5; col++) border(ws.getCell(gr, col));
  if (last >= 6) { const qc = ws.getCell(gr, 6); qc.value = { formula: `SUM(F6:F${last})`, result: sums.qty }; qc.numFmt = '#,##0.##'; qc.alignment = { horizontal: 'right' }; qc.font = { bold: true }; border(qc); }
  else { const qc = ws.getCell(gr, 6); qc.value = 0; border(qc); }
  border(ws.getCell(gr, 7));
  if (last >= 6) formulaMoney(ws, gr, 8, `SUM(H6:H${last})`, sums.cost, true); else moneyCell(ws, gr, 8, 0).font = { bold: true };
  border(ws.getCell(gr, 9)); textCell(ws, gr, 10, '');
  signatures(ws, gr + 3, 10);
  return { name: 'Fuel Cost', sums, count: rows.length, refs: { cost: `'Fuel Cost'!H${gr}` } };
}

// ---------------------------------------------------------------------------
// Salaries cost — left "Staff/Security" table from inputs (feeds the Total sheet),
// right "Actual" mechanic-hours table auto-derived from job_labour (informational).
// ---------------------------------------------------------------------------
function buildSalaries(wb, year, month, ym, period) {
  const ws = wb.addWorksheet('Salaries Cost');
  [6, 22, 8, 20, 14, 12, 14, 4, 18, 16, 12, 14].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  titleBand(ws, 12, 'Salaries cost calculation', period);
  // Left table headers (A..G)
  ['Se: no', 'Name', 'Qty', 'Project / Plant'].forEach((t, i) => { ws.mergeCells(4, i + 1, 5, i + 1); const c = ws.getCell(4, i + 1); c.value = t; headerCell(c); });
  ws.mergeCells(4, 5, 4, 7); const grp = ws.getCell(4, 5); grp.value = 'Salaries Cost (Rs)'; headerCell(grp);
  ['Cost', 'Other', 'Total Cost'].forEach((t, i) => { const c = ws.getCell(5, 5 + i); c.value = t; headerCell(c); });
  // Right table headers (I..L)
  [['Name', 9], ['Total Working Hours', 10], ['Hourly Rate', 11], ['Total', 12]].forEach(([t, col]) => { ws.mergeCells(4, col, 5, col); const c = ws.getCell(4, col); c.value = t; headerCell(c); });

  // Left: manual staff/security lump sums
  const staff = inputRows(year, month, 'salary');
  const sums = { cost: 0, other: 0, total: 0 };
  let r = 6, se = 1;
  for (const x of staff) {
    const c1 = num(x.amount1), c2 = num(x.amount2), tot = c1 + c2;
    textCell(ws, r, 1, se); textCell(ws, r, 2, x.label || ''); textCell(ws, r, 3, x.qty || ''); textCell(ws, r, 4, x.project || '');
    moneyCell(ws, r, 5, c1); moneyCell(ws, r, 6, c2); moneyCell(ws, r, 7, tot);
    sums.cost += c1; sums.other += c2; sums.total += tot;
    r++; se++;
  }
  const lLast = r - 1, lGr = r;
  ws.mergeCells(lGr, 1, lGr, 4); const gl = ws.getCell(lGr, 1); gl.value = 'Grand total cost'; gl.font = { bold: true }; gl.alignment = { horizontal: 'right' }; border(gl);
  for (let col = 2; col <= 4; col++) border(ws.getCell(lGr, col));
  const lKeys = [[5, 'cost'], [6, 'other'], [7, 'total']];
  for (const [col, key] of lKeys) {
    if (lLast >= 6) formulaMoney(ws, lGr, col, `SUM(${colL(col)}6:${colL(col)}${lLast})`, sums[key], true);
    else moneyCell(ws, lGr, col, 0).font = { bold: true };
  }

  // Right: auto mechanic hours from job_labour
  const mechs = all(
    `SELECT jl.mechanic, ROUND(SUM(jl.hours),2) hours, ROUND(SUM(jl.amount),2) amount
       FROM job_labour jl WHERE substr(jl.work_date,1,7) = ? AND jl.mechanic IS NOT NULL AND TRIM(jl.mechanic) <> ''
      GROUP BY jl.mechanic ORDER BY amount DESC`, ym);
  let rr = 6; const mTot = { hours: 0, amount: 0 };
  for (const m of mechs) {
    const hours = num(m.hours), amount = num(m.amount), rate = hours ? amount / hours : 0;
    textCell(ws, rr, 9, m.mechanic); const hc = ws.getCell(rr, 10); hc.value = hours; hc.numFmt = '#,##0.##'; hc.alignment = { horizontal: 'right' }; border(hc);
    moneyCell(ws, rr, 11, rate); moneyCell(ws, rr, 12, amount);
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
  return { name: 'Salaries Cost', sums, count: staff.length, mechanic_total: mTot.amount, refs: { total: `'Salaries Cost'!G${lGr}` } };
}

// ---------------------------------------------------------------------------
// Other cost (overhead — from monthly_report_inputs)
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
  return { name: 'Other Cost', sums: { total: sum }, count: rows.length, refs: { total: `'Other Cost'!D${gr}` } };
}

// ---------------------------------------------------------------------------
// Oils & Lubrication — DIRECT oil/lubricant issues (from stock_ledger) that aren't billed
// to a repair job or a service, so they're counted nowhere else in the report. Oil issued to
// a job is in the Repair sheet's Lubricant column; oil for a service is in the Service sheet —
// both are excluded here to avoid double-counting (see [[service-cost-reconciliation]]).
// ---------------------------------------------------------------------------
const OILVAL = 'ABS(sl.qty) * COALESCE(sl.unit_price, pr.unit_price, 0)';
const LUBE = "pr.category <> 'fuel'"; // engine/gear/hydraulic/grease/other — fuel is its own sheet
function buildOils(wb, ym, period, repairOil, serviceOil, repairJobIds) {
  const ws = wb.addWorksheet('Oils & Lubrication');
  [6, 14, 26, 22, 18, 10, 13, 14, 16].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  titleBand(ws, 9, 'Oils & Lubrication cost — issues not billed to this report’s Repair jobs or a service', period);
  ['Se: no', 'Date', 'Product', 'Vehicle / Consumer', 'Project / Plant', 'Qty', 'Unit Price (Rs)', 'Total Cost (Rs)', 'Remarks']
    .forEach((t, i) => { ws.mergeCells(4, i + 1, 5, i + 1); const c = ws.getCell(4, i + 1); c.value = t; headerCell(c); });

  // Every non-service, non-voided lubricant issue in the month EXCEPT oil on jobs actually shown on
  // this month's Repair sheet (whose oil is already in its Lubricant column). This catches direct
  // issues (job_id NULL) AND oil on jobs Repair never renders (REQUESTED/no-labour, rejected,
  // closed in another month) — which were previously dropped from every sheet.
  const rendered = new Set(repairJobIds || []);
  const rawRows = all(
    `SELECT sl.job_id, sl.txn_date, pr.name product, pr.unit, ABS(sl.qty) qty,
            COALESCE(sl.unit_price, pr.unit_price, 0) unit_price, ${OILVAL} cost,
            sl.consumer, sl.consumer_type, a.registration reg, a.code code, prj.name project, jc.job_no job_no
       FROM stock_ledger sl JOIN products pr ON pr.id = sl.product_id
       LEFT JOIN assets a ON a.id = sl.asset_id LEFT JOIN projects prj ON prj.id = sl.project_id
       LEFT JOIN job_cards jc ON jc.id = sl.job_id
      WHERE sl.kind = 'issue' AND ${LUBE} AND COALESCE(sl.voided,0) = 0
        AND COALESCE(sl.consumer_type,'') <> 'service' AND substr(sl.txn_date,1,7) = ?
      ORDER BY sl.txn_date, sl.id`, ym);
  const rows = rawRows.filter((x) => x.job_id == null || !rendered.has(x.job_id));

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

  // Reconciliation note — oil already counted elsewhere (the actual Repair & Service sheet lubricant
  // totals), so the reader can see the full oil picture without any of it being re-added here.
  const jobOil = r2(repairOil), svcOil = r2(serviceOil);
  const noteRow = gr + 2;
  ws.mergeCells(noteRow, 1, noteRow, 9);
  const nc = ws.getCell(noteRow, 1);
  nc.value = `Note: this sheet counts oil/lubricant issued directly (no job) plus oil on jobs NOT shown on this month’s Repair sheet. Oil on the Repair sheet’s own jobs (Rs ${fmtMoney(jobOil)}, its Lubricant column) and oil for services (Rs ${fmtMoney(svcOil)}, in the Service sheet) are counted there — not re-counted here. Total oil & lubricant in this report: Rs ${fmtMoney(total + jobOil + svcOil)}.`;
  nc.font = { italic: true, size: 9 }; nc.alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(noteRow).height = 42;
  signatures(ws, noteRow + 3, 9);
  return { name: 'Oils & Lubrication', sums: { total }, count: rows.length, job_oil: jobOil, service_oil: svcOil, refs: { total: `'Oils & Lubrication'!H${gr}` } };
}

// ---------------------------------------------------------------------------
// Total cost — summary. 10% Sundry applied to Repair/Service/Tyre/Battery/Oils only.
// Columns: C Labour, D Spare parts, E Lubricant, F Other material, G Outside,
//          H Overhead, I Sundry, J Cost w/o Overhead, K Total.
// ---------------------------------------------------------------------------
function buildTotal(wb, parts, period) {
  const ws = wb.addWorksheet('Total cost');
  [4, 18, 15, 15, 14, 15, 15, 15, 14, 18, 16].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.mergeCells(1, 2, 1, 11); const a = ws.getCell(1, 2); a.value = COMPANY; a.font = { bold: true, size: 13 }; a.alignment = { horizontal: 'center' };
  ws.mergeCells(2, 2, 2, 11); const b = ws.getCell(2, 2); b.value = 'Workshop repairing and servicing cost calculation'; b.font = { bold: true, size: 11 }; b.alignment = { horizontal: 'center' };
  ws.mergeCells(3, 2, 3, 11); const cc = ws.getCell(3, 2); cc.value = 'Summary for the month of ' + period; cc.font = { bold: true, size: 11 }; cc.alignment = { horizontal: 'center' };

  const hdr = ['', '', 'Labor cost', 'Spare parts cost', 'Lubricant cost', 'Other material cost', 'Out side work cost', 'Overhead cost', 'Sundry', 'Cost Without Overhead', 'Total Cost'];
  hdr.forEach((t, i) => { if (t) { const c = ws.getCell(7, i + 1); c.value = t; headerCell(c); } });

  const SUNDRY = 0.10;
  // each entry: label, and a map of column→{formula,result}. Repair-type rows get sundry.
  const R = parts.repair.refs, RS = parts.repair.sums;
  const SV = parts.service.refs, SS = parts.service.sums;
  const TY = parts.tyre.refs, TS = parts.tyre.sums;
  const BT = parts.battery.refs, BS = parts.battery.sums;

  // rows: [rowIdx, label, cells{col:{f,v}}, isRepairType]
  const rowDefs = [
    { row: 8, label: 'Repair', cells: { 3: [R.labour, RS.labour], 4: [R.material, RS.material], 5: [R.oil, RS.oil], 6: [R.other, RS.other], 7: [R.external, RS.external] }, sundry: true },
    { row: 9, label: 'Service', cells: { 3: [SV.labour, SS.labour], 4: [SV.filter, SS.filter], 5: [SV.oil, SS.oil], 6: [SV.other, SS.other], 7: [SV.external, SS.external] }, sundry: true },
    { row: 10, label: 'Tyre work cost', cells: { 4: [TY.tyre, TS.tyre], 6: [TY.tube, TS.tube], 7: [TY.outside, TS.outside] }, sundry: true },
    { row: 11, label: 'Battery cost', cells: { 4: [BT.battery, BS.battery], 6: [BT.other, BS.other] }, sundry: true },
    // Direct oil goes in the Lubricant column (E) and, like lubricant in Repair/Service, gets the 10% Sundry.
    { row: 12, label: 'Oils & Lubrication', cells: { 5: [parts.oils.refs.total, parts.oils.sums.total] }, sundry: true },
    { row: 13, label: 'Fuel Cost', cells: { 8: [parts.fuel.refs.cost, parts.fuel.sums.cost] }, sundry: false },
    { row: 14, label: 'Salaries Cost', cells: { 8: [parts.salaries.refs.total, parts.salaries.sums.total] }, sundry: false },
    { row: 15, label: 'Other Cost', cells: { 8: [parts.other.refs.total, parts.other.sums.total] }, sundry: false },
  ];

  for (const d of rowDefs) {
    const lc = ws.getCell(d.row, 2); lc.value = d.label; lc.font = { bold: true }; border(lc);
    let direct = 0;
    for (let col = 3; col <= 8; col++) {
      if (d.cells[col]) { const [f, v] = d.cells[col]; formulaMoney(ws, d.row, col, f, v); direct += r2(v); }
      else border(ws.getCell(d.row, col));
    }
    const sundry = d.sundry ? r2(direct * SUNDRY) : 0;
    if (d.sundry) formulaMoney(ws, d.row, 9, `SUM(C${d.row}:H${d.row})*10%`, sundry);
    else border(ws.getCell(d.row, 9));
    const total = r2(direct + sundry);
    // "Cost Without Overhead" (J): only the repair-type rows carry it — the overhead-only rows
    // (Fuel/Salaries/Other) leave J blank so J15 excludes overhead (K15 still includes it).
    if (d.sundry) formulaMoney(ws, d.row, 10, `SUM(C${d.row}:I${d.row})`, total);
    else border(ws.getCell(d.row, 10));
    formulaMoney(ws, d.row, 11, `SUM(C${d.row}:I${d.row})`, total, true);
  }

  // Grand total row 16 (rows 8..15 are the category rows)
  const gRow = 16;
  const gl = ws.getCell(gRow, 2); gl.value = 'Grand total cost'; gl.font = { bold: true }; gl.alignment = { horizontal: 'right' }; border(gl);
  const colTotals = {};
  for (let col = 3; col <= 11; col++) {
    let s = 0;
    for (const d of rowDefs) {
      const c = ws.getCell(d.row, col).value;
      if (c && typeof c === 'object' && 'result' in c) s += num(c.result);
    }
    colTotals[col] = s;
    formulaMoney(ws, gRow, col, `SUM(${colL(col)}8:${colL(col)}15)`, s, true);
  }
  signatures(ws, gRow + 3, 11);
  return { grand_total: colTotals[11] || 0, columns: colTotals };
}

async function buildWorkbook(year, month) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WorkshopOne';
  wb.created = new Date(Date.UTC(year, month - 1, 1));
  // Force Excel/LibreOffice to recompute all formulas on open, so cross-sheet totals and the
  // 10% Sundry are always current even after a viewer that doesn't cache zero results.
  wb.calcProperties = Object.assign({}, wb.calcProperties, { fullCalcOnLoad: true });
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const period = `${MONTHS[month]} ${year}`;
  const parts = {};
  parts.repair = buildRepair(wb, ym, period);
  parts.service = buildService(wb, ym, period);
  parts.tyre = buildTyre(wb, ym, period);
  parts.battery = buildBattery(wb, ym, period);
  parts.oils = buildOils(wb, ym, period, parts.repair.sums.oil, parts.service.sums.oil, parts.repair.repair_job_ids);
  parts.fuel = buildFuel(wb, year, month, period);
  parts.salaries = buildSalaries(wb, year, month, ym, period);
  parts.other = buildOther(wb, year, month, period);
  const total = buildTotal(wb, parts, period);
  return { wb, parts, total };
}

module.exports = { buildWorkbook, MONTHS };
