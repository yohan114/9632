'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { db, get, all, run } = require('../src/db');
const auth = require('../src/lib/auth');
const storeLocations = require('../src/lib/store_locations');
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

test('Site Stores Controls Dashboard & MTN Tenancy Boundaries Suite', async (t) => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  t.after(async () => {
    if (server) await new Promise((res) => server.close(res));
  });

  const pwHash = auth.hashPassword('SiteSecret123!');
  run(`INSERT OR IGNORE INTO workshops (id, name, code, is_default, active) VALUES (3, 'Galagedara Site Workshop', 'GALA', 0, 1)`);
  run(`INSERT OR IGNORE INTO workshops (id, name, code, is_default, active) VALUES (4, 'CEP-03 Site Workshop', 'CEP3', 0, 1)`);
  run(`INSERT OR IGNORE INTO store_locations (id, code, name, store_type, active) VALUES (3, 'SITE-GALA', 'Galagedara Site Store', 'SITE_STORE', 1)`);
  run(`INSERT OR IGNORE INTO store_locations (id, code, name, store_type, active) VALUES (4, 'SITE-CEP03', 'CEP-03 Project Site Store', 'SITE_STORE', 1)`);

  // Low stock item seeded in stock_moves and store_reorder for Store 3
  run(`INSERT OR IGNORE INTO stock_moves (section, kind, item_key, item_name, qty, physical_store_id, store_id, source_table, source_id)
       VALUES ('general', 'in', 'ROD6013', 'Welding Rods E6013 3.2mm', 2, 3, 3, 'grn', 99999)`);
  run(`INSERT OR REPLACE INTO store_reorder (store_id, physical_store_id, section, item_key, level)
       VALUES (3, 3, 'general', 'ROD6013', 10)`);

  // 1. Seed admin user
  run("INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('admin', 'Administrator', 1, 1)");
  let adminUser = get("SELECT * FROM users WHERE username = 'admin_site_test'");
  if (!adminUser) {
    const res = run("INSERT INTO users (username, full_name, active, password_hash) VALUES ('admin_site_test', 'Site Test Admin', 1, ?)", pwHash);
    adminUser = get('SELECT * FROM users WHERE id = ?', res.lastInsertRowid);
  } else { run('UPDATE users SET password_hash = ?, active = 1 WHERE id = ?', pwHash, adminUser.id); }
  run("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'admin'))", adminUser.id);

  // 2. Seed site storekeeper for Store 3 (Galagedara Site Store)
  let sk3 = get("SELECT * FROM users WHERE username = 'sk_site_3_test'");
  if (!sk3) {
    const res = run("INSERT INTO users (username, full_name, active, password_hash) VALUES ('sk_site_3_test', 'Site 3 Storekeeper', 1, ?)", pwHash);
    sk3 = get('SELECT * FROM users WHERE id = ?', res.lastInsertRowid);
  } else { run('UPDATE users SET password_hash = ?, active = 1 WHERE id = ?', pwHash, sk3.id); }
  run("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'site_storekeeper'))", sk3.id);
  storeLocations.setUserStoreLocationAccess(sk3.id, 3, {
    can_view: 1, can_request: 1, can_issue: 1, can_receive: 1, can_dispatch: 1, can_count: 1
  });

  // 3. Seed site storekeeper for Store 4 (CEP-03 Project Site Store)
  let sk4 = get("SELECT * FROM users WHERE username = 'sk_site_4_test'");
  if (!sk4) {
    const res = run("INSERT INTO users (username, full_name, active, password_hash) VALUES ('sk_site_4_test', 'Site 4 Storekeeper', 1, ?)", pwHash);
    sk4 = get('SELECT * FROM users WHERE id = ?', res.lastInsertRowid);
  } else { run('UPDATE users SET password_hash = ?, active = 1 WHERE id = ?', pwHash, sk4.id); }
  run("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'site_storekeeper'))", sk4.id);
  storeLocations.setUserStoreLocationAccess(sk4.id, 4, {
    can_view: 1, can_request: 1, can_issue: 1, can_receive: 1, can_dispatch: 1, can_count: 1
  });

  // Seed MTNs:
  // MTN 1: Store 3 -> Store 4 (status: 'approved', ready to dispatch from Store 3)
  const mtn1No = 'MTN-TEST-001-' + Date.now();
  const mtn1Res = run(`
    INSERT INTO mtn (mtn_no, txn_date, description, qty, from_store_location_id, to_store_location_id, status)
    VALUES (?, date('now'), 'Steel plates to Store 4', 5, 3, 4, 'approved')
  `, mtn1No);
  const mtn1Id = mtn1Res.lastInsertRowid;

  // MTN 2: Store 1 -> Store 3 (status: 'dispatched', incoming for Store 3)
  const mtn2No = 'MTN-TEST-002-' + Date.now();
  const mtn2Res = run(`
    INSERT INTO mtn (mtn_no, txn_date, description, qty, from_store_location_id, to_store_location_id, status)
    VALUES (?, date('now'), 'Safety gear to Store 3', 10, 1, 3, 'dispatched')
  `, mtn2No);
  const mtn2Id = mtn2Res.lastInsertRowid;

  // MTN 3: Store 4 -> Store 1 (status: 'dispatched', external to Store 3)
  const mtn3No = 'MTN-TEST-003-' + Date.now();
  const mtn3Res = run(`
    INSERT INTO mtn (mtn_no, txn_date, description, qty, from_store_location_id, to_store_location_id, status)
    VALUES (?, date('now'), 'Hydraulic motor to Main', 1, 4, 1, 'dispatched')
  `, mtn3No);
  const mtn3Id = mtn3Res.lastInsertRowid;

  // Seed MRN for Store 3
  const mrnNo = 'MRN-TEST-' + Date.now();
  run(`
    INSERT INTO mrn (mrn_no, req_date, purpose, approval_status, target_store_location_id)
    VALUES (?, date('now'), 'Site 3 Emergency Brackets', 'requested', 3)
  `, mrnNo);

  const adminCookie = await doLogin('admin_site_test', 'SiteSecret123!');
  const sk3Cookie = await doLogin('sk_site_3_test', 'SiteSecret123!');
  const sk4Cookie = await doLogin('sk_site_4_test', 'SiteSecret123!');

  await t.test('1. Site Store Controls Dashboard Scoped to Assigned Location', async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/stores-controls`, {
      headers: { Cookie: sk3Cookie }
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.active_store.id, 3);
    assert.equal(body.is_main_store, false);
    assert.equal(body.permissions.can_view, true);
    assert.equal(body.permissions.can_issue, true);
    assert.equal(body.permissions.can_receive, true);
    assert.equal(body.permissions.can_dispatch, true);

    // Incoming MTNs for Store 3: must include MTN 2, but NOT MTN 3
    const incomingIds = (body.incoming_mtn || []).map((m) => m.id);
    assert.ok(incomingIds.includes(mtn2Id), 'Incoming MTN must include transfer addressed to Store 3');
    assert.ok(!incomingIds.includes(mtn3Id), 'Incoming MTN must NOT include transfer addressed to Store 1');

    // Ready to dispatch for Store 3: must include MTN 1
    const readyIds = (body.ready_to_dispatch || []).map((m) => m.id);
    assert.ok(readyIds.includes(mtn1Id), 'Ready to dispatch must include approved transfer from Store 3');

    // Pending requests for Store 3: must include our seeded MRN
    const mrnNos = (body.pending_requests || []).map((m) => m.mrn_no);
    assert.ok(mrnNos.includes(mrnNo), 'Pending MRNs must include Store 3 MRN');

    // Low stock for Store 3: must include product 9001
    const lowStockProductNames = (body.low_stock || []).map((i) => i.item_name);
    assert.ok(lowStockProductNames.includes('Welding Rods E6013 3.2mm'), 'Low stock must include Store 3 low items');
  });

  await t.test('2. Store Tenancy Lock: Site user cannot bypass assigned store via query param', async () => {
    // Attempt to view Central Store (1) and Store 4 using store_id query param
    const resStore1 = await fetch(`${baseUrl}/api/dashboard/stores-controls?store_id=1`, {
      headers: { Cookie: sk3Cookie }
    });
    assert.equal(resStore1.status, 200);
    const body1 = await resStore1.json();
    assert.equal(body1.active_store.id, 3, 'Query param store_id=1 must be ignored for site user');

    const resStore4 = await fetch(`${baseUrl}/api/dashboard/stores-controls?store_id=4`, {
      headers: { Cookie: sk3Cookie }
    });
    assert.equal(resStore4.status, 200);
    const body4 = await resStore4.json();
    assert.equal(body4.active_store.id, 3, 'Query param store_id=4 must be ignored for site user');
  });

  await t.test('3. Admin / Central user can inspect multiple store locations via store_id query param', async () => {
    const res3 = await fetch(`${baseUrl}/api/dashboard/stores-controls?store_id=3`, {
      headers: { Cookie: adminCookie }
    });
    assert.equal(res3.status, 200);
    const body3 = await res3.json();
    assert.equal(body3.active_store.id, 3);

    const res4 = await fetch(`${baseUrl}/api/dashboard/stores-controls?store_id=4`, {
      headers: { Cookie: adminCookie }
    });
    assert.equal(res4.status, 200);
    const body4 = await res4.json();
    assert.equal(body4.active_store.id, 4);
  });

  await t.test('4. MTN Destination Boundary: Site storekeeper can only accept MTNs addressed to their store', async () => {
    // sk3 (Store 3) tries to accept MTN 3 (addressed to Store 1) -> Must be refused (403)
    const badAccept1 = await fetch(`${baseUrl}/api/stores/mtn/${mtn3Id}/accept`, {
      method: 'POST',
      headers: { Cookie: sk3Cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ accepted_by: 'Site 3 Storekeeper' })
    });
    assert.equal(badAccept1.status, 403, 'Should forbid accepting MTN destined for Store 1');

    // sk3 (Store 3) tries to accept MTN 1 (addressed to Store 4) -> Must be refused (403)
    const badAccept2 = await fetch(`${baseUrl}/api/stores/mtn/${mtn1Id}/accept`, {
      method: 'POST',
      headers: { Cookie: sk3Cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ accepted_by: 'Site 3 Storekeeper' })
    });
    assert.equal(badAccept2.status, 403, 'Should forbid accepting MTN destined for Store 4');

    // sk3 (Store 3) accepts MTN 2 (addressed to Store 3) -> Allowed (200)
    const goodAccept = await fetch(`${baseUrl}/api/stores/mtn/${mtn2Id}/accept`, {
      method: 'POST',
      headers: { Cookie: sk3Cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ accepted_by: 'Site 3 Storekeeper' })
    });
    assert.equal(goodAccept.status, 200, 'Should allow accepting MTN addressed to Store 3');
    const accJson = await goodAccept.json();
    assert.equal(accJson.ok, true);
    assert.equal(accJson.status, 'accepted');
  });

  await t.test('5. MTN Dispatch Boundary: Site storekeeper can only dispatch MTNs originating from their store', async () => {
    // sk3 (Store 3) tries to dispatch MTN 3 (originating from Store 4) -> Must be refused (403)
    const badDispatch1 = await fetch(`${baseUrl}/api/stores/mtn/${mtn3Id}/dispatch`, {
      method: 'POST',
      headers: { Cookie: sk3Cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ driver_name: 'Driver Joe' })
    });
    assert.equal(badDispatch1.status, 403, 'Should forbid dispatching MTN originating from Store 4');

    // sk3 (Store 3) dispatches MTN 1 (originating from Store 3) -> Allowed (200)
    const goodDispatch = await fetch(`${baseUrl}/api/stores/mtn/${mtn1Id}/dispatch`, {
      method: 'POST',
      headers: { Cookie: sk3Cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ driver_name: 'Driver Joe' })
    });
    assert.equal(goodDispatch.status, 200, 'Should allow dispatching MTN originating from Store 3');
    const dispJson = await goodDispatch.json();
    assert.equal(dispJson.ok, true);
    assert.equal(dispJson.status, 'dispatched');
  });
});
