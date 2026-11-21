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

const DEFAULT_PRICES_CENTS = {
  AUTO_DIESEL: 38200,
  SUPER_DIESEL: 47800,
  PETROL_92: 39900,
  PETROL_95: 47500,
  KEROSENE: 28500,
};

function todayLocalStr() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function normalizeFuelType(raw) {
  return String(raw || 'AUTO_DIESEL').trim().toUpperCase();
}

function resolvePriceDetail(fuelType = 'AUTO_DIESEL', date = null) {
  const ft = normalizeFuelType(fuelType);
  const targetDate = date ? String(date).trim().slice(0, 10) : todayLocalStr();
  let row = get(`
    SELECT * FROM fuel_prices
     WHERE UPPER(COALESCE(fuel_type, fuel_kind)) = ? AND effective_date <= ?
     ORDER BY effective_date DESC, id DESC LIMIT 1
  `, ft, targetDate);

  if (!row) {
    row = get(`
      SELECT * FROM fuel_prices
       WHERE UPPER(COALESCE(fuel_type, fuel_kind)) = ?
       ORDER BY effective_date ASC, id ASC LIMIT 1
    `, ft);
  }

  if (row) {
    return {
      fuelType: ft,
      pricePerLitreCents: Number(row.price_per_litre_cents) || Math.round(Number(row.price_per_litre || 0) * 100),
      effectiveDate: row.effective_date,
      source: row.source || row.notes || 'Fuel Tariff Table',
      isFallback: false,
    };
  }

  return {
    fuelType: ft,
    pricePerLitreCents: DEFAULT_PRICES_CENTS[ft] || 38200,
    effectiveDate: null,
    source: 'Default Tariff Baseline',
    isFallback: true,
  };
}

function getCurrentPrice(fuelType = 'AUTO_DIESEL', date = null) {
  return resolvePriceDetail(fuelType, date).pricePerLitreCents;
}

function getActivePriceMap(date = null) {
  const out = {};
  for (const ft of Object.keys(DEFAULT_PRICES_CENTS)) {
    out[ft] = resolvePriceDetail(ft, date);
  }
  return out;
}

function recordIssue({
  assetCode,
  vehicleRef,
  litres,
  fuelType = null,
  meterReading = null,
  meterType = null,
  issueDate = null,
  sourceTankId = null,
  sourceProjectId = null,
  targetProjectId = null,
  driverName = null,
  stationName = null,
  pumpLocation = null,
  fuelPriceCents = null,
  pricePerLitre = null,
  isManual = 0,
  isDirectBilled = 0,
  signatureUrl = null,
  photoUrl = null,
  fuelRequestId = null,
  requestId = null,
  allowUnlinkedSiteTransfer = false,
  allowSiteTransfer = true,
  runningChartNo = null,
  tripPurpose = null,
  notes = null,
}, actorId = 1) {
  const errStatus = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
  const vol = Number(litres);
  if (isNaN(vol) || vol <= 0) {
    throw errStatus(400, 'Fuel issue volume must be greater than 0 litres');
  }

  // Resolve canonical asset
  const asset = identity.resolveAsset(assetCode || vehicleRef);
  const resolvedCode = asset ? (asset.ec_code || asset.code || asset.registration) : String(assetCode || vehicleRef || '').trim();
  const assetId = asset ? asset.id : null;
  const isSiteTransfer = allowUnlinkedSiteTransfer || (allowSiteTransfer && resolvedCode.toUpperCase().startsWith('SITE-'));
  const effectiveReqId = fuelRequestId || requestId || null;

  const dateStr = issueDate ? String(issueDate).slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ');
  const issueId = `fi-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const issueNo = `FI-${dateStr.slice(0, 4)}-${Math.floor(100000 + Math.random() * 900000)}`;

  return tx(() => {
    // 0. Enforce "No Request, No Issue" gate & compute cross-check against request + recommended norms
    const transportRequests = require('./transport_requests');
    const gate = transportRequests.validateRequestForIssue({
      fuelRequestId: effectiveReqId,
      resolvedAssetId: assetId,
      resolvedCode,
      sourceTankId,
      isSiteTransfer,
      issueLitres: vol,
      meterReading,
    });

    const fr = gate.request;
    const effTankId = gate.effectiveTankId;
    const effFuelType = normalizeFuelType(fuelType || (fr && fr.fuel_type) || 'AUTO_DIESEL');
    const effDriverName = driverName || (fr && fr.driver_name) || null;
    const effStationName = stationName || (fr && fr.station_name) || null;
    const effChartNo = runningChartNo || (fr && fr.running_chart_no) || null;
    const effTripPurpose = tripPurpose || (fr && fr.trip_purpose) || null;
    const effMeter = meterReading != null && meterReading !== ''
      ? Number(meterReading)
      : (fr && fr.meter_reading != null ? Number(fr.meter_reading) : null);
    const effMeterType = meterType || (fr && fr.meter_type) || 'HOURS';
    const effNotes = notes || (fr && fr.notes) || null;
    const cc = gate.crossCheck;

    let unitPrice;
    if (fuelPriceCents != null && fuelPriceCents !== '') {
      unitPrice = Math.round(Number(fuelPriceCents));
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        throw errStatus(400, 'Fuel rate (cents per litre) must be greater than 0');
      }
    } else if (pricePerLitre != null && pricePerLitre !== '') {
      unitPrice = Math.round(Number(pricePerLitre) * 100);
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        throw errStatus(400, 'Fuel rate (LKR per litre) must be greater than 0');
      }
    } else {
      unitPrice = getCurrentPrice(effFuelType, dateStr);
    }
    const totalCost = Math.round(vol * unitPrice);

    // 1. Insert fuel issue record (populate both WorkshopOne and Fuel-System-V2 alias columns)
    const projId = targetProjectId || gate.effectiveProjectId || sourceProjectId || null;
    run(`
      INSERT INTO fuel_issues (
        id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, fuel_kind, litres,
        fuel_price_cents, price_per_litre_cents, unit_price, total_cost_cents, cost_cents, total_price,
        meter_reading, meter_type, issue_date,
        station_name, pump_location, driver_name, recipient_name, source_tank_id, bulk_tank_id,
        source_project_id, target_project_id, project_id, issued_by, is_voided, voided,
        is_manual, is_direct_billed, source, signature_url, photo_url,
        fuel_request_id, running_chart_no, trip_purpose,
        approx_km_snapshot, recommended_litres_snapshot, trip_fuel_snapshot,
        is_full_tank, variance_litres, variance_pct, trip_variance_litres, cross_check_status, notes
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, 0, 0,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
    `, issueId, issueNo, assetId, resolvedCode, vehicleRef || resolvedCode, effFuelType, effFuelType, vol,
       unitPrice, unitPrice, unitPrice / 100, totalCost, totalCost, totalCost / 100,
       effMeter && effMeter > 0 ? effMeter : null, effMeterType, dateStr,
       effStationName, pumpLocation || null, effDriverName, effDriverName,
       effTankId || null, effTankId || null,
       sourceProjectId || projId, targetProjectId || projId, projId,
       actorId, isManual ? 1 : 0, isDirectBilled ? 1 : 0,
       effTankId ? 'BOWSER' : (isDirectBilled ? 'DIRECT_BILLED' : (isManual ? 'MANUAL' : 'STATION')),
       signatureUrl || null, photoUrl || null,
       fr ? fr.id : null, effChartNo, effTripPurpose,
       fr ? fr.approx_km : null, fr ? fr.recommended_litres : null, fr ? fr.trip_total_fuel : null,
       fr && fr.is_full_tank ? 1 : 0,
       cc ? cc.varianceLitres : null, cc ? cc.variancePct : null,
       cc ? cc.tripVarianceLitres : null, cc ? cc.crossCheckStatus : null,
       effNotes);

    // 1b. Mark linked Transport Fuel Request FULFILLED (1 request = 1 issue)
    if (fr) {
      run(`
        UPDATE fuel_requests
           SET status = 'FULFILLED',
               actual_issued_litres = ?,
               fuel_issue_id = ?,
               fulfilled_by = ?,
               fulfilled_at = datetime('now')
         WHERE id = ?
      `, vol, issueId, actorId, fr.id);
    }

    // 2. Consume stock from source tank once
    if (effTankId) {
      deductStock(effTankId, vol);
    }

    // 3. Record meter reading if provided
    if (effMeter && Number(effMeter) > 0) {
      const mVal = Number(effMeter);
      const readingId = `mr-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      run(`
        INSERT INTO fuel_meter_readings (
          id, asset_id, asset_code, meter_reading, meter_type, reading_date, source, recorded_by
        ) VALUES (?, ?, ?, ?, ?, ?, 'FUEL_ISSUE', ?)
      `, readingId, assetId, resolvedCode, mVal, effMeterType, dateStr, actorId);

      if (assetId) {
        try {
          run(`
            INSERT INTO meter_readings (asset_id, reading, meter_type, reading_date, recorded_by, source, notes)
            VALUES (?, ?, ?, ?, ?, 'FUEL_ISSUE', ?)
          `, assetId, mVal, effMeterType, dateStr.slice(0, 10), actorId, `Fuel Issue ${issueNo} (${vol}L)`);
          run(`
            UPDATE assets SET current_hours = CASE WHEN current_hours IS NULL OR current_hours < ? THEN ? ELSE current_hours END
             WHERE id = ?
          `, mVal, mVal, assetId);
        } catch (_) {}
      }
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
    `, eventKey, eventKey, assetId, resolvedCode, projId,
       dateStr.slice(0, 10), yr, mo, totalCost, vol, issueId);

    // 5. Keep vehicle_monthly_costs.fuel_cost synchronized live
    if (assetId) {
      try { require('../costing').recalcFuelVehicleMonth(assetId, dateStr); } catch (_) {}
    }

    return {
      id: issueId,
      issue_no: issueNo,
      asset_code: resolvedCode,
      fuel_type: effFuelType,
      litres: vol,
      fuel_price_cents: unitPrice,
      unit_price: unitPrice / 100,
      total_cost_cents: totalCost,
      issue_date: dateStr,
      source_tank_id: effTankId || null,
      fuel_request_id: fr ? fr.id : null,
      request_no: fr ? fr.request_no : null,
      running_chart_no: effChartNo,
      is_full_tank: !!(fr && fr.is_full_tank),
      recommended_litres: fr ? fr.recommended_litres : null,
      variance_litres: cc ? cc.varianceLitres : null,
      variance_pct: cc ? cc.variancePct : null,
      cross_check_status: cc ? cc.crossCheckStatus : null,
    };
  });
}

function voidIssue(issueId, reason, actorId = 1) {
  const errStatus = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
  if (!issueId) throw errStatus(400, 'Issue ID is required');
  if (!reason) throw errStatus(400, 'Documented reason is required to void an issue');

  const issue = get('SELECT * FROM fuel_issues WHERE id = ?', String(issueId));
  if (!issue) throw errStatus(404, `Fuel issue not found: ${issueId}`);
  if (issue.is_voided) throw errStatus(409, 'This fuel issue is already voided');

  return tx(() => {
    // 1. Mark as voided
    run(`
      UPDATE fuel_issues
         SET is_voided = 1,
             voided = 1,
             void_reason = ?,
             voided_at = datetime('now'),
             voided_by = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `, reason, actorId, String(issueId));

    // 2. Restore tank stock if it was drawn from a tank
    const tankId = issue.source_tank_id || issue.bulk_tank_id;
    if (tankId && Number(issue.litres) > 0) {
      restoreStock(tankId, Number(issue.litres));
    }

    // 2b. Reopen linked Transport Fuel Request back to APPROVED if no other active issue exists
    if (issue.fuel_request_id) {
      const otherActive = get(
        'SELECT 1 FROM fuel_issues WHERE fuel_request_id = ? AND COALESCE(is_voided, 0) = 0 AND id != ? LIMIT 1',
        issue.fuel_request_id, String(issueId)
      );
      if (!otherActive) {
        run(`
          UPDATE fuel_requests
             SET status = 'APPROVED',
                 actual_issued_litres = NULL,
                 fuel_issue_id = NULL,
                 fulfilled_by = NULL,
                 fulfilled_at = NULL
           WHERE id = ? AND status = 'FULFILLED'
        `, issue.fuel_request_id);
      }
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

    // 4. Recompute vehicle_monthly_costs.fuel_cost after voiding
    if (issue.asset_id) {
      try { require('../costing').recalcFuelVehicleMonth(issue.asset_id, issue.issue_date); } catch (_) {}
    }

    return { id: issueId, is_voided: 1, void_reason: reason };
  });
}

function listIssues({
  limit = 50,
  offset = 0,
  assetCode = null,
  tankId = null,
  projectId = null,
  allowedTankIds = null,
  scopedProjectId = null,
  fromDate = null,
  toDate = null,
  showVoided = false,
  search = null,
  sourceType = null,
  fuelType = null,
} = {}) {
  const conditions = [];
  const params = [];

  if (!showVoided) {
    conditions.push('fi.is_voided = 0');
  }

  if (Array.isArray(allowedTankIds)) {
    if (allowedTankIds.length > 0) {
      const marks = allowedTankIds.map(() => '?').join(',');
      conditions.push(`(fi.source_tank_id IN (${marks}) OR fi.bulk_tank_id IN (${marks}))`);
      params.push(...allowedTankIds, ...allowedTankIds);
    } else if (scopedProjectId != null) {
      conditions.push('(fi.source_project_id = ? OR fi.target_project_id = ? OR fi.project_id = ?)');
      params.push(Number(scopedProjectId), Number(scopedProjectId), Number(scopedProjectId));
    } else {
      conditions.push('1 = 0');
    }
  } else if (scopedProjectId != null) {
    conditions.push('(fi.source_project_id = ? OR fi.target_project_id = ? OR fi.project_id = ?)');
    params.push(Number(scopedProjectId), Number(scopedProjectId), Number(scopedProjectId));
  }

  if (assetCode) {
    conditions.push('(UPPER(fi.asset_code) LIKE UPPER(?) OR UPPER(fi.vehicle_ref) LIKE UPPER(?))');
    params.push(`%${assetCode}%`, `%${assetCode}%`);
  }

  if (tankId) {
    conditions.push('(fi.source_tank_id = ? OR fi.bulk_tank_id = ?)');
    params.push(String(tankId), String(tankId));
  }

  if (projectId) {
    conditions.push('(fi.source_project_id = ? OR fi.target_project_id = ? OR fi.project_id = ?)');
    params.push(Number(projectId), Number(projectId), Number(projectId));
  }

  if (sourceType && sourceType !== 'ALL') {
    if (sourceType === 'DIRECT_BILLED') {
      conditions.push('fi.is_direct_billed = 1');
    } else if (sourceType === 'MANUAL') {
      conditions.push('fi.is_manual = 1');
    } else if (sourceType === 'BOWSER') {
      conditions.push('(fi.source_tank_id IS NOT NULL OR fi.bulk_tank_id IS NOT NULL)');
    } else if (sourceType === 'STATION') {
      conditions.push('(fi.source_tank_id IS NULL AND fi.bulk_tank_id IS NULL)');
    }
  }

  if (fuelType && fuelType !== 'ALL') {
    conditions.push('COALESCE(fi.fuel_type, fi.fuel_kind) = ?');
    params.push(String(fuelType));
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
    conditions.push('(fi.issue_no LIKE ? OR fi.driver_name LIKE ? OR fi.asset_code LIKE ? OR fi.vehicle_ref LIKE ? OR fi.station_name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = get(`SELECT COUNT(*) AS total FROM fuel_issues fi ${whereClause}`, ...params);
  const total = countRow ? countRow.total : 0;

  const rows = all(`
    SELECT fi.*,
           COALESCE(
             NULLIF(fi.fuel_price_cents, 0),
             NULLIF(fi.price_per_litre_cents, 0),
             CASE WHEN fi.unit_price > 0 THEN ROUND(fi.unit_price * 100) END,
             CASE WHEN fi.litres > 0 AND COALESCE(fi.total_cost_cents, fi.cost_cents, 0) > 0
                  THEN ROUND(COALESCE(fi.total_cost_cents, fi.cost_cents) * 1.0 / fi.litres)
                  ELSE 0 END
           ) AS effective_price_cents,
           t.name AS tank_name,
           fr.request_no,
           sp.name AS source_project_name,
           COALESCE(tp.name, p.name, sp.name) AS target_project_name,
           (SELECT status FROM fuel_corrections fc WHERE fc.fuel_issue_id = fi.id ORDER BY fc.requested_at DESC LIMIT 1) AS correction_status
      FROM fuel_issues fi
      LEFT JOIN fuel_requests fr ON fr.id = fi.fuel_request_id
      LEFT JOIN fuel_tanks t ON t.id = COALESCE(fi.source_tank_id, fi.bulk_tank_id)
      LEFT JOIN projects sp ON sp.id = fi.source_project_id
      LEFT JOIN projects tp ON tp.id = fi.target_project_id
      LEFT JOIN projects p ON p.id = COALESCE(fi.project_id, t.project_id)
     ${whereClause}
     ORDER BY fi.issue_date DESC, fi.created_at DESC
     LIMIT ? OFFSET ?
  `, ...params, Number(limit), Number(offset));

  return { total, rows, limit: Number(limit), offset: Number(offset) };
}

module.exports = {
  getCurrentPrice,
  resolvePriceDetail,
  getActivePriceMap,
  recordIssue,
  voidIssue,
  listIssues,
};
