'use strict';

// General-item rack sheets → the system.
//
//   node scripts/import_general_racks.js            (dry run, default)
//   node scripts/import_general_racks.js --apply
//
// The storekeeper keeps one workbook per rack, one SHEET per item, and each sheet is a little
// ledger: Date | MR No | GRN No | Description/Vehicle | Received | Issued | Transferred |
// Balance | Remarks, opening with a "Balance" row. Those sheets are the working record, so
// they are what the system should agree with.
//
// Two things make this more than a straight load:
//
//   1. The same physical issue is often ALREADY in general_item_txns twice — once from the
//      inventory.db import (source NULL) and once from the warehouse CSV (source 'warehouse').
//      So new rows are matched by COUNT per (item, date, type, qty, vehicle): if the sheet
//      shows an event twice and the system already holds it twice, nothing is added; if the
//      sheet shows it three times, one is added. That keeps genuine same-day repeats — a
//      storekeeper really does issue one Cup Brush to LP-1720 twice in a morning — without
//      ever re-adding what is already recorded.
//
//   2. Because of those legacy duplicates the running ledger no longer adds up, so the item
//      balance is taken from the SHEET's own closing balance rather than re-derived. The
//      storekeeper counted the shelf; that is the number.

const fs = require('fs');
const ExcelJS = require('exceljs');
const { get, all, run, tx } = require('../src/db');
const aliases = require('../src/lib/aliases');

const DIR = process.env.RACK_DIR || 'D:/General items/General Items/';
const APPLY = process.argv.includes('--apply');
const SRC_TAG = 'racksheet';

// ---- cell helpers ---------------------------------------------------------
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
// Item identity: case, spacing and punctuation are typing noise, digits are not —
// "Sand Paper(400)" and "Sand Paper (400)" are one item, "(400)" and "(1000)" are not.
const itemKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// A sheet may be known by its tab OR by the heading in A1. Resolved below, once the register
// is loaded, to whichever spelling something already recognises — so two sheets that spell one
// item differently meet as the same item instead of splitting its stock across two racks.
let keyOfSheet = (it) => it.keys[0];
const descKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const lookupAsset = (v) => {
  const n = aliases.normalize(v);
  if (!n) return null;
  const a = get('SELECT id FROM assets WHERE code_norm = ?', n);
  if (a) return a.id;
  const al = get('SELECT asset_id FROM asset_aliases WHERE raw_norm = ? AND resolved = 1 AND asset_id IS NOT NULL', n);
  return al ? al.asset_id : null;
};

// Descriptions that name a place rather than a machine — never an asset to resolve.
const NON_VEHICLE = /^(l\/p|lp|balance|opening|main stores|stores|store|workshop|yard|electrician|mechanic|welder|painter|office|general|n\/a|-)$/i;

async function readSheets() {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.xlsx') && !/Summery|Summary/i.test(f) && !f.startsWith('~$'));
  const items = [];
  for (const f of files) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(DIR + f);
    const rack = (f.match(/Rack\s*([0-9]+\s*[A-Z])/i) || [])[1];
    for (const ws of wb.worksheets) {
      // The tab and the heading in A1 are both the item's name, and they are not always typed
      // the same: rack 5E's tab says "Coolant" over a heading of "Coolent", while the Car Wash
      // book's tab says "Coolanat" over a heading of "Coolant". Going by the tab alone made
      // those two sheets two different items, and the same 24 units of coolant were counted
      // in two racks. Either spelling now identifies the item.
      // Taken whole. The bracket here is part of the name — "Sand Paper(1000)" and
      // "Air Socket (6mm)" are the grade and the size, not a note to be trimmed off, and
      // dropping it would fold every grade of sandpaper into one item.
      const heading = T(ws.getCell(1, 1).value).trim();
      const rows = [];
      let closing = null;
      for (let r = 4; r <= ws.rowCount; r++) {
        const desc = T(ws.getCell(r, 4).value).trim();
        const rec = N(ws.getCell(r, 5).value);
        const issd = N(ws.getCell(r, 6).value);
        const trf = N(ws.getCell(r, 7).value);
        const bal = T(ws.getCell(r, 8).value);
        if (bal !== '' && !Number.isNaN(Number(bal))) closing = Number(bal);   // last non-empty balance wins
        if (!desc && !rec && !issd && !trf && !(bal !== '' && !Number.isNaN(Number(bal)) && !rows.length && iso(ws.getCell(r, 1).value))) continue;
        // Most sheets label their opening row "Balance". "Break Oil 355ml" and "Break Oil
        // DOT 5" label nothing at all — a date, an MR number and the quantity in the Balance
        // column, with Description and Received both blank. That is still the opening, and
        // dropping it leaves the item's issues with nothing to come out of: 355ml lands at -2.
        const opening = /^(balance|opening)/i.test(desc)
          || (!rows.length && !rec && !issd && !trf && bal !== '' && !Number.isNaN(Number(bal)));
        const type = opening ? 'opening' : (rec > 0 ? 'receipt' : (issd > 0 ? 'issue' : (trf > 0 ? 'issue' : null)));
        if (!type) continue;
        const qty = opening ? Math.abs(N(ws.getCell(r, 8).value)) : Math.abs(rec || issd || trf);
        rows.push({
          date: iso(ws.getCell(r, 1).value), type, qty, desc,
          ref: T(ws.getCell(r, 2).value).trim() || T(ws.getCell(r, 3).value).trim() || null,
          transfer: !opening && !rec && !issd && trf > 0,
          sheet: ws.name, file: f, row: r,
        });
      }
      // The closing balance is the sheet's OWN rows added up, not the Balance column.
      // exceljs drops a cached formula result of 0 (its _copyModel keeps a field only when
      // truthy), so a sheet that ends at zero reports the last non-zero figure instead: Cup
      // Brush reads 1 where the file plainly holds <v>0</v>. Adding up the rows cannot be
      // fooled that way, and it is per-sheet, so the legacy double-entries in the database
      // never enter into it. `shown` keeps whatever the column could be read as, for the
      // cross-check below.
      const derived = rows.reduce((s, r) => s + (r.type === 'issue' ? -r.qty : r.qty), 0);
      const keys = [...new Set([itemKey(ws.name), itemKey(heading)].filter(Boolean))];
      items.push({ name: ws.name.trim(), heading, keys, rack: rack ? rack.replace(/\s+/g, '') : null, file: f, rows,
        closing: Math.round(derived * 100) / 100, shown: closing, sheetName: ws.name.trim() });
    }
  }
  return items;
}

async function readSummary() {
  const f = fs.readdirSync(DIR).find((x) => /Summery|Summary/i.test(x) && x.endsWith('.xlsx'));
  if (!f) return new Map();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(DIR + f);
  const ws = wb.worksheets[0];
  const m = new Map();
  for (let r = 3; r <= ws.rowCount; r++) {
    const name = T(ws.getCell(r, 2).value).trim();
    if (!name) continue;
    // The rack is kept even when the quantity cell is a formula the reader cannot see —
    // they are two separate facts, and dropping the row would lose the rack as well.
    const qtyRaw = T(ws.getCell(r, 4).value);
    const qty = (qtyRaw === '' || Number.isNaN(Number(qtyRaw))) ? null : Number(qtyRaw);
    m.set(itemKey(name), { name, qty, rack: T(ws.getCell(r, 5).value).trim() || null });
  }
  return m;
}

(async () => {
  const sheets = await readSheets();
  const summary = await readSummary();

  // A sheet is identified by its TAB. The heading in A1 is only used to SPOT a sheet that is
  // the same item under another spelling — never to merge it. Merging would move one sheet's
  // ledger onto another register row while the first row keeps its own copy, so the stock is
  // counted twice in a new way instead of the old one. Two register rows becoming one is a
  // decision about what is physically on the shelf, so it is reported and left to the owner.
  keyOfSheet = (it) => it.keys[0];
  const spellingSplit = [];
  const byAnyKey = new Map();
  for (const it of sheets) for (const k of it.keys) { if (!byAnyKey.has(k)) byAnyKey.set(k, []); byAnyKey.get(k).push(it); }
  for (const [, group] of byAnyKey) {
    if (group.length < 2) continue;
    const tabs = [...new Set(group.map((g) => itemKey(g.name)))];
    if (tabs.length > 1) spellingSplit.push(group);
  }

  // store_items keyed on the same normalised name. Where the register holds the same item
  // twice (the "Sand Paper(400)" / "Sand Paper (400)" pairs), prefer the one carrying stock.
  const byKey = new Map();
  for (const s of all('SELECT id, name, balance, rack, is_general FROM store_items WHERE is_general = 1')) {
    const k = itemKey(s.name);
    const cur = byKey.get(k);
    if (!cur || (Math.abs(s.balance || 0) > Math.abs(cur.balance || 0))) byKey.set(k, s);
  }

  // Everything already recorded, counted per (item, date, type, qty, who).
  const have = new Map();
  for (const t of all(`SELECT store_item_id, date(txn_date) d, txn_type, ABS(qty) q, asset_id, source FROM general_item_txns`)) {
    const k = [t.store_item_id, t.d, t.txn_type, t.q, t.asset_id || ''].join('|');
    have.set(k, (have.get(k) || 0) + 1);
  }

  const plan = [];
  const rep = { sheets: sheets.length, rows: 0, matched: 0, newItems: [], already: 0, add: 0,
    noDate: 0, unresolved: new Map(), balance: [], summaryMiss: [] };

  for (const it of sheets) {
    const k = keyOfSheet(it);
    const item = byKey.get(k);
    if (item) rep.matched++; else rep.newItems.push(it.name);
    for (const r of it.rows) {
      rep.rows++;
      if (!r.date) { rep.noDate++; continue; }
      let assetId = null;
      if (r.type === 'issue' && r.desc && !NON_VEHICLE.test(r.desc)) {
        assetId = lookupAsset(r.desc);
        if (!assetId) rep.unresolved.set(r.desc, (rep.unresolved.get(r.desc) || 0) + 1);
      }
      const key = [item ? item.id : 'NEW:' + k, r.date, r.type, r.qty, assetId || ''].join('|');
      const held = have.get(key) || 0;
      if (held > 0) { have.set(key, held - 1); rep.already++; continue; }   // one of the sheet's rows is accounted for
      plan.push({ itemKey: k, itemId: item ? item.id : null, itemName: it.name, rack: it.rack,
        date: r.date, type: r.type, qty: r.qty, assetId, desc: r.desc, ref: r.ref });
      rep.add++;
    }
    // What the shelf should read once this is loaded.
    const sum = summary.get(k);
    const sheetBal = it.closing;
    it.agreesWithSummary = sum != null && sum.qty != null && sheetBal != null && Number(sum.qty) === Number(sheetBal);
    it.item = item;
    if (sum && sum.qty != null && sheetBal != null && Number(sum.qty) !== Number(sheetBal)) {
      rep.summaryMiss.push({ name: it.name, sheet: sheetBal, summary: sum.qty });
    }
  }

  // Where an item is written up on two sheets, only ONE of them sets the balance — the sheet
  // agreeing with the Summary, else the fuller one. Deciding that here rather than at write
  // time keeps the report and what actually happens in step.
  const bySheetItem = new Map();
  for (const it of sheets) {
    if (it.closing == null) continue;
    const k = keyOfSheet(it);
    const cur = bySheetItem.get(k);
    if (!cur) { bySheetItem.set(k, it); continue; }
    const better = (it.agreesWithSummary && !cur.agreesWithSummary) ? it
      : (cur.agreesWithSummary && !it.agreesWithSummary) ? cur
        : (it.rows.length > cur.rows.length ? it : cur);
    bySheetItem.set(k, better);
  }
  for (const it of bySheetItem.values()) {
    if (it.item && Number(it.item.balance) !== Number(it.closing)) {
      rep.balance.push({ id: it.item.id, name: it.item.name, was: it.item.balance, now: it.closing });
    }
  }

  console.log(`item sheets read: ${rep.sheets}   transaction rows: ${rep.rows}`);
  console.log(`  matched to an existing general item : ${rep.matched}`);
  console.log(`  item sheets with no register entry   : ${rep.newItems.length}`);
  console.log(`  rows already recorded (skipped)      : ${rep.already}`);
  console.log(`  rows to ADD                          : ${rep.add}`);
  console.log(`  rows with no usable date (skipped)   : ${rep.noDate}`);
  console.log();
  const byType = {};
  plan.forEach((p) => { byType[p.type] = (byType[p.type] || 0) + 1; });
  console.log('  to add, by type:', JSON.stringify(byType));
  const byMonth = {};
  plan.forEach((p) => { const m = p.date.slice(0, 7); byMonth[m] = (byMonth[m] || 0) + 1; });
  console.log('  to add, by month:', JSON.stringify(byMonth));
  console.log();

  if (rep.newItems.length) {
    console.log(`items on a sheet but not in the register (${rep.newItems.length}) — they would be created:`);
    rep.newItems.slice(0, 30).forEach((n) => console.log('   ', n));
    console.log();
  }
  if (rep.unresolved.size) {
    const u = [...rep.unresolved.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`vehicle names that do not resolve to an asset (${u.length}) — the issue is still recorded, without a machine:`);
    u.slice(0, 20).forEach(([n, c]) => console.log('   ' + String(c).padStart(3), n));
    console.log();
  }
  // The same item written up on two sheets is a source problem worth saying out loud — one of
  // the two is being kept and the other has quietly gone stale.
  const seenSheet = new Map();
  for (const it of sheets) {
    const k = keyOfSheet(it);
    if (!seenSheet.has(k)) seenSheet.set(k, []);
    seenSheet.get(k).push(it);
  }
  if (spellingSplit.length) {
    console.log(`the same item written up under two spellings (${spellingSplit.length}) — REVIEW, its stock is split across two register rows:`);
    spellingSplit.forEach((g) => g.forEach((s) => console.log(
      `   tab ${JSON.stringify(s.name).padEnd(14)} heading ${JSON.stringify(s.heading).padEnd(14)} closing ${String(s.closing).padStart(5)}   ${s.file}`)));
    console.log();
  }

  const twice = [...seenSheet.values()].filter((v) => v.length > 1);
  if (twice.length) {
    console.log(`items written up on MORE THAN ONE sheet (${twice.length}) — REVIEW, one copy is probably stale:`);
    twice.forEach((v) => v.forEach((it) => console.log(
      `   ${String(it.name).padEnd(20)} closing ${String(it.closing).padStart(8)}  ${it.agreesWithSummary ? '(agrees with Summary)' : ''}  ${it.file}`)));
    console.log();
  }

  // ---- where each item lives -------------------------------------------------
  // The workbook an item's ledger sits in IS its rack — "Rack 2C General Item Issuing &
  // Recieving.xlsx" means rack 2C. The Summary's RACK NO column agrees on 82 of 87, so it is
  // used only where the workbook cannot say: the Car Wash & Others book is not named after a
  // rack. Where the two disagree the workbook wins and the disagreement is printed, because
  // moving a sheet between workbooks is deliberate while re-typing a summary cell is easy to
  // get wrong.
  const rackOf = (it) => {
    if (it.rack) return it.rack;
    const s = summary.get(keyOfSheet(it));
    if (s && s.rack) return s.rack.replace(/\s+/g, '');
    return 'Car Wash';                    // the wash-bay consumables have no rack of their own
  };
  const rackSame = (a, b) => String(a || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    === String(b || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  const rackConflict = [];
  const rackPlan = [];
  for (const it of sheets) {
    const k = keyOfSheet(it);
    const s = summary.get(k);
    if (it.rack && s && s.rack && !rackSame(it.rack, s.rack)) {
      rackConflict.push({ name: it.name, workbook: it.rack, summary: s.rack });
    }
    const item = byKey.get(k);
    const want = rackOf(it);
    if (item && !rackSame(item.rack, want)) rackPlan.push({ id: item.id, name: item.name, from: item.rack, to: want });
  }

  console.log(`rack numbers that would change: ${rackPlan.length}`);
  rackPlan.slice(0, 40).forEach((r) => console.log(`   ${String(r.name).padEnd(30)} ${String(r.from || '(none)').padEnd(12)} → ${r.to}`));
  if (rackPlan.length > 40) console.log(`   … and ${rackPlan.length - 40} more`);
  console.log();
  if (rackConflict.length) {
    console.log(`items whose workbook and Summary disagree about the rack (${rackConflict.length}) — the workbook is used, REVIEW:`);
    rackConflict.forEach((c) => console.log(`   ${String(c.name).padEnd(30)} workbook ${String(c.workbook).padEnd(6)} summary ${c.summary}`));
    console.log();
  }

  console.log(`item balances that would change to match the sheet: ${rep.balance.length}`);
  rep.balance.slice(0, 25).forEach((b) => console.log(`   ${String(b.name).padEnd(30)} ${String(b.was).padStart(8)} → ${b.now}`));
  console.log();
  if (rep.summaryMiss.length) {
    console.log(`sheets whose own closing balance disagrees with the Summary workbook (${rep.summaryMiss.length}) — REVIEW:`);
    rep.summaryMiss.slice(0, 20).forEach((s) => console.log(`   ${String(s.name).padEnd(30)} sheet ${s.sheet}  summary ${s.summary}`));
    console.log();
  }

  if (!APPLY) { console.log('DRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

  const out = tx(() => {
    const created = new Map();
    let added = 0;
    for (const p of plan) {
      let id = p.itemId;
      if (!id) {
        if (created.has(p.itemKey)) id = created.get(p.itemKey);
        else {
          const info = run(
            `INSERT INTO store_items (name, unit, rack, min_stock, is_general, balance, catalogue_kind)
             VALUES (?, 'nos', ?, 0, 1, 0, 'general')`, p.itemName, p.rack);
          id = info.lastInsertRowid;
          run(`UPDATE store_items SET item_no = ? WHERE id = ?`, 'GS-' + String(id).padStart(4, '0'), id);
          created.set(p.itemKey, id);
        }
      }
      run(`INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, asset_id, job_id, unit_price, ref, txn_date, source)
           VALUES (?, ?, ?, 0, ?, NULL, NULL, ?, ?, ?)`,
        id, p.type, p.type === 'issue' ? -p.qty : p.qty, p.assetId, p.ref, p.date, SRC_TAG);
      added++;
    }

    // The balance comes from the ITEM SHEET, not from re-summing the ledger and not from the
    // Summary workbook. Re-summing would carry the legacy double-entries straight into the
    // balance; and where the two workbooks disagree (16 items on the 2026-08-16 load) the
    // owner's call was the item sheet, because its arithmetic runs unbroken from the opening
    // row through every receipt and issue, while the Summary is re-typed by hand.
    // One item can be kept on two sheets — "Hand Gloves" is written up both in Car Wash &
    // Others and in Rack 2C, from the same two MRs, but the Car Wash copy stopped being
    // updated. bySheetItem (decided above, alongside the report) holds the live one.
    let rebal = 0;
    const held = 0;
    for (const it of bySheetItem.values()) {
      const k = keyOfSheet(it);
      const id = (byKey.get(k) || {}).id || created.get(k);
      if (!id) continue;
      // A deliberate correction outranks the sheet. Where someone has adjusted the item AFTER
      // its sheet's last movement — as the coolant write-down did, once the owner confirmed
      // MR 140621 had been written into two books — re-asserting the sheet would quietly undo
      // it on the next run.
      const lastMove = it.rows.map((r) => r.date).filter(Boolean).sort().pop() || '0000-00-00';
      const adj = get(
        `SELECT 1 v FROM general_item_txns
          WHERE store_item_id = ? AND txn_type = 'adjustment' AND date(txn_date) > date(?) LIMIT 1`, id, lastMove);
      if (adj) continue;
      const cur = get('SELECT balance FROM store_items WHERE id = ?', id);
      if (cur && Number(cur.balance) !== Number(it.closing)) {
        run('UPDATE store_items SET balance = ? WHERE id = ?', it.closing, id);
        rebal++;
      }
    }

    // Rack numbers, for every sheet item — including the ones already in the register, which
    // were still carrying racks from the old warehouse import ("13A", "Legacy Log").
    let racked = 0;
    for (const it of sheets) {
      const k = keyOfSheet(it);
      const id = (byKey.get(k) || {}).id || created.get(k);
      if (!id) continue;
      const want = rackOf(it);
      const cur = get('SELECT rack FROM store_items WHERE id = ?', id);
      if (cur && !rackSame(cur.rack, want)) {
        run('UPDATE store_items SET rack = ? WHERE id = ?', want, id);
        racked++;
      }
    }
    return { added, created: created.size, rebal, held, racked };
  });

  console.log(`\nAdded ${out.added} transaction(s), created ${out.created} item(s), corrected ${out.rebal} balance(s), set ${out.racked} rack number(s).`);
  if (out.held) console.log(`${out.held} balance(s) left as they were — the item sheet and the Summary workbook disagree (listed above).`);
})();
