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
const { requireAuth } = require('../lib/auth');
const { asyncHandler } = require('../lib/http');
const fuelStock = require('../lib/fuel/stock');
const fuelScope = require('../lib/fuel/scope');
const audit = require('../lib/audit');

router.get(
  '/',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_tanks', 'fuel'],
    level: 'view',
    caps: ['fuel.tanks.view', 'fuel.tanks.refill', 'fuel.tanks.manage', 'fuel.console.view'],
  }),
  asyncHandler(async (req, res) => {
    const scope = fuelScope.getFuelScope(req.user);
    const raw = fuelStock.getAllTanks();
    const filtered = scope.scoped
      ? raw.filter((t) => scope.allowedTankIds && scope.allowedTankIds.includes(String(t.id)))
      : raw;
    const tanks = filtered.map((t) => fuelScope.maskTankForUser(t, scope));
    res.json({ tanks });
  })
);

router.get(
  '/:id',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_tanks', 'fuel'],
    level: 'view',
    caps: ['fuel.tanks.view', 'fuel.tanks.refill', 'fuel.tanks.manage', 'fuel.console.view'],
  }),
  asyncHandler(async (req, res) => {
    const scope = fuelScope.assertTankInScope(req.user, req.params.id, 'view this fuel tank');
    const rawTank = fuelStock.getTank(req.params.id);
    if (!rawTank) return res.status(404).json({ error: 'Bulk tank not found' });

    const tank = fuelScope.maskTankForUser(rawTank, scope);

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
  })
);

router.post(
  '/',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel_tanks', level: 'edit', caps: ['fuel.tanks.manage'] }),
  asyncHandler(async (req, res) => {
    const { id, code, name, tankType, fuelType, capacityLitres, currentLitres, location, projectId, bowserAssetId, meterType, calibrationChartJson } = req.body;
    if (!code || !name) {
      return res.status(400).json({ error: 'Tank code and name are required' });
    }

    const tankId = id || `tank-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const cap = Number(capacityLitres) || 0;
    const curr = Number(currentLitres) || 0;
    const ft = String(fuelType || 'AUTO_DIESEL').trim().toUpperCase();

    run(`
      INSERT INTO fuel_tanks (
        id, code, name, tank_type, fuel_type, capacity_litres, current_litres, location,
        project_id, bowser_asset_id, meter_type, calibration_chart_json, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name,
        tank_type = excluded.tank_type,
        fuel_type = excluded.fuel_type,
        capacity_litres = excluded.capacity_litres,
        location = excluded.location,
        project_id = excluded.project_id,
        bowser_asset_id = excluded.bowser_asset_id,
        meter_type = excluded.meter_type,
        calibration_chart_json = excluded.calibration_chart_json,
        updated_at = datetime('now')
    `, tankId, String(code).trim().toUpperCase(), String(name).trim(),
       tankType || 'FIXED', ft, cap, curr, location || null,
       projectId || null, bowserAssetId || null, meterType || 'HOURS',
       calibrationChartJson || null);

    try {
      audit.record({
        userId: req.user ? req.user.id : null,
        entity: 'fuel_tank',
        entityId: null,
        action: 'fuel.tank.saved',
        after: { tankId, code, name },
      });
    } catch (_) {}
    res.status(201).json({ id: tankId, code, name });
  })
);

router.post(
  '/:id/dip',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel_tanks', level: 'add', caps: ['fuel.tanks.dip'] }),
  asyncHandler(async (req, res) => {
    fuelScope.assertTankInScope(req.user, req.params.id, 'record a dip on this tank');
    const { dipLitres, note } = req.body;
    const actorId = req.user ? req.user.id : 1;

    const result = fuelStock.recordDip({
      tankId: req.params.id,
      dipLitres,
      recordedBy: actorId,
      note,
    });

    try {
      audit.record({
        userId: actorId,
        entity: 'fuel_tank',
        entityId: null,
        action: 'fuel.tank.dip_recorded',
        after: {
          tankId: req.params.id,
          dipLitres: result.dip_litres,
          varianceLitres: result.variance_litres,
        },
      });
    } catch (_) {}

    res.json(result);
  })
);

router.post(
  '/:id/refill',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel_tanks', level: 'add', caps: ['fuel.tanks.refill'] }),
  asyncHandler(async (req, res) => {
    const scope = fuelScope.assertTankInScope(req.user, req.params.id, 'add fuel delivery to this tank');
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

    try {
      audit.record({
        userId: actorId,
        entity: 'fuel_tank',
        entityId: null,
        action: 'fuel.tank.refilled',
        after: {
          tankId: req.params.id,
          litres: result.litres,
          newBalance: result.new_balance,
        },
      });
    } catch (_) {}

    res.json(scope.hideStock ? { ...result, new_balance: null, hide_stock: true } : result);
  })
);

module.exports = router;
