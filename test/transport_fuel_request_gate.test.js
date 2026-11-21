'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-transport-fuel-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const permissions = require('../src/lib/permissions');
const app = require('../src/server');

let server;
let baseUrl;
let adminCookie;
let transportCookie;
let pumpBadalgamaCookie;
let pumpSiteCookie;
let managerCookie;

async function reqJson(urlPath, { method = 'GET', body = null, cookie = adminCookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('spreadsheetml')) {
    const ab = await res.arrayBuffer();
    return { status: res.status, headers: res.headers, buffer: Buffer.from(ab) };
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, headers: res.headers, body: json };
}

async function loginAs(username, password) {
  const res = await reqJson('/api/auth/login', {
    method: 'POST',
    cookie: null,
    body: { username, password },
  });
  assert.equal(res.status, 200, `Login failed for ${username}: ${JSON.stringify(res.body)}`);
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, `Missing set-cookie for ${username}`);
  return setCookie.split(';')[0];
}

test('Setup multi-site transport fuel fixtures, tanks, vehicles & rate cards', async () => {
  migrate();
  permissions.seedDefaults();
  capabilities.seedCapabilities();

  const reqCols = all('PRAGMA table_info(fuel_requests)').map((c) => c.name);
  for (const col of ['running_chart_no', 'approx_km', 'recommended_litres', 'is_full_tank', 'target_tank_id']) {
    assert.ok(reqCols.includes(col), `fuel_requests missing migration 062 column ${col}`);
  }
  const issCols = all('PRAGMA table_info(fuel_issues)').map((c) => c.name);
  for (const col of ['variance_litres', 'cross_check_status', 'is_full_tank']) {
    assert.ok(issCols.includes(col), `fuel_issues missing migration 062 column ${col}`);
  }

  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop — Badalgama', 'Badalgama', 1, 1)");
  run("INSERT OR REPLACE INTO projects (id, code, name, name_norm, active) VALUES (10, 'BDG', 'Badalgama Main Workshop', 'badalgama main workshop', 1)");
  run("INSERT OR REPLACE INTO projects (id, code, name, name_norm, active) VALUES (21, 'CEP-03', 'CEP-03 E Package Site', 'cep-03 e package site', 1)");

  run(`
    INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active)
    VALUES
      ('tk-badalgama', 'TK-BDG-01', 'Badalgama Tank', 'FIXED', 'AUTO_DIESEL', 20000, 10000, 10, 1),
      ('tk-cep03', 'TK-CEP-01', 'CEP-03 Site Tank', 'BOWSER', 'AUTO_DIESEL', 8000, 4000, 21, 1)
  `);

  run(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, category, asset_class, meter_type, current_hours, home_project_id, current_project_id, status, in_register, created_at, updated_at)
    VALUES
      (701, 'DC-25', 'DC25', 'WP-PD-1025', 'Toyota', 'Double Cab', 'Double Cab', 'vehicle', 'KM', 12000, 10, 10, 'active', 1, datetime('now'), datetime('now')),
      (702, 'BH-12', 'BH12', 'WP-BH-4012', 'JCB', 'Backhoe Loader', 'Backhoe Loader', 'machine', 'HOURS', 3500, 21, 21, 'active', 1, datetime('now'), datetime('now'))
  `);

  run(`
    INSERT INTO fleet_rental_rates (id, asset_id, category_name, rate_basis, rate_cents, fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy, fuel_cons_basis, created_at, updated_at)
    VALUES
      ('rate-701', 701, 'Double Cab', 'KM', 12000, 0.08, 0.10, 0.125, 'km', datetime('now'), datetime('now')),
      ('rate-702', 702, 'Backhoe Loader', 'HOURLY', 500000, 5.5, 7.0, 9.0, 'hr', datetime('now'), datetime('now'))
  `);

  run(`
    INSERT INTO fuel_prices (fuel_type, price_per_litre_cents, effective_date, notes, created_by)
    VALUES ('AUTO_DIESEL', 38500, '2026-01-01', 'Active Auto Diesel', 1)
  `);

  const pwHash = auth.hashPassword('Transport#2026!');
  run("INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('admin', 'Administrator', 1, 1)");
  run("INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('transport_manager', 'Transport Manager', 1, 1)");
  run("INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('manager', 'Manager', 1, 1)");
  run("INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('fuel_officer', 'Fuel Officer', 0, 1)");
  const adminRole = get("SELECT id FROM roles WHERE name = 'admin'");
  const tmRole = get("SELECT id FROM roles WHERE name = 'transport_manager'");
  const mgrRole = get("SELECT id FROM roles WHERE name = 'manager'");
  const foRole = get("SELECT id FROM roles WHERE name = 'fuel_officer'");

  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password) VALUES (1, 'sys_admin', ?, 'Sys Admin', 1, 0)", pwHash);
  run('INSERT INTO user_roles (user_id, role_id) VALUES (1, ?)', adminRole.id);

  run("INSERT INTO users (id, username, password_hash, full_name, project_id, active, must_change_password) VALUES (2, 'tr_officer', ?, 'Transport Officer', 10, 1, 0)", pwHash);
  run('INSERT INTO user_roles (user_id, role_id) VALUES (2, ?)', tmRole.id);

  run("INSERT INTO users (id, username, password_hash, full_name, project_id, bulk_tank_id, active, must_change_password) VALUES (3, 'pump_bdg', ?, 'Badalgama Pump Operator', 10, 'tk-badalgama', 1, 0)", pwHash);
  run('INSERT INTO user_roles (user_id, role_id) VALUES (3, ?)', foRole.id);

  run("INSERT INTO users (id, username, password_hash, full_name, project_id, bulk_tank_id, active, must_change_password) VALUES (4, 'pump_cep', ?, 'CEP-03 Pump Operator', 21, 'tk-cep03', 1, 0)", pwHash);
  run('INSERT INTO user_roles (user_id, role_id) VALUES (4, ?)', foRole.id);

  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password) VALUES (5, 'ops_mgr', ?, 'Ops Manager', 1, 0)", pwHash);
  run('INSERT INTO user_roles (user_id, role_id) VALUES (5, ?)', mgrRole.id);

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  adminCookie = await loginAs('sys_admin', 'Transport#2026!');
  transportCookie = await loginAs('tr_officer', 'Transport#2026!');
  pumpBadalgamaCookie = await loginAs('pump_bdg', 'Transport#2026!');
  pumpSiteCookie = await loginAs('pump_cep', 'Transport#2026!');
  managerCookie = await loginAs('ops_mgr', 'Transport#2026!');
});

test('Recommended fuel calculation supports KM meter delta, manual approxKm & HR machinery norms', async () => {
  const kmAuto = await reqJson('/api/fuel/recommend-calc?assetCode=DC-25&prevMeterReading=12000&meterReading=12250', {
    cookie: transportCookie,
  });
  assert.equal(kmAuto.status, 200);
  assert.equal(kmAuto.body.ok, true);
  assert.equal(kmAuto.body.meterType, 'KM');
  assert.equal(kmAuto.body.basis, 'km');
  assert.equal(kmAuto.body.meterDelta, 250);
  assert.equal(kmAuto.body.approxKm, 250);
  assert.equal(kmAuto.body.recommendedLitres, 25); // 250 km * 0.10 L/km = 25 L

  const kmManual = await reqJson('/api/fuel/recommend-calc?assetCode=DC-25&prevMeterReading=12000&meterReading=12250&approxKm=300', {
    cookie: transportCookie,
  });
  assert.equal(kmManual.status, 200);
  assert.equal(kmManual.body.approxKm, 300);
  assert.equal(kmManual.body.usedMeterDelta, false);
  assert.equal(kmManual.body.recommendedLitres, 30);

  const hrAuto = await reqJson('/api/fuel/recommend-calc?assetCode=BH-12&prevMeterReading=3500&meterReading=3510', {
    cookie: transportCookie,
  });
  assert.equal(hrAuto.status, 200);
  assert.equal(hrAuto.body.basis, 'hr');
  assert.equal(hrAuto.body.meterDelta, 10);
  assert.equal(hrAuto.body.recommendedLitres, 70); // 10 hrs * 7.0 L/hr = 70 L
});

test('Strict No Request No Issue gate rejects unlinked issues across both endpoints while allowing SITE-* transfers', async () => {
  const directBlock = await reqJson('/api/fuel/issues', {
    method: 'POST',
    cookie: pumpBadalgamaCookie,
    body: {
      assetCode: 'DC-25',
      litres: 25,
      meterReading: 12100,
      sourceTankId: 'tk-badalgama',
      targetProjectId: 10,
    },
  });
  assert.equal(directBlock.status, 400);
  assert.match(directBlock.body.error, /No Request, No Issue/i);

  const consoleBlock = await reqJson('/api/fuel/site-console/issue', {
    method: 'POST',
    cookie: pumpSiteCookie,
    body: {
      assetCode: 'BH-12',
      litres: 40,
      meterReading: 3506,
      sourceTankId: 'tk-cep03',
      targetProjectId: 21,
    },
  });
  assert.equal(consoleBlock.status, 400);
  assert.match(consoleBlock.body.error, /No Request, No Issue/i);

  // Bulk tank-to-tank SITE-* transfer without a vehicle transport request succeeds
  const siteTransfer = await reqJson('/api/fuel/issues', {
    method: 'POST',
    cookie: pumpBadalgamaCookie,
    body: {
      assetCode: 'SITE-CEP03',
      litres: 200,
      sourceTankId: 'tk-badalgama',
      targetProjectId: 21,
    },
  });
  assert.equal(siteTransfer.status, 201);
});

test('Normal within-band request goes directly to Pump Queue, Full Tank lets operator enter qty after fill & enforces 1:1', async () => {
  // 1. Badalgama Full Tank request -> skips manager, lands directly APPROVED at Badalgama pump queue
  const fullReq = await reqJson('/api/fuel/requests', {
    method: 'POST',
    cookie: transportCookie,
    body: {
      assetCode: 'DC-25',
      runningChartNo: 'RC-BDG-2026-01',
      driverName: 'Kamal Perera',
      tripPurpose: 'Badalgama -> Colombo materials run',
      meterReading: 12200,
      approxKm: 200,
      sourceMode: 'TANK',
      targetTankId: 'tk-badalgama',
      isFullTank: true,
    },
  });
  assert.equal(fullReq.status, 201, JSON.stringify(fullReq.body));
  assert.equal(fullReq.body.status, 'APPROVED');
  assert.equal(fullReq.body.is_full_tank, true);
  assert.equal(fullReq.body.recommended_litres, 20); // 200 * 0.10 = 20 L
  assert.equal(fullReq.body.project_id, 10);

  // Verify Site Console returns pendingPumpRequests for Badalgama tank
  const bdgConsole = await reqJson('/api/fuel/site-console?tankId=tk-badalgama', { cookie: pumpBadalgamaCookie });
  assert.equal(bdgConsole.status, 200);
  assert.ok(bdgConsole.body.pendingPumpRequests.some((r) => r.id === fullReq.body.id));
  assert.ok(bdgConsole.body.allProjects.some((p) => p.id === 21), 'Site console must list all sites dynamically');

  // Verify CEP-03 site console queue is scoped cleanly to CEP-03 (does NOT show Badalgama's request)
  const cepConsole = await reqJson('/api/fuel/site-console?tankId=tk-cep03', { cookie: pumpSiteCookie });
  assert.equal(cepConsole.status, 200);
  assert.ok(!cepConsole.body.pendingPumpRequests.some((r) => r.id === fullReq.body.id));

  // Verify wrong vehicle fails
  const wrongVeh = await reqJson('/api/fuel/issues', {
    method: 'POST',
    cookie: pumpBadalgamaCookie,
    body: {
      fuelRequestId: fullReq.body.id,
      assetCode: 'BH-12',
      litres: 32,
      sourceTankId: 'tk-badalgama',
    },
  });
  assert.equal(wrongVeh.status, 400);
  assert.match(wrongVeh.body.error, /Vehicle mismatch/i);

  // 2. Pump Operator fills tank full and enters 32L after filling -> tank stock drops 32L & cross-check flags OVER_RECOMMENDED
  const beforeTank = get("SELECT current_litres FROM fuel_tanks WHERE id = 'tk-badalgama'").current_litres;
  const dispatchRes = await reqJson(`/api/fuel/requests/${fullReq.body.id}/issue`, {
    method: 'POST',
    cookie: pumpBadalgamaCookie,
    body: {
      litres: 32,
      meterReading: 12200,
      sourceTankId: 'tk-badalgama',
      notes: 'Full tank fill verified',
    },
  });
  assert.equal(dispatchRes.status, 201, JSON.stringify(dispatchRes.body));
  assert.equal(dispatchRes.body.issue.litres, 32);
  assert.equal(dispatchRes.body.issue.is_full_tank, true);
  assert.equal(dispatchRes.body.issue.variance_litres, 12); // 32 - 20 = +12L
  assert.equal(dispatchRes.body.issue.variance_pct, 60);
  assert.equal(dispatchRes.body.issue.cross_check_status, 'OVER_RECOMMENDED');
  assert.equal(dispatchRes.body.request.status, 'FULFILLED');
  assert.equal(dispatchRes.body.request.actual_issued_litres, 32);

  const afterTank = get("SELECT current_litres FROM fuel_tanks WHERE id = 'tk-badalgama'").current_litres;
  assert.equal(afterTank, beforeTank - 32);

  // 3. Attempting to reuse same fulfilled request fails with 409 (1 request = 1 issue)
  const doubleIssue = await reqJson(`/api/fuel/requests/${fullReq.body.id}/issue`, {
    method: 'POST',
    cookie: pumpBadalgamaCookie,
    body: { litres: 10 },
  });
  assert.equal(doubleIssue.status, 409);

  // 4. Voiding the issue restores tank stock AND reopens the request back to APPROVED
  const voidRes = await reqJson(`/api/fuel/issues/${dispatchRes.body.issue.id}/void`, {
    method: 'POST',
    cookie: adminCookie,
    body: { reason: 'Entered 32 instead of 22 by mistake' },
  });
  assert.equal(voidRes.status, 200);
  assert.equal(get("SELECT current_litres FROM fuel_tanks WHERE id = 'tk-badalgama'").current_litres, beforeTank);
  assert.equal(get('SELECT status FROM fuel_requests WHERE id = ?', fullReq.body.id).status, 'APPROVED');

  // Re-dispense correct 21L -> status becomes OK (within +-15% of 20L!)
  const reDispatch = await reqJson(`/api/fuel/requests/${fullReq.body.id}/issue`, {
    method: 'POST',
    cookie: pumpBadalgamaCookie,
    body: { litres: 21, meterReading: 12200 },
  });
  assert.equal(reDispatch.status, 201);
  assert.equal(reDispatch.body.issue.cross_check_status, 'OK');
});

test('Multi-site CEP-03 >20% excess request requires Manager approval, blocks backwards meter, exports Cross-Check XLSX', async () => {
  // Backwards meter rejected
  const backMeter = await reqJson('/api/fuel/requests', {
    method: 'POST',
    cookie: transportCookie,
    body: {
      assetCode: 'BH-12',
      runningChartNo: 'RC-CEP-01',
      meterReading: 3400, // current_hours = 3500!
      approxKm: 8,
      tripTotalFuel: 56,
      targetTankId: 'tk-cep03',
    },
  });
  assert.equal(backMeter.status, 400);

  // 1. Excess request: 8 hrs * 7 L/hr = 56L recommended, requesting 80L (+42.9% > 20%) -> PENDING Manager approval
  const excessReq = await reqJson('/api/fuel/requests', {
    method: 'POST',
    cookie: transportCookie,
    body: {
      assetCode: 'BH-12',
      runningChartNo: 'RC-CEP-2026-09',
      driverName: 'Nimal Silva',
      tripPurpose: 'Heavy rock excavation CEP-03',
      meterReading: 3508,
      approxKm: 8,
      tripTotalFuel: 80,
      sourceMode: 'TANK',
      targetTankId: 'tk-cep03',
      projectId: 21,
    },
  });
  assert.equal(excessReq.status, 201, JSON.stringify(excessReq.body));
  assert.equal(excessReq.body.needs_approval, true);
  assert.equal(excessReq.body.status, 'PENDING');
  assert.equal(excessReq.body.recommended_litres, 56);

  // Pump cannot dispense while PENDING approval (409)
  const blockedPending = await reqJson(`/api/fuel/requests/${excessReq.body.id}/issue`, {
    method: 'POST',
    cookie: pumpSiteCookie,
    body: { litres: 80 },
  });
  assert.equal(blockedPending.status, 409);

  // Manager approves -> moves to APPROVED (ready at CEP-03 pump)
  const mgrApprove = await reqJson(`/api/fuel/requests/${excessReq.body.id}/review`, {
    method: 'POST',
    cookie: managerCookie,
    body: { action: 'APPROVE', dispenseNow: false },
  });
  assert.equal(mgrApprove.status, 200);
  assert.equal(mgrApprove.body.request.status, 'APPROVED');

  // CEP-03 Pump Operator dispenses 75L -> OK against requested, OVER_RECOMMENDED vs 56L norm (+33.9%)
  const cepDispense = await reqJson(`/api/fuel/requests/${excessReq.body.id}/issue`, {
    method: 'POST',
    cookie: pumpSiteCookie,
    body: { litres: 75, sourceTankId: 'tk-cep03' },
  });
  assert.equal(cepDispense.status, 201, JSON.stringify(cepDispense.body));
  assert.equal(cepDispense.body.issue.variance_litres, 19); // 75 - 56 = +19L
  assert.equal(cepDispense.body.issue.cross_check_status, 'OVER_RECOMMENDED');

  // Cross-Check JSON report across sites & CEP-03 filter + XLSX export
  const ccAll = await reqJson('/api/fuel/cross-check', { cookie: managerCookie });
  assert.equal(ccAll.status, 200);
  assert.equal(ccAll.body.summary.fulfilledCount, 2);
  assert.equal(ccAll.body.summary.flaggedCount, 1);

  const ccCep = await reqJson('/api/fuel/cross-check?projectId=21', { cookie: managerCookie });
  assert.equal(ccCep.status, 200);
  assert.equal(ccCep.body.rows.length, 1);
  assert.equal(ccCep.body.rows[0].running_chart_no, 'RC-CEP-2026-09');

  const xlsxRes = await reqJson('/api/fuel/cross-check.xlsx', { cookie: managerCookie });
  assert.equal(xlsxRes.status, 200);
  assert.ok(xlsxRes.buffer.length > 500 && xlsxRes.buffer.slice(0, 2).toString() === 'PK', 'Valid XLSX zip header expected');
});

test.after(() => {
  if (server) server.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
});
