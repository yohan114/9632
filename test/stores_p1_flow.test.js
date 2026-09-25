'use strict';

// Stores plan, Part 1 — one list of every requested item, and the Monitor (src/lib/stores_flow.js).
//
//   Each line of a request walks Requested → Certified → Approved → Bought → Received → Priced →
//   Issued. The list shows how far each has come and filters by the step it waits at; the Monitor
//   counts what waits at each step. Imported history (no requester) is never a to-do. A store's own
//   restocking request is done once received. Each person sees their own workshops' requests.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-sp1-'));
process.env.DB_PATH = path.join(TMP, 'sp1.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');
const workshops = require('../src/lib/workshops');
const scope = require('../src/lib/scope');
const flow = require('../src/lib/stores_flow');

migrate();
for (const n of ['admin', 'workshop', 'manager', 'storekeeper']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
const CW = workshops.defaultId();
const MTR = run("INSERT INTO workshops (code, name) VALUES ('MTR', 'Muthur Workshop')").lastInsertRowid;
const PW = 'copper-lantern-gravel';
function mkUser(username, roles, ws = CW) {
  const id = run('INSERT INTO users (username, password_hash, active, workshop_id) VALUES (?, ?, 1, ?)', username, auth.hashPassword(PW), ws).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const U = { boss: mkUser('boss', ['admin']), mgr: mkUser('mgr', ['manager']), sk: mkUser('sk', ['storekeeper']),
  wsC: mkUser('wsC', ['workshop']), wsM: mkUser('wsM', ['workshop'], MTR) };
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const TODAY = day(0);
let seq = 0;
const asset = (code) => run('INSERT INTO assets (code, code_norm, registration, status, in_register) VALUES (?, ?, ?, ?, 1)', code, code.replace(/\W/g, ''), code, 'active').lastInsertRowid;
const job = (ws, a) => run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, is_historical, requested_at, workshop_id)
  VALUES (?, ?, 'repair', 'x', 'IN_PROGRESS', 0, ?, ?)`, `2026/9/R/${500 + (++seq)}`, a, TODAY, ws).lastInsertRowid;

// One request with one line. f: status (approval), by (requester; null = imported), type, ws, job, qty, category, tb.
function request(description, f = {}) {
  const m = run(`INSERT INTO mrn (mrn_no, req_date, requested_by, approval_status, request_type, workshop_id, job_id, asset_id, tb_kind, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  `P1-${++seq}`, f.date || day(-3), f.by === undefined ? 'Kasun' : f.by, f.status || 'approved', f.type || 'vehicle',
  f.ws || CW, f.job || null, f.asset || null, f.tb || null, f.mrnStatus || 'open').lastInsertRowid;
  const l = run('INSERT INTO mrn_lines (mrn_id, description, qty, category, purchased_at, supplier) VALUES (?, ?, ?, ?, ?, ?)',
    m, description, f.qty || 1, f.category || 'Spare Parts', f.bought ? day(-1) : null, f.bought ? 'Lanka Motors' : null).lastInsertRowid;
  return { m, l };
}
function receive(r, qty, price = 100) {
  run('UPDATE mrn_lines SET qty_received = COALESCE(qty_received,0) + ? WHERE id = ?', qty, r.l);
  return run('INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, unit_price, delivery_date, supplier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'G-' + (++seq), r.m, r.l, 'x', qty, price, TODAY, 'Lanka Motors').lastInsertRowid;
}
const issue = (grnId, jobId, qty) => run("INSERT INTO issues (issue_date, job_id, description, qty, grn_id) VALUES (?, ?, 'x', ?, ?)", TODAY, jobId, qty, grnId).lastInsertRowid;

const V = { a: asset('WP-1111'), b: asset('WP-2222') };
const JC = job(CW, V.a);
const JM = job(MTR, V.b);
const R = {
  requested: request('Clutch plate', { status: 'requested', job: JC, asset: V.a }),
  certified: request('Pressure plate', { status: 'certified', job: JC, asset: V.a }),
  toBuy: request('Water pump', { job: JC, asset: V.a }),
  bought: request('Alternator', { job: JC, asset: V.a, bought: true }),
  partUnpriced: request('Brake shoe', { job: JC, asset: V.a, qty: 3 }),
  done: request('Fan belt', { job: JC, asset: V.a, qty: 2 }),
  restock: request('Hose clamp', { type: 'general', qty: 10 }),
  rejected: request('Seat cover', { status: 'rejected', job: JC, asset: V.a }),
  cancelled: request('Mirror glass', { job: JC, asset: V.a, mrnStatus: 'cancelled' }),
  imported: request('Old gasket', { by: null, status: 'requested' }),
  oil: request('HD 68', { category: 'Lubricants', type: 'general', qty: 4 }),
  filter: request('Oil filter C-206', { category: 'Filters', job: JC, asset: V.a }),
  // A tyre request says so itself, whatever its category reads.
  tyre: request('Tyre 1000x20', { tb: 'tyre', category: 'Spare Parts', job: JC, asset: V.a, qty: 2 }),
  partIssued: request('Wiper blade', { job: JC, asset: V.a, qty: 3 }),
  muthur: request('Starter motor', { ws: MTR, job: JM, asset: V.b }),
};
receive(R.partUnpriced, 2, null);                               // 2 of 3 in, not priced
const gDone = receive(R.done, 2, 450);
issue(gDone, JC, 2);                                             // all handed over
receive(R.restock, 10, 20);                                      // restock: in, done
receive(R.oil, 4, 1500);
receive(R.tyre, 2, 30000);
run("INSERT INTO tyre_battery_issues (kind, issue_date, qty, mrn_line_id) VALUES ('tyre', ?, 1, ?)", TODAY, R.tyre.l);   // one of two fitted
receive(R.muthur, 1, 9000);
issue(receive(R.partIssued, 1, 300), JC, 1);                    // 1 of 3 in, and handed over
receive(R.imported, 1, null);                                    // imported history, never priced: not a to-do
// The part came before the paperwork: received, but the request still waits for its certification.
R.early = request('Radiator cap', { status: 'requested', job: JC, asset: V.a });
receive(R.early, 1, 700);

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
        resolve({ status: res.statusCode, body: json, text: buf, cookie: sc ? sc[0].split(';')[0] : null, type: res.headers['content-type'] });
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
const list = async (qs, user = 'mgr') => {
  const r = await req('GET', '/api/stores/flow' + (qs ? '?' + qs : ''), { cookie: await as(user) });
  assert.strictEqual(r.status, 200, r.text);
  return r.body;
};
const ids = (rows) => rows.map((r) => r.id).sort((a, b) => a - b);
const lineIds = (...rs) => rs.map((r) => r.l).sort((a, b) => a - b);

// ================================================================== the steps
test('each line waits at its step; the filters pick them; imported history is never a to-do', async () => {
  const at = async (step) => ids(await list('step=' + step));
  assert.deepStrictEqual(await at('requested'), lineIds(R.requested, R.early), 'arrived early, still to certify');
  assert.deepStrictEqual(await at('certified'), lineIds(R.certified));
  assert.deepStrictEqual(await at('to_buy'), lineIds(R.toBuy, R.filter));
  assert.deepStrictEqual(await at('on_order'), lineIds(R.bought, R.partUnpriced, R.partIssued));
  assert.deepStrictEqual(await at('unpriced'), lineIds(R.partUnpriced));
  assert.deepStrictEqual(await at('ready'), lineIds(R.partUnpriced, R.tyre, R.muthur, R.early));
  assert.deepStrictEqual(await at('done'), lineIds(R.done, R.restock, R.oil));
  assert.deepStrictEqual(await at('rejected'), lineIds(R.rejected, R.cancelled));
  assert.deepStrictEqual(await at('imported'), lineIds(R.imported));
  const open = await at('open');
  for (const r of [R.done, R.restock, R.oil, R.rejected, R.cancelled, R.imported]) assert.ok(!open.includes(r.l), 'not open: ' + r.l);
  assert.strictEqual(open.length, 10);
  assert.deepStrictEqual(ids(await list('')), open, 'the list opens on what is still to do');
  assert.strictEqual((await list('step=all')).length, Object.keys(R).length);
});

test('the road: how far each line has come, and what it has had', async () => {
  const one = async (r) => (await list('step=all')).find((x) => x.id === r.l);
  const road = (x) => Object.fromEntries(x.road.map((s) => [s.key, s.state]));
  let x = await one(R.partUnpriced);
  assert.deepStrictEqual([x.step, x.received, x.issued, x.on_shelf, x.unpriced, x.kind], ['ready', 2, 0, 2, 1, 'general']);
  assert.deepStrictEqual(road(x), { requested: 'done', approved: 'done', bought: 'done', received: 'part', priced: 'now', issued: 'now' });
  x = await one(R.restock);
  assert.strictEqual(x.road.find((s) => s.key === 'issued').label, 'To stock', 'a restocking request goes to the shelf');
  assert.deepStrictEqual([x.step, road(x).issued], ['done', 'done']);
  x = await one(R.tyre);
  assert.deepStrictEqual([x.kind, x.issued, x.on_shelf], ['tyre', 1, 1], 'a tyre fitted from the request counts as issued');
  x = await one(R.toBuy);
  assert.deepStrictEqual([x.step, road(x).approved, road(x).bought], ['to_buy', 'done', 'now']);
  x = await one(R.requested);
  assert.deepStrictEqual([x.step, road(x).approved], ['requested', 'now']);
  x = await one(R.early);
  assert.deepStrictEqual([x.step, road(x).approved, road(x).received, x.on_shelf], ['requested', 'now', 'done', 1], 'the road shows the missing signature');
  assert.strictEqual((await one(R.done)).value, 900);
  const step = async (r) => (await one(r)).step;
  assert.deepStrictEqual([await step(R.certified), await step(R.cancelled), await step(R.imported), await step(R.partIssued)],
    ['certified', 'rejected', 'imported', 'on_order']);
  x = await one(R.bought);
  assert.deepStrictEqual([x.step, road(x).bought, road(x).received], ['on_order', 'done', 'now'], 'bought: waiting to arrive');
  assert.strictEqual(road(await one(R.rejected)).approved, 'stop');
  assert.strictEqual(road(await one(R.imported)).approved, 'done', 'imported and received: it went ahead');
  x = await one(R.restock);
  assert.deepStrictEqual([x.on_shelf, x.shelf], [0, undefined], 'restock is handed over from stock, not from the request');
  // The buttons act on the receipt still on the shelf, and on the receipt awaiting its price.
  x = await one(R.partUnpriced);
  const g = get('SELECT id, grn_no FROM grn WHERE mrn_line_id = ?', R.partUnpriced.l);
  assert.deepStrictEqual([x.shelf.grn_id, x.shelf.grn_no, x.shelf.remaining], [g.id, g.grn_no, 2]);
  assert.deepStrictEqual([x.price_grn.id, x.price_grn.qty], [g.id, 2]);
  assert.strictEqual((await one(R.done)).price_grn, undefined);
  assert.strictEqual((await one(R.oil)).kind, 'oil');
  assert.strictEqual((await one(R.filter)).kind, 'filter');
});

test('receiving, handing over and bringing back move a line along', async () => {
  const sk = await as('sk');
  const step = async (r) => (await list('step=all')).find((x) => x.id === r.l).step;
  assert.strictEqual(await step(R.bought), 'on_order');
  const rx = await req('POST', '/api/stores/grn/bulk-receive', { cookie: sk, body: { rows: [{ mrn_line_id: R.bought.l, qty: 1 }] } });
  assert.strictEqual(rx.status, 200, rx.text);
  assert.strictEqual(await step(R.bought), 'ready', 'received for its job: to hand over');
  const g = get('SELECT id FROM grn WHERE mrn_line_id = ?', R.bought.l).id;
  const iss = issue(g, JC, 1);
  assert.strictEqual(await step(R.bought), 'unpriced', 'handed over, still awaiting its price');
  assert.ok(ids(await list('step=unpriced')).includes(R.bought.l));
  assert.ok(!ids(await list('step=done')).includes(R.bought.l), 'not done before it is priced');
  run('UPDATE grn SET unit_price = 8000 WHERE id = ?', g);
  assert.strictEqual(await step(R.bought), 'done');
  run("INSERT INTO issue_returns (issue_id, qty, return_date) VALUES (?, 1, ?)", iss, TODAY);
  assert.strictEqual(await step(R.bought), 'ready', 'brought back unused: on the shelf again');
});

test('the kind and the search narrow the list', async () => {
  assert.deepStrictEqual(ids(await list('step=all&kind=tyre')), lineIds(R.tyre));
  assert.deepStrictEqual(ids(await list('step=all&kind=oil')), lineIds(R.oil));
  assert.deepStrictEqual(ids(await list('step=all&q=WP-2222')), lineIds(R.muthur), 'by vehicle');
  assert.deepStrictEqual(ids(await list('step=all&q=Lanka')).length, 10, 'by supplier (bought from, or on a receipt)');
  const mrnNo = get('SELECT mrn_no FROM mrn WHERE id = ?', R.oil.m).mrn_no;
  assert.deepStrictEqual(ids(await list('step=all&q=' + mrnNo)), lineIds(R.oil), 'by request number');
  assert.deepStrictEqual(ids(await list('step=all&mrn_id=' + R.oil.m)), lineIds(R.oil), 'one request');
  assert.deepStrictEqual(ids(await list('step=all&job_id=' + JM)), lineIds(R.muthur), 'one job');
  assert.deepStrictEqual(ids(await list('step=all&workshop_id=' + MTR)), lineIds(R.muthur), 'one workshop');
});

test('each person sees their own workshops\' requests once the workshops are kept apart', async () => {
  scope.setSwitch({ id: U.boss }, true);
  const mine = ids(await list('step=all', 'wsM'));
  assert.deepStrictEqual(mine, lineIds(R.muthur));
  assert.ok(!ids(await list('step=all', 'wsC')).includes(R.muthur.l));
  assert.ok(ids(await list('step=all', 'mgr')).includes(R.muthur.l), 'head office: every workshop');
  assert.strictEqual((await req('GET', '/api/stores/flow/monitor', { cookie: await as('wsM') })).body.steps.ready, 1);
  // With a store in each workshop, store staff watch their own store's shelf; head office all.
  const monitorOf = async (u) => (await req('GET', '/api/stores/flow/monitor', { cookie: await as(u) })).body;
  assert.strictEqual((await monitorOf('wsM')).store, null, 'one store: nothing to pick');
  run('UPDATE workshops SET own_store = 1 WHERE id IN (?, ?)', CW, MTR);
  assert.strictEqual((await monitorOf('wsM')).store.id, MTR);
  assert.strictEqual((await monitorOf('mgr')).store, null);
  run('UPDATE workshops SET own_store = 0 WHERE id = ?', MTR);
  scope.setSwitch({ id: U.boss }, false);
});

test('the Monitor counts what waits at each step, the same way the list does', async () => {
  const m = (await req('GET', '/api/stores/flow/monitor', { cookie: await as('mgr') })).body;
  for (const s of ['requested', 'certified', 'to_buy', 'on_order', 'unpriced', 'ready', 'done', 'open']) {
    assert.strictEqual(m.steps[s], (await list('step=' + s)).length, s);
  }
  assert.strictEqual(m.steps.unpriced_receipts, 1);
  assert.deepStrictEqual([m.to_certify, m.to_approve], [2, 1], 'imported requests are not waiting for anyone');
  assert.strictEqual(m.issued_today, 4, 'three handed over and one tyre fitted today');
  assert.strictEqual(m.received_today, 10);
  // On the shelf: an item at or under the level its store reorders it at.
  run("INSERT INTO store_reorder (store_id, section, item_key, level) VALUES (?, 'general', 'HOSECLAMP', 50)", CW);
  require('../src/lib/stock').rebuild({ wipe: true });
  assert.strictEqual((await req('GET', '/api/stores/flow/monitor', { cookie: await as('mgr') })).body.low_stock, 1);
  const oilKey = get("SELECT item_key FROM stock_moves WHERE section = 'oil' LIMIT 1").item_key;
  run("INSERT INTO store_reorder (store_id, section, item_key, level) VALUES (?, 'oil', ?, 10)", CW, oilKey);
  assert.strictEqual((await req('GET', '/api/stores/flow/monitor', { cookie: await as('mgr') })).body.low_stock, 2, 'every kind of stock');
  // Batteries whose warranty ends within 60 days.
  run('INSERT INTO batteries (serial_no, warranty_date, state) VALUES (?, ?, ?)', 'BAT-1', day(20), 'installed');
  assert.strictEqual((await req('GET', '/api/stores/flow/monitor', { cookie: await as('mgr') })).body.battery_warranty, 1);
});

test('the list downloads as a spreadsheet; the Monitor and list need a session', async () => {
  const x = await req('GET', '/api/stores/flow/export.xlsx?step=all', { cookie: await as('sk') });
  assert.strictEqual(x.status, 200);
  assert.match(x.type, /spreadsheetml/);
  assert.strictEqual((await req('GET', '/api/stores/flow')).status, 401);
  assert.deepStrictEqual(flow.STEPS.includes('open'), true);
});

test('"Mark received" (one line or many) keeps the tyre and battery permission', async () => {
  run("INSERT OR IGNORE INTO roles (name, label) VALUES ('rxclerk', 'Receiving clerk')");
  require('../src/lib/permissions').setPermission('rxclerk', 'stores', 'edit');
  require('../src/lib/permissions').setPermission('rxclerk', 'tb_grn', 'view');
  require('../src/lib/capabilities').setCapability('rxclerk', 'stores.grn.receive', true);
  mkUser('clerk', ['rxclerk']);
  const tyre = request('Tyre 1200x24', { tb: 'tyre', category: 'Tyres', job: JC, asset: V.a, qty: 1 });
  const bolt = request('Wheel bolt', { job: JC, asset: V.a, qty: 4 });
  const r = await req('POST', '/api/stores/grn/bulk-receive', { cookie: await as('clerk'), body: { rows: [
    { mrn_line_id: tyre.l, qty: 1 }, { mrn_line_id: bolt.l, qty: 4 }] } });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.received, 1, 'the bolts come in');
  assert.deepStrictEqual(r.body.skipped.map((x) => x.mrn_line_id), [tyre.l], 'the tyre does not');
  assert.match(r.body.skipped[0].reason, /tyres or batteries/);
  assert.strictEqual(get('SELECT qty_received FROM mrn_lines WHERE id = ?', tyre.l).qty_received, 0);
  const over = await req('POST', '/api/stores/grn/bulk-receive', { cookie: await as('sk'), body: { rows: [{ mrn_line_id: bolt.l, qty: 1 }] } });
  assert.match(over.body.skipped[0].reason, /exceed/, 'never more than was asked for');
});
