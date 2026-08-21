'use strict';

// One delivery, one record — the rest of them.
//
// scripts/reconcile_oil_receipts.js voided 7 twins in Phase 3. It matched on product + quantity
// within 7 days, but only over the window it was looking at, and 31 pairs were left standing —
// 787 litres of oil that arrived once and is counted twice. Most are not subtle: 20 of them share
// the SAME MR NUMBER on the SAME DAY, written once in the oil ledger and once as a GRN.
//
// The rule is the owner's, already settled in Phase 3 and unchanged here:
//   KEEP THE GRN. It carries the supplier, the invoice and the price.
//   VOID THE LEDGER TWIN. stock_ledger.voided is already honoured by the rebuild.
// Nothing is deleted. Each voided row records which receipt replaced it, so it can be read back
// and reversed.
//
// MATCHED BY PRODUCT + QUANTITY + WITHIN 7 DAYS, NEVER BY NAME — a delivery booked twice rarely
// lands on the same day in both books, and the two books spell the oil differently, which is the
// whole reason it was written twice. The match is greedy and STRICTLY 1:1: a GRN can absorb only
// one ledger row. Joining them as a set instead produces a cross-product and wildly overstates
// the duplication (that mistake was made once already on this data).
//
//   node scripts/reconcile_oil_receipts_2.js            # dry run
//   node scripts/reconcile_oil_receipts_2.js --apply
//
// Afterwards: rebuild the stock, then compare against stock_counts.

const { get, all, run, tx } = require('../src/db');
const lubricants = require('../src/lib/lubricants');

const APPLY = process.argv.includes('--apply');
const WINDOW_DAYS = 7;
const day = (d) => new Date(String(d).slice(0, 10) + 'T00:00:00Z').getTime();
const apart = (a, b) => Math.abs(day(a) - day(b)) / 86400000;

// Receipts on the oil ledger that are still standing.
const ledger = all(`SELECT id, product_id, qty, txn_date, mr_no, note FROM stock_ledger
                     WHERE kind = 'receipt' AND COALESCE(voided,0) = 0 AND COALESCE(qty,0) > 0
                     ORDER BY txn_date, id`);

// Receipts on the stores side that resolve to a lubricant, judged AS AT their own delivery date.
const grn = all(`SELECT g.id, COALESCE(g.description, ml.description) AS description, g.qty,
                        g.delivery_date, g.unit_price, m.mrn_no
                   FROM grn g
                   LEFT JOIN mrn_lines ml ON ml.id = g.mrn_line_id
                   LEFT JOIN mrn m ON m.id = ml.mrn_id
                  WHERE COALESCE(g.qty,0) > 0 AND NULLIF(g.delivery_date,'') IS NOT NULL`)
  .map((g) => ({ ...g, product_id: lubricants.resolveLubricant(g.description, { record: false, on: g.delivery_date }).productId }))
  .filter((g) => g.product_id);

// THE PAPERWORK NUMBER IS NOT A TIE-BREAK, IT IS THE RULE. Scoring it as a preference and
// falling back to "nearest delivery of the same size" quietly pairs the wrong records: ledger
// #7270 (MR 167431) has its twin in GRN #6209, MRN 167431, same day, same 200 L — but that GRN
// is spelt "HD-68 Hy/ Oil", which the oil book does not recognise (note the stray space), so it
// was invisible to the match and the row paired instead with GRN #5984, a GENUINELY SEPARATE
// delivery a week earlier. The litres would have come out the same and the audit trail would
// have been a lie. So: if the ledger row carries an MR number, only that MRN can be its twin.
// Where it carries none — most of the kerosene run — product + exact quantity + the same window
// still stands, because there is nothing better to go on.
const taken = new Set();
const pairs = [];
const unmatchedWithRef = [];
for (const l of ledger) {
  const ref = String(l.mr_no || '').trim();
  let best = null;
  for (const g of grn) {
    if (taken.has(g.id) || g.product_id !== l.product_id) continue;
    if (Math.abs((g.qty || 0) - (l.qty || 0)) > 0.001) continue;
    const gref = String(g.mrn_no || '').trim();
    if (ref) {
      if (gref !== ref) continue;                     // a number on the paper is not a hint
      best = { g, d: apart(g.delivery_date, l.txn_date), sameRef: true };
      break;
    }
    const d = apart(g.delivery_date, l.txn_date);
    if (d > WINDOW_DAYS) continue;
    if (!best || d < best.d) best = { g, d, sameRef: false };
  }
  if (best) { taken.add(best.g.id); pairs.push({ l, ...best }); }
  else if (ref) unmatchedWithRef.push(l);
}

const units = pairs.reduce((s, p) => s + (p.l.qty || 0), 0);
const sameRef = pairs.filter((p) => p.sameRef).length;
console.log(`OIL RECEIPTS WRITTEN TWICE — ${pairs.length} pairs, ${Math.round(units * 100) / 100} units`);
console.log(`   ${sameRef} of them carry the SAME paperwork number on both sides — not in doubt.`);
console.log();
console.log('   product        qty   ledger                       GRN                          gap');
for (const p of pairs) {
  const pr = get('SELECT code, name FROM products WHERE id = ?', p.l.product_id);
  console.log('   ' + String(pr.code).padEnd(10) + String(p.l.qty).padStart(8)
    + '   #' + String(p.l.id).padEnd(6) + String(p.l.txn_date).slice(0, 10) + ' MR ' + String(p.l.mr_no || '-').padEnd(9)
    + '   #' + String(p.g.id).padEnd(6) + String(p.g.delivery_date).slice(0, 10) + ' MRN ' + String(p.g.mrn_no || '-').padEnd(9)
    + '  ' + String(p.d) + 'd' + (p.sameRef ? '  ✓same ref' : ''));
}

if (unmatchedWithRef.length) {
  console.log(`\n   ${unmatchedWithRef.length} ledger receipts carry an MR number with no matching GRN — LEFT ALONE, not guessed.`);
  console.log('   (Usually the stores side spells the oil in a way the book does not yet recognise.)');
  for (const l of unmatchedWithRef.slice(0, 12)) {
    const pr = get('SELECT code, name FROM products WHERE id = ?', l.product_id);
    console.log(`      #${String(l.id).padEnd(6)}${String(l.txn_date).slice(0, 10)}  MR ${String(l.mr_no).padEnd(9)}${String(l.qty).padStart(8)}  ${pr ? pr.code + ' ' + pr.name : ''}`);
  }
  if (unmatchedWithRef.length > 12) console.log(`      … and ${unmatchedWithRef.length - 12} more`);
}

// What it is worth: the balance each product carries now, and what it would carry after.
console.log('\nEffect by product:');
const byProduct = new Map();
for (const p of pairs) byProduct.set(p.l.product_id, (byProduct.get(p.l.product_id) || 0) + (p.l.qty || 0));
for (const [pid, q] of [...byProduct].sort((a, b) => b[1] - a[1])) {
  const pr = get('SELECT code, name FROM products WHERE id = ?', pid);
  const c = get(`SELECT counted_qty FROM stock_counts WHERE product_id = ? ORDER BY period DESC LIMIT 1`, pid);
  console.log('   ' + String(pr.code).padEnd(10) + String(pr.name).slice(0, 26).padEnd(28)
    + 'removing ' + String(Math.round(q * 100) / 100).padStart(8)
    + (c ? '   (last counted ' + c.counted_qty + ')' : ''));
}

if (!APPLY) { console.log('\nDry run — nothing written.'); process.exit(0); }

tx(() => {
  for (const p of pairs) {
    run(`UPDATE stock_ledger
            SET voided = 1,
                note = TRIM(COALESCE(note,'') || ' | voided ' || ? || ': the same delivery is recorded as GRN #' || ?
                            || ' (' || ? || ', ' || ? || '), which carries the supplier and the price')
          WHERE id = ?`,
    new Date().toISOString().slice(0, 10), p.g.id, String(p.g.qty), String(p.g.delivery_date).slice(0, 10), p.l.id);
  }
});
console.log(`\nAPPLIED — ${pairs.length} duplicate ledger receipts voided, ${Math.round(units * 100) / 100} units.`);
console.log('Nothing was deleted; each row says which receipt replaced it.');
console.log('Next: rebuild the stock, then compare the oil balance against stock_counts.');
