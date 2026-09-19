'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), 'workshopone-phase2-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');
const costing = require('../src/lib/costing');

migrate();
for (const n of ['admin', 'workshop', 'transport_manager', 'operational_manager']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'mgr_p2', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ['admin', 'workshop', 'transport_manager', 'operational_manager']) {
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
    body: JSON.stringify({ username: 'mgr_p2', password: 'pw' }),
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

test('POST /jobs/bulk-transition batch-approves REQUESTED cards to APPROVED_TRANSPORT', async () => {
  const j1 = run("INSERT INTO job_cards (job_no, status, description, type) VALUES ('TEST/P2/01', 'REQUESTED', 'Card 1', 'repair')").lastInsertRowid;
  const j2 = run("INSERT INTO job_cards (job_no, status, description, type) VALUES ('TEST/P2/02', 'REQUESTED', 'Card 2', 'repair')").lastInsertRowid;

  const r = await api('/jobs/bulk-transition', {
    method: 'POST',
    body: {
      ids: [j1, j2],
      to: 'APPROVED_TRANSPORT',
      reason: 'Batch approval test'
    }
  });

  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.success_count, 2);
  assert.strictEqual(r.body.fail_count, 0);

  const updated1 = get('SELECT status FROM job_cards WHERE id = ?', j1);
  const updated2 = get('SELECT status FROM job_cards WHERE id = ?', j2);
  assert.strictEqual(updated1.status, 'APPROVED_TRANSPORT');
  assert.strictEqual(updated2.status, 'APPROVED_TRANSPORT');
});

test('Closure gate detects unissued store shelf parts', async () => {
  const aId = run("INSERT INTO assets (code, code_norm, registration, status) VALUES ('SH-01', 'SH01', 'WP-SH-01', 'active')").lastInsertRowid;
  const jId = run("INSERT INTO job_cards (job_no, asset_id, status, description, type) VALUES ('TEST/P2/SH', ?, 'WORK_COMPLETE', 'Shelf test', 'repair')", aId).lastInsertRowid;

  // No parts yet -> ready is true (assuming no other required items)
  let readiness = costing.closureReadiness(jId);
  assert.strictEqual(readiness.ready, true);

  // Add MRN and GRN (delivered to shelf)
  const mrnId = run("INSERT INTO mrn (mrn_no, req_date, asset_id, job_id, status, requested_by) VALUES ('MRN-SH-01', '2026-09-12', ?, ?, 'open', 'tester')", aId, jId).lastInsertRowid;
  const mlId = run("INSERT INTO mrn_lines (mrn_id, description, qty, qty_received) VALUES (?, 'Turbo Hose', 2, 2)", mrnId).lastInsertRowid;
  const grnId = run("INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, unit_price, delivery_date) VALUES ('GRN-SH-01', ?, ?, 'Turbo Hose', 2, 5000, '2026-09-12')", mrnId, mlId).lastInsertRowid;

  // Now closureReadiness should detect unissued shelf item
  readiness = costing.closureReadiness(jId);
  assert.strictEqual(readiness.ready, false);
  assert(readiness.missing.some((m) => m.includes('Turbo Hose') && m.includes('unissued')));

  // Once issued via stock issue
  run("INSERT INTO issues (job_id, grn_id, description, qty, unit_price, issue_date) VALUES (?, ?, 'Turbo Hose', 2, 5000, '2026-09-12')", jId, grnId);
  run("INSERT INTO job_parts (job_id, source_type, source_id, mrn_line_id, description, qty, unit_price) VALUES (?, 'grn', ?, ?, 'Turbo Hose', 2, 5000)", jId, grnId, mlId);

  readiness = costing.closureReadiness(jId);
  assert.strictEqual(readiness.ready, true);
});

test('POST /daily-work/bulk-log logs multiple mechanic hours and recalculates labour', async () => {
  run("INSERT OR IGNORE INTO labour_rates (mechanic, rate, effective_from) VALUES ('Saman Kumara', 450, '2026-01-01')");
  const jId = run("INSERT INTO job_cards (job_no, status, description, type) VALUES ('TEST/P2/DW', 'IN_PROGRESS', 'Daily work test', 'repair')").lastInsertRowid;

  const r = await api('/daily-work/bulk-log', {
    method: 'POST',
    body: {
      date: '2026-09-12',
      entries: [
        {
          mechanic: 'Saman Kumara',
          job_id: jId,
          hours: 6,
          description: 'Front brake repair'
        },
        {
          mechanic: 'Saman Kumara',
          job_id: jId,
          hours: 2,
          description: 'Wheel alignment check'
        }
      ]
    }
  });

  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.entries_logged, 2);

  const job = get('SELECT labour_cost FROM job_cards WHERE id = ?', jId);
  // 8 hours * 450 = 3600
  assert.strictEqual(Number(job.labour_cost), 3600);
});
