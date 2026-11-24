'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-mig070-'));
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
const mig070 = require('../src/migrate/070_mark_hired_vehicles');
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

test('Setup fresh DB with owned + 5 hired vehicles, allocations, bills, rates & financial events', async () => {
  migrate();
  capabilities.seedCapabilities();

  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop', 'Peliyagoda', 1, 1)");
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (38, 'CEP03', 'Galagedara Site', 'galagedara site', 1)");
  run("INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active) VALUES ('tk-12', 'T12', 'Gala Pump', 'FIXED', 'AUTO_DIESEL', 20000, 12000, 38, 1)");

  run(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, asset_class, meter_type, current_project_id, status, in_register, ownership, created_at, updated_at)
    VALUES
      (100, 'DT-55', 'DT55', 'LO-7182', 'TATA', 'Dump Truck', 'vehicle', 'KM', 38, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1480, 'D4D-01', 'D4D01', NULL, NULL, 'JCB backhoe loader (hired)', 'plant', 'HOURS', 38, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1482, 'D4D-02', 'D4D02', NULL, NULL, 'JCB backhoe loader (hired)', 'plant', 'HOURS', 38, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1483, 'D4D-03', 'D4D03', NULL, NULL, 'JCB backhoe loader (hired)', 'plant', 'HOURS', 38, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (799, 'LO-4925', 'LO4925', NULL, NULL, NULL, 'vehicle', 'KM', 38, 'active', 0, 'OWNED', datetime('now'), datetime('now')),
      (987, 'SRS-03', 'SRS03', NULL, NULL, NULL, 'vehicle', NULL, 38, 'active', 0, 'OWNED', datetime('now'), datetime('now'))
  `);

  run(`
    INSERT INTO fleet_rental_rates (id, asset_id, category_name, rate_basis, rate_cents, dry_rate_cents, wet_rate_cents, equip_type, default_basis, fuel_cons_basis, fuel_cons_typ)
    VALUES
      ('r-100', 100, 'Dump Truck (Tipper)', 'KM', 9500, 9500, 12000, 'FLEET', 'WET', 'km', 0.217),
      ('r-1480', 1480, NULL, 'HOURLY', 200000, 200000, 280000, 'FLEET', 'WET', 'hr', 5),
      ('r-1482', 1482, NULL, 'HOURLY', 200000, 200000, 280000, 'FLEET', 'WET', 'hr', 5),
      ('r-1483', 1483, NULL, 'HOURLY', 200000, 200000, 280000, 'FLEET', 'WET', 'hr', 5),
      ('r-799', 799, 'Dump Truck (Tipper)', 'KM', 9500, 9500, 12000, 'FLEET', 'WET', 'km', 0.217),
      ('r-987', 987, 'VR', 'HOURLY', 280000, 0, 280000, 'FLEET', 'WET', 'hr', 3)
  `);

  run(`
    INSERT INTO fleet_vehicle_allocations (id, dedupe_key, asset_id, vehicle_no, project_id, site_name, month, owner_code, basis, origin, locked, is_current, active)
    VALUES
      ('va-1482', 'AUTO-1482-38-2026-10', 1482, 'D4D-02', 38, 'Galagedara Site', '2026-10', 'E&C', 'WET', 'AUTO_FUEL', 0, 0, 1),
      ('va-799', 'AUTO-799-38-2026-10', 799, 'LO-4925', 38, 'Galagedara Site', '2026-10', 'E&C', 'WET', 'AUTO_FUEL', 0, 0, 1),
      ('va-987', 'AUTO-987-38-2026-10', 987, 'SRS-03', 38, 'Galagedara Site', '2026-10', 'E&C', 'WET', 'AUTO_FUEL', 0, 0, 1)
  `);

  run(`
    INSERT INTO fleet_asset_assignments (id, asset_id, asset_code, project_id, start_date, billing_type, origin)
    VALUES ('as-799', 799, 'LO-4925', 38, '2026-10-01', 'WET', 'FUEL')
  `);

  run(`
    INSERT INTO fleet_bills (
      id, invoice_number, year, month, period_key, period_start, period_end,
      asset_id, asset_code, project_id, billing_mode, rate_basis, rate_cents,
      actual_units, minimum_units, billable_units, rental_amount_cents, subtotal_cents, sscl_cents, vat_cents, grand_total_cents, status
    ) VALUES
      ('b-100', 'INV-100', 2026, 11, '2026-11', '2026-11-01', '2026-11-30', 100, 'DT-55', 38, 'WET', 'KM', 12000, 3000, 3000, 3000, 36000000, 36000000, 0, 0, 36000000, 'FINAL'),
      ('b-1480', 'INV-1480', 2026, 11, '2026-11', '2026-11-01', '2026-11-30', 1480, 'D4D-01', 38, 'DRY', 'HOURLY', 200000, 120, 120, 120, 24000000, 24000000, 0, 0, 29028000, 'FINAL'),
      ('b-799', 'INV-799', 2026, 11, '2026-11', '2026-11-01', '2026-11-30', 799, 'LO-4925', 38, 'WET', 'KM', 12000, 3000, 3000, 3000, 36000000, 36000000, 0, 0, 36000000, 'FINAL'),
      ('b-987', 'INV-987', 2026, 11, '2026-11', '2026-11-01', '2026-11-30', 987, 'SRS-03', 38, 'WET', 'HOURLY', 280000, 120, 120, 120, 33600000, 33600000, 0, 0, 33600000, 'DRAFT')
  `);

  run(`
    INSERT INTO fleet_financial_events (
      id, event_key, event_type, asset_id, asset_code, project_id, business_date, year, month, amount_cents, source_table, source_id
    ) VALUES
      ('fe-rev-1480', 'FIN-REV-1480', 'REVENUE_RENTAL', 1480, 'D4D-01', 38, '2026-11-30', 2026, 11, 24000000, 'fleet_bills', 'b-1480'),
      ('fe-fuel-799', 'FIN-FUEL-799', 'REVENUE_FUEL', 799, 'LO-4925', 38, '2026-11-30', 2026, 11, 4116000, 'fleet_bills', 'b-799'),
      ('fe-exp-799', 'FIN-EXP-799', 'COST_MAINTENANCE_PARTS', 799, 'LO-4925', 38, '2026-11-15', 2026, 11, 150000, 'job_cards', 'jc-1'),
      ('fe-rev-100', 'FIN-REV-100', 'REVENUE_RENTAL', 100, 'DT-55', 38, '2026-11-30', 2026, 11, 36000000, 'fleet_bills', 'b-100')
  `);

  run(`
    INSERT INTO fuel_issues (id, asset_id, asset_code, vehicle_ref, fuel_type, litres, fuel_price_cents, total_cost_cents, issue_date, source_tank_id, project_id, is_voided)
    VALUES
      ('fi-dt55', 100, 'DT-55', 'LO-7182', 'AUTO_DIESEL', 80, 29400, 2352000, '2026-11-05', 'tk-12', 38, 0),
      ('fi-d4d02-1', 1482, 'D4D-02', 'D4D-02', 'AUTO_DIESEL', 50, 29400, 1470000, '2026-11-05', 'tk-12', 38, 0),
      ('fi-d4d02-2', 1482, 'D4D-02', 'D4D-02', 'AUTO_DIESEL', 60, 29400, 1764000, '2026-11-10', 'tk-12', 38, 0),
      ('fi-lo4925', 799, 'LO-4925', 'LO-4925', 'AUTO_DIESEL', 90, 29400, 2646000, '2026-11-06', 'tk-12', 38, 0),
      ('fi-srs03', 987, 'SRS-03', 'SRS-03', 'AUTO_DIESEL', 40, 29400, 1176000, '2026-11-08', 'tk-12', 38, 0)
  `);

  run("INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('admin', 'Administrator', 1, 1)");
  const adminRole = get("SELECT id FROM roles WHERE name = 'admin'");
  const pwHash = auth.hashPassword('HiredPass#2026!');
  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password) VALUES (1, 'admin070', ?, 'Admin User', 1, 0)", pwHash);
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
    body: { username: 'admin070', password: 'HiredPass#2026!' },
  });
  assert.equal(login.status, 200);
  adminCookie = login.headers.get('set-cookie').split(';')[0];
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { rawDb.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('Migration 070 marks 5 hired vehicles, voids bills/rates/revenue idempotently, and integrates with sync/summary/finance', async () => {
  const res1 = mig070.runMigration(rawDb);
  assert.equal(res1.assetsMarkedHired, 5);
  assert.equal(res1.ratesRemoved, 5);
  assert.equal(res1.allocsUpdated, 3);
  assert.equal(res1.assignmentsUpdated, 1);
  assert.equal(res1.billsVoided, 3);
  assert.equal(res1.revEventsRemoved, 2);

  // Verify assets
  for (const code of ['D4D-01', 'D4D-02', 'D4D-03', 'LO-4925', 'SRS-03']) {
    const a = get('SELECT * FROM assets WHERE code = ?', code);
    assert.equal(a.ownership, 'HIRED');
    assert.equal(a.in_register, 0);
  }
  const dt55 = get("SELECT * FROM assets WHERE code = 'DT-55'");
  assert.equal(dt55.ownership, 'OWNED');
  assert.equal(dt55.in_register, 1);

  // Owned asset rate, bill, and non-revenue expense event preserved
  assert.equal(all('SELECT * FROM fleet_rental_rates WHERE asset_id IN (1480,1482,1483,799,987)').length, 0);
  assert.equal(all('SELECT * FROM fleet_rental_rates WHERE asset_id = 100').length, 1);
  assert.equal(get("SELECT status FROM fleet_bills WHERE id = 'b-100'").status, 'FINAL');
  assert.equal(get("SELECT status FROM fleet_bills WHERE id = 'b-799'").status, 'VOID');
  assert.ok(get("SELECT * FROM fleet_financial_events WHERE id = 'fe-exp-799'"), 'Expense event should be preserved');
  assert.ok(get("SELECT * FROM fleet_financial_events WHERE id = 'fe-rev-100'"), 'Owned revenue event should be preserved');

  // Idempotency
  const res2 = mig070.runMigration(rawDb);
  assert.equal(res2.assetsMarkedHired, 0);
  assert.equal(res2.ratesRemoved, 0);
  assert.equal(res2.allocsUpdated, 0);
  assert.equal(res2.assignmentsUpdated, 0);
  assert.equal(res2.billsVoided, 0);
  assert.equal(res2.revEventsRemoved, 0);

  // Fuel-driven auto allocation assigns owner_code='HIRED', basis='BILLED_DIRECT' to hired assets
  fuelTimeline.syncFuelAllocations({ periodKey: '2026-11' });
  const a1482 = get("SELECT * FROM fleet_vehicle_allocations WHERE asset_id = 1482 AND month = '2026-11'");
  assert.equal(a1482.owner_code, 'HIRED');
  assert.equal(a1482.basis, 'BILLED_DIRECT');
  const a100 = get("SELECT * FROM fleet_vehicle_allocations WHERE asset_id = 100 AND month = '2026-11'");
  assert.equal(a100.owner_code, 'E&C');

  // Site summary excludes hired vehicles from billable lines & unrated, lists all 5 active ones in billedDirect
  const sum = siteSummary.buildSiteSummary(38, '2026-11');
  const lineCodes = new Set(sum.lines.map((l) => l.code));
  assert.ok(lineCodes.has('DT-55'));
  for (const h of ['D4D-01', 'D4D-02', 'D4D-03', 'LO-4925', 'SRS-03']) {
    assert.ok(!lineCodes.has(h), `${h} must not appear in bill lines`);
    assert.ok(!sum.unrated.includes(h), `${h} must not appear in unrated`);
    assert.ok(sum.billedDirect.includes(h), `${h} must appear in billedDirect`);
  }

  // Fleet profitability endpoint reports HIRED vs OWNED accurately
  const prof = await reqJson('/api/fleet/finance/vehicle-profitability?year=2026&month=11');
  assert.equal(prof.status, 200);
  const byCode = new Map((prof.body.report || []).map((v) => [v.assetCode, v]));
  assert.equal(byCode.get('DT-55').ownership, 'OWNED');
  assert.equal(byCode.get('LO-4925').ownership, 'HIRED');
  assert.equal(byCode.get('SRS-03').ownership, 'HIRED');
});
