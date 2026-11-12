'use strict';

/**
 * Fuel Tanks & Bowsers API Routes (Plan V2)
 *
 * Mounts at /api/fuel/tanks
 * Replaces Next.js /admin/tanks and tank dip tracking
 */

const express = require('express');
const router = express.Router();

const { get, all, run } = require('../db');
const { requireAuth, requireCap } = require('../lib/auth');
const { asyncHandler } = require('../lib/http');
const fuelStock = require('../lib/fuel/stock');
const audit = require('../lib/audit');

router.get('/', requireAuth, requireCap('fuel.tanks.view', 'fuel.view'), asyncHandler(async (req, res) => {
  const tanks = fuelStock.getAllTanks();
  res.json({ tanks });
}));

router.get('/:id', requireAuth, requireCap('fuel.tanks.view', 'fuel.view'), asyncHandler(async (req, res) => {
  const tank = fuelStock.getTank(req.params.id);
  if (!tank) return res.status(404).json({ error: 'Bulk tank not found' });

  const dips = all(`
    SELECT td.*, COALESCE(u.full_name, u.username) AS recorder_name
      FROM fuel_tank_dips td
      LEFT JOIN users u ON u.id = td.recorded_by
     WHERE td.tank_id = ?
     ORDER BY td.dip_date DESC LIMIT 30
  `, req.params.id);

  const deliveries = all(`
    SELECT fd.*, COALESCE(u.full_name, u.username) AS receiver_name
      FROM fuel_bulk_deliveries fd
      LEFT JOIN users u ON u.id = fd.received_by
     WHERE fd.tank_id = ?
     ORDER BY fd.delivery_date DESC LIMIT 30
  `, req.params.id);

  res.json({ tank, dips, deliveries });
}));

router.post('/', requireAuth, requireCap('fuel.tanks.manage'), asyncHandler(async (req, res) => {
  const { id, code, name, tankType, capacityLitres, currentLitres, location, projectId, bowserAssetId, meterType, calibrationChartJson } = req.body;
  if (!code || !name) {
    return res.status(400).json({ error: 'Tank code and name are required' });
  }

  const tankId = id || `tank-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const cap = Number(capacityLitres) || 0;
  const curr = Number(currentLitres) || 0;

  run(`
    INSERT INTO fuel_tanks (
      id, code, name, tank_type, capacity_litres, current_litres, location,
      project_id, bowser_asset_id, meter_type, calibration_chart_json, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name,
      tank_type = excluded.tank_type,
      capacity_litres = excluded.capacity_litres,
      location = excluded.location,
      project_id = excluded.project_id,
      bowser_asset_id = excluded.bowser_asset_id,
      meter_type = excluded.meter_type,
      calibration_chart_json = excluded.calibration_chart_json,
      updated_at = datetime('now')
  `, tankId, String(code).trim().toUpperCase(), String(name).trim(),
     tankType || 'FIXED', cap, curr, location || null,
     projectId || null, bowserAssetId || null, meterType || 'HOURS',
     calibrationChartJson || null);

  audit.log(req, 'fuel.tank.saved', { tankId, code, name });
  res.status(201).json({ id: tankId, code, name });
}));

router.post('/:id/dip', requireAuth, requireCap('fuel.tanks.dip'), asyncHandler(async (req, res) => {
  const { dipLitres, note } = req.body;
  const actorId = req.user ? req.user.id : 1;

  const result = fuelStock.recordDip({
    tankId: req.params.id,
    dipLitres,
    recordedBy: actorId,
    note,
  });

  audit.log(req, 'fuel.tank.dip_recorded', {
    tankId: req.params.id,
    dipLitres: result.dip_litres,
    varianceLitres: result.variance_litres,
  });

  res.json(result);
}));

router.post('/:id/refill', requireAuth, requireCap('fuel.tanks.refill'), asyncHandler(async (req, res) => {
  const { litres, fuelType, supplier, invoiceNumber, costCents, deliveryDate, note } = req.body;
  const actorId = req.user ? req.user.id : 1;

  const result = fuelStock.recordBulkDelivery({
    tankId: req.params.id,
    litres,
    fuelType,
    supplier,
    invoiceNumber,
    costCents,
    deliveryDate,
    receivedBy: actorId,
    note,
  });

  audit.log(req, 'fuel.tank.refilled', {
    tankId: req.params.id,
    litres: result.litres,
    newBalance: result.new_balance,
  });

  res.json(result);
}));

module.exports = router;
