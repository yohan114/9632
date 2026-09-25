'use strict';

// Stores plan, Part 2 — stock take as count sessions (src/lib/stock_count.js) and the Stock view.
//
//   A store counts one kind of stock, or all. The book figure is kept from the start (ST-D4) and
//   from the moment each item is counted; the difference is taken against the second, so what
//   moved during the count is not counted twice. Nothing changes in stock until head office
//   approves (ST-D5). Lubricants count in litres: drums × size + the dip (ST-D16). A quick count of
//   one item waits for head office too, unless head office made it (ST-D14).

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-sp2-'));
process.env.DB_PATH = path.join(TMP, 'sp2.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const workshops = require('../src/lib/workshops');
const scope = require('../src/lib/scope');
const stock = require('../src/lib/stock');

migrate();
for (const n of ['admin', 'workshop', 'manager', 'storekeeper', 'operational_manager']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
require('../src/lib/capabilities').seedCapabilities();
require('../src/lib/permissions').setPermission('operational_manager', 'stores', 'view');
const CW = workshops.defaultId();
const MTR = run("INSERT INTO workshops (code, name) VALUES ('MTR', 'Muthur Workshop')").lastInsertRowid;
const PW = 'copper-lantern-gravel';
function mkUser(username, roles, ws = CW) {
  const id = run('INSERT INTO users (username, password_hash, active, workshop_id) VALUES (?, ?, 1, ?)', username, auth.hashPassword(PW), ws).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const U = { boss: mkUser('boss', ['admin']), mgr: mkUser('mgr', ['manager']), om: mkUser('om', ['operational_manager']),
  sk: mkUser('sk', ['storekeeper']), skM: mkUser('skM', ['storekeeper'], MTR), ws: mkUser('ws', ['workshop']) };
// A store supervisor given the right to approve counts — but not head office.
run("INSERT INTO roles (name, label) VALUES ('storelead', 'Store supervisor')");
require('../src/lib/permissions').setPermission('storelead', 'stores', 'edit');
require('../src/lib/capabilities').setCapability('storelead', 'stores.count.approve', true);
mkUser('lead', ['storelead'], MTR);
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const TODAY = day(0);
let seq = 0;

// Stock on the shelf of a store: a receipt (GRN) of `qty` at `price`.
function receive(desc, category, qty, price, store = CW, on = day(-8)) {
  const m = run("INSERT INTO mrn (mrn_no, req_date, requested_by, approval_status, workshop_id) VALUES (?, ?, 'Kasun', 'approved', ?)", `C-${++seq}`, day(-30), store).lastInsertRowid;
  const l = run('INSERT INTO mrn_lines (mrn_id, description, qty, category, qty_received) VALUES (?, ?, ?, ?, ?)', m, desc, qty, category, qty).lastInsertRowid;
  return run('INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, unit_price, delivery_date, store_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'G-' + (++seq), m, l, desc, qty, price, on, store).lastInsertRowid;
}
const issue = (grnId, qty, store = CW) => run("INSERT INTO issues (issue_date, description, qty, grn_id, store_id) VALUES (?, 'x', ?, ?, ?)", TODAY, qty, grnId, store).lastInsertRowid;

const G = { pad: receive('Brake Pad Set', 'Spare Parts', 10, 500), belt: receive('Fan Belt', 'Spare Parts', 4, 1200) };
issue(G.pad, 2);                                                        // 8 pads on the shelf
const OILP = run("INSERT INTO products (code, name, unit) VALUES ('OIL-9101', 'HD 68 Hydraulic', 'L')").lastInsertRowid;
require('../src/lib/lubricants').seedCatalogueAliases();          // the oil book knows its own product names
run("INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, txn_date, store_id) VALUES (?, 'receipt', 420, 420, 1500, ?, ?)", OILP, day(-7), CW);
run("INSERT INTO stock_items (code, section, name, item_key, unit, source_table) VALUES ('GEN-0901', 'general', 'Wiper Blade', 'WIPERBLADE', 'nos', 'store_items')");
run("INSERT INTO stock_items (code, section, name, item_key, unit, unit_price, source_table) VALUES ('GEN-0902', 'general', 'Hose Clamp', 'HOSECLAMP', 'nos', 50, 'store_items')");
run("INSERT INTO stock_items (code, section, name, item_key, unit, source_table) VALUES ('GEN-0903', 'general', 'Spare Bulb', 'SPAREBULB', 'nos', 'store_items')");
// A filter bought twice: the later price is the one it is worth now.
receive('FF-5052', 'Filters', 2, 800, CW, day(-20));
receive('FF-5052', 'Filters', 3, 900, CW, day(-8));
run("INSERT INTO stock_items (code, section, name, item_key, unit, unit_price, source_table) VALUES ('FIL-0901', 'filter', 'Fuel Filter FF-5052', 'FF5052', 'nos', 700, 'filter_prices')");
// A tyre fitted that the book never received: a shelf under 0 is worth nothing, not less than nothing.
run("INSERT INTO tyre_battery_issues (kind, issue_date, qty, category, store_id) VALUES ('tyre', ?, 1, 'Tyre 1000x20', ?)", day(-3), CW);
run("INSERT INTO stock_items (code, section, name, item_key, unit, unit_price, source_table) VALUES ('TYR-0901', 'tyre', 'Tyre 1000x20', 'TYRE1000X20', 'nos', 45000, 'tyre_battery_prices')");
// A lubricant the oil book does not know: history, never stock — and never on a count sheet.
receive('Mystery Oil XYZ', 'Lubricants', 5, 100);
stock.rebuild({ wipe: true });
const PAD = 'BRAKEPADSET';
const BELT = 'FANBELT';
const OIL = get("SELECT item_key FROM stock_moves WHERE section = 'oil' AND counts = 1 LIMIT 1").item_key;
run("INSERT INTO store_reorder (store_id, section, item_key, level) VALUES (?, 'general', 'WIPERBLADE', 2)", CW);
const bal = (key, store = CW, section = 'general') => stock.balanceOf(section, key, store);

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
const call = async (user, method, p, body) => req(method, '/api/stores' + p, { cookie: await as(user), body });
const ok = (r, status = 200) => { assert.strictEqual(r.status, status, r.text); return r.body; };
const lineOf = (s, key) => s.lines.find((l) => l.item_key === key);

// ================================================================== a full count, start to finish
test('a full count: the book at the start, what moved while counting, and the difference', async () => {
  assert.strictEqual((await call('sk', 'POST', '/counts', { kind: 'spares' })).status, 400);
  assert.strictEqual((await call('sk', 'POST', '/counts', { kind: 'general', count_date: day(1) })).status, 400, 'not in the future');
  assert.strictEqual((await call('ws', 'POST', '/counts', { kind: 'general' })).status, 403, 'only store staff count');
  assert.strictEqual((await call('boss', 'POST', '/counts', { kind: 'general', store_id: 99999 })).status, 400, 'a store that exists');
  const s = ok(await call('sk', 'POST', '/counts', { kind: 'general', note: 'month end' }), 201);
  assert.match(s.count_no, /^ST-\d{4}-0001$/);
  assert.deepStrictEqual([s.status, s.store_id, s.scope], ['counting', CW, 'full']);
  // What the store holds, and what it keeps a level for — not the catalogue at large.
  assert.deepStrictEqual(s.lines.map((l) => [l.item_key, l.book_start]).sort(), [[PAD, 8], [BELT, 4], ['WIPERBLADE', 0]]);
  assert.deepStrictEqual([lineOf(s, PAD).unit_price, lineOf(s, PAD).unit], [500, 'nos']);
  assert.strictEqual((await call('sk', 'POST', '/counts', { kind: 'all' })).status, 409, 'one count of a shelf at a time');
  assert.strictEqual((await call('sk', 'POST', '/counts', { kind: 'oil' })).status, 201, 'another kind may be counted alongside');

  // A pad is handed over while the store counts; then the pads are counted: 6 on the shelf.
  issue(G.pad, 1);
  stock.rebuild({ wipe: true });
  const pad = ok(await call('sk', 'PUT', `/counts/${s.id}/lines/${lineOf(s, PAD).id}`, { counted: 6 }));
  assert.deepStrictEqual([pad.book_start, pad.book_at_count, pad.moved_during, pad.diff, pad.diff_value], [8, 7, -1, -1, -500]);
  assert.strictEqual((await call('sk', 'PUT', `/counts/${s.id}/lines/${lineOf(s, BELT).id}`, { counted: -1 })).status, 400);
  assert.strictEqual((await call('sk', 'PUT', `/counts/${s.id}/lines/${lineOf(s, BELT).id}`, { counted: 4, date: day(-1) })).status, 400, 'not before the count began');
  ok(await call('sk', 'PUT', `/counts/${s.id}/lines/${lineOf(s, BELT).id}`, { counted: 5, note: 'one behind the door' }));
  // Every item needs a count before head office sees it — 0 is a count.
  let r = await call('sk', 'POST', `/counts/${s.id}/submit`);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /1 item is not counted yet/);
  ok(await call('sk', 'PUT', `/counts/${s.id}/lines/${lineOf(s, 'WIPERBLADE').id}`, { counted: 0 }));
  // Found on the shelf, not on the list: added and counted.
  const dup = await call('sk', 'POST', `/counts/${s.id}/lines`, { section: 'general', item_key: PAD });
  assert.deepStrictEqual([dup.status, /already on the list/.test(dup.body.error)], [409, true]);
  assert.strictEqual((await call('sk', 'POST', `/counts/${s.id}/lines`, { section: 'oil', item_key: OIL })).status, 400, 'not this kind');
  assert.strictEqual((await call('sk', 'POST', `/counts/${s.id}/lines`, { section: 'general', item_key: 'NOPE' })).status, 404);
  const found = await call('sk', 'GET', `/counts/${s.id}/find?q=Hose`);
  assert.deepStrictEqual(ok(found).map((i) => [i.item_key, i.on_list]), [['HOSECLAMP', false]]);
  assert.deepStrictEqual(ok(await call('sk', 'GET', `/counts/${s.id}/find?q=5052`)), [], 'only the kind being counted');
  // Only the store's own staff count; the operational manager approves but does not count.
  assert.deepStrictEqual(ok(await call('om', 'GET', `/counts/${s.id}`)).can, { count: false, submit: false, approve: false, send_back: false, cancel: true });
  const clamp = ok(await call('sk', 'POST', `/counts/${s.id}/lines`, { section: 'general', item_key: 'HOSECLAMP' }), 201);
  assert.deepStrictEqual([clamp.added, clamp.book_start, clamp.unit_price], [1, 0, 50]);
  assert.deepStrictEqual(ok(await call('sk', 'GET', `/counts/${s.id}/find?q=Hose`)).map((i) => [i.item_key, i.on_list]), [['HOSECLAMP', true]]);
  ok(await call('sk', 'PUT', `/counts/${s.id}/lines/${clamp.id}`, { counted: 12 }));
  // Cleared, to count again.
  const cleared = ok(await call('sk', 'PUT', `/counts/${s.id}/lines/${clamp.id}`, { counted: '' }));
  assert.deepStrictEqual([cleared.counted, cleared.counted_qty, cleared.diff], [false, null, null]);
  ok(await call('sk', 'PUT', `/counts/${s.id}/lines/${clamp.id}`, { counted: 12 }));

  const sent = ok(await call('sk', 'POST', `/counts/${s.id}/submit`));
  assert.strictEqual(sent.status, 'submitted');
  assert.deepStrictEqual([sent.can.approve, sent.can.count], [false, false], 'the storekeeper does not approve');
  assert.strictEqual(ok(await call('mgr', 'GET', `/counts/${s.id}`)).can.approve, true);
  const late = await call('sk', 'POST', `/counts/${s.id}/lines`, { section: 'general', item_key: 'SPAREBULB' });
  assert.deepStrictEqual([late.status, /Nothing can be added now/.test(late.body.error)], [409, true]);
  assert.deepStrictEqual(sent.totals, { lines: 4, counted: 4, differ: 3, over_value: 1800, short_value: -500, net_value: 1300, unpriced: 0 });
  assert.strictEqual((await call('sk', 'PUT', `/counts/${s.id}/lines/${lineOf(s, PAD).id}`, { counted: 7 })).status, 409, 'sent: no more counting');
  assert.deepStrictEqual([bal(PAD), bal(BELT), bal('HOSECLAMP')], [7, 4, 0], 'nothing changes before approval');

  // Head office approves — the operational manager, who holds stores=view only.
  const no = await call('sk', 'POST', `/counts/${s.id}/approve`);
  assert.deepStrictEqual([no.status, /does not allow/.test(no.body.error)], [403, true]);
  const done = ok(await call('om', 'POST', `/counts/${s.id}/approve`));
  assert.strictEqual(done.status, 'approved');
  assert.deepStrictEqual([bal(PAD), bal(BELT), bal('HOSECLAMP'), bal('WIPERBLADE')], [6, 5, 12, 0]);
  const rows = all('SELECT item_key, book_qty, counted_qty, delta, session_id FROM store_counts WHERE session_id = ? ORDER BY item_key', s.id);
  assert.deepStrictEqual(rows.map((x) => [x.item_key, x.book_qty, x.counted_qty, x.delta]), [[PAD, 7, 6, -1], [BELT, 4, 5, 1], ['HOSECLAMP', 0, 12, 12]]);
  assert.strictEqual((await call('om', 'POST', `/counts/${s.id}/approve`)).status, 409, 'once');
  assert.strictEqual((await call('om', 'POST', `/counts/${s.id}/cancel`, { reason: 'too late' })).status, 409, 'approved stays approved');
  stock.rebuild({ wipe: true });
  assert.deepStrictEqual([bal(PAD), bal(BELT), bal('HOSECLAMP')], [6, 5, 12], 'a rebuild keeps the corrections');

  // The difference report.
  const x = await req('GET', `/api/stores/counts/${s.id}/export.xlsx`, { cookie: await as('mgr') });
  assert.strictEqual(x.status, 200);
  assert.match(x.type, /spreadsheetml/);
});

// ================================================================== lubricants, send back, cancel
test('lubricants count in litres: full drums × size + the dip; head office can send a count back', async () => {
  const s = (await call('sk', 'GET', '/counts?status=counting')).body.find((c) => c.kind === 'oil');
  const d = ok(await call('sk', 'GET', `/counts/${s.id}`));
  const l = lineOf(d, OIL);
  assert.deepStrictEqual([l.book_start, l.unit, l.unit_price], [420, 'L', 1500]);
  assert.strictEqual(d.lines.length, 1, 'an unknown name is old history, not stock');
  const put = (body) => call('sk', 'PUT', `/counts/${s.id}/lines/${l.id}`, body);
  assert.strictEqual((await put({ containers: 2 })).status, 400, 'the size of a drum');
  assert.strictEqual((await put({ containers: 1.5, container_size: 210 })).status, 400, 'whole drums');
  assert.strictEqual((await put({ containers: 2, container_size: 210, loose_qty: -3 })).status, 400);
  const c = ok(await put({ containers: 1, container_size: 210, loose_qty: 185.5 }));
  assert.deepStrictEqual([c.counted_qty, c.containers, c.container_size, c.loose_qty, c.diff, c.diff_value], [395.5, 1, 210, 185.5, -24.5, -36750]);
  ok(await call('sk', 'POST', `/counts/${s.id}/submit`));
  assert.strictEqual((await call('mgr', 'POST', `/counts/${s.id}/send-back`, { reason: '' })).status, 400, 'say what to count again');
  const back = ok(await call('mgr', 'POST', `/counts/${s.id}/send-back`, { reason: 'Dip the drum again' }));
  assert.deepStrictEqual([back.status, back.decision_note], ['counting', 'Dip the drum again']);
  ok(await put({ containers: 1, container_size: 210, loose_qty: 190 }));
  ok(await call('sk', 'POST', `/counts/${s.id}/submit`));
  ok(await call('mgr', 'POST', `/counts/${s.id}/approve`));
  assert.strictEqual(bal(OIL, CW, 'oil'), 400);

  // Cancelled: nothing goes into stock. Store staff need the stores edit level to cancel.
  run("INSERT INTO roles (name, label) VALUES ('stockviewer', 'Counts, view only')");
  require('../src/lib/permissions').setPermission('stockviewer', 'stores', 'view');
  require('../src/lib/capabilities').setCapability('stockviewer', 'stores.stock.count', true);
  mkUser('viewonly', ['stockviewer']);
  const t = ok(await call('sk', 'POST', '/counts', { kind: 'general' }), 201);
  ok(await call('sk', 'PUT', `/counts/${t.id}/lines/${lineOf(t, PAD).id}`, { counted: 1 }));
  assert.strictEqual((await call('viewonly', 'POST', `/counts/${t.id}/cancel`, { reason: 'Started by mistake' })).status, 403);
  assert.strictEqual((await call('sk', 'POST', `/counts/${t.id}/cancel`, { reason: 'x' })).status, 400);
  assert.strictEqual(ok(await call('sk', 'POST', `/counts/${t.id}/cancel`, { reason: 'Started by mistake' })).status, 'cancelled');
  assert.strictEqual(bal(PAD), 6);
  assert.strictEqual((await call('sk', 'POST', `/counts/${t.id}/submit`)).status, 409);
});

// ================================================================== quick count
test('a quick count of one item waits for head office — unless head office made it', async () => {
  const q = ok(await call('sk', 'POST', '/stock/general/count', { store_id: CW, item_key: PAD, counted: 9, note: 'box behind' }), 201);
  assert.deepStrictEqual([q.status, q.book, q.counted, q.delta, q.balance], ['submitted', 6, 9, 3, 6]);
  assert.strictEqual((await call('sk', 'POST', '/stock/general/count', { store_id: CW, item_key: PAD, counted: 9 })).status, 409, 'one waiting count per item');
  const list = ok(await call('mgr', 'GET', '/counts?status=submitted&scope=quick'));
  assert.deepStrictEqual(list.map((c) => [c.id, c.item_name]), [[q.session_id, 'Brake Pad Set']]);
  ok(await call('mgr', 'POST', `/counts/${q.session_id}/approve`));
  assert.strictEqual(bal(PAD), 9);
  const h = ok(await call('boss', 'POST', '/stock/general/count', { store_id: CW, item_key: BELT, counted: 3 }), 201);
  assert.deepStrictEqual([h.status, h.delta, h.balance], ['approved', -2, 3], 'head office: at once');
  // Lubricants by the drum here too.
  const o = ok(await call('boss', 'POST', '/stock/oil/count', { store_id: CW, item_key: OIL, containers: 2, container_size: 200 }), 201);
  assert.deepStrictEqual([o.counted, o.balance], [400, 400]);
});

test('an item corrected by another count after it was counted is not corrected twice', async () => {
  const s = ok(await call('sk', 'POST', '/counts', { kind: 'general' }), 201);
  for (const l of s.lines) ok(await call('sk', 'PUT', `/counts/${s.id}/lines/${l.id}`, { counted: l.item_key === PAD ? 8 : l.book_start }));
  ok(await call('sk', 'POST', `/counts/${s.id}/submit`));
  ok(await call('boss', 'POST', '/stock/general/count', { store_id: CW, item_key: PAD, counted: 8 }), 201);    // 9 → 8
  const r = await call('mgr', 'POST', `/counts/${s.id}/approve`);
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /Another count corrected Brake Pad Set/);
  assert.strictEqual(bal(PAD), 8, 'corrected once');
  ok(await call('mgr', 'POST', `/counts/${s.id}/send-back`, { reason: 'Count the pads again' }));
  ok(await call('sk', 'PUT', `/counts/${s.id}/lines/${lineOf(s, PAD).id}`, { counted: 8 }));
  ok(await call('sk', 'POST', `/counts/${s.id}/submit`));
  ok(await call('mgr', 'POST', `/counts/${s.id}/approve`));
  assert.strictEqual(bal(PAD), 8);
});

// ================================================================== the Stock view and the Monitor
test('the Stock view: value, last count, the first full count of each kind; the Monitor counts', async () => {
  const d = ok(await call('mgr', 'GET', '/stock/general'));
  const pad = d.items.find((i) => i.item_key === PAD);
  assert.deepStrictEqual([pad.balance, pad.unit_price, pad.value, pad.last_count], [8, 500, 4000, TODAY]);
  assert.strictEqual(d.summary.value, 8 * 500 + 3 * 1200 + 12 * 50);
  assert.deepStrictEqual([d.can.count, d.can.approve, d.home.id], [true, true, CW], 'one store: counted there');
  const ty = ok(await call('mgr', 'GET', '/stock/tyre'));
  assert.deepStrictEqual([ty.items[0].balance, ty.items[0].unit_price, ty.items[0].value, ty.summary.value], [-1, 45000, 0, 0]);
  const fi = ok(await call('mgr', 'GET', '/stock/filter')).items.find((i) => i.item_key === 'FF5052');
  assert.deepStrictEqual([fi.balance, fi.unit_price, fi.value], [5, 900, 4500], 'the last price paid');
  // A quick count, or a full count that was cancelled, is not the store's full count.
  ok(await call('boss', 'POST', '/stock/filter/count', { store_id: CW, item_key: 'FF5052', counted: 5 }), 201);
  const ty2 = ok(await call('sk', 'POST', '/counts', { kind: 'tyre' }), 201);
  ok(await call('sk', 'POST', `/counts/${ty2.id}/cancel`, { reason: 'Tyres next week' }));
  const ov = ok(await call('sk', 'GET', '/stock/overview'));
  const kind = (k) => ov.kinds.find((x) => x.section === k);
  assert.strictEqual(kind('tyre').full_count, null);
  assert.strictEqual(kind('general').full_count, TODAY);
  assert.strictEqual(kind('oil').full_count, TODAY);
  assert.strictEqual(kind('filter').full_count, null);
  assert.strictEqual(kind('oil').value, 400 * 1500);
  assert.deepStrictEqual(ov.counts, { counting: 0, submitted: 0 });
  const fc = ok(await call('sk', 'POST', '/counts', { kind: 'filter' }), 201);
  assert.strictEqual(lineOf(fc, 'FF5052').unit_price, 900, 'valued at the last price paid');
  ok(await call('sk', 'POST', '/stock/general/count', { store_id: CW, item_key: BELT, counted: 3 }), 201);
  ok(await call('sk', 'POST', '/stock/general/count', { store_id: CW, item_key: PAD, counted: 7 }), 201);
  const m = ok(await call('sk', 'GET', '/flow/monitor'));
  assert.deepStrictEqual(m.stock_takes, { counting: 1, submitted: 2 });
  // The list, by state and by kind of count.
  const listed = async (qs) => ok(await call('mgr', 'GET', '/counts?' + qs));
  assert.deepStrictEqual((await listed('status=submitted')).map((c) => [c.status, c.scope]), [['submitted', 'quick'], ['submitted', 'quick']]);
  assert.ok((await listed('status=approved')).every((c) => c.status === 'approved'));
  assert.deepStrictEqual((await listed('status=open&scope=full')).map((c) => c.kind), ['filter']);
  assert.deepStrictEqual((await listed('status=open&scope=quick')).map((c) => c.item_name).sort(), ['Brake Pad Set', 'Fan Belt']);
});

// ================================================================== store by store
test('with a store in each workshop, store staff count their own store; head office sees all', async () => {
  run('UPDATE workshops SET own_store = 1 WHERE id = ?', MTR);
  receive('Brake Pad Set', 'Spare Parts', 6, 500, MTR);
  stock.rebuild({ wipe: true });
  scope.setSwitch({ id: U.boss }, true);
  try {
    const other = await call('skM', 'POST', '/counts', { kind: 'general', store_id: CW });
    assert.deepStrictEqual([other.status, /You count only your own store \(Muthur Workshop\)/.test(other.body.error)], [403, true]);
    assert.strictEqual((await call('boss', 'POST', '/counts', { kind: 'tyre' })).status, 400, 'head office names the store');
    const s = ok(await call('skM', 'POST', '/counts', { kind: 'general' }), 201);
    assert.strictEqual(s.store_id, MTR, 'store staff: their own store');
    assert.deepStrictEqual(s.lines.map((l) => [l.item_key, l.book_start]), [[PAD, 6]], 'Muthur\'s shelf only');
    const mine = ok(await call('skM', 'GET', '/counts'));
    assert.ok(mine.length && mine.every((c) => c.store_id === MTR));
    const cw = get("SELECT id FROM count_sessions WHERE store_id = ? ORDER BY id DESC LIMIT 1", CW).id;
    assert.strictEqual((await call('skM', 'GET', `/counts/${cw}`)).status, 403);
    assert.ok(ok(await call('mgr', 'GET', '/counts')).some((c) => c.store_id === CW), 'head office: every store');
    assert.ok(ok(await call('mgr', 'GET', `/counts?store_id=${MTR}`)).every((c) => c.store_id === MTR));
    ok(await call('skM', 'PUT', `/counts/${s.id}/lines/${s.lines[0].id}`, { counted: 5 }));
    ok(await call('skM', 'POST', `/counts/${s.id}/submit`));
    assert.strictEqual((await call('skM', 'POST', `/counts/${s.id}/approve`)).status, 403);
    // A store's own supervisor, even with the right to approve, is not head office.
    const lead = await call('lead', 'POST', `/counts/${s.id}/approve`);
    assert.deepStrictEqual([lead.status, lead.body.error], [403, 'Head office approves a stock take.']);
    assert.strictEqual(ok(await call('lead', 'GET', `/counts/${s.id}`)).can.approve, false);
    ok(await call('mgr', 'POST', `/counts/${s.id}/approve`));
    assert.deepStrictEqual([bal(PAD, MTR), bal(PAD, CW)], [5, 8], 'the other store is untouched');
    // Their Monitor watches their own store's counts.
    assert.deepStrictEqual(ok(await call('skM', 'GET', '/flow/monitor')).stock_takes, { counting: 0, submitted: 0 });
    run("INSERT INTO store_reorder (store_id, section, item_key, level) VALUES (?, 'general', ?, 10)", MTR, PAD);
    const ov = ok(await call('skM', 'GET', '/stock/overview'));
    const gen = ov.kinds.find((k) => k.section === 'general');
    assert.deepStrictEqual([ov.store.id, gen.full_count, gen.low], [MTR, TODAY, 1]);
    assert.deepStrictEqual(ok(await call('mgr', 'GET', `/stock/general?store_id=${MTR}`)).can, { count: true, levels: true, approve: true });
  } finally {
    scope.setSwitch({ id: U.boss }, false);
    run('UPDATE workshops SET own_store = 0 WHERE id = ?', MTR);
  }
});
