'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-stage-a-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.CEYPETCO_SYNC_ENABLED = 'false';
delete process.env.MULTIDB;

const { rawDb, migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const mig076 = require('../src/migrate/076_stage_a_financial_accuracy');
const app = require('../src/server');

let server;
let baseUrl;
let adminCookie;
let viewerCookie;

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
  assert.ok(setCookie);
  return setCookie.split(';')[0];
}

test('Setup Stage A fixtures & auth users', async () => {
  migrate();
  capabilities.seedCapabilities();

  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop', 'Peliyagoda', 1, 1)");
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (14, 'Badalgama Plant', 'Badalgama Plant', 'badalgama plant', 1)");
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (38, 'CEP-03F', 'CEP-03 F (Galagedara)', 'cep03f', 1)");

  run(`
    INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active)
    VALUES
      ('tk-14', 'TK-14', 'Badalgama Tank', 'BOWSER', 'AUTO_DIESEL', 15000, 8000, 14, 1),
      ('tk-38', 'TK-38', 'CEP-03F Tank', 'BOWSER', 'AUTO_DIESEL', 15000, 8000, 38, 1)
  `);

  run(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, asset_class, ownership, meter_type, current_project_id, status, in_register, created_at, updated_at)
    VALUES
      (201, 'DT-201', 'DT201', 'DT-201', 'Sinotruk', 'Dump Truck (Tipper)', 'vehicle', 'OWNED', 'KM', 14, 'active', 1, datetime('now'), datetime('now')),
      (202, 'EX-202', 'EX202', 'EX-202', 'CASE', 'Excavator', 'vehicle', 'OWNED', 'HOURS', 14, 'active', 1, datetime('now'), datetime('now')),
      (203, 'EX-203', 'EX203', 'EX-203', 'CAT', 'Excavator', 'vehicle', 'OWNED', 'HOURS', 38, 'active', 1, datetime('now'), datetime('now')),
      (204, 'BD-204', 'BD204', 'BD-204', 'KOMATSU', 'Bulldozer', 'vehicle', 'OWNED', 'HOURS', 38, 'active', 1, datetime('now'), datetime('now')),
      (205, 'HEX-47', 'HEX47', 'HEX-47', 'Quick Added', 'Other Asset', 'vehicle', 'OWNED', 'HOURS', 14, 'active', 1, datetime('now'), datetime('now')),
      (206, 'LT-19', 'LT19', 'LT-19', 'Quick Added', 'Light Plant', 'vehicle', 'OWNED', 'HOURS', 14, 'active', 1, datetime('now'), datetime('now')),
      (207, 'HIRED-01', 'HIRED01', 'HIRED-01', 'Private', 'Double Cab', 'vehicle', 'OWNED', 'KM', 14, 'active', 1, datetime('now'), datetime('now')),
      (208, 'SITE-WCP', 'SITEWCP', 'SITE-WCP', 'Site Storage', 'Project Site', 'vehicle', 'OWNED', 'KM', 14, 'active', 0, datetime('now'), datetime('now'))
  `);

  run(`
    INSERT INTO fleet_rental_rates (
      id, asset_id, category_name, rate_basis, rate_cents, dry_rate_cents, wet_rate_cents, fully_wet_rate_cents,
      min_bill_hours, equip_type, default_basis, fuel_cons_basis, fuel_cons_typ,
      hr_dry_cents, hr_wet_cents, hr_fw_cents, km_dry_cents, km_wet_cents, km_fw_cents
    ) VALUES
      ('rate-asset-201', 201, 'Dump Truck (Tipper)', 'KM', 9500, 9500, 12000, 23000, 3000, 'FLEET', 'WET', 'km', 0.25, NULL, NULL, NULL, 9500, 12000, 23000),
      ('rate-asset-202', 202, 'Excavator', 'HOURLY', 473000, 473000, 1051000, 1051000, 120, 'FLEET', 'WET', 'hr', 13.7, 473000, 1051000, 1051000, NULL, NULL, NULL),
      ('rate-asset-203', 203, 'Excavator', 'HOURLY', 473000, 473000, 1051000, 1051000, 120, 'FLEET', 'WET', 'hr', 13.7, 473000, 1051000, 1051000, NULL, NULL, NULL),
      ('rate-asset-204', 204, 'Bulldozer', 'HOURLY', 300000, 300000, 600000, 600000, 120, 'FLEET', 'WET', 'hr', 15.0, 300000, 600000, 600000, NULL, NULL, NULL)
  `);

  run("INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('admin', 'Administrator', 1, 1)");
  const adminRole = get("SELECT id FROM roles WHERE name = 'admin'");
  run("INSERT INTO roles (id, name, label, is_system, active) VALUES (59, 'bill_viewer', 'Billing Viewer', 0, 1)");
  for (const cap of ['fuel.view', 'fuel.prices.view', 'hire.billing.view', 'hire.rates.view']) {
    run("INSERT OR REPLACE INTO role_capabilities (role, capability, granted) VALUES ('bill_viewer', ?, 1)", cap);
  }
  run("INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES ('bill_viewer', 'fuel', 'view')");
  run("INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES ('bill_viewer', 'fuel_prices', 'view')");
  run("INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES ('bill_viewer', 'hire_billing', 'view')");

  const pwHash = auth.hashPassword('TestPass#2026!');
  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password) VALUES (1, 'admin_sa', ?, 'Admin StageA', 1, 0)", pwHash);
  run('INSERT INTO user_roles (user_id, role_id) VALUES (1, ?)', adminRole.id);
  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password) VALUES (2, 'viewer_sa', ?, 'Viewer StageA', 1, 0)", pwHash);
  run('INSERT INTO user_roles (user_id, role_id) VALUES (2, 59)');

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  adminCookie = await loginAs('admin_sa', 'TestPass#2026!');
  viewerCookie = await loginAs('viewer_sa', 'TestPass#2026!');
});

test('Fuel tariff re-price preview and apply updates slips + DRAFT bills while preserving FINAL bills & manual overrides', async () => {
  run(`
    INSERT INTO fuel_prices (fuel_type, fuel_kind, price_per_litre_cents, price_per_litre, effective_date, source, notes)
    VALUES
      ('AUTO_DIESEL', 'AUTO_DIESEL', 39200, 392.0, '2026-10-01', 'CEYPETCO_AUTO', 'Oct tariff'),
      ('AUTO_DIESEL', 'AUTO_DIESEL', 39700, 397.0, '2026-11-02', 'CEYPETCO_AUTO', 'Nov 2 tariff')
  `);

  run(`
    INSERT INTO fuel_issues (
      id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, fuel_kind, litres,
      fuel_price_cents, price_per_litre_cents, unit_price, total_cost_cents, cost_cents, total_price,
      issue_date, source_tank_id, bulk_tank_id, target_project_id, project_id, is_voided, is_manual, is_direct_billed
    ) VALUES
      ('fi-nov1', 'FI-N1', 201, 'DT-201', 'DT-201', 'AUTO_DIESEL', 'AUTO_DIESEL', 50, 39200, 39200, 392, 1960000, 1960000, 19600, '2026-11-01 10:00:00', 'tk-14', 'tk-14', 14, 14, 0, 0, 0),
      ('fi-nov3', 'FI-N3', 201, 'DT-201', 'DT-201', 'AUTO_DIESEL', 'AUTO_DIESEL', 100, 39200, 39200, 392, 3920000, 3920000, 39200, '2026-11-03 10:00:00', 'tk-14', 'tk-14', 14, 14, 0, 0, 0),
      ('fi-nov5-man', 'FI-N5M', 201, 'DT-201', 'DT-201', 'AUTO_DIESEL', 'AUTO_DIESEL', 20, 39000, 39000, 390, 780000, 780000, 7800, '2026-11-05 10:00:00', 'tk-14', 'tk-14', 14, 14, 0, 1, 0),
      ('fi-nov4-fin', 'FI-N4F', 202, 'EX-202', 'EX-202', 'AUTO_DIESEL', 'AUTO_DIESEL', 40, 39200, 39200, 392, 1568000, 1568000, 15680, '2026-11-04 10:00:00', 'tk-14', 'tk-14', 14, 14, 0, 0, 0)
  `);

  // One DRAFT bill (DT-201, total 170L -> old cost 1960000+3920000+780000 = 6660000) and one FINAL bill (EX-202, 40L -> 1568000)
  run(`
    INSERT INTO fleet_bills (
      id, invoice_number, year, month, period_key, period_start, period_end,
      asset_id, asset_code, project_id, project_name, project_code,
      billing_mode, rate_basis, rate_cents, actual_units, minimum_units, billable_units,
      rental_amount_cents, fuel_litres, fuel_cost_cents, breakdown_days, breakdown_deduct_cents,
      subtotal_cents, sscl_rate, sscl_cents, vat_rate, vat_cents, grand_total_cents, status
    ) VALUES
      ('b-dt201', NULL, 2026, 11, '2026-11', '2026-11-01', '2026-11-30', 201, 'DT-201', 14, 'Badalgama Plant', 'Badalgama Plant',
       'WET', 'KM', 12000, 3000, 3000, 3000, 36000000, 170, 6660000, 0, 0, 42660000, 0.025, 1066500, 0.18, 7870770, 51597270, 'DRAFT'),
      ('b-ex202', 'INV-202611-EX202', 2026, 11, '2026-11', '2026-11-01', '2026-11-30', 202, 'EX-202', 14, 'Badalgama Plant', 'Badalgama Plant',
       'WET', 'HOURLY', 1051000, 120, 120, 120, 126120000, 40, 1568000, 0, 0, 127688000, 0.025, 3192200, 0.18, 23558436, 154438636, 'FINAL')
  `);
  run(`
    INSERT INTO fleet_bill_line_items (id, bill_id, item_type, description, quantity, unit_price_cents, amount_cents, is_deduction)
    VALUES ('li-b-dt201-fuel', 'b-dt201', 'FUEL', 'Fuel Recharge (170 Litres @ Rs 391.76)', 170, 39176, 6660000, 0)
  `);

  // Viewer is denied
  const denied = await reqJson('/api/fuel/prices/reprice-preview', {
    method: 'POST',
    cookie: viewerCookie,
    body: { fromDate: '2026-11-01', toDate: '2026-11-30' },
  });
  assert.equal(denied.status, 403);

  // Preview excludes Nov 1 (already 39200) and Nov 5 manual, leaves 2 eligible (140 L: fi-nov3 + fi-nov4-fin)
  const prev = await reqJson('/api/fuel/prices/reprice-preview', {
    method: 'POST',
    body: { fromDate: '2026-11-01', toDate: '2026-11-30', fuelType: 'AUTO_DIESEL', includeManual: false },
  });
  assert.equal(prev.status, 200);
  assert.equal(prev.body.eligibleCount, 2);
  assert.equal(prev.body.totalLitres, 140);
  assert.equal(prev.body.deltaCostCents, 140 * 500);
  assert.equal(prev.body.skippedManualCount, 1);
  assert.equal(prev.body.unchangedCount, 1);
  assert.equal(prev.body.impactedDraftBillsCount, 1);
  assert.equal(prev.body.impactedFinalBillsCount, 1);

  const appRes = await reqJson('/api/fuel/prices/reprice-apply', {
    method: 'POST',
    body: { fromDate: '2026-11-01', toDate: '2026-11-30', fuelType: 'AUTO_DIESEL', includeManual: false, reason: 'Align Nov 2 tariff' },
  });
  assert.equal(appRes.status, 200);
  assert.equal(appRes.body.repricedCount, 2);
  assert.equal(appRes.body.draftBillsUpdated, 1);

  const nov3 = get("SELECT fuel_price_cents, price_per_litre_cents, unit_price, total_cost_cents, cost_cents, total_price FROM fuel_issues WHERE id = 'fi-nov3'");
  assert.equal(nov3.fuel_price_cents, 39700);
  assert.equal(nov3.price_per_litre_cents, 39700);
  assert.equal(nov3.unit_price, 397);
  assert.equal(nov3.total_cost_cents, 3970000);
  assert.equal(nov3.cost_cents, 3970000);
  assert.equal(nov3.total_price, 39700);

  const nov5 = get("SELECT price_per_litre_cents FROM fuel_issues WHERE id = 'fi-nov5-man'");
  assert.equal(nov5.price_per_litre_cents, 39000); // manual untouched

  // DRAFT bill updated: 1960000 + 3970000 + 780000 = 6710000 fuel cost (+50000 cents)
  const draftAfter = get("SELECT * FROM fleet_bills WHERE id = 'b-dt201'");
  assert.equal(draftAfter.fuel_cost_cents, 6710000);
  assert.equal(draftAfter.subtotal_cents, 36000000 + 6710000);
  const fuelLineAfter = get("SELECT amount_cents, unit_price_cents FROM fleet_bill_line_items WHERE bill_id = 'b-dt201' AND item_type = 'FUEL'");
  assert.equal(fuelLineAfter.amount_cents, 6710000);

  // FINAL bill untouched
  const finalAfter = get("SELECT fuel_cost_cents, grand_total_cents FROM fleet_bills WHERE id = 'b-ex202'");
  assert.equal(finalAfter.fuel_cost_cents, 1568000);
  assert.equal(finalAfter.grand_total_cents, 154438636);

  const auditCnt = get("SELECT COUNT(*) n FROM audit_log WHERE entity = 'fuel_price' AND action = 'fuel.issues.repriced'").n;
  assert.equal(auditCnt, 1);
});

test('Site-batch finalisation & period locks enforce immutability and audit trail', async () => {
  // Open breakdown on BD-204 for 2026-11 -> EX-203 should finalise, BD-204 should skip in site 38
  run(`
    INSERT INTO fleet_bills (
      id, invoice_number, year, month, period_key, period_start, period_end,
      asset_id, asset_code, project_id, project_name, project_code,
      billing_mode, rate_basis, rate_cents, actual_units, minimum_units, billable_units,
      rental_amount_cents, fuel_litres, fuel_cost_cents, breakdown_days, breakdown_deduct_cents,
      subtotal_cents, sscl_rate, sscl_cents, vat_rate, vat_cents, grand_total_cents, status
    ) VALUES
      ('b-ex203', NULL, 2026, 11, '2026-11', '2026-11-01', '2026-11-30', 203, 'EX-203', 38, 'CEP-03 F (Galagedara)', 'CEP-03F',
       'WET', 'HOURLY', 1051000, 120, 120, 120, 126120000, 50, 1985000, 0, 0, 128105000, 0.025, 3202625, 0.18, 23635372, 154942997, 'DRAFT'),
      ('b-bd204', NULL, 2026, 11, '2026-11', '2026-11-01', '2026-11-30', 204, 'BD-204', 38, 'CEP-03 F (Galagedara)', 'CEP-03F',
       'WET', 'HOURLY', 600000, 0, 120, 120, 72000000, 0, 0, 0, 0, 72000000, 0.025, 1800000, 0.18, 13284000, 87084000, 'DRAFT')
  `);
  run(`
    INSERT INTO fleet_breakdowns (id, asset_id, asset_code, project_id, breakdown_start, breakdown_end, status, reason)
    VALUES ('bd-open-204', 204, 'BD-204', 38, '2026-11-10', NULL, 'OPEN', 'Engine rebuild')
  `);

  const site38Fin = await reqJson('/api/hire/bills/finalise-site', {
    method: 'POST',
    body: { projectId: 38, periodKey: '2026-11', lockAfter: true, lockReason: 'Nov close' },
  });
  assert.equal(site38Fin.status, 200);
  assert.equal(site38Fin.body.finalisedCount, 1);
  assert.equal(site38Fin.body.skippedBreakdowns.length, 1);
  assert.equal(site38Fin.body.locked, false); // blocked because BD-204 was skipped

  const ex203After = get("SELECT status, invoice_number FROM fleet_bills WHERE id = 'b-ex203'");
  assert.equal(ex203After.status, 'FINAL');
  assert.ok(ex203After.invoice_number);
  const finEv = get("SELECT COUNT(*) n FROM fleet_financial_events WHERE source_id = 'b-ex203'");
  assert.equal(finEv.n, 2); // REVENUE_RENTAL + REVENUE_FUEL

  // Now close Site 14 cleanly (DT-201 DRAFT -> FINAL) with lockAfter = true
  const site14Fin = await reqJson('/api/hire/bills/finalise-site', {
    method: 'POST',
    body: { projectId: 14, periodKey: '2026-11', lockAfter: true, lockReason: 'Approved Badalgama Nov' },
  });
  assert.equal(site14Fin.status, 200);
  assert.equal(site14Fin.body.finalisedCount, 1);
  assert.equal(site14Fin.body.locked, true);

  // Verify GET /api/hire/bills summary carries is_locked
  const billsRes = await reqJson('/api/hire/bills?periodKey=2026-11');
  assert.equal(billsRes.status, 200);
  const row14 = billsRes.body.summaryBySiteMonth.find((s) => Number(s.project_id) === 14);
  assert.ok(row14 && row14.is_locked);

  // Verify lock blocks generate, revise, finalise, and retroactive re-pricing
  const blockedGen = await reqJson('/api/hire/bills/generate', {
    method: 'POST',
    body: { assetId: 201, year: 2026, month: 11, projectId: 14, actualUnits: 120, rateCents: 12000 },
  });
  assert.equal(blockedGen.status, 409);
  assert.equal(blockedGen.body.periodLocked, true);

  const blockedRev = await reqJson('/api/hire/bills/b-dt201/revise', {
    method: 'POST',
    body: { actualUnits: 150, reason: 'Try revise locked' },
  });
  assert.equal(blockedRev.status, 409);
  assert.equal(blockedRev.body.periodLocked, true);

  // Add a Nov 6 slip at site 14 with stale 39200 and verify reprice-apply skips locked period
  run(`
    INSERT INTO fuel_issues (
      id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, fuel_kind, litres,
      fuel_price_cents, price_per_litre_cents, unit_price, total_cost_cents, cost_cents, total_price,
      issue_date, source_tank_id, bulk_tank_id, target_project_id, project_id, is_voided, is_manual, is_direct_billed
    ) VALUES
      ('fi-nov6-locked', 'FI-N6L', 201, 'DT-201', 'DT-201', 'AUTO_DIESEL', 'AUTO_DIESEL', 30, 39200, 39200, 392, 1176000, 1176000, 11760, '2026-11-06 10:00:00', 'tk-14', 'tk-14', 14, 14, 0, 0, 0)
  `);
  const lockedPrev = await reqJson('/api/fuel/prices/reprice-preview', {
    method: 'POST',
    body: { fromDate: '2026-11-06', toDate: '2026-11-06', projectId: 14 },
  });
  assert.equal(lockedPrev.status, 200);
  assert.equal(lockedPrev.body.eligibleCount, 0);
  assert.equal(lockedPrev.body.skippedLockedCount, 1);

  // Unlock without reason fails 400; unlock with reason succeeds
  const badUnlock = await reqJson('/api/hire/period-locks', {
    method: 'POST',
    body: { periodKey: '2026-11', projectId: 14, locked: false, reason: '' },
  });
  assert.equal(badUnlock.status, 400);

  const okUnlock = await reqJson('/api/hire/period-locks', {
    method: 'POST',
    body: { periodKey: '2026-11', projectId: 14, locked: false, reason: 'Allow Nov 6 slip reprice' },
  });
  assert.equal(okUnlock.status, 200);
  assert.equal(okUnlock.body.locked, false);

  const unlockedPrev = await reqJson('/api/fuel/prices/reprice-preview', {
    method: 'POST',
    body: { fromDate: '2026-11-06', toDate: '2026-11-06', projectId: 14 },
  });
  assert.equal(unlockedPrev.body.eligibleCount, 1);
});

test('Unrated active machines queue: assign template and mark hired', async () => {
  const today = new Date().toISOString().slice(0, 10);
  run(`
    INSERT INTO fuel_issues (
      id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, litres,
      fuel_price_cents, price_per_litre_cents, total_cost_cents, issue_date,
      source_tank_id, bulk_tank_id, target_project_id, project_id, is_voided, is_direct_billed
    ) VALUES
      ('fi-u1', 'FI-U1', 205, 'HEX-47', 'HEX-47', 'AUTO_DIESEL', 150, 39700, 39700, 5955000, '${today} 08:00:00', 'tk-14', 'tk-14', 14, 14, 0, 0),
      ('fi-u2', 'FI-U2', 207, 'HIRED-01', 'HIRED-01', 'AUTO_DIESEL', 60, 39700, 39700, 2382000, '${today} 09:00:00', 'tk-14', 'tk-14', 14, 14, 0, 0)
  `);
  run(`
    INSERT INTO fleet_bills (
      id, year, month, period_key, period_start, period_end,
      asset_id, asset_code, project_id, project_name, project_code,
      billing_mode, rate_basis, rate_cents, actual_units, minimum_units, billable_units,
      rental_amount_cents, fuel_litres, fuel_cost_cents, subtotal_cents, sscl_rate, sscl_cents, vat_rate, vat_cents, grand_total_cents, status
    ) VALUES
      ('b-hired-draft', 2026, 11, '2026-11', '2026-11-01', '2026-11-30', 207, 'HIRED-01', 14, 'Badalgama Plant', 'Badalgama Plant',
       'WET', 'KM', 7000, 0, 3000, 3000, 21000000, 60, 2382000, 23382000, 0.025, 584550, 0.18, 4313979, 28279529, 'DRAFT')
  `);

  const qRes = await reqJson('/api/hire/rates-unrated');
  assert.equal(qRes.status, 200);
  const codes = qRes.body.unrated.map((u) => u.asset_code);
  assert.ok(codes.includes('HEX-47'));
  assert.ok(codes.includes('LT-19'));
  assert.ok(codes.includes('HIRED-01'));
  assert.ok(!codes.includes('SITE-WCP'), 'Pseudo-asset SITE-WCP must be excluded');
  assert.ok(qRes.body.unrated.indexOf(qRes.body.unrated.find((u) => u.asset_code === 'HEX-47')) <
    qRes.body.unrated.indexOf(qRes.body.unrated.find((u) => u.asset_code === 'LT-19')));

  const excTpl = qRes.body.templates.find((t) => t.category === 'Excavator');
  assert.ok(excTpl);

  // Assign Excavator template to HEX-47
  const assignRes = await reqJson('/api/hire/rates/assign-template', {
    method: 'POST',
    body: { assetId: 205, templateRateId: excTpl.template_rate_id },
  });
  assert.equal(assignRes.status, 201);
  assert.equal(assignRes.body.categoryName, 'Excavator');
  const hexAsset = get('SELECT type, meter_type FROM assets WHERE id = 205');
  assert.equal(hexAsset.type, 'Excavator');
  assert.equal(hexAsset.meter_type, 'HOURS');

  // Mark HIRED-01 as HIRED
  const hiredRes = await reqJson('/api/hire/rates/mark-hired', {
    method: 'POST',
    body: { assetId: 207, flagDirectBilledFuel: true, reason: 'Outside subcontractor' },
  });
  assert.equal(hiredRes.status, 200);
  assert.equal(hiredRes.body.draftsVoided, 1);
  assert.equal(hiredRes.body.fuelFlagged, 1);

  const hiredAsset = get('SELECT ownership, in_register FROM assets WHERE id = 207');
  assert.equal(hiredAsset.ownership, 'HIRED');
  assert.equal(hiredAsset.in_register, 0);
  assert.equal(get("SELECT status FROM fleet_bills WHERE id = 'b-hired-draft'").status, 'VOID');
  assert.equal(get("SELECT is_direct_billed FROM fuel_issues WHERE id = 'fi-u2'").is_direct_billed, 1);

  const qAfter = await reqJson('/api/hire/rates-unrated');
  const codesAfter = qAfter.body.unrated.map((u) => u.asset_code);
  assert.ok(!codesAfter.includes('HEX-47'));
  assert.ok(!codesAfter.includes('HIRED-01'));
  assert.ok(codesAfter.includes('LT-19'));
});

test('Migration 076 is idempotent and handles pseudo-assets, DAI-9758, and Nov 2+ re-pricing', () => {
  const mDbPath = path.join(TMP, 'mig076.db');
  const srcSchemaDb = new Database(process.env.DB_PATH, { readonly: true });
  const ddlRows = srcSchemaDb.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'").all();
  srcSchemaDb.close();

  const mDb = new Database(mDbPath);
  for (const r of ddlRows) {
    try { mDb.exec(r.sql); } catch {}
  }

  mDb.prepare("INSERT INTO projects (id, code, name, name_norm, active) VALUES (14, 'Badalgama Plant', 'Badalgama Plant', 'badalgama plant', 1)").run();
  mDb.prepare("INSERT INTO projects (id, code, name, name_norm, active) VALUES (38, 'CEP-03F', 'CEP-03 F (Galagedara)', 'cep03f', 1)").run();
  mDb.prepare("INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active) VALUES ('tk-bgp', 'TK-BGP', 'Badalgama Tank', 'BOWSER', 'AUTO_DIESEL', 15000, 5000, 14, 1)").run();
  mDb.prepare(`
    INSERT INTO fuel_prices (fuel_type, fuel_kind, price_per_litre_cents, price_per_litre, effective_date, source, notes)
    VALUES
      ('AUTO_DIESEL', 'AUTO_DIESEL', 39200, 392, '2026-10-01', 'Auto-fetched from ceypetco.gov.lk', 'Oct'),
      ('AUTO_DIESEL', 'AUTO_DIESEL', 39700, 397, '2026-11-02', 'CEYPETCO_AUTO', 'Nov')
  `).run();

  mDb.prepare(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, model_no, asset_class, ownership, in_register, status, current_project_id)
    VALUES
      (1410, 'SITE-WCP', 'SITEWCP', 'SITE-WCP', 'Site Storage', 'Project Site', NULL, 'vehicle', 'OWNED', 1, 'active', 14),
      (1625, 'TRANSFER-RUHUNU-CONSTRUCTION', 'TRANSFERRUHUNU', NULL, NULL, 'Fuel transferred', NULL, 'vehicle', 'OWNED', 1, 'active', 38),
      (1369, 'DAI-9758', 'DAI9758', 'Badalgama Plant', 'Bolero', 'Mahindra', NULL, 'vehicle', 'OWNED', 1, 'active', 14),
      (1001, 'DT-10', 'DT10', 'DT-10', 'Sinotruk', 'Dump Truck (Tipper)', NULL, 'vehicle', 'OWNED', 1, 'active', 14)
  `).run();

  mDb.prepare(`
    INSERT INTO fleet_bills (
      id, year, month, period_key, period_start, period_end,
      asset_id, asset_code, project_id, project_name, project_code,
      billing_mode, rate_basis, rate_cents, actual_units, minimum_units, billable_units,
      rental_amount_cents, fuel_litres, fuel_cost_cents, subtotal_cents, sscl_rate, sscl_cents, vat_rate, vat_cents, grand_total_cents, status
    ) VALUES
      ('bill-draft-2026-11-p14-a1001', 2026, 11, '2026-11', '2026-11-01', '2026-11-30',
       1001, 'DT-10', 14, 'Badalgama Plant', 'Badalgama Plant',
       'WET', 'KM', 12000, 3000, 3000, 3000, 36000000, 100, 3920000, 39920000, 0.025, 998000, 0.18, 7365240, 48283240, 'DRAFT')
  `).run();

  mDb.prepare(`
    INSERT INTO fuel_issues (
      id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, fuel_kind, litres,
      fuel_price_cents, price_per_litre_cents, unit_price, total_cost_cents, cost_cents, total_price,
      issue_date, source_tank_id, bulk_tank_id, target_project_id, project_id, is_voided, is_manual, is_direct_billed
    ) VALUES
      ('mfi-dt10', 'MFI-1', 1001, 'DT-10', 'DT-10', 'AUTO_DIESEL', 'AUTO_DIESEL', 100, 39200, 39200, 392, 3920000, 3920000, 39200, '2026-11-05 08:00:00', 'tk-bgp', 'tk-bgp', 14, 14, 0, 0, 0),
      ('mfi-dai-oct', 'MFI-2', 1369, 'DAI-9758', 'DAI-9758', 'AUTO_DIESEL', 'AUTO_DIESEL', 50, 39200, 39200, 392, 1960000, 1960000, 19600, '2026-10-15 08:00:00', 'tk-bgp', 'tk-bgp', 14, 14, 0, 0, 0),
      ('mfi-dai-nov', 'MFI-3', 1369, 'DAI-9758', 'DAI-9758', 'AUTO_DIESEL', 'AUTO_DIESEL', 100, 39200, 39200, 392, 3920000, 3920000, 39200, '2026-11-08 08:00:00', 'tk-bgp', 'tk-bgp', 14, 14, 0, 0, 0)
  `).run();

  const r1 = mig076.runMigration(mDb);
  assert.equal(r1.pseudoAssetsCleaned, 2);
  assert.equal(r1.dai9758Updated, 1);
  assert.equal(r1.dai9758RateUpserted, 1);
  assert.equal(r1.fuelSlipsRepriced, 2);
  assert.equal(r1.draftBillsRefreshed, 1);
  assert.equal(r1.dai9758DraftCreated, 1);

  assert.equal(mDb.prepare("SELECT COUNT(*) c FROM assets WHERE in_register = 1 AND (code LIKE 'SITE-%' OR code LIKE 'TRANSFER-%')").get().c, 0);
  const dai = mDb.prepare("SELECT * FROM assets WHERE id = 1369").get();
  assert.equal(dai.type, 'Single Cab');
  assert.equal(dai.brand, 'Mahindra');
  assert.equal(dai.model_no, 'Bolero');
  assert.equal(dai.meter_type, 'KM');
  const daiBill = mDb.prepare("SELECT * FROM fleet_bills WHERE asset_id = 1369 AND period_key = '2026-11'").get();
  assert.ok(daiBill);
  assert.equal(daiBill.status, 'DRAFT');
  assert.equal(daiBill.fuel_cost_cents, 3970000);
  assert.equal(daiBill.billable_units, 3000);

  const dt10Bill = mDb.prepare("SELECT fuel_cost_cents FROM fleet_bills WHERE id = 'bill-draft-2026-11-p14-a1001'").get();
  assert.equal(dt10Bill.fuel_cost_cents, 3970000);

  // Repeat run is a strict no-op
  const r2 = mig076.runMigration(mDb);
  assert.deepEqual(r2, {
    pseudoAssetsCleaned: 0,
    pseudoRatesRemoved: 0,
    pseudoAllocsDeactivated: 0,
    pseudoDraftsVoided: 0,
    dai9758Updated: 0,
    dai9758RateUpserted: 0,
    fuelSlipsRepriced: 0,
    draftBillsRefreshed: 0,
    dai9758DraftCreated: 0,
  });

  mDb.close();
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try { rawDb.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
