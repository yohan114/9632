'use strict';

// Add the four fluids the workshop stocks that the oil book never had a product for.
//
// WD-40, Rubber Grease, Brake Oil and Coolant are bought and issued constantly — 123 movements
// between them — but none had a catalogue entry, so every one of those movements resolved to
// nothing and sat outside the lubricant balance.
//
// TWO THINGS ABOUT THESE FOUR THAT THE REST OF THE BOOK DOES NOT SHARE:
//
//  * They are counted in CONTAINERS, not litres. Every record says nos or Pcs — cans of WD-40,
//    tubes of grease, bottles of brake oil. The other 22 products are bulk drums in L or kg.
//    So they are created with unit 'nos'; adding them as litres would silently add tins to a
//    litre balance.
//  * The workshop buys brake oil in 250ml, 350ml, 500ml and 1L, all counted as "1". Those pack
//    sizes are recorded under their OWN names in the general store and keep counting there.
//    This script does NOT pull them in — one product per name the owner asked for, nothing
//    merged behind their back.
//
// A product also needs its row in the unified catalogue (stock_items). Without it the next code
// minted for the oil section would be OIL-0023 again, because nextCode() counts from there.
//
// Names are given as  Name[:category[:unit]]  — category defaults to 'other', unit to 'nos',
// because everything reaching this script so far has been sold in containers rather than drums.
//
//   node scripts/add_lubricant_products.js "CV Grease:grease"          # dry run
//   node scripts/add_lubricant_products.js "CV Grease:grease" --apply
//
// A name that already has a product is reported and skipped, so re-running is safe.

const { get, all, run, tx } = require('../src/db');
const lubricants = require('../src/lib/lubricants');

const APPLY = process.argv.includes('--apply');

const WANTED = process.argv.slice(2)
  .filter((a) => !a.startsWith('--'))
  .map((spec) => {
    const [name, category, unit] = spec.split(':');
    return { name: String(name).trim(), category: (category || 'other').trim(), unit: (unit || 'nos').trim() };
  })
  .filter((w) => w.name);

if (!WANTED.length) {
  console.log('Give one or more names:  node scripts/add_lubricant_products.js "CV Grease:grease" [--apply]');
  process.exit(1);
}

const nextCode = () => {
  const rows = all(`SELECT code FROM stock_items WHERE section = 'oil' AND code LIKE 'OIL-%'`)
    .concat(all(`SELECT code FROM products WHERE code LIKE 'OIL-%'`));
  const n = rows.reduce((m, r) => Math.max(m, parseInt(String(r.code).split('-').pop(), 10) || 0), 0);
  return (i) => 'OIL-' + String(n + 1 + i).padStart(4, '0');
};
const codeAt = nextCode();

console.log('  code       unit   category      name                 movements waiting');
const plan = [];
WANTED.forEach((w, i) => {
  const existing = get('SELECT id, code FROM products WHERE UPPER(name) = UPPER(?)', w.name);
  const key = lubricants.normLube(w.name);
  const waiting = all(
    `SELECT item_name, kind, qty FROM stock_moves WHERE section = 'oil'`)
    .filter((m) => lubricants.normLube(m.item_name) === key).length;
  const code = existing ? existing.code : codeAt(i);
  plan.push({ ...w, code, existing, key, waiting });
  console.log('  ' + code.padEnd(11) + w.unit.padEnd(7) + w.category.padEnd(14)
    + w.name.padEnd(21) + String(waiting).padStart(9) + (existing ? '   (already exists)' : ''));
});

console.log(`\nEach becomes a lubricant in its own right; the pack-size spellings in the general store`);
console.log(`(Brake oil 250ml, Break Oil 1L, WD-40 150ml, Radiator coolant …) are left exactly as they are.`);

if (!APPLY) { console.log('\nDry run — nothing written.'); process.exit(0); }

tx(() => {
  for (const p of plan) {
    if (p.existing) continue;
    const pid = run(
      `INSERT INTO products (code, name, unit, category, reorder_level, active) VALUES (?, ?, ?, ?, 0, 1)`,
      p.code, p.name, p.unit, p.category).lastInsertRowid;
    // The unified catalogue entry, so the two books agree and the code sequence stays honest.
    run(`INSERT INTO stock_items (code, section, name, item_key, unit, source_table, source_id, active)
         VALUES (?, 'oil', ?, ?, ?, 'products', ?, 1)`,
    p.code, p.name, p.name.toUpperCase().replace(/\([^)]*\)/g, ' ').replace(/[^A-Z0-9]/g, ''), p.unit, pid);
    p.id = pid;
  }
  // Each new product answers to its own name.
  lubricants.seedCatalogueAliases();
  // …and the queued spelling now points at it. Only the exact names asked for — "Radiator
  // Coolant" and "Break Oil DOT-5" stay in the queue, because whether they are the same thing
  // is the owner's call, not this script's.
  for (const p of plan) {
    const pid = p.id || (p.existing && p.existing.id);
    const alias = get('SELECT id FROM lubricant_aliases WHERE raw_norm = ?', p.key);
    if (alias && pid) lubricants.setAlias(alias.id, pid, 'owner');
  }
});

console.log('\nAPPLIED.');
for (const p of plan) {
  const r = lubricants.resolveLubricant(p.name, { record: false });
  console.log('  ' + p.name.padEnd(16) + '-> ' + (r.resolved ? r.product.code + ' ' + r.product.name : 'STILL UNRESOLVED'));
}
console.log(`\nqueue now: ${get('SELECT COUNT(*) c FROM lubricant_aliases WHERE resolved = 0').c} name(s) left to identify`);
console.log('No movement or balance was touched — that happens on the stock rebuild.');
