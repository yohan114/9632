'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), 'workshopone-repsec-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, run } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();
for (const n of ['admin', 'workshop', 'operational_manager']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'admin_rep', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ['admin', 'workshop', 'operational_manager']) {
  run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
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
    body: JSON.stringify({ username: 'admin_rep', password: 'pw' }),
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

test('GET /reports/repair-sections requires year and month', async () => {
  const r = await api('/reports/repair-sections');
  assert.strictEqual(r.status, 400);
});

test('GET /reports/repair-sections returns structured sections and tally for valid period', async () => {
  const r = await api('/reports/repair-sections?year=2026&month=6');
  assert.strictEqual(r.status, 200);
  assert(Array.isArray(r.body.closed_jobs));
  assert(Array.isArray(r.body.pending_jobs));
  assert(Array.isArray(r.body.other_labour));
  assert(Array.isArray(r.body.spares_supply));
  assert(r.body.tally);
  assert(typeof r.body.tally.total_daily_work_labour === 'number');
  assert(typeof r.body.tally.allocated_sum === 'number');
  assert(typeof r.body.tally.is_balanced === 'boolean');
});

test('POST /reports/repair-sections/sync-labour runs without error', async () => {
  const r = await api('/reports/repair-sections/sync-labour', {
    method: 'POST',
    body: { year: 2026, month: 6 }
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
});
