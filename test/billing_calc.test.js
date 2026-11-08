'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../src/lib/billing/calc');

test('Billing Calc: Dry basis hourly calculation with actual hours > minimum', () => {
  // Excavator: 150 hrs actual, 100 hrs min, Rs 3,500/hr (350,000 cents), Dry basis
  // Subtotal = 150 * 350,000 = 52,500,000 cents (Rs 525,000)
  // SSCL = 2.5% = 1,312,500 cents
  // Pre-VAT = 53,812,500 cents
  // VAT = 18% = 9,686,250 cents
  // Grand Total = 63,498,750 cents (Rs 634,987.50)
  const res = calc.computeTotals({
    billingMode: 'hourly',
    rateBasis: 'd',
    rateCents: 350000,
    actualUnits: 150,
    minimumUnits: 100,
    fuelLitres: 450,
    fuelCostCents: 16500000, // Rs 165,000 fuel consumed, but Dry basis so not charged
    ssclRate: 0.025,
    vatRate: 0.18,
  });

  assert.equal(res.billableUnits, 150);
  assert.equal(res.rentalAmountCents, 52500000);
  assert.equal(res.fuelChargedCents, 0, 'Dry basis must not charge fuel to customer');
  assert.equal(res.subtotalCents, 52500000);
  assert.equal(res.ssclCents, 1312500);
  assert.equal(res.vatCents, 9686250);
  assert.equal(res.grandTotalCents, 63498750);
});

test('Billing Calc: Minimum guarantee applies when actual < minimum', () => {
  // Machine worked only 45 hrs, but contract minimum is 100 hrs
  const res = calc.computeTotals({
    billingMode: 'hourly',
    rateBasis: 'd',
    rateCents: 200000, // Rs 2,000/hr
    actualUnits: 45,
    minimumUnits: 100,
    fuelLitres: 0,
    fuelCostCents: 0,
    ssclRate: 0.025,
    vatRate: 0.18,
  });

  assert.equal(res.billableUnits, 100, 'Must bill contract minimum of 100 units');
  assert.equal(res.rentalAmountCents, 20000000); // 100 * 200,000
});

test('Billing Calc: Wet / Fully Wet basis charges fuel on top of rental', () => {
  // Wet basis: rental + fuel consumed is billed
  const res = calc.computeTotals({
    billingMode: 'hourly',
    rateBasis: 'w',
    rateCents: 400000, // Rs 4,000/hr
    actualUnits: 80,
    minimumUnits: 50,
    fuelLitres: 200,
    fuelCostCents: 7400000, // Rs 74,000
    ssclRate: 0.025,
    vatRate: 0.18,
  });

  assert.equal(res.billableUnits, 80);
  assert.equal(res.rentalAmountCents, 32000000); // 80 * 400,000
  assert.equal(res.fuelChargedCents, 7400000, 'Wet basis must recharge fuel');
  assert.equal(res.subtotalCents, 39400000); // 32,000,000 + 7,400,000
  assert.equal(res.ssclCents, Math.round(39400000 * 0.025));
  assert.equal(res.vatCents, Math.round((39400000 + res.ssclCents) * 0.18));
  assert.equal(res.grandTotalCents, 39400000 + res.ssclCents + res.vatCents);
});

test('Billing Calc: Fuel-Only vehicle charges zero rental and full fuel', () => {
  // Privately owned vehicle that E&C fuels but does not rent out
  const res = calc.computeTotals({
    billingMode: 'hourly',
    rateBasis: 'd',
    rateCents: 500000,
    actualUnits: 120,
    minimumUnits: 100,
    fuelLitres: 150,
    fuelCostCents: 5550000, // Rs 55,500
    ssclRate: 0.025,
    vatRate: 0.18,
    fuelOnly: true,
  });

  assert.equal(res.rentalAmountCents, 0, 'Fuel-only vehicle rental amount must be zero');
  assert.equal(res.fuelChargedCents, 5550000);
  assert.equal(res.subtotalCents, 5550000);
});

test('Billing Calc: Cent / LKR conversions and labels', () => {
  assert.equal(calc.centsToLkr(1500000), 15000);
  assert.equal(calc.lkrToCents(15000), 1500000);
  assert.equal(calc.unitLabel('hourly'), 'hr');
  assert.equal(calc.unitLabel('perkm'), 'km');
  assert.equal(calc.unitLabel('perday'), 'day');
  assert.equal(calc.basisLabel('fw'), 'Fully Wet');
  assert.equal(calc.basisLabel('w'), 'Wet');
  assert.equal(calc.basisLabel('d'), 'Dry');
});
