'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-m5-scoping-'));
const TEST_DB = path.join(TMP, 'test.db');
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { migrate, run, get, db } = require('../src/db');
const storeLocations = require('../src/lib/store_locations');
migrate();
storeLocations.seedStoreLocations(db);

// Seed workshops
run("INSERT OR IGNORE INTO workshops (id, code, name, active) VALUES (1, 'CW', 'Central Workshop', 1)");
run("INSERT OR IGNORE INTO workshops (id, code, name, active) VALUES (2, 'WS2', 'Workshop 2', 1)");

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test('M5: syncIssueToLedgers scopes previous balance to the same store and refuses fallback defaults', async () => {
  // Create an item
  const itemRes = run(`INSERT INTO store_items (part_number, name, category, balance, unit_cost, is_general)
                       VALUES ('TEST-M5', 'Test Scoped Item M5', 'Consumables', 150, 100, 1)`);
  const itemId = itemRes.lastInsertRowid;

  // Store 1 (Central Main Stores) initial balance: 100
  run(`INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, unit_price, ref, txn_date, store_id, physical_store_id)
       VALUES (?, 'receipt', 100, 100, 100, 'Opening Store 1', '2026-11-01', 1, 1)`, itemId);

  // Store 2 (Central Main Workshop Stores) initial balance: 50
  run(`INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, unit_price, ref, txn_date, store_id, physical_store_id)
       VALUES (?, 'receipt', 50, 50, 100, 'Opening Store 2', '2026-11-02', 2, 2)`, itemId);

  // Load stores router
  const storesRouter = require('../src/routes/stores');

  // Issue 10 from Store 1 on 2026-11-03
  const iss1 = run(`INSERT INTO issues (store_item_id, description, qty, unit_price, issue_date, physical_store_id, store_id)
                    VALUES (?, 'Test Scoped Item M5', 10, 100, '2026-11-03', 1, 1)`, itemId).lastInsertRowid;
  storesRouter.syncIssueToLedgers(iss1);

  // Verify Store 1 balance after is 90
  const git1 = get(`SELECT balance_after FROM general_item_txns WHERE source_issue_id = ?`, iss1);
  assert.ok(git1, 'Store 1 general_item_txns record must exist');
  assert.strictEqual(git1.balance_after, 90, 'Store 1 balance should be 100 - 10 = 90');

  // Issue 5 from Store 2 on 2026-11-04
  const iss2 = run(`INSERT INTO issues (store_item_id, description, qty, unit_price, issue_date, physical_store_id, store_id)
                    VALUES (?, 'Test Scoped Item M5', 5, 100, '2026-11-04', 2, 2)`, itemId).lastInsertRowid;
  storesRouter.syncIssueToLedgers(iss2);

  // Verify Store 2 balance after is 45 (50 - 5 = 45), NOT (90 - 5 = 85)
  const git2 = get(`SELECT balance_after FROM general_item_txns WHERE source_issue_id = ?`, iss2);
  assert.ok(git2, 'Store 2 general_item_txns record must exist');
  assert.strictEqual(git2.balance_after, 45, 'Store 2 balance should be 50 - 5 = 45, not contaminated by Store 1 balance');

  // Issue with NO physical_store_id should NOT default to physical_store_id = 2
  const issNoStore = run(`INSERT INTO issues (store_item_id, description, qty, unit_price, issue_date)
                          VALUES (?, 'Test Scoped Item M5', 2, 100, '2026-11-05')`, itemId).lastInsertRowid;
  storesRouter.syncIssueToLedgers(issNoStore);

  const gitNoStore = get(`SELECT * FROM general_item_txns WHERE source_issue_id = ?`, issNoStore);
  assert.strictEqual(gitNoStore, undefined, 'Issue without store assignment must be refused from defaulting to store 2');
});
