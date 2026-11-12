'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-mtn-test-'));
const TEST_DB = path.join(TMP, 'test.db');
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, run, get, all, db } = require('../src/db');
const auth = require('../src/lib/auth');
const storeLocations = require('../src/lib/store_locations');
const stock = require('../src/lib/stock');

migrate();

// Ensure test workshops and projects exist
run("INSERT OR IGNORE INTO workshops (id, code, name, is_default, active) VALUES (1, 'CW', 'Central Workshop', 1, 1)");
run("INSERT OR IGNORE INTO workshops (id, code, name, is_default, active) VALUES (2, 'GWS', 'Galagedara', 0, 1)");
run("INSERT OR IGNORE INTO projects (id, name, active) VALUES (1, 'CEP-03 Project', 1)");

storeLocations.seedStoreLocations(db);
storeLocations.migrateStoreLocationsStage2(db);

// Seed roles
for (const n of ['admin', 'site_storekeeper']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
const adminRoleId = get("SELECT id FROM roles WHERE name = 'admin'").id;
const skRoleId = get("SELECT id FROM roles WHERE name = 'site_storekeeper'").id;

// Ensure capabilities
for (const c of ['stores.mtn.view', 'stores.mtn.edit', 'stores.mtn.approve']) {
  run("INSERT OR IGNORE INTO role_capabilities (role, capability, granted) VALUES ('site_storekeeper', ?, 1)", c);
  run("INSERT OR IGNORE INTO role_capabilities (role, capability, granted) VALUES ('admin', ?, 1)", c);
}

// User 1: Site A Storekeeper (assigned to Store 4: CEP-03)
const uidSiteA = run("INSERT INTO users (username, password_hash, active, workshop_id) VALUES ('sk_site_a', ?, 1, NULL)", auth.hashPassword('pw123')).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", uidSiteA, skRoleId);
run("INSERT OR REPLACE INTO store_location_access (user_id, store_location_id, can_view, can_request, can_issue, can_receive, can_dispatch, can_count) VALUES (?, 4, 1, 1, 1, 0, 1, 1)", uidSiteA);

// User 2: Destination Storekeeper at Galagedara (assigned to Store 3: Galagedara)
const uidDest = run("INSERT INTO users (username, password_hash, active, workshop_id) VALUES ('sk_galagedara', ?, 1, 2)", auth.hashPassword('pw123')).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", uidDest, skRoleId);
run("INSERT OR REPLACE INTO store_location_access (user_id, store_location_id, can_view, can_request, can_issue, can_receive, can_dispatch, can_count) VALUES (?, 3, 1, 1, 1, 1, 0, 1)", uidDest);

// User 3: Destination Storekeeper WITHOUT can_receive (Store 3: Galagedara)
const uidNoReceive = run("INSERT INTO users (username, password_hash, active, workshop_id) VALUES ('sk_gws_noreceive', ?, 1, 2)", auth.hashPassword('pw123')).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", uidNoReceive, skRoleId);
run("INSERT OR REPLACE INTO store_location_access (user_id, store_location_id, can_view, can_request, can_issue, can_receive, can_dispatch, can_count) VALUES (?, 3, 1, 1, 1, 0, 0, 1)", uidNoReceive);

// User 4: Admin
const uidAdmin = run("INSERT INTO users (username, password_hash, active, workshop_id) VALUES ('admin_tester', ?, 1, 1)", auth.hashPassword('pw123')).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", uidAdmin, adminRoleId);

const app = require('../src/server');
let server;
let base;
let cookieSiteA;
let cookieDest;
let cookieNoReceive;
let cookieAdmin;

async function loginUser(username) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'pw123' }),
  });
  assert.strictEqual(r.status, 200, `Login for ${username} should succeed`);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;

  cookieSiteA = await loginUser('sk_site_a');
  cookieDest = await loginUser('sk_galagedara');
  cookieNoReceive = await loginUser('sk_gws_noreceive');
  cookieAdmin = await loginUser('admin_tester');
});

test.after(() => {
  if (server) server.close();
});

test('MTN Receive/Accept & Stock Correctness Suite', async (t) => {
  // Setup: Create a product (e.g. Grease 10kg) and store item with opening balance
  const prodId = run(`
    INSERT INTO products (code, name, category, unit, unit_price, stock_qty, active)
    VALUES ('LUBE-GREASE-01', 'Multi-Purpose Grease (EP2)', 'oil', 'kg', 1200, 100, 1)
  `).lastInsertRowid;

  // Insert lubricant alias so resolveLubricant identifies it as an authorized lubricant product
  run(`
    INSERT OR REPLACE INTO lubricant_aliases (raw_text, raw_norm, product_id, resolved, source)
    VALUES ('Multi-Purpose Grease (EP2)', 'MULTIPURPOSEGREASEEP2', ?, 1, 'test')
  `, prodId);

  // Initial stock: 100 kg at Site A (store 4) and 0 at Galagedara (store 3)
  run(`
    INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, consumer, txn_date, store_id, physical_store_id)
    VALUES (?, 'receipt', 100, 100, 1200, 'OPENING', date('now'), 1, 4)
  `, prodId);

  // Run initial stock rebuild
  stock.rebuild();

  const greaseKey = stock.itemKey('oil', 'Multi-Purpose Grease (EP2)', 'LUBE-GREASE-01');
  const initialGlobalStock = stock.balanceOf('oil', greaseKey);
  const initialSiteAStock = stock.balanceOf('oil', greaseKey, { physical_store_id: 4 });
  const initialDestStock = stock.balanceOf('oil', greaseKey, { physical_store_id: 3 });

  assert.strictEqual(initialSiteAStock, 100, 'Site A must have 100 kg initial stock');
  assert.strictEqual(initialDestStock, 0, 'Galagedara must have 0 kg initial stock');

  let mtnId = null;

  await t.test('1. Create MTN for 10 kg grease transfer from Site A (Store 4) to Galagedara (Store 3)', async () => {
    const res = await fetch(`${base}/api/stores/mtn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieSiteA },
      body: JSON.stringify({
        txn_date: new Date().toISOString().slice(0, 10),
        from_location: 'CEP-03 Project Site Store',
        to_location: 'Galagedara Site Store',
        from_store_location_id: 4,
        to_store_location_id: 3,
        lines: [
          { description: 'Multi-Purpose Grease (EP2)', qty: 10, value: 1200 }
        ]
      })
    });
    assert.strictEqual(res.status, 201, 'MTN creation should succeed');
    const json = await res.json();
    mtnId = json.id;
    assert.ok(mtnId, 'MTN id must be returned');

    // Approve MTN
    const appRes = await fetch(`${base}/api/stores/mtn/${mtnId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieAdmin },
      body: JSON.stringify({ approved_by: 'Admin Approver', reason: 'Approved transfer' })
    });
    assert.strictEqual(appRes.status, 200, 'MTN approval should succeed');
  });

  await t.test('2. Sender dispatches MTN: Site A stock drops by 10, Galagedara unchanged, global balance unchanged', async () => {
    const dispRes = await fetch(`${base}/api/stores/mtn/${mtnId}/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieSiteA },
      body: JSON.stringify({ dispatched_by: 'Driver Perera', reason: 'Dispatched to Galagedara' })
    });
    assert.strictEqual(dispRes.status, 200, 'Dispatch should succeed');

    const siteAStock = stock.balanceOf('oil', greaseKey, { physical_store_id: 4 });
    const destStock = stock.balanceOf('oil', greaseKey, { physical_store_id: 3 });
    const globalStock = stock.balanceOf('oil', greaseKey);

    assert.strictEqual(siteAStock, 90, 'Site A stock must drop by 10 on dispatch (100 -> 90)');
    assert.strictEqual(destStock, 0, 'Galagedara stock must still be 0 while in transit');
    assert.strictEqual(globalStock, initialGlobalStock, 'Global company-wide stock must remain unchanged for transfers');
  });

  await t.test('3. Tenancy rule: Sender CANNOT receive or accept own outgoing MTN (returns 403)', async () => {
    // Attempt receive by Sender
    const recRes = await fetch(`${base}/api/stores/mtn/${mtnId}/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieSiteA },
      body: JSON.stringify({ received_by: 'Attempted by Sender' })
    });
    assert.strictEqual(recRes.status, 403, 'Sender attempting receive must be rejected with 403');
    const recJson = await recRes.json();
    assert.match(recJson.error, /Only the destination store may receive or accept this transfer/i);

    // Attempt accept by Sender
    const accRes = await fetch(`${base}/api/stores/mtn/${mtnId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieSiteA },
      body: JSON.stringify({ accepted_by: 'Attempted by Sender' })
    });
    assert.strictEqual(accRes.status, 403, 'Sender attempting accept must be rejected with 403');
    const accJson = await accRes.json();
    assert.match(accJson.error, /Only the destination store may receive or accept this transfer/i);
  });

  await t.test('4. Permission rule: User at destination WITHOUT can_receive is rejected with 403', async () => {
    const recRes = await fetch(`${base}/api/stores/mtn/${mtnId}/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieNoReceive },
      body: JSON.stringify({ received_by: 'No Receive Storekeeper' })
    });
    assert.strictEqual(recRes.status, 403, 'User without can_receive must be rejected with 403');
    const recJson = await recRes.json();
    assert.match(recJson.error, /authorization to receive MTNs/i);
  });

  await t.test('5. Destination storekeeper confirms receipt: Galagedara gains +10 kg grease', async () => {
    const recRes = await fetch(`${base}/api/stores/mtn/${mtnId}/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieDest },
      body: JSON.stringify({ received_by: 'Galagedara Storekeeper', received_designation: 'Dest Storekeeper' })
    });
    assert.strictEqual(recRes.status, 200, 'Destination storekeeper receive must succeed');

    const siteAStock = stock.balanceOf('oil', greaseKey, { physical_store_id: 4 });
    const destStock = stock.balanceOf('oil', greaseKey, { physical_store_id: 3 });
    const globalStock = stock.balanceOf('oil', greaseKey);

    assert.strictEqual(siteAStock, 90, 'Site A stock remains 90 (-10)');
    assert.strictEqual(destStock, 10, 'Galagedara stock must now be +10 upon receipt');
    assert.strictEqual(globalStock, initialGlobalStock, 'Global company-wide stock remains unchanged');
  });

  await t.test('6. Destination storekeeper accepts & bins into stock: stock remains consistent', async () => {
    const accRes = await fetch(`${base}/api/stores/mtn/${mtnId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieDest },
      body: JSON.stringify({ accepted_by: 'Galagedara In-Charge', reason: 'Checked and accepted' })
    });
    assert.strictEqual(accRes.status, 200, 'Destination storekeeper accept must succeed');

    const siteAStock = stock.balanceOf('oil', greaseKey, { physical_store_id: 4 });
    const destStock = stock.balanceOf('oil', greaseKey, { physical_store_id: 3 });
    const globalStock = stock.balanceOf('oil', greaseKey);

    assert.strictEqual(siteAStock, 90, 'Site A stock is 90');
    assert.strictEqual(destStock, 10, 'Galagedara stock is 10');
    assert.strictEqual(globalStock, initialGlobalStock, 'Global company-wide stock remains unchanged');

    // Verify cost reports count Rs 0 for this transfer
    const ym = new Date().toISOString().slice(0, 7);
    const monthCosts = require('../src/lib/month_costs');
    const rollup = monthCosts.monthlyRollup();
    const currentMonthRollup = rollup.find((o) => o.month === ym);
    assert.strictEqual(currentMonthRollup ? currentMonthRollup.oil : 0, 0, 'MTN transfer must not add to monthly oil consumption costs');

    const mRow = get("SELECT COUNT(*) c FROM stock_ledger WHERE mtn_id = ? AND kind = 'issue' AND consumer = 'Site Transfer'", mtnId);
    assert.strictEqual(mRow.c, 1, 'One issue transfer ledger row must exist');

    // Ledger rows for MTN Transfer must have consumer 'Site Transfer'
    const transferLedgerRows = all("SELECT * FROM stock_ledger WHERE mtn_id = ?", mtnId);
    assert.strictEqual(transferLedgerRows.length, 2, 'One issue and one receipt ledger row');
  });

  await t.test('7. Migration 053 idempotency: Running twice produces same state and changes nothing', () => {
    const migration = require('../src/migrate/053_mtn_store_locations');
    const result = migration.runMigration(db);
    assert.strictEqual(result.fromUpdated, 0, 'No origin stores should be re-updated on second run');
    assert.strictEqual(result.toUpdated, 0, 'No destination stores should be re-updated on second run');
  });
});
