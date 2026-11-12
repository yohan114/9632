'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireAuth } = require('../lib/auth');
const { requireModule } = require('../lib/permissions');
const { asyncHandler } = require('../lib/http');
const emitter = require('../lib/emitter');

const router = express.Router();

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
function toFloat(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
function clean(s) {
  return typeof s === 'string' ? s.trim() : '';
}

function resolveAssetId(raw) {
  if (!raw) return null;
  const asNum = toInt(raw);
  if (asNum) {
    const foundById = get('SELECT id FROM assets WHERE id = ?', asNum);
    if (foundById) return foundById.id;
  }
  const str = clean(String(raw));
  if (!str) return null;
  const foundByCode = get(
    'SELECT id FROM assets WHERE UPPER(code) = UPPER(?) OR UPPER(registration) = UPPER(?) OR UPPER(ec_code) = UPPER(?) LIMIT 1',
    str, str, str
  );
  return foundByCode ? foundByCode.id : null;
}

// -----------------------------------------------------------------------------
// 1. FINAL VEHICLE COSTING REPORT (PER VEHICLE & MONTH)
// -----------------------------------------------------------------------------
const handleSingleVehicleReport = asyncHandler((req, res) => {
  const assetId = resolveAssetId(req.query.asset_id);
  let month = clean(req.query.month); // Format: 'YYYY-MM'

  if (!assetId) {
    return res.status(400).json({ error: 'asset_id is required' });
  }

  if (!month) {
    const now = new Date();
    month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  const asset = get(`
    SELECT a.*, p.name project_name
      FROM assets a
      LEFT JOIN projects p ON p.id = COALESCE(a.current_project_id, a.home_project_id)
     WHERE a.id = ?
  `, assetId);

  if (!asset) {
    return res.status(404).json({ error: 'Vehicle/Asset not found' });
  }

  // A. MONTHLY HIRING REVENUE
  // 1. Direct hiring revenue entries
  const directRevenueLines = all(`
    SELECT vhr.*, p.name project_name, u.full_name created_by_name
      FROM vehicle_hiring_revenue vhr
      LEFT JOIN projects p ON p.id = vhr.project_id
      LEFT JOIN users u ON u.id = vhr.created_by
     WHERE vhr.asset_id = ? AND vhr.month = ?
     ORDER BY vhr.date DESC, vhr.id DESC
  `, assetId, month);

  // 2. Billing line items from equipment bills / fleet_bills for this month
  const fleetBillLines = all(`
    SELECT id, invoice_number AS bill_no, period_start, period_end, project_name,
           rate_basis, billable_units AS hours_or_days,
           ROUND(rate_cents / 100.0, 2) AS rate,
           ROUND(rental_amount_cents / 100.0, 2) AS base_amount,
           ROUND(grand_total_cents / 100.0, 2) AS net_amount
      FROM fleet_bills
     WHERE asset_id = ? AND period_key = ? AND status != 'VOID'
  `, assetId, month);

  const legacyBillingLines = fleetBillLines.length ? [] : all(`
    SELECT bli.*, b.bill_no, b.period_start, b.period_end, p.name project_name
      FROM bill_line_items bli
      JOIN bills b ON b.id = bli.bill_id
      LEFT JOIN projects p ON p.id = b.project_id
     WHERE bli.asset_id = ? AND strftime('%Y-%m', b.period_start) = ?
  `, assetId, month);

  const billingLines = fleetBillLines.length ? fleetBillLines : legacyBillingLines;

  const directRevenueTotal = directRevenueLines.reduce((acc, r) => acc + (r.total_revenue || 0), 0);
  const billingRevenueTotal = billingLines.reduce((acc, r) => acc + (r.net_amount || r.base_amount || 0), 0);
  const totalHiringRevenue = Math.round((directRevenueTotal + billingRevenueTotal) * 100) / 100;

  // B. MONTHLY VEHICLE REPAIR COST (Directly from 9632 Stores, Job Cards, Service Maintenance)
  // 1. Store Material Issues to this vehicle
  const storeIssues = all(`
    SELECT i.id, i.min_no, i.min_no AS slip_no, i.issue_date, i.issue_date AS date,
           i.description, i.description AS item_name, i.qty, i.qty AS quantity, i.unit,
           COALESCE(i.unit_price, 0) unit_price,
           ROUND(i.qty * COALESCE(i.unit_price, 0), 2) total_cost,
           i.recipient_name, i.recipient_name AS recipient, i.purpose, i.issued_by
      FROM issues i
     WHERE i.asset_id = ? AND strftime('%Y-%m', i.issue_date) = ?
     ORDER BY i.issue_date DESC, i.id DESC
  `, assetId, month);

  // 2. Job Card Parts billed to this vehicle
  const jobParts = all(`
    SELECT jp.id, jc.job_no, jp.description, jp.qty,
           COALESCE(jp.unit_price, 0) unit_cost,
           ROUND(jp.qty * COALESCE(jp.unit_price, 0), 2) total_cost,
           jc.status job_status
      FROM job_parts jp
      JOIN job_cards jc ON jc.id = jp.job_id
     WHERE jc.asset_id = ? AND strftime('%Y-%m', COALESCE(jc.completed_at, jc.started_at, jc.closed_at, jc.requested_at, jc.created_at)) = ?
     ORDER BY jp.id DESC
  `, assetId, month);

  // 3. Job Card Labour hours worked on this vehicle
  const jobLabour = all(`
    SELECT jl.id, jc.job_no, jl.mechanic AS mechanic_name, jl.hours,
           COALESCE(jl.rate, 0) hourly_rate,
           ROUND(COALESCE(jl.amount, jl.hours * COALESCE(jl.rate, 0)), 2) total_cost
      FROM job_labour jl
      JOIN job_cards jc ON jc.id = jl.job_id
     WHERE jc.asset_id = ? AND strftime('%Y-%m', COALESCE(jl.work_date, jc.completed_at, jc.started_at, jc.closed_at, jc.requested_at, jc.created_at)) = ?
     ORDER BY jl.id DESC
  `, assetId, month);

  // 4. Scheduled Service Maintenance (Oils & Filters)
  const serviceOils = all(`
    SELECT so.id, sj.service_date, sj.service_type, so.oil_name, so.oil_type, so.qty, so.price,
           ROUND(so.qty * COALESCE(so.price, 0), 2) total_cost
      FROM service_oils so
      JOIN service_jobs sj ON sj.id = so.service_id
     WHERE sj.asset_id = ? AND strftime('%Y-%m', sj.service_date) = ?
  `, assetId, month);

  const serviceFilters = all(`
    SELECT sf.id, sj.service_date, sj.service_type, sf.filter_no, sf.category, sf.qty, sf.price,
           ROUND(sf.qty * COALESCE(sf.price, 0), 2) total_cost
      FROM service_filters sf
      JOIN service_jobs sj ON sj.id = sf.service_id
     WHERE sj.asset_id = ? AND strftime('%Y-%m', sj.service_date) = ?
  `, assetId, month);

  const storeIssuesTotal = storeIssues.reduce((acc, i) => acc + (i.total_cost || 0), 0);
  const jobPartsTotal = jobParts.reduce((acc, p) => acc + (p.total_cost || 0), 0);
  const jobLabourTotal = jobLabour.reduce((acc, l) => acc + (l.total_cost || 0), 0);
  const serviceMaintenanceTotal = serviceOils.reduce((acc, o) => acc + (o.total_cost || 0), 0) +
                                  serviceFilters.reduce((acc, f) => acc + (f.total_cost || 0), 0);

  const totalRepairCost = Math.round((storeIssuesTotal + jobPartsTotal + jobLabourTotal + serviceMaintenanceTotal) * 100) / 100;

  // C. MONTHLY DIESEL / FUEL COST (Directly from Fuel-System-V2 fuel_issues)
  const fuelIssues = all(`
    SELECT fi.id, fi.issue_no, fi.issue_date,
           COALESCE(fi.fuel_type, fi.fuel_kind, 'AUTO_DIESEL') AS fuel_kind,
           fi.litres,
           COALESCE(ROUND(fi.fuel_price_cents / 100.0, 2), fi.unit_price, 0) AS unit_price,
           COALESCE(ROUND(fi.total_cost_cents / 100.0, 2), fi.total_price, 0) AS total_price,
           fi.meter_reading,
           COALESCE(fi.driver_name, fi.recipient_name) AS recipient_name,
           COALESCE(fi.station_name, fi.source, 'Bowser') AS source,
           COALESCE(ft.name, bt.name, fi.station_name, 'Bowser') AS tank_name,
           COALESCE(ft.name, bt.name, fi.station_name, 'Bowser') AS bulk_tank_name,
           u.full_name issued_by_name
      FROM fuel_issues fi
      LEFT JOIN fuel_tanks ft ON ft.id = fi.source_tank_id
      LEFT JOIN bulk_tanks bt ON CAST(bt.id AS TEXT) = CAST(fi.bulk_tank_id AS TEXT)
      LEFT JOIN users u ON u.id = fi.issued_by
     WHERE fi.asset_id = ?
       AND strftime('%Y-%m', fi.issue_date) = ?
       AND COALESCE(fi.is_voided, fi.voided, 0) = 0
     ORDER BY fi.issue_date DESC, fi.id DESC
  `, assetId, month);

  const totalDieselLitres = Math.round(fuelIssues.reduce((acc, f) => acc + (f.litres || 0), 0) * 100) / 100;
  const totalDieselCost = Math.round(fuelIssues.reduce((acc, f) => acc + (f.total_price || 0), 0) * 100) / 100;

  // D. MONTHLY DRIVER & OTHER VEHICLE COSTS
  const driverCostLines = all(`
    SELECT vdoc.*, p.name project_name, u.full_name created_by_name
      FROM vehicle_driver_other_costs vdoc
      LEFT JOIN projects p ON p.id = vdoc.project_id
      LEFT JOIN users u ON u.id = vdoc.created_by
     WHERE vdoc.asset_id = ? AND vdoc.month = ?
     ORDER BY vdoc.date DESC, vdoc.id DESC
  `, assetId, month);

  const totalDriverSalary = Math.round(driverCostLines.reduce((acc, c) => acc + (c.driver_salary || 0), 0) * 100) / 100;
  const totalBataOt = Math.round(driverCostLines.reduce((acc, c) => acc + (c.bata_ot || 0), 0) * 100) / 100;
  const totalOtherExpenses = Math.round(driverCostLines.reduce((acc, c) => acc + (c.other_expenses || 0), 0) * 100) / 100;
  const totalDriverOtherCosts = Math.round(driverCostLines.reduce((acc, c) => acc + (c.amount || (c.driver_salary + c.bata_ot + c.other_expenses) || 0), 0) * 100) / 100;

  // E. FINAL NET VEHICLE COSTING & PROFITABILITY CALCULATION
  const totalExpenses = Math.round((totalRepairCost + totalDieselCost + totalDriverOtherCosts) * 100) / 100;
  const netProfit = Math.round((totalHiringRevenue - totalExpenses) * 100) / 100;
  const profitMarginPct = totalHiringRevenue > 0
    ? Math.round((netProfit / totalHiringRevenue) * 1000) / 10
    : 0;

  res.json({
    asset: {
      id: asset.id,
      code: asset.code,
      registration: asset.registration,
      ec_code: asset.ec_code,
      category: asset.category || asset.type,
      brand: asset.brand || asset.make,
      model: asset.model_no || asset.type,
      meter_type: asset.meter_type || 'HOURS',
      current_hours: asset.current_hours || asset.running_hours || 0,
      project_name: asset.project_name
    },
    month,
    summary: {
      hiring_revenue: totalHiringRevenue,
      monthly_hiring_revenue: totalHiringRevenue,
      repair_cost: totalRepairCost,
      monthly_vehicle_repair_cost: totalRepairCost,
      diesel_cost: totalDieselCost,
      monthly_diesel_cost: totalDieselCost,
      diesel_litres: totalDieselLitres,
      monthly_diesel_litres: totalDieselLitres,
      driver_other_cost: totalDriverOtherCosts,
      monthly_driver_other_costs: totalDriverOtherCosts,
      total_expenses: totalExpenses,
      net_profit: netProfit,
      final_net_profit: netProfit,
      profit_margin_percent: profitMarginPct,
      is_profitable: netProfit >= 0
    },
    breakdown: {
      hiring_revenue: {
        total: totalHiringRevenue,
        direct_revenue_lines: directRevenueLines,
        billing_lines: billingLines
      },
      repair_costs: {
        total: totalRepairCost,
        store_issues_subtotal: storeIssuesTotal,
        job_parts_subtotal: jobPartsTotal,
        job_labour_subtotal: jobLabourTotal,
        service_maintenance_subtotal: serviceMaintenanceTotal,
        store_issues: storeIssues,
        job_parts: jobParts,
        job_labour: jobLabour,
        service_oils: serviceOils,
        service_filters: serviceFilters
      },
      diesel_costs: {
        total_cost: totalDieselCost,
        total_litres: totalDieselLitres,
        issues: fuelIssues
      },
      driver_and_other_costs: {
        total: totalDriverOtherCosts,
        driver_salary_subtotal: totalDriverSalary,
        bata_ot_subtotal: totalBataOt,
        other_expenses_subtotal: totalOtherExpenses,
        lines: driverCostLines
      }
    }
  });
});

router.get('/report', requireAuth, requireModule('costing'), handleSingleVehicleReport);
router.get('/single-vehicle', requireAuth, requireModule('costing'), handleSingleVehicleReport);

// -----------------------------------------------------------------------------
// 2. FLEET-WIDE MONTHLY COSTING & PROFIT SUMMARY
// -----------------------------------------------------------------------------
router.get('/fleet-summary', requireAuth, requireModule('costing'), asyncHandler((req, res) => {
  let month = clean(req.query.month);
  if (!month) {
    const now = new Date();
    month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  const assets = all(`
    SELECT a.id, a.code, a.registration, COALESCE(a.category, a.type) AS category, a.brand, a.type model, p.name project_name
      FROM assets a
      LEFT JOIN projects p ON p.id = COALESCE(a.current_project_id, a.home_project_id)
     ORDER BY a.code
  `);

  // Grouped bulk queries for speed
  const directRevMap = new Map(
    all(`SELECT asset_id, COALESCE(SUM(total_revenue), 0) AS r FROM vehicle_hiring_revenue WHERE month = ? GROUP BY asset_id`, month)
      .map(x => [x.asset_id, x.r])
  );
  const fleetBillRevMap = new Map(
    all(`SELECT asset_id, ROUND(COALESCE(SUM(rental_amount_cents), 0) / 100.0, 2) AS r FROM fleet_bills WHERE period_key = ? AND status != 'VOID' GROUP BY asset_id`, month)
      .map(x => [x.asset_id, x.r])
  );
  const legacyBillRevMap = new Map(
    all(`SELECT bli.asset_id, COALESCE(SUM(bli.net_amount), 0) AS r FROM bill_line_items bli JOIN bills b ON b.id = bli.bill_id WHERE strftime('%Y-%m', b.period_start) = ? GROUP BY bli.asset_id`, month)
      .map(x => [x.asset_id, x.r])
  );

  const issuesCostMap = new Map(
    all(`SELECT asset_id, COALESCE(SUM(qty * COALESCE(unit_price, 0)), 0) AS c FROM issues WHERE strftime('%Y-%m', issue_date) = ? GROUP BY asset_id`, month)
      .map(x => [x.asset_id, x.c])
  );
  const jobPartsCostMap = new Map(
    all(`SELECT jc.asset_id, COALESCE(SUM(jp.qty * COALESCE(jp.unit_price, 0)), 0) AS c FROM job_parts jp JOIN job_cards jc ON jc.id = jp.job_id WHERE strftime('%Y-%m', COALESCE(jc.completed_at, jc.started_at, jc.closed_at, jc.requested_at, jc.created_at)) = ? GROUP BY jc.asset_id`, month)
      .map(x => [x.asset_id, x.c])
  );
  const jobLabourCostMap = new Map(
    all(`SELECT jc.asset_id, COALESCE(SUM(COALESCE(jl.amount, jl.hours * COALESCE(jl.rate, 0))), 0) AS c FROM job_labour jl JOIN job_cards jc ON jc.id = jl.job_id WHERE strftime('%Y-%m', COALESCE(jl.work_date, jc.completed_at, jc.started_at, jc.closed_at, jc.requested_at, jc.created_at)) = ? GROUP BY jc.asset_id`, month)
      .map(x => [x.asset_id, x.c])
  );

  const fuelCostMap = new Map(
    all(`
      SELECT asset_id,
             COALESCE(SUM(litres), 0) AS litres,
             COALESCE(SUM(COALESCE(ROUND(total_cost_cents / 100.0, 2), total_price, 0)), 0) AS cost
        FROM fuel_issues
       WHERE strftime('%Y-%m', issue_date) = ? AND COALESCE(is_voided, voided, 0) = 0
       GROUP BY asset_id
    `, month).map(x => [x.asset_id, x])
  );

  const driverCostMap = new Map(
    all(`
      SELECT asset_id, COALESCE(SUM(COALESCE(amount, driver_salary + bata_ot + other_expenses)), 0) AS c
        FROM vehicle_driver_other_costs
       WHERE month = ?
       GROUP BY asset_id
    `, month).map(x => [x.asset_id, x.c])
  );

  const summaryRows = [];
  let fleetRevenue = 0;
  let fleetRepair = 0;
  let fleetDiesel = 0;
  let fleetDriverOther = 0;

  for (const a of assets) {
    const rev1 = directRevMap.get(a.id) || 0;
    const rev2 = fleetBillRevMap.has(a.id) ? fleetBillRevMap.get(a.id) : (legacyBillRevMap.get(a.id) || 0);
    const hiringRevenue = Math.round((rev1 + rev2) * 100) / 100;

    const issuesCost = issuesCostMap.get(a.id) || 0;
    const jobPartsCost = jobPartsCostMap.get(a.id) || 0;
    const jobLabourCost = jobLabourCostMap.get(a.id) || 0;
    const repairCost = Math.round((issuesCost + jobPartsCost + jobLabourCost) * 100) / 100;

    const fuelRow = fuelCostMap.get(a.id) || { litres: 0, cost: 0 };
    const dieselLitres = Math.round((fuelRow.litres || 0) * 100) / 100;
    const dieselCost = Math.round((fuelRow.cost || 0) * 100) / 100;

    const driverOtherCost = Math.round((driverCostMap.get(a.id) || 0) * 100) / 100;

    const totalExpenses = Math.round((repairCost + dieselCost + driverOtherCost) * 100) / 100;
    const netProfit = Math.round((hiringRevenue - totalExpenses) * 100) / 100;
    const profitMarginPct = hiringRevenue > 0
      ? Math.round((netProfit / hiringRevenue) * 1000) / 10
      : (totalExpenses > 0 ? -100 : 0);

    fleetRevenue += hiringRevenue;
    fleetRepair += repairCost;
    fleetDiesel += dieselCost;
    fleetDriverOther += driverOtherCost;

    summaryRows.push({
      id: a.id,
      asset_id: a.id,
      code: a.code,
      registration: a.registration,
      category: a.category,
      brand: a.brand,
      model: a.model,
      project_name: a.project_name,
      hiring_revenue: hiringRevenue,
      repair_cost: repairCost,
      diesel_cost: dieselCost,
      diesel_litres: dieselLitres,
      driver_other_cost: driverOtherCost,
      driver_other_costs: driverOtherCost,
      total_expenses: totalExpenses,
      net_profit: netProfit,
      margin_percent: profitMarginPct,
      profit_margin_percent: profitMarginPct
    });
  }

  summaryRows.sort((a, b) => b.net_profit - a.net_profit);

  const fleetExpenses = Math.round((fleetRepair + fleetDiesel + fleetDriverOther) * 100) / 100;
  const fleetNetProfit = Math.round((fleetRevenue - fleetExpenses) * 100) / 100;
  const fleetMargin = fleetRevenue > 0 ? Math.round((fleetNetProfit / fleetRevenue) * 1000) / 10 : 0;
  const fleetLitres = Math.round(summaryRows.reduce((acc, r) => acc + (r.diesel_litres || 0), 0) * 100) / 100;

  res.json({
    month,
    totals: {
      total_hiring_revenue: Math.round(fleetRevenue * 100) / 100,
      total_repair_cost: Math.round(fleetRepair * 100) / 100,
      total_diesel_cost: Math.round(fleetDiesel * 100) / 100,
      total_diesel_litres: fleetLitres,
      total_driver_other_cost: Math.round(fleetDriverOther * 100) / 100,
      total_driver_other_costs: Math.round(fleetDriverOther * 100) / 100,
      total_expenses: fleetExpenses,
      total_net_profit: fleetNetProfit,
      fleet_profit_margin_percent: fleetMargin
    },
    vehicles: summaryRows
  });
}));

// -----------------------------------------------------------------------------
// 3. VEHICLE HIRING REVENUE CRUD (/revenue AND /hiring-revenue)
// -----------------------------------------------------------------------------
const handleGetHiringRevenue = asyncHandler((req, res) => {
  const assetId = resolveAssetId(req.query.asset_id);
  const month = clean(req.query.month);
  const where = [];
  const params = [];

  if (assetId) { where.push('vhr.asset_id = ?'); params.push(assetId); }
  if (month) { where.push('vhr.month = ?'); params.push(month); }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const directRows = all(`
    SELECT vhr.*,
           vhr.date AS revenue_date,
           UPPER(COALESCE(vhr.hire_type, 'HOURLY')) AS rate_type,
           vhr.quantity AS hours_or_days,
           vhr.hire_rate AS rate,
           a.code AS asset_code,
           a.registration AS asset_reg,
           p.name AS project_name,
           u.full_name AS created_by_name
      FROM vehicle_hiring_revenue vhr
      JOIN assets a ON a.id = vhr.asset_id
      LEFT JOIN projects p ON p.id = vhr.project_id
      LEFT JOIN users u ON u.id = vhr.created_by
     ${whereClause}
     ORDER BY vhr.date DESC, vhr.id DESC
  `, ...params);

  // Also include fleet_bills for the requested month/asset so generated hire bills appear seamlessly
  const billWhere = ["fb.status != 'VOID'"];
  const billParams = [];
  if (assetId) { billWhere.push('fb.asset_id = ?'); billParams.push(assetId); }
  if (month) { billWhere.push('fb.period_key = ?'); billParams.push(month); }

  const billRows = all(`
    SELECT fb.id,
           fb.asset_id,
           COALESCE(fb.issued_date, fb.period_end, fb.period_start) AS date,
           COALESCE(fb.issued_date, fb.period_end, fb.period_start) AS revenue_date,
           fb.period_key AS month,
           fb.project_id,
           fb.project_name,
           COALESCE(fb.rate_basis, 'MONTHLY') AS hire_type,
           COALESCE(fb.rate_basis, 'MONTHLY') AS rate_type,
           fb.billable_units AS quantity,
           fb.billable_units AS hours_or_days,
           ROUND(COALESCE(fb.rate_cents, 0) / 100.0, 2) AS hire_rate,
           ROUND(COALESCE(fb.rate_cents, 0) / 100.0, 2) AS rate,
           ROUND(COALESCE(fb.rental_amount_cents, fb.grand_total_cents, 0) / 100.0, 2) AS total_revenue,
           fb.invoice_number AS invoice_no,
           COALESCE(fb.notes, 'Hire Bill ' || fb.invoice_number) AS notes,
           fb.asset_code,
           fb.asset_reg_no AS asset_reg
      FROM fleet_bills fb
     WHERE ${billWhere.join(' AND ')}
     ORDER BY fb.id DESC
     LIMIT 250
  `, ...billParams);

  const combined = [...directRows, ...billRows];
  res.json({ rows: combined, items: combined });
});

const handlePostHiringRevenue = asyncHandler((req, res) => {
  const assetId = resolveAssetId(req.body.asset_id);
  const date = clean(req.body.date || req.body.revenue_date) || new Date().toISOString().slice(0, 10);
  const month = clean(req.body.month) || date.slice(0, 7);
  const projectId = toInt(req.body.project_id);
  const hireType = clean(req.body.hire_type || req.body.rate_type) || 'HOURLY';
  const quantity = toFloat(req.body.quantity ?? req.body.hours_or_days);
  const hireRate = toFloat(req.body.hire_rate ?? req.body.rate);
  let totalRevenue = toFloat(req.body.total_revenue ?? req.body.total_amount);

  if (!assetId || (quantity <= 0 && totalRevenue <= 0)) {
    return res.status(400).json({ error: 'Valid vehicle (ID or code) and quantity or total_revenue are required' });
  }

  if (!totalRevenue || totalRevenue <= 0) {
    totalRevenue = Math.round(quantity * hireRate * 100) / 100;
  }

  const invoiceNo = clean(req.body.invoice_no);
  const notes = clean(req.body.notes);

  const info = run(`
    INSERT INTO vehicle_hiring_revenue (
      asset_id, date, month, project_id, hire_type, quantity, hire_rate, total_revenue, invoice_no, notes, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, assetId, date, month, projectId, hireType, quantity, hireRate, totalRevenue, invoiceNo, notes, req.user.id);

  emitter.emit('data_changed', { type: 'vehicle_revenue', asset_id: assetId, month });
  res.json({ ok: true, id: info.lastInsertRowid, total_revenue: totalRevenue });
});

const handleDeleteHiringRevenue = asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const row = get('SELECT id, asset_id, month FROM vehicle_hiring_revenue WHERE id = ?', id);
  if (!row) return res.status(404).json({ error: 'Record not found' });

  run('DELETE FROM vehicle_hiring_revenue WHERE id = ?', id);
  emitter.emit('data_changed', { type: 'vehicle_revenue', asset_id: row.asset_id, month: row.month });
  res.json({ ok: true, id });
});

router.get('/revenue', requireAuth, requireModule('costing'), handleGetHiringRevenue);
router.post('/revenue', requireAuth, requireModule('costing', 'add'), handlePostHiringRevenue);
router.delete('/revenue/:id', requireAuth, requireModule('costing', 'edit'), handleDeleteHiringRevenue);

router.get('/hiring-revenue', requireAuth, requireModule('costing'), handleGetHiringRevenue);
router.post('/hiring-revenue', requireAuth, requireModule('costing', 'add'), handlePostHiringRevenue);
router.delete('/hiring-revenue/:id', requireAuth, requireModule('costing', 'edit'), handleDeleteHiringRevenue);

// -----------------------------------------------------------------------------
// 4. DRIVER & OTHER COSTS CRUD
// -----------------------------------------------------------------------------
router.get('/driver-costs', requireAuth, requireModule('costing'), asyncHandler((req, res) => {
  const assetId = resolveAssetId(req.query.asset_id);
  const month = clean(req.query.month);
  const where = [];
  const params = [];

  if (assetId) { where.push('vdoc.asset_id = ?'); params.push(assetId); }
  if (month) { where.push('vdoc.month = ?'); params.push(month); }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = all(`
    SELECT vdoc.*,
           vdoc.date AS cost_date,
           COALESCE(vdoc.description, '') AS notes,
           a.code asset_code, a.registration asset_reg, p.name project_name, u.full_name created_by_name
      FROM vehicle_driver_other_costs vdoc
      JOIN assets a ON a.id = vdoc.asset_id
      LEFT JOIN projects p ON p.id = vdoc.project_id
      LEFT JOIN users u ON u.id = vdoc.created_by
     ${whereClause}
     ORDER BY vdoc.date DESC, vdoc.id DESC
  `, ...params);

  res.json({ rows, items: rows });
}));

router.post('/driver-costs', requireAuth, requireModule('costing', 'add'), asyncHandler((req, res) => {
  const assetId = resolveAssetId(req.body.asset_id);
  const date = clean(req.body.date || req.body.cost_date) || new Date().toISOString().slice(0, 10);
  const month = clean(req.body.month) || date.slice(0, 7);
  const projectId = toInt(req.body.project_id);
  const costType = clean(req.body.cost_type) || 'SALARY';
  const driverName = clean(req.body.driver_name || req.body.payee);
  const driverSalary = toFloat(req.body.driver_salary);
  const bataOt = toFloat(req.body.bata_ot);
  const otherExpenses = toFloat(req.body.other_expenses);
  let amount = toFloat(req.body.amount);
  const description = clean(req.body.description || req.body.notes);

  if (!assetId) {
    return res.status(400).json({ error: 'Valid vehicle (ID or code) is required' });
  }

  if (!amount || amount <= 0) {
    amount = Math.round((driverSalary + bataOt + otherExpenses) * 100) / 100;
  }

  const info = run(`
    INSERT INTO vehicle_driver_other_costs (
      asset_id, date, month, project_id, cost_type, driver_name,
      driver_salary, bata_ot, other_expenses, amount, description, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, assetId, date, month, projectId, costType, driverName,
     driverSalary, bataOt, otherExpenses, amount, description, req.user.id);

  emitter.emit('data_changed', { type: 'vehicle_driver_cost', asset_id: assetId, month });
  res.json({ ok: true, id: info.lastInsertRowid, amount });
}));

router.delete('/driver-costs/:id', requireAuth, requireModule('costing', 'edit'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const row = get('SELECT id, asset_id, month FROM vehicle_driver_other_costs WHERE id = ?', id);
  if (!row) return res.status(404).json({ error: 'Record not found' });

  run('DELETE FROM vehicle_driver_other_costs WHERE id = ?', id);
  emitter.emit('data_changed', { type: 'vehicle_driver_cost', asset_id: row.asset_id, month: row.month });
  res.json({ ok: true, id });
}));

module.exports = router;
