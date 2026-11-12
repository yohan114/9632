'use strict';

/**
 * Consolidated Master Dashboard API Routes (Plan V2)
 *
 * Mounts at /api/master-dashboard
 * Provides unified executive KPIs spanning Operations, Fuel, Hire Billing, and Stores.
 */

const express = require('express');
const router = express.Router();

const { get, all } = require('../db');
const { requireAuth, requireCap } = require('../lib/auth');
const { asyncHandler } = require('../lib/http');
const jobstate = require('../lib/jobstate');

router.get('/summary', requireAuth, requireCap('master_dashboard.view'), asyncHandler(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';
  const y = new Date().getFullYear();
  const m = new Date().getMonth() + 1;

  // 1. Fleet count
  const assetCounts = get(`
    SELECT COUNT(*) AS total_assets,
           SUM(CASE WHEN in_register = 1 THEN 1 ELSE 0 END) AS registered_assets,
           SUM(CASE WHEN UPPER(status) = 'ACTIVE' OR status IS NULL THEN 1 ELSE 0 END) AS active_assets
      FROM assets
  `) || { total_assets: 0, registered_assets: 0, active_assets: 0 };

  // 2. Open job cards
  let openJobs = 0;
  try {
    // The one definition of an open card (src/lib/jobstate.js): a partly closed card has released
    // the vehicle and is not open, as on every other dashboard.
    const jobRow = get(`SELECT COUNT(*) AS count FROM job_cards WHERE ${jobstate.openSql()}`);
    openJobs = jobRow ? jobRow.count : 0;
  } catch (_) {}

  // 3. Fuel issues today and this month
  const todayFuel = get(`
    SELECT COUNT(*) AS count, COALESCE(SUM(litres), 0) AS litres, COALESCE(SUM(total_cost_cents), 0) AS cost_cents
      FROM fuel_issues
     WHERE is_voided = 0 AND issue_date >= ?
  `, today) || { count: 0, litres: 0, cost_cents: 0 };

  const monthFuel = get(`
    SELECT COUNT(*) AS count, COALESCE(SUM(litres), 0) AS litres, COALESCE(SUM(total_cost_cents), 0) AS cost_cents
      FROM fuel_issues
     WHERE is_voided = 0 AND issue_date >= ?
  `, monthStart) || { count: 0, litres: 0, cost_cents: 0 };

  // 4. Finalised / active rental revenue this month
  const monthBilling = get(`
    SELECT COUNT(*) AS bills_count,
           COALESCE(SUM(rental_amount_cents), 0) AS rental_revenue_cents,
           COALESCE(SUM(fuel_cost_cents), 0) AS fuel_recharge_revenue_cents,
           COALESCE(SUM(grand_total_cents), 0) AS grand_total_cents
      FROM fleet_bills
     WHERE year = ? AND month = ? AND status != 'VOID'
  `, y, m) || { bills_count: 0, rental_revenue_cents: 0, fuel_recharge_revenue_cents: 0, grand_total_cents: 0 };

  // 5. Bulk tanks alert (low stock < 20% capacity)
  const lowTanks = all(`
    SELECT id, code, name, capacity_litres, current_litres,
           ROUND((current_litres / MAX(1, capacity_litres)) * 100, 1) AS pct_full
      FROM fuel_tanks
     WHERE active = 1 AND capacity_litres > 0 AND (current_litres / capacity_litres) < 0.20
     ORDER BY pct_full ASC
  `);

  // 6. Pending approvals count
  let pendingCorrections = 0;
  try {
    const pRow = get("SELECT COUNT(*) AS count FROM fuel_corrections WHERE status = 'PENDING'");
    pendingCorrections = pRow ? pRow.count : 0;
  } catch (_) {}

  const grossRev = (Number(monthBilling.rental_revenue_cents) || 0) + (Number(monthBilling.fuel_recharge_revenue_cents) || 0);
  const fuelCost = Number(monthFuel.cost_cents) || 0;
  const contribution = grossRev - fuelCost;

  res.json({
    date: today,
    monthKey: `${y}-${String(m).padStart(2, '0')}`,
    fleet: {
      total: assetCounts.total_assets,
      active: assetCounts.active_assets,
      openJobCards: openJobs,
    },
    fuel: {
      todayLitres: todayFuel.litres,
      todayCostCents: todayFuel.cost_cents,
      todayIssuesCount: todayFuel.count,
      monthLitres: monthFuel.litres,
      monthCostCents: monthFuel.cost_cents,
      monthIssuesCount: monthFuel.count,
      lowStockTanks: lowTanks,
      pendingCorrections,
    },
    billing: {
      finalBillsCount: monthBilling.bills_count,
      rentalRevenueCents: monthBilling.rental_revenue_cents,
      fuelRechargeRevenueCents: monthBilling.fuel_recharge_revenue_cents,
      grandTotalCents: monthBilling.grand_total_cents,
      operatingContributionCents: contribution,
    },
  });
}));

router.post('/sync-live', requireAuth, asyncHandler(async (req, res) => {
  if (!req.user || !req.user.roles || !req.user.roles.includes('admin')) {
    return res.status(403).json({ error: 'Only System Administrators can trigger a live database delta sync' });
  }
  const { runLiveDeltaSync } = require('../../scripts/sync_all_live_data');
  const stats = runLiveDeltaSync({ quiet: true });
  try {
    const emitter = require('../lib/emitter');
    emitter.emit('data_changed', { type: 'live_sync', stats });
  } catch (_) {}
  res.json({ ok: true, stats, syncedAt: new Date().toISOString() });
}));

module.exports = router;
