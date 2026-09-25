'use strict';

// Job cards plan, Part 1 — the Job Cards Monitor and one list of everything waiting for a decision
// (src/lib/jobs_flow.js, src/routes/jobflow.js).
//
//   A job starts as a job request (certified, then approved: that makes the card) or as a card raised
//   directly (transport approval, then operations). The Requests list shows both, with the reopen
//   requests and the requested cards that never moved. Each row says what it waits for, since when,
//   and which buttons the person may press — the same rules the routes behind the buttons enforce.
//   Imported history is no to-do (JC-D10); each person sees their own workshop (JC-D2).

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-jp1-'));
process.env.DB_PATH = path.join(TMP, 'jp1.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');
const workshops = require('../src/lib/workshops');
const scope = require('../src/lib/scope');
const flow = require('../src/lib/jobs_flow');

migrate();
for (const n of ['admin', 'workshop', 'manager', 'storekeeper', 'operational_manager', 'transport_manager', 'assistant_transport_manager']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
require('../src/lib/capabilities').seedCapabilities();
require('../src/lib/permissions').seedDefaults();
const perms = require('../src/lib/permissions');
// A role that sees job requests but not job cards, and one that sees neither.
run("INSERT INTO roles (name, label) VALUES ('jronly', 'Requests only'), ('nobody', 'Nothing')");
perms.setPermission('jronly', 'jobrequests', 'view');
perms.setPermission('jronly', 'jobs', 'none');
perms.setPermission('nobody', 'jobrequests', 'none');
perms.setPermission('nobody', 'jobs', 'none');

const CW = workshops.defaultId();
const MTR = run("INSERT INTO workshops (code, name) VALUES ('MTR', 'Muthur Workshop')").lastInsertRowid;
const PW = 'copper-lantern-gravel';
function mkUser(username, roles, ws = CW, fullName = null) {
  const id = run('INSERT INTO users (username, password_hash, active, workshop_id, full_name) VALUES (?, ?, 1, ?, ?)',
    username, auth.hashPassword(PW), ws, fullName).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const U = {
  boss: mkUser('boss', ['admin']), tm: mkUser('tm', ['transport_manager'], CW, 'Tharindu TM'), om: mkUser('om', ['operational_manager']),
  om2: mkUser('om2', ['operational_manager']), asst: mkUser('asst', ['assistant_transport_manager']), ws: mkUser('ws', ['workshop'], CW, 'Kamal Fitter'),
  wsM: mkUser('wsM', ['workshop'], MTR), jr: mkUser('jr', ['jronly']), none: mkUser('none', ['nobody']),
};
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const TODAY = day(0);

let seq = 0;
const asset = (code) => run('INSERT INTO assets (code, code_norm, status, in_register) VALUES (?, ?, ?, 1)', code, code.replace(/\W/g, ''), 'active').lastInsertRowid;
const V = { a: asset('EX-101'), b: asset('EX-102'), c: asset('EX-103'), d: asset('EX-104'), e: asset('EX-105'), f: asset('EX-106'), g: asset('EX-107'), h: asset('EX-108') };
function jobRequest(assetId, desc, { status = 'requested', date = TODAY, ws = CW, type = 'repair', priority = 'normal' } = {}) {
  return run(`INSERT INTO job_requests (jr_no, req_date, asset_id, type, priority, description, approval_status, requested_by, requested_by_user, workshop_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'Nimal ATM', ?, ?)`, `JR-${String(++seq).padStart(4, '0')}`, date, assetId, type, priority, desc, status, U.asst, ws).lastInsertRowid;
}
function card(assetId, desc, { status = 'REQUESTED', date = TODAY, ws = CW, historical = 0, type = 'repair', legacy = null } = {}) {
  return run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at, requested_by, workshop_id, is_historical, legacy_ref)
              VALUES (?, ?, ?, ?, ?, ?, 'Kamal Fitter', ?, ?, ?)`, `2026/9/R/${++seq}`, assetId, type, desc, status, date, ws, historical, legacy).lastInsertRowid;
}

// ---- the world ------------------------------------------------------------------------------------
const JR1 = jobRequest(V.a, 'Brakes weak', { date: day(-3), priority: 'urgent' });            // to certify
const JR2 = jobRequest(V.h, 'Boom cylinder leak', { status: 'certified', date: day(-5) });    // to approve — certified by tm
run("UPDATE job_requests SET certified_by = 'Tharindu TM', certified_at = ? WHERE id = ?", day(-4) + ' 09:00:00', JR2);
run(`INSERT INTO job_request_approvals (job_request_id, stage, role, approver_id, signed_name, decision) VALUES (?, 'certify', 'transport_manager', ?, 'Tharindu TM', 'approved')`, JR2, U.tm);
const JR3 = jobRequest(V.c, 'Starter noisy', { status: 'rejected', date: day(-9) });           // rejected
run(`INSERT INTO job_request_approvals (job_request_id, stage, role, approver_id, signed_name, decision, reason, created_at) VALUES (?, 'certify', 'transport_manager', ?, 'Tharindu TM', 'rejected', 'On the service plan already', ?)`, JR3, U.tm, day(-8) + ' 10:00:00');
const JRM = jobRequest(V.g, 'Muthur request', { ws: MTR, date: day(-1), type: 'service' });  // another workshop's
const C1 = card(V.d, 'AC not cooling', { date: day(-2) });                                    // transport
const C2 = card(V.e, 'Gearbox noise', { status: 'APPROVED_TRANSPORT', date: day(-6) });        // operations — transport by tm
run("UPDATE job_cards SET approved_transport_at = ? WHERE id = ?", day(-4) + ' 08:00:00', C2);
run(`INSERT INTO job_approvals (job_id, role, approver_id, decision) VALUES (?, 'transport_manager', ?, 'approved')`, C2, U.tm);
const CSTUCK = card(V.f, 'Old requested card', { date: day(-200) });                          // stuck: nothing for 200 days
const CIMP = card(V.g, 'Imported requested', { date: day(-10), historical: 1 });              // imported, not stuck: no to-do
const CIMPOLD = card(V.a, 'Imported old', { date: day(-400), historical: 1 });                 // imported and stuck: review
const CBOX = card(null, 'Stores materials holder', { date: day(-1) });                         // a container: never a request
const CREJ = card(V.b, 'Rejected card', { status: 'REJECTED', date: day(-12) });
run(`INSERT INTO job_approvals (job_id, role, approver_id, decision, reason, created_at) VALUES (?, 'transport_manager', ?, 'rejected', 'Not our machine', ?)`, CREJ, U.tm, day(-11) + ' 11:00:00');
const CPART = card(V.c, 'Partly closed card', { status: 'PARTIALLY_CLOSED', date: day(-20) });
const REOPEN = run(`INSERT INTO job_reopen_requests (job_id, requested_by, requested_at, reason, status) VALUES (?, ?, ?, 'Leak came back', 'pending')`, CPART, U.ws, day(-1) + ' 07:00:00').lastInsertRowid;
const CM = card(V.g, 'Muthur card', { ws: MTR, date: day(-1) });                              // another workshop's transport
// Work in the workshop: waiting to start, in progress (worked today), work done.
card(V.a, 'Approved, not started', { status: 'APPROVED_OPERATIONS', date: day(-2) });
card(V.b, 'In the bay', { status: 'IN_WORKSHOP', date: day(-2) });
const CIP = card(V.d, 'Engine overhaul', { status: 'IN_PROGRESS', date: day(-3) });
run("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours) VALUES (?, ?, 'Anura', 4)", CIP, TODAY);
const CDONE = card(V.e, 'Work done card', { status: 'WORK_COMPLETE', date: day(-4) });
run("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours) VALUES (?, ?, 'Sunil', 3)", CDONE, day(-3));
card(V.c, 'Imported in progress', { status: 'IN_PROGRESS', date: day(-30), historical: 1 });
card(null, 'General workshop holder', { status: 'IN_PROGRESS', date: day(-30), legacy: 'general-workshop' });

// ---- the server -----------------------------------------------------------------------------------
const app = require('../src/server');
let server; let port;
test.before(async () => { await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); }); port = server.address().port; });
test.after(() => { server && server.close(); });
function req(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = {};
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, text: buf, type: res.headers['content-type'] });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const cookies = {};
async function as(user) {
  if (!cookies[user]) {
    cookies[user] = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ username: user, password: PW });
      const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/login',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.headers['set-cookie'][0].split(';')[0]));
      });
      q.on('error', reject); q.write(data); q.end();
    });
  }
  return cookies[user];
}
const call = async (user, method, p, body) => req(method, '/api' + p, { cookie: await as(user), body });
const ok = (r, status = 200) => { assert.strictEqual(r.status, status, r.text); return r.body; };
const list = async (user, qs = '') => ok(await call(user, 'GET', '/job-flow/requests' + qs));
const find = (rows, kind, id) => rows.find((r) => r.kind === kind && r.id === id);
const nos = (rows) => rows.map((r) => r.no);

// ================================================================== the road
test('the road of a job, by where it is', () => {
  const at = (s, o) => flow.roadOf(s, o).map((m) => m.state[0]).join('');
  assert.strictEqual(at(null), 'dnttttt', 'a request: approval is next');
  assert.strictEqual(at('APPROVED_TRANSPORT'), 'dnttttt');
  assert.strictEqual(at('APPROVED_OPERATIONS'), 'ddntttt', 'approved: into the workshop next');
  assert.strictEqual(at('IN_WORKSHOP'), 'dddnttt');
  assert.strictEqual(at('IN_PROGRESS'), 'dddnttt');
  assert.strictEqual(at('WORK_COMPLETE'), 'dddddnt', 'work done: the prices next');
  assert.strictEqual(at('PARTIALLY_CLOSED'), 'dddddnt');
  assert.strictEqual(at('CLOSED'), 'ddddddd');
  assert.strictEqual(at('REJECTED'), 'dsttttt');
  assert.strictEqual(at(null, { rejected: true }), 'dsttttt');
  assert.deepStrictEqual(flow.ROAD.map(([, l]) => l), ['Requested', 'Approved', 'In workshop', 'Working', 'Work done', 'Prices in', 'Closed']);
});

// ================================================================== the list
test('everything waiting for a decision, the longest waiting first; nothing imported, no holder cards', async () => {
  const d = await list('boss');
  const no = (id) => get('SELECT job_no FROM job_cards WHERE id = ?', id).job_no;
  assert.deepStrictEqual(d.rows.map((r) => [r.kind, r.no, r.step]), [
    ['card', no(C2), 'operations'],       // waiting since day -4 (transport approval)
    ['jr', 'JR-0002', 'to_approve'],      // since day -4 (certified)
    ['jr', 'JR-0001', 'to_certify'],      // day -3
    ['card', no(C1), 'transport'],        // day -2
    ['reopen', no(CPART), 'reopen'],      // day -1, then by number
    ['card', no(CM), 'transport'],
    ['jr', 'JR-0004', 'to_certify'],
  ]);
  const steps = d.rows.map((r) => r.step);
  assert.ok(!d.rows.some((r) => [CIMP, CIMPOLD, CBOX, CSTUCK, CREJ].includes(r.id) && r.kind === 'card'), 'no imported, holder, stuck or rejected card');
  assert.deepStrictEqual([...new Set(steps)].sort(), ['operations', 'reopen', 'to_approve', 'to_certify', 'transport']);
  const since = d.rows.map((r) => r.since);
  assert.deepStrictEqual(since, [...since].sort(), 'oldest first');
  assert.deepStrictEqual(d.counts, { open: 7, to_certify: 2, to_approve: 1, transport: 2, operations: 1, reopen: 1, stuck: 2, approved: 0, rejected: 2 });
  const j1 = find(d.rows, 'jr', JR1);
  assert.deepStrictEqual([j1.waiting_for, j1.days, j1.priority, j1.link, j1.asset_code], ['Transport Manager to certify', 3, 'urgent', '#/jobrequests/' + JR1, 'EX-101']);
  assert.deepStrictEqual(j1.road.map((m) => m.state).slice(0, 2), ['done', 'now']);
  const rq = find(d.rows, 'reopen', REOPEN);
  assert.deepStrictEqual([rq.reason, rq.requested_by, rq.job_id, rq.link], ['Leak came back', 'Kamal Fitter', CPART, '#/jobs/' + CPART]);
  assert.strictEqual(rq.road[5].state, 'now', 'a partly closed card waits at the prices');
});

test('each step alone; the stuck ones are the review screen\'s, imported ones too', async () => {
  assert.deepStrictEqual(nos((await list('boss', '?step=to_certify')).rows), ['JR-0001', 'JR-0004']);
  assert.deepStrictEqual(nos((await list('boss', '?step=to_approve')).rows), ['JR-0002']);
  assert.deepStrictEqual((await list('boss', '?step=transport')).rows.map((r) => r.id).sort(), [C1, CM].sort());
  assert.deepStrictEqual((await list('boss', '?step=operations')).rows.map((r) => r.id), [C2]);
  const stuck = (await list('boss', '?step=stuck')).rows;
  assert.deepStrictEqual(stuck.map((r) => [r.id, r.imported]), [[CIMPOLD, true], [CSTUCK, false]], 'oldest first');
  assert.strictEqual(stuck[0].waiting_for, 'Review: raised long ago, nothing done');
  const rej = (await list('boss', '?step=rejected')).rows;
  assert.deepStrictEqual(rej.map((r) => [r.kind, r.reject_reason]), [['jr', 'On the service plan already'], ['card', 'Not our machine']], 'newest decision first');
  assert.deepStrictEqual(rej.map((r) => r.days), [null, null]);
  assert.deepStrictEqual((await list('boss', '?step=nonsense')).rows.length, 7, 'an unknown step is the to-do list');
});

test('search and the kind of work narrow the list', async () => {
  assert.deepStrictEqual(nos((await list('boss', '?q=brakes')).rows), ['JR-0001']);
  assert.deepStrictEqual((await list('boss', '?q=EX-105')).rows.map((r) => r.id), [C2], 'by vehicle');
  assert.deepStrictEqual((await list('boss', '?q=Leak%20came')).rows.map((r) => r.kind), ['reopen'], 'by why it is reopened');
  assert.deepStrictEqual(nos((await list('boss', '?type=service')).rows), ['JR-0004']);
  assert.deepStrictEqual(nos((await list('boss', `?workshop_id=${MTR}`)).rows).length, 2);
});

// ================================================================== who may press what
test('the buttons follow the permissions, and nobody approves their own step twice', async () => {
  const tm = (await list('tm')).rows;
  assert.deepStrictEqual(find(tm, 'jr', JR1).can, { certify: true, approve: false, reject: true });
  assert.deepStrictEqual(find(tm, 'card', C1).can, { transport: true, operations: false, reject: true, review: false });
  assert.strictEqual(find(tm, 'card', C2).can.operations, false, 'the Transport Manager does not give the operations approval');
  const asst = (await list('asst')).rows;
  assert.deepStrictEqual(find(asst, 'jr', JR1).can, { certify: false, approve: false, reject: false }, 'who raises does not decide');
  assert.deepStrictEqual(find(asst, 'jr', JR2).can, { certify: false, approve: false, reject: false });
  assert.deepStrictEqual(find(asst, 'card', C2).can, { transport: false, operations: false, reject: false, review: false });
  assert.strictEqual(find(tm, 'reopen', REOPEN).can.reopen, false, 'the Transport Manager does not reopen'); 
  const om = (await list('om')).rows;
  assert.deepStrictEqual(find(om, 'jr', JR2).can, { certify: false, approve: true, reject: true });
  assert.deepStrictEqual(find(om, 'card', C2).can, { transport: false, operations: true, reject: true, review: false });
  assert.strictEqual(find(om, 'card', C1).can.transport, false);
  assert.strictEqual(find(om, 'reopen', REOPEN).can.reopen, true);
  // The certifier cannot then approve, even when also allowed to: another manager does.
  require('../src/lib/capabilities').setCapability('transport_manager', 'jobrequests.approve', true);
  require('../src/lib/capabilities').setCapability('transport_manager', 'jobs.approve_operations', true);
  // Two more, whose first step someone else signed: those the same person may approve.
  const JRX = jobRequest(V.h, 'Certified by another', { status: 'certified', date: day(-2) });
  run(`INSERT INTO job_request_approvals (job_request_id, stage, role, approver_id, signed_name, decision) VALUES (?, 'certify', 'transport_manager', ?, 'om2', 'approved')`, JRX, U.om2);
  const CX = card(V.h, 'Transport approved by another', { status: 'APPROVED_TRANSPORT', date: day(-2) });
  run(`INSERT INTO job_approvals (job_id, role, approver_id, decision) VALUES (?, 'transport_manager', ?, 'approved')`, CX, U.om2);
  try {
    const tm2 = (await list('tm')).rows;
    assert.deepStrictEqual([find(tm2, 'jr', JRX).can.approve, find(tm2, 'card', CX).can.operations], [true, true], 'the permission is live');
    assert.deepStrictEqual([find(tm2, 'jr', JR2).can.approve, find(tm2, 'jr', JR2).note], [false, 'You certified it — another manager approves.']);
    assert.deepStrictEqual([find(tm2, 'card', C2).can.operations, find(tm2, 'card', C2).note], [false, 'You gave the transport approval — another manager approves.']);
    // …which is exactly what the routes say.
    const r = await call('tm', 'POST', `/job-requests/${JR2}/approve`, {});
    assert.strictEqual(r.status, 403);
  } finally {
    run('DELETE FROM job_request_approvals WHERE job_request_id = ?', JRX); run('DELETE FROM job_requests WHERE id = ?', JRX);
    run('DELETE FROM job_approvals WHERE job_id = ?', CX); run('DELETE FROM job_cards WHERE id = ?', CX);
    require('../src/lib/capabilities').setCapability('transport_manager', 'jobrequests.approve', false);
    require('../src/lib/capabilities').setCapability('transport_manager', 'jobs.approve_operations', false);
  }
  // The admin is not held to it — as the routes do not hold the admin to it.
  run(`INSERT INTO job_request_approvals (job_request_id, stage, role, approver_id, signed_name, decision) VALUES (?, 'certify', 'transport_manager', ?, 'boss', 'approved')`, JR2, U.boss);
  run(`INSERT INTO job_approvals (job_id, role, approver_id, decision) VALUES (?, 'transport_manager', ?, 'approved')`, C2, U.boss);
  try {
    const boss = (await list('boss')).rows;
    assert.deepStrictEqual([find(boss, 'jr', JR2).can.approve, find(boss, 'jr', JR2).note, find(boss, 'card', C2).can.operations], [true, null, true]);
  } finally {
    run("DELETE FROM job_request_approvals WHERE job_request_id = ? AND signed_name = 'boss'", JR2);
    run('DELETE FROM job_approvals WHERE job_id = ? AND approver_id = ?', C2, U.boss);
  }
  // Whoever asked for a reopen does not decide it.
  const ws = (await list('ws')).rows;
  assert.deepStrictEqual([find(ws, 'reopen', REOPEN).can.reopen, find(ws, 'reopen', REOPEN).note], [false, 'You asked for it — another manager decides.']);
  // Stuck cards are for whoever reviews them.
  require('../src/lib/capabilities').setCapability('operational_manager', 'jobs.triage', true);
  assert.strictEqual((await list('om', '?step=stuck')).rows[0].can.review, true);
  assert.strictEqual((await list('tm', '?step=stuck')).rows[0].can.review, false);
});

test('a job request needs Job Requests; a card needs Job Cards; neither, no list', async () => {
  const ws = await list('ws');
  assert.ok(ws.rows.every((r) => r.kind !== 'jr'), 'the workshop sees no job requests (as the page was)');
  assert.deepStrictEqual([ws.counts.to_certify, ws.counts.to_approve], [0, 0]);
  const jr = await list('jr');
  assert.ok(jr.rows.length && jr.rows.every((r) => r.kind === 'jr'), 'requests only, no cards');
  assert.strictEqual((await call('none', 'GET', '/job-flow/requests')).status, 403);
  assert.strictEqual((await call('none', 'GET', '/job-flow/monitor')).status, 403);
  const m = ok(await call('jr', 'GET', '/job-flow/monitor'));
  assert.deepStrictEqual([m.sees, m.workshop, m.finishing, m.watch], [{ jobs: false, jobrequests: true }, null, null, null]);
  assert.deepStrictEqual([m.requests.to_certify, m.requests.transport], [2, 0]);
});

// ================================================================== the Monitor
test('the Monitor counts each step; imported cards and holders are left out', async () => {
  const m = ok(await call('boss', 'GET', '/job-flow/monitor'));
  assert.deepStrictEqual(m.requests, { to_certify: 2, to_approve: 1, transport: 2, operations: 1, reopen: 1, open: 7 });
  assert.deepStrictEqual(m.workshop, { all: 3, not_started: 2, worked_today: 1, idle_1_2: 0, idle_3: 0, waiting_parts: 0, no_reason: 0, idle_mechanics: null },
    'the Ongoing counts (Part 2): two approved, not started; one worked on today');
  assert.deepStrictEqual(m.finishing, { work_done: 1, partly_closed: 1 });
  assert.deepStrictEqual(m.watch, { breakdowns_down: null, reopen: 1, stuck: 2, two_open: 4 });
  assert.strictEqual(m.scope, null, 'head office: every workshop');
});

// ================================================================== store by store
test('with the workshops kept apart, each sees its own', async () => {
  scope.setSwitch({ id: U.boss }, true);
  try {
    assert.ok(!(await list('asst')).rows.some((r) => r.kind === 'jr' && r.id === JRM), "another workshop's job request is out of reach");
    assert.ok((await list('asst')).rows.some((r) => r.kind === 'jr' && r.id === JR1));
    const cw = await list('ws');
    assert.ok(cw.rows.every((r) => r.workshop_id === CW), 'Central only');
    assert.ok(!cw.rows.some((r) => r.id === CM && r.kind === 'card'));
    const mt = await list('wsM');
    assert.deepStrictEqual(mt.rows.map((r) => [r.kind, r.id]), [['card', CM]], 'Muthur only');
    const m = ok(await call('wsM', 'GET', '/job-flow/monitor'));
    assert.deepStrictEqual([m.scope.label, m.requests.transport, m.workshop.all], ['Muthur Workshop', 1, 0]);
    // Head office sees both.
    assert.strictEqual((await list('boss', '?step=transport')).rows.length, 2);
  } finally {
    scope.setSwitch({ id: U.boss }, false);
  }
});

// ================================================================== the rest
test('the Excel of the list, and the job list taking several statuses', async () => {
  const x = await call('boss', 'GET', '/job-flow/requests/export.xlsx?step=open');
  assert.strictEqual(x.status, 200);
  assert.match(x.type, /spreadsheetml/);
  const both = ok(await call('boss', 'GET', '/jobs?status=APPROVED_OPERATIONS,IN_WORKSHOP'));
  assert.deepStrictEqual(both.map((j) => j.status).sort(), ['APPROVED_OPERATIONS', 'IN_WORKSHOP']);
  assert.deepStrictEqual(ok(await call('boss', 'GET', '/jobs?status=WORK_COMPLETE')).map((j) => j.status), ['WORK_COMPLETE']);
});

test('approving from the list goes through the same routes: the row moves on', async () => {
  const r = await call('om', 'POST', `/job-requests/${JR2}/approve`, {});
  assert.strictEqual(r.status, 200, r.text);
  const approved = (await list('om', '?step=approved')).rows;
  assert.deepStrictEqual(approved.map((x) => [x.no, x.job_no, x.step]), [['JR-0002', r.body.job.job_no, 'approved']]);
  assert.strictEqual(approved[0].road[2].state, 'now', 'its card: into the workshop next');
  ok(await call('om', 'POST', `/jobs/${C2}/transition`, { to: 'APPROVED_OPERATIONS' }));
  const open = await list('om');
  assert.ok(!open.rows.some((x) => (x.kind === 'jr' && x.id === JR2) || (x.kind === 'card' && x.id === C2)));
  assert.deepStrictEqual([open.counts.open, open.counts.approved], [5, 1]);
});
