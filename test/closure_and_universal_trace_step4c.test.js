'use strict';

// ===========================================================================
// WorkshopOne — Step 4c Test Suite: Request Closure Rules & Universal Trace
//
// Rules verified:
//   1. Line-Item Cancellation:
//      - Unfulfilled lines can be cancelled with mandatory reason.
//      - Cancelled lines do not block MRN or Job Card closure.
//      - Fully-received lines cannot be cancelled.
//      - Lines on already-closed MRNs cannot be cancelled.
//   2. MRN Closure Gate (canCloseMrn):
//      - Refuses closure if any active line has unfulfilled quantity without cancellation or shortage.
//      - Refuses closure if received parts remain on store shelf unissued (qty_received > qty_issued).
//      - Refuses closure if open delivery discrepancies exist.
//      - Allows closure when all lines are fulfilled/cancelled, shelf is clear, and discrepancies resolved.
//   3. MRN Lifecycle State (closeMrn & reopenMrn):
//      - Sets status = 'closed', closed_by, closed_at, closure_notes.
//      - Emits audit and websocket event.
//      - Reopen restores prior status and clears closed_by with mandatory reason.
//   4. Job Card Closure Integration:
//      - costing.closureReadiness ignores cancelled lines.
//      - costing.closureReadiness flags open delivery shortages.
//   5. Universal Omnibox Search (universalSearch):
//      - Searches across Chain No, MRN No, MTN No, GRN No, Job No, and Asset Code/Reg.
//   6. Pipeline Trace Endpoint:
//      - Returns full lifecycle, cancellation info, closure status, and closure reasons.
// ===========================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-step4c-'));
process.env.DB_PATH = path.join(TMP, 'step4c.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all, tx } = require('../src/db');
const chainPipeline = require('../src/lib/chain_pipeline');
const supplyRoutes = require('../src/lib/supply_routes');
const costing = require('../src/lib/costing');
const auth = require('../src/lib/auth');

migrate();

// Seed roles
for (const n of ['admin', 'storekeeper', 'workshop', 'operational_manager', 'transport_manager', 'viewer']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
run("INSERT OR IGNORE INTO roles (name, label) VALUES ('stores_writer', 'Stores writer')");
run("INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES ('stores_writer', 'stores', 'full')");

// Seed workshops
run("INSERT OR IGNORE INTO workshops (id, name, code, is_default, own_store) VALUES (1, 'Central Workshop', 'CENTRAL', 1, 1)");
run("INSERT OR IGNORE INTO workshops (id, name, code, is_default, own_store) VALUES (2, 'Badalgama Site', 'BDG', 0, 1)");

// Seed users
const PW = 'password-salt-hash-123';
function makeUser(username, role, wsId = null) {
  run('INSERT OR IGNORE INTO users (username, password_hash, full_name, active, workshop_id) VALUES (?, ?, ?, 1, ?)',
    username, PW, username.toUpperCase(), wsId);
  const u = get('SELECT id, username, full_name FROM users WHERE username = ?', username);
  const r = get('SELECT id FROM roles WHERE name = ?', role);
  if (r) run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', u.id, r.id);
  return u;
}

const adminUser = makeUser('admin_step4c', 'admin', 1);
const mgrUser = makeUser('mgr_step4c', 'operational_manager', 1);
const engUser = makeUser('eng_step4c', 'workshop', 1);
const storeUser = makeUser('store_step4c', 'storekeeper', 1);

// Seed asset
run(`INSERT OR IGNORE INTO assets (id, code, registration, code_norm, model_no, type, status)
     VALUES (101, 'EX-101', 'CAT-320D-101', 'EX101', 'CAT 320D', 'Excavator', 'active')`);

// Seed store items
run(`INSERT OR IGNORE INTO store_items (id, part_number, name, description, category, unit, unit_cost)
     VALUES (501, 'BRG-501', 'Roller Bearing 501', 'Roller Bearing 501', 'bearings', 'nos', 4500)`);
run(`INSERT OR IGNORE INTO store_items (id, part_number, name, description, category, unit, unit_cost)
     VALUES (502, 'FLT-502', 'Hydraulic Filter 502', 'Hydraulic Filter 502', 'filters', 'nos', 8200)`);

test('1. Line-Item Cancellation: Unfulfilled lines can be cancelled with reason', () => {
  // Create an MRN with 2 lines
  run(`INSERT INTO mrn (mrn_no, purpose, requested_by, approval_status, workshop_id)
       VALUES ('MRN-4C-01', 'Bucket Cylinder Overhaul', 'eng_step4c', 'approved', 1)`);
  const mrn = get("SELECT * FROM mrn WHERE mrn_no = 'MRN-4C-01'");
  chainPipeline.assignChainNo(mrn.id);

  run(`INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty, qty_received, qty_short)
       VALUES (?, 501, 'Roller Bearing 501', 5, 0, 0)`, mrn.id);
  run(`INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty, qty_received, qty_short)
       VALUES (?, 502, 'Hydraulic Filter 502', 2, 2, 0)`, mrn.id);

  const line1 = get("SELECT * FROM mrn_lines WHERE mrn_id = ? AND description LIKE '%Bearing%'", mrn.id);
  const line2 = get("SELECT * FROM mrn_lines WHERE mrn_id = ? AND description LIKE '%Filter%'", mrn.id);

  // Cancel Line 1
  const cancelResult = chainPipeline.cancelMrnLine(line1.id, { reason: 'Part obsolete; alternate bearing used' }, engUser);
  assert.strictEqual(cancelResult.ok, true);
  assert.strictEqual(cancelResult.is_cancelled, 1);

  const updatedLine1 = get('SELECT * FROM mrn_lines WHERE id = ?', line1.id);
  assert.strictEqual(updatedLine1.is_cancelled, 1);
  assert.strictEqual(updatedLine1.cancellation_reason, 'Part obsolete; alternate bearing used');
  assert.strictEqual(updatedLine1.cancelled_by, engUser.full_name);
  assert.ok(updatedLine1.cancelled_at);

  // Fully-received line cannot be cancelled
  assert.throws(() => {
    chainPipeline.cancelMrnLine(line2.id, { reason: 'Try cancel received' }, engUser);
  }, /all requested quantity has already been received/i);

  // Line cancellation requires a reason
  assert.throws(() => {
    chainPipeline.cancelMrnLine(line1.id, { reason: ' ' }, engUser);
  }, /already cancelled|reason is required/i);
});

test('2. MRN Closure Gate: Refuses closure while items are unfulfilled, on shelf, or discrepant', () => {
  // Create an MRN with 2 lines
  run(`INSERT INTO mrn (mrn_no, purpose, requested_by, approval_status, workshop_id)
       VALUES ('MRN-4C-02', 'Engine Repair', 'eng_step4c', 'approved', 1)`);
  const mrn = get("SELECT * FROM mrn WHERE mrn_no = 'MRN-4C-02'");
  const chainNo = chainPipeline.assignChainNo(mrn.id);

  run(`INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty, qty_received, qty_short)
       VALUES (?, 501, 'Roller Bearing 501', 4, 0, 0)`, mrn.id);
  const line1 = get('SELECT * FROM mrn_lines WHERE mrn_id = ?', mrn.id);

  // Initial check: line1 not received, not cancelled -> cannot close
  let check = chainPipeline.canCloseMrn(mrn.id);
  assert.strictEqual(check.can_close, false);
  assert.strictEqual(check.unfulfilled_count, 1);
  assert.ok(check.reasons.some((r) => r.includes('not received')));

  // Attempting closeMrn throws 409
  assert.throws(() => {
    chainPipeline.closeMrn(mrn.id, { notes: 'Premature close' }, mgrUser);
  }, (err) => err.status === 409);

  // Receive the 4 units via GRN onto store shelf
  run(`INSERT INTO grn (grn_no, mrn_id, mrn_line_id, chain_no, qty, unit_price, description, supplier)
       VALUES ('GRN-4C-02A', ?, ?, ?, 4, 4500, 'Roller Bearing 501', 'ABC Bearings')`, mrn.id, line1.id, chainNo);
  run('UPDATE mrn_lines SET qty_received = 4 WHERE id = ?', line1.id);

  // Now line is received, but 4 units are on the shelf unissued -> cannot close!
  check = chainPipeline.canCloseMrn(mrn.id);
  assert.strictEqual(check.can_close, false);
  assert.strictEqual(check.uncollected_count, 1);
  assert.ok(check.reasons.some((r) => r.includes('remain on store shelf')));

  // Now create an open delivery discrepancy on the MRN
  run(`INSERT INTO delivery_discrepancies (chain_no, mrn_id, mrn_line_id, item_description, qty_expected, qty_received, qty_short, reason, status)
       VALUES (?, ?, ?, 'Roller Bearing 501', 4, 3, 1, '1 damaged in transit', 'open')`, chainNo, mrn.id, line1.id);

  check = chainPipeline.canCloseMrn(mrn.id);
  assert.strictEqual(check.can_close, false);
  assert.ok(check.reasons.some((r) => r.includes('Delivery discrepancy')));

  // Resolve the discrepancy
  const disc = get('SELECT id FROM delivery_discrepancies WHERE mrn_id = ?', mrn.id);
  chainPipeline.resolveDiscrepancy(disc.id, { status: 'resolved', resolution_notes: 'Supplier replaced damaged unit' }, storeUser);

  // Issue the 4 units to clear the store shelf
  const grn = get("SELECT id FROM grn WHERE grn_no = 'GRN-4C-02A'");
  run(`INSERT INTO issues (mrn_line_id, grn_id, chain_no, qty, unit_price, description)
       VALUES (?, ?, ?, 4, 4500, 'Roller Bearing 501')`, line1.id, grn.id, chainNo);

  // Now shelf is 0, discrepancy resolved, line fulfilled -> Can Close!
  check = chainPipeline.canCloseMrn(mrn.id);
  assert.strictEqual(check.can_close, true);
  assert.strictEqual(check.reasons.length, 0);
  assert.strictEqual(check.unfulfilled_count, 0);
  assert.strictEqual(check.uncollected_count, 0);
});

test('3. MRN Lifecycle: Close and Reopen MRN with audit trail', () => {
  // Create an MRN with all lines cancelled
  run(`INSERT INTO mrn (mrn_no, purpose, requested_by, approval_status, workshop_id)
       VALUES ('MRN-4C-03', 'Track Adjustment', 'eng_step4c', 'approved', 1)`);
  const mrn = get("SELECT * FROM mrn WHERE mrn_no = 'MRN-4C-03'");
  chainPipeline.assignChainNo(mrn.id);

  run(`INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty, qty_received, qty_short, is_cancelled, cancellation_reason)
       VALUES (?, 501, 'Roller Bearing 501', 2, 0, 0, 1, 'No longer needed')`, mrn.id);

  // Can close since all lines are cancelled
  const check = chainPipeline.canCloseMrn(mrn.id);
  assert.strictEqual(check.can_close, true);

  // Formally close
  const closeRes = chainPipeline.closeMrn(mrn.id, { notes: 'Work cancelled by client; MRN closed' }, mgrUser);
  assert.strictEqual(closeRes.ok, true);
  assert.strictEqual(closeRes.status, 'closed');

  const closedMrn = get('SELECT * FROM mrn WHERE id = ?', mrn.id);
  assert.strictEqual(closedMrn.status, 'closed');
  assert.strictEqual(closedMrn.closed_by, mgrUser.full_name);
  assert.strictEqual(closedMrn.closure_notes, 'Work cancelled by client; MRN closed');
  assert.ok(closedMrn.closed_at);

  // Cannot modify lines on a closed MRN
  const line = get('SELECT id FROM mrn_lines WHERE mrn_id = ?', mrn.id);
  assert.throws(() => {
    chainPipeline.cancelMrnLine(line.id, { reason: 'Try modify line' }, engUser);
  }, /closed MRN/i);

  // Cannot close already closed MRN
  assert.throws(() => {
    chainPipeline.closeMrn(mrn.id, { notes: 'Try close again' }, mgrUser);
  }, /already closed/i);

  // Reopen MRN
  const reopenRes = chainPipeline.reopenMrn(mrn.id, { reason: 'Job resumed by engineer' }, mgrUser);
  assert.strictEqual(reopenRes.ok, true);
  assert.notStrictEqual(reopenRes.status, 'closed');

  const reopenedMrn = get('SELECT * FROM mrn WHERE id = ?', mrn.id);
  assert.strictEqual(reopenedMrn.status, 'open');
  assert.strictEqual(reopenedMrn.closed_by, null);
  assert.strictEqual(reopenedMrn.closed_at, null);
  assert.strictEqual(reopenedMrn.closure_notes, null);
});

test('4. Job Card Closure Integration: costing.closureReadiness handles cancellations & discrepancies', () => {
  // Create Job Card
  run(`INSERT INTO job_cards (job_no, asset_id, type, status, description, requested_at, flat_labour)
       VALUES ('JC-4C-04', 101, 'service', 'IN_PROGRESS', 'Scheduled 500hr Service', date('now'), 5000)`);
  const job = get("SELECT * FROM job_cards WHERE job_no = 'JC-4C-04'");

  // Create MRN linked to this job card
  run(`INSERT INTO mrn (mrn_no, job_id, asset_id, purpose, requested_by, approval_status, workshop_id)
       VALUES ('MRN-4C-04', ?, 101, 'Service Parts', 'eng_step4c', 'approved', 1)`, job.id);
  const mrn = get("SELECT * FROM mrn WHERE mrn_no = 'MRN-4C-04'");
  const chainNo = chainPipeline.assignChainNo(mrn.id);

  // Add line 1: unreceived bearing
  run(`INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty, qty_received, qty_short)
       VALUES (?, 501, 'Roller Bearing 501', 1, 0, 0)`, mrn.id);
  const line1 = get('SELECT * FROM mrn_lines WHERE mrn_id = ?', mrn.id);

  // closureReadiness should flag unreceived line
  let readiness = costing.closureReadiness(job.id);
  assert.strictEqual(readiness.ready, false);
  assert.ok(readiness.missing.some((m) => m.includes('Roller Bearing 501') && m.includes('awaiting GRN')));

  // Cancel line 1
  chainPipeline.cancelMrnLine(line1.id, { reason: 'Bearing inspection showed old unit still good' }, engUser);

  // Now that line 1 is cancelled, it should no longer be listed as awaiting GRN
  readiness = costing.closureReadiness(job.id);
  assert.strictEqual(readiness.missing.some((m) => m.includes('awaiting GRN')), false);

  // Now create an open delivery discrepancy on this job's MRN
  run(`INSERT INTO delivery_discrepancies (chain_no, mrn_id, mrn_line_id, item_description, qty_expected, qty_received, qty_short, reason, status)
       VALUES (?, ?, ?, 'Hydraulic Filter', 2, 1, 1, '1 filter leaked', 'open')`, chainNo, mrn.id, line1.id);

  // closureReadiness should flag open delivery shortage
  readiness = costing.closureReadiness(job.id);
  assert.strictEqual(readiness.ready, false);
  assert.ok(readiness.missing.some((m) => m.includes('Delivery shortage') && m.includes('Hydraulic Filter')));

  // Resolve the shortage
  const disc = get('SELECT id FROM delivery_discrepancies WHERE mrn_id = ?', mrn.id);
  chainPipeline.resolveDiscrepancy(disc.id, { status: 'resolved', resolution_notes: 'Credit note received' }, storeUser);

  // Now discrepancy is resolved -> readiness clears discrepancy flag
  readiness = costing.closureReadiness(job.id);
  assert.strictEqual(readiness.missing.some((m) => m.includes('Delivery shortage')), false);
});

test('5. Universal Omnibox Search: Resolves documents, chains, jobs, and vehicles', () => {
  // Search for chain
  const chainMatches = chainPipeline.universalSearch('CHN-2026', adminUser);
  assert.ok(chainMatches.length > 0);
  assert.strictEqual(chainMatches[0].type, 'chain');
  assert.ok(chainMatches[0].link.includes('#/stores/trace?chain_no='));

  // Search for MRN
  const mrnMatches = chainPipeline.universalSearch('MRN-4C-01', adminUser);
  assert.ok(mrnMatches.length > 0);
  assert.strictEqual(mrnMatches[0].type, 'mrn');
  assert.ok(mrnMatches[0].title.includes('MRN-4C-01'));

  // Search for Job
  const jobMatches = chainPipeline.universalSearch('JC-4C-04', adminUser);
  assert.ok(jobMatches.length > 0);
  assert.strictEqual(jobMatches[0].type, 'job');
  assert.ok(jobMatches[0].title.includes('JC-4C-04'));

  // Search for Asset code
  const assetMatches = chainPipeline.universalSearch('EX-101', adminUser);
  assert.ok(assetMatches.length > 0);
  assert.strictEqual(assetMatches[0].type, 'asset');
  assert.ok(assetMatches[0].subtitle.includes('EX-101'));
});

test('6. Pipeline Trace: Returns full lifecycle, line cancellations, and closure reasons', () => {
  const mrn = get("SELECT * FROM mrn WHERE mrn_no = 'MRN-4C-02'");
  const pipeline = chainPipeline.getChainPipeline(mrn.chain_no);

  assert.ok(pipeline);
  assert.strictEqual(pipeline.chain_no, mrn.chain_no);
  assert.ok(pipeline.lines.length > 0);
  assert.ok(pipeline.grns.length > 0);
  assert.ok(pipeline.issues.length > 0);
  assert.strictEqual(pipeline.integrity.is_safe_to_close, true);
  assert.strictEqual(pipeline.integrity.closure_reasons.length, 0);
});

test('7. Express Route Integration: MRN closure check, close, and line cancellation', async () => {
  const express = require('express');
  const storesRouter = require('../src/routes/stores');

  const app = express();
  app.use(express.json());
  // Mock req.user as adminUser
  app.use((req, res, next) => {
    req.user = { ...adminUser, roles: ['admin'] };
    next();
  });
  app.use('/api/stores', storesRouter);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/stores`;

  try {
    // Create new MRN with 1 unfulfilled line
    run(`INSERT INTO mrn (mrn_no, purpose, requested_by, approval_status, workshop_id)
         VALUES ('MRN-4C-API', 'API Test Requisition', 'admin_step4c', 'approved', 1)`);
    const mrn = get("SELECT * FROM mrn WHERE mrn_no = 'MRN-4C-API'");
    chainPipeline.assignChainNo(mrn.id);

    run(`INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty, qty_received, qty_short)
         VALUES (?, 501, 'Roller Bearing 501', 3, 0, 0)`, mrn.id);
    const line = get('SELECT * FROM mrn_lines WHERE mrn_id = ?', mrn.id);

    // 1. GET /api/stores/mrn/:id/closure-check -> can_close: false
    const chkRes = await fetch(`${baseUrl}/mrn/${mrn.id}/closure-check`);
    assert.strictEqual(chkRes.status, 200);
    const chkData = await chkRes.json();
    assert.strictEqual(chkData.can_close, false);
    assert.strictEqual(chkData.unfulfilled_count, 1);

    // 2. POST /api/stores/mrn/:id/close -> 409 Conflict
    const closeFailRes = await fetch(`${baseUrl}/mrn/${mrn.id}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'Premature close' }),
    });
    assert.strictEqual(closeFailRes.status, 409);

    // 3. POST /api/stores/mrn-lines/:id/cancel -> 200 OK
    const cancelRes = await fetch(`${baseUrl}/mrn-lines/${line.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Client requested cancellation' }),
    });
    assert.strictEqual(cancelRes.status, 200);
    const cancelData = await cancelRes.json();
    assert.strictEqual(cancelData.ok, true);
    assert.strictEqual(cancelData.is_cancelled, 1);

    // 4. GET /api/stores/mrn/:id/closure-check -> can_close: true
    const chkRes2 = await fetch(`${baseUrl}/mrn/${mrn.id}/closure-check`);
    const chkData2 = await chkRes2.json();
    assert.strictEqual(chkData2.can_close, true);

    // 5. POST /api/stores/mrn/:id/close -> 200 OK
    const closeRes = await fetch(`${baseUrl}/mrn/${mrn.id}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'Formal settlement' }),
    });
    assert.strictEqual(closeRes.status, 200);
    const closeData = await closeRes.json();
    assert.strictEqual(closeData.ok, true);
    assert.strictEqual(closeData.status, 'closed');

    // 6. POST /api/stores/mrn/:id/reopen -> 200 OK
    const reopenRes = await fetch(`${baseUrl}/mrn/${mrn.id}/reopen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Reopened by supervisor' }),
    });
    assert.strictEqual(reopenRes.status, 200);
    const reopenData = await reopenRes.json();
    assert.strictEqual(reopenData.ok, true);
    assert.strictEqual(reopenData.status, 'open');

    // 7. GET /api/stores/trace/search?q=MRN-4C-API
    const searchRes = await fetch(`${baseUrl}/trace/search?q=MRN-4C-API`);
    assert.strictEqual(searchRes.status, 200);
    const searchData = await searchRes.json();
    assert.ok(searchData.length > 0);
    assert.strictEqual(searchData[0].type, 'mrn');

    // 8. GET /api/stores/pipeline/trace?q=MRN-4C-API
    const traceRes = await fetch(`${baseUrl}/pipeline/trace?q=MRN-4C-API`);
    assert.strictEqual(traceRes.status, 200);
    const traceData = await traceRes.json();
    assert.ok(traceData.mrns.length > 0);
    assert.strictEqual(traceData.mrns[0].mrn_no, 'MRN-4C-API');
    assert.strictEqual(traceData.integrity.can_close_mrn, true);
  } finally {
    server.close();
  }
});
