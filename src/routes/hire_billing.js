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
const siteSummary = require('../lib/billing/site_summary');
const siteSummaryDoc = require('../lib/billing/site_summary_document');
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
  if (b === 'FULLY_WET') return rateCard.fully_wet_rate_cents || rateCard.wet_rate_cents || rateCard.dry_rate_cents || rateCard.rate_cents || 0;
  if (b === 'WET') return rateCard.wet_rate_cents || rateCard.dry_rate_cents || rateCard.rate_cents || 0;
  if (b === 'FUEL_ONLY') return 0;
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
 * Build a Site & Month billing plan from allocations, active assignments,
 * active site assets, and fuel/meter issues. Enforces the breakdown guard per machine.
 */
function buildSiteMonthlyPlan(projectIdRaw, periodKey) {
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

  const fromDate = bounds.start;
  const toDateEnd = `${bounds.end} 23:59:59`;
  const pairMap = new Map();

  const upsertPair = (assetId, projectId, patch) => {
    if (!assetId) return;
    const pKey = projectId ? Number(projectId) : 0;
    const key = `${assetId}:${pKey}`;
    const cur = pairMap.get(key) || {
      assetId: Number(assetId),
      projectId: projectId ? Number(projectId) : null,
      projectName: patch.projectName || null,
      projectCode: patch.projectCode || null,
      allocBasis: null,
      allocDateFrom: null,
      allocDateTo: null,
      allocIsCurrent: false,
      driverName: null,
      fuelLitres: 0,
      fuelCostCents: 0,
      minMeter: null,
      maxMeter: null,
      sources: new Set(),
    };
    if (patch.projectName && !cur.projectName) cur.projectName = patch.projectName;
    if (patch.projectCode && !cur.projectCode) cur.projectCode = patch.projectCode;
    if (patch.allocBasis && !cur.allocBasis) cur.allocBasis = patch.allocBasis;
    if (patch.allocDateFrom) {
      cur.allocDateFrom = !cur.allocDateFrom || patch.allocDateFrom < cur.allocDateFrom
        ? patch.allocDateFrom
        : cur.allocDateFrom;
    }
    if (patch.allocDateTo) {
      cur.allocDateTo = !cur.allocDateTo || patch.allocDateTo > cur.allocDateTo
        ? patch.allocDateTo
        : cur.allocDateTo;
    }
    if (patch.allocIsCurrent) cur.allocIsCurrent = true;
    if (patch.driverName && !cur.driverName) cur.driverName = patch.driverName;
    if (patch.fuelLitres != null) cur.fuelLitres += Number(patch.fuelLitres) || 0;
    if (patch.fuelCostCents != null) cur.fuelCostCents += Number(patch.fuelCostCents) || 0;
    if (patch.minMeter != null && (cur.minMeter == null || patch.minMeter < cur.minMeter)) cur.minMeter = patch.minMeter;
    if (patch.maxMeter != null && (cur.maxMeter == null || patch.maxMeter > cur.maxMeter)) cur.maxMeter = patch.maxMeter;
    if (patch.source) cur.sources.add(patch.source);
    pairMap.set(key, cur);
  };

  // 1. Overlapping Site Allocator entries for [bounds.start .. bounds.end]
  const allocRows = all(`
    SELECT va.asset_id, va.project_id,
           COALESCE(p.name, va.site_name) AS project_name,
           p.code AS project_code,
           va.basis, va.driver_name, va.is_current,
           COALESCE(va.date_from, COALESCE(va.month_from, va.month) || '-01') AS eff_from,
           COALESCE(va.date_to,
             CASE WHEN va.is_current = 1 THEN NULL
                  ELSE date(COALESCE(va.month_to, va.month) || '-01', '+1 month', '-1 day') END) AS eff_to
      FROM fleet_vehicle_allocations va
      LEFT JOIN projects p ON p.id = va.project_id
     WHERE va.asset_id IS NOT NULL
       AND COALESCE(va.active, 1) = 1
       ${filterProjId ? 'AND va.project_id = ?' : ''}
       AND (
         va.month = ?
         OR (
           COALESCE(va.date_from, COALESCE(va.month_from, va.month) || '-01') <= ?
           AND (
             va.is_current = 1
             OR COALESCE(va.date_to, date(COALESCE(va.month_to, va.month) || '-01', '+1 month', '-1 day')) >= ?
           )
         )
       )
     ORDER BY va.is_current DESC, eff_from DESC
  `, ...(filterProjId ? [filterProjId, bounds.periodKey, bounds.end, bounds.start] : [bounds.periodKey, bounds.end, bounds.start]));

  for (const r of allocRows) {
    upsertPair(r.asset_id, r.project_id, {
      projectName: r.project_name,
      projectCode: r.project_code,
      allocBasis: r.basis,
      allocDateFrom: r.eff_from,
      allocDateTo: r.is_current ? null : r.eff_to,
      allocIsCurrent: !!r.is_current,
      driverName: r.driver_name,
      source: 'ALLOCATION',
    });
  }

  // 2. Active continuous assignments in fleet_asset_assignments overlapping month
  const assignRows = all(`
    SELECT fa.asset_id, fa.project_id, p.name AS project_name, p.code AS project_code,
           fa.billing_type, fa.driver_name,
           substr(fa.start_date, 1, 10) AS eff_from,
           CASE WHEN fa.end_date IS NOT NULL THEN substr(fa.end_date, 1, 10) ELSE NULL END AS eff_to
      FROM fleet_asset_assignments fa
      LEFT JOIN projects p ON p.id = fa.project_id
     WHERE fa.asset_id IS NOT NULL
       ${filterProjId ? 'AND fa.project_id = ?' : ''}
       AND substr(fa.start_date, 1, 10) <= ?
       AND (fa.end_date IS NULL OR substr(fa.end_date, 1, 10) >= ?)
     ORDER BY fa.start_date DESC
  `, ...(filterProjId ? [filterProjId, bounds.end, bounds.start] : [bounds.end, bounds.start]));

  for (const r of assignRows) {
    upsertPair(r.asset_id, r.project_id, {
      projectName: r.project_name,
      projectCode: r.project_code,
      allocBasis: r.billing_type,
      allocDateFrom: r.eff_from,
      allocDateTo: r.eff_to,
      allocIsCurrent: !r.eff_to,
      driverName: r.driver_name,
      source: 'ASSIGNMENT',
    });
  }

  // 3. Fuel & meter activity inside month
  const fuelRows = all(`
    SELECT fi.asset_id,
           COALESCE(fi.target_project_id, fi.project_id, fi.source_project_id, a.current_project_id) AS project_id,
           p.name AS project_name, p.code AS project_code,
           ROUND(SUM(fi.litres), 2) AS fuel_litres,
           ROUND(SUM(COALESCE(fi.total_cost_cents, fi.cost_cents, fi.total_price * 100, 0)), 0) AS fuel_cost_cents,
           MIN(CASE WHEN fi.meter_reading > 0 THEN fi.meter_reading ELSE NULL END) AS min_meter,
           MAX(CASE WHEN fi.meter_reading > 0 THEN fi.meter_reading ELSE NULL END) AS max_meter
      FROM fuel_issues fi
      JOIN assets a ON a.id = fi.asset_id
      LEFT JOIN projects p ON p.id = COALESCE(fi.target_project_id, fi.project_id, fi.source_project_id, a.current_project_id)
     WHERE fi.is_voided = 0
       AND fi.asset_id IS NOT NULL
       AND fi.issue_date BETWEEN ? AND ?
       ${filterProjId ? 'AND COALESCE(fi.target_project_id, fi.project_id, fi.source_project_id, a.current_project_id) = ?' : ''}
     GROUP BY fi.asset_id, COALESCE(fi.target_project_id, fi.project_id, fi.source_project_id, a.current_project_id)
  `, ...(filterProjId ? [fromDate, toDateEnd, filterProjId] : [fromDate, toDateEnd]));

  for (const f of fuelRows) {
    upsertPair(f.asset_id, f.project_id, {
      projectName: f.project_name,
      projectCode: f.project_code,
      fuelLitres: f.fuel_litres,
      fuelCostCents: f.fuel_cost_cents,
      minMeter: f.min_meter,
      maxMeter: f.max_meter,
      source: 'FUEL',
    });
  }

  // 4. For a specific site in the current month, include active assets stationed there without any allocation/assignment row in this month
  if (filterProjId && bounds.periodKey === currentMonthKey()) {
    const curAssets = all(`
      SELECT a.id AS asset_id
        FROM assets a
       WHERE a.current_project_id = ?
         AND COALESCE(a.status, 'active') NOT IN ('decommissioned', 'DISPOSED')
         AND NOT EXISTS (
           SELECT 1 FROM fleet_vehicle_allocations va
            WHERE va.asset_id = a.id
              AND COALESCE(va.active, 1) = 1
              AND (
                va.month = ?
                OR (
                  COALESCE(va.date_from, COALESCE(va.month_from, va.month) || '-01') <= ?
                  AND (va.is_current = 1 OR COALESCE(va.date_to, date(COALESCE(va.month_to, va.month) || '-01', '+1 month', '-1 day')) >= ?)
                )
              )
         )
         AND NOT EXISTS (
           SELECT 1 FROM fleet_asset_assignments fa
            WHERE fa.asset_id = a.id
              AND substr(fa.start_date, 1, 10) <= ?
              AND (fa.end_date IS NULL OR substr(fa.end_date, 1, 10) >= ?)
         )
    `, filterProjId, bounds.periodKey, bounds.end, bounds.start, bounds.end, bounds.start);
    for (const ca of curAssets) {
      if (!pairMap.has(`${ca.asset_id}:${filterProjId}`)) {
        upsertPair(ca.asset_id, filterProjId, {
          projectName: projectObj.name,
          projectCode: projectObj.code,
          allocDateFrom: bounds.start,
          allocDateTo: null,
          allocIsCurrent: true,
          source: 'CURRENT_SITE',
        });
      }
    }
  }

  const rateCards = new Map();
  for (const rc of all('SELECT * FROM fleet_rental_rates WHERE asset_id IS NOT NULL')) {
    if (!rateCards.has(rc.asset_id)) rateCards.set(rc.asset_id, rc);
  }

  const assetsMap = new Map();
  for (const a of all('SELECT * FROM assets')) {
    assetsMap.set(a.id, a);
  }

  const items = [];
  for (const entry of pairMap.values()) {
    const asset = assetsMap.get(entry.assetId);
    if (!asset) continue;
    const rateCard = rateCards.get(entry.assetId) || null;
    const billingMode = entry.allocBasis || (rateCard && rateCard.default_basis) || 'DRY_WITH_DRIVER';
    const rateBasis = (rateCard && rateCard.rate_basis) || (rateCard && rateCard.fuel_cons_basis === 'km' ? 'KM' : 'HOURLY');
    const rateCents = pickRateForMode(rateCard, billingMode);
    const hasRate = rateCents > 0 || billingMode === 'FUEL_ONLY';

    const effStart = entry.allocDateFrom || bounds.start;
    const effEnd = entry.allocDateTo || bounds.end;
    const siteOverlapDays = overlapDays(effStart, effEnd, bounds.start, bounds.end) || bounds.daysInMonth;

    const meterSpan = (entry.maxMeter != null && entry.minMeter != null && entry.maxMeter > entry.minMeter)
      ? Math.round((entry.maxMeter - entry.minMeter) * 10) / 10
      : 0;
    const fullMinUnits = rateBasis === 'DAILY'
      ? (rateCard && Number(rateCard.min_bill_hours) > 0 ? Number(rateCard.min_bill_hours) : 0)
      : resolveDefaultMinUnits(rateBasis, rateCard);
    const proratedMinUnits = (fullMinUnits > 0 && siteOverlapDays < bounds.daysInMonth)
      ? Math.round(fullMinUnits * (siteOverlapDays / bounds.daysInMonth) * 100) / 100
      : fullMinUnits;
    const defaultDailyUnits = rateBasis === 'DAILY'
      ? siteOverlapDays
      : (proratedMinUnits > 0 ? proratedMinUnits : (rateBasis === 'MONTHLY' || rateBasis === 'FLAT' ? 1 : (rateBasis === 'KM' ? 3000 : 120)));
    const actualUnits = meterSpan > 0 ? meterSpan : defaultDailyUnits;

    const bdStatus = breakdowns.getAssetBillingBreakdownStatus(asset.id, bounds.periodKey);
    const existingBill = get(`
      SELECT id, invoice_number, status, grand_total_cents
        FROM fleet_bills
       WHERE asset_id = ?
         AND period_key = ?
         AND status != 'VOID'
         AND (? IS NULL OR project_id IS NULL OR project_id = ?)
       LIMIT 1
    `, asset.id, bounds.periodKey, entry.projectId, entry.projectId);

    const periodFuelPriceCents = resolvePeriodFuelPriceCents({
      litres: entry.fuelLitres,
      totalFuelCostCents: entry.fuelCostCents,
      asOfDate: bounds.end,
    });

    const calculation = calc.calculateRentalBill({
      actualUnits,
      rateBasis,
      rateCents,
      billingMode,
      minimumUnits: proratedMinUnits,
      breakdownDays: bdStatus.breakdownDays,
      workingDaysInMonth: WORKING_DAYS_PER_MONTH,
      daysInMonth: bounds.daysInMonth,
      fuelLitres: entry.fuelLitres || 0,
      fuelPriceCents: periodFuelPriceCents,
    });

    items.push({
      assetId: asset.id,
      assetCode: asset.code || asset.ec_code || asset.registration,
      registration: asset.registration,
      assetType: asset.type || null,
      projectId: entry.projectId,
      projectName: entry.projectName || 'Central',
      projectCode: entry.projectCode || null,
      driverName: entry.driverName || null,
      allocDateFrom: entry.allocDateFrom || bounds.start,
      allocDateTo: entry.allocIsCurrent ? null : (entry.allocDateTo || bounds.end),
      allocIsCurrent: entry.allocIsCurrent,
      siteOverlapDays,
      workingDaysInMonth: WORKING_DAYS_PER_MONTH,
      sources: [...entry.sources],
      billingMode,
      rateBasis,
      rateCents,
      hasRate,
      openingMeter: entry.minMeter,
      closingMeter: entry.maxMeter,
      actualUnits,
      minBillHours: proratedMinUnits,
      fuelLitres: Math.round((entry.fuelLitres || 0) * 100) / 100,
      fuelPriceCents: periodFuelPriceCents,
      breakdownDays: bdStatus.breakdownDays,
      billingBlocked: bdStatus.billingBlocked || bdStatus.fullMonthDown,
      blockReason: bdStatus.blockReason,
      existingBill: existingBill || null,
      calculation,
      eligible: !existingBill && hasRate && !(bdStatus.billingBlocked || bdStatus.fullMonthDown),
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
    project: projectObj ? { id: projectObj.id, code: projectObj.code, name: projectObj.name } : null,
    items,
    summary: {
      totalMachines: items.length,
      eligibleCount: items.filter((x) => x.eligible).length,
      blockedCount: items.filter((x) => x.billingBlocked).length,
      alreadyBilledCount: items.filter((x) => !!x.existingBill).length,
      missingRateCount: items.filter((x) => !x.hasRate).length,
      estimatedGrandTotalCents: items.reduce((s, x) => s + (x.calculation ? x.calculation.grandTotalCents : 0), 0),
    },
  };
}

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
  `, ...summaryParams).map((s) => ({
    ...s,
    balance_cents: Math.max(0, (s.grand_total_cents || 0) - (s.paid_cents || 0)),
  }));

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
  const plan = buildSiteMonthlyPlan(projectId, month);
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
    });
    for (const l of s.lines) {
      lineRows.push({
        siteCode: s.siteCode,
        siteName: s.siteName,
        machine: l.code,
        regNo: l.regNo || '',
        days: l.workingDaysHere != null && l.workingDaysInMonth && l.billingMode !== 'perday'
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

  let generatedBills = 0;
  let skippedExisting = 0;
  let skippedUnrated = 0;
  const skippedBreakdowns = [];
  const createdBills = [];

  tx(() => {
    for (const s of result.summaries) {
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
  const fuelRow = get(`
    SELECT COALESCE(SUM(litres), 0) AS litres,
           COALESCE(SUM(COALESCE(total_cost_cents, cost_cents, total_price * 100, 0)), 0) AS fuel_cost_cents,
           MIN(CASE WHEN meter_reading > 0 THEN meter_reading ELSE NULL END) AS min_meter,
           MAX(CASE WHEN meter_reading > 0 THEN meter_reading ELSE NULL END) AS max_meter
      FROM fuel_issues
     WHERE is_voided = 0 AND asset_id = ? AND issue_date BETWEEN ? AND ?
       ${targetProjId ? 'AND COALESCE(target_project_id, project_id, source_project_id) = ?' : ''}
  `, ...(targetProjId ? [asset.id, fromDate, toDate, targetProjId] : [asset.id, fromDate, toDate]));
  const periodFuelPriceCents = resolvePeriodFuelPriceCents({
    litres: fuelRow ? fuelRow.litres : 0,
    totalFuelCostCents: fuelRow ? fuelRow.fuel_cost_cents : 0,
    asOfDate: monthEndDate,
  });

  const bdStatus = breakdowns.getAssetBillingBreakdownStatus(asset.id, periodKey);

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

  const reqProj = targetProjId ? get('SELECT id, name FROM projects WHERE id = ?', targetProjId) : null;
  const currProj = asset.current_project_id ? get('SELECT id, name FROM projects WHERE id = ?', asset.current_project_id) : null;

  const openingMeter = fuelRow && fuelRow.min_meter ? fuelRow.min_meter : null;
  const closingMeter = fuelRow && fuelRow.max_meter ? fuelRow.max_meter : null;
  const actualUnits = (openingMeter != null && closingMeter != null && closingMeter > openingMeter)
    ? Math.round((closingMeter - openingMeter) * 10) / 10
    : 0;

  const billingMode = (assign && assign.billing_type) || (alloc && alloc.basis) || (rateCard && rateCard.default_basis) || 'DRY_WITH_DRIVER';
  const projectId = targetProjId || (assign && assign.project_id) || (alloc && alloc.project_id) || asset.current_project_id || null;
  const projectName = (reqProj && reqProj.name) || (assign && assign.project_name) || (alloc && (alloc.project_name || alloc.site_name)) || (currProj && currProj.name) || null;
  const allocDateFrom = (assign && assign.start_date ? String(assign.start_date).slice(0, 10) : null) || (alloc && alloc.eff_from) || null;
  const allocDateTo = (assign ? (assign.end_date ? String(assign.end_date).slice(0, 10) : null) : (alloc ? alloc.eff_to : null));
  const siteOverlapDays = allocDateFrom
    ? (overlapDays(allocDateFrom, allocDateTo || monthEndDate, fromDate, monthEndDate) || lastDay)
    : lastDay;

  const prefillRateBasis = (rateCard && rateCard.rate_basis) || (rateCard && rateCard.fuel_cons_basis === 'km' ? 'KM' : 'HOURLY');
  const prefillMinUnits = resolveDefaultMinUnits(prefillRateBasis, rateCard);

  res.json({
    asset: {
      id: asset.id,
      code: asset.code || asset.ec_code,
      registration: asset.registration,
      category: asset.type,
    },
    periodKey,
    daysInMonth: lastDay,
    workingDaysInMonth: WORKING_DAYS_PER_MONTH,
    rateCard: rateCard || null,
    openingMeter,
    closingMeter,
    actualUnits,
    fuelLitres: fuelRow ? Math.round((fuelRow.litres || 0) * 100) / 100 : 0,
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
    driverName: (assign && assign.driver_name) || (alloc && alloc.driver_name) || null,
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

  const y = Number(year);
  const m = Number(month);
  const periodKey = `${y}-${String(m).padStart(2, '0')}`;
  const period = breakdowns.monthBounds(periodKey);
  if (!period) return res.status(400).json({ error: 'Invalid year or month' });

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
  const { projectId = 'ALL', month = currentMonthKey(), selectedAssetIds = null, finalise = false } = req.body || {};
  const plan = buildSiteMonthlyPlan(projectId, String(month).trim().slice(0, 7));
  const actorId = req.user ? req.user.id : 1;
  const period = breakdowns.monthBounds(plan.month);
  const targetStatus = finalise ? 'FINAL' : 'DRAFT';
  const filterSet = Array.isArray(selectedAssetIds) && selectedAssetIds.length
    ? new Set(selectedAssetIds.map((x) => Number(x)))
    : null;

  let generatedBills = 0;
  let skippedAlreadyBilled = 0;
  let skippedMissingRate = 0;
  const skippedBreakdowns = [];
  const createdBills = [];

  tx(() => {
    for (const item of plan.items) {
      if (filterSet && !filterSet.has(Number(item.assetId))) continue;
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
    skippedBreakdownsCount: skippedBreakdowns.length,
    skippedBreakdowns,
    bills: createdBills,
  });
}));

router.post('/bills/:id/revise', requireAuth, requireCap('hire.billing.generate', 'hire.billing.finalise'), asyncHandler(async (req, res) => {
  const bill = get('SELECT * FROM fleet_bills WHERE id = ?', req.params.id);
  if (!bill) return res.status(404).json({ error: 'Rental bill not found' });

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

    return {
      ...r,
      cons_basis: basis,
      rate_basis: effRateBasis,
      rate_unit_label: rateUnitLabel,
      display_unit: dispUnit,
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
    SELECT * FROM fleet_rental_rates
     WHERE equip_type = 'PORTABLE'
     ORDER BY category_name ASC, id ASC
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

// ---------------------------------------------------------------------------
// 4. Machine Site Allocations (Allocator Console)
// ---------------------------------------------------------------------------

router.get('/allocations', requireAuth, requireCap('allocations.view', 'hire.billing.view'), asyncHandler(async (req, res) => {
  const { month, monthFrom, monthTo, dateFrom, dateTo, currentOnly, projectId, assetCode, basis, groupByRange = '1' } = req.query;
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

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rawRows = all(`
    SELECT va.*,
           COALESCE(p.name, va.site_name) AS project_name,
           p.code AS project_code,
           COALESCE(a.code, a.ec_code, va.vehicle_no) AS asset_code,
           COALESCE(a.type, va.machine_type) AS asset_type,
           a.registration,
           a.brand,
           a.model_no,
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
      ].join('|');
      if (seen.has(rangeKey)) continue;
      seen.add(rangeKey);
      rows.push(r);
    }
  }

  res.json({ allocations: rows, currentMonth: curMonth, today: breakdowns.todayStr() });
}));

router.post('/allocations', requireAuth, requireCap('allocations.manage', 'hire.billing.generate'), asyncHandler(async (req, res) => {
  const {
    assetId: reqAssetId, assetCode, projectId, siteName,
    month, monthFrom, monthTo, dateFrom, dateTo, isCurrent,
    assignedBasis = 'DRY_WITH_DRIVER', driverName, startDate, endDate, notes
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
  const resolvedBasis = normalizeAllocBasis(assignedBasis, 'DRY_WITH_DRIVER');
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
    for (const m of monthsList) {
      const dedupeKey = `${resolvedSite}|${m}|${resolvedCode}`;
      const allocId = `valloc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      run(`
        INSERT INTO fleet_vehicle_allocations (
          id, dedupe_key, asset_id, vehicle_no, project_id, site_name,
          month, month_from, month_to, date_from, date_to, is_current, machine_type, owner_code,
          basis, active, driver_name, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'E&C', ?, 1, ?, ?, datetime('now'), datetime('now'))
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
          basis = excluded.basis,
          active = 1,
          driver_name = COALESCE(excluded.driver_name, fleet_vehicle_allocations.driver_name),
          notes = COALESCE(excluded.notes, fleet_vehicle_allocations.notes),
          updated_at = datetime('now')
      `, allocId, dedupeKey, asset ? asset.id : null, resolvedCode,
         proj ? proj.id : null, resolvedSite, m, mFrom, mTo,
         effectiveStartDate, effectiveEndDate, currentFlag ? 1 : 0, machineType, resolvedBasis,
         driverName || null, notes || null);
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

  const { assignedBasis, driverName, notes, monthTo, dateFrom, dateTo, isCurrent, action } = req.body || {};
  const nextCurrent = action === 'end' ? 0 : (isCurrent !== undefined ? (isCurrent ? 1 : 0) : row.is_current);
  const nextDateFrom = dateFrom ? (breakdowns.d10(dateFrom) || row.date_from) : row.date_from;
  let nextDateTo = row.date_to;
  if (action === 'end') {
    nextDateTo = breakdowns.todayStr();
  } else if (dateTo !== undefined) {
    nextDateTo = dateTo ? breakdowns.d10(dateTo) : null;
  } else if (nextCurrent) {
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
             updated_at = datetime('now')
       WHERE id = ?
          OR (vehicle_no = ? AND COALESCE(project_id, 0) = COALESCE(?, 0) AND COALESCE(date_from, '') = COALESCE(?, '') AND COALESCE(month_from, '') = COALESCE(?, ''))
    `, nextBasis, driverName !== undefined ? (driverName || null) : null,
       notes !== undefined ? (notes || null) : null,
       nextDateFrom || null, nextDateTo || null,
       nextMonthFrom || null, nextMonthTo || null, nextCurrent,
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
    dateFrom: nextDateFrom,
    dateTo: nextDateTo,
    monthTo: nextMonthTo,
  });
  res.json({ ok: true, id: row.id, dateFrom: nextDateFrom, dateTo: nextDateTo, isCurrent: !!nextCurrent });
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
