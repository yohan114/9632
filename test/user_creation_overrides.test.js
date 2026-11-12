'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-user-overrides-'));
process.env.DB_PATH = path.join(TMP, 'test_user_overrides.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.MULTIDB = '0';

const { migrate, run, get, all } = require('../src/db');
const permissions = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');
const auth = require('../src/lib/auth');
const storeLocs = require('../src/lib/store_locations');
const rules = require('../src/lib/access_rules');

migrate();
permissions.seedDefaults();
capabilities.seedCapabilities();

const BUILT_IN = ['admin', ...Object.keys(permissions.DEFAULT_MATRIX)];
for (const n of BUILT_IN) run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);

// Seed test admin user
const adminHash = auth.hashPassword('AdminPass123!');
const adminId = run("INSERT INTO users (username, password_hash, full_name, active) VALUES ('admin_test', ?, 'Admin Tester', 1)", adminHash).lastInsertRowid;
const adminRoleId = get("SELECT id FROM roles WHERE name = 'admin'").id;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", adminId, adminRoleId);
const adminUser = { id: adminId, username: 'admin_test', roles: ['admin'] };

test('POST /api/users creates standard site storekeeper with 0 overrides', async () => {
  const usersRoute = require('../src/routes/users');
  const req = {
    user: adminUser,
    body: {
      username: 'sk_standard',
      password: 'StandardPassword1!',
      full_name: 'Standard Storekeeper',
      roles: ['site_storekeeper'],
      store_location_id: 1,
    }
  };

  let statusCode = null;
  let jsonResult = null;
  const res = {
    status(c) { statusCode = c; return this; },
    json(d) { jsonResult = d; return this; }
  };

  // Invoke users route handler directly
  const layer = usersRoute.stack.find(s => s.route && s.route.path === '/' && s.route.methods.post);
  assert.ok(layer, 'POST / route found in users.js');

  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  await handler(req, res, () => {});

  assert.strictEqual(statusCode, 201);
  assert.ok(jsonResult.id);
  assert.deepStrictEqual(jsonResult.roles, ['site_storekeeper']);

  // Check database override tables
  const userPerms = all('SELECT * FROM user_permissions WHERE user_id = ?', jsonResult.id);
  const userCaps = all('SELECT * FROM user_capabilities WHERE user_id = ?', jsonResult.id);

  assert.strictEqual(userPerms.length, 0, 'No section overrides on standard creation');
  assert.strictEqual(userCaps.length, 0, 'No capability overrides on standard creation');

  // Verify effective caps
  const effective = capabilities.effectiveCaps({ id: jsonResult.id, roles: ['site_storekeeper'] });
  assert.ok(effective.includes('stores.issue'), 'Holds standard site storekeeper issue');
  assert.ok(!effective.includes('stores.mrn.approve'), 'Does not hold approve');
});

test('POST /api/users with 2 extra actions creates exactly 2 overrides and expands access', async () => {
  const usersRoute = require('../src/routes/users');
  const req = {
    user: adminUser,
    body: {
      username: 'sk_elevated',
      password: 'ElevatedPassword1!',
      full_name: 'Elevated Storekeeper',
      roles: ['site_storekeeper'],
      capabilities: {
        'stores.items.price': true,
        'tools.manage': true,
      },
      override_reason: 'Temporary coverage for senior inventory supervisor'
    }
  };

  let statusCode = null;
  let jsonResult = null;
  const res = {
    status(c) { statusCode = c; return this; },
    json(d) { jsonResult = d; return this; }
  };

  const layer = usersRoute.stack.find(s => s.route && s.route.path === '/' && s.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  await handler(req, res, () => {});

  assert.strictEqual(statusCode, 201);
  const userCaps = all('SELECT capability, granted FROM user_capabilities WHERE user_id = ? ORDER BY capability', jsonResult.id);

  assert.strictEqual(userCaps.length, 2, 'Exactly 2 capability overrides created');
  assert.strictEqual(userCaps[0].capability, 'stores.items.price');
  assert.strictEqual(userCaps[0].granted, 1);
  assert.strictEqual(userCaps[1].capability, 'tools.manage');
  assert.strictEqual(userCaps[1].granted, 1);

  // Verify effective caps incorporate the overrides
  const effective = capabilities.effectiveCaps({ id: jsonResult.id, roles: ['site_storekeeper'] });
  assert.ok(effective.includes('stores.items.price'), 'Now holds stores.items.price via override');
  assert.ok(effective.includes('tools.manage'), 'Now holds tools.manage via override');
  assert.ok(effective.includes('stores.issue'), 'Still holds baseline stores.issue');
});

test('POST /api/users with explicit revoke removes action from role template', async () => {
  const usersRoute = require('../src/routes/users');
  const req = {
    user: adminUser,
    body: {
      username: 'sk_restricted',
      password: 'RestrictedPassword1!',
      full_name: 'Restricted Storekeeper',
      roles: ['site_storekeeper'],
      capabilities: {
        'stores.stock.count': false, // Revoke counting ability
      },
      override_reason: 'Probationary trainee storekeeper'
    }
  };

  let statusCode = null;
  let jsonResult = null;
  const res = {
    status(c) { statusCode = c; return this; },
    json(d) { jsonResult = d; return this; }
  };

  const layer = usersRoute.stack.find(s => s.route && s.route.path === '/' && s.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  await handler(req, res, () => {});

  assert.strictEqual(statusCode, 201);
  const userCaps = all('SELECT capability, granted FROM user_capabilities WHERE user_id = ?', jsonResult.id);

  assert.strictEqual(userCaps.length, 1);
  assert.strictEqual(userCaps[0].capability, 'stores.stock.count');
  assert.strictEqual(userCaps[0].granted, 0, 'Explicit revoke recorded as granted = 0');

  const effective = capabilities.effectiveCaps({ id: jsonResult.id, roles: ['site_storekeeper'] });
  assert.ok(!effective.includes('stores.stock.count'), 'stores.stock.count is stripped from effective caps');
});

test('cannot grant what you do not hold: caller restricted by safety rules', async () => {
  const usersRoute = require('../src/routes/users');

  // Create a limited supervisor who can manage users but DOES NOT hold 'purchasing.po.approve'
  const limitedId = run("INSERT INTO users (username, password_hash, full_name, active) VALUES ('limited_mgr', ?, 'Limited Manager', 1)", adminHash).lastInsertRowid;
  const limitedUser = { id: limitedId, username: 'limited_mgr', roles: ['workshop'] };

  // Grant limitedUser 'users.manage' capability so they can call POST /api/users
  capabilities.setUserCapability(limitedId, 'users.manage', true);

  const req = {
    user: limitedUser,
    body: {
      username: 'escalated_user',
      password: 'EscalatedPassword1!',
      roles: ['workshop'],
      capabilities: {
        'purchasing.po.approve': true // limitedUser does not hold this
      }
    }
  };

  let errorThrown = null;
  try {
    const layer = usersRoute.stack.find(s => s.route && s.route.path === '/' && s.route.methods.post);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    await handler(req, {}, () => {});
  } catch (err) {
    errorThrown = err;
  }

  assert.ok(errorThrown, 'Safety rule blocked unauthorized grant');
  assert.strictEqual(errorThrown.status, 403);
});

test('temporary access expiry (access_until) enforces time limit', async () => {
  const usersRoute = require('../src/routes/users');
  const pastDate = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
  const req = {
    user: adminUser,
    body: {
      username: 'temp_contractor',
      password: 'TempPassword123!',
      full_name: 'Temporary Contractor',
      roles: ['site_storekeeper'],
      access_until: pastDate,
    }
  };

  let statusCode = null;
  let jsonResult = null;
  const res = {
    status(c) { statusCode = c; return this; },
    json(d) { jsonResult = d; return this; }
  };

  const layer = usersRoute.stack.find(s => s.route && s.route.path === '/' && s.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  await handler(req, res, () => {});

  assert.strictEqual(statusCode, 201);
  assert.strictEqual(jsonResult.access_until, pastDate);

  // Expired user should have 0 effective caps and 'none' permission level
  const effective = capabilities.effectiveCaps({ id: jsonResult.id, roles: ['site_storekeeper'], access_until: pastDate });
  assert.strictEqual(effective.length, 0, 'Expired temporary user holds 0 effective caps');

  const lvl = permissions.effectiveLevel({ id: jsonResult.id, roles: ['site_storekeeper'], access_until: pastDate }, 'stores');
  assert.strictEqual(lvl, 'none', 'Expired temporary user falls back to none clearance');
});
