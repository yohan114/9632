'use strict';

// Phase 3 — one record per delivery.
//
// A drum of oil bought through stores was written down twice: once as a GRN (with the supplier,
// the invoice and the price) and once as a top-up in the oil book's own ledger. Nothing has gone
// wrong in the balance so far only because EVERY stores receipt of oil was muted wholesale —
// which also hid 17 genuine deliveries the oil ledger never knew about.
//
// This pairs them up properly, by PRODUCT rather than by spelling, so "HD-68 Oil" on a receipt
// and "HD 68 Oil (Valvoline)" in the ledger are recognised as the same delivery.
//
// The GRN is kept as the record of the delivery — it carries the supplier, invoice number and
// price, and the ledger row carries none of that. The ledger twin is VOIDED, using the oil
// book's own `voided` column, which the stock rebuild already honours. Nothing is deleted: the
// row stays, marked and dated, with a note saying which receipt superseded it.
//
// Matching rule: same product, same quantity, within 7 days, paired one-to-one nearest-first.
// A delivery booked twice rarely lands on the identical day in both books — the Grease of
// 2026-07-15 is the 2026-07-14 ledger row, and the four HD-68 drums line up 4-to-4 across a
// few days. Anything that cannot be paired is left alone and reported.
//
//   node scripts/reconcile_oil_receipts.js            # dry run
//   node scripts/reconcile_oil_receipts.js --apply

const { get, all, run, tx } = require('../src/db');
const lubricants = require('../src/lib/lubricants');

const APPLY = process.argv.includes('--apply');
const WINDOW_DAYS = 7;

const productOf = (name, date) => lubricants.resolveLubricant(name, { record: false, on: date }).productId || null;
const daysApart = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);

// The stores receipts of oil, and the oil ledger's own receipts, straight from stock_moves so
// both have already been through the same section and identity rules.
const receipts = all(
  `SELECT sm.id, sm.source_id AS grn_id, sm.item_name, sm.qty, sm.txn_date, sm.ref
     FROM stock_moves sm
    WHERE sm.section = 'oil' AND sm.source_table = 'grn' AND sm.kind = 'in'
    ORDER BY sm.txn_date, sm.id`);
const ledger = all(
  `SELECT sm.id, sm.source_id AS ledger_id, sm.item_name, sm.qty, sm.txn_date
     FROM stock_moves sm
     JOIN stock_ledger sl ON sl.id = sm.source_id
    WHERE sm.section = 'oil' AND sm.source_table = 'stock_ledger' AND sm.kind = 'in'
      AND COALESCE(sl.voided, 0) = 0
    ORDER BY sm.txn_date, sm.id`);

const taken = new Set();
const pairs = []; const genuine = []; const notLube = [];

for (const r of receipts) {
  const pid = productOf(r.item_name, r.txn_date);
  if (!pid) { notLube.push(r); continue; }
  const twin = ledger
    .filter((l) => !taken.has(l.ledger_id)
      && productOf(l.item_name, l.txn_date) === pid
      && Math.abs(l.qty - r.qty) < 0.001
      && daysApart(l.txn_date, r.txn_date) <= WINDOW_DAYS)
    .sort((a, b) => daysApart(a.txn_date, r.txn_date) - daysApart(b.txn_date, r.txn_date))[0];
  if (twin) { taken.add(twin.ledger_id); pairs.push({ r, twin, pid }); } else genuine.push({ r, pid });
}

console.log(`stores receipts of oil: ${receipts.length}\n`);
console.log(`DUPLICATES — the same delivery in both books (${pairs.length}):`);
console.log('   receipt date   qty    product                        ledger twin');
for (const p of pairs) {
  const prod = get('SELECT code, name FROM products WHERE id = ?', p.pid);
  console.log(`   ${p.r.txn_date}  ${String(p.r.qty).padStart(6)}   ${(prod.code + ' ' + prod.name).padEnd(30)} `
    + `${p.twin.txn_date} (ledger #${p.twin.ledger_id})`);
}
console.log(`\nGENUINE — stores deliveries the oil ledger never had (${genuine.length}, `
  + `${genuine.reduce((s, g) => s + g.r.qty, 0).toFixed(1)} units):`);
for (const g of genuine.slice(0, 8)) {
  const prod = get('SELECT code FROM products WHERE id = ?', g.pid);
  console.log(`   ${g.r.txn_date}  ${String(g.r.qty).padStart(6)}   ${prod.code}  ${g.r.item_name}`);
}
if (genuine.length > 8) console.log(`   … and ${genuine.length - 8} more`);
console.log(`\nNOT LUBRICANTS — out either way (${notLube.length}, ${notLube.reduce((s, n) => s + n.qty, 0).toFixed(1)} units)`);

console.log(`\nAfter this, and once the blanket mute on oil receipts is lifted:`);
console.log(`   +${genuine.reduce((s, g) => s + g.r.qty, 0).toFixed(1)} units enter the balance (the genuine deliveries)`);
console.log(`   ${pairs.length} ledger row(s) voided, ${pairs.length} receipt(s) counted in their place — no net change from those`);

if (!APPLY) { console.log('\nDry run — nothing written.'); process.exit(0); }

tx(() => {
  for (const p of pairs) {
    const note = `Voided ${new Date().toISOString().slice(0, 10)}: the same delivery is recorded as `
      + `stores receipt ${p.r.ref || 'GRN #' + p.r.grn_id} on ${p.r.txn_date}, which carries the supplier and price.`;
    run(`UPDATE stock_ledger SET voided = 1, note = TRIM(COALESCE(note,'') || ' | ' || ?) WHERE id = ?`,
      note, p.twin.ledger_id);
  }
});
console.log(`\nAPPLIED — ${pairs.length} ledger row(s) voided. Nothing deleted; each says which receipt replaced it.`);
console.log('Now lift the blanket mute in src/lib/stock.js and rebuild the stock.');
