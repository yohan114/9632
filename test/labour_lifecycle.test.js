'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-labour-'));
process.env.DB_PATH = path.join(TMP, 'labour.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const workshops = require('../src/lib/workshops');

migrate();

for (const n of ['admin', 'workshop', 'operational_manager', 'manager', 'storekeeper']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}

const PW = 'labour-test-password';
function mkUser(username, roles) {
  const id = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', username, auth.hashPassword(PW)).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}

const U = {
  boss: mkUser('boss', ['admin']),
  mgr: mkUser('mgr', ['manager']),
  ws: mkUser('ws', ['workshop']),
};

const CW = workshops.defaultId();
const KW = workshops.create({ id: U.boss }, { code: 'KW', name: 'Kandy Workshop', place: 'Kandy' }).id;

const app = require('../src/server');
let server;
let port;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
});

test.after(() => {
  if (server) server.close();
});

function req(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = {};
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* not json */ }
        const sc = res.headers['set-cookie'];
        resolve({ status: res.statusCode, body: json, text: buf, cookie: sc ? sc[0].split(';')[0] : null });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const cookies = {};
async function as(user) {
  if (!cookies[user]) {
    const r = await req('POST', '/api/auth/login', { body: { username: user, password: PW } });
    assert.strictEqual(r.status, 200, r.text);
    cookies[user] = r.cookie;
  }
  return cookies[user];
}

test('Labour lifecycle: create, rate, resign with date cutoff, and reinstate', async () => {
  const bossCookie = await as('boss');

  // 1. Create a new mechanic
  const createRes = await req('POST', '/api/mechanics', {
    body: { name: 'Sunil Perera' },
    cookie: bossCookie,
  });
  assert.strictEqual(createRes.status, 201);
  const sunilId = createRes.body.id;
  assert.ok(sunilId > 0);

  // Set rate for Sunil
  await req('POST', '/api/mechanics/rates', {
    body: { mechanic: 'Sunil Perera', rate: 450 },
    cookie: bossCookie,
  });

  // Verify Sunil appears in active mechanics
  const activeList = await req('GET', '/api/mechanics', { cookie: bossCookie });
  assert.ok(activeList.body.some((m) => m.name === 'Sunil Perera' && m.rate === 450));

  // 2. Create another mechanic to test resignation: Kamal Silva
  const kamalRes = await req('POST', '/api/mechanics', {
    body: { name: 'Kamal Silva' },
    cookie: bossCookie,
  });
  const kamalId = kamalRes.body.id;

  // Resign Kamal effective 2026-09-10
  const resignRes = await req('POST', `/api/mechanics/${kamalId}/resign`, {
    body: {
      left_date: '2026-09-10',
      left_reason: 'Resigned (Voluntary)',
      notes: 'Moved to overseas employment',
    },
    cookie: bossCookie,
  });
  assert.strictEqual(resignRes.status, 200);
  assert.strictEqual(resignRes.body.active, 0);
  assert.strictEqual(resignRes.body.status, 'resigned');
  assert.strictEqual(resignRes.body.left_date, '2026-09-10');
  assert.strictEqual(resignRes.body.left_reason, 'Resigned (Voluntary)');

  // 3. Test date-aware listing:
  // For a past date BEFORE resignation (2026-09-05), Kamal MUST be visible
  const pastList = await req('GET', '/api/mechanics?active=1&date=2026-09-05', { cookie: bossCookie });
  assert.ok(pastList.body.some((m) => m.name === 'Kamal Silva'), 'Kamal was active on 2026-09-05');

  // For a date AFTER resignation (2026-09-15), Kamal MUST be HIDDEN
  const futureList = await req('GET', '/api/mechanics?active=1&date=2026-09-15', { cookie: bossCookie });
  assert.ok(!futureList.body.some((m) => m.name === 'Kamal Silva'), 'Kamal is hidden on 2026-09-15');

  // When include_inactive=1 is specified, Kamal is included with resigned details
  const allList = await req('GET', '/api/mechanics?include_inactive=1', { cookie: bossCookie });
  const kamalRecord = allList.body.find((m) => m.name === 'Kamal Silva');
  assert.ok(kamalRecord, 'Kamal is in full registry');
  assert.strictEqual(kamalRecord.status, 'resigned');
  assert.strictEqual(kamalRecord.left_date, '2026-09-10');

  // 4. Test attendance roster date cutoff:
  const attPast = await req('GET', '/api/attendance/day?date=2026-09-05', { cookie: bossCookie });
  assert.ok(attPast.body.rows.some((m) => m.name === 'Kamal Silva'), 'Kamal in attendance on 2026-09-05');

  const attFuture = await req('GET', '/api/attendance/day?date=2026-09-15', { cookie: bossCookie });
  assert.ok(!attFuture.body.rows.some((m) => m.name === 'Kamal Silva'), 'Kamal hidden from attendance on 2026-09-15');

  // 5. Test Reinstate:
  const reinstateRes = await req('POST', `/api/mechanics/${kamalId}/reinstate`, { cookie: bossCookie });
  assert.strictEqual(reinstateRes.status, 200);
  assert.strictEqual(reinstateRes.body.active, 1);
  assert.strictEqual(reinstateRes.body.status, 'active');
  assert.strictEqual(reinstateRes.body.left_date, null);

  // Now Kamal is visible on future date as well
  const reinstatedList = await req('GET', '/api/mechanics?active=1&date=2026-09-15', { cookie: bossCookie });
  assert.ok(reinstatedList.body.some((m) => m.name === 'Kamal Silva'), 'Kamal visible after reinstatement');
});

test('Labour site transfer: transfer to another workshop, verify date scoping and history', async () => {
  const bossCookie = await as('boss');

  // Create Nimal Fernando
  const nimalRes = await req('POST', '/api/mechanics', {
    body: { name: 'Nimal Fernando' },
    cookie: bossCookie,
  });
  const nimalId = nimalRes.body.id;

  // Move Nimal to KW from 2026-09-12
  const transferRes = await req('POST', `/api/mechanics/${nimalId}/transfer`, {
    body: {
      workshop_id: KW,
      from_date: '2026-09-12',
      note: 'Transferred to Kandy Workshop for highway site operations',
    },
    cookie: bossCookie,
  });
  assert.strictEqual(transferRes.status, 200);

  // Verify workshop scoping by date:
  assert.strictEqual(workshops.mechanicWorkshop(nimalId, '2026-09-05'), CW, 'Was at Central Workshop before Sept 12');
  assert.strictEqual(workshops.mechanicWorkshop(nimalId, '2026-09-15'), KW, 'Moved to Kandy Workshop from Sept 12');

  // Query mechanic details endpoint:
  const details = await req('GET', `/api/mechanics/${nimalId}`, { cookie: bossCookie });
  assert.strictEqual(details.status, 200);
  assert.strictEqual(details.body.mechanic.workshop_id, KW);
  assert.strictEqual(details.body.mechanic.workshop_name, 'Kandy Workshop');
  assert.ok(details.body.transfers.length >= 1);
  assert.strictEqual(details.body.transfers[0].workshop_id, KW);
  assert.strictEqual(details.body.transfers[0].note, 'Transferred to Kandy Workshop for highway site operations');
});

test('Historical preservation in monthly summary after labourer resigns', async () => {
  const bossCookie = await as('boss');

  // Create labourer Jagath
  const jRes = await req('POST', '/api/mechanics', { body: { name: 'Jagath Bandara' }, cookie: bossCookie });
  const jagathId = jRes.body.id;
  await req('POST', '/api/mechanics/rates', { body: { mechanic: 'Jagath Bandara', rate: 500, effective_from: '2026-09-01' }, cookie: bossCookie });

  // Create job card & log daily work for Jagath on 2026-09-04
  const assetId = run('INSERT INTO assets (code, code_norm, status, in_register) VALUES (?, ?, ?, 1)', 'WP-CAT-99', 'WPCAT99', 'active').lastInsertRowid;
  const jobId = run('INSERT INTO job_cards (job_no, asset_id, status, type, requested_by) VALUES (?, ?, ?, ?, ?)', 'JOB-LAB-01', assetId, 'APPROVED_OPERATIONS', 'repair', 'boss').lastInsertRowid;

  run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, hours, description)
       VALUES (?, '2026-09-04', 'Jagath Bandara', 8.5, 'Hydraulic pump overhaul')`, jobId);
  require('../src/lib/mechanics').syncJobLabourForMonth('2026-09');

  // Now resign Jagath on 2026-09-10
  await req('POST', `/api/mechanics/${jagathId}/resign`, {
    body: { left_date: '2026-09-10', left_reason: 'Contract Ended' },
    cookie: bossCookie,
  });

  // Query monthly summary for 2026-09
  const summaryRes = await req('GET', '/api/daily-work/monthly-summary?month=2026-09', { cookie: bossCookie });
  assert.strictEqual(summaryRes.status, 200);

  const jagathSummary = summaryRes.body.labor_summary.find((l) => l.mechanic === 'Jagath Bandara');
  assert.ok(jagathSummary, 'Jagath still appears in monthly summary for past work');
  assert.strictEqual(jagathSummary.total_hours, 8.5);
  assert.strictEqual(jagathSummary.total_cost, 4250);
  assert.strictEqual(jagathSummary.status, 'resigned');
  assert.strictEqual(jagathSummary.active, 0);
  assert.strictEqual(jagathSummary.left_date, '2026-09-10');
  assert.strictEqual(jagathSummary.left_reason, 'Contract Ended');
});
