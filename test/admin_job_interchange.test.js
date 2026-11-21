'use strict';

/**
 * Tests for System-Admin-only job card reassignment & two-way interchange
 * (daily work, parts, MRNs, MIN store issues, oil issues, general issues)
 * plus the overlapping-date-window MRN bleed fix on GET /api/jobs/:id.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-admin-interchange-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.MULTIDB = '0';
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const costing = require('../src/lib/costing');
const aliases = require('../src/lib/aliases');

migrate();

// Seed roles & users: one System Admin (`admin`) and one Workshop user (`workshop`, non-admin).
for (const n of ['admin', 'workshop', 'storekeeper']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
const adminUid = run(
  'INSERT INTO users (username, password_hash, full_name, active) VALUES (?, ?, ?, 1)',
  'sysadmin', auth.hashPassword('pw'), 'System Admin'
).lastInsertRowid;
run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', adminUid, 'admin');

const userUid = run(
  'INSERT INTO users (username, password_hash, full_name, active) VALUES (?, ?, ?, 1)',
  'supervisor', auth.hashPassword('pw'), 'Workshop Supervisor'
).lastInsertRowid;
for (const r of ['workshop', 'storekeeper']) {
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', userUid, r);
}

// Machine & mechanic setup
const ASSET = aliases.findOrCreateAsset('WP-101').id;
const OTHER_ASSET = aliases.findOrCreateAsset('WP-999').id;

run("INSERT OR IGNORE INTO mechanics (name, name_norm, active) VALUES ('Kamal', 'KAMAL', 1)");
run("INSERT OR IGNORE INTO mechanics (name, name_norm, active) VALUES ('Nimal', 'NIMAL', 1)");
run("INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Kamal', 500, '2026-01-01')");
run("INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Nimal', 400, '2026-01-01')");

// Create two overlapping job cards on the same machine (`ASSET`):
// JOB1 is CLOSED (early job card), JOB2 is IN_PROGRESS (newer job card).
const JOB1 = run(
  `INSERT INTO job_cards (job_no, type, description, status, asset_id, requested_by, requested_at, completed_at, closed_at)
   VALUES ('2026/8/R/101', 'repair', 'Early engine overhaul', 'CLOSED', ?, 'sysadmin', '2026-08-01', '2026-08-10', '2026-08-10')`,
  ASSET
).lastInsertRowid;

const JOB2 = run(
  `INSERT INTO job_cards (job_no, type, description, status, asset_id, requested_by, requested_at)
   VALUES ('2026/8/R/102', 'repair', 'Hydraulic pump repair', 'IN_PROGRESS', ?, 'sysadmin', '2026-08-05')`,
  ASSET
).lastInsertRowid;

const JOB_OTHER = run(
  `INSERT INTO job_cards (job_no, type, description, status, asset_id, requested_by, requested_at)
   VALUES ('2026/8/R/103', 'repair', 'Other machine job', 'IN_PROGRESS', ?, 'sysadmin', '2026-08-05')`,
  OTHER_ASSET
).lastInsertRowid;

// 1. Daily work entries
const DW_J1 = run(
  `INSERT INTO job_daily_work (job_id, asset_id, work_date, mechanic, description, hours, is_external, external_value)
   VALUES (?, ?, '2026-08-02', 'Kamal', 'Pump seal work (wrongly on J1)', 4, 0, 0)`,
  JOB1, ASSET
).lastInsertRowid;

const DW_J2 = run(
  `INSERT INTO job_daily_work (job_id, asset_id, work_date, mechanic, description, hours, is_external, external_value)
   VALUES (?, ?, '2026-08-06', 'Nimal', 'Engine gasket check (wrongly on J2)', 3, 0, 0)`,
  JOB2, ASSET
).lastInsertRowid;

// 2. MRN + MRN line + GRN + MIN + issue + linked job_part on JOB1 (wrongly linked to early closed card JOB1)
const MRN1 = run(
  `INSERT INTO mrn (mrn_no, req_date, asset_id, job_id, purpose, requested_by, status)
   VALUES ('MRN-8001', '2026-08-03', ?, ?, 'Hydraulic Seal Kit', 'sysadmin', 'open')`,
  ASSET, JOB1
).lastInsertRowid;
const MRNL1 = run(
  `INSERT INTO mrn_lines (mrn_id, description, category, qty, qty_received, unit)
   VALUES (?, 'Hydraulic Seal Kit', 'Spares', 2, 2, 'nos')`,
  MRN1
).lastInsertRowid;
const GRN1 = run(
  `INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, unit_price, delivery_date)
   VALUES ('GRN-8001', ?, ?, 'Hydraulic Seal Kit', 2, 1500, '2026-08-04')`,
  MRN1, MRNL1
).lastInsertRowid;

// MRN2 linked explicitly to JOB2 (must NOT bleed into JOB1 even though dates overlap within 7 days)
const MRN2 = run(
  `INSERT INTO mrn (mrn_no, req_date, asset_id, job_id, purpose, requested_by, status)
   VALUES ('MRN-8002', '2026-08-06', ?, ?, 'Filter Element', 'sysadmin', 'open')`,
  ASSET, JOB2
).lastInsertRowid;
const MRNL2 = run(
  `INSERT INTO mrn_lines (mrn_id, description, category, qty, qty_received, unit)
   VALUES (?, 'Filter Element', 'Spares', 1, 1, 'nos')`,
  MRN2
).lastInsertRowid;

// Unlinked MRN3 (`job_id IS NULL`) within the overlapping window
const MRN3_UNLINKED = run(
  `INSERT INTO mrn (mrn_no, req_date, asset_id, job_id, purpose, requested_by, status)
   VALUES ('MRN-8003', '2026-08-04', ?, NULL, 'Unlinked Bearing', 'sysadmin', 'open')`,
  ASSET
).lastInsertRowid;
run(
  `INSERT INTO mrn_lines (mrn_id, description, category, qty, qty_received, unit)
   VALUES (?, 'Unlinked Bearing', 'Spares', 1, 0, 'nos')`,
  MRN3_UNLINKED
);

// MIN + Issue + Stock move + Issue-backed job_part on JOB1
const STORE_ITEM_PART = run(
  `INSERT INTO store_items (name, part_number, category, unit, is_general, balance)
   VALUES ('Hydraulic Seal Kit', 'HSK-10', 'Spares', 'nos', 0, 10)`
).lastInsertRowid;
const MIN1 = run(
  `INSERT INTO min_notes (min_no, issue_date, asset_id, job_id, purpose, status)
   VALUES ('MIN-8001', '2026-08-04', ?, ?, 'Seal issue', 'issued')`,
  ASSET, JOB1
).lastInsertRowid;
const ISS1 = run(
  `INSERT INTO issues (store_item_id, issue_date, qty, unit_price, grn_id, min_id, asset_id, job_id, description, issued_by)
   VALUES (?, '2026-08-04', 2, 1500, ?, ?, ?, ?, 'Hydraulic Seal Kit', 'sysadmin')`,
  STORE_ITEM_PART, GRN1, MIN1, ASSET, JOB1
).lastInsertRowid;
run(
  `INSERT INTO stock_moves (section, kind, item_key, item_name, store_item_id, qty, unit_price, source_table, source_id, asset_id, job_id, mrn_line_id, grn_id, txn_date)
   VALUES ('filter', 'out', 'hydraulic seal kit', 'Hydraulic Seal Kit', ?, 2, 1500, 'issues', ?, ?, ?, ?, ?, '2026-08-04')`,
  STORE_ITEM_PART, ISS1, ASSET, JOB1, MRNL1, GRN1
);
const PART_ISS1 = run(
  `INSERT INTO job_parts (job_id, source_type, source_id, description, qty, unit_price, mrn_line_id)
   VALUES (?, 'issue', ?, 'Hydraulic Seal Kit', 2, 1500, ?)`,
  JOB1, ISS1, MRNL1
).lastInsertRowid;

// Standalone GRN-backed part on JOB2 for swap test
const PART_GRN_J2 = run(
  `INSERT INTO job_parts (job_id, source_type, source_id, description, qty, unit_price, mrn_line_id)
   VALUES (?, 'grn', NULL, 'Alternator Belt (wrongly on J2)', 1, 900, ?)`,
  JOB2, MRNL2
).lastInsertRowid;

// 3. Oil issues (`stock_ledger`) on JOB1 and JOB2
const OIL_PROD = run(
  `INSERT INTO products (code, name, unit, category, unit_price, active)
   VALUES ('HD46-T', 'Hydraulic Oil HD46', 'L', 'hydraulic', 850, 1)`
).lastInsertRowid;
const OIL_J1 = run(
  `INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, asset_id, job_id, txn_date, note)
   VALUES (?, 'issue', -5, 95, 850, ?, ?, '2026-08-04', 'Wrongly on J1')`,
  OIL_PROD, ASSET, JOB1
).lastInsertRowid;
const OIL_J2 = run(
  `INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, asset_id, job_id, txn_date, note)
   VALUES (?, 'issue', -2, 93, 850, ?, ?, '2026-08-06', 'Wrongly on J2')`,
  OIL_PROD, ASSET, JOB2
).lastInsertRowid;

// 4. General item issues (`general_item_txns`) on JOB1 and JOB2
const GEN_ITEM = run(
  `INSERT INTO store_items (name, part_number, category, unit, is_general, balance)
   VALUES ('Cotton Waste', 'GEN-CW', 'Consumables', 'kg', 1, 50)`
).lastInsertRowid;
const GEN_J1 = run(
  `INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, asset_id, job_id, unit_price, ref, txn_date)
   VALUES (?, 'issue', -2, 48, ?, ?, 300, 'CW-J1', '2026-08-04')`,
  GEN_ITEM, ASSET, JOB1
).lastInsertRowid;
const GEN_J2 = run(
  `INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, asset_id, job_id, unit_price, ref, txn_date)
   VALUES (?, 'issue', -1, 47, ?, ?, 300, 'CW-J2', '2026-08-06')`,
  GEN_ITEM, ASSET, JOB2
).lastInsertRowid;

// Snapshot JOB1's initial closed cost
costing.refreshJobTotals(JOB1);
costing.snapshotJobCost(JOB1);
costing.refreshJobTotals(JOB2);

const app = require('../src/server');
let server;
let base;
let adminCookie;
let userCookie;

async function loginAs(username, password) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

const api = async (p, { method = 'GET', body, cookie = adminCookie } = {}) => {
  const r = await fetch(base + '/api' + p, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminCookie = await loginAs('sysadmin', 'pw');
  userCookie = await loginAs('supervisor', 'pw');
});

test.after(() => server && server.close());

test('1. Non-admin users are blocked (403) from all admin reassignment & interchange endpoints', async () => {
  const cRes = await api('/jobs/admin/candidates?asset_id=' + ASSET, { cookie: userCookie });
  assert.strictEqual(cRes.status, 403);

  const rRes = await api('/jobs/admin/reassign', {
    method: 'POST',
    cookie: userCookie,
    body: { target_job_id: JOB2, items: { daily_work: [DW_J1] } },
  });
  assert.strictEqual(rRes.status, 403);

  const iRes = await api('/jobs/admin/interchange', {
    method: 'POST',
    cookie: userCookie,
    body: { job_a_id: JOB1, job_b_id: JOB2, move_a_to_b: { daily_work: [DW_J1] } },
  });
  assert.strictEqual(iRes.status, 403);

  const dwRes = await api('/daily-work/' + DW_J1, {
    method: 'PATCH',
    cookie: userCookie,
    body: { job_id: JOB2 },
  });
  assert.strictEqual(dwRes.status, 403);
});

test('2. MRN date-window bleed fix: overlapping job cards do not show MRNs explicitly linked to another job card', async () => {
  const j1 = await api('/jobs/' + JOB1);
  assert.strictEqual(j1.status, 200);
  const mrnNos1 = j1.body.mrnItems.map((m) => m.mrn_no);
  assert.ok(mrnNos1.includes('MRN-8001'), 'JOB1 must see its own MRN-8001');
  assert.ok(mrnNos1.includes('MRN-8003'), 'JOB1 may see truly unlinked MRN-8003 in window');
  assert.ok(!mrnNos1.includes('MRN-8002'), 'JOB1 must NOT bleed MRN-8002 which is explicitly linked to JOB2');

  const j2 = await api('/jobs/' + JOB2);
  assert.strictEqual(j2.status, 200);
  const mrnNos2 = j2.body.mrnItems.map((m) => m.mrn_no);
  assert.ok(mrnNos2.includes('MRN-8002'), 'JOB2 must see its own MRN-8002');
});

test('3. Admin candidate picker prioritizes same-machine job cards first', async () => {
  const res = await api(`/jobs/admin/candidates?asset_id=${ASSET}&exclude_job_id=${JOB1}`);
  assert.strictEqual(res.status, 200);
  const list = res.body;
  assert.ok(!list.some((j) => j.id === JOB1), 'exclude_job_id must be omitted');
  assert.ok(list.length >= 2);
  assert.strictEqual(list[0].id, JOB2, 'same-machine card JOB2 should come before other-machine cards');
  assert.strictEqual(list[0].same_vehicle, 1);
  const otherRow = list.find((j) => j.id === JOB_OTHER);
  assert.strictEqual(otherRow.same_vehicle, 0);
});

test('4. Admin reassigns daily_work, mrn, part+issue+min, oil_issue, and general_issue off CLOSED JOB1 onto JOB2 cleanly', async () => {
  const beforeJ1 = get('SELECT * FROM job_cards WHERE id = ?', JOB1);
  assert.ok(beforeJ1.total_cost > 0);

  const res = await api('/jobs/admin/reassign', {
    method: 'POST',
    body: {
      target_job_id: JOB2,
      items: {
        daily_work: [DW_J1],
        parts: [PART_ISS1],
        mrns: [MRN1],
        oil_issues: [OIL_J1],
        general_issues: [GEN_J1],
      },
      reason: 'Fix materials and labour mistakenly booked to earlier closed job card',
    },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);

  // Verify database rows moved cleanly onto JOB2
  assert.strictEqual(get('SELECT job_id FROM job_daily_work WHERE id = ?', DW_J1).job_id, JOB2);
  assert.strictEqual(get('SELECT job_id FROM job_parts WHERE id = ?', PART_ISS1).job_id, JOB2);
  assert.strictEqual(get('SELECT job_id FROM mrn WHERE id = ?', MRN1).job_id, JOB2);
  assert.strictEqual(get('SELECT job_id FROM issues WHERE id = ?', ISS1).job_id, JOB2);
  assert.strictEqual(get("SELECT job_id FROM stock_moves WHERE source_table = 'issues' AND source_id = ?", ISS1).job_id, JOB2);
  assert.strictEqual(get('SELECT job_id FROM min_notes WHERE id = ?', MIN1).job_id, JOB2);
  assert.strictEqual(get('SELECT job_id FROM stock_ledger WHERE id = ?', OIL_J1).job_id, JOB2);
  assert.strictEqual(get('SELECT job_id FROM general_item_txns WHERE id = ?', GEN_J1).job_id, JOB2);

  // Verify JOB1 no longer sees MRN-8001 in GET /api/jobs/:id (neither directly nor via bleed window)
  const j1Detail = await api('/jobs/' + JOB1);
  assert.ok(!j1Detail.body.mrnItems.some((m) => m.mrn_no === 'MRN-8001'));
  const j2Detail = await api('/jobs/' + JOB2);
  assert.ok(j2Detail.body.mrnItems.some((m) => m.mrn_no === 'MRN-8001'));

  // Verify costs recomputed & CLOSED snapshot updated on JOB1:
  // JOB1 now has 0 labour, 0 parts, 0 oil => snapshot updated to 0
  const afterJ1 = get('SELECT * FROM job_cards WHERE id = ?', JOB1);
  const snapJ1 = get('SELECT * FROM job_costs WHERE job_id = ? ORDER BY id DESC LIMIT 1', JOB1);
  assert.strictEqual(afterJ1.total_cost, 0);
  assert.strictEqual(snapJ1.total_cost, 0);

  // JOB2 now has:
  // - Labour: DW_J1 (Kamal 4h * 500 = 2000) + DW_J2 (Nimal 3h * 400 = 1200) = 3200
  // - Material (parts): PART_ISS1 (2 * 1500 = 3000) + PART_GRN_J2 (1 * 900 = 900) = 3900
  // - Oil: OIL_J1 (5 * 850 = 4250) + OIL_J2 (2 * 850 = 1700) = 5950
  // - General: GEN_J1 (2 * 300 = 600) + GEN_J2 (1 * 300 = 300) = 900
  // Total = 3200 + 3900 + 5950 + 900 = 13950
  const afterJ2 = get('SELECT * FROM job_cards WHERE id = ?', JOB2);
  assert.strictEqual(afterJ2.labour_cost, 3200);
  assert.strictEqual(afterJ2.material_cost, 3900);
  assert.strictEqual(afterJ2.oil_cost, 5950);
  assert.strictEqual(afterJ2.general_cost, 900);
  assert.strictEqual(afterJ2.total_cost, 13950);

  // Audit record persisted
  const auditRow = get("SELECT * FROM audit_log WHERE action = 'admin_reassign_items' ORDER BY id DESC LIMIT 1");
  assert.ok(auditRow, 'Audit trail entry should exist');
});

test('5. Admin PATCH /api/daily-work/:id allows moving daily work back onto CLOSED JOB1', async () => {
  const res = await api('/daily-work/' + DW_J1, {
    method: 'PATCH',
    body: { job_id: JOB1 },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.job_id, JOB1);
  assert.strictEqual(get('SELECT job_id FROM job_daily_work WHERE id = ?', DW_J1).job_id, JOB1);
  // Closed snapshot of JOB1 recomputed to 2000 (Kamal 4h * 500)
  assert.strictEqual(get('SELECT total_cost FROM job_cards WHERE id = ?', JOB1).total_cost, 2000);
  assert.strictEqual(get('SELECT total_cost FROM job_costs WHERE job_id = ? ORDER BY id DESC LIMIT 1', JOB1).total_cost, 2000);
});

test('6. Admin two-way interchange swaps items atomically between JOB1 and JOB2', async () => {
  // Currently: JOB1 holds [DW_J1]; JOB2 holds [DW_J2, PART_ISS1, PART_GRN_J2, MRN1, MRN2, OIL_J1, OIL_J2, GEN_J1, GEN_J2].
  // Swap DW_J1 (J1 -> J2) in exchange for DW_J2, PART_GRN_J2, OIL_J2, GEN_J2 (J2 -> J1).
  const res = await api('/jobs/admin/interchange', {
    method: 'POST',
    body: {
      job_a_id: JOB1,
      job_b_id: JOB2,
      move_a_to_b: { daily_work: [DW_J1] },
      move_b_to_a: {
        daily_work: [DW_J2],
        parts: [PART_GRN_J2],
        mrns: [MRN2],
        oil_issues: [OIL_J2],
        general_issues: [GEN_J2],
      },
      reason: 'Two-way swap between overhaul card and pump card',
    },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);

  assert.strictEqual(get('SELECT job_id FROM job_daily_work WHERE id = ?', DW_J1).job_id, JOB2);
  assert.strictEqual(get('SELECT job_id FROM job_daily_work WHERE id = ?', DW_J2).job_id, JOB1);
  assert.strictEqual(get('SELECT job_id FROM job_parts WHERE id = ?', PART_GRN_J2).job_id, JOB1);
  assert.strictEqual(get('SELECT job_id FROM mrn WHERE id = ?', MRN2).job_id, JOB1);
  assert.strictEqual(get('SELECT job_id FROM stock_ledger WHERE id = ?', OIL_J2).job_id, JOB1);
  assert.strictEqual(get('SELECT job_id FROM general_item_txns WHERE id = ?', GEN_J2).job_id, JOB1);

  // Check totals on both cards after swap:
  // JOB1: DW_J2 (1200) + PART_GRN_J2 (900) + OIL_J2 (2 * 850 = 1700) + GEN_J2 (1 * 300 = 300) = 4100
  const finalJ1 = get('SELECT * FROM job_cards WHERE id = ?', JOB1);
  assert.strictEqual(finalJ1.labour_cost, 1200);
  assert.strictEqual(finalJ1.material_cost, 900);
  assert.strictEqual(finalJ1.oil_cost, 1700);
  assert.strictEqual(finalJ1.general_cost, 300);
  assert.strictEqual(finalJ1.total_cost, 4100);
  assert.strictEqual(get('SELECT total_cost FROM job_costs WHERE job_id = ? ORDER BY id DESC LIMIT 1', JOB1).total_cost, 4100);

  // JOB2: DW_J1 (2000) + PART_ISS1 (3000) + OIL_J1 (4250) + GEN_J1 (600) = 9850
  const finalJ2 = get('SELECT * FROM job_cards WHERE id = ?', JOB2);
  assert.strictEqual(finalJ2.labour_cost, 2000);
  assert.strictEqual(finalJ2.material_cost, 3000);
  assert.strictEqual(finalJ2.oil_cost, 4250);
  assert.strictEqual(finalJ2.general_cost, 600);
  assert.strictEqual(finalJ2.total_cost, 9850);

  const auditSwap = get("SELECT * FROM audit_log WHERE action = 'admin_interchange_items' ORDER BY id DESC LIMIT 1");
  assert.ok(auditSwap, 'Interchange audit record should exist');
});
