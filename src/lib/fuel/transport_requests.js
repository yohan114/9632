'use strict';

/**
 * Transport Fuel & Running Chart Domain Engine
 * ---------------------------------------------------------------------------
 * Implements:
 *   1. Recommended Fuel calculation from Running Chart meter delta or Approx KM/Hrs
 *      using vehicle rate-card norms (L/km or L/hr).
 *   2. Multi-site Transport Fuel Request creation (Site Tanks/Bowsers & External Stations)
 *      with support for Full Tank ("fill first, pump operator enters actual quantity after").
 *   3. Strict "No Request, No Issue" gate & 1:1 request-to-issue linking.
 *   4. Cross-check variance & audit engine + ExcelJS workbook export.
 */

const { get, all, run } = require('../../db');
const audit = require('../audit');
const v2Engine = require('./v2_engine');

const APPROVAL_OVER_PCT = 0.20;
const CROSS_CHECK_OVER_PCT = 0.15;
const CROSS_CHECK_UNDER_PCT = 0.35;

function httpError(status, message, data = null) {
  const err = new Error(message);
  err.status = status;
  if (data) err.data = data;
  return err;
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function lookupRateCardForAsset(asset) {
  if (!asset) return null;
  const direct = get('SELECT * FROM fleet_rental_rates WHERE asset_id = ? ORDER BY updated_at DESC LIMIT 1', asset.id);
  if (direct && (direct.fuel_cons_typ > 0 || direct.fuel_cons_econ > 0 || direct.fuel_cons_heavy > 0)) {
    return direct;
  }
  const cat = String(asset.category || asset.type || '').trim();
  if (!cat) return direct || null;
  const byCategory = get(
    `SELECT * FROM fleet_rental_rates
      WHERE UPPER(COALESCE(category_name, '')) = UPPER(?)
        AND (fuel_cons_typ > 0 OR fuel_cons_econ > 0 OR fuel_cons_heavy > 0)
      ORDER BY updated_at DESC LIMIT 1`,
    cat
  );
  return byCategory || direct || null;
}

function calculateRecommendedFuel({
  assetCode,
  assetId,
  vehicleCode,
  meterReading,
  prevMeterReading,
  approxKm,
  issueDate,
} = {}) {
  const meterCheck = v2Engine.checkMeterReading({
    assetCode,
    assetId,
    vehicleCode,
    meterReading,
    issueDate,
  });

  const resolvedAsset = meterCheck.found
    ? get('SELECT * FROM assets WHERE id = ?', meterCheck.asset.id)
    : v2Engine.resolveVehicle(assetCode || assetId || vehicleCode);

  const fallbackRateCard = (!meterCheck.band || (!meterCheck.band.rawTyp && !meterCheck.band.rawEcon))
    ? lookupRateCardForAsset(resolvedAsset)
    : null;

  const meterType = meterCheck.asset
    ? meterCheck.asset.meter_type
    : v2Engine.inferMeterType(resolvedAsset, fallbackRateCard);
  const basis = (meterCheck.band && meterCheck.band.basis)
    || (fallbackRateCard && fallbackRateCard.fuel_cons_basis)
    || (meterType === 'KM' ? 'km' : 'hr');
  const displayUnit = basis === 'km' ? 'km/L' : 'L/hr';

  let band = meterCheck.band;
  if ((!band || (!band.rawTyp && !band.rawEcon)) && fallbackRateCard) {
    const econDisp = v2Engine.toDisplayRate(fallbackRateCard.fuel_cons_econ, basis);
    const typDisp = v2Engine.toDisplayRate(fallbackRateCard.fuel_cons_typ, basis);
    const heavyDisp = v2Engine.toDisplayRate(fallbackRateCard.fuel_cons_heavy, basis);
    band = {
      econ: econDisp != null ? round2(econDisp) : null,
      typ: typDisp != null ? round2(typDisp) : null,
      heavy: heavyDisp != null ? round2(heavyDisp) : null,
      rawEcon: fallbackRateCard.fuel_cons_econ,
      rawTyp: fallbackRateCard.fuel_cons_typ,
      rawHeavy: fallbackRateCard.fuel_cons_heavy,
      basis,
      unit: displayUnit,
      displayUnit,
      econDisplay: econDisp != null ? round2(econDisp) : null,
      typDisplay: typDisp != null ? round2(typDisp) : null,
      heavyDisplay: heavyDisp != null ? round2(heavyDisp) : null,
    };
  }

  const assetBaseline = (!meterCheck.previous && resolvedAsset && Number(resolvedAsset.current_hours) > 0)
    ? Number(resolvedAsset.current_hours)
    : null;
  const previous = meterCheck.previous || (assetBaseline != null ? {
    value: assetBaseline,
    reading: assetBaseline,
    reading_date: String(resolvedAsset.updated_at || '').slice(0, 10) || null,
    date: String(resolvedAsset.updated_at || '').slice(0, 10) || null,
    source: 'ASSET_REGISTER',
  } : null);

  const prevMeter = prevMeterReading !== undefined && prevMeterReading !== null && prevMeterReading !== ''
    ? Number(prevMeterReading)
    : (previous && previous.value != null ? Number(previous.value) : null);

  const currMeter = meterReading !== undefined && meterReading !== null && meterReading !== ''
    ? Number(meterReading)
    : null;

  let meterOk = meterCheck.ok;
  let meterWarning = meterCheck.warning;
  let meterDelta = null;
  if (currMeter != null && Number.isFinite(currMeter) && prevMeter != null && Number.isFinite(prevMeter)) {
    meterDelta = round1(currMeter - prevMeter);
    if (currMeter < prevMeter) {
      meterOk = false;
      meterWarning = meterWarning || `Meter reading ${currMeter} is below previous reading ${prevMeter}.`;
    }
  }

  const manualApprox = approxKm !== undefined && approxKm !== null && approxKm !== '' ? Number(approxKm) : null;
  const effApproxKm = manualApprox != null && Number.isFinite(manualApprox) && manualApprox > 0
    ? round1(manualApprox)
    : (meterDelta != null && meterDelta > 0 ? meterDelta : 0);

  const normRate = band
    ? (band.rawTyp != null && band.rawTyp > 0 ? Number(band.rawTyp)
      : (band.rawEcon != null && band.rawEcon > 0 ? Number(band.rawEcon) : null))
    : null;

  const recommendedLitres = effApproxKm > 0 && normRate != null && normRate > 0
    ? round1(effApproxKm * normRate)
    : null;

  const recommendedBand = effApproxKm > 0 && band ? {
    econ: band.rawEcon > 0 ? round1(effApproxKm * Number(band.rawEcon)) : null,
    typ: recommendedLitres,
    heavy: band.rawHeavy > 0 ? round1(effApproxKm * Number(band.rawHeavy)) : null,
  } : null;

  return {
    found: !!resolvedAsset,
    ok: meterOk,
    warning: meterWarning,
    asset: meterCheck.asset || (resolvedAsset ? {
      id: resolvedAsset.id,
      code: resolvedAsset.code || resolvedAsset.ec_code,
      registration: resolvedAsset.registration,
      category: resolvedAsset.category,
      meter_type: meterType,
    } : null),
    previous,
    prevMeter,
    meterReading: currMeter,
    meterType,
    basis,
    meterDelta: meterDelta != null && meterDelta >= 0 ? meterDelta : null,
    approxKm: effApproxKm,
    usedMeterDelta: !(manualApprox != null && manualApprox > 0) && meterDelta != null && meterDelta > 0,
    normRate,
    displayNorm: band ? (band.typDisplay != null ? band.typDisplay : band.econDisplay) : null,
    displayUnit,
    recommendedLitres,
    recommendedBand,
    band,
  };
}

function computeCrossCheck({
  actualLitres,
  recommendedLitres,
  tripTotalFuel,
  requestedLitres,
  isFullTank = false,
  prevMeterReading = null,
  issueMeterReading = null,
  meterFaulty = false,
} = {}) {
  const actual = Number(actualLitres);
  const rec = recommendedLitres != null && Number(recommendedLitres) > 0 ? Number(recommendedLitres) : null;
  const trip = tripTotalFuel != null && Number(tripTotalFuel) > 0 ? Number(tripTotalFuel) : null;
  const req = requestedLitres != null && Number(requestedLitres) > 0 ? Number(requestedLitres) : null;

  const varianceLitres = rec != null ? round1(actual - rec) : null;
  const variancePct = rec != null && rec > 0 ? round1(((actual - rec) / rec) * 100) : null;
  const tripVarianceLitres = trip != null ? round1(actual - trip) : null;

  const flags = [];
  if (meterFaulty) {
    flags.push('METER_FAULTY');
  } else if (
    prevMeterReading != null
    && issueMeterReading != null
    && Number(prevMeterReading) > 0
    && Number(issueMeterReading) === Number(prevMeterReading)
    && actual > 10
  ) {
    flags.push('METER_MISMATCH');
  }
  if (!isFullTank && req != null && actual > req * 1.1) {
    flags.push('OVER_REQUESTED');
  }
  if (rec == null) {
    flags.push('NO_NORM');
  } else {
    if (actual > rec * (1 + CROSS_CHECK_OVER_PCT)) flags.push('OVER_RECOMMENDED');
    if (actual < rec * (1 - CROSS_CHECK_UNDER_PCT)) flags.push('UNDER_RECOMMENDED');
  }

  let crossCheckStatus = 'OK';
  if (flags.includes('METER_MISMATCH')) crossCheckStatus = 'METER_MISMATCH';
  else if (flags.includes('OVER_REQUESTED')) crossCheckStatus = 'OVER_REQUESTED';
  else if (flags.includes('OVER_RECOMMENDED')) crossCheckStatus = 'OVER_RECOMMENDED';
  else if (flags.includes('METER_FAULTY')) crossCheckStatus = 'METER_FAULTY';
  else if (flags.includes('UNDER_RECOMMENDED')) crossCheckStatus = 'UNDER_RECOMMENDED';
  else if (flags.includes('NO_NORM')) crossCheckStatus = 'NO_NORM';

  return {
    varianceLitres,
    variancePct,
    tripVarianceLitres,
    crossCheckStatus,
    flags,
  };
}

function hydrateRequestRow(row) {
  if (!row) return null;
  return {
    ...row,
    is_full_tank: !!row.is_full_tank,
    needs_approval: !!row.needs_approval,
    meter_faulty: !!row.meter_faulty,
  };
}

function getRequestById(id) {
  const row = get(`
    SELECT fr.*,
           COALESCE(p.name, tp.name, 'Central') AS project_name,
           COALESCE(p.code, tp.code) AS project_code,
           t.name AS target_tank_name,
           t.code AS target_tank_code,
           t.fuel_type AS target_tank_fuel_type,
           COALESCE(u1.full_name, u1.username) AS requester_name,
           COALESCE(u2.full_name, u2.username) AS approver_name,
           COALESCE(u3.full_name, u3.username) AS fulfilled_by_name,
           fi.issue_no AS linked_issue_no,
           fi.litres AS linked_issue_litres,
           fi.issue_date AS linked_issue_date,
           fi.variance_litres AS linked_variance_litres,
           fi.variance_pct AS linked_variance_pct,
           fi.cross_check_status AS linked_cross_check_status,
           fi.total_cost_cents AS linked_total_cost_cents,
           a.category AS asset_category,
           a.registration AS asset_registration
      FROM fuel_requests fr
      LEFT JOIN fuel_tanks t ON t.id = fr.target_tank_id
      LEFT JOIN projects p ON p.id = fr.project_id
      LEFT JOIN projects tp ON tp.id = t.project_id
      LEFT JOIN assets a ON a.id = fr.asset_id
      LEFT JOIN users u1 ON u1.id = fr.requested_by
      LEFT JOIN users u2 ON u2.id = fr.approved_by
      LEFT JOIN users u3 ON u3.id = fr.fulfilled_by
      LEFT JOIN fuel_issues fi ON fi.id = fr.fuel_issue_id AND COALESCE(fi.is_voided, 0) = 0
     WHERE fr.id = ?
  `, String(id));
  return hydrateRequestRow(row);
}

function createTransportRequest(payload = {}, actor = null) {
  const actorId = actor && actor.id ? actor.id : 1;
  const assetInput = payload.assetCode || payload.vehicleCode || payload.assetId;
  if (!assetInput) {
    throw httpError(400, 'Vehicle / Machine code is required');
  }

  const meterFaulty = !!(payload.meterFaulty ?? payload.meter_faulty);
  const meterFaultReason = String(payload.meterFaultReason ?? payload.meter_fault_reason ?? '').trim() || null;
  const rawMeter = payload.meterReading ?? payload.meter_reading;
  const meterVal = !meterFaulty && rawMeter != null && rawMeter !== '' ? Number(rawMeter) : null;
  if (meterFaulty) {
    if (!meterFaultReason || meterFaultReason.length < 3) {
      throw httpError(400, 'Faulty meter reason (at least 3 characters) is required when Meter Faulty is marked');
    }
  } else if (!Number.isFinite(meterVal) || meterVal <= 0) {
    throw httpError(400, 'Current Running Chart meter reading (> 0) is required (or mark Meter Faulty with a reason)');
  }

  const runningChartNo = String(payload.runningChartNo || payload.running_chart_no || '').trim();
  if (!runningChartNo) {
    throw httpError(400, 'Running Chart No is required');
  }

  const isFullTank = !!(payload.isFullTank ?? payload.is_full_tank);
  const sourceMode = String(payload.sourceMode || payload.source_mode || 'TANK').toUpperCase() === 'STATION'
    ? 'STATION'
    : 'TANK';

  const calc = calculateRecommendedFuel({
    assetCode: payload.assetCode || payload.vehicleCode,
    assetId: payload.assetId,
    meterReading: meterFaulty ? null : meterVal,
    prevMeterReading: payload.prevMeterReading,
    approxKm: payload.approxKm,
    issueDate: payload.issueDate,
  });

  if (!meterFaulty && !calc.ok && !payload.ignoreMeterWarning) {
    throw httpError(400, calc.warning || 'Meter reading cannot go backwards below last recorded reading', {
      meterGuardFailed: true,
      previous: calc.previous,
    });
  }

  const rawTripFuel = payload.tripTotalFuel ?? payload.trip_total_fuel ?? payload.requestedLitres ?? payload.requested_litres;
  const tripFuelNum = rawTripFuel !== undefined && rawTripFuel !== null && rawTripFuel !== '' ? Number(rawTripFuel) : null;

  if (!isFullTank && (tripFuelNum == null || !Number.isFinite(tripFuelNum) || tripFuelNum <= 0)) {
    throw httpError(400, 'Trip Total Fuel (requested litres > 0) is required unless Full Tank mode is enabled');
  }

  const requestedLitres = tripFuelNum != null && Number.isFinite(tripFuelNum) && tripFuelNum > 0
    ? round1(tripFuelNum)
    : (calc.recommendedLitres != null && calc.recommendedLitres > 0 ? calc.recommendedLitres : 0);

  let targetTank = null;
  if (sourceMode === 'TANK') {
    const reqTankId = payload.targetTankId || payload.tankId || payload.sourceTankId;
    if (!reqTankId) {
      throw httpError(400, 'Target Site Pump / Tank must be selected for site fuel requests');
    }
    targetTank = get('SELECT * FROM fuel_tanks WHERE id = ? AND active = 1', String(reqTankId));
    if (!targetTank) {
      throw httpError(404, `Selected fuel tank/pump not found or inactive: ${reqTankId}`);
    }
  }

  const stationName = sourceMode === 'STATION'
    ? String(payload.stationName || payload.station_name || '').trim()
    : null;
  if (sourceMode === 'STATION' && !stationName) {
    throw httpError(400, 'Filling Station name is required for external station requests');
  }

  const resolvedAsset = calc.asset
    ? get('SELECT * FROM assets WHERE id = ?', calc.asset.id)
    : v2Engine.resolveVehicle(assetInput);

  const projectId = payload.projectId != null && payload.projectId !== ''
    ? Number(payload.projectId)
    : (targetTank && targetTank.project_id)
      || (resolvedAsset && resolvedAsset.current_project_id)
      || (actor && actor.project_id)
      || null;

  const recLitres = calc.recommendedLitres;
  const exceedsBand = recLitres != null && recLitres > 0 && tripFuelNum != null && tripFuelNum > recLitres * (1 + APPROVAL_OVER_PCT);
  const needsApproval = exceedsBand ? 1 : 0;
  // Normal requests (or Full Tank requests without >20% trip override) route straight to Pump Operator queue (APPROVED)
  const initialStatus = needsApproval ? 'PENDING' : 'APPROVED';

  const reqId = `freq-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const reqNo = `FR-${new Date().getFullYear()}-${Math.floor(10000 + Math.random() * 90000)}`;
  const fuelType = String(payload.fuelType || (targetTank && targetTank.fuel_type) || 'AUTO_DIESEL').toUpperCase();
  const resolvedCode = resolvedAsset
    ? (resolvedAsset.code || resolvedAsset.ec_code || resolvedAsset.registration)
    : String(assetInput).trim().toUpperCase();

  run(`
    INSERT INTO fuel_requests (
      id, request_no, asset_id, asset_code, project_id, target_tank_id, source_mode, station_name,
      fuel_type, requested_litres, meter_reading, prev_meter_reading, meter_type,
      meter_faulty, meter_fault_reason,
      approx_km, consumption_norm, consumption_basis, recommended_litres, trip_total_fuel,
      is_full_tank, needs_approval, running_chart_no, driver_name, trip_purpose,
      reason, notes, status, requested_by, requested_at, approved_by, approved_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, datetime('now'), ?, CASE WHEN ? = 'APPROVED' THEN datetime('now') ELSE NULL END
    )
  `,
    reqId, reqNo, resolvedAsset ? resolvedAsset.id : null, resolvedCode, projectId,
    targetTank ? targetTank.id : null, sourceMode, stationName,
    fuelType, requestedLitres, meterFaulty ? null : meterVal, calc.prevMeter, calc.meterType,
    meterFaulty ? 1 : 0, meterFaulty ? meterFaultReason : null,
    calc.approxKm || 0, calc.normRate, calc.basis, recLitres, tripFuelNum != null ? round1(tripFuelNum) : null,
    isFullTank ? 1 : 0, needsApproval, runningChartNo,
    payload.driverName ? String(payload.driverName).trim() : null,
    payload.tripPurpose ? String(payload.tripPurpose).trim() : null,
    payload.reason || payload.tripPurpose || `Running Chart ${runningChartNo}`,
    payload.notes ? String(payload.notes).trim() : null,
    initialStatus, actorId,
    initialStatus === 'APPROVED' ? actorId : null,
    initialStatus
  );

  try {
    audit.record({
      userId: actorId,
      entity: 'fuel_request',
      entityId: reqId,
      action: 'fuel.request.created',
      after: {
        requestNo: reqNo,
        assetCode: resolvedCode,
        runningChartNo,
        meterFaulty,
        meterFaultReason,
        approxKm: calc.approxKm,
        recommendedLitres: recLitres,
        tripTotalFuel: tripFuelNum,
        isFullTank,
        status: initialStatus,
        targetTankId: targetTank ? targetTank.id : null,
      },
    });
  } catch (_) {}

  return getRequestById(reqId);
}

function listTransportRequests({
  status = 'ALL',
  projectId = null,
  tankId = null,
  allowedTankIds = null,
  scopedProjectId = null,
  assetCode = null,
  search = null,
  queueOnly = false,
  limit = 150,
} = {}) {
  const conds = [];
  const params = [];

  if (Array.isArray(allowedTankIds)) {
    if (allowedTankIds.length > 0 && scopedProjectId != null) {
      const marks = allowedTankIds.map(() => '?').join(',');
      conds.push(`(fr.target_tank_id IN (${marks}) OR (fr.target_tank_id IS NULL AND COALESCE(fr.project_id, t.project_id) = ?))`);
      params.push(...allowedTankIds, Number(scopedProjectId));
    } else if (allowedTankIds.length > 0) {
      const marks = allowedTankIds.map(() => '?').join(',');
      conds.push(`fr.target_tank_id IN (${marks})`);
      params.push(...allowedTankIds);
    } else if (scopedProjectId != null) {
      conds.push('COALESCE(fr.project_id, t.project_id) = ?');
      params.push(Number(scopedProjectId));
    } else {
      conds.push('1 = 0');
    }
  } else if (scopedProjectId != null) {
    conds.push('COALESCE(fr.project_id, t.project_id) = ?');
    params.push(Number(scopedProjectId));
  }

  if (queueOnly) {
    conds.push("fr.status = 'APPROVED'");
  } else if (status && status !== 'ALL') {
    const up = String(status).toUpperCase();
    if (up === 'OPEN') {
      conds.push("fr.status IN ('PENDING', 'APPROVED')");
    } else {
      conds.push('UPPER(fr.status) = ?');
      params.push(up);
    }
  }

  if (projectId != null && projectId !== '' && projectId !== 'ALL') {
    conds.push('COALESCE(fr.project_id, t.project_id) = ?');
    params.push(Number(projectId));
  }
  if (tankId != null && tankId !== '' && tankId !== 'ALL') {
    conds.push('fr.target_tank_id = ?');
    params.push(String(tankId));
  }
  if (assetCode) {
    conds.push('UPPER(fr.asset_code) LIKE UPPER(?)');
    params.push(`%${String(assetCode).trim()}%`);
  }
  if (search) {
    const q = `%${String(search).trim()}%`;
    conds.push(`(
      UPPER(fr.request_no) LIKE UPPER(?)
      OR UPPER(fr.asset_code) LIKE UPPER(?)
      OR UPPER(COALESCE(fr.running_chart_no, '')) LIKE UPPER(?)
      OR UPPER(COALESCE(fr.driver_name, '')) LIKE UPPER(?)
      OR UPPER(COALESCE(fr.trip_purpose, '')) LIKE UPPER(?)
    )`);
    params.push(q, q, q, q, q);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const lim = Math.min(500, Math.max(1, Number(limit) || 150));

  const rows = all(`
    SELECT fr.*,
           COALESCE(p.name, tp.name, 'Central') AS project_name,
           COALESCE(p.code, tp.code) AS project_code,
           t.name AS target_tank_name,
           t.code AS target_tank_code,
           t.fuel_type AS target_tank_fuel_type,
           COALESCE(u1.full_name, u1.username) AS requester_name,
           COALESCE(u2.full_name, u2.username) AS approver_name,
           COALESCE(u3.full_name, u3.username) AS fulfilled_by_name,
           fi.issue_no AS linked_issue_no,
           fi.litres AS linked_issue_litres,
           fi.issue_date AS linked_issue_date,
           fi.variance_litres AS linked_variance_litres,
           fi.variance_pct AS linked_variance_pct,
           fi.cross_check_status AS linked_cross_check_status,
           fi.total_cost_cents AS linked_total_cost_cents,
           a.category AS asset_category,
           a.registration AS asset_registration
      FROM fuel_requests fr
      LEFT JOIN fuel_tanks t ON t.id = fr.target_tank_id
      LEFT JOIN projects p ON p.id = fr.project_id
      LEFT JOIN projects tp ON tp.id = t.project_id
      LEFT JOIN assets a ON a.id = fr.asset_id
      LEFT JOIN users u1 ON u1.id = fr.requested_by
      LEFT JOIN users u2 ON u2.id = fr.approved_by
      LEFT JOIN users u3 ON u3.id = fr.fulfilled_by
      LEFT JOIN fuel_issues fi ON fi.id = fr.fuel_issue_id AND COALESCE(fi.is_voided, 0) = 0
     ${where}
     ORDER BY CASE fr.status
                WHEN 'PENDING' THEN 0
                WHEN 'APPROVED' THEN 1
                WHEN 'FULFILLED' THEN 2
                ELSE 3
              END,
              fr.requested_at DESC
     LIMIT ?
  `, ...params, lim);

  return rows.map(hydrateRequestRow);
}

/**
 * Validate a fuel request during transactional fuel issue recording.
 * Enforces strict "No Request, No Issue" and 1:1 request-to-issue linking.
 */
function validateRequestForIssue({
  fuelRequestId,
  resolvedAssetId = null,
  resolvedCode = null,
  sourceTankId = null,
  isSiteTransfer = false,
  issueLitres,
  meterReading = null,
  meterFaulty = undefined,
} = {}) {
  if (isSiteTransfer && !fuelRequestId) {
    return { bypass: true, request: null, effectiveTankId: sourceTankId || null, crossCheck: null };
  }

  if (!fuelRequestId) {
    throw httpError(
      400,
      'No Request, No Issue: An approved Transport Fuel Request must be selected before dispensing vehicle fuel.'
    );
  }

  const fr = get('SELECT * FROM fuel_requests WHERE id = ?', String(fuelRequestId));
  if (!fr) {
    throw httpError(404, `Transport Fuel Request not found: ${fuelRequestId}`);
  }

  if (fr.status === 'PENDING') {
    throw httpError(409, `Request ${fr.request_no} is waiting for Manager approval before pump dispatch.`);
  }
  if (fr.status === 'REJECTED' || fr.status === 'CANCELLED') {
    throw httpError(409, `Request ${fr.request_no} was ${fr.status.toLowerCase()} and cannot be issued.`);
  }
  if (fr.status === 'FULFILLED') {
    throw httpError(409, `Request ${fr.request_no} has already been fulfilled (1 request = 1 issue).`);
  }
  if (fr.status !== 'APPROVED') {
    throw httpError(409, `Request ${fr.request_no} is in status '${fr.status}' and is not open for issue.`);
  }

  const existingActive = get(
    'SELECT id, issue_no FROM fuel_issues WHERE fuel_request_id = ? AND COALESCE(is_voided, 0) = 0 LIMIT 1',
    fr.id
  );
  if (existingActive) {
    throw httpError(
      409,
      `Request ${fr.request_no} is already linked to active issue ${existingActive.issue_no} (1 request = 1 issue).`
    );
  }

  // Verify asset / vehicle matches
  if (fr.asset_id && resolvedAssetId && Number(fr.asset_id) !== Number(resolvedAssetId)) {
    throw httpError(400, `Vehicle mismatch: Request ${fr.request_no} belongs to ${fr.asset_code}, not ${resolvedCode || resolvedAssetId}.`);
  }
  if (!fr.asset_id && fr.asset_code && resolvedCode) {
    if (v2Engine.squashCode(fr.asset_code) !== v2Engine.squashCode(resolvedCode)) {
      throw httpError(400, `Vehicle mismatch: Request ${fr.request_no} belongs to ${fr.asset_code}, not ${resolvedCode}.`);
    }
  }

  // Verify tank match if request specifies a target tank and caller explicitly passed a different tank
  const effectiveTankId = sourceTankId || (fr.source_mode === 'TANK' ? fr.target_tank_id : null);
  if (fr.source_mode === 'TANK' && fr.target_tank_id && sourceTankId && String(fr.target_tank_id) !== String(sourceTankId)) {
    throw httpError(
      400,
      `Pump mismatch: Request ${fr.request_no} is assigned to tank ${fr.target_tank_id}, not ${sourceTankId}.`
    );
  }

  const hasExplicitFaulty = meterFaulty !== undefined;
  const effMeterFaulty = hasExplicitFaulty
    ? !!meterFaulty
    : Boolean(fr.meter_faulty && !(meterReading != null && meterReading !== '' && Number(meterReading) > 0));

  const crossCheck = computeCrossCheck({
    actualLitres: issueLitres,
    recommendedLitres: fr.recommended_litres,
    tripTotalFuel: fr.trip_total_fuel,
    requestedLitres: fr.requested_litres,
    isFullTank: !!fr.is_full_tank,
    prevMeterReading: fr.prev_meter_reading,
    issueMeterReading: effMeterFaulty ? null : (meterReading != null ? meterReading : fr.meter_reading),
    meterFaulty: effMeterFaulty,
  });

  return {
    bypass: false,
    request: fr,
    effectiveTankId,
    effectiveProjectId: fr.project_id || null,
    crossCheck,
  };
}

function getCrossCheckReport({
  projectId = null,
  tankId = null,
  allowedTankIds = null,
  scopedProjectId = null,
  flag = null,
  fromDate = null,
  toDate = null,
  search = null,
  limit = 250,
} = {}) {
  const conds = [];
  const params = [];

  if (Array.isArray(allowedTankIds)) {
    if (allowedTankIds.length > 0 && scopedProjectId != null) {
      const marks = allowedTankIds.map(() => '?').join(',');
      conds.push(`(COALESCE(fi.source_tank_id, fr.target_tank_id) IN (${marks}) OR (COALESCE(fi.source_tank_id, fr.target_tank_id) IS NULL AND COALESCE(fr.project_id, t.project_id, fi.target_project_id, fi.project_id) = ?))`);
      params.push(...allowedTankIds, Number(scopedProjectId));
    } else if (allowedTankIds.length > 0) {
      const marks = allowedTankIds.map(() => '?').join(',');
      conds.push(`COALESCE(fi.source_tank_id, fr.target_tank_id) IN (${marks})`);
      params.push(...allowedTankIds);
    } else if (scopedProjectId != null) {
      conds.push('COALESCE(fr.project_id, t.project_id, fi.target_project_id, fi.project_id) = ?');
      params.push(Number(scopedProjectId));
    } else {
      conds.push('1 = 0');
    }
  } else if (scopedProjectId != null) {
    conds.push('COALESCE(fr.project_id, t.project_id, fi.target_project_id, fi.project_id) = ?');
    params.push(Number(scopedProjectId));
  }

  if (projectId != null && projectId !== '' && projectId !== 'ALL') {
    conds.push('COALESCE(fr.project_id, t.project_id, fi.target_project_id, fi.project_id) = ?');
    params.push(Number(projectId));
  }
  if (tankId != null && tankId !== '' && tankId !== 'ALL') {
    conds.push('COALESCE(fi.source_tank_id, fr.target_tank_id) = ?');
    params.push(String(tankId));
  }
  if (flag && flag !== 'ALL') {
    if (flag === 'FLAGGED') {
      conds.push("(fi.cross_check_status IN ('OVER_RECOMMENDED', 'UNDER_RECOMMENDED', 'OVER_REQUESTED', 'METER_MISMATCH', 'METER_FAULTY') OR COALESCE(fi.meter_faulty, fr.meter_faulty, 0) = 1)");
    } else if (String(flag).toUpperCase() === 'METER_FAULTY') {
      conds.push("(COALESCE(fi.meter_faulty, fr.meter_faulty, 0) = 1 OR fi.cross_check_status = 'METER_FAULTY')");
    } else {
      conds.push('fi.cross_check_status = ?');
      params.push(String(flag).toUpperCase());
    }
  }
  if (fromDate) {
    conds.push('substr(COALESCE(fi.issue_date, fr.requested_at), 1, 10) >= ?');
    params.push(String(fromDate).slice(0, 10));
  }
  if (toDate) {
    conds.push('substr(COALESCE(fi.issue_date, fr.requested_at), 1, 10) <= ?');
    params.push(String(toDate).slice(0, 10));
  }
  if (search) {
    const q = `%${String(search).trim()}%`;
    conds.push(`(
      UPPER(fr.request_no) LIKE UPPER(?)
      OR UPPER(fr.asset_code) LIKE UPPER(?)
      OR UPPER(COALESCE(fr.running_chart_no, '')) LIKE UPPER(?)
      OR UPPER(COALESCE(fi.issue_no, '')) LIKE UPPER(?)
      OR UPPER(COALESCE(fr.driver_name, '')) LIKE UPPER(?)
    )`);
    params.push(q, q, q, q, q);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const lim = Math.min(1000, Math.max(1, Number(limit) || 250));

  const rows = all(`
    SELECT fr.id AS request_id,
           fr.request_no,
           fr.status AS request_status,
           fr.asset_id,
           fr.asset_code,
           a.category AS asset_category,
           a.registration AS asset_registration,
           COALESCE(p.name, tp.name, 'Central') AS project_name,
           COALESCE(fr.project_id, t.project_id) AS project_id,
           COALESCE(t.name, fr.station_name, 'External Station') AS pump_or_station,
           fr.target_tank_id,
           fr.source_mode,
           fr.running_chart_no,
           fr.driver_name,
           fr.trip_purpose,
           fr.prev_meter_reading,
           fr.meter_reading AS request_meter_reading,
           fr.meter_type,
           fr.meter_faulty AS request_meter_faulty,
           fr.meter_fault_reason AS request_meter_fault_reason,
           fr.approx_km,
           fr.consumption_norm,
           fr.consumption_basis,
           fr.recommended_litres,
           fr.trip_total_fuel,
           fr.requested_litres,
           fr.is_full_tank,
           fr.requested_at,
           COALESCE(u1.full_name, u1.username) AS requester_name,
           fi.id AS issue_id,
           fi.issue_no,
           fi.litres AS actual_litres,
           fi.meter_reading AS issue_meter_reading,
           fi.meter_faulty AS issue_meter_faulty,
           fi.meter_fault_reason AS issue_meter_fault_reason,
           fi.issue_date,
           fi.total_cost_cents,
           fi.variance_litres,
           fi.variance_pct,
           fi.trip_variance_litres,
           fi.cross_check_status,
           COALESCE(u2.full_name, u2.username) AS operator_name
      FROM fuel_requests fr
      LEFT JOIN fuel_issues fi ON fi.id = fr.fuel_issue_id AND COALESCE(fi.is_voided, 0) = 0
      LEFT JOIN fuel_tanks t ON t.id = COALESCE(fi.source_tank_id, fr.target_tank_id)
      LEFT JOIN projects p ON p.id = fr.project_id
      LEFT JOIN projects tp ON tp.id = t.project_id
      LEFT JOIN assets a ON a.id = fr.asset_id
      LEFT JOIN users u1 ON u1.id = fr.requested_by
      LEFT JOIN users u2 ON u2.id = fi.issued_by
     ${where}
     ORDER BY COALESCE(fi.issue_date, fr.requested_at) DESC
     LIMIT ?
  `, ...params, lim);

  let fulfilledCount = 0;
  let pendingCount = 0;
  let fullTankCount = 0;
  let flaggedCount = 0;
  let overRecommendedCount = 0;
  let meterMismatchCount = 0;
  let meterFaultyCount = 0;
  let totalRecommendedLitres = 0;
  let totalRequestedLitres = 0;
  let totalActualLitres = 0;

  for (const r of rows) {
    if (r.issue_id) fulfilledCount++;
    else if (r.request_status === 'PENDING' || r.request_status === 'APPROVED') pendingCount++;
    if (r.is_full_tank) fullTankCount++;
    if (r.recommended_litres > 0) totalRecommendedLitres += Number(r.recommended_litres);
    if (r.requested_litres > 0) totalRequestedLitres += Number(r.requested_litres);
    if (r.actual_litres > 0) totalActualLitres += Number(r.actual_litres);
    const rowFaulty = !!(r.issue_meter_faulty || r.request_meter_faulty);
    if (['OVER_RECOMMENDED', 'UNDER_RECOMMENDED', 'OVER_REQUESTED', 'METER_MISMATCH', 'METER_FAULTY'].includes(r.cross_check_status) || rowFaulty) {
      flaggedCount++;
    }
    if (r.cross_check_status === 'OVER_RECOMMENDED') overRecommendedCount++;
    if (r.cross_check_status === 'METER_MISMATCH') meterMismatchCount++;
    if (rowFaulty || r.cross_check_status === 'METER_FAULTY') meterFaultyCount++;
  }

  return {
    rows: rows.map((r) => ({
      ...r,
      is_full_tank: !!r.is_full_tank,
      meter_faulty: !!(r.issue_meter_faulty || r.request_meter_faulty),
      meter_fault_reason: r.issue_meter_fault_reason || r.request_meter_fault_reason || null,
    })),
    summary: {
      totalRequests: rows.length,
      fulfilledCount,
      pendingCount,
      fullTankCount,
      flaggedCount,
      overRecommendedCount,
      meterMismatchCount,
      meterFaultyCount,
      totalRecommendedLitres: round1(totalRecommendedLitres),
      totalRequestedLitres: round1(totalRequestedLitres),
      totalActualLitres: round1(totalActualLitres),
      netVarianceLitres: round1(totalActualLitres - totalRecommendedLitres),
    },
  };
}

async function buildCrossCheckWorkbook(report) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WorkshopOne Transport Fuel';
  wb.created = new Date();

  const ws = wb.addWorksheet('Transport Fuel Cross-Check');
  ws.columns = [
    { header: 'Request No', key: 'request_no', width: 16 },
    { header: 'Status', key: 'request_status', width: 13 },
    { header: 'Site / Project', key: 'project_name', width: 22 },
    { header: 'Pump / Station', key: 'pump_or_station', width: 22 },
    { header: 'Vehicle / Machine', key: 'asset_code', width: 16 },
    { header: 'Running Chart No', key: 'running_chart_no', width: 18 },
    { header: 'Driver', key: 'driver_name', width: 18 },
    { header: 'Prev Meter', key: 'prev_meter_reading', width: 12 },
    { header: 'Req Meter', key: 'request_meter_reading', width: 12 },
    { header: 'Meter Faulty?', key: 'meter_faulty_label', width: 13 },
    { header: 'Fault Reason', key: 'meter_fault_reason', width: 24 },
    { header: 'Approx KM/Hr', key: 'approx_km', width: 13 },
    { header: 'Recommended (L)', key: 'recommended_litres', width: 15 },
    { header: 'Trip Requested (L)', key: 'requested_litres', width: 16 },
    { header: 'Full Tank?', key: 'full_tank_label', width: 11 },
    { header: 'Issue No', key: 'issue_no', width: 16 },
    { header: 'Actual Issued (L)', key: 'actual_litres', width: 16 },
    { header: 'Variance vs Rec (L)', key: 'variance_litres', width: 17 },
    { header: 'Variance %', key: 'variance_pct', width: 12 },
    { header: 'Cross-Check Flag', key: 'cross_check_status', width: 18 },
    { header: 'Requested By', key: 'requester_name', width: 18 },
    { header: 'Pump Operator', key: 'operator_name', width: 18 },
    { header: 'Date', key: 'issue_or_req_date', width: 19 },
  ];

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };

  for (const r of report.rows || []) {
    const row = ws.addRow({
      ...r,
      meter_faulty_label: r.meter_faulty ? 'FAULTY' : 'OK',
      full_tank_label: r.is_full_tank ? 'FULL TANK' : 'FIXED',
      issue_or_req_date: r.issue_date || r.requested_at || '',
    });
    if (['OVER_RECOMMENDED', 'OVER_REQUESTED', 'METER_MISMATCH'].includes(r.cross_check_status)) {
      row.getCell('cross_check_status').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
      row.getCell('cross_check_status').font = { bold: true, color: { argb: 'FFB91C1C' } };
    } else if (r.cross_check_status === 'OK') {
      row.getCell('cross_check_status').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
      row.getCell('cross_check_status').font = { bold: true, color: { argb: 'FF15803D' } };
    }
  }

  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return wb.xlsx.writeBuffer();
}

module.exports = {
  APPROVAL_OVER_PCT,
  CROSS_CHECK_OVER_PCT,
  CROSS_CHECK_UNDER_PCT,
  calculateRecommendedFuel,
  computeCrossCheck,
  createTransportRequest,
  listTransportRequests,
  getRequestById,
  validateRequestForIssue,
  getCrossCheckReport,
  buildCrossCheckWorkbook,
};
