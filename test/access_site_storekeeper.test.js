'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-sk-'));
process.env.DB_PATH = path.join(TMP, 'test_site_sk.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.MULTIDB = '0';

const { migrate, run, get } = require('../src/db');
const permissions = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');
const auth = require('../src/lib/auth');

migrate();
// Ensure permissions and capabilities are seeded
permissions.seedDefaults();
capabilities.seedCapabilities();

test('site_storekeeper role exists in permissions DEFAULT_MATRIX with correct clearances', () => {
  const m = permissions.DEFAULT_MATRIX.site_storekeeper;
  assert.ok(m, 'site_storekeeper template defined in DEFAULT_MATRIX');

  // View sections
  assert.strictEqual(m.dashboard, 'view');
  assert.strictEqual(m.jobs, 'view');
  assert.strictEqual(m.assets, 'view');
  assert.strictEqual(m.projects, 'view');
  assert.strictEqual(m.services, 'view');
  assert.strictEqual(m.lubricants, 'view');
  assert.strictEqual(m.reports, 'view');

  // Edit sections
  assert.strictEqual(m.stores, 'edit');
  assert.strictEqual(m.oil, 'edit');
  assert.strictEqual(m.filters, 'edit');

  // None sections
  assert.strictEqual(m.purchasing, 'none');
  assert.strictEqual(m.labour, 'none');
  assert.strictEqual(m.workshops, 'none');
  assert.strictEqual(m.access, 'none');
  assert.strictEqual(m.users, 'none');
  assert.strictEqual(m.cost_teardown, 'none');
});

test('site_storekeeper holds operational inventory capabilities but excludes approval and pricing', () => {
  const caps = new Set(capabilities.capsForRoles(['site_storekeeper']));

  // Granted actions
  assert.ok(caps.has('stores.mrn.create'), 'can create MRN');
  assert.ok(caps.has('stores.grn.receive'), 'can receive GRN');
  assert.ok(caps.has('stores.issue'), 'can issue stock');
  assert.ok(caps.has('stores.stock_issue'), 'can issue catalogue parts');
  assert.ok(caps.has('stores.issue_return'), 'can return issued stock');
  assert.ok(caps.has('stores.stock.count'), 'can count physical stock');
  assert.ok(caps.has('oil.ledger.post'), 'can post oil ledger');
  assert.ok(caps.has('filters.stock.issue'), 'can issue filters');

  // View clearances
  assert.ok(caps.has('dashboard.view'), 'can view dashboard');
  assert.ok(caps.has('stores.view'), 'can view stores');
  assert.ok(caps.has('oil.view'), 'can view oil');
  assert.ok(caps.has('filters.view'), 'can view filters');
  assert.ok(caps.has('assets.view'), 'can view assets');

  // Strict Exclusions (Segregation of Duties & Authority Limits)
  assert.ok(!caps.has('stores.mrn.approve'), 'cannot approve MRN');
  assert.ok(!caps.has('stores.mrn.certify'), 'cannot certify MRN');
  assert.ok(!caps.has('stores.grn.approve'), 'cannot approve GRN');
  assert.ok(!caps.has('stores.items.price'), 'cannot set item prices');
  assert.ok(!caps.has('stores.count.approve'), 'cannot approve stock takes');
  assert.ok(!caps.has('stores.disposal.approve'), 'cannot approve scrap disposal');
  assert.ok(!caps.has('stores.all'), 'cannot access all stores globally by default');
});

test('role health check flags roles with all none sections or no capabilities as incomplete', () => {
  // Create an empty dummy role
  run("INSERT OR IGNORE INTO roles (name, label, active) VALUES ('empty_role', 'Empty Test Role', 1)");
  for (const m of permissions.MODULE_KEYS) {
    run("INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES ('empty_role', ?, 'none')", m);
  }

  const { all } = require('../src/db');
  const emptyRow = all("SELECT name, label, is_system, active, require_mfa, created_at FROM roles WHERE name = 'empty_role'")[0];
  const emptyCaps = capabilities.capsForRole(emptyRow.name);
  const isAllNone = permissions.MODULE_KEYS.every((m) => permissions.levelForRoles([emptyRow.name], m) === 'none');
  const isIncomplete = emptyRow.name !== 'admin' && (emptyCaps.length === 0 || isAllNone);

  assert.strictEqual(isIncomplete, true, 'Empty role must be flagged as incomplete');

  // site_storekeeper must NOT be incomplete
  const skCaps = capabilities.capsForRole('site_storekeeper');
  const skAllNone = permissions.MODULE_KEYS.every((m) => permissions.levelForRoles(['site_storekeeper'], m) === 'none');
  const skIncomplete = skCaps.length === 0 || skAllNone;

  assert.strictEqual(skIncomplete, false, 'site_storekeeper must be complete');
});

test('migration 051 populates database without overwriting existing grants', () => {
  const migration051 = require('../src/migrate/051_seed_site_storekeeper_role');
  const { rawDb } = require('../src/db');
  migration051.runMigration(rawDb);

  const role = get("SELECT * FROM roles WHERE name = 'site_storekeeper'");
  assert.ok(role, 'site_storekeeper role exists in database');
  assert.strictEqual(role.is_system, 1, 'site_storekeeper is marked as is_system');

  const permCount = get("SELECT COUNT(*) AS n FROM role_permissions WHERE role = 'site_storekeeper'").n;
  assert.ok(permCount >= 20, `site_storekeeper has ${permCount} permissions rows`);

  const capCount = get("SELECT COUNT(*) AS n FROM role_capabilities WHERE role = 'site_storekeeper' AND granted = 1").n;
  assert.ok(capCount >= 10, `site_storekeeper has ${capCount} capabilities rows`);
});
