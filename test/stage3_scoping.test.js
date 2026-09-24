'use strict';

// Multi-site Stage 3 — each workshop sees its own work (src/lib/scope.js).
//
//   With "Separate workshops" on and a second workshop in use, people outside head office see and
//   work on only their own workshop's job cards, job requests, requests (MRN), daily work and
//   approval queues. Head office sees everything; store staff every workshop their store serves
//   (all of them, while there is one store).
//   Vehicles are shared (another workshop's card shows number, status and workshop only), and one
//   open card per vehicle holds across every workshop. Off, or with one workshop: nothing changes.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-s3-'));
process.env.DB_PATH = path.join(TMP, 's3.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const workshops = require('../src/lib/workshops');
const scope = require('../src/lib/scope');

migrate();
for (const n of ['admin', 'workshop', 'operational_manager', 'manager', 'storekeeper', 'transport_manager', 'assistant_transport_manager']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
const CW = workshops.defaultId();
const MTR = run("INSERT INTO workshops (code, name, place) VALUES ('MTR', 'Muthur Workshop', 'Muthur')").lastInsertRowid;
const PW = 'ember-harbour-quarry';
function mkUser(username, roles, ws = CW) {
  const id = run('INSERT INTO users (username, password_hash, active, workshop_id) VALUES (?, ?, 1, ?)', username, auth.hashPassword(PW), ws).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const U = {
  boss: mkUser('boss', ['admin']), om: mkUser('om', ['operational_manager']), mgr: mkUser('mgr', ['manager']),
  sk: mkUser('sk', ['storekeeper']),                       // the one store, at Central
  wsC: mkUser('wsC', ['workshop']), wsM: mkUser('wsM', ['workshop'], MTR),
  tmC: mkUser('tmC', ['transport_manager']), tmM: mkUser('tmM', ['transport_manager'], MTR),
  atM: mkUser('atM', ['assistant_transport_manager'], MTR),
};
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const TODAY = day(0);
let seq = 0;
const asset = (code) => run('INSERT INTO assets (code, code_norm, status, in_register) VALUES (?, ?, ?, 1)', code, code.replace(/\W/g, ''), 'active').lastInsertRowid;
const job = (assetId, ws, status = 'IN_PROGRESS', extra = {}) => run(
  `INSERT INTO job_cards (job_no, asset_id, type, description, status, is_historical, requested_at, workshop_id, approved_transport_at)
   VALUES (?, ?, 'repair', ?, ?, 0, ?, ?, ?)`, `2026/9/R/${700 + (++seq)}`, assetId, extra.description || 'secret fault', status, day(-5), ws,
  extra.transportApproved ? day(-4) : null).lastInsertRowid;
const mrn = (ws, status = 'requested', jobId = null) => run(
  "INSERT INTO mrn (mrn_no, requested_by, approval_status, workshop_id, job_id) VALUES (?, 'someone', ?, ?, ?)", 'S3-' + (++seq), status, ws, jobId).lastInsertRowid;
run("INSERT INTO mechanics (name, name_norm) VALUES ('Anura', 'ANURA'), ('Buddhika', 'BUDDHIKA')");
run("INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Anura', 400, '2020-01-01'), ('Buddhika', 450, '2020-01-01')");
const ANURA = get("SELECT id FROM mechanics WHERE name = 'Anura'").id;
run("INSERT INTO mechanic_workshops (mechanic_id, workshop_id, from_date) VALUES (?, ?, ?)", ANURA, MTR, day(-3));

const V = { c: asset('C-1'), m: asset('M-1'), shared: asset('SH-1') };
const J = { c: job(V.c, CW), m: job(V.m, MTR), cApproval: job(asset('C-2'), CW, 'REQUESTED'), mApproval: job(asset('M-2'), MTR, 'REQUESTED'),
  shared: job(V.shared, CW, 'IN_PROGRESS', { description: 'Central-only notes' }) };
run("INSERT INTO job_parts (job_id, source_type, description, qty, unit_price) VALUES (?, 'external', 'Pump', 1, 90000)", J.shared);
const M = { c: mrn(CW), m: mrn(MTR), cCert: mrn(CW, 'certified'), mCert: mrn(MTR, 'certified') };

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
        const sc = res.headers['set-cookie'];
        resolve({ status: res.statusCode, body: json, text: buf, cookie: sc ? sc[0].split(';')[0] : null });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
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
const ids = (rows) => rows.map((r) => r.id);

// ================================================================== off: as before
test('switched off (the default): everyone sees every workshop, exactly as before', async () => {
  assert.strictEqual(scope.switchedOn(), false);
  const wsM = await as('wsM');
  const list = (await req('GET', '/api/jobs', { cookie: wsM })).body;
  assert.ok(ids(list).includes(J.c) && ids(list).includes(J.m));
  assert.strictEqual((await req('GET', `/api/jobs/${J.c}`, { cookie: wsM })).status, 200);
  assert.strictEqual((await req('GET', '/api/auth/me', { cookie: wsM })).body.seesAllWorkshops, true);
});

test('the switch: only whoever manages workshops turns it on; with one workshop it waits', async () => {
  assert.strictEqual((await req('PUT', '/api/workshops/separate', { cookie: await as('mgr'), body: { on: true } })).status, 403);
  run('UPDATE workshops SET active = 0 WHERE id = ?', MTR);
  try {
    const r = await req('PUT', '/api/workshops/separate', { cookie: await as('boss'), body: { on: true } });
    assert.deepStrictEqual(r.body, { separate: true, separate_in_force: false }, 'one workshop: nothing to keep apart');
    assert.strictEqual((await req('GET', `/api/jobs/${J.m}`, { cookie: await as('wsC') })).status, 200);
  } finally { run('UPDATE workshops SET active = 1 WHERE id = ?', MTR); }
  assert.strictEqual(scope.enabled(), true);
  assert.ok(get("SELECT 1 x FROM audit_log WHERE action = 'workshops_separate_on'"));
});

// ================================================================== job cards
test('job cards: your own workshop only; another\'s is refused by name; head office and the store see all', async () => {
  const wsM = await as('wsM');
  const mine = ids((await req('GET', '/api/jobs', { cookie: wsM })).body);
  assert.ok(mine.includes(J.m) && !mine.includes(J.c) && !mine.includes(J.shared));
  const no = await req('GET', `/api/jobs/${J.c}`, { cookie: wsM });
  assert.strictEqual(no.status, 403);
  assert.strictEqual(no.body.error, 'This job card belongs to Central Workshop — Badalgama.');
  assert.deepStrictEqual(no.body.other_workshop, { id: CW, name: 'Central Workshop — Badalgama' });
  // Every action on it, not just reading.
  assert.strictEqual((await req('POST', `/api/jobs/${J.c}/transition`, { cookie: wsM, body: { to: 'WORK_COMPLETE' } })).status, 403);
  assert.strictEqual((await req('POST', `/api/jobs/${J.c}/parts`, { cookie: wsM, body: { description: 'x', qty: 1 } })).status, 403);
  assert.strictEqual((await req('PATCH', `/api/jobs/${J.c}`, { cookie: wsM, body: { description: 'changed' } })).status, 403);
  assert.strictEqual(get('SELECT description d FROM job_cards WHERE id = ?', J.c).d, 'secret fault');
  assert.strictEqual((await req('GET', `/api/reports/job/${J.c}/report`, { cookie: wsM })).status, 403);
  const bulk = (await req('POST', '/api/jobs/bulk-transition', { cookie: wsM, body: { ids: [J.c], to: 'WORK_COMPLETE' } })).body;
  assert.strictEqual(bulk.success_count, 0);
  assert.match(bulk.failed[0].error, /belongs to Central Workshop/);
  // Your own card is yours as before.
  assert.strictEqual((await req('GET', `/api/jobs/${J.m}`, { cookie: wsM })).status, 200);
  assert.strictEqual((await req('GET', '/api/auth/me', { cookie: wsM })).body.seesAllWorkshops, false);
  // Head office and store staff: everything.
  for (const u of ['om', 'mgr', 'boss', 'sk']) {
    const all_ = ids((await req('GET', '/api/jobs', { cookie: await as(u) })).body);
    assert.ok(all_.includes(J.c) && all_.includes(J.m), u);
    assert.strictEqual((await req('GET', `/api/jobs/${J.m}`, { cookie: await as(u) })).status, 200, u);
  }
});

test('one open card per vehicle holds across every workshop, and says where', async () => {
  const r = await req('POST', '/api/jobs', { cookie: await as('wsM'), body: { asset_id: V.c, description: 'x' } });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /at Central Workshop — Badalgama\)/);
});

test('a vehicle is shared: another workshop\'s card shows number, status and workshop — nothing more', async () => {
  const a = (await req('GET', `/api/assets/${V.shared}`, { cookie: await as('wsM') })).body;
  assert.deepStrictEqual(a.open_jobs[0], { id: J.shared, job_no: get('SELECT job_no FROM job_cards WHERE id = ?', J.shared).job_no,
    status: 'IN_PROGRESS', type: 'repair', workshop_name: 'Central Workshop — Badalgama', workshop_id: CW, reachable: false });
  assert.ok(!JSON.stringify(a.timeline).includes('Central-only notes'), 'the description stays with its workshop');
  run("INSERT INTO mrn (mrn_no, asset_id, purpose, workshop_id, requested_by) VALUES ('S3-TL', ?, 'Central purpose', ?, 'x')", V.shared, CW);
  const again = (await req('GET', `/api/assets/${V.shared}`, { cookie: await as('wsM') })).body;
  assert.ok(again.timeline.some((t) => t.ref === 'S3-TL' && t.description === 'Material request at Central Workshop — Badalgama'));
  const own = (await req('GET', `/api/assets/${V.shared}`, { cookie: await as('wsC') })).body;
  assert.strictEqual(own.open_jobs[0].reachable, true);
  assert.strictEqual(own.open_jobs[0].description, 'Central-only notes');
});

// ================================================================== job requests
test('job requests: raised for your own workshop, seen and signed by your own; the card follows', async () => {
  const atM = await as('atM');
  const r = await req('POST', '/api/job-requests', { cookie: atM, body: { asset_id: asset('JR-1'), description: 'noise' } });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.body.request.workshop_id, MTR);
  const jr = r.body.request.id;
  const other = run(`INSERT INTO job_requests (jr_no, asset_id, type, description, approval_status, workshop_id)
                     VALUES ('JR-C1', ?, 'repair', 'x', 'requested', ?)`, asset('JR-2'), CW).lastInsertRowid;
  const seenM = ids((await req('GET', '/api/job-requests', { cookie: await as('tmM') })).body);
  assert.ok(seenM.includes(jr) && !seenM.includes(other));
  assert.strictEqual((await req('POST', `/api/job-requests/${other}/certify`, { cookie: await as('tmM'), body: {} })).status, 403);
  assert.strictEqual((await req('GET', `/api/job-requests/${other}/print.html`, { cookie: await as('tmM') })).status, 403);
  assert.strictEqual((await req('POST', `/api/job-requests/${jr}/certify`, { cookie: await as('tmM'), body: {} })).status, 200);
  // Store staff are not head office for job requests (they see every request for goods, not these).
  assert.ok(!ids((await req('GET', '/api/job-requests', { cookie: await as('tmC') })).body).includes(jr));
  const skUser = { id: U.sk, roles: ['storekeeper'] };
  assert.ok(scope.jobRequestRefusal(skUser, jr), 'the storekeeper (at Central) does not reach Muthur\'s job request');
  assert.strictEqual(scope.jobRefusal(skUser, J.m), null, '…but does reach its job cards, while there is one store');
  const ok = await req('POST', `/api/job-requests/${jr}/approve`, { cookie: await as('om'), body: {} });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.strictEqual(get('SELECT workshop_id w FROM job_cards WHERE id = ?', ok.body.job.id).w, MTR);
  // Raised for another workshop on purpose: the card goes where the request says, not the raiser's.
  const forC = await req('POST', '/api/job-requests', { cookie: atM, body: { asset_id: asset('JR-3'), description: 'x', workshop_id: CW } });
  assert.strictEqual(forC.body.request.workshop_id, CW);
  run("UPDATE job_requests SET approval_status = 'certified' WHERE id = ?", forC.body.request.id);
  run("INSERT INTO job_request_approvals (job_request_id, stage, role, approver_id, decision) VALUES (?, 'certify', 'transport_manager', ?, 'approved')", forC.body.request.id, U.tmC);
  const okC = await req('POST', `/api/job-requests/${forC.body.request.id}/approve`, { cookie: await as('om'), body: {} });
  assert.strictEqual(get('SELECT workshop_id w FROM job_cards WHERE id = ?', okC.body.job.id).w, CW);
});

// ================================================================== requests (MRN)
test('requests (MRN): your own workshop\'s to see and sign; the store sees them all', async () => {
  const wsM = await as('wsM');
  const list = ids((await req('GET', '/api/stores/mrn', { cookie: wsM })).body);
  assert.ok(list.includes(M.m) && !list.includes(M.c));
  assert.strictEqual((await req('GET', `/api/stores/mrn/${M.c}`, { cookie: wsM })).status, 403);
  assert.strictEqual((await req('GET', `/api/stores/mrn/${M.c}/print.html`, { cookie: wsM })).status, 403);
  const cert = await req('POST', `/api/stores/mrn/${M.c}/certify`, { cookie: wsM, body: {} });
  assert.strictEqual(cert.status, 403);
  assert.strictEqual(get('SELECT approval_status s FROM mrn WHERE id = ?', M.c).s, 'requested');
  assert.strictEqual((await req('POST', `/api/stores/mrn/${M.m}/certify`, { cookie: wsM, body: {} })).status, 200);
  const count = (await req('GET', '/api/stores/mrn/pending-count', { cookie: wsM })).body;
  assert.strictEqual(count.certified, get('SELECT COUNT(*) n FROM mrn WHERE approval_status = ? AND workshop_id = ?', 'certified', MTR).n);
  const sk = ids((await req('GET', '/api/stores/mrn', { cookie: await as('sk') })).body);
  assert.ok(sk.includes(M.c) && sk.includes(M.m), 'one store serves every workshop, so its staff reach every workshop (Stage 4: the workshops their store serves)');
  assert.strictEqual((await req('GET', `/api/stores/mrn/${M.m}`, { cookie: await as('sk') })).status, 200);
  const skMe = (await req('GET', '/api/auth/me', { cookie: await as('sk') })).body;
  assert.deepStrictEqual([skMe.seesAllWorkshops, skMe.workshopsSeen], [true, null], 'one store serving them all: every workshop, as before');
});

test('issuing shelf stock to another workshop\'s card is refused (the store itself may)', async () => {
  // A site role that may issue off the shelf (with Stores clearance), posted to Muthur.
  run("INSERT INTO roles (name, label) VALUES ('site_issuer', 'Site Issuer')");
  run("INSERT INTO role_capabilities (role, capability, granted) VALUES ('site_issuer', 'stores.stock_issue', 1)");
  require('../src/lib/permissions').setPermission('site_issuer', 'stores', 'edit');
  mkUser('siM', ['site_issuer'], MTR);
  const r = await req('POST', '/api/stores/stock-issue', { cookie: await as('siM'), body: { job_id: J.c, lines: [{ description: 'Rag', qty: 1 }] } });
  assert.strictEqual(r.status, 403, r.text);
  assert.match(r.body.error, /belongs to Central Workshop/);
});

// ================================================================== daily work
test('daily work: your own workshop\'s lines; general work goes on your workshop\'s own general card', async () => {
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, ?, 'Buddhika', 'central line', 2)", J.c, TODAY);
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, ?, 'Anura', 'muthur line', 3)", J.m, TODAY);
  const wsM = await as('wsM');
  const dayList = (await req('GET', `/api/daily-work?date=${TODAY}`, { cookie: wsM })).body.entries.map((e) => e.description);
  assert.ok(dayList.includes('muthur line') && !dayList.includes('central line'));
  const month = (await req('GET', `/api/daily-work/month?month=${TODAY.slice(0, 7)}`, { cookie: wsM })).body.entries.map((e) => e.description);
  assert.ok(month.includes('muthur line') && !month.includes('central line'));
  const days = (await req('GET', '/api/daily-work/days', { cookie: wsM })).body.find((d) => d.date === TODAY);
  assert.strictEqual(days.hours, 3);
  // Work on another workshop's card, however it is aimed at, is refused.
  assert.strictEqual((await req('POST', '/api/daily-work', { cookie: wsM, body: { work_date: TODAY, job_id: J.c, mechanic: 'Anura', hours: 1 } })).status, 403);
  assert.strictEqual((await req('POST', '/api/daily-work', { cookie: wsM, body: { work_date: TODAY, asset_id: V.c, mechanic: 'Anura', hours: 1 } })).status, 403);
  const cLine = get("SELECT id FROM job_daily_work WHERE description = 'central line'").id;
  assert.strictEqual((await req('PATCH', `/api/daily-work/${cLine}`, { cookie: wsM, body: { hours: 9 } })).status, 403);
  assert.strictEqual((await req('DELETE', `/api/daily-work/${cLine}`, { cookie: wsM })).status, 403);
  // General work: Muthur's own general card, and its own pool.
  const g = await req('POST', '/api/daily-work', { cookie: wsM, body: { work_date: TODAY, request_type: 'general', mechanic: 'Anura', hours: 1, description: 'yard sweep' } });
  assert.strictEqual(g.status, 201, g.text);
  assert.strictEqual(g.body.job_no, 'GENERAL-WS-MTR');
  const gCard = get("SELECT * FROM job_cards WHERE legacy_ref = ?", `general-workshop:${MTR}`);
  assert.strictEqual(gCard.workshop_id, MTR);
  const poolM = (await req('GET', `/api/jobs/unassigned/daily-work?job_id=${J.m}`, { cookie: wsM })).body.map((r) => r.description);
  assert.ok(poolM.includes('yard sweep'));
  const poolC = (await req('GET', `/api/jobs/unassigned/daily-work?job_id=${J.c}`, { cookie: await as('wsC') })).body.map((r) => r.description);
  assert.ok(!poolC.includes('yard sweep'), "Central's pool is Central's");
  // Head office (at home in Central) opening Muthur's card sees Muthur's pool.
  const poolHo = (await req('GET', `/api/jobs/unassigned/daily-work?job_id=${J.m}`, { cookie: await as('om') })).body.map((r) => r.description);
  assert.ok(poolHo.includes('yard sweep'));
  const line = get("SELECT id FROM job_daily_work WHERE description = 'yard sweep'").id;
  const at = await req('POST', `/api/jobs/${J.m}/daily-work/attach`, { cookie: wsM, body: { ids: [line] } });
  assert.strictEqual(at.status, 200, at.text);
  assert.strictEqual(get('SELECT job_id j FROM job_daily_work WHERE id = ?', line).j, J.m);
  // Taken off again, it goes back to Muthur's pool, not Central's.
  const back = await req('DELETE', `/api/jobs/${J.m}/daily-work/${line}`, { cookie: wsM });
  assert.strictEqual(back.status, 200, back.text);
  assert.strictEqual(get('SELECT job_id j FROM job_daily_work WHERE id = ?', line).j, gCard.id);
});

test('general work named to a vehicle another workshop holds goes on your own month card for it', async () => {
  const r = await req('POST', '/api/daily-work', { cookie: await as('wsM'),
    body: { work_date: TODAY, request_type: 'general', asset_id: V.c, mechanic: 'Anura', hours: 1, description: 'helped with lifting' } });
  assert.strictEqual(r.status, 201, r.text);
  const card = get("SELECT j.* FROM job_daily_work w JOIN job_cards j ON j.id = w.job_id WHERE w.description = 'helped with lifting'");
  assert.notStrictEqual(card.id, J.c, 'not Central\'s open card');
  assert.strictEqual(card.workshop_id, MTR);
  assert.strictEqual(card.legacy_ref, 'auto-container-labour');
});

test('the reopen queue holds your own workshop\'s cards', async () => {
  const cClosed = job(asset('RO-1'), CW, 'CLOSED');
  const mClosed = job(asset('RO-2'), MTR, 'CLOSED');
  const rC = run("INSERT INTO job_reopen_requests (job_id, requested_by, reason) VALUES (?, ?, 'x')", cClosed, U.wsC).lastInsertRowid;
  const rM = run("INSERT INTO job_reopen_requests (job_id, requested_by, reason) VALUES (?, ?, 'y')", mClosed, U.atM).lastInsertRowid;
  const q = ids((await req('GET', '/api/jobs/reopen-requests', { cookie: await as('wsM') })).body);
  assert.ok(q.includes(rM) && !q.includes(rC));
  assert.strictEqual((await req('POST', `/api/jobs/reopen-requests/${rC}/refuse`, { cookie: await as('wsM'), body: { note: 'no' } })).status, 403);
  assert.strictEqual(get('SELECT status s FROM job_reopen_requests WHERE id = ?', rC).s, 'pending');
});

test('the mechanic list: your own workshop\'s mechanics on the day (head office: all)', async () => {
  const names = async (u, q = '') => (await req('GET', `/api/mechanics${q}`, { cookie: await as(u) })).body.map((m) => m.name);
  assert.deepStrictEqual(await names('wsM'), ['Anura']);
  assert.deepStrictEqual(await names('wsM', `?date=${day(-10)}`), [], 'before the move Anura was at Central');
  assert.deepStrictEqual(await names('wsC'), ['Buddhika']);
  assert.deepStrictEqual(await names('om'), ['Anura', 'Buddhika']);
  assert.deepStrictEqual(await names('om', `?workshop_id=${MTR}`), ['Anura']);
});

// ================================================================== dashboard and queues
test('the dashboard and the approval queues hold your own workshop\'s items', async () => {
  const d = (await req('GET', '/api/reports/dashboard', { cookie: await as('wsM') })).body;
  assert.strictEqual(d.open_jobs_count, get("SELECT COUNT(*) n FROM job_cards j WHERE workshop_id = ? AND status NOT IN ('PARTIALLY_CLOSED','CLOSED','REJECTED')", MTR).n);
  const dOm = (await req('GET', '/api/reports/dashboard', { cookie: await as('om') })).body;
  assert.ok(dOm.open_jobs_count > d.open_jobs_count);
  const qM = (await req('GET', '/api/reports/pending-approvals', { cookie: await as('tmM') })).body;
  assert.ok(ids(qM.transport).includes(J.mApproval) && !ids(qM.transport).includes(J.cApproval));
  const qC = (await req('GET', '/api/reports/pending-approvals', { cookie: await as('tmC') })).body;
  assert.ok(ids(qC.transport).includes(J.cApproval) && !ids(qC.transport).includes(J.mApproval));
  const certM = (await req('GET', '/api/reports/pending-approvals', { cookie: await as('wsM') })).body.certify;
  assert.ok(certM.every((m) => get('SELECT workshop_id w FROM mrn WHERE id = ?', m.id).w === MTR));
  const opsAll = (await req('GET', '/api/reports/pending-approvals', { cookie: await as('om') })).body;
  assert.ok(ids(opsAll.approve).includes(M.cCert) && ids(opsAll.approve).includes(M.mCert), 'head office: every workshop');
});

test('switched off again: everything is shared once more', async () => {
  assert.strictEqual((await req('PUT', '/api/workshops/separate', { cookie: await as('boss'), body: { on: false } })).status, 200);
  assert.strictEqual((await req('GET', `/api/jobs/${J.c}`, { cookie: await as('wsM') })).status, 200);
  assert.ok(ids((await req('GET', '/api/stores/mrn', { cookie: await as('wsM') })).body).includes(M.c));
});
