'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-hire-billing-'));
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
let operatorCookie;

function currentYm() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

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
  assert.equal(res.status, 200, `Expected login 200 for ${username}, got ${res.status}: ${JSON.stringify(res.body)}`);
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, `Missing set-cookie for ${username}`);
  return setCookie.split(';')[0];
}

test('Setup fresh database with Migration 059 & test fixtures', async () => {
  migrate();
  capabilities.seedCapabilities();

  // Check Migration 059 tables/columns
  assert.ok(get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fleet_breakdowns'"), 'fleet_breakdowns table missing');
  assert.ok(get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fleet_bill_payments'"), 'fleet_bill_payments table missing');
  const allocCols = all('PRAGMA table_info(fleet_vehicle_allocations)').map((c) => c.name);
  for (const col of ['month_from', 'month_to', 'date_from', 'date_to', 'is_current', 'driver_name', 'notes']) {
    assert.ok(allocCols.includes(col), `fleet_vehicle_allocations missing ${col}`);
  }
  const assignDdl = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='fleet_asset_assignments'");
  assert.match(assignDdl.sql, /DRY_WITH_DRIVER/, 'fleet_asset_assignments CHECK should allow DRY_WITH_DRIVER');

  // Seed workshops (Central + Kandy site workshop)
  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop', 'Peliyagoda', 1, 1)");
  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (2, 'KDY', 'Kandy Site Workshop', 'Kandy', 0, 1)");

  // Seed projects
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (10, 'PRJ-PC', 'Port City Project', 'port city project', 1)");
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (11, 'PRJ-CH', 'Central Highway', 'central highway', 1)");

  // Seed assets
  run(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, model_no, asset_class, home_project_id, current_project_id, status, in_register, created_at, updated_at)
    VALUES
      (101, 'EX-101', 'EX101', 'WP-EX-101', 'KOBELCO', 'Excavator', 'SK200', 'vehicle', 10, 10, 'active', 1, datetime('now'), datetime('now')),
      (102, 'EX-102', 'EX102', 'WP-EX-102', 'CAT', 'Excavator', '320D', 'vehicle', 11, 11, 'active', 1, datetime('now'), datetime('now')),
      (103, 'DT-201', 'DT201', 'WP-LI-201', 'ISUZU', 'Dump Truck', 'GIGA', 'vehicle', 10, 10, 'active', 1, datetime('now'), datetime('now'))
  `);

  // Seed roles + users (admin + hire_operator without hire.breakdowns.adjust)
  run("INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('admin', 'Administrator', 1, 1)");
  const adminRole = get("SELECT id FROM roles WHERE name = 'admin'");
  run("INSERT INTO roles (id, name, label, is_system, active) VALUES (50, 'hire_operator', 'Hire Operator', 0, 1)");
  for (const cap of [
    'hire.billing.view', 'hire.billing.generate', 'hire.billing.finalise',
    'hire.rates.view', 'hire.rates.manage',
    'allocations.view', 'allocations.manage',
    'fuel.view', 'jobs.view', 'costing.manage',
  ]) {
    run("INSERT OR REPLACE INTO role_capabilities (role, capability, granted) VALUES ('hire_operator', ?, 1)", cap);
  }
  run("INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES ('hire_operator', 'hire', 'full')");

  const pwHash = auth.hashPassword('TestPass#2026!');
  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password) VALUES (1, 'admin_test', ?, 'Admin User', 1, 0)", pwHash);
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', 1, adminRole.id);
  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password) VALUES (2, 'hire_op', ?, 'Hire Operator', 1, 0)", pwHash);
  run('INSERT INTO user_roles (user_id, role_id) VALUES (2, 50)');

  // Seed historical vs live multi-site job records + JR description for breakdown reason test
  const ym = currentYm();
  run(`
    INSERT INTO job_requests (id, jr_no, req_date, asset_id, project_id, workshop_id, type, severity, priority, description, approval_status, requested_by)
    VALUES
      (201, 'JR-KDY-201', ?, 101, 11, 2, 'repair', 'major', 'breakdown', 'Hydraulic boom hose burst at Kandy site', 'approved', 1),
      (202, 'JR-PC-202', ?, 102, 10, 1, 'repair', 'major', 'urgent', 'Alternator failure reported by operator', 'approved', 1)
  `, `${ym}-03`, `${ym}-06`);

  run(`
    INSERT INTO job_cards (id, job_no, asset_id, project_id, workshop_id, type, severity, status, breakdown, field, reported_at, description, job_request_id, requested_by, is_historical)
    VALUES (
      301, 'KDY/2026/001', 101, 11, 2, 'repair', 'major', 'IN_PROGRESS', 1, 1, ?,
      'Boom hose burst\n\nWorkshop note: internal mechanics assigned', 201, 1, 0
    )
  `, `${ym}-03`);

  // Historical repair job card should NOT appear in monitoring or block billing
  run(`
    INSERT INTO job_cards (id, job_no, asset_id, project_id, workshop_id, type, severity, status, breakdown, reported_at, description, requested_by, is_historical)
    VALUES (302, 'HIST/2020/001', 103, 10, 1, 'repair', 'minor', 'REQUESTED', 1, '2020-01-01', 'Legacy unclosed', 1, 1)
  `);

  // Seed fuel issues on EX-101 in current month to test rate card measured consumption & sync-to-costing
  run(`
    INSERT INTO fuel_issues (id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, litres, fuel_price_cents, total_cost_cents, meter_reading, meter_type, issue_date, target_project_id, source_project_id, is_voided)
    VALUES
      ('fi-1', 'FI-001', 101, 'EX-101', 'WP-EX-101', 'DIESEL', 200, 34100, 6820000, 1000, 'HOURS', ?, 11, 11, 0),
      ('fi-2', 'FI-002', 101, 'EX-101', 'WP-EX-101', 'DIESEL', 250, 34100, 8525000, 1030, 'HOURS', ?, 11, 11, 0)
  `, `${ym}-02`, `${ym}-12`);

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });

  adminCookie = await loginAs('admin_test', 'TestPass#2026!');
  operatorCookie = await loginAs('hire_op', 'TestPass#2026!');
});

test('Site Allocator Console: DRY_WITH_DRIVER, Month From-To/Current, Asset & Project lookup', async () => {
  const curYm = currentYm();
  // Asset picker + Project dropdown sources work cleanly
  const assetsRes = await reqJson('/api/assets/search?q=EX-101');
  assert.equal(assetsRes.status, 200);
  assert.ok(JSON.stringify(assetsRes.body).includes('EX-101'));

  const projRes = await reqJson('/api/projects');
  assert.equal(projRes.status, 200);
  assert.ok(JSON.stringify(projRes.body).includes('Central Highway'));

  // Initial list must not throw SQLite errors (previously va.vehicle_type)
  const list0 = await reqJson('/api/hire/allocations');
  assert.equal(list0.status, 200);
  assert.equal(list0.body.currentMonth, curYm);

  // Allocate EX-101 on DRY_WITH_DRIVER from current month for 2 months as Current/Ongoing
  const [y, m] = curYm.split('-').map(Number);
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const nextYm = `${nextY}-${String(nextM).padStart(2, '0')}`;

  const createRes = await reqJson('/api/hire/allocations', {
    method: 'POST',
    cookie: operatorCookie,
    body: {
      assetId: 101,
      projectId: 11,
      assignedBasis: 'DRY_WITH_DRIVER',
      monthFrom: curYm,
      monthTo: nextYm,
      isCurrent: true,
      driverName: 'Kamal Perera',
      notes: 'Excavation Package A',
    },
  });
  assert.equal(createRes.status, 201, `Allocation create failed: ${JSON.stringify(createRes.body)}`);
  assert.equal(createRes.body.monthsCount, 2);
  assert.equal(createRes.body.assignedBasis, 'DRY_WITH_DRIVER');
  assert.equal(createRes.body.isCurrent, true);

  // Verify asset current_project_id & fleet_asset_assignments updated cleanly
  const updatedAsset = get('SELECT current_project_id FROM assets WHERE id = 101');
  assert.equal(updatedAsset.current_project_id, 11);
  const assignRow = get("SELECT billing_type, driver_name FROM fleet_asset_assignments WHERE asset_id = 101 AND end_date IS NULL ORDER BY id DESC LIMIT 1");
  assert.equal(assignRow.billing_type, 'DRY_WITH_DRIVER');
  assert.equal(assignRow.driver_name, 'Kamal Perera');

  // Filter current allocations
  const list1 = await reqJson(`/api/hire/allocations?currentOnly=1&basis=DRY_WITH_DRIVER&monthFrom=${curYm}`);
  assert.equal(list1.status, 200);
  assert.ok(list1.body.allocations.some((r) => r.asset_code === 'EX-101' && r.assigned_basis === 'DRY_WITH_DRIVER' && r.project_name === 'Central Highway'));

  // End allocation via PATCH
  const allocId = createRes.body.id;
  const patchRes = await reqJson(`/api/hire/allocations/${allocId}`, {
    method: 'PATCH',
    cookie: operatorCookie,
    body: { action: 'end' },
  });
  assert.equal(patchRes.status, 200);
  const endedAssign = get('SELECT end_date FROM fleet_asset_assignments WHERE asset_id = 101 ORDER BY start_date DESC LIMIT 1');
  assert.ok(endedAssign.end_date, 'Expected assignment end_date to be stamped when allocation ended');

  // Exact Date/Month/Year allocation (dateFrom / dateTo) & range validation
  const badRange = await reqJson('/api/hire/allocations', {
    method: 'POST',
    cookie: operatorCookie,
    body: {
      assetId: 103,
      projectId: 11,
      assignedBasis: 'DRY_WITH_DRIVER',
      dateFrom: `${curYm}-20`,
      dateTo: `${curYm}-05`,
      isCurrent: false,
    },
  });
  assert.equal(badRange.status, 400);

  const exactRes = await reqJson('/api/hire/allocations', {
    method: 'POST',
    cookie: operatorCookie,
    body: {
      assetId: 103,
      projectId: 11,
      assignedBasis: 'DRY_WITH_DRIVER',
      dateFrom: `${curYm}-05`,
      dateTo: `${curYm}-20`,
      isCurrent: false,
      driverName: 'Sunil Silva',
      notes: '16-day fixed haulage',
    },
  });
  assert.equal(exactRes.status, 201);
  assert.equal(exactRes.body.dateFrom, `${curYm}-05`);
  assert.equal(exactRes.body.dateTo, `${curYm}-20`);
  assert.equal(exactRes.body.isCurrent, false);

  const overlapHit = await reqJson(`/api/hire/allocations?assetCode=DT-201&dateFrom=${curYm}-10&dateTo=${curYm}-12`);
  assert.equal(overlapHit.status, 200);
  assert.ok(overlapHit.body.allocations.some((r) => r.asset_code === 'DT-201' && r.date_from === `${curYm}-05` && r.date_to === `${curYm}-20`));

  const outsideHit = await reqJson(`/api/hire/allocations?assetCode=DT-201&dateFrom=${curYm}-22&dateTo=${curYm}-25`);
  assert.equal(outsideHit.status, 200);
  assert.equal(outsideHit.body.allocations.some((r) => r.asset_code === 'DT-201'), false);
});

test('Rate Cards & Consumption Bands: DRY_WITH_DRIVER, L/hr display & verdict', async () => {
  const emptyRes = await reqJson('/api/hire/rates-overview');
  assert.equal(emptyRes.status, 200);

  const saveFleetRate = await reqJson('/api/hire/rates', {
    method: 'POST',
    cookie: operatorCookie,
    body: {
      assetId: 101,
      rateBasis: 'HOURLY',
      defaultBasis: 'DRY_WITH_DRIVER',
      dryRateCents: 650000, // Rs 6,500/hr
      wetRateCents: 980000,
      fullyWetRateCents: 1120000,
      minBillHours: 160,
      econDisplay: 12,
      typDisplay: 16,
      heavyDisplay: 22,
      fuelConsBasis: 'hr',
      note: 'Kobelco standard site rate',
    },
  });
  assert.equal(saveFleetRate.status, 201);

  const savePortable = await reqJson('/api/hire/rates', {
    method: 'POST',
    cookie: operatorCookie,
    body: {
      equipType: 'PORTABLE',
      categoryName: 'Concrete Poker Vibrator',
      rateBasis: 'DAILY',
      portDdCents: 450000,
      portDwCents: 620000,
      sourceLabel: 'Internal Rate Book 2026',
    },
  });
  assert.equal(savePortable.status, 201);

  const overview = await reqJson('/api/hire/rates-overview?search=EX-101');
  assert.equal(overview.status, 200);
  assert.equal(overview.body.fleet.length, 1);
  const rc = overview.body.fleet[0];
  assert.equal(rc.asset_code, 'EX-101');
  assert.equal(rc.default_basis, 'DRY_WITH_DRIVER');
  assert.equal(rc.dry_rate_cents, 650000);
  assert.equal(rc.fully_wet_rate_cents, 1120000);
  assert.equal(rc.econ_display, 12);
  assert.equal(rc.typ_display, 16);
  assert.equal(rc.heavy_display, 22);
  // Fuel issues: 450L / 30hr = 15 L/hr -> matches typ/normal band
  assert.equal(rc.measured_display, 15);
  assert.equal(rc.verdict, 'NORMAL', 'Expected NORMAL consumption band verdict');
  assert.ok(overview.body.portable.some((p) => p.category_name === 'Concrete Poker Vibrator'));
});

test('Breakdowns Monitoring across all sites, Admin date adjustment & Billing block/deduction', async () => {
  const curYm = currentYm();
  const bdRes = await reqJson('/api/hire/breakdowns');
  assert.equal(bdRes.status, 200);
  const rows = bdRes.body.breakdowns;
  assert.ok(rows.length >= 2, `Expected at least 2 multi-site breakdowns, got ${rows.length}`);

  const jcBd = rows.find((r) => r.job_no === 'KDY/2026/001');
  const jrBd = rows.find((r) => r.jr_no === 'JR-PC-202');
  assert.ok(jcBd, 'Expected repair job card across other workshop (Kandy) to appear');
  assert.ok(jrBd, 'Expected unlinked repair job request to appear');
  assert.equal(rows.some((r) => r.job_no === 'HIST/2020/001'), false, 'Historical job card must not appear');
  assert.equal(jcBd.reason, 'Hydraulic boom hose burst at Kandy site', 'Breakdown reason must prefer JR description');
  assert.equal(jcBd.is_open, true);

  // Prefill shows billingBlocked while breakdown is open
  const [y, m] = curYm.split('-').map(Number);
  const prefillBlocked = await reqJson(`/api/hire/bills/prefill?assetCode=EX-101&year=${y}&month=${m}`);
  assert.equal(prefillBlocked.status, 200);
  assert.equal(prefillBlocked.body.billingBlocked, true);
  assert.match(prefillBlocked.body.blockReason, /Cannot bill EX-101/i);

  // Attempting to generate bill for EX-101 while breakdown is open -> 409 Conflict
  const genBlocked = await reqJson('/api/hire/bills/generate', {
    method: 'POST',
    cookie: operatorCookie,
    body: {
      assetCode: 'EX-101',
      year: y,
      month: m,
      actualUnits: 180,
      rateCents: 650000,
      rateBasis: 'HOURLY',
      billingMode: 'DRY_WITH_DRIVER',
    },
  });
  assert.equal(genBlocked.status, 409);
  assert.equal(genBlocked.body.billingBlocked, true);

  // Auto-sync to costing skips open breakdown machines instead of billing them
  const syncBlocked = await reqJson('/api/hire/sync-to-costing', {
    method: 'POST',
    cookie: operatorCookie,
    body: { month: curYm },
  });
  assert.equal(syncBlocked.status, 200);
  assert.ok(syncBlocked.body.skippedBreakdowns.some((s) => s.assetCode === 'EX-101'));

  // Non-admin cannot adjust breakdown dates -> 403
  const forbiddenAdj = await reqJson(`/api/hire/breakdowns/${encodeURIComponent(jcBd.id)}`, {
    method: 'PATCH',
    cookie: operatorCookie,
    body: { breakdownStart: `${curYm}-05`, breakdownEnd: `${curYm}-09`, status: 'CLOSED' },
  });
  assert.equal(forbiddenAdj.status, 403);

  // Admin adjusts Start & Close dates -> 200, persists dates + orig dates + audit log
  const adjRes = await reqJson(`/api/hire/breakdowns/${encodeURIComponent(jcBd.id)}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: {
      breakdownStart: `${curYm}-05`,
      breakdownEnd: `${curYm}-09`,
      status: 'CLOSED',
      adjustmentNote: 'Verified site logbook handover timestamps',
    },
  });
  assert.equal(adjRes.status, 200);
  assert.equal(adjRes.body.breakdown.status, 'CLOSED');
  assert.equal(adjRes.body.breakdown.breakdown_start, `${curYm}-05`);
  assert.equal(adjRes.body.breakdown.breakdown_end, `${curYm}-09`);
  assert.equal(adjRes.body.breakdown.orig_start_date, `${curYm}-03`);
  assert.equal(adjRes.body.breakdown.total_days, 5);
  assert.equal(adjRes.body.breakdown.admin_adjusted, true);

  const auditRow = get("SELECT action, entity_id FROM audit_log WHERE action = 'hire.breakdown.adjusted' ORDER BY id DESC LIMIT 1");
  assert.ok(auditRow, 'Expected audit_log record for admin breakdown adjustment');

  // Now breakdown is closed (5 days down) -> bill generation succeeds on DRY_WITH_DRIVER with breakdown deduction & zero fuel recharge
  const genOk = await reqJson('/api/hire/bills/generate', {
    method: 'POST',
    cookie: operatorCookie,
    body: {
      assetCode: 'EX-101',
      year: y,
      month: m,
      actualUnits: 180,
      minBillHours: 160,
      rateCents: 650000,
      rateBasis: 'HOURLY',
      billingMode: 'DRY_WITH_DRIVER',
      fuelLitres: 450,
    },
  });
  assert.equal(genOk.status, 201, `Expected bill generate 201, got ${genOk.status}: ${JSON.stringify(genOk.body)}`);
  assert.equal(genOk.body.calculation.fuelChargedCents, 0, 'DRY_WITH_DRIVER must not recharge client fuel');
  assert.equal(genOk.body.calculation.breakdownDays, 5);
  assert.ok(genOk.body.calculation.breakdownDeductCents > 0, 'Expected real breakdown deduction cents > 0');

  const lineItems = all('SELECT item_type, is_deduction, amount_cents FROM fleet_bill_line_items WHERE bill_id = ?', genOk.body.id);
  assert.ok(lineItems.some((li) => li.item_type === 'BREAKDOWN_DEDUCT' && li.is_deduction === 1 && li.amount_cents > 0));

  // Revise bill (should insert into fleet_bill_revisions cleanly)
  const revRes = await reqJson(`/api/hire/bills/${genOk.body.id}/revise`, {
    method: 'POST',
    cookie: operatorCookie,
    body: { actualUnits: 190, reason: 'Client signed extra 10 hours' },
  });
  assert.equal(revRes.status, 200);
  assert.equal(revRes.body.revisionNumber, 1);

  // Finalise bill (should post REVENUE_RENTAL into fleet_financial_events)
  const finRes = await reqJson(`/api/hire/bills/${genOk.body.id}/finalise`, {
    method: 'POST',
    cookie: operatorCookie,
    body: {},
  });
  assert.equal(finRes.status, 200);
  assert.equal(finRes.body.status, 'FINAL');
  const finEvt = get("SELECT event_type, amount_cents FROM fleet_financial_events WHERE source_id = ? AND event_type = 'REVENUE_RENTAL'", genOk.body.id);
  assert.ok(finEvt && finEvt.amount_cents > 0);

  // Record payment + Aging report
  const payRes = await reqJson(`/api/hire/bills/${genOk.body.id}/payments`, {
    method: 'POST',
    cookie: operatorCookie,
    body: { amountLkr: 50000, method: 'BANK_TRANSFER', reference: 'REF-101' },
  });
  assert.equal(payRes.status, 201);
  const agingRes = await reqJson('/api/hire/aging');
  assert.equal(agingRes.status, 200);
  assert.ok(agingRes.body.items.some((i) => i.id === genOk.body.id));
});

test('Site & Monthly Billing: site-preview, generate-site, summaryBySiteMonth & sync-to-costing', async () => {
  const curYm = currentYm();
  const [y, m] = curYm.split('-').map(Number);
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const nextYm = `${nextY}-${String(nextM).padStart(2, '0')}`;

  // Rate card for DT-201 (DRY_WITH_DRIVER, DAILY) and EX-102 (at Project 10, currently OPEN breakdown JR-PC-202)
  await reqJson('/api/hire/rates', {
    method: 'POST',
    cookie: operatorCookie,
    body: {
      assetId: 103,
      rateBasis: 'DAILY',
      defaultBasis: 'DRY_WITH_DRIVER',
      dryRateCents: 1800000, // Rs 18,000/day
    },
  });
  await reqJson('/api/hire/rates', {
    method: 'POST',
    cookie: operatorCookie,
    body: {
      assetId: 102,
      rateBasis: 'HOURLY',
      defaultBasis: 'DRY_WITH_DRIVER',
      dryRateCents: 700000,
      minBillHours: 100,
    },
  });

  // Allocate EX-102 to Project 10 for current month (has open JR-PC-202 -> must be blocked!)
  await reqJson('/api/hire/allocations', {
    method: 'POST',
    cookie: operatorCookie,
    body: {
      assetId: 102,
      projectId: 10,
      assignedBasis: 'DRY_WITH_DRIVER',
      dateFrom: `${curYm}-01`,
      dateTo: `${curYm}-28`,
      isCurrent: false,
    },
  });

  // Preview Project 11: DT-201 (16-day date allocation, zero fuel issues) should be eligible & computed
  const prev11 = await reqJson(`/api/hire/bills/site-preview?projectId=11&month=${curYm}`);
  assert.equal(prev11.status, 200);
  const dtItem = prev11.body.items.find((it) => it.assetCode === 'DT-201');
  assert.ok(dtItem, 'Expected DT-201 in site-preview for Project 11');
  assert.equal(dtItem.siteOverlapDays, 16);
  assert.equal(dtItem.actualUnits, 16);
  assert.equal(dtItem.billingMode, 'DRY_WITH_DRIVER');
  assert.equal(dtItem.eligible, true);
  assert.equal(dtItem.calculation.rentalAmountCents, 16 * 1800000);
  assert.equal(dtItem.calculation.fuelChargedCents, 0);

  // Preview Project 10: EX-102 is blocked by open breakdown JR-PC-202
  const prev10 = await reqJson(`/api/hire/bills/site-preview?projectId=10&month=${curYm}`);
  assert.equal(prev10.status, 200);
  const ex102Item = prev10.body.items.find((it) => it.assetCode === 'EX-102');
  assert.ok(ex102Item && ex102Item.billingBlocked === true && ex102Item.eligible === false);

  // Generate site bills for Project 11 -> creates DT-201 bill tagged to Central Highway
  const genSite11 = await reqJson('/api/hire/bills/generate-site', {
    method: 'POST',
    cookie: operatorCookie,
    body: { projectId: 11, month: curYm },
  });
  assert.equal(genSite11.status, 201);
  assert.equal(genSite11.body.generatedBills, 1);
  assert.equal(genSite11.body.bills[0].assetCode, 'DT-201');

  // Generate site bills for Project 10 -> skips EX-102 due to open breakdown
  const genSite10 = await reqJson('/api/hire/bills/generate-site', {
    method: 'POST',
    cookie: operatorCookie,
    body: { projectId: 10, month: curYm },
  });
  assert.equal(genSite10.status, 201);
  assert.equal(genSite10.body.generatedBills, 0);
  assert.ok(genSite10.body.skippedBreakdowns.some((s) => s.assetCode === 'EX-102'));

  // Site-filtered bills query returns summaryBySiteMonth + overallSummary
  const bills11 = await reqJson(`/api/hire/bills?projectId=11&periodKey=${curYm}`);
  assert.equal(bills11.status, 200);
  assert.ok(bills11.body.bills.some((b) => b.asset_code === 'DT-201' && b.project_id === 11));
  const sm11 = bills11.body.summaryBySiteMonth.find((s) => s.project_id === 11 && s.period_key === curYm);
  assert.ok(sm11 && sm11.bill_count >= 2 && bills11.body.overallSummary.grandTotalCents > 0);

  // Allocate DT-201 for next month with 0 fuel issues -> sync-to-costing for Site 11 still bills DRY_WITH_DRIVER!
  await reqJson('/api/hire/allocations', {
    method: 'POST',
    cookie: operatorCookie,
    body: {
      assetId: 103,
      projectId: 11,
      assignedBasis: 'DRY_WITH_DRIVER',
      dateFrom: `${nextYm}-01`,
      dateTo: `${nextYm}-10`,
      isCurrent: false,
    },
  });
  const syncNext = await reqJson('/api/hire/sync-to-costing', {
    method: 'POST',
    cookie: operatorCookie,
    body: { month: nextYm, projectId: 11 },
  });
  assert.equal(syncNext.status, 200);
  assert.ok(syncNext.body.generatedBills >= 1);
});

test('Rate Cards separation: L/hr takes Hourly Rate, km/L takes Per-KM Rate, Migration 061 keeps Boom Truck on L/hr', async () => {
  const { runMigration } = require('../src/migrate/061_rate_cards_unit_separation');

  // Seed a Double Cab wrongly imported as HOURLY, a Boom Truck with null fuel_cons_basis, and an Excavator
  run(`
    INSERT INTO assets (id, code, code_norm, registration, type, asset_class, status, in_register)
    VALUES
      (104, 'DC-99', 'DC99', 'WP-DC-99', 'Double Cab', 'vehicle', 'active', 1),
      (105, 'BM-02', 'BM02', 'WP-BM-02', 'Boom truck', 'vehicle', 'active', 1),
      (106, 'HEX-88', 'HEX88', 'WP-EX-88', 'Excavator', 'plant', 'active', 1)
  `);
  run(`
    INSERT INTO fleet_rental_rates (id, asset_id, category_name, rate_basis, rate_cents, dry_rate_cents, wet_rate_cents, fully_wet_rate_cents, equip_type, default_basis, fuel_cons_basis, fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy)
    VALUES
      ('r-dc99', 104, 'Double Cab (Pickup)', 'HOURLY', 87000, 87000, 161000, 161000, 'FLEET', 'DRY', 'km', 0.08, 0.1, 0.125),
      ('r-bm02', 105, 'Boom Truck', 'HOURLY', 180000, 180000, 260000, 340000, 'FLEET', 'DRY', NULL, 6, 8, 11),
      ('r-hex88', 106, 'Excavator', 'HOURLY', 300000, 300000, 380000, 666000, 'FLEET', 'DRY', NULL, 10, 14, 18)
  `);

  const mRes = runMigration(rawDb);
  assert.ok(mRes.updatedKm >= 1 && mRes.updatedHr >= 2);

  const dcRow = get('SELECT * FROM fleet_rental_rates WHERE id = ?', 'r-dc99');
  assert.equal(dcRow.rate_basis, 'KM', 'Double Cab (km/L) must switch from HOURLY to KM');
  assert.equal(dcRow.fuel_cons_basis, 'km');
  assert.equal(dcRow.dry_rate_cents, 4500, 'Double Cab must use Per-KM dry rate (Rs 45/km)');
  assert.equal(dcRow.wet_rate_cents, 7000);
  assert.equal(dcRow.fully_wet_rate_cents, 11000);
  assert.equal(dcRow.hr_dry_cents, 87000, 'Historical hourly rate preserved in hr_dry_cents');
  assert.equal(dcRow.km_dry_cents, 4500);

  const bmRow = get('SELECT * FROM fleet_rental_rates WHERE id = ?', 'r-bm02');
  assert.equal(bmRow.rate_basis, 'HOURLY', 'Boom Truck must stay HOURLY (not misclassified as KM)');
  assert.equal(bmRow.fuel_cons_basis, 'hr');
  assert.equal(bmRow.dry_rate_cents, 180000);

  const hexRow = get('SELECT * FROM fleet_rental_rates WHERE id = ?', 'r-hex88');
  assert.equal(hexRow.rate_basis, 'HOURLY');
  assert.equal(hexRow.fuel_cons_basis, 'hr');

  // Verify GET /api/hire/rates-overview splits machinery_hr vs vehicles_km cleanly
  const ov = await reqJson('/api/hire/rates-overview');
  assert.equal(ov.status, 200);
  assert.ok(ov.body.machinery_hr.some((r) => r.asset_code === 'EX-101' && r.display_unit === 'L/hr' && r.rate_unit_label === 'Rs/hr'));
  assert.ok(ov.body.machinery_hr.some((r) => r.asset_code === 'BM-02' && r.rate_basis === 'HOURLY'));
  assert.ok(ov.body.vehicles_km.some((r) => r.asset_code === 'DC-99' && r.display_unit === 'km/L' && r.rate_unit_label === 'Rs/km'));
  assert.equal(ov.body.machinery_hr.some((r) => r.asset_code === 'DC-99'), false);
  assert.equal(ov.body.vehicles_km.some((r) => r.asset_code === 'BM-02'), false);
  assert.ok(ov.body.summary.vehiclesKmCount >= 1 && ov.body.summary.machineryHrCount >= 3);

  // Verify saving a road vehicle with fuelConsBasis='km' via POST /rates enforces Per-KM unit syncing & prefill returns Rs/km
  const saveKmRes = await reqJson('/api/hire/rates', {
    method: 'POST',
    cookie: operatorCookie,
    body: {
      assetId: 103, // DT-201
      defaultBasis: 'DRY_WITH_DRIVER',
      rateBasis: 'KM',
      fuelConsBasis: 'km',
      dryRateCents: 9500,
      wetRateCents: 12000,
      fullyWetRateCents: 23000,
      econDisplay: 3.5,
      typDisplay: 2.8,
      heavyDisplay: 2.0,
    },
  });
  assert.equal(saveKmRes.status, 201);
  assert.equal(saveKmRes.body.rateBasis, 'KM');
  assert.equal(saveKmRes.body.fuelConsBasis, 'km');

  const dtOv = await reqJson('/api/hire/rates-overview?consBasis=km&search=DT-201');
  assert.equal(dtOv.status, 200);
  assert.equal(dtOv.body.vehicles_km.length, 1);
  assert.equal(dtOv.body.vehicles_km[0].dry_rate_cents, 9500);
  assert.equal(dtOv.body.vehicles_km[0].display_unit, 'km/L');
  assert.equal(dtOv.body.vehicles_km[0].rate_unit_label, 'Rs/km');

  const [curY, curM] = currentYm().split('-').map(Number);
  const prefillKm = await reqJson(`/api/hire/bills/prefill?assetCode=DC-99&year=${curY}&month=${curM}`);
  assert.equal(prefillKm.status, 200);
  assert.equal(prefillKm.body.rateBasis, 'KM');
  assert.equal(prefillKm.body.dryRateCents, 4500);
  assert.equal(prefillKm.body.minBillHours, 3000);
  assert.equal(prefillKm.body.workingDaysInMonth, 25);

  const prefillHr = await reqJson(`/api/hire/bills/prefill?assetCode=HEX-88&year=${curY}&month=${curM}`);
  assert.equal(prefillHr.status, 200);
  assert.equal(prefillHr.body.rateBasis, 'HOURLY');
  assert.equal(prefillHr.body.minBillHours, 120);
  assert.equal(prefillHr.body.workingDaysInMonth, 25);

  const hexOv = await reqJson('/api/hire/rates-overview?consBasis=hr&search=HEX-88');
  assert.equal(hexOv.status, 200);
  assert.equal(hexOv.body.machinery_hr[0].min_bill_units, 120);
  const dcOv = await reqJson('/api/hire/rates-overview?consBasis=km&search=DC-99');
  assert.equal(dcOv.status, 200);
  assert.equal(dcOv.body.vehicles_km[0].min_bill_units, 3000);

  // Verify pure calculator 25-day breakdown deduction on default 120 hr / 3,000 km minimums
  const calc = require('../src/lib/billing/calc');
  const hrRes = calc.calculateRentalBill({
    rateBasis: 'HOURLY',
    billingMode: 'DRY',
    rateCents: 500000,
    actualUnits: 0,
    breakdownDays: 5,
    fuelLitres: 0,
  });
  assert.equal(hrRes.minimumUnits, 120);
  assert.equal(hrRes.workingDaysInMonth, 25);
  assert.equal(hrRes.workingDaysBilled, 20);
  assert.equal(hrRes.rentalAmountCents, 60000000);
  assert.equal(hrRes.breakdownDeductCents, 12000000);
  assert.equal(hrRes.netRentalAmountCents, 48000000);
  assert.equal(hrRes.subtotalCents, 48000000);

  const kmRes = calc.calculateRentalBill({
    rateBasis: 'KM',
    billingMode: 'DRY',
    rateCents: 12000,
    actualUnits: 0,
    breakdownDays: 5,
    fuelLitres: 0,
  });
  assert.equal(kmRes.minimumUnits, 3000);
  assert.equal(kmRes.workingDaysInMonth, 25);
  assert.equal(kmRes.workingDaysBilled, 20);
  assert.equal(kmRes.rentalAmountCents, 36000000);
  assert.equal(kmRes.breakdownDeductCents, 7200000);
  assert.equal(kmRes.netRentalAmountCents, 28800000);
  assert.equal(kmRes.subtotalCents, 28800000);
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try { rawDb.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
