'use strict';

/**
 * Bulk Tank-to-Tank Fuel Transfer Request Engine
 *
 * Supports end-to-end bulk transfers (e.g. Badalgama Tank -> Wadakada Tank / Galagedara Tank):
 *   1. Site or Transport raises Bulk Transfer Request (`PENDING` for Site, `APPROVED` for Transport)
 *   2. Transport reviews, adjusts approved litres, assigns Bowser (dual E&C + Reg) & driver -> `APPROVED`
 *   3. Source tank operator dispatches bowser load -> deducts source tank stock, marks `IN_TRANSIT`
 *   4. Destination tank operator confirms physical offload -> credits destination tank stock,
 *      inserts zero-cost `fuel_bulk_deliveries` entry (no double-billing / no false vehicle cost),
 *      computes `variance_litres`, marks `RECEIVED`
 *   5. Cancellation before receipt (`IN_TRANSIT` restores source tank stock atomically)
 */

const { get, all, run, tx } = require('../../db');
const audit = require('../audit');
const { hasCap } = require('../auth');
const { resolveVehicleIdentity } = require('../vehicle_label');
const fuelScope = require('./scope');
const fuelStock = require('./stock');
const v2Engine = require('./v2_engine');

function httpError(status, message, data = null) {
  const err = new Error(message);
  err.status = status;
  if (data) err.data = data;
  return err;
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function canApproveTransfer(actor) {
  if (!actor) return false;
  if (Array.isArray(actor.roles) && actor.roles.includes('admin')) return true;
  return hasCap(actor, 'fuel.approve_request', 'fuel.approve', 'fuel.transfer', 'fuel.tanks.manage');
}

function isTransportActor(actor) {
  if (!actor) return false;
  if (Array.isArray(actor.roles) && actor.roles.includes('admin')) return true;
  const scope = fuelScope.getFuelScope(actor);
  if (scope.scoped) return false;
  return hasCap(actor, 'fuel.approve_request', 'fuel.approve', 'fuel.approve_site_request', 'fuel.all_sites');
}

function hydrateTransferRow(row, hideStock = false) {
  if (!row) return null;
  const bowserId = row.bowser_asset_id || row.bowser_code || row.bowser_master_code
    ? resolveVehicleIdentity({
        code: row.bowser_master_code || row.bowser_code,
        ec_code: row.bowser_ec_code,
        registration: row.bowser_registration,
      })
    : null;
  return {
    ...row,
    bowser_ec_code: bowserId ? bowserId.ec_code : null,
    bowser_registration: bowserId ? bowserId.registration : null,
    bowser_display: bowserId ? bowserId.display : null,
    source_tank_current_litres: hideStock ? null : row.source_tank_current_litres,
    dest_tank_current_litres: hideStock ? null : row.dest_tank_current_litres,
    hide_stock: !!hideStock,
  };
}

const TRANSFER_BASE_SELECT = `
  SELECT ftt.*,
         st.code AS source_tank_code,
         st.name AS source_tank_name,
         st.tank_type AS source_tank_type,
         st.current_litres AS source_tank_current_litres,
         dt.code AS dest_tank_code,
         dt.name AS dest_tank_name,
         dt.tank_type AS dest_tank_type,
         dt.current_litres AS dest_tank_current_litres,
         COALESCE(sp.name, 'Central') AS source_project_name,
         COALESCE(sp.code, '') AS source_project_code,
         COALESCE(dp.name, 'Central') AS dest_project_name,
         COALESCE(dp.code, '') AS dest_project_code,
         ba.code AS bowser_master_code,
         ba.ec_code AS bowser_ec_code,
         ba.registration AS bowser_registration,
         COALESCE(u1.full_name, u1.username) AS requester_name,
         COALESCE(u2.full_name, u2.username) AS approver_name,
         COALESCE(u3.full_name, u3.username) AS dispatcher_name,
         COALESCE(u4.full_name, u4.username) AS receiver_name
    FROM fuel_tank_transfers ftt
    LEFT JOIN fuel_tanks st ON st.id = ftt.source_tank_id
    LEFT JOIN fuel_tanks dt ON dt.id = ftt.dest_tank_id
    LEFT JOIN projects sp ON sp.id = COALESCE(ftt.source_project_id, st.project_id)
    LEFT JOIN projects dp ON dp.id = COALESCE(ftt.dest_project_id, dt.project_id)
    LEFT JOIN assets ba ON ba.id = ftt.bowser_asset_id
    LEFT JOIN users u1 ON u1.id = ftt.requested_by
    LEFT JOIN users u2 ON u2.id = ftt.approved_by
    LEFT JOIN users u3 ON u3.id = ftt.dispatched_by
    LEFT JOIN users u4 ON u4.id = ftt.received_by
`;

function getTransferById(id, actor = null) {
  const scope = actor ? fuelScope.getFuelScope(actor) : { hideStock: false };
  const row = get(`${TRANSFER_BASE_SELECT} WHERE ftt.id = ?`, String(id));
  return hydrateTransferRow(row, !!scope.hideStock);
}

function listTransfers({
  status = 'ALL',
  sourceTankId = null,
  destTankId = null,
  tankId = null,
  projectId = null,
  allowedTankIds = null,
  scopedProjectId = null,
  search = null,
  limit = 150,
  hideStock = false,
} = {}) {
  const conds = [];
  const params = [];

  if (Array.isArray(allowedTankIds)) {
    if (allowedTankIds.length > 0 && scopedProjectId != null) {
      const marks = allowedTankIds.map(() => '?').join(',');
      conds.push(`(ftt.source_tank_id IN (${marks}) OR ftt.dest_tank_id IN (${marks}) OR ftt.source_project_id = ? OR ftt.dest_project_id = ?)`);
      params.push(...allowedTankIds, ...allowedTankIds, Number(scopedProjectId), Number(scopedProjectId));
    } else if (allowedTankIds.length > 0) {
      const marks = allowedTankIds.map(() => '?').join(',');
      conds.push(`(ftt.source_tank_id IN (${marks}) OR ftt.dest_tank_id IN (${marks}))`);
      params.push(...allowedTankIds, ...allowedTankIds);
    } else if (scopedProjectId != null) {
      conds.push('(ftt.source_project_id = ? OR ftt.dest_project_id = ?)');
      params.push(Number(scopedProjectId), Number(scopedProjectId));
    } else {
      conds.push('1 = 0');
    }
  } else if (scopedProjectId != null) {
    conds.push('(ftt.source_project_id = ? OR ftt.dest_project_id = ?)');
    params.push(Number(scopedProjectId), Number(scopedProjectId));
  }

  if (status && status !== 'ALL') {
    const up = String(status).toUpperCase();
    if (up === 'OPEN') {
      conds.push("ftt.status IN ('PENDING', 'APPROVED', 'IN_TRANSIT')");
    } else {
      conds.push('UPPER(ftt.status) = ?');
      params.push(up);
    }
  }

  if (sourceTankId && sourceTankId !== 'ALL') {
    conds.push('ftt.source_tank_id = ?');
    params.push(String(sourceTankId));
  }
  if (destTankId && destTankId !== 'ALL') {
    conds.push('ftt.dest_tank_id = ?');
    params.push(String(destTankId));
  }
  if (tankId && tankId !== 'ALL') {
    conds.push('(ftt.source_tank_id = ? OR ftt.dest_tank_id = ?)');
    params.push(String(tankId), String(tankId));
  }
  if (projectId && projectId !== 'ALL') {
    conds.push('(ftt.source_project_id = ? OR ftt.dest_project_id = ?)');
    params.push(Number(projectId), Number(projectId));
  }
  if (search) {
    const q = `%${String(search).trim()}%`;
    conds.push(`(
      UPPER(ftt.transfer_no) LIKE UPPER(?)
      OR UPPER(COALESCE(st.name, '')) LIKE UPPER(?)
      OR UPPER(COALESCE(dt.name, '')) LIKE UPPER(?)
      OR UPPER(COALESCE(ftt.bowser_code, '')) LIKE UPPER(?)
      OR UPPER(COALESCE(ba.ec_code, '')) LIKE UPPER(?)
      OR UPPER(COALESCE(ba.registration, '')) LIKE UPPER(?)
      OR UPPER(COALESCE(ftt.driver_name, '')) LIKE UPPER(?)
      OR UPPER(COALESCE(ftt.seal_no, '')) LIKE UPPER(?)
    )`);
    params.push(q, q, q, q, q, q, q, q);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const lim = Math.min(500, Math.max(1, Number(limit) || 150));

  const rows = all(`
    ${TRANSFER_BASE_SELECT}
    ${where}
    ORDER BY CASE ftt.status
               WHEN 'IN_TRANSIT' THEN 0
               WHEN 'PENDING' THEN 1
               WHEN 'APPROVED' THEN 2
               WHEN 'RECEIVED' THEN 3
               ELSE 4
             END,
             ftt.requested_at DESC
    LIMIT ?
  `, ...params, lim);

  return rows.map((r) => hydrateTransferRow(r, !!hideStock));
}

function resolveBowserInput(bowserAssetId, bowserCode) {
  if (!bowserAssetId && !bowserCode) return { assetId: null, code: null };
  const resolved = v2Engine.resolveVehicle(bowserAssetId || bowserCode);
  if (resolved) {
    return {
      assetId: resolved.id,
      code: resolved.ec_code || resolved.code || resolved.registration,
    };
  }
  const clean = String(bowserCode || '').trim().toUpperCase();
  return { assetId: null, code: clean || null };
}

function createTransferRequest(payload = {}, actor = null) {
  const actorId = actor && actor.id ? Number(actor.id) : 1;
  const scope = actor ? fuelScope.getFuelScope(actor) : { scoped: false, unassigned: false };

  const sourceTankId = String(payload.sourceTankId || payload.fromTankId || '').trim();
  const destTankId = String(payload.destTankId || payload.toTankId || payload.targetTankId || '').trim();
  if (!sourceTankId || !destTankId) {
    throw httpError(400, 'Both Source Tank and Destination Tank must be selected');
  }
  if (sourceTankId === destTankId) {
    throw httpError(400, 'Source tank and destination tank must be different');
  }

  const reqLitres = Number(payload.requestedLitres ?? payload.litres);
  if (!Number.isFinite(reqLitres) || reqLitres <= 0) {
    throw httpError(400, 'Requested litres must be greater than 0');
  }

  const srcTank = get('SELECT * FROM fuel_tanks WHERE id = ? AND active = 1', sourceTankId);
  if (!srcTank) throw httpError(404, `Source tank not found or inactive: ${sourceTankId}`);
  const dstTank = get('SELECT * FROM fuel_tanks WHERE id = ? AND active = 1', destTankId);
  if (!dstTank) throw httpError(404, `Destination tank not found or inactive: ${destTankId}`);

  if (scope.scoped) {
    if (scope.unassigned) {
      throw httpError(403, 'No fuel site or tank assigned to your account. Contact an Administrator before raising tank transfer requests.');
    }
    fuelScope.assertTankInScope(actor, destTankId, 'request bulk fuel into this tank');
  }

  const transportActor = isTransportActor(actor);
  const requestedChannel = transportActor ? 'TRANSPORT' : 'SITE';
  const canAutoApprove = !scope.scoped && canApproveTransfer(actor);
  const requireApproval = !canAutoApprove || Boolean(payload.requireApproval);
  const status = requireApproval ? 'PENDING' : 'APPROVED';
  const roundedReq = round1(reqLitres);
  const approvedLitres = status === 'APPROVED' ? roundedReq : null;
  const fuelType = String(payload.fuelType || dstTank.fuel_type || srcTank.fuel_type || 'AUTO_DIESEL').toUpperCase();
  const bowser = resolveBowserInput(payload.bowserAssetId || payload.bowser_asset_id, payload.bowserCode || payload.bowser_code);

  const id = `ftr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const transferNo = `FTR-${new Date().getFullYear()}-${Math.floor(10000 + Math.random() * 90000)}`;

  run(`
    INSERT INTO fuel_tank_transfers (
      id, transfer_no, source_tank_id, dest_tank_id, source_project_id, dest_project_id,
      fuel_type, requested_litres, approved_litres, bowser_asset_id, bowser_code, driver_name,
      requested_channel, status, reason, requested_by, requested_at, approved_by, approved_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, datetime('now'), ?, CASE WHEN ? = 'APPROVED' THEN datetime('now') ELSE NULL END, datetime('now')
    )
  `,
    id, transferNo, srcTank.id, dstTank.id, srcTank.project_id || null, dstTank.project_id || null,
    fuelType, roundedReq, approvedLitres, bowser.assetId, bowser.code,
    payload.driverName ? String(payload.driverName).trim() : null,
    requestedChannel, status,
    payload.reason ? String(payload.reason).trim() : null,
    actorId,
    status === 'APPROVED' ? actorId : null,
    status
  );

  try {
    audit.record({
      userId: actorId,
      entity: 'fuel_tank_transfer',
      entityId: id,
      action: 'fuel.tank_transfer.created',
      after: {
        transferNo,
        sourceTankId: srcTank.id,
        destTankId: dstTank.id,
        requestedLitres: roundedReq,
        requestedChannel,
        status,
      },
    });
  } catch (_) {}

  return getTransferById(id, actor);
}

function reviewTransferRequest(id, payload = {}, actor = null) {
  const actorId = actor && actor.id ? Number(actor.id) : 1;
  if (!canApproveTransfer(actor)) {
    throw httpError(403, 'You do not have permission to approve or reject tank transfer requests.');
  }

  const tr = get('SELECT * FROM fuel_tank_transfers WHERE id = ?', String(id));
  if (!tr) throw httpError(404, `Tank transfer request not found: ${id}`);

  if (tr.status === 'IN_TRANSIT' || tr.status === 'RECEIVED') {
    throw httpError(409, `Cannot review transfer ${tr.transfer_no} once it is ${tr.status}.`);
  }
  if (tr.status === 'CANCELLED') {
    throw httpError(409, `Transfer ${tr.transfer_no} is cancelled.`);
  }

  const isApprove = String(payload.action || '').toUpperCase().startsWith('APPROV');
  if (!isApprove) {
    const reason = String(payload.rejectionReason ?? payload.reviewNote ?? payload.review_note ?? '').trim();
    if (reason.length < 3) {
      throw httpError(400, 'A rejection reason (at least 3 characters) is required');
    }
    run(`
      UPDATE fuel_tank_transfers
         SET status = 'REJECTED',
             approved_by = ?,
             approved_at = datetime('now'),
             rejection_reason = ?,
             review_note = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `, actorId, reason, reason, tr.id);
    try {
      audit.record({ userId: actorId, entity: 'fuel_tank_transfer', entityId: tr.id, action: 'fuel.tank_transfer.rejected', reason });
    } catch (_) {}
    return getTransferById(tr.id, actor);
  }

  if (tr.status !== 'PENDING' && tr.status !== 'APPROVED') {
    throw httpError(409, `Cannot approve transfer in status '${tr.status}'`);
  }

  const rawApp = payload.approvedLitres ?? payload.approved_litres;
  let approvedLitres = tr.approved_litres || tr.requested_litres;
  if (rawApp !== undefined && rawApp !== null && rawApp !== '') {
    const n = Number(rawApp);
    if (!Number.isFinite(n) || n <= 0) {
      throw httpError(400, 'Approved litres must be greater than 0');
    }
    approvedLitres = round1(n);
  }

  let sourceTankId = tr.source_tank_id;
  let sourceProjectId = tr.source_project_id;
  if (payload.sourceTankId && String(payload.sourceTankId) !== String(tr.source_tank_id)) {
    if (String(payload.sourceTankId) === String(tr.dest_tank_id)) {
      throw httpError(400, 'Source tank and destination tank must be different');
    }
    const newSrc = get('SELECT * FROM fuel_tanks WHERE id = ? AND active = 1', String(payload.sourceTankId));
    if (!newSrc) throw httpError(404, `Selected source tank not found or inactive: ${payload.sourceTankId}`);
    sourceTankId = newSrc.id;
    sourceProjectId = newSrc.project_id || null;
  }

  const bowser = (payload.bowserAssetId !== undefined || payload.bowser_asset_id !== undefined || payload.bowserCode !== undefined || payload.bowser_code !== undefined)
    ? resolveBowserInput(payload.bowserAssetId ?? payload.bowser_asset_id, payload.bowserCode ?? payload.bowser_code)
    : { assetId: tr.bowser_asset_id, code: tr.bowser_code };
  const driverName = payload.driverName !== undefined
    ? (String(payload.driverName || '').trim() || null)
    : tr.driver_name;
  const reviewNote = payload.reviewNote !== undefined || payload.review_note !== undefined
    ? (String(payload.reviewNote ?? payload.review_note ?? '').trim() || null)
    : tr.review_note;

  run(`
    UPDATE fuel_tank_transfers
       SET status = 'APPROVED',
           source_tank_id = ?,
           source_project_id = ?,
           approved_litres = ?,
           bowser_asset_id = ?,
           bowser_code = ?,
           driver_name = ?,
           review_note = ?,
           approved_by = ?,
           approved_at = datetime('now'),
           updated_at = datetime('now')
     WHERE id = ?
  `, sourceTankId, sourceProjectId, approvedLitres, bowser.assetId, bowser.code, driverName, reviewNote, actorId, tr.id);

  try {
    audit.record({
      userId: actorId,
      entity: 'fuel_tank_transfer',
      entityId: tr.id,
      action: 'fuel.tank_transfer.approved',
      after: { approvedLitres, sourceTankId, bowserCode: bowser.code, driverName, reviewNote },
    });
  } catch (_) {}

  return getTransferById(tr.id, actor);
}

function dispatchTransfer(id, payload = {}, actor = null) {
  const actorId = actor && actor.id ? Number(actor.id) : 1;
  const isAdmin = Boolean(actor && Array.isArray(actor.roles) && actor.roles.includes('admin'));
  if (!isAdmin && !hasCap(actor, 'fuel.issue', 'fuel.transfer', 'fuel.tanks.refill')) {
    throw httpError(403, 'You do not have permission to dispatch bulk tank transfers.');
  }

  const tr = get('SELECT * FROM fuel_tank_transfers WHERE id = ?', String(id));
  if (!tr) throw httpError(404, `Tank transfer request not found: ${id}`);

  if (tr.status === 'PENDING') {
    throw httpError(409, `Transfer ${tr.transfer_no} is still awaiting Transport Section approval before dispatch.`);
  }
  if (tr.status !== 'APPROVED') {
    throw httpError(409, `Transfer ${tr.transfer_no} cannot be dispatched in status '${tr.status}'.`);
  }

  const scope = actor ? fuelScope.getFuelScope(actor) : { scoped: false };
  if (scope.scoped) {
    fuelScope.assertTankInScope(actor, tr.source_tank_id, 'dispatch bulk fuel from this tank');
  }

  const rawDisp = payload.dispatchedLitres ?? payload.dispatched_litres ?? payload.litres;
  const qty = round1(rawDisp != null && rawDisp !== '' ? Number(rawDisp) : (tr.approved_litres || tr.requested_litres));
  if (!Number.isFinite(qty) || qty <= 0) {
    throw httpError(400, 'Dispatched litres must be greater than 0');
  }

  const bowser = (payload.bowserAssetId !== undefined || payload.bowser_asset_id !== undefined || payload.bowserCode !== undefined || payload.bowser_code !== undefined)
    ? resolveBowserInput(payload.bowserAssetId ?? payload.bowser_asset_id, payload.bowserCode ?? payload.bowser_code)
    : { assetId: tr.bowser_asset_id, code: tr.bowser_code };
  const driverName = payload.driverName !== undefined
    ? (String(payload.driverName || '').trim() || null)
    : tr.driver_name;
  const sealNo = String(payload.sealNo ?? payload.seal_no ?? '').trim() || null;
  const dispatchNote = String(payload.dispatchNote ?? payload.dispatch_note ?? payload.note ?? '').trim() || null;

  tx(() => {
    const cur = get('SELECT status FROM fuel_tank_transfers WHERE id = ?', tr.id);
    if (!cur || cur.status !== 'APPROVED') {
      throw httpError(409, `Transfer ${tr.transfer_no} was already processed.`);
    }
    fuelStock.deductStock(tr.source_tank_id, qty);
    run(`
      UPDATE fuel_tank_transfers
         SET status = 'IN_TRANSIT',
             dispatched_litres = ?,
             bowser_asset_id = ?,
             bowser_code = ?,
             driver_name = ?,
             seal_no = ?,
             dispatch_note = ?,
             dispatched_by = ?,
             dispatched_at = COALESCE(?, datetime('now')),
             updated_at = datetime('now')
       WHERE id = ?
    `,
      qty, bowser.assetId, bowser.code, driverName, sealNo, dispatchNote,
      actorId,
      payload.dispatchDate ? String(payload.dispatchDate).slice(0, 19).replace('T', ' ') : null,
      tr.id
    );
  });

  try {
    audit.record({
      userId: actorId,
      entity: 'fuel_tank_transfer',
      entityId: tr.id,
      action: 'fuel.tank_transfer.dispatched',
      after: { transferNo: tr.transfer_no, sourceTankId: tr.source_tank_id, dispatchedLitres: qty, sealNo, bowserCode: bowser.code },
    });
  } catch (_) {}

  return getTransferById(tr.id, actor);
}

function receiveTransfer(id, payload = {}, actor = null) {
  const actorId = actor && actor.id ? Number(actor.id) : 1;
  const isAdmin = Boolean(actor && Array.isArray(actor.roles) && actor.roles.includes('admin'));
  if (!isAdmin && !hasCap(actor, 'fuel.tanks.refill', 'fuel.issue', 'fuel.transfer')) {
    throw httpError(403, 'You do not have permission to receive bulk tank transfers.');
  }

  const tr = get('SELECT * FROM fuel_tank_transfers WHERE id = ?', String(id));
  if (!tr) throw httpError(404, `Tank transfer request not found: ${id}`);

  if (tr.status !== 'IN_TRANSIT') {
    throw httpError(409, `Transfer ${tr.transfer_no} must be IN_TRANSIT to confirm receipt (current status: '${tr.status}').`);
  }

  const scope = actor ? fuelScope.getFuelScope(actor) : { scoped: false };
  if (scope.scoped) {
    fuelScope.assertTankInScope(actor, tr.dest_tank_id, 'receive bulk fuel into this tank');
  }

  const rawRec = payload.receivedLitres ?? payload.received_litres ?? payload.litres;
  const qty = round1(rawRec != null && rawRec !== '' ? Number(rawRec) : tr.dispatched_litres);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw httpError(400, 'Actual received litres must be greater than 0');
  }

  const varianceLitres = round1(qty - Number(tr.dispatched_litres || 0));
  const receiveSealNo = String(payload.receiveSealNo ?? payload.receive_seal_no ?? payload.sealNo ?? '').trim() || null;
  const receiveNote = String(payload.receiveNote ?? payload.receive_note ?? payload.note ?? '').trim() || null;
  const receivedDate = payload.receivedDate
    ? String(payload.receivedDate).trim().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const srcTank = get('SELECT id, code, name FROM fuel_tanks WHERE id = ?', String(tr.source_tank_id));
  const supplierLabel = `Internal Transfer — ${(srcTank && srcTank.name) || tr.source_tank_id}${srcTank && srcTank.code ? ` (${srcTank.code})` : ''}`;
  const noteParts = [
    tr.bowser_code ? `Bowser: ${tr.bowser_code}` : '',
    tr.seal_no ? `Dispatch Seal: ${tr.seal_no}` : '',
    receiveSealNo ? `Recv Seal: ${receiveSealNo}` : '',
    receiveNote || '',
  ].filter(Boolean).join(' · ');

  const deliveryId = `deliv-ftr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  tx(() => {
    const cur = get('SELECT status FROM fuel_tank_transfers WHERE id = ?', tr.id);
    if (!cur || cur.status !== 'IN_TRANSIT') {
      throw httpError(409, `Transfer ${tr.transfer_no} was already received.`);
    }

    // Zero cost_cents prevents double-counting bulk purchase spend across sites
    run(`
      INSERT INTO fuel_bulk_deliveries (
        id, tank_id, litres, fuel_type, supplier, invoice_number, cost_cents, delivery_date, status, received_by, note
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'DELIVERED', ?, ?)
    `, deliveryId, String(tr.dest_tank_id), qty, tr.fuel_type || 'AUTO_DIESEL',
       supplierLabel, tr.transfer_no, receivedDate, actorId, noteParts || 'Internal tank transfer');

    fuelStock.restoreStock(tr.dest_tank_id, qty);

    run(`
      UPDATE fuel_tank_transfers
         SET status = 'RECEIVED',
             received_litres = ?,
             variance_litres = ?,
             receive_seal_no = ?,
             receive_note = ?,
             delivery_id = ?,
             received_by = ?,
             received_at = COALESCE(?, datetime('now')),
             updated_at = datetime('now')
       WHERE id = ?
    `,
      qty, varianceLitres, receiveSealNo, receiveNote, deliveryId, actorId,
      payload.receivedAt ? String(payload.receivedAt).slice(0, 19).replace('T', ' ') : null,
      tr.id
    );
  });

  try {
    audit.record({
      userId: actorId,
      entity: 'fuel_tank_transfer',
      entityId: tr.id,
      action: 'fuel.tank_transfer.received',
      after: {
        transferNo: tr.transfer_no,
        destTankId: tr.dest_tank_id,
        dispatchedLitres: tr.dispatched_litres,
        receivedLitres: qty,
        varianceLitres,
        deliveryId,
      },
    });
  } catch (_) {}

  return getTransferById(tr.id, actor);
}

function cancelTransfer(id, payload = {}, actor = null) {
  const actorId = actor && actor.id ? Number(actor.id) : 1;
  const isAdmin = Boolean(actor && Array.isArray(actor.roles) && actor.roles.includes('admin'));
  const tr = get('SELECT * FROM fuel_tank_transfers WHERE id = ?', String(id));
  if (!tr) throw httpError(404, `Tank transfer request not found: ${id}`);

  if (tr.status === 'RECEIVED') {
    throw httpError(409, 'Cannot cancel a tank transfer that has already been received');
  }
  if (tr.status === 'CANCELLED' || tr.status === 'REJECTED') {
    throw httpError(409, `Transfer ${tr.transfer_no} is already ${tr.status.toLowerCase()}`);
  }

  const scope = actor ? fuelScope.getFuelScope(actor) : { scoped: false };
  if (scope.scoped) {
    const allowed = new Set((scope.allowedTankIds || []).map(String));
    if (!allowed.has(String(tr.source_tank_id)) && !allowed.has(String(tr.dest_tank_id))) {
      throw httpError(403, 'Site/Tank isolation denied: cannot cancel another site tank transfer.');
    }
  }

  if (tr.status === 'IN_TRANSIT') {
    if (!isAdmin && !hasCap(actor, 'fuel.void', 'fuel.approve_correction')) {
      throw httpError(403, 'Only an Administrator can cancel an IN_TRANSIT transfer and restore source tank stock.');
    }
  } else {
    const canCancelOpen = isAdmin
      || Number(tr.requested_by) === actorId
      || hasCap(actor, 'fuel.approve_request', 'fuel.approve_site_request', 'fuel.approve', 'fuel.transfer', 'fuel.transport.request', 'fuel.request');
    if (!canCancelOpen) {
      throw httpError(403, 'You do not have permission to cancel this transfer request.');
    }
  }

  const reason = String(payload.reason || '').trim() || 'Cancelled';

  tx(() => {
    const cur = get('SELECT * FROM fuel_tank_transfers WHERE id = ?', tr.id);
    if (!cur || !['PENDING', 'APPROVED', 'IN_TRANSIT'].includes(cur.status)) {
      throw httpError(409, 'Transfer state changed concurrently');
    }
    if (cur.status === 'IN_TRANSIT' && Number(cur.dispatched_litres) > 0) {
      fuelStock.restoreStock(cur.source_tank_id, Number(cur.dispatched_litres));
    }
    run(`
      UPDATE fuel_tank_transfers
         SET status = 'CANCELLED',
             rejection_reason = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `, reason, tr.id);
  });

  try {
    audit.record({
      userId: actorId,
      entity: 'fuel_tank_transfer',
      entityId: tr.id,
      action: 'fuel.tank_transfer.cancelled',
      reason,
      after: { previousStatus: tr.status, restoredLitres: tr.status === 'IN_TRANSIT' ? tr.dispatched_litres : 0 },
    });
  } catch (_) {}

  return {
    ...getTransferById(tr.id, actor),
    restored_stock_litres: tr.status === 'IN_TRANSIT' ? Number(tr.dispatched_litres || 0) : 0,
  };
}

function getTransferSummary({ allowedTankIds = null, scopedProjectId = null } = {}) {
  const conds = [];
  const params = [];
  if (Array.isArray(allowedTankIds)) {
    if (allowedTankIds.length > 0 && scopedProjectId != null) {
      const marks = allowedTankIds.map(() => '?').join(',');
      conds.push(`(source_tank_id IN (${marks}) OR dest_tank_id IN (${marks}) OR source_project_id = ? OR dest_project_id = ?)`);
      params.push(...allowedTankIds, ...allowedTankIds, Number(scopedProjectId), Number(scopedProjectId));
    } else if (allowedTankIds.length > 0) {
      const marks = allowedTankIds.map(() => '?').join(',');
      conds.push(`(source_tank_id IN (${marks}) OR dest_tank_id IN (${marks}))`);
      params.push(...allowedTankIds, ...allowedTankIds);
    } else if (scopedProjectId != null) {
      conds.push('(source_project_id = ? OR dest_project_id = ?)');
      params.push(Number(scopedProjectId), Number(scopedProjectId));
    } else {
      return { pending: 0, approved: 0, inTransit: 0, received: 0, openTotal: 0 };
    }
  } else if (scopedProjectId != null) {
    conds.push('(source_project_id = ? OR dest_project_id = ?)');
    params.push(Number(scopedProjectId), Number(scopedProjectId));
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const row = get(`
    SELECT
      SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'IN_TRANSIT' THEN 1 ELSE 0 END) AS inTransit,
      SUM(CASE WHEN status = 'RECEIVED' THEN 1 ELSE 0 END) AS received
    FROM fuel_tank_transfers
    ${where}
  `, ...params) || {};
  const pending = Number(row.pending || 0);
  const approved = Number(row.approved || 0);
  const inTransit = Number(row.inTransit || 0);
  const received = Number(row.received || 0);
  return {
    pending,
    approved,
    inTransit,
    received,
    openTotal: pending + approved + inTransit,
  };
}

module.exports = {
  getTransferById,
  listTransfers,
  createTransferRequest,
  reviewTransferRequest,
  dispatchTransfer,
  receiveTransfer,
  cancelTransfer,
  getTransferSummary,
};
