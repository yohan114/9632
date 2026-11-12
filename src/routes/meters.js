'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireAuth } = require('../lib/auth');
const { requireModule } = require('../lib/permissions');
const { asyncHandler } = require('../lib/http');
const emitter = require('../lib/emitter');
const v2Engine = require('../lib/fuel/v2_engine');

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

// -----------------------------------------------------------------------------
// 1. METER READINGS (HOURS / KM TELEMETRY — MERGED LEDGER)
// -----------------------------------------------------------------------------
router.get('/', requireAuth, requireModule('fuel'), asyncHandler((req, res) => {
  const assetId = toInt(req.query.asset_id);
  const assetCode = clean(req.query.asset_code);
  const sourceFilter = clean(req.query.source).toUpperCase();
  const typeFilter = clean(req.query.meter_type).toUpperCase();
  const search = clean(req.query.search);
  const limit = Math.min(Math.max(toInt(req.query.limit) || 200, 10), 1000);

  let resolvedId = assetId;
  if (!resolvedId && assetCode) {
    const a = v2Engine.resolveVehicle(assetCode);
    if (a) resolvedId = a.id;
  }

  const conds = [];
  const params = [];

  if (resolvedId) {
    conds.push('u.asset_id = ?');
    params.push(resolvedId);
  }
  if (sourceFilter && sourceFilter !== 'ALL') {
    conds.push('UPPER(u.source) = ?');
    params.push(sourceFilter);
  }
  if (typeFilter && typeFilter !== 'ALL') {
    conds.push('UPPER(u.meter_type) = ?');
    params.push(typeFilter);
  }
  if (search) {
    conds.push('(UPPER(u.asset_code) LIKE UPPER(?) OR UPPER(u.asset_reg) LIKE UPPER(?) OR UPPER(u.notes) LIKE UPPER(?))');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const rows = all(`
    SELECT * FROM (
      SELECT CAST(mr.id AS TEXT) AS id,
             mr.asset_id,
             COALESCE(a.code, a.ec_code) AS asset_code,
             a.registration AS asset_reg,
             a.category AS asset_category,
             mr.reading AS reading,
             COALESCE(mr.meter_type, 'HOURS') AS meter_type,
             mr.reading_date,
             COALESCE(usr.full_name, usr.username, 'Operator') AS recorded_by_name,
             UPPER(COALESCE(mr.source, 'MANUAL')) AS source,
             mr.notes
        FROM meter_readings mr
        JOIN assets a ON a.id = mr.asset_id
        LEFT JOIN users usr ON usr.id = mr.recorded_by
      UNION ALL
      SELECT fmr.id AS id,
             fmr.asset_id,
             COALESCE(a.code, a.ec_code, fmr.asset_code) AS asset_code,
             a.registration AS asset_reg,
             a.category AS asset_category,
             fmr.meter_reading AS reading,
             COALESCE(fmr.meter_type, 'HOURS') AS meter_type,
             fmr.reading_date,
             COALESCE(usr.full_name, usr.username, 'Pump Operator') AS recorded_by_name,
             UPPER(COALESCE(fmr.source, 'FUEL_ISSUE')) AS source,
             'Fuel System Reading' AS notes
        FROM fuel_meter_readings fmr
        LEFT JOIN assets a ON a.id = fmr.asset_id
        LEFT JOIN users usr ON usr.id = fmr.recorded_by
       WHERE NOT EXISTS (
         SELECT 1 FROM meter_readings mr2
          WHERE mr2.asset_id = fmr.asset_id
            AND ABS(mr2.reading - fmr.meter_reading) < 0.1
            AND substr(mr2.reading_date, 1, 10) = substr(fmr.reading_date, 1, 10)
       )
    ) u
    ${where}
    ORDER BY u.reading_date DESC, u.reading DESC
    LIMIT ?
  `, ...params, limit);

  res.json(rows);
}));

router.post('/', requireAuth, requireModule('fuel', 'add'), asyncHandler((req, res) => {
  const rawAsset = req.body.asset_code || req.body.assetCode || req.body.asset_id;
  const reading = toFloat(req.body.reading || req.body.value);
  const readingDate = clean(req.body.reading_date) || new Date().toISOString().slice(0, 10);
  const source = clean(req.body.source) || 'MANUAL';
  let notes = clean(req.body.notes);

  const asset = v2Engine.resolveVehicle(rawAsset);
  if (!asset || reading <= 0) {
    return res.status(400).json({ error: 'Valid vehicle code/ID and reading > 0 are required' });
  }

  const meterType = clean(req.body.meter_type) || v2Engine.inferMeterType(asset, null);

  // Run Meter Guard check
  const check = v2Engine.checkMeterReading({
    assetId: asset.id,
    meterReading: reading,
    issueDate: readingDate,
  });

  if (!check.ok && !req.body.forceOverride) {
    return res.status(400).json({
      error: check.warning,
      meterGuardFailed: true,
      previous: check.previous,
    });
  }

  if (check.warning) {
    notes = (notes ? notes + ' | ' : '') + `[WARN: ${check.warning}]`;
  }

  const actorId = req.user ? req.user.id : 1;

  tx(() => {
    run(`
      INSERT INTO meter_readings (asset_id, reading, meter_type, reading_date, recorded_by, source, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, asset.id, reading, meterType, readingDate, actorId, source.toUpperCase(), notes);

    run(`
      INSERT INTO fuel_meter_readings (id, asset_id, asset_code, meter_reading, meter_type, reading_date, source, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, `mr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, asset.id, asset.code || asset.ec_code, reading, meterType, readingDate, source.toUpperCase(), actorId);

    run(`
      UPDATE assets
         SET current_hours = CASE
               WHEN current_hours IS NULL OR current_hours < ? THEN ?
               ELSE current_hours
             END
       WHERE id = ?
    `, reading, reading, asset.id);
  });

  emitter.emit('data_changed', { type: 'meter_reading', asset_id: asset.id, reading });
  res.json({
    ok: true,
    asset_id: asset.id,
    asset_code: asset.code || asset.ec_code,
    reading,
    meter_type: meterType,
    reading_date: readingDate,
    delta: check.delta,
  });
}));

// -----------------------------------------------------------------------------
// 2. DAILY CONDITIONS (WORKING / BREAKDOWN / IDLE / MAINTENANCE)
// -----------------------------------------------------------------------------
router.get('/conditions', requireAuth, requireModule('fuel'), asyncHandler((req, res) => {
  const date = clean(req.query.date);
  const condSql = date ? 'WHERE substr(c.condition_date, 1, 10) = ?' : '';
  const params = date ? [date] : [];

  const rows = all(`
    SELECT * FROM (
      SELECT CAST(dc.id AS TEXT) AS id,
             dc.asset_id,
             COALESCE(a.code, a.ec_code) AS asset_code,
             a.registration AS asset_reg,
             a.category AS asset_category,
             substr(dc.condition_date, 1, 10) AS condition_date,
             dc.state AS state,
             dc.hours_worked,
             p.name AS project_name,
             COALESCE(u.full_name, u.username) AS recorded_by_name,
             dc.notes
        FROM daily_conditions dc
        JOIN assets a ON a.id = dc.asset_id
        LEFT JOIN projects p ON p.id = dc.project_id
        LEFT JOIN users u ON u.id = dc.recorded_by
      UNION ALL
      SELECT fdc.id AS id,
             fdc.asset_id,
             COALESCE(a.code, a.ec_code, fdc.asset_code) AS asset_code,
             a.registration AS asset_reg,
             a.category AS asset_category,
             substr(fdc.condition_date, 1, 10) AS condition_date,
             fdc.working_status AS state,
             0 AS hours_worked,
             fdc.location AS project_name,
             COALESCE(u.full_name, u.username, 'Site Operator') AS recorded_by_name,
             fdc.breakdown_reason AS notes
        FROM fuel_daily_conditions fdc
        LEFT JOIN assets a ON a.id = fdc.asset_id
        LEFT JOIN users u ON u.id = fdc.recorded_by
    ) c
    ${condSql}
    ORDER BY c.condition_date DESC, c.asset_code ASC
    LIMIT 200
  `, ...params);

  res.json({ date: date || 'ALL', rows });
}));

router.post('/conditions', requireAuth, requireModule('fuel', 'add'), asyncHandler((req, res) => {
  const rawAsset = req.body.asset_code || req.body.assetCode || req.body.asset_id;
  const asset = v2Engine.resolveVehicle(rawAsset);
  if (!asset) return res.status(400).json({ error: 'Valid vehicle code or asset_id is required' });

  const conditionDate = clean(req.body.condition_date) || new Date().toISOString().slice(0, 10);
  const state = clean(req.body.state || req.body.working_status || 'WORKING').toUpperCase();
  const hoursWorked = toFloat(req.body.hours_worked) || 0;
  const projectId = toInt(req.body.project_id);
  const notes = clean(req.body.notes || req.body.breakdown_reason);
  const actorId = req.user ? req.user.id : 1;

  tx(() => {
    run(`
      INSERT INTO daily_conditions (asset_id, condition_date, project_id, state, hours_worked, recorded_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset_id, condition_date) DO UPDATE SET
        state = excluded.state,
        hours_worked = excluded.hours_worked,
        project_id = excluded.project_id,
        notes = excluded.notes,
        recorded_by = excluded.recorded_by
    `, asset.id, conditionDate, projectId, state, hoursWorked, actorId, notes);

    run(`
      INSERT OR REPLACE INTO fuel_daily_conditions (id, asset_id, asset_code, condition_date, working_status, breakdown_reason, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, `fdc-${asset.id}-${conditionDate}`, asset.id, asset.code || asset.ec_code, conditionDate, state, notes || null, actorId);
  });

  emitter.emit('data_changed', { type: 'daily_condition', asset_id: asset.id, date: conditionDate });
  res.json({ ok: true, asset_id: asset.id, asset_code: asset.code || asset.ec_code, condition_date: conditionDate, state });
}));

module.exports = router;
