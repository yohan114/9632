'use strict';

/**
 * Machine Hire & Rental Billing API Routes (Plan V2)
 *
 * Mounts at /api/hire
 * Native Express implementation replacing Next.js /billing, /allocator, /rates
 */

const express = require('express');
const router = express.Router();

const { get, all, run, tx } = require('../db');
const { requireAuth, requireCap } = require('../lib/auth');
const { asyncHandler } = require('../lib/http');
const calc = require('../lib/billing/calc');
const audit = require('../lib/audit');
const identity = require('../lib/fleet_identity');

// ---------------------------------------------------------------------------
// 1. Rental Bills
// ---------------------------------------------------------------------------

router.get('/bills', requireAuth, requireCap('hire.billing.view'), asyncHandler(async (req, res) => {
  const { year, month, status, projectId, assetCode, search, limit = 50, offset = 0 } = req.query;

  const conditions = [];
  const params = [];

  if (year) {
    conditions.push('b.year = ?');
    params.push(Number(year));
  }
  if (month) {
    conditions.push('b.month = ?');
    params.push(Number(month));
  }
  if (status) {
    conditions.push('b.status = ?');
    params.push(String(status).toUpperCase());
  }
  if (projectId) {
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

  const countRow = get(`SELECT COUNT(*) AS total FROM fleet_bills b ${whereClause}`, ...params);
  const total = countRow ? countRow.total : 0;

  const rows = all(`
    SELECT b.*, COALESCE(u.full_name, u.username) AS generator_name, COALESCE(au.full_name, au.username) AS approver_name
      FROM fleet_bills b
      LEFT JOIN users u ON u.id = b.generated_by
      LEFT JOIN users au ON au.id = b.approved_by
     ${whereClause}
     ORDER BY b.year DESC, b.month DESC, b.asset_code ASC
     LIMIT ? OFFSET ?
  `, ...params, Number(limit), Number(offset));

  res.json({ total, bills: rows, limit: Number(limit), offset: Number(offset) });
}));

router.get('/bills/:id', requireAuth, requireCap('hire.billing.view'), asyncHandler(async (req, res) => {
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

  const revisions = all(`
    SELECT r.*, COALESCE(u.full_name, u.username) AS creator_name
      FROM fleet_bill_revisions r
      LEFT JOIN users u ON u.id = r.created_by
     WHERE r.bill_id = ?
     ORDER BY r.revision_number DESC
  `, req.params.id);

  res.json({ bill, lineItems, revisions });
}));

router.post('/bills/generate', requireAuth, requireCap('hire.billing.generate'), asyncHandler(async (req, res) => {
  const {
    assetCode, year, month, actualUnits, openingMeter, closingMeter,
    rateCents, rateBasis = 'HOURLY', billingMode = 'DRY',
    minBillHours = 0, fuelLitres = 0, fuelPriceCents = 34100,
    breakdownDays = 0, projectId = null, driverName = null, notes = null
  } = req.body;

  if (!assetCode || !year || !month) {
    return res.status(400).json({ error: 'assetCode, year, and month are required' });
  }

  const asset = identity.resolveAsset(assetCode);
  const resolvedCode = asset ? (asset.ec_code || asset.registration) : String(assetCode).trim();
  const assetId = asset ? asset.id : null;

  const y = Number(year);
  const m = Number(month);
  const periodKey = `${y}-${String(m).padStart(2, '0')}`;
  const periodStart = `${periodKey}-01`;
  const periodEnd = `${periodKey}-${new Date(y, m, 0).getDate()}`;

  // Call pure billing calculation engine
  const calculation = calc.calculateRentalBill({
    actualUnits: Number(actualUnits) || 0,
    rateBasis,
    rateCents: Number(rateCents) || 0,
    billingMode,
    minimumUnits: Number(minBillHours) || 0,
    breakdownDays: Number(breakdownDays) || 0,
    fuelLitres: Number(fuelLitres) || 0,
    fuelPriceCents: Number(fuelPriceCents) || 34100,
  });

  const billId = `bill-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const actorId = req.user ? req.user.id : 1;

  // Resolve project
  const proj = projectId ? get('SELECT * FROM projects WHERE id = ?', Number(projectId)) : null;

  tx(() => {
    run(`
      INSERT INTO fleet_bills (
        id, year, month, period_key, period_start, period_end,
        asset_id, asset_code, asset_reg_no, driver_name, project_id, project_name, project_code,
        billing_mode, rate_basis, rate_cents, opening_meter, closing_meter,
        actual_units, minimum_units, billable_units, rental_amount_cents,
        fuel_litres, fuel_cost_cents, breakdown_days, breakdown_deduct_cents,
        subtotal_cents, sscl_rate, sscl_cents, vat_rate, vat_cents, grand_total_cents,
        status, notes, generated_by
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        'DRAFT', ?, ?
      )
    `, billId, y, m, periodKey, periodStart, periodEnd,
       assetId, resolvedCode, asset ? asset.registration : null, driverName || null,
       proj ? proj.id : null, proj ? proj.name : null, proj ? proj.code : null,
       billingMode, rateBasis, Number(rateCents) || 0,
       openingMeter ? Number(openingMeter) : null, closingMeter ? Number(closingMeter) : null,
       calculation.actualUnits, calculation.minimumUnits, calculation.billableUnits, calculation.rentalAmountCents,
       calculation.fuelLitres, calculation.fuelCostCents, calculation.breakdownDays, calculation.breakdownDeductCents,
       calculation.subtotalCents, calculation.ssclRate, calculation.ssclCents, calculation.vatRate, calculation.vatCents,
       calculation.grandTotalCents, notes || null, actorId);

    // Insert Rental Line Item
    run(`
      INSERT INTO fleet_bill_line_items (
        id, bill_id, item_type, description, quantity, unit_price_cents, amount_cents, is_deduction
      ) VALUES (
        ?, ?, 'RENTAL', ?, ?, ?, ?, 0
      )
    `, `li-${billId}-rental`, billId,
       `Machine Hire Rental (${calculation.billableUnits} ${rateBasis.toLowerCase()})`,
       calculation.billableUnits, Number(rateCents) || 0, calculation.rentalAmountCents);

    // Insert Fuel Line Item if applicable
    if (calculation.fuelCostCents > 0) {
      run(`
        INSERT INTO fleet_bill_line_items (
          id, bill_id, item_type, description, quantity, unit_price_cents, amount_cents, is_deduction
        ) VALUES (
          ?, ?, 'FUEL', ?, ?, ?, ?, 0
        )
      `, `li-${billId}-fuel`, billId,
         `Fuel Recharge (${calculation.fuelLitres} Litres @ Rs ${(Number(fuelPriceCents) / 100).toFixed(2)})`,
         calculation.fuelLitres, Number(fuelPriceCents), calculation.fuelCostCents);
    }
  });

  audit.log(req, 'hire.bill.generated', { billId, assetCode: resolvedCode, periodKey, grandTotalCents: calculation.grandTotalCents });
  res.status(201).json({ id: billId, calculation });
}));

router.post('/bills/:id/finalise', requireAuth, requireCap('hire.billing.finalise'), asyncHandler(async (req, res) => {
  const bill = get('SELECT * FROM fleet_bills WHERE id = ?', req.params.id);
  if (!bill) return res.status(404).json({ error: 'Rental bill not found' });
  if (bill.status === 'FINAL') return res.status(400).json({ error: 'Bill is already finalized' });

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

    // Post to unified financial ledger as revenue
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

  audit.log(req, 'hire.bill.finalised', { billId: req.params.id, invoiceNo });
  res.json({ id: req.params.id, status: 'FINAL', invoice_number: invoiceNo });
}));

// ---------------------------------------------------------------------------
// 2. Machine Rental Rates
// ---------------------------------------------------------------------------

router.get('/rates', requireAuth, requireCap('hire.rates.view'), asyncHandler(async (req, res) => {
  const rates = all(`
    SELECT r.*, a.ec_code AS asset_code, a.registration AS asset_reg, a.type AS asset_type
      FROM fleet_rental_rates r
      LEFT JOIN assets a ON a.id = r.asset_id
     ORDER BY r.category_name ASC, a.ec_code ASC
  `);
  res.json({ rates });
}));

router.post('/rates', requireAuth, requireCap('hire.rates.manage'), asyncHandler(async (req, res) => {
  const { id, assetId, categoryName, rateBasis = 'HOURLY', rateCents, dryRateCents, wetRateCents, minBillHours = 0, note } = req.body;
  if (!rateBasis || !rateCents) {
    return res.status(400).json({ error: 'rateBasis and rateCents are required' });
  }

  const rateId = id || `rate-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  run(`
    INSERT INTO fleet_rental_rates (
      id, asset_id, category_name, rate_basis, rate_cents, dry_rate_cents, wet_rate_cents, min_bill_hours, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      rate_basis = excluded.rate_basis,
      rate_cents = excluded.rate_cents,
      dry_rate_cents = excluded.dry_rate_cents,
      wet_rate_cents = excluded.wet_rate_cents,
      min_bill_hours = excluded.min_bill_hours,
      note = excluded.note,
      updated_at = datetime('now')
  `, rateId, assetId ? Number(assetId) : null, categoryName || null, rateBasis,
     Math.round(Number(rateCents)), dryRateCents ? Math.round(Number(dryRateCents)) : null,
     wetRateCents ? Math.round(Number(wetRateCents)) : null, Number(minBillHours) || 0, note || null);

  audit.log(req, 'hire.rate.saved', { rateId, rateBasis, rateCents });
  res.status(201).json({ id: rateId, success: true });
}));

// ---------------------------------------------------------------------------
// 3. Machine Site Allocations
// ---------------------------------------------------------------------------

router.get('/allocations', requireAuth, requireCap('allocations.view'), asyncHandler(async (req, res) => {
  const { month, projectId, assetCode } = req.query;
  const conditions = [];
  const params = [];

  if (month) {
    conditions.push('va.month = ?');
    params.push(String(month));
  }
  if (projectId) {
    conditions.push('va.project_id = ?');
    params.push(Number(projectId));
  }
  if (assetCode) {
    conditions.push('UPPER(va.vehicle_no) LIKE UPPER(?)');
    params.push(`%${assetCode}%`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = all(`
    SELECT va.*, p.name AS project_name, p.code AS project_code, a.type AS asset_type
      FROM fleet_vehicle_allocations va
      LEFT JOIN projects p ON p.id = va.project_id
      LEFT JOIN assets a ON a.id = va.asset_id
     ${whereClause}
     ORDER BY va.month DESC, va.site_name ASC, va.vehicle_no ASC
  `, ...params);

  res.json({ allocations: rows });
}));

module.exports = router;
