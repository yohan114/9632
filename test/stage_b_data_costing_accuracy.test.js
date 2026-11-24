'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-stage-b-'));
process.env.DB_PATH = path.join(TMP, 'stageb.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.CEYPETCO_SYNC_ENABLED = 'false';
delete process.env.MULTIDB;

const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const permissions = require('../src/lib/permissions');
const stock = require('../src/lib/stock');
const app = require('../src/server');

let server;
let baseUrl;
let adminCookie;
let mgrCookie;
let skCookie;
let supCookie;

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

const TODAY = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const YM = TODAY.slice(0, 7);
const [YEAR, MONTH] = YM.split('-').map(Number);

test('Setup Stage B database fixtures, roles, assets, store items, oils & fuel tanks', async () => {
  migrate();
  require('../src/migrate/015_phase4_erp_gaps').runStep();
  for (const [name, label] of [
    ['admin', 'Administrator'],
    ['manager', 'Manager'],
    ['operational_manager', 'Operations Manager'],
    ['storekeeper', 'Storekeeper'],
    ['transport_manager', 'Transport Manager'],
  ]) {
    run('INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES (?, ?, 1, 1)', name, label);
  }
  permissions.seedDefaults();
  capabilities.seedCapabilities();

  // Verify Migration 077 schema & default settings
  assert.equal(get("SELECT value FROM settings WHERE key = 'migration_077_done'").value, '1');
  assert.equal(get("SELECT value FROM settings WHERE key = 'stock.block_negative_issue'").value, '0');
  assert.equal(get("SELECT value FROM settings WHERE key = 'fuel.require_meter_or_faulty'").value, '1');

  const frCols = all('PRAGMA table_info(fuel_requests)').map((c) => c.name);
  const fiCols = all('PRAGMA table_info(fuel_issues)').map((c) => c.name);
  assert.ok(frCols.includes('meter_faulty') && frCols.includes('meter_fault_reason'));
  assert.ok(fiCols.includes('meter_faulty') && fiCols.includes('meter_fault_reason'));

  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop', 'Badalgama', 1, 1)");
  run("INSERT OR REPLACE INTO projects (id, code, name, name_norm, active) VALUES (10, 'BDG', 'Badalgama Plant', 'badalgama plant', 1)");
  run(`
    INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active)
    VALUES ('tk-bdg', 'TK-BDG', 'Badalgama Main Tank', 'FIXED', 'AUTO_DIESEL', 20000, 12000, 10, 1)
  `);
  run(`
    INSERT INTO fuel_prices (fuel_type, fuel_kind, price_per_litre_cents, price_per_litre, effective_date, notes, created_by)
    VALUES ('AUTO_DIESEL', 'AUTO_DIESEL', 39700, 397, '2026-01-01', 'Test Auto Diesel', 1)
  `);

  run(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, category, asset_class, meter_type, current_hours, home_project_id, current_project_id, status, in_register, created_at, updated_at)
    VALUES
      (301, 'EX-301', 'EX301', 'EX-301', 'CAT', 'Excavator', 'Excavator', 'machine', 'HOURS', 1500, 10, 10, 'active', 1, datetime('now'), datetime('now')),
      (302, 'SITE-TRF', 'SITETRF', 'SITE-TRF', 'Site', 'Transfer', 'Site Transfer', 'vehicle', 'KM', 0, 10, 10, 'active', 0, datetime('now'), datetime('now'))
  `);
  run(`
    INSERT INTO fleet_rental_rates (id, asset_id, category_name, rate_basis, rate_cents, fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy, fuel_cons_basis, created_at, updated_at)
    VALUES ('rate-301', 301, 'Excavator', 'HOURLY', 500000, 6.0, 8.0, 10.0, 'hr', datetime('now'), datetime('now'))
  `);

  const pw = auth.hashPassword('StageB#2026!');
  const roleId = (n) => get('SELECT id FROM roles WHERE name = ?', n).id;
  run("INSERT OR REPLACE INTO users (id, username, password_hash, full_name, active, must_change_password, workshop_id) VALUES (1, 'sb_admin', ?, 'StageB Admin', 1, 0, 1)", pw);
  run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (1, ?)', roleId('admin'));
  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password, workshop_id) VALUES (2, 'sb_mgr', ?, 'StageB Manager', 1, 0, 1)", pw);
  run('INSERT INTO user_roles (user_id, role_id) VALUES (2, ?)', roleId('manager'));
  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password, workshop_id) VALUES (3, 'sb_sk', ?, 'StageB Storekeeper', 1, 0, 1)", pw);
  run('INSERT INTO user_roles (user_id, role_id) VALUES (3, ?)', roleId('storekeeper'));
  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password, workshop_id) VALUES (4, 'sb_sup', ?, 'StageB Stores Supervisor', 1, 0, 1)", pw);
  run('INSERT INTO user_roles (user_id, role_id) VALUES (4, ?)', roleId('storekeeper'));
  run('INSERT INTO user_roles (user_id, role_id) VALUES (4, ?)', roleId('manager'));

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  adminCookie = await loginAs('sb_admin', 'StageB#2026!');
  mgrCookie = await loginAs('sb_mgr', 'StageB#2026!');
  skCookie = await loginAs('sb_sk', 'StageB#2026!');
  supCookie = await loginAs('sb_sup', 'StageB#2026!');
  assert.ok(supCookie && supCookie !== adminCookie);
});

// =========================================================================
// PILLAR 1: Unpriced GRN & Job Parts Queue + Costing Cascade
// =========================================================================
test('Pillar 1: awaiting-price hints (NULL + 0), summary, negative price validation, GRN & job_parts bulk pricing cascade', async () => {
  // Store item + Historical priced GRN providing hint price Rs 2,500
  const siId = run(`
    INSERT INTO store_items (item_no, name, category, unit, balance, min_stock, is_general, unit_cost)
    VALUES ('GEN-SB1', 'Hydraulic Hose Assembly', 'Spare Parts', 'nos', 5, 2, 1, 0)
  `).lastInsertRowid;
  run(`
    INSERT INTO stock_items (code, section, name, item_key, unit, unit_price, source_table, source_id, active)
    VALUES ('GEN-SB1', 'general', 'Hydraulic Hose Assembly', 'HYDRAULICHOSEASSEMBLY', 'nos', 0, 'store_items', ?, 1)
  `, siId);

  const mrnHist = run("INSERT INTO mrn (mrn_no, req_date, status, workshop_id) VALUES ('910001', '2026-10-01', 'received', 1)").lastInsertRowid;
  const mlHist = run('INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty, qty_received, category, purchase_source) VALUES (?, ?, ?, 2, 2, ?, ?)',
    mrnHist, siId, 'Hydraulic Hose Assembly', 'Spare Parts', 'local_purchase').lastInsertRowid;
  run(`
    INSERT INTO grn (grn_no, grn_date, delivery_date, mrn_id, mrn_line_id, store_item_id, description, qty, unit_price, supplier, purchase_source, purchase_source_norm, store_id)
    VALUES ('GRN-HIST-1', '2026-10-02', '2026-10-02', ?, ?, ?, 'Hydraulic Hose Assembly', 2, 2500, 'Hose World', 'local_purchase', 'local_purchase', 1)
  `, mrnHist, mlHist, siId);

  // Job Card + Unpriced GRN (NULL) + Unpriced zero-price GRN (0) + Unpriced Issue-based job_part
  const jobId = run(`
    INSERT INTO job_cards (job_no, asset_id, project_id, type, description, status, is_historical, requested_at, completed_at, workshop_id)
    VALUES ('2026/11/R/SB1', 301, 10, 'repair', 'Hydraulic boom hose repair', 'IN_PROGRESS', 0, ?, ?, 1)
  `, TODAY, TODAY).lastInsertRowid;

  const mrnUnp = run('INSERT INTO mrn (mrn_no, job_id, req_date, status, workshop_id) VALUES (?, ?, ?, ?, 1)',
    '910002', jobId, TODAY, 'received').lastInsertRowid;
  const mlUnp1 = run('INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty, qty_received, category, purchase_source) VALUES (?, ?, ?, 2, 2, ?, ?)',
    mrnUnp, siId, 'Hydraulic Hose Assembly', 'Spare Parts', 'local_purchase').lastInsertRowid;
  const grnNullId = run(`
    INSERT INTO grn (grn_no, grn_date, delivery_date, mrn_id, mrn_line_id, store_item_id, description, qty, unit_price, purchase_source, purchase_source_norm, store_id)
    VALUES ('GRN-UNP-1', ?, ?, ?, ?, ?, 'Hydraulic Hose Assembly', 2, NULL, 'local_purchase', 'local_purchase', 1)
  `, TODAY, TODAY, mrnUnp, mlUnp1, siId).lastInsertRowid;

  const mlUnp2 = run('INSERT INTO mrn_lines (mrn_id, description, qty, qty_received, category, purchase_source) VALUES (?, ?, 1, 1, ?, ?)',
    mrnUnp, 'Bespoke Pivot Pin', 'Spare Parts', 'head_office').lastInsertRowid;
  const grnZeroId = run(`
    INSERT INTO grn (grn_no, grn_date, delivery_date, mrn_id, mrn_line_id, description, qty, unit_price, purchase_source, purchase_source_norm, store_id)
    VALUES ('GRN-UNP-0', ?, ?, ?, ?, 'Bespoke Pivot Pin', 1, 0, 'head_office', 'head_office', 1)
  `, TODAY, TODAY, mrnUnp, mlUnp2).lastInsertRowid;

  const issUnpId = run(`
    INSERT INTO issues (asset_id, job_id, store_item_id, description, qty, unit_price, issue_date, category, store_id)
    VALUES (301, ?, ?, 'Hydraulic Hose Assembly', 2, NULL, ?, 'Spare Parts', 1)
  `, jobId, siId, TODAY).lastInsertRowid;
  const jpIssueId = run(`
    INSERT INTO job_parts (job_id, source_type, source_id, mrn_line_id, description, qty, unit_price)
    VALUES (?, 'issue', ?, ?, 'Hydraulic Hose Assembly', 2, NULL)
  `, jobId, issUnpId, mlUnp1).lastInsertRowid;
  const jpGrnZeroId = run(`
    INSERT INTO job_parts (job_id, source_type, source_id, mrn_line_id, description, qty, unit_price)
    VALUES (?, 'grn', ?, ?, 'Bespoke Pivot Pin', 1, 0)
  `, jobId, grnZeroId, mlUnp2).lastInsertRowid;

  stock.sync({ grn: [grnNullId, grnZeroId], issues: [issUnpId] });

  // Reset si.unit_cost to 0 so it counts as unpriced store_item before cascade
  run('UPDATE store_items SET unit_cost = 0 WHERE id = ?', siId);

  // 1. Check /awaiting-price returns BOTH NULL and 0 GRNs + attaches suggested_price
  const apRes = await reqJson('/api/stores/awaiting-price', { cookie: skCookie });
  assert.equal(apRes.status, 200);
  const grnNullRow = apRes.body.find((r) => r.id === grnNullId);
  const grnZeroRow = apRes.body.find((r) => r.id === grnZeroId);
  assert.ok(grnNullRow, 'NULL price GRN must appear in awaiting-price');
  assert.ok(grnZeroRow, 'Zero price GRN must appear in awaiting-price');
  assert.equal(grnNullRow.suggested_price, 2500);
  assert.equal(grnNullRow.suggested_source, 'grn');
  assert.equal(grnZeroRow.suggested_price, null);

  // ?hint=1 filters only hinted GRNs
  const hintOnlyRes = await reqJson('/api/stores/awaiting-price?hint=1', { cookie: skCookie });
  assert.equal(hintOnlyRes.status, 200);
  assert.ok(hintOnlyRes.body.some((r) => r.id === grnNullId));
  assert.ok(!hintOnlyRes.body.some((r) => r.id === grnZeroId));

  // 2. Check /pricing-queue/summary
  const sumRes = await reqJson('/api/stores/pricing-queue/summary', { cookie: skCookie });
  assert.equal(sumRes.status, 200);
  assert.equal(sumRes.body.unpriced_grns, 2);
  assert.equal(sumRes.body.unpriced_grns_with_hint, 1);
  assert.equal(sumRes.body.unpriced_job_parts, 2);
  assert.equal(sumRes.body.unpriced_job_parts_with_hint, 1);
  assert.equal(sumRes.body.unpriced_store_items, 1);

  // 3. /grn/bulk-price rejects negative price with 400
  const negPrice = await reqJson('/api/stores/grn/bulk-price', {
    method: 'POST',
    cookie: skCookie,
    body: { rows: [{ id: grnNullId, unit_price: -50 }] },
  });
  assert.equal(negPrice.status, 400);

  // 4. Bulk price grnNullId @ 2600 -> cascades into issue, job_part, store_item, job_card, and vehicle_monthly_costs
  const bulkGrn = await reqJson('/api/stores/grn/bulk-price', {
    method: 'POST',
    cookie: skCookie,
    body: { rows: [{ id: grnNullId, unit_price: 2600, supplier: 'Hose World Updated' }] },
  });
  assert.equal(bulkGrn.status, 200, JSON.stringify(bulkGrn.body));
  assert.equal(bulkGrn.body.saved, 1);
  assert.ok(bulkGrn.body.jobs_refreshed >= 1);

  assert.equal(get('SELECT unit_price FROM grn WHERE id = ?', grnNullId).unit_price, 2600);
  assert.equal(get('SELECT unit_price FROM issues WHERE id = ?', issUnpId).unit_price, 2600);
  assert.equal(get('SELECT unit_price FROM job_parts WHERE id = ?', jpIssueId).unit_price, 2600);
  assert.equal(get('SELECT unit_cost FROM store_items WHERE id = ?', siId).unit_cost, 2600);
  assert.equal(get("SELECT unit_price FROM stock_moves WHERE source_table = 'grn' AND source_id = ?", grnNullId).unit_price, 2600);
  assert.equal(get('SELECT total_cost FROM job_cards WHERE id = ?', jobId).total_cost, 5200);
  const vmc1 = get('SELECT parts_cost, total_cost FROM vehicle_monthly_costs WHERE asset_id = 301 AND year = ? AND month = ?', YEAR, MONTH);
  assert.equal(vmc1.parts_cost, 5200);

  // 5. Remaining unpriced job_part (jpGrnZeroId) visible in /unpriced-job-parts & priced via /job-parts/bulk-price
  const ujpRes = await reqJson('/api/stores/unpriced-job-parts', { cookie: skCookie });
  assert.equal(ujpRes.status, 200);
  assert.ok(ujpRes.body.some((r) => r.id === jpGrnZeroId));
  assert.ok(!ujpRes.body.some((r) => r.id === jpIssueId));

  const jpBulkRes = await reqJson('/api/stores/job-parts/bulk-price', {
    method: 'POST',
    cookie: skCookie,
    body: { rows: [{ id: jpGrnZeroId, unit_price: 1800 }] },
  });
  assert.equal(jpBulkRes.status, 200, JSON.stringify(jpBulkRes.body));
  assert.equal(jpBulkRes.body.saved, 1);
  assert.equal(jpBulkRes.body.grns_updated, 1);
  assert.equal(get('SELECT unit_price FROM grn WHERE id = ?', grnZeroId).unit_price, 1800);
  assert.equal(get('SELECT total_cost FROM job_cards WHERE id = ?', jobId).total_cost, 7000);
  assert.ok(get("SELECT 1 x FROM audit_log WHERE entity = 'job_parts' AND action = 'bulk_price'"));
});

// =========================================================================
// PILLAR 2: Negative Stock Reconciliation & Configurable Non-Negative Issue Guard
// =========================================================================
test('Pillar 2: negative stock reconciliation (general + oil + drift + shelf) & strict issue guard with Manager override', async () => {
  // Seed negative general item, negative oil product + cache drift
  const negGenId = run(`
    INSERT INTO store_items (item_no, name, category, unit, balance, min_stock, is_general, unit_cost)
    VALUES ('GEN-NEG1', 'Negative Gasket Kit', 'General Items', 'nos', -4, 1, 1, 500)
  `).lastInsertRowid;
  run(`
    INSERT INTO stock_items (code, section, name, item_key, unit, unit_price, source_table, source_id, active)
    VALUES ('GEN-NEG1', 'general', 'Negative Gasket Kit', 'NEGATIVEGASKETKIT', 'nos', 500, 'store_items', ?, 1)
  `, negGenId);
  const gTxnNeg = run(`
    INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, unit_price, ref, txn_date, store_id)
    VALUES (?, 'issue', -4, -4, 500, 'Historical issue', ?, 1)
  `, negGenId, TODAY).lastInsertRowid;

  const negOilId = run(`
    INSERT INTO products (code, name, category, unit, reorder_level, unit_price, stock_qty, active)
    VALUES ('OIL-NEG1', 'Negative Test Oil 15W40', 'engine_oil', 'L', 20, 1400, -15, 1)
  `).lastInsertRowid;
  run(`
    INSERT INTO stock_items (code, section, name, item_key, unit, unit_price, source_table, source_id, active)
    VALUES ('OIL-NEG1', 'oil', 'Negative Test Oil 15W40', 'OILNEG1', 'L', 1400, 'products', ?, 1)
  `, negOilId);
  const oLedNeg = run(`
    INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, txn_date, note, store_id)
    VALUES (?, 'issue', -20, -20, 1400, ?, 'Historical oil issue', 1)
  `, negOilId, TODAY).lastInsertRowid;

  // Notice intentional drift: stock_qty (-15) vs ledger_balance (-20)
  stock.sync({ general_item_txns: [gTxnNeg], stock_ledger: [oLedNeg] });

  // 1. Negative stock detection reports general item, oil product, drift, and shelf items
  const negList = await reqJson('/api/stock-cockpit/negative-stock', { cookie: mgrCookie });
  assert.equal(negList.status, 200);
  assert.ok(negList.body.summary.general_count >= 1);
  assert.ok(negList.body.summary.oil_count >= 1);
  assert.ok(negList.body.summary.oil_drift_count >= 1);
  assert.equal(negList.body.policy.block_negative_issue, false);
  const oilEntry = negList.body.oil_products.find((o) => o.id === negOilId);
  assert.equal(oilEntry.stock_qty, -15);
  assert.equal(oilEntry.ledger_balance, -20);
  assert.equal(oilEntry.has_drift, true);

  // 2. Sync oil cache fixes drift between products.stock_qty and stock_ledger
  const syncCacheRes = await reqJson('/api/stock-cockpit/sync-oil-cache', { method: 'POST', cookie: mgrCookie });
  assert.equal(syncCacheRes.status, 200);
  assert.ok(syncCacheRes.body.synced >= 1);
  assert.equal(get('SELECT stock_qty FROM products WHERE id = ?', negOilId).stock_qty, -20);

  // 3. Reconcile negative authorization & validation
  const skForbidden = await reqJson('/api/stock-cockpit/reconcile-negative', {
    method: 'POST',
    cookie: skCookie,
    body: { items: [{ target_type: 'general_item', id: negGenId, counted_qty: 2, reason: 'Physical count' }] },
  });
  assert.equal(skForbidden.status, 403);

  const badNegQty = await reqJson('/api/stock-cockpit/reconcile-negative', {
    method: 'POST',
    cookie: mgrCookie,
    body: { items: [{ target_type: 'general_item', id: negGenId, counted_qty: -1, reason: 'Invalid count' }] },
  });
  assert.equal(badNegQty.status, 400);

  const badNoReason = await reqJson('/api/stock-cockpit/reconcile-negative', {
    method: 'POST',
    cookie: mgrCookie,
    body: { items: [{ target_type: 'general_item', id: negGenId, counted_qty: 2, reason: 'x' }] },
  });
  assert.equal(badNoReason.status, 400);

  // 4. Valid reconciliation zeroes oil (-20 -> 0) and sets general (-4 -> 3) atomically across all tables
  const recRes = await reqJson('/api/stock-cockpit/reconcile-negative', {
    method: 'POST',
    cookie: mgrCookie,
    body: {
      items: [
        { target_type: 'general_item', id: negGenId, counted_qty: 3, reason: 'Physical count at Main Store' },
        { target_type: 'oil_product', id: negOilId, counted_qty: 0, reason: 'Verified empty oil drum' },
      ],
    },
  });
  assert.equal(recRes.status, 200, JSON.stringify(recRes.body));
  assert.equal(recRes.body.reconciled, 2);

  assert.equal(get('SELECT balance FROM store_items WHERE id = ?', negGenId).balance, 3);
  assert.equal(stock.balanceOf('general', 'NEGATIVEGASKETKIT', 1), 3);
  assert.equal(get('SELECT stock_qty FROM products WHERE id = ?', negOilId).stock_qty, 0);
  assert.equal(get('SELECT balance_after FROM stock_ledger WHERE product_id = ? ORDER BY id DESC LIMIT 1', negOilId).balance_after, 0);
  assert.equal(stock.balanceOf('oil', 'OILNEG1', 1), 0);
  assert.ok(get("SELECT 1 x FROM audit_log WHERE entity = 'stock_reconciliation' AND action = 'reconcile_negative'"));

  // 5. Enable strict non-negative issue guard via policy endpoint
  const polOn = await reqJson('/api/stock-cockpit/guard-policy', {
    method: 'POST',
    cookie: mgrCookie,
    body: { block_negative_issue: true },
  });
  assert.equal(polOn.status, 200);
  assert.equal(polOn.body.block_negative_issue, true);

  // Storekeeper issuing 5 (when 3 in stock) is blocked with 409 & can_override: false
  const job2 = run(`
    INSERT INTO job_cards (job_no, asset_id, project_id, type, description, status, is_historical, requested_at, workshop_id)
    VALUES ('2026/11/R/SB2', 301, 10, 'repair', 'Guard check', 'IN_PROGRESS', 0, ?, 1)
  `, TODAY).lastInsertRowid;

  const skBlock = await reqJson(`/api/general-stock/items/${negGenId}/adjust`, {
    method: 'POST',
    cookie: skCookie,
    body: { txn_type: 'issue', qty: 5, job_id: job2, reason: 'Attempt past zero' },
  });
  assert.equal(skBlock.status, 409, JSON.stringify(skBlock.body));
  assert.equal(skBlock.body.can_override, false);
  assert.equal(get('SELECT balance FROM store_items WHERE id = ?', negGenId).balance, 3, 'Blocked write must roll back');

  // Issuing Supervisor (storekeeper + manager override capability) without override gets 409 with can_override: true
  const supBlock = await reqJson(`/api/general-stock/items/${negGenId}/adjust`, {
    method: 'POST',
    cookie: supCookie,
    body: { txn_type: 'issue', qty: 5, job_id: job2, reason: 'Supervisor attempt without flag' },
  });
  assert.equal(supBlock.status, 409);
  assert.equal(supBlock.body.can_override, true);

  // Issuing Supervisor with override flag but short reason -> 400
  const supShortReason = await reqJson(`/api/general-stock/items/${negGenId}/adjust`, {
    method: 'POST',
    cookie: supCookie,
    body: { txn_type: 'issue', qty: 5, job_id: job2, allow_negative_override: true, override_reason: 'ok' },
  });
  assert.equal(supShortReason.status, 400);

  // Issuing Supervisor with override flag + valid documented reason -> 201 + audit trail
  const supOverrideOk = await reqJson(`/api/general-stock/items/${negGenId}/adjust`, {
    method: 'POST',
    cookie: supCookie,
    body: {
      txn_type: 'issue',
      qty: 5,
      job_id: job2,
      allow_negative_override: true,
      override_reason: 'GRN paperwork pending arrival from Head Office',
    },
  });
  assert.equal(supOverrideOk.status, 201, JSON.stringify(supOverrideOk.body));
  assert.equal(get('SELECT balance FROM store_items WHERE id = ?', negGenId).balance, -2);
  assert.ok(get("SELECT 1 x FROM audit_log WHERE entity = 'stock_guard' AND action = 'negative_override'"));
});

// =========================================================================
// PILLAR 3: Mandatory Meter / Faulty-Meter Capture & Faulty-Meter Alert Lifecycle
// =========================================================================
test('Pillar 3: mandatory meter or faulty-meter flag with reason + METER_FAULTY alert raise & auto-clear', async () => {
  // 1. Missing both meterReading and meterFaulty -> rejected 400
  const missingBoth = await reqJson('/api/fuel/requests', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      assetCode: 'EX-301',
      runningChartNo: 'RC-SB-01',
      approxKm: 10,
      tripTotalFuel: 80,
      sourceMode: 'TANK',
      targetTankId: 'tk-bdg',
      projectId: 10,
    },
  });
  assert.equal(missingBoth.status, 400);

  // 2. meterFaulty: true without reason -> rejected 400
  const missingReason = await reqJson('/api/fuel/requests', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      assetCode: 'EX-301',
      runningChartNo: 'RC-SB-02',
      meterFaulty: true,
      meterFaultReason: 'x',
      approxKm: 10,
      tripTotalFuel: 80,
      sourceMode: 'TANK',
      targetTankId: 'tk-bdg',
      projectId: 10,
    },
  });
  assert.equal(missingReason.status, 400);

  // 3. Valid faulty-meter request with approxKm -> 201, calculates norm, stores meter_faulty=1 & meter_reading=null
  const faultyReq = await reqJson('/api/fuel/requests', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      assetCode: 'EX-301',
      runningChartNo: 'RC-SB-FAULT-1',
      meterFaulty: true,
      meterFaultReason: 'Hour meter LCD blank',
      approxKm: 10,
      tripTotalFuel: 80,
      sourceMode: 'TANK',
      targetTankId: 'tk-bdg',
      projectId: 10,
    },
  });
  assert.equal(faultyReq.status, 201, JSON.stringify(faultyReq.body));
  assert.equal(faultyReq.body.meter_faulty, true);
  assert.equal(faultyReq.body.meter_fault_reason, 'Hour meter LCD blank');
  assert.equal(faultyReq.body.meter_reading, null);
  assert.equal(faultyReq.body.recommended_litres, 80); // 10 hrs * 8.0 L/hr = 80 L
  assert.equal(faultyReq.body.status, 'APPROVED');

  // Open faulty-meter request already raises a METER_FAULTY alert
  const alertsBeforeDispense = await reqJson('/api/fuel/alerts', { cookie: adminCookie });
  assert.equal(alertsBeforeDispense.status, 200);
  assert.ok(alertsBeforeDispense.body.alerts.some((a) => a.category === 'METER_FAULTY' && a.asset_code === 'EX-301'));

  // 4. Dispense against faulty-meter request -> inherits faulty flag, no 0 meter log inserted, sets cross_check_status = METER_FAULTY
  const dispFaulty = await reqJson(`/api/fuel/requests/${faultyReq.body.id}/issue`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      litres: 80,
      sourceTankId: 'tk-bdg',
      issueDate: `${TODAY} 09:00:00`,
    },
  });
  assert.equal(dispFaulty.status, 201, JSON.stringify(dispFaulty.body));
  assert.equal(dispFaulty.body.issue.meter_faulty, true);
  assert.equal(dispFaulty.body.issue.meter_fault_reason, 'Hour meter LCD blank');
  assert.equal(dispFaulty.body.issue.meter_reading, null);
  assert.equal(dispFaulty.body.issue.cross_check_status, 'METER_FAULTY');
  assert.equal(get('SELECT COUNT(*) AS n FROM fuel_meter_readings WHERE asset_id = 301').n, 0);

  // Alert remains active while latest slip is faulty
  const alertsAfterDispense = await reqJson('/api/fuel/alerts', { cookie: adminCookie });
  const faultAlert = alertsAfterDispense.body.alerts.find((a) => a.category === 'METER_FAULTY' && a.asset_code === 'EX-301');
  assert.ok(faultAlert, 'METER_FAULTY alert must be active after faulty-meter dispense');
  assert.equal(faultAlert.severity, 'HIGH');
  assert.match(faultAlert.message, /Hour meter LCD blank/);

  // 5. Cross-Check report returns meter_faulty and filters by ?flag=METER_FAULTY
  const ccFault = await reqJson('/api/fuel/cross-check?flag=METER_FAULTY', { cookie: adminCookie });
  assert.equal(ccFault.status, 200);
  assert.equal(ccFault.body.summary.meterFaultyCount, 1);
  assert.equal(ccFault.body.rows[0].meter_faulty, true);

  // 6. Later request + issue with repaired working meterReading > 0 clears the METER_FAULTY alert
  const repairedReq = await reqJson('/api/fuel/requests', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      assetCode: 'EX-301',
      runningChartNo: 'RC-SB-FIXED-2',
      meterReading: 1510,
      approxKm: 10,
      tripTotalFuel: 80,
      sourceMode: 'TANK',
      targetTankId: 'tk-bdg',
      projectId: 10,
    },
  });
  assert.equal(repairedReq.status, 201);

  const dispRepaired = await reqJson(`/api/fuel/requests/${repairedReq.body.id}/issue`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      litres: 80,
      meterReading: 1510,
      sourceTankId: 'tk-bdg',
      issueDate: `${TODAY} 14:00:00`,
    },
  });
  assert.equal(dispRepaired.status, 201);
  assert.equal(dispRepaired.body.issue.meter_faulty, false);
  assert.equal(dispRepaired.body.issue.meter_reading, 1510);

  const alertsAfterRepair = await reqJson('/api/fuel/alerts', { cookie: adminCookie });
  assert.ok(!alertsAfterRepair.body.alerts.some((a) => a.category === 'METER_FAULTY' && a.asset_code === 'EX-301'),
    'Valid meter issue after faulty slip should auto-clear METER_FAULTY alert');

  // 7. SITE-* bulk tank transfer without meter continues to succeed
  const siteTrf = await reqJson('/api/fuel/issues', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      assetCode: 'SITE-TRF',
      litres: 150,
      sourceTankId: 'tk-bdg',
      targetProjectId: 10,
      issueDate: `${TODAY} 15:00:00`,
    },
  });
  assert.equal(siteTrf.status, 201, JSON.stringify(siteTrf.body));
});

test.after(() => {
  if (server) server.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
});
