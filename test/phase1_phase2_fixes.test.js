'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const zlib = require('zlib');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-p12-fixes-'));
process.env.DB_PATH = path.join(TMP, 'p12.db');
process.env.MULTIDB = '0';
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.NO_PORT = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { db, get, all, run, migrate } = require('../src/db');
migrate();

const auth = require('../src/lib/auth');
const permissions = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');
const costing = require('../src/lib/costing');
const fuelIssue = require('../src/lib/fuel/issue');
const m064 = require('../src/migrate/064_p0_hygiene_indexes_and_fuel_cost_backfill');

for (const r of ['admin', ...Object.keys(permissions.DEFAULT_MATRIX)]) {
  run('INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES (?, ?, 1, 1)', r, r);
}
permissions.seedDefaults();
capabilities.seedCapabilities();

const app = require('../src/server');
let server;
let port;

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
        const raw = Buffer.concat(chunks);
        const sc = res.headers['set-cookie'];
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          raw,
          json,
          text: raw.toString('utf8'),
          cookie: sc ? sc[0].split(';')[0] : null,
        });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const PW = 'PhaseOneTwo#2026!';
function mkUser(username, roleNames) {
  const uid = run(
    'INSERT INTO users (username, full_name, password_hash, active) VALUES (?, ?, ?, 1)',
    username,
    username,
    auth.hashPassword(PW)
  ).lastInsertRowid;
  for (const rn of roleNames) {
    run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, rn);
  }
  return uid;
}

async function loginAs(username) {
  const r = await rawReq('POST', '/api/auth/login', { body: { username, password: PW } });
  assert.equal(r.status, 200, `Login failed for ${username}: ${r.text}`);
  return r.cookie;
}

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('1. costing.recalcVehicleMonth aggregates fuel_cost live + handles NULL issue categories', () => {
  const assetId = run(
    "INSERT INTO assets (code, code_norm, ec_code, registration, type, status, in_register) VALUES ('VH-COST-01', 'VHCOST01', 'VH-COST-01', 'WP-1111', 'truck', 'active', 1)"
  ).lastInsertRowid;

  // Store issue with NULL category (previously dropped!)
  run(
    "INSERT INTO issues (asset_id, description, qty, unit_price, issue_date, category, store_id) VALUES (?, 'Fan Belt', 2, 1500, '2026-10-05', NULL, 1)",
    assetId
  );

  // Tank + fuel price + live fuel issue + voided fuel issue
  run("INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, active) VALUES ('tank-c1', 'T-C1', 'Cost Tank', 'FIXED', 'AUTO_DIESEL', 10000, 5000, 1)");
  run("INSERT INTO fuel_prices (fuel_type, fuel_kind, price_per_litre_cents, price_per_litre, effective_date) VALUES ('AUTO_DIESEL', 'AUTO_DIESEL', 30000, 300, '2026-01-01')");

  const created = fuelIssue.recordIssue({
    assetCode: 'VH-COST-01',
    fuelType: 'AUTO_DIESEL',
    litres: 50,
    issueDate: '2026-10-12 08:00:00',
    sourceTankId: 'tank-c1',
    isManual: true,
    allowUnlinkedSiteTransfer: true,
    notes: 'Live sync check',
  }, 1);
  assert.equal(created.total_cost_cents, 1500000); // 50L * 30000 cents = 1,500,000 cents (Rs 15,000)

  // Second issue that we immediately void — must NOT count in fuel_cost
  const voided = fuelIssue.recordIssue({
    assetCode: 'VH-COST-01',
    fuelType: 'AUTO_DIESEL',
    litres: 20,
    issueDate: '2026-10-13 08:00:00',
    sourceTankId: 'tank-c1',
    isManual: true,
    allowUnlinkedSiteTransfer: true,
  }, 1);
  fuelIssue.voidIssue(voided.id, 'Duplicate slip', 1);

  const vmc = get('SELECT fuel_cost, parts_cost, total_cost FROM vehicle_monthly_costs WHERE asset_id = ? AND year = 2026 AND month = 10', assetId);
  assert.ok(vmc, 'vehicle_monthly_costs row created');
  assert.equal(vmc.parts_cost, 3000, 'NULL-category issue included in parts_cost');
  assert.equal(vmc.fuel_cost, 15000, 'Live active fuel_cost included, voided excluded');
  assert.equal(vmc.total_cost, 18000, 'total_cost = fuel + parts');
});

test('2. tyre_battery RBAC fix (tb_reports instead of tyrebattery) + PATCH guard + audit trail', async () => {
  run("INSERT INTO roles (name, label) VALUES ('tb_editor', 'T&B Editor')");
  permissions.setPermission('tb_editor', 'tb_reports', 'edit');
  run("INSERT INTO roles (name, label) VALUES ('tb_viewer', 'T&B Viewer')");
  permissions.setPermission('tb_viewer', 'tb_reports', 'view');

  mkUser('tb_ed_user', ['tb_editor']);
  mkUser('tb_vw_user', ['tb_viewer']);

  const issId = run(
    "INSERT INTO tyre_battery_issues (kind, issue_date, vehicle, qty, category, category_norm, row_hash, store_id) VALUES ('tyre', '2026-10-10', 'VH-COST-01', 2, '1000X20', '1000X20', 'tb-hash-1', 1)"
  ).lastInsertRowid;

  const edCookie = await loginAs('tb_ed_user');
  const vwCookie = await rawReq('POST', '/api/auth/login', { body: { username: 'tb_vw_user', password: PW } }).then((r) => r.cookie);

  // Viewer blocked from POST /prices & PATCH /issues/:id
  const vwPost = await rawReq('POST', '/api/tyre-battery/prices', {
    cookie: vwCookie,
    body: { kind: 'tyre', prices: [{ category_norm: '1000X20', category: '1000X20', unit_price: 55000 }] },
  });
  assert.equal(vwPost.status, 403);

  const vwPatch = await rawReq('PATCH', `/api/tyre-battery/issues/${issId}`, {
    cookie: vwCookie,
    body: { unit_price: 52000 },
  });
  assert.equal(vwPatch.status, 403);

  // Editor allowed on BOTH (previously 403 due to 'tyrebattery' typo!)
  const edPost = await rawReq('POST', '/api/tyre-battery/prices', {
    cookie: edCookie,
    body: { kind: 'tyre', prices: [{ category_norm: '1000X20', category: '1000X20', unit_price: 55000 }] },
  });
  assert.equal(edPost.status, 200, edPost.text);

  const edPatch = await rawReq('PATCH', `/api/tyre-battery/issues/${issId}`, {
    cookie: edCookie,
    body: { unit_price: 52000 },
  });
  assert.equal(edPatch.status, 200, edPatch.text);

  const audits = all("SELECT entity, action FROM audit_log WHERE entity IN ('tyre_battery_prices', 'tyre_battery_issues')");
  assert.equal(audits.length, 2, 'Both tyre_battery mutations recorded in audit_log');
});

test('3. fleet_finance includes Tyre/Battery + Outsourcing + Driver costs & seal-period works with snapshot + audit', async () => {
  mkUser('fin_admin', ['admin']);
  const adminCookie = await loginAs('fin_admin');

  const aId = run(
    "INSERT INTO assets (code, code_norm, ec_code, registration, type, status, in_register) VALUES ('VH-FIN-01', 'VHFIN01', 'VH-FIN-01', 'WP-9988', 'tipper', 'active', 1)"
  ).lastInsertRowid;

  // Tyre issue for 2026-10
  run(
    "INSERT INTO tyre_battery_issues (kind, issue_date, vehicle, asset_id, qty, category, category_norm, unit_price, row_hash, store_id) VALUES ('tyre', '2026-10-15', 'VH-FIN-01', ?, 1, '1000X20', '1000X20', 40000, 'tb-fin-1', 1)",
    aId
  );
  // Driver cost for 2026-10
  run(
    "INSERT INTO vehicle_driver_other_costs (asset_id, date, month, cost_type, driver_name, amount) VALUES (?, '2026-10-20', '2026-10', 'SALARY', 'Nimal', 25000)",
    aId
  );
  // CCOM Outsourcing unposted link for 2026-10
  const jcId = run(
    "INSERT INTO job_cards (job_no, asset_id, type, description, status) VALUES ('2026/10/R/901', ?, 'repair', 'CCOM external repair test', 'IN_WORKSHOP')",
    aId
  ).lastInsertRowid;
  const vId = run("INSERT INTO outsourcing_vendors (code, name) VALUES ('V-TEST', 'Test Vendor')").lastInsertRowid;
  const oReqId = run(
    "INSERT INTO outsourcing_requests (ref_no, repair_job_id, vendor_id, request_type, asset_id, status, created_by) VALUES ('CCOM-T1', ?, ?, 'repair', ?, 'completed', 1)",
    jcId, vId, aId
  ).lastInsertRowid;
  run(
    "INSERT INTO outsourcing_cost_links (request_id, invoice_no, invoice_date, amount, posted_to_parent) VALUES (?, 'INV-88', '2026-10-18', 12000, 0)",
    oReqId
  );

  const prof = await rawReq('GET', '/api/fleet/finance/vehicle-profitability?year=2026&month=10&assetCode=VH-FIN-01', { cookie: adminCookie });
  assert.equal(prof.status, 200, prof.text);
  const row = prof.json.report.find((r) => r.assetId === aId);
  assert.ok(row, 'Asset present in profitability report');
  assert.equal(row.tyreBatteryCostCents, 4000000);
  assert.equal(row.driverOtherCostCents, 2500000);
  assert.equal(row.ccomOutsourceCents, 1200000);
  assert.equal(row.totalDirectCostCents, 7700000);

  // Seal period (previously crashed with audit.log is not a function!)
  const seal = await rawReq('POST', '/api/fleet/finance/seal-period', {
    cookie: adminCookie,
    body: { year: 2026, month: 10 },
  });
  assert.equal(seal.status, 200, seal.text);
  assert.equal(seal.json.success, true);
  assert.ok(seal.json.sealedCount >= 1);

  const snap = get("SELECT is_sealed, sealed_by FROM fleet_monthly_snapshots WHERE asset_id = ? AND year = 2026 AND month = 10", aId);
  assert.ok(snap && snap.is_sealed === 1, 'Sealed snapshot row persisted');
  const sealAudit = get("SELECT action FROM audit_log WHERE entity = 'fleet_monthly_snapshots' AND action = 'seal_period'");
  assert.ok(sealAudit, 'Seal period recorded in audit_log');
});

test('4. HTTP gzip compression shrinks app.js cleanly without altering content', async () => {
  const res = await rawReq('GET', '/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'gzip');
  const expected = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const unzipped = zlib.gunzipSync(res.raw).toString('utf8');
  assert.equal(unzipped, expected);
  assert.ok(res.raw.length < Buffer.byteLength(expected) * 0.4, 'Gzip should reduce size by >60%');
});

test('5. Audit logging works on workshops, vehicle_costing, meters & operations', async () => {
  const adminCookie = await loginAs('fin_admin');

  const assetId = get("SELECT id FROM assets WHERE code = 'VH-COST-01'").id;

  const wsRes = await rawReq('POST', '/api/workshops', { cookie: adminCookie, body: { code: 'TSTW', name: 'Test WS', place: 'Kandy' } });
  assert.equal(wsRes.status, 201, wsRes.text);

  const revRes = await rawReq('POST', '/api/vehicle-costing/revenue', { cookie: adminCookie, body: { asset_id: assetId, date: '2026-10-05', total_revenue: 90000 } });
  assert.equal(revRes.status, 200, revRes.text);

  const mtrRes = await rawReq('POST', '/api/meters', { cookie: adminCookie, body: { asset_id: assetId, reading: 12345, reading_date: '2026-10-14', forceOverride: true } });
  assert.equal(mtrRes.status, 200, mtrRes.text);

  assert.ok(get("SELECT 1 FROM audit_log WHERE entity = 'workshop' AND action = 'create'"));
  assert.ok(get("SELECT 1 FROM audit_log WHERE entity = 'vehicle_hiring_revenue' AND action = 'create'"));
  assert.ok(get("SELECT 1 FROM audit_log WHERE entity = 'meter_readings' AND action = 'record'"));
});

test('6. Migration 064 hygiene, swapped stores, workshop dedup, expired sessions, indexes & fuel backfill', () => {
  // Seed simulated anomalies matching live DB
  const pCep = run("INSERT INTO projects (code, name, active) VALUES ('CEP03', 'CEP-03 Project', 1)").lastInsertRowid;
  const pRuw = run("INSERT INTO projects (code, name, active) VALUES ('RUW', 'Ruwanwella Water Project', 1)").lastInsertRowid;
  run("INSERT OR IGNORE INTO store_locations (code, name, store_type, project_id, active) VALUES ('SITE-STORE-CEP03PROJE', 'CEP-03 Site Store', 'SITE_STORE', ?, 1)", pRuw);
  run("INSERT OR IGNORE INTO store_locations (code, name, store_type, project_id, active) VALUES ('SITE-STORE-RUWANWELLA', 'Ruwanwella Site Store', 'SITE_STORE', ?, 1)", pCep);

  run("INSERT INTO workshops (code, name, active) VALUES ('GWS', 'Galagedara', 1)");
  const galaId = run("INSERT INTO workshops (code, name, active) VALUES ('GALA', 'Galagedara Site Workshop', 1)").lastInsertRowid;
  run("INSERT INTO job_cards (job_no, type, description, status, workshop_id) VALUES ('DC/TEST/999', 'repair', 'Test', 'IN_WORKSHOP', ?)", galaId);
  run("INSERT INTO sessions (user_id, token, expires_at) VALUES (1, 'tok-exp-1', datetime('now','-1 day'))");
  run("INSERT INTO sessions (user_id, token, expires_at) VALUES (1, 'tok-live-1', datetime('now','+1 day'))");

  const stats = m064.runMigration(db);
  assert.equal(stats.storeLinksFixed, 2);
  assert.equal(stats.workshopMerged, true);
  assert.ok(stats.expiredSessionsPruned >= 1);
  assert.ok(stats.indexesCreated >= 10);

  assert.equal(get("SELECT project_id FROM store_locations WHERE code = 'SITE-STORE-CEP03PROJE'").project_id, pCep);
  assert.equal(get("SELECT project_id FROM store_locations WHERE code = 'SITE-STORE-RUWANWELLA'").project_id, pRuw);
  assert.equal(get("SELECT active FROM workshops WHERE code = 'GALA'").active, 0);
  assert.equal(get("SELECT COUNT(*) c FROM job_cards WHERE job_no LIKE 'DC/TEST/%'").c, 0);
  assert.equal(get("SELECT 1 FROM sessions WHERE token = 'tok-exp-1'"), undefined);
  assert.ok(get("SELECT 1 FROM sessions WHERE token = 'tok-live-1'"));

  // Check indexes & migration_046/048/064 gate flags
  assert.ok(get("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_fuel_issues_asset_date'"));
  assert.ok(get("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_filter_catalogue_oem_norm'"));
  assert.ok(get("SELECT 1 FROM settings WHERE key = 'migration_046_done'"));
  assert.ok(get("SELECT 1 FROM settings WHERE key = 'migration_048_done'"));
  assert.ok(get("SELECT 1 FROM settings WHERE key = 'migration_064_done'"));
});
