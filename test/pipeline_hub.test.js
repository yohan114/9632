'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), 'workshopone-pipeline-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();
for (const n of ['admin', 'storekeeper', 'workshop']) run('INSERT INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'sk_pipe', auth.hashPassword('pw')).lastInsertRowid;
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
    body: JSON.stringify({ username: 'sk_pipe', password: 'pw' }),
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

test('pipeline hub summary endpoint reports live counts', async () => {
  const r = await api('/stores/pipeline/summary');
  assert.strictEqual(r.status, 200);
  assert(typeof r.body.requests_pending === 'number');
  assert(typeof r.body.awaiting_delivery === 'number');
  assert(typeof r.body.ready_in_store === 'number');
  assert(typeof r.body.issued_today === 'number');
});

test('shelf received items can be queried across all vehicles with allow_empty=1', async () => {
  const r = await api('/stores/received?allow_empty=1');
  assert.strictEqual(r.status, 200);
  assert(Array.isArray(r.body));
});

test('creating MRN, GRN, and querying job card shows shelf readiness', async () => {
  // 1. Create asset and job card
  const aId = run("INSERT INTO assets (code, code_norm, registration, status) VALUES ('TR-999', 'TR999', 'WP-TR-999', 'active')").lastInsertRowid;
  const jId = run("INSERT INTO job_cards (job_no, asset_id, status, description, type) VALUES ('JC-999', ?, 'IN_PROGRESS', 'Test job', 'repair')", aId).lastInsertRowid;

  // 2. Create MRN linked to job
  const mrnId = run("INSERT INTO mrn (mrn_no, req_date, asset_id, job_id, status, requested_by) VALUES ('MRN-999', '2026-09-12', ?, ?, 'open', 'sk_pipe')", aId, jId).lastInsertRowid;
  const mlId = run("INSERT INTO mrn_lines (mrn_id, description, qty, qty_received) VALUES (?, 'Oil Filter OF-99', 2, 2)", mrnId).lastInsertRowid;

  // 3. Create GRN receipt for 2 units
  const grnId = run("INSERT INTO grn (grn_no, delivery_date, mrn_id, mrn_line_id, description, qty, unit_price) VALUES ('GRN-999', '2026-09-12', ?, ?, 'Oil Filter OF-99', 2, 1500)", mrnId, mlId).lastInsertRowid;

  // 4. Check summary reflects ready_in_store
  const sum = await api('/stores/pipeline/summary');
  assert(sum.body.ready_in_store >= 1);

  // 5. Query /api/stores/received with allow_empty=1
  const rec = await api('/stores/received?allow_empty=1&q=OF-99');
  assert.strictEqual(rec.status, 200);
  assert(rec.body.length >= 1);
  const found = rec.body.find((x) => x.grn_id === grnId);
  assert(found != null);
  assert.strictEqual(found.remaining, 2);
  assert.strictEqual(found.job_id, jId);

  // 6. Query job card and verify mrnItems includes shelf readiness
  const jobRes = await api('/jobs/' + jId);
  assert.strictEqual(jobRes.status, 200);
  const mrnItems = jobRes.body.mrnItems;
  assert(Array.isArray(mrnItems));
  const mItem = mrnItems.find((x) => x.mrn_id === mrnId);
  assert(mItem != null);
  assert.strictEqual(mItem.remaining_in_store, 2);
  assert.strictEqual(mItem.grn_id, grnId);
});
