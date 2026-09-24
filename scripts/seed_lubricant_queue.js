'use strict';

// Put every lubricant name already on record in front of the owner — without moving a figure.
//
// The unknown-name queue normally fills as stock is rebuilt, but a rebuild is also what applies
// the new "a lubricant is what the oil book knows" rule, and that changes the balance. Doing it
// in that order would ask the owner to approve a number that only looks wrong because the names
// have not been identified yet. So this reads what is already in the oil section, records the
// names nobody has matched, and touches nothing else — the balance is identical afterwards.
//
//   node scripts/seed_lubricant_queue.js            # dry run
//   node scripts/seed_lubricant_queue.js --apply

const { get, all, run } = require('../src/db');
const lubricants = require('../src/lib/lubricants');

const APPLY = process.argv.includes('--apply');

// Group by the SAME identity the alias table uses, not by stock_moves.item_key. The two
// disagree on purpose: item_key strips brackets, so "HD 68 Oil (Valvoline)" and a bare
// "HD-68 Oil" share one key — and grouping that way credited an unidentified name with 49
// movements and 1,000 units that in fact belong to a product already identified.
const byIdentity = new Map();
for (const m of all(
  `SELECT item_name, kind, qty, counts, txn_date FROM stock_moves
    WHERE section = 'oil' AND item_name IS NOT NULL AND TRIM(item_name) <> ''`)) {
  const key = lubricants.normLube(m.item_name);
  if (!key) continue;
  const e = byIdentity.get(key)
    || { key, name: lubricants.displayName(m.item_name), moves: 0, net: 0, counting: 0, first: null, last: null };
  e.moves++;
  e.net += (m.kind === 'out' ? -1 : 1) * (Number(m.qty) || 0);
  if (m.counts) e.counting++;
  if (m.txn_date && (!e.first || m.txn_date < e.first)) e.first = m.txn_date;
  if (m.txn_date && (!e.last || m.txn_date > e.last)) e.last = m.txn_date;
  byIdentity.set(key, e);
}

const all_ = [...byIdentity.values()];
const known = all_.filter((e) => lubricants.resolveLubricant(e.name, { record: false }).resolved);
const queue = all_.filter((e) => !lubricants.resolveLubricant(e.name, { record: false }).resolved)
  .sort((a, b) => b.moves - a.moves);

console.log(`oil-section names on record : ${all_.length}`);
console.log(`  already match a product   : ${known.length}`);
console.log(`  need identifying          : ${queue.length}\n`);
console.log('  movements   net qty   counting   first        last         name');
for (const q of queue) {
  console.log('  ' + String(q.moves).padStart(9) + String(q.net.toFixed(1)).padStart(10)
    + String(q.counting).padStart(11) + '   ' + String(q.first || '—').padEnd(13)
    + String(q.last || '—').padEnd(13) + q.name);
}

const atRisk = queue.filter((q) => q.counting > 0);
console.log(`\n${atRisk.length} of these currently count toward the oil balance and would stop `
  + `once the rule is applied (net ${atRisk.reduce((s, q) => s + q.net, 0).toFixed(1)}).`);

if (APPLY) {
  let added = 0;
  for (const q of queue) {
    if (get('SELECT id FROM lubricant_aliases WHERE raw_norm = ?', q.key)) continue;
    run(`INSERT INTO lubricant_aliases (raw_text, raw_norm, product_id, resolved, hit_count, source)
         VALUES (?, ?, NULL, 0, ?, 'stock-scan')`, q.name, q.key, q.moves);
    added++;
  }
  console.log(`\nAPPLIED — ${added} name(s) queued. No movement, balance or category was touched.`);
} else {
  console.log('\nDry run — nothing written.');
}
