'use strict';

// Two rules about a month's figures, and nothing about any one month's numbers:
//
//   1. a month nobody has entered anything for is strictly zero on every sheet, and
//   2. building that empty month does not disturb a month that does have figures.
//
// Both tests used to read whatever database happened to sit at data/workshopone.db and assert the
// owner's own June 2026 totals (fuel Rs 584,609.20, salaries Rs 1,382,840, 78 closed repairs, and a
// grand total of Rs 10,316,216.33). Those numbers exist only in the live database the real migration
// builds from sources/, so the second test failed on a fresh clone, on a seeded demo database and in
// CI — and the first one was passing by luck, since it only held while the live database happened to
// have nothing in October 2026. So the suite now builds its own month on its own database, the way
// monthly_report_labour.test.js does, and the figures it checks are the figures it entered.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-cost-zero-value-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run } = require('../src/db');
const aliases = require('../src/lib/aliases');
const report = require('../src/lib/monthly_cost_report');

migrate();
require('../src/migrate/015_phase4_erp_gaps').runStep();

// The month with figures in it, and the month with none.
const YEAR = 2026;
const FILLED_MONTH = 6;
const EMPTY_MONTH = 10;

const input = (sheet, seq, cols) =>
  run(`INSERT INTO monthly_report_inputs (year, month, sheet, seq, vehicle, label, project, qty, rate, amount1, amount2, amount3, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    YEAR, FILLED_MONTH, sheet, seq,
    cols.vehicle || null, cols.label || null, cols.project || null, cols.qty || null,
    cols.rate || 0, cols.amount1 || 0, cols.amount2 || 0, cols.amount3 || 0, cols.note || null);

// --- Fuel & Rental: cost is litres x rate, per line. No rental on these lines (ratio 0, note 0).
//     1000 x 310 = 310,000   and   900 x 295 = 265,500.
input('fuel', 1, { vehicle: 'EC-1', label: 'Bowser', qty: '1000', rate: 310, note: '0' });
input('fuel', 2, { vehicle: 'EC-2', label: 'Cab', qty: '900', rate: 295, note: '0' });
const FUEL_COST = 1000 * 310 + 900 * 295; // 575,500
const FUEL_RENTAL = 0;

// --- Salaries: amount1 per person. The first eight lines are the overhead staff (the Salaries sheet
//     reads G6:G13 for the Overhead Staff row on 'Total cost'), the rest are the others.
const OVERHEAD_STAFF = 8, OVERHEAD_RATE = 50000;
const OTHER_STAFF = 2, OTHER_RATE = 75000;
for (let i = 0; i < OVERHEAD_STAFF; i++) {
  input('salary', i + 1, { label: `Overhead staff ${i + 1}`, project: 'Workshop', qty: '26', amount1: OVERHEAD_RATE });
}
for (let i = 0; i < OTHER_STAFF; i++) {
  input('salary', OVERHEAD_STAFF + i + 1, { label: `Other staff ${i + 1}`, project: 'Workshop', qty: '26', amount1: OTHER_RATE });
}
const SALARY_OVERHEAD = OVERHEAD_STAFF * OVERHEAD_RATE;          // 400,000
const SALARY_TOTAL = SALARY_OVERHEAD + OTHER_STAFF * OTHER_RATE; // 550,000

// --- Other (site) overheads: amount1 per line.
const OTHER_LINES = [20000, 15000, 8000];
OTHER_LINES.forEach((amt, i) => input('other', i + 1, { label: `Overhead ${i + 1}`, project: 'Workshop', amount1: amt }));
const OTHER_TOTAL = OTHER_LINES.reduce((a, b) => a + b, 0); // 43,000

// --- Closed repairs: cards closed inside the filled month, which is what the Repair sheet counts.
const CLOSED_REPAIRS = 3;
for (let i = 1; i <= CLOSED_REPAIRS; i++) {
  const assetId = aliases.findOrCreateAsset(`ZV-REP-${i}`, {}).id;
  run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at, completed_at, closed_at)
       VALUES (?, ?, 'repair', ?, 'CLOSED', ?, ?, ?)`,
    `${YEAR}/${FILLED_MONTH}/R/${i}`, assetId, `Repair ${i}`,
    `${YEAR}-06-01`, `${YEAR}-06-1${i}`, `${YEAR}-06-1${i}`);
}

// --- Services: one row per service done in the filled month.
const SERVICES = 2;
for (let i = 1; i <= SERVICES; i++) {
  const assetId = aliases.findOrCreateAsset(`ZV-SVC-${i}`, {}).id;
  run(`INSERT INTO service_jobs (job_no, asset_id, vehicle_label, service_date, labour_charge, grand_total)
       VALUES (?, ?, ?, ?, 0, 0)`,
    `${YEAR}/${FILLED_MONTH}/S/${i}`, assetId, `ZV-SVC-${i}`, `${YEAR}-06-2${i}`);
}

// Only the three overhead sheets carry money here, so the month's grand total is their sum. Nothing
// else was given a cost, which keeps the figure something this file can state rather than discover.
const GRAND_TOTAL = FUEL_COST + FUEL_RENTAL + SALARY_TOTAL + OTHER_TOTAL; // 1,168,500

test('new / unpopulated month evaluates strictly to zero values across all sheets', async () => {
  const { wb, parts, total } = await report.buildWorkbook(YEAR, EMPTY_MONTH);

  // Grand total must be exactly 0
  assert.strictEqual(total.grand_total, 0, 'Grand total of unpopulated month must be 0');

  // Verify all parts have 0 count and 0 totals
  assert.strictEqual(parts.repair.count, 0, 'Repair count must be 0');
  assert.strictEqual(parts.repair.sums.total, 0, 'Repair total must be 0');
  assert.strictEqual(parts.service.count, 0, 'Service count must be 0');
  assert.strictEqual(parts.service.sums.total, 0, 'Service total must be 0');
  assert.strictEqual(parts.battery.count, 0, 'Battery count must be 0');
  assert.strictEqual(parts.battery.sums.total, 0, 'Battery total must be 0');
  assert.strictEqual(parts.tyre.count, 0, 'Tyre count must be 0');
  assert.strictEqual(parts.tyre.sums.total, 0, 'Tyre total must be 0');
  assert.strictEqual(parts.oils.count, 0, 'Oils count must be 0');
  assert.strictEqual(parts.oils.sums.total, 0, 'Oils total must be 0');
  assert.strictEqual(parts.general.count, 0, 'General count must be 0');
  assert.strictEqual(parts.general.sums.total, 0, 'General total must be 0');

  // The manual input sheets must not have carried over from the filled month
  assert.strictEqual(parts.fuel.count, 0, 'Fuel count must be 0');
  assert.strictEqual(parts.fuel.sums.cost, 0, 'Fuel cost must be 0');
  assert.strictEqual(parts.salaries.count, 0, 'Salaries staff count must be 0');
  assert.strictEqual(parts.salaries.sums.total, 0, 'Salaries total must be 0');
  assert.strictEqual(parts.salaries.overhead_total, 0, 'Overhead staff salary must be 0');
  assert.strictEqual(parts.other.count, 0, 'Other overhead count must be 0');
  assert.strictEqual(parts.other.sums.total, 0, 'Other overhead total must be 0');

  // Verify total columns are all 0
  for (const [col, val] of Object.entries(total.columns)) {
    assert.strictEqual(val, 0, `Column ${col} total must be 0`);
  }

  // Verify PROFIT OR LOSS sheet exists and has zero activity headline
  const pl = wb.getWorksheet('PROFIT OR LOSS');
  assert.ok(pl, 'PROFIT OR LOSS worksheet exists');
  const valCell = pl.getCell(8, 2).value;
  assert.strictEqual(valCell.result, 'Rs 0.00', 'Headline value result must be Rs 0.00');
  const stmtCell = pl.getCell(11, 2).value;
  assert.strictEqual(stmtCell.result, 'No workshop activity recorded for this period.');
});

test('a month that has figures reports them back, to the rupee', async () => {
  const { parts, total } = await report.buildWorkbook(YEAR, FILLED_MONTH);

  // Every figure below is the arithmetic on the lines entered above, not a number read off a report.
  assert.strictEqual(parts.fuel.count, 2, 'both fuel lines are on the sheet');
  assert.strictEqual(parts.fuel.sums.cost, FUEL_COST, 'fuel cost is litres x rate, summed');
  assert.strictEqual(parts.fuel.sums.rental, FUEL_RENTAL, 'no rental was entered');
  assert.strictEqual(parts.salaries.count, OVERHEAD_STAFF + OTHER_STAFF, 'every person is on the sheet');
  assert.strictEqual(parts.salaries.sums.total, SALARY_TOTAL, 'salaries total is the sum of the lines');
  assert.strictEqual(parts.salaries.overhead_total, SALARY_OVERHEAD, 'overhead staff are the first eight lines');
  assert.strictEqual(parts.other.count, OTHER_LINES.length, 'every overhead line is on the sheet');
  assert.strictEqual(parts.other.sums.total, OTHER_TOTAL, 'other overheads are the sum of the lines');
  assert.strictEqual(parts.repair.closed_count, CLOSED_REPAIRS, 'the repairs closed this month are counted');
  assert.strictEqual(parts.service.count, SERVICES, 'the services done this month are counted');

  // The overheads are the only money in the month, so they are the month's total.
  assert.strictEqual(total.columns[8], GRAND_TOTAL, 'the overhead column carries fuel + salaries + other');
  assert.strictEqual(total.grand_total, GRAND_TOTAL, 'the grand total is the overheads and nothing else');
});

test('building the empty month leaves the filled month exactly as it was', async () => {
  // The regression the old test was reaching for: the empty-month path must not clear or carry over
  // another month's figures. Build the empty month between two builds of the filled one and compare.
  const before = await report.buildWorkbook(YEAR, FILLED_MONTH);
  await report.buildWorkbook(YEAR, EMPTY_MONTH);
  const after = await report.buildWorkbook(YEAR, FILLED_MONTH);

  const shape = ({ parts, total }) => ({
    fuel: parts.fuel.sums,
    salaries: Object.assign({}, parts.salaries.sums, { overhead_total: parts.salaries.overhead_total }),
    other: parts.other.sums,
    closed_repairs: parts.repair.closed_count,
    services: parts.service.count,
    grand_total: total.grand_total,
  });

  assert.deepStrictEqual(shape(after), shape(before), 'the filled month is unchanged');
  assert.strictEqual(after.total.grand_total, GRAND_TOTAL, 'and it still totals what was entered');
});
