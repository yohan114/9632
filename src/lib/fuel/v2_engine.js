'use strict';

/**
 * Fuel-System-V2 Complete Domain & Analytics Engine for WorkshopOne (:1949)
 *
 * Ports all core logic from Fuel-System-V2-Ref:
 * 1. Meter Guard (rollback & spike validation against previous fuel reading)
 * 2. Fuel Issue Corrections / Adjustments (EDIT / VOID with tank stock & financial delta)
 * 3. Fuel Requests Queue (submit, approve, auto-dispense)
 * 4. Site Fuel Operator Console & Site Fuel Overview (with 6-month sparkline & budget pace)
 * 5. Vehicle-Wise 360° Fuel & Meter Profile (Consumption Band series, Meter timeline, PM & Filters)
 * 6. Fleet Fuel Consumption Health (Econ / Typ / Heavy band classification — OVER, HEAVY, NORMAL, BELOW_ECON, NO_METER)
 * 7. Dual-Basis Service & Filter Planner (higher of Recorded Meter vs Fuel-Derived Running)
 */

const { get, all, run, tx } = require('../../db');
const { deductStock, restoreStock } = require('./stock');
const fuelIssue = require('./issue');

// Normalize vehicle code / registration for fuzzy matching ("ZA 2609" === "ZA-2609")
function squashCode(s) {
  return String(s || '').trim().toUpperCase().replace(/[-\s/().]/g, '');
}

function resolveVehicle(codeOrId) {
  if (!codeOrId && codeOrId !== 0) return null;
  const raw = String(codeOrId).trim();
  if (/^\d+$/.test(raw)) {
    const byId = get('SELECT * FROM assets WHERE id = ?', Number(raw));
    if (byId) return byId;
  }
  const exact = get(
    'SELECT * FROM assets WHERE UPPER(code) = UPPER(?) OR UPPER(ec_code) = UPPER(?) OR UPPER(registration) = UPPER(?) LIMIT 1',
    raw, raw, raw
  );
  if (exact) return exact;

  const target = squashCode(raw);
  if (!target) return null;
  const candidates = all('SELECT * FROM assets WHERE status != ?', 'DISPOSED');
  return candidates.find(
    (a) => squashCode(a.code) === target || squashCode(a.ec_code) === target || squashCode(a.registration) === target
  ) || null;
}

function inferMeterType(asset, rateCard) {
  if (rateCard && rateCard.fuel_cons_basis === 'km') return 'KM';
  if (rateCard && rateCard.fuel_cons_basis === 'hr') return 'HOURS';
  const cat = String((asset && (asset.category || asset.type)) || '').toUpperCase();
  const code = String((asset && (asset.code || asset.ec_code)) || '').toUpperCase();
  if (
    /DUMP|TRUCK|CAB|BUS|BOWSER|LORRY|VAN|CAR|BIKE|MIXER|MOVER/.test(cat) ||
    /^(DT|DC|SC|HCC|TM|BD|DB|WB|BS|PV|BM|MB)-/.test(code)
  ) {
    return 'KM';
  }
  return 'HOURS';
}

function toDisplayRate(storageRate, basis) {
  if (storageRate == null || !Number.isFinite(storageRate) || storageRate <= 0) return null;
  return basis === 'km' ? 1 / storageRate : storageRate;
}

function classifyConsumption(actualStorageRate, econ, typ, heavy) {
  if (typ == null && heavy == null && econ == null) return 'NO_BAND';
  if (actualStorageRate == null || actualStorageRate <= 0) return 'NO_METER';
  if (heavy != null && actualStorageRate > heavy) return 'OVER';
  if (typ != null && actualStorageRate > typ) return 'HEAVY';
  if (econ != null && actualStorageRate < econ) return 'BELOW_ECON';
  return 'NORMAL';
}

// ---------------------------------------------------------------------------
// 1. Live Meter Guard
// ---------------------------------------------------------------------------
function checkMeterReading({ assetCode, assetId, vehicleCode, meterReading, meter, reading, issueDate, date } = {}) {
  const asset = resolveVehicle(assetCode || assetId || vehicleCode);
  if (!asset) {
    return {
      found: false,
      ok: true,
      warning: 'Vehicle not in master register (will record as unlinked ref)',
      asset: null,
      previous: null,
      band: null,
      consumptionBand: null,
    };
  }

  const rateCard = get('SELECT * FROM fleet_rental_rates WHERE asset_id = ? LIMIT 1', asset.id);
  const meterType = inferMeterType(asset, rateCard);
  const rawDate = issueDate || date;
  const targetDate = rawDate ? String(rawDate).slice(0, 19).replace('T', ' ') : '9999-12-31 23:59:59';

  // Most recent fuel-issue reading on or before targetDate
  const prevIssue = get(`
    SELECT meter_reading AS value, meter_reading AS reading, issue_date AS reading_date, issue_date AS date, 'FUEL_ISSUE' AS source
      FROM fuel_issues
     WHERE asset_id = ? AND is_voided = 0 AND meter_reading > 0 AND issue_date <= ?
     ORDER BY issue_date DESC, meter_reading DESC
     LIMIT 1
  `, asset.id, targetDate);

  const prevLog = get(`
    SELECT reading AS value, reading AS reading, reading_date, reading_date AS date, COALESCE(source, 'MANUAL') AS source
      FROM meter_readings
     WHERE asset_id = ? AND reading > 0 AND reading_date <= ?
     ORDER BY reading_date DESC, id DESC
     LIMIT 1
  `, asset.id, targetDate.slice(0, 10));

  const previous = prevIssue || prevLog || null;
  const rawReading = meterReading !== undefined ? meterReading : (meter !== undefined ? meter : reading);
  const val = rawReading != null && rawReading !== '' ? Number(rawReading) : null;

  const basis = (rateCard && rateCard.fuel_cons_basis) || (meterType === 'KM' ? 'km' : 'hr');
  const displayUnit = basis === 'km' ? 'km/L' : 'L/hr';
  const econDisp = rateCard && toDisplayRate(rateCard.fuel_cons_econ, basis) != null ? Math.round(toDisplayRate(rateCard.fuel_cons_econ, basis) * 100) / 100 : null;
  const typDisp = rateCard && toDisplayRate(rateCard.fuel_cons_typ, basis) != null ? Math.round(toDisplayRate(rateCard.fuel_cons_typ, basis) * 100) / 100 : null;
  const heavyDisp = rateCard && toDisplayRate(rateCard.fuel_cons_heavy, basis) != null ? Math.round(toDisplayRate(rateCard.fuel_cons_heavy, basis) * 100) / 100 : null;

  const band = rateCard ? {
    econ: econDisp,
    typ: typDisp,
    heavy: heavyDisp,
    rawEcon: rateCard.fuel_cons_econ,
    rawTyp: rateCard.fuel_cons_typ,
    rawHeavy: rateCard.fuel_cons_heavy,
    basis,
    unit: displayUnit,
    displayUnit,
    econDisplay: econDisp,
    typDisplay: typDisp,
    heavyDisplay: heavyDisp,
  } : null;

  if (val == null || isNaN(val) || val <= 0) {
    return {
      found: true,
      ok: true,
      asset: { id: asset.id, code: asset.code || asset.ec_code, registration: asset.registration, category: asset.category, meter_type: meterType },
      previous,
      band,
      consumptionBand: band,
      delta: null,
      warning: null,
    };
  }

  let ok = true;
  let warning = null;
  let delta = null;

  if (previous && previous.value > 0) {
    delta = Math.round((val - Number(previous.value)) * 10) / 10;
    if (val < Number(previous.value)) {
      ok = false;
      warning = `Reading ${val.toLocaleString()} is below last recorded reading ${Number(previous.value).toLocaleString()} (${String(previous.reading_date).slice(0, 10)}). Readings cannot go backwards unless meter was replaced.`;
    } else {
      const maxJump = meterType === 'KM' ? 5000 : 500;
      if (delta > maxJump) {
        warning = `Large meter jump detected (+${delta.toLocaleString()} ${meterType === 'KM' ? 'km' : 'hrs'} since ${String(previous.reading_date).slice(0, 10)}). Please verify digits.`;
      }
    }
  }

  return {
    found: true,
    ok,
    warning,
    delta,
    asset: { id: asset.id, code: asset.code || asset.ec_code, registration: asset.registration, category: asset.category, meter_type: meterType },
    previous,
    band,
    consumptionBand: band,
  };
}

// ---------------------------------------------------------------------------
// 2. Fuel Issue Corrections / Adjustments Workflow
// ---------------------------------------------------------------------------
function listCorrections({ status = 'ALL', site = 'ALL', search = '' } = {}) {
  const conds = [];
  const params = [];

  if (status && status !== 'ALL') {
    conds.push('UPPER(c.status) = UPPER(?)');
    params.push(status);
  }
  if (site && site !== 'ALL') {
    conds.push('(c.project_code = ? OR CAST(c.project_id AS TEXT) = ?)');
    params.push(site, site);
  }
  if (search) {
    conds.push('(c.asset_code LIKE ? OR c.reason LIKE ? OR c.project_name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const rows = all(`
    SELECT c.*,
           fi.issue_no,
           COALESCE(c.asset_code, fi.asset_code) AS vehicle_code,
           COALESCE(c.asset_code, fi.asset_code) AS asset_code,
           COALESCE(c.orig_issue_date, fi.issue_date) AS issue_date,
           COALESCE(c.orig_fuel_kind, fi.fuel_type, 'AUTO_DIESEL') AS fuel_kind,
           COALESCE(c.project_name, p.name, 'Central Workshop') AS site_name,
           COALESCE(c.project_name, p.name, 'Central Workshop') AS project_name,
           COALESCE(c.project_code, p.code, 'CW') AS site_code,
           COALESCE(u1.full_name, u1.username, 'Operator') AS requested_by_name,
           COALESCE(u1.full_name, u1.username, 'Operator') AS requester_name,
           COALESCE(u2.full_name, u2.username) AS approved_by_name,
           COALESCE(u2.full_name, u2.username) AS approver_name
      FROM fuel_corrections c
      LEFT JOIN fuel_issues fi ON fi.id = c.fuel_issue_id
      LEFT JOIN projects p ON p.id = COALESCE(c.project_id, fi.target_project_id, fi.project_id)
      LEFT JOIN users u1 ON u1.id = c.requested_by
      LEFT JOIN users u2 ON u2.id = c.approved_by
     ${where}
     ORDER BY CASE WHEN c.status = 'PENDING' THEN 0 ELSE 1 END, c.requested_at DESC
  `, ...params);

  const sites = all(`
    SELECT DISTINCT COALESCE(c.project_code, p.code, CAST(p.id AS TEXT)) AS code,
           COALESCE(c.project_name, p.name) AS name
      FROM fuel_corrections c
      LEFT JOIN fuel_issues fi ON fi.id = c.fuel_issue_id
      LEFT JOIN projects p ON p.id = COALESCE(c.project_id, fi.target_project_id, fi.project_id)
     WHERE COALESCE(c.project_name, p.name) IS NOT NULL
  `);

  const counts = {
    PENDING: (get("SELECT COUNT(*) n FROM fuel_corrections WHERE status = 'PENDING'") || {}).n || 0,
    APPROVED: (get("SELECT COUNT(*) n FROM fuel_corrections WHERE status = 'APPROVED'") || {}).n || 0,
    REJECTED: (get("SELECT COUNT(*) n FROM fuel_corrections WHERE status = 'REJECTED'") || {}).n || 0,
    ALL: (get('SELECT COUNT(*) n FROM fuel_corrections') || {}).n || 0,
  };

  return { rows, corrections: rows, sites, counts };
}

function createCorrection(payload, actorId = 1) {
  const {
    fuelIssueId,
    correctionType = 'EDIT',
    afterLitres = null,
    newLitres = null,
    afterMeter = null,
    newMeter = null,
    newFuelKind = null,
    newIssueDate = null,
    reason,
    evidenceFile = null,
    notes = null,
    autoApprove = false,
  } = payload;

  if (!fuelIssueId) throw new Error('fuelIssueId is required');
  if (!reason || !String(reason).trim()) throw new Error('A documented reason is required for fuel adjustment');

  const issue = get('SELECT * FROM fuel_issues WHERE id = ?', String(fuelIssueId));
  if (!issue) throw new Error('Fuel issue not found');

  const beforeLitres = Number(issue.litres) || 0;
  const beforeMeter = issue.meter_reading != null ? Number(issue.meter_reading) : null;
  const effLitres = afterLitres !== null && afterLitres !== undefined ? afterLitres : newLitres;
  const effMeter = afterMeter !== null && afterMeter !== undefined ? afterMeter : newMeter;
  const parsedAfterLitres = effLitres !== null && effLitres !== '' && effLitres !== undefined ? Number(effLitres) : beforeLitres;
  const parsedAfterMeter = effMeter !== null && effMeter !== '' && effMeter !== undefined ? Number(effMeter) : beforeMeter;

  const isVoid = String(correctionType).toUpperCase() === 'VOID';
  const stockDeltaLitres = isVoid ? beforeLitres : (beforeLitres - parsedAfterLitres);
  const unitCents = Number(issue.fuel_price_cents || issue.price_per_litre_cents || 34100);
  const financialDeltaCents = Math.round(-stockDeltaLitres * unitCents);

  const projId = issue.target_project_id || issue.project_id || issue.source_project_id || null;
  const proj = projId ? get('SELECT id, code, name FROM projects WHERE id = ?', projId) : null;

  const corrId = `corr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  tx(() => {
    run(`
      INSERT INTO fuel_corrections (
        id, fuel_issue_id, correction_type, before_litres, after_litres,
        before_meter, after_meter, stock_delta_litres, financial_delta_cents,
        reason, evidence_file, status, requested_by, requested_at, notes,
        asset_id, asset_code, project_id, project_code, project_name,
        orig_fuel_kind, new_fuel_kind, orig_issue_date, new_issue_date
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, 'PENDING', ?, datetime('now'), ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `, corrId, String(fuelIssueId), String(correctionType).toUpperCase(),
       beforeLitres, isVoid ? 0 : parsedAfterLitres,
       beforeMeter, parsedAfterMeter, stockDeltaLitres, financialDeltaCents,
       String(reason).trim(), evidenceFile || 'Running-Chart-Verified', actorId, notes || null,
       issue.asset_id, issue.asset_code, proj ? proj.id : projId, proj ? proj.code : null, proj ? proj.name : null,
       issue.fuel_type || issue.fuel_kind || 'AUTO_DIESEL', newFuelKind || null,
       issue.issue_date, newIssueDate || null);
  });

  if (autoApprove) {
    return reviewCorrection(corrId, { action: 'APPROVE', reviewNote: 'Auto-approved by authorized administrator' }, actorId);
  }

  return get('SELECT * FROM fuel_corrections WHERE id = ?', corrId);
}

function reviewCorrection(correctionId, { action, reviewNote }, actorId = 1) {
  const corr = get('SELECT * FROM fuel_corrections WHERE id = ?', String(correctionId));
  if (!corr) throw new Error('Correction record not found');
  if (corr.status !== 'PENDING') throw new Error(`Correction is already ${corr.status}`);

  const act = String(action || '').toUpperCase();
  if (act !== 'APPROVE' && act !== 'APPROVED' && act !== 'REJECT' && act !== 'REJECTED') {
    throw new Error('Action must be APPROVE or REJECT');
  }

  const isApprove = act.startsWith('APPROV');
  const issue = get('SELECT * FROM fuel_issues WHERE id = ?', String(corr.fuel_issue_id));

  return tx(() => {
    if (!isApprove) {
      run(`
        UPDATE fuel_corrections
           SET status = 'REJECTED',
               approved_by = ?,
               approved_at = datetime('now'),
               review_note = ?
         WHERE id = ?
      `, actorId, reviewNote || null, corr.id);
      return get('SELECT * FROM fuel_corrections WHERE id = ?', corr.id);
    }

    // Apply approval to fuel_issues and tank stock
    if (issue) {
      if (String(corr.correction_type).toUpperCase() === 'VOID') {
        if (!issue.is_voided) {
          fuelIssue.voidIssue(issue.id, `Approved Correction (${corr.id}): ${corr.reason}`, actorId);
        }
      } else {
        const newLitres = corr.after_litres != null ? Number(corr.after_litres) : Number(issue.litres);
        const newMeter = corr.after_meter != null ? Number(corr.after_meter) : issue.meter_reading;
        const newFuel = corr.new_fuel_kind || issue.fuel_type || 'AUTO_DIESEL';
        const newDate = corr.new_issue_date || issue.issue_date;
        const unitPrice = Number(issue.fuel_price_cents || issue.price_per_litre_cents || 34100);
        const newTotalCents = Math.round(newLitres * unitPrice);

        run(`
          UPDATE fuel_issues
             SET litres = ?,
                 meter_reading = ?,
                 fuel_type = ?,
                 fuel_kind = ?,
                 issue_date = ?,
                 total_cost_cents = ?,
                 cost_cents = ?,
                 total_price = ?,
                 updated_at = datetime('now')
           WHERE id = ?
        `, newLitres, newMeter, newFuel, newFuel, newDate, newTotalCents, newTotalCents, newTotalCents / 100, issue.id);

        // Adjust tank stock by stock_delta_litres (before - after)
        const tankId = issue.source_tank_id || issue.bulk_tank_id;
        const delta = Number(issue.litres) - newLitres;
        if (tankId && Math.abs(delta) > 0.001) {
          if (delta > 0) restoreStock(tankId, delta);
          else deductStock(tankId, Math.abs(delta));
        }

        // Update meter reading if changed
        if (newMeter && newMeter > 0 && issue.asset_id) {
          run(`
            INSERT INTO fuel_meter_readings (id, asset_id, asset_code, meter_reading, meter_type, reading_date, source, recorded_by)
            VALUES (?, ?, ?, ?, ?, ?, 'FUEL_CORRECTION', ?)
          `, `mr-corr-${Date.now()}`, issue.asset_id, issue.asset_code, newMeter, issue.meter_type || 'HOURS', newDate, actorId);
        }
      }
    }

    run(`
      UPDATE fuel_corrections
         SET status = 'APPROVED',
             approved_by = ?,
             approved_at = datetime('now'),
             review_note = ?
       WHERE id = ?
    `, actorId, reviewNote || 'Approved & applied', corr.id);

    return get('SELECT * FROM fuel_corrections WHERE id = ?', corr.id);
  });
}

// ---------------------------------------------------------------------------
// 3. Site Fuel Operators Console & Site Fuel Overview
// ---------------------------------------------------------------------------
function getSiteConsoleData(user, query = {}) {
  const userRow = user && user.id ? get('SELECT * FROM users WHERE id = ?', user.id) : null;
  const allTanks = all(`
    SELECT t.*, p.name AS project_name, p.code AS project_code
      FROM fuel_tanks t
      LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.active = 1
     ORDER BY t.name ASC
  `);

  const requestedTankId = query.tankId || (userRow && userRow.bulk_tank_id) || (allTanks[0] && allTanks[0].id);
  const selectedTank = allTanks.find((t) => String(t.id) === String(requestedTankId)) || allTanks[0] || null;
  const selectedProjectId = query.projectId
    ? Number(query.projectId)
    : (selectedTank && selectedTank.project_id) || (userRow && userRow.project_id) || null;

  const project = selectedProjectId ? get('SELECT * FROM projects WHERE id = ?', selectedProjectId) : null;
  const hideStock = !!(userRow && userRow.hide_stock && !(user.roles || []).includes('admin'));

  // Vehicles deployed to this site
  const siteVehicles = selectedProjectId ? all(`
    SELECT DISTINCT a.id, COALESCE(a.code, a.ec_code) AS code, a.registration, a.category, a.current_hours,
           fa.driver_name, fa.billing_type, fa.start_date
      FROM fleet_asset_assignments fa
      JOIN assets a ON a.id = fa.asset_id
     WHERE fa.project_id = ? AND (fa.end_date IS NULL OR fa.end_date >= date('now', '-60 days'))
     ORDER BY a.code ASC
  `, selectedProjectId) : [];

  // Recent issues from this tank or project
  const recentIssues = selectedTank ? all(`
    SELECT fi.*, COALESCE(u.full_name, u.username, fi.driver_name) AS issuer_name,
           (SELECT status FROM fuel_corrections fc WHERE fc.fuel_issue_id = fi.id ORDER BY fc.requested_at DESC LIMIT 1) AS correction_status
      FROM fuel_issues fi
      LEFT JOIN users u ON u.id = fi.issued_by
     WHERE (fi.source_tank_id = ? OR fi.bulk_tank_id = ? OR (? IS NOT NULL AND COALESCE(fi.target_project_id, fi.project_id) = ?))
     ORDER BY fi.issue_date DESC
     LIMIT 60
  `, String(selectedTank.id), String(selectedTank.id), selectedProjectId, selectedProjectId) : [];

  // Recent bulk deliveries into this tank
  const recentDeliveries = selectedTank ? all(`
    SELECT fd.*, COALESCE(u.full_name, u.username) AS receiver_name
      FROM fuel_bulk_deliveries fd
      LEFT JOIN users u ON u.id = fd.received_by
     WHERE fd.tank_id = ?
     ORDER BY fd.delivery_date DESC
     LIMIT 25
  `, String(selectedTank.id)) : [];

  const tankObj = selectedTank ? {
    ...selectedTank,
    current_litres: hideStock ? null : selectedTank.current_litres,
    hide_stock: hideStock,
  } : null;

  return {
    tank: tankObj,
    activeTank: tankObj,
    project,
    activeProject: project,
    hideStock,
    allTanks,
    tanks: allTanks,
    siteVehicles,
    recentIssues,
    recentDeliveries,
  };
}

function getSitesOverview({ month } = {}) {
  const targetMonth = month || '2026-08';
  const [yrStr, moStr] = targetMonth.split('-');
  const yr = Number(yrStr);
  const mo = Number(moStr);

  // Build 6-month window keys ending at targetMonth
  const sixMonths = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(yr, mo - 1 - i, 1));
    sixMonths.push(d.toISOString().slice(0, 7));
  }
  const earliestDate = sixMonths[0] + '-01';
  const latestDate = targetMonth + '-31 23:59:59';

  // Aggregate monthly fuel by project across the 6-month window
  const rawMonthly = all(`
    SELECT COALESCE(fi.target_project_id, fi.project_id, t.project_id, 0) AS project_id,
           substr(fi.issue_date, 1, 7) AS ym,
           COUNT(*) AS issue_count,
           COUNT(DISTINCT fi.asset_id) AS vehicle_count,
           ROUND(SUM(fi.litres), 1) AS litres,
           ROUND(SUM(CASE WHEN fi.source_tank_id IS NOT NULL OR fi.bulk_tank_id IS NOT NULL THEN fi.litres ELSE 0 END), 1) AS bowser_litres,
           ROUND(SUM(CASE WHEN fi.source_tank_id IS NULL AND fi.bulk_tank_id IS NULL THEN fi.litres ELSE 0 END), 1) AS external_litres,
           ROUND(SUM(COALESCE(fi.total_cost_cents, fi.cost_cents, fi.total_price * 100, 0)) / 100.0, 2) AS cost_lkr
      FROM fuel_issues fi
      LEFT JOIN fuel_tanks t ON t.id = COALESCE(fi.source_tank_id, fi.bulk_tank_id)
     WHERE fi.is_voided = 0 AND fi.issue_date >= ? AND fi.issue_date <= ?
     GROUP BY COALESCE(fi.target_project_id, fi.project_id, t.project_id, 0), substr(fi.issue_date, 1, 7)
  `, earliestDate, latestDate);

  const projects = all('SELECT id, code, name FROM projects ORDER BY name ASC');
  const projMap = new Map(projects.map((p) => [Number(p.id), p]));
  projMap.set(0, { id: 0, code: 'CW', name: 'Central Workshop / Unallocated' });

  const budgets = all('SELECT * FROM site_fuel_budgets WHERE year = ? AND month = ?', yr, mo);
  const budgetMap = new Map(budgets.map((b) => [Number(b.project_id), b]));

  const tanks = all('SELECT * FROM fuel_tanks WHERE active = 1');
  const tanksByProj = new Map();
  for (const t of tanks) {
    const pid = Number(t.project_id || 0);
    if (!tanksByProj.has(pid)) tanksByProj.set(pid, []);
    tanksByProj.get(pid).push(t);
  }

  // Group by project
  const bySite = new Map();
  for (const r of rawMonthly) {
    const pid = Number(r.project_id || 0);
    if (!bySite.has(pid)) {
      const p = projMap.get(pid) || { id: pid, code: `SITE-${pid}`, name: `Site #${pid}` };
      bySite.set(pid, {
        project_id: pid,
        project_code: p.code || `S-${pid}`,
        project_name: p.name,
        month_litres: 0,
        bowser_litres: 0,
        external_litres: 0,
        month_cost: 0,
        issue_count: 0,
        vehicle_count: 0,
        six_month_litres: 0,
        byMonth: new Map(),
      });
    }
    const entry = bySite.get(pid);
    entry.six_month_litres += r.litres || 0;
    entry.byMonth.set(r.ym, { litres: r.litres || 0, cost: r.cost_lkr || 0, issues: r.issue_count || 0, vehicles: r.vehicle_count || 0 });
    if (r.ym === targetMonth) {
      entry.month_litres = r.litres || 0;
      entry.bowser_litres = r.bowser_litres || 0;
      entry.external_litres = r.external_litres || 0;
      entry.month_cost = r.cost_lkr || 0;
      entry.issue_count = r.issue_count || 0;
      entry.vehicle_count = r.vehicle_count || 0;
    }
  }

  const sites = Array.from(bySite.values()).map((s) => {
    const sparkline = sixMonths.map((ym) => ({
      month: ym,
      litres: (s.byMonth.get(ym) && s.byMonth.get(ym).litres) || 0,
      cost: (s.byMonth.get(ym) && s.byMonth.get(ym).cost) || 0,
    }));
    const b = budgetMap.get(s.project_id);
    const budgetLitres = b ? b.budget_litres : null;
    const pctOfBudget = budgetLitres && budgetLitres > 0 ? Math.round((s.month_litres / budgetLitres) * 1000) / 10 : null;
    const siteTanks = tanksByProj.get(s.project_id) || [];
    const paceVerdict = !budgetLitres ? 'NO_BUDGET' : (pctOfBudget > 100 ? 'OVER' : (pctOfBudget >= 85 ? 'NEAR' : 'ON_TRACK'));
    const monthLitres = Math.round(s.month_litres * 10) / 10;
    const monthCost = Math.round(s.month_cost * 100) / 100;

    return {
      project_id: s.project_id,
      project_code: s.project_code,
      project_name: s.project_name,
      month_litres: monthLitres,
      litres: monthLitres,
      bowserLitres: Math.round((s.bowser_litres || 0) * 10) / 10,
      externalLitres: Math.round((s.external_litres || 0) * 10) / 10,
      month_cost: monthCost,
      costLkr: monthCost,
      issue_count: s.issue_count,
      issues: s.issue_count,
      vehicle_count: s.vehicle_count,
      vehicles: s.vehicle_count,
      six_month_litres: Math.round(s.six_month_litres * 10) / 10,
      budget_litres: budgetLitres,
      budgetLitres,
      budget_pct: pctOfBudget,
      budgetPct: pctOfBudget,
      budget_status: !budgetLitres ? 'NO_BUDGET' : (pctOfBudget > 100 ? 'OVER_BUDGET' : (pctOfBudget >= 85 ? 'WATCH' : 'ON_TRACK')),
      paceVerdict,
      sparkline,
      tanks: siteTanks,
    };
  }).sort((a, b) => b.month_litres - a.month_litres || b.six_month_litres - a.six_month_litres);

  const totalMonthLitres = Math.round(sites.reduce((s, r) => s + r.month_litres, 0) * 10) / 10;
  const totalMonthCost = Math.round(sites.reduce((s, r) => s + r.month_cost, 0) * 100) / 100;

  return {
    month: targetMonth,
    sixMonths,
    totalMonthLitres,
    totalMonthCost,
    totals: {
      litres: totalMonthLitres,
      costLkr: totalMonthCost,
    },
    sites,
    cards: sites,
  };
}

function getSiteMonthlySheet(projectId, month) {
  const targetMonth = month || '2026-08';
  const pid = Number(projectId || 0);
  const project = pid > 0 ? get('SELECT * FROM projects WHERE id = ?', pid) : { id: 0, code: 'CW', name: 'Central Workshop / Unallocated' };

  const issues = all(`
    SELECT fi.*, COALESCE(a.code, fi.asset_code) AS vehicle_code, a.registration, a.category,
           t.name AS tank_name
      FROM fuel_issues fi
      LEFT JOIN assets a ON a.id = fi.asset_id
      LEFT JOIN fuel_tanks t ON t.id = COALESCE(fi.source_tank_id, fi.bulk_tank_id)
     WHERE fi.is_voided = 0
       AND substr(fi.issue_date, 1, 7) = ?
       AND COALESCE(fi.target_project_id, fi.project_id, t.project_id, 0) = ?
     ORDER BY fi.asset_code ASC, fi.issue_date ASC
  `, targetMonth, pid);

  const byVehicle = new Map();
  for (const i of issues) {
    const key = i.vehicle_code || i.asset_code || 'UNKNOWN';
    if (!byVehicle.has(key)) {
      byVehicle.set(key, {
        asset_id: i.asset_id,
        asset_code: key,
        code: key,
        registration: i.registration || i.vehicle_ref || '-',
        category: i.category || '-',
        issue_count: 0,
        total_litres: 0,
        total_cost: 0,
        opening_meter: null,
        closing_meter: null,
        meter_type: i.meter_type || 'HOURS',
      });
    }
    const v = byVehicle.get(key);
    v.issue_count++;
    v.total_litres += Number(i.litres) || 0;
    v.total_cost += Number(i.total_cost_cents || i.cost_cents || (i.total_price ? i.total_price * 100 : 0)) / 100;
    if (i.meter_reading && Number(i.meter_reading) > 0) {
      const m = Number(i.meter_reading);
      if (v.opening_meter === null || m < v.opening_meter) v.opening_meter = m;
      if (v.closing_meter === null || m > v.closing_meter) v.closing_meter = m;
    }
  }

  const vehicles = Array.from(byVehicle.values()).map((v) => {
    const delta = v.opening_meter != null && v.closing_meter != null && v.closing_meter > v.opening_meter
      ? Math.round((v.closing_meter - v.opening_meter) * 10) / 10
      : 0;
    const rate = delta > 0 ? Math.round((v.total_litres / delta) * 100) / 100 : null;
    const totalLitres = Math.round(v.total_litres * 10) / 10;
    const totalCost = Math.round(v.total_cost * 100) / 100;
    return {
      ...v,
      fills: v.issue_count,
      total_litres: totalLitres,
      litres: totalLitres,
      total_cost: totalCost,
      costLkr: totalCost,
      minMeter: v.opening_meter,
      maxMeter: v.closing_meter,
      meter_delta: delta,
      meterSpan: delta,
      burn_rate: rate,
      measuredRate: rate,
      unit: v.meter_type === 'KM' ? 'L/km' : 'L/hr',
    };
  }).sort((a, b) => b.total_litres - a.total_litres);

  const totalLitres = Math.round(vehicles.reduce((s, v) => s + v.total_litres, 0) * 10) / 10;
  const totalCost = Math.round(vehicles.reduce((s, v) => s + v.total_cost, 0) * 100) / 100;

  return {
    project: project || { id: pid, code: `S-${pid}`, name: `Site #${pid}` },
    month: targetMonth,
    vehicles,
    issues,
    totalLitres,
    totalCost,
    totals: {
      litres: totalLitres,
      costLkr: totalCost,
      issues: issues.length,
      vehicles: vehicles.length,
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Vehicle-Wise 360° Fuel & Meter Profile
// ---------------------------------------------------------------------------
function getVehicle360Profile(codeOrId) {
  const asset = resolveVehicle(codeOrId);
  if (!asset) return null;

  const rateCard = get('SELECT * FROM fleet_rental_rates WHERE asset_id = ? LIMIT 1', asset.id);
  const meterType = inferMeterType(asset, rateCard);
  const basis = (rateCard && rateCard.fuel_cons_basis) || (meterType === 'KM' ? 'km' : 'hr');

  const assignment = get(`
    SELECT fa.*, p.name AS project_name, p.code AS project_code
      FROM fleet_asset_assignments fa
      LEFT JOIN projects p ON p.id = fa.project_id
     WHERE fa.asset_id = ?
     ORDER BY CASE WHEN fa.end_date IS NULL THEN 0 ELSE 1 END, fa.start_date DESC
     LIMIT 1
  `, asset.id);

  const issues = all(`
    SELECT fi.*, t.name AS tank_name, p.name AS project_name,
           COALESCE(u.full_name, u.username, fi.driver_name) AS issuer_name
      FROM fuel_issues fi
      LEFT JOIN fuel_tanks t ON t.id = COALESCE(fi.source_tank_id, fi.bulk_tank_id)
      LEFT JOIN projects p ON p.id = COALESCE(fi.target_project_id, fi.project_id, t.project_id)
      LEFT JOIN users u ON u.id = fi.issued_by
     WHERE fi.asset_id = ? OR UPPER(fi.asset_code) = UPPER(?)
     ORDER BY fi.issue_date DESC
     LIMIT 250
  `, asset.id, asset.code || asset.ec_code);

  // Combine meter readings from fuel_meter_readings, meter_readings, and fuel_issues
  const rawReadings = all(`
    SELECT reading_date AS date, meter_reading AS value, meter_reading AS reading, COALESCE(meter_type, '${meterType}') AS unit, meter_type, source, '' AS remarks, id
      FROM fuel_meter_readings
     WHERE asset_id = ? AND meter_reading > 0
    UNION ALL
    SELECT reading_date AS date, reading AS value, reading AS reading, COALESCE(meter_type, '${meterType}') AS unit, meter_type, COALESCE(source, 'MANUAL') AS source, COALESCE(notes, '') AS remarks, CAST(id AS TEXT) AS id
      FROM meter_readings
     WHERE asset_id = ? AND reading > 0
     ORDER BY date DESC, value DESC
     LIMIT 250
  `, asset.id, asset.id);

  // Compute fill-to-fill consumption series from chronological active issues with meter > 0
  const activeIssuesAsc = issues
    .filter((i) => !i.is_voided)
    .slice()
    .sort((a, b) => String(a.issue_date).localeCompare(String(b.issue_date)));

  const econ = rateCard ? rateCard.fuel_cons_econ : null;
  const typ = rateCard ? rateCard.fuel_cons_typ : null;
  const heavy = rateCard ? rateCard.fuel_cons_heavy : null;

  let totalLitres = 0;
  let totalCostCents = 0;
  let firstMeter = null;
  let lastMeter = null;
  const consumptionSeries = [];
  const monthlyMap = new Map();

  let prevMeterIssue = null;
  let accLitresBetweenMeters = 0;

  for (const i of activeIssuesAsc) {
    const l = Number(i.litres) || 0;
    const c = Number(i.total_cost_cents || i.cost_cents || (i.total_price ? i.total_price * 100 : 0));
    totalLitres += l;
    totalCostCents += c;

    const ym = String(i.issue_date || '').slice(0, 7);
    if (ym) {
      const m = monthlyMap.get(ym) || { month: ym, litres: 0, cost: 0, count: 0 };
      m.litres += l;
      m.cost += c / 100;
      m.count += 1;
      monthlyMap.set(ym, m);
    }

    accLitresBetweenMeters += l;
    const mVal = i.meter_reading != null ? Number(i.meter_reading) : 0;
    if (mVal > 0) {
      if (firstMeter === null) firstMeter = mVal;
      lastMeter = mVal;

      if (prevMeterIssue && mVal > prevMeterIssue.meter) {
        const delta = mVal - prevMeterIssue.meter;
        const minDelta = basis === 'km' ? 50 : 4;
        if (delta >= minDelta) {
          const storageRate = accLitresBetweenMeters / delta;
          const dispRate = toDisplayRate(storageRate, basis);
          const segVerdict = classifyConsumption(storageRate, econ, typ, heavy);
          consumptionSeries.push({
            date: String(i.issue_date).slice(0, 10),
            litres: Math.round(accLitresBetweenMeters * 10) / 10,
            meterStart: prevMeterIssue.meter,
            meterEnd: mVal,
            meterDelta: Math.round(delta * 10) / 10,
            deltaMeter: Math.round(delta * 10) / 10,
            storageRate: Math.round(storageRate * 1000) / 1000,
            displayRate: dispRate != null ? Math.round(dispRate * 100) / 100 : null,
            verdict: segVerdict,
          });
        }
        prevMeterIssue = { meter: mVal, date: i.issue_date };
        accLitresBetweenMeters = 0;
      } else if (!prevMeterIssue) {
        prevMeterIssue = { meter: mVal, date: i.issue_date };
        accLitresBetweenMeters = 0;
      }
    }
  }

  const runGrowth = firstMeter != null && lastMeter != null && lastMeter > firstMeter ? Math.round((lastMeter - firstMeter) * 10) / 10 : 0;
  const actualStorageRate = runGrowth > 0 && totalLitres > 0 ? totalLitres / runGrowth : null;
  const actualDisplayRate = toDisplayRate(actualStorageRate, basis);
  const state = classifyConsumption(actualStorageRate, econ, typ, heavy);

  const recommendedUnits = typ && typ > 0 && totalLitres > 0 ? Math.round((totalLitres / typ) * 10) / 10 : null;
  const variancePct = recommendedUnits && runGrowth > 0 ? Math.round(((runGrowth - recommendedUnits) / recommendedUnits) * 1000) / 10 : null;
  const meterVariance = recommendedUnits != null && runGrowth > 0 ? Math.round((runGrowth - recommendedUnits) * 10) / 10 : null;

  // Service & Filter status for this vehicle
  const serviceStatus = computeSingleVehicleService(asset, rateCard, totalLitres, lastMeter);

  // Fitted Filters & Lubricant Capacities
  let fittedFilters = [];
  try {
    fittedFilters = all(`
      SELECT fs.*, fc.part_number AS cat_part, fc.brand, fc.filter_type, fc.price
        FROM service_filter_specs fs
        LEFT JOIN filter_catalogue fc ON UPPER(fc.part_number) = UPPER(fs.part_number)
       WHERE fs.asset_id = ?
    `, asset.id);
  } catch (_) {}

  let lubricants = [];
  try {
    lubricants = all('SELECT * FROM vehicle_lubricant_capacities WHERE asset_id = ?', asset.id);
  } catch (_) {}

  let breakdowns = [];
  try {
    breakdowns = all(`
      SELECT id, job_no, date_in AS opened_at, date_out AS closed_at, status, priority,
             COALESCE(reported_defect, work_done, '') AS fault_description
        FROM job_cards
       WHERE asset_id = ?
       ORDER BY id DESC LIMIT 20
    `, asset.id);
  } catch (_) {}

  const displayUnit = basis === 'km' ? 'km/L' : 'L/hr';
  const econDisplay = toDisplayRate(econ, basis) != null ? Math.round(toDisplayRate(econ, basis) * 100) / 100 : null;
  const typDisplay = toDisplayRate(typ, basis) != null ? Math.round(toDisplayRate(typ, basis) * 100) / 100 : null;
  const heavyDisplay = toDisplayRate(heavy, basis) != null ? Math.round(toDisplayRate(heavy, basis) * 100) / 100 : null;
  const measuredDisplay = actualDisplayRate != null ? Math.round(actualDisplayRate * 100) / 100 : null;

  const statsObj = {
    totalLitres: Math.round(totalLitres * 10) / 10,
    totalCost: Math.round(totalCostCents) / 100,
    totalCostLkr: Math.round(totalCostCents) / 100,
    issueCount: activeIssuesAsc.length,
    totalIssues: activeIssuesAsc.length,
    firstMeter,
    lastMeter,
    latestMeter: lastMeter,
    runGrowth,
    recordedSpan: runGrowth,
    basis,
    displayUnit,
    actualStorageRate: actualStorageRate != null ? Math.round(actualStorageRate * 1000) / 1000 : null,
    actualDisplayRate: measuredDisplay,
    econDisplay,
    typDisplay,
    heavyDisplay,
    state,
    recommendedUnits,
    recommendedRunning: recommendedUnits,
    variancePct,
    meterVariance,
  };

  return {
    asset: {
      ...asset,
      code: asset.code || asset.ec_code,
      meter_type: meterType,
      current_site: assignment ? (assignment.project_name || assignment.project_code) : (asset.current_site || 'Central Workshop'),
      assignment,
    },
    allocation: assignment || null,
    rateCard: rateCard || null,
    metrics: statsObj,
    stats: statsObj,
    consumptionBand: {
      verdict: state,
      econ: econDisplay,
      typ: typDisplay,
      heavy: heavyDisplay,
      unit: displayUnit,
      measuredDisplay,
    },
    issues: issues.slice(0, 150),
    readings: rawReadings.slice(0, 150),
    meterReadings: rawReadings.slice(0, 150),
    consumptionSeries,
    fillSeries: consumptionSeries,
    monthlySeries: Array.from(monthlyMap.values()).sort((a, b) => a.month.localeCompare(b.month)),
    serviceStatus: {
      ...serviceStatus,
      status: serviceStatus.state,
      governingBasis: serviceStatus.usedSource === 'fuel' ? 'FUEL-DERIVED' : 'METER',
      usedSinceService: serviceStatus.usedSince,
      interval: serviceStatus.intervalValue,
    },
    pmTasks: serviceStatus.pmTasks || [],
    fittedFilters,
    lubricants,
    breakdowns,
  };
}

// ---------------------------------------------------------------------------
// 5. Dual-Basis Service & Filter Planner (Recorded Meter vs Fuel-Derived)
// ---------------------------------------------------------------------------
function computeSingleVehicleService(asset, rateCard, lifetimeLitres, latestMeter) {
  const meterType = inferMeterType(asset, rateCard);
  const defaultInterval = meterType === 'KM' ? 5000 : 500;
  const dueSoonThreshold = meterType === 'KM' ? 500 : 50;

  let lastService = null;
  try {
    lastService = get(`
      SELECT service_date, meter_reading AS meter_at_service, service_type, next_service_meter AS next_service_due_meter
        FROM service_jobs
       WHERE asset_id = ?
       ORDER BY service_date DESC, id DESC LIMIT 1
    `, asset.id);
  } catch (_) {}

  const intervalValue = (lastService && lastService.next_service_due_meter && lastService.meter_at_service && lastService.next_service_due_meter > lastService.meter_at_service)
    ? (lastService.next_service_due_meter - lastService.meter_at_service)
    : defaultInterval;

  const anchorDate = (lastService && lastService.service_date) || '2025-01-01';
  const meterAtService = (lastService && lastService.meter_at_service) || null;

  const fuelSinceRow = get(`
    SELECT COUNT(*) AS cnt, COALESCE(SUM(litres), 0) AS litres, MAX(meter_reading) AS max_meter
      FROM fuel_issues
     WHERE asset_id = ? AND is_voided = 0 AND issue_date >= ?
  `, asset.id, anchorDate);

  const fuelLitresSince = fuelSinceRow ? Number(fuelSinceRow.litres) || 0 : 0;
  const currentMeter = (fuelSinceRow && fuelSinceRow.max_meter) || latestMeter || asset.current_hours || null;

  const recordedSince = (meterAtService != null && currentMeter != null && currentMeter >= meterAtService)
    ? Math.round((currentMeter - meterAtService) * 10) / 10
    : null;

  const typ = rateCard && rateCard.fuel_cons_typ > 0 ? Number(rateCard.fuel_cons_typ) : (meterType === 'KM' ? 0.22 : 9.0);
  const fuelDerivedSince = fuelLitresSince > 0 && typ > 0 ? Math.round((fuelLitresSince / typ) * 10) / 10 : 0;

  // Higher of recorded meter growth and fuel-derived running
  const candidates = [recordedSince, fuelDerivedSince].filter((v) => v != null && v >= 0);
  const usedSince = candidates.length ? Math.max(...candidates) : null;
  const usedSource = usedSince == null ? 'none' : (recordedSince != null && recordedSince >= fuelDerivedSince ? 'meter' : 'fuel');
  const remaining = usedSince != null ? Math.round((intervalValue - usedSince) * 10) / 10 : null;

  let state = 'UNKNOWN';
  if (remaining != null) {
    if (remaining <= 0) state = 'OVERDUE';
    else if (remaining <= dueSoonThreshold) state = 'DUE_SOON';
    else state = 'OK';
  }

  const pmTasks = all('SELECT * FROM fuel_pm_tasks WHERE asset_id = ? LIMIT 20', asset.id);

  return {
    asset_id: asset.id,
    code: asset.code || asset.ec_code,
    registration: asset.registration,
    category: asset.category,
    basis: meterType,
    unit: meterType === 'KM' ? 'km' : 'hr',
    intervalValue,
    lastServiceDate: lastService ? lastService.service_date : null,
    meterAtService,
    currentMeter,
    recordedSince,
    fuelLitresSince: Math.round(fuelLitresSince * 10) / 10,
    fuelDerivedSince,
    usedSince,
    usedSource,
    remaining,
    state,
    pmTasks,
  };
}

function getFleetServicePlanner({ statusFilter = '', search = '', projectId = null } = {}) {
  // Fetch all active vehicles that have fuel issues, service records, or PM tasks
  const vehicles = all(`
    SELECT a.id, COALESCE(a.code, a.ec_code) AS code, a.registration, a.category, a.type, a.current_hours,
           COALESCE(p.name, 'Central') AS current_site,
           r.fuel_cons_econ, r.fuel_cons_typ, r.fuel_cons_heavy, r.fuel_cons_basis
      FROM assets a
      LEFT JOIN projects p ON p.id = a.current_project_id
      LEFT JOIN fleet_rental_rates r ON r.asset_id = a.id
     WHERE COALESCE(a.status, 'ACTIVE') != 'DISPOSED'
     ORDER BY a.code ASC
  `);

  // Pre-aggregate fuel issues & latest service per asset for fast bulk computation
  let lastServices = new Map();
  try {
    lastServices = new Map(
      all(`
        SELECT asset_id, MAX(service_date) AS service_date, MAX(meter_reading) AS meter_at_service, MAX(next_service_meter) AS next_due
          FROM service_jobs
         GROUP BY asset_id
      `).map((r) => [r.asset_id, r])
    );
  } catch (_) {}

  const fuelAgg = new Map(
    all(`
      SELECT asset_id, COUNT(*) AS cnt, SUM(litres) AS total_litres, MIN(meter_reading) AS min_m, MAX(meter_reading) AS max_m
        FROM fuel_issues
       WHERE is_voided = 0 AND asset_id IS NOT NULL
       GROUP BY asset_id
    `).map((r) => [r.asset_id, r])
  );

  const counts = { OVERDUE: 0, DUE_SOON: 0, OK: 0, UNKNOWN: 0, TRACKED: 0, ALL: 0 };
  const rows = [];

  for (const v of vehicles) {
    const f = fuelAgg.get(v.id);
    const ls = lastServices.get(v.id);
    if (!f && !ls) continue; // Only include active tracked fleet

    const meterType = inferMeterType(v, v);
    const intervalValue = (ls && ls.next_due && ls.meter_at_service && ls.next_due > ls.meter_at_service)
      ? (ls.next_due - ls.meter_at_service)
      : (meterType === 'KM' ? 5000 : 500);
    const dueSoonThreshold = meterType === 'KM' ? 500 : 50;

    const meterAtService = ls ? ls.meter_at_service : (f ? f.min_m : null);
    const currentMeter = (f && f.max_m) || v.current_hours || null;
    const recordedSince = (meterAtService != null && currentMeter != null && currentMeter >= meterAtService)
      ? Math.round((currentMeter - meterAtService) * 10) / 10
      : null;

    const fuelLitresSince = f ? Math.round((Number(f.total_litres) || 0) * 10) / 10 : 0;
    const typ = v.fuel_cons_typ > 0 ? Number(v.fuel_cons_typ) : (meterType === 'KM' ? 0.22 : 9.0);
    const fuelDerivedSince = fuelLitresSince > 0 ? Math.round((fuelLitresSince / typ) * 10) / 10 : null;

    const candidates = [recordedSince, fuelDerivedSince].filter((x) => x != null && x >= 0);
    const usedSince = candidates.length ? Math.max(...candidates) : null;
    const usedSource = usedSince == null ? 'none' : (recordedSince != null && recordedSince >= (fuelDerivedSince || 0) ? 'meter' : 'fuel');
    const remaining = usedSince != null ? Math.round((intervalValue - usedSince) * 10) / 10 : null;

    let state = 'UNKNOWN';
    if (remaining != null) {
      if (remaining <= 0) state = 'OVERDUE';
      else if (remaining <= dueSoonThreshold) state = 'DUE_SOON';
      else state = 'OK';
    }

    counts[state] = (counts[state] || 0) + 1;
    counts.TRACKED++;
    counts.ALL++;

    rows.push({
      asset_id: v.id,
      code: v.code,
      registration: v.registration,
      category: v.category,
      site: v.current_site || 'Central',
      current_site: v.current_site || 'Central',
      basis: meterType,
      meter_type: meterType,
      unit: meterType === 'KM' ? 'km' : 'hr',
      interval_value: intervalValue,
      interval: intervalValue,
      last_service_date: ls ? ls.service_date : null,
      meter_at_service: meterAtService,
      last_service_meter: meterAtService,
      current_meter: currentMeter,
      recorded_since: recordedSince,
      fuel_litres_since: fuelLitresSince,
      fuel_derived_since: fuelDerivedSince,
      used_since: usedSince,
      used_source: usedSource,
      governing_basis: usedSource === 'fuel' ? 'FUEL_DERIVED' : 'RECORDED',
      remaining,
      state,
      status: state,
    });
  }

  const STATE_RANK = { OVERDUE: 0, DUE_SOON: 1, OK: 2, UNKNOWN: 3 };
  rows.sort((a, b) => (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9) || (a.remaining ?? 999999) - (b.remaining ?? 999999));

  let filtered = rows;
  if (statusFilter && STATE_RANK[statusFilter] !== undefined) {
    filtered = filtered.filter((r) => r.state === statusFilter);
  }
  if (search) {
    const q = squashCode(search);
    filtered = filtered.filter((r) => squashCode(r.code).includes(q) || squashCode(r.registration).includes(q) || String(r.category || '').toUpperCase().includes(q));
  }

  return { counts, rows: filtered.slice(0, 250), items: filtered.slice(0, 250), totalMatched: filtered.length };
}

// ---------------------------------------------------------------------------
// 6. Interactive Fuel Consumption Graphs & Health Analytics
// ---------------------------------------------------------------------------
function getConsumptionAnalytics({ fromDate, toDate, projectId, month } = {}) {
  const targetMonth = month || (fromDate ? String(fromDate).slice(0, 7) : '2026-08');
  const start = fromDate || `${targetMonth}-01`;
  const end = (toDate || `${targetMonth}-31`) + ' 23:59:59';
  const pid = projectId ? Number(projectId) : null;

  const siteFilterSql = pid ? 'AND COALESCE(fi.target_project_id, fi.project_id, t.project_id) = ?' : '';
  const siteParams = pid ? [pid] : [];

  // 1. Daily trend in selected window
  const dailyTrend = all(`
    SELECT substr(fi.issue_date, 1, 10) AS day,
           ROUND(SUM(fi.litres), 1) AS litres,
           ROUND(SUM(COALESCE(fi.total_cost_cents, fi.cost_cents, fi.total_price * 100, 0)) / 100.0, 2) AS cost_lkr,
           ROUND(SUM(COALESCE(fi.total_cost_cents, fi.cost_cents, fi.total_price * 100, 0)) / 100.0, 2) AS costLkr,
           COUNT(*) AS issue_count,
           COUNT(*) AS issues
      FROM fuel_issues fi
      LEFT JOIN fuel_tanks t ON t.id = COALESCE(fi.source_tank_id, fi.bulk_tank_id)
     WHERE fi.is_voided = 0 AND fi.issue_date >= ? AND fi.issue_date <= ? ${siteFilterSql}
     GROUP BY substr(fi.issue_date, 1, 10)
     ORDER BY day ASC
  `, start, end, ...siteParams);

  // 2. Monthly trend across all available months
  const monthlyTrend = all(`
    SELECT substr(fi.issue_date, 1, 7) AS month,
           ROUND(SUM(fi.litres), 1) AS litres,
           ROUND(SUM(CASE WHEN fi.source_tank_id IS NOT NULL OR fi.bulk_tank_id IS NOT NULL THEN fi.litres ELSE 0 END), 1) AS bowser_litres,
           ROUND(SUM(CASE WHEN fi.source_tank_id IS NOT NULL OR fi.bulk_tank_id IS NOT NULL THEN fi.litres ELSE 0 END), 1) AS bowserLitres,
           ROUND(SUM(CASE WHEN fi.source_tank_id IS NULL AND fi.bulk_tank_id IS NULL THEN fi.litres ELSE 0 END), 1) AS external_litres,
           ROUND(SUM(CASE WHEN fi.source_tank_id IS NULL AND fi.bulk_tank_id IS NULL THEN fi.litres ELSE 0 END), 1) AS externalLitres,
           ROUND(SUM(COALESCE(fi.total_cost_cents, fi.cost_cents, fi.total_price * 100, 0)) / 100.0, 2) AS cost_lkr,
           ROUND(SUM(COALESCE(fi.total_cost_cents, fi.cost_cents, fi.total_price * 100, 0)) / 100.0, 2) AS costLkr,
           COUNT(*) AS issue_count,
           COUNT(*) AS issues
      FROM fuel_issues fi
      LEFT JOIN fuel_tanks t ON t.id = COALESCE(fi.source_tank_id, fi.bulk_tank_id)
     WHERE fi.is_voided = 0 AND fi.issue_date IS NOT NULL ${siteFilterSql}
     GROUP BY substr(fi.issue_date, 1, 7)
     ORDER BY month ASC
     LIMIT 12
  `, ...siteParams);

  // 2b. Site breakdown in selected window
  const bySite = all(`
    SELECT COALESCE(p.name, 'Central Workshop') AS project_name,
           ROUND(SUM(fi.litres), 1) AS litres,
           ROUND(SUM(COALESCE(fi.total_cost_cents, fi.cost_cents, fi.total_price * 100, 0)) / 100.0, 2) AS costLkr,
           COUNT(DISTINCT fi.asset_id) AS vehicles,
           COUNT(*) AS issues
      FROM fuel_issues fi
      LEFT JOIN fuel_tanks t ON t.id = COALESCE(fi.source_tank_id, fi.bulk_tank_id)
      LEFT JOIN projects p ON p.id = COALESCE(fi.target_project_id, fi.project_id, t.project_id)
     WHERE fi.is_voided = 0 AND fi.issue_date >= ? AND fi.issue_date <= ? ${siteFilterSql}
     GROUP BY COALESCE(p.name, 'Central Workshop')
     ORDER BY litres DESC
  `, start, end, ...siteParams);

  // 3. Per-vehicle consumption health on Econ-Typ-Heavy band
  const vehicleAgg = all(`
    SELECT fi.asset_id,
           COALESCE(a.code, a.ec_code, fi.asset_code) AS code,
           a.registration,
           a.category,
           COALESCE(p.name, 'Central') AS project_name,
           ROUND(SUM(fi.litres), 1) AS litres,
           ROUND(SUM(CASE WHEN fi.source_tank_id IS NOT NULL OR fi.bulk_tank_id IS NOT NULL THEN fi.litres ELSE 0 END), 1) AS bowser_litres,
           ROUND(SUM(CASE WHEN fi.source_tank_id IS NULL AND fi.bulk_tank_id IS NULL THEN fi.litres ELSE 0 END), 1) AS external_litres,
           COUNT(*) AS issue_count,
           ROUND(SUM(COALESCE(fi.total_cost_cents, fi.cost_cents, fi.total_price * 100, 0)) / 100.0, 2) AS cost_lkr,
           ROUND(SUM(COALESCE(fi.total_cost_cents, fi.cost_cents, fi.total_price * 100, 0)) / 100.0, 2) AS costLkr,
           MIN(CASE WHEN fi.meter_reading > 0 THEN fi.meter_reading ELSE NULL END) AS min_meter,
           MAX(CASE WHEN fi.meter_reading > 0 THEN fi.meter_reading ELSE NULL END) AS max_meter,
           r.fuel_cons_econ, r.fuel_cons_typ, r.fuel_cons_heavy, r.fuel_cons_basis
      FROM fuel_issues fi
      LEFT JOIN assets a ON a.id = fi.asset_id
      LEFT JOIN fuel_tanks t ON t.id = COALESCE(fi.source_tank_id, fi.bulk_tank_id)
      LEFT JOIN projects p ON p.id = COALESCE(fi.target_project_id, fi.project_id, t.project_id)
      LEFT JOIN fleet_rental_rates r ON r.asset_id = fi.asset_id
     WHERE fi.is_voided = 0 AND fi.issue_date >= ? AND fi.issue_date <= ? ${siteFilterSql}
     GROUP BY fi.asset_id, COALESCE(a.code, a.ec_code, fi.asset_code)
     ORDER BY litres DESC
  `, start, end, ...siteParams);

  const counts = { OVER: 0, HEAVY: 0, NORMAL: 0, BELOW_ECON: 0, NO_METER: 0, NO_BAND: 0 };
  const healthRows = [];

  for (const v of vehicleAgg) {
    const meterType = inferMeterType(v, v);
    const basis = v.fuel_cons_basis || (meterType === 'KM' ? 'km' : 'hr');
    const displayUnit = basis === 'km' ? 'km/L' : 'L/hr';
    const meterDelta = v.min_meter != null && v.max_meter != null && v.max_meter > v.min_meter
      ? Math.round((v.max_meter - v.min_meter) * 10) / 10
      : 0;
    const actualStorageRate = meterDelta > 0 ? v.litres / meterDelta : null;
    const state = classifyConsumption(actualStorageRate, v.fuel_cons_econ, v.fuel_cons_typ, v.fuel_cons_heavy);
    counts[state] = (counts[state] || 0) + 1;

    const severity = actualStorageRate != null && v.fuel_cons_typ > 0 ? Math.round((actualStorageRate / v.fuel_cons_typ) * 100) / 100 : 0;
    const pctOfTyp = actualStorageRate != null && v.fuel_cons_typ > 0 ? Math.round(((actualStorageRate - v.fuel_cons_typ) / v.fuel_cons_typ) * 100) : null;
    const measuredDisp = toDisplayRate(actualStorageRate, basis) != null ? Math.round(toDisplayRate(actualStorageRate, basis) * 100) / 100 : null;
    const econDisp = toDisplayRate(v.fuel_cons_econ, basis) != null ? Math.round(toDisplayRate(v.fuel_cons_econ, basis) * 100) / 100 : null;
    const typDisp = toDisplayRate(v.fuel_cons_typ, basis) != null ? Math.round(toDisplayRate(v.fuel_cons_typ, basis) * 100) / 100 : null;
    const heavyDisp = toDisplayRate(v.fuel_cons_heavy, basis) != null ? Math.round(toDisplayRate(v.fuel_cons_heavy, basis) * 100) / 100 : null;

    healthRows.push({
      asset_id: v.asset_id,
      code: v.code,
      registration: v.registration,
      category: v.category || 'Fleet',
      project_name: v.project_name,
      site: v.project_name,
      basis: meterType,
      unit: displayUnit,
      display_unit: displayUnit,
      litres: v.litres,
      cost_lkr: v.cost_lkr,
      costLkr: v.cost_lkr,
      meter_delta: meterDelta,
      meterSpan: meterDelta,
      actual_rate: actualStorageRate != null ? Math.round(actualStorageRate * 100) / 100 : null,
      actual_display: measuredDisp,
      measured: measuredDisp,
      econ: econDisp,
      typ: typDisp,
      heavy: heavyDisp,
      pctOfTyp,
      state,
      verdict: state,
      severity,
    });
  }

  const STATE_ORDER = { OVER: 0, HEAVY: 1, NORMAL: 2, BELOW_ECON: 3, NO_METER: 4, NO_BAND: 5 };
  healthRows.sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || b.severity - a.severity || b.litres - a.litres);

  const totalLitres = Math.round(vehicleAgg.reduce((s, r) => s + (r.litres || 0), 0) * 10) / 10;
  const totalCostLkr = Math.round(vehicleAgg.reduce((s, r) => s + (r.cost_lkr || 0), 0) * 100) / 100;
  const bowserLitres = Math.round(vehicleAgg.reduce((s, r) => s + (r.bowser_litres || 0), 0) * 10) / 10;
  const externalLitres = Math.round(vehicleAgg.reduce((s, r) => s + (r.external_litres || 0), 0) * 10) / 10;
  const totalIssues = vehicleAgg.reduce((s, r) => s + (r.issue_count || 0), 0);

  const healthObj = {
    counts,
    rows: healthRows,
    charted: healthRows.filter((r) => r.actual_rate != null && (r.econ != null || r.typ != null || r.heavy != null)),
    noMeter: healthRows.filter((r) => r.state === 'NO_METER'),
  };

  return {
    month: targetMonth,
    fromDate: start.slice(0, 10),
    toDate: end.slice(0, 10),
    totals: {
      litres: totalLitres,
      costLkr: totalCostLkr,
      issues: totalIssues,
      vehicles: vehicleAgg.length,
      bowserLitres,
      externalLitres,
    },
    dailyTrend,
    dailySeries: dailyTrend,
    monthlyTrend,
    monthlySeries: monthlyTrend,
    topVehicles: vehicleAgg.slice(0, 15),
    bySite,
    health: healthObj,
    fleetHealth: healthObj,
  };
}

module.exports = {
  squashCode,
  resolveVehicle,
  inferMeterType,
  checkMeterReading,
  listCorrections,
  createCorrection,
  reviewCorrection,
  getSiteConsoleData,
  getSitesOverview,
  getSiteMonthlySheet,
  getVehicle360Profile,
  getFleetServicePlanner,
  getConsumptionAnalytics,
};
