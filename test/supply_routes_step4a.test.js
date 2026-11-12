'use strict';

// ===========================================================================
// WorkshopOne — Step 4a Test Suite: Supply Routes & Line-by-Line Quantities
//
// Rules verified:
//   1. 4 Supply Routes:
//      - main_store: Stock transfer from Central Store (auto-MTN)
//      - head_office: Head Office centralized procurement queue
//      - local_purchase: Site local buy, strictly capped at Rs 25,000 (Decision D4)
//      - direct_delivery: Direct vendor delivery straight to site
//   2. Line-by-Line Quantity Progression:
//      qty (requested) → qty_approved → qty_sent → qty_received → qty_issued
//   3. Auto-MTN Generation:
//      - When MRN is approved for site workshop with main_store items, auto-draft MTN.
//      - When MRN is for Central Workshop (ID 1), no MTN generated (co-located).
//   4. Pipeline Hooks:
//      - MTN dispatch → increments qty_sent.
//      - MTN accept → increments qty_received.
//      - Issue creation → increments qty_issued.
//      - Issue return → decrements qty_issued.
//   5. Decision D4 ceiling:
//      - Local purchase strictly capped at Rs. 25,000 per request.
//   6. API endpoints:
//      - GET /api/stores/supply-routes
//      - PATCH /api/stores/mrn/line/:id/route
//      - GET /api/stores/mrn/:id/pipeline
// ===========================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-step4a-'));
process.env.DB_PATH = path.join(TMP, 'step4a.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const supplyRoutes = require('../src/lib/supply_routes');
const auth = require('../src/lib/auth');

migrate();

// Seed roles
for (const n of ['admin', 'storekeeper', 'workshop', 'operational_manager', 'transport_manager', 'viewer']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
run("INSERT OR IGNORE INTO roles (name, label) VALUES ('stores_writer', 'Stores writer')");
run("INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES ('stores_writer', 'stores', 'full')");

// Seed workshops: 1 = Central Workshop, 2 = Badalgama Site Workshop
run("INSERT OR IGNORE INTO workshops (id, name, code, is_default, own_store) VALUES (1, 'Central Workshop', 'CENTRAL', 1, 1)");
run("INSERT OR IGNORE INTO workshops (id, name, code, is_default, own_store) VALUES (2, 'Badalgama Site', 'BDG', 0, 1)");

// Seed users
const PW = 'password-salt-hash-123';
function makeUser(username, role, wsId = null) {
  run('INSERT OR IGNORE INTO users (username, password_hash, full_name, active, workshop_id) VALUES (?, ?, ?, 1, ?)',
    username, auth.hashPassword(PW), username, wsId);
  const u = get('SELECT id, username, full_name, workshop_id FROM users WHERE username = ?', username);
  run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', u.id, role);
  return { ...u, role };
}

const adminUser = makeUser('admin_user', 'admin');
const skUser = makeUser('sk_site', 'storekeeper', 2);
const mgrUser = makeUser('mgr_user', 'operational_manager');

// Seed items
run("INSERT OR IGNORE INTO store_items (id, name, unit, is_general, balance) VALUES (1, 'Air Filter Cat 320', 'nos', 1, 50)");
run("INSERT OR IGNORE INTO store_items (id, name, unit, is_general, balance) VALUES (2, 'Hydraulic Hose 1/2in', 'mtr', 1, 100)");
run("INSERT OR IGNORE INTO store_items (id, name, unit, is_general, balance) VALUES (3, 'Special Seal Ring', 'nos', 0, 0)");

// Seed reference pricing in GRN
run("INSERT OR IGNORE INTO grn (id, grn_no, store_item_id, description, unit_price, qty) VALUES (1, 'GRN-P-001', 1, 'Air Filter Cat 320', 8000, 10)");
run("INSERT OR IGNORE INTO grn (id, grn_no, store_item_id, description, unit_price, qty) VALUES (2, 'GRN-P-002', 2, 'Hydraulic Hose 1/2in', 3000, 20)");
run("INSERT OR IGNORE INTO grn (id, grn_no, store_item_id, description, unit_price, qty) VALUES (3, 'GRN-P-003', 3, 'Special Seal Ring', 15000, 5)");

test('Step 4a: Database schema has all supply route & pipeline columns', () => {
  const lineCols = all("PRAGMA table_info('mrn_lines')").map((c) => c.name);
  assert(lineCols.includes('supply_route'), 'mrn_lines.supply_route must exist');
  assert(lineCols.includes('qty_approved'), 'mrn_lines.qty_approved must exist');
  assert(lineCols.includes('qty_sent'), 'mrn_lines.qty_sent must exist');
  assert(lineCols.includes('qty_issued'), 'mrn_lines.qty_issued must exist');
  assert(lineCols.includes('auto_mtn_id'), 'mrn_lines.auto_mtn_id must exist');
  assert(lineCols.includes('route_assigned_by'), 'mrn_lines.route_assigned_by must exist');
  assert(lineCols.includes('route_assigned_at'), 'mrn_lines.route_assigned_at must exist');
  assert(lineCols.includes('route_assigned_reason'), 'mrn_lines.route_assigned_reason must exist');

  const mtnCols = all("PRAGMA table_info('mtn')").map((c) => c.name);
  assert(mtnCols.includes('mrn_id'), 'mtn.mrn_id must exist');
  assert(mtnCols.includes('auto_generated'), 'mtn.auto_generated must exist');

  const mtnLineCols = all("PRAGMA table_info('mtn_lines')").map((c) => c.name);
  assert(mtnLineCols.includes('mrn_id'), 'mtn_lines.mrn_id must exist');
  assert(mtnLineCols.includes('mrn_line_id'), 'mtn_lines.mrn_line_id must exist');

  const issueCols = all("PRAGMA table_info('issues')").map((c) => c.name);
  assert(issueCols.includes('mrn_line_id'), 'issues.mrn_line_id must exist');
});

test('Step 4a: Supply route validation and constants', () => {
  assert.strictEqual(supplyRoutes.ROUTES.length, 4);
  assert(supplyRoutes.ROUTES.includes('main_store'));
  assert(supplyRoutes.ROUTES.includes('head_office'));
  assert(supplyRoutes.ROUTES.includes('local_purchase'));
  assert(supplyRoutes.ROUTES.includes('direct_delivery'));

  assert.strictEqual(supplyRoutes.validateRoute('main_store'), true);
  assert.strictEqual(supplyRoutes.validateRoute('head_office'), true);
  assert.strictEqual(supplyRoutes.validateRoute('local_purchase'), true);
  assert.strictEqual(supplyRoutes.validateRoute('direct_delivery'), true);

  assert.strictEqual(supplyRoutes.validateRoute('central_store'), false);
  assert.strictEqual(supplyRoutes.validateRoute(''), false);
  assert.strictEqual(supplyRoutes.validateRoute(null), false);

  assert.strictEqual(supplyRoutes.LOCAL_PURCHASE_CEILING, 25000);
});

test('Step 4a: Decision D4 - Site Local Purchase spending ceiling (Rs 25,000)', () => {
  // Create an MRN for testing ceiling
  const mrnInfo = run(`
    INSERT INTO mrn (mrn_no, req_date, workshop_id, approval_status, requested_by)
    VALUES ('MRN-CEIL-001', '2026-10-05', 2, 'requested', 'sk_site')
  `);
  const mrnId = mrnInfo.lastInsertRowid;

  // 1. Line under ceiling (Rs 16,000 <= 25,000) -> Allowed
  const r1 = supplyRoutes.checkLocalPurchaseLimit(mrnId, null, 16000);
  assert.strictEqual(r1.ok, true);

  // 2. Line over ceiling (Rs 30,000 > 25,000) -> Blocked
  const r2 = supplyRoutes.checkLocalPurchaseLimit(mrnId, null, 30000);
  assert.strictEqual(r2.ok, false);
  assert.match(r2.error, /Decision D4/);

  // 3. Add a line of Rs 16,000 to DB as local_purchase
  run(`
    INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty, unit, supply_route, purchase_source)
    VALUES (?, 1, 'Air Filter Cat 320', 2, 'nos', 'local_purchase', 'local_purchase')
  `, mrnId);

  // 4. Adding another local purchase of Rs 10,000 pushes cumulative to Rs 26,000 -> Blocked
  const r3 = supplyRoutes.checkLocalPurchaseLimit(mrnId, null, 10000);
  assert.strictEqual(r3.ok, false);
  assert.match(r3.error, /Decision D4/);

  // 5. Adding Rs 8,000 (cumulative Rs 24,000 <= 25,000) -> Allowed
  const r4 = supplyRoutes.checkLocalPurchaseLimit(mrnId, null, 8000);
  assert.strictEqual(r4.ok, true);
});

test('Step 4a: Line route assignment & audit trail (setLineRoute)', () => {
  const mrnInfo = run(`
    INSERT INTO mrn (mrn_no, req_date, workshop_id, approval_status, requested_by)
    VALUES ('MRN-ROUTE-001', '2026-10-05', 2, 'requested', 'sk_site')
  `);
  const mrnId = mrnInfo.lastInsertRowid;

  const lineInfo = run(`
    INSERT INTO mrn_lines (mrn_id, description, qty, unit, supply_route)
    VALUES (?, 'Fan Belt 340', 2, 'nos', 'main_store')
  `, mrnId);
  const lineId = lineInfo.lastInsertRowid;

  // Change route to head_office
  const updated = supplyRoutes.setLineRoute(lineId, 'head_office', adminUser, 'Not in main store inventory');
  assert.strictEqual(updated.supply_route, 'head_office');
  assert.strictEqual(updated.purchase_source, 'head_office');
  assert.strictEqual(updated.route_assigned_by, 'admin_user');
  assert.strictEqual(updated.route_assigned_reason, 'Not in main store inventory');

  // Audit record written
  const auditRec = get("SELECT * FROM audit_log WHERE entity = 'mrn_line' AND entity_id = ? ORDER BY id DESC LIMIT 1", lineId);
  assert(auditRec, 'Audit record must be created');
  assert.strictEqual(auditRec.action, 'route_assignment');
});

test('Step 4a: Quantity Progression & Auto-MTN generation on MRN approval', () => {
  // Site workshop raises MRN with 3 lines across routes
  const mrnInfo = run(`
    INSERT INTO mrn (mrn_no, req_date, workshop_id, approval_status, requested_by)
    VALUES ('MRN-FLOW-001', '2026-10-05', 2, 'requested', 'sk_site')
  `);
  const mrnId = mrnInfo.lastInsertRowid;

  // Line 1: main_store, 10 units
  const l1 = run(`
    INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty, unit, supply_route)
    VALUES (?, 1, 'Air Filter Cat 320', 10, 'nos', 'main_store')
  `, mrnId).lastInsertRowid;

  // Line 2: head_office, 5 units
  const l2 = run(`
    INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty, unit, supply_route)
    VALUES (?, 2, 'Hydraulic Hose 1/2in', 5, 'mtr', 'head_office')
  `, mrnId).lastInsertRowid;

  // Line 3: local_purchase, 2 units
  const l3 = run(`
    INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty, unit, supply_route)
    VALUES (?, 3, 'Special Seal Ring', 2, 'nos', 'local_purchase')
  `, mrnId).lastInsertRowid;

  // Approve the MRN
  run("UPDATE mrn SET approval_status = 'approved', approved_by = 'mgr_user', approved_at = '2026-10-05T10:00:00Z' WHERE id = ?", mrnId);
  supplyRoutes.onMrnApproved(mrnId, mgrUser);

  // 1. Check qty_approved set on all lines
  const row1 = get('SELECT * FROM mrn_lines WHERE id = ?', l1);
  const row2 = get('SELECT * FROM mrn_lines WHERE id = ?', l2);
  const row3 = get('SELECT * FROM mrn_lines WHERE id = ?', l3);
  assert.strictEqual(Number(row1.qty_approved), 10, 'Line 1 qty_approved must equal qty');
  assert.strictEqual(Number(row2.qty_approved), 5, 'Line 2 qty_approved must equal qty');
  assert.strictEqual(Number(row3.qty_approved), 2, 'Line 3 qty_approved must equal qty');

  // 2. Check auto-MTN draft generated for main_store line
  assert(row1.auto_mtn_id, 'Line 1 must be linked to auto-MTN');
  const autoMtn = get('SELECT * FROM mtn WHERE id = ?', row1.auto_mtn_id);
  assert(autoMtn, 'Auto MTN record must exist');
  assert.strictEqual(autoMtn.auto_generated, 1, 'MTN must be flagged as auto_generated');
  assert.strictEqual(autoMtn.mrn_id, mrnId, 'MTN must reference the MRN ID');
  assert.strictEqual(autoMtn.from_location, 'Central Workshop — Badalgama', 'Source workshop must be Central Store');
  assert.strictEqual(autoMtn.to_location, 'Badalgama Site', 'Destination workshop must be Badalgama');
  assert.strictEqual(autoMtn.status, 'draft', 'Auto MTN must start in draft status');

  const mtnLines = all('SELECT * FROM mtn_lines WHERE mtn_id = ?', autoMtn.id);
  assert.strictEqual(mtnLines.length, 1, 'MTN must have exactly 1 line');
  assert.strictEqual(mtnLines[0].mrn_line_id, l1, 'MTN line must reference mrn_line_id');
  assert.strictEqual(Number(mtnLines[0].qty), 10, 'MTN line qty must match');

  // Head Office and Local Purchase lines must NOT be in MTN
  assert.strictEqual(row2.auto_mtn_id, null, 'Line 2 (head_office) must not have auto_mtn_id');
  assert.strictEqual(row3.auto_mtn_id, null, 'Line 3 (local_purchase) must not have auto_mtn_id');

  // 3. MTN Dispatch Hook: increments qty_sent
  run("UPDATE mtn SET status = 'dispatched' WHERE id = ?", autoMtn.id);
  supplyRoutes.onMtnDispatched(autoMtn.id);
  const row1Sent = get('SELECT qty_sent FROM mrn_lines WHERE id = ?', l1);
  assert.strictEqual(Number(row1Sent.qty_sent), 10, 'qty_sent must increment upon dispatch');

  // 4. MTN Accept Hook: increments qty_received
  run("UPDATE mtn SET status = 'accepted', accepted_at = '2026-10-05T12:00:00Z' WHERE id = ?", autoMtn.id);
  supplyRoutes.onMtnAccepted(autoMtn.id);
  const row1Recv = get('SELECT qty_received FROM mrn_lines WHERE id = ?', l1);
  assert.strictEqual(Number(row1Recv.qty_received), 10, 'qty_received must increment upon acceptance');

  // 5. Issue Created Hook: increments qty_issued
  supplyRoutes.onIssueCreated(l1, 4);
  const row1Iss = get('SELECT qty_issued FROM mrn_lines WHERE id = ?', l1);
  assert.strictEqual(Number(row1Iss.qty_issued), 4, 'qty_issued must increment to 4');

  // 6. Issue Returned Hook: decrements qty_issued
  supplyRoutes.onIssueReturned(l1, 1);
  const row1Ret = get('SELECT qty_issued FROM mrn_lines WHERE id = ?', l1);
  assert.strictEqual(Number(row1Ret.qty_issued), 3, 'qty_issued must decrement to 3');
});

test('Step 4a: Central Workshop (ID 1) does NOT generate MTN for main_store items', () => {
  const mrnInfo = run(`
    INSERT INTO mrn (mrn_no, req_date, workshop_id, approval_status, requested_by)
    VALUES ('MRN-CENTRAL-001', '2026-10-05', 1, 'requested', 'sk_central')
  `);
  const mrnId = mrnInfo.lastInsertRowid;

  const lId = run(`
    INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty, unit, supply_route)
    VALUES (?, 1, 'Air Filter Cat 320', 3, 'nos', 'main_store')
  `, mrnId).lastInsertRowid;

  run("UPDATE mrn SET approval_status = 'approved' WHERE id = ?", mrnId);
  supplyRoutes.onMrnApproved(mrnId, mgrUser);

  const line = get('SELECT * FROM mrn_lines WHERE id = ?', lId);
  assert.strictEqual(Number(line.qty_approved), 3, 'qty_approved must be set');
  assert.strictEqual(line.auto_mtn_id, null, 'No auto-MTN generated for Central Workshop');
});

test('Step 4a: Full pipeline retrieval (getMrnPipeline)', () => {
  const mrn = get("SELECT id FROM mrn WHERE mrn_no = 'MRN-FLOW-001'");
  assert(mrn, 'MRN-FLOW-001 must exist');

  const pipeline = supplyRoutes.getMrnPipeline(mrn.id);
  assert.strictEqual(pipeline.length, 3, 'Must return 3 pipeline lines');

  const l1 = pipeline.find((p) => p.description === 'Air Filter Cat 320');
  assert(l1, 'Line 1 must exist');
  assert.strictEqual(Number(l1.qty_requested), 10);
  assert.strictEqual(Number(l1.qty_approved), 10);
  assert.strictEqual(Number(l1.qty_sent), 10);
  assert.strictEqual(Number(l1.qty_received), 10);
  assert.strictEqual(Number(l1.qty_issued), 3);
  assert.strictEqual(l1.supply_route, 'main_store');
  assert.strictEqual(l1.pipeline_stage, 'received');
  assert(l1.auto_mtn_no, 'Auto MTN number must be populated');
});

const app = require('../src/server');
let server;
let base;
let adminCookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin_user', password: PW }),
  });
  adminCookie = res.headers.get('set-cookie');
});

test.after(async () => {
  if (server) await new Promise((res) => server.close(res));
});

test('Step 4a: GET /api/stores/supply-routes returns routes & ceiling', async () => {
  const res = await fetch(`${base}/api/stores/supply-routes`, {
    headers: { cookie: adminCookie },
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.ceiling, 25000);
  assert(Array.isArray(data.routes));
  assert.strictEqual(data.routes.length, 4);
  assert(data.labels.main_store);
  assert(data.badges.main_store);
});

test('Step 4a: PATCH /api/stores/mrn/line/:id/route updates route and records audit', async () => {
  const line = get("SELECT id FROM mrn_lines WHERE description = 'Fan Belt 340' LIMIT 1");
  assert(line, 'Fan Belt line must exist');

  const res = await fetch(`${base}/api/stores/mrn/line/${line.id}/route`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      cookie: adminCookie,
    },
    body: JSON.stringify({
      supply_route: 'direct_delivery',
      reason: 'Delivered directly to site by local vendor',
    }),
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.ok, true);
  assert.strictEqual(data.line.supply_route, 'direct_delivery');
  assert.strictEqual(data.line.route_assigned_reason, 'Delivered directly to site by local vendor');
});

test('Step 4a: PATCH /api/stores/mrn/line/:id/route validates routes', async () => {
  const line = get("SELECT id FROM mrn_lines WHERE description = 'Fan Belt 340' LIMIT 1");
  const res = await fetch(`${base}/api/stores/mrn/line/${line.id}/route`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      cookie: adminCookie,
    },
    body: JSON.stringify({
      supply_route: 'invalid_route',
    }),
  });
  assert.strictEqual(res.status, 400);
});

test('Step 4a: GET /api/stores/mrn/:id/pipeline returns line progression', async () => {
  const mrn = get("SELECT id FROM mrn WHERE mrn_no = 'MRN-FLOW-001'");
  const res = await fetch(`${base}/api/stores/mrn/${mrn.id}/pipeline`, {
    headers: { cookie: adminCookie },
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.mrn.id, mrn.id);
  assert(Array.isArray(data.pipeline));
  assert.strictEqual(data.pipeline.length, 3);
  const l1 = data.pipeline.find((l) => l.description === 'Air Filter Cat 320');
  assert.strictEqual(l1.pipeline_stage, 'received');
  assert(l1.auto_mtn_no);
});

