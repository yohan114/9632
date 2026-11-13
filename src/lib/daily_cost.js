'use strict';

/**
 * Daily Cost Report Engine & Monthly Overheads Management
 *
 * Computes the daily operating cost of the workshop:
 * 1. Our Labour actual work value (hours × hourly rate from labour_rates)
 * 2. Outside value (outside_labour from daily work + external job parts)
 * 3. Spares cost in same day (Local Purchase, Head Office, and General Consumables)
 * 4. Allocated Monthly Overheads (prorated per day based on days in month:
 *    electricity, internet, telephone allowance, travelling allowance, other expenses)
 * 5. Deferred modules placeholders (Fuel Cost & Vehicle Rental)
 * 6. Grand total daily cost
 */

const { get, all, run, tx } = require('../db');
const mechanics = require('./mechanics');
const costing = require('./costing');
const ExcelJS = require('exceljs');

const DEFAULT_OVERHEADS = {
  electricity_cost: 60000.0,
  internet_bill: 5000.0,
  telephone_allowance: 13250.0,
  travelling_allowance: 0.0,
  other_expenses: 5000.0,
  notes: 'Standard baseline overheads'
};

const CREATE_OVERHEADS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS workshop_monthly_overheads (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    workshop_id         INTEGER NOT NULL DEFAULT 1,
    year_month          TEXT NOT NULL,
    electricity_cost    REAL NOT NULL DEFAULT 60000.0,
    internet_bill       REAL NOT NULL DEFAULT 5000.0,
    telephone_allowance REAL NOT NULL DEFAULT 13250.0,
    travelling_allowance REAL NOT NULL DEFAULT 0.0,
    other_expenses      REAL NOT NULL DEFAULT 5000.0,
    notes               TEXT,
    updated_by          INTEGER,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(workshop_id, year_month)
  );
  CREATE INDEX IF NOT EXISTS idx_workshop_overheads_ym ON workshop_monthly_overheads(year_month);
`;

function ensureOverheadsTable() {
  try {
    const { db } = require('../db');
    db.exec(CREATE_OVERHEADS_TABLE_SQL);
  } catch (e) {
    // ignore
  }
}

function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * Retrieve monthly overhead configuration for a workshop and month (YYYY-MM).
 * Returns saved row or default configuration.
 */
function getOverheads(workshopId = 1, yearMonth) {
  const ws = Number(workshopId) || 1;
  const ym = String(yearMonth || '').slice(0, 7) || new Date().toISOString().slice(0, 7);

  ensureOverheadsTable();

  let row = null;
  try {
    row = get(
      `SELECT * FROM workshop_monthly_overheads WHERE workshop_id = ? AND year_month = ?`,
      ws, ym
    );
  } catch (err) {
    console.warn(`getOverheads failed for ws ${ws}, ym ${ym}:`, err.message);
  }

  const [y, m] = ym.split('-').map(Number);
  const daysInMonth = (y && m) ? getDaysInMonth(y, m) : 30;

  const data = row ? {
    id: row.id,
    workshop_id: row.workshop_id,
    year_month: row.year_month,
    electricity_cost: Number(row.electricity_cost) || 0,
    internet_bill: Number(row.internet_bill) || 0,
    telephone_allowance: Number(row.telephone_allowance) || 0,
    travelling_allowance: Number(row.travelling_allowance) || 0,
    other_expenses: Number(row.other_expenses) || 0,
    notes: row.notes || '',
    updated_by: row.updated_by,
    updated_at: row.updated_at,
    is_default: false
  } : {
    id: null,
    workshop_id: ws,
    year_month: ym,
    ...DEFAULT_OVERHEADS,
    updated_by: null,
    updated_at: null,
    is_default: true
  };

  const daily = {
    electricity: round2(data.electricity_cost / daysInMonth),
    internet: round2(data.internet_bill / daysInMonth),
    telephone: round2(data.telephone_allowance / daysInMonth),
    travelling: round2(data.travelling_allowance / daysInMonth),
    other: round2(data.other_expenses / daysInMonth),
  };
  daily.total = round2(daily.electricity + daily.internet + daily.telephone + daily.travelling + daily.other);

  return { monthly: data, daily, days_in_month: daysInMonth };
}

/**
 * Save / Update monthly overhead configuration for a workshop and month.
 */
function saveOverheads(workshopId = 1, yearMonth, payload = {}, userId = null) {
  const ws = Number(workshopId) || 1;
  const ym = String(yearMonth || '').slice(0, 7);
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) {
    const err = new Error('Invalid year_month (format YYYY-MM required)');
    err.status = 400;
    throw err;
  }

  ensureOverheadsTable();

  const electricity = payload.electricity_cost !== undefined ? Math.max(0, Number(payload.electricity_cost) || 0) : DEFAULT_OVERHEADS.electricity_cost;
  const internet = payload.internet_bill !== undefined ? Math.max(0, Number(payload.internet_bill) || 0) : DEFAULT_OVERHEADS.internet_bill;
  const telephone = payload.telephone_allowance !== undefined ? Math.max(0, Number(payload.telephone_allowance) || 0) : DEFAULT_OVERHEADS.telephone_allowance;
  const travelling = payload.travelling_allowance !== undefined ? Math.max(0, Number(payload.travelling_allowance) || 0) : DEFAULT_OVERHEADS.travelling_allowance;
  const other = payload.other_expenses !== undefined ? Math.max(0, Number(payload.other_expenses) || 0) : DEFAULT_OVERHEADS.other_expenses;
  const notes = payload.notes !== undefined ? String(payload.notes || '').trim() : '';

  run(
    `INSERT INTO workshop_monthly_overheads
       (workshop_id, year_month, electricity_cost, internet_bill, telephone_allowance, travelling_allowance, other_expenses, notes, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(workshop_id, year_month) DO UPDATE SET
       electricity_cost = excluded.electricity_cost,
       internet_bill = excluded.internet_bill,
       telephone_allowance = excluded.telephone_allowance,
       travelling_allowance = excluded.travelling_allowance,
       other_expenses = excluded.other_expenses,
       notes = excluded.notes,
       updated_by = excluded.updated_by,
       updated_at = datetime('now')`,
    ws, ym, electricity, internet, telephone, travelling, other, notes, userId || null
  );

  return getOverheads(ws, ym);
}

/**
 * Compute the complete Daily Cost report for a given date and workshop.
 */
function computeDailyCost({ asOf, ws = null } = {}) {
  const todayISO = new Date().toISOString().slice(0, 10);
  const date = String(asOf || todayISO).slice(0, 10);
  const wsId = ws ? Number(ws) : 1;
  const ym = date.slice(0, 7);

  let workshopName = 'Central Workshop';
  try {
    const wsRow = get('SELECT id, name, code FROM workshops WHERE id = ?', wsId);
    if (wsRow && wsRow.name) workshopName = wsRow.name;
  } catch (_) {
    try {
      const wsRow = get('SELECT id, name, code FROM core.workshops WHERE id = ?', wsId);
      if (wsRow && wsRow.name) workshopName = wsRow.name;
    } catch (_) {}
  }

  // 1. Labour & Outside value from job_daily_work
  const dwSql = `
    SELECT w.id, w.job_id, w.work_date, w.mechanic, w.description, w.hours,
           w.is_external, w.external_value, w.outside_labour, w.travel,
           j.job_no, j.type AS job_type, j.workshop_id,
           a.code AS asset_code, a.registration AS asset_reg
      FROM job_daily_work w
      LEFT JOIN job_cards j ON j.id = w.job_id
      LEFT JOIN assets a ON a.id = COALESCE(w.asset_id, j.asset_id)
     WHERE date(w.work_date) = date(?)
       ${ws ? 'AND (j.workshop_id = ? OR j.workshop_id IS NULL)' : ''}
     ORDER BY w.id ASC
  `;
  const dwParams = ws ? [date, wsId] : [date];
  let dwRows = [];
  try { dwRows = all(dwSql, ...dwParams); } catch (e) { console.warn('daily_cost dwRows error:', e.message); }

  const labourLines = [];
  const outsideLines = [];
  let internalLabourTotal = 0;
  let internalHoursTotal = 0;
  let outsideLabourTotal = 0;

  for (const w of dwRows) {
    const veh = (w.asset_reg || w.asset_code || '—');
    const hrs = Number(w.hours) || 0;

    // A. Internal Labour (hours × rate)
    if (!w.is_external && hrs > 0) {
      const names = mechanics.splitMechanics(w.mechanic);
      if (!names.length) {
        labourLines.push({
          id: w.id,
          job_id: w.job_id,
          job_no: w.job_no || '—',
          vehicle: veh,
          mechanic: w.mechanic || '(unassigned)',
          hours: hrs,
          rate: 0,
          amount: 0,
          description: w.description || '',
          travel: !!w.travel
        });
        internalHoursTotal += hrs;
      } else {
        for (const nm of names) {
          const rate = costing.labourRateFor(nm, date) || 0;
          const amt = round2(hrs * rate);
          internalLabourTotal += amt;
          internalHoursTotal += hrs;
          labourLines.push({
            id: w.id,
            job_id: w.job_id,
            job_no: w.job_no || '—',
            vehicle: veh,
            mechanic: nm,
            hours: hrs,
            rate,
            amount: amt,
            description: w.description || '',
            travel: !!w.travel
          });
        }
      }
    }

    // B. Outside Labour value
    const outVal = Number(w.outside_labour) > 0
      ? Number(w.outside_labour)
      : (w.is_external && Number(w.external_value) > 0 ? Number(w.external_value) : 0);

    if (outVal > 0) {
      outsideLabourTotal += outVal;
      outsideLines.push({
        id: w.id,
        source: 'daily_work',
        job_id: w.job_id,
        job_no: w.job_no || '—',
        vehicle: veh,
        mechanic: w.mechanic || '(outside contractor)',
        description: w.description || 'Outside repair / labour',
        amount: round2(outVal)
      });
    }
  }

  // C. Outside / External Repairs from job_parts
  const extPartsSql = `
    SELECT jp.id, jp.job_id, jp.description, jp.qty, jp.unit_price, jp.created_at,
           j.job_no, j.workshop_id, a.code AS asset_code, a.registration AS asset_reg
      FROM job_parts jp
      LEFT JOIN job_cards j ON j.id = jp.job_id
      LEFT JOIN assets a ON a.id = j.asset_id
     WHERE (jp.source_type = 'external' OR jp.is_external_repair = 1)
       AND date(jp.created_at) = date(?)
       ${ws ? 'AND (j.workshop_id = ? OR j.workshop_id IS NULL)' : ''}
     ORDER BY jp.id ASC
  `;
  const extPartsParams = ws ? [date, wsId] : [date];
  let extPartsRows = [];
  try { extPartsRows = all(extPartsSql, ...extPartsParams); } catch (e) { console.warn('extPartsRows error:', e.message); }

  let extRepairsTotal = 0;
  for (const ep of extPartsRows) {
    const veh = (ep.asset_reg || ep.asset_code || '—');
    const amt = round2((Number(ep.qty) || 1) * (Number(ep.unit_price) || 0));
    extRepairsTotal += amt;
    outsideLines.push({
      id: ep.id,
      source: 'external_repair',
      job_id: ep.job_id,
      job_no: ep.job_no || '—',
      vehicle: veh,
      mechanic: 'External Provider',
      description: ep.description || 'External Repair Charge',
      qty: ep.qty,
      unit_price: ep.unit_price,
      amount: amt
    });
  }

  const totalOutsideValue = round2(outsideLabourTotal + extRepairsTotal);
  internalLabourTotal = round2(internalLabourTotal);
  internalHoursTotal = round2(internalHoursTotal);

  // 2. Spares cost in same day (Local Purchase, Head Office, General items)
  // A. Issues to assets / jobs
  const issuesSql = `
    SELECT i.id, i.issue_date, i.description, i.qty, i.unit, i.unit_price,
           i.min_no, i.chain_no, i.purpose,
           COALESCE(g.purchase_source_norm, g.purchase_source, ml.purchase_source, m.purchase_source, 'local_purchase') AS purchase_source,
           si.item_no, si.part_number,
           j.job_no, j.workshop_id,
           a.code AS asset_code, a.registration AS asset_reg
      FROM issues i
      LEFT JOIN mrn_lines ml ON ml.id = i.mrn_line_id
      LEFT JOIN mrn m ON m.id = ml.mrn_id
      LEFT JOIN grn g ON g.mrn_line_id = ml.id
      LEFT JOIN store_items si ON si.id = i.store_item_id
      LEFT JOIN job_cards j ON j.id = i.job_id
      LEFT JOIN assets a ON a.id = i.asset_id
     WHERE date(i.issue_date) = date(?)
       ${ws ? 'AND (j.workshop_id = ? OR j.workshop_id IS NULL)' : ''}
     ORDER BY i.id ASC
  `;
  const issuesParams = ws ? [date, wsId] : [date];
  let issueRows = [];
  try { issueRows = all(issuesSql, ...issuesParams); } catch (e) { console.warn('issuesRows error:', e.message); }

  const localSparesLines = [];
  const hoSparesLines = [];
  let localSparesTotal = 0;
  let hoSparesTotal = 0;

  for (const iss of issueRows) {
    const qty = Number(iss.qty) || 0;
    const unitPrice = iss.unit_price != null ? Number(iss.unit_price) : null;
    const isUnpriced = unitPrice == null;
    const amt = isUnpriced ? 0 : round2(qty * unitPrice);

    const src = String(iss.purchase_source || '').toLowerCase();
    const isHO = src.includes('head') || src.includes('direct') || src === 'head_office';

    const item = {
      id: iss.id,
      description: iss.description,
      part_no: iss.part_number || iss.item_no || '—',
      qty,
      unit: iss.unit || 'nos',
      unit_price: unitPrice,
      amount: amt,
      is_unpriced: isUnpriced,
      job_no: iss.job_no || '—',
      vehicle: iss.asset_reg || iss.asset_code || '—',
      min_no: iss.min_no || iss.chain_no || '—'
    };

    if (isHO) {
      hoSparesTotal += amt;
      hoSparesLines.push(item);
    } else {
      localSparesTotal += amt;
      localSparesLines.push(item);
    }
  }

  // B. General Consumable Items (general_item_txns)
  const genSql = `
    SELECT git.id, git.txn_date, git.qty, git.unit_price, git.ref,
           si.name AS item_name, si.item_no, si.part_number, si.unit,
           j.job_no, j.workshop_id,
           a.code AS asset_code, a.registration AS asset_reg
      FROM general_item_txns git
      LEFT JOIN store_items si ON si.id = git.store_item_id
      LEFT JOIN job_cards j ON j.id = git.job_id
      LEFT JOIN assets a ON a.id = git.asset_id
     WHERE git.txn_type = 'issue'
       AND date(git.txn_date) = date(?)
       ${ws ? 'AND (j.workshop_id = ? OR j.workshop_id IS NULL)' : ''}
     ORDER BY git.id ASC
  `;
  const genParams = ws ? [date, wsId] : [date];
  let genRows = [];
  try { genRows = all(genSql, ...genParams); } catch (e) { console.warn('genRows error:', e.message); }

  const genSparesLines = [];
  let genSparesTotal = 0;

  for (const git of genRows) {
    const qty = Math.abs(Number(git.qty) || 0);
    const unitPrice = git.unit_price != null ? Number(git.unit_price) : null;
    const isUnpriced = unitPrice == null;
    const amt = isUnpriced ? 0 : round2(qty * unitPrice);

    genSparesTotal += amt;
    genSparesLines.push({
      id: git.id,
      description: git.item_name || 'General Consumable',
      part_no: git.part_number || git.item_no || '—',
      qty,
      unit: git.unit || 'nos',
      unit_price: unitPrice,
      amount: amt,
      is_unpriced: isUnpriced,
      job_no: git.job_no || '—',
      vehicle: git.asset_reg || git.asset_code || '—',
      ref: git.ref || '—'
    });
  }

  localSparesTotal = round2(localSparesTotal);
  hoSparesTotal = round2(hoSparesTotal);
  genSparesTotal = round2(genSparesTotal);
  const totalSparesCost = round2(localSparesTotal + hoSparesTotal + genSparesTotal);

  // 3. Allocated Monthly Overheads
  const overheadsData = getOverheads(wsId, ym);
  const dailyOverheadTotal = overheadsData.daily.total;

  // 4. Deferred module placeholders (Fuel & Vehicle rental)
  const deferred = [
    { key: 'fuel_cost', label: 'Fuel Cost', active: false, amount: 0.0, note: 'Deferred - complex module to be built in future' },
    { key: 'vehicle_rental_cost', label: 'Vehicle Rental Cost', active: false, amount: 0.0, note: 'Deferred - complex module to be built in future' }
  ];

  // 5. Grand Total
  const grandTotal = round2(internalLabourTotal + totalOutsideValue + totalSparesCost + dailyOverheadTotal);

  return {
    kind: 'daily_cost',
    as_of: date,
    workshop_id: wsId,
    workshop_name: workshopName,
    year_month: ym,
    days_in_month: overheadsData.days_in_month,
    summary: {
      internal_labour_value: internalLabourTotal,
      internal_labour_hours: internalHoursTotal,
      outside_value: totalOutsideValue,
      spares_local_value: localSparesTotal,
      spares_head_office_value: hoSparesTotal,
      spares_general_value: genSparesTotal,
      spares_total_value: totalSparesCost,
      daily_overheads_value: dailyOverheadTotal,
      fuel_cost: 0.0,
      vehicle_rental_cost: 0.0,
      grand_total: grandTotal
    },
    labour: {
      total_hours: internalHoursTotal,
      total_value: internalLabourTotal,
      lines: labourLines
    },
    outside: {
      total_value: totalOutsideValue,
      lines: outsideLines
    },
    spares: {
      local_purchase: { total: localSparesTotal, lines: localSparesLines },
      head_office: { total: hoSparesTotal, lines: hoSparesLines },
      general_items: { total: genSparesTotal, lines: genSparesLines },
      total: totalSparesCost
    },
    overheads: overheadsData,
    deferred
  };
}

/**
 * Excel export for Daily Cost report.
 */
function dailyCostWorkbook(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WorkshopOne';
  const ws = wb.addWorksheet(`Daily Cost ${data.as_of}`);

  const head = (c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  };

  const subhead = (c) => {
    c.font = { bold: true, color: { argb: 'FF1F2937' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
  };

  const currency = (c) => {
    c.numFmt = '#,##0.00';
    c.alignment = { horizontal: 'right' };
  };

  // Columns: A-F
  ws.columns = [
    { key: 'col1', width: 6 },
    { key: 'col2', width: 28 },
    { key: 'col3', width: 35 },
    { key: 'col4', width: 14 },
    { key: 'col5', width: 16 },
    { key: 'col6', width: 18 }
  ];

  // Title
  ws.mergeCells('A1:F1');
  const t = ws.getCell('A1');
  t.value = `DAILY OPERATING COST REPORT — ${data.workshop_name.toUpperCase()}`;
  t.font = { bold: true, size: 14, color: { argb: 'FF1E3A8A' } };
  t.alignment = { horizontal: 'center' };

  ws.mergeCells('A2:F2');
  const st = ws.getCell('A2');
  st.value = `Date: ${data.as_of}  |  Month: ${data.year_month} (${data.days_in_month} days)  |  Grand Total: Rs. ${data.summary.grand_total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  st.font = { italic: true, size: 11, color: { argb: 'FF4B5563' } };
  st.alignment = { horizontal: 'center' };

  let r = 4;

  // --- SECTION: KPI SUMMARY ---
  ws.mergeCells(`A${r}:F${r}`);
  ws.getCell(`A${r}`).value = '1. COST SUMMARY BREAKDOWN';
  head(ws.getCell(`A${r}`));
  r++;

  const summaryRows = [
    ['Our Labour Work Value', `${data.summary.internal_labour_hours} hours`, data.summary.internal_labour_value],
    ['Outside Labour & Repairs', `${data.outside.lines.length} charges`, data.summary.outside_value],
    ['Spares - Local Purchase', `${data.spares.local_purchase.lines.length} items`, data.summary.spares_local_value],
    ['Spares - Head Office', `${data.spares.head_office.lines.length} items`, data.summary.spares_head_office_value],
    ['Spares - General Consumables', `${data.spares.general_items.lines.length} items`, data.summary.spares_general_value],
    ['Daily Allocated Overheads', `Prorated (1/${data.days_in_month})`, data.summary.daily_overheads_value],
    ['Fuel Cost', 'Deferred (future module)', data.summary.fuel_cost],
    ['Vehicle Rental Cost', 'Deferred (future module)', data.summary.vehicle_rental_cost],
  ];

  for (const [title, desc, val] of summaryRows) {
    ws.getCell(`B${r}`).value = title;
    ws.getCell(`B${r}`).font = { bold: true };
    ws.getCell(`C${r}`).value = desc;
    ws.getCell(`F${r}`).value = val;
    currency(ws.getCell(`F${r}`));
    r++;
  }

  // Grand Total line
  ws.getCell(`B${r}`).value = 'GRAND TOTAL DAILY COST';
  ws.getCell(`B${r}`).font = { bold: true, size: 12, color: { argb: 'FF1E3A8A' } };
  ws.getCell(`F${r}`).value = data.summary.grand_total;
  ws.getCell(`F${r}`).font = { bold: true, size: 12, color: { argb: 'FF1E3A8A' } };
  currency(ws.getCell(`F${r}`));
  r += 2;

  // --- SECTION: OUR LABOUR DETAIL ---
  ws.mergeCells(`A${r}:F${r}`);
  ws.getCell(`A${r}`).value = `2. OUR LABOUR ACTUAL WORK VALUE (Rs. ${data.summary.internal_labour_value.toLocaleString()})`;
  head(ws.getCell(`A${r}`));
  r++;

  ws.getCell(`A${r}`).value = '#';
  ws.getCell(`B${r}`).value = 'Mechanic';
  ws.getCell(`C${r}`).value = 'Vehicle / Job / Work Done';
  ws.getCell(`D${r}`).value = 'Hours';
  ws.getCell(`E${r}`).value = 'Rate (Rs)';
  ws.getCell(`F${r}`).value = 'Value (Rs)';
  ['A', 'B', 'C', 'D', 'E', 'F'].forEach(c => subhead(ws.getCell(`${c}${r}`)));
  r++;

  if (!data.labour.lines.length) {
    ws.getCell(`B${r}`).value = 'No internal labour logged on this date.';
    r++;
  } else {
    data.labour.lines.forEach((l, idx) => {
      ws.getCell(`A${r}`).value = idx + 1;
      ws.getCell(`B${r}`).value = l.mechanic;
      ws.getCell(`C${r}`).value = `${l.vehicle} [${l.job_no}] - ${l.description || ''}`;
      ws.getCell(`D${r}`).value = l.hours;
      ws.getCell(`E${r}`).value = l.rate;
      ws.getCell(`F${r}`).value = l.amount;
      currency(ws.getCell(`E${r}`));
      currency(ws.getCell(`F${r}`));
      r++;
    });
  }
  r++;

  // --- SECTION: OUTSIDE VALUE DETAIL ---
  ws.mergeCells(`A${r}:F${r}`);
  ws.getCell(`A${r}`).value = `3. OUTSIDE LABOUR & REPAIRS (Rs. ${data.summary.outside_value.toLocaleString()})`;
  head(ws.getCell(`A${r}`));
  r++;

  ws.getCell(`A${r}`).value = '#';
  ws.getCell(`B${r}`).value = 'Provider / Mechanic';
  ws.getCell(`C${r}`).value = 'Vehicle / Job / Work Description';
  ws.getCell(`D${r}`).value = 'Type';
  ws.getCell(`E${r}`).value = 'Source';
  ws.getCell(`F${r}`).value = 'Value (Rs)';
  ['A', 'B', 'C', 'D', 'E', 'F'].forEach(c => subhead(ws.getCell(`${c}${r}`)));
  r++;

  if (!data.outside.lines.length) {
    ws.getCell(`B${r}`).value = 'No outside labour or repair charges on this date.';
    r++;
  } else {
    data.outside.lines.forEach((l, idx) => {
      ws.getCell(`A${r}`).value = idx + 1;
      ws.getCell(`B${r}`).value = l.mechanic;
      ws.getCell(`C${r}`).value = `${l.vehicle} [${l.job_no}] - ${l.description || ''}`;
      ws.getCell(`D${r}`).value = l.source;
      ws.getCell(`E${r}`).value = l.source === 'external_repair' ? 'Job Part' : 'Daily Work';
      ws.getCell(`F${r}`).value = l.amount;
      currency(ws.getCell(`F${r}`));
      r++;
    });
  }
  r++;

  // --- SECTION: SPARES DETAIL ---
  ws.mergeCells(`A${r}:F${r}`);
  ws.getCell(`A${r}`).value = `4. SPARES ISSUED ON THIS DATE (Rs. ${data.summary.spares_total_value.toLocaleString()})`;
  head(ws.getCell(`A${r}`));
  r++;

  ws.getCell(`A${r}`).value = '#';
  ws.getCell(`B${r}`).value = 'Source / Category';
  ws.getCell(`C${r}`).value = 'Description & Part No';
  ws.getCell(`D${r}`).value = 'Qty';
  ws.getCell(`E${r}`).value = 'Unit Price (Rs)';
  ws.getCell(`F${r}`).value = 'Amount (Rs)';
  ['A', 'B', 'C', 'D', 'E', 'F'].forEach(c => subhead(ws.getCell(`${c}${r}`)));
  r++;

  const allSpares = [
    ...data.spares.local_purchase.lines.map(x => ({ ...x, group: 'Local Purchase' })),
    ...data.spares.head_office.lines.map(x => ({ ...x, group: 'Head Office' })),
    ...data.spares.general_items.lines.map(x => ({ ...x, group: 'General Store' }))
  ];

  if (!allSpares.length) {
    ws.getCell(`B${r}`).value = 'No spares issued on this date.';
    r++;
  } else {
    allSpares.forEach((s, idx) => {
      ws.getCell(`A${r}`).value = idx + 1;
      ws.getCell(`B${r}`).value = s.group;
      ws.getCell(`C${r}`).value = `${s.description} (${s.part_no}) -> ${s.vehicle} [${s.job_no}]`;
      ws.getCell(`D${r}`).value = `${s.qty} ${s.unit || ''}`.trim();
      ws.getCell(`E${r}`).value = s.unit_price != null ? s.unit_price : '(awaiting price)';
      ws.getCell(`F${r}`).value = s.amount;
      if (s.unit_price != null) currency(ws.getCell(`E${r}`));
      currency(ws.getCell(`F${r}`));
      r++;
    });
  }
  r++;

  // --- SECTION: ALLOCATED OVERHEADS DETAIL ---
  ws.mergeCells(`A${r}:F${r}`);
  ws.getCell(`A${r}`).value = `5. ALLOCATED MONTHLY OVERHEADS (Daily Total: Rs. ${data.summary.daily_overheads_value.toLocaleString()})`;
  head(ws.getCell(`A${r}`));
  r++;

  ws.getCell(`B${r}`).value = 'Expense Category';
  ws.getCell(`C${r}`).value = 'Basis / Notes';
  ws.getCell(`E${r}`).value = 'Monthly (Rs)';
  ws.getCell(`F${r}`).value = 'Daily Prorated (Rs)';
  ['A', 'B', 'C', 'D', 'E', 'F'].forEach(c => subhead(ws.getCell(`${c}${r}`)));
  r++;

  const ovRows = [
    ['Electricity Cost', 'Approx. Rs 60,000 / month', data.overheads.monthly.electricity_cost, data.overheads.daily.electricity],
    ['Internet Bill', 'Standard bill Rs 5,000 / month', data.overheads.monthly.internet_bill, data.overheads.daily.internet],
    ['Telephone Allowance', 'Staff allowance Rs 13,250 / month', data.overheads.monthly.telephone_allowance, data.overheads.daily.telephone],
    ['Travelling Allowance', 'Outside repair service vehicle allowance', data.overheads.monthly.travelling_allowance, data.overheads.daily.travelling],
    ['Other General Overheads', 'Miscellaneous expenses', data.overheads.monthly.other_expenses, data.overheads.daily.other],
  ];

  for (const [cat, basis, mVal, dVal] of ovRows) {
    ws.getCell(`B${r}`).value = cat;
    ws.getCell(`C${r}`).value = basis;
    ws.getCell(`E${r}`).value = mVal;
    ws.getCell(`F${r}`).value = dVal;
    currency(ws.getCell(`E${r}`));
    currency(ws.getCell(`F${r}`));
    r++;
  }

  return wb;
}

module.exports = {
  computeDailyCost,
  getOverheads,
  saveOverheads,
  dailyCostWorkbook,
  DEFAULT_OVERHEADS
};
