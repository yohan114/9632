'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { db, get, all, run } = require('../src/db');
const auth = require('../src/lib/auth');
const costing = require('../src/lib/costing');
const app = require('../src/server');

let server;
let baseUrl;

async function doLogin(username, password) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return cookie;
}

test('Fabrication General Works & Costing Sheet End-to-End Suite', async (t) => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  t.after(async () => {
    if (server) await new Promise((res) => server.close(res));
  });

  const pwHash = auth.hashPassword('Secret123!');

  // A fresh database has only the roles a migration creates (site_storekeeper, fabrication_officer);
  // the built-in ones are made by whoever uses them. Without these rows the user_roles inserts below
  // quietly did nothing (OR IGNORE over a NULL role_id) and the "admin" had no role at all.
  for (const r of ['admin', 'transport_manager', 'workshop', 'operational_manager']) {
    run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', r, r);
  }

  // Seed or fetch users
  let adminUser = get("SELECT * FROM users WHERE username = 'admin_fab_test'");
  if (!adminUser) {
    const res = run("INSERT INTO users (username, full_name, active, password_hash) VALUES ('admin_fab_test', 'Admin User', 1, ?)", pwHash);
    adminUser = get('SELECT * FROM users WHERE id = ?', res.lastInsertRowid);
  }
  run("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'admin'))", adminUser.id);

  let fabOfficer = get("SELECT * FROM users WHERE username = 'officer_fab_test'");
  if (!fabOfficer) {
    const res = run("INSERT INTO users (username, full_name, active, password_hash) VALUES ('officer_fab_test', 'Fabrication Officer', 1, ?)", pwHash);
    fabOfficer = get('SELECT * FROM users WHERE id = ?', res.lastInsertRowid);
  }
  run("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'fabrication_officer'))", fabOfficer.id);

  let transportMgr = get("SELECT * FROM users WHERE username = 'transport_fab_test'");
  if (!transportMgr) {
    const res = run("INSERT INTO users (username, full_name, active, password_hash) VALUES ('transport_fab_test', 'Transport Manager', 1, ?)", pwHash);
    transportMgr = get('SELECT * FROM users WHERE id = ?', res.lastInsertRowid);
  }
  run("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'transport_manager'))", transportMgr.id);

  let workshopMgr = get("SELECT * FROM users WHERE username = 'workshop_fab_test'");
  if (!workshopMgr) {
    const res = run("INSERT INTO users (username, full_name, active, password_hash) VALUES ('workshop_fab_test', 'Workshop Manager', 1, ?)", pwHash);
    workshopMgr = get('SELECT * FROM users WHERE id = ?', res.lastInsertRowid);
  }
  run("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'workshop'))", workshopMgr.id);

  let opsMgr = get("SELECT * FROM users WHERE username = 'ops_fab_test'");
  if (!opsMgr) {
    const res = run("INSERT INTO users (username, full_name, active, password_hash) VALUES ('ops_fab_test', 'Operations Manager', 1, ?)", pwHash);
    opsMgr = get('SELECT * FROM users WHERE id = ?', res.lastInsertRowid);
  }
  run("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'operational_manager'))", opsMgr.id);

  let siteStorekeeper = get("SELECT * FROM users WHERE username = 'storekeeper_fab_test'");
  if (!siteStorekeeper) {
    const res = run("INSERT INTO users (username, full_name, active, password_hash) VALUES ('storekeeper_fab_test', 'Site Storekeeper', 1, ?)", pwHash);
    siteStorekeeper = get('SELECT * FROM users WHERE id = ?', res.lastInsertRowid);
  }
  run("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'site_storekeeper'))", siteStorekeeper.id);

  // Ensure default overhead setting
  run("INSERT INTO settings (key, value) VALUES ('fabrication.default_overhead_rate', '10') ON CONFLICT(key) DO UPDATE SET value = '10'");
  run("INSERT INTO settings (key, value) VALUES ('fabrication.enabled', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");

  const adminCookie = await doLogin('admin_fab_test', 'Secret123!');
  const officerCookie = await doLogin('officer_fab_test', 'Secret123!');
  const transportCookie = await doLogin('transport_fab_test', 'Secret123!');
  const workshopCookie = await doLogin('workshop_fab_test', 'Secret123!');
  const opsCookie = await doLogin('ops_fab_test', 'Secret123!');
  const storeCookie = await doLogin('storekeeper_fab_test', 'Secret123!');

  let createdRequestId = null;
  let createdJobId = null;

  await t.test('1. Fabrication Categories CRUD and Access Protection', async () => {
    const listRes = await fetch(`${baseUrl}/api/fabrication/categories`, {
      headers: { Cookie: officerCookie }
    });
    assert.equal(listRes.status, 200);
    const cats = await listRes.json();
    assert.ok(Array.isArray(cats));
    assert.ok(cats.length >= 4);

    // Creating category without fabrication.settings is blocked
    const unauthCreate = await fetch(`${baseUrl}/api/fabrication/categories`, {
      method: 'POST',
      headers: { Cookie: officerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Test Category', key: 'test_cat_' + Date.now() })
    });
    assert.equal(unauthCreate.status, 403);

    // Creating category with admin / manager succeeds
    const catKey = 'steel_trestles_' + Date.now();
    const createRes = await fetch(`${baseUrl}/api/fabrication/categories`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Steel Trestles', key: catKey, display_order: 15 })
    });
    assert.equal(createRes.status, 201);
    const createdCat = await createRes.json();
    assert.equal(createdCat.key, catKey);
  });

  await t.test('2. Drawing Upload and Path Traversal Protection', async () => {
    const dummyBase64 = Buffer.from('PDF-1.4 dummy drawing content').toString('base64');
    const uploadRes = await fetch(`${baseUrl}/api/fabrication/drawings`, {
      method: 'POST',
      headers: { Cookie: officerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base64: dummyBase64,
        filename: 'trestle_spec_v1.pdf',
        drawing_ref: 'DWG-TRESTLE-001'
      })
    });
    assert.equal(uploadRes.status, 201);
    const upJson = await uploadRes.json();
    assert.ok(upJson.drawing_path);
    assert.equal(upJson.drawing_ref, 'DWG-TRESTLE-001');

    // Retrieve drawing
    const filename = path.basename(upJson.drawing_path);
    const downloadRes = await fetch(`${baseUrl}/api/fabrication/drawings/${filename}`, {
      headers: { Cookie: officerCookie }
    });
    assert.equal(downloadRes.status, 200);

    // Path traversal attempt returns 404 or is sanitized
    const traversalRes = await fetch(`${baseUrl}/api/fabrication/drawings/..%2f..%2fconfig.js`, {
      headers: { Cookie: officerCookie }
    });
    assert.equal(traversalRes.status, 404);
  });

  await t.test('3. General Works Job Request Validation & Creation', async () => {
    // Missing category fails
    const fail1 = await fetch(`${baseUrl}/api/job-requests`, {
      method: 'POST',
      headers: { Cookie: officerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'fabrication',
        work_target: 'general',
        description: 'Construct 5 steel trestles'
      })
    });
    assert.equal(fail1.status, 400);
    const err1 = await fail1.json();
    assert.match(err1.error, /requires a category/i);

    // Missing cost centre fails
    const fail2 = await fetch(`${baseUrl}/api/job-requests`, {
      method: 'POST',
      headers: { Cookie: officerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'fabrication',
        work_target: 'general',
        category: 'stands',
        description: 'Construct 5 steel trestles'
      })
    });
    assert.equal(fail2.status, 400);
    const err2 = await fail2.json();
    assert.match(err2.error, /requires a cost centre/i);

    // Missing drawing ref fails
    const fail3 = await fetch(`${baseUrl}/api/job-requests`, {
      method: 'POST',
      headers: { Cookie: officerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'fabrication',
        work_target: 'general',
        category: 'stands',
        cost_centre: 'Central Bridge Project',
        description: 'Construct 5 steel trestles'
      })
    });
    assert.equal(fail3.status, 400);
    const err3 = await fail3.json();
    assert.match(err3.error, /requires a drawing reference/i);

    // Valid General Works Request
    const successRes = await fetch(`${baseUrl}/api/job-requests`, {
      method: 'POST',
      headers: { Cookie: officerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'fabrication',
        work_target: 'general',
        category: 'stands',
        cost_centre: 'Central Bridge Project',
        drawing_ref: 'DWG-TRESTLE-001',
        drawing_path: '/uploads/drawings/trestle.pdf',
        drawing_filename: 'trestle.pdf',
        quantity_or_size: '5 Units (2m x 1m)',
        deliver_to: 'Bridge Pier Site 3',
        description: 'Heavy duty steel trestles for pier scaffolding'
      })
    });
    assert.equal(successRes.status, 201);
    const sJson = await successRes.json();
    assert.ok(sJson.request);
    createdRequestId = sJson.request.id;
    assert.equal(sJson.request.work_target, 'general');
    assert.equal(sJson.request.category, 'stands');
    assert.equal(sJson.request.cost_centre, 'Central Bridge Project');
  });

  await t.test('4. Certification, Approval & Card Opening Gate', async () => {
    // Certify by Transport Manager
    const certRes = await fetch(`${baseUrl}/api/job-requests/${createdRequestId}/certify`, {
      method: 'POST',
      headers: { Cookie: transportCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: 'Transport Cert Signature' })
    });
    assert.equal(certRes.status, 200);

    // Approve by Operations Manager
    const appRes = await fetch(`${baseUrl}/api/job-requests/${createdRequestId}/approve`, {
      method: 'POST',
      headers: { Cookie: opsCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: 'Ops Approval Signature' })
    });
    assert.equal(appRes.status, 200);

    // Workshop manager with jobs.create alone CANNOT open a fabrication card
    const blockOpen = await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { Cookie: workshopCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_request_id: createdRequestId,
        workshop_id: 1,
        description: 'Workshop trying to open fab card'
      })
    });
    assert.equal(blockOpen.status, 403);
    const bJson = await blockOpen.json();
    assert.match(bJson.error, /fabrication\.open_card required/i);

    // Fabrication officer with fabrication.open_card opens successfully
    const openRes = await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { Cookie: officerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_request_id: createdRequestId,
        workshop_id: 1,
        description: 'Open card for steel trestles'
      })
    });
    assert.equal(openRes.status, 201);
    const oJson = await openRes.json();
    assert.ok(oJson.job);
    createdJobId = oJson.job.id;

    // Verify F numbering: YYYY/M/F/seq
    assert.match(oJson.job.job_no, /^\d{4}\/\d+\/F\/\d+$/);
    assert.equal(oJson.job.work_target, 'general');
    assert.equal(oJson.job.category, 'stands');
    assert.equal(oJson.job.cost_centre, 'Central Bridge Project');
    assert.equal(oJson.job.issue_store_location_id, 1); // Central Main Stores
  });

  await t.test('5. Storekeeper Issue Picker Masking & Direct Read Refusal', async () => {
    // Storekeeper direct read of fabrication card returns 404
    const directRead = await fetch(`${baseUrl}/api/jobs/${createdJobId}`, {
      headers: { Cookie: storeCookie }
    });
    assert.equal(directRead.status, 404);

    // Storekeeper querying active jobs for issue picker (open=1) can see the card, but sensitive data is masked
    const pickerRes = await fetch(`${baseUrl}/api/jobs?open=1&for_issue=1`, {
      headers: { Cookie: storeCookie }
    });
    assert.equal(pickerRes.status, 200);
    const rows = await pickerRes.json();
    const fabItem = rows.find((j) => j.id === createdJobId);
    assert.ok(fabItem, 'Fabrication card should appear in issue target picker');
    assert.equal(fabItem.total_cost, 0);
    assert.equal(fabItem.material_cost, 0);
    assert.equal(fabItem.labour_cost, 0);
    assert.equal(fabItem.drawing_ref, undefined);
    assert.equal(fabItem.drawing_path, undefined);
  });

  await t.test('6. Costing Sheet Lifecycle with Live Actuals and Segregation of Duties', async () => {
    run(
      `INSERT OR IGNORE INTO labour_rates (mechanic, rate, effective_from)
       VALUES ('Sunil', 500, '2020-01-01')`
    );
    // Add daily work and a part to verify actuals computation
    run(
      `INSERT INTO job_daily_work (job_id, work_date, mechanic, hours, description, is_external)
       VALUES (?, date('now'), 'Sunil', 10, 'Cutting & welding frames', 0)`,
      createdJobId
    );
    run(
      `INSERT INTO job_parts (job_id, description, qty, unit_price, source_type)
       VALUES (?, 'Angle Iron 50x50x6mm', 4, 1500, 'issue')`,
      createdJobId
    );

    // 1. Initial retrieval - officer views costing sheet
    const costGet = await fetch(`${baseUrl}/api/fabrication/costing/${createdJobId}`, {
      headers: { Cookie: officerCookie }
    });
    assert.equal(costGet.status, 200);
    const cgJson = await costGet.json();
    assert.equal(cgJson.sheet.status, 'draft');
    assert.equal(cgJson.actuals.material_cost, 6000); // 4 * 1500
    assert.ok(cgJson.actuals.labour_cost > 0);
    // Officer without labour.rates.view cannot see individual mechanic rates
    for (const line of cgJson.actuals.labour_lines) {
      assert.equal(line.rate, null);
    }

    // 2. Save draft estimates and notes
    const saveRes = await fetch(`${baseUrl}/api/fabrication/costing/${createdJobId}/save`, {
      method: 'POST',
      headers: { Cookie: officerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        estimated_materials: 7000,
        estimated_labour: 5000,
        estimated_total: 12000,
        outside_quotation: 18000,
        overhead_percentage: 15,
        notes: 'Initial fabrication costing for bridge trestles'
      })
    });
    assert.equal(saveRes.status, 200);
    const svJson = await saveRes.json();
    assert.equal(svJson.sheet.status, 'draft');
    assert.equal(svJson.sheet.prepared_by, fabOfficer.id);

    // 3. Add manual adjustment (e.g. non-stock galvanizing service)
    const adjRes = await fetch(`${baseUrl}/api/fabrication/costing/${createdJobId}/adjustments`, {
      method: 'POST',
      headers: { Cookie: officerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'outsourced_work',
        description: 'Hot dip galvanizing trestle frames',
        amount: 3500,
        reason: 'Corrosion protection specification',
        supplier_or_contractor: 'Lanka Galvanizing Ltd'
      })
    });
    assert.equal(adjRes.status, 201);
    const aJson = await adjRes.json();
    assert.equal(aJson.amount, 3500);

    // 4. Submit sheet
    const submitRes = await fetch(`${baseUrl}/api/fabrication/costing/${createdJobId}/submit`, {
      method: 'POST',
      headers: { Cookie: officerCookie, 'Content-Type': 'application/json' }
    });
    assert.equal(submitRes.status, 200);
    const subJson = await submitRes.json();
    assert.equal(subJson.sheet.status, 'submitted');

    // 5. Segregation of Duties: Preparer (officer) CANNOT approve own sheet even if capability granted
    run("INSERT OR REPLACE INTO user_capabilities (user_id, capability, granted, updated_at) VALUES (?, 'fabrication.cost.approve', 1, datetime('now'))", fabOfficer.id);
    const selfApprove = await fetch(`${baseUrl}/api/fabrication/costing/${createdJobId}/approve`, {
      method: 'POST',
      headers: { Cookie: officerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: 'Officer Self Approval' })
    });
    assert.equal(selfApprove.status, 403);
    const saJson = await selfApprove.json();
    assert.match(saJson.error, /Segregation of Duties violation/i);
    run("DELETE FROM user_capabilities WHERE user_id = ? AND capability = 'fabrication.cost.approve'", fabOfficer.id);

    // 6. Manager approves costing sheet
    const approveRes = await fetch(`${baseUrl}/api/fabrication/costing/${createdJobId}/approve`, {
      method: 'POST',
      headers: { Cookie: opsCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: 'Ops Manager Cost Approval Signature' })
    });
    assert.equal(approveRes.status, 200);
    const appJson = await approveRes.json();
    assert.equal(appJson.sheet.status, 'approved');

    // Verify job card totals have been updated with approved overhead & adjustments
    const updatedCard = get('SELECT * FROM job_cards WHERE id = ?', createdJobId);
    assert.ok(updatedCard.other_cost > 0, 'other_cost should hold adjustment and overhead');
    const expectedSum = Math.round((updatedCard.material_cost + updatedCard.labour_cost + updatedCard.oil_cost + updatedCard.general_cost + updatedCard.external_cost + updatedCard.other_cost) * 100) / 100;
    assert.equal(Math.round(updatedCard.total_cost * 100) / 100, expectedSum, 'Total cost must match the sum of component columns exactly');

    // 7. Reconciled cost matches
    const reconciled = costing.reconciledCost(createdJobId);
    assert.equal(reconciled.total_cost, updatedCard.total_cost);
  });
});
