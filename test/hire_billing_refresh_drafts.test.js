'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-refresh-drafts-'));
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
const HIST_MONTH = '2026-10';

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

test.before(async () => {
  migrate();
  capabilities.seedCapabilities();

  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop', 'Peliyagoda', 1, 1)");
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (38, 'CEP-03F', 'CEP-03 F (Galagedara)', 'cep 03 f galagedara', 1)");
  run("INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active) VALUES ('12', 'TANK-12', 'Galagedara Main', 'FIXED', 'AUTO_DIESEL', 20000, 5000, 38, 1)");

  // A1 & A2 have October 2026 fuel; A3 only has current_project_id=38 and zero October fuel
  run(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, asset_class, meter_type, current_project_id, status, in_register, created_at, updated_at)
    VALUES
      (101, 'A1-EX', 'A1EX', 'A1-EX', 'CAT', 'Excavator', 'vehicle', 'HOURS', 38, 'active', 1, datetime('now'), datetime('now')),
      (102, 'A2-EX', 'A2EX', 'A2-EX', 'KOMATSU', 'Excavator', 'vehicle', 'HOURS', 38, 'active', 1, datetime('now'), datetime('now')),
      (103, 'A3-DT', 'A3DT', 'A3-DT', 'ISUZU', 'Dump Truck', 'vehicle', 'KM', 38, 'active', 1, datetime('now'), datetime('now'))
  `);

  run(`
    INSERT INTO fleet_rental_rates (
      id, asset_id, category_name, rate_basis, rate_cents,
      dry_rate_cents, wet_rate_cents, hr_dry_cents, hr_wet_cents, km_dry_cents, km_wet_cents,
      equip_type, default_basis, min_bill_hours, fuel_cons_typ, fuel_cons_basis
    ) VALUES
      ('rc-101', 101, 'Excavator', 'HOURLY', 500000, 450000, 500000, 450000, 500000, NULL, NULL, 'FLEET', 'WET', 120, 15, 'hr'),
      ('rc-102', 102, 'Excavator', 'HOURLY', 500000, 450000, 500000, 450000, 500000, NULL, NULL, 'FLEET', 'WET', 120, 15, 'hr'),
      ('rc-103', 103, 'Dump Truck', 'KM', 12000, 9500, 12000, NULL, NULL, 9500, 12000, 'FLEET', 'WET', 3000, 0.25, 'km')
  `);

  run(`
    INSERT INTO fuel_issues (
      id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, litres,
      fuel_price_cents, price_per_litre_cents, total_cost_cents, cost_cents,
      issue_date, bulk_tank_id, source_tank_id, is_voided
    ) VALUES
      ('fi-a1-1', 'FI-1', 101, 'A1-EX', 'A1-EX', 'AUTO_DIESEL', 100, 39200, 39200, 3920000, 3920000, '2026-10-05 08:00:00', '12', '12', 0),
      ('fi-a2-1', 'FI-2', 102, 'A2-EX', 'A2-EX', 'AUTO_DIESEL', 100, 39200, 39200, 3920000, 3920000, '2026-10-05 09:00:00', '12', '12', 0)
  `);

  run("INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('admin', 'Administrator', 1, 1)");
  const adminRole = get("SELECT id FROM roles WHERE name = 'admin'");
  const pwHash = auth.hashPassword('RefreshPass#2026!');
  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password) VALUES (1, 'admin_ref', ?, 'Refresh Admin', 1, 0)", pwHash);
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
    body: { username: 'admin_ref', password: 'RefreshPass#2026!' },
  });
  assert.equal(login.status, 200);
  adminCookie = login.headers.get('set-cookie').split(';')[0];
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { rawDb.close(); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test('Historical month excludes zero-fuel current_project_id ghost, and refreshDrafts updates DRAFTs without touching FINAL', async () => {
  // 1. Initial generate for historical month 2026-10 bills A1 & A2 only (A3 has zero fuel & no 2026-10 allocation)
  const gen1 = await reqJson('/api/hire/bills/generate-site', {
    method: 'POST',
    body: { projectId: 38, month: HIST_MONTH },
  });
  assert.equal(gen1.status, 201);
  assert.equal(gen1.body.generatedBills, 2);
  assert.equal(gen1.body.refreshedBills, 0);

  const a1Initial = get("SELECT * FROM fleet_bills WHERE project_id = 38 AND period_key = ? AND asset_id = 101 AND status != 'VOID'", HIST_MONTH);
  const a2Initial = get("SELECT * FROM fleet_bills WHERE project_id = 38 AND period_key = ? AND asset_id = 102 AND status != 'VOID'", HIST_MONTH);
  const a3Ghost = get("SELECT * FROM fleet_bills WHERE project_id = 38 AND period_key = ? AND asset_id = 103 AND status != 'VOID'", HIST_MONTH);
  assert.ok(a1Initial && a1Initial.status === 'DRAFT');
  assert.ok(a2Initial && a2Initial.status === 'DRAFT');
  assert.equal(a3Ghost, undefined, 'Zero-fuel current_project_id machine must not leak into historical month bills');
  assert.equal(a1Initial.fuel_litres, 100);

  // 2. Finalise A2
  const fin = await reqJson(`/api/hire/bills/${a2Initial.id}/finalise`, { method: 'POST', body: {} });
  assert.equal(fin.status, 200);
  const a2FinalBefore = get('SELECT * FROM fleet_bills WHERE id = ?', a2Initial.id);
  assert.equal(a2FinalBefore.status, 'FINAL');

  // 3. Late October fuel imported for both A1 (+200L) and A2 (+200L)
  run(`
    INSERT INTO fuel_issues (
      id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, litres,
      fuel_price_cents, price_per_litre_cents, total_cost_cents, cost_cents,
      issue_date, bulk_tank_id, source_tank_id, is_voided
    ) VALUES
      ('fi-a1-2', 'FI-3', 101, 'A1-EX', 'A1-EX', 'AUTO_DIESEL', 200, 39200, 39200, 7840000, 7840000, '2026-10-18 08:00:00', '12', '12', 0),
      ('fi-a2-2', 'FI-4', 102, 'A2-EX', 'A2-EX', 'AUTO_DIESEL', 200, 39200, 39200, 7840000, 7840000, '2026-10-18 09:00:00', '12', '12', 0)
  `);

  // 4. Re-generating with refreshDrafts=false skips both existing bills
  const genSkip = await reqJson('/api/hire/bills/generate-site', {
    method: 'POST',
    body: { projectId: 38, month: HIST_MONTH, refreshDrafts: false },
  });
  assert.equal(genSkip.status, 201);
  assert.equal(genSkip.body.generatedBills, 0);
  assert.equal(genSkip.body.refreshedBills, 0);
  assert.equal(genSkip.body.skippedAlreadyBilled, 2);
  assert.equal(get('SELECT fuel_litres FROM fleet_bills WHERE id = ?', a1Initial.id).fuel_litres, 100);

  // 5. Preview with refreshDrafts=1 marks A1 eligible + positive delta, A2 ineligible (FINAL)
  const prev = await reqJson(`/api/hire/bills/site-preview?projectId=38&month=${HIST_MONTH}&refreshDrafts=1`);
  assert.equal(prev.status, 200);
  assert.equal(prev.body.summary.refreshableDraftCount, 1);
  const pA1 = prev.body.items.find((x) => x.assetId === 101);
  const pA2 = prev.body.items.find((x) => x.assetId === 102);
  assert.equal(pA1.eligible, true);
  assert.equal(pA1.canRefreshDraft, true);
  assert.ok(pA1.draftDeltaCents > 0);
  assert.equal(pA2.eligible, false);
  assert.equal(pA2.canRefreshDraft, false);

  // 6. Refresh drafts updates A1 only and leaves FINAL A2 untouched
  const genRef = await reqJson('/api/hire/bills/generate-site', {
    method: 'POST',
    body: { projectId: 38, month: HIST_MONTH, refreshDrafts: true },
  });
  assert.equal(genRef.status, 201);
  assert.equal(genRef.body.generatedBills, 0);
  assert.equal(genRef.body.refreshedBills, 1);
  assert.equal(genRef.body.skippedAlreadyBilled, 1);

  const a1After = get('SELECT * FROM fleet_bills WHERE id = ?', a1Initial.id);
  const a1FuelLine = get("SELECT * FROM fleet_bill_line_items WHERE bill_id = ? AND item_type = 'FUEL'", a1Initial.id);
  const a1Revs = all('SELECT * FROM fleet_bill_revisions WHERE bill_id = ?', a1Initial.id);
  const a2FinalAfter = get('SELECT * FROM fleet_bills WHERE id = ?', a2Initial.id);

  assert.equal(a1After.fuel_litres, 300);
  assert.equal(a1After.fuel_cost_cents, 11760000);
  assert.ok(a1After.grand_total_cents > a1Initial.grand_total_cents);
  assert.equal(a1FuelLine.quantity, 300);
  assert.equal(a1FuelLine.amount_cents, 11760000);
  assert.equal(a1Revs.length, 1);
  assert.equal(a2FinalAfter.fuel_litres, a2FinalBefore.fuel_litres);
  assert.equal(a2FinalAfter.grand_total_cents, a2FinalBefore.grand_total_cents);

  // 7. Site-summary generate with refreshDrafts=true also refreshes DRAFT A1 after more fuel while skipping FINAL A2
  run(`
    INSERT INTO fuel_issues (
      id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, litres,
      fuel_price_cents, price_per_litre_cents, total_cost_cents, cost_cents,
      issue_date, bulk_tank_id, source_tank_id, is_voided
    ) VALUES ('fi-a1-3', 'FI-5', 101, 'A1-EX', 'A1-EX', 'AUTO_DIESEL', 50, 39200, 39200, 1960000, 1960000, '2026-10-22 08:00:00', '12', '12', 0)
  `);
  const sumGen = await reqJson('/api/hire/bills/site-summary/generate', {
    method: 'POST',
    body: { projectId: 38, month: HIST_MONTH, refreshDrafts: true },
  });
  assert.equal(sumGen.status, 201);
  assert.equal(sumGen.body.refreshedBills, 1);
  assert.equal(sumGen.body.skippedExisting, 1);
  assert.equal(get('SELECT fuel_litres FROM fleet_bills WHERE id = ?', a1Initial.id).fuel_litres, 350);
  assert.equal(get('SELECT fuel_litres FROM fleet_bills WHERE id = ?', a2Initial.id).fuel_litres, 100);

  // 8. Locking period blocks refreshDrafts=true with 409 periodLocked
  const lk = await reqJson('/api/hire/period-locks', {
    method: 'POST',
    body: { periodKey: HIST_MONTH, projectId: 38, reason: 'Month closed' },
  });
  assert.ok(lk.status === 200 || lk.status === 201);
  const blockedRef = await reqJson('/api/hire/bills/generate-site', {
    method: 'POST',
    body: { projectId: 38, month: HIST_MONTH, refreshDrafts: true },
  });
  assert.equal(blockedRef.status, 409);
  assert.equal(blockedRef.body.periodLocked, true);
});
