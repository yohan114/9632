'use strict';
// Is job_labour consistent with job_daily_work for every month? Rebuild is idempotent, so a
// month whose stored total differs from a fresh recompute is stale.
const { all, get } = require('../src/db');
const m = require('../src/lib/mechanics');
const months = all(`SELECT DISTINCT substr(work_date,1,7) ym FROM job_daily_work WHERE work_date IS NOT NULL ORDER BY 1`).map(r => r.ym);
const rateOf = (name) => { const r = get('SELECT rate FROM labour_rates WHERE mechanic=? ORDER BY effective_from DESC, id DESC LIMIT 1', m.resolveMechanicName(name)); return r ? r.rate : 250; };
let bad = 0;
for (const ym of months) {
  const storedRow = get(`SELECT ROUND(SUM(amount),2) v FROM job_labour WHERE substr(work_date,1,7)=?`, ym);
  const stored = storedRow.v || 0;
  let expect = 0;
  for (const w of all(`SELECT mechanic, hours, is_external FROM job_daily_work WHERE substr(work_date,1,7)=? AND (is_external IS NULL OR is_external=0)`, ym)) {
    const hrs = Number(w.hours) || 0; if (!hrs) continue;
    for (const n of m.splitMechanics(w.mechanic)) expect += hrs * rateOf(n);
  }
  expect = Math.round(expect * 100) / 100;
  const diff = Math.round((stored - expect) * 100) / 100;
  if (Math.abs(diff) > 0.01) { bad++; console.log(`STALE ${ym}: stored ${stored} vs recompute ${expect}  (diff ${diff})`); }
}
console.log(bad ? `\n${bad} stale month(s) — job_labour needs a rebuild there.` : '\nAll months consistent — job_labour matches job_daily_work everywhere.');
