'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), 'workshopone-trace-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, run } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();
for (const n of ['admin', 'storekeeper', 'workshop']) run('INSERT INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'sk_trace', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ['admin', 'storekeeper', 'workshop']) {
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
}

const app = require('../src/server');
let server;
let base;
let cookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'sk_trace', password: 'pw' }),
  });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
});

test.after(() => server && server.close());

const api = async (p, opts = {}) => {
  const r = await fetch(base + '/api' + p, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('pipeline trace fails with 400 when missing query parameters', async () => {
  const r = await api('/stores/pipeline/trace');
  assert.strictEqual(r.status, 400);
});

test('pipeline trace fails with 404 when job does not exist', async () => {
  const r = await api('/stores/pipeline/trace?job_id=999999');
  assert.strictEqual(r.status, 404);
});

test('pipeline trace by job_id tracks complete lifecycle and detects uncollected shelf parts', async () => {
  // 1. Setup asset, job card, MRN, GRN, and partial issue
  const aId = run("INSERT INTO assets (code, code_norm, registration, status) VALUES ('EX-444', 'EX444', 'WP-EX-444', 'active')").lastInsertRowid;
  const jId = run("INSERT INTO job_cards (job_no, asset_id, status, description, type) VALUES ('JC-444', ?, 'IN_PROGRESS', 'Hydraulic overhaul', 'repair')", aId).lastInsertRowid;

  const mrnId = run("INSERT INTO mrn (mrn_no, req_date, asset_id, job_id, status, approval_status, requested_by) VALUES ('MRN-444', '2026-09-12', ?, ?, 'open', 'approved', 'sk_trace')", aId, jId).lastInsertRowid;
  const mlId1 = run("INSERT INTO mrn_lines (mrn_id, description, qty, qty_received, unit, category) VALUES (?, 'Seal Kit SK-10', 4, 4, 'nos', 'Spares')", mrnId).lastInsertRowid;
  const mlId2 = run("INSERT INTO mrn_lines (mrn_id, description, qty, qty_received, unit, category) VALUES (?, 'Pressure Valve PV-20', 2, 0, 'nos', 'Spares')", mrnId).lastInsertRowid;

  // GRN for 4 seal kits at Rs 2,500 each
  const grnId = run("INSERT INTO grn (grn_no, delivery_date, mrn_id, mrn_line_id, description, qty, unit_price) VALUES ('GRN-444', '2026-09-12', ?, ?, 'Seal Kit SK-10', 4, 2500)", mrnId, mlId1).lastInsertRowid;

  // Issue 1 unit to job card, leaving 3 on shelf
  const issueId = run("INSERT INTO issues (issue_date, job_id, asset_id, grn_id, description, qty, unit_price, issued_by) VALUES ('2026-09-12', ?, ?, ?, 'Seal Kit SK-10', 1, 2500, 'sk_trace')", jId, aId, grnId).lastInsertRowid;

  // Query trace by job_id
  const r = await api(`/stores/pipeline/trace?job_id=${jId}`);
  assert.strictEqual(r.status, 200);

  const b = r.body;
  assert.strictEqual(b.root.type, 'job');
  assert.strictEqual(b.root.id, jId);
  assert.strictEqual(b.job.job_no, 'JC-444');
  assert.strictEqual(b.job.asset_code, 'EX-444');

  // Verify MRN and items
  assert.strictEqual(b.mrns.length, 1);
  assert.strictEqual(b.items.length, 2);

  const sealLine = b.items.find(x => x.mrn_line_id === mlId1);
  assert(sealLine != null);
  assert.strictEqual(sealLine.qty_requested, 4);
  assert.strictEqual(sealLine.qty_received, 4);
  assert.strictEqual(sealLine.qty_issued, 1);
  assert.strictEqual(sealLine.qty_on_shelf, 3);
  assert.strictEqual(sealLine.stage, 'READY_ON_SHELF');

  const valveLine = b.items.find(x => x.mrn_line_id === mlId2);
  assert(valveLine != null);
  assert.strictEqual(valveLine.qty_requested, 2);
  assert.strictEqual(valveLine.qty_received, 0);
  assert.strictEqual(valveLine.stage, 'AWAITING_DELIVERY');

  // Verify Summary & Integrity
  assert.strictEqual(b.summary.total_qty_requested, 6);
  assert.strictEqual(b.summary.total_qty_received, 4);
  assert.strictEqual(b.summary.total_qty_issued, 1);
  assert.strictEqual(b.summary.total_qty_on_shelf, 3);
  assert.strictEqual(b.summary.total_received_cost, 10000); // 4 * 2500
  assert.strictEqual(b.summary.total_issued_cost, 2500); // 1 * 2500

  assert.strictEqual(b.integrity.is_safe_to_close, false);
  assert.strictEqual(b.integrity.uncollected_shelf_parts_count, 1);
  assert.strictEqual(b.integrity.pending_delivery_count, 1);

  // Test bidirectional query by MRN
  const rMrn = await api(`/stores/pipeline/trace?mrn_id=${mrnId}`);
  assert.strictEqual(rMrn.status, 200);
  assert.strictEqual(rMrn.body.root.type, 'mrn');
  assert.strictEqual(rMrn.body.job.job_no, 'JC-444');

  // Test bidirectional query by GRN
  const rGrn = await api(`/stores/pipeline/trace?grn_id=${grnId}`);
  assert.strictEqual(rGrn.status, 200);
  assert.strictEqual(rGrn.body.root.type, 'grn');
  assert.strictEqual(rGrn.body.job.job_no, 'JC-444');

  // Test bidirectional query by Issue
  const rIss = await api(`/stores/pipeline/trace?issue_id=${issueId}`);
  assert.strictEqual(rIss.status, 200);
  assert.strictEqual(rIss.body.root.type, 'issue');
  assert.strictEqual(rIss.body.job.job_no, 'JC-444');
});
