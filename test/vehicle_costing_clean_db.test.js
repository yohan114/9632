'use strict';

// Regression tests ensuring Vehicle Costing & Profitability P&L, Fleet Finance,
// and Daily Conditions work cleanly on a freshly migrated database (the exact
// schema deployed on the live VPS) without legacy pre-V2 tables or columns:
//   - No `bills` / `bill_line_items` tables
//   - No `bulk_tanks` table
//   - No `daily_conditions` table
//   - No `issues.recipient_name` column

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-costing-clean-'));
process.env.DB_PATH = path.join(TMP, 'clean_vps.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const test = require('node:test');
const assert = require('node:assert');
const { migrate, db, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();

const PW = 'CleanDbTest#2026';
db.pragma('foreign_keys = OFF');
run("INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('admin', 'Admin', 1, 1)");
const adminRoleId = get("SELECT id FROM roles WHERE name = 'admin'").id;
const userId = Number(run(
  'INSERT INTO users (id, username, full_name, password_hash, active) VALUES (1, ?, ?, ?, 1)',
  'boss', 'System Boss', auth.hashPassword(PW)
).lastInsertRowid);
run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', userId, adminRoleId);

run("INSERT INTO projects (id, code, name) VALUES (1, 'P1', 'Badalgama Plant')");
run(
  "INSERT INTO assets (id, code, code_norm, registration, category, current_project_id) VALUES (1, 'TRK-001', 'TRK001', 'WP-1234', 'Truck', 1)"
);
run("INSERT INTO fuel_tanks (id, code, name, active) VALUES (1, 'TK1', 'Main Tank', 1)");

// Active store issue (qty=2 * 2500 = 5000) + voided issue (excluded)
run(
  "INSERT INTO issues (id, min_no, asset_id, description, qty, unit, unit_price, issue_date, issued_by, voided) VALUES (1, 'MIN-1', 1, 'Oil Filter', 2, 'pcs', 2500, '2026-11-15', 'Storekeeper', 0)"
);
run(
  "INSERT INTO issues (id, min_no, asset_id, description, qty, unit, unit_price, issue_date, issued_by, voided) VALUES (2, 'MIN-2', 1, 'Voided Part', 10, 'pcs', 9999, '2026-11-16', 'Storekeeper', 1)"
);

// Fuel issue 1: total_cost_cents populated (15,000 LKR, 50 L, source_tank_id=1)
run(
  "INSERT INTO fuel_issues (id, issue_no, issue_date, asset_id, asset_code, vehicle_ref, fuel_type, source_tank_id, litres, fuel_price_cents, total_cost_cents, is_voided) VALUES (1, 'FI-1', '2026-11-15', 1, 'TRK-001', 'WP-1234', 'AUTO_DIESEL', 1, 50, 30000, 1500000, 0)"
);
// Fuel issue 2: total_cost_cents=0, fallback to cost_cents=600000 (6,000 LKR, 20 L, bulk_tank_id='1')
run(
  "INSERT INTO fuel_issues (id, issue_no, issue_date, asset_id, asset_code, vehicle_ref, fuel_type, bulk_tank_id, litres, fuel_price_cents, price_per_litre_cents, total_cost_cents, cost_cents, is_voided) VALUES (2, 'FI-2', '2026-11-18', 1, 'TRK-001', 'WP-1234', 'AUTO_DIESEL', '1', 20, 0, 30000, 0, 600000, 0)"
);

// Fleet rental bill for 2026-11: 100,000 LKR
run(
  `INSERT INTO fleet_bills (
    id, invoice_number, year, month, period_key, period_start, period_end,
    asset_id, asset_code, project_id, project_name, billing_mode, rate_basis,
    rate_cents, actual_units, minimum_units, billable_units, rental_amount_cents,
    subtotal_cents, sscl_cents, vat_cents, grand_total_cents, status
  ) VALUES (
    'fb-1', 'INV-2026-11-001', 2026, 11, '2026-11', '2026-11-01', '2026-11-30',
    1, 'TRK-001', 1, 'Badalgama Plant', 'DRY', 'MONTHLY',
    10000000, 1, 1, 1, 10000000,
    10000000, 0, 0, 10000000, 'FINAL'
  )`
);
db.pragma('foreign_keys = ON');

const app = require('../src/server');
let server;
let base;
let cookie;

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: PW }),
  });
  assert.strictEqual(r.status, 200, 'admin login should succeed');
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
});

test.after(() => {
  if (server) server.close();
  try { db.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

async function api(p, opts = {}) {
  const r = await fetch(`${base}/api${p}`, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let body = text;
  try { body = JSON.parse(text); } catch {}
  return { status: r.status, body };
}

test('clean migrated DB has no legacy bills/bulk_tanks/daily_conditions tables or issues.recipient_name', () => {
  for (const tbl of ['bills', 'bill_line_items', 'bulk_tanks', 'daily_conditions']) {
    assert.strictEqual(
      get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", tbl),
      undefined,
      `legacy table ${tbl} should not exist on clean DB`
    );
  }
  const issueCols = all('PRAGMA table_info(issues)').map((c) => c.name);
  assert.ok(!issueCols.includes('recipient_name'), 'issues.recipient_name should not exist on clean DB');
});

test('vehicle-costing fleet-summary, single-vehicle, and report succeed with accurate totals', async () => {
  const sum = await api('/vehicle-costing/fleet-summary?month=2026-11');
  assert.strictEqual(sum.status, 200, JSON.stringify(sum.body));
  assert.strictEqual(sum.body.totals.total_hiring_revenue, 100000);
  assert.strictEqual(sum.body.totals.total_repair_cost, 5000);
  assert.strictEqual(sum.body.totals.total_diesel_cost, 21000);
  assert.strictEqual(sum.body.totals.total_diesel_litres, 70);
  assert.strictEqual(sum.body.totals.total_net_profit, 74000);

  for (const ep of [
    '/vehicle-costing/single-vehicle?asset_id=1&month=2026-11',
    '/vehicle-costing/report?asset_id=1&month=2026-11',
  ]) {
    const rep = await api(ep);
    assert.strictEqual(rep.status, 200, `${ep}: ${JSON.stringify(rep.body)}`);
    assert.strictEqual(rep.body.summary.hiring_revenue, 100000);
    assert.strictEqual(rep.body.summary.repair_cost, 5000);
    assert.strictEqual(rep.body.summary.diesel_cost, 21000);
    assert.strictEqual(rep.body.summary.diesel_litres, 70);
    assert.strictEqual(rep.body.summary.net_profit, 74000);
    assert.strictEqual(rep.body.breakdown.repair_costs.store_issues.length, 1);
    assert.strictEqual(rep.body.breakdown.diesel_costs.issues.length, 2);
    assert.ok(rep.body.breakdown.diesel_costs.issues.every((f) => f.tank_name === 'Main Tank'));
  }
});

test('vehicle-costing hiring-revenue and driver-costs CRUD round-trips succeed', async () => {
  const addRev = await api('/vehicle-costing/hiring-revenue', {
    method: 'POST',
    body: { asset_id: 1, month: '2026-11', quantity: 10, hire_rate: 500, notes: 'Clean DB test' },
  });
  assert.strictEqual(addRev.status, 200, JSON.stringify(addRev.body));
  const listRev = await api('/vehicle-costing/hiring-revenue?month=2026-11');
  assert.strictEqual(listRev.status, 200, JSON.stringify(listRev.body));
  assert.ok(listRev.body.rows.length >= 2);
  const delRev = await api(`/vehicle-costing/hiring-revenue/${addRev.body.id}`, { method: 'DELETE' });
  assert.strictEqual(delRev.status, 200, JSON.stringify(delRev.body));

  const addDrv = await api('/vehicle-costing/driver-costs', {
    method: 'POST',
    body: { asset_id: 1, month: '2026-11', driver_name: 'Nimal', driver_salary: 12000, bata_ot: 3000 },
  });
  assert.strictEqual(addDrv.status, 200, JSON.stringify(addDrv.body));
  const listDrv = await api('/vehicle-costing/driver-costs?month=2026-11');
  assert.strictEqual(listDrv.status, 200, JSON.stringify(listDrv.body));
  assert.strictEqual(listDrv.body.rows.length, 1);
  const delDrv = await api(`/vehicle-costing/driver-costs/${addDrv.body.id}`, { method: 'DELETE' });
  assert.strictEqual(delDrv.status, 200, JSON.stringify(delDrv.body));
});

test('fleet profitability JSON and XLSX endpoints succeed on clean DB', async () => {
  const pnl = await api('/fleet/finance/vehicle-profitability?period=2026-11');
  assert.strictEqual(pnl.status, 200, JSON.stringify(pnl.body));
  const xlsxRes = await fetch(`${base}/api/fleet/finance/vehicle-profitability.xlsx?period=2026-11`, {
    headers: { cookie },
  });
  assert.strictEqual(xlsxRes.status, 200);
});

test('meters daily conditions GET and POST succeed without legacy daily_conditions table', async () => {
  const postCond = await api('/meters/conditions', {
    method: 'POST',
    body: { asset_id: 1, project_id: 1, condition_date: '2026-11-20', state: 'WORKING', notes: 'Clean DB ok' },
  });
  assert.strictEqual(postCond.status, 200, JSON.stringify(postCond.body));

  const getCond = await api('/meters/conditions?date=2026-11-20');
  assert.strictEqual(getCond.status, 200, JSON.stringify(getCond.body));
  assert.strictEqual(getCond.body.rows.length, 1);
  assert.strictEqual(getCond.body.rows[0].asset_code, 'TRK-001');
  assert.strictEqual(getCond.body.rows[0].state, 'WORKING');
  assert.strictEqual(getCond.body.rows[0].project_name, 'Badalgama Plant');
});
