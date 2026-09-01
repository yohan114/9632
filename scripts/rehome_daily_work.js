'use strict';

// Move a day's work onto the job card whose own dates actually cover it.
//
//   node scripts/rehome_daily_work.js          (dry run, default)
//   node scripts/rehome_daily_work.js --apply
//
// The daily-work sheet records a vehicle and a date but no job number, so every job_id in
// job_daily_work is an inference. The rule that made most of them had no date bound, so one card
// could absorb a vehicle's whole year — LB-18's April backhoe work sat on a card called "Hy hose
// replace" dated 1 July, while the card actually describing that work ("Loader & backhoe bucket
// repair, F/R pin bush repair, replaced backhoe arm jack seal", 24 Apr – 5 May) held nothing.
//
// A row is moved ONLY when some card for the SAME vehicle has a window containing the work date.
// If nothing covers the day it is left exactly where it is — a guess is not improved by a
// different guess. Labour is month-scoped by work_date, so this moves NOTHING between months;
// it only puts the right work on the right card.

const { get, all, run, tx } = require('../src/db');
const costing = require('../src/lib/costing');

const APPLY = process.argv.includes('--apply');
const d10 = (v) => String(v || '').slice(0, 10);

const cardsByAsset = new Map();
for (const c of all(`SELECT id, job_no, asset_id, status, date(requested_at) s,
                            date(COALESCE(closed_at, completed_at, requested_at)) e
                       FROM job_cards WHERE asset_id IS NOT NULL`)) {
  if (!cardsByAsset.has(c.asset_id)) cardsByAsset.set(c.asset_id, []);
  cardsByAsset.get(c.asset_id).push(c);
}

const moves = [];
const rows = all(`SELECT w.id, w.work_date, w.description, w.hours, w.job_id,
                         j.job_no cur_no, j.asset_id, a.code, a.registration
                    FROM job_daily_work w
                    JOIN job_cards j ON j.id = w.job_id
                    LEFT JOIN assets a ON a.id = j.asset_id
                   WHERE j.asset_id IS NOT NULL AND w.work_date IS NOT NULL`);

for (const w of rows) {
  const cards = cardsByAsset.get(w.asset_id) || [];
  const date = d10(w.work_date);
  const covering = cards.filter((c) => c.s && c.s <= date && date <= (c.e || c.s));
  if (!covering.length) continue;                     // nothing covers the day — leave it alone
  if (covering.some((c) => c.id === w.job_id)) continue; // already on a card that covers it
  // Several can cover the same day; take the one that started most recently, i.e. the job the
  // vehicle was actually in the workshop for on that date.
  const to = covering.sort((a, b) => String(b.s).localeCompare(String(a.s)))[0];
  moves.push({ w, to });
}

const monthBefore = {};
for (const r of all(`SELECT substr(work_date,1,7) m, ROUND(SUM(amount),2) v FROM job_labour GROUP BY m`)) monthBefore[r.m] = r.v;

console.log(`daily-work rows examined     : ${rows.length}`);
console.log(`rows to re-home              : ${moves.length}`);
const byVeh = {};
moves.forEach((m) => { const k = m.w.registration || m.w.code || m.w.asset_id; byVeh[k] = (byVeh[k] || 0) + 1; });
console.log(`vehicles affected            : ${Object.keys(byVeh).length}`);
console.log();
console.log('  most affected vehicles:');
Object.entries(byVeh).sort((a, b) => b[1] - a[1]).slice(0, 10)
  .forEach(([v, n]) => console.log(`    ${String(v).padEnd(14)} ${n} row(s)`));
console.log();
console.log('  sample moves:');
moves.slice(0, 10).forEach((m) => console.log(
  `    ${m.w.work_date}  ${String(m.w.description || '').slice(0, 30).padEnd(31)} ${String(m.w.cur_no).padEnd(15)} -> ${m.to.job_no}`));

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

const jobs = new Set();
tx(() => {
  for (const m of moves) {
    run('UPDATE job_daily_work SET job_id = ? WHERE id = ?', m.to.id, m.w.id);
    run('UPDATE job_labour SET job_id = ? WHERE job_id = ? AND work_date = ?', m.to.id, m.w.job_id, m.w.work_date);
    jobs.add(m.w.job_id); jobs.add(m.to.id);
  }
});
for (const j of jobs) { try { costing.refreshJobTotals(j); } catch (e) { /* non-fatal */ } }

// The whole point of moving only within a vehicle is that no month may shift.
const monthAfter = {};
for (const r of all(`SELECT substr(work_date,1,7) m, ROUND(SUM(amount),2) v FROM job_labour GROUP BY m`)) monthAfter[r.m] = r.v;
const drifted = Object.keys({ ...monthBefore, ...monthAfter })
  .filter((m) => Math.abs((monthAfter[m] || 0) - (monthBefore[m] || 0)) > 0.01);

console.log(`\nRe-homed ${moves.length} rows across ${jobs.size} job cards.`);
console.log(`  months whose labour changed: ${drifted.length}${drifted.length ? ' — ' + drifted.map((m) => `${m} ${Math.round((monthAfter[m] || 0) - (monthBefore[m] || 0))}`).join(', ') : ' (none, as intended)'}`);
console.log(`  cards now carrying work    : ${get('SELECT COUNT(DISTINCT job_id) c FROM job_daily_work').c}`);
