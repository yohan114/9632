'use strict';

/**
 * Pure billing mathematics module — no DB access, 100% deterministic & unit-testable.
 * Replicates the E&C Machine Rental Calculator:
 *   billable = max(actual, minimum)
 *   rentalAmount = fuelOnly ? 0 : round(billable * rate)
 *   fuelCharged = (fuelOnly || basis === 'fw' || basis === 'w') ? fuelCost : 0
 *   subtotal = rentalAmount + fuelCharged
 *   sscl = round(subtotal * ssclRate)
 *   vat = round((subtotal + sscl) * vatRate)
 *   grandTotal = subtotal + sscl + vat
 *
 * All monetary amounts are in integer LKR cents.
 */

const BILLING_MODES = ['hourly', 'perkm', 'perday'];
const RATE_BASES = ['fw', 'w', 'd']; // fw = Fully Wet, w = Wet, d = Dry

/**
 * Compute line totals for vehicle hire & fuel recharge
 * @param {Object} input
 * @param {string} input.billingMode - 'hourly' | 'perkm' | 'perday'
 * @param {string} input.rateBasis - 'fw' | 'w' | 'd'
 * @param {number} input.rateCents - rate in LKR cents
 * @param {number} input.actualUnits - actual working hours / km / days
 * @param {number} input.minimumUnits - guaranteed contractual minimum units
 * @param {number} input.fuelLitres - consumed fuel volume in litres
 * @param {number} input.fuelCostCents - cost of consumed fuel in LKR cents
 * @param {number} input.ssclRate - Social Security Contribution Levy (e.g. 0.025 for 2.5%)
 * @param {number} input.vatRate - Value Added Tax rate (e.g. 0.18 for 18%)
 * @param {boolean} [input.fuelOnly=false] - true if vehicle is privately owned / unrented
 * @returns {Object} Computed line totals in LKR cents
 */
function computeTotals(input) {
  const actual = Number(input.actualUnits) || 0;
  const minimum = Number(input.minimumUnits) || 0;
  const rate = Number(input.rateCents) || 0;
  const fuelCost = Number(input.fuelCostCents) || 0;
  const ssclRate = Number(input.ssclRate) || 0;
  const vatRate = Number(input.vatRate) || 0;
  const fuelOnly = Boolean(input.fuelOnly);
  const basis = String(input.rateBasis || 'd').toLowerCase();

  const billableUnits = Math.max(actual, minimum);
  const rentalAmountCents = fuelOnly ? 0 : Math.round(billableUnits * rate);

  // E&C supplies fuel whenever a driver is provided (Fully Wet or Wet), so
  // issued fuel is billed on top of rental.
  // On Dry basis, the customer self-fuels, so fuel is not billed.
  // A fuel-only vehicle is always billed its issued fuel.
  const fuelChargedCents = (fuelOnly || basis === 'fw' || basis === 'w') ? fuelCost : 0;

  const subtotalCents = rentalAmountCents + fuelChargedCents;
  const ssclCents = Math.round(subtotalCents * ssclRate);
  const preVatCents = subtotalCents + ssclCents;
  const vatCents = Math.round(preVatCents * vatRate);
  const grandTotalCents = preVatCents + vatCents;

  return {
    billableUnits,
    rentalAmountCents,
    fuelChargedCents,
    subtotalCents,
    ssclCents,
    vatCents,
    grandTotalCents,
  };
}

/**
 * High-level rental bill generator adapter
 */
function calculateRentalBill(input) {
  const actual = Number(input.actualUnits) || 0;
  const minimum = Number(input.minimumUnits) || 0;
  const rate = Number(input.rateCents) || 0;
  const fuelLitres = Number(input.fuelLitres) || 0;
  const fuelPrice = Number(input.fuelPriceCents) || 34100;
  const fuelCost = Math.round(fuelLitres * fuelPrice);
  const ssclRate = input.ssclRate !== undefined ? Number(input.ssclRate) : 0.025;
  const vatRate = input.vatRate !== undefined ? Number(input.vatRate) : 0.18;
  const bRaw = String(input.rateBasis || input.basis || 'd').toLowerCase();
  const basis = bRaw === 'wet' || bRaw === 'w' ? 'w' : (bRaw === 'fully_wet' || bRaw === 'fw' ? 'fw' : 'd');
  const fuelOnly = Boolean(input.fuelOnly);

  const res = computeTotals({
    billingMode: input.billingMode || 'hourly',
    rateBasis: basis,
    rateCents: rate,
    actualUnits: actual,
    minimumUnits: minimum,
    fuelLitres,
    fuelCostCents: fuelCost,
    ssclRate,
    vatRate,
    fuelOnly,
  });

  return {
    ...res,
    actualUnits: actual,
    minimumUnits: minimum,
    fuelLitres,
    fuelCostCents: fuelCost,
    ssclRate,
    vatRate,
    breakdownDays: Number(input.breakdownDays) || 0,
    breakdownDeductCents: 0,
  };
}

/** Convert integer LKR cents to decimal Rupees */
function centsToLkr(cents) {
  return (Number(cents) || 0) / 100;
}

/** Convert decimal Rupees to integer LKR cents */
function lkrToCents(lkr) {
  return Math.round((Number(lkr) || 0) * 100);
}

/** Human-readable unit label */
function unitLabel(mode) {
  return mode === 'perkm' ? 'km' : mode === 'perday' ? 'day' : 'hr';
}

/** Human-readable basis label */
function basisLabel(basis) {
  const b = String(basis || '').toLowerCase();
  return b === 'fw' ? 'Fully Wet' : b === 'w' ? 'Wet' : 'Dry';
}

/** Human-readable mode label */
function modeLabel(mode) {
  return mode === 'perkm' ? 'Per-KM' : mode === 'perday' ? 'Per-Day' : 'Hourly';
}

module.exports = {
  BILLING_MODES,
  RATE_BASES,
  computeTotals,
  calculateRentalBill,
  centsToLkr,
  lkrToCents,
  unitLabel,
  basisLabel,
  modeLabel,
};
