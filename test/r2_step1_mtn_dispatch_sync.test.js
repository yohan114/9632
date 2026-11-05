'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-mtn-sync-'));
const TEST_DB = path.join(TMP, 'test.db');
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, run, get, db } = require('../src/db');
const auth = require('../src/lib/auth');
const storeLocations = require('../src/lib/store_locations');
migrate();
storeLocations.seedStoreLocations(db);

// Seed roles and user
for (const n of ['admin', 'storekeeper']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
const uid = run("INSERT INTO users (username, password_hash, active, workshop_id) VALUES ('sk_tester', ?, 1, 1)", auth.hashPassword('pw')).lastInsertRowid;
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
    body: JSON.stringify({ username: 'sk_tester', password: 'pw' }),
  });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
});

test.after(() => {
  if (server) server.close();
});

test('syncMtnStock runs only at dispatch, claims stock_synced_at, and is idempotent', async () => {
  // Create an item with initial balance 100
  const itemId = run(`
    INSERT INTO store_items (name, part_number, category, unit, balance, is_general)
    VALUES ('Air Hose 20m', 'HOSE-01', 'General', 'nos', 100, 1)
  `).lastInsertRowid;

  run(`
    INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, unit_price, ref, txn_date, store_id, physical_store_id)
    VALUES (?, 'receipt', 100, 100, 500, 'OPENING', date('now'), 1, 1)
  `, itemId);

  // 1. Create an MTN
  const createRes = await fetch(`${base}/api/stores/mtn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      txn_date: new Date().toISOString().slice(0, 10),
      from_location: 'Central Main Stores',
      to_location: 'Workshop 2',
      from_store_location_id: 1,
      to_store_location_id: 2,
      lines: [
        { store_item_id: itemId, description: 'Air Hose 20m', qty: 10, value: 500 }
      ]
    })
  });
  assert.strictEqual(createRes.status, 201, 'MTN creation should succeed');
  const mtnData = await createRes.json();
  const mtnId = mtnData.id;

  // Assert: Stock must NOT fall on creation
  const txnsAfterCreate = get("SELECT COUNT(*) c FROM general_item_txns WHERE ref = 'MTN Transfer'").c;
  assert.strictEqual(txnsAfterCreate, 0, 'No MTN Transfer transaction should be created at MTN creation');

  const mtnRow = get('SELECT stock_synced_at FROM mtn WHERE id = ?', mtnId);
  assert.strictEqual(mtnRow.stock_synced_at, null, 'stock_synced_at must be null after create');

  // 2. Dispatch the MTN
  const dispRes = await fetch(`${base}/api/stores/mtn/${mtnId}/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      dispatched_by: 'Storekeeper',
      reason: 'Dispatch to WS2'
    })
  });
  assert.strictEqual(dispRes.status, 200, 'Dispatch should succeed');

  // Assert: Stock falls once
  const txnsAfterDisp = get("SELECT COUNT(*) c FROM general_item_txns WHERE ref = 'MTN Transfer'").c;
  assert.strictEqual(txnsAfterDisp, 1, 'Exactly one MTN Transfer transaction should be created on dispatch');

  const mtnRowAfterDisp = get('SELECT stock_synced_at FROM mtn WHERE id = ?', mtnId);
  assert.ok(mtnRowAfterDisp.stock_synced_at, 'stock_synced_at must be stamped on dispatch');

  // 3. Dispatch a second time
  const dispRes2 = await fetch(`${base}/api/stores/mtn/${mtnId}/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      dispatched_by: 'Storekeeper',
      reason: 'Repeat dispatch attempt'
    })
  });
  assert.strictEqual(dispRes2.status, 200);

  // Assert: No double deduction
  const txnsAfterDisp2 = get("SELECT COUNT(*) c FROM general_item_txns WHERE ref = 'MTN Transfer'").c;
  assert.strictEqual(txnsAfterDisp2, 1, 'Stock must not be deducted a second time on duplicate dispatch');
});
