'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-h6-context-'));
const TEST_DB = path.join(TMP, 'test.db');
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { migrate, run, get, all, db } = require('../src/db');
const storeLocations = require('../src/lib/store_locations');
const context = require('../src/lib/context');
migrate();

// Seed workshops first for foreign key integrity
run("INSERT OR IGNORE INTO workshops (id, code, name, active) VALUES (1, 'CW', 'Central Workshop', 1)");
// Galagedara (code GWS), so the seed gives it its site store (store 3, used below). The seed used to
// treat whichever workshop had id 2 as Galagedara; it goes by the code now.
run("INSERT OR IGNORE INTO workshops (id, code, name, active) VALUES (2, 'GWS', 'Galagedara Workshop', 1)");

storeLocations.seedStoreLocations(db);

// Seed users
run("INSERT INTO users (id, username, password_hash, active) VALUES (101, 'mstore_plain', 'hash', 1)");
run("INSERT INTO users (id, username, password_hash, active) VALUES (102, 'clerk1', 'hash', 1)");
run("INSERT INTO users (id, username, password_hash, active) VALUES (103, 'authorized_mstore', 'hash', 1)");

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test('H6: context engine enforces capability/role check, validates can_view for switches, and audits context switches', async () => {
  // 1. Username 'mstore' without roles/caps MUST NOT be treated as main store user
  const plainUser = { id: 101, username: 'mstore', roles: [] };
  assert.strictEqual(context.isMainStoreUser(plainUser), false, 'Plain mstore without role must not have main store authority');

  // 2. A clerk with a grant on a main store but without main_storekeeper role MUST NOT be treated as main store user
  run(`INSERT OR IGNORE INTO store_location_access (user_id, store_location_id, can_view, can_request)
       VALUES (102, 1, 1, 1)`);
  const clerkUser = { id: 102, username: 'clerk1', roles: ['clerk'] };
  assert.strictEqual(context.isMainStoreUser(clerkUser), false, 'Clerk with a main store grant must not be mainStoreUser');

  // 3. A main storekeeper switching store context writes an audit entry
  const mstoreUser = { id: 103, username: 'authorized_mstore', roles: ['main_storekeeper'] };
  // Grant view on store 3 (Galagedara)
  run(`INSERT OR IGNORE INTO store_location_access (user_id, store_location_id, can_view)
       VALUES (103, 3, 1)`);

  const req = {
    user: mstoreUser,
    headers: { 'x-store-location-id': '3' },
    ip: '127.0.0.1',
    session: { activeStoreId: 1 }
  };

  const resolved = context.resolveRequestContext(req);
  assert.strictEqual(resolved.activeStoreId, 3, 'Authorized switch to store 3 should be accepted');

  // Verify audit log has the switch
  const auditRow = get(`SELECT * FROM audit_log WHERE user_id = 103 AND entity = 'store_context' AND action = 'switch_context' ORDER BY id DESC LIMIT 1`);
  assert.ok(auditRow, 'Context switch must be recorded in audit_log');
  const details = JSON.parse(auditRow.after_json || '{}');
  assert.strictEqual(details.to_store_id, 3, 'Audit log should record target store id');
});
