'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-mig072-'));
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
const mig072 = require('../src/migrate/072_exclude_outside_billed_vehicles');
const app = require('../src/server');

let server;
let baseUrl;
let adminCookie;

const OUTSIDE_CODES = [
  '325-1030',
  'ELS SUBCONTRACTOR',
  'GD-7104',
  'PE-3723',
  'RG-5415',
  'S&S SOLUTION',
];

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

test('Setup fresh DB with owned + 6 outside-billed assets, allocations, assignments, fuel, bills & ledger events', async () => {
  migrate();
  capabilities.seedCapabilities();

  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop', 'Peliyagoda', 1, 1)");
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (38, 'CEP-03F', 'Galagedara Site', 'galagedara site', 1)");
  run("INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active) VALUES ('tk-12', 'T12', 'Galagedara Tank', 'FIXED', 'AUTO_DIESEL', 20000, 12000, 38, 1)");

  run(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, asset_class, meter_type, current_project_id, status, in_register, ownership, created_at, updated_at)
    VALUES
      (100,  'DT-55',             'DT55',            'LO-7182', 'TATA', 'Dump Truck',               'vehicle', 'KM',    38, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1488, '325-1030',          '3251030',         '325-1030', NULL,  'From Galagedara book',     'vehicle', 'KM',    38, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1434, 'ELS SUBCONTRACTOR', 'ELSSUBCONTRACTOR', NULL,     NULL,   NULL,                       'vehicle', 'KM',    38, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1427, 'GD-7104',           'GD7104',          NULL,      NULL,   'Imported — set type',      'vehicle', 'KM',    38, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1445, 'PE-3723',           'PE3723',          NULL,      NULL,   'Unclassified — set type',  'vehicle', 'HOURS', 38, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1624, 'RG-5415',           'RG5415',          'RG-5415', NULL,   'Tractor',                  'vehicle', 'HOURS', 38, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1634, 'S&S SOLUTION',      'SSSOLUTION',      NULL,     'Quick', 'Other Asset',              'vehicle', 'KM',    38, 'active', 1, 'OWNED', datetime('now'), datetime('now'))
  `);

  run(`
    INSERT INTO fleet_rental_rates (id, asset_id, category_name, rate_basis, rate_cents, dry_rate_cents, wet_rate_cents, equip_type, default_basis, fuel_cons_basis, fuel_cons_typ)
    VALUES
      ('r-100',  100,  'Dump Truck (Tipper)', 'KM',     9500, 9500, 12000, 'FLEET', 'WET', 'km', 0.217),
      ('r-1624', 1624, 'Tractor',             'HOURLY', 180000, 180000, 220000, 'FLEET', 'DRY_WITH_DRIVER', 'hr', 3.5)
  `);

  run(`
    INSERT INTO fleet_vehicle_allocations (id, dedupe_key, asset_id, vehicle_no, project_id, site_name, month, owner_code, basis, origin, locked, is_current, active)
    VALUES
      ('va-1488', 'AUTO-1488-38-2026-11', 1488, '325-1030',          38, 'Galagedara Site', '2026-11', 'E&C', 'DRY_WITH_DRIVER', 'AUTO_FUEL', 0, 1, 1),
      ('va-1434', 'AUTO-1434-38-2026-11', 1434, 'ELS SUBCONTRACTOR', 38, 'Galagedara Site', '2026-11', 'E&C', 'DRY_WITH_DRIVER', 'AUTO_FUEL', 0, 1, 1),
      ('va-1427', 'AUTO-1427-38-2026-11', 1427, 'GD-7104',           38, 'Galagedara Site', '2026-11', 'E&C', 'DRY_WITH_DRIVER', 'AUTO_FUEL', 0, 1, 1),
      ('va-1445', 'AUTO-1445-38-2026-11', 1445, 'PE-3723',           38, 'Galagedara Site', '2026-11', 'E&C', 'DRY_WITH_DRIVER', 'AUTO_FUEL', 0, 1, 1),
      ('va-1624', 'AUTO-1624-38-2026-11', 1624, 'RG-5415',           38, 'Galagedara Site', '2026-11', 'E&C', 'DRY_WITH_DRIVER', 'AUTO_FUEL', 0, 1, 1),
      ('va-1634', 'AUTO-1634-38-2026-11', 1634, 'S&S SOLUTION',      38, 'Galagedara Site', '2026-11', 'E&C', 'DRY_WITH_DRIVER', 'AUTO_FUEL', 0, 1, 1)
  `);

  run(`
    INSERT INTO fleet_asset_assignments (id, asset_id, asset_code, project_id, start_date, billing_type, origin)
    VALUES
      ('as-1488', 1488, '325-1030',          38, '2026-11-01', 'DRY_WITH_DRIVER', 'FUEL'),
      ('as-1434', 1434, 'ELS SUBCONTRACTOR', 38, '2026-11-01', 'DRY_WITH_DRIVER', 'FUEL'),
      ('as-1427', 1427, 'GD-7104',           38, '2026-11-01', 'DRY_WITH_DRIVER', 'FUEL'),
      ('as-1445', 1445, 'PE-3723',           38, '2026-11-01', 'DRY_WITH_DRIVER', 'FUEL'),
      ('as-1624', 1624, 'RG-5415',           38, '2026-11-01', 'DRY_WITH_DRIVER', 'FUEL'),
      ('as-1634', 1634, 'S&S SOLUTION',      38, '2026-11-01', 'DRY_WITH_DRIVER', 'FUEL')
  `);

  run(`
    INSERT INTO fleet_bills (
      id, invoice_number, year, month, period_key, period_start, period_end,
      asset_id, asset_code, project_id, billing_mode, rate_basis, rate_cents,
      actual_units, minimum_units, billable_units, rental_amount_cents,
      fuel_litres, fuel_cost_cents, subtotal_cents, sscl_cents, vat_cents, grand_total_cents, status
    ) VALUES (
      'b-1634', 'INV-1634', 2026, 11, '2026-11', '2026-11-01', '2026-11-30',
      1634, 'S&S SOLUTION', 38, 'DRY_WITH_DRIVER', 'KM', 0,
      0, 0, 0, 0,
      380, 14896000, 14896000, 0, 0, 14896000, 'FINAL'
    )
  `);

  run(`
    INSERT INTO fleet_financial_events (
      id, event_key, event_type, asset_id, asset_code, project_id, business_date, year, month, amount_cents, source_table, source_id
    ) VALUES (
      'fe-fuel-1634', 'FIN-FUEL-1634', 'REVENUE_FUEL', 1634, 'S&S SOLUTION', 38, '2026-11-30', 2026, 11, 14896000, 'fleet_bills', 'b-1634'
    )
  `);

  run(`
    INSERT INTO fuel_issues (id, asset_id, asset_code, vehicle_ref, fuel_type, litres, fuel_price_cents, total_cost_cents, issue_date, source_tank_id, project_id, is_direct_billed, is_voided)
    VALUES
      ('fi-dt55', 100,  'DT-55',             'LO-7182',           'AUTO_DIESEL', 80,  29400, 2352000, '2026-11-05', 'tk-12', 38, 0, 0),
      ('fi-325',  1488, '325-1030',          '325-1030',          'AUTO_DIESEL', 79,  39200, 3096800, '2026-11-05', 'tk-12', 38, 0, 0),
      ('fi-els',  1434, 'ELS SUBCONTRACTOR', 'ELS SUBCONTRACTOR', 'AUTO_DIESEL', 100, 39200, 3920000, '2026-11-06', 'tk-12', 38, 0, 0),
      ('fi-gd',   1427, 'GD-7104',           'GD-7104',           'AUTO_DIESEL', 20,  39200, 784000,  '2026-11-07', 'tk-12', 38, 0, 0),
      ('fi-pe',   1445, 'PE-3723',           'PE-3723',           'AUTO_DIESEL', 60,  39200, 2352000, '2026-11-08', 'tk-12', 38, 0, 0),
      ('fi-rg',   1624, 'RG-5415',           'RG-5415',           'AUTO_DIESEL', 80,  39200, 3136000, '2026-11-09', 'tk-12', 38, 0, 0),
      ('fi-ss',   1634, 'S&S SOLUTION',      'S&S SOLUTION',      'AUTO_DIESEL', 380, 39200, 14896000,'2026-11-10', 'tk-12', 38, 0, 0)
  `);

  run("INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('admin', 'Administrator', 1, 1)");
  const adminRole = get("SELECT id FROM roles WHERE name = 'admin'");
  const pwHash = auth.hashPassword('OutsidePass#2026!');
  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password) VALUES (1, 'admin072', ?, 'Admin User', 1, 0)", pwHash);
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
    body: { username: 'admin072', password: 'OutsidePass#2026!' },
  });
  assert.equal(login.status, 200);
  adminCookie = login.headers.get('set-cookie').split(';')[0];
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { rawDb.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('Migration 072 excludes all 6 outside-billed vehicles idempotently and blocks rental + fuel billing & summary lines', async () => {
  const res1 = mig072.runMigration(rawDb);
  assert.equal(res1.assetsUpdated, 6);
  assert.equal(res1.ratesRemoved, 1);
  assert.equal(res1.allocsUpdated, 6);
  assert.equal(res1.assignmentsUpdated, 6);
  assert.equal(res1.fuelIssuesFlagged, 6);
  assert.equal(res1.billsVoided, 1);
  assert.equal(res1.revEventsRemoved, 1);

  // Assets marked HIRED and removed from fleet register; owned DT-55 untouched
  for (const code of OUTSIDE_CODES) {
    const a = get('SELECT * FROM assets WHERE code = ?', code);
    assert.equal(a.ownership, 'HIRED', `${code} ownership should be HIRED`);
    assert.equal(a.in_register, 0, `${code} in_register should be 0`);
  }
  const dt55 = get("SELECT * FROM assets WHERE code = 'DT-55'");
  assert.equal(dt55.ownership, 'OWNED');
  assert.equal(dt55.in_register, 1);

  // Allocations, assignments, bills, ledger events, and fuel_issues preservation
  for (const id of [1488, 1434, 1427, 1445, 1624, 1634]) {
    const al = get('SELECT * FROM fleet_vehicle_allocations WHERE asset_id = ?', id);
    assert.equal(al.owner_code, 'HIRED');
    assert.equal(al.basis, 'BILLED_DIRECT');
    const asg = get('SELECT * FROM fleet_asset_assignments WHERE asset_id = ?', id);
    assert.equal(asg.billing_type, 'BILLED_DIRECT');
    const fi = get('SELECT * FROM fuel_issues WHERE asset_id = ?', id);
    assert.ok(fi, `Physical fuel_issues row for asset ${id} must be preserved`);
    assert.equal(fi.is_direct_billed, 1);
  }
  assert.equal(get('SELECT COUNT(*) AS c FROM fuel_issues').c, 7);
  assert.equal(get("SELECT is_direct_billed FROM fuel_issues WHERE id = 'fi-dt55'").is_direct_billed, 0);
  assert.equal(get("SELECT status FROM fleet_bills WHERE id = 'b-1634'").status, 'VOID');
  assert.equal(get("SELECT * FROM fleet_financial_events WHERE id = 'fe-fuel-1634'"), undefined);

  // Strict idempotency
  const res2 = mig072.runMigration(rawDb);
  assert.equal(res2.assetsUpdated, 0);
  assert.equal(res2.ratesRemoved, 0);
  assert.equal(res2.allocsUpdated, 0);
  assert.equal(res2.assignmentsUpdated, 0);
  assert.equal(res2.fuelIssuesFlagged, 0);
  assert.equal(res2.billsVoided, 0);
  assert.equal(res2.revEventsRemoved, 0);

  // Fuel-driven auto allocation preserves HIRED / BILLED_DIRECT
  fuelTimeline.syncFuelAllocations({ periodKey: '2026-11' });
  for (const id of [1488, 1434, 1427, 1445, 1624, 1634]) {
    const al = get("SELECT * FROM fleet_vehicle_allocations WHERE asset_id = ? AND month = '2026-11'", id);
    assert.equal(al.owner_code, 'HIRED');
    assert.equal(al.basis, 'BILLED_DIRECT');
  }

  // Site summary excludes all 6 from lines AND fuel totals (0 rental + 0 fuel)
  const sum = siteSummary.buildSiteSummary(38, '2026-11');
  assert.deepEqual(sum.lines.map((l) => l.code), ['DT-55']);
  assert.equal(sum.fuelLitres, 80);
  assert.equal(sum.fuelCostCents, 2352000);
  for (const code of OUTSIDE_CODES) {
    assert.ok(!sum.unrated.includes(code), `${code} must not appear in unrated`);
    assert.ok(sum.billedDirect.includes(code), `${code} must appear in billedDirect`);
  }

  // Site preview API excludes all 6, includes DT-55
  const preview = await reqJson('/api/hire/bills/site-preview?projectId=38&month=2026-11');
  assert.equal(preview.status, 200);
  const previewCodes = (preview.body.items || []).map((i) => i.assetCode);
  assert.deepEqual(previewCodes, ['DT-55']);

  // Single-bill generate rejects hired/outside vehicles with 409 Conflict
  for (const code of ['325-1030', 'S&S SOLUTION']) {
    const gen = await reqJson('/api/hire/bills/generate', {
      method: 'POST',
      body: { assetCode: code, year: 2026, month: 11, projectId: 38 },
    });
    assert.equal(gen.status, 409, `${code} bill generation must return 409`);
    assert.equal(gen.body.billingBlocked, true);
    assert.equal(gen.body.hiredDirect, true);
  }

  // Prefill returns isHired: true, billingMode: 'BILLED_DIRECT', and 0 billable fuel
  const prefill = await reqJson('/api/hire/bills/prefill?assetCode=325-1030&year=2026&month=11&projectId=38');
  assert.equal(prefill.status, 200);
  assert.equal(prefill.body.isHired, true);
  assert.equal(prefill.body.billingMode, 'BILLED_DIRECT');
  assert.equal(prefill.body.fuelLitres, 0);
});
