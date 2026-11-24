'use strict';

/**
 * Machine Hire, Costing Options, Rates, Consumption Bands, Allocator,
 * Breakdown Monitoring & Billing API Routes
 *
 * Mounts at /api/hire (and /api/billing alias)
 */

const express = require('express');
const router = express.Router();

const { get, all, run, tx } = require('../db');
const { requireAuth, requireCap } = require('../lib/auth');
const { asyncHandler } = require('../lib/http');
const calc = require('../lib/billing/calc');
const breakdowns = require('../lib/billing/breakdowns');
const fuelTimeline = require('../lib/billing/fuel_timeline');
const siteSummary = require('../lib/billing/site_summary');
const siteSummaryDoc = require('../lib/billing/site_summary_document');
const periodLocks = require('../lib/billing/period_locks');
const { sendPdf } = require('../lib/pdf_generator');
const { sendXlsx } = require('../lib/export');
const v2Engine = require('../lib/fuel/v2_engine');
const fuelIssue = require('../lib/fuel/issue');
const audit = require('../lib/audit');
const identity = require('../lib/fleet_identity');

const ALLOWED_ALLOC_BASES = new Set([
  'DRY_WITH_DRIVER', 'DRY', 'WET', 'FULLY_WET', 'FUEL_ONLY', 'BILLED_DIRECT', 'FREE_OF_CHARGE',
]);
const ALLOWED_RATE_BASES = new Set(['HOURLY', 'DAILY', 'MONTHLY', 'KM', 'FLAT']);

function logAudit(req, entity, entityId, action, after = null, before = null, reason = null) {
  try {
    audit.record({
      userId: req.user ? req.user.id : null,
      entity,
      entityId: Number.isFinite(Number(entityId)) ? Number(entityId) : null,
      action,
      before,
      after,
      reason,
    });
  } catch (_) {}
}

function currentMonthKey() {
  return breakdowns.todayStr().slice(0, 7);
}

function normalizeRateBasis(raw) {
  const s = String(raw || 'HOURLY').trim().toUpperCase();
  if (s === 'PER_KM' || s === 'PERKM') return 'KM';
  if (s === 'PER_DAY' || s === 'PERDAY') return 'DAILY';
  if (s === 'PER_HR' || s === 'PERHR') return 'HOURLY';
  return ALLOWED_RATE_BASES.has(s) ? s : 'HOURLY';
}

function normalizeAllocBasis(raw, fallback = 'DRY_WITH_DRIVER') {
  const s = String(raw || fallback).trim().toUpperCase();
  return ALLOWED_ALLOC_BASES.has(s) ? s : fallback;
}

function expandMonths(fromYm, toYm) {
  const m1 = /^(\d{4})-(\d{2})$/.exec(String(fromYm || '').trim());
  const m2 = /^(\d{4})-(\d{2})$/.exec(String(toYm || fromYm || '').trim());
  if (!m1 || !m2) return [];
  let y = Number(m1[1]);
  let m = Number(m1[2]);
  const endY = Number(m2[1]);
  const endM = Number(m2[2]);
  if (y > endY || (y === endY && m > endM)) return [];
  const list = [];
  for (let i = 0; i < 36; i++) {
    list.push(`${y}-${String(m).padStart(2, '0')}`);
    if (y === endY && m === endM) break;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return list;
}

function dayBefore(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function lastDayOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${ym}-${String(last).padStart(2, '0')}`;
}

const WORKING_DAYS_PER_MONTH = calc.WORKING_DAYS_PER_MONTH || 25;

function resolveDefaultMinUnits(rateBasis, rateCard = null) {
  if (rateCard && Number(rateCard.min_bill_hours) > 0) {
    return Number(rateCard.min_bill_hours);
  }
  const rb = normalizeRateBasis(rateBasis);
  if (rb === 'KM') return 3000;
  if (rb === 'HOURLY') return 120;
  return 0;
}

function pickRateForMode(rateCard, billingMode) {
  if (!rateCard) return 0;
  const b = String(billingMode || 'DRY_WITH_DRIVER').toUpperCase();
  if (b === 'FUEL_ONLY') return 0;

  const isPort =
    String(rateCard.equip_type || '').toUpperCase() === 'PORTABLE' ||
    String(rateCard.rate_basis || '').toUpperCase() === 'DAILY';
  const isKm =
    !isPort &&
    (String(rateCard.rate_basis || '').toUpperCase() === 'KM' ||
      (String(rateCard.fuel_cons_basis || '').toLowerCase() === 'km' &&
        (Number(rateCard.km_wet_cents) > 0 || Number(rateCard.km_dry_cents) > 0)));

  if (isPort) {
    if (b === 'FULLY_WET' || b === 'WET') {
      return rateCard.port_dw_cents || rateCard.wet_rate_cents || rateCard.port_dd_cents || rateCard.dry_rate_cents || rateCard.rate_cents || 0;
    }
    return rateCard.port_dd_cents || rateCard.dry_rate_cents || rateCard.rate_cents || rateCard.port_dw_cents || 0;
  }

  if (isKm) {
    if (b === 'FULLY_WET') {
      return rateCard.km_fw_cents || rateCard.fully_wet_rate_cents || rateCard.km_wet_cents || rateCard.wet_rate_cents || rateCard.km_dry_cents || rateCard.dry_rate_cents || rateCard.rate_cents || 0;
    }
    if (b === 'WET') {
      return rateCard.km_wet_cents || rateCard.wet_rate_cents || rateCard.km_dry_cents || rateCard.dry_rate_cents || rateCard.rate_cents || 0;
    }
    return rateCard.km_dry_cents || rateCard.dry_rate_cents || rateCard.rate_cents || rateCard.km_wet_cents || 0;
  }

  if (b === 'FULLY_WET') return rateCard.fully_wet_rate_cents || rateCard.wet_rate_cents || rateCard.dry_rate_cents || rateCard.rate_cents || 0;
  if (b === 'WET') return rateCard.wet_rate_cents || rateCard.dry_rate_cents || rateCard.rate_cents || 0;
  return rateCard.dry_rate_cents || rateCard.rate_cents || 0;
}

function resolvePeriodFuelPriceCents({ litres = 0, totalFuelCostCents = 0, asOfDate = null, explicitCents = null } = {}) {
  if (explicitCents != null && explicitCents !== '' && Number(explicitCents) > 0) {
    return Math.round(Number(explicitCents));
  }
  if (Number(litres) > 0 && Number(totalFuelCostCents) > 0) {
    return Math.round(Number(totalFuelCostCents) / Number(litres));
  }
  return fuelIssue.getCurrentPrice('AUTO_DIESEL', asOfDate);
}

function overlapDays(startA, endA, startB, endB) {
  const s = startA > startB ? startA : startB;
  const e = endA < endB ? endA : endB;
  if (!s || !e || e < s) return 0;
  return breakdowns.daysBetweenInclusive(s, e);
}

function syncBillCoreLineItems({ billId, billingMode, rateBasis, rateCents, calculation, fuelPriceCents }) {
  run("DELETE FROM fleet_bill_line_items WHERE bill_id = ? AND item_type IN ('RENTAL', 'FUEL', 'BREAKDOWN_DEDUCT')", billId);

  run(`
    INSERT INTO fleet_bill_line_items (
      id, bill_id, item_type, description, quantity, unit_price_cents, amount_cents, is_deduction
    ) VALUES (?, ?, 'RENTAL', ?, ?, ?, ?, 0)
  `, `li-${billId}-rental`, billId,
     `Machine Hire Rental (${calculation.billableUnits} ${String(rateBasis).toLowerCase()} · ${calc.basisLabel(billingMode)})`,
     calculation.billableUnits, Number(rateCents) || 0, calculation.rentalAmountCents);

  if (calculation.fuelChargedCents > 0) {
    run(`
      INSERT INTO fleet_bill_line_items (
        id, bill_id, item_type, description, quantity, unit_price_cents, amount_cents, is_deduction
      ) VALUES (?, ?, 'FUEL', ?, ?, ?, ?, 0)
    `, `li-${billId}-fuel`, billId,
       `Fuel Recharge (${calculation.fuelLitres} Litres @ Rs ${(Number(fuelPriceCents) / 100).toFixed(2)})`,
       calculation.fuelLitres, Number(fuelPriceCents), calculation.fuelChargedCents);
  }

  if (calculation.breakdownDeductCents > 0) {
    run(`
      INSERT INTO fleet_bill_line_items (
        id, bill_id, item_type, description, quantity, unit_price_cents, amount_cents, is_deduction
      ) VALUES (?, ?, 'BREAKDOWN_DEDUCT', ?, ?, ?, ?, 1)
    `, `li-${billId}-bd`, billId,
       `Breakdown Deduction (${calculation.breakdownDays} days)`,
       calculation.breakdownDays, Math.round(calculation.breakdownDeductCents / Math.max(1, calculation.breakdownDays)),
       calculation.breakdownDeductCents);
  }
}

function syncBillFinalFinancialEvents({ billId, assetId, assetCode, projectId, periodEnd, year, month, calculation }) {
  const eventKey = `FIN-REV-RENTAL-${billId}`;
  run(`
    INSERT OR REPLACE INTO fleet_financial_events (
      id, event_key, event_type, asset_id, asset_code, project_id, business_date,
      year, month, amount_cents, quantity, unit, source_system, source_table, source_id
    ) VALUES (
      ?, ?, 'REVENUE_RENTAL', ?, ?, ?, ?,
      ?, ?, ?, ?, 'HOURS', 'WORKSHOPONE', 'fleet_bills', ?
    )
  `, eventKey, eventKey, assetId, assetCode, projectId || null,
     periodEnd, year, month, calculation.rentalAmountCents,
     calculation.billableUnits, billId);

  const fuelRevKey = `FIN-REV-FUEL-${billId}`;
  if (calculation.fuelChargedCents > 0) {
    run(`
      INSERT OR REPLACE INTO fleet_financial_events (
        id, event_key, event_type, asset_id, asset_code, project_id, business_date,
        year, month, amount_cents, quantity, unit, source_system, source_table, source_id
      ) VALUES (
        ?, ?, 'REVENUE_FUEL', ?, ?, ?, ?,
        ?, ?, ?, ?, 'LITRES', 'WORKSHOPONE', 'fleet_bills', ?
      )
    `, fuelRevKey, fuelRevKey, assetId, assetCode, projectId || null,
       periodEnd, year, month, calculation.fuelChargedCents,
       calculation.fuelLitres, billId);
  } else {
    run('DELETE FROM fleet_financial_events WHERE event_key = ?', fuelRevKey);
  }
}

function insertGeneratedBill({
  billId,
  invoiceNumber = null,
  status = 'DRAFT',
  period,
  asset,
  assetCode,
  project,
  driverName = null,
  billingMode,
  rateBasis,
  rateCents,
  openingMeter = null,
  closingMeter = null,
  calculation,
  fuelPriceCents = null,
  notes = null,
  actorId = 1,
}) {
  const assetId = asset ? asset.id : null;
  const issuedDate = status === 'FINAL' ? breakdowns.todayStr() : null;
  const resolvedFuelPriceCents = fuelPriceCents != null && Number(fuelPriceCents) > 0
    ? Number(fuelPriceCents)
    : resolvePeriodFuelPriceCents({ asOfDate: period && period.end });

  run(`
    INSERT INTO fleet_bills (
      id, invoice_number, year, month, period_key, period_start, period_end,
      asset_id, asset_code, asset_reg_no, driver_name, project_id, project_name, project_code,
      billing_mode, rate_basis, rate_cents, opening_meter, closing_meter,
      actual_units, minimum_units, billable_units, rental_amount_cents,
      fuel_litres, fuel_cost_cents, breakdown_days, breakdown_deduct_cents,
      subtotal_cents, sscl_rate, sscl_cents, vat_rate, vat_cents, grand_total_cents,
      status, issued_date, approved_by, approved_at, notes, generated_by
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
  `, billId, invoiceNumber, period.year, period.month, period.periodKey, period.start, period.end,
     assetId, assetCode, asset ? asset.registration : null, driverName || null,
     project ? project.id : null, project ? project.name : null, project ? project.code : null,
     billingMode, rateBasis, Number(rateCents) || 0,
     openingMeter != null ? Number(openingMeter) : null, closingMeter != null ? Number(closingMeter) : null,
     calculation.actualUnits, calculation.minimumUnits, calculation.billableUnits, calculation.rentalAmountCents,
     calculation.fuelLitres, calculation.fuelChargedCents,
     calculation.breakdownDays, calculation.breakdownDeductCents,
     calculation.subtotalCents, calculation.ssclRate, calculation.ssclCents,
     calculation.vatRate, calculation.vatCents, calculation.grandTotalCents,
     status, issuedDate, status === 'FINAL' ? actorId : null,
     status === 'FINAL' ? new Date().toISOString() : null, notes || null, actorId);

  syncBillCoreLineItems({
    billId,
    billingMode,
    rateBasis,
    rateCents,
    calculation,
    fuelPriceCents: resolvedFuelPriceCents,
  });

  if (status === 'FINAL') {
    syncBillFinalFinancialEvents({
      billId,
      assetId,
      assetCode,
      projectId: project ? project.id : null,
      periodEnd: period.end,
      year: period.year,
      month: period.month,
      calculation,
    });
  }
}

/**
 * Build a Site & Month billing plan from fuel-driven monthly vehicle timelines
 * (respecting manual allocations, tank->site links, early-month cutoff rules, and zero double-billing).
 */
function buildSiteMonthlyPlan(projectIdRaw, periodKey, opts = {}) {
  const bounds = breakdowns.monthBounds(periodKey);
  if (!bounds) {
    const err = new Error('Valid month (YYYY-MM) is required');
    err.status = 400;
    throw err;
  }

  const filterProjId = projectIdRaw && String(projectIdRaw).toUpperCase() !== 'ALL'
    ? Number(projectIdRaw)
    : null;
  const projectObj = filterProjId ? get('SELECT * FROM projects WHERE id = ?', filterProjId) : null;
  if (filterProjId && !projectObj) {
    const err = new Error('Selected site / project not found');
    err.status = 404;
    throw err;
  }

  const allowOpenBreakdownDeduction = Boolean(opts.allowOpenBreakdownDeduction);
  const costingOpts = fuelTimeline.getCostingOptions();
  const workingDaysPerMonth = costingOpts.workingDaysPerMonth || WORKING_DAYS_PER_MONTH;

  const timelines = fuelTimeline.buildMonthlyVehicleTimelines(bounds.periodKey, {
    workingDaysPerMonth,
    includeCurrentProjectZeroFuel: true,
  });

  const projectsMap = new Map(all('SELECT id, code, name FROM projects').map((p) => [p.id, p]));
  const rateCards = new Map();
  for (const rc of all('SELECT * FROM fleet_rental_rates WHERE asset_id IS NOT NULL')) {
    if (!rateCards.has(rc.asset_id)) rateCards.set(rc.asset_id, rc);
  }
  const assetsMap = new Map(all('SELECT * FROM assets').map((a) => [a.id, a]));
  const bdMap = siteSummary.buildBreakdownMapForMonth(bounds);
  const repairCostMap = breakdowns.getWorkshopRepairCostMap(bounds.periodKey);

  // Collect overlapping (assetId, projectId) stays from unified timelines
  const targetEntries = [];
  if (filterProjId) {
    const sMap = timelines.bySite.get(filterProjId);
    if (sMap) {
      for (const stay of sMap.values()) targetEntries.push(stay);
    }
  } else {
    for (const sMap of timelines.bySite.values()) {
      for (const stay of sMap.values()) targetEntries.push(stay);
    }
  }

  const items = [];
  for (const stay of targetEntries) {
    const asset = assetsMap.get(stay.assetId);
    if (!asset) continue;
    if (fuelTimeline.isNonMachineFuelRow({}, asset)) continue;
    if (fuelTimeline.isHiredAsset(asset) || (stay.allocBases || []).some((b) => ['BILLED_DIRECT', 'FREE_OF_CHARGE'].includes(String(b).toUpperCase()))) {
      continue;
    }

    // Skip zero-fuel CURRENT_SITE placeholders unless there is an explicit MANUAL allocation/assignment or fuel activity
    if (stay.origin === 'CURRENT_SITE' && stay.fuelLitres <= 0 && stay.issueCount === 0) {
      const hasExplicitAlloc = Boolean(get(`
        SELECT 1 FROM fleet_vehicle_allocations
         WHERE asset_id = ? AND project_id = ? AND COALESCE(active, 1) = 1
           AND (month = ? OR (COALESCE(date_from, COALESCE(month_from, month) || '-01') <= ? AND (is_current = 1 OR COALESCE(date_to, date(COALESCE(month_to, month) || '-01', '+1 month', '-1 day')) >= ?)))
         LIMIT 1
      `, stay.assetId, stay.projectId, bounds.periodKey, bounds.end, bounds.start));
      const hasExplicitAssign = Boolean(get(`
        SELECT 1 FROM fleet_asset_assignments
         WHERE asset_id = ? AND project_id = ?
           AND substr(start_date, 1, 10) <= ? AND (end_date IS NULL OR substr(end_date, 1, 10) >= ?)
         LIMIT 1
      `, stay.assetId, stay.projectId, bounds.end, bounds.start));
      if (!hasExplicitAlloc && !hasExplicitAssign && !filterProjId) continue;
    }

    const proj = projectsMap.get(stay.projectId) || { id: stay.projectId, name: 'Central', code: null };
    const rateCard = rateCards.get(stay.assetId) || null;
    const billingMode = (stay.allocBases && stay.allocBases[0]) || (rateCard && rateCard.default_basis) || 'DRY_WITH_DRIVER';
    const rateBasis = (rateCard && rateCard.rate_basis) || (rateCard && rateCard.fuel_cons_basis === 'km' ? 'KM' : 'HOURLY');
    const rateCents = pickRateForMode(rateCard, billingMode);
    const hasRate = rateCents > 0 || billingMode === 'FUEL_ONLY';

    const siteOverlapDays = stay.postedDays || bounds.daysInMonth;
    const mergedIntervals = stay.intervals && stay.intervals.length ? stay.intervals : [{ start: bounds.start, end: bounds.end }];
    const allocDateFrom = mergedIntervals[0].start;
    const allocDateTo = mergedIntervals[mergedIntervals.length - 1].end;

    const meterSpan = (stay.maxMeter != null && stay.minMeter != null && stay.maxMeter > stay.minMeter)
      ? Math.round((stay.maxMeter - stay.minMeter) * 10) / 10
      : 0;
    const fullMinUnits = rateBasis === 'DAILY'
      ? (rateCard && Number(rateCard.min_bill_hours) > 0 ? Number(rateCard.min_bill_hours) : 0)
      : resolveDefaultMinUnits(rateBasis, rateCard);
    const proratedMinUnits = (fullMinUnits > 0 && siteOverlapDays < bounds.daysInMonth)
      ? Math.round(fullMinUnits * (siteOverlapDays / bounds.daysInMonth) * 100) / 100
      : fullMinUnits;
    const dailyStayUnits = siteOverlapDays >= bounds.daysInMonth
      ? workingDaysPerMonth
      : Math.min(workingDaysPerMonth, siteOverlapDays);
    const defaultDailyUnits = rateBasis === 'DAILY'
      ? dailyStayUnits
      : (proratedMinUnits > 0 ? proratedMinUnits : (rateBasis === 'MONTHLY' || rateBasis === 'FLAT' ? 1 : (rateBasis === 'KM' ? 3000 : 120)));
    const actualUnits = meterSpan > 0 ? meterSpan : defaultDailyUnits;

    const bdStatus = breakdowns.getAssetBillingBreakdownStatus(asset.id, bounds.periodKey);
    const rawBdList = bdMap.get(asset.id) || [];
    const bdMerged = siteSummary.mergeDateIntervals(rawBdList.map((r) => ({ start: r.start, end: r.end })));
    const activeIntervals = siteSummary.subtractDateIntervals(mergedIntervals, bdMerged);
    const activeDaysInStay = activeIntervals.reduce((s, seg) => s + breakdowns.daysBetweenInclusive(seg.start, seg.end), 0);
    const bdDaysInStay = Math.max(0, siteOverlapDays - activeDaysInStay);
    const effectiveBdDays = allowOpenBreakdownDeduction ? bdDaysInStay : bdStatus.breakdownDays;

    const isBlocked = allowOpenBreakdownDeduction
      ? (activeDaysInStay <= 0 && (bdStatus.billingBlocked || bdStatus.fullMonthDown))
      : (bdStatus.billingBlocked || bdStatus.fullMonthDown);

    const existingBill = get(`
      SELECT id, invoice_number, status, grand_total_cents
        FROM fleet_bills
       WHERE asset_id = ?
         AND period_key = ?
         AND status != 'VOID'
         AND (? IS NULL OR project_id IS NULL OR project_id = ?)
       LIMIT 1
    `, asset.id, bounds.periodKey, stay.projectId, stay.projectId);

    const periodFuelPriceCents = resolvePeriodFuelPriceCents({
      litres: stay.fuelLitres,
      totalFuelCostCents: stay.fuelCostCents,
      asOfDate: bounds.end,
    });

    const calculation = calc.calculateRentalBill({
      actualUnits,
      rateBasis,
      rateCents,
      billingMode,
      minimumUnits: proratedMinUnits,
      breakdownDays: effectiveBdDays,
      workingDaysInMonth: workingDaysPerMonth,
      daysInMonth: bounds.daysInMonth,
      fuelLitres: stay.fuelLitres || 0,
      fuelPriceCents: periodFuelPriceCents,
    });

    const totalAssetPostedDays = (timelines.byAsset.get(asset.id) && timelines.byAsset.get(asset.id).totalPostedDays) || siteOverlapDays;
    const rawAssetRepairCents = repairCostMap.get(asset.id) || 0;
    const workshopRepairCostCents = totalAssetPostedDays > 0
      ? Math.round(rawAssetRepairCents * (siteOverlapDays / totalAssetPostedDays))
      : rawAssetRepairCents;
    const lostHireRevenueCents = calculation.breakdownDeductCents || 0;
    const availabilityPct = siteOverlapDays > 0 ? Math.round((activeDaysInStay / siteOverlapDays) * 1000) / 10 : 100;

    items.push({
      assetId: asset.id,
      assetCode: asset.code || asset.ec_code || asset.registration,
      registration: asset.registration,
      assetType: asset.type || null,
      projectId: stay.projectId,
      projectName: proj.name || 'Central',
      projectCode: proj.code || null,
      driverName: stay.driverName || null,
      allocDateFrom,
      allocDateTo: (bounds.periodKey === currentMonthKey() && allocDateTo === bounds.end) ? null : allocDateTo,
      allocIsCurrent: bounds.periodKey === currentMonthKey() && allocDateTo === bounds.end,
      stayDatesLabel: stay.stayDatesLabel || '',
      stayOrigin: stay.origin || 'FUEL_TIMELINE',
      siteOverlapDays,
      activeDays: activeDaysInStay,
      workingDaysInMonth: workingDaysPerMonth,
      sources: [stay.origin || 'FUEL_TIMELINE'],
      billingMode,
      rateBasis,
      rateCents,
      hasRate,
      openingMeter: stay.minMeter,
      closingMeter: stay.maxMeter,
      actualUnits,
      minBillHours: proratedMinUnits,
      fuelLitres: Math.round((stay.fuelLitres || 0) * 100) / 100,
      fuelPriceCents: periodFuelPriceCents,
      breakdownDays: effectiveBdDays,
      lostHireRevenueCents,
      workshopRepairCostCents,
      totalBreakdownImpactCents: workshopRepairCostCents + lostHireRevenueCents,
      availabilityPct,
      billingBlocked: isBlocked,
      blockReason: isBlocked ? bdStatus.blockReason : (bdDaysInStay > 0 ? `Deducting ${bdDaysInStay} repair day(s) — ${activeDaysInStay} active days billable` : null),
      existingBill: existingBill || null,
      calculation,
      eligible: !existingBill && hasRate && !isBlocked,
    });
  }

  items.sort((a, b) =>
    String(a.projectName || '').localeCompare(String(b.projectName || ''))
    || String(a.assetCode || '').localeCompare(String(b.assetCode || ''))
  );

  return {
    month: bounds.periodKey,
    year: bounds.year,
    monthNum: bounds.month,
    periodStart: bounds.start,
    periodEnd: bounds.end,
    daysInMonth: bounds.daysInMonth,
    workingDaysInMonth: workingDaysPerMonth,
    project: projectObj ? { id: projectObj.id, code: projectObj.code, name: projectObj.name } : null,
    items,
    summary: {
      totalMachines: items.length,
      eligibleCount: items.filter((x) => x.eligible).length,
      blockedCount: items.filter((x) => x.billingBlocked).length,
      alreadyBilledCount: items.filter((x) => !!x.existingBill).length,
      missingRateCount: items.filter((x) => !x.hasRate).length,
      estimatedGrandTotalCents: items.reduce((s, x) => s + (x.calculation ? x.calculation.grandTotalCents : 0), 0),
      totalWorkshopRepairCostCents: items.reduce((s, x) => s + (x.workshopRepairCostCents || 0), 0),
      totalLostHireRevenueCents: items.reduce((s, x) => s + (x.lostHireRevenueCents || 0), 0),
    },
  };
}

// ---------------------------------------------------------------------------
// 0. Costing Options & Auto-Allocation Settings
// ---------------------------------------------------------------------------

router.get('/costing-options', requireAuth, requireCap('hire.billing.view', 'hire.rates.view', 'allocations.view'), asyncHandler(async (_req, res) => {
  res.json(fuelTimeline.getCostingOptions());
}));

router.put('/costing-options', requireAuth, requireCap('hire.rates.manage', 'costing.manage', 'hire.billing.generate'), asyncHandler(async (req, res) => {
  const actorId = req.user ? req.user.id : null;
  const updated = fuelTimeline.saveCostingOptions(req.body || {}, actorId);
  res.json({ ok: true, ...updated });
}));

// ---------------------------------------------------------------------------
// 1. Rental Bills, Auto-Prefill, Revisions & Finalisation
// ---------------------------------------------------------------------------

router.get('/bills', requireAuth, requireCap('hire.billing.view', 'costing.view'), asyncHandler(async (req, res) => {
  const { year, month, periodKey, status, projectId, assetCode, search, limit = 150, offset = 0 } = req.query;

  const conditions = [];
  const params = [];

  if (periodKey && /^\d{4}-\d{2}$/.test(String(periodKey))) {
    conditions.push('b.period_key = ?');
    params.push(String(periodKey));
  } else {
    if (year) {
      conditions.push('b.year = ?');
      params.push(Number(year));
    }
    if (month) {
      conditions.push('b.month = ?');
      params.push(Number(month));
    }
  }
  if (status && status !== 'ALL') {
    conditions.push('b.status = ?');
    params.push(String(status).toUpperCase());
  }
  if (projectId && String(projectId).toUpperCase() !== 'ALL') {
    conditions.push('b.project_id = ?');
    params.push(Number(projectId));
  }
  if (assetCode) {
    conditions.push('UPPER(b.asset_code) LIKE UPPER(?)');
    params.push(`%${assetCode}%`);
  }
  if (search) {
    conditions.push('(b.invoice_number LIKE ? OR b.asset_code LIKE ? OR b.driver_name LIKE ? OR b.project_name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const summaryConditions = conditions.filter((_, idx) => !conditions[idx].startsWith('b.status ='));
  const summaryParams = params.filter((_, idx) => !conditions[idx].startsWith('b.status ='));
  const summaryWhere = summaryConditions.length
    ? `WHERE b.status != 'VOID' AND ${summaryConditions.join(' AND ')}`
    : "WHERE b.status != 'VOID'";

  const countRow = get(`SELECT COUNT(*) AS total FROM fleet_bills b ${whereClause}`, ...params);
  const total = countRow ? countRow.total : 0;

  const rows = all(`
    SELECT b.*,
           COALESCE(u.full_name, u.username) AS generator_name,
           COALESCE(au.full_name, au.username) AS approver_name,
           COALESCE((SELECT SUM(p.amount_cents) FROM fleet_bill_payments p WHERE p.bill_id = b.id), 0) AS paid_cents,
           COALESCE((SELECT COUNT(*) FROM fleet_bill_revisions r WHERE r.bill_id = b.id), 0) AS revision_count,
           COALESCE(
             (SELECT li.unit_price_cents FROM fleet_bill_line_items li WHERE li.bill_id = b.id AND li.item_type = 'FUEL' LIMIT 1),
             CASE WHEN b.fuel_litres > 0 AND b.fuel_cost_cents > 0 THEN ROUND(b.fuel_cost_cents * 1.0 / b.fuel_litres) ELSE NULL END
           ) AS fuel_price_cents
      FROM fleet_bills b
      LEFT JOIN users u ON u.id = b.generated_by
      LEFT JOIN users au ON au.id = b.approved_by
     ${whereClause}
     ORDER BY b.year DESC, b.month DESC, COALESCE(b.project_name, 'Central') ASC, b.asset_code ASC
     LIMIT ? OFFSET ?
  `, ...params, Number(limit), Number(offset)).map((row) => ({
    ...row,
    balance_cents: Math.max(0, (row.grand_total_cents || 0) - (row.paid_cents || 0)),
  }));

  const allLocks = periodLocks.listPeriodLocks();
  const monthLockMap = new Map();
  const siteLockMap = new Map();
  for (const lk of allLocks) {
    if (lk.project_id === 0) monthLockMap.set(lk.period_key, lk);
    else siteLockMap.set(`${lk.period_key}|${lk.project_id}`, lk);
  }

  const summaryBySiteMonth = all(`
    SELECT b.period_key,
           b.year,
           b.month,
           b.project_id,
           COALESCE(b.project_name, p.name, 'Central') AS project_name,
           COALESCE(b.project_code, p.code) AS project_code,
           COUNT(*) AS bill_count,
           SUM(CASE WHEN b.status = 'DRAFT' THEN 1 ELSE 0 END) AS draft_count,
           SUM(CASE WHEN b.status IN ('FINAL', 'PAID') THEN 1 ELSE 0 END) AS final_count,
           COALESCE(SUM(b.rental_amount_cents), 0) AS rental_cents,
           COALESCE(SUM(b.breakdown_deduct_cents), 0) AS breakdown_deduct_cents,
           COALESCE(SUM(b.fuel_cost_cents), 0) AS fuel_cents,
           COALESCE(SUM(b.grand_total_cents), 0) AS grand_total_cents,
           COALESCE(SUM(COALESCE((SELECT SUM(pay.amount_cents) FROM fleet_bill_payments pay WHERE pay.bill_id = b.id), 0)), 0) AS paid_cents
      FROM fleet_bills b
      LEFT JOIN projects p ON p.id = b.project_id
     ${summaryWhere}
     GROUP BY b.period_key, b.year, b.month, COALESCE(b.project_id, 0), COALESCE(b.project_name, p.name, 'Central')
     ORDER BY b.period_key DESC, project_name ASC
  `, ...summaryParams).map((s) => {
    const lk = monthLockMap.get(s.period_key)
      || (s.project_id != null ? siteLockMap.get(`${s.period_key}|${Number(s.project_id)}`) : null)
      || null;
    return {
      ...s,
      balance_cents: Math.max(0, (s.grand_total_cents || 0) - (s.paid_cents || 0)),
      is_locked: Boolean(lk),
      lock_scope: lk ? lk.scope : null,
      locked_at: lk ? lk.locked_at : null,
      locked_by_name: lk ? lk.locked_by_name : null,
      lock_reason: lk ? lk.reason : null,
    };
  });

  const overallSummary = {
    totalBills: rows.length,
    totalCount: total,
    sitesCount: new Set(summaryBySiteMonth.map((s) => s.project_name)).size,
    rentalCents: summaryBySiteMonth.reduce((acc, s) => acc + (s.rental_cents || 0), 0),
    breakdownDeductCents: summaryBySiteMonth.reduce((acc, s) => acc + (s.breakdown_deduct_cents || 0), 0),
    fuelCents: summaryBySiteMonth.reduce((acc, s) => acc + (s.fuel_cents || 0), 0),
    grandTotalCents: summaryBySiteMonth.reduce((acc, s) => acc + (s.grand_total_cents || 0), 0),
    paidCents: summaryBySiteMonth.reduce((acc, s) => acc + (s.paid_cents || 0), 0),
    balanceCents: summaryBySiteMonth.reduce((acc, s) => acc + (s.balance_cents || 0), 0),
  };

  res.json({
    total,
    bills: rows,
    summaryBySiteMonth,
    overallSummary,
    periodLocks: allLocks,
    limit: Number(limit),
    offset: Number(offset),
  });
}));

router.get('/sites-catalog', requireAuth, requireCap('hire.billing.view', 'hire.rates.view', 'costing.view', 'allocations.view'), asyncHandler(async (_req, res) => {
  res.json(siteSummary.listSitesCatalog());
}));

router.get('/bills/site-preview', requireAuth, requireCap('hire.billing.view', 'hire.rates.view'), asyncHandler(async (req, res) => {
  const curYm = currentMonthKey();
  const month = req.query.month && /^\d{4}-\d{2}$/.test(String(req.query.month))
    ? String(req.query.month)
    : (req.query.year && req.query.monthNum
      ? `${Number(req.query.year)}-${String(Number(req.query.monthNum)).padStart(2, '0')}`
      : curYm);
  const projectId = req.query.projectId || 'ALL';
  const allowOpenBreakdownDeduction = req.query.allowOpenBreakdownDeduction === '1' || req.query.allowOpenBreakdownDeduction === 'true';
  const plan = buildSiteMonthlyPlan(projectId, month, { allowOpenBreakdownDeduction });
  res.json(plan);
}));

function resolveSiteSummaryQuery(src = {}) {
  const curYm = currentMonthKey();
  const month = src.month && /^\d{4}-\d{2}$/.test(String(src.month).trim())
    ? String(src.month).trim()
    : (src.year && src.monthNum
      ? `${Number(src.year)}-${String(Number(src.monthNum)).padStart(2, '0')}`
      : curYm);
  let rawProj = src.projectId != null ? String(src.projectId).trim() : (src.site ? String(src.site).trim() : 'ALL');
  let siteId = src.siteId ? Number(src.siteId) : undefined;
  if (/^site:(\d+)$/i.test(rawProj)) {
    siteId = Number(rawProj.split(':')[1]);
    rawProj = '';
  }
  const projectId = rawProj || 'ALL';
  const isAll = !siteId && projectId.toUpperCase() === 'ALL';
  const options = {
    siteId,
    basisMode: src.basisMode || src.basis || 'SUMMARY_WET',
    fuelPolicy: src.fuelPolicy || 'ALL_SITE_PUMPS',
    includeZeroFuel: src.includeZeroFuel === '1' || src.includeZeroFuel === true || src.includeZeroFuel === 'true',
    effectiveDaysInMonth: src.effectiveDaysInMonth ? Number(src.effectiveDaysInMonth) : undefined,
    workingDaysInMonth: src.workingDaysInMonth != null && src.workingDaysInMonth !== '' ? Number(src.workingDaysInMonth) : undefined,
    minHours: src.minHours != null && src.minHours !== '' ? Number(src.minHours) : undefined,
    minKm: src.minKm != null && src.minKm !== '' ? Number(src.minKm) : undefined,
    minDays: src.minDays != null && src.minDays !== '' ? Number(src.minDays) : undefined,
  };
  const summaries = isAll
    ? siteSummary.buildAllSiteSummaries(month, options)
    : [siteSummary.buildSiteSummary(projectId, month, options)];
  return { month, projectId, siteId, isAll, options, summaries, summary: summaries[0] || null };
}

router.get('/bills/site-summary', requireAuth, requireCap('hire.billing.view', 'hire.rates.view', 'costing.view'), asyncHandler(async (req, res) => {
  const result = resolveSiteSummaryQuery(req.query);
  if (result.isAll) {
    const combined = {
      totalSites: result.summaries.length,
      totalMachines: result.summaries.reduce((n, s) => n + s.lines.length, 0),
      grossRentalCents: result.summaries.reduce((n, s) => n + (s.grossRentalCents != null ? s.grossRentalCents : s.rentalCents), 0),
      breakdownDeductCents: result.summaries.reduce((n, s) => n + (s.breakdownDeductCents || 0), 0),
      rentalCents: result.summaries.reduce((n, s) => n + s.rentalCents, 0),
      fuelLitres: Math.round(result.summaries.reduce((n, s) => n + s.fuelLitres, 0) * 100) / 100,
      fuelCostCents: result.summaries.reduce((n, s) => n + s.fuelCostCents, 0),
      subtotalCents: result.summaries.reduce((n, s) => n + s.subtotalCents, 0),
      ssclCents: result.summaries.reduce((n, s) => n + s.ssclCents, 0),
      vatCents: result.summaries.reduce((n, s) => n + s.vatCents, 0),
      grandTotalCents: result.summaries.reduce((n, s) => n + s.grandTotalCents, 0),
      totalLostHireRevenueCents: result.summaries.reduce((n, s) => n + (s.totalLostHireRevenueCents || 0), 0),
      totalWorkshopRepairCostCents: result.summaries.reduce((n, s) => n + (s.totalWorkshopRepairCostCents || 0), 0),
      totalBreakdownImpactCents: result.summaries.reduce((n, s) => n + (s.totalBreakdownImpactCents || 0), 0),
    };
    return res.json({ mode: 'ALL', month: result.month, summaries: result.summaries, combined });
  }
  return res.json({ mode: 'SINGLE', month: result.month, summary: result.summary, summaries: result.summaries });
}));

router.get('/bills/site-summary/print.html', requireAuth, requireCap('hire.billing.view', 'hire.rates.view', 'costing.view'), asyncHandler(async (req, res) => {
  const result = resolveSiteSummaryQuery(req.query);
  if (!result.summaries.length) {
    return res.status(404).send(`No site summary data found for ${result.month}`);
  }
  const qStr = new URLSearchParams(req.query).toString();
  const basePath = req.baseUrl || '/api/hire';
  const html = siteSummaryDoc.renderSiteSummaryHtml(result.summaries, {
    forPdf: false,
    downloadUrl: `${basePath}/bills/site-summary/download.pdf?${qStr}`,
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

router.get('/bills/site-summary/download.pdf', requireAuth, requireCap('hire.billing.view', 'hire.rates.view', 'costing.view'), asyncHandler(async (req, res) => {
  const result = resolveSiteSummaryQuery(req.query);
  if (!result.summaries.length) {
    return res.status(404).json({ error: `No site summary data found for ${result.month}` });
  }
  const flat = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '');
  const filename = result.isAll
    ? `sitesummaries_ALL_${flat(result.month)}.pdf`
    : `sitesummary_${flat(result.summary.siteCode)}_${flat(result.month)}.pdf`;
  const html = siteSummaryDoc.renderSiteSummaryHtml(result.summaries, { forPdf: true });
  await sendPdf(res, filename, html);
}));

router.get('/bills/site-summary/download.xlsx', requireAuth, requireCap('hire.billing.view', 'hire.rates.view', 'costing.view'), asyncHandler(async (req, res) => {
  const result = resolveSiteSummaryQuery(req.query);
  if (!result.summaries.length) {
    return res.status(404).json({ error: `No site summary data found for ${result.month}` });
  }
  const siteSummaryRows = [];
  const lineRows = [];
  const exclRows = [];
  for (const s of result.summaries) {
    siteSummaryRows.push({
      siteCode: s.siteCode,
      siteName: s.siteName,
      periodKey: s.periodKey,
      status: s.status,
      machines: s.lines.length,
      fuelLitres: s.fuelLitres,
      grossRentalRs: Math.round(s.grossRentalCents != null ? s.grossRentalCents : s.rentalCents) / 100,
      breakdownDeductRs: Math.round(s.breakdownDeductCents || 0) / 100,
      rentalRs: Math.round(s.rentalCents) / 100,
      fuelRs: Math.round(s.fuelCostCents) / 100,
      subtotalRs: Math.round(s.subtotalCents) / 100,
      ssclRs: Math.round(s.ssclCents) / 100,
      vatRs: Math.round(s.vatCents) / 100,
      grandTotalRs: Math.round(s.grandTotalCents) / 100,
      repairCostRs: Math.round(s.totalWorkshopRepairCostCents || 0) / 100,
      lostHireRs: Math.round(s.totalLostHireRevenueCents || 0) / 100,
      totalBdImpactRs: Math.round(s.totalBreakdownImpactCents || 0) / 100,
      availabilityPct: s.fleetAvailabilityPct != null ? s.fleetAvailabilityPct : 100,
    });
    for (const l of s.lines) {
      lineRows.push({
        siteCode: s.siteCode,
        siteName: s.siteName,
        machine: l.code,
        regNo: l.regNo || '',
        days: l.workingDaysHere != null && l.workingDaysInMonth
          ? `${l.workingDaysHere} / ${l.workingDaysInMonth}`
          : `${l.daysHere} / ${l.daysInMonth}`,
        bdDays: l.breakdownDays || 0,
        consTyp: l.consRefUnits != null ? `${l.consRefUnits} ${l.unit}` : '',
        consRate: l.consTypRate != null ? `${l.consTypRate} L/${l.unit}` : '',
        meter: l.actualUnits != null ? `${l.actualUnits} ${l.unit}` : '',
        billable: `${l.billableUnits} ${l.unit}`,
        billedOn: l.billedOn,
        rateRs: l.rateCents != null ? Math.round(l.rateCents) / 100 : null,
        grossRentalRs: Math.round(l.grossRentalCents != null ? l.grossRentalCents : l.rentalCents) / 100,
        bdDeductRs: Math.round(l.breakdownDeductCents || 0) / 100,
        rentalRs: Math.round(l.rentalCents) / 100,
        fuelLitres: l.fuelLitres,
        fuelRs: Math.round(l.fuelCostCents) / 100,
        totalRs: Math.round(l.lineTotalCents) / 100,
        repairCostRs: Math.round(l.workshopRepairCostCents || 0) / 100,
        lostHireRs: Math.round(l.lostHireRevenueCents || 0) / 100,
        totalBdImpactRs: Math.round(l.totalBreakdownImpactCents || 0) / 100,
        availabilityPct: l.availabilityPct != null ? l.availabilityPct : 100,
      });
    }
    for (const t of s.transfersExcluded || []) {
      exclRows.push({
        siteCode: s.siteCode,
        type: 'TRANSFER / CORRECTION',
        ref: t.ref,
        description: t.description,
        litres: t.litres,
        amountRs: Math.round(t.amountCents) / 100,
      });
    }
    if (s.noFuelHere && s.noFuelHere.length) {
      exclRows.push({ siteCode: s.siteCode, type: 'ZERO FUEL ON SITE', ref: s.noFuelHere.join(', '), description: 'Posted here, drew 0 L from site pumps', litres: 0, amountRs: 0 });
    }
    if (s.billedDirect && s.billedDirect.length) {
      exclRows.push({ siteCode: s.siteCode, type: 'SETTLED DIRECT', ref: s.billedDirect.join(', '), description: 'Hired / settled direct with owner', litres: 0, amountRs: 0 });
    }
  }
  const flat = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '');
  const filename = result.isAll
    ? `sitesummaries_ALL_${flat(result.month)}.xlsx`
    : `sitesummary_${flat(result.summary.siteCode)}_${flat(result.month)}.xlsx`;
  await sendXlsx(res, filename, [
    {
      name: 'Site Totals',
      columns: [
        { header: 'Site Code', key: 'siteCode', width: 14 },
        { header: 'Site Name', key: 'siteName', width: 28 },
        { header: 'Period', key: 'periodKey', width: 11 },
        { header: 'Status', key: 'status', width: 10 },
        { header: 'Machines', key: 'machines', width: 10 },
        { header: 'Fuel Issued (L)', key: 'fuelLitres', width: 15 },
        { header: 'Gross Rental (Rs)', key: 'grossRentalRs', width: 16 },
        { header: 'BD Deduct (Rs)', key: 'breakdownDeductRs', width: 15 },
        { header: 'Net Rental (Rs)', key: 'rentalRs', width: 16 },
        { header: 'Fuel Cost (Rs)', key: 'fuelRs', width: 16 },
        { header: 'Subtotal (Rs)', key: 'subtotalRs', width: 16 },
        { header: 'SSCL 2.5% (Rs)', key: 'ssclRs', width: 15 },
        { header: 'VAT 18% (Rs)', key: 'vatRs', width: 15 },
        { header: 'Site Total (Rs)', key: 'grandTotalRs', width: 18 },
        { header: 'Workshop Repairs (Rs)', key: 'repairCostRs', width: 18 },
        { header: 'Lost Hire (Rs)', key: 'lostHireRs', width: 16 },
        { header: 'Total BD Impact (Rs)', key: 'totalBdImpactRs', width: 18 },
        { header: 'Availability %', key: 'availabilityPct', width: 13 },
      ],
      rows: siteSummaryRows,
    },
    {
      name: 'Machines Posted',
      columns: [
        { header: 'Site', key: 'siteCode', width: 12 },
        { header: 'Machine', key: 'machine', width: 14 },
        { header: 'Reg No', key: 'regNo', width: 14 },
        { header: 'Working Days', key: 'days', width: 12 },
        { header: 'BD Days', key: 'bdDays', width: 9 },
        { header: 'Actual (Cons Typ)', key: 'consTyp', width: 16 },
        { header: 'Typ Rate', key: 'consRate', width: 14 },
        { header: 'Actual (Meter)', key: 'meter', width: 15 },
        { header: 'Billable', key: 'billable', width: 15 },
        { header: 'Billed On', key: 'billedOn', width: 14 },
        { header: 'Rate (Rs)', key: 'rateRs', width: 12 },
        { header: 'Gross Rental (Rs)', key: 'grossRentalRs', width: 15 },
        { header: 'BD Deduct (Rs)', key: 'bdDeductRs', width: 14 },
        { header: 'Net Rental (Rs)', key: 'rentalRs', width: 15 },
        { header: 'Fuel (L)', key: 'fuelLitres', width: 11 },
        { header: 'Fuel (Rs)', key: 'fuelRs', width: 14 },
        { header: 'Total (Rs)', key: 'totalRs', width: 16 },
        { header: 'Repairs (Rs)', key: 'repairCostRs', width: 14 },
        { header: 'Lost Hire (Rs)', key: 'lostHireRs', width: 14 },
        { header: 'BD Impact (Rs)', key: 'totalBdImpactRs', width: 15 },
        { header: 'Avail %', key: 'availabilityPct', width: 10 },
      ],
      rows: lineRows,
    },
    {
      name: 'Excluded & Transfers',
      columns: [
        { header: 'Site', key: 'siteCode', width: 12 },
        { header: 'Category', key: 'type', width: 22 },
        { header: 'Reference / Codes', key: 'ref', width: 32 },
        { header: 'Description', key: 'description', width: 40 },
        { header: 'Litres', key: 'litres', width: 12 },
        { header: 'Amount (Rs)', key: 'amountRs', width: 15 },
      ],
      rows: exclRows,
    },
  ]);
}));

router.post('/bills/site-summary/generate', requireAuth, requireCap('hire.billing.generate', 'costing.manage'), asyncHandler(async (req, res) => {
  const {
    projectId = 'ALL',
    siteId = undefined,
    month = currentMonthKey(),
    finalise = false,
    basisMode = 'SUMMARY_WET',
    fuelPolicy = 'ALL_SITE_PUMPS',
    includeZeroFuel = false,
    workingDaysInMonth = undefined,
    minHours = undefined,
    minKm = undefined,
    minDays = undefined,
    selectedAssetIds = null,
  } = req.body || {};
  const result = resolveSiteSummaryQuery({ projectId, siteId, month, basisMode, fuelPolicy, includeZeroFuel, workingDaysInMonth, minHours, minKm, minDays });
  const actorId = req.user ? req.user.id : 1;
  const period = breakdowns.monthBounds(result.month);
  const targetStatus = finalise ? 'FINAL' : 'DRAFT';
  const filterSet = Array.isArray(selectedAssetIds) && selectedAssetIds.length
    ? new Set(selectedAssetIds.map((x) => Number(x)))
    : null;

  const monthLock = periodLocks.isPeriodLocked(result.month, 0);
  if (monthLock) {
    return res.status(409).json({
      error: `Billing period ${result.month} is locked${monthLock.reason ? `: ${monthLock.reason}` : ''}`,
      periodLocked: true,
      lock: monthLock,
    });
  }
  if (!result.isAll && result.summary) {
    const siteLock = periodLocks.isPeriodLocked(result.month, result.summary.projectId || 0);
    if (siteLock) {
      return res.status(409).json({
        error: `Billing period ${result.month} for ${result.summary.siteName || 'this site'} is locked${siteLock.reason ? `: ${siteLock.reason}` : ''}`,
        periodLocked: true,
        lock: siteLock,
      });
    }
  }

  let generatedBills = 0;
  let skippedExisting = 0;
  let skippedUnrated = 0;
  const skippedLocked = [];
  const skippedBreakdowns = [];
  const createdBills = [];

  tx(() => {
    for (const s of result.summaries) {
      const siteLock = periodLocks.isPeriodLocked(result.month, s.projectId || 0);
      if (siteLock) {
        skippedLocked.push({ projectId: s.projectId, siteCode: s.siteCode, siteName: s.siteName, reason: siteLock.reason || 'Period is locked' });
        continue;
      }
      const proj = { id: s.projectId, name: s.siteName, code: s.siteCode };
      for (const l of s.lines) {
        if (filterSet && !filterSet.has(Number(l.assetId))) continue;
        if (l.existingBill) {
          skippedExisting++;
          continue;
        }
        // Full-month breakdown with zero working days & zero fuel produces no billable charge
        if (l.daysHere === 0 && l.fuelCostCents === 0) {
          skippedBreakdowns.push({ assetId: l.assetId, assetCode: l.code, siteCode: s.siteCode, reason: l.blockReason || 'Full breakdown month' });
          continue;
        }
        if (l.daysHere > 0 && (l.rateCents == null || l.rateCents <= 0)) {
          skippedUnrated++;
          continue;
        }

        const lineFuelPriceCents = resolvePeriodFuelPriceCents({
          litres: l.fuelLitres,
          totalFuelCostCents: l.fuelCostCents,
          asOfDate: period.end,
        });
        const bdDeductCents = l.breakdownDeductCents || 0;
        const grossRentalCents = l.grossRentalCents != null ? l.grossRentalCents : (l.rentalCents + bdDeductCents);
        const subtotalCents = l.rentalCents + l.fuelCostCents;
        const ssclCents = Math.round(subtotalCents * s.ssclRate);
        const vatCents = Math.round((subtotalCents + ssclCents) * s.vatRate);
        const calculation = {
          actualUnits: l.actualUnits != null ? l.actualUnits : (l.consRefUnits || 0),
          minimumUnits: bdDeductCents > 0 ? (l.grossMinimumUnits || l.minimumProrated) : l.minimumProrated,
          billableUnits: bdDeductCents > 0 && l.billedOn === 'minimum' ? (l.grossMinimumUnits || l.billableUnits) : l.billableUnits,
          rentalAmountCents: bdDeductCents > 0 ? grossRentalCents : l.rentalCents,
          fuelLitres: l.fuelLitres,
          fuelChargedCents: l.fuelCostCents,
          breakdownDays: l.breakdownDays || 0,
          breakdownDeductCents: bdDeductCents,
          subtotalCents,
          ssclRate: s.ssclRate,
          ssclCents,
          vatRate: s.vatRate,
          vatCents,
          grandTotalCents: subtotalCents + ssclCents + vatCents,
        };

        const billId = `bill-sum-${result.month}-p${s.projectId}-a${l.assetId}-${Math.random().toString(36).slice(2, 5)}`;
        const invoiceNumber = targetStatus === 'FINAL'
          ? `INV-${period.year}${String(period.month).padStart(2, '0')}-P${s.projectId}-A${l.assetId}`
          : null;
        const asset = get('SELECT id, registration FROM assets WHERE id = ?', l.assetId) || { id: l.assetId, registration: l.regNo };
        const bdNote = l.breakdownDays > 0 ? `; ${l.breakdownDays}d BD excluded (${l.breakdownSpans})` : '';

        insertGeneratedBill({
          billId,
          invoiceNumber,
          status: targetStatus,
          period,
          asset,
          assetCode: l.code,
          project: proj,
          driverName: l.driverName,
          billingMode: l.billingModeCode,
          rateBasis: l.rateBasis,
          rateCents: l.rateCents || 0,
          calculation,
          fuelPriceCents: lineFuelPriceCents,
          notes: `Site Summary Bill (${l.billedOn}${bdNote}) — ${s.siteName} (${result.month})`,
          actorId,
        });

        generatedBills++;
        createdBills.push({ id: billId, assetCode: l.code, siteCode: s.siteCode, grandTotalCents: calculation.grandTotalCents });
      }
    }
  });

  logAudit(req, 'fleet_bill', result.isAll ? null : result.summary.projectId, 'hire.bill.site_summary_generated', {
    month: result.month,
    projectId: result.projectId,
    generatedBills,
    skippedBreakdownsCount: skippedBreakdowns.length,
    status: targetStatus,
  });

  res.status(201).json({
    ok: true,
    month: result.month,
    projectId: result.projectId,
    generatedBills,
    skippedExisting,
    skippedUnrated,
    skippedLockedCount: skippedLocked.length,
    skippedLocked,
    skippedBreakdownsCount: skippedBreakdowns.length,
    skippedBreakdowns,
    createdBills,
  });
}));

router.get('/bills/prefill', requireAuth, requireCap('hire.billing.view', 'hire.rates.view'), asyncHandler(async (req, res) => {
  const nowYm = currentMonthKey().split('-');
  const { assetCode, year = Number(nowYm[0]), month = Number(nowYm[1]), projectId: reqProjId } = req.query;
  if (!assetCode) return res.status(400).json({ error: 'assetCode is required' });

  const asset = v2Engine.resolveVehicle(assetCode) || identity.resolveAsset(assetCode);
  if (!asset) return res.status(404).json({ error: `Vehicle not found: ${assetCode}` });

  const y = Number(year);
  const m = Number(month);
  const periodKey = `${y}-${String(m).padStart(2, '0')}`;
  const lastDay = new Date(y, m, 0).getDate();
  const fromDate = `${periodKey}-01`;
  const monthEndDate = `${periodKey}-${String(lastDay).padStart(2, '0')}`;
  const toDate = `${monthEndDate} 23:59:59`;
  const targetProjId = reqProjId ? Number(reqProjId) : null;

  const rateCard = get('SELECT * FROM fleet_rental_rates WHERE asset_id = ? LIMIT 1', asset.id);
  const tankProjMap = fuelTimeline.loadTankProjectMap();
  const workingDaysPerMonth = fuelTimeline.getCostingOptions().workingDaysPerMonth || WORKING_DAYS_PER_MONTH;

  // Query wide UTC window [-1d .. +1d] and filter by SLST date + tank->project attribution
  const winFrom = fuelTimeline.addDays(fromDate, -1);
  const winTo = `${fuelTimeline.addDays(monthEndDate, 1)} 23:59:59`;
  const rawAssetFuelRows = all(`
    SELECT fi.*
      FROM fuel_issues fi
     WHERE COALESCE(fi.is_voided, 0) = 0
       AND COALESCE(fi.voided, 0) = 0
       AND fi.asset_id = ?
       AND fi.issue_date >= ?
       AND fi.issue_date <= ?
     ORDER BY fi.issue_date ASC, fi.id ASC
  `, asset.id, winFrom, winTo);

  const assetFuelInMonth = [];
  for (const fi of rawAssetFuelRows) {
    if (fuelTimeline.isNonMachineFuelRow(fi, asset)) continue;
    const d = fuelTimeline.slstDate10(fi.issue_date);
    if (!d || d < fromDate || d > monthEndDate) continue;
    const pid = fuelTimeline.resolveIssueProjectId(fi, tankProjMap);
    if (targetProjId && pid !== targetProjId) continue;
    assetFuelInMonth.push(fi);
  }

  let fuelLitresSum = 0;
  let fuelCostCentsSum = 0;
  let minMeter = null;
  let maxMeter = null;
  const assetIsHired = fuelTimeline.isHiredAsset(asset);
  for (const fi of assetFuelInMonth) {
    if (!assetIsHired && Number(fi.is_direct_billed) !== 1) {
      const l = Number(fi.litres) || 0;
      const p = Number(fi.price_per_litre_cents || fi.fuel_price_cents || 0) || Math.round((Number(fi.unit_price) || 0) * 100);
      const c = Number(fi.total_cost_cents || fi.cost_cents || 0) || Math.round(l * p);
      fuelLitresSum += l;
      fuelCostCentsSum += c;
    }
    const mr = Number(fi.meter_reading);
    if (Number.isFinite(mr) && mr > 0) {
      if (minMeter == null || mr < minMeter) minMeter = mr;
      if (maxMeter == null || mr > maxMeter) maxMeter = mr;
    }
  }
  const fuelRow = {
    litres: fuelLitresSum,
    fuel_cost_cents: fuelCostCentsSum,
    min_meter: minMeter,
    max_meter: maxMeter,
  };
  const periodFuelPriceCents = resolvePeriodFuelPriceCents({
    litres: fuelRow.litres,
    totalFuelCostCents: fuelRow.fuel_cost_cents,
    asOfDate: monthEndDate,
  });

  const bdStatus = breakdowns.getAssetBillingBreakdownStatus(asset.id, periodKey);

  // Pull fuel-driven / manual timeline stay for this asset in periodKey
  let timelineStay = null;
  try {
    const tl = fuelTimeline.buildMonthlyVehicleTimelines(periodKey, { workingDaysPerMonth });
    const aEntry = tl.byAsset.get(asset.id);
    if (aEntry && aEntry.stays.length) {
      timelineStay = targetProjId
        ? (aEntry.stays.find((s) => s.projectId === targetProjId) || null)
        : aEntry.stays[aEntry.stays.length - 1];
    }
  } catch (_) {}

  const alloc = get(`
    SELECT va.*, COALESCE(p.name, va.site_name) AS project_name,
           COALESCE(va.date_from, COALESCE(va.month_from, va.month) || '-01') AS eff_from,
           COALESCE(va.date_to, CASE WHEN va.is_current = 1 THEN NULL ELSE date(COALESCE(va.month_to, va.month) || '-01', '+1 month', '-1 day') END) AS eff_to
      FROM fleet_vehicle_allocations va
      LEFT JOIN projects p ON p.id = va.project_id
     WHERE va.asset_id = ?
       ${targetProjId ? 'AND va.project_id = ?' : ''}
     ORDER BY CASE WHEN va.month = ? THEN 0 ELSE 1 END,
              CASE WHEN COALESCE(va.date_from, COALESCE(va.month_from, va.month) || '-01') <= ? AND (va.is_current = 1 OR COALESCE(va.date_to, date(COALESCE(va.month_to, va.month) || '-01', '+1 month', '-1 day')) >= ?) THEN 0 ELSE 1 END,
              va.is_current DESC, va.month DESC
     LIMIT 1
  `, ...(targetProjId ? [asset.id, targetProjId, periodKey, monthEndDate, fromDate] : [asset.id, periodKey, monthEndDate, fromDate]));

  const assign = get(`
    SELECT fa.*, p.name AS project_name
      FROM fleet_asset_assignments fa
      LEFT JOIN projects p ON p.id = fa.project_id
     WHERE fa.asset_id = ?
       ${targetProjId ? 'AND fa.project_id = ?' : ''}
       AND substr(fa.start_date, 1, 10) <= ?
       AND (fa.end_date IS NULL OR substr(fa.end_date, 1, 10) >= ?)
     ORDER BY fa.start_date DESC LIMIT 1
  `, ...(targetProjId ? [asset.id, targetProjId, monthEndDate, fromDate] : [asset.id, monthEndDate, fromDate]));

  const effTlProjId = timelineStay ? timelineStay.projectId : null;
  const tlProj = effTlProjId ? get('SELECT id, name FROM projects WHERE id = ?', effTlProjId) : null;
  const reqProj = targetProjId ? get('SELECT id, name FROM projects WHERE id = ?', targetProjId) : null;
  const currProj = asset.current_project_id ? get('SELECT id, name FROM projects WHERE id = ?', asset.current_project_id) : null;

  const prefillRateBasis = (rateCard && rateCard.rate_basis) || (rateCard && rateCard.fuel_cons_basis === 'km' ? 'KM' : 'HOURLY');
  const openingMeter = fuelRow.min_meter ? fuelRow.min_meter : null;
  const closingMeter = fuelRow.max_meter ? fuelRow.max_meter : null;
  let actualUnits = (openingMeter != null && closingMeter != null && closingMeter > openingMeter)
    ? Math.round((closingMeter - openingMeter) * 10) / 10
    : 0;

  const billingMode = assetIsHired
    ? 'BILLED_DIRECT'
    : ((assign && assign.billing_type)
      || (alloc && alloc.basis)
      || (timelineStay && timelineStay.allocBases && timelineStay.allocBases[0])
      || (rateCard && rateCard.default_basis)
      || 'DRY_WITH_DRIVER');
  const projectId = targetProjId || (timelineStay && timelineStay.projectId) || (assign && assign.project_id) || (alloc && alloc.project_id) || asset.current_project_id || null;
  const projectName = (reqProj && reqProj.name) || (tlProj && tlProj.name) || (assign && assign.project_name) || (alloc && (alloc.project_name || alloc.site_name)) || (currProj && currProj.name) || null;
  const allocDateFrom = (timelineStay && timelineStay.intervals && timelineStay.intervals.length ? timelineStay.intervals[0].start : null)
    || (assign && assign.start_date ? String(assign.start_date).slice(0, 10) : null)
    || (alloc && alloc.eff_from)
    || null;
  const allocDateTo = (timelineStay && timelineStay.intervals && timelineStay.intervals.length ? timelineStay.intervals[timelineStay.intervals.length - 1].end : null)
    || (assign ? (assign.end_date ? String(assign.end_date).slice(0, 10) : null) : (alloc ? alloc.eff_to : null));
  const siteOverlapDays = timelineStay
    ? (timelineStay.postedDays || lastDay)
    : (allocDateFrom ? (overlapDays(allocDateFrom, allocDateTo || monthEndDate, fromDate, monthEndDate) || lastDay) : lastDay);

  if (prefillRateBasis === 'DAILY' && actualUnits === 0) {
    actualUnits = siteOverlapDays >= lastDay
      ? workingDaysPerMonth
      : Math.min(workingDaysPerMonth, siteOverlapDays);
  }
  const prefillMinUnits = (prefillRateBasis === 'DAILY' && (!rateCard || !(Number(rateCard.min_bill_hours) > 0)))
    ? actualUnits
    : resolveDefaultMinUnits(prefillRateBasis, rateCard);

  res.json({
    asset: {
      id: asset.id,
      code: asset.code || asset.ec_code,
      registration: asset.registration,
      category: asset.type,
    },
    periodKey,
    daysInMonth: lastDay,
    workingDaysInMonth: workingDaysPerMonth,
    isHired: assetIsHired,
    rateCard: rateCard || null,
    openingMeter,
    closingMeter,
    actualUnits,
    fuelLitres: Math.round((fuelRow.litres || 0) * 100) / 100,
    fuelPriceCents: periodFuelPriceCents,
    breakdownDays: bdStatus.breakdownDays,
    billingBlocked: bdStatus.billingBlocked,
    fullMonthDown: bdStatus.fullMonthDown,
    blockReason: bdStatus.blockReason,
    openBreakdowns: bdStatus.openBreakdowns,
    breakdownRecords: bdStatus.records,
    projectId,
    projectName,
    allocDateFrom,
    allocDateTo,
    siteOverlapDays,
    driverName: (timelineStay && timelineStay.driverName) || (assign && assign.driver_name) || (alloc && alloc.driver_name) || null,
    billingMode,
    rateBasis: prefillRateBasis,
    rateCents: pickRateForMode(rateCard, billingMode),
    dryRateCents: rateCard ? (rateCard.dry_rate_cents || rateCard.rate_cents || 0) : 0,
    wetRateCents: rateCard ? (rateCard.wet_rate_cents || rateCard.rate_cents || 0) : 0,
    fullyWetRateCents: rateCard ? (rateCard.fully_wet_rate_cents || rateCard.wet_rate_cents || 0) : 0,
    minBillHours: prefillMinUnits,
  });
}));

router.get('/bills/:id', requireAuth, requireCap('hire.billing.view', 'costing.view'), asyncHandler(async (req, res) => {
  const bill = get(`
    SELECT b.*, COALESCE(u.full_name, u.username) AS generator_name, COALESCE(au.full_name, au.username) AS approver_name
      FROM fleet_bills b
      LEFT JOIN users u ON u.id = b.generated_by
      LEFT JOIN users au ON au.id = b.approved_by
     WHERE b.id = ?
  `, req.params.id);

  if (!bill) return res.status(404).json({ error: 'Rental bill not found' });

  const lineItems = all(`
    SELECT * FROM fleet_bill_line_items
     WHERE bill_id = ?
     ORDER BY is_deduction ASC, id ASC
  `, req.params.id);
  const fuelLine = lineItems.find((li) => li.item_type === 'FUEL');
  const resolvedFuelPriceCents = (fuelLine && fuelLine.unit_price_cents > 0)
    ? fuelLine.unit_price_cents
    : resolvePeriodFuelPriceCents({
        litres: bill.fuel_litres,
        totalFuelCostCents: bill.fuel_cost_cents,
        asOfDate: bill.period_end,
      });

  const revisions = all(`
    SELECT r.*, COALESCE(u.full_name, u.username) AS creator_name
      FROM fleet_bill_revisions r
      LEFT JOIN users u ON u.id = r.created_by
     WHERE r.bill_id = ?
     ORDER BY r.revision_number DESC
  `, req.params.id);

  const payments = all(`
    SELECT p.*, COALESCE(u.full_name, u.username) AS creator_name
      FROM fleet_bill_payments p
      LEFT JOIN users u ON u.id = p.created_by
     WHERE p.bill_id = ?
     ORDER BY p.paid_date DESC, p.created_at DESC
  `, req.params.id);

  const paidCents = payments.reduce((acc, p) => acc + (p.amount_cents || 0), 0);

  res.json({
    bill: {
      ...bill,
      fuel_price_cents: resolvedFuelPriceCents,
      paid_cents: paidCents,
      balance_cents: Math.max(0, (bill.grand_total_cents || 0) - paidCents),
    },
    lineItems,
    revisions,
    payments,
  });
}));

router.post('/bills/generate', requireAuth, requireCap('hire.billing.generate', 'costing.manage'), asyncHandler(async (req, res) => {
  const {
    assetCode, assetId: reqAssetId, year, month, actualUnits, openingMeter, closingMeter,
    rateCents, rateBasis = 'HOURLY', billingMode = 'DRY_WITH_DRIVER',
    minBillHours = null, fuelLitres = 0, fuelPriceCents = null,
    breakdownDays = 0, projectId = null, driverName = null, notes = null
  } = req.body;

  if ((!assetCode && !reqAssetId) || !year || !month) {
    return res.status(400).json({ error: 'assetCode (or assetId), year, and month are required' });
  }

  const asset = (reqAssetId ? get('SELECT * FROM assets WHERE id = ?', Number(reqAssetId)) : null)
    || v2Engine.resolveVehicle(assetCode)
    || identity.resolveAsset(assetCode);
  const resolvedCode = asset ? (asset.code || asset.ec_code || asset.registration) : String(assetCode).trim();
  const assetId = asset ? asset.id : null;

  if ((asset && fuelTimeline.isHiredAsset(asset)) || ['BILLED_DIRECT', 'FREE_OF_CHARGE'].includes(String(billingMode || '').trim().toUpperCase())) {
    return res.status(409).json({
      error: `${resolvedCode} is marked as hired/external (settled outside — neither rental nor fuel is billed to site).`,
      billingBlocked: true,
      hiredDirect: true,
    });
  }

  const y = Number(year);
  const m = Number(month);
  const periodKey = `${y}-${String(m).padStart(2, '0')}`;
  const period = breakdowns.monthBounds(periodKey);
  if (!period) return res.status(400).json({ error: 'Invalid year or month' });

  const lockProjectId = projectId ? Number(projectId) : (asset && asset.current_project_id ? Number(asset.current_project_id) : 0);
  const periodLock = periodLocks.isPeriodLocked(periodKey, lockProjectId || 0);
  if (periodLock) {
    return res.status(409).json({
      error: `Billing period ${periodKey} is locked${periodLock.reason ? `: ${periodLock.reason}` : ''}`,
      periodLocked: true,
      lock: periodLock,
    });
  }

  // Enforce: "if machine breakdown we can't bill"
  let effectiveBreakdownDays = Number(breakdownDays) || 0;
  if (assetId) {
    const bdStatus = breakdowns.getAssetBillingBreakdownStatus(assetId, periodKey);
    if (bdStatus.billingBlocked || bdStatus.fullMonthDown) {
      return res.status(409).json({
        error: bdStatus.blockReason,
        billingBlocked: true,
        breakdownDays: bdStatus.breakdownDays,
        openBreakdowns: bdStatus.openBreakdowns,
      });
    }
    effectiveBreakdownDays = Math.max(effectiveBreakdownDays, bdStatus.breakdownDays);
  }

  let periodFuelRow = null;
  if ((!fuelPriceCents || Number(fuelPriceCents) <= 0) && assetId) {
    periodFuelRow = get(`
      SELECT COALESCE(SUM(litres), 0) AS litres,
             COALESCE(SUM(COALESCE(total_cost_cents, cost_cents, total_price * 100, 0)), 0) AS fuel_cost_cents
        FROM fuel_issues
       WHERE is_voided = 0 AND asset_id = ? AND issue_date BETWEEN ? AND ?
    `, assetId, period.start, `${period.end} 23:59:59`);
  }
  const effFuelPriceCents = resolvePeriodFuelPriceCents({
    explicitCents: fuelPriceCents,
    litres: periodFuelRow ? periodFuelRow.litres : 0,
    totalFuelCostCents: periodFuelRow ? periodFuelRow.fuel_cost_cents : 0,
    asOfDate: period.end,
  });

  const rateCard = assetId ? get('SELECT * FROM fleet_rental_rates WHERE asset_id = ? LIMIT 1', assetId) : null;
  const resolvedMinUnits = minBillHours != null && minBillHours !== ''
    ? (Number(minBillHours) || 0)
    : resolveDefaultMinUnits(rateBasis, rateCard);

  const calculation = calc.calculateRentalBill({
    actualUnits: Number(actualUnits) || 0,
    rateBasis,
    rateCents: Number(rateCents) || 0,
    billingMode,
    minimumUnits: resolvedMinUnits,
    breakdownDays: effectiveBreakdownDays,
    workingDaysInMonth: WORKING_DAYS_PER_MONTH,
    daysInMonth: period.daysInMonth,
    fuelLitres: Number(fuelLitres) || 0,
    fuelPriceCents: effFuelPriceCents,
  });

  const billId = `bill-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const actorId = req.user ? req.user.id : 1;
  const effProjectId = projectId ? Number(projectId) : (asset && asset.current_project_id ? asset.current_project_id : null);
  const proj = effProjectId ? get('SELECT * FROM projects WHERE id = ?', effProjectId) : null;

  tx(() => {
    insertGeneratedBill({
      billId,
      status: 'DRAFT',
      period,
      asset,
      assetCode: resolvedCode,
      project: proj,
      driverName,
      billingMode,
      rateBasis,
      rateCents,
      openingMeter,
      closingMeter,
      calculation,
      fuelPriceCents: effFuelPriceCents,
      notes,
      actorId,
    });
  });

  logAudit(req, 'fleet_bill', assetId, 'hire.bill.generated', {
    billId,
    assetCode: resolvedCode,
    projectId: proj ? proj.id : null,
    periodKey,
    grandTotalCents: calculation.grandTotalCents,
  });
  res.status(201).json({ id: billId, calculation });
}));

router.post('/bills/generate-site', requireAuth, requireCap('hire.billing.generate', 'costing.manage'), asyncHandler(async (req, res) => {
  const {
    projectId = 'ALL',
    month = currentMonthKey(),
    selectedAssetIds = null,
    finalise = false,
    allowOpenBreakdownDeduction = false,
  } = req.body || {};
  const plan = buildSiteMonthlyPlan(projectId, String(month).trim().slice(0, 7), {
    allowOpenBreakdownDeduction: Boolean(allowOpenBreakdownDeduction),
  });
  const actorId = req.user ? req.user.id : 1;
  const period = breakdowns.monthBounds(plan.month);
  const targetStatus = finalise ? 'FINAL' : 'DRAFT';
  const filterSet = Array.isArray(selectedAssetIds) && selectedAssetIds.length
    ? new Set(selectedAssetIds.map((x) => Number(x)))
    : null;

  const monthLock = periodLocks.isPeriodLocked(plan.month, 0);
  if (monthLock) {
    return res.status(409).json({
      error: `Billing period ${plan.month} is locked${monthLock.reason ? `: ${monthLock.reason}` : ''}`,
      periodLocked: true,
      lock: monthLock,
    });
  }
  if (plan.project) {
    const siteLock = periodLocks.isPeriodLocked(plan.month, plan.project.id);
    if (siteLock) {
      return res.status(409).json({
        error: `Billing period ${plan.month} for ${plan.project.name} is locked${siteLock.reason ? `: ${siteLock.reason}` : ''}`,
        periodLocked: true,
        lock: siteLock,
      });
    }
  }

  let generatedBills = 0;
  let skippedAlreadyBilled = 0;
  let skippedMissingRate = 0;
  const skippedLocked = [];
  const skippedBreakdowns = [];
  const createdBills = [];

  const siteLockCache = new Map();
  tx(() => {
    for (const item of plan.items) {
      if (filterSet && !filterSet.has(Number(item.assetId))) continue;
      const itemPid = item.projectId ? Number(item.projectId) : 0;
      if (!siteLockCache.has(itemPid)) {
        siteLockCache.set(itemPid, periodLocks.isPeriodLocked(plan.month, itemPid));
      }
      if (siteLockCache.get(itemPid)) {
        skippedLocked.push({ assetId: item.assetId, assetCode: item.assetCode, projectId: itemPid, projectName: item.projectName });
        continue;
      }
      if (item.billingBlocked) {
        skippedBreakdowns.push({ assetId: item.assetId, assetCode: item.assetCode, projectName: item.projectName, reason: item.blockReason });
        continue;
      }
      if (item.existingBill) {
        skippedAlreadyBilled++;
        continue;
      }
      if (!item.hasRate) {
        skippedMissingRate++;
        continue;
      }

      const billId = `bill-site-${plan.month}-p${item.projectId || 0}-a${item.assetId}-${Math.random().toString(36).slice(2, 5)}`;
      const invoiceNumber = targetStatus === 'FINAL'
        ? `INV-${plan.year}${String(plan.monthNum).padStart(2, '0')}-P${item.projectId || 0}-A${item.assetId}`
        : null;
      const proj = item.projectId ? { id: item.projectId, name: item.projectName, code: item.projectCode } : null;
      const asset = { id: item.assetId, registration: item.registration };

      insertGeneratedBill({
        billId,
        invoiceNumber,
        status: targetStatus,
        period,
        asset,
        assetCode: item.assetCode,
        project: proj,
        driverName: item.driverName,
        billingMode: item.billingMode,
        rateBasis: item.rateBasis,
        rateCents: item.rateCents,
        openingMeter: item.openingMeter,
        closingMeter: item.closingMeter,
        calculation: item.calculation,
        fuelPriceCents: item.fuelPriceCents,
        notes: `Site monthly billing — ${item.projectName} (${plan.month})`,
        actorId,
      });

      generatedBills++;
      createdBills.push({ id: billId, assetCode: item.assetCode, projectName: item.projectName, grandTotalCents: item.calculation.grandTotalCents });
    }
  });

  logAudit(req, 'fleet_bill', plan.project ? plan.project.id : null, 'hire.bill.site_generated', {
    month: plan.month,
    projectId: plan.project ? plan.project.id : 'ALL',
    generatedBills,
    skippedBreakdownsCount: skippedBreakdowns.length,
  });

  res.status(201).json({
    ok: true,
    month: plan.month,
    projectId: plan.project ? plan.project.id : 'ALL',
    projectName: plan.project ? plan.project.name : 'All Sites',
    generatedBills,
    skippedAlreadyBilled,
    skippedMissingRate,
    skippedLockedCount: skippedLocked.length,
    skippedLocked,
    skippedBreakdownsCount: skippedBreakdowns.length,
    skippedBreakdowns,
    bills: createdBills,
  });
}));

router.post('/bills/:id/revise', requireAuth, requireCap('hire.billing.generate', 'hire.billing.finalise'), asyncHandler(async (req, res) => {
  const bill = get('SELECT * FROM fleet_bills WHERE id = ?', req.params.id);
  if (!bill) return res.status(404).json({ error: 'Rental bill not found' });

  const lock = periodLocks.isPeriodLocked(bill.period_key, bill.project_id || 0);
  if (lock) {
    return res.status(409).json({
      error: `Billing period ${bill.period_key} is locked${lock.reason ? `: ${lock.reason}` : ''}`,
      periodLocked: true,
      lock,
    });
  }

  const {
    actualUnits = bill.actual_units,
    rateCents = bill.rate_cents,
    rateBasis = bill.rate_basis,
    billingMode = bill.billing_mode,
    minBillHours = bill.minimum_units,
    fuelLitres = bill.fuel_litres,
    fuelPriceCents = null,
    breakdownDays = bill.breakdown_days,
    reason = 'Amended rental bill parameters',
  } = req.body;

  const existingFuelLine = get("SELECT unit_price_cents FROM fleet_bill_line_items WHERE bill_id = ? AND item_type = 'FUEL' LIMIT 1", bill.id);
  const explicitPrice = fuelPriceCents != null && fuelPriceCents !== '' && Number(fuelPriceCents) > 0 ? Number(fuelPriceCents) : null;
  let periodFuelRow = null;
  if (!explicitPrice && (!existingFuelLine || !existingFuelLine.unit_price_cents) && !(bill.fuel_litres > 0 && bill.fuel_cost_cents > 0) && bill.asset_id) {
    periodFuelRow = get(`
      SELECT COALESCE(SUM(litres), 0) AS litres,
             COALESCE(SUM(COALESCE(total_cost_cents, cost_cents, total_price * 100, 0)), 0) AS fuel_cost_cents
        FROM fuel_issues
       WHERE is_voided = 0 AND asset_id = ? AND issue_date BETWEEN ? AND ?
    `, bill.asset_id, bill.period_start, `${bill.period_end} 23:59:59`);
  }
  const effFuelPriceCents = resolvePeriodFuelPriceCents({
    explicitCents: explicitPrice || (existingFuelLine ? existingFuelLine.unit_price_cents : null),
    litres: periodFuelRow ? periodFuelRow.litres : bill.fuel_litres,
    totalFuelCostCents: periodFuelRow ? periodFuelRow.fuel_cost_cents : bill.fuel_cost_cents,
    asOfDate: bill.period_end,
  });

  const daysInMonth = new Date(bill.year, bill.month, 0).getDate();
  const calculation = calc.calculateRentalBill({
    actualUnits: Number(actualUnits) || 0,
    rateBasis,
    rateCents: Number(rateCents) || 0,
    billingMode,
    minimumUnits: Number(minBillHours) || 0,
    breakdownDays: Number(breakdownDays) || 0,
    workingDaysInMonth: WORKING_DAYS_PER_MONTH,
    daysInMonth,
    fuelLitres: Number(fuelLitres) || 0,
    fuelPriceCents: effFuelPriceCents,
  });

  const actorId = req.user ? req.user.id : 1;
  const maxRev = (get('SELECT MAX(revision_number) AS m FROM fleet_bill_revisions WHERE bill_id = ?', bill.id) || {}).m || 0;
  const revNo = maxRev + 1;
  const revId = `brev-${bill.id}-${revNo}`;

  tx(() => {
    run(`
      INSERT INTO fleet_bill_revisions (
        id, bill_id, revision_number, change_summary, snapshot_json, grand_total_cents, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `, revId, bill.id, revNo, String(reason || 'Amended rental bill parameters'), JSON.stringify({
      before: {
        actual_units: bill.actual_units,
        rate_cents: bill.rate_cents,
        billing_mode: bill.billing_mode,
        fuel_litres: bill.fuel_litres,
        fuel_price_cents: existingFuelLine ? existingFuelLine.unit_price_cents : null,
        breakdown_days: bill.breakdown_days,
        breakdown_deduct_cents: bill.breakdown_deduct_cents,
        grand_total_cents: bill.grand_total_cents,
      },
      after: { ...calculation, fuelPriceCents: effFuelPriceCents },
    }), calculation.grandTotalCents, actorId);

    run(`
      UPDATE fleet_bills
         SET billing_mode = ?,
             rate_basis = ?,
             rate_cents = ?,
             actual_units = ?,
             minimum_units = ?,
             billable_units = ?,
             rental_amount_cents = ?,
             fuel_litres = ?,
             fuel_cost_cents = ?,
             breakdown_days = ?,
             breakdown_deduct_cents = ?,
             subtotal_cents = ?,
             sscl_cents = ?,
             vat_cents = ?,
             grand_total_cents = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `, billingMode, rateBasis, Number(rateCents) || 0,
       calculation.actualUnits, calculation.minimumUnits, calculation.billableUnits,
       calculation.rentalAmountCents, calculation.fuelLitres, calculation.fuelChargedCents,
       calculation.breakdownDays, calculation.breakdownDeductCents,
       calculation.subtotalCents, calculation.ssclCents, calculation.vatCents,
       calculation.grandTotalCents, bill.id);

    syncBillCoreLineItems({
      billId: bill.id,
      billingMode,
      rateBasis,
      rateCents,
      calculation,
      fuelPriceCents: effFuelPriceCents,
    });

    if (bill.status === 'FINAL') {
      syncBillFinalFinancialEvents({
        billId: bill.id,
        assetId: bill.asset_id,
        assetCode: bill.asset_code,
        projectId: bill.project_id,
        periodEnd: bill.period_end,
        year: bill.year,
        month: bill.month,
        calculation,
      });
    }
  });

  logAudit(req, 'fleet_bill', bill.asset_id, 'hire.bill.revised', { billId: bill.id, revisionNumber: revNo, fuelPriceCents: effFuelPriceCents, reason });
  res.json({ ok: true, id: bill.id, revisionNumber: revNo, fuelPriceCents: effFuelPriceCents, calculation });
}));

router.post('/bills/:id/finalise', requireAuth, requireCap('hire.billing.finalise', 'costing.manage'), asyncHandler(async (req, res) => {
  const bill = get('SELECT * FROM fleet_bills WHERE id = ?', req.params.id);
  if (!bill) return res.status(404).json({ error: 'Rental bill not found' });
  if (bill.status === 'FINAL') return res.status(400).json({ error: 'Bill is already finalized' });

  const lock = periodLocks.isPeriodLocked(bill.period_key, bill.project_id || 0);
  if (lock) {
    return res.status(409).json({
      error: `Billing period ${bill.period_key} is locked${lock.reason ? `: ${lock.reason}` : ''}`,
      periodLocked: true,
      lock,
    });
  }

  if (bill.asset_id) {
    const bdStatus = breakdowns.getAssetBillingBreakdownStatus(bill.asset_id, bill.period_key);
    if (bdStatus.billingBlocked || bdStatus.fullMonthDown) {
      return res.status(409).json({
        error: bdStatus.blockReason,
        billingBlocked: true,
        openBreakdowns: bdStatus.openBreakdowns,
      });
    }
  }

  const invoiceNo = bill.invoice_number || `INV-${bill.year}${String(bill.month).padStart(2, '0')}-${Math.floor(1000 + Math.random() * 9000)}`;
  const actorId = req.user ? req.user.id : 1;

  tx(() => {
    run(`
      UPDATE fleet_bills
         SET status = 'FINAL',
             invoice_number = ?,
             issued_date = date('now'),
             approved_by = ?,
             approved_at = datetime('now'),
             updated_at = datetime('now')
       WHERE id = ?
    `, invoiceNo, actorId, req.params.id);

    const eventKey = `FIN-REV-RENTAL-${bill.id}`;
    run(`
      INSERT OR REPLACE INTO fleet_financial_events (
        id, event_key, event_type, asset_id, asset_code, project_id, business_date,
        year, month, amount_cents, quantity, unit, source_system, source_table, source_id
      ) VALUES (
        ?, ?, 'REVENUE_RENTAL', ?, ?, ?, ?,
        ?, ?, ?, ?, 'HOURS', 'WORKSHOPONE', 'fleet_bills', ?
      )
    `, eventKey, eventKey, bill.asset_id, bill.asset_code, bill.project_id,
       bill.period_end, bill.year, bill.month, bill.rental_amount_cents,
       bill.billable_units, bill.id);

    if (bill.fuel_cost_cents > 0) {
      const fuelRevKey = `FIN-REV-FUEL-${bill.id}`;
      run(`
        INSERT OR REPLACE INTO fleet_financial_events (
          id, event_key, event_type, asset_id, asset_code, project_id, business_date,
          year, month, amount_cents, quantity, unit, source_system, source_table, source_id
        ) VALUES (
          ?, ?, 'REVENUE_FUEL', ?, ?, ?, ?,
          ?, ?, ?, ?, 'LITRES', 'WORKSHOPONE', 'fleet_bills', ?
        )
      `, fuelRevKey, fuelRevKey, bill.asset_id, bill.asset_code, bill.project_id,
         bill.period_end, bill.year, bill.month, bill.fuel_cost_cents,
         bill.fuel_litres, bill.id);
    }
  });

  logAudit(req, 'fleet_bill', bill.asset_id, 'hire.bill.finalised', { billId: req.params.id, invoiceNo });
  res.json({ id: req.params.id, status: 'FINAL', invoice_number: invoiceNo });
}));

router.post('/bills/finalise-site', requireAuth, requireCap('hire.billing.finalise', 'costing.manage'), asyncHandler(async (req, res) => {
  const { projectId, periodKey, month, lockAfter = false, lockReason = null } = req.body || {};
  const pk = String(periodKey || month || '').trim().slice(0, 7);
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(pk)) {
    return res.status(400).json({ error: 'Valid periodKey (YYYY-MM) is required' });
  }

  const isAll = projectId == null || projectId === '' || String(projectId).trim().toUpperCase() === 'ALL';
  const pid = isAll ? 0 : Number(projectId);
  if (!isAll && !Number.isFinite(pid)) {
    return res.status(400).json({ error: 'Valid projectId is required' });
  }

  const existingLock = periodLocks.isPeriodLocked(pk, pid);
  if (existingLock) {
    return res.status(409).json({
      error: `Billing period ${pk} is already locked${existingLock.reason ? `: ${existingLock.reason}` : ''}`,
      periodLocked: true,
      lock: existingLock,
    });
  }

  const draftBills = pid > 0
    ? all("SELECT * FROM fleet_bills WHERE period_key = ? AND project_id = ? AND status = 'DRAFT' ORDER BY asset_code ASC", pk, pid)
    : all("SELECT * FROM fleet_bills WHERE period_key = ? AND status = 'DRAFT' ORDER BY project_name ASC, asset_code ASC", pk);

  const actorId = req.user ? req.user.id : 1;
  let finalisedCount = 0;
  const skippedBreakdowns = [];
  const finalisedIds = [];
  let lockRecord = null;

  tx(() => {
    for (const bill of draftBills) {
      if (pid === 0) {
        const siteLock = periodLocks.isPeriodLocked(bill.period_key, bill.project_id || 0);
        if (siteLock) continue;
      }

      if (bill.asset_id) {
        const bdStatus = breakdowns.getAssetBillingBreakdownStatus(bill.asset_id, bill.period_key);
        if (bdStatus.billingBlocked || bdStatus.fullMonthDown) {
          skippedBreakdowns.push({
            billId: bill.id,
            assetId: bill.asset_id,
            assetCode: bill.asset_code,
            reason: bdStatus.blockReason,
          });
          continue;
        }
      }

      let invoiceNo = bill.invoice_number;
      if (!invoiceNo) {
        const candidate = `INV-${bill.year}${String(bill.month).padStart(2, '0')}-P${bill.project_id || 0}-A${bill.asset_id || bill.id}`;
        const clash = get('SELECT id FROM fleet_bills WHERE invoice_number = ? AND id != ?', candidate, bill.id);
        invoiceNo = clash ? `${candidate}-${Math.floor(100 + Math.random() * 900)}` : candidate;
      }

      run(`
        UPDATE fleet_bills
           SET status = 'FINAL',
               invoice_number = ?,
               issued_date = date('now'),
               approved_by = ?,
               approved_at = datetime('now'),
               updated_at = datetime('now')
         WHERE id = ?
      `, invoiceNo, actorId, bill.id);

      syncBillFinalFinancialEvents({
        billId: bill.id,
        assetId: bill.asset_id,
        assetCode: bill.asset_code,
        projectId: bill.project_id,
        periodEnd: bill.period_end,
        year: bill.year,
        month: bill.month,
        calculation: {
          rentalAmountCents: bill.rental_amount_cents || 0,
          billableUnits: bill.billable_units || 0,
          fuelChargedCents: bill.fuel_cost_cents || 0,
          fuelLitres: bill.fuel_litres || 0,
        },
      });

      finalisedCount++;
      finalisedIds.push(bill.id);
    }

    if (lockAfter && skippedBreakdowns.length === 0) {
      lockRecord = periodLocks.lockPeriod({
        periodKey: pk,
        projectId: pid,
        userId: actorId,
        reason: lockReason || `Finalised ${finalisedCount} bill(s) for ${pk}`,
      });
    }
  });

  logAudit(req, 'fleet_bill', pid || null, 'hire.bills.finalised_site', {
    periodKey: pk,
    projectId: pid,
    finalisedCount,
    skippedBreakdownsCount: skippedBreakdowns.length,
    locked: Boolean(lockRecord),
  });

  res.json({
    ok: true,
    periodKey: pk,
    projectId: pid,
    finalisedCount,
    finalisedIds,
    skippedBreakdowns,
    locked: Boolean(lockRecord),
    lock: lockRecord,
  });
}));

router.get('/period-locks', requireAuth, requireCap('hire.billing.view', 'costing.view'), asyncHandler(async (req, res) => {
  const periodKey = req.query.periodKey || null;
  res.json({ locks: periodLocks.listPeriodLocks(periodKey) });
}));

router.post('/period-locks', requireAuth, requireCap('hire.billing.finalise', 'costing.manage'), asyncHandler(async (req, res) => {
  const { periodKey, projectId = 0, locked = true, reason = '' } = req.body || {};
  const pk = String(periodKey || '').trim().slice(0, 7);
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(pk)) {
    return res.status(400).json({ error: 'Valid periodKey (YYYY-MM) is required' });
  }
  const pid = projectId != null && Number(projectId) > 0 ? Number(projectId) : 0;
  const actorId = req.user ? req.user.id : 1;
  const cleanReason = String(reason || '').trim();

  if (locked === false) {
    if (!cleanReason) {
      return res.status(400).json({ error: 'An unlock reason is required for audit compliance' });
    }
    const resUnlock = periodLocks.unlockPeriod({ periodKey: pk, projectId: pid });
    logAudit(req, 'billing_period_lock', pid || null, 'hire.period.unlocked', { periodKey: pk, projectId: pid, ...resUnlock }, null, cleanReason);
    return res.json({
      ok: true,
      periodKey: pk,
      projectId: pid,
      locked: false,
      lock: null,
      locks: periodLocks.listPeriodLocks(pk),
    });
  }

  const lock = periodLocks.lockPeriod({
    periodKey: pk,
    projectId: pid,
    userId: actorId,
    reason: cleanReason || `Locked via Billing Console (${pk})`,
  });
  logAudit(req, 'billing_period_lock', pid || null, 'hire.period.locked', { periodKey: pk, projectId: pid, lock }, null, lock.reason);
  res.json({
    ok: true,
    periodKey: pk,
    projectId: pid,
    locked: true,
    lock,
    locks: periodLocks.listPeriodLocks(pk),
  });
}));

// ---------------------------------------------------------------------------
// 2. Payments & Receivables Aging Report
// ---------------------------------------------------------------------------

router.post('/bills/:id/payments', requireAuth, requireCap('hire.billing.generate', 'hire.billing.finalise', 'costing.manage'), asyncHandler(async (req, res) => {
  const bill = get('SELECT * FROM fleet_bills WHERE id = ?', req.params.id);
  if (!bill) return res.status(404).json({ error: 'Rental bill not found' });

  const { amountLkr, amountCents, paidDate, method = 'BANK_TRANSFER', reference, note } = req.body;
  const cents = amountCents != null ? Math.round(Number(amountCents)) : Math.round(Number(amountLkr || 0) * 100);
  if (!cents || cents <= 0) {
    return res.status(400).json({ error: 'Payment amount must be greater than zero' });
  }

  const payId = `bpay-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const actorId = req.user ? req.user.id : 1;
  const dateStr = paidDate || new Date().toISOString().slice(0, 10);

  run(`
    INSERT INTO fleet_bill_payments (
      id, bill_id, amount_cents, paid_date, method, reference, note, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `, payId, bill.id, cents, dateStr, method, reference || null, note || null, actorId);

  const totalPaid = (get('SELECT COALESCE(SUM(amount_cents), 0) AS s FROM fleet_bill_payments WHERE bill_id = ?', bill.id) || {}).s || 0;
  if (totalPaid >= (bill.grand_total_cents || 0) && bill.status !== 'PAID') {
    run("UPDATE fleet_bills SET status = 'PAID', updated_at = datetime('now') WHERE id = ?", bill.id);
  }

  res.status(201).json({
    ok: true,
    id: payId,
    paid_cents: totalPaid,
    balance_cents: Math.max(0, (bill.grand_total_cents || 0) - totalPaid),
  });
}));

router.get('/aging', requireAuth, requireCap('hire.billing.view', 'costing.view'), asyncHandler(async (req, res) => {
  const rows = all(`
    SELECT b.*,
           COALESCE((SELECT SUM(p.amount_cents) FROM fleet_bill_payments p WHERE p.bill_id = b.id), 0) AS paid_cents
      FROM fleet_bills b
     WHERE b.status != 'VOID'
     ORDER BY COALESCE(b.issued_date, b.period_end) ASC
  `);

  const nowMs = Date.now();
  const buckets = {
    b0_30: { label: '0–30 Days', count: 0, balance_cents: 0 },
    b31_60: { label: '31–60 Days', count: 0, balance_cents: 0 },
    b61_90: { label: '61–90 Days', count: 0, balance_cents: 0 },
    b90_plus: { label: '90+ Days', count: 0, balance_cents: 0 },
  };

  const items = rows.map((r) => {
    const balanceCents = Math.max(0, (r.grand_total_cents || 0) - (r.paid_cents || 0));
    const refDate = r.issued_date || r.period_end || r.created_at;
    const ageDays = refDate ? Math.max(0, Math.floor((nowMs - new Date(refDate).getTime()) / 86400000)) : 0;
    let bucket = '0–30';
    if (balanceCents > 0) {
      if (ageDays <= 30) { buckets.b0_30.count++; buckets.b0_30.balance_cents += balanceCents; bucket = '0–30'; }
      else if (ageDays <= 60) { buckets.b31_60.count++; buckets.b31_60.balance_cents += balanceCents; bucket = '31–60'; }
      else if (ageDays <= 90) { buckets.b61_90.count++; buckets.b61_90.balance_cents += balanceCents; bucket = '61–90'; }
      else { buckets.b90_plus.count++; buckets.b90_plus.balance_cents += balanceCents; bucket = '90+'; }
    } else {
      bucket = 'PAID';
    }
    return {
      ...r,
      balance_cents: balanceCents,
      age_days: ageDays,
      aging_bucket: bucket,
    };
  });

  res.json({ buckets, items });
}));

// ---------------------------------------------------------------------------
// 3. Machine Rental Rates, Portable Plant & Standard Consumption Bands
// ---------------------------------------------------------------------------

router.get('/rates', requireAuth, requireCap('hire.rates.view', 'fuel.view'), asyncHandler(async (req, res) => {
  const rates = all(`
    SELECT r.*, COALESCE(a.code, a.ec_code) AS asset_code, a.registration AS asset_reg,
           a.type AS asset_category, a.type AS asset_type,
           a.brand, a.model_no, p.name AS current_site
      FROM fleet_rental_rates r
      LEFT JOIN assets a ON a.id = r.asset_id
      LEFT JOIN projects p ON p.id = a.current_project_id
     ORDER BY COALESCE(r.equip_type, 'FLEET') ASC, COALESCE(r.category_name, a.type) ASC, a.code ASC
  `);
  res.json({ rates });
}));

router.get('/rates-overview', requireAuth, requireCap('hire.rates.view', 'fuel.view'), asyncHandler(async (req, res) => {
  const { search = '', category = '', equipType = '', consBasis = '' } = req.query;

  const fleetRates = all(`
    SELECT r.*,
           a.id AS resolved_asset_id,
           COALESCE(a.code, a.ec_code) AS asset_code,
           a.registration AS asset_reg,
           COALESCE(r.category_name, a.type) AS category,
           a.brand, a.model_no, a.type AS asset_type, p.name AS current_site,
           f.total_litres, f.min_meter, f.max_meter, f.fills
      FROM fleet_rental_rates r
      LEFT JOIN assets a ON a.id = r.asset_id
      LEFT JOIN projects p ON p.id = a.current_project_id
      LEFT JOIN (
        SELECT asset_id,
               COUNT(*) AS fills,
               ROUND(SUM(litres), 1) AS total_litres,
               MIN(CASE WHEN meter_reading > 0 THEN meter_reading ELSE NULL END) AS min_meter,
               MAX(CASE WHEN meter_reading > 0 THEN meter_reading ELSE NULL END) AS max_meter
          FROM fuel_issues
         WHERE is_voided = 0 AND asset_id IS NOT NULL
         GROUP BY asset_id
      ) f ON f.asset_id = r.asset_id
     WHERE COALESCE(r.equip_type, 'FLEET') = 'FLEET'
     ORDER BY COALESCE(r.category_name, a.type) ASC, a.code ASC
  `).map((r) => {
    const inferredBasis = v2Engine.inferMeterType({ code: r.asset_code, category: r.category, type: r.asset_type }, r) === 'KM' ? 'km' : 'hr';
    const basis = (r.fuel_cons_basis === 'km' || r.rate_basis === 'KM')
      ? 'km'
      : (r.fuel_cons_basis === 'hr' ? 'hr' : inferredBasis);
    const dispUnit = basis === 'km' ? 'km/L' : 'L/hr';
    const effRateBasis = r.rate_basis === 'DAILY' || r.rate_basis === 'MONTHLY' || r.rate_basis === 'FLAT'
      ? r.rate_basis
      : (basis === 'km' ? 'KM' : 'HOURLY');
    const rateUnitLabel = effRateBasis === 'KM'
      ? 'Rs/km'
      : (effRateBasis === 'DAILY' ? 'Rs/day' : (effRateBasis === 'MONTHLY' ? 'Rs/mo' : 'Rs/hr'));

    const econDisp = v2Engine.toDisplayRate(r.fuel_cons_econ, basis);
    const typDisp = v2Engine.toDisplayRate(r.fuel_cons_typ, basis);
    const heavyDisp = v2Engine.toDisplayRate(r.fuel_cons_heavy, basis);

    const span = (r.max_meter && r.min_meter && r.max_meter > r.min_meter) ? (r.max_meter - r.min_meter) : 0;
    const measuredStorage = (span > 0 && r.total_litres > 0) ? (r.total_litres / span) : null;
    const measuredDisp = v2Engine.toDisplayRate(measuredStorage, basis);
    const verdict = v2Engine.classifyBand(measuredStorage, r.fuel_cons_econ, r.fuel_cons_typ, r.fuel_cons_heavy);
    const effMinUnits = Number(r.min_bill_hours) > 0
      ? Number(r.min_bill_hours)
      : (effRateBasis === 'KM' ? 3000 : (effRateBasis === 'HOURLY' ? 120 : 0));

    const useKmCols =
      effRateBasis === 'KM' &&
      String(r.rate_basis || '').toUpperCase() !== 'KM' &&
      (Number(r.km_wet_cents) > 0 || Number(r.km_dry_cents) > 0);
    const outDry = useKmCols ? (r.km_dry_cents ?? 0) : r.dry_rate_cents;
    const outWet = useKmCols ? (r.km_wet_cents ?? 0) : r.wet_rate_cents;
    const outFw = useKmCols ? (r.km_fw_cents ?? 0) : r.fully_wet_rate_cents;
    const outRate = useKmCols ? (r.km_dry_cents || r.km_wet_cents || 0) : r.rate_cents;

    return {
      ...r,
      cons_basis: basis,
      rate_basis: effRateBasis,
      rate_unit_label: rateUnitLabel,
      display_unit: dispUnit,
      rate_cents: outRate,
      dry_rate_cents: outDry,
      wet_rate_cents: outWet,
      fully_wet_rate_cents: outFw,
      min_bill_hours: effMinUnits,
      min_bill_units: effMinUnits,
      working_days_per_month: WORKING_DAYS_PER_MONTH,
      econ_display: econDisp != null ? Math.round(econDisp * 100) / 100 : null,
      typ_display: typDisp != null ? Math.round(typDisp * 100) / 100 : null,
      heavy_display: heavyDisp != null ? Math.round(heavyDisp * 100) / 100 : null,
      measured_display: measuredDisp != null ? Math.round(measuredDisp * 100) / 100 : null,
      verdict,
    };
  });

  const portableRates = all(`
    SELECT r.*,
           COALESCE(a.code, a.ec_code) AS asset_code,
           a.registration AS asset_reg,
           p.name AS current_site
      FROM fleet_rental_rates r
      LEFT JOIN assets a ON a.id = r.asset_id
      LEFT JOIN projects p ON p.id = a.current_project_id
     WHERE r.equip_type = 'PORTABLE'
     ORDER BY (r.asset_id IS NOT NULL) DESC, COALESCE(a.code, r.category_name) ASC, r.id ASC
  `);

  let filteredFleet = fleetRates;
  if (consBasis && ['hr', 'km'].includes(String(consBasis).toLowerCase())) {
    const wantedCons = String(consBasis).toLowerCase();
    filteredFleet = filteredFleet.filter((r) => r.cons_basis === wantedCons);
  }
  if (search) {
    const q = v2Engine.squashCode(search);
    filteredFleet = filteredFleet.filter((r) =>
      v2Engine.squashCode(r.asset_code).includes(q) ||
      v2Engine.squashCode(r.asset_reg).includes(q) ||
      String(r.category || '').toUpperCase().includes(q) ||
      String(r.brand || '').toUpperCase().includes(q) ||
      String(r.model_no || '').toUpperCase().includes(q) ||
      String(r.source_label || '').toUpperCase().includes(q)
    );
  }
  if (category) {
    filteredFleet = filteredFleet.filter((r) => String(r.category || '').toLowerCase() === String(category).toLowerCase());
  }

  const machineryHr = filteredFleet.filter((r) => r.cons_basis === 'hr');
  const vehiclesKm = filteredFleet.filter((r) => r.cons_basis === 'km');
  const categories = [...new Set(fleetRates.map((r) => r.category).filter(Boolean))].sort();
  const categoriesHr = [...new Set(fleetRates.filter((r) => r.cons_basis === 'hr').map((r) => r.category).filter(Boolean))].sort();
  const categoriesKm = [...new Set(fleetRates.filter((r) => r.cons_basis === 'km').map((r) => r.category).filter(Boolean))].sort();

  res.json({
    fleet: equipType === 'PORTABLE' ? [] : filteredFleet,
    machinery_hr: equipType === 'PORTABLE' ? [] : machineryHr,
    vehicles_km: equipType === 'PORTABLE' ? [] : vehiclesKm,
    portable: equipType === 'FLEET' ? [] : portableRates,
    categories,
    categories_hr: categoriesHr,
    categories_km: categoriesKm,
    summary: {
      totalFleetRates: fleetRates.length,
      machineryHrCount: fleetRates.filter((r) => r.cons_basis === 'hr').length,
      vehiclesKmCount: fleetRates.filter((r) => r.cons_basis === 'km').length,
      hourlyRateCount: fleetRates.filter((r) => r.rate_basis === 'HOURLY').length,
      kmRateCount: fleetRates.filter((r) => r.rate_basis === 'KM').length,
      withConsumptionBands: fleetRates.filter((r) => r.fuel_cons_typ > 0).length,
      totalPortableClasses: portableRates.length,
    },
  });
}));

router.post('/rates', requireAuth, requireCap('hire.rates.manage', 'costing.manage'), asyncHandler(async (req, res) => {
  const {
    id, assetId: reqAssetId, assetCode, categoryName, rateBasis, rateCents,
    dryRateCents, wetRateCents, fullyWetRateCents, minBillHours = null,
    defaultBasis = 'DRY_WITH_DRIVER', equipType = 'FLEET',
    portDdCents, portDwCents, sourceLabel,
    econDisplay, typDisplay, heavyDisplay, fuelConsBasis, note
  } = req.body;

  let resolvedAssetId = reqAssetId ? Number(reqAssetId) : null;
  let resolvedCat = categoryName || null;
  let resolvedAsset = null;
  if (!resolvedAssetId && assetCode && String(equipType).toUpperCase() !== 'PORTABLE') {
    resolvedAsset = v2Engine.resolveVehicle(assetCode) || identity.resolveAsset(assetCode);
    if (resolvedAsset) {
      resolvedAssetId = resolvedAsset.id;
      if (!resolvedCat) resolvedCat = resolvedAsset.category || resolvedAsset.type || null;
    }
  } else if (resolvedAssetId) {
    resolvedAsset = get('SELECT * FROM assets WHERE id = ?', resolvedAssetId);
  }

  const reqBasisNorm = rateBasis ? normalizeRateBasis(rateBasis) : null;
  const reqConsBasis = fuelConsBasis && ['hr', 'km'].includes(String(fuelConsBasis).toLowerCase())
    ? String(fuelConsBasis).toLowerCase()
    : null;

  // Synchronize L/hr <-> HOURLY and km/L <-> KM seamlessly
  let basis = reqConsBasis;
  if (!basis) {
    if (reqBasisNorm === 'KM') basis = 'km';
    else if (reqBasisNorm === 'HOURLY') basis = 'hr';
    else if (resolvedAsset) basis = v2Engine.inferMeterType(resolvedAsset, null) === 'KM' ? 'km' : 'hr';
    else basis = 'hr';
  }

  let normBasis = reqBasisNorm || (basis === 'km' ? 'KM' : 'HOURLY');
  if (reqConsBasis === 'km' && (!reqBasisNorm || reqBasisNorm === 'HOURLY')) normBasis = 'KM';
  if (reqConsBasis === 'hr' && (!reqBasisNorm || reqBasisNorm === 'KM')) normBasis = 'HOURLY';

  const normEqType = String(equipType || 'FLEET').toUpperCase() === 'PORTABLE' ? 'PORTABLE' : 'FLEET';
  if (normEqType === 'PORTABLE' && !reqBasisNorm) normBasis = 'DAILY';
  const normDefBasis = normalizeAllocBasis(defaultBasis, 'DRY');
  const effMinBillHours = (minBillHours != null && minBillHours !== '' && Number(minBillHours) > 0)
    ? Number(minBillHours)
    : resolveDefaultMinUnits(normBasis);
  const rateId = id || (resolvedAssetId ? `rate-asset-${resolvedAssetId}` : `rate-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`);

  const econVal = econDisplay != null && econDisplay !== '' ? v2Engine.fromDisplayRate(Number(econDisplay), basis) : null;
  const typVal = typDisplay != null && typDisplay !== '' ? v2Engine.fromDisplayRate(Number(typDisplay), basis) : null;
  const heavyVal = heavyDisplay != null && heavyDisplay !== '' ? v2Engine.fromDisplayRate(Number(heavyDisplay), basis) : null;

  const dryC = dryRateCents != null ? Math.round(Number(dryRateCents)) : (portDdCents != null ? Math.round(Number(portDdCents)) : null);
  const wetC = wetRateCents != null ? Math.round(Number(wetRateCents)) : (portDwCents != null ? Math.round(Number(portDwCents)) : null);
  const fwC = fullyWetRateCents != null ? Math.round(Number(fullyWetRateCents)) : null;
  const baseC = rateCents != null ? Math.round(Number(rateCents)) : (dryC != null ? dryC : 0);

  const hrD = normBasis === 'HOURLY' ? dryC : null;
  const hrW = normBasis === 'HOURLY' ? wetC : null;
  const hrFw = normBasis === 'HOURLY' ? fwC : null;
  const kmD = normBasis === 'KM' ? dryC : null;
  const kmW = normBasis === 'KM' ? wetC : null;
  const kmFw = normBasis === 'KM' ? fwC : null;
  const dyD = normBasis === 'DAILY' ? dryC : null;
  const dyW = normBasis === 'DAILY' ? wetC : null;
  const dyFw = normBasis === 'DAILY' ? fwC : null;

  const rateCols = new Set(all('PRAGMA table_info(fleet_rental_rates)').map((c) => c.name));
  const hasTierCols = rateCols.has('km_dry_cents');

  if (hasTierCols) {
    run(`
      INSERT INTO fleet_rental_rates (
        id, asset_id, category_name, rate_basis, rate_cents,
        dry_rate_cents, wet_rate_cents, fully_wet_rate_cents, min_bill_hours,
        equip_type, default_basis, port_dd_cents, port_dw_cents, source_label,
        fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy, fuel_cons_basis, note,
        hr_dry_cents, hr_wet_cents, hr_fw_cents,
        dy_dry_cents, dy_wet_cents, dy_fw_cents,
        km_dry_cents, km_wet_cents, km_fw_cents
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        category_name = COALESCE(excluded.category_name, fleet_rental_rates.category_name),
        rate_basis = excluded.rate_basis,
        rate_cents = COALESCE(excluded.rate_cents, fleet_rental_rates.rate_cents),
        dry_rate_cents = COALESCE(excluded.dry_rate_cents, fleet_rental_rates.dry_rate_cents),
        wet_rate_cents = COALESCE(excluded.wet_rate_cents, fleet_rental_rates.wet_rate_cents),
        fully_wet_rate_cents = COALESCE(excluded.fully_wet_rate_cents, fleet_rental_rates.fully_wet_rate_cents),
        min_bill_hours = COALESCE(excluded.min_bill_hours, fleet_rental_rates.min_bill_hours),
        equip_type = COALESCE(excluded.equip_type, fleet_rental_rates.equip_type),
        default_basis = COALESCE(excluded.default_basis, fleet_rental_rates.default_basis),
        port_dd_cents = COALESCE(excluded.port_dd_cents, fleet_rental_rates.port_dd_cents),
        port_dw_cents = COALESCE(excluded.port_dw_cents, fleet_rental_rates.port_dw_cents),
        source_label = COALESCE(excluded.source_label, fleet_rental_rates.source_label),
        fuel_cons_econ = COALESCE(excluded.fuel_cons_econ, fleet_rental_rates.fuel_cons_econ),
        fuel_cons_typ = COALESCE(excluded.fuel_cons_typ, fleet_rental_rates.fuel_cons_typ),
        fuel_cons_heavy = COALESCE(excluded.fuel_cons_heavy, fleet_rental_rates.fuel_cons_heavy),
        fuel_cons_basis = excluded.fuel_cons_basis,
        note = COALESCE(excluded.note, fleet_rental_rates.note),
        hr_dry_cents = COALESCE(excluded.hr_dry_cents, fleet_rental_rates.hr_dry_cents),
        hr_wet_cents = COALESCE(excluded.hr_wet_cents, fleet_rental_rates.hr_wet_cents),
        hr_fw_cents = COALESCE(excluded.hr_fw_cents, fleet_rental_rates.hr_fw_cents),
        dy_dry_cents = COALESCE(excluded.dy_dry_cents, fleet_rental_rates.dy_dry_cents),
        dy_wet_cents = COALESCE(excluded.dy_wet_cents, fleet_rental_rates.dy_wet_cents),
        dy_fw_cents = COALESCE(excluded.dy_fw_cents, fleet_rental_rates.dy_fw_cents),
        km_dry_cents = COALESCE(excluded.km_dry_cents, fleet_rental_rates.km_dry_cents),
        km_wet_cents = COALESCE(excluded.km_wet_cents, fleet_rental_rates.km_wet_cents),
        km_fw_cents = COALESCE(excluded.km_fw_cents, fleet_rental_rates.km_fw_cents),
        updated_at = datetime('now')
    `, rateId, resolvedAssetId, resolvedCat, normBasis, baseC,
       dryC, wetC, fwC, effMinBillHours,
       normEqType, normDefBasis,
       portDdCents != null ? Math.round(Number(portDdCents)) : (normEqType === 'PORTABLE' ? dryC : null),
       portDwCents != null ? Math.round(Number(portDwCents)) : (normEqType === 'PORTABLE' ? wetC : null),
       sourceLabel || null,
       econVal, typVal, heavyVal, basis, note || null,
       hrD, hrW, hrFw, dyD, dyW, dyFw, kmD, kmW, kmFw);
  } else {
    run(`
      INSERT INTO fleet_rental_rates (
        id, asset_id, category_name, rate_basis, rate_cents,
        dry_rate_cents, wet_rate_cents, fully_wet_rate_cents, min_bill_hours,
        equip_type, default_basis, port_dd_cents, port_dw_cents, source_label,
        fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy, fuel_cons_basis, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        category_name = COALESCE(excluded.category_name, fleet_rental_rates.category_name),
        rate_basis = excluded.rate_basis,
        rate_cents = COALESCE(excluded.rate_cents, fleet_rental_rates.rate_cents),
        dry_rate_cents = COALESCE(excluded.dry_rate_cents, fleet_rental_rates.dry_rate_cents),
        wet_rate_cents = COALESCE(excluded.wet_rate_cents, fleet_rental_rates.wet_rate_cents),
        fully_wet_rate_cents = COALESCE(excluded.fully_wet_rate_cents, fleet_rental_rates.fully_wet_rate_cents),
        min_bill_hours = COALESCE(excluded.min_bill_hours, fleet_rental_rates.min_bill_hours),
        equip_type = COALESCE(excluded.equip_type, fleet_rental_rates.equip_type),
        default_basis = COALESCE(excluded.default_basis, fleet_rental_rates.default_basis),
        port_dd_cents = COALESCE(excluded.port_dd_cents, fleet_rental_rates.port_dd_cents),
        port_dw_cents = COALESCE(excluded.port_dw_cents, fleet_rental_rates.port_dw_cents),
        source_label = COALESCE(excluded.source_label, fleet_rental_rates.source_label),
        fuel_cons_econ = COALESCE(excluded.fuel_cons_econ, fleet_rental_rates.fuel_cons_econ),
        fuel_cons_typ = COALESCE(excluded.fuel_cons_typ, fleet_rental_rates.fuel_cons_typ),
        fuel_cons_heavy = COALESCE(excluded.fuel_cons_heavy, fleet_rental_rates.fuel_cons_heavy),
        fuel_cons_basis = excluded.fuel_cons_basis,
        note = COALESCE(excluded.note, fleet_rental_rates.note),
        updated_at = datetime('now')
    `, rateId, resolvedAssetId, resolvedCat, normBasis, baseC,
       dryC, wetC, fwC, effMinBillHours,
       normEqType, normDefBasis,
       portDdCents != null ? Math.round(Number(portDdCents)) : (normEqType === 'PORTABLE' ? dryC : null),
       portDwCents != null ? Math.round(Number(portDwCents)) : (normEqType === 'PORTABLE' ? wetC : null),
       sourceLabel || null,
       econVal, typVal, heavyVal, basis, note || null);
  }

  logAudit(req, 'fleet_rental_rate', resolvedAssetId, 'hire.rate.saved', { rateId, assetId: resolvedAssetId, rateBasis: normBasis, fuelConsBasis: basis });
  res.status(201).json({ id: rateId, rateBasis: normBasis, fuelConsBasis: basis, success: true });
}));

router.get('/rates-unrated', requireAuth, requireCap('hire.rates.view', 'hire.billing.view', 'costing.view'), asyncHandler(async (_req, res) => {
  const cutoff60 = fuelTimeline.addDays(fuelTimeline.todaySlst(), -60);
  const assetCols = new Set(all('PRAGMA table_info(assets)').map((c) => c.name));
  const ownerFilter = assetCols.has('ownership') ? "COALESCE(a.ownership, 'OWNED') = 'OWNED'" : '1 = 1';
  const regFilter = assetCols.has('in_register') ? 'COALESCE(a.in_register, 1) = 1' : '1 = 1';

  const candidates = all(`
    SELECT a.*, p.name AS current_site_name, p.code AS current_site_code
      FROM assets a
      LEFT JOIN projects p ON p.id = a.current_project_id
     WHERE ${ownerFilter}
       AND ${regFilter}
       AND LOWER(COALESCE(a.status, 'active')) NOT IN ('decommissioned', 'disposed', 'scrapped')
       AND NOT EXISTS (SELECT 1 FROM fleet_rental_rates r WHERE r.asset_id = a.id)
     ORDER BY a.code ASC
  `).filter((a) => !fuelTimeline.isNonMachineFuelRow({}, a));

  const tankProjMap = fuelTimeline.loadTankProjectMap();
  const projectNames = new Map(all('SELECT id, code, name FROM projects').map((p) => [Number(p.id), p.name || p.code]));
  const hasDirectCol = all('PRAGMA table_info(fuel_issues)').some((c) => c.name === 'is_direct_billed');
  const fuelRows = all(`
    SELECT id, asset_id, litres, issue_date, source_tank_id, bulk_tank_id,
           target_project_id, project_id, source_project_id
      FROM fuel_issues
     WHERE is_voided = 0
       AND asset_id IS NOT NULL
       ${hasDirectCol ? 'AND COALESCE(is_direct_billed, 0) = 0' : ''}
     ORDER BY issue_date DESC, id DESC
  `);

  const fuelByAsset = new Map();
  for (const fi of fuelRows) {
    const aid = Number(fi.asset_id);
    const day = fuelTimeline.slstDate10(fi.issue_date);
    const litres = Number(fi.litres || 0);
    const cur = fuelByAsset.get(aid) || {
      totalSlips: 0,
      totalLitres: 0,
      recentSlips: 0,
      recentLitres: 0,
      lastFuelDate: null,
      lastSiteName: null,
    };
    cur.totalSlips++;
    cur.totalLitres += litres;
    if (day && day >= cutoff60) {
      cur.recentSlips++;
      cur.recentLitres += litres;
    }
    if (!cur.lastFuelDate && day) {
      cur.lastFuelDate = day;
      const pid = fuelTimeline.resolveIssueProjectId(fi, tankProjMap);
      cur.lastSiteName = pid != null ? (projectNames.get(Number(pid)) || null) : null;
    }
    fuelByAsset.set(aid, cur);
  }

  const unrated = candidates.map((a) => {
    const f = fuelByAsset.get(Number(a.id)) || {
      totalSlips: 0,
      totalLitres: 0,
      recentSlips: 0,
      recentLitres: 0,
      lastFuelDate: null,
      lastSiteName: a.current_site_name || null,
    };
    return {
      asset_id: a.id,
      asset_code: a.code || a.ec_code || a.registration,
      registration: a.registration || null,
      brand: a.brand || null,
      type: a.type || null,
      model_no: a.model_no || null,
      meter_type: a.meter_type || null,
      current_site_name: f.lastSiteName || a.current_site_name || null,
      last_fuel_date: f.lastFuelDate,
      recent_slips: f.recentSlips,
      recent_litres: Math.round(f.recentLitres * 10) / 10,
      total_slips: f.totalSlips,
      total_litres: Math.round(f.totalLitres * 10) / 10,
    };
  }).sort((a, b) => {
    if (b.recent_litres !== a.recent_litres) return b.recent_litres - a.recent_litres;
    if (b.total_litres !== a.total_litres) return b.total_litres - a.total_litres;
    return String(a.asset_code || '').localeCompare(String(b.asset_code || ''));
  });

  // Canonical category templates (selecting modal rate tuple per category+basis)
  const rawRates = all(`
    SELECT r.*, COALESCE(NULLIF(TRIM(r.category_name), ''), NULLIF(TRIM(a.type), '')) AS cat_label
      FROM fleet_rental_rates r
      LEFT JOIN assets a ON a.id = r.asset_id
     ORDER BY r.updated_at DESC, r.id DESC
  `);
  const catBuckets = new Map();
  for (const r of rawRates) {
    if (!r.cat_label) continue;
    const eq = String(r.equip_type || 'FLEET').toUpperCase();
    const rb = String(r.rate_basis || 'HOURLY').toUpperCase();
    const key = `${r.cat_label}||${rb}||${eq}`;
    if (!catBuckets.has(key)) catBuckets.set(key, []);
    catBuckets.get(key).push(r);
  }

  const templates = [];
  for (const [, rows] of catBuckets.entries()) {
    const tupleCounts = new Map();
    let bestRow = rows[0];
    let bestScore = -1;
    for (const r of rows) {
      const tupleKey = `${r.dry_rate_cents || 0}|${r.wet_rate_cents || 0}|${r.fully_wet_rate_cents || 0}`;
      const cnt = (tupleCounts.get(tupleKey) || 0) + 1;
      tupleCounts.set(tupleKey, cnt);
      if (cnt > bestScore) {
        bestScore = cnt;
        bestRow = r;
      }
    }
    templates.push({
      template_rate_id: bestRow.id,
      category: bestRow.cat_label,
      rate_basis: bestRow.rate_basis || 'HOURLY',
      equip_type: String(bestRow.equip_type || 'FLEET').toUpperCase(),
      dry_rate_cents: bestRow.dry_rate_cents ?? bestRow.rate_cents ?? 0,
      wet_rate_cents: bestRow.wet_rate_cents ?? 0,
      fully_wet_rate_cents: bestRow.fully_wet_rate_cents ?? 0,
      fuel_cons_basis: bestRow.fuel_cons_basis || ((bestRow.rate_basis === 'KM') ? 'km' : 'hr'),
      fuel_cons_typ: bestRow.fuel_cons_typ ?? null,
      min_bill_hours: bestRow.min_bill_hours ?? 0,
      count: rows.length,
    });
  }
  templates.sort((a, b) => (b.count - a.count) || String(a.category).localeCompare(String(b.category)));

  res.json({
    unrated,
    recentFueledCount: unrated.filter((u) => u.recent_litres > 0).length,
    totalUnratedCount: unrated.length,
    templates,
  });
}));

router.post('/rates/assign-template', requireAuth, requireCap('hire.rates.manage', 'costing.manage'), asyncHandler(async (req, res) => {
  const {
    assetId,
    templateRateId = null,
    categoryName = null,
    overrideDryCents = null,
    overrideWetCents = null,
    overrideFwCents = null,
  } = req.body || {};

  if (!assetId) return res.status(400).json({ error: 'assetId is required' });
  const asset = get('SELECT * FROM assets WHERE id = ?', Number(assetId));
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  let template = templateRateId
    ? get('SELECT * FROM fleet_rental_rates WHERE id = ?', String(templateRateId))
    : null;
  if (!template && categoryName) {
    template = get(`
      SELECT r.*
        FROM fleet_rental_rates r
        LEFT JOIN assets a ON a.id = r.asset_id
       WHERE LOWER(COALESCE(r.category_name, a.type, '')) = LOWER(?)
       ORDER BY r.updated_at DESC, r.id DESC
       LIMIT 1
    `, String(categoryName).trim());
  }
  if (!template) return res.status(404).json({ error: 'Rate template not found' });

  const normBasis = normalizeRateBasis(template.rate_basis || 'HOURLY');
  const normEqType = String(template.equip_type || 'FLEET').toUpperCase() === 'PORTABLE' ? 'PORTABLE' : 'FLEET';
  const fuelBasis = template.fuel_cons_basis || (normBasis === 'KM' ? 'km' : 'hr');
  const catLabel = String(categoryName || template.category_name || asset.type || '').trim() || null;

  const dryC = overrideDryCents != null && overrideDryCents !== '' && Number.isFinite(Number(overrideDryCents))
    ? Math.round(Number(overrideDryCents))
    : (template.dry_rate_cents ?? template.rate_cents ?? null);
  const wetC = overrideWetCents != null && overrideWetCents !== '' && Number.isFinite(Number(overrideWetCents))
    ? Math.round(Number(overrideWetCents))
    : (template.wet_rate_cents ?? null);
  const fwC = overrideFwCents != null && overrideFwCents !== '' && Number.isFinite(Number(overrideFwCents))
    ? Math.round(Number(overrideFwCents))
    : (template.fully_wet_rate_cents ?? null);
  const baseC = dryC != null ? dryC : (template.rate_cents ?? wetC ?? 0);

  const rateId = `rate-asset-${asset.id}`;
  const rateCols = new Set(all('PRAGMA table_info(fleet_rental_rates)').map((c) => c.name));
  const assetCols = new Set(all('PRAGMA table_info(assets)').map((c) => c.name));

  tx(() => {
    run('DELETE FROM fleet_rental_rates WHERE asset_id = ?', asset.id);

    if (rateCols.has('km_dry_cents')) {
      const hrDry = normBasis === 'HOURLY' ? dryC : template.hr_dry_cents;
      const hrWet = normBasis === 'HOURLY' ? wetC : template.hr_wet_cents;
      const hrFw = normBasis === 'HOURLY' ? fwC : template.hr_fw_cents;
      const dyDry = normBasis === 'DAILY' ? dryC : template.dy_dry_cents;
      const dyWet = normBasis === 'DAILY' ? wetC : template.dy_wet_cents;
      const dyFw = normBasis === 'DAILY' ? fwC : template.dy_fw_cents;
      const kmDry = normBasis === 'KM' ? dryC : template.km_dry_cents;
      const kmWet = normBasis === 'KM' ? wetC : template.km_wet_cents;
      const kmFw = normBasis === 'KM' ? fwC : template.km_fw_cents;

      run(`
        INSERT INTO fleet_rental_rates (
          id, asset_id, category_name, rate_basis, rate_cents,
          dry_rate_cents, wet_rate_cents, fully_wet_rate_cents, min_bill_hours,
          equip_type, default_basis, port_dd_cents, port_dw_cents, source_label,
          fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy, fuel_cons_basis, note,
          hr_dry_cents, hr_wet_cents, hr_fw_cents,
          dy_dry_cents, dy_wet_cents, dy_fw_cents,
          km_dry_cents, km_wet_cents, km_fw_cents
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      rateId, asset.id, catLabel, normBasis, baseC,
      dryC, wetC, fwC, template.min_bill_hours ?? resolveDefaultMinUnits(normBasis),
      normEqType, template.default_basis || 'WET',
      normEqType === 'PORTABLE' ? (dryC ?? template.port_dd_cents) : template.port_dd_cents,
      normEqType === 'PORTABLE' ? (wetC ?? template.port_dw_cents) : template.port_dw_cents,
      template.source_label || `${catLabel || 'Template'} rate`,
      template.fuel_cons_econ, template.fuel_cons_typ, template.fuel_cons_heavy, fuelBasis,
      `Assigned from template ${template.id}`,
      hrDry, hrWet, hrFw, dyDry, dyWet, dyFw, kmDry, kmWet, kmFw);
    } else {
      run(`
        INSERT INTO fleet_rental_rates (
          id, asset_id, category_name, rate_basis, rate_cents,
          dry_rate_cents, wet_rate_cents, fully_wet_rate_cents, min_bill_hours,
          equip_type, default_basis, port_dd_cents, port_dw_cents, source_label,
          fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy, fuel_cons_basis, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      rateId, asset.id, catLabel, normBasis, baseC,
      dryC, wetC, fwC, template.min_bill_hours ?? resolveDefaultMinUnits(normBasis),
      normEqType, template.default_basis || 'WET',
      normEqType === 'PORTABLE' ? (dryC ?? template.port_dd_cents) : template.port_dd_cents,
      normEqType === 'PORTABLE' ? (wetC ?? template.port_dw_cents) : template.port_dw_cents,
      template.source_label || `${catLabel || 'Template'} rate`,
      template.fuel_cons_econ, template.fuel_cons_typ, template.fuel_cons_heavy, fuelBasis,
      `Assigned from template ${template.id}`);
    }

    const updParts = [];
    const updParams = [];
    const curType = String(asset.type || '').trim();
    if (catLabel && (!curType || curType === 'Other Asset' || curType === 'Quick Added')) {
      updParts.push('type = ?');
      updParams.push(catLabel);
    }
    if (assetCols.has('meter_type')) {
      updParts.push('meter_type = ?');
      updParams.push(normBasis === 'KM' || fuelBasis === 'km' ? 'KM' : 'HOURS');
    }
    if (assetCols.has('updated_at')) {
      updParts.push("updated_at = datetime('now')");
    }
    if (updParts.length > 0) {
      run(`UPDATE assets SET ${updParts.join(', ')} WHERE id = ?`, ...updParams, asset.id);
    }
  });

  logAudit(req, 'fleet_rate', asset.id, 'hire.rate.assigned_template', {
    rateId,
    assetId: asset.id,
    assetCode: asset.code,
    templateRateId: template.id,
    categoryName: catLabel,
    rateBasis: normBasis,
    dryRateCents: dryC,
    wetRateCents: wetC,
    fullyWetRateCents: fwC,
  });

  res.status(201).json({
    ok: true,
    id: rateId,
    assetId: asset.id,
    assetCode: asset.code,
    categoryName: catLabel,
    rateBasis: normBasis,
  });
}));

router.post('/rates/mark-hired', requireAuth, requireCap('hire.rates.manage', 'costing.manage'), asyncHandler(async (req, res) => {
  const { assetId, flagDirectBilledFuel = true, reason = 'Hired / outside-billed vehicle' } = req.body || {};
  if (!assetId) return res.status(400).json({ error: 'assetId is required' });

  const asset = get('SELECT * FROM assets WHERE id = ?', Number(assetId));
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  const cleanReason = String(reason || 'Hired / outside-billed vehicle').trim();
  const assetCols = new Set(all('PRAGMA table_info(assets)').map((c) => c.name));
  const fvaCols = new Set(all('PRAGMA table_info(fleet_vehicle_allocations)').map((c) => c.name));
  const fiCols = new Set(all('PRAGMA table_info(fuel_issues)').map((c) => c.name));
  const tankProjMap = fuelTimeline.loadTankProjectMap();

  let draftsVoided = 0;
  let skippedLockedDrafts = 0;
  let fuelFlagged = 0;
  let skippedLockedFuel = 0;

  tx(() => {
    const sets = [];
    const params = [];
    if (assetCols.has('ownership')) {
      sets.push("ownership = 'HIRED'");
    }
    if (assetCols.has('in_register')) {
      sets.push('in_register = 0');
    }
    if (assetCols.has('notes')) {
      const curNote = String(asset.notes || '').trim();
      const tag = `[outside-billed: ${cleanReason}]`;
      const nextNote = curNote.includes('outside-billed')
        ? curNote
        : (curNote ? `${curNote} | ${tag}` : tag);
      sets.push('notes = ?');
      params.push(nextNote);
    }
    if (assetCols.has('updated_at')) {
      sets.push("updated_at = datetime('now')");
    }
    if (sets.length > 0) {
      run(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`, ...params, asset.id);
    }

    run('DELETE FROM fleet_rental_rates WHERE asset_id = ?', asset.id);

    if (fvaCols.size > 0) {
      const fvaSets = ['active = 0'];
      if (fvaCols.has('updated_at')) fvaSets.push("updated_at = datetime('now')");
      const lockedCond = fvaCols.has('locked') ? ' AND COALESCE(locked, 0) = 0' : '';
      run(`UPDATE fleet_vehicle_allocations SET ${fvaSets.join(', ')} WHERE asset_id = ?${lockedCond}`, asset.id);
    }

    try {
      run("UPDATE fleet_asset_assignments SET end_date = date('now') WHERE asset_id = ? AND end_date IS NULL", asset.id);
    } catch (_) {}

    const draftBills = all("SELECT id, period_key, project_id, notes FROM fleet_bills WHERE asset_id = ? AND status = 'DRAFT'", asset.id);
    for (const b of draftBills) {
      if (periodLocks.isPeriodLocked(b.period_key, b.project_id || 0)) {
        skippedLockedDrafts++;
        continue;
      }
      const nextBillNote = b.notes ? `${b.notes} | Voided (marked HIRED)` : 'Voided (marked HIRED)';
      run("UPDATE fleet_bills SET status = 'VOID', notes = ?, updated_at = datetime('now') WHERE id = ?", nextBillNote, b.id);
      draftsVoided++;
    }

    if (flagDirectBilledFuel && fiCols.has('is_direct_billed')) {
      const assetIssues = all(`
        SELECT id, issue_date, project_id, target_project_id, source_project_id, source_tank_id, bulk_tank_id
          FROM fuel_issues
         WHERE is_voided = 0
           AND asset_id = ?
           AND COALESCE(is_direct_billed, 0) = 0
      `, asset.id);
      for (const fi of assetIssues) {
        const day = fuelTimeline.slstDate10(fi.issue_date);
        const pk = day ? day.slice(0, 7) : null;
        const pid = fuelTimeline.resolveIssueProjectId(fi, tankProjMap) || 0;
        if (pk && periodLocks.isPeriodLocked(pk, pid)) {
          skippedLockedFuel++;
          continue;
        }
        run('UPDATE fuel_issues SET is_direct_billed = 1 WHERE id = ?', fi.id);
        fuelFlagged++;
      }
    }
  });

  logAudit(req, 'fleet_rate', asset.id, 'hire.asset.marked_hired', {
    assetId: asset.id,
    assetCode: asset.code,
    draftsVoided,
    skippedLockedDrafts,
    fuelFlagged,
    skippedLockedFuel,
  }, null, cleanReason);

  res.json({
    ok: true,
    assetId: asset.id,
    assetCode: asset.code,
    draftsVoided,
    skippedLockedDrafts,
    fuelFlagged,
    skippedLockedFuel,
  });
}));

// ---------------------------------------------------------------------------
// 4. Machine Site Allocations (Allocator Console)
// ---------------------------------------------------------------------------

router.get('/allocations', requireAuth, requireCap('allocations.view', 'hire.billing.view'), asyncHandler(async (req, res) => {
  const { month, monthFrom, monthTo, dateFrom, dateTo, currentOnly, projectId, assetCode, basis, origin, groupByRange = '1' } = req.query;
  const conditions = [];
  const params = [];
  const curMonth = currentMonthKey();

  const effFromExpr = "COALESCE(va.date_from, COALESCE(va.month_from, va.month) || '-01')";
  const effToExpr = "COALESCE(va.date_to, CASE WHEN va.is_current = 1 THEN '9999-12-31' ELSE date(COALESCE(va.month_to, va.month) || '-01', '+1 month', '-1 day') END)";

  if (month) {
    conditions.push('va.month = ?');
    params.push(String(month));
  }
  if (dateFrom) {
    conditions.push(`${effToExpr} >= ?`);
    params.push(String(dateFrom).slice(0, 10));
  } else if (monthFrom) {
    conditions.push('COALESCE(va.month_to, va.month) >= ?');
    params.push(String(monthFrom).slice(0, 7));
  }
  if (dateTo) {
    conditions.push(`${effFromExpr} <= ?`);
    params.push(String(dateTo).slice(0, 10));
  } else if (monthTo) {
    conditions.push('COALESCE(va.month_from, va.month) <= ?');
    params.push(String(monthTo).slice(0, 7));
  }
  if (currentOnly === '1' || currentOnly === 'true') {
    conditions.push('(va.is_current = 1 OR va.month = ?)');
    params.push(curMonth);
  }
  if (projectId) {
    conditions.push('va.project_id = ?');
    params.push(Number(projectId));
  }
  if (assetCode) {
    conditions.push('(UPPER(va.vehicle_no) LIKE UPPER(?) OR UPPER(COALESCE(a.code, a.ec_code, \'\')) LIKE UPPER(?) OR UPPER(COALESCE(a.registration, \'\')) LIKE UPPER(?))');
    params.push(`%${assetCode}%`, `%${assetCode}%`, `%${assetCode}%`);
  }
  if (basis) {
    conditions.push('UPPER(COALESCE(va.basis, \'\')) = UPPER(?)');
    params.push(String(basis));
  }
  if (origin && origin !== 'ALL') {
    conditions.push("UPPER(COALESCE(va.origin, 'MANUAL')) = UPPER(?)");
    params.push(String(origin));
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rawRows = all(`
    SELECT va.*,
           COALESCE(p.name, va.site_name) AS project_name,
           p.code AS project_code,
           COALESCE(a.code, a.ec_code, va.vehicle_no) AS asset_code,
           COALESCE(a.type, va.machine_type) AS asset_type,
           COALESCE(a.ownership, 'OWNED') AS ownership,
           a.registration,
           a.brand,
           a.model_no,
           COALESCE(va.origin, 'MANUAL') AS origin,
           COALESCE(va.locked, 0) AS locked,
           COALESCE(va.basis, 'DRY_WITH_DRIVER') AS assigned_basis,
           COALESCE(va.month_from, va.month) AS month_from,
           COALESCE(va.month_to, va.month) AS month_to,
           COALESCE(va.date_from, COALESCE(va.month_from, va.month) || '-01') AS date_from,
           COALESCE(va.date_to, CASE WHEN va.is_current = 1 THEN NULL ELSE date(COALESCE(va.month_to, va.month) || '-01', '+1 month', '-1 day') END) AS date_to,
           COALESCE(va.driver_name,
             (SELECT fa.driver_name FROM fleet_asset_assignments fa
               WHERE fa.asset_id = va.asset_id AND fa.project_id = va.project_id
               ORDER BY fa.start_date DESC LIMIT 1)
           ) AS driver_name
      FROM fleet_vehicle_allocations va
      LEFT JOIN projects p ON p.id = va.project_id
      LEFT JOIN assets a ON a.id = va.asset_id
     ${whereClause}
     ORDER BY va.is_current DESC, COALESCE(va.date_from, va.month || '-01') DESC, va.site_name ASC, va.vehicle_no ASC
     LIMIT 800
  `, ...params);

  let rows = rawRows;
  if (groupByRange !== '0') {
    const seen = new Set();
    rows = [];
    for (const r of rawRows) {
      const rangeKey = [
        r.asset_id || r.vehicle_no,
        r.project_id || r.site_name,
        r.date_from || r.month_from || r.month,
        r.is_current ? 'CURRENT' : (r.date_to || r.month_to || r.month),
        r.assigned_basis,
        r.origin || 'MANUAL',
      ].join('|');
      if (seen.has(rangeKey)) continue;
      seen.add(rangeKey);
      rows.push(r);
    }
  }

  res.json({ allocations: rows, currentMonth: curMonth, today: breakdowns.todayStr() });
}));

router.post('/allocations/sync-from-fuel', requireAuth, requireCap('allocations.manage', 'hire.billing.generate'), asyncHandler(async (req, res) => {
  const {
    month = currentMonthKey(),
    projectId = null,
    assetId = null,
    dryRun = false,
  } = req.body || {};
  const actorId = req.user ? req.user.id : 1;
  const result = fuelTimeline.syncFuelAllocations({
    periodKey: String(month).trim().slice(0, 7),
    projectId,
    assetId,
    dryRun: Boolean(dryRun),
    actorId,
  });
  res.json({ ok: true, ...result });
}));

router.post('/allocations', requireAuth, requireCap('allocations.manage', 'hire.billing.generate'), asyncHandler(async (req, res) => {
  const {
    assetId: reqAssetId, assetCode, projectId, siteName,
    month, monthFrom, monthTo, dateFrom, dateTo, isCurrent,
    assignedBasis = 'DRY_WITH_DRIVER', driverName, startDate, endDate, notes, locked = false
  } = req.body;

  if ((!reqAssetId && !assetCode) || (!projectId && !siteName)) {
    return res.status(400).json({ error: 'Vehicle (from Assets) and Project/Site are required' });
  }

  const asset = (reqAssetId ? get('SELECT * FROM assets WHERE id = ?', Number(reqAssetId)) : null)
    || v2Engine.resolveVehicle(assetCode)
    || identity.resolveAsset(assetCode);
  if (!asset && !assetCode) {
    return res.status(400).json({ error: 'Valid vehicle code from Assets is required' });
  }

  const proj = projectId ? get('SELECT * FROM projects WHERE id = ?', Number(projectId)) : null;
  if (projectId && !proj) {
    return res.status(404).json({ error: 'Selected project not found' });
  }

  const curMonth = currentMonthKey();
  const todayDay = breakdowns.todayStr();
  const rawFromDate = dateFrom || startDate;
  const rawToDate = dateTo || endDate;

  let effDateFrom = rawFromDate ? breakdowns.d10(rawFromDate) : null;
  if (rawFromDate && !effDateFrom) {
    return res.status(400).json({ error: 'From date must be a valid YYYY-MM-DD date' });
  }
  if (!effDateFrom) {
    const mf = String(monthFrom || month || '').trim().slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(mf)) effDateFrom = `${mf}-01`;
    else effDateFrom = todayDay;
  }

  let effDateTo = null;
  if (rawToDate !== undefined && rawToDate !== null && String(rawToDate).trim() !== '') {
    effDateTo = breakdowns.d10(rawToDate);
    if (!effDateTo) {
      return res.status(400).json({ error: 'To date must be a valid YYYY-MM-DD date or blank if Current' });
    }
  }

  const explicitCurrent = isCurrent === true || isCurrent === 1 || isCurrent === '1' || isCurrent === 'true';
  const currentFlag = effDateTo ? false : (isCurrent !== undefined ? explicitCurrent : true);

  if (!currentFlag && !effDateTo) {
    const mt = String(monthTo || monthFrom || month || effDateFrom.slice(0, 7)).trim().slice(0, 7);
    effDateTo = /^\d{4}-\d{2}$/.test(mt) ? lastDayOfMonth(mt) : lastDayOfMonth(effDateFrom.slice(0, 7));
  }
  if (effDateTo && effDateTo < effDateFrom) {
    return res.status(400).json({ error: 'To date cannot be earlier than From date' });
  }

  const mFrom = effDateFrom.slice(0, 7);
  const explicitMTo = monthTo ? String(monthTo).trim().slice(0, 7) : '';
  const mToRaw = effDateTo
    ? effDateTo.slice(0, 7)
    : (/^\d{4}-\d{2}$/.test(explicitMTo) ? explicitMTo : (mFrom > curMonth ? mFrom : curMonth));
  const mTo = mToRaw < mFrom ? mFrom : mToRaw;
  const monthsList = expandMonths(mFrom, mTo);
  if (!monthsList.length) {
    return res.status(400).json({ error: 'Allocation date range spans too many months or is invalid' });
  }

  const resolvedSite = proj ? proj.name : String(siteName || '').trim();
  const resolvedCode = asset ? (asset.code || asset.ec_code || asset.registration) : String(assetCode).trim().toUpperCase();
  const machineType = asset ? (asset.type || null) : null;
  const isHired = Boolean(asset && fuelTimeline.isHiredAsset(asset));
  const ownerCode = isHired ? 'HIRED' : 'E&C';
  const resolvedBasis = normalizeAllocBasis(assignedBasis, isHired ? 'BILLED_DIRECT' : 'DRY_WITH_DRIVER');
  const effectiveStartDate = effDateFrom;
  const effectiveEndDate = currentFlag ? null : effDateTo;
  const actorId = req.user ? req.user.id : null;
  const createdIds = [];

  tx(() => {
    // 1. If current/ongoing, clear is_current on previous allocations for this vehicle
    if (currentFlag && asset) {
      run("UPDATE fleet_vehicle_allocations SET is_current = 0, date_to = COALESCE(date_to, ?), updated_at = datetime('now') WHERE asset_id = ? AND is_current = 1", dayBefore(effectiveStartDate), asset.id);
    }

    // 2. Upsert monthly index rows across [mFrom .. mTo] while storing exact date_from & date_to
    const isLockedFlag = locked ? 1 : 0;
    for (const m of monthsList) {
      // Remove any AUTO_FUEL rows in this month superseded by manual allocation
      if (asset) {
        run("DELETE FROM fleet_vehicle_allocations WHERE asset_id = ? AND month = ? AND COALESCE(origin, 'MANUAL') = 'AUTO_FUEL' AND COALESCE(locked, 0) = 0", asset.id, m);
      }
      const dedupeKey = `${resolvedSite}|${m}|${resolvedCode}`;
      const allocId = `valloc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      run(`
        INSERT INTO fleet_vehicle_allocations (
          id, dedupe_key, asset_id, vehicle_no, project_id, site_name,
          month, month_from, month_to, date_from, date_to, is_current, machine_type, owner_code,
          basis, active, driver_name, notes, origin, locked, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'MANUAL', ?, datetime('now'), datetime('now'))
        ON CONFLICT(dedupe_key) DO UPDATE SET
          asset_id = COALESCE(excluded.asset_id, fleet_vehicle_allocations.asset_id),
          project_id = COALESCE(excluded.project_id, fleet_vehicle_allocations.project_id),
          site_name = excluded.site_name,
          month_from = excluded.month_from,
          month_to = excluded.month_to,
          date_from = excluded.date_from,
          date_to = excluded.date_to,
          is_current = excluded.is_current,
          machine_type = COALESCE(excluded.machine_type, fleet_vehicle_allocations.machine_type),
          owner_code = excluded.owner_code,
          basis = excluded.basis,
          active = 1,
          driver_name = COALESCE(excluded.driver_name, fleet_vehicle_allocations.driver_name),
          notes = COALESCE(excluded.notes, fleet_vehicle_allocations.notes),
          origin = 'MANUAL',
          locked = excluded.locked,
          updated_at = datetime('now')
      `, allocId, dedupeKey, asset ? asset.id : null, resolvedCode,
         proj ? proj.id : null, resolvedSite, m, mFrom, mTo,
         effectiveStartDate, effectiveEndDate, currentFlag ? 1 : 0, machineType, ownerCode, resolvedBasis,
         driverName || null, notes || null, isLockedFlag);
      createdIds.push(allocId);
    }

    // 3. Maintain continuous assignment record in fleet_asset_assignments
    if (asset && proj) {
      const prevEnd = dayBefore(effectiveStartDate);
      run(`
        UPDATE fleet_asset_assignments
           SET end_date = CASE WHEN substr(start_date, 1, 10) <= ? THEN ? ELSE start_date END,
               updated_at = datetime('now')
         WHERE asset_id = ? AND end_date IS NULL
      `, prevEnd, prevEnd, asset.id);

      run(`
        INSERT INTO fleet_asset_assignments (
          id, asset_id, asset_code, project_id, project_code, driver_name,
          start_date, end_date, billing_type, origin, note, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', ?, ?, datetime('now'), datetime('now'))
      `, `assign-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
         asset.id, resolvedCode, proj.id, proj.code || null, driverName || null,
         effectiveStartDate, effectiveEndDate, resolvedBasis, notes || null, actorId);
    }

    // 4. Update active current_project_id on assets (and log asset move if changed)
    if (asset && proj && (currentFlag || !asset.current_project_id)) {
      const prevProjId = asset.current_project_id || null;
      if (prevProjId !== proj.id) {
        try {
          run(`
            INSERT INTO asset_moves (asset_id, move_date, from_project_id, from_site_id, to_project_id, to_site_id, note, moved_by)
            VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
          `, asset.id, effectiveStartDate > todayDay ? todayDay : effectiveStartDate,
             prevProjId, asset.current_site_id || null, proj.id,
             `Site Allocator (${resolvedBasis})`, actorId);
        } catch (_) {}
      }
      run(`
        UPDATE assets
           SET current_project_id = ?,
               current_site_id = NULL,
               updated_at = datetime('now')
         WHERE id = ?
      `, proj.id, asset.id);
    }
  });

  logAudit(req, 'fleet_vehicle_allocation', asset ? asset.id : null, 'hire.allocation.created', {
    allocIds: createdIds,
    assetCode: resolvedCode,
    siteName: resolvedSite,
    assignedBasis: resolvedBasis,
    dateFrom: effectiveStartDate,
    dateTo: effectiveEndDate,
    monthFrom: mFrom,
    monthTo: mTo,
    isCurrent: currentFlag,
  });

  res.status(201).json({
    ok: true,
    id: createdIds[0],
    monthsCount: monthsList.length,
    assetCode: resolvedCode,
    siteName: resolvedSite,
    assignedBasis: resolvedBasis,
    dateFrom: effectiveStartDate,
    dateTo: effectiveEndDate,
    monthFrom: mFrom,
    monthTo: mTo,
    isCurrent: currentFlag,
  });
}));

router.patch('/allocations/:id', requireAuth, requireCap('allocations.manage', 'hire.billing.generate'), asyncHandler(async (req, res) => {
  const row = get('SELECT * FROM fleet_vehicle_allocations WHERE id = ?', req.params.id);
  if (!row) return res.status(404).json({ error: 'Allocation not found' });

  const { assignedBasis, driverName, notes, monthTo, dateFrom, dateTo, isCurrent, locked, action } = req.body || {};
  const nextCurrent = action === 'end' ? 0 : (isCurrent !== undefined ? (isCurrent ? 1 : 0) : row.is_current);
  const nextLocked = action === 'lock' ? 1 : (action === 'unlock' ? 0 : (locked !== undefined ? (locked ? 1 : 0) : (row.locked || 0)));
  const nextOrigin = (action === 'lock' || nextLocked === 1) ? 'MANUAL' : (row.origin || 'MANUAL');
  const nextDateFrom = dateFrom ? (breakdowns.d10(dateFrom) || row.date_from) : row.date_from;
  let nextDateTo = row.date_to;
  if (action === 'end') {
    nextDateTo = breakdowns.todayStr();
  } else if (dateTo !== undefined) {
    nextDateTo = dateTo ? breakdowns.d10(dateTo) : null;
  } else if (nextCurrent && action !== 'lock' && action !== 'unlock') {
    nextDateTo = null;
  }
  if (nextDateFrom && nextDateTo && nextDateTo < nextDateFrom) {
    return res.status(400).json({ error: 'To date cannot be earlier than From date' });
  }
  const nextMonthFrom = nextDateFrom ? nextDateFrom.slice(0, 7) : row.month_from;
  const nextMonthTo = nextDateTo ? nextDateTo.slice(0, 7) : (monthTo || (action === 'end' ? currentMonthKey() : row.month_to));
  const nextBasis = assignedBasis ? normalizeAllocBasis(assignedBasis, row.basis || 'DRY_WITH_DRIVER') : row.basis;

  tx(() => {
    run(`
      UPDATE fleet_vehicle_allocations
         SET basis = ?,
             driver_name = COALESCE(?, driver_name),
             notes = COALESCE(?, notes),
             date_from = COALESCE(?, date_from),
             date_to = ?,
             month_from = COALESCE(?, month_from),
             month_to = COALESCE(?, month_to),
             is_current = ?,
             origin = ?,
             locked = ?,
             updated_at = datetime('now')
       WHERE id = ?
          OR (vehicle_no = ? AND COALESCE(project_id, 0) = COALESCE(?, 0) AND COALESCE(date_from, '') = COALESCE(?, '') AND COALESCE(month_from, '') = COALESCE(?, ''))
    `, nextBasis, driverName !== undefined ? (driverName || null) : null,
       notes !== undefined ? (notes || null) : null,
       nextDateFrom || null, nextDateTo || null,
       nextMonthFrom || null, nextMonthTo || null, nextCurrent,
       nextOrigin, nextLocked,
       row.id, row.vehicle_no, row.project_id, row.date_from, row.month_from);

    if (action === 'end' && row.asset_id) {
      run(`
        UPDATE fleet_asset_assignments
           SET end_date = ?, updated_at = datetime('now')
         WHERE asset_id = ? AND project_id IS ? AND end_date IS NULL
      `, nextDateTo || breakdowns.todayStr(), row.asset_id, row.project_id);
    }
  });

  logAudit(req, 'fleet_vehicle_allocation', row.asset_id, 'hire.allocation.updated', {
    id: row.id,
    basis: nextBasis,
    isCurrent: nextCurrent,
    locked: nextLocked,
    origin: nextOrigin,
    dateFrom: nextDateFrom,
    dateTo: nextDateTo,
    monthTo: nextMonthTo,
  });
  res.json({ ok: true, id: row.id, dateFrom: nextDateFrom, dateTo: nextDateTo, isCurrent: !!nextCurrent, locked: !!nextLocked, origin: nextOrigin });
}));

// ---------------------------------------------------------------------------
// 5. Breakdown Monitoring, Job Record Sync & Admin Date Adjustments
// ---------------------------------------------------------------------------

router.get('/breakdowns', requireAuth, requireCap('hire.billing.view', 'fuel.view', 'jobs.view'), asyncHandler(async (req, res) => {
  const data = breakdowns.listBreakdowns({
    month: req.query.month || '',
    projectId: req.query.projectId || '',
    assetCode: req.query.assetCode || '',
    status: req.query.status || '',
    source: req.query.source || '',
    search: req.query.search || '',
    scopeMode: req.query.scopeMode || 'all',
  });
  res.json(data);
}));

router.post('/breakdowns', requireAuth, requireCap('hire.billing.generate', 'field.create', 'jobs.breakdown'), asyncHandler(async (req, res) => {
  const { assetId: reqAssetId, assetCode, projectId, breakdownStart, breakdownEnd, totalDays, reason, jobCardNo } = req.body;
  if ((!assetCode && !reqAssetId) || !breakdownStart) {
    return res.status(400).json({ error: 'Vehicle code and breakdown start date are required' });
  }

  const asset = (reqAssetId ? get('SELECT * FROM assets WHERE id = ?', Number(reqAssetId)) : null)
    || v2Engine.resolveVehicle(assetCode)
    || identity.resolveAsset(assetCode);
  const start = breakdowns.d10(breakdownStart);
  if (!start) return res.status(400).json({ error: 'Valid breakdownStart (YYYY-MM-DD) is required' });

  const end = breakdownEnd ? breakdowns.d10(breakdownEnd) : null;
  if (breakdownEnd && !end) return res.status(400).json({ error: 'Valid breakdownEnd (YYYY-MM-DD) or blank is required' });
  if (end && end < start) return res.status(400).json({ error: 'Close date cannot be earlier than start date' });

  const effProjectId = projectId ? Number(projectId) : (asset && asset.current_project_id ? asset.current_project_id : null);
  const proj = effProjectId ? get('SELECT id, name FROM projects WHERE id = ?', effProjectId) : null;
  const computedDays = end
    ? (totalDays != null && totalDays !== '' ? Number(totalDays) : breakdowns.daysBetweenInclusive(start, end))
    : null;
  const status = end ? 'CLOSED' : 'OPEN';
  const bdId = `fbd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const actorId = req.user ? req.user.id : 1;

  run(`
    INSERT INTO fleet_breakdowns (
      id, asset_id, asset_code, project_id, site_name, source_type,
      breakdown_start, breakdown_end, orig_start_date, orig_end_date,
      total_days, reason, job_no, reported_by, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'MANUAL', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `, bdId, asset ? asset.id : null,
     asset ? (asset.code || asset.ec_code || asset.registration) : String(assetCode).toUpperCase(),
     proj ? proj.id : null, proj ? proj.name : null,
     start, end, start, end,
     computedDays, reason || 'Mechanical breakdown', jobCardNo || null, actorId, status);

  logAudit(req, 'fleet_breakdown', asset ? asset.id : null, 'hire.breakdown.created', { id: bdId, start, end, status });
  res.status(201).json({ ok: true, id: bdId, status });
}));

router.patch('/breakdowns/:id', requireAuth, requireCap('hire.breakdowns.adjust'), asyncHandler(async (req, res) => {
  const updated = breakdowns.adjustBreakdownRecord(req.user, req.params.id, req.body || {});
  res.json({ ok: true, breakdown: updated });
}));

router.post('/breakdowns/adjust', requireAuth, requireCap('hire.breakdowns.adjust'), asyncHandler(async (req, res) => {
  const key = (req.body && (req.body.id || req.body.key)) || '';
  const updated = breakdowns.adjustBreakdownRecord(req.user, key, req.body || {});
  res.json({ ok: true, breakdown: updated });
}));

// ---------------------------------------------------------------------------
// 6. 1-Click Sync from Hire Bills / Rate Cards to Monthly Vehicle Costing P&L
// ---------------------------------------------------------------------------

router.post('/sync-to-costing', requireAuth, requireCap('hire.billing.generate', 'costing.manage'), asyncHandler(async (req, res) => {
  const month = String((req.body && req.body.month) || currentMonthKey()).trim().slice(0, 7);
  const projectId = (req.body && req.body.projectId) || 'ALL';
  const plan = buildSiteMonthlyPlan(projectId, month);
  const period = breakdowns.monthBounds(plan.month);
  const actorId = req.user ? req.user.id : 1;

  let generatedBills = 0;
  const skippedBreakdowns = [];

  tx(() => {
    for (const item of plan.items) {
      if (item.existingBill) continue;
      if (item.billingBlocked) {
        skippedBreakdowns.push({ assetId: item.assetId, assetCode: item.assetCode, projectName: item.projectName, reason: item.blockReason });
        continue;
      }
      if (!item.hasRate) continue;

      const billId = `bill-auto-${plan.month}-p${item.projectId || 0}-${item.assetId}`;
      const existingById = get('SELECT id FROM fleet_bills WHERE id = ?', billId);
      if (existingById) continue;

      const invoiceNumber = `INV-${plan.year}${String(plan.monthNum).padStart(2, '0')}-P${item.projectId || 0}-A${item.assetId}`;
      const proj = item.projectId ? { id: item.projectId, name: item.projectName, code: item.projectCode } : null;
      const asset = { id: item.assetId, registration: item.registration };

      insertGeneratedBill({
        billId,
        invoiceNumber,
        status: 'FINAL',
        period,
        asset,
        assetCode: item.assetCode,
        project: proj,
        driverName: item.driverName,
        billingMode: item.billingMode,
        rateBasis: item.rateBasis,
        rateCents: item.rateCents,
        openingMeter: item.openingMeter,
        closingMeter: item.closingMeter,
        calculation: item.calculation,
        fuelPriceCents: item.fuelPriceCents,
        notes: `Auto-synced for ${item.projectName} (${plan.month})`,
        actorId,
      });

      generatedBills++;
    }
  });

  const totalMonthBills = (get("SELECT COUNT(*) AS n FROM fleet_bills WHERE period_key = ? AND status != 'VOID'", plan.month) || {}).n || 0;
  res.json({
    ok: true,
    month: plan.month,
    projectId: plan.project ? plan.project.id : 'ALL',
    generatedBills,
    skippedBreakdownsCount: skippedBreakdowns.length,
    skippedBreakdowns,
    totalMonthBills,
  });
}));

module.exports = router;
