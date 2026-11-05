'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-cascade-test-'));
const TEST_DB = path.join(TMP, 'test.db');
process.env.DB_PATH = TEST_DB;
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

// 3. Seed roles
for (const n of ['admin', 'manager', 'main_storekeeper', 'storekeeper']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}

// 4. Seed users
const mstoreUid = run("INSERT INTO users (username, password_hash, active) VALUES ('mstore_test', ?, 1)", auth.hashPassword('Secret123!')).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'main_storekeeper'))", mstoreUid);
// Give mstore view grants on store 1 and store 3 (Galagedara)
run("INSERT INTO store_location_access (user_id, store_location_id, can_view, can_request) VALUES (?, 1, 1, 1)", mstoreUid);
run("INSERT INTO store_location_access (user_id, store_location_id, can_view, can_request) VALUES (?, 3, 1, 1)", mstoreUid);

const gwsUid = run("INSERT INTO users (username, password_hash, active) VALUES ('gws_test', ?, 1)", auth.hashPassword('Secret123!')).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'storekeeper'))", gwsUid);
run("INSERT INTO store_location_access (user_id, store_location_id, can_view, can_request) VALUES (?, 3, 1, 1)", gwsUid);

const app = require('../src/server');
let server;
let base;
let mstoreCookie;
let gwsCookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;

  const r1 = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'mstore_test', password: 'Secret123!' }),
  });
  mstoreCookie = (r1.headers.get('set-cookie') || '').split(';')[0];

  const r2 = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'gws_test', password: 'Secret123!' }),
  });
  gwsCookie = (r2.headers.get('set-cookie') || '').split(';')[0];
});

test.after(() => {
  if (server) server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test('1. Main Storekeeper context resolution', async () => {
  const res = await fetch(`${base}/api/dashboard/overview`, {
    headers: { cookie: mstoreCookie, 'X-Store-Location-Id': '1' }
  });
  assert.strictEqual(res.status, 200);
});

test('2. Main Storekeeper switches context to Galagedara (store 3)', async () => {
  const res = await fetch(`${base}/api/dashboard/overview`, {
    headers: { cookie: mstoreCookie, 'X-Store-Location-Id': '3' }
  });
  assert.strictEqual(res.status, 200);
});

test('3. Sub-store user is locked to assigned store (store 3) and blocked from other stores', async () => {
  // Query own store cockpit -> 200 OK
  const ownRes = await fetch(`${base}/api/stores/cockpit?physical_store_id=3`, {
    headers: { cookie: gwsCookie }
  });
  assert.strictEqual(ownRes.status, 200);

  // Attempt to query store 1 directly -> 403 Forbidden
  const crossRes = await fetch(`${base}/api/stores/cockpit?physical_store_id=1`, {
    headers: { cookie: gwsCookie, 'X-Store-Location-Id': '1' }
  });
  assert.strictEqual(crossRes.status, 403, 'Cross-store query by sub-store must return 403 Forbidden');
});
