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

if (!only || only === '1') {
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

console.log('\nDone.');
