'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-tank-transfers-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { rawDb, migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const permissions = require('../src/lib/permissions');
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

test('Setup fixtures: Migration 080, Badalgama/Galagedara/Wadakada tanks, DB-01 bowser & roles', async () => {
  migrate();
  permissions.seedDefaults();
  capabilities.seedCapabilities();
  require('../src/migrate/080_fuel_tank_transfers').runMigration(rawDb);

  const tbl = get("SELECT name FROM sqlite_master WHERE type='table' AND name='fuel_tank_transfers'");
  assert.ok(tbl && tbl.name === 'fuel_tank_transfers', 'Missing fuel_tank_transfers table');
  assert.equal(get("SELECT value FROM settings WHERE key = 'migration_080_done'").value, '1');

  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop', 'Badalgama', 1, 1)");
  run("INSERT OR REPLACE INTO projects (id, code, name, name_norm, active) VALUES (14, 'BDG', 'Badalgama Plant', 'badalgama plant', 1)");
  run("INSERT OR REPLACE INTO projects (id, code, name, name_norm, active) VALUES (38, 'CEP-03F', 'CEP-03 F (Galagedara)', 'cep-03 f galagedara', 1)");
  run("INSERT OR REPLACE INTO projects (id, code, name, name_norm, active) VALUES (40, 'WDK', 'Wadakada CEP', 'wadakada cep', 1)");

  run(`
    INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active)
    VALUES
      ('1', 'TANK-1', 'Badalgama Tank', 'FIXED', 'AUTO_DIESEL', 20000, 12000, 14, 1),
      ('12', 'TANK-12', 'Galagedara Tank', 'FIXED', 'AUTO_DIESEL', 15000, 2000, 38, 1),
      ('14', 'TANK-14', 'Wadakada Tank', 'FIXED', 'AUTO_DIESEL', 15000, 1500, 40, 1)
  `);

  run(`
    INSERT INTO assets (id, code, code_norm, ec_code, registration, brand, type, category, asset_class, meter_type, current_hours, home_project_id, current_project_id, status, in_register, created_at, updated_at)
    VALUES
      (340, 'DB-01', 'DB01', 'DB-01', 'LA-9208', 'ISUZU', 'Diesel Bowser', 'Fuel Bowser', 'vehicle', 'KM', 42000, 14, 14, 'active', 1, datetime('now'), datetime('now'))
  `);

  run(`
    INSERT INTO fuel_prices (fuel_type, fuel_kind, price_per_litre_cents, price_per_litre, effective_date, notes, created_by)
    VALUES ('AUTO_DIESEL', 'AUTO_DIESEL', 38500, 385, '2026-01-01', 'Test Tariff', 1)
  `);

  const pwHash = auth.hashPassword('TankXfer#2026!');
  const roleId = (n) => get('SELECT id FROM roles WHERE name = ?', n).id;
  for (const rName of ['admin', 'site_storekeeper', 'pump_operator', 'transport_assistant', 'transport_manager']) {
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
  createUser(2, 'gal_sk', 'site_storekeeper', { projectId: 38 });
  createUser(3, 'gal_pump', 'pump_operator', { projectId: 38, tankId: '12', fuelRole: 'SITE_OPERATOR' });
  createUser(4, 'bdg_pump', 'pump_operator', { projectId: 14, tankId: '1', fuelRole: 'SITE_OPERATOR' });
  createUser(5, 'wd_pump', 'pump_operator', { projectId: 40, tankId: '14', fuelRole: 'SITE_OPERATOR' });
  createUser(6, 'tr_asst', 'transport_assistant');
  createUser(7, 'tr_mgr', 'transport_manager');

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  cookies.admin = await loginAs('sys_admin', 'TankXfer#2026!');
  cookies.galSk = await loginAs('gal_sk', 'TankXfer#2026!');
  cookies.galPump = await loginAs('gal_pump', 'TankXfer#2026!');
  cookies.bdgPump = await loginAs('bdg_pump', 'TankXfer#2026!');
  cookies.wdPump = await loginAs('wd_pump', 'TankXfer#2026!');
  cookies.trAsst = await loginAs('tr_asst', 'TankXfer#2026!');
  cookies.trMgr = await loginAs('tr_mgr', 'TankXfer#2026!');
});

test('Bootstrap exposes all source tanks, scoped dest tanks, and dual E&C/Reg bowsers', async () => {
  const res = await reqJson('/api/fuel/tank-transfers/bootstrap', { cookie: cookies.galSk });
  assert.equal(res.status, 200);
  assert.ok(res.body.sourceTanks.some((t) => String(t.id) === '1'), 'Site should see Badalgama as source tank');
  assert.equal(res.body.destTanks.length, 1, 'Scoped site user should only have Galagedara in destTanks');
  assert.equal(String(res.body.destTanks[0].id), '12');

  const db01 = res.body.bowsers.find((b) => b.ec_code === 'DB-01');
  assert.ok(db01, 'Bowser DB-01 should appear in bowsers list');
  assert.equal(db01.registration, 'LA-9208');
  assert.equal(db01.display, 'DB-01 (LA-9208)');
});

let gTransferId = null;

test('End-to-End Badalgama -> Galagedara Transfer: Request -> Transport Review -> Dispatch -> Receipt (-40L variance)', async () => {
  // 1. Galagedara raises request from Badalgama Tank (id='1') to Galagedara Tank (id='12')
  const reqRes = await reqJson('/api/fuel/tank-transfers', {
    method: 'POST',
    cookie: cookies.galSk,
    body: {
      sourceTankId: '1',
      destTankId: '12',
      requestedLitres: 3000,
      reason: 'Galagedara excavators low diesel',
    },
  });
  assert.equal(reqRes.status, 201, JSON.stringify(reqRes.body));
  assert.equal(reqRes.body.status, 'PENDING');
  assert.match(reqRes.body.transfer_no, /^FTR-\d{4}-\d{5}$/);
  gTransferId = reqRes.body.id;

  // 2. Dispatch before Transport approval is rejected (409)
  const earlyDisp = await reqJson(`/api/fuel/tank-transfers/${gTransferId}/dispatch`, {
    method: 'POST',
    cookie: cookies.bdgPump,
    body: { dispatchedLitres: 3000 },
  });
  assert.equal(earlyDisp.status, 409);

  // 3. Transport Assistant cannot approve (403); Transport Manager approves 2800 L with DB-01 bowser
  const asstRev = await reqJson(`/api/fuel/tank-transfers/${gTransferId}/review`, {
    method: 'POST',
    cookie: cookies.trAsst,
    body: { action: 'APPROVE', approvedLitres: 2800, bowserAssetId: 340 },
  });
  assert.equal(asstRev.status, 403);

  const mgrRev = await reqJson(`/api/fuel/tank-transfers/${gTransferId}/review`, {
    method: 'POST',
    cookie: cookies.trMgr,
    body: {
      action: 'APPROVE',
      approvedLitres: 2800,
      bowserAssetId: 340,
      driverName: 'Kamal Perera',
      reviewNote: 'Dispatched via DB-01 tomorrow 6 AM',
    },
  });
  assert.equal(mgrRev.status, 200, JSON.stringify(mgrRev.body));
  assert.equal(mgrRev.body.status, 'APPROVED');
  assert.equal(mgrRev.body.approved_litres, 2800);
  assert.equal(mgrRev.body.bowser_display, 'DB-01 (LA-9208)');

  // 4. Tenancy check: Galagedara pump cannot dispatch from Badalgama tank (403)
  const crossDisp = await reqJson(`/api/fuel/tank-transfers/${gTransferId}/dispatch`, {
    method: 'POST',
    cookie: cookies.galPump,
    body: { dispatchedLitres: 2800 },
  });
  assert.equal(crossDisp.status, 403);

  // 5. Badalgama pump sees transfer in site-console outgoingTankTransfers & dispatches 2800 L
  const bdgConsoleBefore = await reqJson('/api/fuel/site-console', { cookie: cookies.bdgPump });
  assert.equal(bdgConsoleBefore.status, 200);
  assert.ok(bdgConsoleBefore.body.outgoingTankTransfers.some((t) => t.id === gTransferId));

  const issuesCountBefore = get('SELECT COUNT(*) AS c FROM fuel_issues').c;
  const dispRes = await reqJson(`/api/fuel/tank-transfers/${gTransferId}/dispatch`, {
    method: 'POST',
    cookie: cookies.bdgPump,
    body: {
      dispatchedLitres: 2800,
      sealNo: 'SEAL-778',
      dispatchNote: 'Loaded after dip check',
    },
  });
  assert.equal(dispRes.status, 200, JSON.stringify(dispRes.body));
  assert.equal(dispRes.body.status, 'IN_TRANSIT');
  assert.equal(get("SELECT current_litres FROM fuel_tanks WHERE id = '1'").current_litres, 9200);
  assert.equal(get('SELECT COUNT(*) AS c FROM fuel_issues').c, issuesCountBefore, 'Must NOT create false vehicle fuel_issue');

  // 6. Badalgama pump cannot receive into Galagedara tank (403); Galagedara pump sees incoming & receives 2760 L (-40 L variance)
  const crossRecv = await reqJson(`/api/fuel/tank-transfers/${gTransferId}/receive`, {
    method: 'POST',
    cookie: cookies.bdgPump,
    body: { receivedLitres: 2760 },
  });
  assert.equal(crossRecv.status, 403);

  const galConsole = await reqJson('/api/fuel/site-console', { cookie: cookies.galPump });
  assert.equal(galConsole.status, 200);
  assert.ok(galConsole.body.incomingTankTransfers.some((t) => t.id === gTransferId));

  const recvRes = await reqJson(`/api/fuel/tank-transfers/${gTransferId}/receive`, {
    method: 'POST',
    cookie: cookies.galPump,
    body: {
      receivedLitres: 2760,
      receiveSealNo: 'SEAL-778',
      receiveNote: 'Short by 40 L on offload dip',
    },
  });
  assert.equal(recvRes.status, 200, JSON.stringify(recvRes.body));
  assert.equal(recvRes.body.status, 'RECEIVED');
  assert.equal(recvRes.body.variance_litres, -40);
  assert.equal(get("SELECT current_litres FROM fuel_tanks WHERE id = '12'").current_litres, 4760);

  // Verify zero-cost fuel_bulk_deliveries row (no double counting!)
  const delRow = get('SELECT * FROM fuel_bulk_deliveries WHERE invoice_number = ?', recvRes.body.transfer_no);
  assert.ok(delRow, 'Expected zero-cost fuel_bulk_deliveries row');
  assert.equal(delRow.tank_id, '12');
  assert.equal(delRow.litres, 2760);
  assert.equal(delRow.cost_cents, 0);

  // 7. Alerts feed detects TANK_TRANSFER transit variance
  const month = new Date().toISOString().slice(0, 7);
  const alertsRes = await reqJson(`/api/fuel/alerts?month=${month}`, { cookie: cookies.admin });
  assert.equal(alertsRes.status, 200);
  const ttAlert = (alertsRes.body.alerts || []).find((a) => a.category === 'TANK_TRANSFER' && a.transfer_id === gTransferId);
  assert.ok(ttAlert, 'Expected TANK_TRANSFER alert for -40 L shortage');
  assert.equal(ttAlert.variance_litres, -40);
});

test('Badalgama -> Wadakada Transport-direct APPROVED & IN_TRANSIT cancel restores source stock', async () => {
  const createRes = await reqJson('/api/fuel/tank-transfers', {
    method: 'POST',
    cookie: cookies.trMgr,
    body: {
      sourceTankId: '1',
      destTankId: '14',
      requestedLitres: 2000,
      bowserAssetId: 340,
      driverName: 'Sunil',
      reason: 'Scheduled Wadakada replenishment',
      requireApproval: false,
    },
  });
  assert.equal(createRes.status, 201, JSON.stringify(createRes.body));
  assert.equal(createRes.body.status, 'APPROVED');
  const wId = createRes.body.id;

  const dispRes = await reqJson(`/api/fuel/tank-transfers/${wId}/dispatch`, {
    method: 'POST',
    cookie: cookies.bdgPump,
    body: { dispatchedLitres: 2000, sealNo: 'SEAL-889' },
  });
  assert.equal(dispRes.status, 200);
  assert.equal(get("SELECT current_litres FROM fuel_tanks WHERE id = '1'").current_litres, 7200);

  // Non-admin pump operator cannot cancel IN_TRANSIT transfer (403)
  const denyCancel = await reqJson(`/api/fuel/tank-transfers/${wId}/cancel`, {
    method: 'POST',
    cookie: cookies.bdgPump,
    body: { reason: 'Wrong load' },
  });
  assert.equal(denyCancel.status, 403);

  // Admin cancels IN_TRANSIT -> restores 2000 L back to Badalgama Tank (7200 -> 9200)
  const okCancel = await reqJson(`/api/fuel/tank-transfers/${wId}/cancel`, {
    method: 'POST',
    cookie: cookies.admin,
    body: { reason: 'Bowser breakdown, pumped back to Badalgama Tank' },
  });
  assert.equal(okCancel.status, 200, JSON.stringify(okCancel.body));
  assert.equal(okCancel.body.status, 'CANCELLED');
  assert.equal(get("SELECT current_litres FROM fuel_tanks WHERE id = '1'").current_litres, 9200);
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});
