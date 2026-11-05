'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-governance-'));
process.env.DB_PATH = path.join(TMP, 'test_governance.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.MULTIDB = '0';

const { migrate, run, get, all } = require('../src/db');
const permissions = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');
const auth = require('../src/lib/auth');
const storeLocs = require('../src/lib/store_locations');
const sod = require('../src/lib/sod');

migrate();
permissions.seedDefaults();
capabilities.seedCapabilities();

const BUILT_IN = ['admin', ...Object.keys(permissions.DEFAULT_MATRIX)];
for (const n of BUILT_IN) run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);

// Seed test admin user
const adminHash = auth.hashPassword('AdminPass123!');
const adminId = run("INSERT INTO users (username, password_hash, full_name, active) VALUES ('admin_gov', ?, 'Admin Gov', 1)", adminHash).lastInsertRowid;
const adminRoleId = get("SELECT id FROM roles WHERE name = 'admin'").id;
run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', adminId, adminRoleId);
const adminUser = { id: adminId, username: 'admin_gov', roles: ['admin'] };

test('Governance & SoD: unit test findSodConflicts and assertNoSodConflicts', () => {
  // Conflicting pair
  const conflicts1 = sod.findSodConflicts(['stores.mrn.create', 'stores.mrn.approve']);
  assert.strictEqual(conflicts1.length, 1);
  assert.strictEqual(conflicts1[0].rule.code, 'SOD-MRN-01');

  // No conflict
  const conflicts2 = sod.findSodConflicts(['stores.mrn.create', 'stores.stock.count']);
  assert.strictEqual(conflicts2.length, 0);

  // Assert throws 409 without reason
  assert.throws(
    () => sod.assertNoSodConflicts(['stores.mrn.create', 'stores.mrn.approve']),
    (err) => err.status === 409 && err.code === 'SOD_CONFLICT'
  );

  // Assert throws 409 with too-short reason
  assert.throws(
    () => sod.assertNoSodConflicts(['stores.mrn.create', 'stores.mrn.approve'], 'short'),
    (err) => err.status === 409 && err.code === 'SOD_CONFLICT'
  );

  // Assert succeeds with valid exception reason (>= 10 chars)
  const result = sod.assertNoSodConflicts(
    ['stores.mrn.create', 'stores.mrn.approve'],
    'Sole remote project manager emergency exception'
  );
  assert.strictEqual(result.allowedWithException, true);
});

test('Governance & SoD: user creation blocks conflicting duties without justification', async () => {
  const usersRoute = require('../src/routes/users');
  const layer = usersRoute.stack.find((s) => s.route && s.route.path === '/' && s.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;

  // 1. Attempt conflicting duty without justification: expect 409 SOD_CONFLICT
  let conflictErr = null;
  const reqConflict = {
    user: adminUser,
    body: {
      username: 'user_sod_fail',
      password: 'StrongPassword123!',
      roles: ['site_storekeeper'],
      capabilities: {
        'stores.mrn.approve': true // site_storekeeper already has stores.mrn.create
      }
    }
  };
  const resConflict = {
    status(c) { this._status = c; return this; },
    json(d) { this._json = d; return this; }
  };

  try {
    await handler(reqConflict, resConflict, (err) => {
      conflictErr = err;
    });
  } catch (e) {
    conflictErr = e;
  }

  assert.ok(conflictErr, 'Expected an error to be thrown or passed to next()');
  assert.strictEqual(conflictErr.status, 409);
  assert.strictEqual(conflictErr.code, 'SOD_CONFLICT');

  // 2. Supply approved exception reason (>= 10 chars): expect success 201
  let statusOk = null;
  let jsonOk = null;
  const reqOk = {
    user: adminUser,
    body: {
      username: 'user_sod_ok',
      password: 'StrongPassword123!',
      roles: ['site_storekeeper'],
      capabilities: {
        'stores.mrn.approve': true
      },
      override_reason: 'Approved remote site manager dual coverage exemption'
    }
  };
  const resOk = {
    status(c) { statusOk = c; return this; },
    json(d) { jsonOk = d; return this; }
  };

  await handler(reqOk, resOk, (err) => {
    if (err) throw err;
  });

  assert.strictEqual(statusOk, 201);
  assert.strictEqual(jsonOk.username, 'user_sod_ok');

  // Verify audit log recorded exception
  const log = get("SELECT * FROM audit_log WHERE entity = 'sod_governance_exception' AND action = 'user_create_exception_approved' ORDER BY id DESC LIMIT 1");
  assert.ok(log, 'Audit log recorded sod_governance_exception');
  assert.strictEqual(log.action, 'user_create_exception_approved');
  assert.ok(log.after_json.includes('user_sod_ok'));
});

test('Governance & SoD: saving user overrides blocks conflicting duties without justification', async () => {
  const usersRoute = require('../src/routes/users');
  const accessRoute = require('../src/routes/access');

  // Create clean user with site_storekeeper
  const userCreateLayer = usersRoute.stack.find((s) => s.route && s.route.path === '/' && s.route.methods.post);
  const createUserHandler = userCreateLayer.route.stack[userCreateLayer.route.stack.length - 1].handle;

  let createdUser = null;
  await createUserHandler(
    {
      user: adminUser,
      body: { username: 'user_override_test', password: 'StrongPassword123!', roles: ['site_storekeeper'] }
    },
    {
      status() { return this; },
      json(d) { createdUser = d; return this; }
    },
    (err) => { if (err) throw err; }
  );
  assert.ok(createdUser && createdUser.id);

  // Attempt to save override adding stores.mrn.approve without reason
  const saveLayer = accessRoute.stack.find((s) => s.route && s.route.path === '/people/:id/save' && s.route.methods.post);
  const saveHandler = saveLayer.route.stack[saveLayer.route.stack.length - 1].handle;

  let conflictErr = null;
  try {
    await saveHandler(
      {
        user: adminUser,
        params: { id: createdUser.id },
        body: {
          capabilities: { 'stores.mrn.approve': true }
        }
      },
      {
        status(c) { this._status = c; return this; },
        json(d) { this._json = d; return this; }
      },
      (err) => { conflictErr = err; }
    );
  } catch (e) {
    conflictErr = e;
  }

  assert.ok(conflictErr, 'Expected SoD conflict error');
  assert.strictEqual(conflictErr.status, 409);
  assert.strictEqual(conflictErr.code, 'SOD_CONFLICT');

  // Now save with approved reason
  let saveOkJson = null;
  await saveHandler(
    {
      user: adminUser,
      params: { id: createdUser.id },
      body: {
        capabilities: { 'stores.mrn.approve': true },
        override_reason: 'Approved annual stock audit emergency signoff clearance'
      }
    },
    {
      status() { return this; },
      json(d) { saveOkJson = d; return this; }
    },
    (err) => { if (err) throw err; }
  );

  assert.ok(saveOkJson && saveOkJson.ok);
});

test('Governance: emergency elevation auto-expiry falls back to baseline role template', async () => {
  const usersRoute = require('../src/routes/users');
  const accessRoute = require('../src/routes/access');

  const userCreateLayer = usersRoute.stack.find((s) => s.route && s.route.path === '/' && s.route.methods.post);
  const createUserHandler = userCreateLayer.route.stack[userCreateLayer.route.stack.length - 1].handle;

  let createdUser = null;
  await createUserHandler(
    {
      user: adminUser,
      body: { username: 'elevation_user', password: 'StrongPassword123!', roles: ['site_storekeeper'] }
    },
    {
      status() { return this; },
      json(d) { createdUser = d; return this; }
    },
    (err) => { if (err) throw err; }
  );
  const userId = createdUser.id;

  const saveLayer = accessRoute.stack.find((s) => s.route && s.route.path === '/people/:id/save' && s.route.methods.post);
  const saveHandler = saveLayer.route.stack[saveLayer.route.stack.length - 1].handle;

  // 1. Grant elevated capability stores.mrn.approve with FUTURE access_until
  const futureDate = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  await saveHandler(
    {
      user: adminUser,
      params: { id: userId },
      body: {
        capabilities: { 'stores.mrn.approve': true },
        access_until: futureDate,
        override_reason: 'Temporary elevation for weekend manager coverage'
      }
    },
    {
      status() { return this; },
      json() { return this; }
    },
    (err) => { if (err) throw err; }
  );

  const activeUser = get('SELECT id, username, access_until FROM users WHERE id = ?', userId);
  activeUser.roles = ['site_storekeeper'];
  const activeCaps = capabilities.effectiveCaps(activeUser);
  assert.ok(activeCaps.includes('stores.mrn.approve'), 'Active elevation should grant elevated stores.mrn.approve');

  // 2. Set access_until to PAST (expired)
  const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();
  run('UPDATE users SET access_until = ? WHERE id = ?', pastDate, userId);

  const expiredUser = get('SELECT id, username, access_until FROM users WHERE id = ?', userId);
  expiredUser.roles = ['site_storekeeper'];
  const expiredCaps = capabilities.effectiveCaps(expiredUser);

  // Overrides must be bypassed and fall back to site_storekeeper template:
  assert.ok(!expiredCaps.includes('stores.mrn.approve'), 'Expired elevation MUST NOT grant stores.mrn.approve');
  assert.ok(expiredCaps.includes('stores.mrn.create'), 'Expired elevation MUST retain template baseline stores.mrn.create');
  assert.ok(expiredCaps.includes('stores.view'), 'Expired elevation MUST retain template baseline stores.view');
});

test('Governance & SoD: access review report endpoint returns accurate governance data', async () => {
  const accessRoute = require('../src/routes/access');
  const reportLayer = accessRoute.stack.find((s) => s.route && s.route.methods.get && (s.route.path === '/report' || (Array.isArray(s.route.path) && s.route.path.includes('/review-report'))));
  assert.ok(reportLayer, 'Found report layer in access.js');
  const reportHandler = reportLayer.route.stack[reportLayer.route.stack.length - 1].handle;

  let reportJson = null;
  await reportHandler(
    {
      user: adminUser,
      query: {}
    },
    {
      json(d) { reportJson = d; return this; }
    },
    (err) => { if (err) throw err; }
  );

  assert.ok(reportJson, 'Report JSON returned');
  assert.ok(Array.isArray(reportJson.users));
  assert.ok(reportJson.users.length > 0);

  const sample = reportJson.users.find((u) => u.username === 'admin_gov');
  assert.ok(sample);
  assert.strictEqual(sample.username, 'admin_gov');
  assert.ok(sample.roles.includes('admin'));
  assert.strictEqual(typeof sample.is_elevation_expired, 'boolean');
  assert.ok(Array.isArray(sample.store_locations));
  assert.ok(Array.isArray(sample.sod_conflicts));
  assert.ok(Array.isArray(sample.sensitive_capabilities));

  // Test Excel export format
  let xlsxHeaders = {};
  const mockRes = {
    setHeader(k, v) { xlsxHeaders[k] = v; },
    write() {},
    end() { this.ended = true; }
  };

  await reportHandler(
    {
      user: adminUser,
      query: { format: 'xlsx' }
    },
    mockRes,
    (err) => { if (err) throw err; }
  );

  assert.strictEqual(xlsxHeaders['Content-Type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.ok(xlsxHeaders['Content-Disposition'].includes('Access-Governance-Review-Report.xlsx'));
  assert.strictEqual(mockRes.ended, true);
});
