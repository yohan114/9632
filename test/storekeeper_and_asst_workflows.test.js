'use strict';

/**
 * End-to-end tests for:
 *   1. Storekeeper user creation & full permissions:
 *      - Request MRN, Pre-approval MRN edit, MRN line image upload
 *      - Receive GRN (with attached invoice image & standalone photo upload)
 *      - Price Add (GRN unit_price, bulk-price, general item price, oil product price, filter price)
 *      - Other Stores Permissions (`stores.all` + multi-store `store_location_access` grants):
 *        switch stores, view other store stock, create GRN in other stores, MTN dispatch/receive/accept across stores
 *      - Contrast: single-store `site_storekeeper` blocked (403) from other store's receipts
 *   2. Assistant Transport Manager (`assistant_transport_manager` + Migration 058):
 *      - Role grants & migration upgrade path + revocation persistence
 *      - Add & Edit Assets + Asset photo gallery upload (and 403 on delete)
 *      - Add & Edit Projects + Add Project Sites
 *      - Request Job Card (`POST /api/job-requests`)
 *      - Before-approval Edit (`PATCH /api/job-requests/:id`):
 *        * while `requested` -> stays `requested`
 *        * while `certified` -> succeeds and withdraws certification back to `requested`
 *        * after `approved` -> blocked with `409`
 *      - Cancel own uncertified request (`DELETE /api/job-requests/:id`), blocked after approval (`409`)
 *      - Breakdown reporting (`POST /api/field/breakdown`)
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-sk-asst-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, run, get, all, db, rawDb } = require('../src/db');
const auth = require('../src/lib/auth');
const permissions = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');
const storeLocations = require('../src/lib/store_locations');
const m058 = require('../src/migrate/058_assistant_transport_assets_projects_jr_edit');

migrate();

const BUILT_IN = Object.keys(permissions.DEFAULT_MATRIX);
for (const n of ['admin', ...BUILT_IN]) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, `Built-in ${n}`);
}
capabilities.seedCapabilities();
permissions.seedDefaults();
storeLocations.seedStoreLocations(db);

// Seed extra site store so stores 1, 2, 3, 4 exist
run(`INSERT OR IGNORE INTO store_locations (id, code, name, store_type, active)
     VALUES (3, 'SITE-CEP03', 'CEP-03 Site Store', 'SITE_STORE', 1)`);
run(`INSERT OR IGNORE INTO store_locations (id, code, name, store_type, active)
     VALUES (4, 'SITE-RUWAN', 'Ruwanwella Site Store', 'SITE_STORE', 1)`);

const PW = 'StrongPass!2026';

function createAccount(username, fullName, roles, opts = {}) {
  const wsId = opts.workshopId === undefined ? 1 : opts.workshopId;
  const uid = run(
    'INSERT INTO users (username, password_hash, full_name, active, must_change_password, workshop_id) VALUES (?, ?, ?, 1, 0, ?)',
    username, auth.hashPassword(PW), fullName, wsId
  ).lastInsertRowid;
  for (const r of roles) {
    run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
  }
  return uid;
}

const adminId = createAccount('admin_u', 'System Admin', ['admin']);
const skId = createAccount('storekeeper_u', 'Workshop Storekeeper', ['storekeeper']);
const siteSkId = createAccount('site_sk_u', 'Site 4 Storekeeper', ['site_storekeeper'], { workshopId: null });
run('UPDATE users SET workshop_id = NULL WHERE id = ?', siteSkId);
const asstId = createAccount('asst_u', 'Transport Assistant Manager', ['assistant_transport_manager']);
const engId = createAccount('eng_u', 'Workshop Engineer', ['workshop']);
const tmId = createAccount('tm_u', 'Transport Manager', ['transport_manager']);
const omId = createAccount('om_u', 'Operational Manager', ['operational_manager']);

// Grant Storekeeper user other-stores permissions (`stores.all` + multi-store `store_location_access`)
capabilities.setUserCapability(skId, 'stores.all', true);
for (const sid of [1, 2, 3, 4]) {
  storeLocations.setUserStoreLocationAccess(skId, sid, {
    can_view: 1, can_request: 1, can_issue: 1, can_receive: 1, can_dispatch: 1, can_count: 1,
  }, { id: adminId });
}

// Lock site_sk_u strictly to Store 4
storeLocations.setUserStoreLocationAccess(siteSkId, 4, {
  can_view: 1, can_request: 1, can_issue: 1, can_receive: 1, can_dispatch: 0, can_count: 1,
}, { id: adminId });

// Seed baseline master data for pricing & asset tests
const projId = run("INSERT INTO projects (code, name, location, active) VALUES ('PRJ-BASE', 'Baseline Project', 'Colombo', 1)").lastInsertRowid;
const assetId = run("INSERT INTO assets (code, code_norm, registration, status, in_register, current_project_id) VALUES ('WP-1001', 'WP1001', 'WP-1001', 'active', 1, ?)", projId).lastInsertRowid;
const genItemId = run("INSERT INTO store_items (name, unit, is_general, balance, unit_cost) VALUES ('Heavy Grease Cartridge', 'nos', 1, 10, 500)").lastInsertRowid;
const oilProdId = run("INSERT INTO products (code, name, unit, category, unit_price, stock_qty, active) VALUES ('OIL-15W40', '15W-40 Diesel Oil', 'L', 'Engine Oil', 1200, 50, 1)").lastInsertRowid;

// 1x1 tiny PNG base64 data URL
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const app = require('../src/server');
let server;
let base;
const cookies = {};

async function login(username) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PW }),
  });
  assert.strictEqual(r.status, 200, `Login failed for ${username}`);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

async function api(cookie, p, { method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(`${base}/api${p}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      cookie,
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, text };
}

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const u of ['admin_u', 'storekeeper_u', 'site_sk_u', 'asst_u', 'eng_u', 'tm_u', 'om_u']) {
    cookies[u] = await login(u);
  }
});

test.after(() => {
  if (server) server.close();
  try { rawDb.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// =========================================================================
// STOREKEEPER SUITE
// =========================================================================
test('Storekeeper has all requested capabilities & multi-store access', async () => {
  const me = await api(cookies.storekeeper_u, '/auth/me');
  assert.strictEqual(me.status, 200);
  const caps = me.body.caps || [];
  for (const reqCap of [
    'stores.mrn.create', 'stores.mrn.edit',
    'stores.grn.receive', 'stores.grn.edit',
    'general.items.price', 'oil.prices.edit', 'filters.prices.edit',
    'stores.mtn.edit', 'stores.all',
  ]) {
    assert.ok(caps.includes(reqCap), `Expected Storekeeper to hold capability ${reqCap}`);
  }
  assert.ok(me.body.isGlobalStoreScope || me.body.isAllSitesMode, 'Storekeeper with stores.all has global store scope');
});

test('Storekeeper workflow: MRN request + line photo -> approve -> GRN receive + invoice photo -> price add -> multi-store & MTN', async () => {
  // 1. Request MRN
  const mrnRes = await api(cookies.storekeeper_u, '/stores/mrn', {
    method: 'POST',
    headers: { 'x-store-location-id': '3' },
    body: {
      mrn_no: 'MRN-SK-101',
      asset_id: assetId,
      purpose: 'Filter & seal service for CEP-03',
      requested_by: 'Workshop Storekeeper',
      target_store_location_id: 3,
      lines: [
        { description: 'Fuel Filter FC-100', unit: 'nos', qty: 4, supply_route: 'local_purchase' },
      ],
    },
  });
  assert.strictEqual(mrnRes.status, 201, mrnRes.text);
  const mrnId = mrnRes.body.mrn.id;
  const lineId = mrnRes.body.lines[0].id;

  // 2. Upload photo to MRN line ("images add")
  const linePhotoRes = await api(cookies.storekeeper_u, `/stores/mrn-lines/${lineId}/photos`, {
    method: 'POST',
    body: { dataUrl: TINY_PNG, filename: 'old-filter.png', kind: 'sample', caption: 'Old sample photo' },
  });
  assert.strictEqual(linePhotoRes.status, 201, linePhotoRes.text);

  // Check MRN detail includes uploaded photo
  const mrnDet = await api(cookies.storekeeper_u, `/stores/mrn/${mrnId}`);
  assert.strictEqual(mrnDet.status, 200);
  assert.strictEqual(mrnDet.body.lines[0].photos.length, 1);

  // Certify (eng_u) -> Approve (om_u)
  assert.strictEqual((await api(cookies.eng_u, `/stores/mrn/${mrnId}/certify`, { method: 'POST', body: {} })).status, 200);
  assert.strictEqual((await api(cookies.om_u, `/stores/mrn/${mrnId}/approve`, { method: 'POST', body: {} })).status, 200);

  // 3. Receive GRN into OTHER store (Store 3) with inline invoice image attachment & unpriced first
  const grnRes = await api(cookies.storekeeper_u, '/stores/grn', {
    method: 'POST',
    body: {
      grn_no: 'GRN-SK-101',
      mrn_id: mrnId,
      mrn_line_id: lineId,
      physical_store_id: 3,
      supplier: 'Colombo Parts Ltd',
      description: 'Fuel Filter FC-100',
      qty: 4,
      unit: 'nos',
      received_date: '2026-11-14',
      attachments: [{ dataUrl: TINY_PNG, filename: 'invoice-101.png', kind: 'invoice', caption: 'Supplier Invoice' }],
    },
  });
  assert.strictEqual(grnRes.status, 201, grnRes.text);
  const grnId = grnRes.body.id;

  // Upload second photo directly via /grn/:id/photos ("images add")
  const grnPhotoRes = await api(cookies.storekeeper_u, `/stores/grn/${grnId}/photos`, {
    method: 'POST',
    body: { dataUrl: TINY_PNG, filename: 'goods-box.png', kind: 'goods', caption: 'Received goods box' },
  });
  assert.strictEqual(grnPhotoRes.status, 201, grnPhotoRes.text);

  const grnDet = await api(cookies.storekeeper_u, `/stores/grn/${grnId}`);
  assert.strictEqual(grnDet.status, 200);
  assert.strictEqual(grnDet.body.grn.physical_store_id, 3);
  assert.ok(grnDet.body.attachments.length >= 2, 'Both inline and direct GRN attachments saved');

  // Contrast check: Store-4-locked site_sk_u MUST be denied (403) reading/receiving in Store 3
  const siteSkMe = await api(cookies.site_sk_u, '/auth/me');
  assert.ok(!siteSkMe.body.isGlobalStoreScope, 'Site storekeeper must NOT have global store scope');
  const deniedPostGrn = await api(cookies.site_sk_u, '/stores/grn', {
    method: 'POST',
    body: {
      grn_no: 'GRN-DENIED-3',
      physical_store_id: 3,
      supplier: 'Denied Test',
      description: 'Fuel Filter FC-100',
      qty: 1,
      unit: 'nos',
      received_date: '2026-11-14',
      attachments: [{ dataUrl: TINY_PNG, filename: 'inv.png', kind: 'invoice' }],
    },
  });
  assert.strictEqual(deniedPostGrn.status, 403, `Site storekeeper must be refused receiving into Store 3: ${deniedPostGrn.text}`);

  // 4. Price Add (GRN PATCH, bulk-price, general item, oil product, filter price)
  const patchPrice = await api(cookies.storekeeper_u, `/stores/grn/${grnId}`, {
    method: 'PATCH',
    body: { unit_price: 2750, invoice_no: 'INV-101', invoice_date: '2026-11-14' },
  });
  assert.strictEqual(patchPrice.status, 200, patchPrice.text);
  assert.strictEqual(patchPrice.body.unit_price, 2750);

  // Direct GRN into Store 1 (`MAIN-STORES`) then bulk-price
  const directGrn = await api(cookies.storekeeper_u, '/stores/grn', {
    method: 'POST',
    body: {
      grn_no: 'GRN-SK-102',
      physical_store_id: 1,
      supplier: 'Lanka Oil Traders',
      description: 'Hydraulic Filter HF-22',
      qty: 6,
      unit: 'nos',
      received_date: '2026-11-14',
      attachments: [{ dataUrl: TINY_PNG, filename: 'inv-102.png', kind: 'invoice' }],
    },
  });
  assert.strictEqual(directGrn.status, 201, directGrn.text);
  const directGrnId = directGrn.body.id;

  const bulkPrice = await api(cookies.storekeeper_u, '/stores/grn/bulk-price', {
    method: 'POST',
    body: { rows: [{ id: directGrnId, unit_price: 3400, supplier: 'Lanka Oil Traders' }] },
  });
  assert.strictEqual(bulkPrice.status, 200, bulkPrice.text);
  assert.strictEqual(get('SELECT unit_price FROM grn WHERE id = ?', directGrnId).unit_price, 3400);

  // Price add on general item, oil product, and filter book
  const genPrice = await api(cookies.storekeeper_u, `/general-stock/items/${genItemId}/price`, {
    method: 'POST',
    body: { unit_cost: 680 },
  });
  assert.strictEqual(genPrice.status, 200, genPrice.text);
  assert.strictEqual(genPrice.body.unit_cost, 680);

  const oilPrice = await api(cookies.storekeeper_u, `/oil/products/${oilProdId}/prices`, {
    method: 'POST',
    body: { unit_price: 1450 },
  });
  assert.strictEqual(oilPrice.status, 201, oilPrice.text);
  assert.strictEqual(oilPrice.body.unit_price, 1450);

  const filterPrice = await api(cookies.storekeeper_u, '/filters/prices', {
    method: 'POST',
    body: { filter_no: 'FC-100', category: 'Fuel', unit_price: 2750 },
  });
  assert.strictEqual(filterPrice.status, 201, filterPrice.text);
  assert.strictEqual(filterPrice.body.unit_price, 2750);

  // 5. Other Stores Permissions: query Store 1, 2, 3 stock & execute cross-store MTN (Store 1 -> Store 4)
  for (const sid of [1, 2, 3, 4]) {
    const stStock = await api(cookies.storekeeper_u, `/store-locations/${sid}/stock?include_items=1`, {
      headers: { 'x-store-location-id': String(sid) },
    });
    assert.strictEqual(stStock.status, 200, `Storekeeper should read stock of store ${sid}`);
  }

  const mtnRes = await api(cookies.storekeeper_u, '/stores/mtn', {
    method: 'POST',
    body: {
      mtn_no: 'MTN-SK-101',
      from_store_location_id: 1,
      to_store_location_id: 4,
      description: 'Hydraulic Filter HF-22',
      qty: 2,
      unit: 'nos',
      txn_date: '2026-11-14',
      reason: 'Site replenishment',
    },
  });
  assert.strictEqual(mtnRes.status, 201, mtnRes.text);
  const mtnId = mtnRes.body.id;

  const mtnAppRes = await api(cookies.admin_u, `/stores/mtn/${mtnId}/approve`, { method: 'POST', body: {} });
  assert.strictEqual(mtnAppRes.status, 200, mtnAppRes.text);
  const dispRes = await api(cookies.storekeeper_u, `/stores/mtn/${mtnId}/dispatch`, {
    method: 'POST',
    headers: { 'x-store-location-id': '1' },
    body: { driver_name: 'Nimal' },
  });
  assert.strictEqual(dispRes.status, 200, dispRes.text);

  const recRes = await api(cookies.storekeeper_u, `/stores/mtn/${mtnId}/receive`, {
    method: 'POST',
    headers: { 'x-store-location-id': '4' },
    body: { received_by: 'Workshop Storekeeper' },
  });
  assert.strictEqual(recRes.status, 200, recRes.text);

  const accRes = await api(cookies.storekeeper_u, `/stores/mtn/${mtnId}/accept`, {
    method: 'POST',
    headers: { 'x-store-location-id': '4' },
    body: { accepted_by: 'Workshop Storekeeper' },
  });
  assert.strictEqual(accRes.status, 200, accRes.text);
});

// =========================================================================
// ASSISTANT TRANSPORT MANAGER SUITE & MIGRATION 058
// =========================================================================
test('Migration 058 upgrades assistant_transport_manager without clobbering subsequent admin revocations', () => {
  // Simulate pre-058 DB state
  permissions.setPermission('assistant_transport_manager', 'assets', 'view');
  permissions.setPermission('assistant_transport_manager', 'projects', 'view');
  for (const cap of ['assets.create', 'assets.edit', 'assets.photo.upload', 'projects.manage', 'jobrequests.edit']) {
    capabilities.setCapability('assistant_transport_manager', cap, false);
  }
  run("DELETE FROM settings WHERE key = 'migration_058_done'");

  const res = m058.runMigration(rawDb);
  assert.strictEqual(res.applied, true);
  assert.strictEqual(permissions.levelForRoles(['assistant_transport_manager'], 'assets'), 'edit');
  assert.strictEqual(permissions.levelForRoles(['assistant_transport_manager'], 'projects'), 'edit');
  const caps = capabilities.capsForRoles(['assistant_transport_manager']);
  for (const cap of ['assets.create', 'assets.edit', 'assets.photo.upload', 'projects.manage', 'jobrequests.edit']) {
    assert.ok(caps.includes(cap), `Migration 058 restored ${cap}`);
  }

  // Subsequent admin revocation persists across re-runs
  capabilities.setCapability('assistant_transport_manager', 'projects.manage', false);
  const second = m058.runMigration(rawDb);
  assert.strictEqual(second.applied, false);
  assert.ok(!capabilities.capsForRoles(['assistant_transport_manager']).includes('projects.manage'));

  // Restore clean grant for remaining tests
  capabilities.setCapability('assistant_transport_manager', 'projects.manage', true);
});

test('Assistant Transport Manager: add/edit assets + photo, add/edit projects + sites, request job card, before-approve edit (requested & certified), block after approve, breakdown', async () => {
  // 1. Add & Edit Project + Add Site
  const pAdd = await api(cookies.asst_u, '/projects', {
    method: 'POST',
    body: { code: 'PRJ-ASST-1', name: 'Galle Highway Contract', location: 'Galle' },
  });
  assert.strictEqual(pAdd.status, 201, pAdd.text);
  const newProjId = pAdd.body.id;

  const pEdit = await api(cookies.asst_u, `/projects/${newProjId}`, {
    method: 'PATCH',
    body: { code: 'PRJ-ASST-1A', name: 'Galle Highway Phase II', location: 'Matara', active: 1 },
  });
  assert.strictEqual(pEdit.status, 200, pEdit.text);
  assert.strictEqual(pEdit.body.name, 'Galle Highway Phase II');
  assert.strictEqual(pEdit.body.location, 'Matara');

  const sAdd = await api(cookies.asst_u, `/projects/${newProjId}/sites`, {
    method: 'POST',
    body: { name: 'Matara Yard', location: 'Km 125' },
  });
  assert.strictEqual(sAdd.status, 201, sAdd.text);

  // 2. Add & Edit Asset + Photo Upload (and Verify delete blocked)
  const aAdd = await api(cookies.asst_u, '/assets', {
    method: 'POST',
    body: {
      code: 'EC-ASST-99',
      type: 'Excavator',
      brand: 'CAT',
      registration: 'EC-ASST-99',
      current_project_id: newProjId,
      running_hours: 1200,
    },
  });
  assert.strictEqual(aAdd.status, 201, aAdd.text);
  const newAssetId = aAdd.body.id;

  const aEdit = await api(cookies.asst_u, `/assets/${newAssetId}`, {
    method: 'PATCH',
    body: { brand: 'Caterpillar 320D', running_hours: 1245, status: 'active', current_project_id: newProjId },
  });
  assert.strictEqual(aEdit.status, 200, aEdit.text);
  assert.strictEqual(aEdit.body.brand, 'Caterpillar 320D');
  assert.strictEqual(aEdit.body.running_hours, 1245);

  const aImg = await api(cookies.asst_u, `/assets/${newAssetId}/images`, {
    method: 'POST',
    body: { url: TINY_PNG, title: 'Front Boom Photo', category: 'inspection', description: 'Clean hydraulics' },
  });
  assert.strictEqual(aImg.status, 201, aImg.text);

  const aDelDenied = await api(cookies.asst_u, `/assets/${newAssetId}`, { method: 'DELETE' });
  assert.strictEqual(aDelDenied.status, 403, 'Assistant Transport Manager must not delete assets');

  // 3. Request Job Card & Pre-Approval Edits
  const jrCreate = await api(cookies.asst_u, '/job-requests', {
    method: 'POST',
    body: {
      jr_no: 'JR-ASST-901',
      asset_id: newAssetId,
      project_id: newProjId,
      type: 'repair',
      severity: 'minor',
      priority: 'normal',
      driver_name: 'Kasun',
      contact_no: '0771234567',
      meter_reading: '1245 hr',
      description: 'Boom cylinder slight oil leak',
    },
  });
  assert.strictEqual(jrCreate.status, 201, jrCreate.text);
  const jrId = jrCreate.body.request.id;

  // 3a. Before-approve edit #1 while still 'requested'
  const editDraft = await api(cookies.asst_u, `/job-requests/${jrId}`, {
    method: 'PATCH',
    body: {
      priority: 'urgent',
      meter_reading: '1250 hr',
      description: 'Boom cylinder heavy oil leak + seal kit needed',
    },
  });
  assert.strictEqual(editDraft.status, 200, editDraft.text);
  assert.strictEqual(editDraft.body.recertification_required, false);
  assert.strictEqual(editDraft.body.request.approval_status, 'requested');
  assert.strictEqual(editDraft.body.request.priority, 'urgent');

  // 3b. Certify by Transport Manager -> Before-approve edit #2 MUST withdraw certification
  const cert1 = await api(cookies.tm_u, `/job-requests/${jrId}/certify`, { method: 'POST', body: {} });
  assert.strictEqual(cert1.status, 200, cert1.text);
  assert.strictEqual(cert1.body.approval_status, 'certified');

  const editCert = await api(cookies.asst_u, `/job-requests/${jrId}`, {
    method: 'PATCH',
    body: {
      severity: 'major',
      description: 'Boom cylinder & bucket pin overhaul urgently needed',
    },
  });
  assert.strictEqual(editCert.status, 200, editCert.text);
  assert.strictEqual(editCert.body.recertification_required, true, 'Editing certified request withdraws certification');
  assert.strictEqual(editCert.body.request.approval_status, 'requested');
  assert.strictEqual(editCert.body.request.certified_by, null);

  // Operational Manager cannot approve until re-certified
  const premApprove = await api(cookies.om_u, `/job-requests/${jrId}/approve`, { method: 'POST', body: {} });
  assert.strictEqual(premApprove.status, 409);

  // Re-certify (tm_u) and Approve (om_u)
  assert.strictEqual((await api(cookies.tm_u, `/job-requests/${jrId}/certify`, { method: 'POST', body: {} })).status, 200);
  assert.strictEqual((await api(cookies.om_u, `/job-requests/${jrId}/approve`, { method: 'POST', body: {} })).status, 200);

  // 3c. AFTER approval: edit & delete are blocked (409 for approver/editor; 403 for asst delete without delete cap)
  const editAfterApprove = await api(cookies.asst_u, `/job-requests/${jrId}`, {
    method: 'PATCH',
    body: { description: 'Attempted late edit' },
  });
  assert.strictEqual(editAfterApprove.status, 409, 'Approved job request cannot be edited');

  const delAfterApproveAsst = await api(cookies.asst_u, `/job-requests/${jrId}`, { method: 'DELETE' });
  assert.strictEqual(delAfterApproveAsst.status, 403, 'Certified/approved delete denied without jobrequests.delete');

  const delAfterApproveOm = await api(cookies.om_u, `/job-requests/${jrId}`, { method: 'DELETE' });
  assert.strictEqual(delAfterApproveOm.status, 409, 'Approved job request cannot be deleted even with delete capability');

  // 3d. Own uncertified request CAN be cancelled/deleted pre-approval
  const jrDraft2 = await api(cookies.asst_u, '/job-requests', {
    method: 'POST',
    body: { jr_no: 'JR-ASST-902', asset_id: assetId, description: 'Duplicate request to cancel' },
  });
  assert.strictEqual(jrDraft2.status, 201);
  const delOwn = await api(cookies.asst_u, `/job-requests/${jrDraft2.body.request.id}`, { method: 'DELETE' });
  assert.strictEqual(delOwn.status, 200, delOwn.text);

  // 4. Report Field Breakdown (`jobs.breakdown`)
  const bd = await api(cookies.asst_u, '/field/breakdown', {
    method: 'POST',
    body: { asset_id: newAssetId, place: 'p:' + newProjId, description: 'Track shoe snapped at site' },
  });
  assert.strictEqual(bd.status, 201, bd.text);
  assert.strictEqual(bd.body.job.asset_id, newAssetId);
});
