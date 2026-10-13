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
const stock = require('./stock');
const multidb = require('../db/multidb');
const storeLocations = require('./store_locations');

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
 * Step 7 (Phase C): Determine whether an item is supplied by:
 * - Central Main Stores (id = 1): General construction, civil materials, cement, steel, timber, safety PPE, tools, electricals
 * - Central Main Workshop Stores (id = 2): Heavy equipment spare parts, mechanical items, filters, oils/lubricants, tyres, batteries
 */
function determineItemSourceStore(line, fallbackStoreId = 2) {
  if (!line) return Number(fallbackStoreId) || 2;
  if (line.source_store_location_id) {
    return Number(line.source_store_location_id);
  }
  if (line.from_store_location_id) {
    return Number(line.from_store_location_id);
  }
  if (Number(fallbackStoreId) === 1 && (line.parent_mrn_line_id || line.replenishment_type === 'workshop_replenishment')) {
    return 1;
  }

  const cat = String(line.category || '').toLowerCase().trim();
  const desc = String(line.description || '').toLowerCase().trim();
  const section = stock.sectionOf(cat || desc);

  // 1. Explicit Workshop sections
  if (['filter', 'battery', 'tyre', 'oil'].includes(section)) {
    return 2; // Central Main Workshop Stores
  }

  // 2. Workshop keywords in category or description
  const workshopKeywords = [
    'filter', 'lubricant', 'grease', 'engine oil', 'hydraulic oil', 'gear oil', 'brake fluid', 'coolant',
    'battery', 'tyre', 'tire', 'tube', 'flap',
    'spare', 'spares', 'part', 'parts', 'mechanical', 'engine', 'hydraulic', 'transmission', 'gearbox',
    'brake', 'pad', 'shoe', 'disc', 'drum', 'caliper',
    'bearing', 'seal', 'oil seal', 'o-ring', 'gasket', 'hose', 'clutch', 'pressure plate',
    'alternator', 'starter motor', 'injector', 'turbo', 'fan belt', 'v-belt', 'radiator',
    'piston', 'liner', 'crankshaft', 'camshaft', 'valve', 'bushing', 'pin', 'track link', 'sprocket',
    'excavator', 'backhoe', 'loader', 'grader', 'roller', 'dozer', 'dump truck', 'tractor'
  ];

  for (const kw of workshopKeywords) {
    if (cat.includes(kw) || desc.includes(kw)) {
      return 2; // Central Main Workshop Stores
    }
  }

  // 3. General Site / Civil Construction materials keywords
  const generalKeywords = [
    'cement', 'concrete', 'sand', 'metal', 'aggregate', 'rubble', 'gravel', 'soil',
    'steel', 'rebar', 'gi wire', 'binding wire', 'mesh', 'iron', 'sheet', 'plate',
    'timber', 'wood', 'plank', 'plywood', 'formwork',
    'safety', 'ppe', 'helmet', 'boot', 'boots', 'vest', 'glove', 'gloves', 'goggles', 'harness',
    'electrical', 'cable', 'wire', 'conduit', 'bulb', 'switch', 'socket', 'breaker', 'mcb',
    'pipe', 'pvc', 'plumb', 'fitting', 'elbow', 'valve', 'tap',
    'brick', 'block', 'interlock', 'curb',
    'paint', 'thinner', 'primer', 'roller', 'brush',
    'hardware', 'nail', 'screw', 'bolt', 'nut', 'washer', 'anchor',
    'civil', 'construction', 'building', 'survey', 'level'
  ];

  for (const kw of generalKeywords) {
    if (cat.includes(kw) || desc.includes(kw)) {
      return 1; // Central Main Stores
    }
  }

  // If section is general and no mechanical keywords match, default to Main Stores (1)
  if (section === 'general') {
    return 1; // Central Main Stores
  }

  return Number(fallbackStoreId) || 2;
}

/**
 * Step 5/7: Check stock availability & active reservations at Central Stores (1) or Workshop Stores (2)
 * for an MRN or a specific MRN line.
 */
function checkMainWorkshopAvailability(mrnOrLineId, options = {}) {
  const defaultSendingStoreLocId = options.sendingStoreLocationId || 2;
  const defaultSendingStoreLoc = storeLocations.getStoreLocation(defaultSendingStoreLocId) || { id: defaultSendingStoreLocId, code: 'MAIN-WORKSHOP', name: 'Main Workshop Stores' };

  // Fetch pending undispatched MTN lines across stores for reservation calculation
  const pendingMtnLines = all(`
    SELECT ml.id, ml.mtn_id, ml.qty, ml.description, ml.category, ml.store_item_id, ml.mrn_id, ml.mrn_line_id,
           COALESCE(ml.from_store_location_id, t.from_store_location_id) AS from_store_location_id
      FROM mtn_lines ml
      JOIN mtn t ON t.id = ml.mtn_id
     WHERE t.status IN ('draft', 'approved', 'pending_approval')
  `);

  // Resolve destination store location if applicable
  let explicitDestLocId = options.destinationStoreLocationId || null;
  let targetMrn = null;
  if (typeof mrnOrLineId === 'number' || typeof mrnOrLineId === 'string') {
    targetMrn = get('SELECT * FROM mrn WHERE id = ?', Number(mrnOrLineId));
  } else if (mrnOrLineId && mrnOrLineId.mrn_id) {
    targetMrn = get('SELECT * FROM mrn WHERE id = ?', mrnOrLineId.mrn_id);
  }
  if (!explicitDestLocId && targetMrn) {
    explicitDestLocId = targetMrn.target_store_location_id
      ? targetMrn.target_store_location_id
      : (storeLocations.resolvePhysicalStore(targetMrn.workshop_id) || {}).id;
  }

  function checkLineAvailability(line, excludeMrnId = null, excludeMtnId = null, destLocId = null) {
    const reqQty = Number(line.qty) || 0;
    const section = stock.sectionOf(line.category || line.description);
    const itemKey = section === 'filter'
      ? (stock.filterKey(line.description) || stock.itemKey(section, line.description))
      : stock.itemKey(section, line.description);

    // Step 7 (Phase C): Determine supplying central store location for this line
    const lineSourceStoreId = options.sendingStoreLocationId || determineItemSourceStore(line, defaultSendingStoreLocId);
    const lineSourceLoc = storeLocations.getStoreLocation(lineSourceStoreId) || defaultSendingStoreLoc;

    // 1. Local Site Store shelf stock check
    const localStoreId = destLocId || explicitDestLocId;
    const localOnHand = (localStoreId && Number(localStoreId) !== Number(lineSourceStoreId))
      ? stock.balanceOf(section, itemKey, null, { physical_store_id: localStoreId })
      : 0;
    const localFulfillable = Math.min(reqQty, Math.max(0, localOnHand));
    const shortageQty = Math.max(0, reqQty - localFulfillable);

    // 2. Supplying Central Store stock & reservations
    const onHand = stock.balanceOf(section, itemKey, null, { physical_store_id: lineSourceStoreId });

    let reserved = 0;
    for (const r of pendingMtnLines) {
      if (r.from_store_location_id && Number(r.from_store_location_id) !== Number(lineSourceStoreId)) continue;
      if (excludeMtnId && r.mtn_id === Number(excludeMtnId)) continue;
      if (excludeMrnId && r.mrn_id === Number(excludeMrnId)) continue;
      if (line.id && r.mrn_line_id === Number(line.id)) continue;

      let match = false;
      if (line.store_item_id && r.store_item_id && line.store_item_id === r.store_item_id) {
        match = true;
      } else {
        const rSec = stock.sectionOf(r.category || r.description);
        const rKey = rSec === 'filter'
          ? (stock.filterKey(r.description) || stock.itemKey(rSec, r.description))
          : stock.itemKey(rSec, r.description);
        if (rSec === section && rKey === itemKey) match = true;
      }

      if (match) {
        reserved += Number(r.qty) || 0;
      }
    }

    const available = Math.max(0, Math.round((onHand - reserved) * 100) / 100);

    // Supplying store fulfills the shortage
    const centralFulfillable = Math.min(shortageQty, available);
    const totalFulfillable = localFulfillable + centralFulfillable;
    const outstandingQty = Math.max(0, reqQty - totalFulfillable);

    let status = 'unavailable';
    if (totalFulfillable >= reqQty) status = 'full';
    else if (totalFulfillable > 0) status = 'partial';
    else status = 'unavailable';

    return {
      line_id: line.id || null,
      description: line.description,
      category: line.category,
      unit: line.unit || 'nos',
      qty_requested: reqQty,
      qty_approved: Number(line.qty_approved) || 0,
      local_on_hand: localOnHand,
      local_fulfillable_qty: localFulfillable,
      shortage_qty: shortageQty,
      on_hand: onHand,
      reserved: reserved,
      available: available,
      status: status,
      fulfillable_qty: totalFulfillable,
      central_fulfillable_qty: centralFulfillable,
      outstanding_qty: outstandingQty,
      source_store_location_id: lineSourceStoreId,
      source_store_name: lineSourceLoc.name,
      source_store_code: lineSourceLoc.code || `STORE-${lineSourceStoreId}`,
      destination_store_location_id: localStoreId,
    };
  }

  // If passed an object representing a line
  if (typeof mrnOrLineId === 'object' && mrnOrLineId !== null) {
    if (mrnOrLineId.description) {
      return checkLineAvailability(mrnOrLineId, mrnOrLineId.mrn_id, options.excludeMtnId, explicitDestLocId);
    }
  }

  const idNum = Number(mrnOrLineId) || 0;
  if (!idNum) return null;

  // Check if idNum is an MRN ID
  const mrn = get('SELECT * FROM mrn WHERE id = ?', idNum);
  if (mrn) {
    const destStoreLoc = mrn.target_store_location_id
      ? storeLocations.getStoreLocation(mrn.target_store_location_id)
      : (storeLocations.resolvePhysicalStore(mrn.workshop_id) || null);
    const resolvedDestId = destStoreLoc ? destStoreLoc.id : null;

    const lines = all('SELECT * FROM mrn_lines WHERE mrn_id = ? AND (is_cancelled IS NULL OR is_cancelled = 0) ORDER BY id ASC', mrn.id);
    const lineResults = lines.map((l) => checkLineAvailability(l, mrn.id, options.excludeMtnId, resolvedDestId));

    const mainStoreResults = lineResults.filter((_, idx) => {
      const l = lines[idx];
      return l.supply_route === 'main_store' || !l.supply_route;
    });

    let overallStatus = 'unavailable';
    if (!mainStoreResults.length) {
      overallStatus = 'full';
    } else if (mainStoreResults.every((l) => l.status === 'full')) {
      overallStatus = 'full';
    } else if (mainStoreResults.every((l) => l.status === 'unavailable')) {
      overallStatus = 'unavailable';
    } else {
      overallStatus = 'partial';
    }

    return {
      mrn_id: mrn.id,
      mrn_no: mrn.mrn_no,
      source_store_location_id: defaultSendingStoreLocId,
      source_store_code: defaultSendingStoreLoc.code || 'MAIN-WORKSHOP',
      source_store_name: defaultSendingStoreLoc.name,
      target_store_location_id: destStoreLoc ? destStoreLoc.id : null,
      target_store_name: destStoreLoc ? destStoreLoc.name : null,
      overall_status: overallStatus,
      lines: lineResults,
    };
  }

  // Fallback: check if idNum is a line ID
  const line = get('SELECT * FROM mrn_lines WHERE id = ?', idNum);
  if (line) {
    return checkLineAvailability(line, line.mrn_id, options.excludeMtnId, explicitDestLocId);
  }

  return null;
}

/**
 * Step 6 (Phase B): Create or update a linked Child Replenishment MRN
 * from Central Main Workshop Stores (from_store_location_id = 2) to Central Main Stores (1)
 * when Main Workshop has insufficient on-hand stock for a remote site demand.
 */
function createOrUpdateChildReplenishment(parentMrnId, shortageLines, user) {
  const pId = Number(parentMrnId) || 0;
  if (!pId || !Array.isArray(shortageLines) || !shortageLines.length) return null;

  const parentMrn = get('SELECT * FROM mrn WHERE id = ?', pId);
  if (!parentMrn || parentMrn.parent_mrn_id || parentMrn.replenishment_type === 'workshop_replenishment') {
    return null; // Avoid recursion: do not create child of a child replenishment
  }

  const prepName = user ? (user.fullName || user.username) : 'Main Workshop Storekeeper';
  let childMrnId = null;

  tx(() => {
    // Check if a child replenishment MRN already exists for this parent
    let childMrn = get("SELECT * FROM mrn WHERE parent_mrn_id = ? AND replenishment_type = 'workshop_replenishment'", pId);
    if (childMrn) {
      childMrnId = childMrn.id;
    } else {
      const lastMrn = get("SELECT mrn_no FROM mrn WHERE mrn_no GLOB '[0-9]*' ORDER BY CAST(mrn_no AS INTEGER) DESC LIMIT 1");
      const nextNo = lastMrn && Number(lastMrn.mrn_no) ? String(Number(lastMrn.mrn_no) + 1) : String(167500 + pId);

      const info = run(`
        INSERT INTO mrn (
          mrn_no, req_date, workshop_id,
          from_store_location_id, target_store_location_id,
          parent_mrn_id, replenishment_type,
          purpose, requested_by,
          approval_status, site_authority_status, status,
          chain_no
        ) VALUES (
          ?, date('now'), 1,
          2, 2,
          ?, 'workshop_replenishment',
          ?, ?,
          'certified', 'approved', 'open',
          ?
        )
      `, nextNo, pId,
         `Replenishment for site request ${parentMrn.mrn_no}: ${parentMrn.purpose || ''}`.trim(),
         prepName,
         parentMrn.chain_no || null);
      childMrnId = info.lastInsertRowid;
    }

    // Insert or update child replenishment lines
    for (const sl of shortageLines) {
      const neededQty = Number(sl.qty_outstanding) || 0;
      if (neededQty <= 0) continue;

      const existingChildLine = get('SELECT id, qty FROM mrn_lines WHERE mrn_id = ? AND parent_mrn_line_id = ?', childMrnId, sl.id);
      let childLineId;
      if (existingChildLine) {
        childLineId = existingChildLine.id;
        run(`
          UPDATE mrn_lines
             SET qty = ?,
                 qty_outstanding = ?
           WHERE id = ?
        `, neededQty, neededQty, childLineId);
      } else {
        const lineInfo = run(`
          INSERT INTO mrn_lines (
            mrn_id, parent_mrn_line_id, store_item_id, description,
            qty, unit, category, category_id,
            supply_route, target_store_location_id, source_store_location_id,
            qty_approved, qty_outstanding
          ) VALUES (
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            'main_store', 2, 1,
            0, ?
          )
        `, childMrnId, sl.id, sl.store_item_id || null, sl.description,
           neededQty, sl.unit || 'nos', sl.category || null, sl.category_id || null,
           neededQty);
        childLineId = lineInfo.lastInsertRowid;
      }

      // Link child to parent line
      run(`
        UPDATE mrn_lines
           SET child_mrn_id = ?,
               child_mrn_line_id = ?
         WHERE id = ?
      `, childMrnId, childLineId, sl.id);
    }
  });

  if (childMrnId) {
    emitter.emit('data_changed', { what: 'stores', mrn_id: childMrnId, parent_mrn_id: pId });
  }

  return childMrnId;
}

/**
 * Step 6 (Phase B): Back-to-Back Cascading Unblocking.
 * When replenished stock arrives at Central Main Workshop (ID: 2),
 * this function is called with the parent_mrn_line_id and newly received quantity.
 * It advances the parent MRN line's approved quantity, reduces outstanding quantity,
 * and auto-drafts the secondary transfer MTN from Main Workshop (2) to the destination Site Store.
 */
function triggerBackToBackTransfer(parentLineId, qtyReceived, user) {
  const plId = Number(parentLineId) || 0;
  const recvQty = Number(qtyReceived) || 0;
  if (!plId || recvQty <= 0) return null;

  const parentLine = get('SELECT * FROM mrn_lines WHERE id = ?', plId);
  if (!parentLine) return null;
  const parentMrn = get('SELECT * FROM mrn WHERE id = ?', parentLine.mrn_id);
  if (!parentMrn) return null;

  const prepName = user ? (user.fullName || user.username) : 'Main Workshop Storekeeper';
  const destLocId = parentMrn.target_store_location_id;
  const destLoc = destLocId ? storeLocations.getStoreLocation(destLocId) : null;
  const destName = destLoc ? destLoc.name : `Site Workshop ${parentMrn.workshop_id}`;
  const destWsId = destLoc ? (destLoc.workshop_id || parentMrn.workshop_id) : parentMrn.workshop_id;

  let targetMtnId = null;

  tx(() => {
    // 1. Advance parent line qty_approved and decrease qty_outstanding
    const currentApproved = Number(parentLine.qty_approved) || 0;
    const currentOutstanding = Number(parentLine.qty_outstanding) || 0;
    const currentReq = Number(parentLine.qty) || 0;

    const newApproved = Math.min(currentReq, currentApproved + recvQty);
    const newOutstanding = Math.max(0, currentOutstanding - recvQty);

    run(`
      UPDATE mrn_lines
         SET qty_approved = ?,
             qty_outstanding = ?
       WHERE id = ?
    `, newApproved, newOutstanding, plId);

    // 2. Draft transfer MTN from Main Workshop (2) to Site Store (destLocId)
    // Check if an existing DRAFT MTN exists for this parent MRN
    let existingDraftMtn = get("SELECT * FROM mtn WHERE mrn_id = ? AND auto_generated = 1 AND status = 'draft'", parentMrn.id);
    if (existingDraftMtn) {
      targetMtnId = existingDraftMtn.id;
      const existingLine = get('SELECT id, qty FROM mtn_lines WHERE mtn_id = ? AND mrn_line_id = ?', targetMtnId, plId);
      if (existingLine) {
        run('UPDATE mtn_lines SET qty = qty + ? WHERE id = ?', recvQty, existingLine.id);
      } else {
        run(`
          INSERT INTO mtn_lines (
            mtn_id, line_no, store_item_id, description, qty, unit,
            category, from_location, to_location,
            from_store_location_id, to_store_location_id, from_store_id, to_store_id,
            reason, mr_no, mrn_id, mrn_line_id
          ) VALUES (
            ?, 1, ?, ?, ?, ?,
            ?, 'Main Workshop Stores', ?,
            2, ?, 1, ?,
            'Replenishment continuation transfer', ?, ?, ?
          )
        `, targetMtnId, parentLine.store_item_id || null, parentLine.description, recvQty, parentLine.unit || 'nos',
           parentLine.category || null, destName,
           destLocId, destWsId,
           parentMrn.mrn_no, parentMrn.id, plId);
      }
    } else {
      // Create new continuation MTN
      const lastMtn = get("SELECT mtn_no FROM mtn WHERE mtn_no GLOB '[0-9]*' ORDER BY CAST(mtn_no AS INTEGER) DESC LIMIT 1");
      const nextNo = lastMtn && Number(lastMtn.mtn_no) ? String(Number(lastMtn.mtn_no) + 1) : String(58000 + parentMrn.id);

      const mtnInfo = run(`
        INSERT INTO mtn (
          mtn_no, mr_no, mrn_id, auto_generated, txn_date,
          from_location, to_location, from_store_location_id, to_store_location_id,
          from_store_id, to_store_id, workshop_id,
          reason, prepared_by, prepared_at, prepared_designation, status, chain_no
        ) VALUES (
          ?, ?, ?, 1, date('now'),
          'Main Workshop Stores', ?, 2, ?,
          1, ?, 1,
          ?, ?, datetime('now'), 'Store In-Charge', 'draft', ?
        )
      `, nextNo, parentMrn.mrn_no, parentMrn.id,
         destName, destLocId,
         destWsId,
         `Continuation transfer from replenishment for ${parentMrn.mrn_no}`.trim(),
         prepName, parentMrn.chain_no);
      targetMtnId = mtnInfo.lastInsertRowid;

      run(`
        INSERT INTO mtn_lines (
          mtn_id, line_no, store_item_id, description, qty, unit,
          category, from_location, to_location,
          from_store_location_id, to_store_location_id, from_store_id, to_store_id,
          reason, mr_no, mrn_id, mrn_line_id
        ) VALUES (
          ?, 1, ?, ?, ?, ?,
          ?, 'Main Workshop Stores', ?,
          2, ?, 1, ?,
          'Replenishment continuation transfer', ?, ?, ?
        )
      `, targetMtnId, parentLine.store_item_id || null, parentLine.description, recvQty, parentLine.unit || 'nos',
         parentLine.category || null, destName,
         destLocId, destWsId,
         parentMrn.mrn_no, parentMrn.id, plId);

      run('UPDATE mrn_lines SET auto_mtn_id = ? WHERE id = ?', targetMtnId, plId);
    }
  });

  emitter.emit('data_changed', { what: 'stores', mrn_id: parentMrn.id, mtn_id: targetMtnId });
  return targetMtnId;
}

/**
 * Called when an MRN is approved.
 * 1. Checks Site Authority gate: unapproved site requests cannot generate transfers.
 * 2. Checks local shelf stock at requesting Site Store FIRST! If local stock is available,
 *    it is allocated for local issue; only the remaining shortage escalates to Central Main Workshop.
 * 3. Drafts auto-MTN for fulfillable central transfer quantity.
 * 4. Drafts Child Replenishment MRN to Central Main Stores if shortage cannot be covered.
 */
function onMrnApproved(mrnId, user, options = {}) {
  const id = Number(mrnId) || 0;
  if (!id) return;

  const mrn = get(`
    SELECT m.*, w.id AS ws_id, w.name AS ws_name, w.code AS ws_code, w.is_default AS ws_default, w.own_store
      FROM mrn m
      LEFT JOIN workshops w ON w.id = m.workshop_id
     WHERE m.id = ?
  `, id);
  if (!mrn) return;

  const chainNo = mrn.chain_no || chainPipeline.assignChainNo(id);
  if (!mrn.chain_no) mrn.chain_no = chainNo;

  // Resolve destination store location (the Site Store on site)
  const destStoreLoc = mrn.target_store_location_id
    ? storeLocations.getStoreLocation(mrn.target_store_location_id)
    : (storeLocations.resolvePhysicalStore(mrn.workshop_id) || null);
  const destStoreLocId = destStoreLoc ? destStoreLoc.id : null;
  const destWsId = destStoreLoc ? (destStoreLoc.workshop_id || mrn.workshop_id) : mrn.workshop_id;
  const destName = destStoreLoc ? destStoreLoc.name : (mrn.ws_name || `Site Workshop ${mrn.workshop_id}`);

  const isReplenishment = mrn.replenishment_type === 'workshop_replenishment' || Boolean(mrn.parent_mrn_id);

  // Determine sending store location:
  let sendingStoreLocId = 2; // Default: Central Main Workshop Stores
  if (isReplenishment) {
    sendingStoreLocId = 1; // Sourced from Central Main Stores (1) to replenish Main Workshop (2)
  } else if (destStoreLoc && destStoreLoc.parent_store_id) {
    sendingStoreLocId = destStoreLoc.parent_store_id;
  }
  const sendingStoreLoc = storeLocations.getStoreLocation(sendingStoreLocId) || { id: 2, code: 'MAIN-WORKSHOP', name: 'Main Workshop Stores', workshop_id: 1 };
  const sendingWsId = sendingStoreLoc.workshop_id || 1;

  // If requesting workshop is Central Workshop itself (same store), no inter-site MTN needed.
  // Note: Transfers between Main Stores (1) and Main Workshop (2) are distinct physical stores (1 != 2)!
  const isSameStore = Boolean(destStoreLocId && sendingStoreLocId && destStoreLocId === sendingStoreLocId);

  // Phase A Gate: Site Authority Demand Approval Gate
  // A Site request must NOT enter store fulfillment queues or generate MTNs until its assigned Site Authority approves it.
  const isSiteRequest = !isSameStore && !isReplenishment && ((destStoreLoc && destStoreLoc.store_type === 'SITE_STORE') || (mrn.workshop_id && mrn.workshop_id !== 1));
  if (isSiteRequest && mrn.site_authority_status !== 'approved' && !options.bypassGate) {
    return { gated: true, status: 'pending_site_authority', mrn_id: id };
  }

  // Check lines with supply_route = 'main_store'
  const mainStoreLines = all(`
    SELECT * FROM mrn_lines
     WHERE mrn_id = ?
       AND (supply_route = 'main_store' OR supply_route IS NULL OR supply_route = '')
       AND (is_cancelled IS NULL OR is_cancelled = 0)
     ORDER BY id ASC
  `, id);

  // Line availability & approved quantity calculation
  for (const ml of mainStoreLines) {
    let approvedQty = Number(ml.qty_approved) || 0;
    const reqQty = Number(ml.qty) || 0;
    const section = stock.sectionOf(ml.category || ml.description);
    const itemKey = section === 'filter'
      ? (stock.filterKey(ml.description) || stock.itemKey(section, ml.description))
      : stock.itemKey(section, ml.description);

    // 1. Check requesting Site Store's own local shelf stock first!
    // Note: Replenishment requests to Central Main Stores should not be fulfilled locally.
    const localStoreId = (!isReplenishment && destStoreLocId && !isSameStore) ? destStoreLocId : null;
    const localOnHand = localStoreId
      ? stock.balanceOf(section, itemKey, null, { physical_store_id: localStoreId })
      : 0;
    const localFulfillable = Math.min(reqQty, Math.max(0, localOnHand));
    const shortageQty = Math.max(0, reqQty - localFulfillable);

    // Step 7 (Phase C): Determine supplying central store location for this line
    const lineSourceStoreId = isReplenishment
      ? 1
      : determineItemSourceStore(ml, sendingStoreLocId);
    ml.source_store_location_id = lineSourceStoreId;

    // 2. Supplying Central Store (Store 2 for workshop parts, Store 1 for civil/general materials) covers the shortage
    let centralTransferQty = 0;
    if (shortageQty > 0) {
      if (isSameStore) {
        centralTransferQty = shortageQty;
      } else {
        const avail = checkMainWorkshopAvailability(ml, {
          sendingStoreLocationId: lineSourceStoreId,
          destinationStoreLocationId: destStoreLocId
        });
        centralTransferQty = avail ? Math.min(shortageQty, avail.available) : shortageQty;
      }
    }

    const totalApproved = localFulfillable + centralTransferQty;
    const outstandingQty = Math.max(0, reqQty - totalApproved);

    run(`
      UPDATE mrn_lines
         SET local_issue_qty = ?,
             qty_approved = ?,
             qty_outstanding = ?,
             source_store_location_id = ?
       WHERE id = ?
    `, localFulfillable, totalApproved, outstandingQty, lineSourceStoreId, ml.id);
    ml.local_issue_qty = localFulfillable;
    ml.qty_approved = totalApproved;
    ml.qty_outstanding = outstandingQty;
    ml.qty_to_transfer = centralTransferQty;
  }

  // Update non-main_store lines (e.g. head_office, local_purchase)
  run(`
    UPDATE mrn_lines
       SET qty_approved = CASE WHEN qty_approved IS NULL OR qty_approved = 0 THEN qty ELSE qty_approved END,
           qty_outstanding = CASE WHEN qty_approved IS NULL OR qty_approved = 0 THEN 0 ELSE MAX(0, qty - qty_approved) END
     WHERE mrn_id = ?
       AND supply_route NOT IN ('main_store')
       AND supply_route IS NOT NULL
  `, id);

  // Step 6 (Phase B): Check if any workshop parts central shortage lines require replenishment from Main Stores (1)
  // When a site request arrives for Workshop parts (source_store_location_id === 2), and Main Workshop cannot fully satisfy the shortage:
  if (!mrn.parent_mrn_id && mrn.replenishment_type !== 'workshop_replenishment') {
    const workshopShortageLines = mainStoreLines.filter((l) => Number(l.source_store_location_id) === 2 && Number(l.qty_outstanding) > 0);
    if (workshopShortageLines.length > 0) {
      createOrUpdateChildReplenishment(id, workshopShortageLines, user);
    }
  }

  if (isSameStore || !mainStoreLines.length) {
    emitter.emit('data_changed', { what: 'stores', mrn_id: id });
    return;
  }

  // Filter lines that require an actual central transfer (qty_to_transfer > 0)
  const linesToTransfer = mainStoreLines.filter((l) => Number(l.qty_to_transfer) > 0);
  if (!linesToTransfer.length) {
    // If all lines are fulfilled locally from the site store's own shelf, NO central transfer note is needed!
    emitter.emit('data_changed', { what: 'stores', mrn_id: id });
    return;
  }

  // Group transfer lines by supplying central store location (Store 2 Main Workshop vs Store 1 Main Stores)
  const transfersBySource = new Map();
  for (const ml of linesToTransfer) {
    const srcId = Number(ml.source_store_location_id) || sendingStoreLocId;
    if (!transfersBySource.has(srcId)) {
      transfersBySource.set(srcId, []);
    }
    transfersBySource.get(srcId).push(ml);
  }

  // Create or update auto-MTN transfer note(s) per supplying store location
  const now = new Date().toISOString();
  const prepName = user ? (user.fullName || user.username) : 'System';

  tx(() => {
    for (const [srcStoreId, srcLines] of transfersBySource.entries()) {
      const srcStoreLoc = storeLocations.getStoreLocation(srcStoreId) || storeLocations.getStoreLocation(2);
      const srcWsId = srcStoreLoc.workshop_id || 1;
      const srcStoreName = srcStoreLoc.name || (srcStoreId === 1 ? 'Central Main Stores' : 'Main Workshop Stores');

      // Check if an auto-MTN already exists for this MRN and this supplying warehouse
      const existing = get(`
        SELECT id FROM mtn
         WHERE mrn_id = ?
           AND auto_generated = 1
           AND (from_store_location_id = ? OR (from_store_location_id IS NULL AND ? = 2))
      `, id, srcStoreId, srcStoreId);

      let mtnId;
      if (existing) {
        mtnId = existing.id;
        run(`
          UPDATE mtn
             SET from_store_location_id = ?,
                 to_store_location_id = ?,
                 from_location = ?,
                 to_location = ?,
                 from_store_id = ?,
                 to_store_id = ?,
                 workshop_id = ?,
                 chain_no = COALESCE(chain_no, ?)
           WHERE id = ?
        `, srcStoreId, destStoreLocId, srcStoreName, destName, srcWsId, destWsId, srcWsId, chainNo, mtnId);
      } else {
        const lastMtn = get("SELECT mtn_no FROM mtn WHERE mtn_no GLOB '[0-9]*' ORDER BY CAST(mtn_no AS INTEGER) DESC LIMIT 1");
        let nextNumVal = lastMtn && Number(lastMtn.mtn_no) ? Number(lastMtn.mtn_no) + 1 : 58000 + id;
        while (get('SELECT 1 FROM mtn WHERE mtn_no = ?', String(nextNumVal))) {
          nextNumVal++;
        }
        const nextNo = String(nextNumVal);

        const info = run(`
          INSERT INTO mtn (
            mtn_no, mr_no, mrn_id, auto_generated, txn_date,
            from_location, to_location, from_store_location_id, to_store_location_id,
            from_store_id, to_store_id, workshop_id,
            reason, prepared_by, prepared_at, prepared_designation, status, chain_no
          ) VALUES (
            ?, ?, ?, 1, date('now'),
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, 'Store In-Charge', 'draft', ?
          )
        `, nextNo, mrn.mrn_no, id,
           srcStoreName, destName, srcStoreId, destStoreLocId,
           srcWsId, destWsId, srcWsId,
           `Auto-transfer (${srcStoreName}) for approved request ${mrn.mrn_no}: ${mrn.purpose || ''}`.trim(),
           prepName, now, chainNo);
        mtnId = info.lastInsertRowid;
      }

      // Add or update lines in this MTN
      let lineIdx = 1;
      for (const ml of srcLines) {
        const transferQty = Number(ml.qty_to_transfer);
        const alreadyLinked = get('SELECT id FROM mtn_lines WHERE mtn_id = ? AND mrn_line_id = ?', mtnId, ml.id);
        if (alreadyLinked) {
          run(`
            UPDATE mtn_lines
               SET qty = ?,
                   from_store_location_id = ?,
                   to_store_location_id = ?,
                   from_store_id = ?,
                   to_store_id = ?,
                   from_location = ?,
                   to_location = ?
             WHERE id = ?
          `, transferQty, srcStoreId, destStoreLocId, srcWsId, destWsId, srcStoreName, destName, alreadyLinked.id);
        } else {
          run(`
            INSERT INTO mtn_lines (
              mtn_id, line_no, store_item_id, description, qty, unit,
              category, from_location, to_location,
              from_store_location_id, to_store_location_id, from_store_id, to_store_id,
              reason, mr_no, mrn_id, mrn_line_id
            ) VALUES (
              ?, ?, ?, ?, ?, ?,
              ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?, ?
            )
          `, mtnId, lineIdx++, ml.store_item_id || null, ml.description, transferQty, ml.unit || 'nos',
             ml.category || null, srcStoreName, destName,
             srcStoreId, destStoreLocId, srcWsId, destWsId,
             'Requisition transfer', mrn.mrn_no, id, ml.id);
        }

        run('UPDATE mrn_lines SET auto_mtn_id = ? WHERE id = ?', mtnId, ml.id);
      }
    }
  });

  emitter.emit('data_changed', { what: 'stores', mrn_id: id });
}

/**
 * Phase A: Site Authority Demand Approval.
 * Approves the operational need (item, qty, vehicle/asset, job card, reason).
 * Seals the demand and triggers local stock check and central fulfillment.
 */
function onSiteAuthorityApproved(mrnId, user, options = {}) {
  const id = Number(mrnId) || 0;
  if (!id) return null;
  const notes = options.notes || null;
  const uId = user ? user.id : null;

  run(`
    UPDATE mrn
       SET site_authority_status = 'approved',
           site_authority_user_id = ?,
           site_authority_at = datetime('now'),
           site_authority_notes = ?
     WHERE id = ?
  `, uId, notes, id);

  onMrnApproved(id, user, { bypassGate: true });
  return get('SELECT * FROM mrn WHERE id = ?', id);
}

/**
 * Phase A: Site Authority Demand Rejection.
 * Returns to requester with reason; zero stock moved or reserved.
 */
function onSiteAuthorityRejected(mrnId, user, reason = '') {
  const id = Number(mrnId) || 0;
  if (!id) return null;
  const uId = user ? user.id : null;

  run(`
    UPDATE mrn
       SET site_authority_status = 'rejected',
           site_authority_user_id = ?,
           site_authority_at = datetime('now'),
           site_authority_notes = ?,
           approval_status = 'rejected'
     WHERE id = ?
  `, uId, reason, id);

  return get('SELECT * FROM mrn WHERE id = ?', id);
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

  // Cross-workshop synchronization for MULTIDB mode:
  // Propagate dispatch status to destination workshop database
  if (multidb.isMultiDb()) {
    try {
      const mtn = get('SELECT * FROM mtn WHERE id = ?', mid);
      if (mtn) {
        const anyLine = get('SELECT to_store_id FROM mtn_lines WHERE mtn_id = ? AND to_store_id IS NOT NULL LIMIT 1', mid);
        const toWsId = anyLine ? anyLine.to_store_id : null;
        if (toWsId && toWsId !== multidb.activeWorkshopId()) {
          multidb.withWorkshop(toWsId, () => {
            const destMtn = get('SELECT id FROM mtn WHERE chain_no = ? OR mtn_no = ?', mtn.chain_no, mtn.mtn_no);
            if (destMtn) {
              run(`UPDATE mtn SET status = 'dispatched',
                                  approved_by = COALESCE(?, approved_by),
                                  approved_sig = COALESCE(?, approved_sig),
                                  approved_at = COALESCE(?, approved_at),
                                  approved_designation = COALESCE(?, approved_designation),
                                  received_by = COALESCE(?, received_by),
                                  received_sig = COALESCE(?, received_sig),
                                  received_at = COALESCE(?, received_at),
                                  received_designation = COALESCE(?, received_designation)
                    WHERE id = ?`,
                mtn.approved_by, mtn.approved_sig, mtn.approved_at, mtn.approved_designation,
                mtn.received_by, mtn.received_sig, mtn.received_at, mtn.received_designation,
                destMtn.id);
            }
          });
        }
      }
    } catch (e) {
      console.warn('[supply_routes] Failed to sync dispatched MTN across workshops:', e.message);
    }
  }
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

  const lines = all('SELECT * FROM mtn_lines WHERE mtn_id = ?', mid);
  const receiptMap = new Map();
  if (Array.isArray(receipts)) {
    for (const r of receipts) {
      if (r.mtn_line_id) receiptMap.set(Number(r.mtn_line_id), r);
      else if (r.mrn_line_id) receiptMap.set(`mrn_${r.mrn_line_id}`, r);
      else if (r.line_id) receiptMap.set(Number(r.line_id), r);
    }
  }

  const affectedMrnIds = new Set();

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

      // Advance qty_received on MRN line if linked
      if (l.mrn_line_id) {
        run(`
          UPDATE mrn_lines
             SET qty_received = COALESCE(qty_received, 0) + ?,
                 qty_outstanding = MAX(0, qty - (COALESCE(qty_received, 0) + ?)),
                 discrepancy_reason = COALESCE(?, discrepancy_reason)
           WHERE id = ?
        `, recQty, recQty, reason, l.mrn_line_id);

        const mrnIdOfLine = l.mrn_id || (get('SELECT mrn_id FROM mrn_lines WHERE id = ?', l.mrn_line_id)?.mrn_id);
        if (mrnIdOfLine) affectedMrnIds.add(mrnIdOfLine);

        // Step 6 (Phase B): Back-to-Back unblocking for child replenishment
        const childLine = get('SELECT id, parent_mrn_line_id FROM mrn_lines WHERE id = ?', l.mrn_line_id);
        if (childLine && childLine.parent_mrn_line_id && recQty > 0) {
          triggerBackToBackTransfer(childLine.parent_mrn_line_id, recQty, user);
        }
      }

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
          mrn_id: l.mrn_id || null,
          mrn_line_id: l.mrn_line_id || null,
          mtn_id: mid,
          mtn_line_id: l.id,
          item_description: l.description,
          qty_expected: sentQty,
          qty_received: recQty,
          reason: reason || 'Short delivery at destination site',
        }, user);
      }
    }

    // Advance MRN header status based on destination receipt
    for (const mrnId of affectedMrnIds) {
      const mLines = all('SELECT qty, qty_received, is_cancelled FROM mrn_lines WHERE mrn_id = ?', mrnId);
      const active = mLines.filter((x) => !x.is_cancelled);
      if (active.length > 0) {
        const allReceived = active.every((x) => Number(x.qty_received) >= Number(x.qty) && Number(x.qty) > 0);
        const anyReceived = active.some((x) => Number(x.qty_received) > 0);
        let newStatus = 'open';
        if (allReceived) {
          newStatus = 'received';
        } else if (anyReceived) {
          newStatus = 'partially_received';
        }
        run("UPDATE mrn SET status = ? WHERE id = ? AND status NOT IN ('closed', 'cancelled')", newStatus, mrnId);
      }
    }
  });

  // Cross-workshop synchronization for MULTIDB mode:
  // Propagate accept status to origin workshop database and rebuild its stock
  if (multidb.isMultiDb()) {
    try {
      const mtn = get('SELECT * FROM mtn WHERE id = ?', mid);
      if (mtn) {
        const anyLine = get('SELECT from_store_id FROM mtn_lines WHERE mtn_id = ? AND from_store_id IS NOT NULL LIMIT 1', mid);
        const fromWsId = anyLine ? anyLine.from_store_id : null;
        if (fromWsId && fromWsId !== multidb.activeWorkshopId()) {
          multidb.withWorkshop(fromWsId, () => {
            const origMtn = get('SELECT id FROM mtn WHERE chain_no = ? OR mtn_no = ?', mtn.chain_no, mtn.mtn_no);
            if (origMtn) {
              run(`UPDATE mtn SET status = 'accepted',
                                  accepted_by = COALESCE(?, accepted_by),
                                  accepted_sig = COALESCE(?, accepted_sig),
                                  accepted_at = COALESCE(?, accepted_at),
                                  accepted_designation = COALESCE(?, accepted_designation)
                    WHERE id = ?`,
                mtn.accepted_by, mtn.accepted_sig, mtn.accepted_at, mtn.accepted_designation,
                origMtn.id);
              stock.rebuild({ transfersOf: origMtn.id });
            }
          });
        }
      }
    } catch (e) {
      console.warn('[supply_routes] Failed to sync accepted MTN across workshops:', e.message);
    }
  }
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
           COALESCE(ml.qty_outstanding, MAX(0, ml.qty - COALESCE(ml.qty_received, 0))) AS qty_outstanding,
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
    const outstanding = Number(r.qty_outstanding) || 0;

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
      qty_outstanding: outstanding,
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
  checkMainWorkshopAvailability,
  determineItemSourceStore,
  createOrUpdateChildReplenishment,
  triggerBackToBackTransfer,
  onMrnApproved,
  onSiteAuthorityApproved,
  onSiteAuthorityRejected,
  onMtnDispatched,
  onMtnAccepted,
  onIssueCreated,
  onIssueReturned,
  getMrnPipeline,
};
