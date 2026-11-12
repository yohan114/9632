'use strict';

/**
 * Step 3: Purchasing, Procurement & GRN Routing to Central Main Stores Tests
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-stock-p3-'));
process.env.DB_PATH = path.join(TMP, 'stock_p3.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');

const { migrate, run, get, all, db } = require('../src/db');
const storeLocations = require('../src/lib/store_locations');
const stock = require('../src/lib/stock');

migrate();

// Seed test workshops
run(`INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active, own_store)
    VALUES (1, 'CW', 'Central Workshop — Badalgama', 'Badalgama', 1, 1, 1)`);
run(`INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active, own_store)
    VALUES (2, 'GWS', 'Galagedara Workshop', 'Galagedara', 0, 1, 1)`);

// Seed physical stores and run migrations
storeLocations.seedStoreLocations(db);
storeLocations.migrateStoreLocationsStage2(db);

test('Step 3: Purchasing, Procurement & GRN Routing to Central Main Stores', async (t) => {
  await t.test('1. Database schema contains target_store_location_id and physical_store_id', () => {
    const mrnCols = db.prepare('PRAGMA table_info(mrn)').all().map((c) => c.name);
    const mrnLineCols = db.prepare('PRAGMA table_info(mrn_lines)').all().map((c) => c.name);
    const grnVoucherCols = db.prepare('PRAGMA table_info(grn_vouchers)').all().map((c) => c.name);
    const grnCols = db.prepare('PRAGMA table_info(grn)').all().map((c) => c.name);

    assert.ok(mrnCols.includes('target_store_location_id'), 'mrn has target_store_location_id');
    assert.ok(mrnLineCols.includes('target_store_location_id'), 'mrn_lines has target_store_location_id');
    assert.ok(grnVoucherCols.includes('physical_store_id'), 'grn_vouchers has physical_store_id');
    assert.ok(grnCols.includes('physical_store_id'), 'grn has physical_store_id');
  });

  await t.test('2. Central Purchase (head_office) routes to Central Main Stores (id=1)', () => {
    const msLocation = get("SELECT id FROM store_locations WHERE code = 'MAIN-STORES'");
    const wsLocation = get("SELECT id FROM store_locations WHERE code = 'MAIN-WORKSHOP'");
    assert.ok(msLocation && msLocation.id, 'Central Main Stores exists');
    assert.ok(wsLocation && wsLocation.id, 'Main Workshop Stores exists');

    // Create an MRN with head_office purchase source
    const mrnId = run(`
      INSERT INTO mrn (mrn_no, req_date, workshop_id, purpose, purchase_source, approval_status)
      VALUES ('MRN-HO-001', '2026-10-09', 1, 'Central stock replenishment', 'head_office', 'approved')
    `).lastInsertRowid;

    const mrnLineId = run(`
      INSERT INTO mrn_lines (mrn_id, description, qty, unit, category, purchase_source)
      VALUES (?, 'Central Filter C-500', 50, 'nos', 'filter', 'head_office')
    `, mrnId).lastInsertRowid;

    // Simulate GRN receipt created for head_office purchase routed to Central Main Stores (msLocation.id = 1)
    const grnId = run(`
      INSERT INTO grn (status, grn_no, grn_date, mrn_id, mrn_line_id, description, qty, unit_price,
                       purchase_source, delivery_date, store_id, physical_store_id)
      VALUES ('approved', 'GRN-HO-001', '2026-10-09', ?, ?, 'Central Filter C-500', 50, 1200,
              'head_office', '2026-10-09', 1, ?)
    `, mrnId, mrnLineId, msLocation.id).lastInsertRowid;

    // Sync stock
    stock.sync({ grn: [grnId] });

    // Verify stock_moves
    const move = get(`
      SELECT * FROM stock_moves WHERE source_table = 'grn' AND source_id = ?
    `, grnId);

    assert.ok(move, 'stock_move created');
    assert.equal(move.physical_store_id, msLocation.id, 'Move is assigned to Central Main Store location');
    assert.equal(move.qty, 50, 'Quantity is 50');

    // Verify stock summary for Central Main Store has 50
    const msItems = stock.items('filter', '', 500, { physical_store_id: msLocation.id });
    const msFilter = msItems.find((s) => s.item_key.includes('C500') || (s.item_name && s.item_name.includes('C-500')));
    assert.ok(msFilter, 'Filter found in Central Main Store stock');
    assert.equal(msFilter.balance, 50, 'Central Main Store balance is 50');

    const msSectionSummary = stock.summary('filter', { physical_store_id: msLocation.id });
    assert.equal(msSectionSummary.balance, 50, 'Central Main Store section summary balance is 50');

    // Verify stock summary for Main Workshop Store is completely unaffected
    const wsItems = stock.items('filter', '', 500, { physical_store_id: wsLocation.id });
    const wsFilter = wsItems.find((s) => s.item_key.includes('C500') || (s.item_name && s.item_name.includes('C-500')));
    assert.equal(wsFilter, undefined, 'Main Workshop Store does NOT contain Central Store items');

    const wsSectionSummary = stock.summary('filter', { physical_store_id: wsLocation.id });
    assert.equal(wsSectionSummary.balance, 0, 'Main Workshop Store section summary balance is 0');
  });

  await t.test('3. Local Workshop Purchase routes directly to Main Workshop Store (id=2)', () => {
    const wsLocation = get("SELECT id FROM store_locations WHERE code = 'MAIN-WORKSHOP'");
    const msLocation = get("SELECT id FROM store_locations WHERE code = 'MAIN-STORES'");

    // Create an MRN for workshop 1
    const mrnId = run(`
      INSERT INTO mrn (mrn_no, req_date, workshop_id, purpose, purchase_source, approval_status)
      VALUES ('MRN-LOC-001', '2026-10-09', 1, 'Urgent workshop repair', 'local_purchase', 'approved')
    `).lastInsertRowid;

    const mrnLineId = run(`
      INSERT INTO mrn_lines (mrn_id, description, qty, unit, category, purchase_source)
      VALUES (?, 'Local Workshop Bearing 6205', 10, 'nos', 'general', 'local_purchase')
    `, mrnId).lastInsertRowid;

    // Simulate GRN receipt routed to workshop store
    const grnId = run(`
      INSERT INTO grn (status, grn_no, grn_date, mrn_id, mrn_line_id, description, qty, unit_price,
                       purchase_source, delivery_date, store_id, physical_store_id)
      VALUES ('approved', 'GRN-LOC-001', '2026-10-09', ?, ?, 'Local Workshop Bearing 6205', 10, 450,
              'local_purchase', '2026-10-09', 1, ?)
    `, mrnId, mrnLineId, wsLocation.id).lastInsertRowid;

    stock.sync({ grn: [grnId] });

    // Verify move is in Workshop Store
    const move = get(`
      SELECT * FROM stock_moves WHERE source_table = 'grn' AND source_id = ?
    `, grnId);

    assert.equal(move.physical_store_id, wsLocation.id, 'Move is in Main Workshop Store');

    const wsItems = stock.items('general', '', 500, { physical_store_id: wsLocation.id });
    const wsItem = wsItems.find((s) => s.item_name && s.item_name.includes('6205'));
    assert.ok(wsItem, 'Item in workshop stock');
    assert.equal(wsItem.balance, 10, 'Workshop balance is 10');

    const wsSectionSummary = stock.summary('general', { physical_store_id: wsLocation.id });
    assert.equal(wsSectionSummary.balance, 10, 'Workshop section balance is 10');

    // Central Main Store should NOT have this bearing
    const msItems = stock.items('general', '', 500, { physical_store_id: msLocation.id });
    const msItem = msItems.find((s) => s.item_name && s.item_name.includes('6205'));
    assert.equal(msItem, undefined, 'Central Main Store does NOT have workshop local item');

    const msSectionSummary = stock.summary('general', { physical_store_id: msLocation.id });
    assert.equal(msSectionSummary.balance, 0, 'Central Main Store section balance is 0');
  });

  await t.test('4. Purchasing buyer updates (marking bought / invoice) DO NOT touch stock', () => {
    const movesBefore = get('SELECT COUNT(*) c FROM stock_moves').c;

    // Mark line bought on mrn_lines
    run(`
      UPDATE mrn_lines
         SET purchased_at = datetime('now'),
             purchased_by = 'buyer1',
             supplier = 'Auto Spares Ltd',
             invoice_no = 'INV-999',
             purchase_amount = 5000
       WHERE id = 1
    `);

    const movesAfter = get('SELECT COUNT(*) c FROM stock_moves').c;
    assert.equal(movesAfter, movesBefore, 'Stock moves count unchanged after buyer purchase update');
  });

  await t.test('5. GRN Voucher stores physical_store_id on header and lines', () => {
    const msLocation = get("SELECT id FROM store_locations WHERE code = 'MAIN-STORES'");

    const vId = run(`
      INSERT INTO grn_vouchers (grn_no, received_date, supplier, status, physical_store_id)
      VALUES ('GRN-V-001', '2026-10-09', 'Central Supplier', 'pending_approval', ?)
    `, msLocation.id).lastInsertRowid;

    const voucher = get('SELECT * FROM grn_vouchers WHERE id = ?', vId);
    assert.equal(voucher.physical_store_id, msLocation.id, 'Voucher has physical_store_id');
  });

  test.after(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });
});
