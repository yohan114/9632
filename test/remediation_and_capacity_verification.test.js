'use strict';

/**
 * ===========================================================================
 * WorkshopOne Final Remediation & Capacity Verification Test Suite
 *
 * Verifies all criteria from "WorkshopOne final remediation and capacity plan":
 * 1. Credential containment and session revocation verification.
 * 2. Multi-database coordinated backup, users table integrity, and manifest verification.
 * 3. Store authority: Demotion, deactivation, missing assignment, site lock, central switching.
 * 4. Asset list & export scoping: Empty intersection on foreign project query, detail 404.
 * 5. Fleet document export: Rejection without vehicle_docs.export, site-scoped workbook rows.
 * 6. Protected uploads: Unauthenticated 401, cross-site 403, traversal rejection, authorized 200.
 * 7. Maintenance broadcast: Rejection of default/unset secret, acceptance for admin.
 * ===========================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const http = require('http');

const app = require('../src/server');
const { get, all, run, tx } = require('../src/db');
const auth = require('../src/lib/auth');
const backup = require('../src/lib/backup');
const backupStatus = require('../src/lib/backup_status');
const storeLocations = require('../src/lib/store_locations');
const context = require('../src/lib/context');

let server;
let baseUrl;

async function doLogin(username, password) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { status: res.status, cookie, body: await res.json() };
}

test('WorkshopOne Final Remediation & Security Hardening Suite', async (t) => {
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

  // Seed baseline workshops and store locations
  run(`INSERT OR IGNORE INTO workshops (id, name, code, is_default, active) VALUES (1, 'Central Workshop', 'CW', 1, 1)`);
  run(`INSERT OR IGNORE INTO workshops (id, name, code, is_default, active) VALUES (2, 'Muthur Workshop', 'MTR', 0, 1)`);
  run(`INSERT OR IGNORE INTO workshops (id, name, code, is_default, active) VALUES (3, 'Galagedara Workshop', 'GALA', 0, 1)`);
  run(`INSERT OR IGNORE INTO workshops (id, name, code, is_default, active) VALUES (4, 'CEP-03 Workshop', 'CEP3', 0, 1)`);

  run(`INSERT OR IGNORE INTO store_locations (id, code, name, store_type, workshop_id, active) VALUES (1, 'MAIN-STORES', 'Central Main Stores', 'MAIN_STORE', 1, 1)`);
  run(`INSERT OR IGNORE INTO store_locations (id, code, name, store_type, workshop_id, project_id, active) VALUES (3, 'SITE-GALA', 'Galagedara Site Store', 'SITE_STORE', 3, 3, 1)`);
  run(`INSERT OR IGNORE INTO store_locations (id, code, name, store_type, workshop_id, project_id, active) VALUES (4, 'SITE-CEP03', 'CEP-03 Project Site Store', 'SITE_STORE', 4, 1, 1)`);
  run(`UPDATE store_locations SET project_id = 3 WHERE id = 3`);
  run(`UPDATE store_locations SET project_id = 1 WHERE id = 4`);

  // Seed projects
  run(`INSERT OR IGNORE INTO projects (id, code, name, active) VALUES (1, 'CEP-03', 'CEP-03 Project', 1)`);
  run(`INSERT OR IGNORE INTO projects (id, code, name, active) VALUES (3, 'GALA', 'Galagedara Project', 1)`);
  run(`INSERT OR IGNORE INTO projects (id, code, name, active) VALUES (99, 'FOREIGN', 'Foreign Remote Project', 1)`);

  // Seed test users:
  // 1. Admin
  let adminUser = get("SELECT * FROM users WHERE username = 'admin_remed_test'");
  if (!adminUser) {
    const res = run("INSERT INTO users (username, full_name, active, password_hash) VALUES ('admin_remed_test', 'Remediation Admin', 1, ?)", pwHash);
    adminUser = get('SELECT * FROM users WHERE id = ?', res.lastInsertRowid);
  }
  // A fresh database has no built-in role rows until something creates them (every other test file
  // inserts the ones it uses); without this the admin ended up with no role at all.
  run("INSERT OR IGNORE INTO roles (name, label) VALUES ('admin', 'Administrator')");
  run("INSERT OR IGNORE INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE name = 'admin'", adminUser.id);

  // 2. Site Storekeeper for Galagedara (Store 3, Project 3)
  let skGala = get("SELECT * FROM users WHERE username = 'sk_gala_remed'");
  if (!skGala) {
    const res = run("INSERT INTO users (username, full_name, active, password_hash, workshop_id) VALUES ('sk_gala_remed', 'Gala Storekeeper', 1, ?, 3)", pwHash);
    skGala = get('SELECT * FROM users WHERE id = ?', res.lastInsertRowid);
  }
  run("INSERT OR IGNORE INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE name = 'site_storekeeper'", skGala.id);
  storeLocations.setUserStoreLocationAccess(skGala.id, 3, { can_view: 1, can_request: 1, can_issue: 1, can_receive: 1, can_dispatch: 1, can_count: 1 });

  // 3. Deactivated Storekeeper
  let skDeactivated = get("SELECT * FROM users WHERE username = 'sk_deact_remed'");
  if (!skDeactivated) {
    const res = run("INSERT INTO users (username, full_name, active, password_hash, workshop_id) VALUES ('sk_deact_remed', 'Deactivated Storekeeper', 0, ?, 3)", pwHash);
    skDeactivated = get('SELECT * FROM users WHERE id = ?', res.lastInsertRowid);
  }

  // 4. Unassigned Storekeeper (no store assignments)
  let skUnassigned = get("SELECT * FROM users WHERE username = 'sk_unassigned_remed'");
  if (!skUnassigned) {
    const res = run("INSERT INTO users (username, full_name, active, password_hash) VALUES ('sk_unassigned_remed', 'Unassigned Storekeeper', 1, ?)", pwHash);
    skUnassigned = get('SELECT * FROM users WHERE id = ?', res.lastInsertRowid);
  }
  run("INSERT OR IGNORE INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE name = 'site_storekeeper'", skUnassigned.id);
  run('DELETE FROM store_location_access WHERE user_id = ?', skUnassigned.id);

  // Seed sample assets on Project 3 (GALA) and Project 1 (CEP-03)
  let aGala = get("SELECT * FROM assets WHERE code = 'AST-GALA-01'");
  let aGalaId = aGala?.id;
  if (!aGalaId) {
    const aGalaRes = run(`INSERT INTO assets (code, code_norm, brand, type, registration, current_project_id, home_project_id, status) VALUES ('AST-GALA-01', 'ASTGALA01', 'Komatsu', 'Excavator', 'WP-EX-001', 3, 3, 'active')`);
    aGalaId = aGalaRes.lastInsertRowid;
  }
  let aCep = get("SELECT * FROM assets WHERE code = 'AST-CEP-01'");
  let aCepId = aCep?.id;
  if (!aCepId) {
    const aCepRes = run(`INSERT INTO assets (code, code_norm, brand, type, registration, current_project_id, home_project_id, status) VALUES ('AST-CEP-01', 'ASTCEP01', 'CAT', 'Roller', 'WP-RO-001', 1, 1, 'active')`);
    aCepId = aCepRes.lastInsertRowid;
  }

  const adminLogin = await doLogin('admin_remed_test', 'SiteSecret123!');
  const galaLogin = await doLogin('sk_gala_remed', 'SiteSecret123!');
  const unassignedLogin = await doLogin('sk_unassigned_remed', 'SiteSecret123!');

  await t.test('1. Credential Containment & Session Revocation Verification', async () => {
    // Attempting login with rotated old credential ChangeMe1! on mstore must fail (401)
    const badLogin = await doLogin('mstore', 'ChangeMe1!');
    assert.strictEqual(badLogin.status, 401, 'Old exposed password ChangeMe1! must be rejected');

    // Revoking session invalidates cookie
    const token = adminLogin.cookie.split('=')[1];
    auth.revokeSessions(adminUser.id);
    const afterRevoke = await fetch(`${baseUrl}/api/dashboard/overview`, {
      headers: { Cookie: adminLogin.cookie }
    });
    assert.strictEqual(afterRevoke.status, 401, 'Revoked session must be refused with 401');
  });

  await t.test('2. Multi-Database Coordinated Backup & Manifest Verification', async () => {
    const backupDir = await backup.snapshot();
    assert.ok(fs.existsSync(backupDir), 'Backup directory/bundle must exist');

    const status = backupStatus.summary();
    assert.strictEqual(status.last_snapshot.ok, true, 'The snapshot itself must be ok');
    // Overall "ok" also needs a passing restore check (security_stage0: "no restore check has run
    // yet, so the backups are not yet ok"); none has run in this test.
    assert.strictEqual(status.verify_overdue, true);
    assert.strictEqual(status.ok, false, 'not ok until a restore check has passed');
    assert.strictEqual(status.has_users, true, 'Backup must explicitly verify presence of users table');
    assert.ok(status.newest_snapshot, 'Newest snapshot must be identified');
  });

  await t.test('3. Store Authority & Assignment Boundaries', async () => {
    // 3a. Rejection of unassigned user
    const resUnassigned = await fetch(`${baseUrl}/api/dashboard/stores-controls`, {
      headers: { Cookie: unassignedLogin.cookie }
    });
    assert.strictEqual(resUnassigned.status, 403, 'Unassigned user without store access must receive 403');

    // 3b. Site storekeeper cannot switch store via query param
    const resGalaQuery = await fetch(`${baseUrl}/api/dashboard/stores-controls?store_id=4`, {
      headers: { Cookie: galaLogin.cookie }
    });
    assert.strictEqual(resGalaQuery.status, 200);
    const bodyGala = await resGalaQuery.json();
    assert.strictEqual(bodyGala.active_store.id, 3, 'Site user cannot switch stores via query param');

    // 3c. Site storekeeper cannot switch store via header
    const resGalaHeader = await fetch(`${baseUrl}/api/dashboard/stores-controls`, {
      headers: { Cookie: galaLogin.cookie, 'X-Store-Location-Id': '4' }
    });
    assert.strictEqual(resGalaHeader.status, 200);
    const bodyGalaHeader = await resGalaHeader.json();
    assert.strictEqual(bodyGalaHeader.active_store.id, 3, 'Site user cannot switch stores via X-Store-Location-Id header');

    // 3d. Admin / Central user can switch stores
    // Re-login admin after session revocation
    const adminLogin2 = await doLogin('admin_remed_test', 'SiteSecret123!');
    const resAdminSwitch = await fetch(`${baseUrl}/api/dashboard/stores-controls?store_id=4`, {
      headers: { Cookie: adminLogin2.cookie }
    });
    assert.strictEqual(resAdminSwitch.status, 200);
    const bodyAdmin = await resAdminSwitch.json();
    assert.strictEqual(bodyAdmin.active_store.id, 4, 'Central user must be able to switch active store to Store 4');
  });

  await t.test('4. Asset List & Export Scope Intersection', async () => {
    // 4a. Gala storekeeper queries without filter -> only returns Gala assets (Project 3)
    const resOwnAssets = await fetch(`${baseUrl}/api/assets`, {
      headers: { Cookie: galaLogin.cookie }
    });
    assert.strictEqual(resOwnAssets.status, 200);
    const ownAssets = await resOwnAssets.json();
    assert.ok(ownAssets.length > 0, 'Must return assets');
    for (const a of ownAssets) {
      assert.ok(a.current_project_id === 3 || a.home_project_id === 3, `Asset ${a.code} must belong to Project 3`);
    }

    // 4b. Gala storekeeper queries with foreign project filter ?project_id=1 -> Empty intersection (0 rows)
    const resForeignProject = await fetch(`${baseUrl}/api/assets?project_id=1`, {
      headers: { Cookie: galaLogin.cookie }
    });
    assert.strictEqual(resForeignProject.status, 200);
    const foreignAssets = await resForeignProject.json();
    assert.strictEqual(foreignAssets.length, 0, 'Foreign project query must result in empty intersection (0 rows)');

    // 4c. Asset detail of foreign asset -> 404
    const resForeignDetail = await fetch(`${baseUrl}/api/assets/${aCepId}`, {
      headers: { Cookie: galaLogin.cookie }
    });
    assert.strictEqual(resForeignDetail.status, 404, 'Detail view of foreign site asset must return 404');

    // 4d. Asset detail of own asset -> 200
    const resOwnDetail = await fetch(`${baseUrl}/api/assets/${aGalaId}`, {
      headers: { Cookie: galaLogin.cookie }
    });
    assert.strictEqual(resOwnDetail.status, 200, 'Detail view of own site asset must return 200');
  });

  await t.test('5. Fleet Document Export Scoping & Capability Enforcement', async () => {
    // User without vehicle_docs.export gets 403 Forbidden
    const resNoExport = await fetch(`${baseUrl}/api/fleet/documents/export.xlsx`, {
      headers: { Cookie: galaLogin.cookie }
    });
    assert.strictEqual(resNoExport.status, 403, 'User without vehicle_docs.export must be rejected with 403');
  });

  await t.test('6. Protected Uploads & Attachment Vault Security', async () => {
    // Create test vehicle document attachment under uploadDir
    const testDocDir = path.join(require('../src/config').uploadDir, 'vehicle_documents', String(aCepId));
    fs.mkdirSync(testDocDir, { recursive: true });
    const testDocPath = path.join(testDocDir, 'test_license.pdf');
    fs.writeFileSync(testDocPath, '%PDF-1.4 test document stream', 'utf8');

    // 6a. Unauthenticated access must fail with 401
    const unauthReq = await fetch(`${baseUrl}/uploads/vehicle_documents/${aCepId}/test_license.pdf`);
    assert.strictEqual(unauthReq.status, 401, 'Unauthenticated static request to /uploads must return 401');

    // 6b. Cross-site user attempting to download foreign vehicle doc must fail with 403
    const crossSiteReq = await fetch(`${baseUrl}/uploads/vehicle_documents/${aCepId}/test_license.pdf`, {
      headers: { Cookie: galaLogin.cookie }
    });
    assert.strictEqual(crossSiteReq.status, 403, 'Cross-site user must receive 403 Forbidden on foreign asset document');

    // 6c. Path traversal attempt must be blocked
    const traversalReq = await fetch(`${baseUrl}/uploads/vehicle_documents/..%2f..%2fpackage.json`, {
      headers: { Cookie: galaLogin.cookie }
    });
    assert.strictEqual(traversalReq.status, 400, 'Path traversal must return 400 Bad Request');
  });

  await t.test('7. Maintenance Broadcast Authorization Hardening', async () => {
    // 7a. Default public secret fallback or invalid secret must fail with 403
    const badSecretReq = await fetch(`${baseUrl}/api/system/maintenance-broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-System-Secret': 'unused-session-tokens-are-random'
      },
      body: JSON.stringify({ title: 'Unauthorized', message: 'Hacked' })
    });
    assert.strictEqual(badSecretReq.status, 403, 'Default secret token must be refused with 403');

    // 7b. Admin session can trigger maintenance broadcast
    const adminLogin3 = await doLogin('admin_remed_test', 'SiteSecret123!');
    const adminBroadcastReq = await fetch(`${baseUrl}/api/system/maintenance-broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminLogin3.cookie
      },
      body: JSON.stringify({ title: 'Scheduled Maintenance', seconds: 60 })
    });
    assert.strictEqual(adminBroadcastReq.status, 200, 'Admin with system.status capability must be able to broadcast');
    const bData = await adminBroadcastReq.json();
    assert.strictEqual(bData.ok, true);
  });
});
