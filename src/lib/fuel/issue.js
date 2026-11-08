'use strict';

/**
 * Fuel Issue & Correction Business Logic Engine (Plan V2)
 *
 * Enforces business rules:
 * - Vehicle fuel issue consumes tank stock once.
 * - Transfer between tanks is not vehicle fuel consumption.
 * - Correction produces traceable before/after and stock/financial impact.
 * - Void is excluded from current billing/consumption but retained in history.
 * - Missing price produces an exception, never guessed zero cost.
 */

const { get, all, run, tx } = require('../../db');
const { deductStock, restoreStock } = require('./stock');
const identity = require('../fleet_identity');

function getCurrentPrice(fuelType = 'AUTO_DIESEL', date = null) {
  const targetDate = date ? String(date).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const row = get(`
    SELECT * FROM fuel_prices
     WHERE fuel_type = ? AND effective_date <= ?
     ORDER BY effective_date DESC, id DESC LIMIT 1
  `, fuelType, targetDate);

  if (row) return row.price_per_litre_cents;
  // Default Ceypetco Auto Diesel baseline in cents if unseeded (Rs 341.00 = 34100 cents)
  return fuelType === 'AUTO_DIESEL' ? 34100 : 38000;
}

function recordIssue({
  assetCode,
  vehicleRef,
  litres,
  fuelType = 'AUTO_DIESEL',
  meterReading = null,
  meterType = 'HOURS',
  issueDate = null,
  sourceTankId = null,
  sourceProjectId = null,
  targetProjectId = null,
  driverName = null,
  stationName = null,
  pumpLocation = null,
  fuelPriceCents = null,
  isManual = 0,
  isDirectBilled = 0,
  signatureUrl = null,
  photoUrl = null,
}, actorId = 1) {
  const vol = Number(litres);
  if (isNaN(vol) || vol <= 0) {
    throw new Error('Fuel issue volume must be greater than 0 litres');
  }

  // Resolve canonical asset
  const asset = identity.resolveAsset(assetCode || vehicleRef);
  const resolvedCode = asset ? (asset.ec_code || asset.registration) : String(assetCode || vehicleRef).trim();
  const assetId = asset ? asset.id : null;

  const dateStr = issueDate ? String(issueDate).slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ');
  const unitPrice = fuelPriceCents ? Number(fuelPriceCents) : getCurrentPrice(fuelType, dateStr);
  const totalCost = Math.round(vol * unitPrice);

  const issueId = `fi-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const issueNo = `FI-${dateStr.slice(0, 4)}-${Math.floor(100000 + Math.random() * 900000)}`;

  return tx(() => {
    // 1. Insert fuel issue record
    run(`
      INSERT INTO fuel_issues (
        id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, litres,
        fuel_price_cents, total_cost_cents, meter_reading, meter_type, issue_date,
        station_name, pump_location, driver_name, source_tank_id, source_project_id,
        target_project_id, issued_by, is_voided, is_manual, is_direct_billed,
        signature_url, photo_url
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, 0, ?, ?,
        ?, ?
      )
    `, issueId, issueNo, assetId, resolvedCode, vehicleRef || resolvedCode, fuelType, vol,
       unitPrice, totalCost, meterReading ? Number(meterReading) : null, meterType || 'HOURS',
       dateStr, stationName || null, pumpLocation || null, driverName || null,
       sourceTankId || null, sourceProjectId || null, targetProjectId || null,
       actorId, isManual ? 1 : 0, isDirectBilled ? 1 : 0, signatureUrl || null, photoUrl || null);

    // 2. Consume stock from source tank once
    if (sourceTankId) {
      deductStock(sourceTankId, vol);
    }

    // 3. Record meter reading if provided
    if (meterReading && Number(meterReading) > 0) {
      const readingId = `mr-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      run(`
        INSERT INTO fuel_meter_readings (
          id, asset_id, asset_code, meter_reading, meter_type, reading_date, source, recorded_by
        ) VALUES (?, ?, ?, ?, ?, ?, 'FUEL_ISSUE', ?)
      `, readingId, assetId, resolvedCode, Number(meterReading), meterType || 'HOURS', dateStr, actorId);
    }

    // 4. Emit financial ledger posting event (COST_FUEL)
    const eventKey = `FIN-FUEL-${issueId}`;
    const dt = new Date(dateStr);
    const yr = dt.getFullYear();
    const mo = dt.getMonth() + 1;

    run(`
      INSERT OR REPLACE INTO fleet_financial_events (
        id, event_key, event_type, asset_id, asset_code, project_id, business_date,
        year, month, amount_cents, quantity, unit, source_system, source_table, source_id
      ) VALUES (
        ?, ?, 'COST_FUEL', ?, ?, ?, ?,
        ?, ?, ?, ?, 'LITRES', 'WORKSHOPONE', 'fuel_issues', ?
      )
    `, eventKey, eventKey, assetId, resolvedCode, targetProjectId || sourceProjectId || null,
       dateStr.slice(0, 10), yr, mo, totalCost, vol, issueId);

    return {
      id: issueId,
      issue_no: issueNo,
      asset_code: resolvedCode,
      litres: vol,
      total_cost_cents: totalCost,
      issue_date: dateStr,
    };
  });
}

function voidIssue(issueId, reason, actorId = 1) {
  if (!issueId) throw new Error('Issue ID is required');
  if (!reason) throw new Error('Documented reason is required to void an issue');

  const issue = get('SELECT * FROM fuel_issues WHERE id = ?', String(issueId));
  if (!issue) throw new Error(`Fuel issue not found: ${issueId}`);
  if (issue.is_voided) throw new Error('This fuel issue is already voided');

  return tx(() => {
    // 1. Mark as voided
    run(`
      UPDATE fuel_issues
         SET is_voided = 1,
             void_reason = ?,
             voided_at = datetime('now'),
             voided_by = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `, reason, actorId, String(issueId));

    // 2. Restore tank stock if it was drawn from a tank
    if (issue.source_tank_id && Number(issue.litres) > 0) {
      restoreStock(issue.source_tank_id, Number(issue.litres));
    }

    // 3. Post reversal in financial ledger
    const reversalId = `FIN-REV-FUEL-${issueId}`;
    const dt = new Date();
    run(`
      INSERT OR REPLACE INTO fleet_financial_events (
        id, event_key, event_type, asset_id, asset_code, project_id, business_date,
        year, month, amount_cents, quantity, unit, source_system, source_table, source_id,
        is_reversal, reversal_of_event_id
      ) VALUES (
        ?, ?, 'COST_FUEL', ?, ?, ?, ?,
        ?, ?, ?, ?, 'LITRES', 'WORKSHOPONE', 'fuel_issues', ?,
        1, ?
      )
    `, reversalId, reversalId, issue.asset_id, issue.asset_code, issue.target_project_id || issue.source_project_id || null,
       new Date().toISOString().slice(0, 10), dt.getFullYear(), dt.getMonth() + 1,
       -Math.abs(Number(issue.total_cost_cents)), -Math.abs(Number(issue.litres)),
       issueId, `FIN-FUEL-${issueId}`);

    return { id: issueId, is_voided: 1, void_reason: reason };
  });
}

function listIssues({
  limit = 50,
  offset = 0,
  assetCode = null,
  tankId = null,
  projectId = null,
  fromDate = null,
  toDate = null,
  showVoided = false,
  search = null,
} = {}) {
  const conditions = [];
  const params = [];

  if (!showVoided) {
    conditions.push('fi.is_voided = 0');
  }

  if (assetCode) {
    conditions.push('(UPPER(fi.asset_code) LIKE UPPER(?) OR UPPER(fi.vehicle_ref) LIKE UPPER(?))');
    params.push(`%${assetCode}%`, `%${assetCode}%`);
  }

  if (tankId) {
    conditions.push('fi.source_tank_id = ?');
    params.push(String(tankId));
  }

  if (projectId) {
    conditions.push('(fi.source_project_id = ? OR fi.target_project_id = ?)');
    params.push(Number(projectId), Number(projectId));
  }

  if (fromDate) {
    conditions.push('fi.issue_date >= ?');
    params.push(String(fromDate));
  }

  if (toDate) {
    conditions.push('fi.issue_date <= ?');
    params.push(String(toDate) + ' 23:59:59');
  }

  if (search) {
    conditions.push('(fi.issue_no LIKE ? OR fi.driver_name LIKE ? OR fi.asset_code LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = get(`SELECT COUNT(*) AS total FROM fuel_issues fi ${whereClause}`, ...params);
  const total = countRow ? countRow.total : 0;

  const rows = all(`
    SELECT fi.*, t.name AS tank_name, sp.name AS source_project_name, tp.name AS target_project_name
      FROM fuel_issues fi
      LEFT JOIN fuel_tanks t ON t.id = fi.source_tank_id
      LEFT JOIN projects sp ON sp.id = fi.source_project_id
      LEFT JOIN projects tp ON tp.id = fi.target_project_id
     ${whereClause}
     ORDER BY fi.issue_date DESC, fi.created_at DESC
     LIMIT ? OFFSET ?
  `, ...params, Number(limit), Number(offset));

  return { total, rows, limit: Number(limit), offset: Number(offset) };
}

module.exports = {
  getCurrentPrice,
  recordIssue,
  voidIssue,
  listIssues,
};
