'use strict';

/**
 * Automated tests for the 4-Stage Service & Filter Plan Engine, API routes,
 * RBAC gating, Excel export, Service JR generation, and manual lock persistence.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-srvplan-adv-'));
process.env.DB_PATH = path.join(TMP, 'sp-adv.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { db, migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const perms = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');
const servicePlan = require('../src/lib/service_plan');
const engine = require('../src/lib/service_plan_engine');
const { normF } = require('../src/lib/filter_no');
const { backfillVehicleFilterSchedules } = require('../src/migrate/060_service_filter_plan');

migrate();
const PW = 'amber-quarry-compass-9';
const BUILT_IN = Object.keys(perms.DEFAULT_MATRIX);
for (const n of ['admin', ...BUILT_IN]) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
capabilities.seedCapabilities();
perms.seedDefaults();

function mkRole(name, modulesOpen, caps = []) {
  run('INSERT INTO roles (name, label) VALUES (?, ?)', name, name);
  for (const m of perms.MODULE_KEYS) {
    perms.setPermission(name, m, modulesOpen.includes(m) ? 'edit' : 'none');
  }
  for (const c of caps) {
    capabilities.setCapability(name, c, true);
  }
}

mkRole('sp_filt_only', ['filters'], ['filters.view']);
mkRole('sp_view_only', ['service_plan'], ['service_plan.view']);
mkRole('sp_full', ['service_plan'], [
  'service_plan.view',
  'service_plan.override_interval',
  'service_plan.manage',
  'service_plan.export',
]);

for (const u of [
  { name: 'adv_admin', role: 'admin' },
  { name: 'adv_filt', role: 'sp_filt_only' },
  { name: 'adv_view', role: 'sp_view_only' },
  { name: 'adv_full', role: 'sp_full' },
]) {
  const uid = run(
    'INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)',
    u.name,
    auth.hashPassword(PW)
  ).lastInsertRowid;
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, u.role);
}

// Reference projects & tanks
const projA = run("INSERT INTO projects (code, name, location) VALUES ('PRJ-A', 'Site Alpha', 'Kandy')").lastInsertRowid;
const projB = run("INSERT INTO projects (code, name, location) VALUES ('PRJ-B', 'Site Beta', 'Galle')").lastInsertRowid;
const tankA = 'tank-a';
const tankB = 'tank-b';
run("INSERT INTO fuel_tanks (id, code, name, project_id, active) VALUES ('tank-a', 'TK-A', 'Tank Alpha', ?, 1)", projA);
run("INSERT INTO fuel_tanks (id, code, name, project_id, active) VALUES ('tank-b', 'TK-B', 'Bowser Beta', ?, 1)", projB);

// Helper to create test assets
function mkAsset(code, { reg = null, ec = null, cls = 'plant', type = 'Excavator', projectId = projA } = {}) {
  const norm = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return run(
    `INSERT INTO assets (code, code_norm, registration, ec_code, asset_class, type, home_project_id, current_project_id, status, in_register)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1)`,
    code, norm, reg, ec, cls, type, projectId, projectId
  ).lastInsertRowid;
}

// Helper for stock & xrefs
run("INSERT INTO filter_stock (filter_type, part_no, unit, qty_in_stock) VALUES ('Engine Oil Filter', 'LF9009', 'nos', 4)");
run("INSERT INTO filter_prices (filter_no, filter_no_norm, unit_price, uses, source) VALUES ('C-510A', 'C510A', 4200, 1, 'test')");
run("INSERT INTO filter_prices (filter_no, filter_no_norm, unit_price, uses, source) VALUES ('AF-200', 'AF200', 7500, 1, 'test')");
const catId = run(
  "INSERT INTO filter_catalogue (id, category, oem_pn, oem_pn_norm, hifi_pn, hifi_pn_norm) VALUES (901, 'Engine Oil Filter', 'C-510A', 'C510A', 'LF9009', 'LF9009')"
).lastInsertRowid;
run("INSERT INTO filter_xrefs (catalogue_id, brand, part_number, part_number_norm, ref_type) VALUES (?, 'DONALDSON', 'C-510A', 'C510A', 'oem')", catId);
run("INSERT INTO filter_xrefs (catalogue_id, brand, part_number, part_number_norm, ref_type) VALUES (?, 'FLEETGUARD', 'LF9009', 'LF9009', 'cross')", catId);

// 1. Asset ADV-1: Multi-site fuel + Colombo 18:30Z boundary + Selective 1x/2x/4x + Compound parts + Repair dedupe
const A1 = mkAsset('HEX-901', { reg: 'HEX-901', ec: 'EC-901', cls: 'plant', type: 'Excavator', projectId: projA });
run(
  "INSERT INTO fleet_rental_rates (id, asset_id, category_name, rate_basis, rate_cents, fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy, fuel_cons_basis) VALUES ('r-a1', ?, 'Excavator', 'HOURLY', 50000, 10, 12.5, 16, 'hr')",
  A1
);
// Visit 1 (June): fitted Engine Oil, Air Outer, Hydraulic
const s1 = run(
  "INSERT INTO service_jobs (job_no, vehicle_label, asset_id, service_date, meter_reading, site_location) VALUES ('2026/06/S/01', 'HEX-901', ?, '2026-06-15', '1000', 'Site Alpha')",
  A1
).lastInsertRowid;
run("INSERT INTO service_filters (service_id, category, filter_no, filter_no_norm, action_type, qty) VALUES (?, 'Engine Oil Filter', 'C-510A & C-519', 'C510A', 'X', 1)", s1);
run("INSERT INTO service_filters (service_id, category, filter_no, filter_no_norm, action_type, qty) VALUES (?, 'Air Filter Outer', 'AF-200', 'AF200', 'X', 1)", s1);
run("INSERT INTO service_filters (service_id, category, filter_no, filter_no_norm, action_type, qty) VALUES (?, 'Hydraulic Filter - S', 'HF-400', 'HF400', 'X', 1)", s1);

// Visit 2 (July): fitted Engine Oil ONLY (Air cleaned E, Hydraulic skipped) -> on next service (#3): Oil=CHANGE, Air=CHANGE (2nd visit since June), Hydraulic=SKIP (only 1 visit since June, needs 4)
const s2 = run(
  "INSERT INTO service_jobs (job_no, vehicle_label, asset_id, service_date, meter_reading, site_location) VALUES ('2026/08/S/01', 'HEX-901', ?, '2026-08-01', '1500', 'Site Alpha')",
  A1
).lastInsertRowid;
run("INSERT INTO service_filters (service_id, category, filter_no, filter_no_norm, action_type, qty) VALUES (?, 'Engine Oil Filter', 'C-510A & C-519', 'C510A', 'X', 1)", s2);
run("INSERT INTO service_filters (service_id, category, filter_no, filter_no_norm, action_type, qty) VALUES (?, 'Air Filter Outer', 'AF-200', 'AF200', 'E', 1)", s2);
run("INSERT INTO service_filters (service_id, category, filter_no, filter_no_norm, action_type, qty) VALUES (?, 'Primary Fuel Filter', 'FF-101', 'FF101', 'X', 1)", s2);

backfillVehicleFilterSchedules(db);

function addFuel({ id, assetId = null, code, ref = null, tankId = null, projectId = null, station = null, litres, meter = null, meterType = 'HOURS', date, voided = 0 }) {
  run(
    `INSERT INTO fuel_issues (
      id, issue_no, asset_id, asset_code, vehicle_ref, litres, fuel_price_cents, total_cost_cents,
      meter_reading, meter_type, issue_date, station_name, source_tank_id, target_project_id, is_voided
    ) VALUES (?, ?, ?, ?, ?, ?, 32000, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, id, assetId, code, ref || code, litres, Math.round(litres * 32000),
    meter, meterType, date, station, tankId, projectId, voided
  );
}

// Fuel issues across 3 sites: Site Alpha, Site Beta (via unresolved code alias -> HEX 901 resolved map), External pump (UTC boundary) + voided (excluded) + Sep 01 Colombo (excluded from 2026-08)
run("INSERT INTO asset_aliases (raw_text, raw_norm, asset_id, resolved) VALUES ('HEX 901 EX', 'HEX901EX', ?, 1)", A1);
addFuel({ id: 'FI-1', assetId: A1, code: 'HEX-901', tankId: tankA, projectId: projA, litres: 1500, meter: 1650, date: '2026-08-05T08:00:00Z' });
addFuel({ id: 'FI-2', assetId: null, code: 'HEX 901 EX', tankId: tankB, projectId: projB, litres: 2000, meter: 1810, date: '2026-08-15T19:00:00Z' }); // 19:00Z Aug 15 = Aug 16 Colombo
addFuel({ id: 'FI-3', assetId: A1, code: 'HEX-901', station: 'Ceypetco Highway Station', litres: 2500, meter: 1980, date: '2026-08-20T06:00:00Z' });
addFuel({ id: 'FI-VOID', assetId: A1, code: 'HEX-901', tankId: tankA, litres: 9999, meter: 9999, date: '2026-08-21T06:00:00Z', voided: 1 });
addFuel({ id: 'FI-SEP', assetId: A1, code: 'HEX-901', tankId: tankA, litres: 500, meter: 2020, date: '2026-08-31T19:00:00Z' }); // Sep 01 Colombo

// Closed 6-day breakdown in Aug 2026 for A1 (also exercises active rate per day) + Air Inner dedupe not present, test Primary Fuel deduction or Air Filter dedupe separately on A3
run(
  "INSERT INTO fleet_breakdowns (id, asset_id, asset_code, project_id, site_name, source_type, breakdown_start, breakdown_end, reason, status) VALUES ('bd-1', ?, 'HEX-901', ?, 'Site Alpha', 'MANUAL', '2026-08-10', '2026-08-15', 'Hydraulic hose burst and cylinder seal leak', 'CLOSED')",
  A1, projA
);

// 2. Asset A2: Meter anomaly + Rate basis conflict + SERVICE_ON_BREAKDOWN
const A2 = mkAsset('HEX-902', { reg: 'HEX-902', ec: 'EC-902', cls: 'plant', type: 'Excavator', projectId: projA });
run(
  "INSERT INTO fleet_rental_rates (id, asset_id, category_name, rate_basis, rate_cents, fuel_cons_typ, fuel_cons_basis) VALUES ('r-a2', ?, 'Excavator', 'HOURLY', 40000, 0.25, 'km')",
  A2
); // Intentionally conflicting 'km' basis on HOURS excavator!
const sA2 = run(
  "INSERT INTO service_jobs (job_no, vehicle_label, asset_id, service_date, meter_reading) VALUES ('2026/08/S/02', 'HEX-902', ?, '2026-08-01', '2000')",
  A2
).lastInsertRowid;
run("INSERT INTO service_filters (service_id, category, filter_no, filter_no_norm, action_type, qty) VALUES (?, 'Engine Oil Filter', 'OF-22', 'OF22', 'X', 1)", sA2);
run("INSERT INTO service_filters (service_id, category, filter_no, filter_no_norm, action_type, qty) VALUES (?, 'Primary Fuel Filter', 'FF-22', 'FF22', 'X', 1)", sA2);
run("INSERT INTO service_filters (service_id, category, filter_no, filter_no_norm, action_type, qty) VALUES (?, 'Hydraulic Filter - S', 'HF-22', 'HF22', 'X', 1)", sA2);
run("INSERT INTO service_filters (service_id, category, filter_no, filter_no_norm, action_type, qty) VALUES (?, 'Air Filter Outer', 'AF-22', 'AF22', 'X', 1)", sA2);
backfillVehicleFilterSchedules(db);

// Fuel readings for A2: 1 valid progression (2000 -> 2440 = 440 hrs, remaining 60 <= 20% of 500), plus 1 wrong KM reading, 1 rollback, 1 huge jump
addFuel({ id: 'F2-1', assetId: A2, code: 'HEX-902', tankId: tankA, litres: 300, meter: 2200, meterType: 'HOURS', date: '2026-08-08T08:00:00Z' });
addFuel({ id: 'F2-BAD-KM', assetId: A2, code: 'HEX-902', tankId: tankA, litres: 100, meter: 125000, meterType: 'KM', date: '2026-08-10T08:00:00Z' });
addFuel({ id: 'F2-BAD-BACK', assetId: A2, code: 'HEX-902', tankId: tankA, litres: 100, meter: 1900, meterType: 'HOURS', date: '2026-08-12T08:00:00Z' });
addFuel({ id: 'F2-BAD-JUMP', assetId: A2, code: 'HEX-902', tankId: tankA, litres: 100, meter: 9500, meterType: 'HOURS', date: '2026-08-13T08:00:00Z' });
addFuel({ id: 'F2-2', assetId: A2, code: 'HEX-902', tankId: tankA, litres: 400, meter: 2440, meterType: 'HOURS', date: '2026-08-22T08:00:00Z' });

// Open breakdown in Aug 2026 for A2 -> SERVICE_ON_BREAKDOWN!
run(
  "INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at, project_id, workshop_id) VALUES ('2026/08/R/02', ?, 'repair', 'Travel motor fault & minor diesel fuel injector check', 'IN_PROGRESS', '2026-08-25', ?, 1)",
  A2, projA
);

// 3. Asset A3: Open breakdown far from due (ON_BREAKDOWN) + Repair job already replaced Primary Fuel Filter (SKIP_RECENT) + CLEAN (E) between cycles
const A3 = mkAsset('HEX-903', { reg: 'HEX-903', ec: 'EC-903', cls: 'plant', type: 'Excavator', projectId: projA });
const sA3 = run(
  "INSERT INTO service_jobs (job_no, vehicle_label, asset_id, service_date, meter_reading) VALUES ('2026/08/S/03', 'HEX-903', ?, '2026-08-01', '5000')",
  A3
).lastInsertRowid;
run("INSERT INTO service_filters (service_id, category, filter_no, filter_no_norm, action_type, qty) VALUES (?, 'Engine Oil Filter', 'OF-33', 'OF33', 'X', 1)", sA3);
run("INSERT INTO service_filters (service_id, category, filter_no, filter_no_norm, action_type, qty) VALUES (?, 'Primary Fuel Filter', 'FF-33', 'FF33', 'X', 1)", sA3);
run("INSERT INTO service_filters (service_id, category, filter_no, filter_no_norm, action_type, qty) VALUES (?, 'Air Filter Outer', 'AF-33', 'AF33', 'X', 1)", sA3);
run("INSERT INTO service_filters (service_id, category, filter_no, filter_no_norm, action_type, qty) VALUES (?, 'Hydraulic Filter - S', 'HF-33', 'HF33', 'X', 1)", sA3);
backfillVehicleFilterSchedules(db);

// Only 100 hrs used (400 hrs left > 100 threshold -> ON_BREAKDOWN)
addFuel({ id: 'F3-1', assetId: A3, code: 'HEX-903', tankId: tankA, litres: 200, meter: 5100, meterType: 'HOURS', date: '2026-08-18T08:00:00Z' });
const jcA3 = run(
  "INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at, project_id, workshop_id) VALUES ('2026/08/R/03', ?, 'repair', 'Cab door latch and wiper motor repair', 'IN_PROGRESS', '2026-08-24', ?, 1)",
  A3, projA
).lastInsertRowid;
run(
  "INSERT INTO issues (asset_id, job_id, description, qty, issue_date) VALUES (?, ?, 'Primary Fuel Filter FF-33 fitted during repair', 1, '2026-08-25')",
  A3, jcA3
);

// Set up HTTP test server
const app = require('../src/server');
let server;
let port;
const cookies = {};

async function login(username) {
  if (cookies[username]) return cookies[username];
  const cookie = await new Promise((resolve, reject) => {
    const data = JSON.stringify({ username, password: PW });
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/auth/login',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve((res.headers['set-cookie'] || [''])[0].split(';')[0]));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
  cookies[username] = cookie;
  return cookie;
}

function httpCall(username, method, urlPath, body) {
  return new Promise(async (resolve, reject) => {
    const cookie = username ? await login(username) : '';
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: json, buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
});

test.after(() => {
  server && server.close();
});

test('Stage 1: all-site fuel aggregation, alias resolution, void exclusion & Colombo 18:30Z boundary', () => {
  assert.strictEqual(engine.toColomboDay('2026-08-15T19:00:00Z'), '2026-08-16');
  assert.strictEqual(engine.toColomboDay('2026-08-31T19:00:00Z'), '2026-09-01');

  const d = engine.getVehicleServicePlanDetail(A1, { month: '2026-08' }).vehicle;
  // FI-1 (1500) + FI-2 via alias (2000) + FI-3 External station (2500) = 6000 L. FI-VOID and FI-SEP excluded.
  assert.strictEqual(d.fuel.litres_since_service, 6000);
  assert.strictEqual(d.fuel.issues_since_service, 3);
  assert.strictEqual(d.fuel.sites_count_since, 3);
  assert.strictEqual(d.fuel.month_litres, 6000);
  // Site Beta issue timestamp 2026-08-15T19:00:00Z must shift to 2026-08-16 in Colombo
  const betaSite = d.fuel.sites_since.find((s) => s.site_name === 'Site Beta');
  assert.ok(betaSite, 'Fuel from Site Beta via unresolved asset_code + alias must be aggregated');
  assert.strictEqual(betaSite.last_date, '2026-08-16');
});

test('Stage 1 & 3: meter-trust rejects KM on HOURS, rollbacks, jumps, and guards rate basis conflict', () => {
  const rateBad = engine.resolveConsumptionRate({ fuel_cons_typ: 0.25, fuel_cons_basis: 'km' }, 'HOURS');
  assert.strictEqual(rateBad.comparable, false);
  assert.strictEqual(rateBad.reason, 'basis_conflict');

  const d2 = engine.getVehicleServicePlanDetail(A2, { month: '2026-08' }).vehicle;
  assert.strictEqual(d2.timing.recorded_since, 440, 'Only valid 2000->2440 growth trusted despite KM/rollback/jump rows');
  assert.strictEqual(d2.timing.fuel_derived_since, null, 'basis_conflict blocks false L/hr inflation');
  assert.ok(d2.timing.meter_warnings.length >= 2, 'Anomalous rollback and jump readings captured as warnings');
});

test('Stage 2 & 3: month breakdown days adjust active burn rate and flag SERVICE_ON_BREAKDOWN vs ON_BREAKDOWN', () => {
  const d1 = engine.getVehicleServicePlanDetail(A1, { month: '2026-08' }).vehicle;
  // Aug 1..31 = 31 elapsed days - 6 BD days (Aug 10..15) = 25 active days
  assert.strictEqual(d1.breakdowns.breakdown_days_in_month, 6);
  assert.strictEqual(d1.timing.month_active_days, 25);
  assert.ok(d1.timing.active_rate_per_day > d1.timing.used_since / 31, 'Active burn rate divides by active days (net of breakdown)');

  const d2 = engine.getVehicleServicePlanDetail(A2, { month: '2026-08' }).vehicle;
  assert.strictEqual(d2.state, 'SERVICE_ON_BREAKDOWN');
  assert.strictEqual(d2.breakdowns.combine_on_breakdown, true);

  const d3 = engine.getVehicleServicePlanDetail(A3, { month: '2026-08' }).vehicle;
  assert.strictEqual(d3.state, 'ON_BREAKDOWN');
  assert.strictEqual(d3.breakdowns.combine_on_breakdown, false);
});

test('Stage 4: selective filter matrix (CHANGE / CLEAN / SKIP), breakdown risk, repair dedupe, compound split & equivs', () => {
  // A1: Hydraulic breakdown reason triggers Hydraulic Filter - S upgrade to CHANGE (X), Air Filter Outer 2nd cycle -> CHANGE (X), Oil -> CHANGE (X)
  const d1 = engine.getVehicleServicePlanDetail(A1, { month: '2026-08' }).vehicle;
  const a1Oil = d1.filter_matrix.find((m) => m.category === 'Engine Oil Filter');
  const a1Air = d1.filter_matrix.find((m) => m.category === 'Air Filter Outer');
  const a1Hyd = d1.filter_matrix.find((m) => m.category === 'Hydraulic Filter - S');
  assert.strictEqual(a1Oil.decision, 'CHANGE');
  assert.strictEqual(a1Air.decision, 'CHANGE');
  assert.strictEqual(a1Hyd.decision, 'CHANGE');
  assert.match(a1Hyd.reason, /Triggered by month breakdown/i);

  // Compound part C-510A & C-519 splits into both C510A and C519 in order, with LF9009 equivalent flagged
  const plan = engine.buildAdvancedServicePlan({ month: '2026-08' });
  const c510 = plan.parts.find((p) => p.part_norm === 'C510A');
  const c519 = plan.parts.find((p) => p.part_norm === 'C519');
  assert.ok(c510 && c519, 'Compound part C-510A & C-519 splits cleanly');
  assert.ok(c510.equivalents_in_stock.some((e) => e.part_no === 'LF9009' && e.in_stock === 4), 'Equivalent LF9009 in stock surfaced');

  // A3: Primary Fuel Filter replaced on repair job -> SKIP_RECENT; Air Filter Outer (1st cycle after X) -> CLEAN (E); Hydraulic Filter (1st cycle after X, no hyd breakdown) -> SKIP (OK)
  const d3 = engine.getVehicleServicePlanDetail(A3, { month: '2026-08' }).vehicle;
  const d3Fuel = d3.filter_matrix.find((m) => m.category === 'Primary Fuel Filter');
  const d3Air = d3.filter_matrix.find((m) => m.category === 'Air Filter Outer');
  const d3Hyd = d3.filter_matrix.find((m) => m.category === 'Hydraulic Filter - S');
  assert.strictEqual(d3Fuel.decision, 'SKIP');
  assert.strictEqual(d3Fuel.action, 'SKIP_RECENT');
  assert.strictEqual(d3Air.decision, 'CLEAN');
  assert.strictEqual(d3Air.action, 'E');
  assert.strictEqual(d3Hyd.decision, 'SKIP');
  assert.strictEqual(d3Hyd.action, 'SKIP');

  // Verify CLEAN and SKIP items never enter plan.parts / categories
  assert.strictEqual(plan.parts.some((p) => p.part_norm === 'HF33'), false);
  assert.strictEqual(plan.parts.some((p) => p.part_norm === 'AF33'), false);

  // Read-only guarantee on engine evaluation
  const sjBefore = get('SELECT COUNT(*) n FROM service_jobs').n;
  const vfsBefore = get('SELECT COUNT(*) n FROM vehicle_filter_schedules').n;
  engine.buildAdvancedServicePlan({ month: '2026-08', includeOk: true, includeLongOverdue: true });
  assert.strictEqual(get('SELECT COUNT(*) n FROM service_jobs').n, sjBefore);
  assert.strictEqual(get('SELECT COUNT(*) n FROM vehicle_filter_schedules').n, vfsBefore);
});

test('HTTP RBAC, manual filter schedule locking + backfill protection, service JR creation & XLSX export', async () => {
  // 1. Filters-only role refused on /service-plan
  const rFilt = await httpCall('adv_filt', 'GET', '/api/filters/service-plan?month=2026-08');
  assert.strictEqual(rFilt.status, 403);

  // 2. View-only role allowed GET, refused XLSX/override/create JR
  const rView = await httpCall('adv_view', 'GET', '/api/filters/service-plan?month=2026-08');
  assert.strictEqual(rView.status, 200);
  assert.strictEqual(rView.body.source, 'unified_4stage');

  const rViewVeh = await httpCall('adv_view', 'GET', `/api/filters/service-plan/vehicle/${A3}?month=2026-08`);
  assert.strictEqual(rViewVeh.status, 200);
  assert.strictEqual(rViewVeh.body.vehicle.asset_code, 'HEX-903');

  const rNoXlsx = await httpCall('adv_view', 'GET', '/api/filters/service-plan?month=2026-08&format=xlsx');
  assert.strictEqual(rNoXlsx.status, 403);
  const rNoEdit = await httpCall('adv_view', 'PUT', `/api/filters/service-plan/vehicle/${A3}/filter-schedule`, {
    category: 'Hydraulic Filter - S', every_n_services: 2, between_action: 'SKIP',
  });
  assert.strictEqual(rNoEdit.status, 403);
  const rNoJr = await httpCall('adv_view', 'POST', `/api/filters/service-plan/vehicle/${A3}/create-service-request`, { month: '2026-08' });
  assert.strictEqual(rNoJr.status, 403);

  // 3. Full service_plan role edits schedule -> locked = 1 + audit logged + backfill respects lock
  const rPut = await httpCall('adv_full', 'PUT', `/api/filters/service-plan/vehicle/${A3}/filter-schedule`, {
    month: '2026-08',
    schedules: [{ category: 'Hydraulic Filter - S', every_n_services: 3, between_action: 'SKIP', qty: 2, locked: 1 }],
    interval_override: { basis: 'HOURS', interval_value: 250, warn_threshold: 25, combine_pct: 0.25 },
  });
  assert.strictEqual(rPut.status, 200);
  const schRow = get("SELECT every_n_services, qty, locked FROM vehicle_filter_schedules WHERE asset_id = ? AND category = 'Hydraulic Filter - S'", A3);
  assert.strictEqual(schRow.every_n_services, 3);
  assert.strictEqual(schRow.qty, 2);
  assert.strictEqual(schRow.locked, 1);

  backfillVehicleFilterSchedules(db);
  const afterBackfill = get("SELECT every_n_services, qty, locked FROM vehicle_filter_schedules WHERE asset_id = ? AND category = 'Hydraulic Filter - S'", A3);
  assert.strictEqual(afterBackfill.every_n_services, 3, 'Locked manual schedule must survive backfill');
  assert.strictEqual(afterBackfill.qty, 2);

  const auditHit = get("SELECT * FROM audit_log WHERE entity = 'vehicle_filter_schedule' AND entity_id = ? ORDER BY id DESC LIMIT 1", A3);
  assert.ok(auditHit, 'Manual schedule change must be audited');

  // 4. Create Service Job Request -> contains only CHANGE & CLEAN filters, not SKIP
  const rJr = await httpCall('adv_full', 'POST', `/api/filters/service-plan/vehicle/${A3}/create-service-request`, { month: '2026-08' });
  assert.strictEqual(rJr.status, 201);
  assert.ok(rJr.body.jr_no && rJr.body.request.type === 'service');
  assert.match(rJr.body.request.description, /CHANGE \(X\):.*Engine Oil Filter/);
  assert.match(rJr.body.request.description, /CLEAN \/ INSPECT \(E\):.*Air Filter Outer/);
  assert.match(rJr.body.request.description, /SKIPPED.*Primary Fuel Filter/);

  // 5. Fuel service-planner unified endpoint agrees with Service Plan
  const rFuel = await httpCall('adv_admin', 'GET', '/api/fuel/service-planner?month=2026-08');
  assert.strictEqual(rFuel.status, 200);
  const fA1 = rFuel.body.rows.find((r) => r.asset_id === A1);
  assert.ok(fA1 && fA1.fuel_litres_since === 6000 && fA1.sites_count_since === 3);

  // 6. Excel multi-tab export returns binary XLSX
  const rXlsx = await httpCall('adv_full', 'GET', '/api/filters/service-plan?month=2026-08&format=xlsx');
  assert.strictEqual(rXlsx.status, 200);
  assert.match(rXlsx.headers['content-type'], /spreadsheetml\.sheet/);
  assert.strictEqual(rXlsx.buf.slice(0, 2).toString('utf8'), 'PK', 'Valid XLSX zip header expected');
});
