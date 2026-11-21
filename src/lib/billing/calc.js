'use strict';

/**
 * Pure billing mathematics module — no DB access, 100% deterministic & unit-testable.
 * Replicates the E&C Machine Rental Calculator:
 *   billable = max(actual, minimum)
 *   rentalAmount = fuelOnly ? 0 : round(billable * rate)
 *   fuelCharged = (fuelOnly || basis === 'fw' || basis === 'w') ? fuelCost : 0
 *   breakdownDeduct = computed deduction for unbillable downtime days
 *   subtotal = max(0, rentalAmount + fuelCharged - breakdownDeduct)
 *   sscl = round(subtotal * ssclRate)
 *   vat = round((subtotal + sscl) * vatRate)
 *   grandTotal = subtotal + sscl + vat
 *
 * All monetary amounts are in integer LKR cents.
 */

const BILLING_MODES = ['hourly', 'perkm', 'perday', 'monthly', 'flat'];
const RATE_BASES = ['fw', 'w', 'd']; // fw = Fully Wet, w = Wet, d = Dry / Dry with Driver
const WORKING_DAYS_PER_MONTH = 25;

function defaultMinUnitsForMode(mode, workingDays = WORKING_DAYS_PER_MONTH) {
  const m = normalizeUnitMode(mode);
  if (m === 'perkm') return 3000;
  if (m === 'hourly') return 120;
  if (m === 'perday') return Math.max(1, Number(workingDays) || WORKING_DAYS_PER_MONTH);
  return 0;
}

const HIRE_BASIS_SET = new Set([
  'dry', 'dry_with_driver', 'd',
  'wet', 'w',
  'fully_wet', 'fully-wet', 'fw',
  'fuel_only', 'fuel-only',
]);

const UNIT_MODE_MAP = {
  hourly: 'hourly',
  per_hr: 'hourly',
  km: 'perkm',
  perkm: 'perkm',
  per_km: 'perkm',
  daily: 'perday',
  perday: 'perday',
  per_day: 'perday',
  monthly: 'monthly',
  flat: 'flat',
};

function normalizeHireBasis(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'wet' || s === 'w') return 'w';
  if (s === 'fully_wet' || s === 'fully-wet' || s === 'fw') return 'fw';
  if (s === 'fuel_only' || s === 'fuel-only') return 'fuel_only';
  return 'd';
}

function normalizeUnitMode(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return UNIT_MODE_MAP[s] || 'hourly';
}

/**
 * Compute line totals for vehicle hire & fuel recharge
 * @param {Object} input
 * @returns {Object} Computed line totals in LKR cents
 */
function computeTotals(input) {
  const actual = Number(input.actualUnits) || 0;
  const fuelOnly = Boolean(input.fuelOnly);
  const basis = normalizeHireBasis(input.rateBasis || 'd');
  const unitMode = normalizeUnitMode(input.billingMode || 'hourly');
  const workingDays = Math.max(1, Number(input.workingDaysInMonth) || WORKING_DAYS_PER_MONTH);
  const breakdownDays = Math.max(0, Number(input.breakdownDays) || 0);
  const clampedDays = Math.min(breakdownDays, workingDays);

  const rawMin = input.minimumUnits;
  const minimum = (rawMin !== undefined && rawMin !== null)
    ? (Number(rawMin) || 0)
    : (unitMode === 'hourly' ? 120 : (unitMode === 'perkm' ? 3000 : 0));
  const rate = Number(input.rateCents) || 0;
  const fuelCost = Number(input.fuelCostCents) || 0;
  const ssclRate = input.ssclRate !== undefined ? Number(input.ssclRate) : 0;
  const vatRate = input.vatRate !== undefined ? Number(input.vatRate) : 0;

  const billableUnits = Math.max(actual, minimum);
  const rentalAmountCents = fuelOnly ? 0 : Math.round(billableUnits * rate);

  // E&C supplies fuel whenever fuel is included/recharged (Fully Wet or Wet).
  // On Dry / Dry with Driver, the customer self-fuels, so fuel is not billed.
  // A fuel-only vehicle is always billed its issued fuel.
  const fuelChargedCents = (fuelOnly || basis === 'fw' || basis === 'w') ? fuelCost : 0;

  // Breakdown deduction: deduct (breakdownDays / 25 working days) of monthly commitment / daily rental.
  let breakdownDeductCents = 0;
  let breakdownDeductUnits = 0;
  if (input.breakdownDeductCents != null) {
    breakdownDeductCents = Math.min(rentalAmountCents, Math.max(0, Math.round(Number(input.breakdownDeductCents) || 0)));
  } else if (clampedDays > 0 && !fuelOnly && rentalAmountCents > 0) {
    if (unitMode === 'perday') {
      breakdownDeductUnits = clampedDays;
      breakdownDeductCents = Math.min(rentalAmountCents, Math.round(clampedDays * rate));
    } else {
      const baseMinUnits = minimum > 0
        ? minimum
        : (unitMode === 'hourly' ? 120 : (unitMode === 'perkm' ? 3000 : 0));
      if (baseMinUnits > 0) {
        breakdownDeductUnits = Math.round((baseMinUnits * (clampedDays / workingDays)) * 100) / 100;
        breakdownDeductCents = Math.min(rentalAmountCents, Math.round((baseMinUnits * (clampedDays / workingDays)) * rate));
      } else {
        breakdownDeductCents = Math.min(rentalAmountCents, Math.round(rentalAmountCents * (clampedDays / workingDays)));
      }
    }
  }

  const netRentalAmountCents = Math.max(0, rentalAmountCents - breakdownDeductCents);
  const subtotalCents = Math.max(0, netRentalAmountCents + fuelChargedCents);
  const ssclCents = Math.round(subtotalCents * ssclRate);
  const preVatCents = subtotalCents + ssclCents;
  const vatCents = Math.round(preVatCents * vatRate);
  const grandTotalCents = preVatCents + vatCents;

  return {
    billableUnits,
    minimumUnitsUsed: minimum,
    workingDaysInMonth: workingDays,
    workingDaysBilled: Math.max(0, workingDays - clampedDays),
    breakdownDeductUnits,
    rentalAmountCents,
    netRentalAmountCents,
    fuelChargedCents,
    breakdownDeductCents,
    subtotalCents,
    ssclCents,
    vatCents,
    grandTotalCents,
  };
}

/**
 * High-level rental bill generator adapter.
 * Accepts either Fuel-System-V2 order (billingMode='hourly', rateBasis='w')
 * or WorkshopOne hire_billing order (billingMode='DRY_WITH_DRIVER'|'WET', rateBasis='HOURLY'|'DAILY').
 */
function calculateRentalBill(input) {
  const actual = Number(input.actualUnits) || 0;
  const rate = Number(input.rateCents) || 0;
  const fuelLitres = Number(input.fuelLitres) || 0;
  const fuelPrice = Number(input.fuelPriceCents) || 34100;
  const fuelCost = Math.round(fuelLitres * fuelPrice);
  const ssclRate = input.ssclRate !== undefined ? Number(input.ssclRate) : 0.025;
  const vatRate = input.vatRate !== undefined ? Number(input.vatRate) : 0.18;
  const breakdownDays = Math.max(0, Number(input.breakdownDays) || 0);
  const workingDaysInMonth = Math.max(1, Number(input.workingDaysInMonth) || WORKING_DAYS_PER_MONTH);
  const daysInMonth = Math.max(1, Number(input.daysInMonth) || 30);

  const bmLower = String(input.billingMode || '').trim().toLowerCase();
  const rbLower = String(input.rateBasis || '').trim().toLowerCase();

  let rawHireBasis = input.basis;
  if (!rawHireBasis) {
    if (HIRE_BASIS_SET.has(bmLower)) rawHireBasis = bmLower;
    else if (HIRE_BASIS_SET.has(rbLower)) rawHireBasis = rbLower;
    else rawHireBasis = 'd';
  }

  let rawUnitMode = 'hourly';
  if (UNIT_MODE_MAP[rbLower]) rawUnitMode = rbLower;
  else if (UNIT_MODE_MAP[bmLower]) rawUnitMode = bmLower;

  const normalizedBasis = normalizeHireBasis(rawHireBasis);
  const fuelOnly = Boolean(input.fuelOnly) || normalizedBasis === 'fuel_only';
  const basis = normalizedBasis === 'fuel_only' ? 'd' : normalizedBasis;
  const unitMode = normalizeUnitMode(rawUnitMode);

  const minimum = input.minimumUnits != null
    ? (Number(input.minimumUnits) || 0)
    : (unitMode === 'hourly' ? 120 : (unitMode === 'perkm' ? 3000 : 0));

  const res = computeTotals({
    billingMode: unitMode,
    rateBasis: basis,
    rateCents: rate,
    actualUnits: actual,
    minimumUnits: minimum,
    fuelLitres,
    fuelCostCents: fuelCost,
    ssclRate,
    vatRate,
    fuelOnly,
    breakdownDays,
    workingDaysInMonth,
    daysInMonth,
    breakdownDeductCents: input.breakdownDeductCents,
  });

  return {
    ...res,
    actualUnits: actual,
    minimumUnits: res.minimumUnitsUsed,
    fuelLitres,
    fuelCostCents: fuelCost,
    ssclRate,
    vatRate,
    breakdownDays,
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
  const m = normalizeUnitMode(mode);
  return m === 'perkm' ? 'km' : m === 'perday' ? 'day' : m === 'monthly' ? 'month' : 'hr';
}

/** Human-readable basis label */
function basisLabel(basis) {
  const b = String(basis || '').trim().toLowerCase();
  if (b === 'fw' || b === 'fully_wet' || b === 'fully-wet') return 'Fully Wet';
  if (b === 'w' || b === 'wet') return 'Wet';
  if (b === 'dry_with_driver') return 'Dry with Driver';
  if (b === 'fuel_only' || b === 'fuel-only') return 'Fuel Only';
  return 'Dry';
}

/** Human-readable mode label */
function modeLabel(mode) {
  const m = normalizeUnitMode(mode);
  return m === 'perkm' ? 'Per-KM' : m === 'perday' ? 'Per-Day' : m === 'monthly' ? 'Monthly' : 'Hourly';
}

module.exports = {
  BILLING_MODES,
  RATE_BASES,
  WORKING_DAYS_PER_MONTH,
  defaultMinUnitsForMode,
  normalizeHireBasis,
  normalizeUnitMode,
  computeTotals,
  calculateRentalBill,
  centsToLkr,
  lkrToCents,
  unitLabel,
  basisLabel,
  modeLabel,
};
