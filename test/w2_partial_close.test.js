'use strict';

// W2 — partial close, full close and reopen requests (docs/WORKSHOPONE_PLAN.md §A.2, Stage W2).
//
//   A partly closed card no longer holds its vehicle, and takes only prices, what was already
//   requested, general items and daily work up to its partial-close day. Full close needs the
//   closure check, now with "work done recorded". A reopen is asked for, approved by somebody else,
//   and only when the vehicle has no other open card. Switched off, everything is as it was.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-w2-'));
process.env.DB_PATH = path.join(TMP, 'w2.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const jobstate = require('../src/lib/jobstate');
const closeLib = require('../src/lib/job_close');
const costing = require('../src/lib/costing');

migrate();
for (const n of ['admin', 'workshop', 'operational_manager', 'manager', 'storekeeper', 'transport_manager', 'viewer']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
const PW = 'ember-harbour-quarry';
function mkUser(username, roles) {
  const id = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', username, auth.hashPassword(PW)).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const U = { boss: mkUser('boss', ['admin']), ws: mkUser('ws', ['workshop']), om: mkUser('om', ['operational_manager']),
  mgr: mkUser('mgr', ['manager']), sk: mkUser('sk', ['storekeeper']),
  // May edit job cards (Job Cards clearance: edit) but holds neither new permission.
  tm: mkUser('tm', ['transport_manager']) };

run("INSERT INTO mechanics (name, name_norm) VALUES ('Anura', 'ANURA')");
run("INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Anura', 400, '2020-01-01')");

const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY = day(0);
let seq = 0;
const asset = (code) => run('INSERT INTO assets (code, code_norm, status, in_register) VALUES (?, ?, ?, 1)', code, code.replace(/\W/g, ''), 'under_repair').lastInsertRowid;
const job = (assetId, status = 'IN_PROGRESS', extra = {}) => run(
  `INSERT INTO job_cards (job_no, asset_id, type, description, status, is_historical, requested_at, flat_labour)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  `2024/9/${extra.type === 'service' ? 'S' : 'R'}/${800 + (++seq)}`, assetId, extra.type || 'repair', extra.description || 'test job', status,
  extra.historical ? 1 : 0, extra.requested_at || day(-20), extra.flat_labour == null ? null : extra.flat_labour).lastInsertRowid;
const work = (jobId, date = day(-5), hours = 3) => run(
  "INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, ?, 'Anura', 'work', ?)", jobId, date, hours).lastInsertRowid;
const part = (jobId, price = null) => run(
  "INSERT INTO job_parts (job_id, source_type, description, qty, unit_price) VALUES (?, 'external', 'Seal kit', 1, ?)", jobId, price).lastInsertRowid;
const J = (id) => get('SELECT * FROM job_cards WHERE id = ?', id);

// A request on the card, received but not yet handed over: the one thing the card may still take off the shelf.
function receiptFor(jobId, assetId) {
  const m = run("INSERT INTO mrn (mrn_no, asset_id, job_id, requested_by, approval_status) VALUES (?, ?, ?, 'ws', 'approved')",
    'W2-' + (++seq), assetId, jobId).lastInsertRowid;
  const l = run("INSERT INTO mrn_lines (mrn_id, description, qty, qty_received) VALUES (?, 'Hydraulic hose', 1, 1)", m).lastInsertRowid;
  const g = run("INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, unit_price, delivery_date) VALUES (?, ?, ?, 'Hydraulic hose', 1, 5000, ?)",
    'G-' + seq, m, l, day(-3)).lastInsertRowid;
  run("INSERT INTO job_parts (job_id, source_type, source_id, description, qty, unit_price, mrn_line_id) VALUES (?, 'grn', ?, 'Hydraulic hose', 1, 5000, ?)", jobId, g, l);
  return { mrn: m, line: l, grn: g };
}

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
const on = () => closeLib.setEnabled(true);
const off = () => closeLib.setEnabled(false);

// ================================================================== switched off: as before
test('switched off (the default): no partial close, direct reopen, the old close gate', async () => {
  assert.strictEqual(jobstate.partialCloseEnabled(), false, 'off until somebody switches it on');
  const boss = await as('boss');
  const v = asset('OFF-1');
  const j = job(v, 'WORK_COMPLETE');
  part(j, null);
  assert.strictEqual((await req('POST', `/api/jobs/${j}/partial-close`, { cookie: boss, body: { note: 'x' } })).status, 409);
  assert.strictEqual((await req('POST', `/api/jobs/${j}/reopen-request`, { cookie: boss, body: { reason: 'x' } })).status, 409);
  const refused = await req('POST', `/api/jobs/${j}/transition`, { cookie: boss, body: { to: 'CLOSED' } });
  assert.strictEqual(refused.status, 409);
  assert.strictEqual(refused.body.error, 'Job is not fully priced — cannot close', 'the same words as before');
  assert.ok(!refused.body.missing.some((m) => /work done/i.test(m)), 'no work rule while off');
  run('UPDATE job_parts SET unit_price = 100 WHERE job_id = ?', j);
  assert.strictEqual((await req('POST', `/api/jobs/${j}/transition`, { cookie: boss, body: { to: 'CLOSED' } })).status, 200,
    'no daily work, and it still closes — exactly as before');
  const reopen = await req('POST', `/api/jobs/${j}/transition`, { cookie: boss, body: { to: 'IN_PROGRESS', reason: 'forgot a part' } });
  assert.strictEqual(reopen.status, 200, reopen.text);
  assert.strictEqual(J(j).status, 'IN_PROGRESS');
  const pa = await req('GET', '/api/reports/pending-approvals', { cookie: await as('ws') });
  assert.deepStrictEqual(pa.body.reopen, []);
});

test('only jobs.settings (admin) switches it, and the switch is audited', async () => {
  assert.strictEqual((await req('PUT', '/api/jobs/close-settings', { cookie: await as('om'), body: { partial_close_enabled: true } })).status, 403);
  const r = await req('PUT', '/api/jobs/close-settings', { cookie: await as('boss'), body: { partial_close_enabled: true } });
  assert.deepStrictEqual([r.status, r.body.partial_close_enabled], [200, true]);
  assert.ok(get("SELECT 1 x FROM audit_log WHERE entity = 'settings' AND action = 'partial_close_switch'"));
  assert.strictEqual((await req('GET', '/api/jobs/close-settings', { cookie: await as('sk') })).body.partial_close_enabled, true);
});

// ================================================================== partly close
test('partly closing needs the permission, a card in progress, work recorded (or a note), and something outstanding', async () => {
  on();
  const v = asset('PC-1');
  const j = job(v, 'IN_PROGRESS');
  part(j, null);
  assert.strictEqual((await req('POST', `/api/jobs/${j}/partial-close`, { cookie: await as('tm'), body: { note: 'x' } })).status, 403, 'transport manager: no jobs.partial_close');
  const noWork = await req('POST', `/api/jobs/${j}/partial-close`, { cookie: await as('ws'), body: {} });
  assert.strictEqual(noWork.status, 400);
  assert.match(noWork.body.error, /No work is recorded/);
  const early = job(asset('PC-2'), 'REQUESTED');
  assert.strictEqual((await req('POST', `/api/jobs/${early}/partial-close`, { cookie: await as('ws'), body: { note: 'x' } })).status, 409);
  const ready = job(asset('PC-3'), 'WORK_COMPLETE');
  work(ready);
  const nothing = await req('POST', `/api/jobs/${ready}/partial-close`, { cookie: await as('ws'), body: { note: 'x' } });
  assert.strictEqual(nothing.status, 409);
  assert.match(nothing.body.error, /close it fully/);
  const viaTransition = await req('POST', `/api/jobs/${j}/transition`, { cookie: await as('ws'), body: { to: 'PARTIALLY_CLOSED' } });
  assert.strictEqual(viaTransition.status, 400, 'it has its own route');
  const withNote = await req('POST', `/api/jobs/${j}/partial-close`, { cookie: await as('ws'), body: { note: 'Vehicle towed to site, no workshop hours' } });
  assert.strictEqual(withNote.status, 200, withNote.text);
  assert.strictEqual(J(j).partial_note, 'Vehicle towed to site, no workshop hours');
});

// The card most of the tests below use.
const V = asset('WP-7');
const P = job(V, 'WORK_COMPLETE', { description: 'Gearbox overhaul' });
const pWork = work(P, day(-4), 6);
const pPart = part(P, null);
const pReceipt = receiptFor(P, V);
const generalItem = run("INSERT INTO store_items (name, balance, is_general) VALUES ('Cotton waste', 50, 1)").lastInsertRowid;
const shelf = run("INSERT INTO stock_items (code, section, name, item_key, unit_price, source_table) VALUES ('GEN-0001', 'general', 'Grease gun', 'GREASEGUN', 900, 'stock_items')").lastInsertRowid;
let NEWJOB = null;

test('partly close: the vehicle is free, a new card points back, and the report month is the partial-close month', async () => {
  const ws = await as('ws');
  const r = await req('POST', `/api/jobs/${P}/partial-close`, { cookie: ws, body: { note: 'Waiting for the seal kit invoice', open_new: true } });
  assert.strictEqual(r.status, 200, r.text);
  const j = J(P);
  assert.strictEqual(j.status, 'PARTIALLY_CLOSED');
  assert.strictEqual(String(j.partial_closed_at).slice(0, 10), TODAY);
  assert.strictEqual(String(j.completed_at).slice(0, 10), TODAY, 'the report month is the partial-close month (W-D9)');
  assert.strictEqual(j.partial_closed_by, U.ws);
  assert.ok(r.body.missing.some((m) => /Seal kit/.test(m)), 'what is outstanding comes back');
  assert.ok(r.body.new_job, 'a new card was opened');
  NEWJOB = r.body.new_job.id;
  assert.strictEqual(J(NEWJOB).continues_job_id, P);
  assert.strictEqual(J(NEWJOB).asset_id, V);
  assert.strictEqual(J(NEWJOB).status, 'REQUESTED');
  assert.strictEqual(jobstate.openJobFor(V).id, NEWJOB, 'the partly closed card no longer holds the vehicle');
  const detail = await req('GET', `/api/jobs/${P}`, { cookie: ws });
  assert.strictEqual(detail.body.continuedAs[0].id, NEWJOB);
  assert.strictEqual((await req('GET', `/api/jobs/${NEWJOB}`, { cookie: ws })).body.continues.id, P);
  assert.ok(get("SELECT 1 x FROM audit_log WHERE entity = 'job_card' AND action = 'partial_close' AND entity_id = ?", P));
  const dash = await req('GET', '/api/reports/dashboard', { cookie: ws });
  assert.ok(dash.body.partly_closed.some((x) => x.id === P && x.missing_count > 0), 'dashboard: partly closed, awaiting prices');
  assert.ok(!all(`SELECT id FROM job_cards WHERE ${jobstate.openSql()}`).some((x) => x.id === P), 'not counted as open');
  const a = await req('GET', `/api/assets/${V}`, { cookie: ws });
  assert.deepStrictEqual([a.body.open_jobs.map((x) => x.id), a.body.partly_closed_jobs.map((x) => x.id)], [[NEWJOB], [P]], 'the asset shows them apart');
});

test('a vehicle whose only card is partly closed can get a new card straight away', async () => {
  const v = asset('WP-8');
  const j = job(v, 'IN_PROGRESS');
  work(j); part(j, null);
  await req('POST', `/api/jobs/${j}/partial-close`, { cookie: await as('ws'), body: {} });
  assert.strictEqual(J(j).status, 'PARTIALLY_CLOSED');
  assert.ok(jobstate.checkOneOpenJob(v).ok, 'job requests and new cards see a free vehicle');
  const fresh = await req('POST', '/api/jobs', { cookie: await as('ws'), body: { asset_id: v, type: 'repair', description: 'Next fault' } });
  assert.strictEqual(fresh.status, 201, fresh.text);
  assert.strictEqual(get('SELECT status s FROM assets WHERE id = ?', v).s, 'active', 'nothing held it after the partial close');
});

// ================================================================== what a partly closed card refuses
test('a partly closed card refuses exactly the listed actions, and says where to go instead', async () => {
  const boss = await as('boss');
  const newNo = J(NEWJOB).job_no;
  const tries = [
    ['new MRN', 'POST', '/api/stores/mrn', { asset_id: V, job_id: P, lines: [{ description: 'Filter', qty: 1 }] }],
    ['MRN line', 'POST', `/api/stores/mrn/${pReceipt.mrn}/lines`, { description: 'Gasket', qty: 1 }],
    ['tyre request', 'POST', '/api/tb/requests', { kind: 'tyre', job_id: P, lines: [{ qty: 1 }] }],
    ['new part line', 'POST', `/api/jobs/${P}/parts`, { source_type: 'external', description: 'Machining', qty: 1, unit_price: 500 }],
    ['remove a part', 'DELETE', `/api/jobs/${P}/parts/${pPart}`],
    ['claim a receipt', 'POST', `/api/jobs/${P}/parts/attach`, { receipts: [1] }],
    ['claim daily work', 'POST', `/api/jobs/${P}/daily-work/attach`, { ids: [1] }],
    ['edit the card', 'PATCH', `/api/jobs/${P}`, { description: 'changed' }],
    ['shelf stock', 'POST', '/api/stores/stock-issue', { job_id: P, lines: [{ stock_item_id: shelf, qty: 1 }] }],
    ['free issue', 'POST', '/api/stores/issues', { job_id: P, description: 'Bolt', qty: 1, unit_price: 50 }],
    ['own receipt + shelf stock together', 'POST', '/api/stores/stock-issue', { job_id: P, lines: [{ grn_id: pReceipt.grn, qty: 1 }, { stock_item_id: shelf, qty: 1 }] }],
    ['work after the partial close (job card)', 'POST', `/api/jobs/${P}/daily-work`, { work_date: day(1), mechanic: 'Anura', hours: 2 }],
    ['work after the partial close (Daily Work)', 'POST', '/api/daily-work', { work_date: day(1), job_id: P, mechanic: 'Anura', hours: 2 }],
  ];
  for (const [what, method, p, body] of tries) {
    const r = await req(method, p, { cookie: boss, body });
    assert.strictEqual(r.status, 409, `${what}: ${r.status} ${r.text}`);
    assert.match(r.body.error, /partly closed/, what);
  }
  const msg = (await req('POST', `/api/jobs/${P}/parts`, { cookie: boss, body: { source_type: 'external', description: 'x' } })).body;
  assert.strictEqual(msg.error, `This job is partly closed. You can price items, receive what was already requested and add general items. To add anything else, request a reopen — or use the vehicle's new job ${newNo}.`);
  assert.strictEqual(msg.successor.id, NEWJOB);
  const late = await req('POST', `/api/jobs/${P}/daily-work`, { cookie: boss, body: { work_date: day(1), mechanic: 'Anura', hours: 2 } });
  assert.match(late.body.error, new RegExp(`partly closed on ${TODAY}\\. Work after that date goes on the vehicle's new job \\(${newNo.replace(/\//g, '\\/')}\\)`));
  assert.strictEqual(get('SELECT COUNT(*) n FROM job_parts WHERE job_id = ?', P).n, 2, 'nothing was added');
});

test('a partly closed card still takes prices, its own receipts, general items and catching-up daily work', async () => {
  const ws = await as('ws'); const boss = await as('boss');
  const price = await req('PATCH', `/api/jobs/${P}/parts/${pPart}`, { cookie: ws, body: { unit_price: 2500 } });
  assert.strictEqual(price.status, 200, price.text);
  const own = await req('POST', '/api/stores/stock-issue', { cookie: boss, body: { job_id: P, lines: [{ grn_id: pReceipt.grn, qty: 1 }] } });
  assert.strictEqual(own.status, 201, own.text);
  const general = await req('POST', `/api/stores/items/${generalItem}/txn`, { cookie: boss, body: { txn_type: 'issue', qty: 2, job_id: P, unit_price: 40 } });
  assert.strictEqual(general.status, 201, `general items go on without a confirmation: ${general.text}`);
  const catchUp = await req('POST', `/api/jobs/${P}/daily-work`, { cookie: ws, body: { work_date: day(-1), mechanic: 'Anura', hours: 1 } });
  assert.strictEqual(catchUp.status, 201, catchUp.text);
  const sameDay = await req('POST', '/api/daily-work', { cookie: ws, body: { work_date: TODAY, job_id: P, mechanic: 'Anura', hours: 1 } });
  assert.strictEqual(sameDay.status, 201, `the partial-close day itself: ${sameDay.text}`);
  const fix = await req('PATCH', `/api/daily-work/${pWork}`, { cookie: ws, body: { hours: 5.5 } });
  assert.strictEqual(fix.status, 200, 'correcting an earlier line');
  const move = await req('PATCH', `/api/daily-work/${pWork}`, { cookie: ws, body: { work_date: day(2) } });
  assert.strictEqual(move.status, 409, 'but not moving it past the partial close');
  const service = job(asset('WP-9'), 'IN_PROGRESS', { type: 'service', flat_labour: null });
  part(service, null);
  await req('POST', `/api/jobs/${service}/partial-close`, { cookie: ws, body: { note: 'labour amount not agreed yet' } });
  assert.strictEqual(J(service).status, 'PARTIALLY_CLOSED');
  assert.strictEqual((await req('PATCH', `/api/jobs/${service}/flat-labour`, { cookie: ws, body: { flat_labour: 3000 } })).status, 200, 'service flat labour is a price');
});

test('daily work logged by vehicle after the partial close lands on the new card', async () => {
  const r = await req('POST', '/api/daily-work', { cookie: await as('ws'), body: { work_date: day(1), asset_id: V, mechanic: 'Anura', hours: 2 } });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.body.job_no, J(NEWJOB).job_no);
});

// ================================================================== close fully
test('close fully: refused until everything is priced and received and the work is recorded', async () => {
  const om = await as('om');
  const extra = run("INSERT INTO job_parts (job_id, source_type, description, qty) VALUES (?, 'external', 'Bearing', 1)", P).lastInsertRowid;
  const refused = await req('POST', `/api/jobs/${P}/transition`, { cookie: om, body: { to: 'CLOSED' } });
  assert.strictEqual(refused.status, 409);
  assert.match(refused.body.error, /Not ready to close fully — 1 thing still missing\.$/);
  assert.ok(refused.body.missing.some((m) => /Bearing/.test(m)));
  run('UPDATE job_parts SET unit_price = 800 WHERE id = ?', extra);
  const ok = await req('POST', `/api/jobs/${P}/transition`, { cookie: om, body: { to: 'CLOSED' } });
  assert.strictEqual(ok.status, 200, ok.text);
  const j = J(P);
  assert.strictEqual(j.status, 'CLOSED');
  assert.strictEqual(String(j.completed_at).slice(0, 10), TODAY, 'still in the partial-close month');
  assert.ok(j.closed_at);
  assert.ok(get('SELECT 1 x FROM job_costs WHERE job_id = ?', P), 'a cost snapshot, like every close');

  // "Work done recorded" — a live repair with nothing on it cannot be closed fully.
  const empty = job(asset('WP-10'), 'WORK_COMPLETE');
  const noWork = await req('POST', `/api/jobs/${empty}/transition`, { cookie: om, body: { to: 'CLOSED' } });
  assert.strictEqual(noWork.status, 409);
  assert.ok(noWork.body.missing.some((m) => /No work done recorded/.test(m)));
  assert.match(noWork.body.error, /Partly close it instead/);
  const history = job(asset('WP-11'), 'WORK_COMPLETE', { historical: true });
  assert.strictEqual((await req('POST', `/api/jobs/${history}/transition`, { cookie: om, body: { to: 'CLOSED' } })).status, 200, 'imported history is not held to it');
  const svc = job(asset('WP-12'), 'WORK_COMPLETE', { type: 'service', flat_labour: 2500 });
  assert.strictEqual((await req('POST', `/api/jobs/${svc}/transition`, { cookie: om, body: { to: 'CLOSED' } })).status, 200, 'a service: its flat labour is the work');
});

test('close on date: a live card that is not ready is PARTLY closed on that date (W-D12); a ready one closes', async () => {
  const om = await as('om');
  const notReady = job(asset('CD-1'), 'IN_WORKSHOP', { requested_at: '2026-06-02' });
  work(notReady, '2026-06-05'); part(notReady, null);
  const r = await req('POST', `/api/jobs/${notReady}/close-on-date`, { cookie: om, body: { date: '2026-06-20', reason: 'finished in June' } });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.partly_closed, true);
  assert.match(r.body.warning, /Partly closed on 2026-06-20/);
  assert.deepStrictEqual([J(notReady).status, J(notReady).completed_at, J(notReady).partial_closed_at], ['PARTIALLY_CLOSED', '2026-06-20', '2026-06-20']);
  const again = await req('POST', `/api/jobs/${notReady}/close-on-date`, { cookie: om, body: { date: '2026-06-21' } });
  assert.strictEqual(again.status, 409, 'a partly closed card is closed with "Close fully"');
  const ready = job(asset('CD-2'), 'IN_PROGRESS');
  work(ready, '2026-06-03');
  assert.strictEqual((await req('POST', `/api/jobs/${ready}/close-on-date`, { cookie: om, body: { date: '2026-06-25' } })).body.status, 'CLOSED');
  const old = job(asset('CD-3'), 'REQUESTED', { historical: true });
  part(old, null);
  assert.strictEqual((await req('POST', `/api/jobs/${old}/close-on-date`, { cookie: om, body: { date: '2023-04-10' } })).body.status, 'CLOSED', 'imported history closes as before');
});

// ================================================================== reopen requests
let REQ = null;
test('with partial close on, a reopen is asked for — nobody reopens directly', async () => {
  const om = await as('om'); const ws = await as('ws'); const tm = await as('tm');
  const direct = await req('POST', `/api/jobs/${P}/transition`, { cookie: await as('boss'), body: { to: 'IN_PROGRESS', reason: 'x' } });
  assert.strictEqual(direct.status, 409);
  assert.strictEqual(direct.body.use_request, true);
  assert.strictEqual((await req('POST', `/api/jobs/${P}/reopen-request`, { cookie: tm, body: { reason: 'x' } })).status, 403, 'transport manager: no jobs.reopen_request');
  assert.strictEqual((await req('POST', `/api/jobs/${P}/reopen-request`, { cookie: ws, body: { reason: ' ' } })).status, 400, 'a reason');
  const open = job(asset('RQ-1'), 'IN_PROGRESS');
  assert.strictEqual((await req('POST', `/api/jobs/${open}/reopen-request`, { cookie: ws, body: { reason: 'x' } })).status, 409, 'nothing to reopen');
  const r = await req('POST', `/api/jobs/${P}/reopen-request`, { cookie: ws, body: { reason: 'Gearbox noise came back' } });
  assert.strictEqual(r.status, 201, r.text);
  REQ = r.body.id;
  assert.strictEqual((await req('POST', `/api/jobs/${P}/reopen-request`, { cookie: om, body: { reason: 'again' } })).status, 409, 'one at a time');
  const mine = await req('GET', '/api/reports/pending-approvals', { cookie: ws });
  assert.ok(!mine.body.reopen.some((x) => x.id === REQ), 'not in the queue of the person who asked');
  const theirs = await req('GET', '/api/reports/pending-approvals', { cookie: om });
  assert.ok(theirs.body.reopen.some((x) => x.id === REQ && x.job_no === J(P).job_no));
  assert.ok(theirs.body.total >= 1 && theirs.body.is_approver);
});

test('the requester cannot approve; a reopen is blocked while the vehicle\'s new card is open', async () => {
  const noCap = await req('POST', `/api/jobs/reopen-requests/${REQ}/approve`, { cookie: await as('tm') });
  assert.strictEqual(noCap.status, 403, 'approving needs jobs.reopen');
  const self = await req('POST', `/api/jobs/reopen-requests/${REQ}/approve`, { cookie: await as('ws') });
  assert.strictEqual(self.status, 403);
  assert.match(self.body.error, /somebody else/);
  const blocked = await req('POST', `/api/jobs/reopen-requests/${REQ}/approve`, { cookie: await as('om') });
  assert.strictEqual(blocked.status, 409, blocked.text);
  assert.match(blocked.body.error, new RegExp(`${J(NEWJOB).job_no.replace(/\//g, '\\/')} is open for this vehicle\\. Finish or close it first`));
  assert.strictEqual(blocked.body.blocking_job.id, NEWJOB);
  assert.strictEqual(get('SELECT status s FROM job_reopen_requests WHERE id = ?', REQ).s, 'pending', 'still waiting');
  assert.strictEqual(J(P).status, 'CLOSED');
});

test('approved once the new card is finished: back to work, in its original report month', async () => {
  run("UPDATE job_cards SET status = 'CLOSED', completed_at = datetime('now'), closed_at = datetime('now') WHERE id = ?", NEWJOB);
  const monthBefore = String(J(P).completed_at).slice(0, 7);
  const r = await req('POST', `/api/jobs/reopen-requests/${REQ}/approve`, { cookie: await as('om'), body: { note: 'ok' } });
  assert.strictEqual(r.status, 200, r.text);
  const j = J(P);
  assert.strictEqual(j.status, 'IN_PROGRESS');
  assert.strictEqual(j.completed_at, null);
  assert.strictEqual(String(j.original_completed_at).slice(0, 7), monthBefore, 'the anchor: the month it was first closed in');
  const reop = get('SELECT * FROM job_reopens WHERE job_id = ? ORDER BY id DESC LIMIT 1', P);
  assert.strictEqual(reop.prev_status, 'CLOSED');
  assert.match(reop.reason, /Gearbox noise came back \(request #\d+\)/);
  assert.deepStrictEqual(Object.values(get('SELECT status, decided_by FROM job_reopen_requests WHERE id = ?', REQ)), ['approved', U.om]);
  assert.ok(get("SELECT 1 x FROM audit_log WHERE entity = 'job_reopen_request' AND action = 'approve' AND entity_id = ?", REQ));
  assert.strictEqual((await req('POST', `/api/jobs/reopen-requests/${REQ}/approve`, { cookie: await as('boss') })).status, 409, 'decided once');
  // Closing it again puts it back in that month.
  const mc = await req('POST', `/api/jobs/${P}/transition`, { cookie: await as('ws'), body: { to: 'WORK_COMPLETE' } });
  assert.strictEqual(mc.status, 200, mc.text);
  assert.strictEqual(String(J(P).completed_at).slice(0, 7), monthBefore);
  // A reopened live card is held to the full check again — being closed once is no excuse now.
  const late = run("INSERT INTO job_parts (job_id, source_type, description, qty) VALUES (?, 'external', 'Late extra', 1)", P).lastInsertRowid;
  const refused = await req('POST', `/api/jobs/${P}/transition`, { cookie: await as('om'), body: { to: 'CLOSED' } });
  assert.strictEqual(refused.status, 409, refused.text);
  run('UPDATE job_parts SET unit_price = 10 WHERE id = ?', late);
  assert.strictEqual((await req('POST', `/api/jobs/${P}/transition`, { cookie: await as('om'), body: { to: 'CLOSED' } })).status, 200);
  assert.strictEqual(String(J(P).completed_at).slice(0, 7), monthBefore, 'and it closes into its original month');
});

test('a partly closed card is reopened the same way; a refusal needs a reason', async () => {
  const v = asset('RQ-2');
  const j = job(v, 'IN_PROGRESS');
  work(j); part(j, null);
  await req('POST', `/api/jobs/${j}/partial-close`, { cookie: await as('ws'), body: {} });
  const r1 = await req('POST', `/api/jobs/${j}/reopen-request`, { cookie: await as('ws'), body: { reason: 'wrong card' } });
  const noWhy = await req('POST', `/api/jobs/reopen-requests/${r1.body.id}/refuse`, { cookie: await as('om'), body: {} });
  assert.strictEqual(noWhy.status, 400);
  const refused = await req('POST', `/api/jobs/reopen-requests/${r1.body.id}/refuse`, { cookie: await as('om'), body: { note: 'Use the new card' } });
  assert.strictEqual(refused.status, 200);
  assert.strictEqual(J(j).status, 'PARTIALLY_CLOSED', 'nothing changed');
  const r2 = await req('POST', `/api/jobs/${j}/reopen-request`, { cookie: await as('mgr'), body: { reason: 'a part is missing after all' } });
  const ok = await req('POST', `/api/jobs/reopen-requests/${r2.body.id}/approve`, { cookie: await as('om') });
  assert.strictEqual(ok.status, 200, ok.text);
  const after = J(j);
  assert.deepStrictEqual([after.status, after.partial_closed_at, after.completed_at], ['IN_PROGRESS', null, null]);
  assert.strictEqual(String(after.original_completed_at).slice(0, 10), TODAY, 'its report month is the partial-close month');
  assert.strictEqual(get('SELECT prev_status p FROM job_reopens WHERE job_id = ?', j).p, 'PARTIALLY_CLOSED');
  assert.strictEqual(get('SELECT status s FROM assets WHERE id = ?', v).s, 'under_repair');
  // Partly closing it again keeps that month.
  const again = await req('POST', `/api/jobs/${j}/partial-close`, { cookie: await as('ws'), body: {} });
  assert.strictEqual(again.status, 200, again.text);
  assert.strictEqual(String(J(j).completed_at).slice(0, 10), String(after.original_completed_at).slice(0, 10));
});

test('labour cost is untouched by a partial close and a full close', () => {
  const v = asset('LC-1');
  const j = job(v, 'WORK_COMPLETE');
  work(j, day(-2), 4); part(j, null);
  costing.refreshJobTotals(j);
  const before = costing.computeJobCost(j).labour_cost;
  closeLib.partialClose(J(j), { user: { id: U.ws, roles: ['workshop'] } });
  assert.strictEqual(costing.computeJobCost(j).labour_cost, before);
  assert.strictEqual(before, 4 * 400);
});
