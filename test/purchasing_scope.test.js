'use strict';

// What a purchasing officer is allowed to see.
//
// The first cut of these roles handed them read-only job cards, stores, filters, projects and the
// fleet "so the screen has context". That put the company's costs, stock and vehicle history in
// front of two people whose job needs none of it, and buried the one list they work from behind
// nine they never open. Their access is now one module, and this file is what keeps it that way —
// a cell added back here should have to survive reading these tests.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-purchasing-scope-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const permissions = require('../src/lib/permissions');

migrate();
permissions.seedDefaults();

const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)',
  'hq', auth.hashPassword('pw')).lastInsertRowid;
run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, 'purchase_head_office');

const app = require('../src/server');
let server; let base; let cookie;
test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'hq', password: 'pw' }),
  });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
});
test.after(() => server && server.close());

const call = (p) => fetch(base + '/api' + p, { headers: { cookie } }).then((r) => r.status);

test('the two buying roles hold exactly one module between them', () => {
  for (const role of ['purchase_head_office', 'purchase_local']) {
    const open = all('SELECT module, level FROM role_permissions WHERE role = ? AND level <> ?', role, 'none');
    assert.deepStrictEqual(open.map((r) => r.module), ['purchasing'],
      `${role} can also reach: ${open.map((r) => r.module + '=' + r.level).join(', ')}`);
  }
});

test('every enforced module except purchasing is closed to them', async () => {
  // Walked as real HTTP calls rather than read off the matrix, because the matrix is only a
  // policy — what matters is what the server does when the request actually arrives.
  const shut = [
    ['/jobs', 'job cards'], ['/stores/mrn', 'stores'], ['/oil/products', 'oil'],
    ['/batteries', 'batteries'], ['/filters/prices', 'filter prices'],
    ['/general-stock/items', 'general stock'], ['/filter-stock', 'filter stock'],
    ['/assets', 'the fleet'], ['/job-requests', 'job requests'], ['/daily-work', 'daily work'],
  ];
  for (const [p, what] of shut) {
    assert.strictEqual(await call(p), 403, `${what} (${p}) is open to a purchasing officer`);
  }
});

test('their own screen is open', async () => {
  assert.strictEqual(await call('/purchasing/counts'), 200);
  assert.strictEqual(await call('/purchasing/queue?tab=to_buy'), 200);
});

test('their landing page loads without touching the workshop dashboard', async () => {
  // A purchasing-only officer is sent to a purchasing dashboard, so the data behind THAT is what
  // has to answer on sign-in — the workshop overview (job costs, stock value, vehicle history) is
  // neither shown to them nor fetched.
  assert.strictEqual(await call('/purchasing/counts'), 200);
  assert.strictEqual(await call('/purchasing/queue?tab=to_buy&limit=12'), 200);

  // Not asserted: /api/dashboard/overview. It 500s on a freshly migrated database — filter_stock
  // and products.stock_qty are created by src/migrate/015, a one-off data script, and never by the
  // boot migration. Pre-existing, unrelated to these roles, and invisible until now because every
  // real database went through 015 years ago. Left failing loudly elsewhere rather than papered
  // over here; see the note raised alongside this change.
});

test('the correction runs once and does not fight an admin afterwards', () => {
  // role_permissions is editable from the Access screen. Clearing these roles on every boot would
  // silently undo a deliberate change, so it is guarded by a marker.
  const mark = get('SELECT value FROM settings WHERE key = ?', 'purchasing_roles_scoped_v2');
  assert.ok(mark, 'the one-time marker must be recorded');

  run('UPDATE role_permissions SET level = ? WHERE role = ? AND module = ?', 'view', 'purchase_local', 'stores');
  migrate();
  permissions.seedDefaults();
  assert.strictEqual(
    get('SELECT level FROM role_permissions WHERE role = ? AND module = ?', 'purchase_local', 'stores').level,
    'view', 'a deliberate grant made from the Access screen must survive the next restart');

  run('UPDATE role_permissions SET level = ? WHERE role = ? AND module = ?', 'none', 'purchase_local', 'stores');
});
