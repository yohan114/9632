'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-fuel-site-rbac-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { rawDb, migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const permissions = require('../src/lib/permissions');
const { deduplicateTanksAndActivateSites } = require('../src/migrate/063_fuel_site_rbac_and_tank_cleanup');
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

test('Setup two-site RBAC fixtures (Badalgama & CEP-03) and test users', async () => {
  migrate();
  for (const [name, label, isSys] of [
    ['admin', 'Administrator', 1],
    ['manager', 'Manager', 1],
    ['purchase_local', 'Purchasing Local', 1],
    ['viewer', 'Viewer', 1],
  ]) {
    run('INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES (?, ?, ?, 1)', name, label, isSys);
  }
  permissions.seedDefaults();
  capabilities.seedCapabilities();

  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop', 'Badalgama', 1, 1)");
  run("INSERT OR REPLACE INTO projects (id, code, name, name_norm, active) VALUES (10, 'BDG', 'Badalgama Plant', 'badalgama plant', 1)");
  run("INSERT OR REPLACE INTO projects (id, code, name, name_norm, active) VALUES (21, 'CEP-03', 'CEP-03 E Package', 'cep-03 e package', 1)");

  run(`
    INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active)
    VALUES
      ('tk-bdg', 'TK-BDG', 'Badalgama Tank', 'FIXED', 'AUTO_DIESEL', 20000, 12000, 10, 1),
      ('tk-cep', 'TK-CEP', 'CEP-03 E Tank', 'FIXED', 'AUTO_DIESEL', 15000, 8000, 21, 1)
  `);

  run(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, category, asset_class, meter_type, current_hours, home_project_id, current_project_id, status, in_register, created_at, updated_at)
    VALUES
      (801, 'EX-10', 'EX10', 'WP-EX-10', 'CAT', 'Excavator', 'Excavator', 'machine', 'HOURS', 5000, 21, 21, 'active', 1, datetime('now'), datetime('now')),
      (802, 'DT-20', 'DT20', 'WP-DT-20', 'TATA', 'Dump Truck', 'Dump Truck', 'vehicle', 'KM', 42000, 10, 10, 'active', 1, datetime('now'), datetime('now'))
  `);

  run(`
    INSERT INTO fleet_rental_rates (id, asset_id, category_name, rate_basis, rate_cents, fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy, fuel_cons_basis, created_at, updated_at)
    VALUES
      ('r-801', 801, 'Excavator', 'HOURLY', 500000, 5.0, 7.0, 9.0, 'hr', datetime('now'), datetime('now')),
      ('r-802', 802, 'Dump Truck', 'KM', 10000, 0.25, 0.30, 0.35, 'km', datetime('now'), datetime('now'))
  `);

  run(`
    INSERT INTO fuel_prices (fuel_type, fuel_kind, price_per_litre_cents, price_per_litre, effective_date, notes, created_by)
    VALUES ('AUTO_DIESEL', 'AUTO_DIESEL', 38500, 385, '2026-01-01', 'Test Tariff', 1)
  `);

  const pwHash = auth.hashPassword('SecureTest#2026!');
  const roleId = (name) => get('SELECT id FROM roles WHERE name = ?', name).id;

  run("INSERT OR IGNORE INTO users (id, username, password_hash, full_name, active, must_change_password) VALUES (1, 'sys_admin', ?, 'System Admin', 1, 0)", pwHash);
  run("UPDATE users SET password_hash = ?, active = 1, must_change_password = 0 WHERE id = 1", pwHash);
  run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (1, ?)', roleId('admin'));
  const adminUser = get('SELECT username FROM users WHERE id = 1');

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  cookies.admin = await loginAs(adminUser.username, 'SecureTest#2026!');
});

test('POST /api/users persists site/tank fuel scope, and GET /api/access/people/:id exposes sub-parts & caps', async () => {
  // 1. Site Pump Operator for CEP-03 (with hide_stock=true)
  const createPump = await reqJson('/api/users', {
    method: 'POST',
    body: {
      username: 'pump_cep',
      password: 'SecureTest#2026!',
      full_name: 'CEP-03 Pump Operator',
      roles: ['pump_operator'],
      project_id: 21,
      bulk_tank_id: 'tk-cep',
      fuel_role: 'SITE_OPERATOR',
      hide_stock: true,
    },
  });
  assert.equal(createPump.status, 201, JSON.stringify(createPump.body));
  assert.equal(createPump.body.project_id, 21);
  assert.equal(createPump.body.bulk_tank_id, 'tk-cep');
  assert.equal(createPump.body.fuel_role, 'SITE_OPERATOR');
  assert.equal(Boolean(createPump.body.hide_stock), true);

  const dbPump = get("SELECT id, project_id, bulk_tank_id, fuel_role, hide_stock FROM users WHERE username = 'pump_cep'");
  assert.equal(dbPump.project_id, 21);
  assert.equal(dbPump.bulk_tank_id, 'tk-cep');
  assert.equal(dbPump.hide_stock, 1);
  run("UPDATE users SET must_change_password = 0 WHERE username = 'pump_cep'");

  // 2. Site Fuel Requester for CEP-03
  const createReq = await reqJson('/api/users', {
    method: 'POST',
    body: {
      username: 'req_cep',
      password: 'SecureTest#2026!',
      full_name: 'CEP-03 Fuel Requester',
      roles: ['fuel_requester'],
      project_id: 21,
      bulk_tank_id: 'tk-cep',
    },
  });
  assert.equal(createReq.status, 201, JSON.stringify(createReq.body));
  run("UPDATE users SET must_change_password = 0 WHERE username = 'req_cep'");

  // 3. Purchasing Officer (no fuel access at all)
  const createPurch = await reqJson('/api/users', {
    method: 'POST',
    body: {
      username: 'purch_local',
      password: 'SecureTest#2026!',
      full_name: 'Local Purchaser',
      roles: ['purchase_local'],
    },
  });
  assert.equal(createPurch.status, 201);
  run("UPDATE users SET must_change_password = 0 WHERE username = 'purch_local'");

  // 4. Viewer with personal override fuel = none
  const createViewer = await reqJson('/api/users', {
    method: 'POST',
    body: {
      username: 'viewer_nofuel',
      password: 'SecureTest#2026!',
      full_name: 'Viewer Without Fuel',
      roles: ['viewer'],
      sections: { fuel: 'none' },
      override_reason: 'Restrict fuel access for viewer',
    },
  });
  assert.equal(createViewer.status, 201);
  run("UPDATE users SET must_change_password = 0 WHERE username = 'viewer_nofuel'");

  // 5. Inspect GET /api/access/people/:id exposes fuel sub-parts and all sub-part capabilities
  const personRes = await reqJson(`/api/access/people/${dbPump.id}`);
  assert.equal(personRes.status, 200);
  const fuelSec = personRes.body.sections.find((s) => s.key === 'fuel');
  assert.ok(fuelSec, 'fuel section missing');
  assert.ok(Array.isArray(fuelSec.parts) && fuelSec.parts.length >= 6, 'fuel sub-parts missing');
  const capKeys = new Set(fuelSec.capabilities.map((c) => c.key));
  for (const k of ['fuel.console.view', 'fuel.issue', 'fuel.tanks.refill', 'fuel.correction.request', 'fuel.transport.request', 'fuel.prices.view', 'fuel.reports.view']) {
    assert.ok(capKeys.has(k), `fuel section missing sub-part capability ${k}`);
  }

  // 6. Verify section-save works with valid services capability key (no 400 Unknown permission)
  const secSave = await reqJson('/api/access/section-save', {
    method: 'POST',
    body: {
      role: 'manager',
      modules: { services: 'full' },
      capabilities: { 'services.checklist.verify': true },
    },
  });
  assert.equal(secSave.status, 200, JSON.stringify(secSave.body));

  cookies.pumpCep = await loginAs('pump_cep', 'SecureTest#2026!');
  cookies.reqCep = await loginAs('req_cep', 'SecureTest#2026!');
  cookies.purchLocal = await loginAs('purch_local', 'SecureTest#2026!');
  cookies.viewerNoFuel = await loginAs('viewer_nofuel', 'SecureTest#2026!');
});

test('Auth /me returns fuelScope, and module=none denies fuel endpoints regardless of legacy caps', async () => {
  const mePump = await reqJson('/api/auth/me', { cookie: cookies.pumpCep });
  assert.equal(mePump.status, 200);
  assert.equal(mePump.body.fuelScope.isPumpOnly, true);
  assert.equal(mePump.body.fuelScope.scoped, true);
  assert.equal(mePump.body.fuelScope.tankId, 'tk-cep');
  assert.equal(mePump.body.fuelScope.hideStock, true);

  const meReq = await reqJson('/api/auth/me', { cookie: cookies.reqCep });
  assert.equal(meReq.status, 200);
  assert.equal(meReq.body.fuelScope.isRequesterOnly, true);
  assert.equal(meReq.body.fuelScope.scoped, true);

  // Purchasing officer blocked across all fuel endpoints
  for (const ep of ['/api/fuel/issues', '/api/fuel/site-console', '/api/fuel/tanks', '/api/fuel/requests', '/api/fuel/prices', '/api/fuel/reports']) {
    const r = await reqJson(ep, { cookie: cookies.purchLocal });
    assert.equal(r.status, 403, `purchase_local must be 403 on ${ep}, got ${r.status}`);
  }

  // Viewer with personal override fuel=none blocked from fuel endpoints
  const vFuel = await reqJson('/api/fuel/issues', { cookie: cookies.viewerNoFuel });
  assert.equal(vFuel.status, 403);
});

let bdgReqId;
let cepReqId;
let cepPendingReqId;
let cepIssueId;
let corrId;

test('Site Fuel Requester raises own-site requests, blocked from other sites & pump dispensing', async () => {
  // Bootstrap only returns assigned site/tank
  const boot = await reqJson('/api/fuel/transport-bootstrap', { cookie: cookies.reqCep });
  assert.equal(boot.status, 200, JSON.stringify(boot.body));
  assert.equal(boot.body.tanks.length, 1);
  assert.equal(boot.body.tanks[0].id, 'tk-cep');
  assert.equal(boot.body.projects.length, 1);
  assert.equal(boot.body.projects[0].id, 21);

  // Site-raised within-band request MUST now route through Transport Section approval first (PENDING, SITE channel)
  const cepReq = await reqJson('/api/fuel/requests', {
    method: 'POST',
    cookie: cookies.reqCep,
    body: {
      assetCode: 'EX-10',
      runningChartNo: 'RC-CEP-100',
      driverName: 'Saman',
      tripPurpose: 'Excavation Section A',
      meterReading: 5010,
      approxKm: 10,
      tripTotalFuel: 70,
      sourceMode: 'TANK',
      targetTankId: 'tk-cep',
      projectId: 21,
    },
  });
  assert.equal(cepReq.status, 201, JSON.stringify(cepReq.body));
  assert.equal(cepReq.body.status, 'PENDING');
  assert.equal(cepReq.body.requested_channel, 'SITE');
  assert.equal(cepReq.body.exceeds_norm, false);
  cepReqId = cepReq.body.id;

  // Pump cannot dispense before Transport approves it (409)
  const preApproveIssue = await reqJson(`/api/fuel/requests/${cepReqId}/issue`, {
    method: 'POST',
    cookie: cookies.pumpCep,
    body: { litres: 70, sourceTankId: 'tk-cep' },
  });
  assert.equal(preApproveIssue.status, 409);

  // Transport/Admin approves standard site request -> moves to APPROVED at CEP-03 pump
  const appRes = await reqJson(`/api/fuel/requests/${cepReqId}/review`, {
    method: 'POST',
    cookie: cookies.admin,
    body: { action: 'APPROVE', dispenseNow: false },
  });
  assert.equal(appRes.status, 200, JSON.stringify(appRes.body));
  assert.equal(appRes.body.request.status, 'APPROVED');

  // Can raise >20% excess request -> PENDING manager approval
  const cepExcess = await reqJson('/api/fuel/requests', {
    method: 'POST',
    cookie: cookies.reqCep,
    body: {
      assetCode: 'EX-10',
      runningChartNo: 'RC-CEP-101',
      meterReading: 5020,
      approxKm: 10,
      tripTotalFuel: 100, // +42% over 70L norm
      sourceMode: 'TANK',
      targetTankId: 'tk-cep',
      projectId: 21,
    },
  });
  assert.equal(cepExcess.status, 201);
  assert.equal(cepExcess.body.status, 'PENDING');
  cepPendingReqId = cepExcess.body.id;

  // Blocked from raising a request for Badalgama tank
  const crossSiteReq = await reqJson('/api/fuel/requests', {
    method: 'POST',
    cookie: cookies.reqCep,
    body: {
      assetCode: 'DT-20',
      runningChartNo: 'RC-BDG-X',
      meterReading: 42100,
      approxKm: 100,
      tripTotalFuel: 30,
      sourceMode: 'TANK',
      targetTankId: 'tk-bdg',
      projectId: 10,
    },
  });
  assert.equal(crossSiteReq.status, 403);

  // Blocked from dispensing fuel or refueling tank
  const dispBlock = await reqJson(`/api/fuel/requests/${cepReqId}/issue`, {
    method: 'POST',
    cookie: cookies.reqCep,
    body: { litres: 70, sourceTankId: 'tk-cep' },
  });
  assert.equal(dispBlock.status, 403);

  const refuelBlock = await reqJson('/api/fuel/site-console/refuel', {
    method: 'POST',
    cookie: cookies.reqCep,
    body: { tankId: 'tk-cep', litresDelivered: 500 },
  });
  assert.equal(refuelBlock.status, 403);

  // Admin creates & issues a Badalgama request so we can test cross-site isolation for CEP-03 pump operator
  const bdgReq = await reqJson('/api/fuel/requests', {
    method: 'POST',
    cookie: cookies.admin,
    body: {
      assetCode: 'DT-20',
      runningChartNo: 'RC-BDG-200',
      meterReading: 42100,
      approxKm: 100,
      tripTotalFuel: 30,
      sourceMode: 'TANK',
      targetTankId: 'tk-bdg',
      projectId: 10,
    },
  });
  assert.equal(bdgReq.status, 201);
  bdgReqId = bdgReq.body.id;

  // Create a second Badalgama request and dispense it as Admin to verify CEP-03 pump operator never sees Badalgama history
  const bdgReq2 = await reqJson('/api/fuel/requests', {
    method: 'POST',
    cookie: cookies.admin,
    body: {
      assetCode: 'DT-20',
      runningChartNo: 'RC-BDG-201',
      meterReading: 42200,
      approxKm: 100,
      tripTotalFuel: 30,
      sourceMode: 'TANK',
      targetTankId: 'tk-bdg',
      projectId: 10,
    },
  });
  const bdgIss = await reqJson(`/api/fuel/requests/${bdgReq2.body.id}/issue`, {
    method: 'POST',
    cookie: cookies.admin,
    body: { litres: 30, sourceTankId: 'tk-bdg' },
  });
  assert.equal(bdgIss.status, 201);
});

test('Site Pump Operator strictly limited to 4 own-tank sections, hide_stock, and Admin change request workflow', async () => {
  // 1. Locked to tk-cep even if requesting ?tankId=tk-bdg, and hide_stock masks all balances
  const sc = await reqJson('/api/fuel/site-console?tankId=tk-bdg', { cookie: cookies.pumpCep });
  assert.equal(sc.status, 200);
  assert.equal(sc.body.tank.id, 'tk-cep');
  assert.equal(sc.body.tank.current_litres, null);
  assert.equal(sc.body.allTanks.length, 1);
  assert.equal(sc.body.allTanks[0].id, 'tk-cep');
  assert.equal(sc.body.allTanks[0].current_litres, null);
  assert.equal(sc.body.allProjects.length, 1);
  assert.equal(sc.body.allProjects[0].id, 21);
  assert.ok(sc.body.pendingPumpRequests.some((r) => r.id === cepReqId));
  assert.ok(!sc.body.pendingPumpRequests.some((r) => r.id === bdgReqId));

  // /api/fuel/tanks also scoped & masked
  const tanksRes = await reqJson('/api/fuel/tanks', { cookie: cookies.pumpCep });
  assert.equal(tanksRes.status, 200);
  assert.equal(tanksRes.body.tanks.length, 1);
  assert.equal(tanksRes.body.tanks[0].current_litres, null);

  // 2. Blocked from raising fuel requests, approving >20% requests, and SITE-* transfers
  const reqBlock = await reqJson('/api/fuel/requests', {
    method: 'POST',
    cookie: cookies.pumpCep,
    body: { assetCode: 'EX-10', runningChartNo: 'RC-X', meterReading: 5030, approxKm: 5, tripTotalFuel: 30, sourceMode: 'TANK', targetTankId: 'tk-cep' },
  });
  assert.equal(reqBlock.status, 403);

  const approveBlock = await reqJson(`/api/fuel/requests/${cepPendingReqId}/review`, {
    method: 'POST',
    cookie: cookies.pumpCep,
    body: { action: 'APPROVE' },
  });
  assert.equal(approveBlock.status, 403);

  const siteTransferBlock = await reqJson('/api/fuel/issues', {
    method: 'POST',
    cookie: cookies.pumpCep,
    body: { assetCode: 'SITE-BDG', litres: 100, sourceTankId: 'tk-cep', targetProjectId: 10 },
  });
  assert.equal(siteTransferBlock.status, 400);
  assert.match(siteTransferBlock.body.error, /No Request, No Issue/i);

  // 3. Blocked from issuing against Badalgama request/tank
  const crossIssue = await reqJson(`/api/fuel/requests/${bdgReqId}/issue`, {
    method: 'POST',
    cookie: cookies.pumpCep,
    body: { litres: 30, sourceTankId: 'tk-bdg' },
  });
  assert.equal(crossIssue.status, 403);

  // 4. CAN dispense against approved CEP-03 request
  const cepIss = await reqJson(`/api/fuel/requests/${cepReqId}/issue`, {
    method: 'POST',
    cookie: cookies.pumpCep,
    body: { litres: 68, meterReading: 5010, sourceTankId: 'tk-cep' },
  });
  assert.equal(cepIss.status, 201, JSON.stringify(cepIss.body));
  cepIssueId = cepIss.body.issue.id;

  // 5. Issue history strictly scoped to tk-cep (no Badalgama issues visible)
  const hist = await reqJson('/api/fuel/issues', { cookie: cookies.pumpCep });
  assert.equal(hist.status, 200);
  assert.equal(hist.body.rows.length, 1);
  assert.equal(hist.body.rows[0].id, cepIssueId);

  // 6. Blocked from directly voiding an issue
  const voidBlock = await reqJson(`/api/fuel/issues/${cepIssueId}/void`, {
    method: 'POST',
    cookie: cookies.pumpCep,
    body: { reason: 'Trying direct void' },
  });
  assert.equal(voidBlock.status, 403);

  // 7. CAN submit a change request to Admin — MUST stay PENDING even with autoApprove=true
  const corrCreate = await reqJson('/api/fuel/corrections', {
    method: 'POST',
    cookie: cookies.pumpCep,
    body: {
      fuelIssueId: cepIssueId,
      correctionType: 'EDIT',
      newLitres: 65,
      reason: 'Pump meter actually showed 65.0L',
      autoApprove: true,
    },
  });
  assert.equal(corrCreate.status, 201, JSON.stringify(corrCreate.body));
  assert.equal(corrCreate.body.status, 'PENDING');
  corrId = corrCreate.body.id;

  // Duplicate PENDING change request blocked (409)
  const dupCorr = await reqJson('/api/fuel/corrections', {
    method: 'POST',
    cookie: cookies.pumpCep,
    body: { fuelIssueId: cepIssueId, correctionType: 'EDIT', newLitres: 64, reason: 'Duplicate' },
  });
  assert.equal(dupCorr.status, 409);

  // Pump operator blocked from approving own change request
  const selfApprove = await reqJson(`/api/fuel/corrections/${corrId}/review`, {
    method: 'POST',
    cookie: cookies.pumpCep,
    body: { action: 'APPROVE' },
  });
  assert.equal(selfApprove.status, 403);

  // Admin approves change request -> issue=65, request.actual_issued_litres=65, variance=-5, tank restored +3L
  const stockBeforeApprove = get("SELECT current_litres FROM fuel_tanks WHERE id = 'tk-cep'").current_litres;
  const adminApprove = await reqJson(`/api/fuel/corrections/${corrId}/review`, {
    method: 'POST',
    cookie: cookies.admin,
    body: { action: 'APPROVE', reviewNote: 'Verified slip with site supervisor' },
  });
  assert.equal(adminApprove.status, 200);
  assert.equal(adminApprove.body.status, 'APPROVED');

  const issAfter = get('SELECT litres, variance_litres FROM fuel_issues WHERE id = ?', cepIssueId);
  const reqAfter = get('SELECT actual_issued_litres FROM fuel_requests WHERE id = ?', cepReqId);
  const stockAfterApprove = get("SELECT current_litres FROM fuel_tanks WHERE id = 'tk-cep'").current_litres;
  assert.equal(issAfter.litres, 65);
  assert.equal(issAfter.variance_litres, -5);
  assert.equal(reqAfter.actual_issued_litres, 65);
  assert.equal(stockAfterApprove, stockBeforeApprove + 3);

  // 8. Fuel Add to own tank succeeds (and hides new_balance when hide_stock=1), cross-tank blocked
  const badRefuel = await reqJson('/api/fuel/site-console/refuel', {
    method: 'POST',
    cookie: cookies.pumpCep,
    body: { tankId: 'tk-bdg', litresDelivered: 1000, supplierName: 'Ceypetco', invoiceNo: 'INV-BAD' },
  });
  assert.equal(badRefuel.status, 403);

  const okRefuel = await reqJson('/api/fuel/site-console/refuel', {
    method: 'POST',
    cookie: cookies.pumpCep,
    body: { tankId: 'tk-cep', litresDelivered: 2000, supplierName: 'Ceypetco Bulk', invoiceNo: 'INV-CEP-500' },
  });
  assert.equal(okRefuel.status, 201, JSON.stringify(okRefuel.body));
  assert.equal(okRefuel.body.new_balance, null); // masked due to hide_stock=1

  // Site console now reflects recentIssues, myCorrections (APPROVED), and recentDeliveries (Fuel Add History)
  const scAfter = await reqJson('/api/fuel/site-console', { cookie: cookies.pumpCep });
  assert.equal(scAfter.status, 200);
  assert.equal(scAfter.body.recentIssues.length, 1);
  assert.equal(scAfter.body.recentIssues[0].litres, 65);
  assert.ok(scAfter.body.myCorrections.some((c) => c.id === corrId && c.status === 'APPROVED'));
  assert.ok(scAfter.body.recentDeliveries.some((d) => d.invoice_number === 'INV-CEP-500' && d.litres === 2000));

  // 9. Blocked from ALL sections outside the 4 pump-operator sections
  for (const ep of [
    '/api/fuel/prices',
    '/api/fuel/reports',
    '/api/fuel/alerts',
    '/api/fuel/sites-overview',
    '/api/fuel/fleet-directory',
    '/api/fuel/cross-check',
    '/api/meters',
    '/api/meters/check?asset_code=EX-10',
  ]) {
    const r = await reqJson(ep, { cookie: cookies.pumpCep });
    assert.equal(r.status, 403, `pump_operator must be 403 on ${ep}, got ${r.status}`);
  }

  const quickLogBlock = await reqJson('/api/fuel/service-planner/quick-log', {
    method: 'POST',
    cookie: cookies.pumpCep,
    body: { assetCode: 'EX-10', serviceDate: '2026-11-19', meterAtService: 5010 },
  });
  assert.equal(quickLogBlock.status, 403);
});

test('Meters /check endpoint & override aliases work cleanly for Admin', async () => {
  const todayStr = new Date().toISOString().slice(0, 10);
  const chk = await reqJson('/api/meters/check?asset_code=EX-10&reading=4900', { cookie: cookies.admin });
  assert.equal(chk.status, 200);
  assert.equal(chk.body.found, true);
  assert.equal(chk.body.ok, false);

  const postNoOverride = await reqJson('/api/meters', {
    method: 'POST',
    cookie: cookies.admin,
    body: { asset_code: 'EX-10', reading: 4900, reading_date: todayStr },
  });
  assert.equal(postNoOverride.status, 400);

  const postOverride = await reqJson('/api/meters', {
    method: 'POST',
    cookie: cookies.admin,
    body: { asset_code: 'EX-10', reading: 4900, reading_date: todayStr, ignore_warning: true, notes: 'Replaced meter' },
  });
  assert.equal(postOverride.status, 200, JSON.stringify(postOverride.body));
});

test('Migration 063 tank deduplication remaps orphaned UUID history and activates site projects', () => {
  // Simulate live DB corruption: inactive project + triplicated tanks + orphaned UUID issue/delivery + test tank
  run("INSERT OR REPLACE INTO projects (id, code, name, name_norm, active) VALUES (105, 'GAL', 'Galagedara Site', 'galagedara site', 0)");
  run(`
    INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active)
    VALUES
      ('14', 'TANK-GAL-1', 'Galagedara Bulk Tank', 'FIXED', 'AUTO_DIESEL', 10000, 4200, 105, 1),
      ('140', 'TANK-GAL-2', 'Galagedara Bulk Tank', 'FIXED', 'AUTO_DIESEL', 10000, 0, 105, 1),
      ('uuid-gal-old', 'TANK-GAL-UUID', 'Galagedara Bulk Tank', 'FIXED', 'AUTO_DIESEL', 10000, 0, 105, 0),
      ('tank-test-cw', 'TEST-TANK', 'test Tank', 'FIXED', 'AUTO_DIESEL', 1000, 100, 10, 1)
  `);
  run(`
    INSERT INTO fuel_issues (id, issue_no, asset_code, vehicle_ref, litres, fuel_type, fuel_price_cents, total_cost_cents, issue_date, source_tank_id, bulk_tank_id, is_voided)
    VALUES ('fi-orphan-1', 'FI-ORPH-1', 'EX-10', 'EX-10', 45, 'AUTO_DIESEL', 38500, 1732500, '2026-08-10 08:00:00', 'uuid-gal-old', 'uuid-gal-old', 0)
  `);
  run(`
    INSERT INTO fuel_bulk_deliveries (id, tank_id, litres, fuel_type, supplier, delivery_date)
    VALUES ('fd-orphan-1', 'uuid-gal-old', 3000, 'AUTO_DIESEL', 'Ceypetco', '2026-08-01')
  `);

  const summary = deduplicateTanksAndActivateSites(rawDb);
  assert.ok(summary.duplicateTanksRemoved >= 2);
  assert.ok(summary.issuesRemapped >= 1);
  assert.ok(summary.deliveriesRemapped >= 1);

  const activeGalTanks = all("SELECT id, current_litres FROM fuel_tanks WHERE LOWER(name) = 'galagedara bulk tank' AND active = 1");
  assert.equal(activeGalTanks.length, 1);
  assert.equal(activeGalTanks[0].id, '14');
  assert.equal(activeGalTanks[0].current_litres, 4200);

  const testTankRow = get("SELECT active FROM fuel_tanks WHERE id = 'tank-test-cw'");
  assert.equal(testTankRow.active, 0);

  const remappedIssue = get("SELECT source_tank_id, bulk_tank_id FROM fuel_issues WHERE id = 'fi-orphan-1'");
  assert.equal(remappedIssue.source_tank_id, '14');
  assert.equal(remappedIssue.bulk_tank_id, '14');

  const remappedDeliv = get("SELECT tank_id FROM fuel_bulk_deliveries WHERE id = 'fd-orphan-1'");
  assert.equal(remappedDeliv.tank_id, '14');

  const projActive = get('SELECT active FROM projects WHERE id = 105');
  assert.equal(projActive.active, 1);
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try { rawDb.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
