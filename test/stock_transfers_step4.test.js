'use strict';

/**
 * Step 4: Inter-Store Transfers (MTN) Between Main Stores and Workshop Stores Tests
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-stock-p4-'));
process.env.DB_PATH = path.join(TMP, 'stock_p4.db');
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

// Seed physical stores and run migrations
storeLocations.seedStoreLocations(db);
storeLocations.migrateStoreLocationsStage2(db);

const msLoc = get("SELECT id, code, name FROM store_locations WHERE code = 'MAIN-STORES'");
const wsLoc = get("SELECT id, code, name FROM store_locations WHERE code = 'MAIN-WORKSHOP'");

test('Step 4: Inter-Store Transfers (MTN) Between Main Stores and Workshop Stores', async (t) => {
  assert.ok(msLoc && msLoc.id === 1, 'Central Main Stores exists with ID 1');
  assert.ok(wsLoc && wsLoc.id === 2, 'Main Workshop Stores exists with ID 2');

  // Seed initial stock in Central Main Stores (physical_store_id = 1) via linked MRN & GRN
  const mrnId = run(`
    INSERT INTO mrn (mrn_no, req_date, workshop_id, purpose, purchase_source, approval_status)
    VALUES ('MRN-ST4-INIT', '2026-10-09', 1, 'Initial Central Stock', 'head_office', 'approved')
  `).lastInsertRowid;

  const partNo = 'Oil Filter ST-400';
  const mrnLineId = run(`
    INSERT INTO mrn_lines (mrn_id, description, qty, unit, category, purchase_source)
    VALUES (?, ?, 50, 'nos', 'filter', 'head_office')
  `, mrnId, partNo).lastInsertRowid;

  const grnId = run(`
    INSERT INTO grn (status, grn_no, grn_date, mrn_id, mrn_line_id, description, qty, unit_price,
                     purchase_source, delivery_date, store_id, physical_store_id)
    VALUES ('approved', 'GRN-TEST-ST4-01', '2026-10-09', ?, ?, ?, 50, 2500, 'head_office', '2026-10-09', 1, 1)
  `, mrnId, mrnLineId, partNo).lastInsertRowid;

  stock.sync({ grn: [grnId] });

  await t.test('1. Initial stock is present in Central Main Stores (1) and 0 in Workshop (2)', () => {
    const balMs = stock.summary('filter', { physical_store_id: 1 });
    const balWs = stock.summary('filter', { physical_store_id: 2 });
    assert.equal(balMs.balance, 50, 'Central Main Stores has 50 items');
    assert.equal(balWs.balance, 0, 'Main Workshop Stores has 0 items');
  });

  await t.test('2. Draft and Approved MTN: 0 physical stock moves', () => {
    // Create MTN in draft status
    const mtnId = run(`
      INSERT INTO mtn (mtn_no, txn_date, from_location, to_location, from_store_location_id, to_store_location_id,
                       status, workshop_id)
      VALUES ('MTN-TEST-01', '2026-10-09', 'Central Main Stores', 'Main Workshop Stores', 1, 2, 'draft', 1)
    `).lastInsertRowid;

    run(`
      INSERT INTO mtn_lines (mtn_id, line_no, description, qty, unit, category, from_store_location_id, to_store_location_id)
      VALUES (?, 1, ?, 10, 'nos', 'filter', 1, 2)
    `, mtnId, partNo);

    stock.rebuild({ transfersOf: mtnId });

    let balMs = stock.summary('filter', { physical_store_id: 1 });
    let balWs = stock.summary('filter', { physical_store_id: 2 });
    assert.equal(balMs.balance, 50, 'Central Main Stores still has 50 items during draft');
    assert.equal(balWs.balance, 0, 'Main Workshop Stores still has 0 items during draft');

    // Approve MTN
    run("UPDATE mtn SET status = 'approved', approved_at = datetime('now') WHERE id = ?", mtnId);
    stock.rebuild({ transfersOf: mtnId });

    balMs = stock.summary('filter', { physical_store_id: 1 });
    balWs = stock.summary('filter', { physical_store_id: 2 });
    assert.equal(balMs.balance, 50, 'Central Main Stores still has 50 items after approval');
    assert.equal(balWs.balance, 0, 'Main Workshop Stores still has 0 items after approval');

    const inTransit = stock.inTransit('filter', { from_location_id: 1 });
    assert.equal(inTransit.length, 0, 'No stock in-transit before dispatch');
  });

  await t.test('3. Dispatched MTN: deducted from origin, 0 in destination, visible in inTransit', () => {
    const mtn = get("SELECT id FROM mtn WHERE mtn_no = 'MTN-TEST-01'");
    run("UPDATE mtn SET status = 'dispatched' WHERE id = ?", mtn.id);
    stock.rebuild({ transfersOf: mtn.id });

    const balMs = stock.summary('filter', { physical_store_id: 1 });
    const balWs = stock.summary('filter', { physical_store_id: 2 });
    assert.equal(balMs.balance, 40, 'Central Main Stores deducted 10 items (50 -> 40)');
    assert.equal(balWs.balance, 0, 'Main Workshop Stores has not received items yet');

    const inTransit = stock.inTransit('filter', { from_location_id: 1 });
    assert.equal(inTransit.length, 1, '1 line in transit');
    assert.equal(inTransit[0].qty_in_transit, 10, '10 items in transit');
    assert.equal(inTransit[0].from_location_id, 1, 'From store location is 1');
    assert.equal(inTransit[0].to_location_id, 2, 'To store location is 2');
  });

  await t.test('4. Accepted MTN: added to destination physical store, clears inTransit', () => {
    const mtn = get("SELECT id FROM mtn WHERE mtn_no = 'MTN-TEST-01'");
    // Simulate accept
    run("UPDATE mtn SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?", mtn.id);
    supplyRoutes.onMtnAccepted(mtn.id, [{ line_id: get('SELECT id FROM mtn_lines WHERE mtn_id = ?', mtn.id).id, qty_received: 10 }]);
    stock.rebuild({ transfersOf: mtn.id });

    const balMs = stock.summary('filter', { physical_store_id: 1 });
    const balWs = stock.summary('filter', { physical_store_id: 2 });
    assert.equal(balMs.balance, 40, 'Central Main Stores remains at 40');
    assert.equal(balWs.balance, 10, 'Main Workshop Stores received 10 items (0 -> 10)');

    const inTransit = stock.inTransit('filter', { from_location_id: 1 });
    assert.equal(inTransit.length, 0, 'In-transit is cleared after acceptance');
  });

  await t.test('5. Short Delivery: Dispatched 10, Accepted 8 -> Destination receives 8, Discrepancy logged for 2', () => {
    // Create new MTN for 10 items
    const mtnId = run(`
      INSERT INTO mtn (mtn_no, txn_date, from_location, to_location, from_store_location_id, to_store_location_id,
                       status, workshop_id)
      VALUES ('MTN-TEST-02', '2026-10-09', 'Central Main Stores', 'Main Workshop Stores', 1, 2, 'dispatched', 1)
    `).lastInsertRowid;

    const lineId = run(`
      INSERT INTO mtn_lines (mtn_id, line_no, description, qty, unit, category, from_store_location_id, to_store_location_id)
      VALUES (?, 1, ?, 10, 'nos', 'filter', 1, 2)
    `, mtnId, partNo).lastInsertRowid;

    stock.rebuild({ transfersOf: mtnId });

    let balMs = stock.summary('filter', { physical_store_id: 1 });
    let balWs = stock.summary('filter', { physical_store_id: 2 });
    assert.equal(balMs.balance, 30, 'Central Main Stores deducted 10 (40 -> 30)');
    assert.equal(balWs.balance, 10, 'Main Workshop Stores still at 10');

    // Accept with short delivery: 8 accepted, 2 damaged
    run("UPDATE mtn SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?", mtnId);
    supplyRoutes.onMtnAccepted(mtnId, [{ line_id: lineId, qty_received: 8, discrepancy_reason: '2 filters damaged during transport' }]);
    stock.rebuild({ transfersOf: mtnId });

    balMs = stock.summary('filter', { physical_store_id: 1 });
    balWs = stock.summary('filter', { physical_store_id: 2 });
    assert.equal(balMs.balance, 30, 'Central Main Stores remains at 30');
    assert.equal(balWs.balance, 18, 'Main Workshop Stores received exactly 8 (10 + 8 = 18)');

    // Verify discrepancy logged in delivery_discrepancies
    const disc = get('SELECT * FROM delivery_discrepancies WHERE mtn_id = ?', mtnId);
    assert.ok(disc, 'Discrepancy record exists');
    assert.equal(disc.qty_expected, 10, 'Expected/dispatched qty recorded as 10');
    assert.equal(disc.qty_received, 8, 'Received qty recorded as 8');
    assert.equal(disc.qty_short, 2, 'Short qty recorded as 2');
    assert.equal(disc.reason, '2 filters damaged during transport');
  });

  await t.test('6. Rejection after dispatch: Reverses deduction back onto origin shelf', () => {
    // Create new MTN for 5 items
    const mtnId = run(`
      INSERT INTO mtn (mtn_no, txn_date, from_location, to_location, from_store_location_id, to_store_location_id,
                       status, workshop_id)
      VALUES ('MTN-TEST-03', '2026-10-09', 'Central Main Stores', 'Main Workshop Stores', 1, 2, 'dispatched', 1)
    `).lastInsertRowid;

    run(`
      INSERT INTO mtn_lines (mtn_id, line_no, description, qty, unit, category, from_store_location_id, to_store_location_id)
      VALUES (?, 1, ?, 5, 'nos', 'filter', 1, 2)
    `, mtnId, partNo);

    stock.rebuild({ transfersOf: mtnId });

    let balMs = stock.summary('filter', { physical_store_id: 1 });
    assert.equal(balMs.balance, 25, 'Central Main Stores deducted 5 on dispatch (30 -> 25)');

    // Reject MTN
    run("UPDATE mtn SET status = 'rejected' WHERE id = ?", mtnId);
    stock.rebuild({ transfersOf: mtnId });

    balMs = stock.summary('filter', { physical_store_id: 1 });
    let balWs = stock.summary('filter', { physical_store_id: 2 });
    assert.equal(balMs.balance, 30, 'Central Main Stores restored to 30 after rejection');
    assert.equal(balWs.balance, 18, 'Main Workshop Stores unaffected and remains at 18');
  });

  await t.test('7. Return transfer from Main Workshop (2) to Central Main Stores (1)', () => {
    // Transfer 4 items from Main Workshop back to Central Main Stores
    const mtnId = run(`
      INSERT INTO mtn (mtn_no, txn_date, from_location, to_location, from_store_location_id, to_store_location_id,
                       status, workshop_id)
      VALUES ('MTN-RET-01', '2026-10-09', 'Main Workshop Stores', 'Central Main Stores', 2, 1, 'dispatched', 1)
    `).lastInsertRowid;

    const lineId = run(`
      INSERT INTO mtn_lines (mtn_id, line_no, description, qty, unit, category, from_store_location_id, to_store_location_id)
      VALUES (?, 1, ?, 4, 'nos', 'filter', 2, 1)
    `, mtnId, partNo).lastInsertRowid;

    stock.rebuild({ transfersOf: mtnId });

    let balMs = stock.summary('filter', { physical_store_id: 1 });
    let balWs = stock.summary('filter', { physical_store_id: 2 });
    assert.equal(balWs.balance, 14, 'Workshop Stores deducted 4 on dispatch (18 -> 14)');
    assert.equal(balMs.balance, 30, 'Central Main Stores has not received yet (still 30)');

    // Accept return transfer at Central Main Stores
    run("UPDATE mtn SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?", mtnId);
    supplyRoutes.onMtnAccepted(mtnId, [{ line_id: lineId, qty_received: 4 }]);
    stock.rebuild({ transfersOf: mtnId });

    balMs = stock.summary('filter', { physical_store_id: 1 });
    balWs = stock.summary('filter', { physical_store_id: 2 });
    assert.equal(balWs.balance, 14, 'Workshop Stores remains at 14');
    assert.equal(balMs.balance, 34, 'Central Main Stores received 4 (30 -> 34)');
  });
});
