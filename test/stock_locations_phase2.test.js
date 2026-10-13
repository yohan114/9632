'use strict';

/**
 * Stock Movements & Physical Store Tracking Tests (Plan Revision 2, Phase 2)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-stock-p2-'));
process.env.DB_PATH = path.join(TMP, 'stock_p2.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');

const { migrate, run, get, all, db } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const storeLocations = require('../src/lib/store_locations');
const stock = require('../src/lib/stock');

migrate();

// Seed roles & admin
const PW = 'secure-password-p2';
function mkUser(username, roleName) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', roleName, roleName);
  const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', username, auth.hashPassword(PW)).lastInsertRowid;
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, roleName);
  return uid;
}

const adminId = mkUser('admin_p2', 'admin');
capabilities.seedCapabilities();

// Seed test workshops
run(`INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active, own_store)
    VALUES (1, 'CW', 'Central Workshop — Badalgama', 'Badalgama', 1, 1, 1)`);
run(`INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active, own_store)
    VALUES (2, 'GWS', 'Galagedara Workshop', 'Galagedara', 0, 1, 1)`);

// Seed physical stores
storeLocations.seedStoreLocations(db);
storeLocations.migrateStoreLocationsStage2(db);

const app = require('../src/server');
let server;
let port;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
});

test.after(() => {
  if (server) server.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

function req(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = {};
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch {}
        const sc = res.headers['set-cookie'];
        resolve({
          status: res.statusCode,
          body: json,
          text: raw.toString('utf8'),
          cookie: sc ? sc[0].split(';')[0] : null
        });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function login(username) {
  const r = await req('POST', '/api/auth/login', { body: { username, password: PW } });
  assert.strictEqual(r.status, 200, r.text);
  return r.cookie;
}

test('Phase 2 Schema: tables contain physical store columns', () => {
  const checkCol = (tbl, col) => {
    const cols = db.prepare(`PRAGMA table_info(${tbl})`).all().map(c => c.name);
    assert.ok(cols.includes(col), `Table ${tbl} must contain column ${col}`);
  };

  for (const t of ['stock_moves', 'grn', 'issues', 'general_item_txns', 'stock_ledger', 'tyre_battery_issues', 'service_jobs', 'store_counts']) {
    checkCol(t, 'physical_store_id');
  }
  checkCol('mtn', 'from_store_location_id');
  checkCol('mtn', 'to_store_location_id');
  checkCol('mtn_lines', 'from_store_location_id');
  checkCol('mtn_lines', 'to_store_location_id');
});

test('Stock Movements: writeMove records physical_store_id with default mapping', () => {
  // Insert a test GRN with physical_store_id = 2
  db.prepare(`
    INSERT INTO grn (grn_no, delivery_date, description, qty, unit_price, store_id, physical_store_id)
    VALUES ('GRN-TEST-P2', '2026-03-01', 'Test Phase 2 Item', 10, 100, 1, 2)
  `).run();

  const grn = db.prepare("SELECT * FROM grn WHERE grn_no = 'GRN-TEST-P2'").get();
  assert.equal(grn.store_id, 1);
  assert.equal(grn.physical_store_id, 2);

  // Sync stock moves
  stock.sync({ grn: [grn.id] });

  const move = db.prepare("SELECT * FROM stock_moves WHERE source_table = 'grn' AND source_id = ?").get(grn.id);
  assert.ok(move, 'Move must be recorded in stock_moves');
  assert.equal(move.store_id, 1);
  assert.equal(move.physical_store_id, 2);
  assert.equal(move.qty, 10);
});

test('Shadow Reconciliation: CW legacy balance matches Main Workshop physical balance exactly', () => {
  const rec = stock.reconcileLegacyAndPhysicalStores();
  assert.equal(rec.in_sync, true);
  assert.equal(rec.total_delta, 0);
  assert.equal(rec.main_stores_total_balance, 0);

  for (const sec of stock.SECTIONS) {
    const s = rec.sections[sec];
    assert.ok(s, `Section ${sec} must be reported in reconciliation`);
    assert.equal(s.delta, 0, `Section ${sec} delta must be 0`);
    assert.equal(s.matched, true, `Section ${sec} matched must be true`);
    assert.equal(s.legacy_cw_balance, s.physical_workshop_balance);
    assert.equal(s.central_main_stores_balance, 0);
  }
});

test('In-Transit Tracking: tracks transfers between physical locations', () => {
  // Create an MTN between Main Stores (id=1) and Main Workshop (id=2)
  const mtnInfo = db.prepare(`
    INSERT INTO mtn (mtn_no, txn_date, from_location, to_location, from_store_location_id, to_store_location_id, status, workshop_id)
    VALUES ('MTN-TEST-TRANSIT', '2026-03-02', 'Central Main Store', 'Central Main Workshop Store', 1, 2, 'dispatched', 1)
  `).run();
  const mtnId = mtnInfo.lastInsertRowid;

  db.prepare(`
    INSERT INTO mtn_lines (mtn_id, line_no, description, qty, category, from_store_location_id, to_store_location_id)
    VALUES (?, 1, 'Hydraulic Seal Kit', 5, 'general', 1, 2)
  `).run(mtnId);

  // When dispatched, inTransit must return it
  const inTransit1 = stock.inTransit();
  const found = inTransit1.find(t => t.mtn_no === 'MTN-TEST-TRANSIT');
  assert.ok(found, 'Dispatched transfer must appear in inTransit');
  assert.equal(found.qty_in_transit, 5);

  // When accepted, it clears from inTransit
  db.prepare("UPDATE mtn SET status = 'accepted' WHERE id = ?").run(mtnId);
  const inTransit2 = stock.inTransit();
  const foundAccepted = inTransit2.find(t => t.mtn_no === 'MTN-TEST-TRANSIT');
  assert.equal(foundAccepted, undefined, 'Accepted transfer must not appear in inTransit');
});

test('REST API Endpoints: reconciliation, in-transit, and store stock', async () => {
  const cookie = await login('admin_p2');

  // 1. GET /api/store-locations/reconciliation
  const resRec = await req('GET', '/api/store-locations/reconciliation', { cookie });
  assert.equal(resRec.status, 200);
  assert.equal(resRec.body.in_sync, true);
  assert.equal(resRec.body.total_delta, 0);

  // 2. GET /api/store-locations/in-transit
  const resTransit = await req('GET', '/api/store-locations/in-transit', { cookie });
  assert.equal(resTransit.status, 200);
  assert.ok(Array.isArray(resTransit.body));

  // 3. GET /api/store-locations/2/stock
  const resStock = await req('GET', '/api/store-locations/2/stock', { cookie });
  assert.equal(resStock.status, 200);
  assert.equal(resStock.body.store.id, 2);
  assert.ok(resStock.body.summaries.general);
});
