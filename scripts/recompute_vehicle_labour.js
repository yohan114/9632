'use strict';

// Bring vehicle_monthly_costs.labour_cost into agreement with job_labour.
//
// The per-vehicle rollup in costing.refreshJobTotals was unreachable (asset_id was missing
// from its SELECT), so labour_cost never moved after the 015 backfill. This recomputes it
// with the SAME formula the live code now uses — total labour for the vehicle in that month,
// summed from job_labour, which already applies the confirmed crew rule (each mechanic full
// hours at their own rate).
//
// Idempotent: it SETs an absolute value, never adds. Running it twice changes nothing.
// Only labour_cost moves; fuel/oil/filter/battery/parts are untouched and total_cost is
// re-derived as Σ(components) so the table's invariant holds.
//
//   node scripts/recompute_vehicle_labour.js --dry     (report only, default)
//   node scripts/recompute_vehicle_labour.js --apply

const { get, all, run, tx } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Every vehicle-month that has labour, plus every row already stored (so a month whose
// labour has since been deleted is corrected down to 0 rather than left stale).
const periods = all(`
  SELECT asset_id, ym FROM (
    SELECT j.asset_id AS asset_id, substr(jl.work_date, 1, 7) AS ym
      FROM job_labour jl JOIN job_cards j ON j.id = jl.job_id
     WHERE j.asset_id IS NOT NULL AND jl.work_date IS NOT NULL
     GROUP BY j.asset_id, ym
    UNION
    SELECT asset_id, printf('%04d-%02d', year, month) FROM vehicle_monthly_costs
     WHERE asset_id IS NOT NULL
  ) ORDER BY asset_id, ym`);

const changes = [];
let created = 0;
for (const p of periods) {
  const [yr, mo] = p.ym.split('-').map(Number);
  if (!yr || !mo) continue;
  const computed = r2(get(
    `SELECT COALESCE(SUM(jl.amount), 0) v FROM job_labour jl JOIN job_cards j ON j.id = jl.job_id
      WHERE j.asset_id = ? AND substr(jl.work_date, 1, 7) = ?`, p.asset_id, p.ym).v);
  const row = get('SELECT * FROM vehicle_monthly_costs WHERE asset_id = ? AND year = ? AND month = ?', p.asset_id, yr, mo);
  const stored = row ? r2(row.labour_cost) : 0;
  if (!row && computed <= 0) continue;               // nothing to store
  if (row && Math.abs(stored - computed) < 0.01) continue; // already agrees
  changes.push({ asset_id: p.asset_id, ym: p.ym, yr, mo, stored, computed, isNew: !row, id: row ? row.id : null });
  if (!row) created++;
}

const up = changes.filter((c) => c.computed > c.stored);
const down = changes.filter((c) => c.computed < c.stored);
const net = r2(changes.reduce((s, c) => s + c.computed - c.stored, 0));

console.log(`vehicle-months examined : ${periods.length}`);
console.log(`  already correct       : ${periods.length - changes.length}`);
console.log(`  to change             : ${changes.length}  (${created} new row(s))`);
console.log(`    rising              : ${up.length}  +Rs ${r2(up.reduce((s, c) => s + c.computed - c.stored, 0)).toLocaleString()}`);
console.log(`    falling             : ${down.length}  -Rs ${r2(down.reduce((s, c) => s + c.stored - c.computed, 0)).toLocaleString()}`);
console.log(`  net movement          : Rs ${net.toLocaleString()}`);

if (changes.length) {
  console.log('\nlargest 10 movements:');
  for (const c of [...changes].sort((a, b) => Math.abs(b.computed - b.stored) - Math.abs(a.computed - a.stored)).slice(0, 10)) {
    const a = get('SELECT code, registration FROM assets WHERE id = ?', c.asset_id) || {};
    console.log(`   ${String(a.registration || a.code || c.asset_id).padEnd(12)} ${c.ym}  ${String(c.stored).padStart(10)} -> ${String(c.computed).padStart(10)}${c.isNew ? '  (new)' : ''}`);
  }
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.');
  process.exit(0);
}

tx(() => {
  for (const c of changes) {
    if (c.isNew) {
      run(`INSERT INTO vehicle_monthly_costs (asset_id, year, month, labour_cost, total_cost, updated_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))`, c.asset_id, c.yr, c.mo, c.computed, c.computed);
    } else {
      run(`UPDATE vehicle_monthly_costs
              SET labour_cost = ?,
                  total_cost = ROUND(COALESCE(fuel_cost,0) + COALESCE(oil_cost,0) + COALESCE(filter_cost,0)
                                   + COALESCE(battery_cost,0) + COALESCE(parts_cost,0) + ?, 2),
                  updated_at = datetime('now')
            WHERE id = ?`, c.computed, c.computed, c.id);
    }
  }
});

const breaches = get(`SELECT COUNT(*) c FROM vehicle_monthly_costs
   WHERE ROUND(total_cost,2) <> ROUND(COALESCE(fuel_cost,0)+COALESCE(oil_cost,0)+COALESCE(filter_cost,0)
                                    +COALESCE(battery_cost,0)+COALESCE(parts_cost,0)+COALESCE(labour_cost,0),2)`).c;
console.log(`\napplied ${changes.length} change(s).`);
console.log(`total_cost = Σ(components) breaches: ${breaches}${breaches ? '  *** INVARIANT VIOLATED ***' : '  (invariant holds)'}`);
console.log(`SUM(labour_cost) now: Rs ${get('SELECT ROUND(SUM(labour_cost),2) v FROM vehicle_monthly_costs').v.toLocaleString()}`);
console.log(`SUM(total_cost)  now: Rs ${get('SELECT ROUND(SUM(total_cost),2) v FROM vehicle_monthly_costs').v.toLocaleString()}`);
