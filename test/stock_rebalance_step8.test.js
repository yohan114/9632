'use strict';

/**
 * ===========================================================================
 * Step 8 Test Suite: Inter-Store Stock Rebalancing & Physical Store ROP
 *
 * Validates Phase D requirements:
 * 1. Physical store hierarchy: Central Main Stores (1), Main Workshop (2),
 *    and unified remote Site Stores (3 and 4).
 * 2. Historical demand analysis & ADD computation per physical store shelf.
 * 3. Dynamic ROP, Safety Stock, ROQ calculation and application to store_reorder.
 * 4. Multi-site health evaluation (STOCKOUT, CRITICAL, LOW, HEALTHY, SURPLUS).
 * 5. Inter-site rebalancing engine prioritizing direct Site-to-Site transfers
 *    over central depot routing to prevent logistics delays.
 * 6. Donor protection: donor balance NEVER drops below its safe buffer (ROP + SS).
 * 7. 1-Click Rebalance MTN generation linking physical store locations
 *    and universal chain tracking (CHN-YYYY-XXXXX).
 * 8. Dispatch & destination acceptance moving physical shelf inventory.
 * ===========================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-stock-p8-'));
process.env.DB_PATH = path.join(TMP, 'stock_p8.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');

const { migrate, run, get, all, db } = require('../src/db');
const storeLocations = require('../src/lib/store_locations');
const stock = require('../src/lib/stock');
const reorderRebalance = require('../src/lib/reorder_rebalance');

migrate();

// 1. Seed Roles & Users
for (const n of ['admin', 'storekeeper', 'operational_manager']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
run("INSERT OR IGNORE INTO users (id, username, password_hash, full_name, active) VALUES (1, 'admin', 'hash', 'System Admin', 1)");
run("INSERT OR IGNORE INTO users (id, username, password_hash, full_name, active) VALUES (2, 'site.a.sk', 'hash', 'Galagedara Storekeeper', 1)");
run("INSERT OR IGNORE INTO users (id, username, password_hash, full_name, active) VALUES (3, 'site.b.sk', 'hash', 'Kurunegala Storekeeper', 1)");
const adminUser = { id: 1, username: 'admin', fullName: 'System Admin' };

// 2. Seed Workshops
run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active, own_store) VALUES (1, 'CW', 'Central Workshop — Badalgama', 'Badalgama', 1, 1, 1)");
run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active, own_store) VALUES (2, 'GWS', 'Galagedara Workshop', 'Galagedara', 0, 1, 1)");
run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active, own_store) VALUES (3, 'KRN', 'Kurunegala Workshop', 'Kurunegala', 0, 1, 1)");

// 3. Seed Physical Stores and Hierarchy
storeLocations.seedStoreLocations(db);
storeLocations.migrateStoreLocationsStage2(db);

// Ensure second site store for Kurunegala (Site Store B)
const msLoc = get("SELECT id, code, name FROM store_locations WHERE code = 'MAIN-STORES'");
const wsLoc = get("SELECT id, code, name FROM store_locations WHERE code = 'MAIN-WORKSHOP'");
const siteALoc = get("SELECT id, code, name FROM store_locations WHERE code = 'SITE-STORE-GWS'");

let siteBLoc = get("SELECT id, code, name FROM store_locations WHERE code = 'SITE-STORE-KRN'");
if (!siteBLoc) {
  run(`
    INSERT INTO store_locations (code, name, store_type, parent_store_id, workshop_id, active, is_default, notes)
    VALUES ('SITE-STORE-KRN', 'Kurunegala Site Store', 'SITE_STORE', ?, 3, 1, 0, 'Unified site store for Kurunegala project')
  `, msLoc.id);
  siteBLoc = get("SELECT id, code, name FROM store_locations WHERE code = 'SITE-STORE-KRN'");
}
run(`
  INSERT OR REPLACE INTO store_location_mappings (legacy_store_id, workshop_id, store_location_id, is_primary)
  VALUES (3, 3, ?, 1)
`, siteBLoc.id);

test('Phase D: Inter-Store Stock Rebalancing & Physical Store ROP', async (t) => {
  await t.test('1. Physical store topology & access', () => {
    assert.ok(msLoc && msLoc.id === 1, 'Central Main Stores exists (ID 1)');
    assert.ok(wsLoc && wsLoc.id === 2, 'Main Workshop Stores exists (ID 2)');
    assert.ok(siteALoc && siteALoc.id === 3, 'Site Store A exists (ID 3)');
    assert.ok(siteBLoc && siteBLoc.id === 4, 'Site Store B exists (ID 4)');

    const allStores = reorderRebalance.getAllActiveStores();
    assert.ok(allStores.some((s) => s.physical_store_id === 1), 'Central Main Stores in active list');
    assert.ok(allStores.some((s) => s.physical_store_id === 2), 'Central Main Workshop in active list');
    assert.ok(allStores.some((s) => s.physical_store_id === 3), 'Site Store A in active list');
    assert.ok(allStores.some((s) => s.physical_store_id === 4), 'Site Store B in active list');
  });

  const partName = 'Hydraulic Hose R2-08';
  const section = 'general';
  const partKey = stock.itemKey(section, partName);

  // Seed stock item
  run("INSERT OR IGNORE INTO stock_items (section, item_key, name, unit) VALUES (?, ?, ?, 'nos')", section, partKey, partName);

  await t.test('2. Shelf-level consumption history and Average Daily Demand (ADD)', () => {
    // Simulate 180 units issued from Site Store A over the last 90 days (2 units/day)
    run(`
      INSERT INTO stock_moves (physical_store_id, store_id, section, item_key, item_name, kind, qty, txn_date, counts, source_table, source_id)
      VALUES (3, 2, ?, ?, ?, 'out', 90, date('now', '-40 day'), 1, 'manual', 101)
    `, section, partKey, partName);
    run(`
      INSERT INTO stock_moves (physical_store_id, store_id, section, item_key, item_name, kind, qty, txn_date, counts, source_table, source_id)
      VALUES (3, 2, ?, ?, ?, 'out', 90, date('now', '-10 day'), 1, 'manual', 102)
    `, section, partKey, partName);

    const history = reorderRebalance.getItemDemandHistory(section, partKey, { physical_store_id: 3 }, { days: 90 });
    assert.strictEqual(history.total_issued, 180, 'Total issued is 180 units');
    assert.strictEqual(history.issue_count, 2, 'Two distinct issue transactions');
    assert.strictEqual(history.avg_daily_demand, 2, 'ADD is 2.0 units per day');
    assert.strictEqual(history.monthly_demand, 60, 'Monthly demand is 60 units');
  });

  await t.test('3. Dynamic ROP, Safety Stock (SS), and ROQ calculation for Site Store A', () => {
    // Formula check:
    // Lead Time = 7 days, Safety Days = 7 days
    // SS = ceil(ADD * 7) = ceil(2 * 7) = 14
    // ROP = ceil(ADD * 7 + SS) = 14 + 14 = 28
    // ROQ = max(ceil(2 * 30), ceil(14 * 2)) = 60
    const calc = reorderRebalance.calculateItemRop(section, partKey, { physical_store_id: 3 }, {
      leadTimeDays: 7,
      safetyDays: 7,
      demandDays: 90
    });

    assert.strictEqual(calc.avg_daily_demand, 2);
    assert.strictEqual(calc.safety_stock, 14);
    assert.strictEqual(calc.rop, 28);
    assert.strictEqual(calc.roq, 60);

    // Apply calculated ROP to store_reorder table for physical_store_id 3
    const applyRes = reorderRebalance.applyRopLevels({ physical_store_id: 3 }, [{
      section,
      item_key: partKey,
      rop: 28,
      safety_stock: 14,
      reorder_qty: 60,
      avg_daily_demand: 2,
      lead_time_days: 7
    }], adminUser);

    assert.strictEqual(applyRes.ok, true);
    assert.strictEqual(applyRes.applied_count, 1);

    const row = get('SELECT * FROM store_reorder WHERE physical_store_id = ? AND item_key = ?', 3, partKey);
    assert.ok(row, 'store_reorder row saved with physical_store_id');
    assert.strictEqual(row.level, 28);
    assert.strictEqual(row.safety_stock, 14);
    assert.strictEqual(row.reorder_qty, 60);
  });

  await t.test('4. Stock Health classification: Site Store A in CRITICAL deficit', () => {
    // Net balance at Site Store A:
    // Issues: -180. Add 190 in stock -> Net balance = 10 units
    // Since balance (10) <= Safety Stock (14), status must be CRITICAL! Shortfall = 28 - 10 = 18.
    run(`
      INSERT INTO stock_moves (physical_store_id, store_id, section, item_key, item_name, kind, qty, txn_date, counts, source_table, source_id)
      VALUES (3, 2, ?, ?, ?, 'in', 190, date('now'), 1, 'manual', 103)
    `, section, partKey, partName);

    const health = reorderRebalance.calculateItemRop(section, partKey, { physical_store_id: 3 });
    assert.strictEqual(health.balance, 10, 'On-hand balance is 10');
    assert.strictEqual(health.status, 'CRITICAL', 'Status is CRITICAL');
    assert.strictEqual(health.shortfall, 18, 'Shortfall is 18 (28 ROP - 10 bal)');
    assert.strictEqual(health.available_surplus, 0, 'No surplus available at deficit store');
  });

  await t.test('5. Stock surplus at remote Site Store B and Central Main Workshop', () => {
    // Setup Site Store B (Kurunegala, ID 4):
    // ROP = 20, SS = 10, Safe Buffer = ROP + SS = 30
    // Balance = 55 units -> Available surplus = 55 - 30 = 25 units!
    reorderRebalance.applyRopLevels({ physical_store_id: 4 }, [{
      section,
      item_key: partKey,
      rop: 20,
      safety_stock: 10,
      reorder_qty: 40,
      avg_daily_demand: 1.5,
      lead_time_days: 7
    }], adminUser);

    run(`
      INSERT INTO stock_moves (physical_store_id, store_id, section, item_key, item_name, kind, qty, txn_date, counts, source_table, source_id)
      VALUES (4, 3, ?, ?, ?, 'in', 55, date('now'), 1, 'manual', 104)
    `, section, partKey, partName);

    const siteBHealth = reorderRebalance.calculateItemRop(section, partKey, { physical_store_id: 4 });
    assert.strictEqual(siteBHealth.balance, 55);
    assert.strictEqual(siteBHealth.status, 'SURPLUS');
    assert.strictEqual(siteBHealth.available_surplus, 25, 'Available surplus is 25 units');

    // Also setup Central Main Workshop (ID 2):
    // ROP = 20, SS = 10 -> Safe Buffer = 30. Balance = 45 -> Surplus = 15.
    reorderRebalance.applyRopLevels({ physical_store_id: 2 }, [{
      section,
      item_key: partKey,
      rop: 20,
      safety_stock: 10,
      reorder_qty: 40,
      avg_daily_demand: 1.5,
      lead_time_days: 7
    }], adminUser);

    run(`
      INSERT INTO stock_moves (physical_store_id, store_id, section, item_key, item_name, kind, qty, txn_date, counts, source_table, source_id)
      VALUES (2, 1, ?, ?, ?, 'in', 45, date('now'), 1, 'manual', 105)
    `, section, partKey, partName);

    const centralHealth = reorderRebalance.calculateItemRop(section, partKey, { physical_store_id: 2 });
    assert.strictEqual(centralHealth.balance, 45);
    assert.strictEqual(centralHealth.status, 'SURPLUS');
    assert.strictEqual(centralHealth.available_surplus, 15);
  });

  await t.test('6. Inter-site rebalance pairing prioritizing Site Store B over Central depot', () => {
    // Site Store A (ID 3) needs 18 units.
    // Site Store B (ID 4, SITE_STORE) has 25 surplus.
    // Central Main Workshop (ID 2, MAIN_WORKSHOP_STORE) has 15 surplus.
    // The engine should prioritize direct Site Store B -> Site Store A transfer!
    const opps = reorderRebalance.findRebalanceOpportunities({ physicalStoreId: 3, section });
    assert.ok(opps.length >= 1, 'Found rebalance opportunities');

    const topOpp = opps[0];
    assert.strictEqual(topOpp.item_key, partKey);
    assert.strictEqual(topOpp.from_store_location_id, 4, 'Donor is Site Store B (Kurunegala)');
    assert.strictEqual(topOpp.to_store_location_id, 3, 'Recipient is Site Store A (Galagedara)');
    assert.strictEqual(topOpp.shortfall, 18, 'Shortfall at Site Store A is 18');
    assert.strictEqual(topOpp.from_available_surplus, 25, 'Site Store B has 25 available surplus');
    assert.strictEqual(topOpp.suggested_transfer_qty, 18, 'Suggested transfer is min(18, 25) = 18');
    assert.strictEqual(topOpp.urgency, 'HIGH', 'Urgency is HIGH due to CRITICAL stock health');
  });

  let rebalanceMtnId, rebalanceMtnNo, rebalanceChainNo;

  await t.test('7. 1-Click Rebalance MTN creation with physical store location links', () => {
    const res = reorderRebalance.createRebalanceMtn({
      fromStoreLocationId: 4,
      toStoreLocationId: 3,
      items: [
        {
          section,
          item_key: partKey,
          item_name: partName,
          qty: 18,
          unit: 'nos'
        }
      ],
      reason: 'Urgent site-to-site rebalance from Kurunegala to Galagedara',
      user: adminUser
    });

    assert.strictEqual(res.ok, true);
    assert.ok(res.mtn_id > 0);
    assert.ok(res.mtn_no);
    assert.ok(res.chain_no.startsWith('CHN-'));
    assert.strictEqual(res.from_store_location_id, 4);
    assert.strictEqual(res.to_store_location_id, 3);
    assert.strictEqual(res.items_count, 1);

    rebalanceMtnId = res.mtn_id;
    rebalanceMtnNo = res.mtn_no;
    rebalanceChainNo = res.chain_no;

    const mtn = get('SELECT * FROM mtn WHERE id = ?', rebalanceMtnId);
    assert.strictEqual(mtn.status, 'draft');
    assert.strictEqual(mtn.from_store_location_id, 4);
    assert.strictEqual(mtn.to_store_location_id, 3);
    assert.strictEqual(mtn.chain_no, rebalanceChainNo);

    const line = get('SELECT * FROM mtn_lines WHERE mtn_id = ?', rebalanceMtnId);
    assert.ok(line);
    assert.strictEqual(line.qty, 18);
    assert.strictEqual(line.from_store_location_id, 4);
    assert.strictEqual(line.to_store_location_id, 3);
  });

  await t.test('8. Dispatch & destination acceptance executes physical shelf movement', () => {
    // 8a. Dispatch: donor shelf (Store 4) is depleted by 18
    run("UPDATE mtn SET status = 'dispatched', transferred_by = 'KRN Storekeeper' WHERE id = ?", rebalanceMtnId);
    stock.rebuild({ transfersOf: rebalanceMtnId });

    const donorBalAfterDispatch = stock.balanceOf(section, partKey, null, { physical_store_id: 4 });
    assert.strictEqual(donorBalAfterDispatch, 37, 'Donor balance drops from 55 to 37 (safe buffer of 30 preserved!)');

    // 8b. Acceptance: receiving shelf (Store 3) increases by 18
    run("UPDATE mtn SET status = 'accepted', received_by = 'GWS Storekeeper' WHERE id = ?", rebalanceMtnId);
    run("UPDATE mtn_lines SET qty_received = 18 WHERE mtn_id = ?", rebalanceMtnId);
    stock.rebuild({ transfersOf: rebalanceMtnId });

    const recipientBalAfterAccept = stock.balanceOf(section, partKey, null, { physical_store_id: 3 });
    assert.strictEqual(recipientBalAfterAccept, 28, 'Recipient balance rises from 10 to 28 (exact ROP reached!)');

    // Re-evaluate health at Site Store A:
    // With balance 28, ROP 28, SS 14:
    // Balance is equal to ROP, shortfall is resolved!
    const newHealth = reorderRebalance.calculateItemRop(section, partKey, { physical_store_id: 3 });
    assert.strictEqual(newHealth.balance, 28);
    assert.strictEqual(newHealth.shortfall, 0, 'Shortfall completely resolved (0 units)');
    assert.strictEqual(newHealth.status, 'HEALTHY', 'Status promoted to HEALTHY');
  });
});
