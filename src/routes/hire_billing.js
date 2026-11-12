'use strict';

/**
 * Machine Hire, Costing Options, Rates, Consumption Bands, Allocator & Billing API Routes
 *
 * Mounts at /api/hire
 * Complete native Express implementation of Fuel-System-V2 Costing, Rates, Allocator,
 * Breakdowns, Bill Revisions, Payments & Aging, and Vehicle Costing Sync (:1949).
 */

const express = require('express');
const router = express.Router();

const { get, all, run, tx } = require('../db');
const { requireAuth, requireCap } = require('../lib/auth');
const { asyncHandler } = require('../lib/http');
const calc = require('../lib/billing/calc');
const v2Engine = require('../lib/fuel/v2_engine');
const audit = require('../lib/audit');
const identity = require('../lib/fleet_identity');

// ---------------------------------------------------------------------------
// 1. Rental Bills, Auto-Prefill, Revisions & Finalisation
// ---------------------------------------------------------------------------

router.get('/bills', requireAuth, requireCap('hire.billing.view', 'costing.view'), asyncHandler(async (req, res) => {
  const { year, month, status, projectId, assetCode, search, limit = 100, offset = 0 } = req.query;

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
  if (status && status !== 'ALL') {
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
    SELECT b.*,
           COALESCE(u.full_name, u.username) AS generator_name,
           COALESCE(au.full_name, au.username) AS approver_name,
           COALESCE((SELECT SUM(p.amount_cents) FROM fleet_bill_payments p WHERE p.bill_id = b.id), 0) AS paid_cents,
           COALESCE((SELECT COUNT(*) FROM fleet_bill_revisions r WHERE r.bill_id = b.id), 0) AS revision_count
      FROM fleet_bills b
      LEFT JOIN users u ON u.id = b.generated_by
      LEFT JOIN users au ON au.id = b.approved_by
     ${whereClause}
     ORDER BY b.year DESC, b.month DESC, b.asset_code ASC
     LIMIT ? OFFSET ?
  `, ...params, Number(limit), Number(offset)).map((row) => ({
    ...row,
    balance_cents: Math.max(0, (row.grand_total_cents || 0) - (row.paid_cents || 0)),
  }));

  res.json({ total, bills: rows, limit: Number(limit), offset: Number(offset) });
}));

router.get('/bills/prefill', requireAuth, requireCap('hire.billing.view', 'hire.rates.view'), asyncHandler(async (req, res) => {
  const { assetCode, year = 2026, month = 8 } = req.query;
  if (!assetCode) return res.status(400).json({ error: 'assetCode is required' });

  const asset = v2Engine.resolveVehicle(assetCode) || identity.resolveAsset(assetCode);
  if (!asset) return res.status(404).json({ error: `Vehicle not found: ${assetCode}` });

  const y = Number(year);
  const m = Number(month);
  const periodKey = `${y}-${String(m).padStart(2, '0')}`;
  const fromDate = `${periodKey}-01`;
  const toDate = `${periodKey}-31 23:59:59`;

  const rateCard = get('SELECT * FROM fleet_rental_rates WHERE asset_id = ? LIMIT 1', asset.id);
  const fuelRow = get(`
    SELECT COALESCE(SUM(litres), 0) AS litres,
           MIN(CASE WHEN meter_reading > 0 THEN meter_reading ELSE NULL END) AS min_meter,
           MAX(CASE WHEN meter_reading > 0 THEN meter_reading ELSE NULL END) AS max_meter
      FROM fuel_issues
     WHERE asset_id = ? AND is_voided = 0 AND issue_date BETWEEN ? AND ?
  `, asset.id, fromDate, toDate);

  const bdCond = get(`
    SELECT COUNT(*) AS days FROM (
      SELECT date FROM daily_conditions WHERE asset_id = ? AND status = 'BREAKDOWN' AND substr(date, 1, 7) = ?
      UNION
      SELECT date FROM fuel_daily_conditions WHERE asset_id = ? AND status = 'BREAKDOWN' AND substr(date, 1, 7) = ?
    )
  `, asset.id, periodKey, asset.id, periodKey);

  const alloc = get(`
    SELECT va.*, p.name AS project_name
      FROM fleet_vehicle_allocations va
      LEFT JOIN projects p ON p.id = va.project_id
     WHERE va.asset_id = ?
     ORDER BY CASE WHEN va.month = ? THEN 0 ELSE 1 END, va.month DESC
     LIMIT 1
  `, asset.id, periodKey);

  const openingMeter = fuelRow && fuelRow.min_meter ? fuelRow.min_meter : null;
  const closingMeter = fuelRow && fuelRow.max_meter ? fuelRow.max_meter : null;
  const actualUnits = (openingMeter != null && closingMeter != null && closingMeter > openingMeter)
    ? Math.round((closingMeter - openingMeter) * 10) / 10
    : 0;

  res.json({
    asset: {
      id: asset.id,
      code: asset.code || asset.ec_code,
      registration: asset.registration,
      category: asset.category,
    },
    periodKey,
    rateCard: rateCard || null,
    openingMeter,
    closingMeter,
    actualUnits,
    fuelLitres: fuelRow ? Math.round((fuelRow.litres || 0) * 100) / 100 : 0,
    breakdownDays: bdCond ? bdCond.days : 0,
    projectId: alloc ? alloc.project_id : (asset.current_project_id || null),
    projectName: alloc ? (alloc.project_name || alloc.site_name) : (asset.current_site || null),
    billingMode: (alloc && alloc.assigned_basis) || (rateCard && rateCard.default_basis) || 'DRY',
    rateBasis: (rateCard && rateCard.rate_basis) || 'HOURLY',
    rateCents: rateCard ? (rateCard.dry_rate_cents || rateCard.rate_cents || 0) : 0,
    wetRateCents: rateCard ? (rateCard.wet_rate_cents || rateCard.rate_cents || 0) : 0,
    fullyWetRateCents: rateCard ? (rateCard.fully_wet_rate_cents || rateCard.wet_rate_cents || 0) : 0,
    minBillHours: rateCard ? (rateCard.min_bill_hours || 0) : 0,
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
    assetCode, year, month, actualUnits, openingMeter, closingMeter,
    rateCents, rateBasis = 'HOURLY', billingMode = 'DRY',
    minBillHours = 0, fuelLitres = 0, fuelPriceCents = 34100,
    breakdownDays = 0, projectId = null, driverName = null, notes = null
  } = req.body;

  if (!assetCode || !year || !month) {
    return res.status(400).json({ error: 'assetCode, year, and month are required' });
  }

  const asset = v2Engine.resolveVehicle(assetCode) || identity.resolveAsset(assetCode);
  const resolvedCode = asset ? (asset.code || asset.ec_code || asset.registration) : String(assetCode).trim();
  const assetId = asset ? asset.id : null;

  const y = Number(year);
  const m = Number(month);
  const periodKey = `${y}-${String(m).padStart(2, '0')}`;
  const periodStart = `${periodKey}-01`;
  const periodEnd = `${periodKey}-${new Date(y, m, 0).getDate()}`;

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

    run(`
      INSERT INTO fleet_bill_line_items (
        id, bill_id, item_type, description, quantity, unit_price_cents, amount_cents, is_deduction
      ) VALUES (?, ?, 'RENTAL', ?, ?, ?, ?, 0)
    `, `li-${billId}-rental`, billId,
       `Machine Hire Rental (${calculation.billableUnits} ${rateBasis.toLowerCase()})`,
       calculation.billableUnits, Number(rateCents) || 0, calculation.rentalAmountCents);

    if (calculation.fuelCostCents > 0) {
      run(`
        INSERT INTO fleet_bill_line_items (
          id, bill_id, item_type, description, quantity, unit_price_cents, amount_cents, is_deduction
        ) VALUES (?, ?, 'FUEL', ?, ?, ?, ?, 0)
      `, `li-${billId}-fuel`, billId,
         `Fuel Recharge (${calculation.fuelLitres} Litres @ Rs ${(Number(fuelPriceCents) / 100).toFixed(2)})`,
         calculation.fuelLitres, Number(fuelPriceCents), calculation.fuelCostCents);
    }

    if (calculation.breakdownDeductCents > 0) {
      run(`
        INSERT INTO fleet_bill_line_items (
          id, bill_id, item_type, description, quantity, unit_price_cents, amount_cents, is_deduction
        ) VALUES (?, ?, 'DEDUCTION', ?, ?, ?, ?, 1)
      `, `li-${billId}-bd`, billId,
         `Breakdown Deduction (${calculation.breakdownDays} days)`,
         calculation.breakdownDays, Math.round(calculation.breakdownDeductCents / Math.max(1, calculation.breakdownDays)),
         calculation.breakdownDeductCents);
    }
  });

  audit.log(req, 'hire.bill.generated', { billId, assetCode: resolvedCode, periodKey, grandTotalCents: calculation.grandTotalCents });
  res.status(201).json({ id: billId, calculation });
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
    fuelPriceCents = 34100,
    breakdownDays = bill.breakdown_days,
    reason = 'Amended rental bill parameters',
  } = req.body;

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

  const actorId = req.user ? req.user.id : 1;
  const maxRev = (get('SELECT MAX(revision_number) AS m FROM fleet_bill_revisions WHERE bill_id = ?', bill.id) || {}).m || 0;
  const revNo = maxRev + 1;
  const revId = `brev-${bill.id}-${revNo}`;

  tx(() => {
    run(`
      INSERT INTO fleet_bill_revisions (
        id, bill_id, revision_number, snapshot_json, reason, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `, revId, bill.id, revNo, JSON.stringify({
      before: {
        actual_units: bill.actual_units,
        rate_cents: bill.rate_cents,
        billing_mode: bill.billing_mode,
        fuel_litres: bill.fuel_litres,
        breakdown_days: bill.breakdown_days,
        grand_total_cents: bill.grand_total_cents,
      },
      after: calculation,
    }), reason, actorId);

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
       calculation.rentalAmountCents, calculation.fuelLitres, calculation.fuelCostCents,
       calculation.breakdownDays, calculation.breakdownDeductCents,
       calculation.subtotalCents, calculation.ssclCents, calculation.vatCents,
       calculation.grandTotalCents, bill.id);
  });

  audit.log(req, 'hire.bill.revised', { billId: bill.id, revisionNumber: revNo, reason });
  res.json({ ok: true, id: bill.id, revisionNumber: revNo, calculation });
}));

router.post('/bills/:id/finalise', requireAuth, requireCap('hire.billing.finalise', 'costing.manage'), asyncHandler(async (req, res) => {
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
           a.category AS asset_category, a.type AS asset_type, a.current_site
      FROM fleet_rental_rates r
      LEFT JOIN assets a ON a.id = r.asset_id
     ORDER BY COALESCE(r.equip_type, 'FLEET') ASC, COALESCE(r.category_name, a.category) ASC, a.code ASC
  `);
  res.json({ rates });
}));

router.get('/rates-overview', requireAuth, requireCap('hire.rates.view', 'fuel.view'), asyncHandler(async (req, res) => {
  const { search = '', category = '', equipType = '' } = req.query;

  const fleetRates = all(`
    SELECT r.*,
           a.id AS resolved_asset_id,
           COALESCE(a.code, a.ec_code) AS asset_code,
           a.registration AS asset_reg,
           COALESCE(r.category_name, a.category) AS category,
           a.brand, a.model, a.current_site,
           f.total_litres, f.min_meter, f.max_meter, f.fills
      FROM fleet_rental_rates r
      LEFT JOIN assets a ON a.id = r.asset_id
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
     ORDER BY COALESCE(r.category_name, a.category) ASC, a.code ASC
  `).map((r) => {
    const basis = r.fuel_cons_basis || (v2Engine.inferMeterType(r, r) === 'KM' ? 'km' : 'hr');
    const dispUnit = basis === 'km' ? 'km/L' : 'L/hr';
    const econDisp = v2Engine.toDisplayRate(r.fuel_cons_econ, basis);
    const typDisp = v2Engine.toDisplayRate(r.fuel_cons_typ, basis);
    const heavyDisp = v2Engine.toDisplayRate(r.fuel_cons_heavy, basis);

    const span = (r.max_meter && r.min_meter && r.max_meter > r.min_meter) ? (r.max_meter - r.min_meter) : 0;
    const measuredStorage = (span > 0 && r.total_litres > 0) ? (r.total_litres / span) : null;
    const measuredDisp = v2Engine.toDisplayRate(measuredStorage, basis);
    const verdict = v2Engine.classifyBand(measuredStorage, r.fuel_cons_econ, r.fuel_cons_typ, r.fuel_cons_heavy);

    return {
      ...r,
      display_unit: dispUnit,
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
  if (search) {
    const q = v2Engine.squashCode(search);
    filteredFleet = filteredFleet.filter((r) =>
      v2Engine.squashCode(r.asset_code).includes(q) ||
      v2Engine.squashCode(r.asset_reg).includes(q) ||
      String(r.category || '').toUpperCase().includes(q) ||
      String(r.source_label || '').toUpperCase().includes(q)
    );
  }
  if (category) {
    filteredFleet = filteredFleet.filter((r) => String(r.category || '').toLowerCase() === String(category).toLowerCase());
  }

  const categories = [...new Set(fleetRates.map((r) => r.category).filter(Boolean))].sort();

  res.json({
    fleet: equipType === 'PORTABLE' ? [] : filteredFleet,
    portable: equipType === 'FLEET' ? [] : portableRates,
    categories,
    summary: {
      totalFleetRates: fleetRates.length,
      withConsumptionBands: fleetRates.filter((r) => r.fuel_cons_typ > 0).length,
      totalPortableClasses: portableRates.length,
    },
  });
}));

router.post('/rates', requireAuth, requireCap('hire.rates.manage', 'costing.manage'), asyncHandler(async (req, res) => {
  const {
    id, assetId, categoryName, rateBasis = 'HOURLY', rateCents,
    dryRateCents, wetRateCents, fullyWetRateCents, minBillHours = 0,
    defaultBasis = 'DRY', econDisplay, typDisplay, heavyDisplay, fuelConsBasis, note
  } = req.body;

  const rateId = id || (assetId ? `rate-asset-${assetId}` : `rate-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`);
  const basis = fuelConsBasis || (rateBasis === 'KM' ? 'km' : 'hr');
  const econVal = econDisplay != null && econDisplay !== '' ? v2Engine.fromDisplayRate(Number(econDisplay), basis) : null;
  const typVal = typDisplay != null && typDisplay !== '' ? v2Engine.fromDisplayRate(Number(typDisplay), basis) : null;
  const heavyVal = heavyDisplay != null && heavyDisplay !== '' ? v2Engine.fromDisplayRate(Number(heavyDisplay), basis) : null;

  run(`
    INSERT INTO fleet_rental_rates (
      id, asset_id, category_name, rate_basis, rate_cents,
      dry_rate_cents, wet_rate_cents, fully_wet_rate_cents, min_bill_hours,
      default_basis, fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy, fuel_cons_basis, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      rate_basis = COALESCE(excluded.rate_basis, fleet_rental_rates.rate_basis),
      rate_cents = COALESCE(excluded.rate_cents, fleet_rental_rates.rate_cents),
      dry_rate_cents = COALESCE(excluded.dry_rate_cents, fleet_rental_rates.dry_rate_cents),
      wet_rate_cents = COALESCE(excluded.wet_rate_cents, fleet_rental_rates.wet_rate_cents),
      fully_wet_rate_cents = COALESCE(excluded.fully_wet_rate_cents, fleet_rental_rates.fully_wet_rate_cents),
      min_bill_hours = COALESCE(excluded.min_bill_hours, fleet_rental_rates.min_bill_hours),
      default_basis = COALESCE(excluded.default_basis, fleet_rental_rates.default_basis),
      fuel_cons_econ = COALESCE(excluded.fuel_cons_econ, fleet_rental_rates.fuel_cons_econ),
      fuel_cons_typ = COALESCE(excluded.fuel_cons_typ, fleet_rental_rates.fuel_cons_typ),
      fuel_cons_heavy = COALESCE(excluded.fuel_cons_heavy, fleet_rental_rates.fuel_cons_heavy),
      fuel_cons_basis = COALESCE(excluded.fuel_cons_basis, fleet_rental_rates.fuel_cons_basis),
      note = COALESCE(excluded.note, fleet_rental_rates.note),
      updated_at = datetime('now')
  `, rateId, assetId ? Number(assetId) : null, categoryName || null, rateBasis,
     rateCents != null ? Math.round(Number(rateCents)) : (dryRateCents != null ? Math.round(Number(dryRateCents)) : 0),
     dryRateCents != null ? Math.round(Number(dryRateCents)) : null,
     wetRateCents != null ? Math.round(Number(wetRateCents)) : null,
     fullyWetRateCents != null ? Math.round(Number(fullyWetRateCents)) : null,
     Number(minBillHours) || 0,
     defaultBasis || 'DRY',
     econVal, typVal, heavyVal, basis,
     note || null);

  audit.log(req, 'hire.rate.saved', { rateId, assetId, rateBasis });
  res.status(201).json({ id: rateId, success: true });
}));

// ---------------------------------------------------------------------------
// 4. Machine Site Allocations (Allocator Console)
// ---------------------------------------------------------------------------

router.get('/allocations', requireAuth, requireCap('allocations.view', 'hire.billing.view'), asyncHandler(async (req, res) => {
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
    SELECT va.*, COALESCE(p.name, va.site_name) AS project_name, p.code AS project_code,
           COALESCE(a.category, va.vehicle_type) AS asset_type, a.registration
      FROM fleet_vehicle_allocations va
      LEFT JOIN projects p ON p.id = va.project_id
      LEFT JOIN assets a ON a.id = va.asset_id
     ${whereClause}
     ORDER BY va.month DESC, va.site_name ASC, va.vehicle_no ASC
     LIMIT 500
  `, ...params);

  res.json({ allocations: rows });
}));

router.post('/allocations', requireAuth, requireCap('allocations.manage', 'hire.billing.generate'), asyncHandler(async (req, res) => {
  const { assetCode, projectId, siteName, month, assignedBasis = 'DRY', driverName, startDate, notes } = req.body;
  if (!assetCode || (!projectId && !siteName)) {
    return res.status(400).json({ error: 'Vehicle code and project/site are required' });
  }

  const asset = v2Engine.resolveVehicle(assetCode);
  const proj = projectId ? get('SELECT * FROM projects WHERE id = ?', Number(projectId)) : null;
  const resolvedSite = proj ? proj.name : String(siteName || '').trim();
  const resolvedCode = asset ? (asset.code || asset.ec_code) : String(assetCode).toUpperCase();
  const resolvedMonth = month || new Date().toISOString().slice(0, 7);
  const allocId = `valloc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  tx(() => {
    run(`
      INSERT INTO fleet_vehicle_allocations (
        id, asset_id, vehicle_no, vehicle_type, project_id, site_name,
        month, assigned_basis, driver_name, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `, allocId, asset ? asset.id : null, resolvedCode, asset ? asset.category : null,
       proj ? proj.id : null, resolvedSite, resolvedMonth, assignedBasis, driverName || null, notes || null);

    if (asset && proj) {
      run(`
        INSERT INTO fleet_asset_assignments (
          id, asset_id, project_id, assigned_from, billing_mode, status, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, datetime('now'))
      `, `assign-${Date.now()}`, asset.id, proj.id, startDate || (resolvedMonth + '-01'), assignedBasis, notes || null);
    }

    if (asset) {
      run(`
        UPDATE assets
           SET current_site = ?,
               current_project_id = COALESCE(?, current_project_id)
         WHERE id = ?
      `, resolvedSite, proj ? proj.id : null, asset.id);
    }
  });

  audit.log(req, 'hire.allocation.created', { allocId, assetCode: resolvedCode, siteName: resolvedSite, assignedBasis });
  res.status(201).json({ ok: true, id: allocId, assetCode: resolvedCode, siteName: resolvedSite });
}));

// ---------------------------------------------------------------------------
// 5. Breakdown Days Log (for Hire Deduction)
// ---------------------------------------------------------------------------

router.get('/breakdowns', requireAuth, requireCap('hire.billing.view', 'fuel.view'), asyncHandler(async (req, res) => {
  const { month, assetCode } = req.query;
  const rows = all(`
    SELECT b.*, COALESCE(a.code, b.asset_code) AS vehicle_code, a.registration, a.category,
           p.name AS project_name
      FROM fleet_breakdowns b
      LEFT JOIN assets a ON a.id = b.asset_id
      LEFT JOIN projects p ON p.id = b.project_id
     WHERE (? IS NULL OR substr(b.breakdown_start, 1, 7) = ?)
       AND (? IS NULL OR UPPER(COALESCE(a.code, b.asset_code)) LIKE UPPER(?))
     ORDER BY b.breakdown_start DESC
     LIMIT 200
  `, month || null, month || null, assetCode || null, assetCode ? `%${assetCode}%` : null);

  const condBreakdowns = all(`
    SELECT c.id, c.asset_id, COALESCE(a.code, a.ec_code) AS vehicle_code, a.registration, a.category,
           c.date AS breakdown_start, c.date AS breakdown_end, 1 AS total_days,
           c.reason, c.notes, a.current_site AS project_name
      FROM (
        SELECT id, asset_id, date, status, reason, notes FROM daily_conditions WHERE status = 'BREAKDOWN'
        UNION ALL
        SELECT id, asset_id, date, status, reason, notes FROM fuel_daily_conditions WHERE status = 'BREAKDOWN'
      ) c
      LEFT JOIN assets a ON a.id = c.asset_id
     WHERE (? IS NULL OR substr(c.date, 1, 7) = ?)
       AND (? IS NULL OR UPPER(COALESCE(a.code, a.ec_code)) LIKE UPPER(?))
     ORDER BY c.date DESC
     LIMIT 200
  `, month || null, month || null, assetCode || null, assetCode ? `%${assetCode}%` : null);

  res.json({ breakdowns: [...rows, ...condBreakdowns] });
}));

router.post('/breakdowns', requireAuth, requireCap('hire.billing.generate', 'field.create', 'jobs.breakdown'), asyncHandler(async (req, res) => {
  const { assetCode, projectId, breakdownStart, breakdownEnd, totalDays = 1, reason, jobCardNo } = req.body;
  if (!assetCode || !breakdownStart) {
    return res.status(400).json({ error: 'Vehicle code and breakdown start date are required' });
  }
  const asset = v2Engine.resolveVehicle(assetCode);
  const bdId = `fbd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const actorId = req.user ? req.user.id : 1;

  run(`
    INSERT INTO fleet_breakdowns (
      id, asset_id, asset_code, project_id, breakdown_start, breakdown_end,
      total_days, reason, job_card_no, reported_by, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECORDED', datetime('now'))
  `, bdId, asset ? asset.id : null, asset ? (asset.code || asset.ec_code) : String(assetCode).toUpperCase(),
     projectId ? Number(projectId) : null, breakdownStart, breakdownEnd || breakdownStart,
     Number(totalDays) || 1, reason || 'Mechanical breakdown', jobCardNo || null, actorId);

  res.status(201).json({ ok: true, id: bdId });
}));

// ---------------------------------------------------------------------------
// 6. 1-Click Sync from Hire Bills / Rate Cards to Monthly Vehicle Costing P&L
// ---------------------------------------------------------------------------

router.post('/sync-to-costing', requireAuth, requireCap('hire.billing.generate', 'costing.manage'), asyncHandler(async (req, res) => {
  const month = String(req.body.month || '2026-08').trim();
  const [yStr, mStr] = month.split('-');
  const year = Number(yStr) || 2026;
  const mon = Number(mStr) || 8;
  const fromDate = `${month}-01`;
  const toDate = `${month}-31 23:59:59`;
  const actorId = req.user ? req.user.id : 1;

  // 1. Find all vehicles with fuel/meter activity in this month that don't yet have a fleet_bill
  const activeFuelAssets = all(`
    SELECT fi.asset_id,
           COALESCE(a.code, fi.asset_code) AS asset_code,
           a.registration,
           ROUND(SUM(fi.litres), 2) AS fuel_litres,
           MIN(CASE WHEN fi.meter_reading > 0 THEN fi.meter_reading ELSE NULL END) AS min_meter,
           MAX(CASE WHEN fi.meter_reading > 0 THEN fi.meter_reading ELSE NULL END) AS max_meter,
           MAX(COALESCE(fi.target_project_id, fi.project_id)) AS project_id
      FROM fuel_issues fi
      JOIN assets a ON a.id = fi.asset_id
     WHERE fi.is_voided = 0 AND fi.asset_id IS NOT NULL AND fi.issue_date BETWEEN ? AND ?
     GROUP BY fi.asset_id
  `, fromDate, toDate);

  let generatedBills = 0;
  let syncedRevenueRows = 0;

  tx(() => {
    for (const fa of activeFuelAssets) {
      const existingBill = get('SELECT id FROM fleet_bills WHERE asset_id = ? AND period_key = ? AND status != ?', fa.asset_id, month, 'VOID');
      if (existingBill) continue;

      const rateCard = get('SELECT * FROM fleet_rental_rates WHERE asset_id = ? LIMIT 1', fa.asset_id);
      if (!rateCard || !(rateCard.dry_rate_cents || rateCard.rate_cents || rateCard.wet_rate_cents)) continue;

      const rateBasis = rateCard.rate_basis || 'HOURLY';
      const billingMode = rateCard.default_basis || 'DRY';
      const rateCents = billingMode === 'WET'
        ? (rateCard.wet_rate_cents || rateCard.rate_cents || 0)
        : (rateCard.dry_rate_cents || rateCard.rate_cents || 0);

      if (rateCents <= 0) continue;

      const meterSpan = (fa.max_meter && fa.min_meter && fa.max_meter > fa.min_meter)
        ? Math.round((fa.max_meter - fa.min_meter) * 10) / 10
        : 0;
      const minUnits = rateCard.min_bill_hours || (rateBasis === 'HOURLY' ? 100 : (rateBasis === 'DAILY' ? 20 : 1000));
      const actualUnits = meterSpan > 0 ? meterSpan : minUnits;

      const calculation = calc.calculateRentalBill({
        actualUnits,
        rateBasis,
        rateCents,
        billingMode,
        minimumUnits: rateCard.min_bill_hours || 0,
        breakdownDays: 0,
        fuelLitres: fa.fuel_litres || 0,
        fuelPriceCents: 34100,
      });

      const billId = `bill-auto-${month}-${fa.asset_id}`;
      const proj = fa.project_id ? get('SELECT * FROM projects WHERE id = ?', fa.project_id) : null;

      run(`
        INSERT OR IGNORE INTO fleet_bills (
          id, year, month, period_key, period_start, period_end,
          asset_id, asset_code, asset_reg_no, project_id, project_name, project_code,
          billing_mode, rate_basis, rate_cents, opening_meter, closing_meter,
          actual_units, minimum_units, billable_units, rental_amount_cents,
          fuel_litres, fuel_cost_cents, breakdown_days, breakdown_deduct_cents,
          subtotal_cents, sscl_rate, sscl_cents, vat_rate, vat_cents, grand_total_cents,
          invoice_number, status, notes, generated_by
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, 0, 0,
          ?, ?, ?, ?, ?, ?,
          ?, 'FINAL', ?, ?
        )
      `, billId, year, mon, month, `${month}-01`, `${month}-28`,
         fa.asset_id, fa.asset_code, fa.registration,
         proj ? proj.id : null, proj ? proj.name : null, proj ? proj.code : null,
         billingMode, rateBasis, rateCents, fa.min_meter || null, fa.max_meter || null,
         calculation.actualUnits, calculation.minimumUnits, calculation.billableUnits, calculation.rentalAmountCents,
         calculation.fuelLitres, calculation.fuelCostCents,
         calculation.subtotalCents, calculation.ssclRate, calculation.ssclCents, calculation.vatRate, calculation.vatCents,
         calculation.grandTotalCents,
         `INV-${year}${String(mon).padStart(2, '0')}-A${fa.asset_id}`,
         `Auto-synced from Rate Card & Fuel/Meter Ledger (${month})`, actorId);

      generatedBills++;
    }
  });

  const totalMonthBills = (get("SELECT COUNT(*) AS n FROM fleet_bills WHERE period_key = ? AND status != 'VOID'", month) || {}).n || 0;
  res.json({
    ok: true,
    month,
    generatedBills,
    totalMonthBills,
    SyncedRevenueRows: syncedRevenueRows,
  });
}));

module.exports = router;
