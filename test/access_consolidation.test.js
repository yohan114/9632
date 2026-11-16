'use strict';

// ===========================================================================
// Access Control Consolidation Regression Suite:
//   1. `fabrication` (23rd canonical section) & `audit_logs` in section-matrix
//   2. `GET /api/access/people` & `:id` return `mfa_enabled`, `store_locations`,
//      allow `users.manage` alongside `access.manage`, and block unprivileged users
//   3. `POST /api/access/people/:id/save` does NOT overwrite existing granular
//      store_location_access flags on save
//   4. `GET /api/audit-logs` supports `category=access|auth|critical`, CSV entity
//      filters, Excel export with category, and scopes `access.manage`-only users
//   5. `public/app.js` & `public/index.html` ship the 4-tab layout & cache bump
// ===========================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-access-cons-'));
process.env.DB_PATH = path.join(TMP, 'access-cons.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');
const permissions = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');
const storeLocs = require('../src/lib/store_locations');
const audit = require('../src/lib/audit');

migrate();
permissions.seedDefaults();
capabilities.seedCapabilities();

for (const n of ['admin', 'viewer', 'workshop']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, n);
}
run("INSERT OR IGNORE INTO roles (name, label) VALUES ('user_admin', 'User Admin')");
run("INSERT OR IGNORE INTO role_permissions (role, module, level) VALUES ('user_admin', 'users', 'full')");
run("INSERT OR IGNORE INTO role_capabilities (role, capability, granted) VALUES ('user_admin', 'users.manage', 1)");

run("INSERT OR IGNORE INTO roles (name, label) VALUES ('access_mgr', 'Access Manager')");
run("INSERT OR IGNORE INTO role_permissions (role, module, level) VALUES ('access_mgr', 'access', 'full')");
run("INSERT OR IGNORE INTO role_capabilities (role, capability, granted) VALUES ('access_mgr', 'access.manage', 1)");

const PW = 'amber-falcon-9921';
const U = {};
const mkUser = (name, roleList, fullName = null) => {
  U[name] = run(
    'INSERT INTO users (username, full_name, password_hash, active, must_change_password) VALUES (?, ?, ?, 1, 0)',
    name, fullName || name, auth.hashPassword(PW)
  ).lastInsertRowid;
  for (const r of roleList) {
    run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', U[name], r);
  }
};

mkUser('boss', ['admin'], 'Boss Admin');
mkUser('uadmin', ['user_admin'], 'User Admin Only');
mkUser('amgr', ['access_mgr'], 'Access Manager Only');
mkUser('target', ['workshop'], 'Target Worker');
mkUser('plain', ['viewer'], 'Plain Viewer');

// Seed an extra store location so we have an unassigned store too
const mainStore = get("SELECT id FROM store_locations ORDER BY id LIMIT 1");
assert.ok(mainStore, 'default store location exists');
const secondStoreId = Number(run(
  "INSERT INTO store_locations (code, name, store_type, workshop_id, active) VALUES ('SITE-CONS', 'Site Test Store', 'SITE_STORE', 1, 1)"
).lastInsertRowid);

// Seed a non-access audit entry and an access/session audit entry
audit.record({
  userId: U.boss,
  entity: 'job_card',
  entityId: 9001,
  action: 'delete_test',
  reason: 'test non-access entry',
  after: { job_no: '2026/1/R/99' },
});
const nonAccessAuditId = get("SELECT id FROM audit_log WHERE entity = 'job_card' AND entity_id = 9001 ORDER BY id DESC LIMIT 1").id;
audit.record({
  userId: U.boss,
  entity: 'session',
  entityId: U.boss,
  action: 'login',
  after: { method: 'password' },
});
audit.record({
  userId: U.boss,
  entity: 'role',
  entityId: 1,
  action: 'update',
  reason: 'test governance update',
  after: { role: 'workshop' },
});

const app = require('../src/server');
let server;
let base;
const cookies = {};

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const u of Object.keys(U)) {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u, password: PW }),
    });
    assert.strictEqual(r.status, 200, u);
    cookies[u] = (r.headers.get('set-cookie') || '').split(';')[0];
  }
});

test.after(() => server && server.close());

const call = async (who, method, p, body) => {
  const r = await fetch(base + '/api' + p, {
    method,
    headers: { 'content-type': 'application/json', cookie: cookies[who] },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, headers: r.headers };
};

test('1. /api/access/section-matrix includes fabrication and audit_logs', async () => {
  const r = await call('boss', 'GET', '/access/section-matrix');
  assert.strictEqual(r.status, 200);
  const fab = r.body.sections.find((s) => s.id === 'fabrication');
  assert.ok(fab, 'fabrication section present in FUNCTIONAL_SECTIONS');
  assert.deepStrictEqual(fab.modules, ['fabrication', 'fabrication_costing']);
  const acc = r.body.sections.find((s) => s.id === 'access');
  assert.ok(acc && acc.modules.includes('audit_logs'), 'access section includes audit_logs');
});

test('2. /api/access/people & :id expose mfa_enabled and store_locations and allow users.manage', async () => {
  const adminRes = await call('boss', 'GET', '/access/people');
  assert.strictEqual(adminRes.status, 200);
  const t = adminRes.body.people.find((p) => p.id === U.target);
  assert.ok(t, 'target returned in people list');
  assert.strictEqual(typeof t.mfa_enabled, 'boolean');
  assert.ok(Array.isArray(t.store_locations));

  const uaRes = await call('uadmin', 'GET', '/access/people');
  assert.strictEqual(uaRes.status, 200);

  const uaDetail = await call('uadmin', 'GET', `/access/people/${U.target}`);
  assert.strictEqual(uaDetail.status, 200);
  assert.strictEqual(typeof uaDetail.body.user.mfa_enabled, 'boolean');

  const viewerRes = await call('plain', 'GET', '/access/people');
  assert.strictEqual(viewerRes.status, 403);
});

test('3. POST /api/access/people/:id/save preserves existing granular store_location_access flags', async () => {
  const actor = { id: U.boss, username: 'boss' };
  storeLocs.setUserStoreLocationAccess(
    U.target,
    mainStore.id,
    { can_view: 1, can_receive: 0, can_issue: 1, can_dispatch: 0, can_count: 1, can_request: 0 },
    actor
  );

  // Saving overrides + approval limit (and even sending already-assigned store_location_id) must NOT clobber granular flags
  const saveRes = await call('boss', 'POST', `/access/people/${U.target}/save`, {
    sections: { stores: 'edit' },
    capabilities: {},
    approval_limit: 25000,
    store_location_id: mainStore.id,
  });
  assert.strictEqual(saveRes.status, 200);

  const storesAfter = storeLocs.getUserStoreLocations(U.target);
  const mainRow = storesAfter.find((s) => Number(s.store_location_id) === Number(mainStore.id));
  assert.ok(mainRow, 'store assignment still exists');
  assert.strictEqual(mainRow.can_receive, 0, 'custom can_receive=0 must NOT be overwritten to 1');
  assert.strictEqual(mainRow.can_dispatch, 0, 'custom can_dispatch=0 must NOT be overwritten to 1');
  assert.strictEqual(mainRow.can_request, 0, 'custom can_request=0 must NOT be overwritten to 1');
  assert.strictEqual(mainRow.can_issue, 1);

  // Assigning a genuinely unassigned store via save initializes default store flags
  const assignNew = await call('boss', 'POST', `/access/people/${U.target}/save`, {
    sections: {},
    capabilities: {},
    store_location_id: secondStoreId,
  });
  assert.strictEqual(assignNew.status, 200);
  const storesAfterNew = storeLocs.getUserStoreLocations(U.target);
  const newRow = storesAfterNew.find((s) => Number(s.store_location_id) === secondStoreId);
  assert.ok(newRow && newRow.can_view === 1, 'new unassigned store gets default assignment');
});

test('4. /api/audit-logs supports presets and scopes access.manage-only users safely', async () => {
  const accessRes = await call('boss', 'GET', '/audit-logs?category=access');
  assert.strictEqual(accessRes.status, 200);
  assert.ok(accessRes.body.logs.every((l) => l.entity !== 'job_card' && l.entity !== 'session'));

  const authRes = await call('boss', 'GET', '/audit-logs?category=auth');
  assert.strictEqual(authRes.status, 200);
  assert.ok(authRes.body.logs.length > 0 && authRes.body.logs.every((l) => l.entity === 'session'));

  const critRes = await call('boss', 'GET', '/audit-logs?category=critical');
  assert.strictEqual(critRes.status, 200);
  assert.ok(critRes.body.logs.some((l) => l.action === 'delete_test'));

  const csvRes = await call('boss', 'GET', '/audit-logs?entity=role,session');
  assert.strictEqual(csvRes.status, 200);
  assert.ok(csvRes.body.logs.every((l) => l.entity === 'role' || l.entity === 'session'));

  // access.manage user without audit.logs.view can view access logs (and export), but NOT job_card audit entries
  const mgrLogs = await call('amgr', 'GET', '/audit-logs?category=all');
  assert.strictEqual(mgrLogs.status, 200);
  assert.strictEqual(mgrLogs.body.can_view_all, false);
  assert.ok(mgrLogs.body.logs.every((l) => l.entity !== 'job_card' && l.entity !== 'session'));

  const mgrStats = await call('amgr', 'GET', '/audit-logs/stats');
  assert.strictEqual(mgrStats.status, 200);
  assert.strictEqual(mgrStats.body.can_view_all, false);

  const deniedDetail = await call('amgr', 'GET', `/audit-logs/${nonAccessAuditId}`);
  assert.strictEqual(deniedDetail.status, 403);

  const exportRes = await fetch(`${base}/api/audit-logs/export.xlsx?category=access`, {
    headers: { cookie: cookies.amgr },
  });
  assert.strictEqual(exportRes.status, 200);
});

test('5. Consolidated 4-tab UI and versioned bundle script present', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(indexHtml, /\/app\.js\?v=([6-9]|\d{2,})/, 'index.html busts service worker cache');

  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!appJs.includes("['auditlogs', '🛡️', 'User Activity Logs'"), 'duplicate sidebar nav item removed');
  assert.ok(appJs.includes("tabs.push(['people', '👥 Users & Access'])"));
  assert.ok(appJs.includes("tabs.push(['roles', '🛡️ Roles, Matrix & Limits'])"));
  assert.ok(appJs.includes("tabs.push(['governance', '🔍 Inspector & Hand-overs'])"));
  assert.ok(appJs.includes("tabs.push(['auditlogs', '📜 Security & Audit Trail'])"));
});
