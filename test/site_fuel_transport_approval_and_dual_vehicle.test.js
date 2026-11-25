'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-site-transport-dual-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { rawDb, migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const permissions = require('../src/lib/permissions');
const { resolveVehicleIdentity } = require('../src/lib/vehicle_label');
const app = require('../src/server');

let server;
let baseUrl;
const cookies = {};

async function reqJson(urlPath, { method = 'GET', body = null, cookie = cookies.admin } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('spreadsheetml')) {
    const ab = await res.arrayBuffer();
    return { status: res.status, headers: res.headers, buffer: Buffer.from(ab) };
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, headers: res.headers, body: json };
}

async function loginAs(username, password) {
  const res = await reqJson('/api/auth/login', {
    method: 'POST',
    cookie: null,
    body: { username, password },
  });
  assert.equal(res.status, 200, `Login failed for ${username}: ${JSON.stringify(res.body)}`);
  return res.headers.get('set-cookie').split(';')[0];
}

test('Setup fixtures: Site staff, Transport tiered roles, dual E&C/Reg vehicles', async () => {
  migrate();
  permissions.seedDefaults();
  capabilities.seedCapabilities();
  require('../src/migrate/079_transport_fuel_approval_and_dual_vehicle').runMigration(rawDb);

  const reqCols = all('PRAGMA table_info(fuel_requests)').map((c) => c.name);
  for (const col of ['requested_channel', 'approved_litres', 'review_note', 'exceeds_norm']) {
    assert.ok(reqCols.includes(col), `Missing Migration 079 column: ${col}`);
  }
  assert.equal(get("SELECT value FROM settings WHERE key = 'fuel.require_transport_approval'").value, 'SITE_ALL');

  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop', 'Badalgama', 1, 1)");
  run("INSERT OR REPLACE INTO projects (id, code, name, name_norm, active) VALUES (38, 'CEP-03F', 'CEP-03 F (Galagedara)', 'cep-03 f galagedara', 1)");
  run("INSERT OR REPLACE INTO projects (id, code, name, name_norm, active) VALUES (14, 'BDG', 'Badalgama Plant', 'badalgama plant', 1)");

  run(`
    INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active)
    VALUES
      ('12', 'TANK-12', 'Galagedara Tank', 'FIXED', 'AUTO_DIESEL', 15000, 9000, 38, 1),
      ('1', 'TANK-1', 'Badalgama Tank', 'FIXED', 'AUTO_DIESEL', 20000, 12000, 14, 1)
  `);

  run(`
    INSERT INTO assets (id, code, code_norm, ec_code, registration, brand, type, category, asset_class, meter_type, current_hours, home_project_id, current_project_id, status, in_register, created_at, updated_at)
    VALUES
      (901, 'DT-15', 'DT15', 'DT-15', 'LM-5722', 'SINOTRUK', 'Dump Truck', 'Dump Truck', 'vehicle', 'KM', 50000, 38, 38, 'active', 1, datetime('now'), datetime('now')),
      (902, 'LI-3405', 'LI3405', 'WB-04', 'LI-3405', 'ISUZU', 'Water Bowser', 'Water Bowser', 'vehicle', 'HOURS', 1200, 38, 38, 'active', 1, datetime('now'), datetime('now')),
      (903, 'HEX-23', 'HEX23', 'HEX-23', NULL, 'KOBELCO', 'Excavator', 'Excavator', 'machine', 'HOURS', 4100, 38, 38, 'active', 1, datetime('now'), datetime('now')),
      (904, '57-3062', '573062', NULL, '57-3062', 'TOYOTA', 'Double Cab', 'Double Cab', 'vehicle', 'KM', 80000, 14, 14, 'active', 1, datetime('now'), datetime('now')),
      (1368, 'DAI-9757', 'DAI9757', 'SC-17', 'Badalgama Plant', 'MITSUBISHI', 'Single Cab', 'Single Cab', 'vehicle', 'KM', 25000, 14, 14, 'active', 1, datetime('now'), datetime('now'))
  `);

  // Verify migration 079 cleans dirty placeholder on asset 1368
  require('../src/migrate/079_transport_fuel_approval_and_dual_vehicle').runMigration(rawDb);
  assert.equal(get('SELECT registration FROM assets WHERE id = 1368').registration, 'DAI-9757');

  run(`
    INSERT INTO fleet_rental_rates (id, asset_id, category_name, rate_basis, rate_cents, fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy, fuel_cons_basis, created_at, updated_at)
    VALUES
      ('r-901', 901, 'Dump Truck', 'KM', 10000, 0.25, 0.30, 0.35, 'km', datetime('now'), datetime('now')),
      ('r-902', 902, 'Water Bowser', 'HOURLY', 20000, 5.0, 6.0, 7.5, 'hr', datetime('now'), datetime('now')),
      ('r-903', 903, 'Excavator', 'HOURLY', 500000, 8.0, 10.0, 12.0, 'hr', datetime('now'), datetime('now'))
  `);

  run(`
    INSERT INTO fuel_prices (fuel_type, fuel_kind, price_per_litre_cents, price_per_litre, effective_date, notes, created_by)
    VALUES ('AUTO_DIESEL', 'AUTO_DIESEL', 38500, 385, '2026-01-01', 'Test Tariff', 1)
  `);

  const pwHash = auth.hashPassword('FuelPlan#2026!');
  const roleId = (n) => get('SELECT id FROM roles WHERE name = ?', n).id;
  for (const rName of ['admin', 'site_storekeeper', 'pump_operator', 'transport_assistant', 'transport_assistant_manager', 'transport_manager']) {
    run('INSERT OR IGNORE INTO roles (name, label, active) VALUES (?, ?, 1)', rName, rName);
  }

  const createUser = (id, username, role, extra = {}) => {
    run(
      'INSERT INTO users (id, username, password_hash, full_name, project_id, bulk_tank_id, fuel_role, active, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)',
      id, username, pwHash, username, extra.projectId || null, extra.tankId || null, extra.fuelRole || null
    );
    run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', id, roleId(role));
  };

  createUser(1, 'sys_admin', 'admin');
  createUser(2, 'gal_site_sk', 'site_storekeeper', { projectId: 38 });
  createUser(3, 'gal_pump', 'pump_operator', { projectId: 38, tankId: '12', fuelRole: 'SITE_OPERATOR' });
  createUser(4, 'heshara_d', 'transport_assistant');
  createUser(5, 'bhashitha', 'transport_assistant_manager');
  createUser(6, 'nishan', 'transport_manager');

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  cookies.admin = await loginAs('sys_admin', 'FuelPlan#2026!');
  cookies.siteSk = await loginAs('gal_site_sk', 'FuelPlan#2026!');
  cookies.pump = await loginAs('gal_pump', 'FuelPlan#2026!');
  cookies.trAsst = await loginAs('heshara_d', 'FuelPlan#2026!');
  cookies.trAsstMgr = await loginAs('bhashitha', 'FuelPlan#2026!');
  cookies.trMgr = await loginAs('nishan', 'FuelPlan#2026!');
});

test('Dual vehicle identity helper resolves E&C + Reg across all fleet patterns cleanly', () => {
  assert.deepEqual(
    resolveVehicleIdentity({ code: 'DT-15', ec_code: 'DT-15', registration: 'LM-5722' }),
    { ec_code: 'DT-15', registration: 'LM-5722', primary: 'DT-15', display: 'DT-15 (LM-5722)' }
  );
  assert.deepEqual(
    resolveVehicleIdentity({ code: 'LI-3405', ec_code: 'WB-04', registration: 'LI-3405' }),
    { ec_code: 'WB-04', registration: 'LI-3405', primary: 'WB-04', display: 'WB-04 (LI-3405)' }
  );
  assert.deepEqual(
    resolveVehicleIdentity({ code: 'HEX-23', ec_code: 'HEX-23', registration: null }),
    { ec_code: 'HEX-23', registration: null, primary: 'HEX-23', display: 'HEX-23' }
  );
  assert.deepEqual(
    resolveVehicleIdentity({ code: '57-3062', ec_code: null, registration: '57-3062' }),
    { ec_code: null, registration: '57-3062', primary: '57-3062', display: '57-3062' }
  );
});

test('Site Fuel Request -> Transport Approval -> Pump Dispense + Heavy Machine Running Chart Optionality', async () => {
  // 1. Road vehicle KM without Running Chart No MUST fail (400)
  const kmMissingRc = await reqJson('/api/fuel/requests', {
    method: 'POST',
    cookie: cookies.siteSk,
    body: {
      assetCode: 'DT-15',
      meterReading: 50100,
      approxKm: 100,
      tripTotalFuel: 30,
      targetTankId: '12',
      projectId: 38,
    },
  });
  assert.equal(kmMissingRc.status, 400);
  assert.match(kmMissingRc.body.error, /Running Chart No/i);

  // 2. Heavy machine HOURS (HEX-23) WITHOUT Running Chart No succeeds & starts PENDING for Transport
  const hexReq = await reqJson('/api/fuel/requests', {
    method: 'POST',
    cookie: cookies.siteSk,
    body: {
      assetCode: 'HEX-23',
      meterReading: 4110,
      approxKm: 10,
      tripTotalFuel: 120, // norm is 10 * 10 = 100 L (+20% exact threshold -> within norm!)
      targetTankId: '12',
      projectId: 38,
    },
  });
  assert.equal(hexReq.status, 201, JSON.stringify(hexReq.body));
  assert.equal(hexReq.body.status, 'PENDING');
  assert.equal(hexReq.body.requested_channel, 'SITE');
  assert.equal(hexReq.body.exceeds_norm, false);
  assert.equal(hexReq.body.asset_display, 'HEX-23');

  // 3. Site Full Tank request on WB-04 (submitted by Reg LI-3405!) starts PENDING for Transport
  const wbFullReq = await reqJson('/api/fuel/requests', {
    method: 'POST',
    cookie: cookies.siteSk,
    body: {
      assetCode: 'LI-3405',
      runningChartNo: 'LOG-GAL-09',
      meterReading: 1210,
      approxKm: 10,
      isFullTank: true,
      targetTankId: '12',
      projectId: 38,
    },
  });
  assert.equal(wbFullReq.status, 201, JSON.stringify(wbFullReq.body));
  assert.equal(wbFullReq.body.status, 'PENDING');
  assert.equal(wbFullReq.body.asset_ec_code, 'WB-04');
  assert.equal(wbFullReq.body.asset_registration, 'LI-3405');
  assert.equal(wbFullReq.body.asset_display, 'WB-04 (LI-3405)');

  // 4. Site Excess (>20%) request starts PENDING with exceeds_norm=true
  const excessReq = await reqJson('/api/fuel/requests', {
    method: 'POST',
    cookie: cookies.siteSk,
    body: {
      assetCode: 'LM-5722', // Reg of DT-15
      runningChartNo: 'RC-GAL-888',
      meterReading: 50100,
      approxKm: 100, // norm = 30 L
      tripTotalFuel: 50, // +66% (>20%)
      targetTankId: '12',
      projectId: 38,
    },
  });
  assert.equal(excessReq.status, 201, JSON.stringify(excessReq.body));
  assert.equal(excessReq.body.status, 'PENDING');
  assert.equal(excessReq.body.exceeds_norm, true);
  assert.equal(excessReq.body.asset_ec_code, 'DT-15');
  assert.equal(excessReq.body.asset_registration, 'LM-5722');
  assert.equal(excessReq.body.asset_display, 'DT-15 (LM-5722)');

  // 5. Transport Assistant (Heshara) approves standard site request AND adjusts litres 120 -> 90L
  const asstApprove = await reqJson(`/api/fuel/requests/${hexReq.body.id}/review`, {
    method: 'POST',
    cookie: cookies.trAsst,
    body: { action: 'APPROVE', approvedLitres: 90, reviewNote: 'Capped to 90L per transport allocation' },
  });
  assert.equal(asstApprove.status, 200, JSON.stringify(asstApprove.body));
  assert.equal(asstApprove.body.request.status, 'APPROVED');
  assert.equal(asstApprove.body.request.approved_litres, 90);
  assert.equal(asstApprove.body.request.requested_litres, 120);

  // Transport Assistant CAN approve Full Tank standard site request
  const asstFullApprove = await reqJson(`/api/fuel/requests/${wbFullReq.body.id}/review`, {
    method: 'POST',
    cookie: cookies.trAsst,
    body: { action: 'APPROVE' },
  });
  assert.equal(asstFullApprove.status, 200);

  // Transport Assistant is BLOCKED (403) from approving >20% over-norm request
  const asstExcessBlock = await reqJson(`/api/fuel/requests/${excessReq.body.id}/review`, {
    method: 'POST',
    cookie: cookies.trAsst,
    body: { action: 'APPROVE' },
  });
  assert.equal(asstExcessBlock.status, 403);

  // 6. Transport Assistant Manager (Bhashitha) approves >20% over-norm request with adjusted 40L
  const mgrApprove = await reqJson(`/api/fuel/requests/${excessReq.body.id}/review`, {
    method: 'POST',
    cookie: cookies.trAsstMgr,
    body: { action: 'APPROVE', approvedLitres: 40, reviewNote: 'Verified long haul deviation' },
  });
  assert.equal(mgrApprove.status, 200, JSON.stringify(mgrApprove.body));
  assert.equal(mgrApprove.body.request.status, 'APPROVED');
  assert.equal(mgrApprove.body.request.approved_litres, 40);

  // 7. Transport-created >20% request cannot be self-approved (SoD 403), must be approved by another manager
  const trOwnExcess = await reqJson('/api/fuel/requests', {
    method: 'POST',
    cookie: cookies.trMgr,
    body: {
      assetCode: 'DT-15',
      runningChartNo: 'RC-TR-99',
      meterReading: 50200,
      approxKm: 100, // norm 30 L
      tripTotalFuel: 55,
      targetTankId: '1',
      projectId: 14,
    },
  });
  assert.equal(trOwnExcess.status, 201);
  assert.equal(trOwnExcess.body.status, 'PENDING');
  assert.equal(trOwnExcess.body.requested_channel, 'TRANSPORT');

  const selfSodBlock = await reqJson(`/api/fuel/requests/${trOwnExcess.body.id}/review`, {
    method: 'POST',
    cookie: cookies.trMgr,
    body: { action: 'APPROVE' },
  });
  assert.equal(selfSodBlock.status, 403);
  assert.match(selfSodBlock.body.error, /Segregation of Duties/i);

  // Pump Operator dispenses approved WB-04 request (entered by Reg LI-3405) -> search works by BOTH WB-04 & LI-3405
  const pumpIss = await reqJson(`/api/fuel/requests/${wbFullReq.body.id}/issue`, {
    method: 'POST',
    cookie: cookies.pump,
    body: { litres: 58, meterReading: 1210, sourceTankId: '12' },
  });
  assert.equal(pumpIss.status, 201, JSON.stringify(pumpIss.body));

  // Verify dual search on requests, issues, cross-check, and Excel columns
  const reqByEc = await reqJson('/api/fuel/requests?search=WB-04', { cookie: cookies.trMgr });
  assert.equal(reqByEc.status, 200);
  assert.ok(reqByEc.body.requests.some((r) => r.id === wbFullReq.body.id), 'Must find request searching by E&C WB-04');

  const reqByReg = await reqJson('/api/fuel/requests?search=LM-5722', { cookie: cookies.trMgr });
  assert.ok(reqByReg.body.requests.some((r) => r.id === excessReq.body.id), 'Must find request searching by Reg LM-5722');

  const issByEc = await reqJson('/api/fuel/issues?search=WB-04', { cookie: cookies.trMgr });
  assert.equal(issByEc.status, 200);
  assert.equal(issByEc.body.rows.length, 1);
  assert.equal(issByEc.body.rows[0].asset_display, 'WB-04 (LI-3405)');

  const ccByReg = await reqJson('/api/fuel/cross-check?search=LI-3405', { cookie: cookies.trMgr });
  assert.equal(ccByReg.status, 200);
  assert.equal(ccByReg.body.rows.length, 1);
  assert.equal(ccByReg.body.rows[0].asset_ec_code, 'WB-04');
  assert.equal(ccByReg.body.rows[0].asset_registration, 'LI-3405');

  const xlsxRes = await reqJson('/api/fuel/cross-check.xlsx', { cookie: cookies.trMgr });
  assert.equal(xlsxRes.status, 200);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsxRes.buffer);
  const ws = wb.worksheets[0];
  const headers = ws.getRow(1).values;
  assert.ok(headers.includes('E&C No'), 'Excel must include E&C No column');
  assert.ok(headers.includes('Vehicle Reg No'), 'Excel must include Vehicle Reg No column');
  assert.ok(headers.includes('Approved (L)'), 'Excel must include Approved (L) column');
});

test.after(() => {
  if (server) server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});
