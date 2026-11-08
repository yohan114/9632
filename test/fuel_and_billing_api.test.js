'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { run, get, migrate } = require('../src/db');
const fuelIssue = require('../src/lib/fuel/issue');
const fuelStock = require('../src/lib/fuel/stock');
const calc = require('../src/lib/billing/calc');

test('API Integration: Fuel tank stock, issues, and voiding life-cycle', () => {
  // 1. Ensure migrations are up to date on test DB
  migrate();

  // Create initial tank in fuel_tanks
  run(`
    INSERT OR REPLACE INTO fuel_tanks (
      id, code, name, tank_type, capacity_litres, current_litres, active
    ) VALUES (
      'tank-test-cw', 'CW-MAIN', 'Central Workshop Main Tank', 'FIXED', 10000, 0, 1
    )
  `);

  // Deliver bulk fuel into tank
  const delivery = fuelStock.recordBulkDelivery({
    tankId: 'tank-test-cw',
    litres: 10000,
    fuelType: 'AUTO_DIESEL',
    supplier: 'Ceypetco Kolonnawa',
    invoiceNumber: 'CP-99881',
    costCents: 341000000,
    deliveryDate: '2026-05-01',
    receivedBy: 1,
    note: 'Initial tank fill',
  });

  assert.strictEqual(delivery.litres, 10000);
  assert.strictEqual(delivery.new_balance, 10000);

  const t1 = fuelStock.getTank('tank-test-cw');
  assert.strictEqual(t1.current_litres, 10000);

  // 2. Issue fuel to vehicle
  const issue = fuelIssue.recordIssue({
    assetCode: 'EX-01',
    vehicleRef: 'CAT Excavator 320D',
    litres: 200,
    fuelType: 'AUTO_DIESEL',
    meterReading: 1250.5,
    meterType: 'HOURS',
    issueDate: '2026-05-10 09:30:00',
    sourceTankId: 'tank-test-cw',
    driverName: 'Kamal Perera',
    fuelPriceCents: 34100,
  }, 1);

  assert.strictEqual(issue.litres, 200);
  assert.strictEqual(issue.total_cost_cents, 6820000); // 200 * 34100 = 6,820,000 cents (Rs 68,200.00)

  // Verify tank stock was deducted
  const t2 = fuelStock.getTank('tank-test-cw');
  assert.strictEqual(t2.current_litres, 9800);

  // 3. Void the fuel issue
  const voided = fuelIssue.voidIssue(issue.id, 'Entered wrong meter and vehicle on paper log', 1);
  assert.strictEqual(voided.is_voided, 1);

  // Verify tank stock was restored
  const t3 = fuelStock.getTank('tank-test-cw');
  assert.strictEqual(t3.current_litres, 10000);
});

test('API Integration: Physical dip measurement variance computation', () => {
  // Dip shows 9,950 litres (computed is 10,000 => variance -50)
  const dip = fuelStock.recordDip({
    tankId: 'tank-test-cw',
    dipLitres: 9950,
    recordedBy: 1,
    note: 'Weekly dipstick check',
  });

  assert.strictEqual(dip.dip_litres, 9950);
  assert.strictEqual(dip.computed_balance, 10000);
  assert.strictEqual(dip.variance_litres, -50);

  // Tank current litres now set to verified dip
  const t = fuelStock.getTank('tank-test-cw');
  assert.strictEqual(t.current_litres, 9950);
});

test('API Integration: Machine rental billing calculation with SSCL and VAT', () => {
  const result = calc.calculateRentalBill({
    actualUnits: 150,
    rateBasis: 'w',
    rateCents: 600000, // Rs 6,000.00/hr
    minimumUnits: 100,
    breakdownDays: 0,
    fuelLitres: 250,
    fuelPriceCents: 34100, // Rs 341.00/litre
  });

  assert.strictEqual(result.rentalAmountCents, 90000000); // 150 * 6000.00 = Rs 900,000.00
  assert.strictEqual(result.fuelCostCents, 8525000); // 250 * 341.00 = Rs 85,250.00
  assert.strictEqual(result.subtotalCents, 98525000); // Rs 985,250.00
  assert.strictEqual(result.ssclCents, 2463125); // 2.5% of 98,525,000 = 2,463,125 cents (Rs 24,631.25)
  assert.strictEqual(result.vatCents, 18177863); // 18% of (98,525,000 + 2,463,125 = 100,988,125) = 18,177,863 cents
  assert.strictEqual(result.grandTotalCents, 119165988); // Rs 1,191,659.88
});
