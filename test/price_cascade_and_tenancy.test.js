'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-cascade-tenancy-'));
const TEST_DB = path.join(TMP, 'test.db');
process.env.DB_PATH = TEST_DB;
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { migrate, run, get, all, db } = require('../src/db');
const auth = require('../src/lib/auth');
const storeLocations = require('../src/lib/store_locations');
migrate();

// 1. Seed workshops & projects
run("INSERT OR IGNORE INTO workshops (id, code, name, active) VALUES (1, 'CW', 'Central Workshop', 1)");
run("INSERT OR IGNORE INTO workshops (id, code, name, active) VALUES (2, 'GWS', 'Galagedara Workshop', 1)");
run("INSERT OR IGNORE INTO projects (id, code, name, active) VALUES (1, 'CEP-03', 'CEP-03 Project', 1)");

// 2. Seed store locations
storeLocations.seedStoreLocations(db);

// 3. Seed roles & permissions
for (const n of ['admin', 'manager', 'main_storekeeper', 'storekeeper']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
for (const m of ['stores', 'inventory', 'general_items', 'jobcards']) {
  run("INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES ('storekeeper', ?, 'edit')", m);
}

// 4. Seed user wstore (workshop storekeeper for Workshop 1)
const PW = 'SecretPassword123!';
const wstoreId = run(
  "INSERT INTO users (username, password_hash, active, workshop_id) VALUES ('wstore', ?, 1, 1)",
  auth.hashPassword(PW)
).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'storekeeper'))", wstoreId);

// Assign store location access for Store 2 (MAIN-WORKSHOP)
run("INSERT OR IGNORE INTO store_location_access (user_id, store_location_id, can_view, can_request, can_issue, can_receive) VALUES (?, 2, 1, 1, 1, 1)", wstoreId);

const app = require('../src/server');
let server;
let base;
let wstoreCookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;

  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'wstore', password: PW }),
  });
  assert.strictEqual(r.status, 200, 'wstore login should succeed');
  wstoreCookie = (r.headers.get('set-cookie') || '').split(';')[0];
});

test.after(() => {
  if (server) server.close();
});

test('Workshop storekeeper can update GRN price without tenancy boundary violation and cascade price', async () => {
  try {
    // Create asset, job card, and MRN for Workshop 1
    const vId = run("INSERT INTO assets (code, code_norm, status, in_register) VALUES ('TEST-VEH-01', 'TESTVEH01', 'active', 1)").lastInsertRowid;
    const jobId = run(
      "INSERT INTO job_cards (job_no, asset_id, workshop_id, status) VALUES ('JOB-CW-001', ?, 1, 'IN_PROGRESS')",
      vId
    ).lastInsertRowid;

    const mrnId = run(
      "INSERT INTO mrn (mrn_no, requested_by, approval_status, job_id, workshop_id, target_store_location_id) VALUES ('MRN-CW-001', 'wstore', 'approved', ?, 1, 1)",
      jobId
    ).lastInsertRowid;

    const mrnLineId = run(
      "INSERT INTO mrn_lines (mrn_id, description, qty, qty_issued) VALUES (?, 'Brake Pad', 2, 2)",
      mrnId
    ).lastInsertRowid;

    // Create store item
    const storeItemId = run(
      "INSERT INTO store_items (part_number, name, description, balance) VALUES ('PART-001', 'Brake Pad', 'Brake Pad', 10)"
    ).lastInsertRowid;

    // Create unpriced GRN with physical_store_id = 1 (Main Stores / Head office source)
    const grnId = run(
      `INSERT INTO grn (mrn_id, mrn_line_id, store_item_id, description, qty, unit_price, supplier, invoice_no, purchase_source, physical_store_id)
       VALUES (?, ?, ?, 'Brake Pad', 2, NULL, 'Dileka Motors', 'INV-715', 'head_office', 1)`,
      mrnId, mrnLineId, storeItemId
    ).lastInsertRowid;

    // Create unpriced issue & job_part linked to this MRN line
    const issueId = run(
      `INSERT INTO issues (description, qty, unit_price, job_id, mrn_line_id, physical_store_id, store_item_id)
       VALUES ('Brake Pad', 2, NULL, ?, ?, 1, ?)`,
      jobId, mrnLineId, storeItemId
    ).lastInsertRowid;

    const jobPartId = run(
      `INSERT INTO job_parts (job_id, source_type, description, qty, unit_price, mrn_line_id)
       VALUES (?, 'grn', 'Brake Pad', 2, NULL, ?)`,
      jobId, mrnLineId
    ).lastInsertRowid;

    // Attach invoice document (exactly as shown in user screenshot)
    const evidencePhotos = require('../src/lib/evidence_photos');
    evidencePhotos.savePhoto({
      entityType: 'grn',
      entityId: grnId,
      buffer: Buffer.from('%PDF-1.4 simulated invoice'),
      filename: '28-10-2026-01-p7.pdf',
      uploadedBy: wstoreId,
    });

    // Now, wstore updates late price on PATCH /api/stores/grn/:id
    const res = await fetch(`${base}/api/stores/grn/${grnId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie: wstoreCookie,
      },
      body: JSON.stringify({
        unit_price: 2500,
        supplier: 'Dileka Motors',
        invoice_no: 'INV-715',
        purchase_source: 'head_office',
      }),
    });

    const resJson = await res.json();
    assert.strictEqual(res.status, 200, `Expected 200 OK, got ${res.status}: ${JSON.stringify(resJson)}`);

    // Verify GRN price was updated
    const updatedGrn = get('SELECT unit_price FROM grn WHERE id = ?', grnId);
    assert.strictEqual(updatedGrn.unit_price, 2500, 'GRN unit_price should be updated to 2500');

    // Verify price cascaded to issues
    const updatedIssue = get('SELECT unit_price FROM issues WHERE id = ?', issueId);
    assert.strictEqual(updatedIssue.unit_price, 2500, 'issues.unit_price should cascade from GRN');

    // Verify price cascaded to job_parts
    const updatedJobPart = get('SELECT unit_price FROM job_parts WHERE id = ?', jobPartId);
    assert.strictEqual(updatedJobPart.unit_price, 2500, 'job_parts.unit_price should cascade from GRN');

    // Verify price cascaded to store_items.unit_cost
    const updatedStoreItem = get('SELECT unit_cost FROM store_items WHERE id = ?', storeItemId);
    assert.strictEqual(updatedStoreItem.unit_cost, 2500, 'store_items.unit_cost should cascade from GRN');

    // Verify job card total was refreshed
    const updatedJob = get('SELECT material_cost, total_cost FROM job_cards WHERE id = ?', jobId);
    assert.strictEqual(updatedJob.material_cost, 5000, 'job_cards.material_cost should be 2 * 2500 = 5000');
    assert.strictEqual(updatedJob.total_cost, 5000, 'job_cards.total_cost should be 5000');
  } catch (err) {
    console.error('TEST 1 ERROR:', err);
    throw err;
  }
});

test('General items issue automatically adopts store_items.unit_cost when unpriced', async () => {
  try {
    const vId = run("INSERT INTO assets (code, code_norm, status, in_register) VALUES ('TEST-VEH-02', 'TESTVEH02', 'active', 1)").lastInsertRowid;
    const jobId = run(
      "INSERT INTO job_cards (job_no, asset_id, workshop_id, status) VALUES ('JOB-CW-002', ?, 1, 'IN_PROGRESS')",
      vId
    ).lastInsertRowid;

    const itemId = run(
      "INSERT INTO store_items (part_number, name, description, unit_cost, balance, is_general, category) VALUES ('GEN-BOLT-01', 'M10 Bolt', 'M10 Bolt', 85.50, 100, 1, 'Hardware')"
    ).lastInsertRowid;

    const res = await fetch(`${base}/api/stores/items/${itemId}/txn`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: wstoreCookie,
      },
      body: JSON.stringify({
        txn_type: 'issue',
        qty: 10,
        job_id: jobId,
        ref: 'Issued for mounting',
      }),
    });

    const resJson = await res.json();
    assert.strictEqual(res.status, 201, `Expected 201 Created, got ${res.status}: ${JSON.stringify(resJson)}`);

    // Verify transaction record adopted 85.50
    const txn = get('SELECT unit_price FROM general_item_txns WHERE store_item_id = ? ORDER BY id DESC LIMIT 1', itemId);
    assert(txn, 'Transaction should be recorded');
    assert.strictEqual(txn.unit_price, 85.50, 'Transaction unit_price should be 85.50');

    // Verify job card total updated
    const updatedJob = get('SELECT general_cost, total_cost FROM job_cards WHERE id = ?', jobId);
    assert.strictEqual(updatedJob.general_cost, 855.00, 'Job general_cost should be 855.00');
  } catch (err) {
    console.error('TEST 2 ERROR:', err);
    throw err;
  }
});
