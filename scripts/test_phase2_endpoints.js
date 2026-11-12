'use strict';

const assert = require('assert');
const http = require('http');
const app = require('../src/server');
const { get, run, all } = require('../src/db');
const { createSession } = require('../src/lib/auth');

console.log('=== RUNNING PHASE 2 BACKEND & API TESTS (PORT 1949 SYSTEM) ===');

async function runTests() {
  // 1. Setup seed user & asset if missing
  let user = get("SELECT * FROM users WHERE username = 'admin' LIMIT 1");
  if (!user) {
    const info = run(`
      INSERT INTO users (username, password_hash, full_name, email, active)
      VALUES ('admin', 'dummy_hash', 'System Administrator', 'admin@ec.lk', 1)
    `);
    user = get("SELECT * FROM users WHERE id = ?", info.lastInsertRowid);
  }

  // Ensure role 'admin' is assigned
  let adminRole = get("SELECT * FROM roles WHERE name = 'admin'");
  if (!adminRole) {
    const rInfo = run("INSERT INTO roles (name, label, is_system) VALUES ('admin', 'System Administrator', 1)");
    adminRole = { id: rInfo.lastInsertRowid, name: 'admin' };
  }
  run("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)", user.id, adminRole.id);

  // Setup non-admin test user (e.g. viewer with granular permission grants)
  let viewerUser = get("SELECT * FROM users WHERE username = 'test_viewer' LIMIT 1");
  if (!viewerUser) {
    const vInfo = run(`
      INSERT INTO users (username, password_hash, full_name, active)
      VALUES ('test_viewer', 'dummy_hash', 'Test Viewer', 1)
    `);
    viewerUser = get("SELECT * FROM users WHERE id = ?", vInfo.lastInsertRowid);
  }
  // Grant granular module permissions to test user: view on costing, none on admin
  run("INSERT OR REPLACE INTO user_permissions (user_id, section, level) VALUES (?, 'costing', 'view')", viewerUser.id);
  run("INSERT OR REPLACE INTO user_permissions (user_id, section, level) VALUES (?, 'fuel', 'view')", viewerUser.id);

  // Setup a test vehicle
  let asset = get("SELECT * FROM assets WHERE code = 'DT-999' LIMIT 1");
  if (!asset) {
    const aInfo = run(`
      INSERT INTO assets (code, code_norm, registration, category, brand, type, status, current_hours)
      VALUES ('DT-999', 'DT999', 'WP-NA-9999', 'DT', 'TATA', 'Prima 2528.K', 'active', 1200)
    `);
    asset = get("SELECT * FROM assets WHERE id = ?", aInfo.lastInsertRowid);
  } else {
    // Reset test data for DT-999 for idempotent test runs
    run("DELETE FROM vehicle_hiring_revenue WHERE asset_id = ?", asset.id);
    run("DELETE FROM vehicle_driver_other_costs WHERE asset_id = ?", asset.id);
    run("DELETE FROM fuel_issues WHERE asset_id = ?", asset.id);
    run("DELETE FROM issues WHERE asset_id = ?", asset.id);
  }

  // Create active session cookie for requests
  const adminSession = createSession(user.id);
  const cookieHeader = `wo_session=${adminSession.token}`;

  const viewerSession = createSession(viewerUser.id);
  const viewerCookie = `wo_session=${viewerSession.token}`;

  // Start test server on dynamic port
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}`);

  async function api(path, opts = {}) {
    const headers = {
      'Cookie': cookieHeader,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    };
    const res = await fetch(`${baseUrl}${path}`, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Health & Portal Authentication Gate
    // -------------------------------------------------------------------------
    console.log('\n[Test 1] Health & Portal Status');
    const h = await api('/api/health');
    assert.strictEqual(h.status, 200, 'Health check failed');
    assert.strictEqual(h.data.ok, true);

    const portalRes = await api('/api/portal/service', {
      headers: { 'x-portal-token': 'fuel_system_v2_merged_token_1949' }
    });
    assert.strictEqual(portalRes.status, 200, 'Portal service check failed');
    assert.strictEqual(portalRes.data.system, 'fuel-merged');
    console.log('✔ Health & Portal endpoints responding correctly');

    // -------------------------------------------------------------------------
    // TEST 2: Bulk Tanks & Dips
    // -------------------------------------------------------------------------
    console.log('\n[Test 2] Bulk Tanks & Dip Measurements');
    const tanks = await api('/api/tanks');
    assert.strictEqual(tanks.status, 200);
    assert(Array.isArray(tanks.data) && tanks.data.length > 0, 'No bulk tanks found');
    const tankId = tanks.data[0].id;

    const dip = await api(`/api/tanks/${tankId}/dips`, {
      method: 'POST',
      body: { dip_cm: 150, calculated_litres: 7500, notes: 'Routine morning dip' }
    });
    assert.strictEqual(dip.status, 200, 'Dip recording failed');
    console.log('✔ Bulk tanks and dip logging verified');

    // -------------------------------------------------------------------------
    // TEST 3: Fuel Dispensing (Pump Issue) & Auto Rollup
    // -------------------------------------------------------------------------
    console.log('\n[Test 3] Fuel Dispensing & Cost Rollup');
    const issueRes = await api('/api/fuel/issues', {
      method: 'POST',
      body: {
        asset_id: asset.id,
        bulk_tank_id: tankId,
        fuel_kind: 'AUTO_DIESEL',
        litres: 120,
        unit_price: 329.00,
        meter_reading: 1250,
        recipient_name: 'Driver Bandara',
        notes: 'Full tank for site run'
      }
    });
    assert.strictEqual(issueRes.status, 200, 'Fuel issue failed');
    assert.strictEqual(issueRes.data.ok, true);
    assert(issueRes.data.total_price > 0);
    const fuelIssueId = issueRes.data.id;
    console.log(`✔ Dispensed 120L (LKR ${issueRes.data.total_price}) to asset ${asset.code}`);

    // Verify meter reading updated on asset
    const updatedAsset = get("SELECT current_hours FROM assets WHERE id = ?", asset.id);
    assert.strictEqual(updatedAsset.current_hours, 1250, 'Asset current_hours not updated from fuel issue');
    console.log('✔ Asset meter telemetry synchronized');

    // -------------------------------------------------------------------------
    // TEST 4: Store Material Issues with Recipient, Qty, Price, Total
    // -------------------------------------------------------------------------
    console.log('\n[Test 4] Store Material Issues (Workshop)');
    // Insert store item if missing
    let storeItem = get("SELECT id FROM store_items LIMIT 1");
    if (!storeItem) {
      const sInfo = run("INSERT INTO store_items (part_number, name, unit_cost, balance) VALUES ('FILT-01', 'Fuel Filter Element', 4500, 50)");
      storeItem = { id: sInfo.lastInsertRowid };
    }

    const matIssue = run(`
      INSERT INTO issues (asset_id, store_item_id, description, qty, unit, unit_price, total_price, recipient_name, purpose)
      VALUES (?, ?, 'Fuel Filter Cartridge', 2, 'nos', 4500, 9000, 'Mechanic Silva', 'Periodic filter change')
    `, asset.id, storeItem.id);
    assert(matIssue.lastInsertRowid > 0);

    const issuesList = await api(`/api/stores/issues?asset_id=${asset.id}`);
    assert.strictEqual(issuesList.status, 200);
    const foundIssue = issuesList.data.find(i => i.id === matIssue.lastInsertRowid);
    assert(foundIssue, 'Store issue not returned');
    assert.strictEqual(foundIssue.recipient, 'Mechanic Silva');
    assert.strictEqual(foundIssue.line_total, 9000);
    console.log('✔ Store Material Issue with recipient, qty, price, and total verified');

    // -------------------------------------------------------------------------
    // TEST 5: MRN File Attachments
    // -------------------------------------------------------------------------
    console.log('\n[Test 5] MRN File Attachments');
    let mrn = get("SELECT id FROM mrn LIMIT 1");
    if (!mrn) {
      const mInfo = run("INSERT INTO mrn (mrn_no, req_date, approval_status) VALUES ('MRN-TEST-01', date('now'), 'approved')");
      mrn = { id: mInfo.lastInsertRowid };
    }

    const fakePdfBytes = Buffer.from('%PDF-1.4 Fake test PDF content for quotation');
    const uploadRes = await fetch(`${baseUrl}/api/stores/mrn/${mrn.id}/attachments?filename=Quotation.pdf`, {
      method: 'POST',
      headers: {
        'Cookie': cookieHeader,
        'Content-Type': 'application/pdf'
      },
      body: fakePdfBytes
    });
    assert.strictEqual(uploadRes.status, 201, 'MRN upload failed');
    const uploadData = await uploadRes.json();
    assert(uploadData.id > 0);

    const attList = await api(`/api/stores/mrn/${mrn.id}/attachments`);
    assert.strictEqual(attList.status, 200);
    assert(attList.data.some(a => a.id === uploadData.id));

    const dlRes = await fetch(`${baseUrl}/api/stores/mrn/attachments/${uploadData.id}/download`, {
      headers: { 'Cookie': cookieHeader }
    });
    assert.strictEqual(dlRes.status, 200);
    const dlBuf = Buffer.from(await dlRes.arrayBuffer());
    assert(dlBuf.subarray(0, 5).equals(Buffer.from('%PDF-')));
    console.log('✔ MRN attachment upload, list, and download verified');

    // -------------------------------------------------------------------------
    // TEST 6: Vehicle Hiring Revenue & Driver/Other Costs CRUD
    // -------------------------------------------------------------------------
    console.log('\n[Test 6] Vehicle Hiring Revenue & Driver Costs CRUD');
    const nowMonth = new Date().toISOString().slice(0, 7);

    const revRes = await api('/api/vehicle-costing/revenue', {
      method: 'POST',
      body: {
        asset_id: asset.id,
        month: nowMonth,
        hire_type: 'hours',
        quantity: 180,
        hire_rate: 4500,
        invoice_no: 'INV-2026-001',
        notes: 'Monthly project site hire'
      }
    });
    assert.strictEqual(revRes.status, 200);
    assert.strictEqual(revRes.data.total_revenue, 180 * 4500); // 810,000

    const drvRes = await api('/api/vehicle-costing/driver-costs', {
      method: 'POST',
      body: {
        asset_id: asset.id,
        month: nowMonth,
        cost_type: 'driver_salary',
        driver_name: 'Bandara',
        driver_salary: 85000,
        bata_ot: 25000,
        other_expenses: 5000,
        description: 'Driver salary and overtime for site work'
      }
    });
    assert.strictEqual(drvRes.status, 200);
    assert.strictEqual(drvRes.data.amount, 115000);
    console.log('✔ Vehicle hiring revenue and driver costs logged successfully');

    // -------------------------------------------------------------------------
    // TEST 7: FINAL VEHICLE COSTING REPORT API ENDPOINT (Task 3 Core Requirement)
    // -------------------------------------------------------------------------
    console.log('\n[Test 7] Final Vehicle Costing Report API Endpoint');
    const repRes = await api(`/api/vehicle-costing/report?asset_id=${asset.id}&month=${nowMonth}`);
    assert.strictEqual(repRes.status, 200, 'Costing report endpoint failed');

    const rep = repRes.data;
    console.log('--- Final Vehicle Costing Summary ---');
    console.log('Vehicle:', rep.asset.code, `(${rep.asset.registration})`);
    console.log('Month:', rep.month);
    console.log('Monthly Hiring Revenue:', rep.summary.monthly_hiring_revenue);
    console.log('Monthly Vehicle Repair Cost:', rep.summary.monthly_vehicle_repair_cost);
    console.log('Monthly Diesel Cost:', rep.summary.monthly_diesel_cost);
    console.log('Monthly Driver & Other Costs:', rep.summary.monthly_driver_other_costs);
    console.log('Total Expenses:', rep.summary.total_expenses);
    console.log('Final Net Profit:', rep.summary.final_net_profit);
    console.log('Profit Margin %:', rep.summary.profit_margin_percent, '%');

    assert.strictEqual(rep.summary.monthly_hiring_revenue, 810000, 'Hiring revenue calculation incorrect');
    assert(rep.summary.monthly_vehicle_repair_cost >= 9000, 'Repair cost not matching store issues');
    assert.strictEqual(rep.summary.monthly_diesel_cost, 120 * 329, 'Diesel cost not matching fuel issues');
    assert.strictEqual(rep.summary.monthly_driver_other_costs, 115000, 'Driver costs incorrect');

    const expectedExpenses = rep.summary.monthly_vehicle_repair_cost + (120 * 329) + 115000;
    assert.strictEqual(rep.summary.total_expenses, expectedExpenses, 'Total expenses mismatch');
    assert.strictEqual(rep.summary.final_net_profit, 810000 - expectedExpenses, 'Final net profit mismatch');
    console.log('✔ Final Vehicle Costing Report equation mathematically verified!');

    // -------------------------------------------------------------------------
    // TEST 8: Fleet-wide Costing Summary
    // -------------------------------------------------------------------------
    console.log('\n[Test 8] Fleet-wide Costing Summary');
    const fleetRes = await api(`/api/vehicle-costing/fleet-summary?month=${nowMonth}`);
    assert.strictEqual(fleetRes.status, 200);
    assert(Array.isArray(fleetRes.data.vehicles));
    assert(fleetRes.data.totals.total_hiring_revenue >= 810000);
    console.log('✔ Fleet-wide monthly costing summary verified');

    // -------------------------------------------------------------------------
    // TEST 9: Granular Permissions Enforcement
    // -------------------------------------------------------------------------
    console.log('\n[Test 9] Granular Role & User Permission Enforcement');
    // Viewer should be able to VIEW costing report
    const vCosting = await fetch(`${baseUrl}/api/vehicle-costing/report?asset_id=${asset.id}&month=${nowMonth}`, {
      headers: { 'Cookie': viewerCookie }
    });
    assert.strictEqual(vCosting.status, 200, 'Viewer with view level should access report');

    // Viewer should be BLOCKED from ADDING revenue (needs add/edit)
    const vBlock = await fetch(`${baseUrl}/api/vehicle-costing/revenue`, {
      method: 'POST',
      headers: { 'Cookie': viewerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset_id: asset.id, quantity: 10, hire_rate: 100 })
    });
    assert.strictEqual(vBlock.status, 403, 'Viewer should be forbidden from POSTing revenue');
    console.log('✔ Viewer granted view access but correctly forbidden from write access');

    console.log('\n===============================================================');
    console.log('ALL PHASE 2 BACKEND AND DATABASE TESTS PASSED WITH 100% SUCCESS!');
    console.log('===============================================================');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('\n❌ Test Error:', err);
  process.exit(1);
});
