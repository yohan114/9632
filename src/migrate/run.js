'use strict';

// Migration runner. Runs the real Stores+Oil+Jobs migration into the app DB.
//   node src/migrate/run.js --reset            # fresh DB, then run all available steps
//   node src/migrate/run.js --reset --step 1   # just Step 3 (asset registry)
//
// Steps are added incrementally per the phased plan; each reports counts in/out.
const fs = require('fs');
const config = require('../config');

if (process.argv.includes('--reset')) {
  for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(config.dbPath + s); } catch {} }
  console.log('Fresh DB at', config.dbPath);
}

const { migrate } = require('../db');
migrate();

const only = process.argv.includes('--step') ? process.argv[process.argv.indexOf('--step') + 1] : null;

function banner(t) { console.log('\n' + '='.repeat(64) + '\n  ' + t + '\n' + '='.repeat(64)); }

if (!only || only === '1' || only === 'assets') {
  banner('Step 3 — Asset registry + alias resolver');
  const rep = require('./01_assets').runStep();
  console.log(`  Projects migrated:              ${rep.projects}`);
  console.log(`  Register norm set (ec ∪ reg):   ${rep.register_norm_set}`);
  console.log(`  Register assets (in_register=1):${String(rep.register_assets).padStart(6)}  (fleet rows w/o a code: ${rep.fleet_no_code}, code collisions handled: ${rep.code_collisions})`);
  console.log(`  Dual-code aliases registered:   ${rep.dual_code_aliases}`);
  console.log(`  Distinct usage codes:           ${rep.usage_distinct}`);
  console.log(`    → matched to register:        ${rep.usage_matched_register}`);
  console.log(`    → auto-created (in_register=0):${String(rep.usage_created).padStart(5)}   [upper bound; alias review folds fuzzy variants]`);
  console.log(`  Oilbook aliases seeded (156):   resolved ${rep.oil_aliases_resolved}, pending ${rep.oil_aliases_pending}`);
  console.log('  ' + '-'.repeat(50));
  console.log(`  TOTAL assets:                   ${rep.total_assets}  (register ${rep.register_assets} + usage ${rep.usage_created})`);
  console.log(`  TOTAL aliases:                  ${rep.total_aliases}  (resolved ${rep.aliases_resolved}, pending ${rep.aliases_pending})`);
}

if (!only || only === 'jobs') {
  banner('Job history import (c_job + requested — unified)');
  const j = require('./05_jobs').runStep();
  console.log(`  Requested rows:                 ${j.requested_rows}  (duplicate job-no skipped: ${j.duplicates_skipped})`);
  console.log(`  C-job rows:                     ${j.cjob_rows}  (enriched existing: ${j.enriched_from_cjob}, new: ${j.cjob_rows - j.enriched_from_cjob})`);
  console.log(`  Vehicles unlinked to an asset:  ${j.unlinked_vehicle}${j.unresolved_samples.length ? '  e.g. ' + j.unresolved_samples.join(', ') : ''}`);
  console.log('  ' + '-'.repeat(50));
  console.log(`  TOTAL job cards:                ${j.total_jobs}  (CLOSED ${j.closed}, open/requested ${j.open})`);
  console.log(`  With a recorded cost:           ${j.with_recorded_cost}  (Σ Rs ${j.recorded_cost_sum.toLocaleString('en-US')})`);
}

if (!only || only === 'labour') {
  banner('Labour hourly rates import (Labor Hour sheet)');
  const l = require('./07_labour').runStep();
  console.log(`  Rates read:                     ${l.rates_read}`);
  console.log(`  Mechanics created:              ${l.mechanics_created}`);
  console.log(`  Rates inserted:                 ${l.rates_inserted}  (already present: ${l.rates_skipped})`);
  console.log(`  Alias spellings linked:         seeded ${l.aliases_seeded}, relinked ${l.aliases_relinked}, unchanged ${l.aliases_skipped}`);
  if (l.alias_canonical_missing.length) console.log(`  ⚠ alias canonical not found:    ${l.alias_canonical_missing.join(', ')}`);
  console.log('  ' + '-'.repeat(50));
  console.log(`  TOTAL mechanics:                ${l.total_mechanics}`);
  console.log(`  TOTAL labour rates:             ${l.total_rates}`);
}

if (!only || only === 'daily') {
  banner('Daily Work Done import (attach to jobs, ±3 days)');
  const d = require('./06_daily_work').runStep();
  console.log(`  Daily-work rows read:           ${d.rows}`);
  console.log(`  Matched to a job (±3 days):     ${d.matched}  (inserted: ${d.inserted}, duplicate skipped: ${d.duplicates})`);
  console.log(`  Skipped — no job within ±3d:    ${d.no_job}`);
  console.log(`  Skipped — no/unknown vehicle:   ${d.no_vehicle + d.unresolved}  (no vehicle: ${d.no_vehicle}, unresolved: ${d.unresolved}${d.unresolved_samples.length ? ' e.g. ' + d.unresolved_samples.join(', ') : ''})`);
  console.log(`  Skipped — no date:              ${d.no_date}`);
  console.log('  ' + '-'.repeat(50));
  console.log(`  TOTAL daily-work entries:       ${d.total_daily_work}  across ${d.jobs_with_daily_work} jobs`);
  if (d.review_file) console.log(`  Unmatched rows written to:      ${d.review_file}`);
}

if (!only || only === 'stores') {
  banner('Stores data import (inventory.db → stores schema)');
  const s = require('./08_stores').runStep();
  if (s.skipped) {
    console.log('  Already imported (mrn/store_items present) — skipped. Reset to re-import.');
  } else {
    console.log(`  Store items (catalogue):        ${s.store_items}`);
    console.log(`  General-item transactions:      ${s.general_txns}`);
    console.log(`  MRN headers / lines:            ${s.mrn} / ${s.mrn_lines}`);
    console.log(`  GRN (receipts):                 ${s.grn}`);
    console.log(`  Issues:                         ${s.issues}`);
    console.log(`  MTN transfers:                  ${s.mtn}  (duplicate-no suffixed: ${s.mtn_no_suffixed})`);
    console.log(`  Batteries / events:             ${s.batteries} / ${s.battery_events}`);
  }
}

if (!only || only === 'materials') {
  banner('Assign store items to jobs (nearest job by vehicle) — material cost');
  const mm = require('./09_job_materials').runStep();
  console.log(`  Container jobs created:         ${mm.container_jobs}  (recovered ${mm.container_lines} lines; non-vehicle skipped: ${mm.container_skipped_nonvehicle})`);
  console.log(`  MRNs assigned:                  ${mm.mrn_matched}`);
  console.log(`  Requested items added:          ${mm.items_added}  (priced: ${mm.priced_items}, backfilled: ${mm.backfilled_items}, awaiting price: ${mm.unpriced_items})`);
  console.log(`  Stock issues added:             ${mm.issue_matched}  (no job: ${mm.issue_unmatched})`);
  console.log(`  Quarantined (impossible dates): ${mm.quarantined}`);
  console.log(`  NOT assigned items:             ${mm.no_job + mm.no_vehicle}  (vehicle has no job: ${mm.no_job}, no vehicle: ${mm.no_vehicle})`);
  console.log('  ' + '-'.repeat(50));
  console.log(`  Jobs with items assigned:       ${mm.jobs_touched}`);
  console.log(`  Priced material value:          Rs ${mm.material_value.toLocaleString('en-US')}`);
  console.log(`  TOTAL material cost (all jobs):  Rs ${mm.total_material.toLocaleString('en-US')}`);
  if (mm.unassigned_file) console.log(`  Not-assigned items table:       ${mm.unassigned_file} (${mm.unassigned_count} items)`);
}

if (!only || only === 'fleet') {
  banner('Fleet vehicle list import (Fuel Rates: E&C No + Reg No)');
  const f = require('./10_fleet_vehicles').runStep();
  console.log(`  Vehicles read:                  ${f.rows}`);
  console.log(`  New vehicles created:           ${f.created}`);
  console.log(`  Existing enriched:              ${f.enriched}  (unchanged: ${f.no_change})`);
  console.log(`  Aliases registered:             ${f.aliases_added}  (Reg No linked: ${f.reg_linked})`);
  console.log('  ' + '-'.repeat(50));
  console.log(`  TOTAL assets:                   ${f.total_assets}  (in register: ${f.in_register})`);
  console.log(`  With E&C code:                  ${f.with_ec}  | with registration: ${f.with_reg}`);
}

if (!only || only === 'reconcile') {
  banner('Vehicle reconciliation (merges + container job) + reassign');
  const rc = require('./11_reconcile').runStep();
  console.log(`  Variant vehicles merged:        ${rc.merged}  (references re-pointed: ${rc.refs_repointed})`);
  console.log(`  Store items → General Items:    ${rc.stores_recategorised}`);
  console.log(`  Container job cards created:    ${rc.container_jobs}`);
  if (rc.skipped.length) console.log(`  Skipped:                        ${rc.skipped.join('; ')}`);
  const mm = rc.reassign;
  console.log('  ' + '-'.repeat(50));
  console.log(`  Reassign → items placed:        ${mm.items_added}  | jobs: ${mm.jobs_touched}  | material Rs ${mm.material_value.toLocaleString('en-US')}`);
  console.log(`  Reassign → NOT assigned items:  ${mm.no_job + mm.no_vehicle}`);
}

if (!only || only === 'labour-cost') {
  banner('Calculate labour cost (daily work × rates) + recost jobs');
  const lc = require('./12_labour_cost').runStep();
  console.log(`  Jobs recosted:                  ${lc.jobs_recosted}`);
  console.log(`  Jobs with labour cost:          ${lc.jobs_with_labour}`);
  console.log('  ' + '-'.repeat(50));
  console.log(`  TOTAL labour cost (all jobs):   Rs ${lc.total_labour.toLocaleString('en-US')}`);
  console.log(`  TOTAL material cost (all jobs):  Rs ${lc.total_material.toLocaleString('en-US')}`);
}

if (!only || only === 'general-issues') {
  banner('General items issue list import + allocate to jobs (±3 days)');
  const gi = require('./13_general_issues').runStep();
  console.log(`  Issue rows read:                ${gi.rows}  (cleared prior from this source: ${gi.cleared_prev})`);
  console.log(`  New general store items created:${gi.items_created}`);
  console.log(`  Issues added:                   ${gi.txns}`);
  console.log(`  Allocated to a job (±3 days):   ${gi.allocated}`);
  console.log(`  NOT allocated:                  ${gi.no_vehicle + gi.unresolved + gi.no_date + gi.no_job}  (no vehicle: ${gi.no_vehicle}, unresolved: ${gi.unresolved}, no date: ${gi.no_date}, no in-window job: ${gi.no_job})`);
  console.log('  ' + '-'.repeat(50));
  console.log(`  TOTAL general-item issues:      ${gi.total_general_issues}  (allocated to jobs: ${gi.allocated_to_jobs})`);
  if (gi.review_file) console.log(`  Unallocated review table:       ${gi.review_file} (${gi.unallocated_count} items)`);
}

if (!only || only === 'catalogue') {
  banner('Consolidated item catalogue import (deduped MRN items → store_items)');
  const ic = require('./14_item_catalogue').runStep();
  console.log(`  Catalogue rows read:            ${ic.rows}`);
  console.log(`  Items created:                  ${ic.created}  (adopted existing same-name: ${ic.adopted}, updated on re-run: ${ic.updated})`);
  console.log(`  By kind:                        part ${ic.by_kind.part}, consumable ${ic.by_kind.consumable}, service ${ic.by_kind.service}`);
  console.log('  ' + '-'.repeat(50));
  console.log(`  TOTAL catalogued store items:   ${ic.total_catalogue}`);
}

if (!only || only === 'oil') {
  banner('Oil & lubricant subsystem import (products, ledger, service specs, counts)');
  const o = require('./16_oil_import').runStep();
  console.log(`  Products imported:              ${o.products}  (priced: ${o.priced_products}, unpriced: ${o.unpriced_products.length})`);
  if (o.unpriced_products.length) console.log(`    ↳ needs a price:              ${o.unpriced_products.join(', ')}`);
  console.log(`  Oilbook vehicles resolved:      ${o.assets_resolved}`);
  console.log(`  Stock-ledger rows:              ${o.ledger}  (issues: ${o.issues})`);
  console.log(`  Oil issues attached to a job:   ${o.issues_on_job}  (no vehicle: ${o.issues_no_asset})`);
  console.log(`  Service specs / stock counts:   ${o.service_specs} / ${o.stock_counts}`);
}

if (!only || only === 'dimensions') {
  banner('Restore project/site dimension (map site → project; asset home project)');
  const dm = require('./17_dimensions').runStep();
  console.log(`  Jobs with a site:               ${dm.jobs_total}`);
  console.log(`  Jobs mapped to a project:       ${dm.jobs_projected}  (${dm.sites_matched} distinct sites matched)`);
  console.log(`  Assets given a home project:    ${dm.assets_projected}`);
  if (dm.unmatched_sites.length) console.log(`  Top unmapped sites (no project): ${dm.unmatched_sites.join(', ')}`);
}

if (!only || only === 'asset-merge') {
  banner('Conservative asset de-duplication (fold unambiguous duplicate vehicles)');
  const am = require('./18_asset_merge').runStep();
  console.log(`  Duplicate groups examined:      ${am.groups_total}`);
  console.log(`  Merged (single canonical):      ${am.merged_groups}  (variants folded: ${am.variants_folded}, refs repointed: ${am.refs_repointed})`);
  console.log(`  Left for manual review:         ${am.skipped_ambiguous}`);
  console.log(`  Assets now:                     ${am.assets_now}`);
}

if (!only || only === 'reconcile-costs') {
  banner('Cost reconciliation (freeze recorded total; recover stranded component cost)');
  const rc = require('./15_reconcile_costs').runStep();
  console.log(`  Jobs recomputed:                ${rc.jobs}  (recorded_cost frozen: ${rc.recorded_backfilled})`);
  console.log(`  Total using recorded figure:    ${rc.used_recorded}`);
  console.log(`  Total from computed components:  ${rc.used_computed}`);
  console.log(`  Jobs reading Rs 0 — before → after: ${rc.zero_before} → ${rc.zero_after}`);
  console.log('  ' + '-'.repeat(50));
  console.log(`  Recovered cost into total:      Rs ${rc.recovered.toLocaleString('en-US')}`);
  console.log(`  Σ total_cost (all jobs) now:     Rs ${rc.total_after.toLocaleString('en-US')}`);
  console.log(`  Columns-sum-to-total check:     ${rc.unreconciled === 0 ? 'OK (all reconcile)' : rc.unreconciled + ' jobs FAIL'}`);
  console.log(`  Recorded≠itemised (in other):   ${rc.mismatches}${rc.review_file ? '  → ' + rc.review_file : ''}`);
}

console.log('\nDone.');
