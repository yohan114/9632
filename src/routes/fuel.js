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
const { requireAuth, requireCap, hasCap } = require('../lib/auth');
const { asyncHandler } = require('../lib/http');
const fuelIssue = require('../lib/fuel/issue');
const fuelStock = require('../lib/fuel/stock');
const v2Engine = require('../lib/fuel/v2_engine');
const transportRequests = require('../lib/fuel/transport_requests');
const fuelScope = require('../lib/fuel/scope');
const ceypetcoSync = require('../lib/fuel/ceypetco_sync');
const fuelReprice = require('../lib/fuel/reprice');
const audit = require('../lib/audit');
const emitter = require('../lib/emitter');
const { attachVehicleLabels, resolveVehicleIdentity } = require('../lib/vehicle_label');

function currentMonthStr() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 7);
}

// ---------------------------------------------------------------------------
// 1. Live Meter Guard & Vehicle Lookup
// ---------------------------------------------------------------------------

router.get(
  '/meter-check',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel', 'fuel_transport', 'fuel_readings'],
    level: 'view',
    caps: ['fuel.view', 'fuel.console.view', 'fuel.issue', 'fuel.transport.view', 'fuel.transport.request', 'fuel.readings.view', 'fuel.readings.record'],
  }),
  asyncHandler(async (req, res) => {
    const result = v2Engine.checkMeterReading(req.query);
    res.json(result);
  })
);

// ---------------------------------------------------------------------------
// 2. Fuel Issues Register & Dispensing
// ---------------------------------------------------------------------------

router.get(
  '/issues',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel', level: 'view', caps: ['fuel.view', 'fuel.console.view', 'fuel.issue'] }),
  asyncHandler(async (req, res) => {
    const scope = fuelScope.getFuelScope(req.user);
    const { limit, offset, assetCode, tankId, projectId, fromDate, toDate, showVoided, search, sourceType, fuelType } = req.query;
    const result = fuelIssue.listIssues({
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
      assetCode,
      tankId: scope.scoped ? null : tankId,
      projectId: scope.scoped ? null : projectId,
      allowedTankIds: scope.scoped ? scope.allowedTankIds : null,
      scopedProjectId: scope.scoped ? scope.projectId : null,
      fromDate,
      toDate,
      showVoided: showVoided === 'true' || showVoided === '1',
      search,
      sourceType,
      fuelType,
    });
    res.json(result);
  })
);

router.get(
  '/issues/:id',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel', level: 'view', caps: ['fuel.view', 'fuel.console.view', 'fuel.issue'] }),
  asyncHandler(async (req, res) => {
    const rawIssue = get(`
      SELECT fi.*, t.name AS tank_name, sp.name AS source_project_name,
             COALESCE(tp.name, p.name) AS target_project_name,
             a.code AS asset_master_code, a.ec_code AS asset_ec_code, a.registration AS asset_registration,
             COALESCE(u.full_name, u.username) AS issuer_name, COALESCE(vu.full_name, vu.username) AS voider_name
        FROM fuel_issues fi
        LEFT JOIN fuel_tanks t ON t.id = COALESCE(fi.source_tank_id, fi.bulk_tank_id)
        LEFT JOIN projects sp ON sp.id = fi.source_project_id
        LEFT JOIN projects tp ON tp.id = fi.target_project_id
        LEFT JOIN projects p ON p.id = COALESCE(fi.project_id, t.project_id)
        LEFT JOIN assets a ON a.id = fi.asset_id
        LEFT JOIN users u ON u.id = fi.issued_by
        LEFT JOIN users vu ON vu.id = fi.voided_by
       WHERE fi.id = ?
    `, req.params.id);

    if (!rawIssue) return res.status(404).json({ error: 'Fuel issue not found' });
    fuelScope.assertIssueInScope(req.user, rawIssue, 'view this fuel issue');
    const issue = attachVehicleLabels(rawIssue);

    const corrections = all(`
      SELECT c.*, COALESCE(req.full_name, req.username) AS requester_name, COALESCE(app.full_name, app.username) AS approver_name
        FROM fuel_corrections c
        LEFT JOIN users req ON req.id = c.requested_by
        LEFT JOIN users app ON app.id = c.approved_by
       WHERE c.fuel_issue_id = ?
       ORDER BY c.requested_at DESC
    `, req.params.id);

    res.json({ issue, corrections });
  })
);

router.post(
  '/issues',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel', level: 'add', caps: ['fuel.issue'] }),
  asyncHandler(async (req, res) => {
    const actorId = req.user ? req.user.id : 1;
    const isAdmin = req.user && (req.user.roles || []).includes('admin');
    const scope = fuelScope.getFuelScope(req.user);

    const effReqId = req.body.fuelRequestId || req.body.requestId || null;
    const linkedReq = effReqId ? get('SELECT * FROM fuel_requests WHERE id = ?', String(effReqId)) : null;
    if (linkedReq && scope.scoped) {
      fuelScope.assertRequestInScope(req.user, linkedReq, 'dispense fuel for this request');
    }

    const targetTankId = req.body.sourceTankId !== undefined
      ? req.body.sourceTankId
      : (linkedReq && linkedReq.source_mode === 'TANK' ? linkedReq.target_tank_id : (scope.scoped ? scope.tankId : null));
    if (scope.scoped) {
      fuelScope.assertTankInScope(req.user, targetTankId, 'issue fuel from this tank');
    }

    // Enforce Meter Guard unless explicitly faulty or overridden by user with reason
    const bodyFaulty = !!(req.body.meterFaulty || req.body.meter_faulty);
    if (!bodyFaulty && req.body.meterReading && !req.body.ignoreMeterWarning) {
      const check = v2Engine.checkMeterReading({
        assetCode: req.body.assetCode || req.body.vehicleRef,
        meterReading: req.body.meterReading,
        issueDate: req.body.issueDate,
      });
      if (!check.ok) {
        return res.status(400).json({ error: check.warning, meterGuardFailed: true, previous: check.previous });
      }
    }

    const issue = fuelIssue.recordIssue({
      ...req.body,
      sourceTankId: targetTankId,
      allowSiteTransfer: isAdmin || hasCap(req.user, 'fuel.transfer'),
    }, actorId);

    try {
      audit.record({
        userId: actorId,
        entity: 'fuel_issue',
        entityId: null,
        action: 'fuel.issue.created',
        after: {
          issueId: issue.id,
          issueNo: issue.issue_no,
          assetCode: issue.asset_code,
          fuelType: issue.fuel_type,
          litres: issue.litres,
          fuelPriceCents: issue.fuel_price_cents,
          totalCostCents: issue.total_cost_cents,
        },
      });
    } catch (_) {}

    res.status(201).json(issue);
    try {
      emitter.emit('fuel_issue_updated', { action: 'created', id: issue.id, tankId: targetTankId });
      if (issue.fuel_request_id) {
        emitter.emit('fuel_request_updated', { action: 'fulfilled', id: issue.fuel_request_id, status: 'FULFILLED', targetTankId });
      }
    } catch (_) {}
  })
);

router.post(
  '/issues/:id/void',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel', level: 'edit', caps: ['fuel.void'] }),
  asyncHandler(async (req, res) => {
    const { reason } = req.body;
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'A valid documented reason is required to void this issue' });
    }

    const existing = get('SELECT * FROM fuel_issues WHERE id = ?', String(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Fuel issue not found' });
    fuelScope.assertIssueInScope(req.user, existing, 'void this fuel issue');

    const actorId = req.user ? req.user.id : 1;
    const result = fuelIssue.voidIssue(req.params.id, String(reason).trim(), actorId);

    try {
      audit.record({
        userId: actorId,
        entity: 'fuel_issue',
        entityId: null,
        action: 'fuel.issue.voided',
        after: { issueId: req.params.id },
        reason: String(reason).trim(),
      });
    } catch (_) {}

    res.json(result);
    try {
      emitter.emit('fuel_issue_updated', { action: 'voided', id: req.params.id });
      if (existing.fuel_request_id) {
        emitter.emit('fuel_request_updated', { action: 'reopened', id: existing.fuel_request_id, status: 'APPROVED' });
      }
    } catch (_) {}
  })
);

// ---------------------------------------------------------------------------
// 3. Fuel Issue Adjustments / Corrections Workflow
// ---------------------------------------------------------------------------

router.get(
  '/corrections',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: 'fuel',
    level: 'view',
    caps: ['fuel.view', 'fuel.console.view', 'fuel.correction.request', 'fuel.approve_correction'],
  }),
  asyncHandler(async (req, res) => {
    const scope = fuelScope.getFuelScope(req.user);
    const { status, site, search } = req.query;
    const result = v2Engine.listCorrections({
      status,
      site: scope.scoped ? 'ALL' : site,
      search,
      allowedTankIds: scope.scoped ? scope.allowedTankIds : null,
      scopedProjectId: scope.scoped ? scope.projectId : null,
      requestedBy: scope.scoped && req.user ? req.user.id : null,
    });
    res.json(result);
  })
);

router.post(
  '/corrections',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel', level: 'add', caps: ['fuel.correction.request', 'fuel.issue', 'fuel.correct'] }),
  asyncHandler(async (req, res) => {
    const actorId = req.user ? req.user.id : 1;
    const isAdmin = req.user && (req.user.roles || []).includes('admin');
    const issueId = req.body && req.body.fuelIssueId;
    if (issueId) {
      const issue = get('SELECT * FROM fuel_issues WHERE id = ?', String(issueId));
      if (issue) {
        fuelScope.assertIssueInScope(req.user, issue, 'request a change on this fuel issue');
      }
    }

    const created = v2Engine.createCorrection({
      ...req.body,
      autoApprove: isAdmin && !!req.body.autoApprove,
    }, actorId);

    try {
      audit.record({
        userId: actorId,
        entity: 'fuel_correction',
        entityId: null,
        action: 'fuel.correction.requested',
        after: {
          correctionId: created.id,
          fuelIssueId: created.fuel_issue_id,
          type: created.correction_type,
        },
      });
    } catch (_) {}

    res.status(201).json(created);
  })
);

router.post(
  '/corrections/:id/review',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel', level: 'edit', caps: ['fuel.approve_correction', 'fuel.correct'] }),
  asyncHandler(async (req, res) => {
    const actorId = req.user ? req.user.id : 1;
    const isAdmin = req.user && (req.user.roles || []).includes('admin');
    const corr = get('SELECT * FROM fuel_corrections WHERE id = ?', String(req.params.id));
    if (!corr) return res.status(404).json({ error: 'Correction record not found' });
    if (!isAdmin && Number(corr.requested_by) === Number(actorId)) {
      return res.status(403).json({
        error: 'Segregation of Duties: you cannot approve or review your own fuel change request. An Administrator must review it.',
      });
    }

    const updated = v2Engine.reviewCorrection(req.params.id, {
      action: req.body.action,
      reviewNote: req.body.reviewNote || req.body.review_note,
    }, actorId);

    try {
      audit.record({
        userId: actorId,
        entity: 'fuel_correction',
        entityId: null,
        action: 'fuel.correction.reviewed',
        after: {
          correctionId: req.params.id,
          status: updated.status,
        },
      });
    } catch (_) {}

    res.json(updated);
  })
);

// ---------------------------------------------------------------------------
// 4. Transport Fuel & Running Chart Requests Queue + Cross-Check ("No Request, No Issue")
// ---------------------------------------------------------------------------

router.get(
  '/transport-bootstrap',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_transport', 'fuel'],
    level: 'view',
    caps: ['fuel.transport.view', 'fuel.transport.request', 'fuel.view', 'fuel.console.view'],
  }),
  asyncHandler(async (req, res) => {
    const scope = fuelScope.getFuelScope(req.user);
    const rawTanks = all(`
      SELECT t.id, t.code, t.name, t.tank_type, t.fuel_type, t.capacity_litres, t.current_litres,
             t.project_id, p.name AS project_name, p.code AS project_code
        FROM fuel_tanks t
        LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.active = 1
       ORDER BY t.name ASC
    `);
    const rawProjects = all('SELECT id, code, name, location FROM projects WHERE COALESCE(active, 1) = 1 ORDER BY name ASC');

    const tanks = (scope.scoped
      ? rawTanks.filter((t) => scope.allowedTankIds && scope.allowedTankIds.includes(String(t.id)))
      : rawTanks
    ).map((t) => fuelScope.maskTankForUser(t, scope));

    const projects = scope.scoped
      ? (scope.projectId != null ? rawProjects.filter((p) => Number(p.id) === Number(scope.projectId)) : [])
      : rawProjects;

    const rawVehicles = all(`
      SELECT a.id, COALESCE(a.code, a.ec_code) AS code, a.ec_code, a.registration, a.category, a.type,
             a.current_hours, a.current_project_id, COALESCE(p.name, 'Central') AS current_site
        FROM assets a
        LEFT JOIN projects p ON p.id = a.current_project_id
       WHERE a.status != 'DISPOSED'
       ORDER BY a.code ASC
       LIMIT 3000
    `);
    const vehicles = rawVehicles.map((v) => {
      const id = resolveVehicleIdentity(v);
      return {
        ...v,
        ec_code: id.ec_code,
        registration: id.registration || v.registration,
        display: id.display,
      };
    });

    res.json({ tanks, projects, vehicles, fuelScope: scope });
  })
);

router.get(
  '/requests/pending-counts',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_transport', 'fuel'],
    level: 'view',
    caps: ['fuel.transport.view', 'fuel.transport.request', 'fuel.view', 'fuel.console.view', 'fuel.issue'],
  }),
  asyncHandler(async (req, res) => {
    const scope = fuelScope.getFuelScope(req.user);
    let condSql = '';
    const params = [];
    if (scope.scoped) {
      if (Array.isArray(scope.allowedTankIds) && scope.allowedTankIds.length > 0 && scope.projectId != null) {
        const marks = scope.allowedTankIds.map(() => '?').join(',');
        condSql = `AND (target_tank_id IN (${marks}) OR (target_tank_id IS NULL AND project_id = ?))`;
        params.push(...scope.allowedTankIds, Number(scope.projectId));
      } else if (Array.isArray(scope.allowedTankIds) && scope.allowedTankIds.length > 0) {
        const marks = scope.allowedTankIds.map(() => '?').join(',');
        condSql = `AND target_tank_id IN (${marks})`;
        params.push(...scope.allowedTankIds);
      } else if (scope.projectId != null) {
        condSql = 'AND project_id = ?';
        params.push(Number(scope.projectId));
      } else {
        return res.json({ pendingTransport: 0, pendingOverNorm: 0, approvedPump: 0 });
      }
    }
    const row = get(`
      SELECT
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pendingTransport,
        SUM(CASE WHEN status = 'PENDING' AND COALESCE(exceeds_norm, 0) = 1 THEN 1 ELSE 0 END) AS pendingOverNorm,
        SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END) AS approvedPump
      FROM fuel_requests
      WHERE 1 = 1 ${condSql}
    `, ...params) || {};
    res.json({
      pendingTransport: Number(row.pendingTransport || 0),
      pendingOverNorm: Number(row.pendingOverNorm || 0),
      approvedPump: Number(row.approvedPump || 0),
    });
  })
);

router.get(
  '/recommend-calc',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_transport', 'fuel'],
    level: 'view',
    caps: ['fuel.transport.view', 'fuel.transport.request', 'fuel.view'],
  }),
  asyncHandler(async (req, res) => {
    const result = transportRequests.calculateRecommendedFuel({
      assetCode: req.query.assetCode || req.query.vehicleCode,
      assetId: req.query.assetId,
      meterReading: req.query.meterReading,
      prevMeterReading: req.query.prevMeterReading,
      approxKm: req.query.approxKm,
      issueDate: req.query.issueDate,
    });
    res.json(result);
  })
);

router.get(
  '/requests',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_transport', 'fuel'],
    level: 'view',
    caps: ['fuel.transport.view', 'fuel.transport.request', 'fuel.view', 'fuel.console.view', 'fuel.issue'],
  }),
  asyncHandler(async (req, res) => {
    const scope = fuelScope.getFuelScope(req.user);
    const { status, projectId, tankId, assetCode, search, queueOnly, limit } = req.query;
    const rows = transportRequests.listTransportRequests({
      status: status || 'ALL',
      projectId: scope.scoped ? null : projectId,
      tankId: scope.scoped ? null : tankId,
      allowedTankIds: scope.scoped ? scope.allowedTankIds : null,
      scopedProjectId: scope.scoped ? scope.projectId : null,
      assetCode,
      search,
      queueOnly: queueOnly === '1' || queueOnly === 'true',
      limit,
    });
    res.json({ requests: rows });
  })
);

router.post(
  '/requests',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_transport', 'fuel'],
    level: 'add',
    caps: ['fuel.transport.request', 'fuel.request'],
  }),
  asyncHandler(async (req, res) => {
    const scope = fuelScope.getFuelScope(req.user);
    const body = { ...(req.body || {}) };
    const sourceMode = String(body.sourceMode || body.source_mode || 'TANK').toUpperCase() === 'STATION'
      ? 'STATION'
      : 'TANK';

    if (scope.scoped) {
      if (scope.unassigned) {
        return res.status(403).json({
          error: 'No fuel site or tank assigned to your account. Contact an Administrator before raising fuel requests.',
        });
      }
      if (sourceMode === 'TANK') {
        const reqTankId = body.targetTankId || body.tankId || body.sourceTankId || scope.tankId;
        fuelScope.assertTankInScope(req.user, reqTankId, 'raise a fuel request for this tank');
        body.targetTankId = reqTankId;
      }
      if (body.projectId != null && body.projectId !== '') {
        fuelScope.assertProjectInScope(req.user, body.projectId, 'raise a fuel request for this site');
      } else if (scope.projectId != null) {
        body.projectId = scope.projectId;
      }
    }

    const created = transportRequests.createTransportRequest(body, req.user);
    res.status(201).json(created);
    try {
      emitter.emit('fuel_request_updated', {
        action: 'created',
        id: created.id,
        requestNo: created.request_no,
        status: created.status,
        projectId: created.project_id,
        targetTankId: created.target_tank_id,
        requestedChannel: created.requested_channel,
      });
    } catch (_) {}
  })
);

router.post(
  '/requests/:id/review',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_transport', 'fuel'],
    level: 'edit',
    caps: ['fuel.approve_request', 'fuel.approve_site_request', 'fuel.approve'],
  }),
  asyncHandler(async (req, res) => {
    const { action, sourceTankId, targetTankId, dispenseNow, litres, meterReading, pumpLocation, issueDate } = req.body;
    const fr = get('SELECT * FROM fuel_requests WHERE id = ?', req.params.id);
    if (!fr) return res.status(404).json({ error: 'Fuel request not found' });

    const scope = fuelScope.getFuelScope(req.user);
    if (scope.scoped) {
      fuelScope.assertRequestInScope(req.user, fr, 'review this fuel request');
    }

    const actorId = req.user ? req.user.id : 1;
    const isAdmin = req.user && (req.user.roles || []).includes('admin');
    const isApprove = String(action || '').toUpperCase().startsWith('APPROV');

    const updatedReq = transportRequests.reviewTransportRequest(fr.id, req.body, req.user);
    if (!isApprove) {
      res.json(updatedReq);
      try {
        emitter.emit('fuel_request_updated', {
          action: 'rejected',
          id: fr.id,
          status: updatedReq.status,
          projectId: updatedReq.project_id,
          targetTankId: updatedReq.target_tank_id,
        });
      } catch (_) {}
      return;
    }

    let issued = null;
    if (dispenseNow) {
      if (!isAdmin && !hasCap(req.user, 'fuel.issue')) {
        return res.status(403).json({ error: 'Your role can approve requests to the pump queue, but cannot dispense fuel directly.' });
      }
      const qty = Number(litres != null ? litres : (updatedReq.approved_litres || updatedReq.requested_litres));
      if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ error: 'Actual dispensed litres (> 0) is required to dispense immediately (or approve to pump queue first)' });
      }
      const effTankId = sourceTankId || targetTankId || (updatedReq.source_mode === 'TANK' ? updatedReq.target_tank_id : null);
      if (scope.scoped) {
        fuelScope.assertTankInScope(req.user, effTankId, 'dispense fuel from this tank');
      }
      issued = fuelIssue.recordIssue({
        fuelRequestId: updatedReq.id,
        assetCode: updatedReq.asset_code,
        litres: qty,
        fuelType: updatedReq.fuel_type || 'AUTO_DIESEL',
        meterReading: meterReading != null ? meterReading : updatedReq.meter_reading,
        meterType: updatedReq.meter_type || 'HOURS',
        meterFaulty: req.body.meterFaulty !== undefined ? !!req.body.meterFaulty : !!updatedReq.meter_faulty,
        meterFaultReason: req.body.meterFaultReason || updatedReq.meter_fault_reason || null,
        sourceTankId: effTankId,
        targetProjectId: updatedReq.project_id || null,
        driverName: updatedReq.driver_name || null,
        stationName: updatedReq.station_name || null,
        pumpLocation: pumpLocation || null,
        issueDate: issueDate || null,
        allowSiteTransfer: isAdmin || hasCap(req.user, 'fuel.transfer'),
      }, actorId);
    }

    const finalReq = transportRequests.getRequestById(fr.id);
    res.json({ request: finalReq, issued });
    try {
      emitter.emit('fuel_request_updated', {
        action: issued ? 'fulfilled' : 'approved',
        id: fr.id,
        status: finalReq.status,
        projectId: finalReq.project_id,
        targetTankId: finalReq.target_tank_id,
      });
      if (issued) emitter.emit('fuel_issue_updated', { action: 'created', id: issued.id, tankId: issued.source_tank_id });
    } catch (_) {}
  })
);

router.post(
  '/requests/:id/issue',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel', level: 'add', caps: ['fuel.issue'] }),
  asyncHandler(async (req, res) => {
    const actorId = req.user ? req.user.id : 1;
    const isAdmin = req.user && (req.user.roles || []).includes('admin');
    const scope = fuelScope.getFuelScope(req.user);
    const fr = get('SELECT * FROM fuel_requests WHERE id = ?', req.params.id);
    if (!fr) return res.status(404).json({ error: 'Fuel request not found' });

    if (scope.scoped) {
      fuelScope.assertRequestInScope(req.user, fr, 'dispense fuel for this request');
    }

    const body = req.body || {};
    const effTankId = body.sourceTankId !== undefined
      ? body.sourceTankId
      : (fr.source_mode === 'TANK' ? fr.target_tank_id : null);
    if (scope.scoped && (fr.source_mode === 'TANK' || scope.isPumpOnly || effTankId)) {
      fuelScope.assertTankInScope(req.user, effTankId, 'dispense fuel from this tank');
    }

    const qty = Number(body.litres != null ? body.litres : (!fr.is_full_tank ? (fr.approved_litres || fr.requested_litres) : 0));
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: 'Actual dispensed fuel quantity (litres > 0) must be entered after filling' });
    }

    if (body.issueDate && !isAdmin) {
      const entryMs = new Date(body.issueDate).getTime();
      const minMs = Date.now() - 15 * 86400000;
      if (!isNaN(entryMs) && entryMs < minMs) {
        return res.status(400).json({ error: 'Site Fuel Operators can only backdate issues up to 14 days. Contact an Administrator for older entries.' });
      }
    }

    const meterVal = body.meterReading != null && body.meterReading !== '' ? body.meterReading : fr.meter_reading;
    const hasExplicitFaulty = body.meterFaulty !== undefined || body.meter_faulty !== undefined;
    const effFaulty = hasExplicitFaulty
      ? Boolean(body.meterFaulty || body.meter_faulty)
      : Boolean(fr.meter_faulty && !(body.meterReading != null && body.meterReading !== '' && Number(body.meterReading) > 0));
    const effFaultReason = effFaulty
      ? (body.meterFaultReason || body.meter_fault_reason || fr.meter_fault_reason || null)
      : null;

    if (!effFaulty && meterVal && !body.ignoreMeterWarning) {
      const check = v2Engine.checkMeterReading({
        assetCode: fr.asset_code,
        meterReading: meterVal,
        issueDate: body.issueDate,
      });
      if (!check.ok) {
        return res.status(400).json({ error: check.warning, meterGuardFailed: true, previous: check.previous });
      }
    }

    const issue = fuelIssue.recordIssue({
      ...body,
      fuelRequestId: fr.id,
      assetCode: fr.asset_code,
      litres: qty,
      fuelType: body.fuelType || fr.fuel_type || 'AUTO_DIESEL',
      meterReading: effFaulty ? null : meterVal,
      meterType: body.meterType || fr.meter_type || 'HOURS',
      meterFaulty: effFaulty,
      meterFaultReason: effFaultReason,
      sourceTankId: effTankId,
      targetProjectId: body.targetProjectId || fr.project_id || null,
      driverName: body.driverName || fr.driver_name || null,
      stationName: body.stationName || fr.station_name || null,
      allowSiteTransfer: isAdmin || hasCap(req.user, 'fuel.transfer'),
    }, actorId);

    try {
      audit.record({
        userId: actorId,
        entity: 'fuel_issue',
        entityId: issue.id,
        action: 'fuel.request.fulfilled',
        after: { requestId: fr.id, requestNo: fr.request_no, issueNo: issue.issue_no, litres: issue.litres, crossCheckStatus: issue.cross_check_status },
      });
    } catch (_) {}

    res.status(201).json({
      issue,
      request: transportRequests.getRequestById(fr.id),
    });
    try {
      emitter.emit('fuel_request_updated', { action: 'fulfilled', id: fr.id, status: 'FULFILLED', targetTankId: effTankId, projectId: fr.project_id });
      emitter.emit('fuel_issue_updated', { action: 'created', id: issue.id, tankId: effTankId });
    } catch (_) {}
  })
);

router.post(
  '/requests/:id/cancel',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_transport', 'fuel'],
    level: 'edit',
    caps: ['fuel.transport.request', 'fuel.request', 'fuel.approve_request', 'fuel.approve_site_request'],
  }),
  asyncHandler(async (req, res) => {
    const fr = get('SELECT * FROM fuel_requests WHERE id = ?', req.params.id);
    if (!fr) return res.status(404).json({ error: 'Fuel request not found' });
    fuelScope.assertRequestInScope(req.user, fr, 'cancel this fuel request');

    if (fr.status === 'FULFILLED') {
      return res.status(409).json({ error: 'Cannot cancel a request that has already been fulfilled; void the linked issue instead.' });
    }
    if (!['PENDING', 'APPROVED'].includes(fr.status)) {
      return res.status(409).json({ error: `Cannot cancel request in status '${fr.status}'` });
    }
    const actorId = req.user ? req.user.id : 1;
    run(`
      UPDATE fuel_requests
         SET status = 'CANCELLED', rejection_reason = COALESCE(?, rejection_reason, 'Cancelled')
       WHERE id = ?
    `, req.body && req.body.reason ? String(req.body.reason) : 'Cancelled', fr.id);
    try {
      audit.record({ userId: actorId, entity: 'fuel_request', entityId: fr.id, action: 'fuel.request.cancelled', reason: (req.body && req.body.reason) || 'Cancelled' });
    } catch (_) {}
    const cancelled = transportRequests.getRequestById(fr.id);
    res.json(cancelled);
    try {
      emitter.emit('fuel_request_updated', { action: 'cancelled', id: fr.id, status: 'CANCELLED', projectId: fr.project_id, targetTankId: fr.target_tank_id });
    } catch (_) {}
  })
);

router.get(
  '/cross-check',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_transport', 'fuel_reports'],
    level: 'view',
    caps: ['fuel.transport.crosscheck', 'fuel.reports.view'],
  }),
  asyncHandler(async (req, res) => {
    const scope = fuelScope.getFuelScope(req.user);
    const report = transportRequests.getCrossCheckReport({
      ...req.query,
      projectId: scope.scoped ? null : req.query.projectId,
      tankId: scope.scoped ? null : req.query.tankId,
      allowedTankIds: scope.scoped ? scope.allowedTankIds : null,
      scopedProjectId: scope.scoped ? scope.projectId : null,
    });
    res.json(report);
  })
);

router.get(
  '/cross-check.xlsx',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_transport', 'fuel_reports'],
    level: 'view',
    caps: ['fuel.transport.crosscheck', 'fuel.reports.view'],
  }),
  asyncHandler(async (req, res) => {
    const scope = fuelScope.getFuelScope(req.user);
    const report = transportRequests.getCrossCheckReport({
      ...req.query,
      projectId: scope.scoped ? null : req.query.projectId,
      tankId: scope.scoped ? null : req.query.tankId,
      allowedTankIds: scope.scoped ? scope.allowedTankIds : null,
      scopedProjectId: scope.scoped ? scope.projectId : null,
      limit: 1000,
    });
    const buf = await transportRequests.buildCrossCheckWorkbook(report);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="transport-fuel-crosscheck.xlsx"');
    res.send(Buffer.from(buf));
  })
);

// ---------------------------------------------------------------------------
// 5. Site Fuel Operators Console & Site Fuel Overview
// ---------------------------------------------------------------------------

router.get(
  '/site-console',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel', 'fuel_tanks'],
    level: 'view',
    caps: ['fuel.console.view', 'fuel.issue', 'fuel.tanks.refill', 'fuel.view'],
  }),
  asyncHandler(async (req, res) => {
    const data = v2Engine.getSiteConsoleData(req.user, req.query);
    res.json(data);
  })
);

router.post(
  '/site-console/issue',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel', level: 'add', caps: ['fuel.issue'] }),
  asyncHandler(async (req, res) => {
    const actorId = req.user ? req.user.id : 1;
    const isAdmin = req.user && (req.user.roles || []).includes('admin');
    const scope = fuelScope.getFuelScope(req.user);

    const effReqId = req.body.fuelRequestId || req.body.requestId || null;
    const linkedReq = effReqId ? get('SELECT * FROM fuel_requests WHERE id = ?', String(effReqId)) : null;
    if (linkedReq && scope.scoped) {
      fuelScope.assertRequestInScope(req.user, linkedReq, 'dispense fuel for this request');
    }

    const targetTankId = req.body.sourceTankId !== undefined
      ? req.body.sourceTankId
      : (linkedReq && linkedReq.source_mode === 'TANK' ? linkedReq.target_tank_id : (scope.scoped ? scope.tankId : null));
    if (scope.scoped) {
      fuelScope.assertTankInScope(req.user, targetTankId, 'issue fuel from this tank');
    }

    // 14-day backdate guard for non-admin Site Pump Operators (ported from Fuel-System-V2)
    if (req.body.issueDate && !isAdmin) {
      const entryMs = new Date(req.body.issueDate).getTime();
      const minMs = Date.now() - 15 * 86400000;
      if (!isNaN(entryMs) && entryMs < minMs) {
        return res.status(400).json({ error: 'Site Fuel Operators can only backdate issues up to 14 days. Contact an Administrator for older entries.' });
      }
    }

    const issue = fuelIssue.recordIssue({
      ...req.body,
      sourceTankId: targetTankId,
      allowSiteTransfer: isAdmin || hasCap(req.user, 'fuel.transfer'),
    }, actorId);
    res.status(201).json(issue);
    try {
      emitter.emit('fuel_issue_updated', { action: 'created', id: issue.id, tankId: targetTankId });
      if (issue.fuel_request_id) {
        emitter.emit('fuel_request_updated', { action: 'fulfilled', id: issue.fuel_request_id, status: 'FULFILLED', targetTankId });
      }
    } catch (_) {}
  })
);

router.post(
  '/site-console/refuel',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_tanks', 'fuel'],
    level: 'add',
    caps: ['fuel.tanks.refill'],
  }),
  asyncHandler(async (req, res) => {
    const actorId = req.user ? req.user.id : 1;
    const scope = fuelScope.getFuelScope(req.user);
    const body = req.body || {};
    const tankId = body.tankId || (scope.scoped ? scope.tankId : null);
    if (scope.scoped) {
      fuelScope.assertTankInScope(req.user, tankId, 'add received fuel delivery to this tank');
    }

    const litres = Number(body.litres != null ? body.litres : body.litresDelivered);
    const fuelType = body.fuelType || 'AUTO_DIESEL';
    const delDate = body.deliveryDate || new Date().toISOString().slice(0, 10);
    const unitCents = body.pricePerLitreCents
      ? Math.round(Number(body.pricePerLitreCents))
      : fuelIssue.getCurrentPrice(fuelType, delDate);
    const costCents = body.costCents != null
      ? Number(body.costCents)
      : Math.round((litres || 0) * unitCents);

    const result = fuelStock.recordBulkDelivery({
      tankId,
      litres,
      fuelType,
      supplier: body.supplier || body.supplierName,
      invoiceNumber: body.invoiceNumber || body.invoiceNo,
      costCents,
      deliveryDate: delDate,
      note: body.note || `Refuel @ Rs ${(unitCents / 100).toFixed(2)}/L`,
      receivedBy: actorId,
    });
    if (scope.hideStock) {
      res.status(201).json({ ...result, new_balance: null, hide_stock: true });
    } else {
      res.status(201).json(result);
    }
  })
);

router.get(
  '/sites-overview',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel_reports', level: 'view', caps: ['fuel.reports.view', 'fuel.all_sites'] }),
  asyncHandler(async (req, res) => {
    const data = v2Engine.getSitesOverview({ month: req.query.month });
    res.json(data);
  })
);

router.get(
  '/sites-overview/:projectId',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel_reports', level: 'view', caps: ['fuel.reports.view', 'fuel.all_sites'] }),
  asyncHandler(async (req, res) => {
    const data = v2Engine.getSiteMonthlySheet(req.params.projectId, req.query.month);
    res.json(data);
  })
);

router.get(
  '/budgets',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_reports', 'fuel_prices', 'fuel_tanks'],
    level: 'view',
    caps: ['fuel.reports.view', 'fuel.prices.view', 'fuel.prices.manage', 'fuel.tanks.manage', 'fuel.tanks.view'],
  }),
  asyncHandler(async (req, res) => {
    const targetMonth = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : currentMonthStr();
    const [yr, mo] = targetMonth.split('-').map(Number);

    const ymShift = (offset) => {
      const d = new Date(Date.UTC(yr, mo - 1 + offset, 1));
      return d.toISOString().slice(0, 7);
    };
    const prev1 = ymShift(-1);
    const prev2 = ymShift(-2);
    const prev3 = ymShift(-3);
    const prevList = [prev1, prev2, prev3];
    const allWindow = [...prevList, targetMonth];

    const warnRow = get("SELECT value FROM settings WHERE key = 'fuel.budget_warn_pct'");
    const warnPct = warnRow && Number.isFinite(Number(warnRow.value)) ? Number(warnRow.value) : 85;

    const usageRows = all(
      `SELECT COALESCE(fi.target_project_id, fi.project_id, t.project_id, 0) AS project_id,
              substr(fi.issue_date, 1, 7) AS ym,
              ROUND(SUM(fi.litres), 1) AS litres,
              ROUND(SUM(COALESCE(fi.total_cost_cents, fi.cost_cents, fi.total_price * 100, 0)) / 100.0, 2) AS cost_lkr
         FROM fuel_issues fi
         LEFT JOIN fuel_tanks t ON t.id = COALESCE(fi.source_tank_id, fi.bulk_tank_id)
        WHERE fi.is_voided = 0
          AND substr(fi.issue_date, 1, 7) IN (?, ?, ?, ?)
        GROUP BY COALESCE(fi.target_project_id, fi.project_id, t.project_id, 0), substr(fi.issue_date, 1, 7)`,
      ...allWindow
    );

    const usageMap = new Map();
    const activeUsagePids = new Set();
    for (const r of usageRows) {
      const pid = Number(r.project_id || 0);
      if (pid > 0) activeUsagePids.add(pid);
      let entry = usageMap.get(pid);
      if (!entry) {
        entry = { curLitres: 0, curCost: 0, prevLitres: 0, prev3Sum: 0 };
        usageMap.set(pid, entry);
      }
      if (r.ym === targetMonth) {
        entry.curLitres += r.litres || 0;
        entry.curCost += r.cost_lkr || 0;
      } else {
        entry.prev3Sum += r.litres || 0;
        if (r.ym === prev1) entry.prevLitres += r.litres || 0;
      }
    }

    const projects = all('SELECT id, code, name, active FROM projects ORDER BY active DESC, name ASC');
    const budgets = all('SELECT * FROM site_fuel_budgets WHERE year = ? AND month = ?', yr, mo);
    const budgetMap = new Map(budgets.map((b) => [Number(b.project_id), b]));

    const items = [];
    for (const p of projects) {
      const hasBudget = budgetMap.has(p.id);
      if (p.active === 0 && !activeUsagePids.has(p.id) && !hasBudget) continue;
      const u = usageMap.get(p.id) || { curLitres: 0, curCost: 0, prevLitres: 0, prev3Sum: 0 };
      const b = budgetMap.get(p.id);
      const budgetLitres = b && b.budget_litres != null ? Number(b.budget_litres) : null;
      const avg3m = Math.round((u.prev3Sum / 3) * 10) / 10;
      const suggested = avg3m > 0 ? Math.ceil((avg3m * 1.1) / 100) * 100 : null;
      const actualLitres = Math.round(u.curLitres * 10) / 10;
      const pct = budgetLitres && budgetLitres > 0 ? Math.round((actualLitres / budgetLitres) * 1000) / 10 : null;
      const paceVerdict = !budgetLitres || budgetLitres <= 0
        ? 'NO_BUDGET'
        : (pct > 100 ? 'OVER' : (pct >= warnPct ? 'NEAR' : 'ON_TRACK'));

      items.push({
        project_id: p.id,
        project_code: p.code || `SITE-${p.id}`,
        project_name: p.name,
        active: p.active !== 0,
        year: yr,
        month: mo,
        budget_litres: budgetLitres,
        budget_amount_cents: b ? b.budget_amount_cents : null,
        note: b ? b.note : null,
        actual_litres: actualLitres,
        actual_cost_lkr: Math.round(u.curCost * 100) / 100,
        prev_month_litres: Math.round(u.prevLitres * 10) / 10,
        avg_3m_litres: avg3m,
        suggested_budget_litres: suggested,
        budget_pct: pct,
        pace_verdict: paceVerdict,
      });
    }

    items.sort((a, b) => (b.actual_litres - a.actual_litres) || (b.avg_3m_litres - a.avg_3m_litres) || a.project_name.localeCompare(b.project_name));

    const summary = {
      total_sites: items.length,
      budgeted_sites: items.filter((i) => i.budget_litres > 0).length,
      on_track: items.filter((i) => i.pace_verdict === 'ON_TRACK').length,
      watch: items.filter((i) => i.pace_verdict === 'NEAR').length,
      over_budget: items.filter((i) => i.pace_verdict === 'OVER').length,
      unbudgeted_active: items.filter((i) => i.pace_verdict === 'NO_BUDGET' && (i.actual_litres > 0 || i.avg_3m_litres > 0)).length,
    };

    res.json({ month: targetMonth, year: yr, month_num: mo, prev_month: prev1, warn_pct: warnPct, summary, items });
  })
);

router.post(
  '/budgets',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_prices', 'fuel_tanks'],
    level: 'edit',
    caps: ['fuel.prices.manage', 'fuel.tanks.manage'],
  }),
  asyncHandler(async (req, res) => {
    const { projectId, year, month, budgetLitres, budgetAmountCents, note } = req.body;
    if (projectId == null || !year || !month) {
      return res.status(400).json({ error: 'projectId, year, and month are required' });
    }
    const actorId = req.user ? req.user.id : 1;
    const litres = budgetLitres != null ? Number(budgetLitres) : null;
    const activeDieselCents = fuelIssue.getCurrentPrice('AUTO_DIESEL');
    const cents = budgetAmountCents != null ? Number(budgetAmountCents) : (litres ? Math.round(litres * activeDieselCents) : null);

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
  })
);

router.post(
  '/budgets/bulk',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_prices', 'fuel_tanks'],
    level: 'edit',
    caps: ['fuel.prices.manage', 'fuel.tanks.manage'],
  }),
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    let yr = Number(body.year);
    let mo = Number(body.month);
    if ((!yr || !mo) && /^\d{4}-\d{2}$/.test(String(body.targetMonth || body.month || ''))) {
      const parts = String(body.targetMonth || body.month).split('-').map(Number);
      yr = parts[0];
      mo = parts[1];
    }
    if (!yr || !mo || mo < 1 || mo > 12) {
      return res.status(400).json({ error: 'Valid year and month (or targetMonth YYYY-MM) are required' });
    }

    const actorId = req.user ? req.user.id : 1;
    const activeDieselCents = fuelIssue.getCurrentPrice('AUTO_DIESEL');
    let savedCount = 0;

    if (body.copyFromMonth) {
      if (!/^\d{4}-\d{2}$/.test(String(body.copyFromMonth))) {
        return res.status(400).json({ error: 'copyFromMonth must be YYYY-MM' });
      }
      const [srcYr, srcMo] = String(body.copyFromMonth).split('-').map(Number);
      const srcRows = all(
        'SELECT * FROM site_fuel_budgets WHERE year = ? AND month = ? AND budget_litres IS NOT NULL AND budget_litres > 0',
        srcYr, srcMo
      );
      tx(() => {
        for (const r of srcRows) {
          const litres = Number(r.budget_litres);
          const cents = Math.round(litres * activeDieselCents);
          run(`
            INSERT INTO site_fuel_budgets (project_id, year, month, budget_litres, budget_amount_cents, note, created_by, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(project_id, year, month) DO UPDATE SET
              budget_litres = excluded.budget_litres,
              budget_amount_cents = excluded.budget_amount_cents,
              note = excluded.note,
              updated_at = datetime('now')
          `, r.project_id, yr, mo, litres, cents, r.note || `Copied from ${body.copyFromMonth}`, actorId);
          savedCount += 1;
        }
      });
    } else {
      const items = Array.isArray(body.items) ? body.items : null;
      if (!items || !items.length) {
        return res.status(400).json({ error: 'items array (or copyFromMonth) is required' });
      }
      if (items.length > 200) {
        return res.status(400).json({ error: 'Cannot save more than 200 site budgets at once' });
      }
      tx(() => {
        for (const it of items) {
          const pid = Number(it && (it.projectId != null ? it.projectId : it.project_id));
          if (!pid) continue;
          const rawVal = it.budgetLitres !== undefined ? it.budgetLitres : it.budget_litres;
          if (rawVal === null || rawVal === '' || rawVal === undefined) {
            run('DELETE FROM site_fuel_budgets WHERE project_id = ? AND year = ? AND month = ?', pid, yr, mo);
            continue;
          }
          const litres = Number(rawVal);
          if (!Number.isFinite(litres) || litres < 0) {
            const err = new Error(`Invalid budget litres for project #${pid}`);
            err.status = 400;
            throw err;
          }
          const cents = Math.round(litres * activeDieselCents);
          run(`
            INSERT INTO site_fuel_budgets (project_id, year, month, budget_litres, budget_amount_cents, note, created_by, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(project_id, year, month) DO UPDATE SET
              budget_litres = excluded.budget_litres,
              budget_amount_cents = excluded.budget_amount_cents,
              note = excluded.note,
              updated_at = datetime('now')
          `, pid, yr, mo, litres, cents, it.note || null, actorId);
          savedCount += 1;
        }
      });
    }

    try {
      audit.record({
        userId: actorId,
        entity: 'site_fuel_budget',
        entityId: null,
        action: 'bulk_save',
        after: { year: yr, month: mo, saved_count: savedCount, copyFromMonth: body.copyFromMonth || null },
      });
    } catch (_) {}

    res.json({ ok: true, year: yr, month: mo, saved_count: savedCount });
  })
);

// ---------------------------------------------------------------------------
// 6. Vehicle-Wise 360° Fuel & Meter Profile + Fleet Directory
// ---------------------------------------------------------------------------

router.get(
  '/fleet-directory',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_reports', 'fuel_transport'],
    level: 'view',
    caps: ['fuel.reports.view', 'fuel.transport.view', 'fuel.all_sites'],
  }),
  asyncHandler(async (req, res) => {
    const { search = '', category = '', site = '' } = req.query;
    const rows = all(`
      SELECT a.id, COALESCE(a.code, a.ec_code) AS code, a.ec_code, a.registration, a.category, a.type, a.status,
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
    `).map((v) => {
      const id = resolveVehicleIdentity(v);
      return {
        ...v,
        ec_code: id.ec_code,
        registration: id.registration || v.registration,
        display: id.display,
      };
    });

    let filtered = rows;
    if (search) {
      const q = v2Engine.squashCode(search);
      filtered = filtered.filter((r) =>
        v2Engine.squashCode(r.code).includes(q) ||
        v2Engine.squashCode(r.ec_code).includes(q) ||
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
  })
);

router.get(
  ['/vehicle-profile', '/vehicle-profile/:code'],
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_reports', 'fuel_transport'],
    level: 'view',
    caps: ['fuel.reports.view', 'fuel.transport.view', 'fuel.all_sites'],
  }),
  asyncHandler(async (req, res) => {
    const code = req.params.code || req.query.code || req.query.asset_id;
    if (!code) return res.status(400).json({ error: 'Vehicle code or asset_id is required' });

    const profile = v2Engine.getVehicle360Profile(code);
    if (!profile) return res.status(404).json({ error: `Vehicle not found: ${code}` });

    res.json(profile);
  })
);

// ---------------------------------------------------------------------------
// 7. Interactive Fuel Consumption Graphs & Health Analytics
// ---------------------------------------------------------------------------

router.get(
  '/analytics/consumption',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel_reports', level: 'view', caps: ['fuel.reports.view'] }),
  asyncHandler(async (req, res) => {
    const { fromDate, toDate, projectId, month } = req.query;
    const data = v2Engine.getConsumptionAnalytics({ fromDate, toDate, projectId, month });
    res.json(data);
  })
);

// ---------------------------------------------------------------------------
// 8. Dual-Basis Service & Filter Planner
// ---------------------------------------------------------------------------

router.get(
  '/service-planner',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_reports', 'service_plan', 'services'],
    level: 'view',
    caps: ['fuel.reports.view', 'services.view', 'service_plan.view'],
  }),
  asyncHandler(async (req, res) => {
    const { status, q, search, projectId, month } = req.query;
    const servicePlanEngine = require('../lib/service_plan_engine');
    const plan = servicePlanEngine.buildAdvancedServicePlan({
      month,
      includeOk: true,
      includeLongOverdue: true,
      site: projectId ? (get('SELECT name FROM projects WHERE id = ?', projectId)?.name || '') : '',
      search: q || search || '',
    });

    const allRows = [
      ...(plan.breakdown_opportunities || []),
      ...(plan.carry || []),
      ...(plan.due || []),
      ...(plan.on_breakdown || []),
      ...(plan.ok || []),
      ...(plan.parked || []),
    ];

    const mapped = allRows.map((v) => ({
      asset_id: v.asset_id,
      code: v.asset_code,
      registration: v.asset_reg,
      ec_code: v.asset_ec,
      category: v.category,
      site: v.site || 'Central',
      current_site: v.site || 'Central',
      basis: v.meter_type,
      meter_type: v.meter_type,
      unit: v.unit,
      interval_value: v.interval,
      interval: v.interval,
      last_service_date: v.last_service,
      meter_at_service: v.last_service_meter,
      last_service_meter: v.last_service_meter,
      current_meter: v.timing ? v.timing.current_meter : null,
      recorded_since: v.timing ? v.timing.recorded_since : 0,
      fuel_litres_since: v.fuel ? v.fuel.litres_since_service : 0,
      fuel_derived_since: v.timing ? v.timing.fuel_derived_since : 0,
      used_since: v.timing ? v.timing.used_since : 0,
      used_source: v.timing ? v.timing.used_source : 'meter',
      governing_basis: v.timing && v.timing.used_source === 'fuel' ? 'FUEL_DERIVED' : 'RECORDED',
      remaining: v.timing ? v.timing.remaining_units : null,
      projected_due_date: v.timing ? v.timing.projected_due_date : null,
      active_rate_per_day: v.timing ? v.timing.active_rate_per_day : null,
      sites_count_since: v.fuel ? v.fuel.sites_count_since : 0,
      breakdown_days_in_month: v.breakdowns ? v.breakdowns.breakdown_days_in_month : 0,
      next_service_seq: v.next_service_seq,
      wanted_filters: v.wanted_filters || [],
      clean_filters: v.clean_filters || [],
      skipped_filters: v.skipped_filters || [],
      state: v.state,
      status: v.state,
    }));

    const wantedStatus = status ? String(status).toUpperCase() : '';
    const rows = wantedStatus
      ? mapped.filter((r) => r.state === wantedStatus || (wantedStatus === 'OVERDUE' && r.state === 'SERVICE_ON_BREAKDOWN'))
      : mapped;

    const counts = {
      ALL: mapped.length,
      TRACKED: plan.fleet ? plan.fleet.tracked : mapped.length,
      OVERDUE: (plan.totals && plan.totals.overdue) || 0,
      DUE_SOON: (plan.totals && plan.totals.due_in_month) || 0,
      SERVICE_ON_BREAKDOWN: (plan.totals && plan.totals.service_on_breakdown) || 0,
      ON_BREAKDOWN: (plan.totals && plan.totals.on_breakdown) || 0,
      OK: (plan.totals && plan.totals.ok) || 0,
      UNKNOWN: (plan.totals && plan.totals.parked) || 0,
    };

    res.json({
      month: plan.month,
      as_of: plan.as_of,
      rule_version: plan.rule_version,
      counts,
      rows,
      vehicles: rows,
    });
  })
);

router.post('/service-planner/quick-log', requireAuth, requireCap('services.create', 'service_plan.manage'), asyncHandler(async (req, res) => {
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

router.get(
  '/prices',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel_prices', level: 'view', caps: ['fuel.prices.view', 'fuel.prices.manage'] }),
  asyncHandler(async (req, res) => {
    const rows = all(`
      SELECT fp.*,
             COALESCE(
               u.full_name,
               u.username,
               CASE
                 WHEN fp.source LIKE 'CEYPETCO_AUTO%' OR fp.source LIKE 'Auto-fetched%' OR fp.source LIKE 'Historical price%'
                 THEN 'Ceypetco Auto-Sync'
                 ELSE NULL
               END
             ) AS creator_name
        FROM fuel_prices fp
        LEFT JOIN users u ON u.id = fp.created_by
       ORDER BY fp.effective_date DESC, fp.id DESC, fp.fuel_type ASC
    `);
    const activePrices = fuelIssue.getActivePriceMap(req.query.date || null);
    res.json({ prices: rows, activePrices, ceypetcoSync: ceypetcoSync.getSyncStatus() });
  })
);

router.get(
  '/prices/lookup',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_prices', 'fuel', 'fuel_tanks'],
    level: 'view',
    caps: ['fuel.prices.view', 'fuel.prices.manage', 'fuel.issue', 'fuel.tanks.refill', 'fuel.view'],
  }),
  asyncHandler(async (req, res) => {
    const fuelType = req.query.fuelType || 'AUTO_DIESEL';
    const date = req.query.date || null;
    const detail = fuelIssue.resolvePriceDetail(fuelType, date);
    const activePrices = fuelIssue.getActivePriceMap(date);
    res.json({ ...detail, activePrices });
  })
);

router.post(
  '/prices',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel_prices', level: 'edit', caps: ['fuel.prices.manage'] }),
  asyncHandler(async (req, res) => {
    const { fuelType, pricePerLitreCents, pricePerLitre, effectiveDate, notes, source } = req.body;
    const cents = pricePerLitreCents != null
      ? Math.round(Number(pricePerLitreCents))
      : (pricePerLitre != null ? Math.round(Number(pricePerLitre) * 100) : NaN);

    if (!fuelType || !effectiveDate || isNaN(cents) || cents <= 0) {
      return res.status(400).json({ error: 'fuelType, effectiveDate, and positive pricePerLitreCents (or pricePerLitre) are required' });
    }

    const normType = String(fuelType).trim().toUpperCase();
    const normDate = String(effectiveDate).trim().slice(0, 10);
    const actorId = req.user ? req.user.id : 1;

    run(`
      INSERT INTO fuel_prices (fuel_type, fuel_kind, price_per_litre_cents, price_per_litre, effective_date, notes, source, created_by, entered_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fuel_type, effective_date) DO UPDATE SET
        fuel_kind = excluded.fuel_kind,
        price_per_litre_cents = excluded.price_per_litre_cents,
        price_per_litre = excluded.price_per_litre,
        notes = excluded.notes,
        source = excluded.source,
        created_by = excluded.created_by,
        entered_by = excluded.entered_by
    `, normType, normType, cents, cents / 100, normDate, notes || null, source || 'Manual Tariff Update', actorId, actorId);

    try {
      audit.record({
        userId: actorId,
        entity: 'fuel_price',
        entityId: null,
        action: 'fuel.price.updated',
        after: { fuelType: normType, cents, effectiveDate: normDate, notes: notes || null },
        reason: notes || `Updated ${normType} tariff effective ${normDate}`,
      });
    } catch (_) {}

    res.json({
      success: true,
      fuelType: normType,
      pricePerLitreCents: cents,
      pricePerLitre: cents / 100,
      effectiveDate: normDate,
      activePrices: fuelIssue.getActivePriceMap(),
    });
  })
);

router.post(
  '/prices/sync',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel_prices', level: 'edit', caps: ['fuel.prices.manage'] }),
  asyncHandler(async (req, res) => {
    try {
      const result = await ceypetcoSync.syncCeypetcoPrices({
        actorId: req.user ? req.user.id : null,
        trigger: 'manual',
      });
      res.json({
        success: true,
        ...result,
        activePrices: fuelIssue.getActivePriceMap(),
        ceypetcoSync: ceypetcoSync.getSyncStatus(),
      });
    } catch (err) {
      res.status(502).json({
        error: (err && err.message) || 'Ceypetco sync failed',
        ceypetcoSync: ceypetcoSync.getSyncStatus(),
      });
    }
  })
);

router.post(
  '/prices/reprice-preview',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel_prices', level: 'edit', caps: ['fuel.prices.manage'] }),
  asyncHandler(async (req, res) => {
    const {
      fromDate,
      toDate,
      fuelType = 'ALL',
      includeManual = false,
      projectId = null,
    } = req.body || {};
    const preview = fuelReprice.previewFuelReprice({
      fromDate,
      toDate,
      fuelType,
      includeManual: Boolean(includeManual),
      projectId,
    });
    const { _eligible, ...clean } = preview;
    res.json(clean);
  })
);

router.post(
  '/prices/reprice-apply',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel_prices', level: 'edit', caps: ['fuel.prices.manage'] }),
  asyncHandler(async (req, res) => {
    const {
      fromDate,
      toDate,
      fuelType = 'ALL',
      includeManual = false,
      projectId = null,
      refreshDraftBills = true,
      reason = null,
    } = req.body || {};
    const actorId = req.user ? req.user.id : null;
    const result = fuelReprice.applyFuelReprice({
      fromDate,
      toDate,
      fuelType,
      includeManual: Boolean(includeManual),
      projectId,
      refreshDraftBills: refreshDraftBills !== false,
      actorId,
      reason,
    });
    res.json({ success: true, ...result });
  })
);

// ---------------------------------------------------------------------------
// 10. Operational Fuel Dashboard Statistics
// ---------------------------------------------------------------------------

router.get(
  '/stats',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel', level: 'view', caps: ['fuel.view', 'fuel.console.view', 'fuel.reports.view'] }),
  asyncHandler(async (req, res) => {
    const scope = fuelScope.getFuelScope(req.user);
    const today = new Date().toISOString().slice(0, 10);
    const curMonthStart = today.slice(0, 7) + '-01';

    let issueScopeSql = '';
    let issueScopeParams = [];
    let tankScopeSql = '';
    let tankScopeParams = [];

    if (scope.scoped) {
      if (scope.allowedTankIds && scope.allowedTankIds.length > 0) {
        const marks = scope.allowedTankIds.map(() => '?').join(',');
        issueScopeSql = ` AND (source_tank_id IN (${marks}) OR bulk_tank_id IN (${marks}))`;
        issueScopeParams = [...scope.allowedTankIds, ...scope.allowedTankIds];
        tankScopeSql = ` AND id IN (${marks})`;
        tankScopeParams = [...scope.allowedTankIds];
      } else if (scope.projectId != null) {
        issueScopeSql = ' AND COALESCE(target_project_id, project_id, source_project_id) = ?';
        issueScopeParams = [Number(scope.projectId)];
        tankScopeSql = ' AND project_id = ?';
        tankScopeParams = [Number(scope.projectId)];
      } else {
        issueScopeSql = ' AND 1 = 0';
        tankScopeSql = ' AND 1 = 0';
      }
    }

    const todayStats = get(`
      SELECT COUNT(*) AS issues_count, COALESCE(SUM(litres), 0) AS total_litres, COALESCE(SUM(COALESCE(total_cost_cents, cost_cents, 0)), 0) AS total_cost_cents
        FROM fuel_issues
       WHERE is_voided = 0 AND issue_date >= ? ${issueScopeSql}
    `, today, ...issueScopeParams);

    let monthStats = get(`
      SELECT COUNT(*) AS issues_count, COALESCE(SUM(litres), 0) AS total_litres, COALESCE(SUM(COALESCE(total_cost_cents, cost_cents, 0)), 0) AS total_cost_cents
        FROM fuel_issues
       WHERE is_voided = 0 AND issue_date >= ? ${issueScopeSql}
    `, curMonthStart, ...issueScopeParams);

    if (!monthStats || !monthStats.issues_count) {
      const latestYmRow = get(`
        SELECT MAX(substr(issue_date, 1, 7)) AS ym
          FROM fuel_issues
         WHERE is_voided = 0 AND issue_date IS NOT NULL ${issueScopeSql}
      `, ...issueScopeParams);
      if (latestYmRow && latestYmRow.ym) {
        monthStats = get(`
          SELECT COUNT(*) AS issues_count, COALESCE(SUM(litres), 0) AS total_litres, COALESCE(SUM(COALESCE(total_cost_cents, cost_cents, 0)), 0) AS total_cost_cents
            FROM fuel_issues
           WHERE is_voided = 0 AND substr(issue_date, 1, 7) = ? ${issueScopeSql}
        `, latestYmRow.ym, ...issueScopeParams);
      }
    }

    const rawTankStats = get(`
      SELECT COUNT(*) AS total_tanks, COALESCE(SUM(current_litres), 0) AS total_stock_litres, COALESCE(SUM(capacity_litres), 0) AS total_capacity_litres
        FROM fuel_tanks
       WHERE active = 1 ${tankScopeSql}
    `, ...tankScopeParams) || { total_tanks: 0, total_stock_litres: 0, total_capacity_litres: 0 };

    const tankStats = scope.hideStock
      ? { ...rawTankStats, total_stock_litres: null, hide_stock: true }
      : rawTankStats;

    const pendingCorrections = (get("SELECT COUNT(*) AS n FROM fuel_corrections WHERE status = 'PENDING'") || {}).n || 0;
    const pendingRequests = (get("SELECT COUNT(*) AS n FROM fuel_requests WHERE status = 'PENDING'") || {}).n || 0;
    const activePrices = fuelIssue.getActivePriceMap();

    res.json({
      today: todayStats || { issues_count: 0, total_litres: 0, total_cost_cents: 0 },
      month: monthStats || { issues_count: 0, total_litres: 0, total_cost_cents: 0 },
      tanks: tankStats,
      currentDieselCents: activePrices.AUTO_DIESEL ? activePrices.AUTO_DIESEL.pricePerLitreCents : fuelIssue.getCurrentPrice('AUTO_DIESEL'),
      currentDieselEffectiveDate: activePrices.AUTO_DIESEL ? activePrices.AUTO_DIESEL.effectiveDate : null,
      activePrices,
      ceypetcoSync: ceypetcoSync.getSyncStatus(),
      pendingCorrections: scope.scoped ? 0 : pendingCorrections,
      pendingRequests: scope.scoped ? 0 : pendingRequests,
    });
  })
);

// ---------------------------------------------------------------------------
// 11. Fuel Consumption Reports & Efficiency Norms
// ---------------------------------------------------------------------------

router.get(
  '/reports',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel_reports', level: 'view', caps: ['fuel.reports.view'] }),
  asyncHandler(async (req, res) => {
    const month = req.query.month || currentMonthStr();
    const fromDate = month + '-01';
    const toDate = month + '-31 23:59:59';

    const vehicleStats = all(`
      SELECT fi.asset_id,
             COALESCE(a.code, fi.asset_code) AS asset_code,
             a.code AS asset_master_code,
             a.ec_code AS asset_ec_code,
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
    `, fromDate, toDate).map(attachVehicleLabels);

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
  })
);

// ---------------------------------------------------------------------------
// 12. Fuel Anomaly & Integrity Alerts
// ---------------------------------------------------------------------------

router.get(
  '/alerts',
  requireAuth,
  fuelScope.requireFuelAccess({ sections: 'fuel_alerts', level: 'view', caps: ['fuel.alerts.view'] }),
  asyncHandler(async (req, res) => {
    const alerts = [];
    const targetMonth = req.query.month || currentMonthStr();

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

    // Alert 2: Tank Dip Discrepancies (> threshold variance, excluding reconciled & opening stock)
    const dipThreshold = fuelStock.getDipVarianceThreshold();
    const dipCols = all('PRAGMA table_info("fuel_tank_dips")').map((c) => c.name);
    const hasReconcileCols = dipCols.includes('reconciled') && dipCols.includes('dip_type');
    const highVarDips = all(`
      SELECT td.*, t.code AS tank_code, t.name AS tank_name
        FROM fuel_tank_dips td
        JOIN fuel_tanks t ON t.id = td.tank_id
       WHERE ABS(td.variance_litres) > ?
         ${hasReconcileCols ? "AND COALESCE(td.reconciled, 0) = 0 AND COALESCE(td.dip_type, 'PHYSICAL_DIP') <> 'OPENING_STOCK'" : ''}
       ORDER BY td.dip_date DESC LIMIT 10
    `, dipThreshold);
    for (const d of highVarDips) {
      alerts.push({
        category: 'INTEGRITY',
        severity: 'HIGH',
        title: `Tank Dip Variance: ${d.tank_name}`,
        message: `Physical dip on ${d.dip_date} had a variance of ${d.variance_litres > 0 ? '+' : ''}${d.variance_litres} Litres.`,
        tank_id: d.tank_id,
        dip_id: d.id,
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

    // Alert 4: Vehicles drawing fuel with no meter movement in targetMonth
    const noMeterVehicles = all(`
      SELECT asset_code, COUNT(*) AS fills, ROUND(SUM(litres), 1) AS total_litres
        FROM fuel_issues
       WHERE is_voided = 0 AND substr(issue_date, 1, 7) = ?
       GROUP BY asset_code
      HAVING COUNT(*) >= 3 AND (MAX(COALESCE(meter_reading, 0)) - MIN(COALESCE(meter_reading, 0))) = 0
       ORDER BY total_litres DESC LIMIT 12
    `, targetMonth);
    for (const nm of noMeterVehicles) {
      alerts.push({
        category: 'METER',
        severity: 'MEDIUM',
        title: `Fuel Without Meter Movement: ${nm.asset_code}`,
        message: `Drew ${nm.total_litres} L across ${nm.fills} issues in ${targetMonth} with 0 meter movement recorded.`,
        asset_code: nm.asset_code,
      });
    }

    // Alert 5: Faulty Meter Repair Alerts (vehicles with faulty-meter fuel slips or open requests and no subsequent working meter issue)
    const faultyIssues = all(`
      SELECT UPPER(COALESCE(NULLIF(TRIM(fi.asset_code),''), fi.vehicle_ref)) AS asset_key,
             MAX(fi.asset_code) AS asset_code,
             MAX(fi.asset_id) AS asset_id,
             COUNT(*) AS faulty_fills,
             ROUND(SUM(fi.litres), 1) AS faulty_litres,
             MAX(fi.issue_date) AS last_fault_date,
             MAX(fi.rowid) AS max_rowid,
             (SELECT fi2.meter_fault_reason
                FROM fuel_issues fi2
               WHERE fi2.is_voided = 0 AND COALESCE(fi2.meter_faulty, 0) = 1
                 AND UPPER(COALESCE(NULLIF(TRIM(fi2.asset_code),''), fi2.vehicle_ref)) = UPPER(COALESCE(NULLIF(TRIM(fi.asset_code),''), fi.vehicle_ref))
               ORDER BY fi2.issue_date DESC, fi2.rowid DESC LIMIT 1) AS latest_reason
        FROM fuel_issues fi
       WHERE fi.is_voided = 0
         AND COALESCE(fi.meter_faulty, 0) = 1
         AND NOT EXISTS (
           SELECT 1 FROM fuel_issues ok
            WHERE ok.is_voided = 0
              AND COALESCE(ok.meter_faulty, 0) = 0
              AND ok.meter_reading > 0
              AND (
                (fi.asset_id IS NOT NULL AND ok.asset_id = fi.asset_id)
                OR UPPER(COALESCE(NULLIF(TRIM(ok.asset_code),''), ok.vehicle_ref)) = UPPER(COALESCE(NULLIF(TRIM(fi.asset_code),''), fi.vehicle_ref))
              )
              AND (ok.issue_date > fi.issue_date OR (ok.issue_date = fi.issue_date AND ok.rowid > fi.rowid))
         )
       GROUP BY asset_key
       ORDER BY last_fault_date DESC
       LIMIT 30
    `);

    const openFaultyReqs = all(`
      SELECT UPPER(fr.asset_code) AS asset_key,
             fr.asset_code,
             fr.asset_id,
             fr.meter_fault_reason AS latest_reason,
             fr.requested_at AS last_fault_date
        FROM fuel_requests fr
       WHERE fr.status IN ('PENDING', 'APPROVED')
         AND COALESCE(fr.meter_faulty, 0) = 1
         AND NOT EXISTS (
           SELECT 1 FROM fuel_issues ok
            WHERE ok.is_voided = 0
              AND COALESCE(ok.meter_faulty, 0) = 0
              AND ok.meter_reading > 0
              AND (
                (fr.asset_id IS NOT NULL AND ok.asset_id = fr.asset_id)
                OR UPPER(COALESCE(NULLIF(TRIM(ok.asset_code),''), ok.vehicle_ref)) = UPPER(fr.asset_code)
              )
              AND (ok.issue_date > fr.requested_at OR COALESCE(ok.created_at,'') > fr.requested_at)
         )
       ORDER BY fr.requested_at DESC
    `);

    const faultyByAsset = new Map();
    for (const row of faultyIssues) {
      if (!row.asset_key) continue;
      faultyByAsset.set(row.asset_key, row);
    }
    for (const r of openFaultyReqs) {
      if (!r.asset_key) continue;
      if (!faultyByAsset.has(r.asset_key)) {
        faultyByAsset.set(r.asset_key, {
          asset_key: r.asset_key,
          asset_code: r.asset_code,
          asset_id: r.asset_id,
          faulty_fills: 0,
          faulty_litres: 0,
          last_fault_date: r.last_fault_date,
          latest_reason: r.latest_reason,
          open_request: true,
        });
      }
    }

    let meterFaultyCount = 0;
    for (const row of faultyByAsset.values()) {
      meterFaultyCount++;
      const reasonTxt = row.latest_reason || 'Meter reported faulty';
      const detailTxt = row.faulty_fills > 0
        ? `${row.faulty_fills} fuel slip(s) (${row.faulty_litres} L) recorded without working meter (latest ${String(row.last_fault_date || '').slice(0, 10)}).`
        : `Open fuel requisition flagged faulty meter (${String(row.last_fault_date || '').slice(0, 10)}).`;
      alerts.push({
        category: 'METER_FAULTY',
        severity: 'HIGH',
        title: `Faulty Meter Repair Needed: ${row.asset_code}`,
        message: `Reason: "${reasonTxt}". ${detailTxt}`,
        asset_code: row.asset_code,
        asset_id: row.asset_id,
        fault_reason: row.latest_reason || null,
      });
    }

    // Alert 6: Site Fuel Budget Overrun / Near-Limit Alerts
    try {
      const [bYr, bMo] = String(targetMonth).split('-').map(Number);
      const warnRow = get("SELECT value FROM settings WHERE key = 'fuel.budget_warn_pct'");
      const warnPct = warnRow && Number.isFinite(Number(warnRow.value)) ? Number(warnRow.value) : 85;
      if (bYr && bMo) {
        const budgetAlertRows = all(`
          SELECT b.project_id, p.name AS project_name, p.code AS project_code, b.budget_litres,
                 ROUND(COALESCE(u.actual_litres, 0), 1) AS actual_litres
            FROM site_fuel_budgets b
            JOIN projects p ON p.id = b.project_id
            LEFT JOIN (
              SELECT COALESCE(fi.target_project_id, fi.project_id, t.project_id, 0) AS pid,
                     SUM(fi.litres) AS actual_litres
                FROM fuel_issues fi
                LEFT JOIN fuel_tanks t ON t.id = COALESCE(fi.source_tank_id, fi.bulk_tank_id)
               WHERE fi.is_voided = 0 AND substr(fi.issue_date, 1, 7) = ?
               GROUP BY COALESCE(fi.target_project_id, fi.project_id, t.project_id, 0)
            ) u ON u.pid = b.project_id
           WHERE b.year = ? AND b.month = ? AND b.budget_litres IS NOT NULL AND b.budget_litres > 0
        `, targetMonth, bYr, bMo);

        for (const r of budgetAlertRows) {
          const pct = Math.round(((r.actual_litres || 0) / r.budget_litres) * 1000) / 10;
          if (pct > 100) {
            alerts.push({
              category: 'BUDGET',
              severity: 'HIGH',
              title: `Site Fuel Budget Exceeded: ${r.project_name}`,
              message: `Used ${r.actual_litres} L against ${r.budget_litres} L budget (${pct}%) in ${targetMonth}.`,
              project_id: r.project_id,
              budget_litres: r.budget_litres,
              actual_litres: r.actual_litres,
              budget_pct: pct,
            });
          } else if (pct >= warnPct) {
            alerts.push({
              category: 'BUDGET',
              severity: 'MEDIUM',
              title: `Site Fuel Budget Near Limit: ${r.project_name}`,
              message: `Reached ${r.actual_litres} L of ${r.budget_litres} L budget (${pct}%) in ${targetMonth}.`,
              project_id: r.project_id,
              budget_litres: r.budget_litres,
              actual_litres: r.actual_litres,
              budget_pct: pct,
            });
          }
        }
      }
    } catch (_) {}

    // Alert 7: Statutory Document Compliance on Fueled Vehicles (Insurance / Revenue Licence Expired)
    try {
      const fueledIds = all(`
        SELECT DISTINCT asset_id
          FROM fuel_issues
         WHERE is_voided = 0 AND substr(issue_date, 1, 7) = ? AND asset_id IS NOT NULL
         LIMIT 500
      `, targetMonth).map((r) => r.asset_id);
      if (fueledIds.length) {
        const vdocs = require('../lib/vehicle_documents');
        const compMap = vdocs.getAssetComplianceMap({ assetIds: fueledIds });
        for (const entry of Object.values(compMap.by_asset_id || {})) {
          if (entry.insurance_expired || entry.rl_expired) {
            const expNames = (entry.expired_docs || [])
              .filter((d) => ['insurance', 'revenue_licence'].includes(d.doc_type_code))
              .map((d) => `${d.doc_type_name} (${d.valid_until})`)
              .join(', ');
            alerts.push({
              category: 'COMPLIANCE',
              severity: 'MEDIUM',
              title: `Expired Statutory Document on Fueled Vehicle: ${entry.asset_code}`,
              message: `Vehicle drew fuel in ${targetMonth} with expired statutory cover: ${expNames}.`,
              asset_id: entry.asset_id,
              asset_code: entry.asset_code,
            });
          }
        }
      }
    } catch (_) {}

    // Enrich vehicle alerts with dual E&C + Vehicle Reg labels
    try {
      const assetRows = all('SELECT id, code, ec_code, registration FROM assets WHERE status != ?', 'DISPOSED');
      const byId = new Map();
      const byKey = new Map();
      for (const a of assetRows) {
        const info = { ...a, ...resolveVehicleIdentity(a) };
        byId.set(Number(a.id), info);
        for (const k of [a.code, a.ec_code, a.registration]) {
          if (k) byKey.set(String(k).trim().toUpperCase(), info);
        }
      }
      for (const al of alerts) {
        const match = (al.asset_id && byId.get(Number(al.asset_id)))
          || (al.asset_code && byKey.get(String(al.asset_code).trim().toUpperCase()));
        if (match) {
          al.asset_ec_code = match.ec_code;
          al.asset_registration = match.registration;
          al.asset_display = match.display;
          if (al.asset_code && al.title && al.asset_display && al.asset_display !== al.asset_code) {
            al.title = al.title.replace(al.asset_code, al.asset_display);
          }
        }
      }
    } catch (_) {}

    res.json({ alerts, count: alerts.length, meter_faulty_count: meterFaultyCount, month: targetMonth });
  })
);

module.exports = router;
