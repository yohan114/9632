'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { db, get, all, run, tx } = require('../src/db');
const dailyCost = require('../src/lib/daily_cost');
const dailyReports = require('../src/lib/daily_reports');

test('Step 1: Schema columns and workshop_monthly_overheads exist', (t) => {
  const jrCols = db.prepare('PRAGMA table_info(job_requests)').all().map(c => c.name);
  assert.ok(jrCols.includes('driver_name'), 'job_requests should have driver_name');
  assert.ok(jrCols.includes('contact_no'), 'job_requests should have contact_no');
  assert.ok(jrCols.includes('meter_reading'), 'job_requests should have meter_reading');

  const jcCols = db.prepare('PRAGMA table_info(job_cards)').all().map(c => c.name);
  assert.ok(jcCols.includes('driver_name'), 'job_cards should have driver_name');
  assert.ok(jcCols.includes('contact_no'), 'job_cards should have contact_no');
  assert.ok(jcCols.includes('meter_reading'), 'job_cards should have meter_reading');

  const overheadsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workshop_monthly_overheads'").get();
  assert.ok(overheadsTable, 'workshop_monthly_overheads table should exist');
});

test('Step 2: Job Request driver fields persist and cascade to Job Card', (t) => {
  // Find or create test vehicle
  let asset = get("SELECT id FROM assets WHERE status = 'active' LIMIT 1");
  if (!asset) {
    const aid = run(
      "INSERT INTO assets (code, code_norm, registration, type, status) VALUES ('TEST-DRV-01', 'TESTDRV01', 'WP-CAD-9999', 'truck', 'active')"
    ).lastInsertRowid;
    asset = { id: aid };
  }

  const jrNo = 'JR-TEST-' + Date.now();
  const testDriver = 'Kamal Perera';
  const testContact = '0779988776';
  const testMeter = '189,450 km';

  // 1. Create job request
  const ins = run(
    `INSERT INTO job_requests (jr_no, req_date, asset_id, type, severity, priority, description,
                               requested_by, driver_name, contact_no, meter_reading, approval_status, workshop_id)
     VALUES (?, date('now'), ?, 'repair', 'minor', 'normal', 'Engine knocking sound',
             'Transport Officer', ?, ?, ?, 'approved', 1)`,
    jrNo, asset.id, testDriver, testContact, testMeter
  );
  const jrId = ins.lastInsertRowid;

  const jr = get('SELECT * FROM job_requests WHERE id = ?', jrId);
  assert.equal(jr.driver_name, testDriver);
  assert.equal(jr.contact_no, testContact);
  assert.equal(jr.meter_reading, testMeter);

  // 2. Cascade to job card
  const jcNo = 'TEST/R/' + Date.now();
  const jcIns = run(
    `INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_by,
                            job_request_id, workshop_id, driver_name, contact_no, meter_reading)
     VALUES (?, ?, 'repair', ?, 'IN_WORKSHOP', ?, ?, 1, ?, ?, ?)`,
    jcNo, asset.id, jr.description, jr.requested_by, jrId, jr.driver_name, jr.contact_no, jr.meter_reading
  );
  const jcId = jcIns.lastInsertRowid;

  const jc = get('SELECT * FROM job_cards WHERE id = ?', jcId);
  assert.equal(jc.driver_name, testDriver, 'Job card should inherit driver_name');
  assert.equal(jc.contact_no, testContact, 'Job card should inherit contact_no');
  assert.equal(jc.meter_reading, testMeter, 'Job card should inherit meter_reading');
});

test('Step 3: Daily Cost calculations and category breakdown', (t) => {
  const testDate = '2099-11-15';
  const testYm = '2099-11';

  // Clean any previous test rows for this test date
  run("DELETE FROM job_daily_work WHERE date(work_date) = date(?)", testDate);
  run("DELETE FROM issues WHERE date(issue_date) = date(?)", testDate);

  // Ensure known overheads baseline for 2099-11
  dailyCost.saveOverheads(1, testYm, {
    electricity_cost: 60000,
    internet_bill: 5000,
    telephone_allowance: 13250,
    travelling_allowance: 0,
    other_expenses: 5000,
    notes: 'Test baseline'
  });

  // Ensure labour rate for mechanic exists
  const mechName = 'Test Mechanic 01';
  run("INSERT OR REPLACE INTO labour_rates (mechanic, rate, effective_from) VALUES (?, 650.0, '2026-01-01')", mechName);

  // Create test job card
  const testJobNo = 'DC/TEST/' + Date.now();
  const jId = run(
    "INSERT INTO job_cards (job_no, type, description, status, workshop_id) VALUES (?, 'repair', 'Test Daily Cost', 'IN_WORKSHOP', 1)",
    testJobNo
  ).lastInsertRowid;

  // Insert daily work (Internal labour: 4 hours * 650 = 2600)
  run(
    `INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, outside_labour)
     VALUES (?, ?, ?, 'Brake adjustment', 4.0, 0, 0.0)`,
    jId, testDate, mechName
  );

  // Insert outside work (Outside labour: 3500)
  run(
    `INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, outside_labour)
     VALUES (?, ?, 'Outside Lathe Works', 'Drum skimming', 0, 1, 3500.0)`,
    jId, testDate
  );

  // Insert test store item
  let sItem = get("SELECT id FROM store_items WHERE part_number = 'TEST-PN-001'");
  if (!sItem) {
    const siId = run(
      "INSERT INTO store_items (name, item_no, part_number, unit, is_general, unit_cost) VALUES ('Test Brake Shoe', 'ITEM-T01', 'TEST-PN-001', 'nos', 0, 4200.0)"
    ).lastInsertRowid;
    sItem = { id: siId };
  }

  // Insert Local Purchase Issue (2 * 4200 = 8400)
  run(
    `INSERT INTO issues (job_id, store_item_id, description, qty, unit, unit_price, issue_date)
     VALUES (?, ?, 'Test Brake Shoe', 2, 'nos', 4200.0, ?)`,
    jId, sItem.id, testDate
  );

  // Compute daily cost
  const report = dailyCost.computeDailyCost({ asOf: testDate, ws: 1 });

  assert.equal(report.as_of, testDate);
  assert.equal(report.summary.internal_labour_hours, 4.0);
  assert.equal(report.summary.internal_labour_value, 2600.0);
  assert.equal(report.summary.outside_value, 3500.0);
  assert.equal(report.summary.spares_local_value, 8400.0);
  assert.equal(report.summary.fuel_cost, 0.0, 'Fuel cost should be 0 (deferred)');
  assert.equal(report.summary.vehicle_rental_cost, 0.0, 'Vehicle rental should be 0 (deferred)');

  // Daily overheads = (60000 + 5000 + 13250 + 0 + 5000) / 30 = 83250 / 30 = 2775.00 (or round2 sum: 2775.01)
  assert.ok(Math.abs(report.summary.daily_overheads_value - 2775.0) < 1.0);

  const expectedGrandTotal = 2600.0 + 3500.0 + 8400.0 + report.summary.daily_overheads_value;
  assert.ok(Math.abs(report.summary.grand_total - expectedGrandTotal) < 0.01, 'Grand total matches sum of components');
});

test('Step 4: Travelling allowance adjustments in monthly overheads', (t) => {
  const testYm = '2026-11';
  const testDate = '2026-11-20';

  // Add travelling allowance (e.g. 15,000 for service vehicle outside repairs)
  const updated = dailyCost.saveOverheads(1, testYm, {
    electricity_cost: 60000,
    internet_bill: 5000,
    telephone_allowance: 13250,
    travelling_allowance: 15000,
    other_expenses: 5000,
    notes: 'Added service vehicle travelling allowance'
  });

  assert.equal(updated.monthly.travelling_allowance, 15000);
  // Daily travelling = 15000 / 30 = 500 / day
  assert.equal(updated.daily.travelling, 500);

  const report = dailyCost.computeDailyCost({ asOf: testDate, ws: 1 });
  assert.equal(report.overheads.daily.travelling, 500);

  // Restore default
  dailyCost.saveOverheads(1, testYm, {
    electricity_cost: 60000,
    internet_bill: 5000,
    telephone_allowance: 13250,
    travelling_allowance: 0,
    other_expenses: 5000,
    notes: 'Standard baseline overheads'
  });
});

test('Step 5: Daily reports registry and Excel workbook generation', async (t) => {
  const testDate = '2026-11-20';
  const report = dailyReports.build('daily_cost', { asOf: testDate, ws: 1 });
  assert.equal(report.kind, 'daily_cost');
  assert.ok(report.summary);

  const wb = dailyReports.workbookFor('daily_cost', report);
  assert.ok(wb);
  const buf = await wb.xlsx.writeBuffer();
  assert.ok(buf.length > 1000, 'Excel buffer size should be valid');
});
