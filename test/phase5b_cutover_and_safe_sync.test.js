'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const Database = require('better-sqlite3');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-p5b-cut-'));
const BACKUP_TMP = path.join(TMP, 'backups');
const CORE_PATH = path.join(TMP, 'core.db');
const CW_PATH = path.join(TMP, 'CW.db');
const MTR_PATH = path.join(TMP, 'MTR.db');
const MERGED_PATH = path.join(TMP, 'merged.db');

process.env.DB_PATH = MERGED_PATH;
process.env.MULTIDB = '0';
process.env.BACKUP_DIR = BACKUP_TMP;
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.NO_PORT = '1';
process.env.LEGACY_CORE_DB_PATH = CORE_PATH;
process.env.LEGACY_CW_DB_PATH = CW_PATH;
process.env.LEGACY_MTR_DB_PATH = MTR_PATH;

const test = require('node:test');
const assert = require('node:assert/strict');
const { db, get, run, migrate } = require('../src/db');
migrate();

const auth = require('../src/lib/auth');
const permissions = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');
const {
  getCutoverParityReport,
  runLiveDeltaSync,
  isSyntheticTestRow,
} = require('../scripts/sync_all_live_data');

for (const r of ['admin', ...Object.keys(permissions.DEFAULT_MATRIX)]) {
  run('INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES (?, ?, 1, 1)', r, r);
}
permissions.seedDefaults();
capabilities.seedCapabilities();
run("INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('p5b_viewer', 'P5B Viewer', 0, 1)");

const PW = 'PhaseFiveB#2026!';
function mkUser(username, roleName) {
  const uid = run(
    'INSERT INTO users (username, full_name, password_hash, active) VALUES (?, ?, ?, 1)',
    username, username, auth.hashPassword(PW)
  ).lastInsertRowid;
  run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, roleName);
  return uid;
}

mkUser('p5b_admin', 'admin');
mkUser('p5b_viewer', 'p5b_viewer');

const app = require('../src/server');
let server;
let port;
let adminCookie;
let viewerCookie;

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
        const text = raw.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        const sc = res.headers['set-cookie'];
        resolve({
          status: res.statusCode,
          headers: res.headers,
          raw,
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

function buildLegacyDb(filePath, tableNames) {
  const legacyDb = new Database(filePath);
  legacyDb.pragma('foreign_keys = OFF');
  for (const t of tableNames) {
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t);
    assert.ok(ddl && ddl.sql, `Missing DDL for ${t}`);
    legacyDb.exec(ddl.sql);
  }
  return legacyDb;
}

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
  adminCookie = (await rawReq('POST', '/api/auth/login', { body: { username: 'p5b_admin', password: PW } })).cookie;
  viewerCookie = (await rawReq('POST', '/api/auth/login', { body: { username: 'p5b_viewer', password: PW } })).cookie;

  // Seed enriched baseline rows in :1949 merged DB
  run("INSERT INTO assets (id, code, code_norm, registration, type, status) VALUES (1, 'DT-100', 'DT100', 'LM-1000', 'dump_truck', 'active')");
  run("INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, active) VALUES ('tank-1', 'T1', 'Central Tank', 'FIXED', 'AUTO_DIESEL', 20000, 12000, 1)");
  run("INSERT INTO fuel_bulk_deliveries (id, tank_id, litres, fuel_type, cost_cents, delivery_date, status) VALUES ('del-1', 'tank-1', 5000, 'AUTO_DIESEL', 57070000, '2026-11-10', 'DELIVERED')");
  run("INSERT INTO vehicle_monthly_costs (asset_id, year, month, fuel_cost, oil_cost, filter_cost, battery_cost, parts_cost, labour_cost, total_cost) VALUES (1, 2026, 11, 214440000, 0, 0, 0, 1000, 0, 214441000)");
  run("INSERT INTO job_cards (id, job_no, type, description, status, asset_id) VALUES (10, '2026/11/R/010', 'repair', 'Real existing job', 'IN_WORKSHOP', 1)");
  run("INSERT INTO issues (id, asset_id, job_id, description, qty, unit_price, issue_date, voided) VALUES (500, 1, 10, 'Filter Element', 2, 1250, '2026-11-10', 0)");
  run("INSERT INTO asset_aliases (id, raw_text, raw_norm, asset_id, resolved, hit_count, source) VALUES (700, 'LM-1000', 'LM1000', 1, 1, 5, 'oilbook')");
  run("INSERT INTO mtn (id, mtn_no, txn_date, description, qty, status) VALUES (329, '65001', '2026-10-06', 'Oil Transfer', 10, 'completed')");

  // Build core.db with stale unpriced delivery + unlinked alias
  const coreDb = buildLegacyDb(CORE_PATH, ['assets', 'asset_aliases', 'fuel_tanks', 'fuel_bulk_deliveries', 'fuel_issues', 'fuel_requests']);
  coreDb.prepare("INSERT INTO assets (id, code, code_norm, registration, type, status) VALUES (1, 'DT-100', 'DT100', 'LM-1000', 'dump_truck', 'active')").run();
  coreDb.prepare("INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, active) VALUES ('tank-1', 'T1', 'Central Tank', 'FIXED', 'AUTO_DIESEL', 20000, 12000, 1)").run();
  coreDb.prepare("INSERT INTO fuel_bulk_deliveries (id, tank_id, litres, fuel_type, cost_cents, delivery_date, status) VALUES ('del-1', 'tank-1', 5000, 'AUTO_DIESEL', 0, '2026-11-10', 'DELIVERED')").run();
  coreDb.prepare("INSERT INTO asset_aliases (id, raw_text, raw_norm, asset_id, resolved, hit_count, source) VALUES (700, 'LM-1000', 'LM1000', NULL, 0, 1, 'oilbook')").run();
  coreDb.close();

  // Build CW.db with synthetic test rows + stale zero-price issue + stale zero-fuel rollup
  const cwDb = buildLegacyDb(CW_PATH, ['job_cards', 'job_requests', 'job_daily_work', 'issues', 'vehicle_monthly_costs']);
  cwDb.prepare("INSERT INTO job_cards (id, job_no, type, description, status, asset_id, requested_at) VALUES (10, '2026/11/R/010', 'repair', 'Real existing job', 'IN_WORKSHOP', 1, '2026-11-10')").run();
  cwDb.prepare("INSERT INTO job_cards (id, job_no, type, description, status, asset_id, requested_at) VALUES (3584, 'DC/TEST/999', 'repair', 'Test Daily Cost', 'IN_WORKSHOP', 1, '2099-11-15')").run();
  cwDb.prepare("INSERT INTO job_cards (id, job_no, type, description, status, asset_id, requested_at) VALUES (3585, 'TEST/R/12345', 'repair', 'Engine knocking sound', 'IN_WORKSHOP', 1, '2026-11-12')").run();
  cwDb.prepare("INSERT INTO job_requests (id, jr_no, req_date, asset_id, type, description, approval_status) VALUES (28, 'JR-TEST-1', '2026-11-12', 1, 'repair', 'Engine knocking sound', 'requested')").run();
  cwDb.prepare("INSERT INTO job_daily_work (id, job_id, work_date, mechanic, description, hours, is_external, travel) VALUES (2895, 3584, '2099-11-15', 'Test Mechanic 01', 'Brake adjustment', 2, 0, 0)").run();
  cwDb.prepare("INSERT INTO job_daily_work (id, job_id, work_date, mechanic, description, hours, is_external, travel) VALUES (2896, 3584, '2099-11-15', 'Outside Lathe Works', 'Drum skimming', 1, 1, 0)").run();
  cwDb.prepare("INSERT INTO issues (id, asset_id, job_id, description, qty, unit_price, issue_date, voided) VALUES (500, 1, 10, 'Filter Element', 2, 0, '2026-11-10', 0)").run();
  cwDb.prepare("INSERT INTO issues (id, asset_id, job_id, description, qty, unit_price, issue_date, voided) VALUES (5695, 1, 3584, 'Test Brake Shoe', 1, 0, '2026-11-20', 0)").run();
  cwDb.prepare("INSERT INTO vehicle_monthly_costs (asset_id, year, month, fuel_cost, oil_cost, filter_cost, battery_cost, parts_cost, labour_cost, total_cost) VALUES (1, 2026, 11, 0, 0, 0, 0, 1000, 0, 1000)").run();
  cwDb.close();

  // Build MTR.db with same natural MTN key under id=1 and junk job_request
  const mtrDb = buildLegacyDb(MTR_PATH, ['mtn', 'job_cards', 'job_requests']);
  mtrDb.prepare("INSERT INTO mtn (id, mtn_no, txn_date, description, qty, status) VALUES (1, '65001', '2026-10-06', 'Oil Transfer', 10, 'completed')").run();
  mtrDb.prepare("INSERT INTO job_requests (id, jr_no, req_date, type, description, approval_status) VALUES (1, 'JR-0001', '2026-10-05', 'repair', 'fewwfw', 'requested')").run();
  mtrDb.close();
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('1. getCutoverParityReport ignores synthetic test rows and matches MTR by natural key', () => {
  assert.equal(isSyntheticTestRow('job_cards', { job_no: 'DC/TEST/1' }), true);
  assert.equal(isSyntheticTestRow('job_cards', { job_no: 'JC-REAL-9001', requested_at: '2026-11-19', description: 'Clutch repair' }), false);

  const report = getCutoverParityReport({
    corePath: CORE_PATH,
    cwPath: CW_PATH,
    mtrPath: MTR_PATH,
    mergedPath: MERGED_PATH,
  });

  assert.equal(report.readyForCutover, true);
  assert.equal(report.realMissingTotal, 0);
  assert.ok(report.syntheticTestIgnoredTotal >= 6, `Expected >= 6 synthetic ignored rows, got ${report.syntheticTestIgnoredTotal}`);

  const mtrMtn = report.tables.find((t) => t.source === 'MTR.db' && t.table === 'mtn');
  assert.ok(mtrMtn);
  assert.equal(mtrMtn.missingRealCount, 0);
  assert.equal(mtrMtn.status, 'SYNCED');
});

test('2. getCutoverParityReport flags real missing operational records', () => {
  const cwDb = new Database(CW_PATH);
  cwDb.pragma('foreign_keys = OFF');
  cwDb.prepare("INSERT INTO job_cards (id, job_no, type, description, status, asset_id, requested_at) VALUES (9001, 'JC-REAL-9001', 'repair', 'Hydraulic pump overhaul', 'IN_WORKSHOP', 1, '2026-11-20')").run();
  cwDb.close();

  const report = getCutoverParityReport({
    corePath: CORE_PATH,
    cwPath: CW_PATH,
    mtrPath: MTR_PATH,
    mergedPath: MERGED_PATH,
  });

  assert.equal(report.readyForCutover, false);
  assert.equal(report.realMissingTotal, 1);

  const jcRow = report.tables.find((t) => t.source === 'CW.db' && t.table === 'job_cards');
  assert.ok(jcRow);
  assert.equal(jcRow.missingRealCount, 1);
  assert.equal(jcRow.status, 'MISSING_IN_1949');
});

test('3. Non-destructive runLiveDeltaSync inserts real missing rows, skips synthetic rows, and preserves :1949 enrichments', () => {
  const stats = runLiveDeltaSync({
    quiet: true,
    corePath: CORE_PATH,
    cwPath: CW_PATH,
    mtrPath: MTR_PATH,
    mergedPath: MERGED_PATH,
  });

  assert.ok(stats.rowsInserted >= 1, `Expected >= 1 inserted row, got ${stats.rowsInserted}`);
  assert.ok(stats.syntheticRowsSkipped >= 6, `Expected >= 6 synthetic skipped, got ${stats.syntheticRowsSkipped}`);
  assert.ok(stats.protectedTablesSkipped.includes('vehicle_monthly_costs'));

  // Real missing row inserted
  const insertedJob = get("SELECT * FROM job_cards WHERE job_no = 'JC-REAL-9001'");
  assert.ok(insertedJob, 'Real missing job_card should be inserted');

  // Synthetic rows NOT injected
  assert.equal(get("SELECT id FROM job_cards WHERE job_no = 'DC/TEST/999'"), undefined);
  assert.equal(get("SELECT id FROM job_requests WHERE jr_no = 'JR-TEST-1'"), undefined);
  assert.equal(get("SELECT id FROM issues WHERE description = 'Test Brake Shoe'"), undefined);

  // :1949 enriched values preserved (never overwritten by stale :1929 rows)
  assert.equal(get("SELECT cost_cents FROM fuel_bulk_deliveries WHERE id = 'del-1'").cost_cents, 57070000);
  assert.equal(get('SELECT fuel_cost FROM vehicle_monthly_costs WHERE asset_id = 1 AND year = 2026 AND month = 11').fuel_cost, 214440000);
  assert.equal(get('SELECT unit_price FROM issues WHERE id = 500').unit_price, 1250);
  assert.equal(get('SELECT resolved, asset_id FROM asset_aliases WHERE id = 700').resolved, 1);
  assert.equal(get('SELECT resolved, asset_id FROM asset_aliases WHERE id = 700').asset_id, 1);

  // Parity report is now readyForCutover: true
  const postReport = getCutoverParityReport({
    corePath: CORE_PATH,
    cwPath: CW_PATH,
    mtrPath: MTR_PATH,
    mergedPath: MERGED_PATH,
  });
  assert.equal(postReport.readyForCutover, true);
  assert.equal(postReport.realMissingTotal, 0);
});

test('4. Cutover HTTP endpoints enforce admin RBAC, support dryRun, and create pre-sync backup snapshot', async () => {
  // Unauthenticated
  const unauth = await rawReq('GET', '/api/master-dashboard/cutover-status');
  assert.equal(unauth.status, 401);

  // Non-admin RBAC
  const nonAdminGet = await rawReq('GET', '/api/master-dashboard/cutover-status', { cookie: viewerCookie });
  assert.equal(nonAdminGet.status, 403);

  const nonAdminPost = await rawReq('POST', '/api/master-dashboard/sync-live', { cookie: viewerCookie, body: {} });
  assert.equal(nonAdminPost.status, 403);

  // Admin GET parity
  const adminGet = await rawReq('GET', '/api/master-dashboard/cutover-status', { cookie: adminCookie });
  assert.equal(adminGet.status, 200);
  assert.equal(adminGet.json.readyForCutover, true);
  assert.equal(adminGet.json.realMissingTotal, 0);
  assert.ok(Array.isArray(adminGet.json.tables) && adminGet.json.tables.length > 0);

  // Admin dryRun POST (no backup file created)
  const beforeFiles = fs.existsSync(BACKUP_TMP) ? fs.readdirSync(BACKUP_TMP).length : 0;
  const dryRes = await rawReq('POST', '/api/master-dashboard/sync-live', { cookie: adminCookie, body: { dryRun: true } });
  assert.equal(dryRes.status, 200);
  assert.equal(dryRes.json.dryRun, true);
  assert.equal(dryRes.json.parity.readyForCutover, true);
  const afterDryFiles = fs.existsSync(BACKUP_TMP) ? fs.readdirSync(BACKUP_TMP).length : 0;
  assert.equal(afterDryFiles, beforeFiles);

  // Admin live POST creates preSyncBackup and preserves :1949 enrichments
  const liveRes = await rawReq('POST', '/api/master-dashboard/sync-live', { cookie: adminCookie, body: {} });
  assert.equal(liveRes.status, 200);
  assert.equal(liveRes.json.ok, true);
  assert.ok(liveRes.json.preSyncBackup, 'Expected preSyncBackup filename');
  assert.ok(fs.existsSync(path.join(BACKUP_TMP, liveRes.json.preSyncBackup)), 'Expected backup snapshot file on disk');
  assert.equal(get("SELECT cost_cents FROM fuel_bulk_deliveries WHERE id = 'del-1'").cost_cents, 57070000);
});
