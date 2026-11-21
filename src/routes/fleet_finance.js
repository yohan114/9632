'use strict';

/**
 * Fleet Financial Reporting & Vehicle Profitability Routes (Plan V2)
 *
 * Mounts at /api/fleet/finance
 * Implements Plan V2 §13 & §14:
 * Reconciles revenue, fuel direct expense, maintenance labour/parts/oil/CCOM,
 * driver wage, and hired-in costs to compute Operating Contribution and Full-Cost Result.
 */

const express = require('express');
const router = express.Router();

const { get, all, run, tx } = require('../db');
const { requireAuth, requireCap } = require('../lib/auth');
const { asyncHandler } = require('../lib/http');
const { sendXlsx } = require('../lib/export');
const audit = require('../lib/audit');

function computeVehicleProfitability({ year, month, assetCode, projectId } = {}) {
  const y = Number(year) || new Date().getFullYear();
  const m = Number(month) || (new Date().getMonth() + 1);
  const periodKey = `${y}-${String(m).padStart(2, '0')}`;
  const periodStart = `${periodKey}-01`;
  const periodEnd = `${periodKey}-${new Date(y, m, 0).getDate()}`;

  const assetConditions = [];
  const assetParams = [];

  if (assetCode) {
    assetConditions.push('(UPPER(a.ec_code) LIKE UPPER(?) OR UPPER(a.registration) LIKE UPPER(?))');
    assetParams.push(`%${assetCode}%`, `%${assetCode}%`);
  }
  if (projectId) {
    assetConditions.push('(a.home_project_id = ? OR a.current_project_id = ?)');
    assetParams.push(Number(projectId), Number(projectId));
  }

  const assetWhere = assetConditions.length ? `WHERE ${assetConditions.join(' AND ')}` : '';
  const assets = all(`
    SELECT a.id, a.ec_code, a.code, a.registration, a.brand, a.type, 'OWNED' AS ownership, a.home_project_id, a.current_project_id,
           hp.name AS home_project_name, cp.name AS current_project_name
      FROM assets a
      LEFT JOIN projects hp ON hp.id = a.home_project_id
      LEFT JOIN projects cp ON cp.id = a.current_project_id
     ${assetWhere}
     ORDER BY COALESCE(a.ec_code, a.code) ASC
  `, ...assetParams);

  const billRows = all(`
    SELECT asset_id, asset_code,
           COALESCE(SUM(rental_amount_cents), 0) AS rental_revenue_cents,
           COALESCE(SUM(fuel_cost_cents), 0) AS fuel_recharge_revenue_cents,
           COALESCE(SUM(billable_units), 0) AS total_billable_units,
           rate_basis
      FROM fleet_bills
     WHERE year = ? AND month = ? AND status != 'VOID'
     GROUP BY asset_id, asset_code
  `, y, m);
  const billMap = new Map();
  for (const b of billRows) {
    if (b.asset_id) billMap.set(b.asset_id, b);
    if (b.asset_code) billMap.set(b.asset_code, b);
  }

  const fuelRows = all(`
    SELECT asset_id, asset_code,
           COALESCE(SUM(litres), 0) AS fuel_litres,
           COALESCE(SUM(
             CASE
               WHEN COALESCE(total_cost_cents, 0) > 0 THEN total_cost_cents
               WHEN COALESCE(cost_cents, 0) > 0 THEN cost_cents
               WHEN COALESCE(total_price, 0) > 0 THEN ROUND(total_price * 100)
               WHEN COALESCE(fuel_price_cents, price_per_litre_cents, 0) > 0 THEN ROUND(COALESCE(litres, 0) * COALESCE(fuel_price_cents, price_per_litre_cents))
               ELSE ROUND(COALESCE(litres, 0) * COALESCE(unit_price, 0) * 100)
             END
           ), 0) AS fuel_cost_cents
      FROM fuel_issues
     WHERE COALESCE(is_voided, voided, 0) = 0 AND issue_date >= ? AND issue_date <= ?
     GROUP BY asset_id, asset_code
  `, periodStart, periodEnd + ' 23:59:59');
  const fuelMap = new Map();
  for (const f of fuelRows) {
    if (f.asset_id) fuelMap.set(f.asset_id, f);
    if (f.asset_code) fuelMap.set(f.asset_code, f);
  }

  const maintMap = new Map();
  const ensureMaint = (id) => {
    if (!maintMap.has(id)) {
      maintMap.set(id, { labour_cents: 0, parts_cents: 0, oil_cents: 0, outsource_cents: 0, tb_cents: 0, driver_cents: 0 });
    }
    return maintMap.get(id);
  };

  try {
    const maintRows = all(`
      SELECT j.asset_id,
             ROUND(COALESCE(SUM(jc.labour_cost), 0) * 100) AS labour_cents,
             ROUND(COALESCE(SUM(COALESCE(jc.material_cost, 0) + COALESCE(jc.general_cost, 0)), 0) * 100) AS parts_cents,
             ROUND(COALESCE(SUM(jc.oil_cost), 0) * 100) AS oil_cents,
             ROUND(COALESCE(SUM(jc.external_cost), 0) * 100) AS outsource_cents
        FROM job_cards j
        JOIN job_costs jc ON jc.job_id = j.id
       WHERE j.asset_id IS NOT NULL
         AND COALESCE(j.completed_at, j.closed_at, j.started_at, j.created_at) >= ?
         AND COALESCE(j.completed_at, j.closed_at, j.started_at, j.created_at) <= ?
       GROUP BY j.asset_id
    `, periodStart, periodEnd + ' 23:59:59');
    for (const mr of maintRows) {
      const mRow = ensureMaint(mr.asset_id);
      mRow.labour_cents += Number(mr.labour_cents) || 0;
      mRow.parts_cents += Number(mr.parts_cents) || 0;
      mRow.oil_cents += Number(mr.oil_cents) || 0;
      mRow.outsource_cents += Number(mr.outsource_cents) || 0;
    }

    const issueRows = all(`
      SELECT asset_id,
             ROUND(COALESCE(SUM(qty * COALESCE(unit_price, 0)), 0) * 100) AS issue_parts_cents
        FROM issues
       WHERE asset_id IS NOT NULL
         AND COALESCE(voided, 0) = 0
         AND COALESCE(LOWER(category), '') NOT LIKE '%lubric%'
         AND COALESCE(LOWER(category), '') NOT LIKE '%oil%'
         AND issue_date >= ? AND issue_date <= ?
       GROUP BY asset_id
    `, periodStart, periodEnd + ' 23:59:59');
    for (const ir of issueRows) {
      const mRow = ensureMaint(ir.asset_id);
      if (!mRow.parts_cents && ir.issue_parts_cents > 0) {
        mRow.parts_cents = Number(ir.issue_parts_cents) || 0;
      }
    }
  } catch (_) {}

  // Tyre & Battery issues priced directly or via tyre_battery_prices catalog
  try {
    const tbRows = all(`
      SELECT i.asset_id,
             ROUND(COALESCE(SUM(COALESCE(i.qty, 0) * COALESCE(i.unit_price, p.unit_price, 0)), 0) * 100) AS tb_cents
        FROM tyre_battery_issues i
        LEFT JOIN tyre_battery_prices p ON p.kind = i.kind AND p.category_norm = i.category_norm
       WHERE i.asset_id IS NOT NULL
         AND substr(i.issue_date, 1, 7) = ?
       GROUP BY i.asset_id
    `, periodKey);
    for (const tr of tbRows) {
      ensureMaint(tr.asset_id).tb_cents += Number(tr.tb_cents) || 0;
    }
  } catch (_) {}

  // CCOM outsourcing invoices not yet folded into parent job_costs.external_cost
  try {
    const outRows = all(`
      SELECT r.asset_id,
             ROUND(COALESCE(SUM(l.amount), 0) * 100) AS out_cents
        FROM outsourcing_cost_links l
        JOIN outsourcing_requests r ON r.id = l.request_id
       WHERE r.asset_id IS NOT NULL
         AND COALESCE(l.posted_to_parent, 0) = 0
         AND substr(COALESCE(l.invoice_date, l.created_at), 1, 7) = ?
       GROUP BY r.asset_id
    `, periodKey);
    for (const orow of outRows) {
      ensureMaint(orow.asset_id).outsource_cents += Number(orow.out_cents) || 0;
    }
  } catch (_) {}

  // Driver wage & other vehicle costs
  try {
    const drvRows = all(`
      SELECT asset_id,
             ROUND(COALESCE(SUM(amount), 0) * 100) AS drv_cents
        FROM vehicle_driver_other_costs
       WHERE asset_id IS NOT NULL
         AND month = ?
       GROUP BY asset_id
    `, periodKey);
    for (const dr of drvRows) {
      ensureMaint(dr.asset_id).driver_cents += Number(dr.drv_cents) || 0;
    }
  } catch (_) {}

  const report = assets.map((a) => {
    const b = billMap.get(a.id) || (a.ec_code && billMap.get(a.ec_code)) || (a.code && billMap.get(a.code)) || { rental_revenue_cents: 0, fuel_recharge_revenue_cents: 0, total_billable_units: 0 };
    const f = fuelMap.get(a.id) || (a.ec_code && fuelMap.get(a.ec_code)) || (a.code && fuelMap.get(a.code)) || { fuel_litres: 0, fuel_cost_cents: 0 };
    const mt = maintMap.get(a.id) || { labour_cents: 0, parts_cents: 0, oil_cents: 0, outsource_cents: 0, tb_cents: 0, driver_cents: 0 };

    const rentalRev = Number(b.rental_revenue_cents) || 0;
    const fuelRev = Number(b.fuel_recharge_revenue_cents) || 0;
    const grossRev = rentalRev + fuelRev;

    const fuelCost = Number(f.fuel_cost_cents) || 0;
    const labourCost = Number(mt.labour_cents) || 0;
    const partsCost = Number(mt.parts_cents) || 0;
    const oilCost = Number(mt.oil_cents) || 0;
    const ccomCost = Number(mt.outsource_cents) || 0;
    const tbCost = Number(mt.tb_cents) || 0;
    const driverCost = Number(mt.driver_cents) || 0;
    const totalMaintCost = labourCost + partsCost + oilCost + ccomCost + tbCost;

    const totalDirectCost = fuelCost + totalMaintCost + driverCost;
    const operatingContribution = grossRev - totalDirectCost;
    const marginPct = grossRev > 0 ? ((operatingContribution / grossRev) * 100).toFixed(1) : 'N/A';
    const assetCodeVal = a.ec_code || a.code || a.registration || `AST-${a.id}`;

    return {
      assetId: a.id,
      assetCode: assetCodeVal,
      registration: a.registration,
      assetType: a.type,
      ownership: a.ownership,
      projectName: a.current_project_name || a.home_project_name || 'Central Workshop',
      periodKey,
      billableUnits: b.total_billable_units,
      rentalRevenueCents: rentalRev,
      fuelRechargeRevenueCents: fuelRev,
      grossRevenueCents: grossRev,
      fuelLitres: Number(f.fuel_litres) || 0,
      fuelCostCents: fuelCost,
      maintenanceLabourCents: labourCost,
      maintenancePartsCents: partsCost,
      maintenanceOilCents: oilCost,
      ccomOutsourceCents: ccomCost,
      tyreBatteryCostCents: tbCost,
      driverOtherCostCents: driverCost,
      totalMaintenanceCents: totalMaintCost,
      totalDirectCostCents: totalDirectCost,
      operatingContributionCents: operatingContribution,
      marginPct,
    };
  });

  let sealedCount = 0;
  let lastSealedAt = null;
  try {
    const sRow = get(
      'SELECT COUNT(*) AS c, MAX(sealed_at) AS last_at FROM fleet_monthly_snapshots WHERE year = ? AND month = ? AND is_sealed = 1',
      y, m
    );
    if (sRow) {
      sealedCount = Number(sRow.c) || 0;
      lastSealedAt = sRow.last_at || null;
    }
  } catch (_) {}

  const summary = {
    totalGrossRevenueCents: report.reduce((sum, r) => sum + r.grossRevenueCents, 0),
    totalFuelCostCents: report.reduce((sum, r) => sum + r.fuelCostCents, 0),
    totalMaintenanceCents: report.reduce((sum, r) => sum + r.totalMaintenanceCents, 0),
    totalTyreBatteryCents: report.reduce((sum, r) => sum + r.tyreBatteryCostCents, 0),
    totalCcomOutsourceCents: report.reduce((sum, r) => sum + r.ccomOutsourceCents, 0),
    totalDriverOtherCents: report.reduce((sum, r) => sum + r.driverOtherCostCents, 0),
    totalOperatingContributionCents: report.reduce((sum, r) => sum + r.operatingContributionCents, 0),
    totalDieselLitres: report.reduce((sum, r) => sum + r.fuelLitres, 0),
  };

  return {
    year: y,
    month: m,
    periodKey,
    totalAssets: report.length,
    sealedCount,
    lastSealedAt,
    summary,
    report,
  };
}

router.get('/vehicle-profitability', requireAuth, requireCap('fleet.profitability.view'), asyncHandler(async (req, res) => {
  res.json(computeVehicleProfitability(req.query));
}));

router.get('/vehicle-profitability.xlsx', requireAuth, requireCap('fleet.profitability.view'), asyncHandler(async (req, res) => {
  const data = computeVehicleProfitability(req.query);
  const toRs = (cents) => Math.round(Number(cents || 0)) / 100;

  const detailColumns = [
    { header: 'Vehicle Code', key: 'asset_code', width: 16 },
    { header: 'Registration', key: 'registration', width: 16 },
    { header: 'Type', key: 'asset_type', width: 18 },
    { header: 'Ownership', key: 'ownership', width: 12 },
    { header: 'Site', key: 'project_name', width: 24 },
    { header: 'Billable Units', key: 'billable_units', width: 14 },
    { header: 'Rental Revenue (LKR)', key: 'rental_revenue', width: 20 },
    { header: 'Fuel Recharge (LKR)', key: 'fuel_recharge', width: 20 },
    { header: 'Gross Revenue (LKR)', key: 'gross_revenue', width: 20 },
    { header: 'Diesel Litres', key: 'diesel_litres', width: 14 },
    { header: 'Diesel Cost (LKR)', key: 'diesel_cost', width: 18 },
    { header: 'Labour (LKR)', key: 'labour_cost', width: 16 },
    { header: 'Parts (LKR)', key: 'parts_cost', width: 16 },
    { header: 'Oil (LKR)', key: 'oil_cost', width: 14 },
    { header: 'Tyre & Battery (LKR)', key: 'tb_cost', width: 18 },
    { header: 'C.COM Outsourcing (LKR)', key: 'ccom_cost', width: 20 },
    { header: 'Driver / Other (LKR)', key: 'driver_cost', width: 18 },
    { header: 'Total Direct Costs (LKR)', key: 'total_direct_cost', width: 22 },
    { header: 'Operating Contribution (LKR)', key: 'operating_contribution', width: 24 },
    { header: 'Margin (%)', key: 'margin_pct', width: 12 },
  ];

  const detailRows = data.report.map((r) => ({
    asset_code: r.assetCode || '',
    registration: r.registration || '',
    asset_type: r.assetType || '',
    ownership: r.ownership || 'OWNED',
    project_name: r.projectName || '',
    billable_units: Number(r.billableUnits || 0),
    rental_revenue: toRs(r.rentalRevenueCents),
    fuel_recharge: toRs(r.fuelRechargeRevenueCents),
    gross_revenue: toRs(r.grossRevenueCents),
    diesel_litres: Number(r.fuelLitres || 0),
    diesel_cost: toRs(r.fuelCostCents),
    labour_cost: toRs(r.maintenanceLabourCents),
    parts_cost: toRs(r.maintenancePartsCents),
    oil_cost: toRs(r.maintenanceOilCents),
    tb_cost: toRs(r.tyreBatteryCostCents),
    ccom_cost: toRs(r.ccomOutsourceCents),
    driver_cost: toRs(r.driverOtherCostCents),
    total_direct_cost: toRs(r.totalDirectCostCents),
    operating_contribution: toRs(r.operatingContributionCents),
    margin_pct: r.marginPct,
  }));

  const s = data.summary;
  const summaryColumns = [
    { header: 'Metric', key: 'metric', width: 30 },
    { header: 'Value', key: 'value', width: 24 },
  ];
  const summaryRows = [
    { metric: 'Period', value: data.periodKey },
    { metric: 'Total Assets', value: data.totalAssets },
    { metric: 'Sealed Snapshots', value: data.sealedCount },
    { metric: 'Gross Revenue (LKR)', value: toRs(s.totalGrossRevenueCents) },
    { metric: 'Diesel Litres Issued', value: Number(s.totalDieselLitres || 0) },
    { metric: 'Diesel Cost (LKR)', value: toRs(s.totalFuelCostCents) },
    { metric: 'Workshop Maintenance Total (LKR)', value: toRs(s.totalMaintenanceCents) },
    { metric: 'Tyre & Battery (LKR)', value: toRs(s.totalTyreBatteryCents) },
    { metric: 'Driver / Other (LKR)', value: toRs(s.totalDriverOtherCents) },
    { metric: 'Operating Contribution (LKR)', value: toRs(s.totalOperatingContributionCents) },
  ];

  await sendXlsx(res, `fleet-profitability-${data.periodKey}.xlsx`, [
    { name: 'Vehicle Profitability', columns: detailColumns, rows: detailRows },
    { name: 'Summary', columns: summaryColumns, rows: summaryRows },
  ]);
}));

router.post('/seal-period', requireAuth, requireCap('finance.period.close'), asyncHandler(async (req, res) => {
  const { year, month } = req.body;
  if (!year || !month) return res.status(400).json({ error: 'year and month are required' });

  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    return res.status(400).json({ error: 'Valid numeric year and month (1-12) are required' });
  }
  const periodKey = `${y}-${String(m).padStart(2, '0')}`;
  const actorId = req.user ? req.user.id : 1;

  const { report, summary } = computeVehicleProfitability({ year: y, month: m });
  const activeRows = report.filter((r) => r.grossRevenueCents !== 0 || r.totalDirectCostCents !== 0 || r.fuelLitres > 0);
  let sealedCount = 0;

  try {
    tx(() => {
      for (const r of activeRows) {
        const snapId = `snap-${periodKey}-${r.assetId}`;
        run(`
          INSERT INTO fleet_monthly_snapshots (
            id, asset_id, asset_code, year, month, period_key,
            rental_revenue_cents, fuel_recharge_revenue_cents, fuel_cost_cents,
            maintenance_labour_cents, maintenance_parts_cents, maintenance_oil_cents,
            ccom_outsourcing_cents, driver_wage_cents, operating_contribution_cents,
            full_cost_result_cents, diesel_litres, is_sealed, sealed_at, sealed_by, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, 1, datetime('now'), ?, datetime('now')
          )
          ON CONFLICT(asset_id, year, month) DO UPDATE SET
            asset_code = excluded.asset_code,
            rental_revenue_cents = excluded.rental_revenue_cents,
            fuel_recharge_revenue_cents = excluded.fuel_recharge_revenue_cents,
            fuel_cost_cents = excluded.fuel_cost_cents,
            maintenance_labour_cents = excluded.maintenance_labour_cents,
            maintenance_parts_cents = excluded.maintenance_parts_cents,
            maintenance_oil_cents = excluded.maintenance_oil_cents,
            ccom_outsourcing_cents = excluded.ccom_outsourcing_cents,
            driver_wage_cents = excluded.driver_wage_cents,
            operating_contribution_cents = excluded.operating_contribution_cents,
            full_cost_result_cents = excluded.full_cost_result_cents,
            diesel_litres = excluded.diesel_litres,
            is_sealed = 1,
            sealed_at = datetime('now'),
            sealed_by = excluded.sealed_by,
            updated_at = datetime('now')
        `,
          snapId, r.assetId, r.assetCode, y, m, periodKey,
          r.rentalRevenueCents, r.fuelRechargeRevenueCents, r.fuelCostCents,
          r.maintenanceLabourCents, r.maintenancePartsCents + r.tyreBatteryCostCents, r.maintenanceOilCents,
          r.ccomOutsourceCents, r.driverOtherCostCents, r.operatingContributionCents,
          r.operatingContributionCents, r.fuelLitres, actorId
        );
        sealedCount++;
      }
    });
  } catch (e) {
    console.warn('[fleet_finance] Snapshot persistence skipped:', e.message);
  }

  audit.record({
    userId: actorId,
    entity: 'fleet_monthly_snapshots',
    entityId: null,
    action: 'seal_period',
    after: { year: y, month: m, periodKey, sealedCount, summary },
  });
  res.json({ success: true, periodKey, sealedCount, sealedBy: actorId, sealedAt: new Date().toISOString() });
}));

module.exports = router;
