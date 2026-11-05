'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-h3-cost-'));
const TEST_DB = path.join(TMP, 'test.db');
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { migrate, run, get, all, db } = require('../src/db');
const auth = require('../src/lib/auth');
const storeLocations = require('../src/lib/store_locations');
migrate();
storeLocations.seedStoreLocations(db);

// Seed roles and user
for (const n of ['admin', 'storekeeper']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
const uid = run("INSERT INTO users (username, password_hash, active, workshop_id) VALUES ('h3_tester', ?, 1, 1)", auth.hashPassword('pw')).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'admin'))", uid);

// Seed workshops
run("INSERT OR IGNORE INTO workshops (id, code, name, active) VALUES (1, 'CW', 'Central Workshop', 1)");
run("INSERT OR IGNORE INTO workshops (id, code, name, active) VALUES (2, 'WS2', 'Workshop 2', 1)");

const app = require('../src/server');
let server;
let base;
let cookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;

  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'h3_tester', password: 'pw' }),
  });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
});

test.after(() => {
  if (server) server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test('H3: transfer rows are tagged with mtn_id, add Rs 0 to monthly costs, and stock_moves has exactly one in and one out per line', async () => {
  // Create store item
  const itemRes = run(`INSERT INTO store_items (part_number, name, category, balance, unit_cost)
                       VALUES ('TEST-ITEM-H3', 'Test General Consumable H3', 'Consumables', 50, 500)`);
  const itemId = itemRes.lastInsertRowid;

  // Verify baseline monthly cost is 0
  const monthCosts = require('../src/lib/month_costs');
  const currMonth = new Date().toISOString().slice(0, 7);
  let rollups = monthCosts.monthlyRollup();
  let thisMonth = rollups.find(m => m.month === currMonth);
  const baselineCost = thisMonth ? thisMonth.general : 0;
  assert.strictEqual(baselineCost, 0, 'Baseline monthly cost should be 0');

  // Create an MTN with 1 line of 10 items (value = 5000)
  const mtnRes = run(`INSERT INTO mtn (mtn_no, txn_date, status, from_store_location_id, to_store_location_id)
                      VALUES ('MTN-H3-001', date('now'), 'draft', 1, 2)`);
  const mtnId = mtnRes.lastInsertRowid;
  const lineRes = run(`INSERT INTO mtn_lines (mtn_id, store_item_id, description, qty, value, from_store_location_id, to_store_location_id)
                       VALUES (?, ?, 'Test General Consumable H3', 10, 500, 1, 2)`, mtnId, itemId);
  const lineId = lineRes.lastInsertRowid;

  // Dispatch the MTN via API
  const dispatchRes = await fetch(`${base}/api/stores/mtn/${mtnId}/dispatch`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
  });
  assert.strictEqual(dispatchRes.status, 200, 'Dispatch should succeed');

  // Accept the MTN via API
  const acceptRes = await fetch(`${base}/api/stores/mtn/${mtnId}/accept`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
  });
  assert.strictEqual(acceptRes.status, 200, 'Accept should succeed');

  // 1. Verify mtn_id is populated on general_item_txns
  const gitRow = get(`SELECT * FROM general_item_txns WHERE store_item_id = ? AND ref = 'MTN Transfer'`, itemId);
  assert.ok(gitRow, 'general_item_txns row should exist for transfer');
  assert.strictEqual(gitRow.mtn_id, mtnId, 'general_item_txns.mtn_id should match mtnId');

  // 2. Verify monthly cost rollup excludes this transfer (adds Rs 0)
  rollups = monthCosts.monthlyRollup();
  thisMonth = rollups.find(m => m.month === currMonth);
  const afterCost = thisMonth ? thisMonth.general : 0;
  assert.strictEqual(afterCost, 0, 'MTN transfer should add Rs 0 to monthly general cost');

  // 3. Verify stock.rebuild does NOT double project the transfer into stock_moves
  const stock = require('../src/lib/stock');
  stock.rebuild({ wipe: true });

  const moves = all(`SELECT * FROM stock_moves WHERE store_item_id = ? OR item_name = 'Test General Consumable H3'`, itemId);
  const outMoves = moves.filter(m => m.kind === 'out');
  const inMoves = moves.filter(m => m.kind === 'in');

  assert.strictEqual(outMoves.length, 1, `Expected exactly 1 OUT move for the transfer, found ${outMoves.length}`);
  assert.strictEqual(inMoves.length, 1, `Expected exactly 1 IN move for the transfer, found ${inMoves.length}`);
});
