'use strict';

// Move a purchased part onto the job card whose own dates cover the date it was requisitioned.
//
//   node scripts/rehome_material.js          (dry run, default)
//   node scripts/rehome_material.js --apply
//
// Same conservative rule as rehome_daily_work.js: a line moves ONLY when some card for the SAME
// vehicle has a window containing the MRN date, and it never crosses vehicles. Where nothing
// covers the date the line stays put — the existing nearest-job rule is owner-confirmed and a
// guess is not improved by a different guess.
//
// UNLIKE labour, this DOES move money between report months: the monthly report scopes a closed
// card's labour by work_date but takes its material as a whole-job figure, so material lands in
// the month the CARD closed. Putting a part on the right card therefore also moves it to the
// month that card belongs to. The dry run prints exactly which months move and by how much.

const { get, all, run, tx } = require('../src/db');
const costing = require('../src/lib/costing');

const APPLY = process.argv.includes('--apply');
const money = (n) => 'Rs ' + Math.round(n).toLocaleString();

const cardsByAsset = new Map();
for (const c of all(`SELECT id, job_no, asset_id, date(requested_at) s,
                            date(COALESCE(closed_at, completed_at, requested_at)) e,
                            substr(COALESCE(completed_at, closed_at, requested_at),1,7) rep_month
                       FROM job_cards WHERE asset_id IS NOT NULL`)) {
  if (!cardsByAsset.has(c.asset_id)) cardsByAsset.set(c.asset_id, []);
  cardsByAsset.get(c.asset_id).push(c);
}

const moves = [];
for (const p of all(`SELECT jp.id, jp.job_id, jp.qty, jp.unit_price, jp.description,
                            j.job_no cur_no, j.asset_id,
                            substr(COALESCE(j.completed_at, j.closed_at, j.requested_at),1,7) cur_month,
                            date(m.req_date) req, a.code, a.registration
                       FROM job_parts jp
                       JOIN job_cards j ON j.id = jp.job_id
                       JOIN mrn_lines ml ON ml.id = jp.mrn_line_id
                       JOIN mrn m ON m.id = ml.mrn_id
                       LEFT JOIN assets a ON a.id = j.asset_id
                      WHERE jp.source_type = 'grn' AND j.asset_id IS NOT NULL AND m.req_date IS NOT NULL`)) {
  const cards = cardsByAsset.get(p.asset_id) || [];
  const covering = cards.filter((c) => c.s && c.s <= p.req && p.req <= (c.e || c.s));
  if (!covering.length) continue;
  if (covering.some((c) => c.id === p.job_id)) continue;
  const to = covering.sort((a, b) => String(b.s).localeCompare(String(a.s)))[0];
  moves.push({ p, to, value: (p.qty || 0) * (p.unit_price || 0) });
}

const monthShift = {};
for (const m of moves) {
  monthShift[m.p.cur_month] = (monthShift[m.p.cur_month] || 0) - m.value;
  monthShift[m.to.rep_month] = (monthShift[m.to.rep_month] || 0) + m.value;
}

console.log(`part lines to re-home : ${moves.length}`);
console.log(`value moving          : ${money(moves.reduce((s, m) => s + m.value, 0))}`);
console.log(`vehicles affected     : ${new Set(moves.map((m) => m.p.asset_id)).size}`);
console.log();
console.log('  month-by-month effect on the REPORTED material figure:');
Object.entries(monthShift).filter(([, v]) => Math.abs(v) > 0.5).sort()
  .forEach(([m, v]) => console.log(`    ${m}  ${v > 0 ? '+' : ''}${money(v)}`));
console.log();
console.log('  sample moves:');
moves.sort((a, b) => b.value - a.value).slice(0, 10).forEach((m) => console.log(
  `    ${m.p.req}  ${String(m.p.description || '').slice(0, 28).padEnd(29)} ${money(m.value).padStart(12)}  ${String(m.p.cur_no).padEnd(15)} -> ${m.to.job_no}`));

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

const jobs = new Set();
tx(() => {
  for (const m of moves) {
    run('UPDATE job_parts SET job_id = ? WHERE id = ?', m.to.id, m.p.id);
    jobs.add(m.p.job_id); jobs.add(m.to.id);
  }
});
for (const j of jobs) { try { costing.refreshJobTotals(j); } catch (e) { /* non-fatal */ } }

console.log(`\nRe-homed ${moves.length} part lines across ${jobs.size} job cards.`);
console.log(`  material on cards: ${money(get('SELECT SUM(material_cost) v FROM job_cards').v)} (unchanged in total — only which card carries it)`);
