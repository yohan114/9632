'use strict';

// Put a running balance back on the general-item ledger.
//
//   node scripts/fix_general_running_balance.js          (dry run, default)
//   node scripts/fix_general_running_balance.js --apply
//
// Opening an item in General Stock shows its movements with a Balance column, read straight
// from general_item_txns.balance_after. 2061 of the 2821 rows carry a literal 0 — every row
// the rack-sheet and warehouse imports wrote — so the ledger reads as though nothing is ever
// in stock, however much the item actually holds.
//
// The balance is recomputed per item, in date order, ending on the item's CURRENT balance and
// working backwards. Going forwards from zero would not do: general_item_txns still holds the
// same physical issue twice for May–June (once from the inventory.db import, once from the
// warehouse CSV), so a forward sum lands nowhere near the shelf. Anchoring on the balance the
// storekeeper counted keeps the last row honest and every earlier row consistent with it.

const { all, get, run, tx } = require('../src/db');

const APPLY = process.argv.includes('--apply');

const items = all(`
  SELECT si.id, si.name, si.balance,
         (SELECT COUNT(*) FROM general_item_txns t WHERE t.store_item_id = si.id) AS n,
         (SELECT COUNT(*) FROM general_item_txns t WHERE t.store_item_id = si.id AND t.balance_after = 0) AS zeros
    FROM store_items si
   WHERE si.is_general = 1
     AND EXISTS (SELECT 1 FROM general_item_txns t WHERE t.store_item_id = si.id)`);

let touched = 0; let rows = 0;
const plan = [];
for (const it of items) {
  const led = all(
    `SELECT id, qty, balance_after FROM general_item_txns
      WHERE store_item_id = ? ORDER BY date(txn_date), id`, it.id);
  if (!led.length) continue;
  // Walk backwards from what the shelf holds now.
  let running = Number(it.balance) || 0;
  const want = new Array(led.length);
  for (let i = led.length - 1; i >= 0; i--) {
    want[i] = Math.round(running * 100) / 100;
    running -= Number(led[i].qty) || 0;
  }
  const changes = [];
  led.forEach((l, i) => { if (Number(l.balance_after) !== want[i]) changes.push({ id: l.id, to: want[i] }); });
  if (!changes.length) continue;
  touched++; rows += changes.length;
  plan.push({ id: it.id, name: it.name, balance: it.balance, n: led.length, changes });
}

console.log(`general items with a ledger : ${items.length}`);
console.log(`items whose running balance is wrong: ${touched}`);
console.log(`ledger rows to correct              : ${rows}`);
console.log();
plan.slice(0, 12).forEach((p) => console.log(`   ${String(p.name).padEnd(28)} ${String(p.n).padStart(4)} rows, ends at ${p.balance}`));
if (plan.length > 12) console.log(`   … and ${plan.length - 12} more`);

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

const out = tx(() => {
  let n = 0;
  for (const p of plan) for (const c of p.changes) { run('UPDATE general_item_txns SET balance_after = ? WHERE id = ?', c.to, c.id); n++; }
  return n;
});

// The last row of every item must now read the item's own balance, or the ledger and the
// stock figure would still disagree on screen.
const bad = all(`
  SELECT si.id, si.name, si.balance, (
    SELECT t.balance_after FROM general_item_txns t
     WHERE t.store_item_id = si.id ORDER BY date(t.txn_date) DESC, t.id DESC LIMIT 1) AS last_bal
    FROM store_items si WHERE si.is_general = 1
     AND EXISTS (SELECT 1 FROM general_item_txns t WHERE t.store_item_id = si.id)`)
  .filter((r) => Math.abs((Number(r.last_bal) || 0) - (Number(r.balance) || 0)) > 0.005);

console.log(`\nCorrected ${out} ledger row(s) across ${plan.length} item(s).`);
console.log(bad.length
  ? `${bad.length} item(s) still end on the wrong balance — REVIEW: ${bad.slice(0, 5).map((b) => b.name).join(', ')}`
  : 'Every item\'s last ledger row now reads its stock balance.');
