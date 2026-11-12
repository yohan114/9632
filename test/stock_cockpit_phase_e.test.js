'use strict';

/**
 * ===========================================================================
 * Phase E Test Suite: Storekeeper Workspaces & Multi-Store Cockpit
 *
 * Verifies:
 * 1. GET /api/stores/cockpit:
 *    - Resolves physical store location context (ID, Code, Name, Store Type).
 *    - Provides consolidated KPIs (deficits, inbound, outbound, open MRNs, surplus).
 *    - Scopes inbound transfers arriving at this store (dispatched/received).
 *    - Scopes outbound transfers shipping from this store (draft/approved).
 *    - Identifies urgent deficit items with shortfall amounts.
 *    - Pairs rebalance opportunities from donor stores.
 *    - Shows safe surplus inventory available to donate.
 * 2. Inbound and Outbound transfers are correctly scoped by physical store location ID.
 * 3. 1-Click Rebalance creation through /api/stores/rebalance/create-mtn immediately
 *    appears in the donor store's outbound queue and the recipient's inbound queue.
 * 4. Destination receiving and acceptance clears the inbound queue and resolves the deficit.
 * ===========================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-cockpit-pe-'));
process.env.DB_PATH = path.join(TMP, 'cockpit_pe.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.MULTIDB = '0';

const { migrate, run, get, all, db } = require('../src/db');
const storeLocations = require('../src/lib/store_locations');
const stock = require('../src/lib/stock');
const reorderRebalance = require('../src/lib/reorder_rebalance');
const auth = require('../src/lib/auth');

migrate();

// 1. Seed Roles & Users
for (const n of ['admin', 'storekeeper', 'operational_manager']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
const adminUid = run("INSERT OR IGNORE INTO users (id, username, password_hash, full_name, active) VALUES (1, 'admin', ?, 'System Admin', 1)", auth.hashPassword('pw')).lastInsertRowid || 1;
for (const r of ['admin', 'storekeeper', 'operational_manager']) {
  run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', 1, r);
}

// 2. Seed Workshops
run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active, own_store) VALUES (1, 'CW', 'Central Workshop — Badalgama', 'Badalgama', 1, 1, 1)");
run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active, own_store) VALUES (2, 'GWS', 'Galagedara Workshop', 'Galagedara', 0, 1, 1)");
run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active, own_store) VALUES (3, 'KRN', 'Kurunegala Workshop', 'Kurunegala', 0, 1, 1)");

// 3. Seed Physical Stores and Hierarchy
storeLocations.seedStoreLocations(db);
storeLocations.migrateStoreLocationsStage2(db);

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
    body: JSON.stringify({ username: 'admin', password: 'pw' }),
  });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
});

test.after(async () => {
  if (server) await new Promise((res) => server.close(res));
});

const api = async (p, opts = {}) => {
  const r = await fetch(base + '/api' + p, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('Phase E: Storekeeper Workspaces & Multi-Store Cockpit', async (t) => {
  const partName = 'Heavy Hydraulic Seal 60x80';
  const section = 'general';
  const partKey = stock.itemKey(section, partName);

  // Seed inventory SKU
  run("INSERT OR IGNORE INTO stock_items (section, item_key, name, unit) VALUES (?, ?, ?, 'nos')", section, partKey, partName);

  // Seed Deficit at Site Store A (Galagedara, ID 3):
  // ROP = 30, SS = 15, on hand balance = 10 -> Shortfall = 20 (CRITICAL deficit!)
  reorderRebalance.applyRopLevels({ physical_store_id: 3 }, [{
    section,
    item_key: partKey,
    rop: 30,
    safety_stock: 15,
    reorder_qty: 60,
    avg_daily_demand: 2.0,
    lead_time_days: 7
  }], { id: 1 });

  run(`
    INSERT INTO stock_moves (physical_store_id, store_id, section, item_key, item_name, kind, qty, txn_date, counts, source_table, source_id)
    VALUES (3, 2, ?, ?, ?, 'in', 10, date('now'), 1, 'manual', 201)
  `, section, partKey, partName);

  // Seed Surplus at Site Store B (Kurunegala, ID 4):
  // ROP = 20, SS = 10 -> Safe Buffer = 30. On hand balance = 60 -> Available Surplus = 30 units!
  reorderRebalance.applyRopLevels({ physical_store_id: 4 }, [{
    section,
    item_key: partKey,
    rop: 20,
    safety_stock: 10,
    reorder_qty: 40,
    avg_daily_demand: 1.5,
    lead_time_days: 7
  }], { id: 1 });

  run(`
    INSERT INTO stock_moves (physical_store_id, store_id, section, item_key, item_name, kind, qty, txn_date, counts, source_table, source_id)
    VALUES (4, 3, ?, ?, ?, 'in', 60, date('now'), 1, 'manual', 202)
  `, section, partKey, partName);

  await t.test('1. GET /api/stores/cockpit for Site Store A reflects critical deficit and rebalance matches', async () => {
    const res = await api('/stores/cockpit?physical_store_id=3&days=90');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok);
    assert.strictEqual(res.body.store.physical_store_id, 3);
    assert.strictEqual(res.body.store.code, 'SITE-STORE-GWS');
    assert.strictEqual(res.body.store.store_type, 'SITE_STORE');

    // Deficit detection
    assert.strictEqual(res.body.kpis.critical, 1);
    assert.strictEqual(res.body.urgent_deficits.length, 1);
    const def = res.body.urgent_deficits[0];
    assert.strictEqual(def.item_key, partKey);
    assert.strictEqual(def.balance, 10);
    assert.strictEqual(def.rop, 30);
    assert.strictEqual(def.shortfall, 20);

    // Rebalance opportunity matched with Site Store B
    assert.ok(res.body.rebalance_opportunities.length >= 1);
    const opp = res.body.rebalance_opportunities[0];
    assert.strictEqual(opp.from_store_location_id, 4);
    assert.strictEqual(opp.to_store_location_id, 3);
    assert.strictEqual(opp.shortfall, 20);
    assert.strictEqual(opp.from_available_surplus, 30);
    assert.strictEqual(opp.suggested_transfer_qty, 20);
  });

  await t.test('2. GET /api/stores/cockpit for Site Store B reflects surplus available to share', async () => {
    const res = await api('/stores/cockpit?physical_store_id=4&days=90');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok);
    assert.strictEqual(res.body.store.physical_store_id, 4);
    assert.strictEqual(res.body.store.code, 'SITE-STORE-KRN');

    assert.strictEqual(res.body.surplus_available.length, 1);
    const sur = res.body.surplus_available[0];
    assert.strictEqual(sur.item_key, partKey);
    assert.strictEqual(sur.balance, 60);
    assert.strictEqual(sur.available_surplus, 30);
  });

  let rebalanceMtnId, rebalanceMtnNo, rebalanceChainNo;

  await t.test('3. 1-Click Rebalance MTN creation updates Outbound queue at Donor & Inbound queue at Recipient', async () => {
    const createRes = await api('/stores/rebalance/create-mtn', {
      method: 'POST',
      body: {
        from_store_location_id: 4,
        to_store_location_id: 3,
        items: [{
          section,
          item_key: partKey,
          item_name: partName,
          qty: 20,
          unit: 'nos'
        }],
        reason: 'Inter-site rebalance from Kurunegala to Galagedara'
      }
    });

    assert.strictEqual(createRes.status, 200);
    assert.ok(createRes.body.ok);
    rebalanceMtnId = createRes.body.mtn_id;
    rebalanceMtnNo = createRes.body.mtn_no;
    rebalanceChainNo = createRes.body.chain_no;
    assert.ok(rebalanceChainNo.startsWith('CHN-'));

    // Check Donor (Store 4) Outbound Queue in Cockpit (status = 'draft')
    const donorRes = await api('/stores/cockpit?physical_store_id=4');
    assert.strictEqual(donorRes.status, 200);
    assert.ok(donorRes.body.outbound_transfers.some((t) => t.id === rebalanceMtnId));

    // Sign & Approve transfer at Donor
    const appRes = await api(`/stores/mtn/${rebalanceMtnId}/approve`, {
      method: 'POST',
      body: { signed_name: 'KRN Store Manager', signature: 'data:image/png;base64,mock' }
    });
    assert.strictEqual(appRes.status, 200);

    // Dispatch transfer with driver (status = 'dispatched')
    const dispRes = await api(`/stores/mtn/${rebalanceMtnId}/dispatch`, {
      method: 'POST',
      body: { received_by: 'Driver Perera', received_sig: 'data:image/png;base64,mock' }
    });
    assert.strictEqual(dispRes.status, 200);

    // Check Recipient (Store 3) Inbound Queue in Cockpit (now in transit / dispatched!)
    const rxRes = await api('/stores/cockpit?physical_store_id=3');
    assert.strictEqual(rxRes.status, 200);
    assert.ok(rxRes.body.inbound_transfers.some((t) => t.id === rebalanceMtnId));
    const inFlight = rxRes.body.inbound_transfers.find((t) => t.id === rebalanceMtnId);
    assert.strictEqual(inFlight.status, 'dispatched');
    assert.strictEqual(inFlight.from_store_location_code, 'SITE-STORE-KRN');
    assert.strictEqual(inFlight.chain_no, rebalanceChainNo);
  });

  await t.test('4. Receiving and Accepting MTN clears queues and restores store inventory health', async () => {
    // Driver arrival & delivery confirmation (Receive)
    const rxRes = await api(`/stores/mtn/${rebalanceMtnId}/receive`, {
      method: 'POST',
      body: { signed_name: 'GWS Receiving Clerk', signature: 'data:image/png;base64,mock' }
    });
    assert.strictEqual(rxRes.status, 200);

    // Final Acceptance & Binned into Destination Shelf
    const acceptRes = await api(`/stores/mtn/${rebalanceMtnId}/accept`, {
      method: 'POST',
      body: { accepted_by: 'GWS Storekeeper', accepted_sig: 'data:image/png;base64,mock' }
    });
    assert.strictEqual(acceptRes.status, 200);

    // Check Recipient Cockpit: shortfall resolved, status HEALTHY!
    const finalRxCockpit = await api('/stores/cockpit?physical_store_id=3');
    assert.strictEqual(finalRxCockpit.status, 200);
    assert.strictEqual(finalRxCockpit.body.inbound_transfers.some((t) => t.id === rebalanceMtnId), false, 'Accepted transfer cleared from in-flight queue');
    assert.strictEqual(finalRxCockpit.body.urgent_deficits.length, 0, 'No remaining deficits at Site Store A');

    // Check Donor Cockpit: safe buffer preserved (40 units remaining, > ROP 20 + SS 10 = 30)
    const finalDonorCockpit = await api('/stores/cockpit?physical_store_id=4');
    assert.strictEqual(finalDonorCockpit.status, 200);
    const donorPart = finalDonorCockpit.body.surplus_available.find((s) => s.item_key === partKey);
    assert.ok(donorPart);
    assert.strictEqual(donorPart.balance, 40, 'Donor balance drops from 60 to 40, safe buffer of 30 strictly preserved');
    assert.strictEqual(donorPart.available_surplus, 10, 'Remaining surplus is 40 - 30 = 10 units');
  });
});
