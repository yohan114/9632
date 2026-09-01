'use strict';

// Repair source dates whose YEAR was mistyped, keeping the day and month.
//
//   node scripts/fix_impossible_dates.js          (dry run, default)
//   node scripts/fix_impossible_dates.js --apply
//
// 30 requests are dated 2001, one 1996, and six receipts carry years like 0004, 0026, 0091 and
// 0226. In every case the neighbouring record confirms the real year is 2026: MRN 141646 (dated
// 2001-05-20) sits between 141645 on 2026-05-16 and 141649 on 2026-05-26, and MRN 141735 (dated
// 1996-03-14) has 2026-03-14 on both sides. The day and month were typed correctly; only the
// year was wrong, so only the year is changed.
//
// This matters beyond tidiness: the materials ETL quarantines a line with an impossible date,
// so these requests were never attached to a job and their parts were never costed to a vehicle.

const { get, all, run, tx } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const YEAR = 2026;
const CUTOFF = '2015-01-01';

// Keep the month and day exactly; replace the year.
const reyear = (v) => {
  const s = String(v || '');
  const m = s.match(/^0*(\d{1,4})-(\d{2})-(\d{2})(.*)$/);
  return m ? `${YEAR}-${m[2]}-${m[3]}${m[4] || ''}` : null;
};

const targets = [
  { table: 'mrn', col: 'req_date', label: 'request date' },
  { table: 'mrn', col: 'required_date', label: 'required by' },
  { table: 'grn', col: 'delivery_date', label: 'received date' },
  { table: 'grn', col: 'invoice_date', label: 'invoice date' },
];

const plan = [];
for (const t of targets) {
  for (const r of all(
    `SELECT id, "${t.col}" AS val FROM "${t.table}"
      WHERE "${t.col}" IS NOT NULL AND date("${t.col}") < date(?)`, CUTOFF)) {
    const to = reyear(r.val);
    if (to && to !== r.val) plan.push({ ...t, id: r.id, from: r.val, to });
  }
}

console.log(`dates to repair: ${plan.length}`);
const byCol = {};
plan.forEach((p) => { const k = `${p.table}.${p.col}`; byCol[k] = (byCol[k] || 0) + 1; });
console.log('  by field:', JSON.stringify(byCol));
console.log();
for (const p of plan.slice(0, 40)) {
  const ref = p.table === 'mrn'
    ? (get('SELECT mrn_no FROM mrn WHERE id = ?', p.id) || {}).mrn_no
    : (get('SELECT COALESCE(grn_no, description) v FROM grn WHERE id = ?', p.id) || {}).v;
  console.log(`  ${p.table}.${p.col.padEnd(14)} ${String(ref || p.id).padEnd(14)} ${String(p.from).slice(0, 10)} -> ${p.to.slice(0, 10)}`);
}

const stuck = get(
  `SELECT COUNT(*) c FROM mrn WHERE date(req_date) < date(?) AND job_id IS NULL`, CUTOFF).c;
console.log();
console.log(`  requests currently quarantined by the bad date (no job attached): ${stuck}`);

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

tx(() => {
  for (const p of plan) run(`UPDATE "${p.table}" SET "${p.col}" = ? WHERE id = ?`, p.to, p.id);
});

console.log(`\nRepaired ${plan.length} date(s).`);
for (const t of targets) {
  const left = get(`SELECT COUNT(*) c FROM "${t.table}" WHERE "${t.col}" IS NOT NULL AND date("${t.col}") < date(?)`, CUTOFF).c;
  console.log(`  ${t.table}.${t.col}: ${left} impossible date(s) left`);
}
