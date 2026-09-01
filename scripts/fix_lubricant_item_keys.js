'use strict';

// Give every lubricant ONE row again.
//
// A lubricant is identified by its product in the oil book. The catalogue sync already intends
// that — it keys an oil item by `p.code || p.name` — but the 30 lubricant rows in stock_items were
// created back when products.code was still NULL for every one of them, so they all fell back to
// the NAME form: 15W40VALVOLINE, HD68HYOILCALTEX, HD68OIL. Not one of the 30 carries the code form.
//
// Two things go wrong because of that, and this script fixes the cause of both:
//
//   1. NEGATIVE BALANCES THAT ARE NOT REAL. The oil ledger keys its movements by the product CODE
//      (itemKey('oil', name, 'OIL-0021') -> OIL0021); every other door — GRN, issues, MRN, general
//      — keys by the written NAME. So one product's receipts and issues land in different rows.
//      HD 68 Oil read -573 under OIL0021 while 1,000 L of the same oil sat under HD68OIL and
//      HD68OILVALVOLINE. Nothing was missing; the shelf was being counted in three pieces.
//
//   2. A DUPLICATE CATALOGUE, waiting to happen. syncCatalogue() looks an item up by the key it
//      would mint today (the code form), does not find it, and inserts a NEW row with a NEW code.
//      Run it as things stand and all 30 lubricants are duplicated.
//
// The code form is used rather than the name form because itemKey() strips brackets and the brand
// lives in the bracket: "HD 68 Oil (Servo)" and "HD 68 Oil (Valvoline)" both flatten to HD68OIL,
// and the workshop buys them separately. A code cannot collide.
//
// Nothing is invented and no movement is touched. This renames a catalogue key; stock_moves is a
// projection and is regenerated from the source tables by the rebuild that follows.
//
//   node scripts/fix_lubricant_item_keys.js            # dry run
//   node scripts/fix_lubricant_item_keys.js --apply
//
// Afterwards: rebuild the stock (POST /stores/stock/rebuild) so the movements re-key too.

const { get, all, run, tx } = require('../src/db');
const stock = require('../src/lib/stock');

const APPLY = process.argv.includes('--apply');

const plan = [];
const already = [];
const collisions = [];
const orphans = [];

for (const p of all('SELECT id, code, name FROM products ORDER BY code, id')) {
  if (!p.code) { orphans.push({ ...p, why: 'the product has no code — nothing to key it by' }); continue; }
  const want = stock.itemKey('oil', p.name, p.code);

  // The catalogue row for this product: linked by source, falling back to whatever currently
  // carries the name form (older rows predate the source link).
  const row = get("SELECT id, code, name, item_key FROM stock_items WHERE section = 'oil' AND source_table = 'products' AND source_id = ?", p.id)
    || get("SELECT id, code, name, item_key FROM stock_items WHERE section = 'oil' AND item_key = ?", stock.itemKey('oil', p.name));

  if (!row) { orphans.push({ ...p, why: 'no catalogue row found for this product' }); continue; }
  if (row.item_key === want) { already.push({ ...p, key: want }); continue; }

  const clash = get("SELECT id, code, name FROM stock_items WHERE section = 'oil' AND item_key = ? AND id <> ?", want, row.id);
  if (clash) { collisions.push({ product: p, row, want, clash }); continue; }

  plan.push({ product: p, row, from: row.item_key, to: want });
}

console.log(`LUBRICANT CATALOGUE KEYS — ${plan.length} to re-key, ${already.length} already correct`);
if (plan.length) {
  console.log('   product     from                      to             name');
  for (const x of plan) {
    console.log('   ' + String(x.product.code).padEnd(11) + String(x.from).slice(0, 24).padEnd(26)
      + String(x.to).padEnd(15) + String(x.product.name).slice(0, 34));
  }
}

if (collisions.length) {
  console.log(`\n   ${collisions.length} NOT re-keyed — the target key is already taken, so re-keying would merge two catalogue items:`);
  for (const c of collisions) console.log(`      ${c.product.code} ${c.product.name} -> ${c.want} is held by ${c.clash.code} ${c.clash.name}`);
}
if (orphans.length) {
  console.log(`\n   ${orphans.length} left alone:`);
  for (const o of orphans) console.log(`      ${o.code || '(no code)'} ${o.name} — ${o.why}`);
}

// What the re-key is worth: how many movement rows currently sit under a name form that will
// collapse onto the product once the rebuild runs.
if (plan.length) {
  console.log('\nMovements that will join their product after the next rebuild:');
  for (const x of plan) {
    const n = get("SELECT COUNT(*) c, ROUND(SUM(CASE WHEN kind IN ('in','opening','adjust') THEN qty ELSE -qty END),2) net FROM stock_moves WHERE section = 'oil' AND item_key = ?", x.from);
    const t = get("SELECT COUNT(*) c, ROUND(SUM(CASE WHEN kind IN ('in','opening','adjust') THEN qty ELSE -qty END),2) net FROM stock_moves WHERE section = 'oil' AND item_key = ?", x.to);
    if ((n.c || 0) + (t.c || 0) === 0) continue;
    console.log(`   ${String(x.product.code).padEnd(10)} ${String(x.product.name).slice(0, 28).padEnd(30)} ${String(x.from).padEnd(22)} ${String(n.c || 0).padStart(4)} mv / ${String(n.net == null ? 0 : n.net).padStart(9)}   +   ${String(x.to).padEnd(10)} ${String(t.c || 0).padStart(4)} mv / ${String(t.net == null ? 0 : t.net).padStart(9)}`);
  }
}

if (!APPLY) { console.log('\nDry run — nothing written.'); process.exit(0); }

tx(() => {
  for (const x of plan) run('UPDATE stock_items SET item_key = ? WHERE id = ?', x.to, x.row.id);
});
console.log(`\nAPPLIED — ${plan.length} lubricant catalogue rows re-keyed to their product code.`);
console.log('Next: rebuild the stock (POST /stores/stock/rebuild) so the movements re-key too.');
