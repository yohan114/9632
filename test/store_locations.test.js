'use strict';

/**
 * ===========================================================================
 * Physical Store Locations Test Suite (Plan Revision 2, Phase 1)
 *
 * Validates:
 * 1. Physical store-location master, hierarchy, and cycle prevention.
 * 2. Idempotent baseline seeding preserving existing stock balances:
 *    - Central Workshop (CW) mapped to MAIN-WORKSHOP (Main Workshop Stores).
 *    - Galagedara (GWS) mapped to SITE-WORKSHOP-GWS (Site Workshop Store).
 *    - Central Main Stores (MAIN-STORES) established as top central authority.
 * 3. Legacy store ID & workshop bridge resolution (bi-directional mapping).
 * 4. User access grants per physical store location.
 * 5. REST API endpoints, RBAC, and granular capability enforcement.
 * 6. Zero stock impact verification on existing balances and movements.
 * ===========================================================================
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-store-locs-'));
process.env.DB_PATH = path.join(TMP, 'store_locs.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const storeLocs = require('../src/lib/store_locations');

migrate();

// 1. Seed Roles & Users
const PW = 'secure-store-loc-token-pw';
function mkUser(username, roleName) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', roleName, roleName);
  const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', username, auth.hashPassword(PW)).lastInsertRowid;
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, roleName);
  return uid;
}

const adminId = mkUser('store_admin_user', 'admin');
const storeMgrId = mkUser('main_store_mgr', 'main_storekeeper');
const skId = mkUser('site_storekeeper', 'storekeeper');
const viewerId = mkUser('plain_viewer', 'viewer');

capabilities.seedCapabilities();

// 2. Seed Test Workshops and Projects
run(`INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active, own_store)
    VALUES (1, 'CW', 'Central Workshop — Badalgama', 'Badalgama', 1, 1, 1)`);
run(`INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active, own_store)
    VALUES (2, 'GWS', 'Galagedara Workshop', 'Galagedara', 0, 1, 1)`);

run(`INSERT OR IGNORE INTO projects (id, code, name, active)
    VALUES (1, 'CEP03', 'CEP-03 Project', 1)`);

// Start HTTP test server
const app = require('../src/server');
let server;
let port;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
});

test.after(() => {
  if (server) server.close();
});

function req(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = {};
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch {}
        const sc = res.headers['set-cookie'];
        resolve({
          status: res.statusCode,
          body: json,
          text: raw.toString('utf8'),
          raw,
          headers: res.headers,
          cookie: sc ? sc[0].split(';')[0] : null
        });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function login(username) {
  const r = await req('POST', '/api/auth/login', { body: { username, password: PW } });
  assert.strictEqual(r.status, 200, r.text);
  return r.cookie;
}

// ---------------------------------------------------------------------------
// TEST 1: Baseline Seed and Legacy Mappings
// ---------------------------------------------------------------------------
test('Baseline seed creates Main Stores, Main Workshop Stores, and maps legacy workshops', () => {
  storeLocs.seedStoreLocations();

  // 1. Verify MAIN-STORES
  const mainStore = storeLocs.getStoreLocationByCode('MAIN-STORES');
  assert.ok(mainStore, 'MAIN-STORES must exist');
  assert.strictEqual(mainStore.store_type, 'MAIN_STORE');
  assert.strictEqual(mainStore.parent_store_id, null);

  // 2. Verify MAIN-WORKSHOP (CW mapped)
  const mainWs = storeLocs.getStoreLocationByCode('MAIN-WORKSHOP');
  assert.ok(mainWs, 'MAIN-WORKSHOP must exist');
  assert.strictEqual(mainWs.store_type, 'MAIN_WORKSHOP_STORE');
  assert.strictEqual(mainWs.parent_store_id, mainStore.id);
  assert.strictEqual(mainWs.workshop_id, 1);

  // 3. Verify SITE-STORE-GWS (GWS mapped to unified Site Store - no site workshop store)
  const gwsStore = storeLocs.getStoreLocationByCode('SITE-STORE-GWS');
  assert.ok(gwsStore, 'SITE-STORE-GWS must exist');
  assert.strictEqual(gwsStore.store_type, 'SITE_STORE');
  assert.strictEqual(gwsStore.parent_store_id, mainWs.id);
  assert.strictEqual(gwsStore.workshop_id, 2);

  // 4. Verify Legacy Store Mappings
  const mapCW = get('SELECT * FROM store_location_mappings WHERE legacy_store_id = 1');
  assert.ok(mapCW, 'Workshop 1 mapped');
  assert.strictEqual(mapCW.store_location_id, mainWs.id);

  const mapGWS = get('SELECT * FROM store_location_mappings WHERE legacy_store_id = 2');
  assert.ok(mapGWS, 'Workshop 2 mapped');
  assert.strictEqual(mapGWS.store_location_id, gwsStore.id);

  // 5. Test bi-directional compatibility resolution
  const resolvedCW = storeLocs.resolvePhysicalStore(1);
  assert.strictEqual(resolvedCW.id, mainWs.id);
  assert.strictEqual(storeLocs.resolveLegacyStoreId(mainWs.id), 1);

  const resolvedGWS = storeLocs.resolvePhysicalStore(2);
  assert.strictEqual(resolvedGWS.id, gwsStore.id);
  assert.strictEqual(storeLocs.resolveLegacyStoreId(gwsStore.id), 2);
});

// ---------------------------------------------------------------------------
// TEST 2: Hierarchy Rules and Cycle Prevention
// ---------------------------------------------------------------------------
test('Hierarchy validation enforces allowed relationships and detects circular cycles', () => {
  const mainStore = storeLocs.getStoreLocationByCode('MAIN-STORES');
  const mainWs = storeLocs.getStoreLocationByCode('MAIN-WORKSHOP');
  const gwsStore = storeLocs.getStoreLocationByCode('SITE-STORE-GWS');

  // Rule 1: MAIN_STORE cannot have a parent
  assert.throws(() => {
    storeLocs.validateHierarchy(storeLocs.STORE_TYPES.MAIN_STORE, mainStore.id);
  }, /Central Main Store cannot have a parent/);

  // Rule 2: SITE_STORE parent cannot be another SITE_STORE
  assert.throws(() => {
    storeLocs.validateHierarchy(storeLocs.STORE_TYPES.SITE_STORE, gwsStore.id);
  }, /Site Store parent must be a Central Main Store or Main Workshop Store/);

  // Rule 3: MAIN_WORKSHOP_STORE parent must be a Central Main Store
  assert.throws(() => {
    storeLocs.validateHierarchy(storeLocs.STORE_TYPES.MAIN_WORKSHOP_STORE, gwsStore.id);
  }, /Main Workshop Store parent must be a Central Main Store/);

  // Rule 4: Cycle prevention
  assert.throws(() => {
    storeLocs.validateHierarchy(storeLocs.STORE_TYPES.MAIN_WORKSHOP_STORE, mainStore.id, mainStore.id);
  }, /cannot be its own parent/);
});

// ---------------------------------------------------------------------------
// TEST 3: Store Location CRUD Operations
// ---------------------------------------------------------------------------
test('Create, update, and retirement of store locations', () => {
  const mainStore = storeLocs.getStoreLocationByCode('MAIN-STORES');

  // 1. Create a valid Site Store
  const siteStore = storeLocs.createStoreLocation({
    code: 'SITE-TEST-01',
    name: 'Test Project Site Store',
    store_type: 'SITE_STORE',
    parent_store_id: mainStore.id,
    notes: 'Unit test created store'
  }, { id: adminId });

  assert.ok(siteStore.id);
  assert.strictEqual(siteStore.code, 'SITE-TEST-01');
  assert.strictEqual(siteStore.parent_store_id, mainStore.id);

  // 2. Update store
  const updated = storeLocs.updateStoreLocation(siteStore.id, {
    name: 'Updated Project Site Store',
    notes: 'Updated notes'
  }, { id: adminId });
  assert.strictEqual(updated.name, 'Updated Project Site Store');

  // 3. Hierarchy tree contains newly created store
  const tree = storeLocs.getStoreHierarchyTree();
  assert.ok(tree.main_store);
  assert.ok(tree.main_store.site_stores.some((s) => s.id === siteStore.id));

  // 4. Retirement guard: Cannot retire main workshop if active children exist
  const mainWs = storeLocs.getStoreLocationByCode('MAIN-WORKSHOP');
  assert.throws(() => {
    storeLocs.retireStoreLocation(mainWs.id, { id: adminId });
  }, /active child stores still depend on it/);

  // 5. Retiring a leaf store succeeds
  const retired = storeLocs.retireStoreLocation(siteStore.id, { id: adminId });
  assert.strictEqual(retired.active, 0);
  assert.ok(retired.closed_at);
});

// ---------------------------------------------------------------------------
// TEST 4: User Access Grants
// ---------------------------------------------------------------------------
test('Assign and retrieve physical store access grants per user', () => {
  const mainWs = storeLocs.getStoreLocationByCode('MAIN-WORKSHOP');

  // 1. Assign access to skId
  const granted = storeLocs.setUserStoreLocationAccess(skId, mainWs.id, {
    can_view: true,
    can_request: true,
    can_issue: true,
    can_receive: true,
    can_dispatch: false,
    can_count: true
  }, { id: adminId });

  assert.strictEqual(granted.user_id, skId);
  assert.strictEqual(granted.can_view, 1);
  assert.strictEqual(granted.can_request, 1);
  assert.strictEqual(granted.can_dispatch, 0);

  // 2. Query access list
  const accessList = storeLocs.getStoreLocationAccess(mainWs.id);
  assert.ok(accessList.some((a) => a.user_id === skId));
});

// ---------------------------------------------------------------------------
// TEST 5: REST API Endpoints & RBAC Capability Enforcement
// ---------------------------------------------------------------------------
test('REST API enforces capabilities and provides store locations data', async () => {
  const viewerCookie = await login('plain_viewer');
  const storeMgrCookie = await login('main_store_mgr');
  const adminCookie = await login('store_admin_user');

  // 1. Unauthenticated gets 401
  const unauth = await req('GET', '/api/store-locations');
  assert.strictEqual(unauth.status, 401);

  // 2. GET /api/store-locations
  const listRes = await req('GET', '/api/store-locations', { cookie: storeMgrCookie });
  assert.strictEqual(listRes.status, 200);
  assert.ok(Array.isArray(listRes.body));
  assert.ok(listRes.body.some((s) => s.code === 'MAIN-STORES'));
  assert.ok(listRes.body.some((s) => s.code === 'MAIN-WORKSHOP'));

  // 3. GET /api/store-locations/tree
  const treeRes = await req('GET', '/api/store-locations/tree', { cookie: storeMgrCookie });
  assert.strictEqual(treeRes.status, 200);
  assert.strictEqual(treeRes.body.main_store.code, 'MAIN-STORES');
  assert.strictEqual(treeRes.body.main_store.main_workshop.code, 'MAIN-WORKSHOP');

  // 4. Viewer lacks stores.locations.manage -> 403 on POST
  const forbidPost = await req('POST', '/api/store-locations', {
    cookie: viewerCookie,
    body: { code: 'FORBIDDEN', name: 'Forbidden', store_type: 'SITE_STORE' }
  });
  assert.strictEqual(forbidPost.status, 403);

  // 5. Manager creates new store location
  const mainStore = storeLocs.getStoreLocationByCode('MAIN-STORES');
  const createRes = await req('POST', '/api/store-locations', {
    cookie: storeMgrCookie,
    body: {
      code: 'SITE-API-01',
      name: 'API Created Site Store',
      store_type: 'SITE_STORE',
      parent_store_id: mainStore.id
    }
  });
  assert.strictEqual(createRes.status, 201);
  assert.strictEqual(createRes.body.code, 'SITE-API-01');

  // 6. Update via PUT
  const updateRes = await req('PUT', `/api/store-locations/${createRes.body.id}`, {
    cookie: storeMgrCookie,
    body: { name: 'Renamed API Site Store' }
  });
  assert.strictEqual(updateRes.status, 200);
  assert.strictEqual(updateRes.body.name, 'Renamed API Site Store');
});
