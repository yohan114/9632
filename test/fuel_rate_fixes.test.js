'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-fuel-rate-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { rawDb, migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const app = require('../src/server');

let server;
let baseUrl;
let adminCookie;
let fuelOpCookie;

async function reqJson(urlPath, { method = 'GET', body = null, cookie = adminCookie } = {}) {
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

test('Setup fresh database & fuel tariff test fixtures', async () => {
  migrate();
  capabilities.seedCapabilities();

  // Check fuel_corrections price columns from migration 059
  const corrCols = all('PRAGMA table_info(fuel_corrections)').map((c) => c.name);
  assert.ok(corrCols.includes('before_price_cents'), 'fuel_corrections missing before_price_cents');
  assert.ok(corrCols.includes('after_price_cents'), 'fuel_corrections missing after_price_cents');

  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop', 'Peliyagoda', 1, 1)");
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (20, 'PRJ-GAL', 'Galle Expressway', 'galle expressway', 1)");

  run(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, model_no, asset_class, meter_type, current_hours, home_project_id, current_project_id, status, in_register, created_at, updated_at)
    VALUES
      (501, 'EX-501', 'EX501', 'WP-EX-501', 'CAT', 'Excavator', '320D', 'vehicle', 'HOURS', 1000, 20, 20, 'active', 1, datetime('now'), datetime('now')),
      (502, 'LD-502', 'LD502', 'WP-LD-502', 'KOMATSU', 'Wheel Loader', 'WA380', 'vehicle', 'HOURS', 2000, 20, 20, 'active', 1, datetime('now'), datetime('now'))
  `);

  run(`
    INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active)
    VALUES ('tk-site-1', 'TK-GAL-01', 'Galle Site Bowser', 'BOWSER', 'AUTO_DIESEL', 10000, 5000, 20, 1)
  `);

  run("INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('admin', 'Administrator', 1, 1)");
  const adminRole = get("SELECT id FROM roles WHERE name = 'admin'");
  run("INSERT INTO roles (id, name, label, is_system, active) VALUES (55, 'fuel_operator', 'Fuel Operator', 0, 1)");
  for (const cap of [
    'fuel.view', 'fuel.issue', 'fuel.correct', 'fuel.approve_correction',
    'fuel.void', 'fuel.prices.view', 'fuel.tanks.view', 'fuel.tanks.dip', 'fuel.tanks.refill',
    'hire.billing.view', 'hire.billing.generate', 'hire.rates.view', 'hire.rates.manage',
    'allocations.view', 'allocations.manage', 'costing.manage',
  ]) {
    run("INSERT OR REPLACE INTO role_capabilities (role, capability, granted) VALUES ('fuel_operator', ?, 1)", cap);
  }
  run("INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES ('fuel_operator', 'fuel', 'full')");

  const pwHash = auth.hashPassword('TestPass#2026!');
  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password) VALUES (1, 'admin_fuel', ?, 'Admin Fuel', 1, 0)", pwHash);
  run('INSERT INTO user_roles (user_id, role_id) VALUES (1, ?)', adminRole.id);
  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password) VALUES (2, 'fuel_op', ?, 'Site Fuel Operator', 1, 0)", pwHash);
  run('INSERT INTO user_roles (user_id, role_id) VALUES (2, 55)');

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  adminCookie = await loginAs('admin_fuel', 'TestPass#2026!');
  fuelOpCookie = await loginAs('fuel_op', 'TestPass#2026!');
});

test('Fuel tariff creation, audit.record logging & date-effective lookup across dates', async () => {
  // Fuel operator without fuel.prices.manage is denied (403)
  const denied = await reqJson('/api/fuel/prices', {
    method: 'POST',
    cookie: fuelOpCookie,
    body: { fuelType: 'AUTO_DIESEL', pricePerLitre: 390, effectiveDate: '2026-09-01' },
  });
  assert.equal(denied.status, 403);

  // Admin creates multiple date-effective tariffs (tests audit.record fix — no 500 error)
  const tariffs = [
    { fuelType: 'AUTO_DIESEL', pricePerLitre: 360.00, effectiveDate: '2026-08-01', notes: 'August Tariff' },
    { fuelType: 'AUTO_DIESEL', pricePerLitre: 382.00, effectiveDate: '2026-09-01', notes: 'September Tariff' },
    { fuelType: 'AUTO_DIESEL', pricePerLitre: 405.50, effectiveDate: '2026-10-15', notes: 'Mid-Oct Revision' },
    { fuelType: 'SUPER_DIESEL', pricePerLitre: 478.00, effectiveDate: '2026-09-01', notes: 'Super Diesel Tariff' },
  ];
  for (const t of tariffs) {
    const res = await reqJson('/api/fuel/prices', { method: 'POST', body: t });
    assert.equal(res.status, 200, `POST /api/fuel/prices failed: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.success, true);
  }

  // Audit log entry written cleanly
  const auditRow = get("SELECT * FROM audit_log WHERE entity = 'fuel_price' ORDER BY id DESC LIMIT 1");
  assert.ok(auditRow, 'Expected audit_log row written by audit.record');

  // Date-effective lookup queries
  const aug = await reqJson('/api/fuel/prices/lookup?fuelType=AUTO_DIESEL&date=2026-08-20');
  assert.equal(aug.status, 200);
  assert.equal(aug.body.pricePerLitreCents, 36000);
  assert.equal(aug.body.effectiveDate, '2026-08-01');

  const sep = await reqJson('/api/fuel/prices/lookup?fuelType=AUTO_DIESEL&date=2026-09-25');
  assert.equal(sep.status, 200);
  assert.equal(sep.body.pricePerLitreCents, 38200);
  assert.equal(sep.body.effectiveDate, '2026-09-01');

  const nov = await reqJson('/api/fuel/prices/lookup?fuelType=AUTO_DIESEL&date=2026-11-05');
  assert.equal(nov.status, 200);
  assert.equal(nov.body.pricePerLitreCents, 40550);
  assert.equal(nov.body.effectiveDate, '2026-10-15');

  const sup = await reqJson('/api/fuel/prices/lookup?fuelType=SUPER_DIESEL&date=2026-11-05');
  assert.equal(sup.status, 200);
  assert.equal(sup.body.pricePerLitreCents, 47800);

  // Prices list & stats reflect latest active prices
  const pricesRes = await reqJson('/api/fuel/prices');
  assert.equal(pricesRes.status, 200);
  assert.equal(pricesRes.body.activePrices.AUTO_DIESEL.pricePerLitreCents, 40550);
  assert.equal(pricesRes.body.activePrices.SUPER_DIESEL.pricePerLitreCents, 47800);

  const statsRes = await reqJson('/api/fuel/stats');
  assert.equal(statsRes.status, 200);
  assert.equal(statsRes.body.currentDieselCents, 40550);
  assert.equal(statsRes.body.currentDieselEffectiveDate, '2026-10-15');
});

let slipSepId;
let slipNovAutoId;
let slipNovManualId;

test('Fuel issue auto date tariff, manual slip override, void audit & rate correction', async () => {
  // Helper: raise an approved Transport Fuel Request first ("No Request, No Issue")
  // Raised by authorized requester/admin (fuel_operator only dispenses, cannot self-request)
  async function createApprovedReq(opts) {
    const r = await reqJson('/api/fuel/requests', {
      method: 'POST',
      cookie: adminCookie,
      body: opts,
    });
    assert.equal(r.status, 201, `Request failed: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.status, 'APPROVED');
    return r.body.id;
  }

  // 1. Issue on 2026-09-10 without explicit price -> picks Sep tariff (38200 = Rs 382.00/L)
  const reqSepId = await createApprovedReq({
    assetCode: 'EX-501',
    runningChartNo: 'RC-SEP-01',
    meterReading: 1020,
    approxKm: 20,
    tripTotalFuel: 50,
    sourceMode: 'TANK',
    targetTankId: 'tk-site-1',
    projectId: 20,
  });
  const sepIssue = await reqJson('/api/fuel/issues', {
    method: 'POST',
    cookie: fuelOpCookie,
    body: {
      fuelRequestId: reqSepId,
      assetCode: 'EX-501',
      litres: 50,
      fuelType: 'AUTO_DIESEL',
      issueDate: '2026-09-10 08:30:00',
      meterReading: 1020,
      meterType: 'HOURS',
      sourceTankId: 'tk-site-1',
      targetProjectId: 20,
    },
  });
  assert.equal(sepIssue.status, 201, `Issue 1 failed: ${JSON.stringify(sepIssue.body)}`);
  slipSepId = sepIssue.body.id;
  assert.equal(sepIssue.body.fuel_price_cents, 38200);
  assert.equal(sepIssue.body.total_cost_cents, 50 * 38200);

  // 2. Issue on 2026-11-05 without explicit price -> picks Oct-15 tariff (40550 = Rs 405.50/L)
  const reqNov1Id = await createApprovedReq({
    assetCode: 'EX-501',
    runningChartNo: 'RC-NOV-01',
    meterReading: 1045,
    approxKm: 25,
    tripTotalFuel: 40,
    sourceMode: 'TANK',
    targetTankId: 'tk-site-1',
    projectId: 20,
  });
  const novAutoIssue = await reqJson('/api/fuel/issues', {
    method: 'POST',
    cookie: fuelOpCookie,
    body: {
      fuelRequestId: reqNov1Id,
      assetCode: 'EX-501',
      litres: 40,
      fuelType: 'AUTO_DIESEL',
      issueDate: '2026-11-05 09:00:00',
      meterReading: 1045,
      meterType: 'HOURS',
      sourceTankId: 'tk-site-1',
      targetProjectId: 20,
    },
  });
  assert.equal(novAutoIssue.status, 201, `Issue 2 failed: ${JSON.stringify(novAutoIssue.body)}`);
  slipNovAutoId = novAutoIssue.body.id;
  assert.equal(novAutoIssue.body.fuel_price_cents, 40550);
  assert.equal(novAutoIssue.body.total_cost_cents, 40 * 40550);

  // 3. Issue on 2026-11-10 WITH explicit per-slip manual override (Rs 412.00 = 41200)
  const reqNov2Id = await createApprovedReq({
    assetCode: 'EX-501',
    runningChartNo: 'RC-NOV-02',
    meterReading: 1060,
    approxKm: 15,
    tripTotalFuel: 25,
    sourceMode: 'STATION',
    stationName: 'External Ceypetco Pump',
    projectId: 20,
  });
  const novManualIssue = await reqJson('/api/fuel/issues', {
    method: 'POST',
    cookie: fuelOpCookie,
    body: {
      fuelRequestId: reqNov2Id,
      assetCode: 'EX-501',
      litres: 25,
      fuelType: 'AUTO_DIESEL',
      fuelPriceCents: 41200,
      issueDate: '2026-11-10 14:15:00',
      meterReading: 1060,
      meterType: 'HOURS',
      stationName: 'External Ceypetco Pump',
      targetProjectId: 20,
    },
  });
  assert.equal(novManualIssue.status, 201, `Issue 3 failed: ${JSON.stringify(novManualIssue.body)}`);
  slipNovManualId = novManualIssue.body.id;
  assert.equal(novManualIssue.body.fuel_price_cents, 41200);
  assert.equal(novManualIssue.body.total_cost_cents, 25 * 41200);

  // 4. Publish a newer tariff (2026-11-16 -> Rs 420.00 = 42000) and verify existing slips retain historical rates!
  const newTariff = await reqJson('/api/fuel/prices', {
    method: 'POST',
    body: { fuelType: 'AUTO_DIESEL', pricePerLitre: 420.00, effectiveDate: '2026-11-16', notes: 'Nov 16 Revision' },
  });
  assert.equal(newTariff.status, 200);

  const listRes = await reqJson('/api/fuel/issues?assetCode=EX-501');
  assert.equal(listRes.status, 200);
  const byId = Object.fromEntries((listRes.body.rows || []).map((r) => [r.id, r]));
  assert.equal(byId[slipSepId].effective_price_cents, 38200);
  assert.equal(byId[slipNovAutoId].effective_price_cents, 40550);
  assert.equal(byId[slipNovManualId].effective_price_cents, 41200);

  // 5. Fuel Correction submitted by operator (PENDING), then approved via 4-eyes review updating litres (40 -> 50) & price (40550 -> 41500)
  const corrRes = await reqJson('/api/fuel/corrections', {
    method: 'POST',
    cookie: fuelOpCookie,
    body: {
      fuelIssueId: slipNovAutoId,
      correctionType: 'EDIT',
      newLitres: 50,
      newPricePerLitre: 415.00,
      newIssueDate: '2026-11-05',
      reason: 'Adjusted slip volume and Ceypetco rate on pump voucher',
      autoApprove: true,
    },
  });
  assert.equal(corrRes.status, 201, `Correction failed: ${JSON.stringify(corrRes.body)}`);
  assert.equal(corrRes.body.status, 'PENDING');

  const reviewRes = await reqJson(`/api/fuel/corrections/${corrRes.body.id}/review`, {
    method: 'POST',
    cookie: adminCookie,
    body: { action: 'APPROVE', reviewNote: 'Rate and litres verified against slip' },
  });
  assert.equal(reviewRes.status, 200, `Correction review failed: ${JSON.stringify(reviewRes.body)}`);
  assert.equal(reviewRes.body.status, 'APPROVED');

  const corrRow = get('SELECT before_price_cents, after_price_cents, after_litres FROM fuel_corrections WHERE id = ?', corrRes.body.id);
  assert.equal(corrRow.before_price_cents, 40550);
  assert.equal(corrRow.after_price_cents, 41500);
  assert.equal(corrRow.after_litres, 50);

  const updatedIssue = get('SELECT litres, fuel_price_cents, price_per_litre_cents, total_cost_cents, cost_cents FROM fuel_issues WHERE id = ?', slipNovAutoId);
  assert.equal(updatedIssue.litres, 50);
  assert.equal(updatedIssue.fuel_price_cents, 41500);
  assert.equal(updatedIssue.price_per_litre_cents, 41500);
  assert.equal(updatedIssue.total_cost_cents, 50 * 41500);
  assert.equal(updatedIssue.cost_cents, 50 * 41500);

  const finEv = get('SELECT amount_cents, quantity FROM fleet_financial_events WHERE event_key = ?', `FIN-FUEL-${slipNovAutoId}`);
  assert.equal(finEv.amount_cents, 50 * 41500);
  assert.equal(finEv.quantity, 50);

  // 6. Void September slip (tests audit.record fix in POST /issues/:id/void + stock restore)
  const tankBeforeVoid = get("SELECT current_litres FROM fuel_tanks WHERE id = 'tk-site-1'").current_litres;
  const voidRes = await reqJson(`/api/fuel/issues/${slipSepId}/void`, {
    method: 'POST',
    cookie: fuelOpCookie,
    body: { reason: 'Duplicate voucher entry test' },
  });
  assert.equal(voidRes.status, 200, `Void failed: ${JSON.stringify(voidRes.body)}`);
  const tankAfterVoid = get("SELECT current_litres FROM fuel_tanks WHERE id = 'tk-site-1'").current_litres;
  assert.equal(tankAfterVoid, tankBeforeVoid + 50);
});

test('Tank refuel delivery, dip audit & dynamic budget defaults (no audit.log 500 or 34100)', async () => {
  const beforeLitres = get("SELECT current_litres FROM fuel_tanks WHERE id = 'tk-site-1'").current_litres;

  const refuelRes = await reqJson('/api/fuel/site-console/refuel', {
    method: 'POST',
    cookie: fuelOpCookie,
    body: {
      tankId: 'tk-site-1',
      litresDelivered: 1000,
      pricePerLitreCents: 42000,
      supplierName: 'Ceypetco Bulk',
      invoiceNo: 'INV-GAL-900',
      deliveryDate: '2026-11-16',
    },
  });
  assert.equal(refuelRes.status, 201, `Site refuel failed: ${JSON.stringify(refuelRes.body)}`);
  assert.equal(refuelRes.body.new_balance, beforeLitres + 1000);

  const delivRow = get("SELECT litres, cost_cents FROM fuel_bulk_deliveries WHERE invoice_number = 'INV-GAL-900'");
  assert.ok(delivRow, 'Delivery record not found in fuel_bulk_deliveries');
  assert.equal(delivRow.litres, 1000);
  assert.equal(delivRow.cost_cents, 42000000);

  // Tank dip must succeed using audit.record without throwing audit.log TypeError
  const dipRes = await reqJson('/api/fuel/tanks/tk-site-1/dip', {
    method: 'POST',
    cookie: fuelOpCookie,
    body: { dipLitres: beforeLitres + 995, note: 'Physical dipstick calibration' },
  });
  assert.ok([200, 201].includes(dipRes.status), `Tank dip failed (${dipRes.status}): ${JSON.stringify(dipRes.body)}`);
  assert.equal(dipRes.body.variance_litres, -5);

  // Setting budget in Rs uses current active tariff (42000), NOT 34100
  const budgetRes = await reqJson('/api/fuel/budgets', {
    method: 'POST',
    cookie: adminCookie,
    body: { projectId: 20, year: 2026, month: 11, budgetLitres: 2000 },
  });
  assert.equal(budgetRes.status, 200, `Budget post failed: ${JSON.stringify(budgetRes.body)}`);
  const bRow = get('SELECT budget_amount_cents FROM site_fuel_budgets WHERE project_id = 20 AND year = 2026 AND month = 11');
  assert.equal(bRow.budget_amount_cents, 2000 * 42000);
});

test('Hire Billing (prefill, site-preview, generate, revise, sync-to-costing) uses dynamic fuel rates', async () => {
  // Set WET hire rate cards & allocate EX-501 and LD-502 for 2026-11
  for (const [assetId, code] of [[501, 'EX-501'], [502, 'LD-502']]) {
    const rSave = await reqJson('/api/hire/rates', {
      method: 'POST',
      cookie: fuelOpCookie,
      body: {
        assetId,
        rateBasis: 'HOURLY',
        defaultBasis: 'WET',
        dryRateCents: 600000,
        wetRateCents: 850000,
        fullyWetRateCents: 990000,
        minBillHours: 160,
        note: `Rate for ${code}`,
      },
    });
    assert.equal(rSave.status, 201);

    const aSave = await reqJson('/api/hire/allocations', {
      method: 'POST',
      cookie: fuelOpCookie,
      body: {
        assetId,
        projectId: 20,
        assignedBasis: 'WET',
        dateFrom: '2026-11-01',
        dateTo: '2026-11-30',
        isCurrent: false,
      },
    });
    assert.equal(aSave.status, 201);
  }

  // 1. Prefill on EX-501 in 2026-11 has 2 non-voided slips: 50L@41500 + 25L@41200 -> weighted 41400 cents/L!
  const prefill501 = await reqJson('/api/hire/bills/prefill?assetCode=EX-501&year=2026&month=11&projectId=20');
  assert.equal(prefill501.status, 200);
  assert.equal(prefill501.body.fuelLitres, 75);
  assert.equal(prefill501.body.fuelPriceCents, 41400);

  // 2. Prefill on LD-502 in 2026-11 (zero slips) falls back to Nov active diesel tariff (42000), NOT 34100!
  const prefill502 = await reqJson('/api/hire/bills/prefill?assetCode=LD-502&year=2026&month=11&projectId=20');
  assert.equal(prefill502.status, 200);
  assert.equal(prefill502.body.fuelPriceCents, 42000);

  // 3. Site-preview reflects dynamic fuelPriceCents for each machine
  const preview = await reqJson('/api/hire/bills/site-preview?projectId=20&month=2026-11');
  assert.equal(preview.status, 200);
  const p501 = preview.body.items.find((i) => i.assetCode === 'EX-501');
  const p502 = preview.body.items.find((i) => i.assetCode === 'LD-502');
  assert.equal(p501.fuelPriceCents, 41400);
  assert.equal(p502.fuelPriceCents, 42000);

  // 4. Generate bill for EX-501 without explicit fuelPriceCents -> picks weighted 41400 cents/L!
  const gen501 = await reqJson('/api/hire/bills/generate', {
    method: 'POST',
    cookie: fuelOpCookie,
    body: {
      assetCode: 'EX-501',
      year: 2026,
      month: 11,
      projectId: 20,
      billingMode: 'WET',
      rateBasis: 'HOURLY',
      rateCents: 850000,
      actualUnits: 180,
      fuelLitres: 75,
    },
  });
  assert.equal(gen501.status, 201, `Bill generate failed: ${JSON.stringify(gen501.body)}`);
  assert.equal(gen501.body.calculation.fuelChargedCents, 75 * 41400);

  const listBills = await reqJson('/api/hire/bills?periodKey=2026-11&assetCode=EX-501');
  assert.equal(listBills.status, 200);
  assert.equal(listBills.body.bills[0].fuel_price_cents, 41400);

  // 5. Revise bill with new fuelRate (Rs 435.00 = 43500 cents/L) & litres (80 L) -> syncs line items & GET /bills!
  const billId = gen501.body.id;
  const revRes = await reqJson(`/api/hire/bills/${billId}/revise`, {
    method: 'POST',
    cookie: fuelOpCookie,
    body: {
      actualUnits: 180,
      rateCents: 850000,
      fuelLitres: 80,
      fuelPriceCents: 43500,
      reason: 'Amended fuel voucher rate to Rs 435/L',
    },
  });
  assert.equal(revRes.status, 200, `Bill revise failed: ${JSON.stringify(revRes.body)}`);
  assert.equal(revRes.body.fuelPriceCents, 43500);
  assert.equal(revRes.body.calculation.fuelChargedCents, 80 * 43500);

  const lineFuel = get("SELECT unit_price_cents, quantity, amount_cents FROM fleet_bill_line_items WHERE bill_id = ? AND item_type = 'FUEL'", billId);
  assert.equal(lineFuel.unit_price_cents, 43500);
  assert.equal(lineFuel.quantity, 80);
  assert.equal(lineFuel.amount_cents, 80 * 43500);

  const listAfterRev = await reqJson('/api/hire/bills?periodKey=2026-11&assetCode=EX-501');
  assert.equal(listAfterRev.body.bills[0].fuel_price_cents, 43500);

  // 6. Auto sync-to-costing generates LD-502 bill using Nov tariff (42000), not 34100
  run(`
    INSERT INTO fuel_issues (id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, litres, fuel_price_cents, price_per_litre_cents, total_cost_cents, issue_date, target_project_id, is_voided)
    VALUES ('fi-502-nov', 'FI-502', 502, 'LD-502', 'WP-LD-502', 'AUTO_DIESEL', 100, 42000, 42000, 4200000, '2026-11-18 10:00:00', 20, 0)
  `);
  const syncRes = await reqJson('/api/hire/sync-to-costing', {
    method: 'POST',
    cookie: fuelOpCookie,
    body: { month: '2026-11', projectId: 20 },
  });
  assert.equal(syncRes.status, 200);
  const bill502 = get("SELECT * FROM fleet_bills WHERE asset_code = 'LD-502' AND period_key = '2026-11'");
  assert.ok(bill502, 'Expected sync-to-costing to generate bill for LD-502');
  assert.equal(bill502.fuel_cost_cents, 100 * 42000);
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try { rawDb.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
