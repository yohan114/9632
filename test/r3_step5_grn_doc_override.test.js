'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-m2-doc-'));
const TEST_DB = path.join(TMP, 'test.db');
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { migrate, run, get, all, db } = require('../src/db');
const auth = require('../src/lib/auth');
const storeLocations = require('../src/lib/store_locations');
migrate();

// Seed workshops & stores
run("INSERT OR IGNORE INTO workshops (id, code, name, active) VALUES (1, 'CW', 'Central Workshop', 1)");
storeLocations.seedStoreLocations(db);

// Seed roles
for (const n of ['admin', 'manager', 'storekeeper', 'clerk']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}

// User 1: Manager with approve perm but no override capability
const mgrUid = run("INSERT INTO users (username, password_hash, active) VALUES ('mgr_user', ?, 1)", auth.hashPassword('pw')).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'manager'))", mgrUid);
run("INSERT INTO store_location_access (user_id, store_location_id, can_view, can_request) VALUES (?, 1, 1, 1)", mgrUid);

// User 2: Admin (has all capabilities)
const adminUid = run("INSERT INTO users (username, password_hash, active) VALUES ('admin_user', ?, 1)", auth.hashPassword('pw')).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'admin'))", adminUid);
run("INSERT INTO store_location_access (user_id, store_location_id, can_view, can_request) VALUES (?, 1, 1, 1)", adminUid);

// Seed a draft GRN without documents
const grnId = run(`
  INSERT INTO grn (grn_no, store_id, physical_store_id, description, qty, unit, status, delivery_date)
  VALUES ('GRN-TEST-001', 1, 1, 'Bolt M10', 10, 'nos', 'received', '2026-11-05')
`).lastInsertRowid;

const app = require('../src/server');
let server;
let base;
let mgrCookie;
let adminCookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;

  const r1 = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'mgr_user', password: 'pw' }),
  });
  mgrCookie = (r1.headers.get('set-cookie') || '').split(';')[0];

  const r2 = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin_user', password: 'pw' }),
  });
  adminCookie = (r2.headers.get('set-cookie') || '').split(';')[0];
});

test.after(() => {
  if (server) server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test('M2: Approving GRN without document and without allow_without_doc fails with 400', async () => {
  const res = await fetch(`${base}/api/stores/grn/${grnId}/approve`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ allow_without_doc: false })
  });
  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.strictEqual(data.code, 'MISSING_GRN_DOCUMENT');
});

test('M2: Approving GRN with allow_without_doc without named capability fails with 403', async () => {
  const res = await fetch(`${base}/api/stores/grn/${grnId}/approve`, {
    method: 'POST',
    headers: { cookie: mgrCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ allow_without_doc: true, reason: 'Mgr has no override doc capability' })
  });
  assert.strictEqual(res.status, 403, 'Must require stores.grn.override_doc capability');
});

test('M2: Approving GRN with allow_without_doc without a reason fails with 400', async () => {
  const res = await fetch(`${base}/api/stores/grn/${grnId}/approve`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ allow_without_doc: true, reason: '' })
  });
  assert.strictEqual(res.status, 400, 'Must require a reason when allow_without_doc is true');
});

test('M2: Approving GRN with allow_without_doc and reason succeeds and creates audit log', async () => {
  const res = await fetch(`${base}/api/stores/grn/${grnId}/approve`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ allow_without_doc: true, reason: 'Vendor invoice arriving tomorrow via courier' })
  });
  assert.strictEqual(res.status, 200);

  // Check audit log
  const auditRow = get("SELECT * FROM audit_log WHERE entity = 'grn' AND entity_id = ? AND (action = 'override_missing_doc' OR reason LIKE '%Vendor invoice%') ORDER BY id DESC LIMIT 1", grnId);
  assert.ok(auditRow, 'Audit log entry must be created for doc override');
  assert.strictEqual(auditRow.reason, 'Vendor invoice arriving tomorrow via courier');
});
