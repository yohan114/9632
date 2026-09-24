'use strict';

const test = require('node:test');
const assert = require('node:assert');
const report = require('../src/lib/monthly_cost_report');
const { get, all } = require('../src/db');

test('new / unpopulated month evaluates strictly to zero values across all sheets', async () => {
  // Use October 2026 (a future month with no entries)
  const { wb, parts, total } = await report.buildWorkbook(2026, 10);

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

  // Verify manual input sheets have NOT carried over from June 2026
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

test('historical data (June 2026) remains 100% preserved and intact', async () => {
  const { parts, total } = await report.buildWorkbook(2026, 6);

  // June 2026 figures must match known historical baseline
  assert.strictEqual(parts.fuel.sums.cost, 584609.2, 'June fuel cost preserved');
  assert.strictEqual(parts.salaries.sums.total, 1382840, 'June salaries total preserved');
  assert.strictEqual(parts.salaries.overhead_total, 622440, 'June overhead staff salary preserved');
  assert.strictEqual(parts.other.sums.total, 68159, 'June other overheads preserved');
  assert.strictEqual(parts.repair.closed_count, 78, 'June closed repairs count preserved');
  assert.strictEqual(parts.service.count, 30, 'June service count preserved');

  // Verify grand total is exact
  assert.ok(Math.abs(total.grand_total - 10316216.33) < 0.01, 'June grand total preserved');
});
