'use strict';

// Settle the names that are not fluids at all.
//
// The workshop files Grease Gun, Oil Pump, Brake Oil Tank, half a dozen oil seals and even
// repair notes ("Fuel Feed Pump repair (Oil leak)") under "Lubricants & Fluids". They keep that
// category — nothing is recategorised — but they are marked as decided: NOT a lubricant, so
// they stop counting as litres on the shelf and stop coming back onto the list to identify.
//
// Each name is listed here in full rather than matched on a word like "seal" or "gun": a rule
// would also catch "Seal Kit" grease or a future product with "gun" in its name, and this file
// is the record of what was ruled out and why.
//
//   node scripts/rule_out_non_lubricants.js            # dry run
//   node scripts/rule_out_non_lubricants.js --apply

const { get, run, tx } = require('../src/db');
const lubricants = require('../src/lib/lubricants');

const APPLY = process.argv.includes('--apply');

const NOT_LUBRICANTS = [
  // pumps and guns — equipment that moves fluid, not the fluid
  'Oil pump', 'E/oil pump', 'Oil Spray Gun', 'Grease Gun', 'Grease Gun (500g)', 'Hand Grease Gun',
  // fittings
  'Grease Nozzle', 'Grease Nipple',
  // tanks and caps
  'Brake Oil Tank', '4. Clutch Oil tank',
  // filter elements. "0-579 Oil VIC" and "0-609 Oil VIC" are OIL FILTERS, not oils: filter_stock
  // carries part_no "O-579" as an Oil Filter, the catalogue has "O-581VICO-579J" under
  // "oil Filter", and both were created in one batch on 2026-06-03 whose siblings — C-206 Oil
  // Filter VIC, C-502, C-101, F-507 Fuel Filter VIC — are all filed as Filters. The letter O was
  // typed as a zero and the word "Filter" dropped.
  'Air Oil Seperator Element (16349003601)', '0-579 Oil VIC', '0-609 Oil VIC',
  // seals — counted in nos, and every one of these was being deducted from the oil balance
  'Front Crank Oil Seal', 'Hub Oil Seal', 'Oil Seal Large', 'Oil Seal (small)',
  'Oil Seal (Top & main shaft)', 'Gear Box Top Shaft Oil Seal',
  // materials and job descriptions that are not stock at all
  'Mack Foil For AC Repair (Ft)', 'Fuel Feed Pump repair (Oil leak)', 'Power steering rack oil leak',
];

const rows = [];
for (const name of NOT_LUBRICANTS) {
  const key = lubricants.normLube(name);
  const alias = get('SELECT * FROM lubricant_aliases WHERE raw_norm = ?', key);
  const m = get(
    `SELECT COUNT(*) n, SUM(counts) counting,
            ROUND(SUM(CASE WHEN kind IN ('in','opening','adjust') THEN qty ELSE -qty END),1) net
       FROM stock_moves WHERE section = 'oil' AND item_name IS NOT NULL`);
  rows.push({ name, key, alias, m });
}

// Per-name figures, through the same identity the alias uses.
const { all } = require('../src/db');
const moves = all(`SELECT item_name, kind, qty, counts FROM stock_moves WHERE section = 'oil' AND item_name IS NOT NULL`);
const tally = new Map();
for (const mv of moves) {
  const k = lubricants.normLube(mv.item_name);
  const e = tally.get(k) || { n: 0, net: 0, counting: 0 };
  e.n++; e.net += (mv.kind === 'out' ? -1 : 1) * (Number(mv.qty) || 0); if (mv.counts) e.counting++;
  tally.set(k, e);
}

console.log('  moves  counting     net   name');
let missing = 0; let stops = 0;
for (const r of rows) {
  const t = tally.get(r.key) || { n: 0, net: 0, counting: 0 };
  stops += t.counting;
  if (!r.alias) missing++;
  console.log('  ' + String(t.n).padStart(5) + String(t.counting).padStart(10)
    + String(t.net.toFixed(1)).padStart(8) + '   ' + r.name + (r.alias ? '' : '   ⚠ no such name on record'));
}
console.log(`\n${rows.length} names · ${stops} movement(s) stop counting as oil stock`);
if (missing) console.log(`${missing} name(s) not found — check the spelling against the queue.`);

if (!APPLY) { console.log('\nDry run — nothing written.'); process.exit(0); }

tx(() => {
  for (const r of rows) {
    if (!r.alias) continue;
    lubricants.setAlias(r.alias.id, null, 'owner');    // decided: not a lubricant
  }
});
console.log(`\nAPPLIED. Queue now: ${get('SELECT COUNT(*) c FROM lubricant_aliases WHERE resolved = 0').c} name(s) left.`);
console.log(`Ruled out: ${get('SELECT COUNT(*) c FROM lubricant_aliases WHERE resolved = 1 AND product_id IS NULL').c}.`);
console.log('No category changed and no balance moved — that happens on the stock rebuild.');
