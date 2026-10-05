'use strict';

/**
 * ===========================================================================
 * Step 4a: Supply Routes & Line-by-Line Quantity Pipeline
 * 
 * Line-by-line routing across 4 supply channels:
 *   1. main_store: Stock transfer from Central / Main Store (auto-MTN)
 *   2. head_office: Head Office centralized procurement
 *   3. local_purchase: Site local purchase (capped at Decision D4 Rs 25,000)
 *   4. direct_delivery: Direct vendor delivery straight to the site
 * 
 * Pipeline quantity progression per item line:
 *   qty (requested) → qty_approved → qty_sent → qty_received → qty_issued
 * ===========================================================================
 */

const { get, all, run, tx } = require('../db');
const audit = require('./audit');
const emitter = require('./emitter');
const chainPipeline = require('./chain_pipeline');

const ROUTES = ['main_store', 'head_office', 'local_purchase', 'direct_delivery'];

const ROUTE_LABELS = {
  main_store: 'Main Store Transfer (MTN)',
  head_office: 'Head Office Buy',
  local_purchase: 'Local Site Buy',
  direct_delivery: 'Direct Delivery to Site',
};

const ROUTE_BADGES = {
  main_store: 'blue',
  head_office: 'purple',
  local_purchase: 'amber',
  direct_delivery: 'green',
};

// Decision D4: Spending ceiling for site local purchases per request
const LOCAL_PURCHASE_CEILING = 25000; // Rs. 25,000

/**
 * Validate that a route string is one of the 4 defined supply routes.
 */
function validateRoute(route) {
  if (!route) return false;
  return ROUTES.includes(String(route).trim());
}

/**
 * Check whether a proposed local purchase amount (or total on an MRN) exceeds Decision D4 ceiling.
 */
function checkLocalPurchaseLimit(mrnId, lineId, proposedAmount) {
  const mid = Number(mrnId) || 0;
  if (!mid) return { ok: true };

  // Calculate sum of existing local purchase lines on this MRN, excluding the target line if updating
  const existingRows = all(`
    SELECT id, qty,
      COALESCE(
        (SELECT g.unit_price FROM grn g WHERE g.mrn_line_id = mrn_lines.id AND g.unit_price IS NOT NULL ORDER BY g.id DESC LIMIT 1),
        (SELECT g.unit_price FROM grn g WHERE g.store_item_id = mrn_lines.store_item_id AND g.unit_price IS NOT NULL ORDER BY g.id DESC LIMIT 1),
        (SELECT g2.unit_price FROM grn g2 WHERE LOWER(TRIM(g2.description)) = LOWER(TRIM(mrn_lines.description)) AND g2.unit_price IS NOT NULL ORDER BY g2.id DESC LIMIT 1),
        (SELECT si.unit_cost FROM store_items si WHERE si.id = mrn_lines.store_item_id),
        0
      ) AS est_price
    FROM mrn_lines
    WHERE mrn_id = ? AND supply_route = 'local_purchase'
  `, mid);

  let currentTotal = 0;
  for (const r of existingRows) {
    if (lineId && r.id === Number(lineId)) continue;
    currentTotal += (Number(r.qty) || 0) * (Number(r.est_price) || 0);
  }

  const newTotal = currentTotal + (Number(proposedAmount) || 0);
  if (newTotal > LOCAL_PURCHASE_CEILING) {
    return {
      ok: false,
      currentTotal,
      newTotal,
      ceiling: LOCAL_PURCHASE_CEILING,
      error: `Local purchase exceeds the ceiling of Rs ${LOCAL_PURCHASE_CEILING.toLocaleString()} per request (Decision D4). Estimated total: Rs ${newTotal.toLocaleString()}. Route via Head Office or obtain special approval.`,
    };
  }
  return { ok: true, currentTotal, newTotal, ceiling: LOCAL_PURCHASE_CEILING };
}

/**
 * Assign or update supply route on a specific MRN line.
 */
function setLineRoute(lineId, route, user, reason) {
  const id = Number(lineId) || 0;
  if (!id) throw new Error('Invalid line ID');

  const cleanRoute = String(route || '').trim();
  if (!validateRoute(cleanRoute)) {
    throw new Error(`Invalid supply route '${route}'. Choose: ${ROUTES.join(', ')}`);
  }

  const line = get('SELECT ml.*, m.workshop_id FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id WHERE ml.id = ?', id);
  if (!line) throw new Error('MRN line not found');

  // Check local purchase ceiling if route is local_purchase
  if (cleanRoute === 'local_purchase') {
    const estPrice = get(`
      SELECT COALESCE(
        (SELECT g.unit_price FROM grn g WHERE g.mrn_line_id = ? AND g.unit_price IS NOT NULL ORDER BY g.id DESC LIMIT 1),
        (SELECT g.unit_price FROM grn g WHERE g.store_item_id = ? AND g.unit_price IS NOT NULL ORDER BY g.id DESC LIMIT 1),
        (SELECT si.unit_cost FROM store_items si WHERE si.id = ?),
        0
      ) AS p`, id, line.store_item_id || 0, line.store_item_id || 0)?.p || 0;
    const lineCost = (Number(line.qty) || 0) * estPrice;
    if (lineCost > 0) {
      const chk = checkLocalPurchaseLimit(line.mrn_id, id, lineCost);
      if (!chk.ok) {
        const err = new Error(chk.error);
        err.statusCode = 403;
        throw err;
      }
    }
  }

  const beforeRoute = line.supply_route || 'main_store';
  const now = new Date().toISOString();
  const username = user ? (user.username || user.fullName || 'system') : 'system';

  // Map to legacy purchase_source for backwards compatibility
  let purchaseSource = null;
  if (cleanRoute === 'head_office') purchaseSource = 'head_office';
  else if (cleanRoute === 'local_purchase') purchaseSource = 'local_purchase';

  tx(() => {
    run(`
      UPDATE mrn_lines
         SET supply_route = ?,
             purchase_source = COALESCE(?, purchase_source),
             route_assigned_by = ?,
             route_assigned_at = ?,
             route_assigned_reason = ?
       WHERE id = ?
    `, cleanRoute, purchaseSource, username, now, reason || null, id);
  });

  audit.record({
    userId: user ? user.id : 1,
    entity: 'mrn_line',
    entityId: id,
    action: 'route_assignment',
    before: { supply_route: beforeRoute },
    after: { supply_route: cleanRoute, reason: reason || null },
  });

  emitter.emit('stock_updated', { mrn_line_id: id, action: 'route_assignment', supply_route: cleanRoute });
  return get('SELECT * FROM mrn_lines WHERE id = ?', id);
}

/**
 * Called when an MRN is approved.
 * 1. Sets qty_approved = qty for all lines if not yet set.
 * 2. If requesting workshop is not Main Store/Central Workshop and there are lines with
 *    supply_route = 'main_store', generates an auto-MTN (Material Transfer Note) draft.
 */
function onMrnApproved(mrnId, user) {
  const id = Number(mrnId) || 0;
  if (!id) return;

  const mrn = get(`
    SELECT m.*, w.id AS ws_id, w.name AS ws_name, w.code AS ws_code, w.is_default AS ws_default, w.own_store
      FROM mrn m
      LEFT JOIN workshops w ON w.id = m.workshop_id
     WHERE m.id = ?
  `, id);
  if (!mrn) return;

  // 1. Set qty_approved = qty on lines where qty_approved == 0
  run(`
    UPDATE mrn_lines
       SET qty_approved = CASE WHEN qty_approved IS NULL OR qty_approved = 0 THEN qty ELSE qty_approved END
     WHERE mrn_id = ?
  `, id);

  // 2. Check for main_store lines
  const mainStoreLines = all(`
    SELECT * FROM mrn_lines
     WHERE mrn_id = ? AND (supply_route = 'main_store' OR supply_route IS NULL OR supply_route = '')
  `, id);

  if (!mainStoreLines.length) return;

  // If requesting workshop is Central Workshop / default workshop with store 1, no inter-site MTN needed.
  const isCentral = mrn.ws_default === 1 || mrn.workshop_id === 1 || !mrn.workshop_id;
  if (isCentral) return;

  // Create auto-MTN transfer note from Central Store to the destination workshop
  const centralWs = get('SELECT id, name FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1') || { id: 1, name: 'Central Workshop - Badalgama' };
  const destName = mrn.ws_name || `Site Workshop ${mrn.workshop_id}`;
  const now = new Date().toISOString();
  const prepName = user ? (user.fullName || user.username) : 'System';

  // Determine next MTN number sequence (~58xxx)
  const lastMtn = get("SELECT mtn_no FROM mtn WHERE mtn_no GLOB '[0-9]*' ORDER BY CAST(mtn_no AS INTEGER) DESC LIMIT 1");
  const nextNo = lastMtn && Number(lastMtn.mtn_no) ? String(Number(lastMtn.mtn_no) + 1) : String(58000 + id);
  const chainNo = mrn.chain_no || chainPipeline.assignChainNo(id);

  tx(() => {
    // Check if an auto-MTN already exists for this MRN
    const existing = get('SELECT id FROM mtn WHERE mrn_id = ? AND auto_generated = 1', id);
    let mtnId;
    if (existing) {
      mtnId = existing.id;
      if (chainNo) run('UPDATE mtn SET chain_no = ? WHERE id = ? AND (chain_no IS NULL OR chain_no = \'\')', chainNo, mtnId);
    } else {
      const info = run(`
        INSERT INTO mtn (
          mtn_no, mr_no, mrn_id, auto_generated, txn_date,
          from_location, to_location, reason, prepared_by,
          prepared_at, prepared_designation, status, chain_no
        ) VALUES (
          ?, ?, ?, 1, date('now'),
          ?, ?, ?, ?,
          ?, 'Store In-Charge', 'draft', ?
        )
      `, nextNo, mrn.mrn_no, id, centralWs.name, destName,
         `Auto-transfer for approved request ${mrn.mrn_no}: ${mrn.purpose || ''}`.trim(),
         prepName, now, chainNo);
      mtnId = info.lastInsertRowid;
    }

    // Add lines to MTN
    let lineIdx = 1;
    for (const ml of mainStoreLines) {
      const alreadyLinked = get('SELECT id FROM mtn_lines WHERE mtn_id = ? AND mrn_line_id = ?', mtnId, ml.id);
      if (!alreadyLinked) {
        const transferQty = Number(ml.qty_approved) || Number(ml.qty) || 1;
        run(`
          INSERT INTO mtn_lines (
            mtn_id, line_no, store_item_id, description, qty, unit,
            category, from_location, to_location, reason, mr_no, mrn_id, mrn_line_id
          ) VALUES (
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?
          )
        `, mtnId, lineIdx++, ml.store_item_id || null, ml.description, transferQty, ml.unit || 'nos',
           ml.category || null, centralWs.name, destName, 'Requisition transfer', mrn.mrn_no, id, ml.id);

        run('UPDATE mrn_lines SET auto_mtn_id = ? WHERE id = ?', mtnId, ml.id);
      }
    }
  });

  emitter.emit('data_changed', { what: 'stores', mrn_id: id });
}

/**
 * Called when an MTN is dispatched.
 * Updates qty_sent on linked MRN lines.
 */
function onMtnDispatched(mtnId) {
  const mid = Number(mtnId) || 0;
  if (!mid) return;

  const lines = all('SELECT mrn_line_id, qty FROM mtn_lines WHERE mtn_id = ? AND mrn_line_id IS NOT NULL', mid);
  tx(() => {
    for (const l of lines) {
      run('UPDATE mrn_lines SET qty_sent = COALESCE(qty_sent, 0) + ? WHERE id = ?', Number(l.qty) || 0, l.mrn_line_id);
    }
  });
}

/**
 * Called when an MTN is accepted at destination workshop.
 * Updates qty_received on linked MRN lines.
 * Supports line-by-line actual receipts and short delivery discrepancy logging.
 * receipts: Array of { mtn_line_id, mrn_line_id, qty_received, reason }
 */
function onMtnAccepted(mtnId, receipts, user) {
  const mid = Number(mtnId) || 0;
  if (!mid) return;

  const lines = all('SELECT * FROM mtn_lines WHERE mtn_id = ? AND mrn_line_id IS NOT NULL', mid);
  const receiptMap = new Map();
  if (Array.isArray(receipts)) {
    for (const r of receipts) {
      if (r.mtn_line_id) receiptMap.set(Number(r.mtn_line_id), r);
      else if (r.mrn_line_id) receiptMap.set(`mrn_${r.mrn_line_id}`, r);
      else if (r.line_id) receiptMap.set(Number(r.line_id), r);
    }
  }

  tx(() => {
    for (const l of lines) {
      const sentQty = Number(l.qty) || 0;
      const rEntry = receiptMap.get(l.id) || receiptMap.get(`mrn_${l.mrn_line_id}`);
      let recQty = sentQty;
      let reason = null;

      if (rEntry && rEntry.qty_received !== undefined) {
        recQty = Math.max(0, Number(rEntry.qty_received) || 0);
        reason = rEntry.reason || rEntry.discrepancy_reason || null;
      }

      const shortQty = Math.max(0, sentQty - recQty);

      // Advance qty_received on MRN line
      run(`
        UPDATE mrn_lines
           SET qty_received = COALESCE(qty_received, 0) + ?,
               discrepancy_reason = COALESCE(?, discrepancy_reason)
         WHERE id = ?
      `, recQty, reason, l.mrn_line_id);

      // Record on MTN line
      run(`
        UPDATE mtn_lines
           SET qty_received = ?,
               discrepancy_reason = ?
         WHERE id = ?
      `, recQty, reason, l.id);

      // If short delivery detected, log to delivery_discrepancies
      if (shortQty > 0) {
        chainPipeline.recordDeliveryDiscrepancy({
          mrn_id: l.mrn_id,
          mrn_line_id: l.mrn_line_id,
          mtn_id: mid,
          mtn_line_id: l.id,
          item_description: l.description,
          qty_expected: sentQty,
          qty_received: recQty,
          reason: reason || 'Short delivery at destination site',
        }, user);
      }
    }
  });
}

/**
 * Called when an issue is created.
 * Updates qty_issued on the linked MRN line.
 */
function onIssueCreated(mrnLineId, qty) {
  const id = Number(mrnLineId) || 0;
  const q = Number(qty) || 0;
  if (!id || q <= 0) return;

  run('UPDATE mrn_lines SET qty_issued = COALESCE(qty_issued, 0) + ? WHERE id = ?', q, id);
}

/**
 * Called when an issue is returned or voided.
 * Decreases qty_issued on the linked MRN line.
 */
function onIssueReturned(mrnLineId, qty) {
  const id = Number(mrnLineId) || 0;
  const q = Number(qty) || 0;
  if (!id || q <= 0) return;

  run('UPDATE mrn_lines SET qty_issued = MAX(0, COALESCE(qty_issued, 0) - ?) WHERE id = ?', q, id);
}

/**
 * Get line-by-line pipeline status and quantities for an MRN.
 */
function getMrnPipeline(mrnId) {
  const mid = Number(mrnId) || 0;
  if (!mid) return [];

  const rows = all(`
    SELECT ml.id, ml.mrn_id, ml.description, ml.unit, ml.category,
           ml.qty AS qty_requested,
           COALESCE(ml.qty_approved, 0) AS qty_approved,
           COALESCE(ml.qty_sent, 0) AS qty_sent,
           COALESCE(ml.qty_received, 0) AS qty_received,
           COALESCE(ml.qty_issued, 0) AS qty_issued,
           COALESCE(ml.qty_short, 0) AS qty_short,
           ml.discrepancy_reason,
           COALESCE(ml.supply_route, 'main_store') AS supply_route,
           ml.auto_mtn_id,
           ml.route_assigned_by,
           ml.route_assigned_at,
           ml.route_assigned_reason,
           m.mrn_no, m.chain_no, m.approval_status,
           (SELECT mtn_no FROM mtn WHERE mtn.id = ml.auto_mtn_id) AS auto_mtn_no
      FROM mrn_lines ml
      JOIN mrn m ON m.id = ml.mrn_id
     WHERE ml.mrn_id = ?
     ORDER BY ml.id ASC
  `, mid);

  return rows.map((r) => {
    const req = Number(r.qty_requested) || 0;
    const appr = Number(r.qty_approved) || 0;
    const sent = Number(r.qty_sent) || 0;
    const recv = Number(r.qty_received) || 0;
    const iss = Number(r.qty_issued) || 0;
    const short = Number(r.qty_short) || 0;

    let stage = 'requested';
    if (r.approval_status === 'approved') {
      if (iss >= req && req > 0) stage = 'issued';
      else if (recv >= req && req > 0) stage = 'received';
      else if (recv > 0) stage = 'partially_received';
      else if (sent >= req && req > 0) stage = 'sent';
      else if (sent > 0) stage = 'partially_sent';
      else stage = 'approved';
    } else if (r.approval_status === 'certified') {
      stage = 'certified';
    } else if (r.approval_status === 'rejected') {
      stage = 'rejected';
    }

    const hasShortage = short > 0;
    const isDeficitOpen = hasShortage && (recv < req);

    return {
      ...r,
      route_label: ROUTE_LABELS[r.supply_route] || r.supply_route,
      route_badge: ROUTE_BADGES[r.supply_route] || '',
      pipeline_stage: stage,
      has_shortage: hasShortage,
      is_deficit_open: isDeficitOpen,
    };
  });
}

module.exports = {
  ROUTES,
  ROUTE_LABELS,
  ROUTE_BADGES,
  LOCAL_PURCHASE_CEILING,
  validateRoute,
  checkLocalPurchaseLimit,
  setLineRoute,
  onMrnApproved,
  onMtnDispatched,
  onMtnAccepted,
  onIssueCreated,
  onIssueReturned,
  getMrnPipeline,
};
