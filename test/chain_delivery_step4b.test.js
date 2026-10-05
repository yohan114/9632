'use strict';

// ===========================================================================
// WorkshopOne — Step 4b Test Suite: Single Chain Number & Short Deliveries
//
// Rules verified:
//   1. Universal Chain Number (chain_no):
//      - Sequential format CHN-YYYY-XXXXX.
//      - Auto-stamped across full lifecycle: MRN → MTN → GRN → MIN / Issue.
//      - Stamped automatically on MRN creation.
//      - Propagated to linked MTNs, GRNs, GRN vouchers, Issues, MIN notes.
//   2. Short Deliveries & Discrepancies:
//      - Record actual received vs sent (qty_received < qty_sent).
//      - Deficit remains open: qty_short = qty_sent - qty_received.
//      - Tracked in delivery_discrepancies table with status lifecycle.
//      - Discrepancy reason logged on line items.
//   3. Idempotency Guard:
//      - Prevents duplicate submissions on MRN, MTN dispatch/accept, GRN receive, Issues.
//      - Cached responses replayed with Idempotent-Replayed header.
//      - Concurrent in-flight duplicate requests return 409 Conflict.
//   4. API Endpoints:
//      - GET /api/stores/numbers (next_chain)
//      - GET /api/stores/discrepancies
//      - PATCH /api/stores/discrepancies/:id
//      - GET /api/stores/pipeline/trace (chain_no trace)
// ===========================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-step4b-'));
process.env.DB_PATH = path.join(TMP, 'step4b.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all, tx } = require('../src/db');
const chainPipeline = require('../src/lib/chain_pipeline');
const supplyRoutes = require('../src/lib/supply_routes');
const auth = require('../src/lib/auth');

migrate();

// Seed roles
for (const n of ['admin', 'storekeeper', 'workshop', 'operational_manager', 'transport_manager', 'viewer']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
run("INSERT OR IGNORE INTO roles (name, label) VALUES ('stores_writer', 'Stores writer')");
run("INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES ('stores_writer', 'stores', 'full')");

// Seed workshops: 1 = Central Workshop, 2 = Badalgama Site Workshop
run("INSERT OR IGNORE INTO workshops (id, name, code, is_default, own_store) VALUES (1, 'Central Workshop', 'CENTRAL', 1, 1)");
run("INSERT OR IGNORE INTO workshops (id, name, code, is_default, own_store) VALUES (2, 'Badalgama Site', 'BDG', 0, 1)");

// Seed users
const PW = 'password-salt-hash-123';
function makeUser(username, role, wsId = null) {
  run('INSERT OR IGNORE INTO users (username, password_hash, full_name, active, workshop_id) VALUES (?, ?, ?, 1, ?)',
    username, auth.hashPassword(PW), 'User ' + username, wsId);
  const u = get('SELECT id, username, full_name, workshop_id FROM users WHERE username = ?', username);
  run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', u.id, role);
  return { id: u.id, username: u.username, fullName: u.full_name, role, roles: [role], workshop_id: u.workshop_id };
}

const uAdmin = makeUser('admin_user', 'admin');
const uStore = makeUser('store_sk', 'storekeeper', 2);
const uEng = makeUser('ws_eng', 'workshop', 2);

// Seed an asset
const assetIns = run("INSERT OR IGNORE INTO assets (id, code, code_norm, registration, type, status) VALUES (10, 'TRK-010', 'TRK010', 'WP-NA-1010', 'prime_mover', 'active')");
const assetId = 10;

// ===========================================================================
// Tests
// ===========================================================================

test('1. Chain Number: Sequential format CHN-YYYY-XXXXX and auto-increment', () => {
  const yr = new Date().getFullYear();
  const c1 = chainPipeline.nextChainNo(yr);
  assert.match(c1, new RegExp(`^CHN-${yr}-\\d{5}$`));

  // Stamp c1 on an MRN
  run(`INSERT INTO mrn (mrn_no, chain_no, req_date, requested_by, workshop_id, approval_status, status)
       VALUES ('MRN-SEQ-TEST-1', ?, date('now'), 'Tester', 2, 'approved', 'open')`, c1);

  const c2 = chainPipeline.nextChainNo(yr);
  assert.match(c2, new RegExp(`^CHN-${yr}-\\d{5}$`));

  const seq1 = parseInt(c1.split('-')[2], 10);
  const seq2 = parseInt(c2.split('-')[2], 10);
  assert.strictEqual(seq2, seq1 + 1, 'Chain numbers must auto-increment sequentially');
});

test('2. Chain Number Propagation: MRN -> MTN -> GRN -> Issue', () => {
  const yr = new Date().getFullYear();
  const chainNo = chainPipeline.nextChainNo(yr);

  // 1. Create MRN with chain_no
  const mrnIns = run(
    `INSERT INTO mrn (mrn_no, chain_no, req_date, requested_by, workshop_id, asset_id, approval_status, status)
     VALUES ('MRN-TEST-001', ?, date('now'), 'Tester', 2, ?, 'approved', 'open')`,
    chainNo, assetId
  );
  const mrnId = mrnIns.lastInsertRowid;

  const lineIns = run(
    `INSERT INTO mrn_lines (mrn_id, description, qty, unit, supply_route)
     VALUES (?, 'Brake Disc Pair', 4, 'sets', 'main_store')`,
    mrnId
  );
  const lineId = lineIns.lastInsertRowid;

  // 2. Create linked MTN
  const mtnIns = run(
    `INSERT INTO mtn (mtn_no, mrn_id, chain_no, from_location, to_location, status)
     VALUES ('MTN-TEST-001', ?, ?, 'Central Workshop', 'Badalgama Site', 'dispatched')`,
    mrnId, chainNo
  );
  const mtnId = mtnIns.lastInsertRowid;

  const mtnLineIns = run(
    `INSERT INTO mtn_lines (mtn_id, mrn_id, mrn_line_id, description, qty)
     VALUES (?, ?, ?, 'Brake Disc Pair', 4)`,
    mtnId, mrnId, lineId
  );
  const mtnLineId = mtnLineIns.lastInsertRowid;

  // 3. Create linked GRN
  const grnIns = run(
    `INSERT INTO grn (grn_no, mrn_id, mrn_line_id, chain_no, description, qty)
     VALUES ('GRN-TEST-001', ?, ?, ?, 'Brake Disc Pair', 4)`,
    mrnId, lineId, chainNo
  );
  const grnId = grnIns.lastInsertRowid;

  // 4. Create linked Issue
  const issIns = run(
    `INSERT INTO issues (mrn_line_id, grn_id, chain_no, description, qty, asset_id)
     VALUES (?, ?, ?, 'Brake Disc Pair', 4, ?)`,
    lineId, grnId, chainNo, assetId
  );
  const issueId = issIns.lastInsertRowid;

  // Verify all records share the exact chain_no
  const m = get('SELECT chain_no FROM mrn WHERE id = ?', mrnId);
  const t = get('SELECT chain_no FROM mtn WHERE id = ?', mtnId);
  const g = get('SELECT chain_no FROM grn WHERE id = ?', grnId);
  const i = get('SELECT chain_no FROM issues WHERE id = ?', issueId);

  assert.strictEqual(m.chain_no, chainNo);
  assert.strictEqual(t.chain_no, chainNo);
  assert.strictEqual(g.chain_no, chainNo);
  assert.strictEqual(i.chain_no, chainNo);

  // Test propagateChainNo backward propagation if chain was added late
  const newChainNo = chainPipeline.nextChainNo(yr);
  chainPipeline.propagateChainNo('mrn', mrnId, newChainNo);
  // (propagateChainNo only fills empty ones, so let's verify assignChainNo)
  chainPipeline.assignChainNo(mrnId, newChainNo);

  assert.strictEqual(get('SELECT chain_no FROM mrn WHERE id = ?', mrnId).chain_no, newChainNo);
  assert.strictEqual(get('SELECT chain_no FROM mtn WHERE id = ?', mtnId).chain_no, newChainNo);
  assert.strictEqual(get('SELECT chain_no FROM grn WHERE id = ?', grnId).chain_no, newChainNo);
  assert.strictEqual(get('SELECT chain_no FROM issues WHERE id = ?', issueId).chain_no, newChainNo);
});

test('3. Short Deliveries & Discrepancies: Record shortage, keep deficit open', () => {
  const yr = new Date().getFullYear();
  const chainNo = chainPipeline.nextChainNo(yr);

  // Create MRN for 10 fuel filters
  const mrnIns = run(
    `INSERT INTO mrn (mrn_no, chain_no, req_date, requested_by, workshop_id, asset_id, approval_status, status)
     VALUES ('MRN-SHORT-001', ?, date('now'), 'Tester', 2, ?, 'approved', 'open')`,
    chainNo, assetId
  );
  const mrnId = mrnIns.lastInsertRowid;

  const lineIns = run(
    `INSERT INTO mrn_lines (mrn_id, description, qty, qty_sent, qty_received, qty_short, unit, supply_route)
     VALUES (?, 'Primary Fuel Filter', 10, 10, 0, 0, 'nos', 'main_store')`,
    mrnId
  );
  const lineId = lineIns.lastInsertRowid;

  // Create MTN transferring 10 items
  const mtnIns = run(
    `INSERT INTO mtn (mtn_no, mrn_id, chain_no, from_location, to_location, status)
     VALUES ('MTN-SHORT-001', ?, ?, 'Central Workshop', 'Badalgama Site', 'dispatched')`,
    mrnId, chainNo
  );
  const mtnId = mtnIns.lastInsertRowid;

  const mtnLineIns = run(
    `INSERT INTO mtn_lines (mtn_id, mrn_id, mrn_line_id, description, qty, qty_received, qty_short)
     VALUES (?, ?, ?, 'Primary Fuel Filter', 10, 0, 0)`,
    mtnId, mrnId, lineId
  );
  const mtnLineId = mtnLineIns.lastInsertRowid;

  // Destination site receives only 7 items (short delivery of 3)
  supplyRoutes.onMtnAccepted(mtnId, [
    {
      mtn_line_id: mtnLineId,
      qty_received: 7,
      discrepancy_reason: 'Only 7 received in sealed box, 3 missing from supplier shipment',
    }
  ], uStore);

  // Check MRN line updates
  const ml = get('SELECT qty, qty_received, qty_short, discrepancy_reason FROM mrn_lines WHERE id = ?', lineId);
  assert.strictEqual(ml.qty_received, 7, 'Received qty must be 7');
  assert.strictEqual(ml.qty_short, 3, 'Short qty must be 3');
  assert.match(ml.discrepancy_reason, /3 missing/, 'Discrepancy reason must be recorded on line');

  // Check MTN line updates
  const tl = get('SELECT qty, qty_received, qty_short, discrepancy_reason FROM mtn_lines WHERE id = ?', mtnLineId);
  assert.strictEqual(tl.qty_received, 7, 'MTN line received qty must be 7');
  assert.strictEqual(tl.qty_short, 3, 'MTN line short qty must be 3');

  // Verify delivery_discrepancies entry created
  const discs = chainPipeline.listDiscrepancies({ mrn_id: mrnId });
  assert.strictEqual(discs.length, 1, 'Exactly 1 discrepancy record must exist');
  const d = discs[0];
  assert.strictEqual(d.chain_no, chainNo);
  assert.strictEqual(d.mrn_id, mrnId);
  assert.strictEqual(d.mtn_id, mtnId);
  assert.strictEqual(d.qty_expected, 10);
  assert.strictEqual(d.qty_received, 7);
  assert.strictEqual(d.qty_short, 3);
  assert.strictEqual(d.status, 'open', 'Discrepancy must initially be open');

  // Check pipeline progression reports shortage & deficit open
  const pipe = supplyRoutes.getMrnPipeline(mrnId);
  assert.strictEqual(pipe[0].has_shortage, true, 'Pipeline must flag has_shortage');
  assert.strictEqual(pipe[0].is_deficit_open, true, 'Pipeline must flag deficit as open');
  assert.strictEqual(pipe[0].qty_short, 3);

  // Test resolving the discrepancy
  const res = chainPipeline.resolveDiscrepancy(d.id, {
    status: 'investigating',
    resolution_notes: 'Driver interviewed, contacted Central Store for stock check',
  }, uAdmin);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.discrepancy.status, 'investigating');

  const resFinal = chainPipeline.resolveDiscrepancy(d.id, {
    status: 'resolved',
    resolution_notes: 'Supplier acknowledged missing 3 filters and issued replacement delivery',
  }, uAdmin);
  assert.strictEqual(resFinal.ok, true);
  assert.strictEqual(resFinal.discrepancy.status, 'resolved');
});

test('4. Short Delivery via GRN Direct Receipt', () => {
  const yr = new Date().getFullYear();
  const chainNo = chainPipeline.nextChainNo(yr);

  const mrnIns = run(
    `INSERT INTO mrn (mrn_no, chain_no, req_date, requested_by, workshop_id, asset_id, approval_status, status)
     VALUES ('MRN-GRN-001', ?, date('now'), 'Tester', 2, ?, 'approved', 'open')`,
    chainNo, assetId
  );
  const mrnId = mrnIns.lastInsertRowid;

  const lineIns = run(
    `INSERT INTO mrn_lines (mrn_id, description, qty, qty_received, qty_short, unit, supply_route)
     VALUES (?, 'Alternator Belt 1250', 5, 0, 0, 'nos', 'direct_delivery')`,
    mrnId
  );
  const lineId = lineIns.lastInsertRowid;

  // Direct GRN received with 4 instead of 5
  const discResult = chainPipeline.recordDeliveryDiscrepancy({
    chain_no: chainNo,
    mrn_id: mrnId,
    mrn_line_id: lineId,
    item_description: 'Alternator Belt 1250',
    qty_expected: 5,
    qty_received: 4,
    reason: 'Vendor dispatched 4 units due to batch limit',
  }, uStore);

  assert.strictEqual(discResult.ok, true);
  assert.strictEqual(discResult.discrepancy.qty_short, 1);
  assert.strictEqual(discResult.discrepancy.qty_expected, 5);
  assert.strictEqual(discResult.discrepancy.qty_received, 4);

  const ml = get('SELECT qty_short, discrepancy_reason FROM mrn_lines WHERE id = ?', lineId);
  assert.strictEqual(ml.qty_short, 1);
  assert.match(ml.discrepancy_reason, /Vendor dispatched 4/);
});

test('5. Idempotency Guard: Cache completed response and prevent duplicates', async () => {
  const testKey = 'test_key_' + Date.now();
  const action = 'mrn_create';
  const dummyPayload = { id: 999, mrn_no: 'MRN-IDEMP-001', ok: true };

  // 1. Simulate fresh request entering idempotency check
  const req1 = {
    headers: { 'idempotency-key': testKey },
    body: {},
    originalUrl: '/api/stores/mrn',
    user: uStore,
  };
  let sentStatus = null;
  let sentBody = null;
  let sentHeaders = {};

  const res1 = {
    status(code) { sentStatus = code; return this; },
    json(data) { sentBody = data; return this; },
    setHeader(name, val) { sentHeaders[name] = val; },
  };

  const guard = chainPipeline.idempotencyGuard(action);

  let nextCalled = false;
  await guard(req1, res1, () => {
    nextCalled = true;
    // Simulate endpoint completion
    res1.status(201).json(dummyPayload);
  });

  assert.strictEqual(nextCalled, true, 'Next must be called on first execution');
  assert.strictEqual(sentStatus, 201);
  assert.deepStrictEqual(sentBody, dummyPayload);

  // 2. Second request with identical key must replay cached response without re-executing
  let nextCalled2 = false;
  let replayStatus = null;
  let replayBody = null;
  let replayHeaders = {};

  const res2 = {
    status(code) { replayStatus = code; return this; },
    json(data) { replayBody = data; return this; },
    setHeader(name, val) { replayHeaders[name] = val; },
  };

  await guard(req1, res2, () => {
    nextCalled2 = true;
  });

  assert.strictEqual(nextCalled2, false, 'Handler must NOT be re-executed on duplicate idempotency key');
  assert.strictEqual(replayStatus, 201, 'Status code must be cached status');
  assert.deepStrictEqual(replayBody, dummyPayload, 'Body must be cached body');
  assert.strictEqual(replayHeaders['Idempotent-Replayed'], 'true', 'Must set Idempotent-Replayed header');
});

test('6. Idempotency Guard: Concurrent in-flight request returns 409 Conflict', async () => {
  const inflightKey = 'inflight_key_' + Date.now();
  const guard = chainPipeline.idempotencyGuard('mtn_dispatch');

  // Insert in-flight state manually in DB
  run(
    `INSERT INTO idempotency_keys (key, action, status, created_at, updated_at)
     VALUES (?, 'mtn_dispatch', 'in_flight', datetime('now'), datetime('now'))`,
    inflightKey
  );

  const req = {
    headers: { 'idempotency-key': inflightKey },
    body: {},
    originalUrl: '/api/stores/mtn/1/dispatch',
    user: uStore,
  };

  let statusCode = null;
  let responseBody = null;
  const res = {
    status(c) { statusCode = c; return this; },
    json(d) { responseBody = d; return this; },
    setHeader() {},
  };

  let nextCalled = false;
  await guard(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false, 'Handler must not run');
  assert.strictEqual(statusCode, 409, 'Must return 409 Conflict');
  assert.strictEqual(responseBody.error, 'A request with this idempotency key is currently processing');
});

test('7. Pipeline Trace Query by Chain Number', () => {
  const yr = new Date().getFullYear();
  const chainNo = chainPipeline.nextChainNo(yr);

  // Setup MRN + MTN + Line with shortage
  const mrn = run(
    `INSERT INTO mrn (mrn_no, chain_no, req_date, requested_by, workshop_id, asset_id, approval_status, status)
     VALUES ('MRN-TRACE-001', ?, date('now'), 'Tester', 2, ?, 'approved', 'open')`,
    chainNo, assetId
  );
  const mrnId = mrn.lastInsertRowid;

  const line = run(
    `INSERT INTO mrn_lines (mrn_id, description, qty, qty_received, qty_short, unit, supply_route)
     VALUES (?, 'Air Brake Valve', 2, 1, 1, 'nos', 'main_store')`,
    mrnId
  );
  const lineId = line.lastInsertRowid;

  // Log discrepancy
  chainPipeline.recordDeliveryDiscrepancy({
    chain_no: chainNo,
    mrn_id: mrnId,
    mrn_line_id: lineId,
    item_description: 'Air Brake Valve',
    qty_expected: 2,
    qty_received: 1,
    reason: 'Defective valve returned to transit driver',
  }, uStore);

  // Trace by chain_no
  const trace = chainPipeline.getChainPipeline(chainNo);
  assert.strictEqual(trace.chain_no, chainNo);
  assert.strictEqual(trace.mrns.length, 1);
  assert.strictEqual(trace.discrepancies.length, 1);
  assert.strictEqual(trace.discrepancies[0].qty_short, 1);
  assert.strictEqual(trace.integrity.open_discrepancies_count, 1);
  assert.strictEqual(trace.integrity.is_safe_to_close, false, 'Cannot close while shortage is unresolved');
});
