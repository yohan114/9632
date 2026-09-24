'use strict';

// Remove job-card parts for items that were requested but NEVER delivered.
//
//   node scripts/drop_undelivered_parts.js          (dry run, default)
//   node scripts/drop_undelivered_parts.js --apply
//
// The materials ETL created a job_part for every MRN line whether or not anything arrived, and
// priced the ones with no receipt from a borrowed item-name average. A part that never turned up
// was never fitted to the vehicle, so charging it is simply wrong — owner-confirmed 2026-08-14.
//
// The request itself is NOT lost: mrn.job_id still links the MRN to the job, so the line keeps
// showing on the job report as requested-but-not-received. Only the costed "consumed part"
// record goes.
//
// The ETL that produced these now skips undelivered lines (src/migrate/09_job_materials.js), so
// this is a one-off catch-up rather than a recurring clean-up.

const { get, all, run, tx } = require('../src/db');
const costing = require('../src/lib/costing');

const APPLY = process.argv.includes('--apply');

// "Delivered" means a GRN row exists for the line at all — priced or not. A delivery still
// waiting for its invoice must NOT be mistaken for one that never came.
const doomed = all(`
  SELECT jp.id, jp.job_id, jp.qty, jp.unit_price, jp.description, jp.mrn_line_id,
         j.job_no, j.status, m.mrn_no
    FROM job_parts jp
    JOIN mrn_lines ml ON ml.id = jp.mrn_line_id
    JOIN mrn m        ON m.id  = ml.mrn_id
    JOIN job_cards j  ON j.id  = jp.job_id
   WHERE jp.source_type = 'grn'
     AND NOT EXISTS (SELECT 1 FROM grn g WHERE g.mrn_line_id = ml.id)
   ORDER BY (jp.qty * COALESCE(jp.unit_price,0)) DESC`);

const valued = doomed.filter((r) => r.unit_price != null);
const value = valued.reduce((s, r) => s + (r.qty || 0) * (r.unit_price || 0), 0);
const jobs = new Set(doomed.map((r) => r.job_id));

console.log(`undelivered part lines on job cards : ${doomed.length}`);
console.log(`  carrying an invented price        : ${valued.length}  = Rs ${Math.round(value).toLocaleString()}`);
console.log(`  already unpriced                  : ${doomed.length - valued.length}`);
console.log(`  job cards affected                : ${jobs.size}`);
console.log();
console.log('  largest:');
doomed.slice(0, 8).forEach((r) => console.log(
  `    ${String(r.job_no).padEnd(15)} MRN ${String(r.mrn_no || '-').padEnd(8)} ${String(r.description).slice(0, 30).padEnd(31)} qty ${r.qty} @ ${r.unit_price == null ? '(none)' : r.unit_price}`));

const before = get('SELECT ROUND(SUM(material_cost),2) v FROM job_cards').v;
console.log();
console.log(`  material on cards now             : Rs ${before.toLocaleString()}`);
console.log(`  after removing them               : Rs ${Math.round((before - value)).toLocaleString()}`);

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

// Sanity gate: never delete a line that does have a receipt, whatever the query said.
for (const r of doomed) {
  const n = get('SELECT COUNT(*) c FROM grn WHERE mrn_line_id = ?', r.mrn_line_id).c;
  if (n > 0) { console.error(`REFUSING: line ${r.mrn_line_id} has ${n} receipt(s) after all`); process.exit(1); }
}

tx(() => { for (const r of doomed) run('DELETE FROM job_parts WHERE id = ?', r.id); });
for (const j of jobs) { try { costing.refreshJobTotals(j); } catch (e) { /* non-fatal */ } }

console.log(`\nRemoved ${doomed.length} lines from ${jobs.size} job cards.`);
console.log(`  material on cards now : Rs ${get('SELECT ROUND(SUM(material_cost),2) v FROM job_cards').v.toLocaleString()}`);
console.log(`  requests still visible: ${get(`SELECT COUNT(*) c FROM mrn WHERE job_id IS NOT NULL`).c} MRNs remain linked to their job`);
