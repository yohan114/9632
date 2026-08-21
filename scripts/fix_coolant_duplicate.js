'use strict';

// One coolant delivery, written into two books.
//
//   node scripts/fix_coolant_duplicate.js          (dry run, default)
//   node scripts/fix_coolant_duplicate.js --apply
//
// MR 140621 delivered 24 L of coolant. It was written up on the Rack 5E sheet on 2026-07-16
// and then AGAIN on the Car Wash & Others sheet on 2026-07-18 under the same MR number, where
// it was issued from and topped up (+40 on MR 140622), closing at 43. The 5E sheet has had no
// movement since. The register therefore carried both — 24 on rack 5E and 43 at the wash bay,
// 67 L for one delivery of 24 plus 40.
//
// The owner confirmed on 2026-08-17 that this is one delivery written twice. The stock lives
// at the wash bay, so the rack 5E holding is written down to nothing with an adjustment that
// says why, rather than deleting the row and losing the trail. This is the same pattern the
// storekeeper used for Hand Gloves — an item re-opened in a new book carrying its original
// MR numbers.

const { get, run, tx } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const DEAD = 1576;    // "Coolant", rack 5E — the abandoned sheet
const LIVE = 2031;    // "Coolanat", Car Wash — the maintained one

const dead = get('SELECT id, name, rack, balance FROM store_items WHERE id = ?', DEAD);
const live = get('SELECT id, name, rack, balance FROM store_items WHERE id = ?', LIVE);
if (!dead || !live) { console.log('Coolant rows not found — nothing to do.'); process.exit(0); }

console.log('coolant, one delivery held as two rows:');
console.log(`  abandoned : id ${dead.id} "${dead.name}" rack ${dead.rack} balance ${dead.balance}`);
console.log(`  live      : id ${live.id} "${live.name}" rack ${live.rack} balance ${live.balance}`);
console.log(`  on hand now: ${(dead.balance || 0) + (live.balance || 0)} → would become ${live.balance}`);

if (!Number(dead.balance)) { console.log('\nAlready written down — nothing to do.'); process.exit(0); }
if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

tx(() => {
  run(`INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, ref, txn_date, source)
       VALUES (?, 'adjustment', ?, 0, ?, date('now'), 'racksheet')`,
    DEAD, -Number(dead.balance), 'MR 140621 re-opened in the Car Wash book');
  run('UPDATE store_items SET balance = 0 WHERE id = ?', DEAD);
});

console.log(`\nWrote rack ${dead.rack} down to 0. Coolant on hand: ${live.balance} at ${live.rack}.`);
