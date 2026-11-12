'use strict';

const express = require('express');
const { get, all } = require('../db');
const config = require('../config');
const { asyncHandler } = require('../lib/http');

const router = express.Router();

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Token or session gate
function portalAuth(req, res, next) {
  const token = req.headers['x-portal-token'];
  const expected = config.servicePlannerToken || process.env.FUEL_PORTAL_TOKEN || process.env.PORTAL_TOKEN;
  if (token && expected && token === expected) return next();
  if (req.user) return next(); // Already authenticated session in WorkshopOne
  // If no token configured in dev, allow internal
  if (!expected && (req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1')) return next();
  return res.status(401).json({ error: 'Unauthorized portal access' });
}

router.use(portalAuth);

// -----------------------------------------------------------------------------
// 1. /api/portal/service (FLEET SERVICE PLANNER STATUS)
// -----------------------------------------------------------------------------
router.get('/service', asyncHandler((req, res) => {
  const asOfParam = req.query.asOf;
  const asOf = asOfParam ? new Date(asOfParam) : new Date();
  const asOfIso = asOf.toISOString().slice(0, 10);
  const only = String(req.query.state || '').toUpperCase();
  const wanted = only ? new Set(only.split(',').map((s) => s.trim()).filter(Boolean)) : null;

  // Retrieve active fleet assets
  const assets = all(`
    SELECT a.id, a.code, a.registration, a.category, a.meter_type, a.current_hours,
           p.name project_name
      FROM assets a
      LEFT JOIN projects p ON p.id = COALESCE(a.current_project_id, a.home_project_id)
     WHERE a.status = 'ACTIVE' OR a.status IS NULL
     ORDER BY a.code
  `);

  const intervals = all('SELECT category, interval_hours, interval_km, warn_hours, warn_km FROM service_intervals');
  const intervalMap = new Map();
  for (const inv of intervals) {
    intervalMap.set(String(inv.category || '').toUpperCase(), inv);
  }

  const rows = [];
  const counts = { overdue: 0, dueSoon: 0, ok: 0, unknown: 0, tracked: 0 };

  for (const a of assets) {
    const basis = (a.meter_type || 'HOURS').toUpperCase() === 'KM' ? 'KM' : 'HOURS';
    const cat = String(a.category || '').toUpperCase();
    const inv = intervalMap.get(cat) || {
      interval_hours: 500,
      interval_km: 5000,
      warn_hours: 50,
      warn_km: 500
    };

    const intervalValue = basis === 'KM' ? inv.interval_km : inv.interval_hours;
    const warnValue = basis === 'KM' ? (inv.warn_km || 500) : (inv.warn_hours || 50);

    // Last service job
    const lastService = get(`
      SELECT sj.id, sj.service_date, sj.meter_reading
        FROM service_jobs sj
       WHERE sj.asset_id = ? AND date(sj.service_date) <= ?
       ORDER BY sj.service_date DESC, sj.id DESC LIMIT 1
    `, a.id, asOfIso);

    const anchorDate = lastService ? lastService.service_date : null;
    const meterAtService = lastService ? lastService.meter_reading : null;

    // Fuel issued since last service
    const fuelClause = anchorDate ? 'AND date(fi.issue_date) > ?' : '';
    const fuelParams = anchorDate ? [a.id, asOfIso, anchorDate] : [a.id, asOfIso];

    const fuelRow = get(`
      SELECT COALESCE(SUM(fi.litres), 0) litres, COUNT(*) issues,
             MAX(fi.meter_reading) max_meter
        FROM fuel_issues fi
       WHERE fi.asset_id = ?
         AND date(fi.issue_date) <= ?
         AND (fi.voided IS NULL OR fi.voided = 0)
         ${fuelClause}
    `, ...fuelParams);

    // Latest meter reading
    const currentMeter = Math.max(a.current_hours || 0, fuelRow.max_meter || 0);

    let recordedSince = 0;
    if (meterAtService && currentMeter > meterAtService) {
      recordedSince = currentMeter - meterAtService;
    } else if (!meterAtService && currentMeter > 0) {
      recordedSince = currentMeter % intervalValue;
    }

    // Fuel derived running estimate (15 L/hr approx for heavy plant, or 4 km/L for trucks)
    const fuelRate = basis === 'KM' ? 3.5 : 12.0;
    const fuelDerivedSince = basis === 'KM'
      ? Math.round(fuelRow.litres * fuelRate)
      : Math.round((fuelRow.litres / fuelRate) * 10) / 10;

    const usedSince = Math.max(recordedSince, fuelDerivedSince);
    const remaining = Math.max(0, Math.round((intervalValue - usedSince) * 10) / 10);

    let state = 'OK';
    if (usedSince >= intervalValue) {
      state = 'OVERDUE';
    } else if (usedSince >= (intervalValue - warnValue)) {
      state = 'DUE_SOON';
    } else if (usedSince === 0 && !meterAtService && (a.current_hours === 0 || !a.current_hours)) {
      state = 'UNKNOWN';
    }

    if (state === 'OVERDUE') counts.overdue++;
    else if (state === 'DUE_SOON') counts.dueSoon++;
    else if (state === 'OK') counts.ok++;
    else counts.unknown++;

    counts.tracked++;

    rows.push({
      code: a.code,
      state,
      site: a.project_name || 'Central Workshop',
      category: a.category || 'General',
      basis,
      interval: intervalValue,
      intervalSource: 'category',
      lastServiceDate: anchorDate,
      usedSince,
      recordedSince,
      fuelLitresSince: Math.round(fuelRow.litres * 10) / 10,
      fuelDerivedSince,
      usedSource: recordedSince >= fuelDerivedSince ? 'meter' : 'fuel',
      remaining
    });
  }

  const filteredMachines = wanted ? rows.filter((r) => wanted.has(r.state)) : rows;

  res.json({
    system: 'fuel-merged',
    generatedAt: new Date().toISOString(),
    asOf: asOfIso,
    counts,
    machines: filteredMachines
  });
}));

// -----------------------------------------------------------------------------
// 2. /api/portal/summary (EXECUTIVE FLEET STATUS)
// -----------------------------------------------------------------------------
router.get('/summary', asyncHandler((_req, res) => {
  const assetCount = get("SELECT COUNT(*) c FROM assets WHERE status = 'ACTIVE' OR status IS NULL").c;
  const tankStock = get("SELECT COALESCE(SUM(current_litres), 0) s, COALESCE(SUM(capacity_litres), 0) c FROM bulk_tanks WHERE status = 'active'");
  const openJobs = get("SELECT COUNT(*) c FROM job_cards WHERE status NOT IN ('completed', 'closed')").c;

  res.json({
    system: 'fuel-merged',
    active_fleet: assetCount,
    bulk_storage: { current_stock: tankStock.s, capacity: tankStock.c },
    open_jobs: openJobs,
    timestamp: new Date().toISOString()
  });
}));

module.exports = router;
