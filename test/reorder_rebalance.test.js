'use strict';

/**
 * ===========================================================================
 * Step 7 Test Suite: Automated Reorder Point (ROP) & Inter-Workshop Rebalancing
 *
 * Validates:
 * 1. Demand Forecasting (ADD & monthly consumption) from stock_moves
 * 2. Dynamic Safety Stock (SS), Reorder Point (ROP), and Order Qty (ROQ)
 * 3. Stock Health evaluation: STOCKOUT, CRITICAL, LOW, HEALTHY, SURPLUS
 * 4. Inter-workshop opportunity discovery and safe surplus matching
 * 5. 1-Click Material Transfer Note (MTN) draft creation with universal chain
 * 6. Applying ROP levels to store_reorder table with audit logging
 * ===========================================================================
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-step7-'));
process.env.DB_PATH = path.join(TMP, 'step7.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all, tx } = require('../src/db');
const reorderRebalance = require('../src/lib/reorder_rebalance');
const chainPipeline = require('../src/lib/chain_pipeline');
const stores = require('../src/lib/stores');

migrate();

// 1. Seed Roles & Permissions
for (const n of ['admin', 'storekeeper', 'workshop', 'operational_manager']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
run("INSERT OR IGNORE INTO roles (name, label) VALUES ('stores_admin', 'Stores Admin')");
run("INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES ('stores_admin', 'stores', 'full')");

// 2. Seed Workshops (Stores)
run("INSERT OR IGNORE INTO workshops (id, name, code, is_default, own_store, active) VALUES (1, 'Central Workshop', 'CW', 1, 1, 1)");
run("INSERT OR IGNORE INTO workshops (id, name, code, is_default, own_store, active) VALUES (2, 'Badalgama Site', 'BDG', 0, 1, 1)");
run("UPDATE workshops SET own_store = 1, active = 1 WHERE id IN (1, 2)");

// 3. Seed Users
run("INSERT OR IGNORE INTO users (id, username, password_hash, full_name, active, workshop_id) VALUES (1, 'admin', 'hash', 'System Admin', 1, 1)");
run("INSERT OR IGNORE INTO users (id, username, password_hash, full_name, active, workshop_id) VALUES (2, 'bdg_sk', 'hash', 'Badalgama Storekeeper', 1, 2)");
const adminUser = { id: 1, username: 'admin', fullName: 'System Admin', roles: ['admin'], workshop_id: 1 };
const bdgUser = { id: 2, username: 'bdg_sk', fullName: 'Badalgama Storekeeper', roles: ['storekeeper'], workshop_id: 2 };

// 4. Seed Stock Items
run("INSERT OR IGNORE INTO stock_items (id, section, item_key, name, unit) VALUES (1, 'general', 'GEN-OIL-SEAL', 'Hydraulic Oil Seal 45x65', 'nos')");
run("INSERT OR IGNORE INTO stock_items (id, section, item_key, name, unit) VALUES (2, 'filter', 'FLT-HYD-01', 'Hydraulic Return Filter HIFI', 'nos')");

test('Step 7.1: Demand forecasting calculates correct ADD and monthly demand', () => {
  // Clear any previous moves for this test key
  run("DELETE FROM stock_moves WHERE item_key = 'GEN-OIL-SEAL'");

  // No movements yet
  const d0 = reorderRebalance.getItemDemandHistory('general', 'GEN-OIL-SEAL', 1, { days: 90 });
  assert.strictEqual(d0.total_issued, 0);
  assert.strictEqual(d0.avg_daily_demand, 0);
  assert.strictEqual(d0.monthly_demand, 0);

  // Add 180 units issued across the last 90 days at store 1 (2 per day)
  run(`
    INSERT INTO stock_moves (store_id, section, item_key, item_name, kind, qty, txn_date, counts, source_table, source_id)
    VALUES (1, 'general', 'GEN-OIL-SEAL', 'Hydraulic Oil Seal 45x65', 'out', 90, date('now', '-30 day'), 1, 'manual', 1)
  `);
  run(`
    INSERT INTO stock_moves (store_id, section, item_key, item_name, kind, qty, txn_date, counts, source_table, source_id)
    VALUES (1, 'general', 'GEN-OIL-SEAL', 'Hydraulic Oil Seal 45x65', 'out', 90, date('now', '-10 day'), 1, 'manual', 2)
  `);

  const d1 = reorderRebalance.getItemDemandHistory('general', 'GEN-OIL-SEAL', 1, { days: 90 });
  assert.strictEqual(d1.total_issued, 180);
  assert.strictEqual(d1.issue_count, 2);
  assert.strictEqual(d1.avg_daily_demand, 2); // 180 / 90 = 2
  assert.strictEqual(d1.monthly_demand, 60);  // 2 * 30 = 60
});

test('Step 7.2: Dynamic ROP, Safety Stock, and ROQ formulas', () => {
  // Demand: ADD = 2, LeadTime = 7, SafetyDays = 7
  // SS = ceil(2 * 7) = 14
  // ROP = ceil(2 * 7 + 14) = 28
  // ROQ = max(ceil(2 * 30), ceil(14 * 2), 1) = max(60, 28, 1) = 60
  const calc = reorderRebalance.calculateItemRop('general', 'GEN-OIL-SEAL', 1, {
    leadTimeDays: 7,
    safetyDays: 7,
    demandDays: 90
  });

  assert.strictEqual(calc.avg_daily_demand, 2);
  assert.strictEqual(calc.safety_stock, 14);
  assert.strictEqual(calc.rop, 28);
  assert.strictEqual(calc.roq, 60);
});

test('Step 7.3: Stock health statuses and shortfall / surplus detection', () => {
  // Currently balance is negative due to out movements without in: balance = -180 -> STOCKOUT
  const s0 = reorderRebalance.calculateItemRop('general', 'GEN-OIL-SEAL', 1);
  assert.strictEqual(s0.status, 'STOCKOUT');
  assert.strictEqual(s0.shortfall > 0, true);
  assert.strictEqual(s0.available_surplus, 0);

  // Receive stock at store 1 to make it CRITICAL (e.g. balance = 10 <= SS 14)
  // Total in: 190. Net balance: 190 - 180 = 10
  run(`
    INSERT INTO stock_moves (store_id, section, item_key, item_name, kind, qty, txn_date, counts, source_table, source_id)
    VALUES (1, 'general', 'GEN-OIL-SEAL', 'Hydraulic Oil Seal 45x65', 'in', 190, date('now'), 1, 'manual', 3)
  `);
  const s1 = reorderRebalance.calculateItemRop('general', 'GEN-OIL-SEAL', 1);
  assert.strictEqual(s1.balance, 10);
  assert.strictEqual(s1.status, 'CRITICAL');
  assert.strictEqual(s1.shortfall, 18); // ROP(28) - 10 = 18

  // Receive more stock to make it LOW (e.g. balance = 20 <= ROP 28)
  run(`
    INSERT INTO stock_moves (store_id, section, item_key, item_name, kind, qty, txn_date, counts, source_table, source_id)
    VALUES (1, 'general', 'GEN-OIL-SEAL', 'Hydraulic Oil Seal 45x65', 'in', 10, date('now'), 1, 'manual', 4)
  `);
  const s2 = reorderRebalance.calculateItemRop('general', 'GEN-OIL-SEAL', 1);
  assert.strictEqual(s2.balance, 20);
  assert.strictEqual(s2.status, 'LOW');
  assert.strictEqual(s2.shortfall, 8); // ROP(28) - 20 = 8

  // Receive enough to make it HEALTHY (e.g. balance = 35: between ROP 28 and ROP+SS 42)
  run(`
    INSERT INTO stock_moves (store_id, section, item_key, item_name, kind, qty, txn_date, counts, source_table, source_id)
    VALUES (1, 'general', 'GEN-OIL-SEAL', 'Hydraulic Oil Seal 45x65', 'in', 15, date('now'), 1, 'manual', 5)
  `);
  const s3 = reorderRebalance.calculateItemRop('general', 'GEN-OIL-SEAL', 1);
  assert.strictEqual(s3.balance, 35);
  assert.strictEqual(s3.status, 'HEALTHY');
  assert.strictEqual(s3.shortfall, 0);
  assert.strictEqual(s3.available_surplus, 0);

  // Receive a surplus (balance = 60 > ROP+SS 42)
  // Available surplus = floor(60 - 42) = 18
  run(`
    INSERT INTO stock_moves (store_id, section, item_key, item_name, kind, qty, txn_date, counts, source_table, source_id)
    VALUES (1, 'general', 'GEN-OIL-SEAL', 'Hydraulic Oil Seal 45x65', 'in', 25, date('now'), 1, 'manual', 6)
  `);
  const s4 = reorderRebalance.calculateItemRop('general', 'GEN-OIL-SEAL', 1);
  assert.strictEqual(s4.balance, 60);
  assert.strictEqual(s4.status, 'SURPLUS');
  assert.strictEqual(s4.shortfall, 0);
  assert.strictEqual(s4.available_surplus, 18);
});

test('Step 7.4: Inter-workshop rebalancing engine matches surplus store to deficit store', () => {
  // Store 1 (CW) has 18 SURPLUS of GEN-OIL-SEAL (from previous test)
  // Store 2 (BDG) has an urgent DEFICIT of GEN-OIL-SEAL:
  // Set store 2 with ROP = 10, balance = 2 (shortfall = 8)
  run("DELETE FROM store_reorder WHERE store_id = 2 AND item_key = 'GEN-OIL-SEAL'");
  run(`
    INSERT INTO store_reorder (store_id, section, item_key, level, safety_stock, avg_daily_demand, lead_time_days)
    VALUES (2, 'general', 'GEN-OIL-SEAL', 10, 5, 0.5, 7)
  `);
  run("DELETE FROM stock_moves WHERE store_id = 2 AND item_key = 'GEN-OIL-SEAL'");
  run(`
    INSERT INTO stock_moves (store_id, section, item_key, item_name, kind, qty, txn_date, counts, source_table, source_id)
    VALUES (2, 'general', 'GEN-OIL-SEAL', 'Hydraulic Oil Seal 45x65', 'in', 2, date('now'), 1, 'manual', 7)
  `);

  // Run rebalance matching for Store 2
  const opps = reorderRebalance.findRebalanceOpportunities({ storeId: 2 });
  assert.strictEqual(opps.length >= 1, true);

  const match = opps.find((o) => o.item_key === 'GEN-OIL-SEAL');
  assert.ok(match, 'Opportunity match found for GEN-OIL-SEAL');
  assert.strictEqual(match.from_store_id, 1); // From Central Workshop
  assert.strictEqual(match.to_store_id, 2);   // To Badalgama Site
  assert.strictEqual(match.to_balance, 2);
  assert.strictEqual(match.shortfall, 8);
  assert.strictEqual(match.from_available_surplus, 18);
  // Transfer qty is min(shortfall 8, available_surplus 18) = 8
  assert.strictEqual(match.suggested_transfer_qty, 8);
  assert.strictEqual(match.urgency, 'HIGH'); // to_status is CRITICAL
});

test('Step 7.5: 1-Click Transfer MTN generation with universal chain tracking', () => {
  const ws1 = stores.byId(1);
  const ws2 = stores.byId(2);

  const result = reorderRebalance.createRebalanceMtn({
    fromStoreId: 1,
    toStoreId: 2,
    items: [
      {
        section: 'general',
        item_key: 'GEN-OIL-SEAL',
        item_name: 'Hydraulic Oil Seal 45x65',
        qty: 8,
        unit: 'nos'
      }
    ],
    reason: 'Deficit rebalance transfer from CW to BDG',
    user: adminUser
  });

  assert.strictEqual(result.ok, true);
  assert.ok(result.mtn_id > 0);
  assert.ok(result.mtn_no);
  assert.ok(result.chain_no.startsWith('CHN-'));
  assert.strictEqual(result.items_count, 1);

  // Verify MTN row in database
  const mtn = get('SELECT * FROM mtn WHERE id = ?', result.mtn_id);
  assert.strictEqual(mtn.status, 'draft');
  assert.strictEqual(mtn.chain_no, result.chain_no);
  assert.strictEqual(mtn.from_location, ws1.name);
  assert.strictEqual(mtn.to_location, ws2.name);

  // Verify MTN Line
  const line = get('SELECT * FROM mtn_lines WHERE mtn_id = ?', result.mtn_id);
  assert.ok(line);
  assert.strictEqual(line.description, 'Hydraulic Oil Seal 45x65');
  assert.strictEqual(line.qty, 8);
  assert.strictEqual(line.from_store_id, 1);
  assert.strictEqual(line.to_store_id, 2);
  assert.strictEqual(line.reason, 'Stock Rebalance');
});

test('Step 7.6: Applying ROP levels updates store_reorder with complete metrics', () => {
  const itemsToApply = [
    {
      section: 'general',
      item_key: 'GEN-OIL-SEAL',
      level: 28,
      safety_stock: 14,
      reorder_qty: 60,
      avg_daily_demand: 2,
      lead_time_days: 7,
      auto_calc: 1
    }
  ];

  const applyRes = reorderRebalance.applyRopLevels(1, itemsToApply, adminUser);
  assert.strictEqual(applyRes.ok, true);
  assert.strictEqual(applyRes.applied_count, 1);

  const sr = get("SELECT * FROM store_reorder WHERE store_id = 1 AND section = 'general' AND item_key = 'GEN-OIL-SEAL'");
  assert.ok(sr);
  assert.strictEqual(sr.level, 28);
  assert.strictEqual(sr.safety_stock, 14);
  assert.strictEqual(sr.reorder_qty, 60);
  assert.strictEqual(sr.avg_daily_demand, 2);
  assert.strictEqual(sr.lead_time_days, 7);
  assert.strictEqual(sr.auto_calc, 1);
  assert.ok(sr.last_calculated_at);
});
