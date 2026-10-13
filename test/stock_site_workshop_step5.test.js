'use strict';

/**
 * Step 5: Site Workshop Request & Fulfilment Routing Tests
 * 
 * Verifies:
 * 1. Routing site workshop requests to Central Main Workshop Stores (physical_store_id = 2).
 * 2. Availability checking: on-hand minus active reservations (pending undispatched MTNs).
 *    Status calculation: 'full', 'partial', 'unavailable'.
 * 3. Full / partial fulfillment: auto-MTN drafted from MAIN-WORKSHOP (2) to Site Workshop (3).
 *    Unfulfilled remainder stays open as outstanding demand (qty_outstanding).
 * 4. Dispatch advances qty_sent, deducts stock from Main Workshop, tracks in-transit.
 * 5. Acceptance advances qty_received, adds stock to Site Workshop, advances MRN status to 'partially_received' / 'received'.
 * 6. Short delivery logging to delivery_discrepancies.
 * 7. Single unified chain trace across MRN and auto-MTN.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-stock-p5-'));
process.env.DB_PATH = path.join(TMP, 'stock_p5.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');

const { migrate, run, get, all, db } = require('../src/db');
const storeLocations = require('../src/lib/store_locations');
const stock = require('../src/lib/stock');
const supplyRoutes = require('../src/lib/supply_routes');
const chainPipeline = require('../src/lib/chain_pipeline');

migrate();

// Seed test workshops
run(`INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active, own_store)
    VALUES (1, 'CW', 'Central Workshop — Badalgama', 'Badalgama', 1, 1, 1)`);
run(`INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active, own_store)
    VALUES (2, 'GWS', 'Galagedara Workshop', 'Galagedara', 0, 1, 1)`);

// Seed test user for Site Authority
run(`INSERT OR IGNORE INTO users (id, username, password_hash, full_name, active)
    VALUES (1, 'site.eng', 'hash', 'Site Authority Engineer', 1)`);

// Seed physical stores and hierarchy
storeLocations.seedStoreLocations(db);
storeLocations.migrateStoreLocationsStage2(db);

const wsMain = get("SELECT id, code, name FROM store_locations WHERE code = 'MAIN-WORKSHOP'");
const wsSite = get("SELECT id, code, name FROM store_locations WHERE code = 'SITE-STORE-GWS'");

test('Step 5: Site Workshop Request & Fulfilment Routing', async (t) => {
  assert.ok(wsMain && wsMain.id === 2, 'Main Workshop Stores exists with ID 2');
  assert.ok(wsSite && wsSite.id === 3, 'Site Store exists with ID 3');

  // Seed initial inventory in Main Workshop Stores (physical_store_id = 2)
  const partNo = 'Hydraulic Filter HF-500';
  const grnId = run(`
    INSERT INTO grn (status, grn_no, grn_date, description, qty, unit_price,
                     purchase_source, delivery_date, store_id, physical_store_id)
    VALUES ('approved', 'GRN-TEST-ST5-01', '2026-10-09', ?, 20, 4500, 'central_store', '2026-10-09', 1, 2)
  `, partNo).lastInsertRowid;

  stock.sync({ grn: [grnId] });

  await t.test('1. Initial stock is present in Main Workshop (2) and 0 in Site Workshop (3)', () => {
    const balWs2 = stock.summary('filter', { physical_store_id: 2 });
    const balWs3 = stock.summary('filter', { physical_store_id: 3 });
    assert.equal(balWs2.balance, 20, 'Main Workshop has 20 items');
    assert.equal(balWs3.balance, 0, 'Site Workshop has 0 items');
  });

  await t.test('2. Availability check: computes on-hand minus active reservations', () => {
    // Currently on-hand = 20, no pending undispatched MTNs -> available = 20
    const avail1 = supplyRoutes.checkMainWorkshopAvailability({ description: partNo, category: 'filter', qty: 10 });
    assert.equal(avail1.on_hand, 20);
    assert.equal(avail1.reserved, 0);
    assert.equal(avail1.available, 20);
    assert.equal(avail1.status, 'full');
    assert.equal(avail1.fulfillable_qty, 10);
    assert.equal(avail1.outstanding_qty, 0);

    // Create a draft MTN from store 2 reserving 6 items
    const mtnDraft = run(`
      INSERT INTO mtn (mtn_no, txn_date, from_store_location_id, to_store_location_id, status)
      VALUES ('MTN-RES-01', '2026-10-09', 2, 3, 'draft')
    `).lastInsertRowid;
    run(`
      INSERT INTO mtn_lines (mtn_id, line_no, description, qty, category, from_store_location_id, to_store_location_id)
      VALUES (?, 1, ?, 6, 'filter', 2, 3)
    `, mtnDraft, partNo);

    // Now: on-hand = 20, reserved = 6 -> available = 14
    const avail2 = supplyRoutes.checkMainWorkshopAvailability({ description: partNo, category: 'filter', qty: 10 });
    assert.equal(avail2.on_hand, 20);
    assert.equal(avail2.reserved, 6);
    assert.equal(avail2.available, 14);
    assert.equal(avail2.status, 'full');
    assert.equal(avail2.fulfillable_qty, 10);

    // Requesting 18 items -> available 14 -> status: partial, fulfillable: 14, outstanding: 4
    const avail3 = supplyRoutes.checkMainWorkshopAvailability({ description: partNo, category: 'filter', qty: 18 });
    assert.equal(avail3.available, 14);
    assert.equal(avail3.status, 'partial');
    assert.equal(avail3.fulfillable_qty, 14);
    assert.equal(avail3.outstanding_qty, 4);

    // Clean up draft reservation MTN
    run('DELETE FROM mtn_lines WHERE mtn_id = ?', mtnDraft);
    run('DELETE FROM mtn WHERE id = ?', mtnDraft);
  });

  await t.test('3. Partial fulfillment: site workshop request with insufficient stock creates auto-MTN for available and tracks remainder', () => {
    // Consume stock in Main Workshop so only 6 items remain
    // On hand is 20. We create an issue of 14 items.
    run(`
      INSERT INTO issues (issue_date, description, qty, store_id, physical_store_id)
      VALUES ('2026-10-09', ?, 14, 1, 2)
    `, partNo);
    stock.rebuild({ wipe: true });

    let balWs2 = stock.summary('filter', { physical_store_id: 2 });
    assert.equal(balWs2.balance, 6, 'Main Workshop has 6 items remaining');

    // Site Store 2 (Galagedara, physical_store_id = 3) requests 10 items
    const mrnId = run(`
      INSERT INTO mrn (mrn_no, req_date, workshop_id, target_store_location_id, purpose, approval_status, site_authority_status, status)
      VALUES ('MRN-GWS-001', '2026-10-09', 2, 3, 'Urgent excavator filter replacement', 'certified', 'pending', 'open')
    `).lastInsertRowid;

    const lineId = run(`
      INSERT INTO mrn_lines (mrn_id, description, qty, unit, category, supply_route)
      VALUES (?, ?, 10, 'nos', 'filter', 'main_store')
    `, mrnId, partNo).lastInsertRowid;

    // Check availability via MRN ID
    const mrnAvail = supplyRoutes.checkMainWorkshopAvailability(mrnId);
    assert.equal(mrnAvail.overall_status, 'partial');
    assert.equal(mrnAvail.lines[0].available, 6);
    assert.equal(mrnAvail.lines[0].fulfillable_qty, 6);
    assert.equal(mrnAvail.lines[0].outstanding_qty, 4);

    // Site Authority Gate check: while site_authority_status is 'pending', fulfillment is gated!
    const gateCheck = supplyRoutes.onMrnApproved(mrnId, { fullName: 'Operational Manager' });
    assert.equal(gateCheck && gateCheck.gated, true, 'Site MRN fulfillment is gated while pending site authority');
    assert.equal(get('SELECT auto_mtn_id FROM mrn_lines WHERE id = ?', lineId).auto_mtn_id, null, 'No MTN generated while pending site authority');

    // Site Authority approves demand: seals demand and triggers fulfillment
    supplyRoutes.onSiteAuthorityApproved(mrnId, { id: 1, fullName: 'Site Authority Engineer' }, { notes: 'Approved for excavator EX-01' });

    const lineAfter = get('SELECT * FROM mrn_lines WHERE id = ?', lineId);
    assert.equal(lineAfter.qty_approved, 6, 'Line approved quantity is 6');
    assert.equal(lineAfter.qty_outstanding, 4, 'Outstanding demand is 4');
    assert.ok(lineAfter.auto_mtn_id, 'Auto-MTN was generated');

    const autoMtn = get('SELECT * FROM mtn WHERE id = ?', lineAfter.auto_mtn_id);
    assert.ok(autoMtn, 'Auto MTN exists');
    assert.equal(autoMtn.from_store_location_id, 2, 'Origin store location is MAIN-WORKSHOP (2)');
    assert.equal(autoMtn.to_store_location_id, 3, 'Destination store location is SITE-STORE-GWS (3)');
    assert.equal(autoMtn.from_store_id, 1, 'From workshop store is 1');
    assert.equal(autoMtn.to_store_id, 2, 'To workshop store is 2 (Galagedara)');
    assert.equal(autoMtn.status, 'draft', 'Auto-MTN starts in draft status');

    const mtnLine = get('SELECT * FROM mtn_lines WHERE mtn_id = ?', autoMtn.id);
    assert.equal(mtnLine.qty, 6, 'MTN line quantity is 6');
    assert.equal(mtnLine.mrn_line_id, lineId, 'MTN line links to MRN line');

    const mrnRow = get('SELECT * FROM mrn WHERE id = ?', mrnId);
    assert.equal(mrnRow.site_authority_status, 'approved', 'Site authority status is approved');
    assert.ok(mrnRow.chain_no, 'MRN has assigned chain_no');
    assert.equal(autoMtn.chain_no, mrnRow.chain_no, 'Single unified chain_no stamped on auto-MTN');
  });

  await t.test('4. Dispatch: advances qty_sent, deducts Main Workshop stock, tracks in-transit', () => {
    const mrn = get("SELECT * FROM mrn WHERE mrn_no = 'MRN-GWS-001'");
    const line = get('SELECT * FROM mrn_lines WHERE mrn_id = ?', mrn.id);
    const mtn = get('SELECT * FROM mtn WHERE id = ?', line.auto_mtn_id);

    // Dispatch MTN
    run("UPDATE mtn SET status = 'dispatched', approved_by = 'Store In-Charge' WHERE id = ?", mtn.id);
    supplyRoutes.onMtnDispatched(mtn.id);
    stock.rebuild({ transfersOf: mtn.id });

    // Verify MRN line
    const lineDispatched = get('SELECT * FROM mrn_lines WHERE id = ?', line.id);
    assert.equal(lineDispatched.qty_sent, 6, 'Line qty_sent is 6');

    // Verify stock
    const balWs2 = stock.summary('filter', { physical_store_id: 2 });
    const balWs3 = stock.summary('filter', { physical_store_id: 3 });
    assert.equal(balWs2.balance, 0, 'Main Workshop stock reduced by 6 (6 -> 0)');
    assert.equal(balWs3.balance, 0, 'Site Workshop has not received items yet');

    // Verify in-transit
    const inTransit = stock.inTransit('filter', { from_location_id: 2 });
    assert.equal(inTransit.length, 1, '1 line in transit');
    assert.equal(inTransit[0].qty_in_transit, 6);
    assert.equal(inTransit[0].from_location_id, 2);
    assert.equal(inTransit[0].to_location_id, 3);
  });

  await t.test('5. Destination acceptance: advances qty_received, destination stock increases, MRN status advances to partially_received', () => {
    const mrn = get("SELECT * FROM mrn WHERE mrn_no = 'MRN-GWS-001'");
    const line = get('SELECT * FROM mrn_lines WHERE mrn_id = ?', mrn.id);
    const mtn = get('SELECT * FROM mtn WHERE id = ?', line.auto_mtn_id);
    const mtnLine = get('SELECT * FROM mtn_lines WHERE mtn_id = ?', mtn.id);

    // Destination accepts all 6 dispatched items
    run("UPDATE mtn SET status = 'accepted', accepted_by = 'Site Storekeeper', accepted_at = datetime('now') WHERE id = ?", mtn.id);
    supplyRoutes.onMtnAccepted(mtn.id, [{ line_id: mtnLine.id, qty_received: 6 }], { fullName: 'Site Storekeeper' });
    stock.rebuild({ transfersOf: mtn.id });

    // Verify MRN line & header
    const lineRecv = get('SELECT * FROM mrn_lines WHERE id = ?', line.id);
    assert.equal(lineRecv.qty_received, 6, 'Line qty_received is 6');
    assert.equal(lineRecv.qty_outstanding, 4, 'Outstanding remainder is still 4');

    const mrnRecv = get('SELECT * FROM mrn WHERE id = ?', mrn.id);
    assert.equal(mrnRecv.status, 'partially_received', 'MRN status advanced to partially_received');

    // Verify stock
    const balWs3 = stock.summary('filter', { physical_store_id: 3 });
    assert.equal(balWs3.balance, 6, 'Site Workshop stock received 6 units (0 -> 6)');

    // In-transit cleared
    const inTransit = stock.inTransit('filter', { from_location_id: 2 });
    assert.equal(inTransit.length, 0, 'In-transit is cleared');
  });

  await t.test('6. Short delivery discrepancy: damaged or missing items log discrepancy', () => {
    // Add 10 items to Main Workshop
    const grnId2 = run(`
      INSERT INTO grn (status, grn_no, grn_date, description, qty, unit_price,
                       purchase_source, delivery_date, store_id, physical_store_id)
      VALUES ('approved', 'GRN-TEST-ST5-02', '2026-10-09', 'Heavy Duty Grease', 10, 1200, 'central_store', '2026-10-09', 1, 2)
    `).lastInsertRowid;
    stock.sync({ grn: [grnId2] });

    // Create Site Workshop MRN
    const mrnId2 = run(`
      INSERT INTO mrn (mrn_no, req_date, workshop_id, target_store_location_id, purpose, approval_status, status)
      VALUES ('MRN-GWS-002', '2026-10-09', 2, 3, 'Grease requisition', 'certified', 'open')
    `).lastInsertRowid;
    const lineId2 = run(`
      INSERT INTO mrn_lines (mrn_id, description, qty, unit, category, supply_route)
      VALUES (?, 'Heavy Duty Grease', 5, 'tins', 'general', 'main_store')
    `, mrnId2).lastInsertRowid;

    // Approve & create auto-MTN for 5 items
    run("UPDATE mrn SET approval_status = 'approved' WHERE id = ?", mrnId2);
    supplyRoutes.onMrnApproved(mrnId2, { fullName: 'Manager' });

    const autoMtn2 = get('SELECT * FROM mtn WHERE mrn_id = ?', mrnId2);
    const mtnLine2 = get('SELECT * FROM mtn_lines WHERE mtn_id = ?', autoMtn2.id);

    // Dispatch 5 items
    run("UPDATE mtn SET status = 'dispatched' WHERE id = ?", autoMtn2.id);
    supplyRoutes.onMtnDispatched(autoMtn2.id);
    stock.rebuild({ transfersOf: autoMtn2.id });

    // Destination accepts only 3 items (2 tins damaged/leaked during transport)
    run("UPDATE mtn SET status = 'accepted' WHERE id = ?", autoMtn2.id);
    supplyRoutes.onMtnAccepted(autoMtn2.id, [{
      line_id: mtnLine2.id,
      qty_received: 3,
      reason: '2 tins damaged and leaked during transport'
    }], { fullName: 'Site Receiver' });
    stock.rebuild({ transfersOf: autoMtn2.id });

    // Verify delivery discrepancy logged
    const disc = get('SELECT * FROM delivery_discrepancies WHERE mtn_id = ?', autoMtn2.id);
    assert.ok(disc, 'Discrepancy record was created');
    assert.equal(disc.qty_expected, 5);
    assert.equal(disc.qty_received, 3);
    assert.equal(disc.qty_short, 2);
    assert.match(disc.reason, /damaged and leaked/);

    // Verify MRN line
    const line2After = get('SELECT * FROM mrn_lines WHERE id = ?', lineId2);
    assert.equal(line2After.qty_received, 3);
    assert.equal(line2After.qty_short, 2);
    assert.equal(line2After.qty_outstanding, 2);

    // Verify Site Workshop stock received only 3 items
    const balGrease = stock.summary('general', { physical_store_id: 3 });
    assert.equal(balGrease.balance, 3, 'Site Workshop received exactly 3 tins');
  });

  await t.test('7. Full receipt advances MRN status to received', () => {
    // Deliver the remaining 4 filters for MRN-GWS-001
    const mrn1 = get("SELECT * FROM mrn WHERE mrn_no = 'MRN-GWS-001'");
    const line1 = get('SELECT * FROM mrn_lines WHERE mrn_id = ?', mrn1.id);

    // Replenish Main Workshop with 10 filters
    const grnReplenish = run(`
      INSERT INTO grn (status, grn_no, grn_date, description, qty, unit_price,
                       purchase_source, delivery_date, store_id, physical_store_id)
      VALUES ('approved', 'GRN-TEST-ST5-03', '2026-10-09', ?, 10, 4500, 'central_store', '2026-10-09', 1, 2)
    `, partNo).lastInsertRowid;
    stock.sync({ grn: [grnReplenish] });

    // Send the remainder 4 filters via MTN
    const mtnRemId = run(`
      INSERT INTO mtn (mtn_no, mr_no, mrn_id, txn_date, from_store_location_id, to_store_location_id,
                       from_store_id, to_store_id, status, chain_no)
      VALUES ('MTN-GWS-REM', ?, ?, '2026-10-09', 2, 3, 1, 2, 'dispatched', ?)
    `, mrn1.mrn_no, mrn1.id, mrn1.chain_no).lastInsertRowid;

    const mtnRemLineId = run(`
      INSERT INTO mtn_lines (mtn_id, line_no, description, qty, unit, category,
                             from_store_location_id, to_store_location_id, from_store_id, to_store_id, mrn_id, mrn_line_id)
      VALUES (?, 1, ?, 4, 'nos', 'filter', 2, 3, 1, 2, ?, ?)
    `, mtnRemId, partNo, mrn1.id, line1.id).lastInsertRowid;

    supplyRoutes.onMtnDispatched(mtnRemId);
    stock.rebuild({ transfersOf: mtnRemId });

    // Accept the remainder at destination
    run("UPDATE mtn SET status = 'accepted' WHERE id = ?", mtnRemId);
    supplyRoutes.onMtnAccepted(mtnRemId, [{ line_id: mtnRemLineId, qty_received: 4 }], { fullName: 'Site Receiver' });
    stock.rebuild({ transfersOf: mtnRemId });

    // Verify MRN line is fully received (6 + 4 = 10)
    const line1Final = get('SELECT * FROM mrn_lines WHERE id = ?', line1.id);
    assert.equal(line1Final.qty_received, 10, 'Full 10 items received');
    assert.equal(line1Final.qty_outstanding, 0, '0 outstanding demand');

    // Verify MRN status advanced to 'received'
    const mrn1Final = get('SELECT * FROM mrn WHERE id = ?', mrn1.id);
    assert.equal(mrn1Final.status, 'received', 'MRN status is now received');

    // Verify total stock in Site Workshop is now 10
    const balWs3Final = stock.summary('filter', { physical_store_id: 3 });
    assert.equal(balWs3Final.balance, 10, 'Site Workshop holds all 10 filters');
  });

  await t.test('8. Local shelf stock check first: Site Store on-hand stock satisfies first, and only remainder shortage generates central MTN', () => {
    // Consume remaining 6 filters in Main Workshop so it starts at 0
    run(`
      INSERT INTO issues (issue_date, description, qty, store_id, physical_store_id)
      VALUES ('2026-10-09', ?, 6, 1, 2)
    `, partNo);
    stock.rebuild({ wipe: true });

    // Add 3 filters to Main Workshop (2)
    const grnNew = run(`
      INSERT INTO grn (status, grn_no, grn_date, description, qty, unit_price,
                       purchase_source, delivery_date, store_id, physical_store_id)
      VALUES ('approved', 'GRN-TEST-MWS-NEW', '2026-10-09', ?, 3, 4500, 'central_store', '2026-10-09', 1, 2)
    `, partNo).lastInsertRowid;
    stock.sync({ grn: [grnNew] });

    // MRN for 15 filters at Site Store (3)
    const mrnLocalId = run(`
      INSERT INTO mrn (mrn_no, req_date, workshop_id, target_store_location_id, purpose, approval_status, site_authority_status, status)
      VALUES ('MRN-GWS-LOC-1', '2026-10-09', 2, 3, 'Excavator 250hr service filters', 'certified', 'approved', 'open')
    `).lastInsertRowid;

    const lineLocalId = run(`
      INSERT INTO mrn_lines (mrn_id, description, qty, unit, category, supply_route)
      VALUES (?, ?, 15, 'nos', 'filter', 'main_store')
    `, mrnLocalId, partNo).lastInsertRowid;

    // Check availability: local shelf (10) fulfills first, shortage (5) checked against central (3 available)
    const availCheck = supplyRoutes.checkMainWorkshopAvailability(mrnLocalId);
    assert.equal(availCheck.lines[0].local_on_hand, 10, 'Site Store local shelf has 10 items');
    assert.equal(availCheck.lines[0].local_fulfillable_qty, 10, 'Local shelf fulfills 10 items');
    assert.equal(availCheck.lines[0].shortage_qty, 5, 'Shortage escalated to central is 5 items');
    assert.equal(availCheck.lines[0].available, 3, 'Main Workshop has 3 items available');
    assert.equal(availCheck.lines[0].fulfillable_qty, 13, 'Total fulfillable = 10 local + 3 central');
    assert.equal(availCheck.lines[0].outstanding_qty, 2, 'Outstanding shortage remainder is 2 items');

    // Run onMrnApproved
    supplyRoutes.onMrnApproved(mrnLocalId, { fullName: 'Site Authority' });

    const lineLocalAfter = get('SELECT * FROM mrn_lines WHERE id = ?', lineLocalId);
    assert.equal(lineLocalAfter.local_issue_qty, 10, '10 items allocated for local issue from Site Store');
    assert.equal(lineLocalAfter.qty_approved, 13, 'Total approved is 13 (10 local + 3 central)');
    assert.equal(lineLocalAfter.qty_outstanding, 2, '2 items remain outstanding');

    // Auto MTN must be drafted for ONLY the 3 items transferred from Central Main Workshop (not 10 or 15!)
    const localAutoMtn = get('SELECT * FROM mtn WHERE id = ?', lineLocalAfter.auto_mtn_id);
    assert.ok(localAutoMtn, 'Auto MTN exists');
    const localMtnLine = get('SELECT * FROM mtn_lines WHERE mtn_id = ?', localAutoMtn.id);
    assert.equal(localMtnLine.qty, 3, 'MTN line carries ONLY the 3 central shortage units');
  });
});
