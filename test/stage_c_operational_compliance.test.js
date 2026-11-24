'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-stage-c-'));
process.env.DB_PATH = path.join(TMP, 'stagec.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.CEYPETCO_SYNC_ENABLED = 'false';
delete process.env.MULTIDB;

const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const permissions = require('../src/lib/permissions');
const vdocs = require('../src/lib/vehicle_documents');
const app = require('../src/server');

let server;
let baseUrl;
let adminCookie;
let mgrCookie;
let skCookie;

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

function addDays(isoDate, deltaDays) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

const TODAY = vdocs.getColomboToday();
const YM = TODAY.slice(0, 7);
const [YEAR, MONTH] = YM.split('-').map(Number);
const PREV_YM = (() => {
  const d = new Date(Date.UTC(YEAR, MONTH - 2, 1));
  return d.toISOString().slice(0, 7);
})();
const NEXT_YM = (() => {
  const d = new Date(Date.UTC(YEAR, MONTH, 1));
  return d.toISOString().slice(0, 7);
})();

test('Setup Stage C DB, Migration 078 idempotency, roles & seed fixtures', async () => {
  migrate();
  require('../src/migrate/015_phase4_erp_gaps').runStep();

  for (const [name, label] of [
    ['admin', 'Administrator'],
    ['manager', 'Manager'],
    ['operational_manager', 'Operations Manager'],
    ['storekeeper', 'Storekeeper'],
    ['transport_manager', 'Transport Manager'],
    ['workshop', 'Workshop Officer'],
  ]) {
    run('INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES (?, ?, 1, 1)', name, label);
  }
  permissions.seedDefaults();
  capabilities.seedCapabilities();

  // Verify Migration 078 columns & settings
  assert.equal(get("SELECT value FROM settings WHERE key = 'migration_078_done'").value, '1');
  assert.equal(get("SELECT value FROM settings WHERE key = 'fuel.dip_variance_threshold_litres'").value, '50');
  assert.equal(get("SELECT value FROM settings WHERE key = 'fuel.budget_warn_pct'").value, '85');
  assert.equal(get("SELECT value FROM settings WHERE key = 'vdocs.expiry_warn_days'").value, '30');

  const dipCols = all('PRAGMA table_info(fuel_tank_dips)').map((c) => c.name);
  for (const c of ['dip_type', 'reconciled', 'reconciled_at', 'reconciled_by', 'reconciled_note']) {
    assert.ok(dipCols.includes(c), `Expected fuel_tank_dips.${c}`);
  }

  // Idempotent re-run of Migration 078
  const m078 = require('../src/migrate/078_stage_c_operational_compliance');
  const secondRun = m078.runMigration(require('../src/db').db);
  assert.deepEqual(secondRun.addedColumns, []);

  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop', 'Badalgama', 1, 1)");
  run("INSERT OR REPLACE INTO projects (id, code, name, name_norm, active) VALUES (10, 'BDG', 'Badalgama Plant', 'badalgama plant', 1)");
  run("INSERT OR REPLACE INTO projects (id, code, name, name_norm, active) VALUES (11, 'CEP', 'CEP-03 Site', 'cep03 site', 1)");

  run(`
    INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active)
    VALUES
      ('tk-zero', 'TK-ZERO', 'Zero Calibration Tank', 'FIXED', 'AUTO_DIESEL', 15000, 0, 10, 1),
      ('tk-active', 'TK-ACT', 'CEP-03 Bowser', 'BOWSER', 'AUTO_DIESEL', 10000, 6000, 11, 1)
  `);
  run(`
    INSERT INTO fuel_prices (fuel_type, fuel_kind, price_per_litre_cents, price_per_litre, effective_date, notes, created_by)
    VALUES ('AUTO_DIESEL', 'AUTO_DIESEL', 39700, 397, '2026-01-01', 'Test Tariff', 1)
  `);

  run(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, category, asset_class, meter_type, current_hours, home_project_id, current_project_id, status, in_register, created_at, updated_at)
    VALUES
      (401, 'DA-9758', 'DA9758', 'DA-9758', 'Mitsubishi', 'Dump Truck', 'Dump Truck', 'vehicle', 'KM', 42000, 10, 10, 'active', 1, datetime('now'), datetime('now')),
      (402, 'DAI-9758', 'DAI9758', 'DA-9758', 'Mitsubishi', '', 'Dump Truck', 'vehicle', 'KM', 43500, 10, 10, 'active', 0, datetime('now'), datetime('now')),
      (403, 'LV-8001', 'LV8001', 'LV-8001', 'Toyota', 'Pickup', 'Double Cab', 'vehicle', NULL, 0, 10, 10, 'active', 1, datetime('now'), datetime('now'))
  `);

  const pw = auth.hashPassword('StageC#2026!');
  const roleId = (n) => get('SELECT id FROM roles WHERE name = ?', n).id;
  run("INSERT OR REPLACE INTO users (id, username, password_hash, full_name, active, must_change_password, workshop_id) VALUES (1, 'sc_admin', ?, 'StageC Admin', 1, 0, 1)", pw);
  run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (1, ?)', roleId('admin'));
  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password, workshop_id) VALUES (2, 'sc_mgr', ?, 'StageC Manager', 1, 0, 1)", pw);
  run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (2, ?)', roleId('manager'));
  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password, workshop_id) VALUES (3, 'sc_sk', ?, 'StageC Storekeeper', 1, 0, 1)", pw);
  run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (3, ?)', roleId('storekeeper'));

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  adminCookie = await loginAs('sc_admin', 'StageC#2026!');
  mgrCookie = await loginAs('sc_mgr', 'StageC#2026!');
  skCookie = await loginAs('sc_sk', 'StageC#2026!');
  assert.ok(mgrCookie && skCookie && mgrCookie !== adminCookie);
});

// =========================================================================
// PILLAR 1: Job Card Closure Blocker Engine & API
// =========================================================================
test('Pillar 1: Job Card Closure Blockers across missing price, pending GRN, unissued shelf, no daily work, sign-off, ready to close', async () => {
  run("INSERT INTO mechanics (id, name, name_norm, active) VALUES (1, 'Silva', 'SILVA', 1)");
  run("INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Silva', 800, '2025-01-01')");

  // 501: PARTIALLY_CLOSED with unpriced part -> missing_part_price + no_daily_work
  run("INSERT INTO job_cards (id, job_no, asset_id, project_id, type, description, status, workshop_id, partial_closed_at, requested_at) VALUES (501, '2026/11/R/501', 401, 10, 'repair', 'Gearbox rebuild', 'PARTIALLY_CLOSED', 1, date('now','-10 day'), date('now','-15 day'))");
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external) VALUES (501, date('now','-11 day'), 'Silva', 'Overhaul', 4, 0)");
  run("INSERT INTO job_parts (job_id, source_type, description, qty, unit_price) VALUES (501, 'grn', 'Bearing 6205', 2, NULL)");

  // 502: IN_PROGRESS with unreceived MRN line + unissued GRN on shelf
  run("INSERT INTO job_cards (id, job_no, asset_id, project_id, type, description, status, workshop_id, requested_at) VALUES (502, '2026/11/R/502', 403, 10, 'repair', 'Suspension check', 'IN_PROGRESS', 1, date('now','-8 day'))");
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external) VALUES (502, date('now','-5 day'), 'Silva', 'Disassembly', 3, 0)");
  run("INSERT INTO mrn (id, mrn_no, asset_id, project_id, job_id, status, approval_status) VALUES (601, 'MRN-502', 403, 10, 502, 'open', 'approved')");
  run("INSERT INTO mrn_lines (id, mrn_id, description, qty, qty_received) VALUES (701, 601, 'Tie Rod End', 4, 2)");
  run("INSERT INTO mrn_lines (id, mrn_id, description, qty, qty_received) VALUES (702, 601, 'Shock Absorber', 2, 2)");
  run("INSERT INTO grn (id, grn_no, mrn_id, mrn_line_id, description, qty, unit_price) VALUES (801, 'GRN-502', 601, 702, 'Shock Absorber', 2, 4500)");

  // 503: REQUESTED backlog -> awaiting_signoff + no_daily_work
  run("INSERT INTO job_cards (id, job_no, asset_id, project_id, type, description, status, workshop_id, is_historical, requested_at) VALUES (503, '2026/10/R/503', 401, 10, 'repair', 'Historic requested backlog', 'REQUESTED', 1, 1, date('now','-30 day'))");

  // 504: WORK_COMPLETE fully priced with work -> ready_to_close
  run("INSERT INTO job_cards (id, job_no, asset_id, project_id, type, description, status, workshop_id, completed_at, total_cost, requested_at) VALUES (504, '2026/11/R/504', 401, 10, 'repair', 'Radiator hose replaced', 'WORK_COMPLETE', 1, date('now','-1 day'), 3200, date('now','-3 day'))");
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external) VALUES (504, date('now','-1 day'), 'Silva', 'Replace hose', 2, 0)");
  run("INSERT INTO job_parts (job_id, source_type, description, qty, unit_price) VALUES (504, 'issue', 'Radiator Hose', 1, 1600)");

  const blk = await reqJson('/api/job-flow/blockers', { cookie: mgrCookie });
  assert.equal(blk.status, 200);
  assert.equal(blk.body.total_open, 4);
  assert.equal(blk.body.counts.missing_part_price, 1);
  assert.equal(blk.body.counts.pending_grn, 1);
  assert.equal(blk.body.counts.unissued_shelf, 1);
  assert.equal(blk.body.counts.awaiting_signoff, 1);
  assert.equal(blk.body.counts.no_daily_work, 1);
  assert.equal(blk.body.counts.ready_to_close, 1);

  const row501 = blk.body.rows.find((r) => r.id === 501);
  assert.ok(row501.blockers.some((b) => b.kind === 'missing_part_price'));
  const row502 = blk.body.rows.find((r) => r.id === 502);
  assert.ok(row502.blockers.some((b) => b.kind === 'pending_grn'));
  assert.ok(row502.blockers.some((b) => b.kind === 'unissued_shelf'));
  const row504 = blk.body.rows.find((r) => r.id === 504);
  assert.equal(row504.ready_to_close, true);
  assert.equal(row504.can.close, true);

  // Filter by blocker kind
  const filtered = await reqJson('/api/job-flow/blockers?blocker=pending_grn', { cookie: mgrCookie });
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.rows.length, 1);
  assert.equal(filtered.body.rows[0].id, 502);

  // GET /api/jobs?include_blockers=1 attaches blockers on open cards
  const allJobs = await reqJson('/api/jobs?include_blockers=1', { cookie: mgrCookie });
  assert.equal(allJobs.status, 200);
  const j501 = allJobs.body.find((j) => j.id === 501);
  assert.ok(j501 && Array.isArray(j501.blockers) && j501.blockers.some((b) => b.kind === 'missing_part_price'));
});

// =========================================================================
// PILLAR 2: Self-Service Asset Merge, Deduplication & Quick Triage
// =========================================================================
test('Pillar 2: Duplicate detection, RBAC gate, dry-run preview, atomic merge across FK/UNIQUE tables, and asset triage', async () => {
  // Overlapping vehicle_monthly_costs on 401 & 402
  run(`
    INSERT INTO vehicle_monthly_costs (asset_id, year, month, fuel_cost, parts_cost, total_cost)
    VALUES
      (401, ?, ?, 50000, 10000, 60000),
      (402, ?, ?, 25000, 5000, 30000)
  `, YEAR, MONTH, YEAR, MONTH);

  // Fuel issues, job card, rental rate, filter schedule & bill on 402
  run(`
    INSERT INTO fuel_issues (id, issue_no, asset_id, asset_code, vehicle_ref, project_id, fuel_type, litres, unit_price, fuel_price_cents, price_per_litre_cents, total_price, total_cost_cents, issue_date, is_voided)
    VALUES ('fi-dup-1', 'ISS-402-1', 402, 'DAI-9758', 'DAI-9758', 10, 'AUTO_DIESEL', 50, 397, 39700, 39700, 19850, 1985000, ?, 0)
  `, `${YM}-05`);
  run("INSERT INTO job_cards (id, job_no, asset_id, project_id, type, description, status, workshop_id) VALUES (590, '2026/11/R/590', 402, 10, 'repair', 'Typo asset job', 'CLOSED', 1)");
  run("INSERT INTO fleet_rental_rates (id, asset_id, category_name, rate_basis, rate_cents) VALUES ('rate-402', 402, 'Dump Truck', 'DAILY', 2500000)");
  run("INSERT INTO vehicle_filter_schedules (asset_id, category, qty, every_n_services) VALUES (401, 'OIL_FILTER', 1, 1), (402, 'OIL_FILTER', 1, 1), (402, 'AIR_FILTER', 1, 2)");
  run(`
    INSERT INTO fleet_bills (id, invoice_number, year, month, period_key, period_start, period_end, asset_id, asset_code, billing_mode, rate_basis, rate_cents, actual_units, minimum_units, billable_units, rental_amount_cents, subtotal_cents, sscl_cents, vat_cents, grand_total_cents, status)
    VALUES ('bill-402', 'INV-402-1', ?, ?, ?, ?, ?, 402, 'DAI-9758', 'DRY_WITH_DRIVER', 'DAILY', 2500000, 5, 0, 5, 12500000, 12500000, 312500, 2306250, 15118750, 'FINAL')
  `, YEAR, MONTH, YM, `${YM}-01`, `${YM}-28`);

  // Candidate detection & triage summary
  const cands = await reqJson('/api/assets/duplicate-candidates', { cookie: mgrCookie });
  assert.equal(cands.status, 200);
  assert.ok(cands.body.candidates.some((p) => p.source.id === 402 && p.target.id === 401));
  assert.equal(cands.body.triage.missing_meter_count >= 1, true); // LV-8001 has NULL meter_type

  // RBAC: Storekeeper denied merge-preview & merge
  const skPrev = await reqJson('/api/assets/merge-preview', { method: 'POST', cookie: skCookie, body: { source_id: 402, target_id: 401 } });
  assert.equal(skPrev.status, 403);
  const skMerge = await reqJson('/api/assets/merge', { method: 'POST', cookie: skCookie, body: { source_id: 402, target_id: 401, reason: 'Unauthorized attempt' } });
  assert.equal(skMerge.status, 403);

  // Manager dry-run preview succeeds (even though manager has assets='view' + assets.repoint)
  const pv = await reqJson('/api/assets/merge-preview', { method: 'POST', cookie: mgrCookie, body: { source_id: 402, target_id: 401 } });
  assert.equal(pv.status, 200);
  assert.ok(pv.body.total_records >= 5);
  assert.equal(pv.body.bills_breakdown.final, 1);
  assert.equal(pv.body.overlapping_vmc_months, 1);

  // Registered source confirmation guard (403 -> 409 check on 403 -> 401)
  const regGuard = await reqJson('/api/assets/merge', {
    method: 'POST',
    cookie: mgrCookie,
    body: { source_id: 403, target_id: 401, reason: 'Registered block test' },
  });
  assert.equal(regGuard.status, 409);
  assert.equal(regGuard.body.requires_registered_confirm, true);

  // Execute safe merge 402 -> 401
  const mg = await reqJson('/api/assets/merge', {
    method: 'POST',
    cookie: mgrCookie,
    body: { source_id: 402, target_id: 401, reason: 'Fold DAI-9758 typo into canonical DA-9758', keep_alias: true },
  });
  assert.equal(mg.status, 200, JSON.stringify(mg.body));
  assert.equal(get('SELECT id FROM assets WHERE id = 402'), undefined);
  assert.equal(get('SELECT asset_id, asset_code FROM fuel_issues WHERE id = ?', 'fi-dup-1').asset_id, 401);
  assert.equal(get('SELECT asset_code FROM fuel_issues WHERE id = ?', 'fi-dup-1').asset_code, 'DA-9758');
  assert.equal(get('SELECT asset_id FROM job_cards WHERE id = 590').asset_id, 401);
  assert.equal(get('SELECT asset_id, asset_code FROM fleet_bills WHERE id = ?', 'bill-402').asset_code, 'DA-9758');

  // Overlapping VMC summed accurately
  const vmc = get('SELECT fuel_cost, parts_cost, total_cost FROM vehicle_monthly_costs WHERE asset_id = 401 AND year = ? AND month = ?', YEAR, MONTH);
  assert.equal(vmc.fuel_cost, 75000);
  assert.equal(vmc.parts_cost, 15000);
  assert.equal(vmc.total_cost, 90000);

  // Higher current_hours preserved & resolved alias created
  assert.equal(get('SELECT current_hours FROM assets WHERE id = 401').current_hours, 43500);
  const al = get("SELECT asset_id, resolved FROM asset_aliases WHERE raw_norm = 'DAI9758'");
  assert.equal(al.asset_id, 401);
  assert.equal(al.resolved, 1);

  // Foreign key check clean
  assert.deepEqual(all('PRAGMA foreign_key_check'), []);

  // Quick triage endpoint & missing_meter filter
  const miss = await reqJson('/api/assets?missing_meter=1', { cookie: mgrCookie });
  assert.equal(miss.status, 200);
  assert.ok(miss.body.some((a) => a.id === 403));

  const tr = await reqJson('/api/assets/403/triage', {
    method: 'PATCH',
    cookie: mgrCookie,
    body: { ownership: 'HIRED', in_register: 0, meter_type: 'HOURS', current_hours: 1200, reason: 'Hired unit' },
  });
  assert.equal(tr.status, 200);
  assert.equal(tr.body.ownership, 'HIRED');
  assert.equal(tr.body.in_register, 0);
  assert.equal(tr.body.meter_type, 'HOURS');
  assert.equal(tr.body.current_hours, 1200);
});

// =========================================================================
// PILLAR 3: Vehicle Document Expiry Dashboard, Bulk Renewal & Compliance Alerts
// =========================================================================
test('Pillar 3: 30/14/7-day expiry dashboard, non-blocking compliance badges, bulk-renew, and fuel alert', async () => {
  const docs = vdocs.getVehicleDocuments(401, { today: TODAY });
  assert.ok(docs.length >= 4);
  const byCode = new Map(docs.map((d) => [d.doc_type_code, d]));

  const seedVerified = (docCode, validUntil, num) => {
    const container = byCode.get(docCode);
    assert.ok(container, `Missing doc container for ${docCode}`);
    const v = vdocs.createDraftVersion(container.id, {
      doc_number: num,
      issuer_name: 'Test Authority',
      issue_date: addDays(TODAY, -300),
      valid_from: addDays(TODAY, -300),
      valid_until: validUntil,
      status: 'pending_verification',
    }, { id: 1 });
    return vdocs.verifyVersion(v.id, { decision: 'approve', today: TODAY }, { id: 1 });
  };

  seedVerified('cr', '9999-12-31', 'CR-401');
  const expIns = seedVerified('insurance', addDays(TODAY, -5), 'POL-EXP-401');
  seedVerified('revenue_licence', addDays(TODAY, 4), 'RL-7D-401');
  seedVerified('emission', addDays(TODAY, 12), 'VET-14D-401');
  if (byCode.has('fitness')) {
    seedVerified('fitness', addDays(TODAY, 22), 'FIT-30D-401');
  }

  const dash = await reqJson(`/api/vehicle-documents/expiry-dashboard?today=${TODAY}`, { cookie: mgrCookie });
  assert.equal(dash.status, 200);
  assert.equal(dash.body.counts.expired, 1);
  assert.equal(dash.body.counts.critical_7d, 1);
  assert.equal(dash.body.counts.warning_14d, 1);
  if (byCode.has('fitness')) {
    assert.equal(dash.body.counts.upcoming_30d, 1);
  }

  // Lookup compliance badge by code (DAI-9758 alias also resolves via merged alias!)
  const badgeRes = await reqJson(`/api/vehicle-documents/compliance-badges?asset_code=DAI-9758&today=${TODAY}`, { cookie: mgrCookie });
  assert.equal(badgeRes.status, 200);
  const info = badgeRes.body.by_asset_id['401'];
  assert.ok(info);
  assert.equal(info.overall_status, 'expired');
  assert.equal(info.insurance_expired, true);
  assert.equal(info.badge.level, 'red');

  // Ensure fuel_issues in YM on asset 401 raises COMPLIANCE alert in /api/fuel/alerts
  const alBefore = await reqJson(`/api/fuel/alerts?month=${YM}`, { cookie: mgrCookie });
  assert.equal(alBefore.status, 200);
  assert.ok(alBefore.body.alerts.some((a) => a.category === 'COMPLIANCE' && a.asset_id === 401));

  // Bulk renew expired insurance with auto_verify
  const br = await reqJson('/api/vehicle-documents/bulk-renew', {
    method: 'POST',
    cookie: mgrCookie,
    body: {
      auto_verify: true,
      today: TODAY,
      items: [{
        document_id: expIns.document_id,
        doc_number: 'POL-NEW-401',
        valid_from: TODAY,
        valid_until: addDays(TODAY, 365),
        issuer_name: 'SLIC',
      }],
    },
  });
  assert.equal(br.status, 201, JSON.stringify(br.body));
  assert.equal(br.body.renewed_count, 1);
  assert.equal(br.body.renewed[0].status, 'verified');

  const badgeAfter = await reqJson(`/api/vehicle-documents/compliance-badges?asset_ids=401&today=${TODAY}`, { cookie: mgrCookie });
  assert.equal(badgeAfter.body.by_asset_id['401'].insurance_expired, false);
});

// =========================================================================
// PILLAR 4: Tank Dip Reconciliation Wizard & Monthly Site Fuel Budgets
// =========================================================================
test('Pillar 4: Opening stock wizard, physical dip variance alert & reconciliation, bulk site budgets & pace alerts', async () => {
  // 1. Check initial zero-stock tank summary
  const r0 = await reqJson('/api/fuel/tanks/reconciliation', { cookie: mgrCookie });
  assert.equal(r0.status, 200);
  assert.equal(r0.body.counts.zero_stock_count, 1);
  assert.equal(r0.body.zero_stock_tanks[0].id, 'tk-zero');

  // 2. Apply Opening Stock via wizard endpoint -> does NOT trigger variance alert
  const os = await reqJson('/api/fuel/tanks/opening-stock', {
    method: 'POST',
    cookie: mgrCookie,
    body: {
      items: [{ tankId: 'tk-zero', openingLitres: 5000, note: 'Initial physical dip calibration' }],
    },
  });
  assert.equal(os.status, 200);
  assert.equal(os.body.updated_count, 1);
  assert.equal(os.body.results[0].dip_type, 'OPENING_STOCK');
  assert.equal(os.body.results[0].reconciled, 1);

  const alAfterOs = await reqJson(`/api/fuel/alerts?month=${YM}`, { cookie: mgrCookie });
  assert.equal(alAfterOs.body.alerts.some((a) => a.category === 'INTEGRITY' && a.tank_id === 'tk-zero'), false);

  // 3. Record physical dip with large variance -> triggers INTEGRITY alert with dip_id
  const dip = await reqJson('/api/fuel/tanks/tk-zero/dip', {
    method: 'POST',
    cookie: mgrCookie,
    body: { dipLitres: 4200, note: 'Evening check' },
  });
  assert.equal(dip.status, 200);
  assert.equal(dip.body.variance_litres, -800);

  const r1 = await reqJson('/api/fuel/tanks/reconciliation', { cookie: mgrCookie });
  assert.equal(r1.body.counts.unresolved_dip_count, 1);
  const alWithDip = await reqJson(`/api/fuel/alerts?month=${YM}`, { cookie: mgrCookie });
  const intAlert = alWithDip.body.alerts.find((a) => a.category === 'INTEGRITY' && a.tank_id === 'tk-zero');
  assert.ok(intAlert && intAlert.dip_id);

  // 4. Reconcile the dip -> validation on short note, then success clears unresolved count & alert
  const badRec = await reqJson(`/api/fuel/tanks/dips/${intAlert.dip_id}/reconcile`, {
    method: 'POST',
    cookie: mgrCookie,
    body: { note: 'ok' },
  });
  assert.equal(badRec.status, 400);

  const goodRec = await reqJson(`/api/fuel/tanks/dips/${intAlert.dip_id}/reconcile`, {
    method: 'POST',
    cookie: mgrCookie,
    body: { note: 'Verified missing slips backfilled and gauge calibrated' },
  });
  assert.equal(goodRec.status, 200);
  assert.equal(goodRec.body.dip.reconciled, 1);

  const r2 = await reqJson('/api/fuel/tanks/reconciliation', { cookie: mgrCookie });
  assert.equal(r2.body.counts.unresolved_dip_count, 0);
  const alAfterRec = await reqJson(`/api/fuel/alerts?month=${YM}`, { cookie: mgrCookie });
  assert.equal(alAfterRec.body.alerts.some((a) => a.category === 'INTEGRITY' && a.tank_id === 'tk-zero'), false);

  // 5. Historical usage + GET /api/fuel/budgets suggestions
  run(`
    INSERT INTO fuel_issues (id, issue_no, asset_id, asset_code, vehicle_ref, project_id, source_tank_id, fuel_type, litres, unit_price, fuel_price_cents, price_per_litre_cents, total_price, total_cost_cents, issue_date, is_voided)
    VALUES
      ('fi-hist-1', 'ISS-HIST-1', 401, 'DA-9758', 'DA-9758', 10, 'tk-zero', 'AUTO_DIESEL', 600, 397, 39700, 39700, 238200, 23820000, ?, 0),
      ('fi-cur-2', 'ISS-CUR-2', 401, 'DA-9758', 'DA-9758', 11, 'tk-active', 'AUTO_DIESEL', 90, 397, 39700, 39700, 35730, 3573000, ?, 0)
  `, `${PREV_YM}-12`, `${YM}-08`);

  const bGet = await reqJson(`/api/fuel/budgets?month=${YM}`, { cookie: mgrCookie });
  assert.equal(bGet.status, 200);
  const p10 = bGet.body.items.find((i) => i.project_id === 10);
  assert.ok(p10 && p10.prev_month_litres === 600 && p10.avg_3m_litres === 200 && p10.suggested_budget_litres > 0);

  // 6. Bulk save tight budgets -> raises BUDGET HIGH (over) & MEDIUM (watch) alerts
  const bSave = await reqJson('/api/fuel/budgets/bulk', {
    method: 'POST',
    cookie: mgrCookie,
    body: {
      year: YEAR,
      month: MONTH,
      items: [
        { projectId: 10, budgetLitres: 40, note: 'Tight cap (<50L drawn)' }, // 50L drawn -> 125% OVER
        { projectId: 11, budgetLitres: 100, note: 'Watch cap (90% drawn)' }, // 90L drawn -> 90% WATCH
      ],
    },
  });
  assert.equal(bSave.status, 200);
  assert.equal(bSave.body.saved_count, 2);

  const alBud = await reqJson(`/api/fuel/alerts?month=${YM}`, { cookie: mgrCookie });
  const overAl = alBud.body.alerts.find((a) => a.category === 'BUDGET' && a.project_id === 10);
  const watchAl = alBud.body.alerts.find((a) => a.category === 'BUDGET' && a.project_id === 11);
  assert.ok(overAl && overAl.severity === 'HIGH');
  assert.ok(watchAl && watchAl.severity === 'MEDIUM');

  // 7. Copy previous month budgets forward
  const [nYr, nMo] = NEXT_YM.split('-').map(Number);
  const bCopy = await reqJson('/api/fuel/budgets/bulk', {
    method: 'POST',
    cookie: mgrCookie,
    body: { year: nYr, month: nMo, copyFromMonth: YM },
  });
  assert.equal(bCopy.status, 200);
  assert.equal(bCopy.body.saved_count, 2);

  const bNext = await reqJson(`/api/fuel/budgets?month=${NEXT_YM}`, { cookie: mgrCookie });
  assert.equal(bNext.status, 200);
  assert.equal(bNext.body.items.find((i) => i.project_id === 10).budget_litres, 40);
});

test('Teardown Stage C test server and temp workspace', async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
});
