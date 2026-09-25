'use strict';

// Job cards plan, Part 3 — Finishing and Ready to close (src/lib/jobs_flow.js).
//
//   A card whose work is done (WORK_COMPLETE, or PARTIALLY_CLOSED: the vehicle has gone, prices are
//   still coming) is FINISHING while the close check finds something missing, and the list shows what,
//   in groups. The check is the Close button's own, so the list and the button agree. When the last
//   thing is added the card is READY TO CLOSE by itself, with its final cost — but nothing closes by
//   itself (JC-D7): a person closes it, one card or several at once, within their approval limit (JC-D8).
//   Imported history and holder cards are left out (JC-D10).

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-jp3-'));
process.env.DB_PATH = path.join(TMP, 'jp3.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const workshops = require('../src/lib/workshops');
const scope = require('../src/lib/scope');
const flow = require('../src/lib/jobs_flow');
const costing = require('../src/lib/costing');
const closeLib = require('../src/lib/job_close');
const perms = require('../src/lib/permissions');

migrate();
for (const n of ['admin', 'workshop', 'manager', 'storekeeper', 'operational_manager', 'transport_manager', 'assistant_transport_manager']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
require('../src/lib/capabilities').seedCapabilities();
perms.seedDefaults();
run("INSERT INTO roles (name, label) VALUES ('jronly', 'Requests only')");
perms.setPermission('jronly', 'jobrequests', 'view');
perms.setPermission('jronly', 'jobs', 'none');

const CW = workshops.defaultId();
const MTR = run("INSERT INTO workshops (code, name) VALUES ('MTR', 'Muthur Workshop')").lastInsertRowid;
const PW = 'copper-lantern-gravel';
function mkUser(username, roles, ws = CW, fullName = null) {
  const id = run('INSERT INTO users (username, password_hash, active, workshop_id, full_name) VALUES (?, ?, 1, ?, ?)',
    username, auth.hashPassword(PW), ws, fullName).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const U = { boss: mkUser('boss', ['admin']), ws: mkUser('ws', ['workshop'], CW, 'Kamal Supervisor'), wsM: mkUser('wsM', ['workshop'], MTR),
  om: mkUser('om', ['operational_manager']), tm: mkUser('tm', ['transport_manager']), jr: mkUser('jr', ['jronly']) };
const BOSS = { id: U.boss, roles: ['admin'] };

const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const cal = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const YM = `${new Date().getFullYear()}/${new Date().getMonth() + 1}`;

closeLib.setEnabled(true); // the recommended way to run (JC-D9)
run("INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Anura', 400, '2020-01-01'), ('Sunil', 300, '2020-01-01')");

let seq = 0;
const asset = (code) => run('INSERT INTO assets (code, code_norm, status, in_register) VALUES (?, ?, ?, 1)', code, code.replace(/\W/g, ''), 'active').lastInsertRowid;
function card(desc, { status = 'WORK_COMPLETE', ws = CW, done = cal(1), type = 'repair', historical = 0, legacy = null, noAsset = false,
  partial = null, partlyBy = null, note = null, flat = null } = {}) {
  const no = `${YM}/${type === 'service' ? 'S' : 'R'}/${++seq}`;
  return run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at, approved_ops_at, completed_at, workshop_id,
                                     is_historical, legacy_ref, partial_closed_at, partial_closed_by, partial_note, flat_labour)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, no, noAsset ? null : asset('V-' + seq), type, desc, status, cal(40), cal(39),
  done, ws, historical, legacy, partial ? partial + ' 10:00:00' : null, partlyBy, note, flat).lastInsertRowid;
}
const work = (job, mechanic, hours, date = cal(12)) => run('INSERT INTO job_daily_work (job_id, work_date, mechanic, hours) VALUES (?, ?, ?, ?)', job, date, mechanic, hours);
const part = (job, desc, qty, price, { outside = false } = {}) => run(
  'INSERT INTO job_parts (job_id, source_type, description, qty, unit_price, is_external_repair) VALUES (?, ?, ?, ?, ?, ?)',
  job, outside ? 'external' : 'issue', desc, qty, price, outside ? 1 : 0).lastInsertRowid;
const no = (id) => get('SELECT job_no FROM job_cards WHERE id = ?', id).job_no;

// ---- ready to close: nothing missing ----------------------------------------------------------------
const R1 = card('Ready: repair with an outside job', { done: cal(5) });
work(R1, 'Anura', 4); work(R1, 'Sunil', 2); part(R1, 'Brake shoe', 2, 500); part(R1, 'Outside welding', 1, 3000, { outside: true });
const R2 = card('Ready: service, partly closed', { type: 'service', status: 'PARTIALLY_CLOSED', done: cal(3), partial: cal(3), partlyBy: U.om,
  note: 'Vehicle left, bill to come', flat: 2500 });
part(R2, 'Wiper blade', 1, 800);
const R3 = card('Ready: a costly repair', { done: cal(4) }); work(R3, 'Anura', 10); part(R3, 'Gearbox', 1, 20000);
const RM = card('Ready: Muthur field job', { ws: MTR, done: cal(6) }); work(RM, 'Anura', 1);
run('UPDATE job_cards SET field = 1, field_km = 10, field_km_rate = 50 WHERE id = ?', RM);                 // Rs 500 of transport

// ---- finishing: something missing -------------------------------------------------------------------
const F1 = card('Brake pad price missing', { done: cal(10) }); work(F1, 'Anura', 2);
const PAD = part(F1, 'Brake pad', 1, null);
const F2 = card('Many things missing', { status: 'PARTIALLY_CLOSED', done: cal(25), partial: cal(20), partlyBy: U.ws, note: 'Waiting for the supplier bill' });
work(F2, 'Kamal', 3, cal(22)); work(F2, 'Kamal', 2, cal(21));                                        // no rate for Kamal, on two lines
run("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours, is_external, external_value) VALUES (?, ?, 'Lanka Engineering', 0, 1, NULL)", F2, cal(21));
const M2 = run(`INSERT INTO mrn (mrn_no, req_date, requested_by, approval_status, job_id, workshop_id) VALUES ('MRN-F2', ?, 'Kamal', 'approved', ?, ?)`, cal(25), F2, CW).lastInsertRowid;
run("INSERT INTO mrn_lines (mrn_id, description, qty, qty_received) VALUES (?, 'Clutch plate', 1, 0)", M2);
const L2 = run("INSERT INTO mrn_lines (mrn_id, description, qty, qty_received) VALUES (?, 'Oil seal', 1, 1)", M2).lastInsertRowid;
run("INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, unit_price) VALUES ('G-1', ?, ?, 'Oil seal', 1, 300)", M2, L2);
const PROD = run("INSERT INTO products (name, unit, unit_price) VALUES ('Mystery oil', 'L', NULL)").lastInsertRowid;
run("INSERT INTO stock_ledger (product_id, kind, qty, balance_after, job_id, txn_date) VALUES (?, 'issue', -4, 0, ?, ?)", PROD, F2, cal(21));
const ITEM = run("INSERT INTO store_items (name, is_general) VALUES ('Rags', 1)").lastInsertRowid;
run("INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, job_id, txn_date) VALUES (?, 'issue', 1, 0, ?, ?)", ITEM, F2, cal(21));
const F3 = card('No work recorded', { done: cal(2) });
const F4 = card('Service charge not set', { type: 'service', done: cal(1) });
// A card closed once and reopened: with partial close switched off the button lets it through.
const RO = card('Reopened, a price missing', { done: cal(7) }); work(RO, 'Anura', 1); part(RO, 'Hose', 1, null);
run("INSERT INTO job_reopens (job_id, reopened_at, reopened_by, reason) VALUES (?, ?, ?, 'Wrong bill')", RO, cal(8), U.boss);

// ---- never in these lists ---------------------------------------------------------------------------
card('Still in progress', { status: 'IN_PROGRESS' });
card('Closed already', { status: 'CLOSED' });
card('Imported, work done', { historical: 1 });
card('Stores materials holder', { noAsset: true, legacy: 'general-workshop' });

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
        resolve({ status: res.statusCode, body: json, text: buf });
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
const finishing = async (user, qs = '') => ok(await call(user, 'GET', '/job-flow/finishing' + qs));
const ready = async (user, qs = '') => ok(await call(user, 'GET', '/job-flow/ready' + qs));
const byId = (rows, id) => rows.find((r) => r.id === id);
const ids = (rows) => rows.map((r) => r.id);

// ================================================================== the close check, in groups
test('the close check says what is missing, and now also of which kind; the words are unchanged', () => {
  const r = costing.closureReadiness(F2);
  assert.strictEqual(r.ready, false);
  assert.deepStrictEqual(r.missing, r.items.map((i) => i.text), 'the same things, in the same order');
  assert.deepStrictEqual(r.items.map((i) => i.kind), ['received', 'shelf', 'oil_price', 'general_price', 'labour_rate', 'labour_rate', 'outside_value']);
  assert.deepStrictEqual(r.missing, [
    'MRN MRN-F2: "Clutch plate" received 0/1 — awaiting GRN',
    'Store shelf item "Oil seal" (1 unissued from MRN MRN-F2)',
    `Oil issue (product #${PROD}) awaiting price`,
    `General item issue #${get('SELECT id FROM general_item_txns WHERE job_id = ?', F2).id} awaiting price`,
    'Labour rate missing for mechanic "Kamal"', 'Labour rate missing for mechanic "Kamal"',
    `External repair on ${cal(21)} awaiting value`,
  ]);
  assert.deepStrictEqual(costing.closureReadiness(F1).items, [{ kind: 'part_price', text: 'Part "Brake pad" awaiting price' }]);
  assert.deepStrictEqual(costing.closureReadiness(F3).items, [{ kind: 'no_work', text: 'No work done recorded — add the daily work' }]);
  assert.deepStrictEqual(costing.closureReadiness(F4).items, [{ kind: 'service_labour', text: 'Service labour (flat charge) not set' }]);
  assert.deepStrictEqual(costing.closureReadiness(R1), { ready: true, missing: [], items: [] });
  assert.deepStrictEqual(costing.MISSING_KINDS, Object.keys(flow.MISSING), 'every kind the check gives has a group');
});

// ================================================================== Finishing
test('Finishing: work done and something missing, the longest waiting first', async () => {
  const d = await finishing('boss');
  assert.deepStrictEqual(ids(d.rows), [F2, F1, RO, F3, F4]);
  assert.deepStrictEqual(d.counts, { all: 5, work_done: 4, partly_closed: 1, ready: 4, received: 1, shelf: 1, part_price: 2, oil_price: 1,
    general_price: 1, service_labour: 1, labour_rate: 1, outside_value: 1, no_work: 1 });
  const f2 = byId(d.rows, F2);
  assert.deepStrictEqual([f2.job_no, f2.status, f2.since, f2.days, f2.partly_by, f2.note, f2.ready, f2.link],
    [no(F2), 'PARTIALLY_CLOSED', cal(20), 20, 'Kamal Supervisor', 'Waiting for the supplier bill', false, '#/jobs/' + F2]);
  assert.deepStrictEqual(f2.missing.groups.map((g) => [g.kind, g.label, g.n]), [
    ['received', 'Parts not received', 1], ['shelf', 'Parts not handed over', 1], ['oil_price', 'Oil prices', 1],
    ['general_price', 'Item prices', 1], ['labour_rate', 'Labour rates', 1], ['outside_value', 'Outside repair value', 1]]);
  assert.deepStrictEqual(f2.missing.groups.find((g) => g.kind === 'labour_rate').items, ['Labour rate missing for mechanic "Kamal"'],
    'the same mechanic on two lines is said once');
  assert.strictEqual(f2.missing.total, 6);
  const f1 = byId(d.rows, F1);
  assert.deepStrictEqual([f1.status, f1.since, f1.days, f1.partly_by, f1.note], ['WORK_COMPLETE', cal(10), 10, null, null], 'work done: since the work was done');
  assert.deepStrictEqual(f1.road.slice(4).map((s) => s.state), ['done', 'now', 'todo'], 'waiting for prices');
});

test('Finishing: the filters', async () => {
  assert.deepStrictEqual(ids((await finishing('boss', '?show=partly_closed')).rows), [F2]);
  assert.deepStrictEqual(ids((await finishing('boss', '?show=work_done')).rows), [F1, RO, F3, F4]);
  assert.deepStrictEqual(ids((await finishing('boss', '?show=part_price')).rows), [F1, RO]);
  assert.deepStrictEqual(ids((await finishing('boss', '?show=labour_rate')).rows), [F2]);
  assert.deepStrictEqual(ids((await finishing('boss', '?show=no_work')).rows), [F3]);
  assert.deepStrictEqual(ids((await finishing('boss', '?type=service')).rows), [F4]);
  assert.deepStrictEqual(ids((await finishing('boss', '?q=' + encodeURIComponent(no(F3)))).rows), [F3]);
  const d = await finishing('boss', '?show=nonsense&q=Brake');
  assert.deepStrictEqual(ids(d.rows), [F1], 'an unknown filter shows all; the search still narrows');
  assert.strictEqual(d.counts.all, 5, 'the counts are over every card, not the search');
});

// ================================================================== Ready to close
test('Ready to close: nothing missing, each with its final cost', async () => {
  const d = await ready('boss');
  assert.deepStrictEqual(ids(d.rows), [RM, R1, R3, R2], 'the longest waiting first');
  assert.deepStrictEqual(byId(d.rows, R1).cost, { labour: 2200, parts: 1000, outside: 3000, oil: 0, general: 0, other: 0, total: 6200 },
    'the outside repair apart from the parts');
  assert.deepStrictEqual(byId(d.rows, R2).cost, { labour: 2500, parts: 800, outside: 0, oil: 0, general: 0, other: 0, total: 3300 });
  assert.deepStrictEqual(byId(d.rows, RM).cost, { labour: 400, parts: 0, outside: 0, oil: 0, general: 0, other: 500, total: 900 },
    'the field transport is "other"');
  for (const r of d.rows) {
    const c = r.cost;
    assert.strictEqual(Math.round((c.labour + c.parts + c.outside + c.oil + c.general + c.other) * 100) / 100, c.total, `${r.job_no} adds up`);
    assert.strictEqual(c.total, costing.reconciledCost(r.id).total_cost, `${r.job_no}: the total the card and the close use`);
    assert.deepStrictEqual([r.ready, r.missing.total, r.can.close, r.over_limit], [true, 0, true, null]);
    assert.deepStrictEqual(r.road.slice(5).map((s) => s.state), ['done', 'now'], 'prices in; waiting to be closed');
  }
  assert.strictEqual(d.total, 6200 + 3300 + 24000 + 900);
  const r2 = byId(d.rows, R2);
  assert.deepStrictEqual([r2.status, r2.since, r2.partly_by, r2.note], ['PARTIALLY_CLOSED', cal(3), 'om', 'Vehicle left, bill to come'],
    'no full name on file: the user name');
  assert.deepStrictEqual(ids((await ready('boss', '?type=service')).rows), [R2]);
  assert.deepStrictEqual(ids((await ready('boss', '?q=costly')).rows), [R3]);
  assert.deepStrictEqual(ids((await ready('boss', '?workshop_id=' + MTR)).rows), [RM]);
});

// ================================================================== Monitor, Dashboard, who may look
test('the Monitor and the Dashboard count the same cards', async () => {
  const m = ok(await call('boss', 'GET', '/job-flow/monitor'));
  assert.deepStrictEqual(m.finishing, { work_done: 4, partly_closed: 1, ready: 4 });
  assert.strictEqual(ok(await call('boss', 'GET', '/reports/dashboard')).ready_to_close, 4);
  assert.strictEqual(ok(await call('jr', 'GET', '/reports/dashboard')).ready_to_close, null, 'no job cards, no count');
  assert.strictEqual((await call('jr', 'GET', '/job-flow/finishing')).status, 403);
  assert.strictEqual((await call('jr', 'GET', '/job-flow/ready')).status, 403);
  assert.strictEqual(flow.readyCount(BOSS), 4);
});

test('with the workshops kept apart, each sees its own', async () => {
  scope.setSwitch({ id: U.boss }, true);
  try {
    assert.deepStrictEqual(ids((await ready('wsM')).rows), [RM]);
    assert.deepStrictEqual((await finishing('wsM')).rows, []);
    assert.deepStrictEqual(ids((await ready('ws')).rows), [R1, R3, R2]);
    assert.deepStrictEqual(ok(await call('ws', 'GET', '/job-flow/monitor')).finishing, { work_done: 4, partly_closed: 1, ready: 3 });
    assert.strictEqual(ok(await call('wsM', 'GET', '/reports/dashboard')).ready_to_close, 1);
    assert.deepStrictEqual(ids((await ready('boss')).rows), [RM, R1, R3, R2], 'head office: all');
  } finally { scope.setSwitch({ id: U.boss }, false); }
});

test('partial close switched off: the check is the old one, and the list follows the button', async () => {
  closeLib.setEnabled(false);
  try {
    // "No work recorded" is not asked for; a card closed once already cleared the check.
    assert.deepStrictEqual(ids((await finishing('boss')).rows), [F2, F1, F4]);
    assert.deepStrictEqual(ids((await ready('boss')).rows), [RO, RM, R1, R3, R2, F3]);
    assert.strictEqual(closeLib.closeGate(get('SELECT * FROM job_cards WHERE id = ?', RO)), null, 'the button agrees');
    assert.strictEqual(byId((await ready('boss')).rows, RO).missing.total, 1, 'still says what was missing');
  } finally { closeLib.setEnabled(true); }
  assert.deepStrictEqual(ids((await finishing('boss')).rows), [F2, F1, RO, F3, F4]);
});

// ================================================================== the move, by itself
test('when the last price is added the card moves to Ready to close by itself — and stays open', async () => {
  ok(await call('ws', 'PATCH', `/jobs/${F1}/parts/${PAD}`, { unit_price: 750 }));
  assert.ok(!ids((await finishing('boss')).rows).includes(F1), 'gone from Finishing');
  const r = byId((await ready('boss')).rows, F1);
  assert.deepStrictEqual(r.cost, { labour: 800, parts: 750, outside: 0, oil: 0, general: 0, other: 0, total: 1550 });
  assert.strictEqual(get('SELECT status FROM job_cards WHERE id = ?', F1).status, 'WORK_COMPLETE', 'nothing closes by itself');
  assert.deepStrictEqual(ok(await call('boss', 'GET', '/job-flow/monitor')).finishing, { work_done: 3, partly_closed: 1, ready: 5 });
});

// ================================================================== who may close, and how much
test('only those who may close see the Close button, within their approval limit', async () => {
  require('../src/lib/approval_limits').setLimit(BOSS, 'operational_manager', 'job_close', 10000);
  try {
    const om = await ready('om');
    assert.deepStrictEqual([byId(om.rows, R1).can.close, byId(om.rows, R1).over_limit], [true, null]);
    assert.deepStrictEqual([byId(om.rows, R3).can.close, byId(om.rows, R3).over_limit], [false, { limit: 10000 }], 'Rs 24,000 is over Rs 10,000');
    const tm = await ready('tm');
    assert.ok(tm.rows.length && tm.rows.every((r) => r.can.close === false && r.over_limit === null), 'no "Close a job card" permission');
    // The close route says the same.
    const res = ok(await call('om', 'POST', '/jobs/bulk-transition', { ids: [R3], to: 'CLOSED' }));
    assert.deepStrictEqual([res.success_count, res.failed[0].over_limit], [0, true]);
  } finally {
    require('../src/lib/approval_limits').setLimit(BOSS, 'operational_manager', 'job_close', null);
  }
});

test('close several at once: the ready ones close with their cost fixed; the others say why not', async () => {
  const before = get('SELECT completed_at FROM job_cards WHERE id = ?', R2).completed_at;
  const res = ok(await call('om', 'POST', '/jobs/bulk-transition', { ids: [R1, R2, F3], to: 'CLOSED' }));
  assert.deepStrictEqual(res.succeeded.map((s) => s.id).sort(), [R1, R2].sort());
  assert.deepStrictEqual([res.failed[0].id, res.failed[0].missing], [F3, ['No work done recorded — add the daily work']]);
  for (const id of [R1, R2]) {
    assert.strictEqual(get('SELECT status FROM job_cards WHERE id = ?', id).status, 'CLOSED');
    assert.ok(get('SELECT 1 x FROM job_costs WHERE job_id = ?', id), 'the final cost is kept');
  }
  assert.strictEqual(get('SELECT total_cost FROM job_cards WHERE id = ?', R1).total_cost, 6200);
  assert.strictEqual(get('SELECT completed_at FROM job_cards WHERE id = ?', R2).completed_at, before, 'a partly closed card keeps its report month');
  const d = await ready('boss');
  assert.deepStrictEqual(ids(d.rows), [F1, RM, R3]);
  assert.strictEqual(d.total, 900 + 24000 + 1550);
  // One card on its own.
  ok(await call('boss', 'POST', `/jobs/${RM}/transition`, { to: 'CLOSED' }));
  assert.deepStrictEqual(ids((await ready('boss')).rows), [F1, R3]);
});

// ================================================================== the list and the button agree
test('every card still in Finishing is refused by the Close button, for the things the list shows', async () => {
  const d = await finishing('boss');
  assert.deepStrictEqual(ids(d.rows), [F2, RO, F3, F4]);
  for (const r of d.rows) {
    const res = await call('boss', 'POST', `/jobs/${r.id}/transition`, { to: 'CLOSED' });
    assert.strictEqual(res.status, 409, `${r.job_no}: ${res.text}`);
    assert.deepStrictEqual([...new Set(res.body.missing)], r.missing.groups.flatMap((g) => g.items), `${r.job_no}: the same things`);
  }
  for (const r of (await ready('boss')).rows) assert.strictEqual(closeLib.closeGate(get('SELECT * FROM job_cards WHERE id = ?', r.id)), null, `${r.job_no} may close`);
});
