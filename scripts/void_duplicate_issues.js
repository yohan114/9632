'use strict';

// One handover, one deduction.
//
// A handover got written down twice, in two different ways:
//
//   A. THE TRACKER WROTE THE ROW TWICE. Two identical lines in sources/stores/issues.csv —
//      same item, same day, same quantity, same vehicle, same person issuing, same recipient.
//      Both came in on the same import run, so they are the same handover keyed twice, not the
//      storekeeper handing out two of something.
//
//   B. IT WAS RECORDED IN BOTH BOOKS. The storekeeper noted the handover free-hand in the
//      tracker (imported 2026-07-16), and later the same handover was issued again through
//      Stores against the receipt it came from (entered 2026-08-14/15). One handover, two rows.
//
// THE FREE-HAND ROW IS MUTED, NEVER DELETED. It is the only place the recipient ("to Anura")
// and the issuing storekeeper survive — the receipt-linked row carries neither. So it stays
// visible in the item's history with counts = 0 and stops deducting a second time. Exactly what
// scripts/reconcile_oil_receipts.js did for the oil book, and reversible the same way.
//
// MATCHING IS ON THE PAPERWORK AND THE ITEM, NEVER ON "SOMETHING SIMILAR NEARBY". A candidate
// only pairs when the receipt sits on the MR NUMBER THE TRACKER ROW ITSELF NAMES **and** is the
// SAME ITEM. Dropping the item check pairs "York (to Krishna)" with a Belt that happened to be
// on the same request for the same vehicle — the balance would come out right and the record
// would be a lie. York has no York on its request at all, so it is left alone: that one is a
// handover with no receipt behind it, which is a different problem.
//
//   node scripts/void_duplicate_issues.js            # dry run
//   node scripts/void_duplicate_issues.js --apply

const { get, all, run, tx, migrate } = require('../src/db');

migrate();   // issues.voided is added by the schema ensure step

const APPLY = process.argv.includes('--apply');
const itemKey = (s) => String(s || '').toUpperCase().replace(/\([^)]*\)/g, ' ').replace(/[^A-Z0-9]/g, '') || 'UNKNOWN';
// What was handed over, with the site ("— Mellawagedara") and the recipient ("(to Anura)") off.
const baseItem = (d) => String(d || '').split(' — ')[0].replace(/\(\s*to\b[^)]*\)/gi, ' ').trim();

const live = all(`SELECT id, description, qty, unit_price, issue_date, asset_id, job_id, issued_by,
                         grn_id, mrn_no, created_at
                    FROM issues WHERE COALESCE(voided,0) = 0 ORDER BY id`);

const plan = [];
const seen = new Set();

// Receipts, grouped by the request they arrived on — so a handover is only ever checked against
// the paperwork it names, never against whatever else is nearby.
const grnByMrnQty = new Map();
for (const g of all(`SELECT g.id, COALESCE(g.description, ml.description) AS d, g.qty, m.mrn_no
                       FROM grn g JOIN mrn_lines ml ON ml.id = g.mrn_line_id JOIN mrn m ON m.id = ml.mrn_id
                      WHERE NULLIF(m.mrn_no,'') IS NOT NULL`)) {
  if (!grnByMrnQty.has(g.mrn_no)) grnByMrnQty.set(g.mrn_no, []);
  grnByMrnQty.get(g.mrn_no).push(g);
}

// ---- A. the same line twice in the tracker ---------------------------------
const groups = new Map();
for (const i of live) {
  if (i.grn_id) continue;                            // a receipt-linked row is not a tracker row
  const k = [i.description, i.issue_date, i.qty, i.asset_id, i.issued_by, i.mrn_no].join('');
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(i);
}
// THE RECEIPT DECIDES, NOT THE CLOCK. Two identical lines could in principle be two real
// handovers on one day, and the timestamps do not settle it — the three found here were entered
// 26 seconds, 17 minutes and 43 minutes apart. What settles it is that the request each names
// RECEIVED ONLY ONE: you cannot hand out two of something one of which was bought. So only the
// handovers the receipt cannot account for are muted, and an item genuinely delivered twice keeps
// both of its handovers.
const receivedOn = (mrnNo, want) => {
  if (!mrnNo) return 0;
  return (grnByMrnQty.get(mrnNo) || []).filter((g) => itemKey(g.d) === want)
    .reduce((s, g) => s + (Number(g.qty) || 0), 0);
};
for (const rows of groups.values()) {
  if (rows.length < 2) continue;
  const want = itemKey(baseItem(rows[0].description));
  const supported = receivedOn(rows[0].mrn_no, want) / (Number(rows[0].qty) || 1);
  const keepCount = Math.max(1, Math.floor(supported + 0.001));
  if (rows.length <= keepCount) continue;                 // the receipt covers every one of them
  // The first is the handover; the ones the receipt cannot account for are the same one keyed again.
  for (const r of rows.slice(keepCount)) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    plan.push({ row: r, keep: rows[0].id, why: 'A',
      detail: `the same line as #${rows[0].id}, and request ${rows[0].mrn_no} received only ${receivedOn(rows[0].mrn_no, want)}` });
  }
}

// ---- B. the tracker and Stores both recorded it ----------------------------
const grnByMrn = grnByMrnQty;
const linkedByGrn = new Map();
for (const i of live) {
  if (!i.grn_id) continue;
  if (!linkedByGrn.has(i.grn_id)) linkedByGrn.set(i.grn_id, []);
  linkedByGrn.get(i.grn_id).push(i);
}

const unmatched = [];
for (const i of live) {
  if (i.grn_id || seen.has(i.id) || !i.mrn_no) continue;
  const want = itemKey(baseItem(i.description));
  const receipts = (grnByMrn.get(i.mrn_no) || []).filter((g) => itemKey(g.d) === want);
  if (!receipts.length) { unmatched.push({ i, why: 'that request holds no receipt of this item' }); continue; }
  const twins = receipts.flatMap((g) => linkedByGrn.get(g.id) || [])
    .filter((t) => t.asset_id === i.asset_id && Math.abs((t.qty || 0) - (i.qty || 0)) < 0.001);
  if (!twins.length) { unmatched.push({ i, why: 'the receipt was never issued through Stores, so there is no second row' }); continue; }
  seen.add(i.id);
  plan.push({ row: i, keep: twins[0].id, why: 'B', detail: `already handed over as #${twins[0].id}, against GRN #${twins[0].grn_id} on the same request` });
}

// ---- report ----------------------------------------------------------------
const A = plan.filter((p) => p.why === 'A'); const B = plan.filter((p) => p.why === 'B');
console.log(`HANDOVERS WRITTEN DOWN TWICE — ${plan.length} to mute (${A.length} keyed twice in the tracker, ${B.length} recorded in both books)`);
console.log();
for (const p of plan) {
  console.log('   #' + String(p.row.id).padEnd(5) + String(p.row.issue_date).slice(0, 10)
    + String(p.row.qty).padStart(5) + '  ' + String(p.row.description).slice(0, 42).padEnd(44) + p.detail);
}

// Which balances this actually puts right.
console.log('\nEffect on the shelf:');
const byItem = new Map();
for (const p of plan) {
  const k = itemKey(p.row.description);
  byItem.set(k, (byItem.get(k) || 0) + (p.row.qty || 0));
}
for (const [k, q] of [...byItem].sort((a, b) => b[1] - a[1])) {
  const cur = get(`SELECT ROUND(COALESCE(SUM(CASE WHEN counts = 0 THEN 0 WHEN kind IN ('in','opening','adjust') THEN qty ELSE -qty END),0),2) v,
                          MAX(item_name) nm FROM stock_moves WHERE section = 'general' AND item_key = ?`, k);
  console.log('   ' + String(cur && cur.nm ? cur.nm : k).slice(0, 40).padEnd(42)
    + String(cur ? cur.v : '?').padStart(8) + '  ->' + String((cur ? cur.v : 0) + q).padStart(8));
}

if (unmatched.length) {
  console.log(`\n${unmatched.length} free-hand handovers LEFT ALONE — no second row to blame:`);
  for (const u of unmatched.slice(0, 10)) {
    console.log('   #' + String(u.i.id).padEnd(5) + String(u.i.issue_date).slice(0, 10) + '  '
      + String(u.i.description).slice(0, 40).padEnd(42) + u.why);
  }
  if (unmatched.length > 10) console.log(`   … and ${unmatched.length - 10} more`);
}

if (!APPLY) { console.log('\nDry run — nothing written.'); process.exit(0); }

tx(() => {
  for (const p of plan) {
    run(`UPDATE issues SET voided = 1, voided_reason = ? WHERE id = ?`,
      `the same handover is recorded as issue #${p.keep} — ${p.detail}`, p.row.id);
  }
});
console.log(`\nAPPLIED — ${plan.length} duplicate handovers muted. Nothing deleted; each says which row it repeats.`);
console.log('Next: rebuild the stock so the balances read through them.');
