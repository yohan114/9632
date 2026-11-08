'use strict';

/**
 * Fuel Operations API Routes (Plan V2)
 *
 * Mounts at /api/fuel
 * Native Express implementation replacing Next.js /fuel/issues and /fuel/requests
 */

const express = require('express');
const router = express.Router();

const { get, all, run } = require('../db');
const { requireAuth, requireCap } = require('../lib/auth');
const { asyncHandler } = require('../lib/http');
const fuelIssue = require('../lib/fuel/issue');
const fuelStock = require('../lib/fuel/stock');
const audit = require('../lib/audit');

// ---------------------------------------------------------------------------
// 1. Fuel Issues
// ---------------------------------------------------------------------------

router.get('/issues', requireAuth, requireCap('fuel.view'), asyncHandler(async (req, res) => {
  const { limit, offset, assetCode, tankId, projectId, fromDate, toDate, showVoided, search } = req.query;
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
  });
  res.json(result);
}));

router.get('/issues/:id', requireAuth, requireCap('fuel.view'), asyncHandler(async (req, res) => {
  const issue = get(`
    SELECT fi.*, t.name AS tank_name, sp.name AS source_project_name, tp.name AS target_project_name,
           COALESCE(u.full_name, u.username) AS issuer_name, COALESCE(vu.full_name, vu.username) AS voider_name
      FROM fuel_issues fi
      LEFT JOIN fuel_tanks t ON t.id = fi.source_tank_id
      LEFT JOIN projects sp ON sp.id = fi.source_project_id
      LEFT JOIN projects tp ON tp.id = fi.target_project_id
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
// 2. Ceypetco Fuel Prices
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
  run(`
    INSERT INTO fuel_prices (fuel_type, price_per_litre_cents, effective_date, notes, created_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(fuel_type, effective_date) DO UPDATE SET
      price_per_litre_cents = excluded.price_per_litre_cents,
      notes = excluded.notes,
      created_by = excluded.created_by
  `, fuelType, cents, effectiveDate, notes || null, actorId);

  audit.log(req, 'fuel.price.updated', { fuelType, cents, effectiveDate });
  res.json({ success: true, fuelType, pricePerLitreCents: cents, effectiveDate });
}));

// ---------------------------------------------------------------------------
// 3. Operational Fuel Dashboard Statistics
// ---------------------------------------------------------------------------

router.get('/stats', requireAuth, requireCap('fuel.view'), asyncHandler(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';

  const todayStats = get(`
    SELECT COUNT(*) AS issues_count, COALESCE(SUM(litres), 0) AS total_litres, COALESCE(SUM(total_cost_cents), 0) AS total_cost_cents
      FROM fuel_issues
     WHERE is_voided = 0 AND issue_date >= ?
  `, today);

  const monthStats = get(`
    SELECT COUNT(*) AS issues_count, COALESCE(SUM(litres), 0) AS total_litres, COALESCE(SUM(total_cost_cents), 0) AS total_cost_cents
      FROM fuel_issues
     WHERE is_voided = 0 AND issue_date >= ?
  `, monthStart);

  const tankStats = get(`
    SELECT COUNT(*) AS total_tanks, COALESCE(SUM(current_litres), 0) AS total_stock_litres, COALESCE(SUM(capacity_litres), 0) AS total_capacity_litres
      FROM fuel_tanks
     WHERE active = 1
  `);

  res.json({
    today: todayStats || { issues_count: 0, total_litres: 0, total_cost_cents: 0 },
    month: monthStats || { issues_count: 0, total_litres: 0, total_cost_cents: 0 },
    tanks: tankStats || { total_tanks: 0, total_stock_litres: 0, total_capacity_litres: 0 },
    currentDieselCents: fuelIssue.getCurrentPrice('AUTO_DIESEL'),
  });
}));

module.exports = router;
