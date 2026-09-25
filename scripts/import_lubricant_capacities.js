'use strict';

// Load the fleet lubricant capacities from Fleet_Oil_Lubricant_Capacities.xlsx.
//
//   node scripts/import_lubricant_capacities.js <file.xlsx>            show what would happen
//   node scripts/import_lubricant_capacities.js <file.xlsx> --apply    back up, then replace
//
// The server version of scripts/import_lubricant_capacities.py, which only runs on the office PC
// (its paths are written in, and it needs Python with openpyxl). This one uses the app's own
// database settings (.env DB_PATH) and exceljs, so it runs anywhere the app runs.
//
// It reads the sheet exactly as the Python script does — sheet "Vehicle Capacities", data from row
// 4, the same 23 columns, a vehicle matched by E&C code first and registration second — so the
// office PC and the server end up with the same rows.
//
// Two guards the Python script did not have:
//   - it replaces the table only with --apply, and takes a backup first;
//   - it will not overwrite capacities someone has changed on screen since the last import
//     (updated_by is not 'system_import'). Those edits would be lost silently. --replace-edited
//     overrides this once you have checked the list it prints.

const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const APPLY = args.includes('--apply');
const REPLACE_EDITED = args.includes('--replace-edited');
const SHEET = 'Vehicle Capacities';
const FIRST_ROW = 4;

const die = (msg) => { console.error(`\n  **  ${msg}\n`); process.exit(1); };

// exceljs hands back formulas, rich text, hyperlinks and dates as objects; openpyxl (data_only)
// hands back the value. Reduce to the value, so both scripts see the same thing.
function plain(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return plain(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return plain(v.text);
    if ('error' in v) return null;
  }
  return v;
}
function cleanVal(v) {
  v = plain(v);
  if (v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function cleanNum(v) {
  v = plain(v);
  if (v === null || v === '') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function cleanInt(v, dflt) {
  const n = cleanNum(v);
  return n === null ? dflt : Math.trunc(n);
}

async function main() {
  if (!file) die('Say which file: node scripts/import_lubricant_capacities.js <file.xlsx> [--apply]');
  if (!fs.existsSync(file)) die(`File not found: ${file}`);

  const config = require('../src/config');
  const { get, all, run, tx } = require('../src/db');
  console.log(`Database: ${config.dbPath}`);
  console.log(`File:     ${path.resolve(file)}`);

  if (!get("SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = 'vehicle_lubricant_capacities'")) {
    die('This database has no lubricant capacities table yet. Start the updated app once (it creates it), then run this again.');
  }

  // The streaming reader, not wb.xlsx.readFile. This workbook writes its internal links as absolute
  // paths ("/xl/worksheets/sheet1.xml"); exceljs only expects relative ones, so the full reader
  // crashes reconciling the comments part ("reading 'comments'") and the streaming reader cannot
  // name the sheets. Streaming reads the cells fine; the names are matched here, both forms allowed.
  const sheetRows = new Map();                 // row number -> Map(column -> value)
  const names = [];
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, {
    entries: 'emit', sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore', worksheets: 'emit',
  });
  const sheetName = (wsr) => {
    const target = (t) => String(t || '').replace(/^\/?(xl\/)?/, '');
    const rel = (reader.workbookRels || []).find((x) => target(x.Target) === `worksheets/sheet${wsr.id}.xml`);
    const sheet = rel && ((reader.model && reader.model.sheets) || []).find((s) => s.rId === rel.Id);
    return sheet ? sheet.name : wsr.name;
  };
  for await (const wsr of reader) {
    const name = sheetName(wsr);
    names.push(name);
    if (name !== SHEET) { for await (const _ of wsr) { /* skip other sheets */ } continue; }
    for await (const row of wsr) {
      const cells = new Map();
      row.eachCell({ includeEmpty: false }, (cell, col) => cells.set(col, cell.value));
      sheetRows.set(row.number, cells);
    }
  }
  if (!names.includes(SHEET)) die(`The file has no sheet called "${SHEET}". Sheets: ${names.join(', ')}`);
  const lastRow = Math.max(0, ...sheetRows.keys());

  const byCode = new Map();
  const byReg = new Map();
  for (const a of all('SELECT id, code, registration FROM assets')) {
    if (a.code) byCode.set(String(a.code).trim().toUpperCase(), a.id);
    if (a.registration) byReg.set(String(a.registration).trim().toUpperCase(), a.id);
  }

  const rows = [];
  for (let r = FIRST_ROW; r <= lastRow; r++) {
    const cells = sheetRows.get(r) || new Map();
    const c = (n) => (cells.has(n) ? cells.get(n) : null);
    const row = {
      sheet_id: cleanInt(c(1), null), ec_no: cleanVal(c(2)), registration: cleanVal(c(3)),
      category: cleanVal(c(4)), brand: cleanVal(c(5)), model: cleanVal(c(6)), year: cleanVal(c(7)),
      engine_oil_l: cleanNum(c(8)), engine_oil_grade: cleanVal(c(9)),
      gearbox_oil_l: cleanNum(c(10)), gearbox_oil_grade: cleanVal(c(11)),
      diff_oil_l: cleanNum(c(12)), diff_oil_grade: cleanVal(c(13)),
      front_axle_oil_l: cleanNum(c(14)), hydraulic_oil_l: cleanNum(c(15)), final_drive_oil_l: cleanNum(c(16)),
      swing_oil_l: cleanNum(c(17)), other_gearbox_oil_l: cleanNum(c(18)), coolant_l: cleanNum(c(19)),
      brake_fluid_l: cleanNum(c(20)), engine_oil_basis: cleanVal(c(21)), engine_oil_records: cleanInt(c(22), 0),
      notes: cleanVal(c(23)),
    };
    if (!row.ec_no && !row.registration && !row.category && !row.brand) continue;
    // Row 4 of the sheet repeats the column headings. The Python import loaded it as a vehicle
    // called "E&C No." (it is on the office PC); it is not one.
    if (row.ec_no === 'E&C No.' && row.registration === 'Registration') continue;
    row.asset_id = (row.ec_no && byCode.get(row.ec_no.toUpperCase()))
      || (row.registration && byReg.get(row.registration.toUpperCase())) || null;
    rows.push(row);
  }

  const matched = rows.filter((x) => x.asset_id).length;
  const unmatched = rows.filter((x) => !x.asset_id);
  const existing = get('SELECT COUNT(*) n FROM vehicle_lubricant_capacities').n;
  const edited = all(`SELECT id, ec_no, registration, updated_by, updated_at FROM vehicle_lubricant_capacities
                       WHERE COALESCE(updated_by, '') <> 'system_import' ORDER BY ec_no`);

  console.log(`\nIn the file:        ${rows.length} vehicles`);
  console.log(`Matched to a vehicle in the system: ${matched}`);
  console.log(`Not matched:        ${unmatched.length}${unmatched.length ? ' (kept, with no vehicle link — same as the office import)' : ''}`);
  for (const u of unmatched.slice(0, 40)) console.log(`    ${u.ec_no || '—'}  ${u.registration || ''}  ${u.category || ''}`);
  if (unmatched.length > 40) console.log(`    … and ${unmatched.length - 40} more`);
  console.log(`Already in the database: ${existing} (these are replaced)`);
  if (edited.length) {
    console.log(`\nChanged on screen since the last import: ${edited.length}`);
    for (const e of edited.slice(0, 40)) console.log(`    ${e.ec_no || '—'}  ${e.registration || ''}  by ${e.updated_by || '?'} on ${e.updated_at}`);
    if (!REPLACE_EDITED) die('Not replacing: these edits would be lost. Check them, then run again with --replace-edited if the file is right.');
  }

  if (!APPLY) { console.log('\nNothing changed. Run again with --apply to load it.\n'); return; }

  const { snapshot } = require('../src/lib/backup');
  const dest = await snapshot();
  if (!dest) die('The backup failed, so nothing was changed.');
  console.log(`\nBackup written: ${dest}`);

  const cols = ['asset_id', 'sheet_id', 'ec_no', 'registration', 'category', 'brand', 'model', 'year',
    'engine_oil_l', 'engine_oil_grade', 'gearbox_oil_l', 'gearbox_oil_grade', 'diff_oil_l', 'diff_oil_grade',
    'front_axle_oil_l', 'hydraulic_oil_l', 'final_drive_oil_l', 'swing_oil_l', 'other_gearbox_oil_l',
    'coolant_l', 'brake_fluid_l', 'engine_oil_basis', 'engine_oil_records', 'notes'];
  tx(() => {
    run('DELETE FROM vehicle_lubricant_capacities');
    for (const x of rows) {
      run(`INSERT INTO vehicle_lubricant_capacities (${cols.join(', ')}, updated_by)
           VALUES (${cols.map(() => '?').join(', ')}, 'system_import')`, ...cols.map((k) => x[k]));
    }
  });
  require('../src/lib/audit').record({
    entity: 'vehicle_lubricant_capacities', action: 'import', notify: false,
    before: { rows: existing }, after: { rows: rows.length, matched, file: path.basename(file) },
  });
  const now = get('SELECT COUNT(*) n, SUM(asset_id IS NOT NULL) linked FROM vehicle_lubricant_capacities');
  console.log(`Loaded: ${now.n} vehicles, ${now.linked} linked to a vehicle in the system.\n`);
}

main().then(() => process.exit(0)).catch((e) => die(e.stack || e.message));
