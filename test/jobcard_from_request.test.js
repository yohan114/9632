'use strict';

// A job card is opened BY THE WORKSHOP, and only against a job request that has been through all
// three signatures (raise → certify → approve). The request is the authority to spend; a card
// without one has nothing behind it.
//
// This file is the gate itself: what it refuses, what it copies from the request rather than
// trusting the body, and the four doors that are deliberately left open (a breakdown at a site, the
// continuation card at a partial close, and the two container cards). The one-open-card rule at
// this gate is test/one_open_job.js; reaching another workshop's request is test/stage3_scoping.js.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-jcfr-'));
process.env.DB_PATH = path.join(TMP, 'jcfr.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const caps = require('../src/lib/capabilities');
const workshops = require('../src/lib/workshops');

migrate();
for (const n of ['admin', 'workshop', 'operational_manager', 'transport_manager', 'assistant_transport_manager', 'manager']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
caps.seedCapabilities();
require('../src/lib/permissions').seedDefaults();

const CW = workshops.defaultId();
const PW = 'amber-ledger-paddock';
function mkUser(username, roles) {
  const id = run('INSERT INTO users (username, password_hash, active, workshop_id, full_name) VALUES (?, ?, 1, ?, ?)',
    username, auth.hashPassword(PW), CW, username.toUpperCase()).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const U = {
  boss: mkUser('boss', ['admin']),
  ws: mkUser('ws', ['workshop']),
  tm: mkUser('tm', ['transport_manager']),
  om: mkUser('om', ['operational_manager']),
  asst: mkUser('asst', ['assistant_transport_manager']),
};

const asset = (code) => run('INSERT INTO assets (code, code_norm, status, in_register) VALUES (?, ?, ?, 1)', code, code.replace(/\W/g, ''), 'active').lastInsertRowid;
const proj = run("INSERT INTO projects (name) VALUES ('Marawila')").lastInsertRowid;

const app = require('../src/server');
let server; let port;
test.before(async () => { await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); }); port = server.address().port; });
test.after(() => { server && server.close(); });

function raw(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = {};
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, text: buf });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
// The login cookie needs the raw Set-Cookie header, which `raw` throws away.
const cookies = {};
async function login(user) {
  if (cookies[user]) return cookies[user];
  cookies[user] = await new Promise((resolve, reject) => {
    const data = JSON.stringify({ username: user, password: PW });
    const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/login',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.headers['set-cookie'][0].split(';')[0]));
    });
    q.on('error', reject); q.write(data); q.end();
  });
  return cookies[user];
}
const call = async (user, method, p, body) => raw(method, '/api' + p, { cookie: await login(user), body });

/** A job request at whatever stage is wanted, raised properly through the routes. */
async function request(stage, fields = {}) {
  const made = await call('asst', 'POST', '/job-requests', { description: 'brake pads worn', ...fields });
  assert.strictEqual(made.status, 201, made.text);
  const id = made.body.request.id;
  if (stage === 'requested') return id;
  if (stage === 'rejected') {
    assert.strictEqual((await call('tm', 'POST', `/job-requests/${id}/reject`, { reason: 'on the service plan' })).status, 200);
    return id;
  }
  assert.strictEqual((await call('tm', 'POST', `/job-requests/${id}/certify`, {})).status, 200);
  if (stage === 'certified') return id;
  assert.strictEqual((await call('om', 'POST', `/job-requests/${id}/approve`, {})).status, 200);
  return id;
}

// ================================================================== what the gate refuses
test('no job request, no job card', async () => {
  const r = await call('ws', 'POST', '/jobs', { asset_id: asset('GATE-1'), description: 'brakes', type: 'repair' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.needs_job_request, true);
  assert.match(r.body.error, /opened from an approved job request/i);
  assert.strictEqual(get("SELECT COUNT(*) c FROM job_cards WHERE description = 'brakes'").c, 0, 'nothing was created');
});

test('a request short of its third signature cannot be opened, and says which one it waits for', async () => {
  const waiting = await request('requested', { asset_id: asset('GATE-2') });
  const r1 = await call('ws', 'POST', '/jobs', { job_request_id: waiting });
  assert.strictEqual(r1.status, 409);
  assert.strictEqual(r1.body.approval_status, 'requested');
  assert.match(r1.body.error, /waiting for the Transport Manager to certify/i);

  const certified = await request('certified', { asset_id: asset('GATE-3') });
  const r2 = await call('ws', 'POST', '/jobs', { job_request_id: certified });
  assert.strictEqual(r2.status, 409);
  assert.strictEqual(r2.body.approval_status, 'certified');
  assert.match(r2.body.error, /waiting for the Operational Manager to approve/i);

  const rejected = await request('rejected', { asset_id: asset('GATE-4') });
  const r3 = await call('ws', 'POST', '/jobs', { job_request_id: rejected });
  assert.strictEqual(r3.status, 409);
  assert.match(r3.body.error, /was rejected/i);

  assert.strictEqual(get('SELECT COUNT(*) c FROM job_cards').c, 0, 'not one of them made a card');
});

test('a request that is already a card answers with that card, and does not make a second', async () => {
  const id = await request('approved', { asset_id: asset('GATE-5') });
  const first = await call('ws', 'POST', '/jobs', { job_request_id: id });
  assert.strictEqual(first.status, 201, first.text);
  const again = await call('ws', 'POST', '/jobs', { job_request_id: id });
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.body.job.job_no, first.body.job.job_no);
  assert.match(again.body.error, /already has job card/i);
  assert.strictEqual(get('SELECT COUNT(*) c FROM job_cards WHERE job_request_id = ?', id).c, 1);
});

test('a request that does not exist is a 404, not a card', async () => {
  const r = await call('ws', 'POST', '/jobs', { job_request_id: 999999 });
  assert.strictEqual(r.status, 404);
});

// ================================================================== who may open one
test('opening a job card is the workshop\'s; the Transport Manager no longer raises them', async () => {
  assert.ok(!caps.capsForRole('transport_manager').includes('jobs.create'), 'taken off the Transport Manager');
  assert.ok(caps.capsForRole('workshop').includes('jobs.create'), 'and it is the workshop\'s');

  const id = await request('approved', { asset_id: asset('WHO-1') });
  assert.strictEqual((await call('tm', 'POST', '/jobs', { job_request_id: id })).status, 403);
  assert.strictEqual((await call('om', 'POST', '/jobs', { job_request_id: id })).status, 403);
  assert.strictEqual((await call('asst', 'POST', '/jobs', { job_request_id: id })).status, 403);
  assert.strictEqual((await call('ws', 'POST', '/jobs', { job_request_id: id })).status, 201);
});

// Taking transport_manager out of the capability TEMPLATE moves nothing on a database that has
// already been seeded: the row is there, granted, and seedCapabilities() only ever INSERTs OR
// IGNOREs. db/index.js revokes it by hand instead — once, and never against an admin's later word.
test('an already-seeded database has the capability taken off it, once', () => {
  const held = () => {
    const row = get("SELECT granted g FROM role_capabilities WHERE role = 'transport_manager' AND capability = 'jobs.create'");
    return row ? row.g : null;
  };
  // Put the database back into the shape it was in before this change, guard and all.
  run("INSERT INTO role_capabilities (role, capability, granted) VALUES ('transport_manager', 'jobs.create', 1) "
    + 'ON CONFLICT(role, capability) DO UPDATE SET granted = 1');
  run("UPDATE role_permissions SET level = 'none' WHERE role = 'workshop' AND module = 'jobrequests'");
  run("DELETE FROM settings WHERE key = 'jobs_create_to_workshop'");
  assert.strictEqual(held(), 1);

  migrate();

  assert.strictEqual(held(), 0, 'revoked, not deleted — so the boot-time seed cannot quietly hand it back');
  assert.ok(!caps.capsForRole('transport_manager').includes('jobs.create'));
  assert.strictEqual(get("SELECT level l FROM role_permissions WHERE role = 'workshop' AND module = 'jobrequests'").l, 'view',
    'and the workshop can now read the requests it opens cards from');
  assert.ok(get("SELECT 1 x FROM settings WHERE key = 'jobs_create_to_workshop'"), 'the move is marked done');

  // An admin who decides otherwise is not overruled on the next start.
  caps.setCapability('transport_manager', 'jobs.create', true);
  try {
    caps.seedCapabilities();
    migrate();
    assert.strictEqual(held(), 1, 'an admin\'s decision stands');
  } finally {
    caps.setCapability('transport_manager', 'jobs.create', false);
  }
});

test('the workshop can read job requests — it cannot open a card without one', () => {
  const reaches = require('../src/lib/permissions').reaches;
  assert.ok(reaches({ id: U.ws, roles: ['workshop'] }, 'jobrequests'), 'it sees them');
  const wsCaps = caps.capsForRole('workshop');
  assert.deepStrictEqual(
    ['jobrequests.create', 'jobrequests.certify', 'jobrequests.approve', 'jobrequests.reject'].filter((c) => wsCaps.includes(c)),
    [], 'and signs none of them');
});

// ================================================================== what the card carries
test('the card is copied from the request, not from the body', async () => {
  const v = asset('COPY-1');
  const id = await request('approved', {
    asset_id: v, type: 'service', severity: 'major', project_id: proj, description: 'full service at 10,000 km',
  });
  const jr = get('SELECT * FROM job_requests WHERE id = ?', id);
  // Everything below is a lie the workshop might type; the request wins every time.
  const r = await call('ws', 'POST', '/jobs', {
    job_request_id: id,
    asset_id: asset('COPY-DECOY'), type: 'repair', severity: 'minor',
    project_id: null, description: 'something else entirely', requested_by: 'nobody',
  });
  assert.strictEqual(r.status, 201, r.text);
  const job = r.body.job;
  assert.strictEqual(job.asset_id, v, 'the vehicle is the request\'s');
  assert.strictEqual(job.type, 'service');
  assert.strictEqual(job.severity, 'major');
  assert.strictEqual(job.project_id, proj);
  assert.strictEqual(job.description, 'full service at 10,000 km');
  assert.strictEqual(job.requested_by, jr.requested_by, 'the person who asked for the work, not the one who opened the card');
  assert.match(job.job_no, /\/S\//, 'a service request numbers a service card');
});

test('the card starts past both gates, with the dates that were signed and the trail to match', async () => {
  const id = await request('approved', { asset_id: asset('GATES-1') });
  const jr = get('SELECT * FROM job_requests WHERE id = ?', id);
  const r = await call('ws', 'POST', '/jobs', { job_request_id: id });
  assert.strictEqual(r.status, 201, r.text);
  const job = r.body.job;
  assert.strictEqual(job.status, 'APPROVED_OPERATIONS', 'the request WAS the approval');
  assert.strictEqual(job.approved_transport_at, jr.certified_at, 'the date the Transport Manager signed');
  assert.strictEqual(job.approved_ops_at, jr.approved_at, 'the date the Operational Manager signed');
  assert.strictEqual(job.requested_at.slice(0, 10), jr.req_date.slice(0, 10));

  // Both approvals mirrored onto the card, pointing at the people who actually gave them.
  const trail = all('SELECT role, approver_id, reason FROM job_approvals WHERE job_id = ? ORDER BY id', job.id);
  assert.deepStrictEqual(trail.map((t) => t.role), ['transport_manager', 'operational_manager']);
  assert.deepStrictEqual(trail.map((t) => t.approver_id), [U.tm, U.om]);
  assert.match(trail[0].reason, new RegExp(`Certified via Job Request ${jr.jr_no}`));
  assert.match(trail[1].reason, new RegExp(`Approved via Job Request ${jr.jr_no}`));

  // Both pointers, and they agree.
  assert.strictEqual(job.job_request_id, id);
  assert.strictEqual(get('SELECT job_id FROM job_requests WHERE id = ?', id).job_id, job.id);
});

test('the workshop\'s note goes under the requested work, never over it', async () => {
  const id = await request('approved', { asset_id: asset('NOTE-1'), description: 'knocking from the front axle' });
  const r = await call('ws', 'POST', '/jobs', { job_request_id: id, note: 'bay 3, needs the press', ref: 'WS-77', site: 'Badalgama' });
  assert.strictEqual(r.status, 201, r.text);
  assert.match(r.body.job.description, /^knocking from the front axle/);
  assert.match(r.body.job.description, /Workshop note: bay 3, needs the press/);
  assert.deepStrictEqual([r.body.job.ref, r.body.job.site], ['WS-77', 'Badalgama'], 'the workshop\'s own fields are its own');
});

test('"take it in now" does the workshop\'s next step too, if it may', async () => {
  const id = await request('approved', { asset_id: asset('TAKE-1') });
  const r = await call('ws', 'POST', '/jobs', { job_request_id: id, take_in: true });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.body.job.status, 'IN_WORKSHOP');

  // Without the permission to take a card in, the card still opens — at the status it had.
  caps.setCapability('workshop', 'jobs.assign_workshop', false);
  try {
    const id2 = await request('approved', { asset_id: asset('TAKE-2') });
    const r2 = await call('ws', 'POST', '/jobs', { job_request_id: id2, take_in: true });
    assert.strictEqual(r2.status, 201, r2.text);
    assert.strictEqual(r2.body.job.status, 'APPROVED_OPERATIONS', 'asking is not the same as being allowed');
  } finally {
    caps.setCapability('workshop', 'jobs.assign_workshop', true);
  }
});

test('a request whose vehicle is still in the Alias Queue cannot be opened', async () => {
  const made = await call('asst', 'POST', '/job-requests', { asset: 'something nobody recognises', description: 'x' });
  assert.strictEqual(made.status, 201, made.text);
  const id = made.body.request.id;
  assert.ok(made.body.unresolved, 'queued for linking');
  assert.strictEqual(get('SELECT asset_id FROM job_requests WHERE id = ?', id).asset_id, null);
  await call('tm', 'POST', `/job-requests/${id}/certify`, {});
  await call('om', 'POST', `/job-requests/${id}/approve`, {});
  const r = await call('ws', 'POST', '/jobs', { job_request_id: id });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.unlinked_asset, true);
  assert.match(r.body.error, /Alias Queue/);
});

// ================================================================== the doors left open
test('a breakdown at a site opens a card with no request behind it', async () => {
  const v = asset('BD-1');
  const r = await call('boss', 'POST', '/field/breakdown', {
    asset_id: v, description: 'engine seized on the haul road', place: `p:${proj}`, stopped_at: '2026-03-02 08:30',
  });
  assert.strictEqual(r.status, 201, r.text);
  const job = get('SELECT * FROM job_cards WHERE asset_id = ?', v);
  assert.deepStrictEqual([job.breakdown, job.field, job.job_request_id], [1, 1, null],
    'flagged as a breakdown, which is what says why it has no request');
  assert.strictEqual(job.status, 'REQUESTED');
});

test('the continuation card at a partial close inherits the request, rather than needing one', async () => {
  const closeLib = require('../src/lib/job_close');
  const v = asset('CONT-1');
  const id = await request('approved', { asset_id: v });
  const opened = await call('ws', 'POST', '/jobs', { job_request_id: id });
  assert.strictEqual(opened.status, 201, opened.text);
  const card = opened.body.job.id;
  run("UPDATE job_cards SET status = 'IN_PROGRESS' WHERE id = ?", card);
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, date('now'), 'Anura', 'strip down', 3)", card);
  run("INSERT INTO job_parts (job_id, source_type, description, qty, unit_price) VALUES (?, 'external', 'Bearing', 1, NULL)", card);
  closeLib.setEnabled(true);
  try {
    const pc = await call('ws', 'POST', `/jobs/${card}/partial-close`, { note: 'price to come', open_new: true });
    assert.strictEqual(pc.status, 200, pc.text);
    const next = get('SELECT * FROM job_cards WHERE id = ?', pc.body.new_job.id);
    assert.strictEqual(next.job_request_id, id, 'the chain from the signed paper is unbroken');
    assert.strictEqual(next.continues_job_id, card);
  } finally { closeLib.setEnabled(false); }
});

test('the container cards are not repairs, and need no request', () => {
  const id = workshops.generalCardId(CW, { create: true });
  const card = get('SELECT * FROM job_cards WHERE id = ?', id);
  assert.deepStrictEqual([card.synthesized_no, card.job_request_id], [1, null]);
  assert.strictEqual(card.job_no, 'GENERAL-WS');
});

// ================================================================== the old link, read the new way
test('a card the approval made before this change keeps its link, read from the new pointer', () => {
  // The shape an older database is in: job_requests.job_id set, job_cards.job_request_id empty.
  const v = asset('OLD-1');
  const jr = run(`INSERT INTO job_requests (jr_no, req_date, asset_id, type, description, approval_status, workshop_id)
                  VALUES ('JR-OLD1', date('now'), ?, 'repair', 'made by the approval', 'approved', ?)`, v, CW).lastInsertRowid;
  const card = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, workshop_id)
                    VALUES ('2024/4/R/77', ?, 'repair', 'made by the approval', 'CLOSED', ?)`, v, CW).lastInsertRowid;
  run('UPDATE job_requests SET job_id = ? WHERE id = ?', card, jr);
  assert.strictEqual(get('SELECT job_request_id FROM job_cards WHERE id = ?', card).job_request_id, null);

  migrate();   // the backfill is a plain UPDATE of the rows that have no forward pointer yet

  assert.strictEqual(get('SELECT job_request_id FROM job_cards WHERE id = ?', card).job_request_id, jr,
    'the link history already had, now readable from the card');
});
