'use strict';

// The Repair sheet's labour column must account for EVERY hour worked in the month.
//
// It lost Rs 301,850 across five months because a job can be routed to the Spares-Supply
// section — which prints a material figure and has no labour column — while still being
// excluded from Other Labour. Labour booked to such a job fell through every section and
// simply disappeared from the report, which is how the July figure came out Rs 18,200 short
// of the Daily Work total the owner reads on screen.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-report-labour-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const aliases = require('../src/lib/aliases');
const report = require('../src/lib/monthly_cost_report');

migrate();
require('../src/migrate/015_phase4_erp_gaps').runStep();

run("INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Anura', 100, '2020-01-01')");

const YM = '2026-09';
const addLabour = (jobId, amount, date = `${YM}-10`) =>
  run('INSERT INTO job_labour (job_id, mechanic, hours, rate, amount, work_date) VALUES (?, ?, ?, ?, ?, ?)',
    jobId, 'Anura', amount / 100, 100, amount, date);

// One card of each kind the Repair sheet routes differently.
const vClosed = aliases.findOrCreateAsset('RP-CLOSED', {}).id;
const vSpares = aliases.findOrCreateAsset('RP-SPARES', {}).id;
const vOther = aliases.findOrCreateAsset('RP-OTHER', {}).id;
const vOpen = aliases.findOrCreateAsset('RP-OPEN', {}).id;

const closedJob = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, completed_at, closed_at)
  VALUES ('2026/9/R/1', ?, 'repair', 'gearbox overhaul', 'CLOSED', '${YM}-20', '${YM}-20')`, vClosed).lastInsertRowid;

// Routed to Spares Supply by its description — the case that used to swallow labour. Such a
// container exists because materials were booked to it, so it carries a part line too.
const sparesJob = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, completed_at, closed_at)
  VALUES ('2026/9/R/2', ?, 'repair', 'Stores materials for RP-SPARES (auto-created container)', 'CLOSED', '${YM}-21', '${YM}-21')`, vSpares).lastInsertRowid;
run(`INSERT INTO job_parts (job_id, source_type, description, qty, unit_price, is_external_repair)
     VALUES (?, 'grn', 'Bearing set', 2, 1500, 0)`, sparesJob);
run('UPDATE job_cards SET material_cost = 3000, total_cost = 3000 WHERE id = ?', sparesJob);

// Open, with daily work this month -> Pending section.
const openJob = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status)
  VALUES ('2026/9/R/3', ?, 'repair', 'still in the yard', 'IN_PROGRESS')`, vOpen).lastInsertRowid;
run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, hours) VALUES (?, '${YM}-12', 'Anura', 1)`, openJob);

// Closed in a DIFFERENT month, so it is on no section this month -> Other Labour.
const otherJob = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, completed_at, closed_at)
  VALUES ('2026/9/R/4', ?, 'repair', 'finished later', 'CLOSED', '2026-10-05', '2026-10-05')`, vOther).lastInsertRowid;

addLabour(closedJob, 5000);
addLabour(sparesJob, 1800);     // the money that used to vanish
addLabour(openJob, 900);
addLabour(otherJob, 700);

const TOTAL = 5000 + 1800 + 900 + 700;

test('every rupee of the month\'s labour appears on the Repair sheet', async () => {
  const truth = get(`SELECT ROUND(SUM(amount),2) v FROM job_labour WHERE substr(work_date,1,7) = ?`, YM).v;
  assert.strictEqual(truth, TOTAL, 'fixture sanity');

  const { parts } = await report.buildWorkbook(2026, 9);
  assert.strictEqual(parts.repair.sums.labour, TOTAL,
    'the Repair sheet labour total must equal the labour actually worked that month');
});

test('labour on a Spares-Supply job is reported, not swallowed', async () => {
  const { parts } = await report.buildWorkbook(2026, 9);
  // That job is on the Spares section (which shows material only), so its labour has to be
  // picked up by Other Labour instead — never dropped.
  assert.ok(parts.repair.spares_supply_count >= 1, 'the container job is on the Spares section');
  assert.strictEqual(parts.repair.sums.labour, TOTAL);

  // Prove it specifically: remove that job's labour and the total must fall by exactly its share.
  run('DELETE FROM job_labour WHERE job_id = ?', sparesJob);
  const after = (await report.buildWorkbook(2026, 9)).parts.repair.sums.labour;
  assert.strictEqual(after, TOTAL - 1800, 'its Rs 1,800 was being counted, not ignored');
  addLabour(sparesJob, 1800);                       // restore for any later test
});

test('no section counts the same labour twice', async () => {
  const { parts } = await report.buildWorkbook(2026, 9);
  const truth = get(`SELECT ROUND(SUM(amount),2) v FROM job_labour WHERE substr(work_date,1,7) = ?`, YM).v;
  assert.ok(parts.repair.sums.labour <= truth + 0.01,
    'the sheet must never report more labour than was worked');
  assert.ok(parts.repair.sums.labour >= truth - 0.01, 'nor less');
});
