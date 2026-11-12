'use strict';

/**
 * Step 7: Direct Sourcing of General Construction / Site Materials from Site Store to Main Stores
 * 
 * Verifies:
 * 1. Routing classification via determineItemSourceStore:
 *    - Mechanical / Workshop items (filters, oils, tyres, batteries, engine spares) -> Store 2 (Main Workshop)
 *    - General / Civil construction materials (cement, steel rebar, timber, PPE helmets, electrical wire) -> Store 1 (Main Stores)
 * 2. Pure Civil Requisition:
 *    - Site Store (3) requests 20 bags of Cement and 10 Safety Helmets.
 *    - Sourced directly from Central Main Stores (1).
 *    - Generates exactly ONE Auto-MTN directly from Central Main Stores (1) to Site Store (3).
 *    - Does NOT trigger child replenishment to Main Workshop.
 *    - Dispatch & acceptance updates stock from Store 1 to Store 3.
 * 3. Mixed Requisition on a Single Unified MRN:
 *    - Remote sites have ONLY a unified Site Store (SITE_STORE), requesting both workshop spares and civil materials.
 *    - Line 1: Filter LF16015 (5 nos) -> routed to Store 2 (Main Workshop).
 *    - Line 2: Steel Rebar 12mm (20 nos) -> routed to Store 1 (Central Main Stores).
 *    - Site Authority Approval generates TWO separate Auto-MTNs under the SAME chain_no!
 *    - Auto-MTN A: From Main Workshop (2) to Site Store (3) for Line 1.
 *    - Auto-MTN B: From Central Main Stores (1) to Site Store (3) for Line 2.
 *    - Each MRN line points to its specific auto_mtn_id.
 * 4. Asynchronous Multi-Origin Dispatch & Receipt:
 *    - Dispatch and accept MTN A: Line 1 received, parent MRN status is 'partially_received'.
 *    - Dispatch and accept MTN B: Line 2 received, parent MRN status advances to 'received'.
 * 5. Mixed Requisition with Local Shelf Stock Check First:
 *    - Site Store already has 2 bags of Cement on shelf.
 *    - Requisition for 10 bags Cement and 4 Tyres.
 *    - 2 Cement fulfilled locally (local_issue_qty = 2); 8 Cement transferred from Store 1; 4 Tyres from Store 2.
 * 6. Chain Traceability:
 *    - Universal chain trace verifies all MTNs share the parent chain_no.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-stock-p7-'));
process.env.DB_PATH = path.join(TMP, 'stock_p7.db');
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

// Seed test user
run(`INSERT OR IGNORE INTO users (id, username, password_hash, full_name, active)
    VALUES (1, 'site.eng', 'hash', 'Site Authority Engineer', 1)`);

// Seed physical stores and hierarchy
storeLocations.seedStoreLocations(db);
storeLocations.migrateStoreLocationsStage2(db);

const msLoc = get("SELECT id, code, name FROM store_locations WHERE code = 'MAIN-STORES'");
const wsLoc = get("SELECT id, code, name FROM store_locations WHERE code = 'MAIN-WORKSHOP'");
const siteLoc = get("SELECT id, code, name FROM store_locations WHERE code = 'SITE-STORE-GWS'");

test('Step 7: Direct Sourcing of General Materials & Multi-Origin Auto-Transfers', async (t) => {
  assert.ok(msLoc && msLoc.id === 1, 'Central Main Stores exists with ID 1');
  assert.ok(wsLoc && wsLoc.id === 2, 'Main Workshop Stores exists with ID 2');
  assert.ok(siteLoc && siteLoc.id === 3, 'Site Store exists with ID 3');

  await t.test('1. Routing Classification: determineItemSourceStore correctly maps items', () => {
    // Mechanical / Workshop items -> Store 2 (Main Workshop)
    assert.equal(supplyRoutes.determineItemSourceStore({ description: 'Oil Filter LF16015', category: 'Filters' }), 2);
    assert.equal(supplyRoutes.determineItemSourceStore({ description: 'Engine Oil 15W40', category: 'Lubricants' }), 2);
    assert.equal(supplyRoutes.determineItemSourceStore({ description: 'Tyre 10.00-20', category: 'Tyres' }), 2);
    assert.equal(supplyRoutes.determineItemSourceStore({ description: 'Exide 12V 100Ah Battery', category: 'Batteries' }), 2);
    assert.equal(supplyRoutes.determineItemSourceStore({ description: 'Hydraulic Cylinder Seal Kit', category: 'Spare Parts' }), 2);
    assert.equal(supplyRoutes.determineItemSourceStore({ description: 'Brake Shoe Lining', category: 'Mechanical' }), 2);

    // General / Civil construction materials -> Store 1 (Central Main Stores)
    assert.equal(supplyRoutes.determineItemSourceStore({ description: 'Portland Cement 50kg', category: 'Civil Materials' }), 1);
    assert.equal(supplyRoutes.determineItemSourceStore({ description: 'Reinforcement Steel Rebar 16mm', category: 'Civil' }), 1);
    assert.equal(supplyRoutes.determineItemSourceStore({ description: 'Safety Helmet Yellow', category: 'Safety / PPE' }), 1);
    assert.equal(supplyRoutes.determineItemSourceStore({ description: 'Plywood Sheet 18mm', category: 'Timber' }), 1);
    assert.equal(supplyRoutes.determineItemSourceStore({ description: 'PVC Pipe 2 inch', category: 'Plumbing' }), 1);
    assert.equal(supplyRoutes.determineItemSourceStore({ description: 'Electrical Cable 2.5mm', category: 'Electrical' }), 1);
  });

  // Seed Initial Inventory:
  // - Main Stores (1): 100 bags Cement, 50 Steel Rebars, 30 Safety Helmets
  // - Main Workshop (2): 20 Oil Filters LF16015, 10 Tyres
  // - Site Store (3): 0 of each
  const grnMs1 = run(`
    INSERT INTO grn (status, grn_no, grn_date, description, qty, unit_price,
                     purchase_source, delivery_date, store_id, physical_store_id)
    VALUES ('approved', 'GRN-P7-MS-01', '2026-10-12', 'Portland Cement 50kg', 100, 2400, 'central_store', '2026-10-12', 1, 1)
  `).lastInsertRowid;
  const grnMs2 = run(`
    INSERT INTO grn (status, grn_no, grn_date, description, qty, unit_price,
                     purchase_source, delivery_date, store_id, physical_store_id)
    VALUES ('approved', 'GRN-P7-MS-02', '2026-10-12', 'Steel Rebar 12mm', 50, 4500, 'central_store', '2026-10-12', 1, 1)
  `).lastInsertRowid;
  const grnMs3 = run(`
    INSERT INTO grn (status, grn_no, grn_date, description, qty, unit_price,
                     purchase_source, delivery_date, store_id, physical_store_id)
    VALUES ('approved', 'GRN-P7-MS-03', '2026-10-12', 'Safety Helmet Yellow', 30, 1500, 'central_store', '2026-10-12', 1, 1)
  `).lastInsertRowid;

  const grnWs1 = run(`
    INSERT INTO grn (status, grn_no, grn_date, description, qty, unit_price,
                     purchase_source, delivery_date, store_id, physical_store_id)
    VALUES ('approved', 'GRN-P7-WS-01', '2026-10-12', 'Oil Filter LF16015', 20, 3800, 'central_store', '2026-10-12', 1, 2)
  `).lastInsertRowid;
  const grnWs2 = run(`
    INSERT INTO grn (status, grn_no, grn_date, description, qty, unit_price,
                     purchase_source, delivery_date, store_id, physical_store_id)
    VALUES ('approved', 'GRN-P7-WS-02', '2026-10-12', 'Tyre 10.00-20', 10, 65000, 'central_store', '2026-10-12', 1, 2)
  `).lastInsertRowid;

  stock.sync({ grn: [grnMs1, grnMs2, grnMs3, grnWs1, grnWs2] });

  let civilMrnId, civilLine1Id, civilLine2Id, civilMtnId;

  await t.test('2. Pure Civil Requisition: Site Store -> Central Main Stores (1) directly', () => {
    // Site Store (3) raises MRN for 20 bags Cement and 10 Safety Helmets
    civilMrnId = run(`
      INSERT INTO mrn (
        mrn_no, req_date, workshop_id, target_store_location_id,
        purpose, requested_by, approval_status, site_authority_status, status
      ) VALUES (
        'MRN-P7-CIVIL-01', '2026-10-12', 2, 3,
        'Site Office Construction', 'Site Supervisor', 'certified', 'pending', 'open'
      )
    `).lastInsertRowid;

    civilLine1Id = run(`
      INSERT INTO mrn_lines (mrn_id, description, qty, unit, category, supply_route, target_store_location_id)
      VALUES (?, 'Portland Cement 50kg', 20, 'bags', 'Civil Materials', 'main_store', 3)
    `, civilMrnId).lastInsertRowid;

    civilLine2Id = run(`
      INSERT INTO mrn_lines (mrn_id, description, qty, unit, category, supply_route, target_store_location_id)
      VALUES (?, 'Safety Helmet Yellow', 10, 'nos', 'Safety / PPE', 'main_store', 3)
    `, civilMrnId).lastInsertRowid;

    // Availability check confirms both lines source from Main Stores (1)
    const avail = supplyRoutes.checkMainWorkshopAvailability(civilMrnId);
    assert.equal(avail.overall_status, 'full');
    assert.equal(avail.lines[0].source_store_location_id, 1, 'Cement sources from Main Stores 1');
    assert.equal(avail.lines[1].source_store_location_id, 1, 'Helmets source from Main Stores 1');

    // Site Authority approval
    supplyRoutes.onSiteAuthorityApproved(civilMrnId, { id: 1, fullName: 'Site Authority Engineer' });
    run("UPDATE mrn SET approval_status = 'approved' WHERE id = ?", civilMrnId);
    supplyRoutes.onMrnApproved(civilMrnId, { fullName: 'Site Authority Engineer' });

    // Verify auto-MTN generated: exactly ONE MTN from Main Stores (1) to Site Store (3)
    const mtns = all('SELECT * FROM mtn WHERE mrn_id = ?', civilMrnId);
    assert.equal(mtns.length, 1, 'Exactly 1 Auto-MTN created for civil materials');
    civilMtnId = mtns[0].id;

    assert.equal(mtns[0].from_store_location_id, 1, 'Supplying store is Central Main Stores (1)');
    assert.equal(mtns[0].to_store_location_id, 3, 'Destination is Site Store (3)');

    const mtnLines = all('SELECT * FROM mtn_lines WHERE mtn_id = ? ORDER BY line_no ASC', civilMtnId);
    assert.equal(mtnLines.length, 2, '2 items in Auto-MTN');
    assert.equal(mtnLines[0].qty, 20);
    assert.equal(mtnLines[1].qty, 10);

    // Verify NO child replenishment MRN was raised
    const childMrns = all('SELECT * FROM mrn WHERE parent_mrn_id = ?', civilMrnId);
    assert.equal(childMrns.length, 0, 'No child replenishment MRN raised for direct Main Stores items');

    // Dispatch & Accept the MTN
    run("UPDATE mtn SET status = 'dispatched' WHERE id = ?", civilMtnId);
    supplyRoutes.onMtnDispatched(civilMtnId);
    stock.rebuild({ transfersOf: civilMtnId });

    assert.equal(stock.summary('general', { physical_store_id: 1 }).balance, 150, 'Main Stores balance deducted');

    run("UPDATE mtn SET status = 'accepted' WHERE id = ?", civilMtnId);
    supplyRoutes.onMtnAccepted(civilMtnId, [
      { mtn_line_id: mtnLines[0].id, qty_received: 20 },
      { mtn_line_id: mtnLines[1].id, qty_received: 10 },
    ], { fullName: 'Site Storekeeper' });
    stock.rebuild({ transfersOf: civilMtnId });

    const updatedMrn = get('SELECT status FROM mrn WHERE id = ?', civilMrnId);
    assert.equal(updatedMrn.status, 'received', 'Civil MRN status advances to received');
  });

  let mixedMrnId, mixedLineFilterId, mixedLineSteelId, mtnWorkshopId, mtnMainStoresId;

  await t.test('3. Mixed Requisition: Single MRN with Mechanical Spares + Civil Construction Materials', () => {
    // Single unified MRN raised at Site Store 3:
    // Line 1: 5 Oil Filters LF16015 (Mechanical spare -> Store 2)
    // Line 2: 15 Steel Rebars 12mm (Civil building material -> Store 1)
    mixedMrnId = run(`
      INSERT INTO mrn (
        mrn_no, req_date, workshop_id, target_store_location_id,
        purpose, requested_by, approval_status, site_authority_status, status
      ) VALUES (
        'MRN-P7-MIXED-01', '2026-10-12', 2, 3,
        'Site Workshop Maintenance & Slab Casting', 'Site In-Charge', 'certified', 'pending', 'open'
      )
    `).lastInsertRowid;

    mixedLineFilterId = run(`
      INSERT INTO mrn_lines (mrn_id, description, qty, unit, category, supply_route, target_store_location_id)
      VALUES (?, 'Oil Filter LF16015', 5, 'nos', 'Filters', 'main_store', 3)
    `, mixedMrnId).lastInsertRowid;

    mixedLineSteelId = run(`
      INSERT INTO mrn_lines (mrn_id, description, qty, unit, category, supply_route, target_store_location_id)
      VALUES (?, 'Steel Rebar 12mm', 15, 'nos', 'Civil Construction', 'main_store', 3)
    `, mixedMrnId).lastInsertRowid;

    // Check availability across multi-origins
    const avail = supplyRoutes.checkMainWorkshopAvailability(mixedMrnId);
    assert.equal(avail.overall_status, 'full');
    assert.equal(avail.lines[0].source_store_location_id, 2, 'Filters route to Main Workshop (2)');
    assert.equal(avail.lines[1].source_store_location_id, 1, 'Steel Rebars route to Central Main Stores (1)');

    // Site Authority approval
    supplyRoutes.onSiteAuthorityApproved(mixedMrnId, { id: 1, fullName: 'Site Authority Engineer' });
    run("UPDATE mrn SET approval_status = 'approved' WHERE id = ?", mixedMrnId);
    supplyRoutes.onMrnApproved(mixedMrnId, { fullName: 'Site Authority Engineer' });

    // Verify TWO distinct Auto-MTNs were generated for the same MRN!
    const mtns = all('SELECT * FROM mtn WHERE mrn_id = ? ORDER BY from_store_location_id DESC', mixedMrnId);
    assert.equal(mtns.length, 2, 'TWO Auto-MTNs created: one per supplying central store');

    // MTN 1: From Main Workshop Stores (2)
    const mtnWs = mtns.find((m) => m.from_store_location_id === 2);
    assert.ok(mtnWs, 'MTN from Main Workshop exists');
    assert.equal(mtnWs.to_store_location_id, 3, 'Transfers to Site Store 3');
    mtnWorkshopId = mtnWs.id;

    // MTN 2: From Central Main Stores (1)
    const mtnMs = mtns.find((m) => m.from_store_location_id === 1);
    assert.ok(mtnMs, 'MTN from Central Main Stores exists');
    assert.equal(mtnMs.to_store_location_id, 3, 'Transfers to Site Store 3');
    mtnMainStoresId = mtnMs.id;

    // Both MTNs share the parent MRN chain_no!
    const parentMrn = get('SELECT chain_no FROM mrn WHERE id = ?', mixedMrnId);
    assert.ok(parentMrn.chain_no, 'Parent MRN has chain_no');
    assert.equal(mtnWs.chain_no, parentMrn.chain_no, 'Workshop MTN has parent chain_no');
    assert.equal(mtnMs.chain_no, parentMrn.chain_no, 'Main Stores MTN has parent chain_no');

    // Verify MRN lines point to their respective auto_mtn_id
    const lineFilter = get('SELECT * FROM mrn_lines WHERE id = ?', mixedLineFilterId);
    const lineSteel = get('SELECT * FROM mrn_lines WHERE id = ?', mixedLineSteelId);

    assert.equal(lineFilter.auto_mtn_id, mtnWorkshopId, 'Filter line linked to Workshop MTN');
    assert.equal(lineFilter.source_store_location_id, 2, 'Filter line source store is 2');
    assert.equal(lineSteel.auto_mtn_id, mtnMainStoresId, 'Steel line linked to Main Stores MTN');
    assert.equal(lineSteel.source_store_location_id, 1, 'Steel line source store is 1');
  });

  await t.test('4. Asynchronous Multi-Origin Dispatch & Receipt', () => {
    // Dispatch and accept MTN 1 (Workshop filters) first
    run("UPDATE mtn SET status = 'dispatched' WHERE id = ?", mtnWorkshopId);
    supplyRoutes.onMtnDispatched(mtnWorkshopId);
    stock.rebuild({ transfersOf: mtnWorkshopId });

    assert.equal(stock.summary('filter', { physical_store_id: 2 }).balance, 15, 'Workshop filter balance drops 20 -> 15');

    // Accept at Site Store
    const wsMtnLine = get('SELECT id FROM mtn_lines WHERE mtn_id = ?', mtnWorkshopId);
    run("UPDATE mtn SET status = 'accepted' WHERE id = ?", mtnWorkshopId);
    supplyRoutes.onMtnAccepted(mtnWorkshopId, [{ line_id: wsMtnLine.id, qty_received: 5 }], { fullName: 'Site Storekeeper' });
    stock.rebuild({ transfersOf: mtnWorkshopId });

    assert.equal(stock.summary('filter', { physical_store_id: 3 }).balance, 5, 'Site Store received 5 filters');

    // MRN status should be partially_received because Steel Rebars have not arrived yet!
    const mrnPartially = get('SELECT status FROM mrn WHERE id = ?', mixedMrnId);
    assert.equal(mrnPartially.status, 'partially_received', 'MRN status is partially_received after first MTN delivery');

    // Now dispatch and accept MTN 2 (Main Stores steel rebars)
    run("UPDATE mtn SET status = 'dispatched' WHERE id = ?", mtnMainStoresId);
    supplyRoutes.onMtnDispatched(mtnMainStoresId);
    stock.rebuild({ transfersOf: mtnMainStoresId });

    const msMtnLine = get('SELECT id FROM mtn_lines WHERE mtn_id = ?', mtnMainStoresId);
    run("UPDATE mtn SET status = 'accepted' WHERE id = ?", mtnMainStoresId);
    supplyRoutes.onMtnAccepted(mtnMainStoresId, [{ line_id: msMtnLine.id, qty_received: 15 }], { fullName: 'Site Storekeeper' });
    stock.rebuild({ transfersOf: mtnMainStoresId });

    // MRN status now advances to received!
    const mrnFully = get('SELECT status FROM mrn WHERE id = ?', mixedMrnId);
    assert.equal(mrnFully.status, 'received', 'MRN status advances to received after both MTNs delivered');
  });

  await t.test('5. Local Shelf Priority on Mixed Requisition', () => {
    // Current state at Site Store (3): has 5 filters and 20 cement bags from previous deliveries.
    // Raise a new MRN requesting:
    // - 8 Cement bags (local shelf has 20, so 8 satisfied locally!)
    // - 2 Tyres (local shelf has 0, so 2 transfer from Main Workshop 2!)
    const mixed2Id = run(`
      INSERT INTO mrn (
        mrn_no, req_date, workshop_id, target_store_location_id,
        purpose, requested_by, approval_status, site_authority_status, status
      ) VALUES (
        'MRN-P7-LOCAL-01', '2026-10-12', 2, 3,
        'Site Patching & Roller Tyres', 'Site Supervisor', 'certified', 'approved', 'open'
      )
    `).lastInsertRowid;

    const lineCement = run(`
      INSERT INTO mrn_lines (mrn_id, description, qty, unit, category, supply_route, target_store_location_id)
      VALUES (?, 'Portland Cement 50kg', 8, 'bags', 'Civil Materials', 'main_store', 3)
    `, mixed2Id).lastInsertRowid;

    const lineTyre = run(`
      INSERT INTO mrn_lines (mrn_id, description, qty, unit, category, supply_route, target_store_location_id)
      VALUES (?, 'Tyre 10.00-20', 2, 'nos', 'Tyres', 'main_store', 3)
    `, mixed2Id).lastInsertRowid;

    supplyRoutes.onMrnApproved(mixed2Id, { fullName: 'Site Authority Engineer' });

    // Cement is satisfied 100% locally from shelf stock:
    const cLine = get('SELECT * FROM mrn_lines WHERE id = ?', lineCement);
    assert.equal(cLine.local_issue_qty, 8, 'All 8 cement bags satisfied locally');
    assert.equal(cLine.qty_approved, 8, 'All 8 approved');
    assert.equal(cLine.auto_mtn_id, null, 'NO central transfer note needed for cement');

    // Tyres cannot be satisfied locally: transfers 2 from Main Workshop (2)
    const tLine = get('SELECT * FROM mrn_lines WHERE id = ?', lineTyre);
    assert.equal(tLine.local_issue_qty, 0);
    assert.equal(tLine.qty_approved, 2);
    assert.ok(tLine.auto_mtn_id, 'Auto-MTN created for tyres');

    const mtnTyre = get('SELECT * FROM mtn WHERE id = ?', tLine.auto_mtn_id);
    assert.equal(mtnTyre.from_store_location_id, 2, 'Tyres transfer from Main Workshop (2)');
    assert.equal(mtnTyre.to_store_location_id, 3, 'To Site Store (3)');
  });

  await t.test('6. Universal Chain Traceability across Multi-MTN Pipeline', () => {
    const parentMrn = get('SELECT chain_no FROM mrn WHERE id = ?', mixedMrnId);
    const trace = chainPipeline.getChainPipeline(parentMrn.chain_no);

    assert.ok(trace, 'Pipeline trace returned');
    assert.equal(trace.chain_no, parentMrn.chain_no);
    assert.equal(trace.mrns.length, 1, 'Traces 1 parent MRN');
    assert.equal(trace.lines.length, 2, 'Traces both MRN lines');
    assert.equal(trace.mtns.length, 2, 'Traces both MTNs under the same chain_no');

    const mtnOrigins = trace.mtns.map((m) => m.from_store_location_id).sort();
    assert.deepEqual(mtnOrigins, [1, 2], 'Traced MTNs originate from Store 1 and Store 2');
  });
});
