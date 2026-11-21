'use strict';

/**
 * Consolidated Master Dashboard API Routes (Plan V2)
 *
 * Mounts at /api/master-dashboard
 * Provides unified executive KPIs spanning Operations, Fuel, Hire Billing, and Stores.
 */

const express = require('express');
const path = require('path');
const router = express.Router();

const { get, all } = require('../db');
const { requireAuth, requireCap } = require('../lib/auth');
const { asyncHandler, toInt } = require('../lib/http');
const { sendXlsx } = require('../lib/export');
const jobstate = require('../lib/jobstate');
const audit = require('../lib/audit');
const backup = require('../lib/backup');
const config = require('../config');

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
  } catch (e) { console.warn('[master_dashboard] openJobs check failed:', e.message); }

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
  } catch (e) { console.warn('[master_dashboard] pendingCorrections check failed:', e.message); }

  // 7. Data completeness & hygiene indicators
  const dataHealth = {
    unpricedStoreIssues: 0,
    overdueOpenMrns: 0,
    unresolvedAssetAliases: 0,
    latestFuelTariffDate: null,
    staleFuelTariffDays: null,
    missingVehicleDocVersions: 0,
  };
  try {
    const r = get("SELECT COUNT(*) AS c FROM issues WHERE (unit_price IS NULL OR unit_price <= 0) AND COALESCE(voided, 0) = 0");
    dataHealth.unpricedStoreIssues = r ? Number(r.c) || 0 : 0;
  } catch (_) {}
  try {
    const r = get("SELECT COUNT(*) AS c FROM mrn WHERE status IN ('open','pending','approved','ordered') AND req_date < date('now', '-30 days')");
    dataHealth.overdueOpenMrns = r ? Number(r.c) || 0 : 0;
  } catch (_) {}
  try {
    const r = get("SELECT COUNT(*) AS c FROM asset_aliases WHERE resolved = 0");
    dataHealth.unresolvedAssetAliases = r ? Number(r.c) || 0 : 0;
  } catch (_) {}
  try {
    const r = get("SELECT MAX(effective_date) AS d FROM fuel_prices");
    const d = r && r.d ? String(r.d).slice(0, 10) : null;
    dataHealth.latestFuelTariffDate = d;
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const diffMs = Date.parse(today + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z');
      dataHealth.staleFuelTariffDays = Math.max(0, Math.round(diffMs / 86400000));
    }
  } catch (_) {}
  try {
    const r = get("SELECT COUNT(*) AS c FROM vehicle_documents WHERE is_required = 1 AND is_exempt = 0 AND current_version_id IS NULL");
    dataHealth.missingVehicleDocVersions = r ? Number(r.c) || 0 : 0;
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
    dataHealth,
  });
}));

router.get('/cutover-status', requireAuth, asyncHandler(async (req, res) => {
  if (!req.user || !req.user.roles || !req.user.roles.includes('admin')) {
    return res.status(403).json({ error: 'Only System Administrators can inspect legacy cutover parity' });
  }
  const { getCutoverParityReport } = require('../../scripts/sync_all_live_data');
  const report = getCutoverParityReport({ mergedPath: config.dbPath });
  res.json(report);
}));

router.post('/sync-live', requireAuth, asyncHandler(async (req, res) => {
  if (!req.user || !req.user.roles || !req.user.roles.includes('admin')) {
    return res.status(403).json({ error: 'Only System Administrators can trigger a live database delta sync' });
  }
  const { runLiveDeltaSync, getCutoverParityReport } = require('../../scripts/sync_all_live_data');
  if (req.body && req.body.dryRun) {
    return res.json({ ok: true, dryRun: true, parity: getCutoverParityReport({ mergedPath: config.dbPath }) });
  }

  let preSyncBackup = null;
  try {
    const snapPath = await backup.snapshot();
    preSyncBackup = snapPath ? path.basename(String(snapPath)) : null;
  } catch (err) {
    return res.status(500).json({ error: `Pre-sync safety backup failed; sync aborted: ${err.message}` });
  }

  const stats = runLiveDeltaSync({ quiet: true, mergedPath: config.dbPath });
  audit.record({
    userId: req.user.id,
    entity: 'system_sync',
    action: 'live_delta_sync',
    after: { stats, preSyncBackup },
  });
  try {
    const emitter = require('../lib/emitter');
    emitter.emit('data_changed', { type: 'live_sync', stats });
  } catch (_) {}
  res.json({ ok: true, stats, preSyncBackup, syncedAt: new Date().toISOString() });
}));

router.get('/data-hygiene.xlsx', requireAuth, requireCap('master_dashboard.view'), asyncHandler(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  let unpricedIssues = [];
  try {
    unpricedIssues = all(`
      SELECT i.id, i.issue_date, i.min_no,
             COALESCE(a.code, '') AS asset_code,
             COALESCE(j.job_no, '') AS job_no,
             i.description, i.qty, i.unit, i.category, i.issued_by
        FROM issues i
        LEFT JOIN assets a ON a.id = i.asset_id
        LEFT JOIN job_cards j ON j.id = i.job_id
       WHERE (i.unit_price IS NULL OR i.unit_price <= 0)
         AND COALESCE(i.voided, 0) = 0
       ORDER BY i.issue_date DESC, i.id DESC
       LIMIT 5000
    `);
  } catch (_) {}

  let overdueMrns = [];
  try {
    overdueMrns = all(`
      SELECT m.id, m.mrn_no, m.req_date, m.status,
             CAST(julianday('now') - julianday(m.req_date) AS INTEGER) AS age_days,
             COALESCE(a.code, '') AS asset_code,
             m.purpose, m.requested_by,
             (SELECT COUNT(*) FROM mrn_lines ml WHERE ml.mrn_id = m.id) AS line_count,
             (SELECT ROUND(COALESCE(SUM(ml.qty), 0), 2) FROM mrn_lines ml WHERE ml.mrn_id = m.id AND COALESCE(ml.is_cancelled, 0) = 0) AS qty_req,
             (SELECT ROUND(COALESCE(SUM(ml.qty_received), 0), 2) FROM mrn_lines ml WHERE ml.mrn_id = m.id AND COALESCE(ml.is_cancelled, 0) = 0) AS qty_recd
        FROM mrn m
        LEFT JOIN assets a ON a.id = m.asset_id
       WHERE m.status IN ('open', 'pending', 'approved', 'ordered')
         AND m.req_date < date('now', '-30 days')
       ORDER BY m.req_date ASC, m.id ASC
    `);
  } catch (_) {}

  let unresolvedAliases = [];
  try {
    unresolvedAliases = all(`
      SELECT id, raw_text, COALESCE(source, 'general') AS source, hit_count, updated_at
        FROM asset_aliases
       WHERE resolved = 0
       ORDER BY hit_count DESC, updated_at DESC
    `);
  } catch (_) {}

  let missingDocs = [];
  try {
    missingDocs = all(`
      SELECT a.code AS asset_code,
             COALESCE(a.registration, '') AS registration,
             COALESCE(a.type, '') AS asset_type,
             COUNT(vd.id) AS missing_count,
             GROUP_CONCAT(vdt.name, ', ') AS missing_types
        FROM vehicle_documents vd
        JOIN assets a ON a.id = vd.asset_id
        JOIN vehicle_doc_types vdt ON vdt.id = vd.doc_type_id
       WHERE vd.is_required = 1
         AND vd.is_exempt = 0
         AND vd.current_version_id IS NULL
       GROUP BY a.id
       ORDER BY missing_count DESC, a.code ASC
    `);
  } catch (_) {}

  await sendXlsx(res, `data-hygiene-worklist-${today}.xlsx`, [
    {
      name: 'Unpriced Store Issues',
      columns: [
        { header: 'Issue ID', key: 'id', width: 12 },
        { header: 'Issue Date', key: 'issue_date', width: 14 },
        { header: 'MIN No', key: 'min_no', width: 16 },
        { header: 'Vehicle', key: 'asset_code', width: 16 },
        { header: 'Job No', key: 'job_no', width: 16 },
        { header: 'Description', key: 'description', width: 34 },
        { header: 'Qty', key: 'qty', width: 10 },
        { header: 'Unit', key: 'unit', width: 10 },
        { header: 'Category', key: 'category', width: 16 },
        { header: 'Issued By', key: 'issued_by', width: 18 },
      ],
      rows: unpricedIssues,
    },
    {
      name: 'Overdue Open MRNs',
      columns: [
        { header: 'MRN ID', key: 'id', width: 10 },
        { header: 'MRN No', key: 'mrn_no', width: 16 },
        { header: 'Request Date', key: 'req_date', width: 14 },
        { header: 'Age (Days)', key: 'age_days', width: 12 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Vehicle', key: 'asset_code', width: 16 },
        { header: 'Purpose', key: 'purpose', width: 30 },
        { header: 'Requested By', key: 'requested_by', width: 18 },
        { header: 'Lines', key: 'line_count', width: 10 },
        { header: 'Qty Req', key: 'qty_req', width: 12 },
        { header: 'Qty Recd', key: 'qty_recd', width: 12 },
      ],
      rows: overdueMrns,
    },
    {
      name: 'Unresolved Aliases',
      columns: [
        { header: 'Alias ID', key: 'id', width: 12 },
        { header: 'Raw Text', key: 'raw_text', width: 34 },
        { header: 'Section', key: 'source', width: 16 },
        { header: 'Hits', key: 'hit_count', width: 10 },
        { header: 'Last Seen', key: 'updated_at', width: 20 },
      ],
      rows: unresolvedAliases,
    },
    {
      name: 'Missing Vehicle Docs',
      columns: [
        { header: 'Vehicle Code', key: 'asset_code', width: 16 },
        { header: 'Registration', key: 'registration', width: 16 },
        { header: 'Type', key: 'asset_type', width: 18 },
        { header: 'Missing Count', key: 'missing_count', width: 14 },
        { header: 'Missing Statutory Documents', key: 'missing_types', width: 48 },
      ],
      rows: missingDocs,
    },
  ]);
}));

router.get('/backups', requireAuth, asyncHandler((req, res) => {
  if (!req.user || !req.user.roles || !req.user.roles.includes('admin')) {
    return res.status(403).json({ error: 'Only System Administrators can inspect system backups' });
  }
  res.json(backup.listBackups(config.backupDir));
}));

router.post('/backups/prune', requireAuth, asyncHandler((req, res) => {
  if (!req.user || !req.user.roles || !req.user.roles.includes('admin')) {
    return res.status(403).json({ error: 'Only System Administrators can prune system backups' });
  }
  const requested = req.body && req.body.keep !== undefined ? toInt(req.body.keep) : null;
  const keep = requested ? Math.max(3, requested) : Math.max(3, config.backupRetention || 10);
  const result = backup.prune(config.backupDir, keep);
  audit.record({
    userId: req.user.id,
    entity: 'system_backup',
    action: 'prune',
    after: result,
  });
  res.json({ ok: true, ...result, summary: backup.listBackups(config.backupDir) });
}));

module.exports = router;
