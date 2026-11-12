'use strict';

/**
 * Fuel Operations, Site Fuel Console, Adjustments, Vehicle 360° & Analytics API Routes
 *
 * Mounts at /api/fuel
 * Complete native Express implementation of Fuel-System-V2 for WorkshopOne (:1949)
 */

const express = require('express');
const router = express.Router();

const { get, all, run, tx } = require('../db');
const { requireAuth, requireCap } = require('../lib/auth');
const { asyncHandler } = require('../lib/http');
const fuelIssue = require('../lib/fuel/issue');
const fuelStock = require('../lib/fuel/stock');
const v2Engine = require('../lib/fuel/v2_engine');
const audit = require('../lib/audit');

// ---------------------------------------------------------------------------
// 1. Live Meter Guard & Vehicle Lookup
// ---------------------------------------------------------------------------

router.get('/meter-check', requireAuth, asyncHandler(async (req, res) => {
  const result = v2Engine.checkMeterReading(req.query);
  res.json(result);
}));

// ---------------------------------------------------------------------------
// 2. Fuel Issues Register & Dispensing
// ---------------------------------------------------------------------------

router.get('/issues', requireAuth, requireCap('fuel.view'), asyncHandler(async (req, res) => {
  const { limit, offset, assetCode, tankId, projectId, fromDate, toDate, showVoided, search, sourceType, fuelType } = req.query;
  const result = fuelIssue.listIssues({
    limit: limit ? Number(limit) : 50,
    offset: offset ? Number(offset) : 0,
    assetCode,
    tankId,
    projectId,
    fromDate,
    toDate,
    showVoided: showVoided === 'true' || showVoided === '1',
    search,
    sourceType,
    fuelType,
  });
  res.json(result);
}));

router.get('/issues/:id', requireAuth, requireCap('fuel.view'), asyncHandler(async (req, res) => {
  const issue = get(`
    SELECT fi.*, t.name AS tank_name, sp.name AS source_project_name,
           COALESCE(tp.name, p.name) AS target_project_name,
           COALESCE(u.full_name, u.username) AS issuer_name, COALESCE(vu.full_name, vu.username) AS voider_name
      FROM fuel_issues fi
      LEFT JOIN fuel_tanks t ON t.id = COALESCE(fi.source_tank_id, fi.bulk_tank_id)
      LEFT JOIN projects sp ON sp.id = fi.source_project_id
      LEFT JOIN projects tp ON tp.id = fi.target_project_id
      LEFT JOIN projects p ON p.id = COALESCE(fi.project_id, t.project_id)
      LEFT JOIN users u ON u.id = fi.issued_by
      LEFT JOIN users vu ON vu.id = fi.voided_by
     WHERE fi.id = ?
  `, req.params.id);

  if (!issue) return res.status(404).json({ error: 'Fuel issue not found' });

  const corrections = all(`
    SELECT c.*, COALESCE(req.full_name, req.username) AS requester_name, COALESCE(app.full_name, app.username) AS approver_name
      FROM fuel_corrections c
      LEFT JOIN users req ON req.id = c.requested_by
      LEFT JOIN users app ON app.id = c.approved_by
     WHERE c.fuel_issue_id = ?
     ORDER BY c.requested_at DESC
  `, req.params.id);

  res.json({ issue, corrections });
}));

router.post('/issues', requireAuth, requireCap('fuel.issue'), asyncHandler(async (req, res) => {
  const actorId = req.user ? req.user.id : 1;

  // Enforce Meter Guard unless explicitly overridden by user with reason
  if (req.body.meterReading && !req.body.ignoreMeterWarning) {
    const check = v2Engine.checkMeterReading({
      assetCode: req.body.assetCode || req.body.vehicleRef,
      meterReading: req.body.meterReading,
      issueDate: req.body.issueDate,
    });
    if (!check.ok) {
      return res.status(400).json({ error: check.warning, meterGuardFailed: true, previous: check.previous });
    }
  }

  const issue = fuelIssue.recordIssue(req.body, actorId);

  audit.log(req, 'fuel.issue.created', {
    issueId: issue.id,
    issueNo: issue.issue_no,
    assetCode: issue.asset_code,
    litres: issue.litres,
    totalCostCents: issue.total_cost_cents,
  });

  res.status(201).json(issue);
}));

router.post('/issues/:id/void', requireAuth, requireCap('fuel.void'), asyncHandler(async (req, res) => {
  const { reason } = req.body;
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'A valid documented reason is required to void this issue' });
  }

  const actorId = req.user ? req.user.id : 1;
  const result = fuelIssue.voidIssue(req.params.id, String(reason).trim(), actorId);

  audit.log(req, 'fuel.issue.voided', {
    issueId: req.params.id,
    reason: String(reason).trim(),
  });

  res.json(result);
}));

// ---------------------------------------------------------------------------
// 3. Fuel Issue Adjustments / Corrections Workflow
// ---------------------------------------------------------------------------

router.get('/corrections', requireAuth, requireCap('fuel.view'), asyncHandler(async (req, res) => {
  const { status, site, search } = req.query;
  const result = v2Engine.listCorrections({ status, site, search });
  res.json(result);
}));

router.post('/corrections', requireAuth, requireCap('fuel.issue', 'fuel.view'), asyncHandler(async (req, res) => {
  const actorId = req.user ? req.user.id : 1;
  const isAdmin = req.user && (req.user.roles || []).includes('admin');
  const created = v2Engine.createCorrection({
    ...req.body,
    autoApprove: isAdmin && !!req.body.autoApprove,
  }, actorId);

  audit.log(req, 'fuel.correction.requested', {
    correctionId: created.id,
    fuelIssueId: created.fuel_issue_id,
    type: created.correction_type,
  });

  res.status(201).json(created);
}));

router.post('/corrections/:id/review', requireAuth, requireCap('fuel.approve_correction', 'fuel.correct', 'fuel.void'), asyncHandler(async (req, res) => {
  const actorId = req.user ? req.user.id : 1;
  const updated = v2Engine.reviewCorrection(req.params.id, {
    action: req.body.action,
    reviewNote: req.body.reviewNote || req.body.review_note,
  }, actorId);

  audit.log(req, 'fuel.correction.reviewed', {
    correctionId: req.params.id,
    status: updated.status,
  });

  res.json(updated);
}));

// ---------------------------------------------------------------------------
// 4. Fuel Requests Queue
// ---------------------------------------------------------------------------

router.get('/requests', requireAuth, requireCap('fuel.view'), asyncHandler(async (req, res) => {
  const { status } = req.query;
  const where = status && status !== 'ALL' ? 'WHERE UPPER(fr.status) = UPPER(?)' : '';
  const params = status && status !== 'ALL' ? [status] : [];

  const rows = all(`
    SELECT fr.*, COALESCE(p.name, 'Central') AS project_name,
           COALESCE(u1.full_name, u1.username) AS requester_name,
           COALESCE(u2.full_name, u2.username) AS approver_name
      FROM fuel_requests fr
      LEFT JOIN projects p ON p.id = fr.project_id
      LEFT JOIN users u1 ON u1.id = fr.requested_by
      LEFT JOIN users u2 ON u2.id = fr.approved_by
     ${where}
     ORDER BY CASE WHEN fr.status = 'PENDING' THEN 0 ELSE 1 END, fr.requested_at DESC
     LIMIT 100
  `, ...params);

  res.json({ requests: rows });
}));

router.post('/requests', requireAuth, requireCap('fuel.request', 'fuel.issue', 'fuel.view'), asyncHandler(async (req, res) => {
  const { assetCode, projectId, fuelType = 'AUTO_DIESEL', requestedLitres, meterReading, reason } = req.body;
  if (!assetCode || !requestedLitres || Number(requestedLitres) <= 0) {
    return res.status(400).json({ error: 'Vehicle code and requested litres (> 0) are required' });
  }

  const asset = v2Engine.resolveVehicle(assetCode);
  const reqId = `freq-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const reqNo = `FR-${new Date().getFullYear()}-${Math.floor(10000 + Math.random() * 90000)}`;
  const actorId = req.user ? req.user.id : 1;

  run(`
    INSERT INTO fuel_requests (
      id, request_no, asset_id, asset_code, project_id, fuel_type,
      requested_litres, meter_reading, reason, status, requested_by, requested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, datetime('now'))
  `, reqId, reqNo, asset ? asset.id : null, asset ? (asset.code || asset.ec_code) : String(assetCode).toUpperCase(),
     projectId ? Number(projectId) : null, fuelType, Number(requestedLitres),
     meterReading ? Number(meterReading) : null, reason || null, actorId);

  res.status(201).json(get('SELECT * FROM fuel_requests WHERE id = ?', reqId));
}));

router.post('/requests/:id/review', requireAuth, requireCap('fuel.approve_request', 'fuel.approve', 'fuel.issue'), asyncHandler(async (req, res) => {
  const { action, rejectionReason, sourceTankId, dispenseNow } = req.body;
  const fr = get('SELECT * FROM fuel_requests WHERE id = ?', req.params.id);
  if (!fr) return res.status(404).json({ error: 'Fuel request not found' });

  const actorId = req.user ? req.user.id : 1;
  const isApprove = String(action || '').toUpperCase().startsWith('APPROV');

  if (!isApprove) {
    run(`
      UPDATE fuel_requests
         SET status = 'REJECTED', approved_by = ?, approved_at = datetime('now'), rejection_reason = ?
       WHERE id = ?
    `, actorId, rejectionReason || 'Rejected', fr.id);
    return res.json(get('SELECT * FROM fuel_requests WHERE id = ?', fr.id));
  }

  run(`
    UPDATE fuel_requests
       SET status = 'APPROVED', approved_by = ?, approved_at = datetime('now')
     WHERE id = ?
  `, actorId, fr.id);

  let issued = null;
  if (dispenseNow) {
    issued = fuelIssue.recordIssue({
      assetCode: fr.asset_code,
      litres: fr.requested_litres,
      fuelType: fr.fuel_type || 'AUTO_DIESEL',
      meterReading: fr.meter_reading,
      sourceTankId: sourceTankId || null,
      targetProjectId: fr.project_id || null,
    }, actorId);
  }

  res.json({ request: get('SELECT * FROM fuel_requests WHERE id = ?', fr.id), issued });
}));

// ---------------------------------------------------------------------------
// 5. Site Fuel Operators Console & Site Fuel Overview
// ---------------------------------------------------------------------------

router.get('/site-console', requireAuth, requireCap('fuel.view'), asyncHandler(async (req, res) => {
  const data = v2Engine.getSiteConsoleData(req.user, req.query);
  res.json(data);
}));

router.post('/site-console/issue', requireAuth, requireCap('fuel.issue'), asyncHandler(async (req, res) => {
  const actorId = req.user ? req.user.id : 1;
  const isAdmin = req.user && (req.user.roles || []).includes('admin');

  // 14-day backdate guard for non-admin Site Pump Operators (ported from Fuel-System-V2)
  if (req.body.issueDate && !isAdmin) {
    const entryMs = new Date(req.body.issueDate).getTime();
    const minMs = Date.now() - 15 * 86400000;
    if (!isNaN(entryMs) && entryMs < minMs) {
      return res.status(400).json({ error: 'Site Fuel Operators can only backdate issues up to 14 days. Contact an Administrator for older entries.' });
    }
  }

  const issue = fuelIssue.recordIssue(req.body, actorId);
  res.status(201).json(issue);
}));

router.post('/site-console/refuel', requireAuth, requireCap('fuel.tanks.refill', 'fuel.issue'), asyncHandler(async (req, res) => {
  const actorId = req.user ? req.user.id : 1;
  const result = fuelStock.recordBulkDelivery({
    ...req.body,
    receivedBy: actorId,
  });
  res.status(201).json(result);
}));

router.get('/sites-overview', requireAuth, requireCap('fuel.view'), asyncHandler(async (req, res) => {
  const data = v2Engine.getSitesOverview({ month: req.query.month });
  res.json(data);
}));

router.get('/sites-overview/:projectId', requireAuth, requireCap('fuel.view'), asyncHandler(async (req, res) => {
  const data = v2Engine.getSiteMonthlySheet(req.params.projectId, req.query.month);
  res.json(data);
}));

router.post('/budgets', requireAuth, requireCap('fuel.prices.manage', 'fuel.tanks.manage'), asyncHandler(async (req, res) => {
  const { projectId, year, month, budgetLitres, budgetAmountCents, note } = req.body;
  if (projectId == null || !year || !month) {
    return res.status(400).json({ error: 'projectId, year, and month are required' });
  }
  const actorId = req.user ? req.user.id : 1;
  const litres = budgetLitres != null ? Number(budgetLitres) : null;
  const cents = budgetAmountCents != null ? Number(budgetAmountCents) : (litres ? Math.round(litres * 34100) : null);

  run(`
    INSERT INTO site_fuel_budgets (project_id, year, month, budget_litres, budget_amount_cents, note, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project_id, year, month) DO UPDATE SET
      budget_litres = excluded.budget_litres,
      budget_amount_cents = excluded.budget_amount_cents,
      note = excluded.note,
      updated_at = datetime('now')
  `, Number(projectId), Number(year), Number(month), litres, cents, note || null, actorId);

  res.json({ ok: true, projectId, year, month, budgetLitres: litres });
}));

// ---------------------------------------------------------------------------
// 6. Vehicle-Wise 360° Fuel & Meter Profile + Fleet Directory
// ---------------------------------------------------------------------------

router.get('/fleet-directory', requireAuth, requireCap('fuel.view'), asyncHandler(async (req, res) => {
  const { search = '', category = '', site = '' } = req.query;
  const rows = all(`
    SELECT a.id, COALESCE(a.code, a.ec_code) AS code, a.registration, a.category, a.type, a.status,
           a.current_hours, COALESCE(p.name, 'Central') AS current_site,
           r.fuel_cons_econ, r.fuel_cons_typ, r.fuel_cons_heavy, r.fuel_cons_basis,
           r.dry_rate_cents, r.wet_rate_cents, r.default_basis,
           COALESCE(f.issue_count, 0) AS issue_count,
           COALESCE(f.total_litres, 0) AS total_litres,
           COALESCE(f.total_cost, 0) AS total_cost,
           f.last_issue_date,
           f.max_meter
      FROM assets a
      LEFT JOIN projects p ON p.id = a.current_project_id
      LEFT JOIN fleet_rental_rates r ON r.asset_id = a.id
      LEFT JOIN (
        SELECT asset_id,
               COUNT(*) AS issue_count,
               ROUND(SUM(litres), 1) AS total_litres,
               ROUND(SUM(COALESCE(total_cost_cents, cost_cents, total_price * 100, 0)) / 100.0, 2) AS total_cost,
               MAX(issue_date) AS last_issue_date,
               MAX(meter_reading) AS max_meter
          FROM fuel_issues
         WHERE is_voided = 0 AND asset_id IS NOT NULL
         GROUP BY asset_id
      ) f ON f.asset_id = a.id
     WHERE a.status != 'DISPOSED'
     ORDER BY COALESCE(f.total_litres, 0) DESC, a.code ASC
  `);

  let filtered = rows;
  if (search) {
    const q = v2Engine.squashCode(search);
    filtered = filtered.filter((r) =>
      v2Engine.squashCode(r.code).includes(q) ||
      v2Engine.squashCode(r.registration).includes(q) ||
      String(r.category || '').toUpperCase().includes(q)
    );
  }
  if (category) {
    filtered = filtered.filter((r) => String(r.category || '').toLowerCase() === String(category).toLowerCase());
  }
  if (site) {
    filtered = filtered.filter((r) => String(r.current_site || '').toLowerCase().includes(String(site).toLowerCase()));
  }

  const categories = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
  res.json({ vehicles: filtered.slice(0, 300), total: filtered.length, categories });
}));

router.get(['/vehicle-profile', '/vehicle-profile/:code'], requireAuth, requireCap('fuel.view'), asyncHandler(async (req, res) => {
  const code = req.params.code || req.query.code || req.query.asset_id;
  if (!code) return res.status(400).json({ error: 'Vehicle code or asset_id is required' });

  const profile = v2Engine.getVehicle360Profile(code);
  if (!profile) return res.status(404).json({ error: `Vehicle not found: ${code}` });

  res.json(profile);
}));

// ---------------------------------------------------------------------------
// 7. Interactive Fuel Consumption Graphs & Health Analytics
// ---------------------------------------------------------------------------

router.get('/analytics/consumption', requireAuth, requireCap('fuel.view'), asyncHandler(async (req, res) => {
  const { fromDate, toDate, projectId, month } = req.query;
  const data = v2Engine.getConsumptionAnalytics({ fromDate, toDate, projectId, month });
  res.json(data);
}));

// ---------------------------------------------------------------------------
// 8. Dual-Basis Service & Filter Planner
// ---------------------------------------------------------------------------

router.get('/service-planner', requireAuth, requireCap('fuel.view', 'services.view', 'service_plan.view'), asyncHandler(async (req, res) => {
  const { status, q, search, projectId } = req.query;
  const data = v2Engine.getFleetServicePlanner({
    statusFilter: status ? String(status).toUpperCase() : '',
    search: q || search || '',
    projectId,
  });
  res.json(data);
}));

router.post('/service-planner/quick-log', requireAuth, requireCap('services.create', 'service_plan.manage', 'fuel.issue'), asyncHandler(async (req, res) => {
  const { assetCode, serviceDate, meterAtService, serviceType, jobNo, costLkr, note } = req.body;
  if (!assetCode || !serviceDate) {
    return res.status(400).json({ error: 'Vehicle code and service date are required' });
  }
  const asset = v2Engine.resolveVehicle(assetCode);
  if (!asset) return res.status(404).json({ error: `Vehicle not found: ${assetCode}` });

  const meterType = v2Engine.inferMeterType(asset, null);
  const interval = meterType === 'KM' ? 5000 : 500;
  const meterVal = meterAtService ? Number(meterAtService) : (asset.current_hours || 0);
  const nextDue = meterVal > 0 ? meterVal + interval : null;
  const actorId = req.user ? req.user.id : 1;

  run(`
    INSERT INTO service_jobs (
      vehicle_label, asset_id, service_date, service_type, meter_reading, next_service_meter,
      job_no, grand_total, repair_details, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `, asset.code || asset.ec_code, asset.id, serviceDate, serviceType || (meterType === 'KM' ? '5000KM Service' : '500HR Service'),
     meterVal || null, nextDue, jobNo || null, costLkr ? Number(costLkr) : 0, note || null);

  if (meterVal > 0) {
    run(`
      UPDATE assets SET current_hours = CASE WHEN current_hours IS NULL OR current_hours < ? THEN ? ELSE current_hours END
       WHERE id = ?
    `, meterVal, meterVal, asset.id);
  }

  res.status(201).json({ ok: true, code: asset.code || asset.ec_code, nextDue });
}));

// ---------------------------------------------------------------------------
// 9. Ceypetco Fuel Prices
// ---------------------------------------------------------------------------

router.get('/prices', requireAuth, requireCap('fuel.prices.view', 'fuel.view'), asyncHandler(async (req, res) => {
  const rows = all(`
    SELECT fp.*, COALESCE(u.full_name, u.username) AS creator_name
      FROM fuel_prices fp
      LEFT JOIN users u ON u.id = fp.created_by
     ORDER BY fp.effective_date DESC, fp.fuel_type ASC
  `);
  res.json({ prices: rows });
}));

router.post('/prices', requireAuth, requireCap('fuel.prices.manage'), asyncHandler(async (req, res) => {
  const { fuelType, pricePerLitreCents, effectiveDate, notes } = req.body;
  if (!fuelType || !pricePerLitreCents || !effectiveDate) {
    return res.status(400).json({ error: 'fuelType, pricePerLitreCents, and effectiveDate are required' });
  }

  const cents = Math.round(Number(pricePerLitreCents));
  if (isNaN(cents) || cents <= 0) {
    return res.status(400).json({ error: 'Price per litre must be a positive number in cents' });
  }

  const actorId = req.user ? req.user.id : 1;
  const priceId = `fp-${fuelType}-${effectiveDate}`;
  run(`
    INSERT INTO fuel_prices (id, fuel_type, fuel_kind, price_per_litre_cents, price_per_litre, effective_date, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fuel_type, effective_date) DO UPDATE SET
      price_per_litre_cents = excluded.price_per_litre_cents,
      price_per_litre = excluded.price_per_litre,
      notes = excluded.notes,
      created_by = excluded.created_by
  `, priceId, fuelType, fuelType, cents, cents / 100, effectiveDate, notes || null, actorId);

  audit.log(req, 'fuel.price.updated', { fuelType, cents, effectiveDate });
  res.json({ success: true, fuelType, pricePerLitreCents: cents, effectiveDate });
}));

// ---------------------------------------------------------------------------
// 10. Operational Fuel Dashboard Statistics
// ---------------------------------------------------------------------------

router.get('/stats', requireAuth, requireCap('fuel.view'), asyncHandler(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  // Default to peak data month if current month has no issues yet
  const curMonthStart = today.slice(0, 7) + '-01';

  const todayStats = get(`
    SELECT COUNT(*) AS issues_count, COALESCE(SUM(litres), 0) AS total_litres, COALESCE(SUM(COALESCE(total_cost_cents, cost_cents, 0)), 0) AS total_cost_cents
      FROM fuel_issues
     WHERE is_voided = 0 AND issue_date >= ?
  `, today);

  let monthStats = get(`
    SELECT COUNT(*) AS issues_count, COALESCE(SUM(litres), 0) AS total_litres, COALESCE(SUM(COALESCE(total_cost_cents, cost_cents, 0)), 0) AS total_cost_cents
      FROM fuel_issues
     WHERE is_voided = 0 AND issue_date >= ?
  `, curMonthStart);

  if (!monthStats || !monthStats.issues_count) {
    monthStats = get(`
      SELECT COUNT(*) AS issues_count, COALESCE(SUM(litres), 0) AS total_litres, COALESCE(SUM(COALESCE(total_cost_cents, cost_cents, 0)), 0) AS total_cost_cents
        FROM fuel_issues
       WHERE is_voided = 0 AND substr(issue_date, 1, 7) = '2026-08'
    `);
  }

  const tankStats = get(`
    SELECT COUNT(*) AS total_tanks, COALESCE(SUM(current_litres), 0) AS total_stock_litres, COALESCE(SUM(capacity_litres), 0) AS total_capacity_litres
      FROM fuel_tanks
     WHERE active = 1
  `);

  const pendingCorrections = (get("SELECT COUNT(*) AS n FROM fuel_corrections WHERE status = 'PENDING'") || {}).n || 0;
  const pendingRequests = (get("SELECT COUNT(*) AS n FROM fuel_requests WHERE status = 'PENDING'") || {}).n || 0;

  res.json({
    today: todayStats || { issues_count: 0, total_litres: 0, total_cost_cents: 0 },
    month: monthStats || { issues_count: 0, total_litres: 0, total_cost_cents: 0 },
    tanks: tankStats || { total_tanks: 0, total_stock_litres: 0, total_capacity_litres: 0 },
    currentDieselCents: fuelIssue.getCurrentPrice('AUTO_DIESEL'),
    pendingCorrections,
    pendingRequests,
  });
}));

// ---------------------------------------------------------------------------
// 11. Fuel Consumption Reports & Efficiency Norms
// ---------------------------------------------------------------------------

router.get('/reports', requireAuth, requireCap('fuel.view'), asyncHandler(async (req, res) => {
  const month = req.query.month || '2026-08';
  const fromDate = month + '-01';
  const toDate = month + '-31 23:59:59';

  const vehicleStats = all(`
    SELECT fi.asset_id,
           COALESCE(a.code, fi.asset_code) AS asset_code,
           a.registration,
           a.category,
           COUNT(*) AS slip_count,
           ROUND(SUM(fi.litres), 2) AS total_litres,
           ROUND(SUM(COALESCE(fi.total_cost_cents, fi.cost_cents, fi.total_price * 100, 0)) / 100.0, 2) AS total_cost,
           MIN(CASE WHEN fi.meter_reading > 0 THEN fi.meter_reading ELSE NULL END) AS min_meter,
           MAX(CASE WHEN fi.meter_reading > 0 THEN fi.meter_reading ELSE NULL END) AS max_meter,
           r.fuel_cons_econ, r.fuel_cons_typ, r.fuel_cons_heavy, r.fuel_cons_basis,
           CASE
             WHEN MAX(fi.meter_reading) > MIN(CASE WHEN fi.meter_reading > 0 THEN fi.meter_reading ELSE NULL END)
             THEN ROUND((MAX(fi.meter_reading) - MIN(CASE WHEN fi.meter_reading > 0 THEN fi.meter_reading ELSE NULL END)), 1)
             ELSE 0
           END AS meter_units_run,
           CASE
             WHEN MAX(fi.meter_reading) > MIN(CASE WHEN fi.meter_reading > 0 THEN fi.meter_reading ELSE NULL END)
             THEN ROUND(SUM(fi.litres) / (MAX(fi.meter_reading) - MIN(CASE WHEN fi.meter_reading > 0 THEN fi.meter_reading ELSE NULL END)), 2)
             ELSE 0
           END AS litres_per_unit
      FROM fuel_issues fi
      LEFT JOIN assets a ON a.id = fi.asset_id
      LEFT JOIN fleet_rental_rates r ON r.asset_id = fi.asset_id
     WHERE fi.is_voided = 0 AND fi.issue_date BETWEEN ? AND ?
     GROUP BY fi.asset_id, COALESCE(a.code, fi.asset_code)
     ORDER BY total_litres DESC
  `, fromDate, toDate);

  const siteStats = all(`
    SELECT COALESCE(p.id, 0) AS project_id,
           COALESCE(p.name, 'Unallocated / Central Workshop') AS project_name,
           p.code AS project_code,
           COUNT(*) AS slip_count,
           COUNT(DISTINCT fi.asset_id) AS vehicle_count,
           ROUND(SUM(fi.litres), 2) AS total_litres,
           ROUND(SUM(COALESCE(fi.total_cost_cents, fi.cost_cents, fi.total_price * 100, 0)) / 100.0, 2) AS total_cost
      FROM fuel_issues fi
      LEFT JOIN fuel_tanks t ON t.id = COALESCE(fi.source_tank_id, fi.bulk_tank_id)
      LEFT JOIN projects p ON p.id = COALESCE(fi.target_project_id, fi.project_id, t.project_id)
     WHERE fi.is_voided = 0 AND fi.issue_date BETWEEN ? AND ?
     GROUP BY COALESCE(p.id, 0), COALESCE(p.name, 'Unallocated / Central Workshop')
     ORDER BY total_litres DESC
  `, fromDate, toDate);

  const totalLitres = vehicleStats.reduce((acc, r) => acc + (r.total_litres || 0), 0);
  const totalCost = vehicleStats.reduce((acc, r) => acc + (r.total_cost || 0), 0);

  res.json({
    month,
    totalLitres: Math.round(totalLitres * 100) / 100,
    totalCost: Math.round(totalCost * 100) / 100,
    vehicles: vehicleStats,
    sites: siteStats,
  });
}));

// ---------------------------------------------------------------------------
// 12. Fuel Anomaly & Integrity Alerts
// ---------------------------------------------------------------------------

router.get('/alerts', requireAuth, requireCap('fuel.view'), asyncHandler(async (req, res) => {
  const alerts = [];

  // Alert 1: Low Bulk Storage Tank Stock (< 15% capacity)
  const lowTanks = all(`
    SELECT id, code, name, capacity_litres, current_litres,
           ROUND((current_litres * 100.0) / NULLIF(capacity_litres, 0), 1) AS stock_pct
      FROM fuel_tanks
     WHERE active = 1 AND capacity_litres > 0 AND (current_litres * 1.0 / capacity_litres) < 0.15
  `);
  for (const t of lowTanks) {
    alerts.push({
      category: 'TANK',
      severity: t.stock_pct < 5 ? 'HIGH' : 'MEDIUM',
      title: `Low Fuel Level: ${t.name} (${t.code})`,
      message: `Tank is at ${t.stock_pct}% capacity (${t.current_litres} L of ${t.capacity_litres} L). Refill required.`,
      tank_id: t.id,
    });
  }

  // Alert 2: Tank Dip Discrepancies (> 50 L variance)
  const highVarDips = all(`
    SELECT td.*, t.code AS tank_code, t.name AS tank_name
      FROM fuel_tank_dips td
      JOIN fuel_tanks t ON t.id = td.tank_id
     WHERE ABS(td.variance_litres) > 50
     ORDER BY td.dip_date DESC LIMIT 10
  `);
  for (const d of highVarDips) {
    alerts.push({
      category: 'INTEGRITY',
      severity: 'HIGH',
      title: `Tank Dip Variance: ${d.tank_name}`,
      message: `Physical dip on ${d.dip_date} had a variance of ${d.variance_litres > 0 ? '+' : ''}${d.variance_litres} Litres.`,
      tank_id: d.tank_id,
    });
  }

  // Alert 3: Pending Fuel Issue Corrections
  const pendingCorr = all(`
    SELECT c.*, COALESCE(u.full_name, u.username) AS requester_name
      FROM fuel_corrections c
      LEFT JOIN users u ON u.id = c.requested_by
     WHERE c.status = 'PENDING'
     ORDER BY c.requested_at DESC LIMIT 10
  `);
  for (const c of pendingCorr) {
    alerts.push({
      category: 'CORRECTION',
      severity: 'MEDIUM',
      title: `Pending Fuel Correction: ${c.asset_code || c.fuel_issue_id}`,
      message: `${c.correction_type} (${c.before_litres}L → ${c.after_litres}L) requested by ${c.requester_name || 'Operator'}: "${c.reason}"`,
      correction_id: c.id,
    });
  }

  // Alert 4: Vehicles drawing fuel with no meter movement in 2026-08
  const noMeterVehicles = all(`
    SELECT asset_code, COUNT(*) AS fills, ROUND(SUM(litres), 1) AS total_litres
      FROM fuel_issues
     WHERE is_voided = 0 AND substr(issue_date, 1, 7) = '2026-08'
     GROUP BY asset_code
    HAVING COUNT(*) >= 3 AND (MAX(COALESCE(meter_reading, 0)) - MIN(COALESCE(meter_reading, 0))) = 0
     ORDER BY total_litres DESC LIMIT 12
  `);
  for (const nm of noMeterVehicles) {
    alerts.push({
      category: 'METER',
      severity: 'MEDIUM',
      title: `Fuel Without Meter Movement: ${nm.asset_code}`,
      message: `Drew ${nm.total_litres} L across ${nm.fills} issues in 2026-08 with 0 meter movement recorded.`,
      asset_code: nm.asset_code,
    });
  }

  res.json({ alerts, count: alerts.length });
}));

module.exports = router;
