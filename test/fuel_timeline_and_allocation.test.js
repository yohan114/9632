'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-fuel-timeline-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { rawDb, migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const fuelTimeline = require('../src/lib/billing/fuel_timeline');
const siteSummary = require('../src/lib/billing/site_summary');
const breakdowns = require('../src/lib/billing/breakdowns');
const app = require('../src/server');

let server;
let baseUrl;
let adminCookie;

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

test('Setup fresh DB with Migration 067, Costing Options & multi-site fuel fixtures', async () => {
  migrate();
  capabilities.seedCapabilities();

  // Verify Migration 067 columns & settings
  const fvaCols = all('PRAGMA table_info(fleet_vehicle_allocations)').map((c) => c.name);
  assert.ok(fvaCols.includes('origin'), 'fleet_vehicle_allocations must have origin column');
  assert.ok(fvaCols.includes('locked'), 'fleet_vehicle_allocations must have locked column');
  assert.equal(get("SELECT value FROM settings WHERE key = 'billing.earlyMonthCutoffDay'").value, '10');
  assert.equal(get("SELECT value FROM settings WHERE key = 'billing.workingDaysPerMonth'").value, '25');
  assert.equal(get("SELECT value FROM settings WHERE key = 'billing.autoAllocMinConsecutive'").value, '2');

  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop', 'Peliyagoda', 1, 1)");
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (14, 'BGP', 'Badalgama Plant', 'badalgama plant', 1)");
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (38, 'CEP03', 'Galagedara Site', 'galagedara site', 1)");

  run(`
    INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active)
    VALUES
      ('tk-1', 'TANK-1', 'Badalgama Pump', 'FIXED', 'AUTO_DIESEL', 20000, 15000, 14, 1),
      ('tk-12', 'TANK-12', 'Galagedara Pump', 'BOWSER', 'AUTO_DIESEL', 15000, 10000, 38, 1)
  `);

  run(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, asset_class, meter_type, status, in_register, created_at, updated_at)
    VALUES
      (1, 'DT-47', 'DT47', 'LI-4701', 'ISUZU', 'Dump Truck', 'vehicle', 'KM', 'active', 1, datetime('now'), datetime('now')),
      (2, 'DT-51', 'DT51', 'LI-5101', 'ISUZU', 'Dump Truck', 'vehicle', 'KM', 'active', 1, datetime('now'), datetime('now')),
      (3, 'EX-99', 'EX99', 'EX-99', 'CAT', 'Excavator', 'vehicle', 'HOURS', 'active', 1, datetime('now'), datetime('now')),
      (4, 'BD-03', 'BD03', 'BD-03', 'KOMATSU', 'Bulldozer', 'vehicle', 'HOURS', 'active', 1, datetime('now'), datetime('now')),
      (5, 'BM-03', 'BM03', 'BM-03', 'HINO', 'Boom Truck', 'vehicle', 'HOURS', 'active', 1, datetime('now'), datetime('now')),
      (6, 'MC-01', 'MC01', 'MC-01', 'KOBELCO', 'Excavator', 'vehicle', 'HOURS', 'active', 1, datetime('now'), datetime('now'))
  `);

  run(`
    INSERT INTO fleet_rental_rates (
      id, asset_id, category_name, rate_basis, rate_cents,
      dry_rate_cents, wet_rate_cents, hr_dry_cents, hr_wet_cents, km_dry_cents, km_wet_cents,
      equip_type, default_basis, fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy, fuel_cons_basis
    ) VALUES
      ('rc-1', 1, 'Dump Truck', 'KM', 10000, 10000, 12000, NULL, NULL, 10000, 12000, 'FLEET', 'DRY', 0.25, 0.333333, 0.4, 'km'),
      ('rc-2', 2, 'Dump Truck', 'KM', 10000, 10000, 12000, NULL, NULL, 10000, 12000, 'FLEET', 'DRY', 0.25, 0.333333, 0.4, 'km'),
      ('rc-3', 3, 'Excavator', 'HOURLY', 500000, 500000, 550000, 500000, 550000, NULL, NULL, 'FLEET', 'DRY', 12, 16, 20, 'hr'),
      ('rc-4', 4, 'Bulldozer', 'HOURLY', 600000, 600000, 650000, 600000, 650000, NULL, NULL, 'FLEET', 'DRY', 12, 16, 20, 'hr'),
      ('rc-5', 5, 'Boom Truck', 'HOURLY', 250000, 250000, 300000, 250000, 300000, NULL, NULL, 'FLEET', 'DRY', 5, 8, 10, 'hr'),
      ('rc-6', 6, 'Excavator', 'HOURLY', 500000, 500000, 550000, 500000, 550000, NULL, NULL, 'FLEET', 'DRY', 12, 16, 20, 'hr')
  `);

  run("INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('admin', 'Administrator', 1, 1)");
  const adminRole = get("SELECT id FROM roles WHERE name = 'admin'");
  const pwHash = auth.hashPassword('TimelinePass#2026!');
  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password) VALUES (1, 'admin_tl', ?, 'Timeline Admin', 1, 0)", pwHash);
  run('INSERT INTO user_roles (user_id, role_id) VALUES (1, ?)', adminRole.id);

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  const login = await reqJson('/api/auth/login', {
    method: 'POST',
    cookie: null,
    body: { username: 'admin_tl', password: 'TimelinePass#2026!' },
  });
  assert.equal(login.status, 200);
  adminCookie = login.headers.get('set-cookie').split(';')[0];
});

test('Costing Options API persists and validates rules cleanly', async () => {
  const g0 = await reqJson('/api/hire/costing-options');
  assert.equal(g0.status, 200);
  assert.equal(g0.body.earlyMonthCutoffDay, 10);
  assert.equal(g0.body.workingDaysPerMonth, 25);

  const bad = await reqJson('/api/hire/costing-options', {
    method: 'PUT',
    body: { earlyMonthCutoffDay: 35 },
  });
  assert.equal(bad.status, 400);

  const upd = await reqJson('/api/hire/costing-options', {
    method: 'PUT',
    body: { earlyMonthCutoffDay: 12, workingDaysPerMonth: 25, autoAllocMinConsecutive: 2, singleSiteFullMonthMode: 'EARLY_CUTOFF' },
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.earlyMonthCutoffDay, 12);

  // Restore default 10 for remaining tests
  await reqJson('/api/hire/costing-options', {
    method: 'PUT',
    body: { earlyMonthCutoffDay: 10 },
  });
});

test('Fuel Timeline & Auto-Allocation: early-month cutoff, late arrival, prior continuity, transit refuel & manual lock', async () => {
  // 1) DT-47: Early-month issues at Galagedara (Nov 4 SLST stored as UTC Nov 3 18:30, plus Nov 15 & Nov 20) -> full 30 days & 100% fuel
  //    (plus verify stale open-ended Badalgama assignment does NOT cause DT-47 to lose fuel or bill 1 day!)
  run(`
    INSERT INTO fleet_asset_assignments (id, asset_id, asset_code, project_id, start_date, end_date, billing_type, origin)
    VALUES ('asg-stale-dt47', 1, 'DT-47', 14, '2026-01-01', NULL, 'DRY_WITH_DRIVER', 'MANUAL')
  `);
  run(`
    INSERT INTO fuel_issues (id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, litres, fuel_price_cents, price_per_litre_cents, total_cost_cents, cost_cents, issue_date, bulk_tank_id, source_tank_id, is_voided)
    VALUES
      ('fi-dt47-1', 'FI-101', 1, 'DT-47', 'LI-4701', 'AUTO_DIESEL', 120, 39200, 39200, 4704000, 4704000, '2026-11-03 18:30:00', 'tk-12', 'tk-12', 0),
      ('fi-dt47-2', 'FI-102', 1, 'DT-47', 'LI-4701', 'AUTO_DIESEL', 180, 39200, 39200, 7056000, 7056000, '2026-11-15 06:00:00', 'tk-12', 'tk-12', 0),
      ('fi-dt47-3', 'FI-103', 1, 'DT-47', 'LI-4701', 'AUTO_DIESEL', 180, 39200, 39200, 7056000, 7056000, '2026-11-20 06:00:00', 'tk-12', 'tk-12', 0)
  `);

  // 2) DT-51: Works at Galagedara all month (Nov 2, 5, 11, 17) with ONE 30L transit refuel at Badalgama on Nov 9
  //    Billing -> Galagedara 29d + 607L, Badalgama 1d + 30L (Total 30d, zero double-billing!)
  //    Auto-Allocation -> stays 100% Galagedara (smoothed out 1-issue transit stop!)
  run(`
    INSERT INTO fuel_issues (id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, litres, fuel_price_cents, price_per_litre_cents, total_cost_cents, cost_cents, issue_date, bulk_tank_id, source_tank_id, is_voided)
    VALUES
      ('fi-dt51-1', 'FI-201', 2, 'DT-51', 'LI-5101', 'AUTO_DIESEL', 150, 39200, 39200, 5880000, 5880000, '2026-11-02 06:00:00', 'tk-12', 'tk-12', 0),
      ('fi-dt51-2', 'FI-202', 2, 'DT-51', 'LI-5101', 'AUTO_DIESEL', 157, 39200, 39200, 6154400, 6154400, '2026-11-05 06:00:00', 'tk-12', 'tk-12', 0),
      ('fi-dt51-3', 'FI-203', 2, 'DT-51', 'LI-5101', 'AUTO_DIESEL', 30,  39200, 39200, 1176000, 1176000, '2026-11-09 06:00:00', 'tk-1',  'tk-1',  0),
      ('fi-dt51-4', 'FI-204', 2, 'DT-51', 'LI-5101', 'AUTO_DIESEL', 150, 39200, 39200, 5880000, 5880000, '2026-11-11 06:00:00', 'tk-12', 'tk-12', 0),
      ('fi-dt51-5', 'FI-205', 2, 'DT-51', 'LI-5101', 'AUTO_DIESEL', 150, 39200, 39200, 5880000, 5880000, '2026-11-17 06:00:00', 'tk-12', 'tk-12', 0)
  `);

  // 3) EX-99: Late arrival on Nov 18 with NO prior-month site -> prorated Nov 18..30 = 13 days!
  run(`
    INSERT INTO fuel_issues (id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, litres, fuel_price_cents, price_per_litre_cents, total_cost_cents, cost_cents, issue_date, bulk_tank_id, source_tank_id, is_voided)
    VALUES
      ('fi-ex99-1', 'FI-301', 3, 'EX-99', 'EX-99', 'AUTO_DIESEL', 160, 39200, 39200, 6272000, 6272000, '2026-11-18 06:00:00', 'tk-12', 'tk-12', 0)
  `);

  // 4) MC-01: Locked MANUAL allocation at Badalgama (14) protected from sync-from-fuel even though fuel issued on Galagedara (38)
  const lockAlloc = await reqJson('/api/hire/allocations', {
    method: 'POST',
    body: {
      assetId: 6,
      projectId: 14,
      assignedBasis: 'DRY_WITH_DRIVER',
      dateFrom: '2026-11-01',
      dateTo: '2026-11-30',
      isCurrent: false,
      locked: true,
      notes: 'Locked manual posting',
    },
  });
  assert.equal(lockAlloc.status, 201);

  // Verify Galagedara (38) & Badalgama (14) site summaries
  const galSum = siteSummary.buildSiteSummary(38, '2026-11');
  const badSum = siteSummary.buildSiteSummary(14, '2026-11');
  const galByCode = Object.fromEntries(galSum.lines.map((l) => [l.code, l]));
  const badByCode = Object.fromEntries(badSum.lines.map((l) => [l.code, l]));

  assert.equal(galByCode['DT-47'].postedDays, 30, 'DT-47 early month SLST Nov 4 issue -> full 30 days');
  assert.equal(galByCode['DT-47'].fuelLitres, 480, 'DT-47 captures all 480L without dropping issues');
  assert.equal(galByCode['DT-51'].postedDays, 29, 'DT-51 gets 29 days at Galagedara');
  assert.equal(galByCode['DT-51'].fuelLitres, 607, 'DT-51 gets 607L at Galagedara');
  assert.equal(badByCode['DT-51'].postedDays, 1, 'DT-51 gets 1 day at Badalgama');
  assert.equal(badByCode['DT-51'].fuelLitres, 30, 'DT-51 gets 30L at Badalgama');
  assert.equal(galByCode['EX-99'].postedDays, 13, 'EX-99 arriving Nov 18 (after cutoff Day 10, no prior site) -> 13 prorated days');

  // Verify buildSiteMonthlyPlan resolves tank->site even with NULL target_project_id
  const previewGal = await reqJson('/api/hire/bills/site-preview?projectId=38&month=2026-11');
  assert.equal(previewGal.status, 200);
  const dt47Prev = previewGal.body.items.find((x) => x.assetCode === 'DT-47');
  assert.ok(dt47Prev && dt47Prev.fuelLitres === 480 && dt47Prev.siteOverlapDays === 30);

  // Dry-run & apply auto-allocation sync
  const drySync = await reqJson('/api/hire/allocations/sync-from-fuel', {
    method: 'POST',
    body: { month: '2026-11', dryRun: true },
  });
  assert.equal(drySync.status, 200);
  assert.equal(drySync.body.dryRun, true);
  assert.ok(drySync.body.created >= 3);

  const applySync = await reqJson('/api/hire/allocations/sync-from-fuel', {
    method: 'POST',
    body: { month: '2026-11', dryRun: false },
  });
  assert.equal(applySync.status, 200);

  // DT-51 should only have 1 allocation row in Galagedara (38), NOT Badalgama (14)
  const dt51Allocs = all("SELECT project_id, origin, date_from, date_to FROM fleet_vehicle_allocations WHERE asset_id = 2 AND month = '2026-11'");
  assert.equal(dt51Allocs.length, 1);
  assert.equal(dt51Allocs[0].project_id, 38);
  assert.equal(dt51Allocs[0].origin, 'AUTO_FUEL');
  assert.equal(dt51Allocs[0].date_from, '2026-11-01');

  // MC-01 locked manual allocation must remain untouched at Badalgama (14)
  const mcAllocs = all("SELECT project_id, origin, locked FROM fleet_vehicle_allocations WHERE asset_id = 6 AND month = '2026-11'");
  assert.equal(mcAllocs.length, 1);
  assert.equal(mcAllocs[0].project_id, 14);
  assert.equal(mcAllocs[0].origin, 'MANUAL');
  assert.equal(mcAllocs[0].locked, 1);

  // Verify prior-month continuity: EX-99 in Oct at Galagedara + single issue in Nov 20 -> Dec 2026 issue gives full month!
  run(`
    INSERT INTO fuel_issues (id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, litres, fuel_price_cents, price_per_litre_cents, total_cost_cents, cost_cents, issue_date, bulk_tank_id, source_tank_id, is_voided)
    VALUES
      ('fi-ex99-dec', 'FI-302', 3, 'EX-99', 'EX-99', 'AUTO_DIESEL', 80, 39200, 39200, 3136000, 3136000, '2026-12-20 06:00:00', 'tk-12', 'tk-12', 0)
  `);
  const decSum = siteSummary.buildSiteSummary(38, '2026-12');
  const ex99Dec = decSum.lines.find((l) => l.code === 'EX-99');
  assert.ok(ex99Dec && ex99Dec.postedDays === 31, 'Prior-month presence at Galagedara gives full 31 days in Dec even on Dec 20 issue');
});

test('Repair downtime accuracy, fuel-during-repair warning, company cost impact & allowOpenBreakdownDeduction', async () => {
  // BD-03: Took Badalgama fuel on Nov 2 & Nov 8 (342L total) then Galagedara fuel on Nov 26 (50L) -> 25d Badalgama + 5d Galagedara
  run(`
    INSERT INTO fuel_issues (id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, litres, fuel_price_cents, price_per_litre_cents, total_cost_cents, cost_cents, issue_date, bulk_tank_id, source_tank_id, is_voided)
    VALUES
      ('fi-bd03-1', 'FI-401', 4, 'BD-03', 'BD-03', 'AUTO_DIESEL', 292, 39200, 39200, 11446400, 11446400, '2026-11-02 06:00:00', 'tk-1', 'tk-1', 0),
      ('fi-bd03-2', 'FI-402', 4, 'BD-03', 'BD-03', 'AUTO_DIESEL', 50,  39200, 39200, 1960000,  1960000,  '2026-11-08 06:00:00', 'tk-1', 'tk-1', 0),
      ('fi-bd03-3', 'FI-403', 4, 'BD-03', 'BD-03', 'AUTO_DIESEL', 50,  39200, 39200, 1960000,  1960000,  '2026-11-26 06:00:00', 'tk-12','tk-12', 0)
  `);

  // Routine JR requested Nov 5 (priority='normal'), workshop STARTED Nov 11 (started_at=2026-11-11), completed Nov 20 (closed_at=2026-11-20), breakdown=0
  // -> Repair window MUST start on Nov 11 (started_at), NOT Nov 5 (jr_req_date)!
  run(`
    INSERT INTO job_requests (id, jr_no, req_date, asset_id, project_id, workshop_id, type, severity, priority, description, approval_status, requested_by)
    VALUES
      (501, 'JR-501', '2026-11-05', 4, 14, 1, 'repair', 'minor', 'normal', 'Wiper & track roller repair', 'approved', 1),
      (502, 'JR-502', '2026-11-04', 5, 14, 1, 'repair', 'minor', 'normal', 'Routine pending grease nipple check', 'requested', 1)
  `);
  run(`
    INSERT INTO job_cards (id, job_no, asset_id, project_id, workshop_id, type, severity, status, breakdown, field, requested_at, started_at, closed_at, description, job_request_id, requested_by, is_historical)
    VALUES
      (601, 'CW/2026/601', 4, 14, 1, 'repair', 'minor', 'CLOSED', 0, 0, '2026-11-05', '2026-11-11', '2026-11-20', 'Routine workshop repair', 501, 1, 0)
  `);
  // Workshop parts cost of Rs 150,000 for BD-03 in Nov 2026
  run(`
    INSERT INTO job_parts (id, job_id, source_type, description, qty, unit_price)
    VALUES (1, 601, 'issue', 'Track Roller Assembly', 1, 150000)
  `);

  // Also test BM-03 OPEN field breakdown starting Nov 16 (with Nov 18 fuel during repair -> warning flag!)
  run(`
    INSERT INTO fuel_issues (id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, litres, fuel_price_cents, price_per_litre_cents, total_cost_cents, cost_cents, issue_date, bulk_tank_id, source_tank_id, is_voided)
    VALUES
      ('fi-bm03-1', 'FI-501', 5, 'BM-03', 'BM-03', 'AUTO_DIESEL', 60, 39200, 39200, 2352000, 2352000, '2026-11-03 06:00:00', 'tk-1', 'tk-1', 0),
      ('fi-bm03-2', 'FI-502', 5, 'BM-03', 'BM-03', 'AUTO_DIESEL', 40, 39200, 39200, 1568000, 1568000, '2026-11-18 06:00:00', 'tk-1', 'tk-1', 0)
  `);
  run(`
    INSERT INTO job_cards (id, job_no, asset_id, project_id, workshop_id, type, severity, status, breakdown, field, reported_at, description, requested_by, is_historical)
    VALUES
      (602, 'CW/2026/602', 5, 14, 1, 'repair', 'major', 'IN_PROGRESS', 1, 1, '2026-11-16', 'Hydraulic boom cylinder failure', 1, 0)
  `);

  const bdRes = await reqJson('/api/hire/breakdowns?month=2026-11');
  assert.equal(bdRes.status, 200);

  // Routine unlinked JR-502 (priority='normal') must NOT pollute breakdown monitoring
  assert.equal(bdRes.body.breakdowns.some((r) => r.jr_no === 'JR-502'), false, 'Routine unlinked JR must not appear as breakdown');

  // BD-03 must start on Nov 11 (started_at), 10 days (Nov 11..20), NOT Nov 5!
  const bd03Rec = bdRes.body.breakdowns.find((r) => r.job_no === 'CW/2026/601');
  assert.ok(bd03Rec);
  assert.equal(bd03Rec.breakdown_start, '2026-11-11');
  assert.equal(bd03Rec.total_days, 10);
  assert.equal(bd03Rec.has_fuel_during_repair, false, 'Nov 8 fuel is before Nov 11 workshop intake');
  assert.equal(bd03Rec.workshop_repair_cost_cents, 15000000);

  // BM-03 OPEN breakdown started Nov 16 -> flags Nov 18 40L fuel dispensed inside repair window
  const bm03Rec = bdRes.body.breakdowns.find((r) => r.job_no === 'CW/2026/602');
  assert.ok(bm03Rec);
  assert.equal(bm03Rec.has_fuel_during_repair, true);
  assert.equal(bm03Rec.fuel_during_repair_litres, 40);

  // Check zero double-billing & repair deduction on BD-03 across Badalgama + Galagedara
  const badNov = siteSummary.buildSiteSummary(14, '2026-11');
  const galNov = siteSummary.buildSiteSummary(38, '2026-11');
  const bd03Bad = badNov.lines.find((l) => l.code === 'BD-03');
  const bd03Gal = galNov.lines.find((l) => l.code === 'BD-03');
  assert.ok(bd03Bad && bd03Gal);
  assert.equal(bd03Bad.postedDays, 25);
  assert.equal(bd03Gal.postedDays, 5);
  assert.equal(bd03Bad.postedDays + bd03Gal.postedDays, 30, 'Total posted days across both sites = 30 (zero double-billing)');
  assert.equal(bd03Bad.breakdownDays, 10, 'Nov 11..20 deducted on Badalgama stay');
  assert.equal(bd03Bad.daysHere, 15, '15 active days billed at Badalgama');
  assert.ok(bd03Bad.workshopRepairCostCents > 0 && bd03Bad.lostHireRevenueCents > 0);
  assert.equal(bd03Bad.totalBreakdownImpactCents, bd03Bad.workshopRepairCostCents + bd03Bad.lostHireRevenueCents);

  // Check Vehicle Costing P&L surfaces Breakdown Impact & Availability %
  const vcFleet = await reqJson('/api/vehicle-costing/fleet-summary?month=2026-11');
  assert.equal(vcFleet.status, 200);
  assert.ok(vcFleet.body.totals.total_breakdown_days > 0);
  assert.ok(vcFleet.body.totals.total_lost_hire_revenue > 0);
  assert.ok(vcFleet.body.totals.total_breakdown_impact >= vcFleet.body.totals.total_repair_cost + vcFleet.body.totals.total_lost_hire_revenue - 0.1);
  const vcBd03 = await reqJson('/api/vehicle-costing/single-vehicle?asset_id=4&month=2026-11');
  assert.equal(vcBd03.status, 200);
  assert.equal(vcBd03.body.summary.breakdown_days, 10);
  assert.equal(vcBd03.body.summary.repair_cost, 150000);
  assert.ok(vcBd03.body.summary.lost_hire_revenue > 0);
  assert.ok(vcBd03.body.summary.total_breakdown_impact > 150000);

  // Check allowOpenBreakdownDeduction=1 allows billing BM-03 active days (Nov 1..15 = 15d) in site-preview
  const strictPrev = await reqJson('/api/hire/bills/site-preview?projectId=14&month=2026-11');
  const strictBm03 = strictPrev.body.items.find((x) => x.assetCode === 'BM-03');
  assert.equal(strictBm03.billingBlocked, true, 'Default strict mode still blocks open breakdown for backward compat');

  const deductPrev = await reqJson('/api/hire/bills/site-preview?projectId=14&month=2026-11&allowOpenBreakdownDeduction=1');
  const deductBm03 = deductPrev.body.items.find((x) => x.assetCode === 'BM-03');
  assert.equal(deductBm03.billingBlocked, false, 'allowOpenBreakdownDeduction=1 unblocks partial active working days');
  assert.equal(deductBm03.activeDays, 15);
  assert.equal(deductBm03.breakdownDays, 15);
  assert.ok(deductBm03.calculation.breakdownDeductCents > 0);
});

test('Live fuel issue hook creates AUTO_FUEL allocation and voiding cleans it up', async () => {
  // Use a fresh unlocked vehicle LD-01 (id=7) in the current SLST month so the live hook creates AUTO_FUEL
  run(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, asset_class, meter_type, status, in_register, created_at, updated_at)
    VALUES (7, 'LD-01', 'LD01', 'LD-01', 'CAT', 'Wheel Loader', 'vehicle', 'HOURS', 'active', 1, datetime('now'), datetime('now'))
  `);
  const ym = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 7);
  const issueDate = `${ym}-04`;

  // Ensure fuel price exists
  run("INSERT OR IGNORE INTO fuel_prices (fuel_type, fuel_kind, effective_date, price_per_litre_cents, price_per_litre, source) VALUES ('AUTO_DIESEL', 'AUTO_DIESEL', '2026-01-01', 39200, 392, 'Test')");

  // Create transport request -> pump dispense issue via API
  const reqRes = await reqJson('/api/fuel/requests', {
    method: 'POST',
    body: {
      assetCode: 'LD-01',
      projectId: 38,
      targetTankId: 'tk-12',
      meterReading: 2500,
      prevMeterReading: 2490,
      runningChartNo: 'RC-9901',
      requestedLitres: 60,
      issueDate,
    },
  });
  assert.equal(reqRes.status, 201, `Fuel request create failed: ${JSON.stringify(reqRes.body)}`);

  const issRes = await reqJson(`/api/fuel/requests/${reqRes.body.id}/issue`, {
    method: 'POST',
    body: {
      litres: 60,
      meterReading: 2500,
      sourceTankId: 'tk-12',
      issueDate,
    },
  });
  assert.equal(issRes.status, 201, `Fuel issue failed: ${JSON.stringify(issRes.body)}`);

  // Live hook must have auto-created AUTO_FUEL allocation for LD-01 at Galagedara (38) for current month!
  const autoRow = get("SELECT * FROM fleet_vehicle_allocations WHERE asset_id = 7 AND month = ? AND origin = 'AUTO_FUEL'", ym);
  assert.ok(autoRow, 'Expected live hook to create AUTO_FUEL allocation on fuel issue');
  assert.equal(autoRow.project_id, 38);
  assert.equal(autoRow.date_from, `${ym}-01`);

  // Void the fuel issue -> live hook must clean up the AUTO_FUEL row!
  const voidRes = await reqJson(`/api/fuel/issues/${issRes.body.issue.id}/void`, {
    method: 'POST',
    body: { reason: 'Test void cleanup' },
  });
  assert.equal(voidRes.status, 200);

  const afterVoid = get("SELECT * FROM fleet_vehicle_allocations WHERE asset_id = 7 AND month = ? AND origin = 'AUTO_FUEL'", ym);
  assert.equal(afterVoid, undefined, 'Expected voiding the only fuel issue to clean up AUTO_FUEL allocation');
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try { rawDb.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
