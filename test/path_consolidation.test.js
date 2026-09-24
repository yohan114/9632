'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), 'workshopone-path-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, run } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();
for (const n of ['admin', 'storekeeper', 'workshop', 'manager']) run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'admin_path', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ['admin', 'storekeeper', 'workshop', 'manager']) {
  run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
}

const app = require('../src/server');
const intelligence = require('../src/lib/intelligence');
const costing = require('../src/lib/costing');
const lubricants = require('../src/lib/lubricants');
const aliases = require('../src/lib/aliases');

let server;
let baseUrl;
let cookie;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin_path', password: 'pw' }),
  });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function get(p) {
  const r = await fetch(baseUrl + p, {
    headers: { 'content-type': 'application/json', cookie },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test('intelligence.warrantyRadar returns canonical battery radar shape', () => {
  const radar = intelligence.warrantyRadar();
  assert.ok(radar, 'radar result should exist');
  assert.ok(Array.isArray(radar.expiring), 'expiring should be an array');
  assert.ok(Array.isArray(radar.idle_in_store), 'idle_in_store should be an array');

  for (const b of radar.expiring) {
    assert.ok(b.serial_no, 'battery must have serial_no');
    assert.ok(b.warranty_date, 'battery must have warranty_date');
    assert.ok('asset_code' in b, 'battery must have asset_code field');
  }
});

test('costing.projectCost and projectsCostSummary lock the project cost rollup schema', () => {
  const summary = costing.projectsCostSummary();
  assert.ok(Array.isArray(summary), 'summary should be an array');

  const EXPECTED_KEYS = [
    'external',
    'general',
    'labour',
    'material',
    'oil',
    'project_code',
    'project_id',
    'project_name',
    'total',
  ];

  for (const p of summary) {
    assert.deepEqual(Object.keys(p).sort(), EXPECTED_KEYS, 'project row keys must match canonical schema');
    assert.strictEqual(typeof p.labour, 'number');
    assert.strictEqual(typeof p.material, 'number');
    assert.strictEqual(typeof p.oil, 'number');
    assert.strictEqual(typeof p.general, 'number');
    assert.strictEqual(typeof p.external, 'number');
    assert.strictEqual(typeof p.total, 'number');
  }
});

test('lubricants.oilForecast computes consistent consumption and low-stock thresholds', () => {
  const forecast = lubricants.oilForecast();
  assert.ok(forecast.window_days > 0, 'window_days must be positive');
  assert.ok(forecast.low_stock_days > 0, 'low_stock_days must be positive');
  assert.ok(Array.isArray(forecast.products), 'products must be an array');

  const EXPECTED_PRODUCT_KEYS = [
    'balance',
    'consumption_window',
    'daily_rate',
    'days_of_cover',
    'id',
    'low',
    'name',
    'product_id',
    'reorder_level',
    'suggested_reorder',
    'unit',
  ];

  for (const p of forecast.products) {
    assert.deepEqual(Object.keys(p).sort(), EXPECTED_PRODUCT_KEYS, 'forecast product keys must match canonical schema');
    assert.strictEqual(typeof p.low, 'boolean');
    assert.strictEqual(p.low, p.suggested_reorder);
  }
});

test('aliases.queryAliasQueue unifies vehicle and mechanic queues', () => {
  const assetQueue = aliases.queryAliasQueue({
    table: 'asset_aliases',
    targetTable: 'assets',
    targetIdCol: 'asset_id',
    targetNameCol: 'code',
    targetAlias: 'asset_code',
    limit: 10,
  });
  assert.ok(Array.isArray(assetQueue), 'asset queue must return array');

  const mechanicQueue = aliases.queryAliasQueue({
    table: 'mechanic_aliases',
    targetTable: 'mechanics',
    targetIdCol: 'mechanic_id',
    targetNameCol: 'name',
    targetAlias: 'mechanic_name',
    limit: 10,
  });
  assert.ok(Array.isArray(mechanicQueue), 'mechanic queue must return array');
});

test('GET /api/reports/cost/by-project returns canonical project summary', async () => {
  const res = await get('/api/reports/cost/by-project');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body));
  if (res.body.length > 0) {
    assert.ok('project_id' in res.body[0]);
    assert.ok('total' in res.body[0]);
  }
});

test('GET /api/batteries/warranty-radar returns canonical radar shape', async () => {
  const res = await get('/api/batteries/warranty-radar');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.expiring));
  assert.ok(Array.isArray(res.body.idle_in_store));
});

test('GET /api/oil/forecast returns canonical forecast shape', async () => {
  const res = await get('/api/oil/forecast');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.products));
  assert.ok(res.body.window_days > 0);
});

test('Master inventory API endpoints are 100% active and preserved', async () => {
  const endpoints = [
    '/api/stores/search',
    '/api/filter-stock/summary',
    '/api/filters/prices',
    '/api/oil/products',
    '/api/batteries',
    '/api/stock-cockpit/overview',
  ];
  for (const ep of endpoints) {
    const res = await get(ep);
    assert.ok([200, 304].includes(res.status), `Endpoint ${ep} must respond successfully (got ${res.status})`);
  }
});

test('public/app.js enforces single canonical navigation paths and redirect shims', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

  // Verify single canonical nav items for Inventory
  assert.match(appJs, /\['stores',\s*'📦',\s*'Stores'\]/);
  // Stores plan, Part 2 (ST-D1): Stock Take is the Stores page's Stock and Stock take tabs now.
  assert.ok(!/\['stocktake',\s*'📋'/.test(appJs), 'Stock Take should be folded into the Stores page');
  assert.match(appJs, /routes\.stocktake\s*=\s*async/);

  // Verify redundant sidebar shortcuts are removed from NAV array
  assert.ok(!appJs.includes("['matreq', '📝'"), 'matreq shortcut should be removed from NAV');
  assert.ok(!appJs.includes("['stockissues', '📤'"), 'stockissues shortcut should be removed from NAV');
  assert.ok(!appJs.includes("['stockcockpit', '🏪'"), 'stockcockpit should be consolidated into stocktake');
  assert.ok(!appJs.includes("['generalstock', '🧰'"), 'generalstock should be consolidated into stocktake');

  // Verify backward-compatibility redirect shims are present
  assert.match(appJs, /routes\.stockcockpit\s*=\s*async/);
  assert.match(appJs, /routes\.generalstock\s*=\s*async/);
  assert.match(appJs, /routes\.oil\s*=\s*async/);
  assert.match(appJs, /routes\.filters\s*=\s*async/);
  assert.match(appJs, /routes\.batteries\s*=\s*async/);
  assert.match(appJs, /routes\.filterstock\s*=\s*async/);
  assert.match(appJs, /routes\.stockissues\s*=\s*async/);
  assert.match(appJs, /routes\.matreq\s*=\s*async/);

  // Verify Stores primary toolbar has removed the cross-module generalstock_link
  assert.ok(!appJs.includes("'generalstock_link'"), 'generalstock_link button should be removed from Stores toolbar');
});
