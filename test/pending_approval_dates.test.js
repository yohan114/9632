'use strict';

// The approval queue has to say WHEN each thing was asked for.
//
// A manager opening "Pending Your Approval" was shown a job number and a vehicle, and nothing else.
// A card raised this morning and one raised three weeks ago looked identical, so the queue gave no
// sense of what was overdue — and the query did not even fetch a date, so no amount of work on the
// screen could have shown one.
//
// The MRN and job-request rows already carried req_date; only the job-card rows did not.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-pending-dates-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();
require('../src/lib/permissions').seedDefaults();

function mkUser(username, roles) {
  const id = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)',
    username, auth.hashPassword('pw')).lastInsertRowid;
  for (const r of roles) {
    run('INSERT OR IGNORE INTO roles (name) VALUES (?)', r);
    run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  }
  return id;
}
mkUser('tm', ['transport_manager']);
mkUser('om', ['operational_manager']);

const ASSET = require('../src/lib/aliases').findOrCreateAsset('AC-06').id;

// Waiting on transport approval, asked for three weeks ago.
const OLD = run(`INSERT INTO job_cards (job_no, type, description, status, asset_id, requested_by, requested_at, is_historical)
   VALUES ('2026/8/R/500', 'repair', 'Compressor overhaul', 'REQUESTED', ?, 'sunil', '2026-08-05', 0)`, ASSET).lastInsertRowid;
// Waiting on operations approval — transport has signed.
const MID = run(`INSERT INTO job_cards (job_no, type, description, status, asset_id, requested_by, requested_at, approved_transport_at, is_historical)
   VALUES ('2026/8/R/501', 'repair', 'Brake job', 'APPROVED_TRANSPORT', ?, 'sunil', '2026-08-20', datetime('now'), 0)`, ASSET).lastInsertRowid;

const app = require('../src/server');
let server; let base;
const cookies = {};
test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const u of ['tm', 'om']) {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u, password: 'pw' }),
    });
    cookies[u] = (r.headers.get('set-cookie') || '').split(';')[0];
  }
});
test.after(() => server && server.close());

const pending = (who) => fetch(`${base}/api/reports/pending-approvals`, { headers: { cookie: cookies[who] } })
  .then((r) => r.json());

test('a card awaiting transport approval says when it was requested', async () => {
  const pa = await pending('tm');
  const row = pa.transport.find((j) => j.id === OLD);
  assert.ok(row, 'the card should be in the transport queue');
  assert.strictEqual(String(row.requested_at).slice(0, 10), '2026-08-05',
    'the query used to select only id, job_no and the vehicle');
});

test('a card awaiting operations approval says so too', async () => {
  const pa = await pending('om');
  const row = pa.ops.find((j) => j.id === MID);
  assert.ok(row, 'the card should be in the operations queue');
  assert.strictEqual(String(row.requested_at).slice(0, 10), '2026-08-20');
});

test('the description comes along, so the queue can be read without opening each card', async () => {
  const pa = await pending('tm');
  const row = pa.transport.find((j) => j.id === OLD);
  assert.strictEqual(row.description, 'Compressor overhaul');
});

test('the screen renders the date and how long it has waited', () => {
  // The date is only useful once it is on screen. Checked against the source because this row is
  // built by a template inside the dashboard, not by a function that can be called on its own.
  const appjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const jobRow = appjs.slice(appjs.indexOf('const jobRow = (j, action)'));
  assert.match(jobRow.slice(0, 400), /waited\(j\.requested_at\)/,
    'the job-card approval row must show the request date');

  const waited = appjs.slice(appjs.indexOf('const waited = (d)'), appjs.indexOf('const jobRow ='));
  assert.match(waited, /days >= 3/, 'a card requested today should not be labelled "0 days"');
  assert.match(waited, /days >= 14/, 'and one waiting a fortnight should stand out from one waiting four days');
});

test('the MRN and job-request rows already had their date and still do', async () => {
  // Not changed by this work, but they share the panel — if one of them lost req_date the panel
  // would go half-dated and look like a bug in the new column.
  const mrn = run(`INSERT INTO mrn (mrn_no, req_date, asset_id, status, approval_status, requested_by)
     VALUES ('M-8001', '2026-08-10', ?, 'open', 'certified', 'sunil')`, ASSET).lastInsertRowid;
  run('INSERT INTO mrn_lines (mrn_id, description, qty, unit, qty_received) VALUES (?, ?, 1, ?, 0)', mrn, 'Belt', 'nos');
  const pa = await pending('om');
  const row = (pa.approve || []).find((m) => m.id === mrn);
  assert.ok(row, 'the certified MRN should be waiting on operations');
  assert.strictEqual(String(row.req_date).slice(0, 10), '2026-08-10');
});
