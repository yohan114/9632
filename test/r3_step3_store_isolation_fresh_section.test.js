'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-isolation-'));
const TEST_DB = path.join(TMP, 'test.db');
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { migrate, run, get, all, db } = require('../src/db');
const auth = require('../src/lib/auth');
const storeLocations = require('../src/lib/store_locations');
migrate();

// Seed workshops
run("INSERT OR IGNORE INTO workshops (id, code, name, active) VALUES (1, 'CW', 'Central Workshop', 1)");
run("INSERT OR IGNORE INTO workshops (id, code, name, active) VALUES (2, 'WS2', 'Workshop 2', 1)");

storeLocations.seedStoreLocations(db);

// Seed admin/mstore user
for (const n of ['admin', 'main_storekeeper']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
const uid = run("INSERT INTO users (username, password_hash, active, workshop_id) VALUES ('mstore_admin', ?, 1, 1)", auth.hashPassword('pw')).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'main_storekeeper'))", uid);
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'admin'))", uid);

// Seed legacy workshop MRN with target_store_location_id = NULL
run(`INSERT INTO mrn (mrn_no, req_date, workshop_id, approval_status, status, requested_by)
     VALUES ('MRN-LEGACY-001', '2026-10-01', 1, 'approved', 'open', 'Workshop Mechanic')`);

const app = require('../src/server');
let server;
let base;
let cookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;

  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'mstore_admin', password: 'pw' }),
  });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
});

test.after(() => {
  if (server) server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test('R3: MRN endpoints are strictly scoped to the active store location, giving Central Main Stores a fresh section', async () => {
  // 1. Central Main Stores (Store ID 1) should show 0 MRNs (clean fresh section)
  const resStore1 = await fetch(`${base}/api/stores/mrn`, {
    headers: { cookie, 'x-store-location-id': '1' }
  });
  assert.strictEqual(resStore1.status, 200);
  const dataStore1 = await resStore1.json();
  assert.strictEqual(dataStore1.length, 0, 'Central Main Stores must be a fresh section with 0 historical workshop MRNs');

  const resCountsStore1 = await fetch(`${base}/api/stores/mrn/counts`, {
    headers: { cookie, 'x-store-location-id': '1' }
  });
  assert.strictEqual(resCountsStore1.status, 200);
  const countsStore1 = await resCountsStore1.json();
  assert.strictEqual(countsStore1.all, 0, 'Central Main Stores count must be 0');

  // 2. Central Main Workshop Stores (Store ID 2) should show the historical workshop MRN
  const resStore2 = await fetch(`${base}/api/stores/mrn`, {
    headers: { cookie, 'x-store-location-id': '2' }
  });
  assert.strictEqual(resStore2.status, 200);
  const dataStore2 = await resStore2.json();
  assert.strictEqual(dataStore2.length, 1, 'Central Main Workshop Stores must retain the historical workshop MRN');
  assert.strictEqual(dataStore2[0].mrn_no, 'MRN-LEGACY-001');

  // 3. Create a fresh MRN targeted to Central Main Stores (Store ID 1)
  const createRes = await fetch(`${base}/api/stores/mrn`, {
    method: 'POST',
    headers: { cookie, 'x-store-location-id': '1', 'content-type': 'application/json' },
    body: JSON.stringify({
      request_type: 'general',
      target_store_location_id: 1,
      purpose: 'Fresh Central Main Stores Stock',
      lines: [{ description: 'New Bulk Item', qty: 20 }]
    })
  });
  assert.strictEqual(createRes.status, 201);

  // 4. Verify the new MRN is visible ONLY in Store 1, not in Store 2
  const checkStore1 = await (await fetch(`${base}/api/stores/mrn`, {
    headers: { cookie, 'x-store-location-id': '1' }
  })).json();
  assert.strictEqual(checkStore1.length, 1, 'Fresh MRN must show in Central Main Stores');
  assert.strictEqual(checkStore1[0].purpose, 'Fresh Central Main Stores Stock');

  const checkStore2 = await (await fetch(`${base}/api/stores/mrn`, {
    headers: { cookie, 'x-store-location-id': '2' }
  })).json();
  assert.strictEqual(checkStore2.length, 1, 'Store 2 should still have only its own 1 legacy MRN');
  assert.strictEqual(checkStore2[0].mrn_no, 'MRN-LEGACY-001');
});
