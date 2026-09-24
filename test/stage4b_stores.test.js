'use strict';

// Multi-site Stage 4, part B — a store per workshop (src/lib/stores.js).
//
//   A workshop has its own store or uses another's; the main one always has its own and holds
//   everything recorded until now. Every movement is stamped with the store it happened in (goods
//   received: the request's workshop's store; issues: the job's; a received line handed over: the
//   store that received it), read as at the movement's date. A transfer note between two stores
//   moves stock out of one and into the other on its date. Each store has its own balances, stock
//   take and reorder levels; head office sees every store and the total. Store staff see the job
//   cards and requests of the workshops their store serves. With one store nothing changes.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-s4b-'));
process.env.DB_PATH = path.join(TMP, 's4b.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const workshops = require('../src/lib/workshops');
const stores = require('../src/lib/stores');
const stock = require('../src/lib/stock');

migrate();
for (const n of ['admin', 'workshop', 'manager', 'storekeeper']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
const CW = workshops.defaultId();
const MTR = run("INSERT INTO workshops (code, name, place) VALUES ('MTR', 'Muthur Workshop', 'Muthur')").lastInsertRowid;
const KDY = run("INSERT INTO workshops (code, name, place) VALUES ('KDY', 'Kandy Workshop', 'Kandy')").lastInsertRowid;
const PW = 'ember-harbour-quarry';
function mkUser(username, roles, ws = CW) {
  const id = run('INSERT INTO users (username, password_hash, active, workshop_id) VALUES (?, ?, 1, ?)', username, auth.hashPassword(PW), ws).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const U = {
  boss: mkUser('boss', ['admin']), mgr: mkUser('mgr', ['manager']),
  skC: mkUser('skC', ['storekeeper']), skM: mkUser('skM', ['storekeeper'], MTR),
  wsM: mkUser('wsM', ['workshop'], MTR), wsK: mkUser('wsK', ['workshop'], KDY),
};
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const TODAY = day(0);
let seq = 0;
const asset = (code) => run('INSERT INTO assets (code, code_norm, status, in_register) VALUES (?, ?, ?, 1)', code, code.replace(/\W/g, ''), 'active').lastInsertRowid;
const job = (ws) => run(
  `INSERT INTO job_cards (job_no, asset_id, type, description, status, is_historical, requested_at, workshop_id)
   VALUES (?, ?, 'repair', 'fault', 'IN_PROGRESS', 0, ?, ?)`, `2026/9/R/${800 + (++seq)}`, asset('V-' + seq), day(-5), ws).lastInsertRowid;
// A request of a workshop, one line, received in full on `date`.
function receive(ws, description, qty, date = TODAY) {
  const m = run("INSERT INTO mrn (mrn_no, requested_by, approval_status, workshop_id) VALUES (?, 'someone', 'approved', ?)", 'S4B-' + (++seq), ws).lastInsertRowid;
  const l = run("INSERT INTO mrn_lines (mrn_id, description, qty, category) VALUES (?, ?, ?, 'General Items')", m, description, qty).lastInsertRowid;
  return run('INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, unit_price, delivery_date) VALUES (?, ?, ?, ?, ?, 100, ?)',
    'G-' + seq, m, l, description, qty, date).lastInsertRowid;
}
const J = { c: job(CW), m: job(MTR), k: job(KDY) };
const PAD = 'BRAKEPADSET';

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
const bal = (store) => stock.balanceOf('general', PAD, store);
const storeOfRow = (t, id) => get(`SELECT store_id FROM ${t} WHERE id = ?`, id).store_id;

// ================================================================== one store: as before
test('one store: the main workshop has it, everything is in it, and no screen shows a store', async () => {
  assert.strictEqual(stores.isMulti(), false);
  assert.deepStrictEqual(stores.list().map((s) => s.id), [CW]);
  assert.deepStrictEqual(stores.list()[0].serves.map((w) => w.id).sort(), [CW, MTR, KDY].sort(), 'every workshop uses Central\'s store');
  const g = receive(MTR, 'Brake Pad Set', 10);
  assert.strictEqual(storeOfRow('grn', g), CW, 'Muthur has no store of its own yet: its goods go into Central\'s');
  stock.rebuild({ wipe: true });
  const d = (await req('GET', '/api/stores/stock/general', { cookie: await as('skM') })).body;
  assert.strictEqual(d.multi, false);
  assert.strictEqual(d.store, null);
  assert.deepStrictEqual(d.stores, []);
  assert.strictEqual(d.items.find((i) => i.item_key === PAD).balance, 10);
  assert.strictEqual(d.items[0].by_store, undefined);
  assert.strictEqual(d.items[0].reorder_level, undefined);
  // The old whole-company stock take still works with one store.
  const si = run("INSERT INTO store_items (name, is_general, balance) VALUES ('Shop Rag', 1, 0)").lastInsertRowid;
  assert.strictEqual((await req('POST', `/api/general-stock/items/${si}/adjust`, { cookie: await as('skC'), body: { txn_type: 'adjustment', qty: 4 } })).status, 201);
  run('DELETE FROM grn WHERE id = ?', g);
  stock.rebuild({ wipe: true });
});

// ================================================================== the store of a workshop
test('opening a store: workshops.manage only; from today or earlier; the main store stays; a used store stays', async () => {
  const mgr = await as('mgr');
  assert.strictEqual((await req('PUT', `/api/workshops/${MTR}/store`, { cookie: mgr, body: { own: true } })).status, 403);
  const boss = await as('boss');
  assert.strictEqual((await req('PUT', `/api/workshops/${MTR}/store`, { cookie: boss, body: { own: true, opened: day(1) } })).status, 400);
  const r = await req('PUT', `/api/workshops/${MTR}/store`, { cookie: boss, body: { own: true } });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.own_store, 1);
  assert.strictEqual(r.body.store_opened, TODAY);
  assert.strictEqual(stores.isMulti(), true);
  // Kandy uses Muthur's store; then Muthur's cannot close, nor Muthur retire.
  assert.strictEqual((await req('PUT', `/api/workshops/${KDY}/store`, { cookie: boss, body: { uses: KDY } })).status, 400);
  const self = await req('PUT', `/api/workshops/${MTR}/store`, { cookie: boss, body: { uses: MTR } });
  assert.strictEqual(self.status, 400);
  assert.match(self.body.error, /its own store as another's/);
  assert.strictEqual((await req('PUT', `/api/workshops/${KDY}/store`, { cookie: boss, body: { uses: MTR } })).status, 200);
  const main = await req('PUT', `/api/workshops/${CW}/store`, { cookie: boss, body: { own: false } });
  assert.strictEqual(main.status, 409);
  assert.match(main.body.error, /main workshop and always has its own store/);
  assert.strictEqual(stores.storeOf(KDY), MTR);
  assert.deepStrictEqual(stores.servedBy(MTR), [MTR, KDY]);
  assert.deepStrictEqual(stores.servedBy(CW), [CW]);
  const close = await req('PUT', `/api/workshops/${MTR}/store`, { cookie: boss, body: { own: false } });
  assert.strictEqual(close.status, 409);
  assert.match(close.body.error, /Kandy Workshop still use/);
  // A store nobody has used can close again; one another workshop uses cannot go with its workshop.
  const actor = { id: U.boss };
  const spr = workshops.create(actor, { code: 'SPR', name: 'Spare Yard' });
  const tmp = workshops.create(actor, { code: 'TMP', name: 'Temp Yard' });
  stores.setStore(actor, spr.id, { own: true });
  stores.setStore(actor, tmp.id, { uses: spr.id });
  assert.throws(() => workshops.setActive(actor, spr.id, false), /Temp Yard still use Spare Yard's store/);
  stores.setStore(actor, tmp.id, { uses: null });
  assert.strictEqual(stores.setStore(actor, spr.id, { own: false }).own_store, 0);
  workshops.setActive(actor, spr.id, false);
  workshops.setActive(actor, tmp.id, false);
  const list = (await req('GET', '/api/workshops', { cookie: boss })).body;
  assert.strictEqual(list.stores_multi, true);
  assert.deepStrictEqual(list.stores.map((s) => s.code), ['CW', 'MTR']);
  assert.strictEqual(list.store_of[KDY], MTR);
});

// ================================================================== stamping
test('each movement is stamped with its store — as at its date', () => {
  const gM = receive(MTR, 'Brake Pad Set', 10);
  const gC = receive(CW, 'Brake Pad Set', 6);
  const gOld = receive(MTR, 'Brake Pad Set', 1, day(-3));
  const gK = receive(KDY, 'Brake Pad Set', 2);
  assert.strictEqual(storeOfRow('grn', gM), MTR, 'goods received go into the store of the request\'s workshop');
  assert.strictEqual(storeOfRow('grn', gC), CW);
  assert.strictEqual(storeOfRow('grn', gOld), CW, 'delivered before Muthur\'s store opened: Central\'s');
  assert.strictEqual(storeOfRow('grn', gK), MTR, 'Kandy uses Muthur\'s store');
  const iM = run("INSERT INTO issues (job_id, description, qty, issue_date) VALUES (?, 'Brake Pad Set', 3, ?)", J.m, TODAY).lastInsertRowid;
  const iRec = run("INSERT INTO issues (job_id, grn_id, description, qty, issue_date) VALUES (?, ?, 'Brake Pad Set', 1, ?)", J.m, gC, TODAY).lastInsertRowid;
  const iNone = run("INSERT INTO issues (description, qty, issue_date) VALUES ('Brake Pad Set', 1, ?)", TODAY).lastInsertRowid;
  assert.strictEqual(storeOfRow('issues', iM), MTR, 'an issue comes out of the job\'s workshop\'s store');
  assert.strictEqual(storeOfRow('issues', iRec), CW, 'a received line leaves the store that received it');
  assert.strictEqual(storeOfRow('issues', iNone), CW, 'nothing to go by: the main store');
  const pid = run("INSERT INTO products (code, name, unit) VALUES ('OIL-9001', 'Test Oil', 'L')").lastInsertRowid;
  const oil = run("INSERT INTO stock_ledger (product_id, kind, qty, balance_after, job_id, txn_date) VALUES (?, 'issue', -1, 0, ?, ?)", pid, J.k, TODAY).lastInsertRowid;
  assert.strictEqual(storeOfRow('stock_ledger', oil), MTR);
  const tb = run("INSERT INTO tyre_battery_issues (kind, issue_date, qty, job_id, row_hash) VALUES ('tyre', ?, 1, ?, 'h1')", TODAY, J.m).lastInsertRowid;
  assert.strictEqual(storeOfRow('tyre_battery_issues', tb), MTR);
  const jobNo = get('SELECT job_no FROM job_cards WHERE id = ?', J.m).job_no;
  const sv = run('INSERT INTO service_jobs (job_no, service_date) VALUES (?, ?)', jobNo, TODAY).lastInsertRowid;
  assert.strictEqual(storeOfRow('service_jobs', sv), MTR, 'a service with a job card: that card\'s workshop\'s store');
  const gt = run("INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, job_id, txn_date) VALUES ((SELECT id FROM store_items LIMIT 1), 'issue', -1, 0, ?, ?)", J.c, TODAY).lastInsertRowid;
  assert.strictEqual(storeOfRow('general_item_txns', gt), CW);
  for (const [t, id] of [['issues', iNone], ['stock_ledger', oil], ['tyre_battery_issues', tb], ['service_jobs', sv], ['general_item_txns', gt], ['issues', iRec]]) run(`DELETE FROM ${t} WHERE id = ?`, id);
  run('DELETE FROM grn WHERE id IN (?, ?)', gOld, gK);
  stock.rebuild({ wipe: true });
  // Left in: Muthur received 10 and issued 3; Central received 6.
  assert.strictEqual(bal(MTR), 7);
  assert.strictEqual(bal(CW), 6);
  assert.strictEqual(bal(null), 13);
});

test('an entry with no job card is in the store of whoever wrote it down', async () => {
  const pid = get("SELECT id FROM products WHERE code = 'OIL-9001'").id;
  const r = await req('POST', '/api/oil/ledger', { cookie: await as('skM'), body: { product_id: pid, kind: 'receipt', qty: 20 } });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(get('SELECT store_id FROM stock_ledger WHERE product_id = ? ORDER BY id DESC LIMIT 1', pid).store_id, MTR);
  const s = await req('POST', '/api/filters/services', { cookie: await as('skM'), body: { asset_id: asset('SV-1'), service_date: TODAY, filters: [], oils: [], parts: [] } });
  assert.strictEqual(s.status, 201, s.text);
  assert.strictEqual(get('SELECT store_id FROM service_jobs WHERE id = ?', s.body.service.id).store_id, MTR);
});

// ================================================================== balances per store
test('balances: one store, or all together with each store\'s share; the movements say which store', async () => {
  const mgr = await as('mgr');
  const one = (await req('GET', `/api/stores/stock/general?store_id=${MTR}`, { cookie: mgr })).body;
  assert.strictEqual(one.multi, true);
  assert.strictEqual(one.store.id, MTR);
  assert.deepStrictEqual(one.stores.map((s) => s.id), [CW, MTR]);
  assert.strictEqual(one.items.find((i) => i.item_key === PAD).balance, 7);
  assert.strictEqual(one.summary.balance, 7);
  const tot = (await req('GET', '/api/stores/stock/general?store_id=all', { cookie: mgr })).body;
  assert.strictEqual(tot.store, null);
  const pad = tot.items.find((i) => i.item_key === PAD);
  assert.strictEqual(pad.balance, 13);
  assert.deepStrictEqual(pad.by_store.map((b) => [b.store_code, b.balance]), [['CW', 6], ['MTR', 7]]);
  const mv = (await req('GET', `/api/stores/stock/general/moves?store_id=${CW}`, { cookie: mgr })).body;
  assert.ok(mv.length && mv.every((m) => m.store_id === CW && m.store_code === 'CW'));
  assert.strictEqual((await req('GET', '/api/stores/stock/general?store_id=999', { cookie: mgr })).status, 400);
});

// ================================================================== transfers
test('a transfer note between two stores moves stock on its date; to a site, or within one store, it stays paper', async () => {
  const skC = await as('skC');
  const r = await req('POST', '/api/stores/mtn', { cookie: skC, body: {
    txn_date: TODAY, from_place: `w:${CW}`, to_place: `w:${MTR}`, lines: [{ description: 'Brake Pad Set', qty: 2, category: 'General Items' }] } });
  assert.strictEqual(r.status, 201, r.text);
  const line = r.body.lines[0];
  assert.strictEqual(line.from_store_id, CW);
  assert.strictEqual(line.to_store_id, MTR);
  assert.strictEqual(bal(CW), 4, 'out of Central at once — no rebuild needed');
  assert.strictEqual(bal(MTR), 9);
  assert.strictEqual(bal(null), 13, 'the company holds what it held');
  const tot = stock.summary('general');
  assert.strictEqual(tot.received, 16, 'all stores: a transfer is not a receipt');
  assert.strictEqual(stock.summary('general', { store: MTR }).received, 12, 'in Muthur\'s store it is');
  assert.strictEqual((await req('GET', '/api/stores/mtn', { cookie: skC })).body.find((t) => t.id === r.body.id).moves_stock, 1);

  // Edit the quantity: the movements follow. Delete an item: they go.
  assert.strictEqual((await req('PATCH', `/api/stores/mtn/line/${line.id}`, { cookie: skC, body: { qty: 3 } })).status, 200);
  assert.strictEqual(bal(CW), 3);
  assert.strictEqual(bal(MTR), 10);
  const l2 = (await req('POST', `/api/stores/mtn/${r.body.id}/lines`, { cookie: skC, body: { description: 'Brake Pad Set', qty: 1, category: 'General Items' } })).body;
  assert.strictEqual(bal(CW), 2);
  assert.strictEqual((await req('DELETE', `/api/stores/mtn/line/${l2.id}`, { cookie: skC })).status, 200);
  assert.strictEqual(bal(CW), 3);
  stock.rebuild({ wipe: true });
  assert.deepStrictEqual([bal(CW), bal(MTR), bal(null)], [3, 10, 13], 'a full rebuild gives the same');

  // Paper only: to a site; between Muthur and Kandy (one store); dated before Muthur's store opened.
  const proj = run("INSERT INTO projects (name) VALUES ('Dam Site')").lastInsertRowid;
  for (const body of [
    { txn_date: TODAY, from_place: `w:${CW}`, to_place: `p:${proj}` },
    { txn_date: TODAY, from_place: `w:${MTR}`, to_place: `p:${proj}` },
    { txn_date: TODAY, from_place: `w:${MTR}`, to_place: `w:${KDY}` },
    { txn_date: day(-2), from_place: `w:${CW}`, to_place: `w:${MTR}` },
  ]) {
    const p = await req('POST', '/api/stores/mtn', { cookie: await as('boss'), body: { ...body, lines: [{ description: 'Brake Pad Set', qty: 1, category: 'General Items' }] } });
    assert.strictEqual(p.status, 201, p.text);
    assert.strictEqual(p.body.lines[0].from_store_id, null, JSON.stringify(body));
  }
  assert.deepStrictEqual([bal(CW), bal(MTR)], [3, 10]);
  // Moving the date of the old note into the store's time makes it move stock.
  const old = get("SELECT t.id FROM mtn t WHERE t.txn_date = ? ORDER BY t.id DESC LIMIT 1", day(-2)).id;
  assert.strictEqual((await req('PATCH', `/api/stores/mtn/${old}`, { cookie: await as('boss'), body: { txn_date: TODAY } })).status, 200);
  assert.deepStrictEqual([bal(CW), bal(MTR)], [2, 11]);
});

// ================================================================== stock take and levels
test('a stock take in one store: the difference goes in as a correction; a rebuild keeps it', async () => {
  const skM = await as('skM');
  assert.strictEqual((await req('POST', '/api/stores/stock/general/count', { cookie: skM, body: { store_id: MTR, item_key: PAD, counted: -1 } })).status, 400);
  assert.strictEqual((await req('POST', '/api/stores/stock/general/count', { cookie: skM, body: { store_id: MTR, item_key: 'NOPE', counted: 1 } })).status, 404);
  assert.strictEqual((await req('POST', '/api/stores/stock/general/count', { cookie: await as('wsM'), body: { store_id: MTR, item_key: PAD, counted: 1 } })).status, 403);
  const r = await req('POST', '/api/stores/stock/general/count', { cookie: skM, body: { store_id: MTR, item_key: PAD, counted: 8, note: 'shelf 3' } });
  assert.strictEqual(r.status, 201, r.text);
  // Stores plan, Part 2: the correction waits for head office (ST-D5, ST-D14).
  assert.deepStrictEqual([r.body.book, r.body.counted, r.body.delta, r.body.balance, r.body.status], [11, 8, -3, 11, 'submitted']);
  const ok = await req('POST', `/api/stores/counts/${r.body.session_id}/approve`, { cookie: await as('mgr') });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.strictEqual(bal(MTR), 8);
  assert.strictEqual(bal(CW), 2, 'the other store is untouched');
  stock.rebuild({ wipe: true });
  assert.strictEqual(bal(MTR), 8);
  const items = stock.items('general', null, 50, { store: MTR });
  // 10 received, 3 + 1 sent in from Central; the write-down of 3 is not a receipt.
  assert.strictEqual(items.find((i) => i.item_key === PAD).received, 14);
});

test('reorder levels are per store; "low" lists what is at or under its level, moved or not', async () => {
  const skM = await as('skM');
  assert.strictEqual((await req('PUT', '/api/stores/stock/general/level', { cookie: skM, body: { store_id: MTR, item_key: PAD, level: -2 } })).status, 400);
  assert.strictEqual((await req('PUT', '/api/stores/stock/general/level', { cookie: skM, body: { store_id: MTR, item_key: PAD, level: 10 } })).status, 200);
  run("INSERT INTO stock_items (code, section, name, item_key, source_table) VALUES ('GEN-0900', 'general', 'Wiper Blade', 'WIPERBLADE', 'store_items')");
  assert.strictEqual((await req('PUT', '/api/stores/stock/general/level', { cookie: skM, body: { store_id: MTR, item_key: 'WIPERBLADE', level: 2 } })).status, 200);
  const mgr = await as('mgr');
  const low = (await req('GET', `/api/stores/stock/general?store_id=${MTR}&low=1`, { cookie: mgr })).body.items;
  assert.deepStrictEqual(low.map((i) => [i.item_key, i.balance, i.reorder_level]).sort(), [[PAD, 8, 10], ['WIPERBLADE', 0, 2]]);
  const cw = (await req('GET', `/api/stores/stock/general?store_id=${CW}&low=1`, { cookie: mgr })).body.items;
  assert.deepStrictEqual(cw, [], 'Central keeps no levels');
  assert.strictEqual((await req('PUT', '/api/stores/stock/general/level', { cookie: skM, body: { store_id: MTR, item_key: 'WIPERBLADE', level: '' } })).status, 200);
  assert.deepStrictEqual((await req('GET', `/api/stores/stock/general?store_id=${MTR}&low=1`, { cookie: mgr })).body.items.map((i) => i.item_key), [PAD]);
});

// ================================================================== issuing
test('issuing off the shelf: the job\'s workshop\'s store — its balance, its warning', async () => {
  run("INSERT INTO stock_items (code, section, name, item_key, source_table) VALUES ('GEN-0901', 'general', 'Brake Pad Set', ?, 'store_items')", PAD);
  const item = get("SELECT id FROM stock_items WHERE code = 'GEN-0901'").id;
  const found = (await req('GET', `/api/stores/stock-items/search?section=general&q=GEN-0901&job_id=${J.m}`, { cookie: await as('skM') })).body;
  assert.strictEqual(found[0].balance, 8, 'the search shows the balance in the store the issue comes out of');
  const r = await req('POST', '/api/stores/stock-issue', { cookie: await as('skM'), body: { job_id: J.k, issue_date: TODAY, lines: [{ stock_item_id: item, qty: 9 }] } });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.body.issued[0].balance_before, 8);
  assert.strictEqual(r.body.issued[0].store, 'Muthur Workshop');
  assert.match(r.body.warnings.join(' '), /stock in Muthur Workshop is now -1/);
  assert.strictEqual(bal(MTR), -1);
  assert.strictEqual(bal(CW), 2);
  assert.strictEqual(get("SELECT store_id FROM stock_moves WHERE source_table = 'issues' ORDER BY id DESC LIMIT 1").store_id, MTR);
});

// ================================================================== the old whole-company counts
test('with several stores the old whole-company counts are refused; receipts still go in', async () => {
  const skC = await as('skC');
  const si = get("SELECT id FROM store_items WHERE name = 'Shop Rag'").id;
  const a = await req('POST', `/api/general-stock/items/${si}/adjust`, { cookie: skC, body: { txn_type: 'adjustment', qty: 4 } });
  assert.strictEqual(a.status, 409);
  assert.match(a.body.error, /store by store/);
  assert.strictEqual((await req('POST', `/api/general-stock/items/${si}/adjust`, { cookie: skC, body: { txn_type: 'receipt', qty: 4 } })).status, 201);
  assert.strictEqual((await req('POST', `/api/stores/items/${si}/txn`, { cookie: skC, body: { txn_type: 'opening', qty: 4 } })).status, 409);
  const pid = get("SELECT id FROM products WHERE code = 'OIL-9001'").id;
  assert.strictEqual((await req('POST', '/api/oil/ledger', { cookie: skC, body: { product_id: pid, kind: 'adjustment', qty: 4 } })).status, 409);
  assert.strictEqual((await req('POST', '/api/oil/counts', { cookie: skC, body: { product_id: pid, period: '2026-09', counted_qty: 3, post_adjustment: true } })).status, 409);
  assert.strictEqual((await req('POST', '/api/oil/counts', { cookie: skC, body: { product_id: pid, period: '2026-09', counted_qty: 3 } })).status, 201, 'a count kept as a record only is fine');
});

// ================================================================== separate workshops
test('workshops kept apart: store staff see the workshops their store serves, and their own store\'s stock', async () => {
  assert.strictEqual((await req('PUT', '/api/workshops/separate', { cookie: await as('boss'), body: { on: true } })).status, 200);
  const mk = (ws) => run("INSERT INTO mrn (mrn_no, requested_by, approval_status, workshop_id) VALUES (?, 'x', 'requested', ?)", 'SEP-' + (++seq), ws).lastInsertRowid;
  const M = { c: mk(CW), m: mk(MTR), k: mk(KDY) };
  const seen = async (u) => (await req('GET', '/api/stores/mrn', { cookie: await as(u) })).body.map((r) => r.id);
  const skM = await seen('skM');
  assert.ok(skM.includes(M.m) && skM.includes(M.k) && !skM.includes(M.c), 'Muthur\'s store serves Muthur and Kandy');
  const skC = await seen('skC');
  assert.ok(skC.includes(M.c) && !skC.includes(M.m) && !skC.includes(M.k), 'Central\'s store now serves Central only');
  const wsM = await seen('wsM');
  assert.ok(wsM.includes(M.m) && !wsM.includes(M.k), 'workshop staff: their own workshop only');
  assert.strictEqual((await req('GET', `/api/jobs/${J.k}`, { cookie: await as('skM') })).status, 200);
  assert.strictEqual((await req('GET', `/api/jobs/${J.k}`, { cookie: await as('skC') })).status, 403);
  const me = (await req('GET', '/api/auth/me', { cookie: await as('skM') })).body;
  assert.deepStrictEqual(me.workshopsSeen, [MTR, KDY]);
  assert.strictEqual(me.seesAllWorkshops, false);

  // Their stock screen is their own store, whatever they ask for.
  const d = (await req('GET', `/api/stores/stock/general?store_id=${CW}`, { cookie: await as('skM') })).body;
  assert.strictEqual(d.store.id, MTR);
  assert.strictEqual(d.fixed, true);
  assert.deepStrictEqual(d.stores, []);
  assert.deepStrictEqual([d.can.count, d.can.levels], [true, true]);
  // Only their own store's received goods to hand over.
  const rec = (await req('GET', '/api/stores/received?all=1', { cookie: await as('skM') })).body;
  assert.ok(rec.length && rec.every((l) => l.store_id === MTR));
  // Counting, setting levels and sending stock: only from their own store. Head office: any.
  assert.strictEqual((await req('POST', '/api/stores/stock/general/count', { cookie: await as('skM'), body: { store_id: CW, item_key: PAD, counted: 1 } })).status, 403);
  assert.strictEqual((await req('PUT', '/api/stores/stock/general/level', { cookie: await as('skM'), body: { store_id: CW, item_key: PAD, level: 1 } })).status, 403);
  const send = (u, from, to) => req('POST', '/api/stores/mtn', { cookie: u, body: {
    txn_date: TODAY, from_place: `w:${from}`, to_place: `w:${to}`, lines: [{ description: 'Brake Pad Set', qty: 1, category: 'General Items' }] } });
  const bad = await send(await as('skM'), CW, MTR);
  assert.strictEqual(bad.status, 403);
  assert.match(bad.body.error, /only from your own store \(Muthur Workshop\)/);
  assert.strictEqual(bal(CW), 2, 'nothing moved');
  const ok = await send(await as('skM'), MTR, CW);
  assert.strictEqual(ok.status, 201, ok.text);
  assert.strictEqual((await send(await as('boss'), CW, MTR)).status, 201, 'head office sends from any store');
  assert.deepStrictEqual([bal(CW), bal(MTR)], [2, -1]);
  // A Central note that moves stock cannot be edited from Muthur.
  const cNote = get('SELECT mtn_id FROM mtn_lines WHERE from_store_id = ? ORDER BY id DESC LIMIT 1', CW).mtn_id;
  assert.strictEqual((await req('PATCH', `/api/stores/mtn/${cNote}`, { cookie: await as('skM'), body: { reason: 'x' } })).status, 403);
  // Head office still sees every store and picks one.
  const h = (await req('GET', `/api/stores/stock/general?store_id=${CW}`, { cookie: await as('mgr') })).body;
  assert.strictEqual(h.store.id, CW);
  assert.strictEqual(h.fixed, false);
  assert.deepStrictEqual([h.can.count, h.can.levels], [true, true]);
});
