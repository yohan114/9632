'use strict';

// Import the workshop's "TYRE BATTERY ISSUE DETAILS" workbook into tyre_battery_issues.
// Idempotent: re-running upserts by row_hash (same file → no duplicates).
//
//   node src/import/tyre_battery.js "C:/path/to/TYRE BATTERY ISSUE DETAILS (25).xlsx"
//
// Sheet layouts (data starts row 5):
//   TYRE    — C=date  D=vehicle E=site F=qty G=category H=min I=km
//   BATTERY — B=date  C=vehicle D=site E=qty F=category G=min H=km

const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { db, migrate, run, get } = require('../db');

const DEFAULT_FILE = 'C:/Users/HP/Downloads/TYRE BATTERY ISSUE DETAILS (25).xlsx';

const cellText = (c) => {
  let v = c && c.value;
  if (v && typeof v === 'object') {
    if (v.formula) v = v.result;
    else if (v.richText) v = v.richText.map((t) => t.text).join('');
    else if (v.text) v = v.text;
    else v = '';
  }
  return v == null ? '' : String(v).trim();
};

function parseDate(s) {
  const m = String(s).match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
// Only attribute a plausible date to a month; a typo like 5015-11-04 is stored with a null date.
const plausible = (ymd) => ymd && +ymd.slice(0, 4) >= 2005 && +ymd.slice(0, 4) <= 2030;

function parseQty(raw) {
  const m = String(raw).match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 1; // an issue implies ≥1 if a count wasn't written
}
const normCat = (s) => String(s || '').toUpperCase().replace(/\s+/g, '').replace(/\.+$/, '').trim();

// Best-effort vehicle → asset link: exact match on normalised code or registration.
function buildAssetMap() {
  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const map = new Map();
  for (const a of db.prepare('SELECT id, code, registration, ec_code FROM assets').all()) {
    for (const key of [a.code, a.registration, a.ec_code]) {
      const n = norm(key);
      if (n && !map.has(n)) map.set(n, a.id);
    }
  }
  return { map, norm };
}

const SHEETS = [
  { kind: 'tyre', name: 'TYRE ISSUE DETAILS', cols: { date: 3, vehicle: 4, site: 5, qty: 6, category: 7, min: 8, km: 9 } },
  { kind: 'battery', name: 'BATTERY ISSUE DETAILS', cols: { date: 2, vehicle: 3, site: 4, qty: 5, category: 6, min: 7, km: 8 } },
];

async function importFile(file) {
  migrate();
  const { map: assetMap, norm: assetNorm } = buildAssetMap();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const summary = {};

  const upsert = db.transaction((rows) => {
    let inserted = 0, updated = 0;
    for (const r of rows) {
      const existing = get('SELECT id FROM tyre_battery_issues WHERE row_hash = ?', r.row_hash);
      if (existing) {
        run(`UPDATE tyre_battery_issues SET issue_date=?, vehicle=?, asset_id=?, site=?, qty=?, qty_raw=?,
               category=?, category_norm=?, min_number=?, km=? WHERE id=?`,
          r.issue_date, r.vehicle, r.asset_id, r.site, r.qty, r.qty_raw, r.category, r.category_norm, r.min_number, r.km, existing.id);
        updated++;
      } else {
        run(`INSERT INTO tyre_battery_issues (kind, issue_date, vehicle, asset_id, site, qty, qty_raw, category, category_norm, min_number, km, source, row_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          r.kind, r.issue_date, r.vehicle, r.asset_id, r.site, r.qty, r.qty_raw, r.category, r.category_norm, r.min_number, r.km, 'import', r.row_hash);
        inserted++;
      }
    }
    return { inserted, updated };
  });

  for (const sh of SHEETS) {
    const ws = wb.getWorksheet(sh.name);
    if (!ws) { summary[sh.kind] = { error: 'sheet not found' }; continue; }
    const rows = [];
    let cur = null, nullDate = 0;
    const months = new Set();
    for (let rn = 5; rn <= ws.rowCount; rn++) {
      const row = ws.getRow(rn);
      const dateRaw = cellText(row.getCell(sh.cols.date));
      const vehicle = cellText(row.getCell(sh.cols.vehicle));
      const category = cellText(row.getCell(sh.cols.category));
      const d = parseDate(dateRaw);
      if (d) cur = d; // a real date updates the running date; integers/blanks carry it forward
      if (!vehicle && !category) continue; // skip fully empty / heading rows
      const issueDate = plausible(cur) ? cur : null;
      if (!issueDate) nullDate++; else months.add(issueDate.slice(0, 7));
      const qtyRaw = cellText(row.getCell(sh.cols.qty));
      const row_hash = crypto.createHash('md5')
        .update([sh.kind, sh.name, rn, dateRaw, vehicle, category, qtyRaw].join('')).digest('hex');
      rows.push({
        kind: sh.kind, issue_date: issueDate, vehicle,
        asset_id: assetMap.get(assetNorm(vehicle)) || null,
        site: cellText(row.getCell(sh.cols.site)),
        qty: parseQty(qtyRaw), qty_raw: qtyRaw,
        category, category_norm: normCat(category),
        min_number: cellText(row.getCell(sh.cols.min)), km: cellText(row.getCell(sh.cols.km)),
        row_hash,
      });
    }
    const res = upsert(rows);
    const linked = rows.filter((r) => r.asset_id).length;
    summary[sh.kind] = {
      parsed: rows.length, inserted: res.inserted, updated: res.updated,
      null_date: nullDate, months: months.size, asset_linked: linked,
      categories: new Set(rows.map((r) => r.category_norm).filter(Boolean)).size,
    };
  }
  return summary;
}

if (require.main === module) {
  const file = process.argv[2] || DEFAULT_FILE;
  console.log('Importing', file);
  importFile(file).then((s) => { console.log(JSON.stringify(s, null, 2)); process.exit(0); })
    .catch((e) => { console.error('IMPORT FAILED:', e.stack); process.exit(1); });
}

module.exports = { importFile };
