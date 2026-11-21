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
const audit = require('../lib/audit');

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
    const issue = get(`
      SELECT fi.*, t.name AS tank_name, sp.name AS source_project_name,
             COALESCE(tp.name, p.name) AS target_project_name,
             COALESCE(u.full_name, u.username) AS issuer_name, COALESCE(vu.full_name, vu.username) AS voider_name
        FROM fuel_issues fi
        LEFT JOIN fuel_tanks t ON t.id = COALESCE(fi.source_tank_id, fi.bulk_tank_id)
        LEFT JOIN projects sp ON sp.id = fi.source_project_id
        LEFT JOIN projects tp ON tp.id = fi.target_project_id
        LEFT JOIN projects p ON p.id = COALESCE(fi.project_id, t.project_id)
        LEFT JOIN users u ON u.id = fi.issued_by
        LEFT JOIN users vu ON vu.id = fi.voided_by
       WHERE fi.id = ?
    `, req.params.id);

    if (!issue) return res.status(404).json({ error: 'Fuel issue not found' });
    fuelScope.assertIssueInScope(req.user, issue, 'view this fuel issue');

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

    // Enforce Meter Guard unless explicitly overridden by user with reason
    if (req.body.meterReading && !req.body.ignoreMeterWarning) {
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

    const vehicles = all(`
      SELECT a.id, COALESCE(a.code, a.ec_code) AS code, a.registration, a.category, a.type,
             a.current_hours, a.current_project_id, COALESCE(p.name, 'Central') AS current_site
        FROM assets a
        LEFT JOIN projects p ON p.id = a.current_project_id
       WHERE a.status != 'DISPOSED'
       ORDER BY a.code ASC
       LIMIT 1000
    `);

    res.json({ tanks, projects, vehicles, fuelScope: scope });
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
  })
);

router.post(
  '/requests/:id/review',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_transport', 'fuel'],
    level: 'edit',
    caps: ['fuel.approve_request', 'fuel.approve'],
  }),
  asyncHandler(async (req, res) => {
    const { action, rejectionReason, sourceTankId, dispenseNow, litres, meterReading, pumpLocation, issueDate } = req.body;
    const fr = get('SELECT * FROM fuel_requests WHERE id = ?', req.params.id);
    if (!fr) return res.status(404).json({ error: 'Fuel request not found' });

    const scope = fuelScope.getFuelScope(req.user);
    if (scope.scoped) {
      fuelScope.assertRequestInScope(req.user, fr, 'review this fuel request');
    }

    const actorId = req.user ? req.user.id : 1;
    const isAdmin = req.user && (req.user.roles || []).includes('admin');
    const isApprove = String(action || '').toUpperCase().startsWith('APPROV');

    if (!isApprove) {
      if (fr.status === 'FULFILLED') {
        return res.status(409).json({ error: 'Cannot reject a request that has already been fulfilled at the pump' });
      }
      run(`
        UPDATE fuel_requests
           SET status = 'REJECTED', approved_by = ?, approved_at = datetime('now'), rejection_reason = ?
         WHERE id = ?
      `, actorId, rejectionReason || 'Rejected', fr.id);
      try {
        audit.record({ userId: actorId, entity: 'fuel_request', entityId: fr.id, action: 'fuel.request.rejected', reason: rejectionReason || 'Rejected' });
      } catch (_) {}
      return res.json(transportRequests.getRequestById(fr.id));
    }

    if (fr.status === 'FULFILLED') {
      return res.status(409).json({ error: 'This fuel request is already fulfilled' });
    }

    run(`
      UPDATE fuel_requests
         SET status = 'APPROVED', approved_by = ?, approved_at = datetime('now')
       WHERE id = ?
    `, actorId, fr.id);

    try {
      audit.record({ userId: actorId, entity: 'fuel_request', entityId: fr.id, action: 'fuel.request.approved' });
    } catch (_) {}

    let issued = null;
    if (dispenseNow) {
      if (!isAdmin && !hasCap(req.user, 'fuel.issue')) {
        return res.status(403).json({ error: 'Your role can approve requests to the pump queue, but cannot dispense fuel directly.' });
      }
      const qty = Number(litres != null ? litres : fr.requested_litres);
      if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ error: 'Actual dispensed litres (> 0) is required to dispense immediately (or approve to pump queue first)' });
      }
      const effTankId = sourceTankId || (fr.source_mode === 'TANK' ? fr.target_tank_id : null);
      if (scope.scoped) {
        fuelScope.assertTankInScope(req.user, effTankId, 'dispense fuel from this tank');
      }
      issued = fuelIssue.recordIssue({
        fuelRequestId: fr.id,
        assetCode: fr.asset_code,
        litres: qty,
        fuelType: fr.fuel_type || 'AUTO_DIESEL',
        meterReading: meterReading != null ? meterReading : fr.meter_reading,
        meterType: fr.meter_type || 'HOURS',
        sourceTankId: effTankId,
        targetProjectId: fr.project_id || null,
        driverName: fr.driver_name || null,
        stationName: fr.station_name || null,
        pumpLocation: pumpLocation || null,
        issueDate: issueDate || null,
        allowSiteTransfer: isAdmin || hasCap(req.user, 'fuel.transfer'),
      }, actorId);
    }

    res.json({ request: transportRequests.getRequestById(fr.id), issued });
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

    const qty = Number(body.litres != null ? body.litres : (!fr.is_full_tank ? fr.requested_litres : 0));
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
    if (meterVal && !body.ignoreMeterWarning) {
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
      meterReading: meterVal,
      meterType: body.meterType || fr.meter_type || 'HOURS',
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
  })
);

router.post(
  '/requests/:id/cancel',
  requireAuth,
  fuelScope.requireFuelAccess({
    sections: ['fuel_transport', 'fuel'],
    level: 'edit',
    caps: ['fuel.transport.request', 'fuel.request', 'fuel.approve_request'],
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
    res.json(transportRequests.getRequestById(fr.id));
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
      SELECT a.id, COALESCE(a.code, a.ec_code) AS code, a.registration, a.category, a.type, a.status,
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
    `);

    let filtered = rows;
    if (search) {
      const q = v2Engine.squashCode(search);
      filtered = filtered.filter((r) =>
        v2Engine.squashCode(r.code).includes(q) ||
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
      SELECT fp.*, COALESCE(u.full_name, u.username) AS creator_name
        FROM fuel_prices fp
        LEFT JOIN users u ON u.id = fp.created_by
       ORDER BY fp.effective_date DESC, fp.id DESC, fp.fuel_type ASC
    `);
    const activePrices = fuelIssue.getActivePriceMap(req.query.date || null);
    res.json({ prices: rows, activePrices });
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
    `, fromDate, toDate);

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

    // Alert 2: Tank Dip Discrepancies (> 50 L variance)
    const highVarDips = all(`
      SELECT td.*, t.code AS tank_code, t.name AS tank_name
        FROM fuel_tank_dips td
        JOIN fuel_tanks t ON t.id = td.tank_id
       WHERE ABS(td.variance_litres) > 50
       ORDER BY td.dip_date DESC LIMIT 10
    `);
    for (const d of highVarDips) {
      alerts.push({
        category: 'INTEGRITY',
        severity: 'HIGH',
        title: `Tank Dip Variance: ${d.tank_name}`,
        message: `Physical dip on ${d.dip_date} had a variance of ${d.variance_litres > 0 ? '+' : ''}${d.variance_litres} Litres.`,
        tank_id: d.tank_id,
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

    res.json({ alerts, count: alerts.length, month: targetMonth });
  })
);

module.exports = router;
