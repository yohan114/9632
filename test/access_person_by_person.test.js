'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-access-'));
process.env.DB_PATH = path.join(TMP, 'access.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const permissions = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');
const accessRules = require('../src/lib/access_rules');

migrate();
require('../src/migrate/015_phase4_erp_gaps').runStep();
require('../src/migrate/26_subcategories').runStep();

// Ensure roles exist
for (const n of ['admin', 'workshop', 'storekeeper', 'viewer', 'management', 'accounts']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Role ' + n);
}

const PW = 'password-secret-123';
function mkUser(username, roleNames, extra = {}) {
  const id = run(
    'INSERT INTO users (username, password_hash, active, access_until, approval_limit) VALUES (?, ?, 1, ?, ?)',
    username,
    auth.hashPassword(PW),
    extra.access_until || null,
    extra.approval_limit !== undefined ? extra.approval_limit : null
  ).lastInsertRowid;
  for (const r of roleNames) {
    run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  }
  return id;
}

function getUser(id) {
  const u = get('SELECT id, username, active, access_until, approval_limit, workshop_id FROM users WHERE id = ?', id);
  if (!u) return null;
  return { ...u, roles: auth.rolesForUser(id) };
}

const adminId = mkUser('admin_user', ['admin']);
const wsUser1Id = mkUser('ws_tech1', ['workshop']);
const wsUser2Id = mkUser('ws_tech2', ['workshop']);
const viewerId = mkUser('viewer_user', ['viewer']);
const unprivUserId = mkUser('unpriv_user', ['storekeeper']);
permissions.setUserPermission(unprivUserId, 'projects', 'none', adminId, 'No projects access');
const expiringUserId = mkUser('temp_worker', ['workshop'], { access_until: '2020-01-01T00:00:00Z' });

// Add dummy mechanics and projects
run("INSERT INTO mechanics (name, name_norm, active) VALUES ('John Mechanic', 'JOHNMECHANIC', 1)");
run("INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('John Mechanic', 450.00, '2020-01-01')");
run("INSERT INTO projects (code, name, active) VALUES ('PRJ-01', 'Highway Construction', 1)");

const app = require('../src/server');
let server;
let port;

test.before(async () => {
  await new Promise((res) => {
    server = app.listen(0, '127.0.0.1', res);
  });
  port = server.address().port;
});

test.after(() => {
  server && server.close();
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
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* not json */ }
        const sc = res.headers['set-cookie'];
        resolve({ status: res.statusCode, headers: res.headers, body: json, text: buf, cookie: sc ? sc[0].split(';')[0] : null });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const cookies = {};
async function as(user) {
  if (!cookies[user]) {
    const res = await req('POST', '/api/auth/login', { body: { username: user, password: PW } });
    cookies[user] = res.cookie;
  }
  return cookies[user];
}

// ---------------------------------------------------------------- Canonical 22 sections & 5 levels
test('Canonical 22 sections and 5 clearance levels are defined correctly', () => {
  assert.strictEqual(permissions.SECTIONS.length, 22);
  assert.deepStrictEqual(permissions.LEVELS, ['none', 'view', 'add', 'edit', 'full']);

  assert.strictEqual(permissions.rank('none'), 0);
  assert.strictEqual(permissions.rank('view'), 1);
  assert.strictEqual(permissions.rank('add'), 2);
  assert.strictEqual(permissions.rank('edit'), 3);
  assert.strictEqual(permissions.rank('full'), 4);
  assert.strictEqual(permissions.rank('unknown'), 0);

  // Check section properties
  for (const sec of permissions.SECTIONS) {
    assert.ok(sec.key, 'Section must have key');
    assert.ok(sec.label, 'Section must have label');
    assert.ok(sec.group, 'Section must have group');
    assert.ok(sec.icon, 'Section must have icon');
  }
});

test('Day-one parity: default clearances match for roles', () => {
  const adminUser = getUser(adminId);
  for (const sec of permissions.SECTIONS) {
    assert.strictEqual(permissions.effectiveLevel(adminUser, sec.key), 'full');
  }

  const viewerUser = getUser(viewerId);
  assert.strictEqual(permissions.effectiveLevel(viewerUser, 'jobs'), 'view');
  assert.strictEqual(permissions.effectiveLevel(viewerUser, 'users'), 'none');
  assert.strictEqual(permissions.effectiveLevel(viewerUser, 'reports'), 'view');
});

// ---------------------------------------------------------------- Person overrides & expiry
test('Personal overrides elevate or restrict user access over role template', () => {
  const wsUser = getUser(wsUser1Id);
  // Default workshop role has 'none' on 'purchasing'
  assert.strictEqual(permissions.effectiveLevel(wsUser, 'purchasing'), 'none');

  // Override to 'edit'
  permissions.setUserPermission(wsUser1Id, 'purchasing', 'edit', adminId, 'Granted for procurement lead');
  const wsUserUpdated = getUser(wsUser1Id);
  assert.strictEqual(permissions.effectiveLevel(wsUserUpdated, 'purchasing'), 'edit');

  // Override to 'none' on 'jobs' (restriction)
  permissions.setUserPermission(wsUser1Id, 'jobs', 'none', adminId, 'Suspended from jobs');
  const wsUserRestricted = getUser(wsUser1Id);
  assert.strictEqual(permissions.effectiveLevel(wsUserRestricted, 'jobs'), 'none');

  // Clear specific override
  permissions.removeUserPermission(wsUser1Id, 'jobs');
  const wsUserRestored = getUser(wsUser1Id);
  assert.strictEqual(permissions.effectiveLevel(wsUserRestored, 'jobs'), 'edit'); // default for workshop role
});

test('Expired access_until revokes all access to none', () => {
  const expiredUser = getUser(expiringUserId);
  assert.ok(permissions.isAccessExpired(expiredUser));
  assert.strictEqual(permissions.effectiveLevel(expiredUser, 'jobs'), 'none');
  assert.strictEqual(permissions.effectiveLevel(expiredUser, 'dashboard'), 'none');
});

// ---------------------------------------------------------------- Safety rules
test('Safety rules: assertNotSelf rejects self-modification', () => {
  assert.throws(
    () => accessRules.assertNotSelf({ id: 5, username: 'tester' }, 5),
    (err) => err.status === 403
  );

  // Different user is allowed
  assert.doesNotThrow(() => accessRules.assertNotSelf({ id: 5, username: 'tester' }, 6));
});

test('Safety rules: assertCanSetLevel forbids granting higher level than held', () => {
  const limitedActor = { id: 10, roles: ['workshop'] }; // workshop holds edit on jobs, none on users
  // Can set edit on jobs
  assert.doesNotThrow(() => accessRules.assertCanSetLevel(limitedActor, 'jobs', 'edit'));
  // Cannot set full on jobs
  assert.throws(
    () => accessRules.assertCanSetLevel(limitedActor, 'jobs', 'full'),
    (err) => err.status === 403
  );
  // Cannot set anything above none on users
  assert.throws(
    () => accessRules.assertCanSetLevel(limitedActor, 'users', 'view'),
    (err) => err.status === 403
  );
});

// ---------------------------------------------------------------- Gated Endpoints & Security Holes
test('Security Gap 1: unprivileged users cannot POST to monthly-inputs or service-outside', async () => {
  const viewerCookie = await as('viewer_user');

  const resInputs = await req('POST', '/api/reports/monthly-inputs', {
    body: { month: '2026-09', overhead_cost: 5000 },
    cookie: viewerCookie
  });
  assert.strictEqual(resInputs.status, 403);

  const resOutside = await req('POST', '/api/reports/service-outside', {
    body: { month: '2026-09', vendor: 'External Garage', amount: 1200 },
    cookie: viewerCookie
  });
  assert.strictEqual(resOutside.status, 403);

  // Admin is allowed
  const adminCookie = await as('admin_user');
  const resAdminInputs = await req('POST', '/api/reports/monthly-inputs', {
    body: { year: 2026, month: 9, sheet: 'fuel', workshop_id: 1, lines: [] },
    cookie: adminCookie
  });
  assert.strictEqual(resAdminInputs.status, 200);
});

test('Security Gap 2: dropdown picklists sanitize financial and rate data for unprivileged users', async () => {
  const unprivCookie = await as('unpriv_user');

  // Mechanics: unpriv does not have labour view clearance
  const resMech = await req('GET', '/api/mechanics', { cookie: unprivCookie });
  assert.strictEqual(resMech.status, 200);
  assert.ok(Array.isArray(resMech.body));
  assert.ok(resMech.body.length > 0);
  for (const m of resMech.body) {
    assert.strictEqual(m.rate, null, 'Unprivileged mechanics list must not include rate');
  }

  // Admin mechanic list should include rate
  const adminCookie = await as('admin_user');
  const resMechAdmin = await req('GET', '/api/mechanics', { cookie: adminCookie });
  assert.strictEqual(resMechAdmin.status, 200);
  const found = resMechAdmin.body.find((m) => m.name === 'John Mechanic');
  assert.ok(found);
  assert.strictEqual(found.rate, 450);

  // Projects: unpriv does not have projects module clearance
  const resProjects = await req('GET', '/api/projects', { cookie: unprivCookie });
  assert.strictEqual(resProjects.status, 200);
  assert.ok(Array.isArray(resProjects.body));
  assert.ok(resProjects.body.length > 0);
  for (const p of resProjects.body) {
    assert.ok(p.id && p.code && p.name);
    assert.strictEqual(p.month_cost, undefined, 'Unprivileged projects list must not include month_cost');
    assert.strictEqual(p.total_cost, undefined, 'Unprivileged projects list must not include total_cost');
  }
});

// ---------------------------------------------------------------- Access Control API
test('Access Control API: GET /api/access/people', async () => {
  const adminCookie = await as('admin_user');
  const res = await req('GET', '/api/access/people', { cookie: adminCookie });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.people));
  const person = res.body.people.find((p) => p.id === wsUser1Id);
  assert.ok(person);
  assert.ok(person.permissions);
  assert.strictEqual(typeof person.override_count, 'number');
});

test('Access Control API: GET /api/access/people/:id returns detailed 22-section breakdown', async () => {
  const adminCookie = await as('admin_user');
  const res = await req('GET', `/api/access/people/${wsUser1Id}`, { cookie: adminCookie });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.user.id, wsUser1Id);
  assert.strictEqual(res.body.sections.length, 22);

  const purchasingSec = res.body.sections.find((s) => s.key === 'purchasing');
  assert.ok(purchasingSec);
  assert.strictEqual(purchasingSec.role_level, 'none');
  assert.strictEqual(purchasingSec.effective_level, 'edit');
  assert.strictEqual(purchasingSec.origin, 'custom');
});

test('Access Control API: POST /api/access/people/:id/save enforces assertNotSelf', async () => {
  const adminCookie = await as('admin_user');
  // Admin trying to edit their own access
  const res = await req('POST', `/api/access/people/${adminId}/save`, {
    body: { permissions: { jobs: 'view' } },
    cookie: adminCookie
  });
  assert.strictEqual(res.status, 403);
  assert.ok(/cannot modify your own/i.test(res.body.error));
});

test('Access Control API: POST /api/access/people/:id/save updates permissions & records history', async () => {
  const adminCookie = await as('admin_user');
  const res = await req('POST', `/api/access/people/${wsUser2Id}/save`, {
    body: {
      permissions: { lubricants: 'full', stores: 'view' },
      capabilities: { 'reports.monthly_cost.edit': true },
      approval_limit: 75000,
      reason: 'Assigned as lubricants supervisor'
    },
    cookie: adminCookie
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);

  // Verify effective permissions
  const updatedUser = getUser(wsUser2Id);
  assert.strictEqual(permissions.effectiveLevel(updatedUser, 'lubricants'), 'full');
  assert.strictEqual(permissions.effectiveLevel(updatedUser, 'stores'), 'view');
  assert.strictEqual(updatedUser.approval_limit, 75000);

  // Check history endpoint
  const histRes = await req('GET', `/api/access/history?target_user_id=${wsUser2Id}`, { cookie: adminCookie });
  assert.strictEqual(histRes.status, 200);
  assert.ok(histRes.body.history.length > 0);
  assert.ok(histRes.body.history.some((h) => h.reason === 'Assigned as lubricants supervisor'));
});

test('Access Control API: POST /api/access/people/:id/copy-from copies overrides', async () => {
  const adminCookie = await as('admin_user');
  const res = await req('POST', `/api/access/people/${wsUser1Id}/copy-from`, {
    body: { source_user_id: wsUser2Id, reason: 'Duplicate lubricants supervisor permissions' },
    cookie: adminCookie
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);

  const u1 = getUser(wsUser1Id);
  assert.strictEqual(permissions.effectiveLevel(u1, 'lubricants'), 'full');
  assert.strictEqual(permissions.effectiveLevel(u1, 'stores'), 'view');
});

test('Access Control API: POST /api/access/people/:id/reset reverts overrides to role defaults', async () => {
  const adminCookie = await as('admin_user');
  const res = await req('POST', `/api/access/people/${wsUser1Id}/reset`, {
    body: { reason: 'Reset to standard workshop technician' },
    cookie: adminCookie
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);

  const u1 = getUser(wsUser1Id);
  assert.strictEqual(permissions.effectiveLevel(u1, 'lubricants'), 'edit'); // default workshop role level is edit
  assert.strictEqual(permissions.effectiveLevel(u1, 'stores'), 'view');
});

test('Access Control API: GET /api/access/sections/:section returns user audit for section', async () => {
  const adminCookie = await as('admin_user');
  const res = await req('GET', '/api/access/sections/lubricants', { cookie: adminCookie });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.section.key, 'lubricants');
  assert.ok(Array.isArray(res.body.people));
  const p2 = res.body.people.find((p) => p.id === wsUser2Id);
  assert.ok(p2);
  assert.strictEqual(p2.effective_level, 'full');
});

test('Access Control API: GET /api/access/compare returns diff comparison', async () => {
  const adminCookie = await as('admin_user');
  const res = await req('GET', `/api/access/compare?a=${wsUser2Id}&b=role:workshop`, { cookie: adminCookie });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.sections));
  const lubSec = res.body.sections.find((s) => s.key === 'lubricants');
  assert.strictEqual(lubSec.level_a, 'full');
  assert.strictEqual(lubSec.level_b, 'edit');
  assert.strictEqual(lubSec.diff, true);
});

test('Access Control API: GET /api/access/report returns matrix', async () => {
  const adminCookie = await as('admin_user');
  const res = await req('GET', '/api/access/report?format=json', { cookie: adminCookie });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.sections.length, 22);
  assert.ok(res.body.people.length >= 4);

  const xlsxRes = await req('GET', '/api/access/report?format=xlsx', { cookie: adminCookie });
  assert.strictEqual(xlsxRes.status, 200);
  assert.strictEqual(xlsxRes.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});
