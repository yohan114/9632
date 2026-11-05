'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-scope-test-'));
process.env.DB_PATH = path.join(TMP, 'test_scope.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.MULTIDB = '0';

const { migrate, run, get, all } = require('../src/db');
const permissions = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');
const auth = require('../src/lib/auth');
const context = require('../src/lib/context');
const storeLocations = require('../src/lib/store_locations');

migrate();
permissions.seedDefaults();
capabilities.seedCapabilities();
storeLocations.seedStoreLocations();

// Create test store locations if not present: Store 1 (Central), Store 2 (Galagedara), Store 3 (CEP-03), Store 4 (Jaffna)
run(`INSERT OR IGNORE INTO store_locations (id, code, name, store_type, parent_store_id, active)
     VALUES (1, 'LOC-MAIN', 'Central Main Store', 'MAIN_STORE', NULL, 1)`);
run(`INSERT OR IGNORE INTO store_locations (id, code, name, store_type, parent_store_id, active)
     VALUES (2, 'LOC-GALA', 'Galagedara Site Store', 'SITE_STORE', 1, 1)`);
run(`INSERT OR IGNORE INTO store_locations (id, code, name, store_type, parent_store_id, active)
     VALUES (3, 'LOC-CEP3', 'CEP-03 Site Store', 'SITE_STORE', 1, 1)`);
run(`INSERT OR IGNORE INTO store_locations (id, code, name, store_type, parent_store_id, active)
     VALUES (4, 'LOC-JAF', 'Jaffna Site Store', 'SITE_STORE', 1, 1)`);

// Seed test vehicle and job card for issue/mrn tests
run(`INSERT OR REPLACE INTO assets (id, code, code_norm, registration) VALUES (1, 'VEH-001', 'VEH001', 'WP-ABC-1234')`);
run(`INSERT OR REPLACE INTO job_cards (id, job_no, status, asset_id, workshop_id, type) VALUES (1, 'JOB-001', 'IN_PROGRESS', 1, 1, 'repair')`);

// Seed test users
const skRoleId = get("SELECT id FROM roles WHERE name = 'site_storekeeper'")?.id || 1;
const mainSkRoleId = get("SELECT id FROM roles WHERE name = 'main_storekeeper'")?.id || 2;
const adminRoleId = get("SELECT id FROM roles WHERE name = 'admin'")?.id || 3;

run(`INSERT OR REPLACE INTO users (id, username, password_hash, full_name, active, workshop_id)
     VALUES (101, 'gala_sk', 'hash', 'Galagedara Storekeeper', 1, 1)`);
run(`INSERT OR REPLACE INTO user_roles (user_id, role_id) VALUES (101, ?)`, skRoleId);
storeLocations.setUserStoreLocationAccess(101, 2, { can_view: 1, can_request: 1, can_issue: 1, can_receive: 1, can_dispatch: 0, can_count: 1 });

run(`INSERT OR REPLACE INTO users (id, username, password_hash, full_name, active, workshop_id)
     VALUES (102, 'cep3_sk', 'hash', 'CEP-03 Storekeeper', 1, 1)`);
run(`INSERT OR REPLACE INTO user_roles (user_id, role_id) VALUES (102, ?)`, skRoleId);
storeLocations.setUserStoreLocationAccess(102, 3, { can_view: 1, can_request: 1, can_issue: 1, can_receive: 1, can_dispatch: 0, can_count: 1 });

run(`INSERT OR REPLACE INTO users (id, username, password_hash, full_name, active, workshop_id)
     VALUES (103, 'central_sk', 'hash', 'Central Storekeeper', 1, 1)`);
run(`INSERT OR REPLACE INTO user_roles (user_id, role_id) VALUES (103, ?)`, mainSkRoleId);
storeLocations.setUserStoreLocationAccess(103, 1, { can_view: 1, can_request: 1, can_issue: 1, can_receive: 1, can_dispatch: 1, can_count: 1 });

run(`INSERT OR REPLACE INTO users (id, username, password_hash, full_name, active, workshop_id)
     VALUES (104, 'admin_user', 'hash', 'System Admin', 1, 1)`);
run(`INSERT OR REPLACE INTO user_roles (user_id, role_id) VALUES (104, ?)`, adminRoleId);

run(`INSERT OR REPLACE INTO users (id, username, password_hash, full_name, active, workshop_id)
     VALUES (105, 'relief_sk', 'hash', 'Relief Roaming Storekeeper', 1, 1)`);
run(`INSERT OR REPLACE INTO user_roles (user_id, role_id) VALUES (105, ?)`, skRoleId);
// Multi-store grants for relief_sk (Store 2 and Store 3)
storeLocations.setUserStoreLocationAccess(105, 2, { can_view: 1, can_request: 1, can_issue: 1, can_receive: 1, can_dispatch: 1, can_count: 1 });
storeLocations.setUserStoreLocationAccess(105, 3, { can_view: 1, can_request: 1, can_issue: 1, can_receive: 1, can_dispatch: 1, can_count: 1 });

// Set up express app for route tests
const app = express();
app.use(express.json());

let currentUser = null;
app.use((req, res, next) => {
  req.user = currentUser;
  next();
});

app.use('/api/stores', require('../src/routes/stores'));

// Standard error handler for status/json
app.use((err, req, res, next) => {
  
  res.status(err.status || 500).json({ error: err.message });
});

let server = null;
let baseUrl = '';

test.before(async () => {
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((res) => server.close(res));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
});

test('storeScopeFor correctly identifies global vs site-scoped roles', () => {
  const adminScope = context.storeScopeFor({ id: 104, roles: ['admin'] });
  assert.equal(adminScope.isGlobal, true);
  assert.equal(adminScope.canAccess(1), true);
  assert.equal(adminScope.canAccess(2), true);
  assert.equal(adminScope.canAccess(3), true);
  assert.doesNotThrow(() => adminScope.assertAccess(999));

  const mainSkScope = context.storeScopeFor({ id: 103, roles: ['main_storekeeper'] });
  assert.equal(mainSkScope.isGlobal, true);
  assert.equal(mainSkScope.canAccess(1), true);
  assert.equal(mainSkScope.canAccess(2), true);
  assert.equal(mainSkScope.canAccess(3), true);
});

test('storeScopeFor site storekeeper restricts access strictly to assigned store', () => {
  const galaScope = context.storeScopeFor({ id: 101, username: 'gala_sk', roles: ['site_storekeeper'] });
  assert.equal(galaScope.isGlobal, false);
  assert.equal(galaScope.primaryStoreId, 2);
  assert.equal(galaScope.canAccess(2), true);
  assert.equal(galaScope.canAccess(3), false);
  assert.equal(galaScope.canAccess(4), false);

  assert.doesNotThrow(() => galaScope.assertAccess(2, 'issue'));

  assert.throws(() => galaScope.assertAccess(3, 'issue'), (err) => {
    assert.equal(err.status, 403);
    assert.match(err.message, /Tenancy \/ store boundary violation/);
    assert.match(err.message, /CEP-03 Site Store/);
    return true;
  });
});

test('storeScopeFor multi-store assigned relief user allows access to all assigned stores and blocks others', () => {
  const reliefScope = context.storeScopeFor({ id: 105, username: 'relief_sk', roles: ['site_storekeeper'] });
  assert.equal(reliefScope.isGlobal, false);
  assert.equal(reliefScope.canAccess(2), true);
  assert.equal(reliefScope.canAccess(3), true);
  assert.equal(reliefScope.canAccess(4), false);

  assert.doesNotThrow(() => reliefScope.assertAccess(2, 'count'));
  assert.doesNotThrow(() => reliefScope.assertAccess(3, 'count'));

  assert.throws(() => reliefScope.assertAccess(4, 'count'), (err) => {
    assert.equal(err.status, 403);
    assert.match(err.message, /Tenancy \/ store boundary violation/);
    return true;
  });
});

test('storeScopeFor respects granular capabilities such as stores.all', () => {
  const customUser = {
    id: 106,
    username: 'auditor',
    roles: ['viewer'],
    capabilities: ['stores.all']
  };
  const scope = context.storeScopeFor(customUser);
  assert.equal(scope.isGlobal, true);
  assert.equal(scope.canAccess(4), true);
});

test('POST /api/stores/mrn rejects cross-store request for site storekeeper', async () => {
  currentUser = { id: 101, username: 'gala_sk', roles: ['site_storekeeper'] };

  // Site storekeeper from Store 2 (Galagedara) tries to create MRN targeted for Store 3 (CEP-03)
  const resCross = await fetch(`${baseUrl}/api/stores/mrn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mrn_no: 'MRN-CROSS-01',
      request_type: 'vehicle',
      asset_id: 1,
      target_store_location_id: 3,
      lines: [{ description: 'Hydraulic Hose', qty: 2 }]
    })
  });

  assert.equal(resCross.status, 403);
  const dataCross = await resCross.json();
  assert.match(dataCross.error, /Tenancy \/ store boundary violation/);
  assert.match(dataCross.error, /CEP-03 Site Store/);

  // But succeeds when targeting their assigned store (Store 2)
  const resOwn = await fetch(`${baseUrl}/api/stores/mrn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mrn_no: 'MRN-OWN-01',
      request_type: 'vehicle',
      asset_id: 1,
      target_store_location_id: 2,
      lines: [{ description: 'Hydraulic Hose', qty: 2 }]
    })
  });
  
  assert.equal(resOwn.status, 201);
});

test('POST /api/stores/issues rejects cross-store issue for site storekeeper', async () => {
  currentUser = { id: 101, username: 'gala_sk', roles: ['site_storekeeper'] };

  const res = await fetch(`${baseUrl}/api/stores/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_id: 1,
      description: 'Grease Cartridge',
      qty: 1,
      issue_date: '2026-11-05',
      physical_store_id: 3 // CEP-03 store
    })
  });

  assert.equal(res.status, 403);
  const data = await res.json();
  assert.match(data.error, /Tenancy \/ store boundary violation/);
});

test('POST /api/stores/grn rejects cross-store receipt for site storekeeper', async () => {
  currentUser = { id: 101, username: 'gala_sk', roles: ['site_storekeeper'] };

  const res = await fetch(`${baseUrl}/api/stores/grn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: 'Air Filter',
      qty: 5,
      store_location_id: 3 // CEP-03 store
    })
  });

  assert.equal(res.status, 403);
  const data = await res.json();
  assert.match(data.error, /Tenancy \/ store boundary violation/);
});

test('POST /api/stores/mtn rejects transfer between unassigned stores for site storekeeper', async () => {
  currentUser = { id: 101, username: 'gala_sk', roles: ['site_storekeeper'], caps: ['stores.mtn.edit'] };

  // Galagedara storekeeper tries to transfer from Store 3 to Store 4
  const res = await fetch(`${baseUrl}/api/stores/mtn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from_store_location_id: 3,
      to_store_location_id: 4,
      from_location: 'CEP-03',
      to_location: 'Jaffna',
      lines: [{ description: 'Engine Oil 15W40', qty: 20 }]
    })
  });

  assert.equal(res.status, 403);
  const data = await res.json();
  assert.match(data.error, /Tenancy boundary violation/);
});

test('Central storekeeper has global clearance to operate across all stores', async () => {
  currentUser = { id: 103, username: 'central_sk', roles: ['main_storekeeper'] };

  // Central storekeeper creates MRN targeting CEP-03 (Store 3)
  const res = await fetch(`${baseUrl}/api/stores/mrn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mrn_no: 'MRN-CENTRAL-01',
      request_type: 'vehicle',
      asset_id: 1,
      target_store_location_id: 3,
      lines: [{ description: 'Brake Pads', qty: 4 }]
    })
  });

  
  assert.equal(res.status, 201);
});
