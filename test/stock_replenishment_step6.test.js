'use strict';

/**
 * Step 6: Main Workshop Replenishment via Main Stores & Back-to-Back Flow Tests
 * 
 * Verifies:
 * 1. Initial stock presence: Main Stores (1) = 20, Main Workshop (2) = 4, Site Store (3) = 0.
 * 2. Site requisition: 10 items requested at Site Store (3). Local shelf has 0, shortage = 10.
 *    Main Workshop covers 4 items; outstanding shortage remainder = 6.
 * 3. Site Authority Approval:
 *    - Auto-MTN #1 drafted from Main Workshop (2) to Site Store (3) for 4 available items.
 *    - Child Replenishment MRN automatically drafted from Main Workshop (2) to Main Stores (1)
 *      with parent_mrn_id, replenishment_type = 'workshop_replenishment', and requested qty = 6.
 *    - Parent MRN line links to child MRN line (child_mrn_id, child_mrn_line_id).
 * 4. First Batch Delivery (4 items):
 *    - Dispatch and destination acceptance at Site Store: Site Store stock becomes 4.
 *    - Parent MRN advances to 'partially_received'.
 * 5. Main Stores Replenishment Fulfillment (6 items):
 *    - Child MRN approved by Main Stores -> auto-MTN #2 drafted from Main Stores (1) to Main Workshop (2).
 *    - Dispatched (Main Stores stock 20 -> 14) and accepted at Main Workshop (stock 0 -> 6).
 *    - Child MRN advances to 'received'.
 * 6. Back-to-Back Cascading Unblocking:
 *    - Acceptance at Main Workshop automatically triggers triggerBackToBackTransfer.
 *    - Parent MRN line qty_approved advances to 10, qty_outstanding becomes 0.
 *    - Continuation auto-MTN #3 drafted from Main Workshop (2) to Site Store (3) for 6 items.
 * 7. Final Site Delivery & Chain Completion:
 *    - Dispatch and destination acceptance of MTN #3: Site Store stock becomes 10.
 *    - Parent MRN status advances to 'received'.
 *    - Single unified chain_no stamps every requisition and transfer note across the flow.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-stock-p6-'));
process.env.DB_PATH = path.join(TMP, 'stock_p6.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');

const { migrate, run, get, all, db } = require('../src/db');
const storeLocations = require('../src/lib/store_locations');
const stock = require('../src/lib/stock');
const supplyRoutes = require('../src/lib/supply_routes');

migrate();

// Seed test workshops
run(`INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active, own_store)
    VALUES (1, 'CW', 'Central Workshop — Badalgama', 'Badalgama', 1, 1, 1)`);
run(`INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active, own_store)
    VALUES (2, 'GWS', 'Galagedara Workshop', 'Galagedara', 0, 1, 1)`);

// Seed test user
run(`INSERT OR IGNORE INTO users (id, username, password_hash, full_name, active)
    VALUES (1, 'site.eng', 'hash', 'Site Authority Engineer', 1)`);

// Seed physical stores and hierarchy
storeLocations.seedStoreLocations(db);
storeLocations.migrateStoreLocationsStage2(db);

const msLoc = get("SELECT id, code, name FROM store_locations WHERE code = 'MAIN-STORES'");
const wsLoc = get("SELECT id, code, name FROM store_locations WHERE code = 'MAIN-WORKSHOP'");
const siteLoc = get("SELECT id, code, name FROM store_locations WHERE code = 'SITE-STORE-GWS'");

test('Step 6: Main Workshop Replenishment via Main Stores & Back-to-Back Flow', async (t) => {
  assert.ok(msLoc && msLoc.id === 1, 'Central Main Stores exists with ID 1');
  assert.ok(wsLoc && wsLoc.id === 2, 'Main Workshop Stores exists with ID 2');
  assert.ok(siteLoc && siteLoc.id === 3, 'Site Store exists with ID 3');

  const partNo = 'Hydraulic Filter HF-700';

  // Seed inventory: 20 in Main Stores (1), 4 in Main Workshop (2), 0 in Site Store (3)
  const grn1 = run(`
    INSERT INTO grn (status, grn_no, grn_date, description, qty, unit_price,
                     purchase_source, delivery_date, store_id, physical_store_id)
    VALUES ('approved', 'GRN-P6-MS-01', '2026-10-12', ?, 20, 4800, 'central_store', '2026-10-12', 1, 1)
  `, partNo).lastInsertRowid;

  const grn2 = run(`
    INSERT INTO grn (status, grn_no, grn_date, description, qty, unit_price,
                     purchase_source, delivery_date, store_id, physical_store_id)
    VALUES ('approved', 'GRN-P6-WS-01', '2026-10-12', ?, 4, 4800, 'central_store', '2026-10-12', 1, 2)
  `, partNo).lastInsertRowid;

  stock.sync({ grn: [grn1, grn2] });

  let parentMrnId, parentLineId;
  let autoMtn1Id, autoMtn1LineId;
  let childMrnId, childLineId;
  let autoMtn2Id, autoMtn2LineId;
  let autoMtn3Id, autoMtn3LineId;

  await t.test('1. Initial stock presence: Main Stores = 20, Main Workshop = 4, Site Store = 0', () => {
    const balMs = stock.summary('filter', { physical_store_id: 1 });
    const balWs = stock.summary('filter', { physical_store_id: 2 });
    const balSite = stock.summary('filter', { physical_store_id: 3 });

    assert.equal(balMs.balance, 20, 'Main Stores has 20 items');
    assert.equal(balWs.balance, 4, 'Main Workshop has 4 items');
    assert.equal(balSite.balance, 0, 'Site Store has 0 items');
  });

  await t.test('2. Availability check: 10 items requested, local shelf = 0, central has 4, shortage = 6', () => {
    parentMrnId = run(`
      INSERT INTO mrn (mrn_no, req_date, workshop_id, target_store_location_id, purpose, approval_status, site_authority_status, status)
      VALUES ('MRN-GWS-700', '2026-10-12', 2, 3, 'Heavy excavator hydraulic service', 'certified', 'pending', 'open')
    `).lastInsertRowid;

    parentLineId = run(`
      INSERT INTO mrn_lines (mrn_id, description, qty, unit, category, supply_route)
      VALUES (?, ?, 10, 'nos', 'filter', 'main_store')
    `, parentMrnId, partNo).lastInsertRowid;

    const avail = supplyRoutes.checkMainWorkshopAvailability(parentMrnId);
    assert.equal(avail.overall_status, 'partial');
    assert.equal(avail.lines[0].local_on_hand, 0);
    assert.equal(avail.lines[0].local_fulfillable_qty, 0);
    assert.equal(avail.lines[0].shortage_qty, 10);
    assert.equal(avail.lines[0].available, 4);
    assert.equal(avail.lines[0].fulfillable_qty, 4);
    assert.equal(avail.lines[0].outstanding_qty, 6);
  });

  await t.test('3. Site Authority approval: drafts auto-MTN for 4 items AND creates Child Replenishment MRN for 6 items', () => {
    // Approve Site Authority demand
    supplyRoutes.onSiteAuthorityApproved(parentMrnId, { id: 1, fullName: 'Site Authority Engineer' }, { notes: 'Required for EX-02 breakdown' });

    const parentLine = get('SELECT * FROM mrn_lines WHERE id = ?', parentLineId);
    assert.equal(parentLine.qty_approved, 4, 'Parent approved qty is 4');
    assert.equal(parentLine.qty_outstanding, 6, 'Outstanding shortage is 6');
    assert.ok(parentLine.auto_mtn_id, 'Auto MTN #1 created for initial available items');
    autoMtn1Id = parentLine.auto_mtn_id;

    // Verify Auto-MTN #1 (2 -> 3)
    const mtn1 = get('SELECT * FROM mtn WHERE id = ?', autoMtn1Id);
    assert.equal(mtn1.from_store_location_id, 2, 'From Main Workshop (2)');
    assert.equal(mtn1.to_store_location_id, 3, 'To Site Store (3)');
    const mtn1Line = get('SELECT * FROM mtn_lines WHERE mtn_id = ?', autoMtn1Id);
    assert.equal(mtn1Line.qty, 4, 'Transfers exactly 4 available items');
    autoMtn1LineId = mtn1Line.id;

    // Verify Child Replenishment MRN auto-generated for the shortage (6 items)
    assert.ok(parentLine.child_mrn_id, 'Parent line links to Child MRN');
    childMrnId = parentLine.child_mrn_id;
    childLineId = parentLine.child_mrn_line_id;

    const childMrn = get('SELECT * FROM mrn WHERE id = ?', childMrnId);
    assert.ok(childMrn, 'Child Replenishment MRN exists');
    assert.equal(childMrn.parent_mrn_id, parentMrnId, 'Child links to parent MRN ID');
    assert.equal(childMrn.replenishment_type, 'workshop_replenishment', 'Marked as workshop replenishment');
    assert.equal(childMrn.from_store_location_id, 2, 'From Main Workshop');
    assert.equal(childMrn.target_store_location_id, 2, 'Target is Main Workshop (where goods will arrive)');
    assert.equal(childMrn.site_authority_status, 'approved', 'Internal replenishment is auto-approved for site authority');
    assert.equal(childMrn.chain_no, mtn1.chain_no, 'Child MRN shares the same chain_no as parent MRN');

    const childLine = get('SELECT * FROM mrn_lines WHERE id = ?', childLineId);
    assert.ok(childLine, 'Child line exists');
    assert.equal(childLine.parent_mrn_line_id, parentLineId, 'Child line links to parent MRN line');
    assert.equal(childLine.qty, 6, 'Child line requested qty is 6');
    assert.equal(childLine.supply_route, 'main_store', 'Supply route is main_store');
  });

  await t.test('4. First batch dispatch & acceptance (4 items): Site Store receives 4, parent MRN status is partially_received', () => {
    // Dispatch Auto-MTN #1
    run("UPDATE mtn SET status = 'dispatched' WHERE id = ?", autoMtn1Id);
    supplyRoutes.onMtnDispatched(autoMtn1Id);
    stock.rebuild({ transfersOf: autoMtn1Id });

    assert.equal(stock.summary('filter', { physical_store_id: 2 }).balance, 0, 'Main Workshop stock drops from 4 to 0');
    assert.equal(stock.inTransit('filter', { from_location_id: 2 })[0].qty_in_transit, 4, '4 items in transit');

    // Accept Auto-MTN #1 at Site Store (3)
    run("UPDATE mtn SET status = 'accepted' WHERE id = ?", autoMtn1Id);
    supplyRoutes.onMtnAccepted(autoMtn1Id, [{ line_id: autoMtn1LineId, qty_received: 4 }], { fullName: 'Site Storekeeper' });
    stock.rebuild({ transfersOf: autoMtn1Id });

    assert.equal(stock.summary('filter', { physical_store_id: 3 }).balance, 4, 'Site Store received first 4 items');
    assert.equal(stock.inTransit('filter', { from_location_id: 2 }).length, 0, 'In transit cleared');

    const parentLineAfter = get('SELECT * FROM mrn_lines WHERE id = ?', parentLineId);
    assert.equal(parentLineAfter.qty_received, 4, 'Parent line received 4 items');
    assert.equal(parentLineAfter.qty_outstanding, 6, '6 items remain outstanding');

    const parentMrnAfter = get('SELECT status FROM mrn WHERE id = ?', parentMrnId);
    assert.equal(parentMrnAfter.status, 'partially_received', 'Parent MRN status advanced to partially_received');
  });

  await t.test('5. Main Stores fulfills Child Replenishment MRN: transfers 6 items to Main Workshop', () => {
    // Approve Child MRN by Central Main Stores
    run("UPDATE mrn SET approval_status = 'approved' WHERE id = ?", childMrnId);
    supplyRoutes.onMrnApproved(childMrnId, { fullName: 'Central Stores Manager' });

    const childLineAfterApprove = get('SELECT * FROM mrn_lines WHERE id = ?', childLineId);
    assert.ok(childLineAfterApprove.auto_mtn_id, 'Auto-MTN #2 created from Main Stores (1) to Main Workshop (2)');
    autoMtn2Id = childLineAfterApprove.auto_mtn_id;

    const mtn2 = get('SELECT * FROM mtn WHERE id = ?', autoMtn2Id);
    assert.equal(mtn2.from_store_location_id, 1, 'From Central Main Stores (1)');
    assert.equal(mtn2.to_store_location_id, 2, 'To Main Workshop Stores (2)');
    const mtn2Line = get('SELECT * FROM mtn_lines WHERE mtn_id = ?', autoMtn2Id);
    assert.equal(mtn2Line.qty, 6, 'Transfers 6 replenishment items');
    autoMtn2LineId = mtn2Line.id;

    // Dispatch Auto-MTN #2
    run("UPDATE mtn SET status = 'dispatched' WHERE id = ?", autoMtn2Id);
    supplyRoutes.onMtnDispatched(autoMtn2Id);
    stock.rebuild({ transfersOf: autoMtn2Id });

    assert.equal(stock.summary('filter', { physical_store_id: 1 }).balance, 14, 'Main Stores stock decrements from 20 to 14');
    assert.equal(stock.inTransit('filter', { from_location_id: 1 })[0].qty_in_transit, 6, '6 items in transit from 1 to 2');

    // Accept Auto-MTN #2 at Main Workshop (2)
    run("UPDATE mtn SET status = 'accepted' WHERE id = ?", autoMtn2Id);
    supplyRoutes.onMtnAccepted(autoMtn2Id, [{ line_id: autoMtn2LineId, qty_received: 6 }], { fullName: 'Main Workshop Storekeeper' });
    stock.rebuild({ transfersOf: autoMtn2Id });

    assert.equal(stock.summary('filter', { physical_store_id: 2 }).balance, 6, 'Main Workshop stock received 6 items (0 -> 6)');
    assert.equal(stock.inTransit('filter', { from_location_id: 1 }).length, 0, 'In transit from Main Stores cleared');

    const childLineAfterRecv = get('SELECT * FROM mrn_lines WHERE id = ?', childLineId);
    assert.equal(childLineAfterRecv.qty_received, 6, 'Child line received 6 items');

    const childMrnAfterRecv = get('SELECT status FROM mrn WHERE id = ?', childMrnId);
    assert.equal(childMrnAfterRecv.status, 'received', 'Child MRN fully received');
  });

  await t.test('6. Back-to-Back cascading trigger: auto-drafts Continuation MTN #3 (2 -> 3) for the 6 items', () => {
    // When Auto-MTN #2 was accepted in test 5, triggerBackToBackTransfer ran!
    const parentLineBack = get('SELECT * FROM mrn_lines WHERE id = ?', parentLineId);
    assert.equal(parentLineBack.qty_approved, 10, 'Parent approved qty is now 10 (4 initial + 6 replenished)');
    assert.equal(parentLineBack.qty_outstanding, 0, 'Parent outstanding shortage is now 0');

    // A continuation MTN must have been auto-drafted for the 6 items
    const continuationMtns = all("SELECT * FROM mtn WHERE mrn_id = ? AND id != ? ORDER BY id DESC", parentMrnId, autoMtn1Id);
    assert.ok(continuationMtns.length >= 1, 'Continuation MTN was generated');
    const mtn3 = continuationMtns[0];
    autoMtn3Id = mtn3.id;

    assert.equal(mtn3.from_store_location_id, 2, 'From Main Workshop (2)');
    assert.equal(mtn3.to_store_location_id, 3, 'To Site Store (3)');
    assert.equal(mtn3.status, 'draft', 'Starts in draft status');

    const mtn3Line = get('SELECT * FROM mtn_lines WHERE mtn_id = ?', autoMtn3Id);
    assert.equal(mtn3Line.qty, 6, 'Continuation MTN carries exactly 6 items');
    assert.equal(mtn3Line.mrn_line_id, parentLineId, 'Links to parent MRN line');
    autoMtn3LineId = mtn3Line.id;
  });

  await t.test('7. Final delivery & chain completion: Site Store receives all 10 items, parent MRN status is received', () => {
    // Dispatch Continuation MTN #3
    run("UPDATE mtn SET status = 'dispatched' WHERE id = ?", autoMtn3Id);
    supplyRoutes.onMtnDispatched(autoMtn3Id);
    stock.rebuild({ transfersOf: autoMtn3Id });

    assert.equal(stock.summary('filter', { physical_store_id: 2 }).balance, 0, 'Main Workshop stock sent 6 items (6 -> 0)');
    assert.equal(stock.inTransit('filter', { from_location_id: 2 })[0].qty_in_transit, 6, '6 items in transit');

    // Accept Continuation MTN #3 at Site Store (3)
    run("UPDATE mtn SET status = 'accepted' WHERE id = ?", autoMtn3Id);
    supplyRoutes.onMtnAccepted(autoMtn3Id, [{ line_id: autoMtn3LineId, qty_received: 6 }], { fullName: 'Site Storekeeper' });
    stock.rebuild({ transfersOf: autoMtn3Id });

    // Stock verification
    assert.equal(stock.summary('filter', { physical_store_id: 3 }).balance, 10, 'Site Store now holds all 10 items (4 + 6)');
    assert.equal(stock.inTransit('filter', { from_location_id: 2 }).length, 0, 'All in transit cleared');

    // Parent MRN completion verification
    const parentLineFinal = get('SELECT * FROM mrn_lines WHERE id = ?', parentLineId);
    assert.equal(parentLineFinal.qty_received, 10, 'Full 10 items received across both transfers');
    assert.equal(parentLineFinal.qty_outstanding, 0, '0 items outstanding');

    const parentMrnFinal = get('SELECT * FROM mrn WHERE id = ?', parentMrnId);
    assert.equal(parentMrnFinal.status, 'received', 'Parent MRN status advanced to received');

    // Single unified chain_no check
    const mtn1 = get('SELECT chain_no FROM mtn WHERE id = ?', autoMtn1Id);
    const mtn2 = get('SELECT chain_no FROM mtn WHERE id = ?', autoMtn2Id);
    const mtn3 = get('SELECT chain_no FROM mtn WHERE id = ?', autoMtn3Id);
    const childMrn = get('SELECT chain_no FROM mrn WHERE id = ?', childMrnId);

    assert.ok(parentMrnFinal.chain_no, 'Parent MRN has chain_no');
    assert.equal(mtn1.chain_no, parentMrnFinal.chain_no, 'MTN #1 matches parent chain_no');
    assert.equal(childMrn.chain_no, parentMrnFinal.chain_no, 'Child MRN matches parent chain_no');
    assert.equal(mtn3.chain_no, parentMrnFinal.chain_no, 'Continuation MTN #3 matches parent chain_no');
  });
});
