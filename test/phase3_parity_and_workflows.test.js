'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-p3-workflows-'));
process.env.DB_PATH = path.join(TMP, 'p3.db');
process.env.MULTIDB = '0';
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.NO_PORT = '1';
delete process.env.SAP_GATEWAY_API_KEY;

const test = require('node:test');
const assert = require('node:assert/strict');
const { db, get, all, run, migrate } = require('../src/db');
migrate();

const auth = require('../src/lib/auth');
const permissions = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');
const fuelStock = require('../src/lib/fuel/stock');
const m065 = require('../src/migrate/065_phase3_tanks_allocations_and_delivery_prices');

for (const r of ['admin', ...Object.keys(permissions.DEFAULT_MATRIX)]) {
  run('INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES (?, ?, 1, 1)', r, r);
}
permissions.seedDefaults();
capabilities.seedCapabilities();

const PW = 'PhaseThree#2026!';
const adminUid = run(
  'INSERT INTO users (username, full_name, password_hash, active) VALUES (?, ?, ?, 1)',
  'p3_admin', 'Phase 3 Admin', auth.hashPassword(PW)
).lastInsertRowid;
run("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'admin'))", adminUid);

const app = require('../src/server');
let server;
let port;
let adminCookie;

function rawReq(method, p, { headers = {}, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        const sc = res.headers['set-cookie'];
        resolve({
          status: res.statusCode,
          headers: res.headers,
          json,
          text,
          cookie: sc ? sc[0].split(';')[0] : null,
        });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
  const login = await rawReq('POST', '/api/auth/login', { body: { username: 'p3_admin', password: PW } });
  assert.equal(login.status, 200, login.text);
  adminCookie = login.cookie;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('1. Migration 065 links TANK-CW/TANK-MRW, marks current allocations, and backfills delivery costs', () => {
  const bgpId = run("INSERT INTO projects (code, name, active) VALUES ('BGP', 'Badalgama Plant', 1)").lastInsertRowid;
  const maraId = run("INSERT INTO projects (code, name, active) VALUES ('MARA', 'Marawila', 1)").lastInsertRowid;

  run("INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active) VALUES ('tank-cw', 'TANK-CW', 'Central Workshop Main Bowser', 'BOWSER', 'AUTO_DIESEL', 10000, 2000, NULL, 1)");
  run("INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active) VALUES ('tank-mrw', 'TANK-MRW', 'Marawila Site Tank', 'FIXED', 'AUTO_DIESEL', 10000, 3000, NULL, 1)");

  const a1 = run("INSERT INTO assets (code, code_norm, registration, type, status) VALUES ('VH-P3-1', 'VHP31', 'WP-5501', 'tipper', 'active')").lastInsertRowid;
  const a2 = run("INSERT INTO assets (code, code_norm, registration, type, status) VALUES ('VH-P3-2', 'VHP32', 'WP-5502', 'lorry', 'active')").lastInsertRowid;

  // Multiple allocation months per vehicle with is_current = 0
  run("INSERT INTO fleet_vehicle_allocations (id, dedupe_key, asset_id, vehicle_no, project_id, site_name, month, active, is_current) VALUES ('alloc-1', 'k1', ?, 'VH-P3-1', ?, 'Badalgama Plant', '2026-07', 1, 0)", a1, bgpId);
  run("INSERT INTO fleet_vehicle_allocations (id, dedupe_key, asset_id, vehicle_no, project_id, site_name, month, active, is_current) VALUES ('alloc-2', 'k2', ?, 'VH-P3-1', ?, 'Marawila', '2026-08', 1, 0)", a1, maraId);
  run("INSERT INTO fleet_vehicle_allocations (id, dedupe_key, asset_id, vehicle_no, project_id, site_name, month, active, is_current) VALUES ('alloc-3', 'k3', ?, 'VH-P3-2', ?, 'Badalgama Plant', '2026-08', 1, 0)", a2, bgpId);
  const latestA1 = 'alloc-2';
  const latestA2 = 'alloc-3';

  // Fuel prices starting 2026-03-01 and 2026-08-01
  run("INSERT INTO fuel_prices (fuel_type, fuel_kind, price_per_litre_cents, price_per_litre, effective_date) VALUES ('AUTO_DIESEL', 'AUTO_DIESEL', 28000, 280, '2026-03-01')");
  run("INSERT INTO fuel_prices (fuel_type, fuel_kind, price_per_litre_cents, price_per_litre, effective_date) VALUES ('AUTO_DIESEL', 'AUTO_DIESEL', 31000, 310, '2026-08-01')");

  // Deliveries: one before earliest tariff (fallback), one on 2026-08-15 (310/L), one already priced
  run("INSERT INTO fuel_bulk_deliveries (id, tank_id, litres, fuel_type, supplier, cost_cents, delivery_date, status) VALUES ('d-pre', 'tank-cw', 100, 'AUTO_DIESEL', 'CPC', 0, '2025-11-10', 'DELIVERED')");
  run("INSERT INTO fuel_bulk_deliveries (id, tank_id, litres, fuel_type, supplier, cost_cents, delivery_date, status) VALUES ('d-aug', 'tank-mrw', 50, 'AUTO_DIESEL', 'CPC', 0, '2026-08-15', 'DELIVERED')");
  run("INSERT INTO fuel_bulk_deliveries (id, tank_id, litres, fuel_type, supplier, cost_cents, delivery_date, status) VALUES ('d-keep', 'tank-cw', 20, 'AUTO_DIESEL', 'CPC', 999999, '2026-08-20', 'DELIVERED')");

  const res = m065.runMigration(db);
  assert.equal(res.tanksLinked, 2);
  assert.equal(res.allocationsMarkedCurrent, 2);
  assert.equal(res.deliveriesPriced, 2);

  assert.equal(get("SELECT project_id FROM fuel_tanks WHERE code = 'TANK-CW'").project_id, bgpId);
  assert.equal(get("SELECT project_id FROM fuel_tanks WHERE code = 'TANK-MRW'").project_id, maraId);

  const curRows = all('SELECT id FROM fleet_vehicle_allocations WHERE is_current = 1 ORDER BY id');
  assert.deepEqual(curRows.map((r) => r.id), [latestA1, latestA2]);

  assert.equal(get("SELECT cost_cents FROM fuel_bulk_deliveries WHERE id = 'd-pre'").cost_cents, 2800000);
  assert.equal(get("SELECT cost_cents FROM fuel_bulk_deliveries WHERE id = 'd-aug'").cost_cents, 1550000);
  assert.equal(get("SELECT cost_cents FROM fuel_bulk_deliveries WHERE id = 'd-keep'").cost_cents, 999999);
});

test('2. stock.recordBulkDelivery auto-prices cost_cents when omitted or 0', () => {
  const autoRes = fuelStock.recordBulkDelivery({
    tankId: 'tank-cw',
    litres: 200,
    fuelType: 'AUTO_DIESEL',
    deliveryDate: '2026-08-22',
    receivedBy: adminUid,
  });
  assert.equal(autoRes.cost_cents, 6200000); // 200L * 31000 cents/L
  assert.equal(get('SELECT cost_cents FROM fuel_bulk_deliveries WHERE id = ?', autoRes.id).cost_cents, 6200000);

  const explicitRes = fuelStock.recordBulkDelivery({
    tankId: 'tank-cw',
    litres: 100,
    fuelType: 'AUTO_DIESEL',
    costCents: 3500000,
    deliveryDate: '2026-08-22',
    receivedBy: adminUid,
  });
  assert.equal(explicitRes.cost_cents, 3500000);
});

test('3. SAP Gateway requires auth on GET / and GET /openapi.json while /healthz remains public', async () => {
  const health = await rawReq('GET', '/api/sap/v1/healthz');
  assert.equal(health.status, 200);

  const rootUnauth = await rawReq('GET', '/api/sap/v1/');
  assert.equal(rootUnauth.status, 401);

  const specUnauth = await rawReq('GET', '/api/sap/v1/openapi.json');
  assert.equal(specUnauth.status, 401);

  const rootAuth = await rawReq('GET', '/api/sap/v1/', { cookie: adminCookie });
  assert.equal(rootAuth.status, 200, rootAuth.text);

  const specAuth = await rawReq('GET', '/api/sap/v1/openapi.json', { cookie: adminCookie });
  assert.equal(specAuth.status, 200, specAuth.text);
  assert.ok(specAuth.json && specAuth.json.openapi);
});

test('4. Alias queue fuzzy suggestions and bulk-link endpoints resolve aliases & log audit', async () => {
  const a1 = get("SELECT id FROM assets WHERE code = 'VH-P3-1'").id;
  const a2 = get("SELECT id FROM assets WHERE code = 'VH-P3-2'").id;

  const al1 = run("INSERT INTO asset_aliases (raw_text, raw_norm, resolved, hit_count, source) VALUES ('WP-5501 Tipper', 'WP5501TIPPER', 0, 5, 'fuel')").lastInsertRowid;
  const al2 = run("INSERT INTO asset_aliases (raw_text, raw_norm, resolved, hit_count, source) VALUES ('5502', '5502', 0, 2, 'stores')").lastInsertRowid;

  const sugg = await rawReq('GET', '/api/aliases/suggestions?min_score=50', { cookie: adminCookie });
  assert.equal(sugg.status, 200, sugg.text);
  const s1 = sugg.json.items.find((x) => x.alias_id === al1);
  const s2 = sugg.json.items.find((x) => x.alias_id === al2);
  assert.ok(s1 && s1.suggestions.length > 0);
  assert.equal(s1.suggestions[0].asset_id, a1);
  assert.ok(s2 && s2.suggestions.some((c) => c.asset_id === a2));

  const bulk = await rawReq('POST', '/api/aliases/bulk-link', {
    cookie: adminCookie,
    body: {
      links: [
        { alias_id: al1, asset_id: a1 },
        { alias_id: al2, asset_id: a2 },
        { alias_id: 999999, asset_id: a1 },
      ],
    },
  });
  assert.equal(bulk.status, 200, bulk.text);
  assert.equal(bulk.json.linked_count, 2);
  assert.equal(bulk.json.skipped_count, 1);

  assert.equal(get('SELECT resolved, asset_id FROM asset_aliases WHERE id = ?', al1).resolved, 1);
  assert.equal(get('SELECT asset_id FROM asset_aliases WHERE id = ?', al1).asset_id, a1);
  assert.equal(get('SELECT asset_id FROM asset_aliases WHERE id = ?', al2).asset_id, a2);
  assert.ok(get("SELECT 1 FROM audit_log WHERE entity = 'asset_alias' AND action = 'bulk_link' AND entity_id = ?", al1));
});

test('5. Vehicle documents bulk-import creates draft/verified versions & DELETE /:documentId works', async () => {
  const imp = await rawReq('POST', '/api/vehicle-documents/bulk-import', {
    cookie: adminCookie,
    body: {
      auto_verify: true,
      rows: [
        {
          vehicle: 'VH-P3-1',
          doc_type: 'revenue_licence',
          doc_number: 'RL-2026-001',
          issuer_name: 'WP DMT',
          valid_from: '2026-01-01',
          valid_until: '2026-12-31',
          cost_amount: 12500,
        },
        {
          vehicle: 'WP-5502',
          doc_type: 'insurance',
          valid_until: '2027-03-31',
          verify: false,
        },
        {
          vehicle: 'UNKNOWN-9999',
          doc_type: 'insurance',
          valid_until: '2027-01-01',
        },
      ],
    },
  });
  assert.equal(imp.status, 201, imp.text);
  assert.equal(imp.json.imported_count, 2);
  assert.equal(imp.json.skipped_count, 1);
  assert.equal(imp.json.imported[0].status, 'verified');
  assert.equal(imp.json.imported[1].status, 'pending_verification');
  assert.ok(imp.json.imported[1].doc_number.startsWith('BULK-INSURANCE-'));

  // Verify DELETE /:documentId no longer throws ReferenceError for missing get/run/audit imports
  const docId = imp.json.imported[1].document_id;
  const del = await rawReq('DELETE', `/api/vehicle-documents/${docId}`, { cookie: adminCookie });
  assert.equal(del.status, 200, del.text);
  assert.equal(del.json.deleted, true);
  assert.ok(get("SELECT 1 FROM audit_log WHERE entity = 'vehicle_document' AND action = 'bulk_import'"));
});

test('6. Master Dashboard summary returns accurate dataHealth indicators', async () => {
  const a1 = get("SELECT id FROM assets WHERE code = 'VH-P3-1'").id;
  run("INSERT INTO issues (asset_id, description, qty, unit_price, issue_date, store_id, voided) VALUES (?, 'Unpriced Seal', 1, 0, '2026-08-10', 1, 0)", a1);
  run("INSERT INTO mrn (mrn_no, req_date, asset_id, purpose, requested_by, status) VALUES ('MRN-OLD-1', date('now', '-45 days'), ?, 'Old filter', 'tech', 'open')", a1);
  run("INSERT INTO asset_aliases (raw_text, raw_norm, resolved, hit_count, source) VALUES ('UNRESOLVED-99', 'UNRESOLVED99', 0, 1, 'fuel')");

  const sum = await rawReq('GET', '/api/master-dashboard/summary', { cookie: adminCookie });
  assert.equal(sum.status, 200, sum.text);
  const dh = sum.json.dataHealth;
  assert.ok(dh, 'dataHealth object returned');
  assert.ok(dh.unpricedStoreIssues >= 1);
  assert.ok(dh.overdueOpenMrns >= 1);
  assert.ok(dh.unresolvedAssetAliases >= 1);
  assert.equal(dh.latestFuelTariffDate, '2026-08-01');
  assert.equal(typeof dh.staleFuelTariffDays, 'number');
  assert.ok(dh.missingVehicleDocVersions >= 1);
});
