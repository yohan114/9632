'use strict';

// Filter stock sheets → the Filter Stock register.
//
//   node scripts/import_filter_stock.js            (dry run, default)
//   node scripts/import_filter_stock.js --apply
//
// D:\General items\Filters\ holds four folders — In Stock, Heavy Vehicle, Light Vehicle and
// Machinery — each with a workbook per filter kind and one SHEET per part number, in the same
// ledger layout as the rack sheets:
//   Date | MR No | GRN No | Description/Vehicle | Received | Issued | Transferred | Balance
//
// The vehicle-class folders differ from In Stock in one useful way: the Description column
// names the MACHINE each filter is held for, and a sheet often lists several — four rows
// running the balance up to four. Those are kept: one ledger receipt per row, against the
// vehicle it is for, so the register can answer "what is this filter here for".
//
// Quirks of the source, all handled:
//   • the opening row is sometimes labelled "Balance" (in Description or in MR No) and
//     sometimes not labelled at all, so EVERY movement row is loaded on its own merits.
//   • a sheet NAME cannot contain a slash, so "32/925682" is tabbed "32 925682" — the part
//     number is read from the title in row 1, which keeps the real punctuation.
//   • the same filter is typed "Oil Filter", "Oil FILTER" and "OIL FILTER"; the type is
//     title-cased so they land as one group, and a bare "Hydrolic" gains its "Filter".
//   • four Machinery sheets have no part number yet, just dots. They are loaded with a null
//     part number and kept apart by the machine they are for, never merged into one row.
//
// One row per SHEET, deliberately: where the same number appears on two sheets, that is the
// owner's filing to reconcile, not this script's to guess at. Collisions are reported.

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { get, all, run, tx } = require('../src/db');
const aliases = require('../src/lib/aliases');

const ROOT = process.env.FILTER_ROOT || 'D:/General items/Filters/';
const FOLDERS = ['In Stock', 'Heavy Vehicle', 'Light Vehicle', 'Machinery'];
const APPLY = process.argv.includes('--apply');

const T = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return v.result == null ? '' : String(v.result);
    if (v.error) return '';
  }
  return String(v);
};
const N = (v) => { const s = T(v).replace(/[^0-9.\-]/g, ''); return s === '' ? 0 : (Number(s) || 0); };
const iso = (v) => { const s = T(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const normF = (s) => String(s || '').toUpperCase().replace(/\([^)]*\)/g, '').replace(/[^A-Z0-9]/g, '');
const typeKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z]/g, '');

// Names in the vehicle column that are places, not machines.
const NOT_VEHICLE = /^(balance|opening|l\/p|lp|main stores|stores|store|workshop|yard|n\/a|-|\.*)$/i;

// "OIL FILTER" → "Oil Filter"; "Hydrolic" → "Hydrolic Filter". His spelling is left alone —
// only the shouting is fixed — because "Hydrolic" is what every one of his sheets says.
function tidyType(raw) {
  let t = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!t) return 'Filter';
  t = t.split(' ').map((w) => (/^[A-Z]{2,}$/.test(w) && w !== 'JCB' ? w[0] + w.slice(1).toLowerCase() : w)).join(' ');
  t = t.replace(/\b(filters?)\b/gi, 'Filter');
  if (!/filter|separator/i.test(t)) t += ' Filter';
  return t;
}

function parseTitle(title, sheetName) {
  const m = String(title || '').match(/^\s*(.*?)\s*\(([^)]*)\)\s*$/);
  const type = tidyType(m ? m[1] : title);
  let part = (m ? m[2] : sheetName).trim();
  if (!normF(part)) part = '';                       // "…………." is not a part number
  return { type, part };
}

const lookupAsset = (v) => {
  const n = aliases.normalize(v);
  if (!n) return null;
  const a = get('SELECT id FROM assets WHERE code_norm = ?', n);
  if (a) return a.id;
  const al = get('SELECT asset_id FROM asset_aliases WHERE raw_norm = ? AND resolved = 1 AND asset_id IS NOT NULL', n);
  return al ? al.asset_id : null;
};

(async () => {
  const sheets = [];
  for (const folder of FOLDERS) {
    const dir = path.join(ROOT, folder) + '/';
    if (!fs.existsSync(dir)) { console.log(`(no folder ${folder} — skipped)`); continue; }
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.xlsx') && !x.startsWith('~$'))) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(dir + f);
      for (const ws of wb.worksheets) {
        const { type, part } = parseTitle(T(ws.getCell(1, 1).value), ws.name);
        const moves = [];
        const strays = [];
        let closing = null;
        for (let r = 4; r <= ws.rowCount; r++) {
          const desc = T(ws.getCell(r, 4).value).trim();
          const date = iso(ws.getCell(r, 1).value);
          const rec = N(ws.getCell(r, 5).value);
          const issd = N(ws.getCell(r, 6).value);
          const trf = N(ws.getCell(r, 7).value);
          const bal = T(ws.getCell(r, 8).value);
          const hasBal = bal !== '' && !Number.isNaN(Number(bal));
          if (hasBal) closing = Number(bal);
          // A real line names a date or a machine — usually both. A stray names neither:
          // "320-04133" has a part number, "006017310BI", sitting alone in the Received column
          // of row 55, and reading that as a quantity would put six million filters on the
          // shelf. Requiring a date alone would be too strict, because "320/04134" row 5 is a
          // genuine receipt for ZA-7968 with the date simply not typed.
          if (!date && !desc) {
            if (rec || issd || trf) strays.push({ row: r, raw: T(ws.getCell(r, 5).value) || T(ws.getCell(r, 6).value) });
            continue;
          }
          // Most sheets write the opening in Received. Some write it ONLY in Balance
          // ("Hydrolic Section Filter (32/925682)": Balance 148, Received blank) — that is
          // still the opening position, and skipping it would leave the filter on the
          // register with a quantity but no history behind it.
          const openingOnly = !rec && !issd && !trf && hasBal && !moves.length;
          if (!rec && !issd && !trf && !openingOnly) continue;
          moves.push({
            // An undated line carries the date of the one above it, which is where it sits.
            date: date || (moves.length ? moves[moves.length - 1].date : null),
            qty: rec || (openingOnly ? Number(bal) : 0),
            out: issd || trf || 0,
            vehicle: desc && !NOT_VEHICLE.test(desc) ? desc : null,
          });
        }
        const vehicles = [...new Set(moves.map((m) => m.vehicle).filter(Boolean))];
        // The quantity is the MOVEMENTS added up, not the Balance column. On 23 sheets the
        // balance cell is a formula whose cached value the reader cannot see, so the last
        // readable figure is stale — C-1121 reads 1 there but was issued to PA-6399 on
        // 2026-08-08 and is actually gone. Trusting that column would put filters on the
        // register that are not on the shelf.
        const qty = moves.reduce((s, m) => s + (m.qty || 0) - (m.out || 0), 0);
        sheets.push({ folder, file: f, sheet: ws.name, type, part, moves, qty, closing, vehicles, strays });
      }
    }
  }

  const book = new Map();
  for (const p of all('SELECT filter_no, filter_no_norm, category, unit_price FROM filter_prices')) {
    book.set(p.filter_no_norm || normF(p.filter_no), p);
  }
  // Idempotency key: the part number and what kind of filter it is. A sheet with no part
  // number falls back to the machine it is for, so four unnamed filters stay four rows.
  const keyOf = (s) => (normF(s.part) ? normF(s.part) : 'NOPART:' + s.vehicles.join(',')) + '|' + typeKey(s.type);
  const held = new Map();
  for (const f of all('SELECT id, part_no, filter_type, compatible_assets, qty_in_stock FROM filter_stock')) {
    const vk = normF(f.part_no) ? normF(f.part_no)
      : 'NOPART:' + String(f.compatible_assets || '').split('·').pop().trim();
    held.set(vk + '|' + typeKey(f.filter_type), f);
  }

  const plan = sheets.filter((s) => !held.has(keyOf(s)));
  const skipped = sheets.length - plan.length;

  console.log(`filter sheets read: ${sheets.length}   already in the register: ${skipped}   to add: ${plan.length}`);
  const byGroup = {};
  plan.forEach((s) => { const k = s.folder + ' / ' + s.type; byGroup[k] = (byGroup[k] || 0) + 1; });
  console.log();
  Object.entries(byGroup).sort().forEach(([k, v]) => console.log('   ' + String(v).padStart(4), k));
  console.log();
  console.log(`  units to add: ${plan.reduce((s, x) => s + x.qty, 0)}`);
  const priced = plan.filter((s) => (book.get(normF(s.part)) || {}).unit_price > 0);
  const value = priced.reduce((s, x) => s + book.get(normF(x.part)).unit_price * x.qty, 0);
  console.log(`  of which priced from the book: ${priced.length} line(s), Rs ${Math.round(value * 100) / 100}`);
  console.log();

  // Same number on two sheets — the owner's filing to settle, not this script's.
  const g = {};
  sheets.forEach((s) => { if (normF(s.part)) { (g[normF(s.part)] = g[normF(s.part)] || []).push(s); } });
  const dups = Object.entries(g).filter(([, v]) => v.length > 1);
  if (dups.length) {
    console.log(`part numbers written up on MORE THAN ONE sheet (${dups.length}) — REVIEW, they load as separate lines:`);
    dups.forEach(([, v]) => v.forEach((s) => console.log(
      `   ${String(s.part).padEnd(17)} ${String(s.type).padEnd(24)} ${String(s.folder).padEnd(14)} qty ${String(s.qty).padStart(3)}   ${s.vehicles.slice(0, 3).join(', ')}`)));
    console.log();
  }
  // Where the balance column could be read and disagrees with the movements, the sheet is
  // telling two different stories — worth the owner's eye either way.
  const drift = sheets.filter((s) => s.closing != null && Math.abs(s.qty - s.closing) > 0.001);
  if (drift.length) {
    console.log(`sheets whose movements do not add up to their Balance column (${drift.length}):`);
    drift.slice(0, 30).forEach((s) => console.log(
      `   ${String(s.part || '(no part no)').padEnd(17)} ${String(s.folder).padEnd(14)} movements ${String(s.qty).padStart(4)}   balance column ${String(s.closing).padStart(4)}`));
    console.log('   (the movements are used — on most of these the balance cell is a formula the reader cannot see)');
    console.log();
  }
  const strayRows = sheets.filter((s) => s.strays.length);
  if (strayRows.length) {
    console.log(`stray values below the table, ignored (${strayRows.length}):`);
    strayRows.forEach((s) => s.strays.forEach((x) => console.log(`   ${String(s.part).padEnd(17)} ${s.folder.padEnd(14)} row ${x.row}: ${JSON.stringify(x.raw)}`)));
    console.log();
  }

  const noPart = sheets.filter((s) => !normF(s.part));
  if (noPart.length) {
    console.log(`sheets with no part number yet (${noPart.length}) — loaded against their machine:`);
    noPart.forEach((s) => console.log(`   ${String(s.type).padEnd(24)} ${s.folder.padEnd(14)} qty ${s.qty}   ${s.vehicles.join(', ')}`));
    console.log();
  }
  const unresolved = new Set();
  sheets.forEach((s) => s.vehicles.forEach((v) => { if (!lookupAsset(v)) unresolved.add(v); }));
  if (unresolved.size) {
    console.log(`vehicle names that do not resolve to an asset (${unresolved.size}) — recorded as text, no machine link:`);
    console.log('   ' + [...unresolved].slice(0, 24).join(', '));
    console.log();
  }

  if (!APPLY) { console.log('DRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

  const out = tx(() => {
    let added = 0; let ledger = 0;
    for (const s of plan) {
      const b = book.get(normF(s.part));
      const cost = b && b.unit_price > 0 ? b.unit_price : null;
      const compat = [s.folder, s.vehicles.join(', ')].filter(Boolean).join(' · ') || null;
      const info = run(
        `INSERT INTO filter_stock (filter_type, brand, part_no, unit, qty_in_stock, reorder_level, unit_cost, supplier, compatible_assets)
         VALUES (?, NULL, ?, 'nos', ?, 0, ?, NULL, ?)`,
        s.type, s.part || null, s.qty, cost, compat);
      const id = info.lastInsertRowid;
      // Each line of the sheet goes on the ledger against the machine it names, so the
      // register keeps WHY the filter is held, not just how many.
      let bal = 0;
      for (const m of s.moves) {
        const qty = m.out ? -Math.abs(m.out) : Math.abs(m.qty);
        if (!qty) continue;
        bal += qty;
        run(`INSERT INTO filter_stock_ledger (filter_id, kind, qty, balance_after, asset_id, unit_price, note, txn_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id, qty > 0 ? 'receipt' : 'issue', qty, bal, m.vehicle ? lookupAsset(m.vehicle) : null, cost,
          [qty > 0 ? 'from the stock sheet' : 'issued (stock sheet)', m.vehicle ? 'for ' + m.vehicle : ''].filter(Boolean).join(' · '),
          m.date || new Date().toISOString().slice(0, 10));
        ledger++;
      }
      added++;
    }
    return { added, ledger };
  });

  console.log(`\nAdded ${out.added} filter type(s) and ${out.ledger} ledger row(s).`);
})();
