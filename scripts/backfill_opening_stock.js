'use strict';

// Give the shelf a starting point, so nothing reads as less than nothing.
//
// 490 general items and 7 lubricants show a NEGATIVE balance: more issued than ever received.
// 461 of them have no receipt at all. They were taken from stock that was already on the shelf
// when the system started recording arrivals, and no opening balance was ever set — only 46 of
// 1,821 general items have one. (Filters, batteries and tyres avoid this entirely by starting
// from a cut-over date instead of counting all history.)
//
// NOTHING HERE IS INVENTED. The opening is the gap between the movement history and a figure
// the workshop has ALREADY recorded:
//
//   general    store_items.balance — the balance the storekeeper counted. The same anchor
//              scripts/fix_general_running_balance.js works back from. 464 of the 484 are
//              counted at zero, so their opening is exactly the shortfall; 20 carry a positive
//              counted balance the history never accounted for.
//   lubricants the latest physical count in stock_counts (4 of the 7 have one — 15W40 was
//              counted at 163 L in 2026-07 against a history of -18). Where a product has
//              never been counted the anchor is zero, which brings it to nothing, not to plenty.
//
// So: opening = counted − history. Afterwards the ledger ends exactly where the shelf is.
//
// Each opening is dated the day BEFORE that item's own first movement, so no month's reported
// consumption changes and the item is never negative at any point in its history. Rows are
// written into the SOURCE tables (general_item_txns / stock_ledger) rather than stock_moves,
// or the next rebuild would wipe them.
//
//   node scripts/backfill_opening_stock.js            # dry run
//   node scripts/backfill_opening_stock.js --apply
//
// Reversible: every row is marked 'opening-backfill'.

const { get, all, run, tx } = require('../src/db');
const lubricants = require('../src/lib/lubricants');

const APPLY = process.argv.includes('--apply');
const MARK = 'opening-backfill';
const dayBefore = (d) => {
  const t = new Date(String(d).slice(0, 10) + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
};
const r3 = (v) => Math.round(v * 1000) / 1000;

// ---- general items ---------------------------------------------------------
// AN OPENING IS RE-SIZED, NOT SKIPPED. The first run computed `counted − history` against a
// history that was itself wrong — the oil ledger and the stores GRNs were both counting the same
// deliveries. Once those duplicates were voided the history shrank, and the openings sized
// against it were left too small: 15W40 opened at 181 and read -40, Cotton Waste opened at 33.5
// and read -110. So the history is measured EXCLUDING any opening this script wrote, and the
// opening is set to whatever now closes the gap. Re-running is safe and always lands on the same
// answer.
const genOpeningIds = new Set(all(`SELECT id FROM general_item_txns WHERE source = ?`, MARK).map((r) => r.id));
const generalRows = all(
  `SELECT sm.item_key, MAX(sm.item_name) AS nm, MAX(sm.store_item_id) AS sid,
          ROUND(SUM(CASE WHEN sm.source_table = 'general_item_txns' AND sm.source_id IN (SELECT id FROM general_item_txns WHERE source = '${MARK}') THEN 0
                         WHEN sm.kind IN ('in','opening','adjust') THEN sm.qty ELSE -sm.qty END),3) AS net,
          MIN(CASE WHEN sm.source_table = 'general_item_txns' AND sm.source_id IN (SELECT id FROM general_item_txns WHERE source = '${MARK}') THEN NULL
                   ELSE sm.txn_date END) AS first_move
     FROM stock_moves sm WHERE sm.section = 'general' AND sm.counts = 1
    GROUP BY sm.item_key`);

const genPlan = []; const genSkipped = [];
for (const r of generalRows) {
  if (!r.sid) { if (r.net < -0.001) genSkipped.push(r); continue; }  // a free-text issue, no catalogue item
  const si = get('SELECT name, balance FROM store_items WHERE id = ?', r.sid);
  const counted = Number(si && si.balance) || 0;
  const opening = r3(counted - r.net);
  const existing = get(`SELECT id, qty FROM general_item_txns WHERE store_item_id = ? AND source = ?`, r.sid, MARK);
  if (opening <= 0) {
    if (!existing || Math.abs(existing.qty) < 0.001) continue;
    genPlan.push({ ...r, name: si ? si.name : r.nm, counted, opening: 0, existing, on: dayBefore(r.first_move) });
    continue;
  }
  if (existing && Math.abs(existing.qty - opening) < 0.001) continue;   // already right
  if (!existing && r.net >= -0.001) continue;                          // nothing wrong to fix
  genPlan.push({ ...r, name: si ? si.name : r.nm, counted, opening, existing, on: dayBefore(r.first_move) });
}

// ---- lubricants ------------------------------------------------------------
const oilOpeningIds = new Set(all(`SELECT id FROM stock_ledger WHERE note LIKE ?`, '%' + MARK + '%').map((r) => r.id));
const oilMoves = all(`SELECT item_name, kind, qty, txn_date, source_table, source_id FROM stock_moves
                       WHERE section = 'oil' AND counts = 1 AND item_name IS NOT NULL`);
// A COUNT IS A FACT ABOUT THE DAY IT WAS TAKEN. Sizing the opening so that TODAY equals the
// July count silently asserts that nothing moved in August — and for 15W40 something did, so the
// shelf read 401 at the end of July against a 163 count. The opening is sized so the balance ON
// THE COUNT DATE equals what was counted; whatever has happened since then moves it from there.
const countOf = new Map();
for (const c of all(`SELECT product_id, counted_qty, period FROM stock_counts ORDER BY period`)) {
  countOf.set(c.product_id, { qty: Number(c.counted_qty) || 0, period: c.period, upto: c.period + '-31' });
}
const byProduct = new Map();
for (const m of oilMoves) {
  // An opening this script wrote is not history — measure the gap without it, or the second run
  // would count its own answer and always conclude that nothing is wrong.
  if (m.source_table === 'stock_ledger' && oilOpeningIds.has(m.source_id)) continue;
  const pid = lubricants.resolveLubricant(m.item_name, { record: false, on: m.txn_date }).productId;
  if (!pid) continue;
  const e = byProduct.get(pid) || { net: 0, first: null };
  const cutoff = countOf.has(pid) ? countOf.get(pid).upto : null;
  // `adjust` carries its own sign now (a stock-take can write stock DOWN), so it is added as it
  // stands rather than forced positive.
  if (!cutoff || String(m.txn_date || '').slice(0, 10) <= cutoff) {
    e.net += (m.kind === 'out' ? -1 : 1) * (Number(m.qty) || 0);
  }
  if (m.txn_date && (!e.first || m.txn_date < e.first)) e.first = m.txn_date;
  byProduct.set(pid, e);
}
const oilPlan = [];
for (const [pid, v] of byProduct) {
  const p = get('SELECT code, name, unit FROM products WHERE id = ?', pid);
  const c = get(`SELECT counted_qty, period FROM stock_counts WHERE product_id = ? ORDER BY period DESC LIMIT 1`, pid);
  const counted = c ? Number(c.counted_qty) || 0 : 0;
  const opening = r3(counted - v.net);
  const existing = get(`SELECT id, qty FROM stock_ledger WHERE product_id = ? AND note LIKE ?`, pid, '%' + MARK + '%');
  if (opening <= 0) {
    if (!existing || Math.abs(existing.qty) < 0.001) continue;
    oilPlan.push({ pid, ...p, net: r3(v.net), counted, countedAt: c ? c.period : null, opening: 0, existing, on: dayBefore(v.first) });
    continue;
  }
  if (existing && Math.abs(existing.qty - opening) < 0.001) continue;   // already right
  if (!existing && v.net >= -0.001) continue;                          // nothing wrong to fix
  oilPlan.push({ pid, ...p, net: r3(v.net), counted, countedAt: c ? c.period : null, opening, existing, on: dayBefore(v.first) });
}

// ---- filters ---------------------------------------------------------------
//
// A filter fitted with no record of it ever arriving. The section deliberately starts from a
// cut-over because filter purchases were never recorded in stores, and the owner's own register
// is what opens it — but the register does not list these, or lists them at zero.
//
// There is NOTHING TO COUNT AGAINST here: no stock-take, no receipt. So the anchor is the same
// one the owner chose for an item that has never been counted — ZERO. The opening is exactly the
// shortfall and no more, which says "there was one on the shelf and it was fitted", not "there is
// one on the shelf now". It is dated ON the cut-over, which is what a cut-over means.
//
// The rows go into filter_stock (the source the rebuild reads) marked `supplier = 'opening-backfill'`,
// so they are identifiable and reversible, and are re-sized rather than duplicated on a re-run.
const MARKF = 'opening-backfill';
const filterCut = (get(`SELECT cutover FROM stock_opening WHERE section = 'filter' AND mode = 'cutover'`) || {}).cutover;
const filterBackfillIds = new Set(all(`SELECT id FROM filter_stock WHERE supplier = ?`, MARKF).map((r) => r.id));
const filPlan = [];
if (filterCut) {
  const rows = all(
    `SELECT sm.item_key,
            MAX(sm.item_name) AS nm,
            ROUND(SUM(CASE WHEN sm.source_table = 'filter_stock' AND sm.source_id IN (SELECT id FROM filter_stock WHERE supplier = '${MARKF}') THEN 0
                           WHEN sm.counts = 0 THEN 0
                           WHEN sm.kind IN ('in','opening','adjust') THEN sm.qty ELSE -sm.qty END),3) AS net
       FROM stock_moves sm WHERE sm.section = 'filter'
      GROUP BY sm.item_key`);
  for (const r of rows) {
    const existing = all(`SELECT id, part_no, qty_in_stock FROM filter_stock WHERE supplier = ?`, MARKF)
      .find((f) => require('../src/lib/stock').itemKey('filter', f.part_no, f.part_no) === r.item_key);
    const opening = r3(-r.net);
    if (opening <= 0) {
      if (!existing || Math.abs(existing.qty_in_stock) < 0.001) continue;
      filPlan.push({ ...r, opening: 0, existing, on: filterCut });
      continue;
    }
    if (existing && Math.abs(existing.qty_in_stock - opening) < 0.001) continue;
    // A readable number for the row, from the workshop's own price list where it knows one.
    const p = get(`SELECT filter_no, category FROM filter_prices WHERE filter_no_norm = ?`, r.item_key);
    filPlan.push({ ...r, opening, existing, on: filterCut, part_no: p ? p.filter_no : r.item_key, type: p ? p.category : null });
  }
}

// ---- report ----------------------------------------------------------------
console.log(`GENERAL — ${genPlan.length} items, opening ${genPlan.reduce((s, r) => s + r.opening, 0).toFixed(1)}`);
console.log('   history   counted   opening   dated        item');
for (const r of genPlan.slice(0, 10)) {
  console.log('  ' + String(r.net).padStart(8) + String(r.counted).padStart(10) + String(r.opening).padStart(10)
    + '   ' + r.on + '   ' + String(r.name).slice(0, 34));
}
if (genPlan.length > 10) console.log(`   … and ${genPlan.length - 10} more`);
if (genSkipped.length) {
  console.log(`\n   ${genSkipped.length} left alone — issues raised without a catalogue item, so there is nothing to open:`);
  for (const s of genSkipped) console.log('      ' + String(s.net).padStart(6) + '  ' + String(s.nm).slice(0, 46));
}

console.log(`\nLUBRICANTS — ${oilPlan.length} products, opening ${oilPlan.reduce((s, r) => s + r.opening, 0).toFixed(1)}`);
console.log('   history   counted   opening   dated        product');
for (const r of oilPlan) {
  console.log('  ' + String(r.net).padStart(8) + String(r.counted).padStart(10)
    + (r.countedAt ? '' : '*') + String(r.opening).padStart(r.countedAt ? 10 : 9)
    + '   ' + r.on + '   ' + r.code + ' ' + r.name + ' (' + r.unit + ')'
    + (r.existing ? `   [re-sized from ${r.existing.qty}]` : ''));
}
if (oilPlan.some((r) => !r.countedAt)) console.log('   * never physically counted — opened to zero, not to plenty');

console.log(`\nFILTERS — ${filPlan.length} part numbers, opening ${filPlan.reduce((s, r) => s + r.opening, 0)}`);
if (filPlan.length) {
  console.log('   history   opening   dated        part');
  for (const r of filPlan) {
    console.log('  ' + String(r.net).padStart(8) + String(r.opening).padStart(10) + '   ' + r.on
      + '   ' + String(r.part_no || r.item_key).padEnd(18) + String(r.type || '').slice(0, 22)
      + (r.existing ? `   [re-sized from ${r.existing.qty_in_stock}]` : ''));
  }
  console.log('   no count and no receipt to anchor to — opened to exactly the shortfall, so each reads zero, not plenty');
}

if (!APPLY) { console.log('\nDry run — nothing written.'); process.exit(0); }

tx(() => {
  for (const r of genPlan) {
    if (r.existing) {
      run(`UPDATE general_item_txns SET qty = ?, balance_after = ?, txn_date = ? WHERE id = ?`,
        r.opening, r.opening, r.on, r.existing.id);
    } else {
      run(`INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, txn_date, ref, source)
           VALUES (?, 'opening', ?, ?, ?, ?, ?)`,
      r.sid, r.opening, r.opening, r.on, 'opening balance', MARK);
    }
  }
  for (const r of oilPlan) {
    const note = `${MARK}: opened at ${r.opening} to match ${r.countedAt ? 'the ' + r.countedAt + ' count of ' + r.counted : 'a zero shelf'}`;
    if (r.existing) {
      run(`UPDATE stock_ledger SET qty = ?, balance_after = ?, txn_date = ?, note = ? WHERE id = ?`,
        r.opening, r.opening, r.on, note, r.existing.id);
    } else {
      run(`INSERT INTO stock_ledger (product_id, kind, qty, balance_after, txn_date, note)
           VALUES (?, 'opening', ?, ?, ?, ?)`, r.pid, r.opening, r.opening, r.on, note);
    }
  }
});
tx(() => {
  for (const r of filPlan) {
    if (r.existing) {
      run(`UPDATE filter_stock SET qty_in_stock = ?, updated_at = datetime('now') WHERE id = ?`, r.opening, r.existing.id);
    } else {
      run(`INSERT INTO filter_stock (filter_type, part_no, unit, qty_in_stock, supplier)
           VALUES (?, ?, 'nos', ?, ?)`, r.type || 'Filter', r.part_no || r.item_key, r.opening, MARKF);
    }
  }
});

const resized = genPlan.filter((r) => r.existing).length + oilPlan.filter((r) => r.existing).length + filPlan.filter((r) => r.existing).length;
console.log(`\nAPPLIED — ${genPlan.length} general, ${oilPlan.length} lubricant and ${filPlan.length} filter opening rows (${resized} re-sized, the rest new).`);
console.log('Next: rebuild the stock, then re-run scripts/fix_general_running_balance.js --apply');
console.log('so the Balance column reads correctly through the new rows.');
