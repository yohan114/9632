'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-h2-test-'));
const TEST_DB = path.join(TMP, 'test.db');
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, run, get, all, db } = require('../src/db');
const auth = require('../src/lib/auth');
const storeLocations = require('../src/lib/store_locations');
migrate();
storeLocations.seedStoreLocations(db);

for (const n of ['admin', 'storekeeper']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
const uid = run("INSERT INTO users (username, password_hash, active, workshop_id) VALUES ('sk_tester2', ?, 1, 1)", auth.hashPassword('pw')).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'admin'))", uid);

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
    body: JSON.stringify({ username: 'sk_tester2', password: 'pw' }),
  });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
});

test.after(() => {
  if (server) server.close();
});

test('H2: transfers use per-store movement only and do not lower global store_items.balance and products.stock_qty', async () => {
  // 1. Seed store item with balance 100
  const itemId = run(`
    INSERT INTO store_items (name, part_number, category, unit, balance, is_general)
    VALUES ('Bolt M12x50', 'BLT-12', 'General', 'nos', 100, 1)
  `).lastInsertRowid;

  // 2. Seed product with stock_qty 50
  const prodId = run(`
    INSERT INTO products (code, name, category, unit, stock_qty, active)
    VALUES ('LUB-HD46', 'HD46 Hydraulic Oil', 'hydraulic', 'L', 50, 1)
  `).lastInsertRowid;

  // 3. Create MTN transferring 10 bolts and 5 litres oil from Store 1 to Store 2
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
        { store_item_id: itemId, description: 'Bolt M12x50', qty: 10, value: 50 },
        { description: 'HD46 Hydraulic Oil', qty: 5, value: 800 }
      ]
    })
  });
  assert.strictEqual(createRes.status, 201, 'MTN creation should succeed');
  const mtnData = await createRes.json();
  const mtnId = mtnData.id;

  // 4. Dispatch the MTN
  const dispRes = await fetch(`${base}/api/stores/mtn/${mtnId}/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ dispatched_by: 'Storekeeper', reason: 'Dispatched to WS2' })
  });
  assert.strictEqual(dispRes.status, 200, 'Dispatch should succeed');

  // 5. Accept the MTN at receiving store
  const acceptRes = await fetch(`${base}/api/stores/mtn/${mtnId}/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ accepted_by: 'Receiver WS2', reason: 'Received and placed on shelf' })
  });
  assert.strictEqual(acceptRes.status, 200, 'Accept should succeed');

  // 6. Assertions:
  // A. Global balance must NOT fall
  const boltBal = get('SELECT balance FROM store_items WHERE id = ?', itemId).balance;
  assert.strictEqual(boltBal, 100, 'Global store_items.balance must not be lowered for transfers');

  const oilQty = get('SELECT stock_qty FROM products WHERE id = ?', prodId).stock_qty;
  assert.strictEqual(oilQty, 50, 'Global products.stock_qty must not be lowered for transfers');

  // B. Per-store movements in stock_moves: out at sender, in at receiver, net sum = 0
  const boltMoves = all("SELECT kind, qty, physical_store_id FROM stock_moves WHERE source_table = 'mtn_lines' AND item_name = 'Bolt M12x50'");
  assert.strictEqual(boltMoves.length, 2, 'Bolt must have exactly one out and one in movement');
  const boltOut = boltMoves.find((m) => m.kind === 'out');
  const boltIn = boltMoves.find((m) => m.kind === 'in');
  assert.strictEqual(boltOut.qty, 10);
  assert.strictEqual(boltIn.qty, 10);
  assert.strictEqual(boltOut.physical_store_id, 1);
  assert.strictEqual(boltIn.physical_store_id, 2);
});
