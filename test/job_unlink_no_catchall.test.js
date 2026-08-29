'use strict';

// Removing a line on a database that has never had a GENERAL-WS card.
//
// Its own test file because it needs a database WITHOUT the catch-all, and every other test creates
// one in its fixtures — which is exactly why the bug survived review.
//
// Nothing in schema.sql, the seed or any migration creates that card. It is made lazily, by the
// first general daily-work entry (routes/dailywork.js) or the first general stores issue
// (routes/stores.js). So on a fresh install it does not exist, catchAllJobId() returns 0, and the
// unlink guard `gid && gid !== id` is falsy — so "send this row back to the pool" silently became
// "delete this row", while the button's tooltip said the opposite. A mechanic's hours, or a priced
// issue line, unrecoverable.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-unlink-nocatchall-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();
for (const n of ['admin', 'workshop', 'storekeeper']) run('INSERT INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'eng', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ['admin', 'workshop', 'storekeeper']) {
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
}
run(`INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Seethananda', 400, '2020-01-01')`);

const ASSET = require('../src/lib/aliases').findOrCreateAsset('AC-06').id;
const JOB = run(`INSERT INTO job_cards (job_no, type, description, status, asset_id, requested_by, requested_at)
   VALUES ('2026/8/R/901', 'repair', 'AC-06 compressor', 'IN_PROGRESS', ?, 'eng', '2026-08-03')`, ASSET).lastInsertRowid;

const LINE = run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value)
   VALUES (?, '2026-08-03', 'Seethananda', 'Compressor clean and repair', 4, 0, 0)`, JOB).lastInsertRowid;
const PART = run(`INSERT INTO job_parts (job_id, source_type, source_id, description, qty, unit_price)
   VALUES (?, 'issue', NULL, 'Compressor Belt', 2, 1500)`, JOB).lastInsertRowid;

const app = require('../src/server');
let server; let base; let cookie;
test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'eng', password: 'pw' }),
  });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
});
test.after(() => server && server.close());

const api = async (p, opts = {}) => {
  const r = await fetch(base + '/api' + p, {
    method: opts.method || 'GET', headers: { 'content-type': 'application/json', cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const catchAll = () => get("SELECT id FROM job_cards WHERE legacy_ref = 'general-workshop'");

test('this database really has no catch-all — otherwise the test proves nothing', () => {
  assert.strictEqual(catchAll(), undefined,
    'nothing in the schema, the seed or any migration creates it; if that changes, this file needs rethinking');
});

test('removing daily work creates the catch-all rather than destroying the row', async () => {
  const off = await api(`/jobs/${JOB}/daily-work/${LINE}`, { method: 'DELETE' });
  assert.strictEqual(off.status, 200);
  assert.strictEqual(off.body.unlinked, true,
    'it reported "Entry deleted" here, and the row was gone — while the screen promised it was kept');

  const made = catchAll();
  assert.ok(made, 'the card must be created on demand, as the other two writers already do');

  const row = get('SELECT job_id, hours FROM job_daily_work WHERE id = ?', LINE);
  assert.ok(row, 'four hours of work must survive a fresh-install remove');
  assert.strictEqual(row.job_id, made.id);
  assert.strictEqual(row.hours, 4);

  const pool = await api('/jobs/unassigned/daily-work?limit=200');
  assert.ok(pool.body.some((r) => r.id === LINE), 'and be claimable again');
});

test('the same holds for a part, where the loss is a priced line', async () => {
  // The issues and stock_moves rows still say the item was consumed on that job, so deleting the
  // job_parts row left the stock ledger and the job disagreeing with each other.
  const off = await api(`/jobs/${JOB}/parts/${PART}`, { method: 'DELETE' });
  assert.strictEqual(off.status, 200);
  assert.strictEqual(off.body.unlinked, true);

  const row = get('SELECT job_id, qty, unit_price FROM job_parts WHERE id = ?', PART);
  assert.ok(row, 'the priced line must survive');
  assert.strictEqual(row.job_id, catchAll().id);
  assert.strictEqual(row.unit_price, 1500);
});

test('only ONE catch-all is ever made, however many rows are removed', async () => {
  const extra = run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value)
     VALUES (?, '2026-08-04', 'Seethananda', 'Another line', 1, 0, 0)`, JOB).lastInsertRowid;
  await api(`/jobs/${JOB}/daily-work/${extra}`, { method: 'DELETE' });
  const n = get("SELECT COUNT(*) c FROM job_cards WHERE legacy_ref = 'general-workshop'").c;
  assert.strictEqual(n, 1, 'a second GENERAL-WS card would split the pool in two, with no sign of it');
});
