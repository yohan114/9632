'use strict';

// Stores plan, Part 3 — the one issue rule, and service records taking their filters and oil from
// stock (src/lib/stock_rule.js, stock.sync, src/routes/filters.js).
//
//   Every receipt and every issue reaches the store's shelf as it is saved (stock.sync). Once a
//   store has had its first full count of a kind of stock, nothing of that kind leaves it unless the
//   shelf holds it (ST-D12, D13): Stores → Issue, the old free-text issue, the rack register, and the
//   service record's filters and oil. An equivalent filter may be fitted and both numbers are kept
//   (ST-D15). An edit is judged by what it changes (ST-D17). A quick count puts right an item the
//   book shows at 0 (ST-D14).

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-sp3-'));
process.env.DB_PATH = path.join(TMP, 'sp3.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const workshops = require('../src/lib/workshops');
const stock = require('../src/lib/stock');

migrate();
// Same order a real install uses: the ERP gap-fill (issues.service_id, vehicle_monthly_costs…).
require('../src/migrate/015_phase4_erp_gaps').runStep();
for (const n of ['admin', 'workshop', 'manager', 'storekeeper', 'operational_manager']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
require('../src/lib/capabilities').seedCapabilities();
const CW = workshops.defaultId();
const PW = 'copper-lantern-gravel';
function mkUser(username, roles, ws = CW) {
  const id = run('INSERT INTO users (username, password_hash, active, workshop_id) VALUES (?, ?, 1, ?)', username, auth.hashPassword(PW), ws).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
mkUser('boss', ['admin']); mkUser('mgr', ['manager']); mkUser('sk', ['storekeeper']);
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const TODAY = day(0);

const ASSET = run("INSERT INTO assets (code, code_norm, registration, status, in_register) VALUES ('WP-3001', 'WP3001', 'WP-3001', 'active', 1)").lastInsertRowid;
const JOB = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, is_historical, requested_at, workshop_id)
  VALUES ('2026/9/R/901', ?, 'repair', 'x', 'IN_PROGRESS', 0, ?, ?)`, ASSET, TODAY, CW).lastInsertRowid;
run("INSERT INTO stock_items (code, section, name, item_key, unit, unit_price, source_table) VALUES ('GEN-0001', 'general', 'Brake Pad Set', 'BRAKEPADSET', 'set', 500, 'store_items')");
const PAD_ITEM = get("SELECT id FROM stock_items WHERE code = 'GEN-0001'").id;
// The oil book, its types and the service sheet's oil list.
const OILP = run("INSERT INTO products (code, name, unit) VALUES ('OIL-9101', 'HD 68 Hydraulic', 'L')").lastInsertRowid;
require('../src/lib/lubricants').seedCatalogueAliases();
run("INSERT INTO oil_type_prices (code, unit_price) VALUES ('HD68', 1500)");
run("INSERT INTO oil_list (name) VALUES ('HD 68 Hydraulic Oil')");
const OIL = stock.itemKey('oil', 'HD 68 Hydraulic', 'OIL-9101');
// One filter, known by its OEM number C-206 and by the VIC number the store actually buys.
run("INSERT INTO filter_catalogue (id, category, oem_pn, oem_pn_norm) VALUES (7001, 'Oil Filter', 'C-206', 'C206')");
run("INSERT INTO filter_xrefs (catalogue_id, brand, part_number, part_number_norm, ref_type) VALUES (7001, 'VIC', 'VIC-C112', 'VICC112', 'cross')");
run("INSERT INTO filter_xrefs (catalogue_id, brand, part_number, part_number_norm, ref_type) VALUES (7001, 'Sakura', 'SAK-2060', 'SAK2060', 'cross')");
run("INSERT INTO filter_prices (filter_no, filter_no_norm, category, unit_price) VALUES ('C-206', 'C206', 'Oil Filter', 2400), ('VIC-C112', 'VICC112', 'Oil Filter', 1800)");
// Filters count from a cut-over, as they do live: the filter register opens the shelf on that day.
run("INSERT INTO stock_opening (section, mode, cutover) VALUES ('filter', 'cutover', ?)", day(-30));

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
    const r = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ username: user, password: PW });
      const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/login',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.headers['set-cookie'][0].split(';')[0]));
      });
      q.on('error', reject); q.write(data); q.end();
    });
    cookies[user] = r;
  }
  return cookies[user];
}
const call = async (user, method, p, body) => req(method, '/api' + p, { cookie: await as(user), body });
const ok = (r, status = 200) => { assert.strictEqual(r.status, status, r.text); return r.body; };
const bal = (section, key) => stock.balanceOf(section, key, CW);

// A request line to receive against.
let seq = 0;
function requestLine(desc, category, qty) {
  const m = run("INSERT INTO mrn (mrn_no, req_date, requested_by, approval_status, workshop_id) VALUES (?, ?, 'Kasun', 'approved', ?)", `R-${++seq}`, day(-5), CW).lastInsertRowid;
  return { m, l: run('INSERT INTO mrn_lines (mrn_id, description, qty, category, qty_received) VALUES (?, ?, ?, ?, 0)', m, desc, qty, category).lastInsertRowid };
}
const receive = async (desc, category, qty, price) => {
  const r = requestLine(desc, category, qty);
  return ok(await call('sk', 'POST', '/stores/grn', { mrn_id: r.m, mrn_line_id: r.l, description: desc, qty, unit_price: price }), 201).id;
};
const issueItem = (qty) => call('sk', 'POST', '/stores/stock-issue', { job_id: JOB, lines: [{ stock_item_id: PAD_ITEM, qty }] });
// A full count of one kind, every item counted as given (else as the book says), approved.
async function fullCount(kind, counted = {}) {
  const s = ok(await call('sk', 'POST', '/stores/counts', { kind }), 201);
  for (const l of s.lines) ok(await call('sk', 'PUT', `/stores/counts/${s.id}/lines/${l.id}`, { counted: counted[l.item_key] ?? Math.max(0, l.book_start) }));
  ok(await call('sk', 'POST', `/stores/counts/${s.id}/submit`));
  return ok(await call('mgr', 'POST', `/stores/counts/${s.id}/approve`));
}
const service = (body) => ({ asset_id: ASSET, service_date: TODAY, job_no: '2026/9/R/901', ...body });
let G = {};

// ================================================================== stock is current at once
test('every receipt and issue reaches the shelf as it is saved; a full rebuild agrees', async () => {
  G.pads = await receive('Brake Pad Set', 'Spare Parts', 10, 500);
  assert.strictEqual(bal('general', 'BRAKEPADSET'), 10, 'received: on the shelf, no rebuild');
  G.filters = await receive('Oil Filter (VIC-C112)', 'Filters', 4, 1800);
  assert.strictEqual(bal('filter', 'VICC112'), 4, 'a filter received under its number in brackets');
  ok(await call('sk', 'POST', '/oil/ledger', { product_id: OILP, kind: 'receipt', qty: 100, unit_price: 1500 }), 201);
  assert.strictEqual(bal('oil', OIL), 100);
  ok(await issueItem(2), 201);
  ok(await call('sk', 'POST', '/stores/issues', { job_id: JOB, description: 'Brake Pad Set', qty: 1 }), 201);
  assert.strictEqual(bal('general', 'BRAKEPADSET'), 7);
  // A receipt handed over comes off the shelf the receipt went onto.
  ok(await call('sk', 'POST', '/stores/stock-issue', { job_id: JOB, lines: [{ grn_id: G.filters, qty: 1 }] }), 201);
  assert.strictEqual(bal('filter', 'VICC112'), 3);
  const clamp = ok(await call('sk', 'POST', '/general-stock/items', { name: 'Hose Clamp', category: 'General Items', balance: 4 }), 201);
  G.clamp = clamp.id;
  assert.strictEqual(bal('general', 'HOSECLAMP'), 4);
  // A service takes its filter and its oil at once.
  const s = ok(await call('boss', 'POST', '/filters/services', service({
    filters: [{ category: 'Oil Filter', filter_no: 'VIC-C112', qty: 1, xe: 'X', price: 1800 }],
    oils: [{ oil_name: 'HD 68 Hydraulic Oil', oil_type: 'HD68', qty: 20, price: 30000 }] })), 201);
  G.svc = s.service.id;
  assert.deepStrictEqual([bal('filter', 'VICC112'), bal('oil', OIL)], [2, 80]);
  // Receiving many at once, and pricing later: on the shelf at once, at the price given.
  const r2 = requestLine('Brake Pad Set', 'Spare Parts', 2);
  ok(await call('sk', 'POST', '/stores/grn/bulk-receive', { rows: [{ mrn_line_id: r2.l, qty: 2 }] }));
  assert.strictEqual(bal('general', 'BRAKEPADSET'), 9);
  const g2 = get('SELECT id FROM grn WHERE mrn_line_id = ?', r2.l).id;
  const movePrice = (g) => get("SELECT unit_price FROM stock_moves WHERE source_table = 'grn' AND source_id = ?", g).unit_price;
  assert.strictEqual(movePrice(g2), null);
  ok(await call('sk', 'POST', '/stores/grn/bulk-price', { rows: [{ id: g2, unit_price: 520 }] }));
  assert.strictEqual(movePrice(g2), 520);
  ok(await call('sk', 'PATCH', `/stores/grn/${g2}`, { unit_price: 530 }));
  assert.strictEqual(movePrice(g2), 530);
  ok(await issueItem(2), 201);
  // Only the rows a write names are brought up to date — nothing else is touched.
  const stray = run("INSERT INTO tyre_battery_issues (kind, issue_date, qty, category) VALUES ('tyre', ?, 1, 'Tyre 900x20')", TODAY).lastInsertRowid;
  const other = run("INSERT INTO workshops (code, name, own_store, active) VALUES ('OTH', 'Other Store', 1, 0)").lastInsertRowid;
  const note = run("INSERT INTO mtn (mtn_no, txn_date, description, qty) VALUES ('MTN-T1', ?, 'Brake Pad Set', 1)", TODAY).lastInsertRowid;
  const moved = run(`INSERT INTO mtn_lines (mtn_id, description, qty, category, from_store_id, to_store_id)
                     VALUES (?, 'Brake Pad Set', 1, 'Spare Parts', ?, ?)`, note, CW, other).lastInsertRowid;
  await receive('Fan Belt', 'Spare Parts', 1, 900);
  assert.strictEqual(get("SELECT COUNT(*) n FROM stock_moves WHERE source_table = 'tyre_battery_issues' AND source_id = ?", stray).n, 0);
  assert.strictEqual(get("SELECT COUNT(*) n FROM stock_moves WHERE source_table = 'mtn_lines' AND source_id = ?", moved).n, 0);
  run('DELETE FROM tyre_battery_issues WHERE id = ?', stray);
  run('DELETE FROM mtn WHERE id = ?', note);
  run('DELETE FROM workshops WHERE id = ?', other);
  assert.throws(() => stock.rebuild({ only: { users: [1] } }), /unknown source/);
  // The same figures a full recalculation reaches.
  const before = stock.SECTIONS.map((sec) => stock.items(sec, null, 1000, { store: CW }).map((i) => [i.item_key, i.balance]));
  stock.rebuild({ wipe: true });
  assert.deepStrictEqual(stock.SECTIONS.map((sec) => stock.items(sec, null, 1000, { store: CW }).map((i) => [i.item_key, i.balance])), before);
});

// ================================================================== before the first full count
test('before a store has counted a kind in full, nothing of it is blocked', async () => {
  const r = ok(await issueItem(9), 201);
  assert.match(r.warnings.join(' '), /stock is now -2/, 'going under 0 is reported, not refused');
  assert.strictEqual(bal('general', 'BRAKEPADSET'), -2);
  assert.deepStrictEqual(ok(await call('sk', 'GET', '/stores/stock/overview')).kinds.map((k) => k.full_count), [null, null, null, null, null]);
  // An oil the oil book does not know is still taken on a service (it just moves no stock).
  ok(await call('boss', 'POST', '/filters/services', service({ oils: [{ oil_name: 'Mystery Oil', qty: 2 }] })), 201);
});

// ================================================================== after it
test('after the first full count, nothing leaves unless it is on the shelf', async () => {
  await fullCount('general', { BRAKEPADSET: 5 });
  assert.strictEqual(bal('general', 'BRAKEPADSET'), 5);
  const issuesBefore = get('SELECT COUNT(*) n FROM issues').n;
  const no = await issueItem(6);
  assert.strictEqual(no.status, 409);
  assert.match(no.body.error, /Brake Pad Set: 5 in stock at .*, 6 asked for/);
  assert.match(no.body.error, /quick count/);
  assert.deepStrictEqual(no.body.short.map((x) => [x.item_key, x.in_stock, x.wanted]), [['BRAKEPADSET', 5, 6]]);
  assert.strictEqual(get('SELECT COUNT(*) n FROM issues').n, issuesBefore, 'nothing was written');
  assert.strictEqual(bal('general', 'BRAKEPADSET'), 5);
  // Two lines of the same item in one issue count together.
  const twice = await call('sk', 'POST', '/stores/stock-issue', { job_id: JOB, lines: [{ stock_item_id: PAD_ITEM, qty: 3 }, { stock_item_id: PAD_ITEM, qty: 3 }] });
  assert.strictEqual(twice.status, 409);
  ok(await issueItem(5), 201);
  assert.strictEqual((await issueItem(1)).status, 409, 'the shelf is empty');
  assert.strictEqual((await call('sk', 'POST', '/stores/issues', { job_id: JOB, description: 'Brake Pad Set', qty: 1 })).status, 409, 'the old door too');
  // The book shows 0, but two are found on the shelf: a quick count, head office approves, then they go.
  const q = ok(await call('sk', 'POST', '/stores/stock/general/count', { store_id: CW, item_key: 'BRAKEPADSET', counted: 2 }), 201);
  assert.strictEqual((await issueItem(1)).status, 409, 'not before the count is approved');
  ok(await call('mgr', 'POST', `/stores/counts/${q.session_id}/approve`));
  ok(await issueItem(2), 201);
  // The rack register's own issue.
  const rack = await call('sk', 'POST', `/general-stock/items/${G.clamp}/adjust`, { txn_type: 'issue', qty: 5 });
  assert.strictEqual(rack.status, 409);
  ok(await call('sk', 'POST', `/general-stock/items/${G.clamp}/adjust`, { txn_type: 'issue', qty: 4 }), 201);
  // A receipt cannot hand over more than it brought in.
  const pads2 = await receive('Brake Pad Set', 'Spare Parts', 3, 500);
  const over = await call('sk', 'POST', '/stores/stock-issue', { job_id: JOB, lines: [{ grn_id: pads2, qty: 4 }] });
  assert.deepStrictEqual([over.status, /only 3 of MRN/.test(over.body.error)], [409, true]);
  // … nor more than the shelf holds: a count found only one of the three.
  ok(await call('boss', 'POST', '/stores/stock/general/count', { store_id: CW, item_key: 'BRAKEPADSET', counted: 1 }), 201);
  const lost = await call('sk', 'POST', '/stores/stock-issue', { job_id: JOB, lines: [{ grn_id: pads2, qty: 2 }] });
  assert.deepStrictEqual([lost.status, /Brake Pad Set: 1 in stock/.test(lost.body.error)], [409, true]);
  ok(await call('sk', 'POST', '/stores/stock-issue', { job_id: JOB, lines: [{ grn_id: pads2, qty: 1 }] }), 201);
  // The stores item transaction door.
  assert.strictEqual((await call('sk', 'POST', `/stores/items/${G.clamp}/txn`, { txn_type: 'issue', qty: 1 })).status, 409);
  // Tyres and batteries join with their serial register (Part 4), even after a full count.
  run("INSERT INTO count_sessions (count_no, store_id, kind, scope, status, count_date, decided_at) VALUES ('ST-T1', ?, 'tyre', 'full', 'approved', ?, datetime('now'))", CW, TODAY);
  assert.strictEqual(require('../src/lib/stock_rule').since(CW, 'tyre'), null);
  // Oil has not been counted yet: still not blocked.
  assert.strictEqual(require('../src/lib/stock_rule').since(CW, 'oil'), null);
  assert.strictEqual(require('../src/lib/stock_rule').since(CW, 'general'), TODAY);
});

// ================================================================== service records
test('a service takes its filters and oil from stock; an equivalent may be fitted, and both numbers are kept', async () => {
  await fullCount('oil');
  await fullCount('filter');
  assert.deepStrictEqual([bal('filter', 'VICC112'), bal('oil', OIL)], [2, 80]);
  // What the form is shown.
  const ctx = ok(await call('boss', 'GET', '/filters/stock-context?job_no=2026/9/R/901&date=' + TODAY));
  assert.deepStrictEqual([ctx.store.id, ctx.rule.oil, ctx.rule.filter, ctx.types.HD68.in_stock, ctx.names['HD 68 Hydraulic Oil'].id], [CW, TODAY, TODAY, 80, OILP]);
  const found = ok(await call('boss', 'GET', '/filters/stock-search?q=C-206&job_no=2026/9/R/901&date=' + TODAY));
  assert.deepStrictEqual(found.items.map((i) => [i.filter_no, i.in_stock]), [['C-206', 0]]);
  assert.deepStrictEqual(found.equivalents.map((e) => [e.filter_no, e.in_stock, e.unit_price]), [['VIC-C112', 2, 1800]]);
  // The vehicle's number is not on the shelf: refused, and the equivalent in stock is named.
  const no = await call('boss', 'POST', '/filters/services', service({ filters: [{ category: 'Oil Filter', filter_no: 'C-206', qty: 1, xe: 'X' }] }));
  assert.strictEqual(no.status, 409);
  assert.match(no.body.error, /C-206: 0 in stock/);
  assert.match(no.body.error, /Equivalents in stock — C-206: VIC-C112 \(2\)/);
  const svcCount = get('SELECT COUNT(*) n FROM service_jobs').n;
  // The equivalent is fitted: it comes off the shelf, and the service keeps both numbers.
  const s = ok(await call('boss', 'POST', '/filters/services', service({
    filters: [{ category: 'Oil Filter', filter_no: 'VIC-C112', required_no: 'C-206', qty: 1, xe: 'X', price: 1800 }],
    oils: [{ oil_name: 'HD 68 Hydraulic Oil', oil_type: 'HD68', qty: 30, price: 45000 }] })), 201);
  assert.strictEqual(get('SELECT COUNT(*) n FROM service_jobs').n, svcCount + 1);
  const line = get('SELECT filter_no, required_no, required_no_norm FROM service_filters WHERE service_id = ?', s.service.id);
  assert.deepStrictEqual(line, { filter_no: 'VIC-C112', required_no: 'C-206', required_no_norm: 'C206' });
  assert.strictEqual(ok(await call('boss', 'GET', `/filters/services/${s.service.id}`)).filters[0].required_no, 'C-206');
  assert.deepStrictEqual([bal('filter', 'VICC112'), bal('oil', OIL)], [1, 50]);
  // More oil than the shelf holds, or an oil the book does not know: refused.
  const much = await call('boss', 'POST', '/filters/services', service({ oils: [{ oil_name: 'HD 68 Hydraulic Oil', oil_type: 'HD68', qty: 60 }] }));
  assert.deepStrictEqual([much.status, /50 in stock/.test(much.body.error)], [409, true]);
  const odd = await call('boss', 'POST', '/filters/services', service({ oils: [{ oil_name: 'Mystery Oil', qty: 2 }] }));
  assert.deepStrictEqual([odd.status, /not in the oil book/.test(odd.body.error)], [409, true]);
  assert.strictEqual(get('SELECT COUNT(*) n FROM service_jobs').n, svcCount + 1, 'nothing half-saved');
  // One left, two asked for: the equivalents named are other filters, never this one.
  const two = await call('boss', 'POST', '/filters/services', service({ filters: [{ category: 'Oil Filter', filter_no: 'VIC-C112', qty: 2 }] }));
  assert.strictEqual(two.status, 409);
  assert.doesNotMatch(two.body.error, /VIC-C112: VIC-C112/);
  G.svc2 = s.service.id;
});

test('an edit moves only the difference: saved again unchanged it is never refused', async () => {
  const id = G.svc2;
  const body = service({ filters: [{ category: 'Oil Filter', filter_no: 'VIC-C112', required_no: 'C-206', qty: 1, xe: 'X', price: 1800 }],
    oils: [{ oil_name: 'HD 68 Hydraulic Oil', oil_type: 'HD68', qty: 30, price: 45000 }] });
  ok(await issueItemFilterAll(), 201);
  assert.strictEqual(bal('filter', 'VICC112'), 0, 'the shelf is now empty');
  ok(await call('boss', 'PUT', `/filters/services/${id}`, { ...body, meter_reading: '1200' }));
  assert.deepStrictEqual([bal('filter', 'VICC112'), bal('oil', OIL)], [0, 50], 'unchanged: nothing moved');
  // A second filter now: there is none.
  const more = await call('boss', 'PUT', `/filters/services/${id}`, { ...body, filters: [{ ...body.filters[0], qty: 2 }] });
  assert.strictEqual(more.status, 409);
  assert.strictEqual(get('SELECT qty FROM service_filters WHERE service_id = ?', id).qty, 1, 'the service is as it was');
  assert.strictEqual(get('SELECT meter_reading FROM service_jobs WHERE id = ?', id).meter_reading, '1200');
  // Less oil: the difference goes back on the shelf.
  ok(await call('boss', 'PUT', `/filters/services/${id}`, { ...body, oils: [{ ...body.oils[0], qty: 25 }] }));
  assert.strictEqual(bal('oil', OIL), 55);
  // What the form shows an edit includes what this service already holds.
  const ctx = ok(await call('boss', 'GET', `/filters/stock-context?service_id=${id}`));
  assert.strictEqual(ctx.types.HD68.in_stock, 80, '55 on the shelf + the 25 this service holds');
  const found = ok(await call('boss', 'GET', `/filters/stock-search?q=VIC-C112&service_id=${id}`));
  assert.strictEqual(found.items[0].in_stock, 1, 'the one fitted on this service');
  stock.rebuild({ wipe: true });
  assert.deepStrictEqual([bal('filter', 'VICC112'), bal('oil', OIL)], [0, 55], 'a full rebuild agrees');
});
async function issueItemFilterAll() {
  return call('sk', 'POST', '/stores/stock-issue', { job_id: JOB, lines: [{ grn_id: G.filters, qty: bal('filter', 'VICC112') }] });
}

// ================================================================== one door for filters
test('the filter register no longer hands filters out', async () => {
  const f = ok(await call('boss', 'POST', '/filter-stock', { filter_type: 'Oil', part_no: 'VIC-C112', qty_in_stock: 0 }), 201);
  const r = await call('boss', 'POST', `/filter-stock/${f.id}/issue`, { qty: 1, asset_id: ASSET });
  assert.strictEqual(r.status, 410);
  assert.match(r.body.error, /Service record, or from Stores → Issue/);
});

// ================================================================== a shelf already under zero
test('a shelf already under zero stops nothing that does not take from it', async () => {
  const id = G.svc2;
  const body = service({ filters: [{ category: 'Oil Filter', filter_no: 'VIC-C112', required_no: 'C-206', qty: 1, xe: 'X', price: 1800 }],
    oils: [{ oil_name: 'HD 68 Hydraulic Oil', oil_type: 'HD68', qty: 25, price: 37500 }] });
  // Two went out that the book never took off (say, before the count).
  run(`INSERT INTO stock_moves (section, kind, item_key, item_name, qty, txn_date, source_table, source_id, counts, store_id)
       VALUES ('filter', 'out', 'VICC112', 'VIC-C112', 2, ?, 'legacy_test', 1, 1, ?)`, TODAY, CW);
  assert.strictEqual(bal('filter', 'VICC112'), -2);
  ok(await call('boss', 'PUT', `/filters/services/${id}`, { ...body, service_type: '500 Hrs' }), 200);
  // Taking the filter off the service puts it back — onto a shelf still under zero.
  ok(await call('boss', 'PUT', `/filters/services/${id}`, { ...body, filters: [] }), 200);
  assert.strictEqual(bal('filter', 'VICC112'), -1);
  // A receipt onto it goes in.
  await receive('Oil Filter (VIC-C112)', 'Filters', 1, 1800);
  assert.strictEqual(bal('filter', 'VICC112'), 0);
  run("DELETE FROM stock_moves WHERE source_table = 'legacy_test'");
});

// ================================================================== the tyre register reaches the shelf
test('a tyre handed over on its request reaches the shelf at once', async () => {
  const spec = run("INSERT INTO tb_specs (kind, size, label, spec_key, source) VALUES ('tyre', '1000 X 20', 'Tyre 1000 X 20', 'T1000X20', 'test')").lastInsertRowid;
  const m = run("INSERT INTO mrn (mrn_no, req_date, requested_by, approval_status, workshop_id, tb_kind, asset_id) VALUES ('TB-1', ?, 'Kasun', 'approved', ?, 'tyre', ?)", TODAY, CW, ASSET).lastInsertRowid;
  const l = run("INSERT INTO mrn_lines (mrn_id, description, qty, category) VALUES (?, 'Tyre 1000 X 20', 1, 'Tyres')", m).lastInsertRowid;
  run("INSERT INTO tb_request_lines (mrn_line_id, kind, spec_id, asset_id, reason) VALUES (?, 'tyre', ?, ?, 'worn')", l, spec, ASSET);
  const r = ok(await call('boss', 'POST', '/tb/issue', { mrn_line_id: l, qty: 1, serial_no: 'SN-1' }), 201);
  assert.strictEqual(get("SELECT COUNT(*) n FROM stock_moves WHERE source_table = 'tyre_battery_issues' AND source_id = ?", r.id).n, 1);
});

// ================================================================== store by store
test('the rule is per store: a store that has not counted is not blocked', async () => {
  const MTR = run("INSERT INTO workshops (code, name, own_store) VALUES ('MTR', 'Muthur Workshop', 1)").lastInsertRowid;
  run("INSERT INTO job_cards (job_no, asset_id, type, description, status, is_historical, requested_at, workshop_id) VALUES ('2026/9/R/902', ?, 'repair', 'x', 'IN_PROGRESS', 0, ?, ?)", ASSET, TODAY, MTR);
  try {
    // A service on a Muthur job takes from Muthur's store, which has counted nothing yet.
    const s = ok(await call('boss', 'POST', '/filters/services', service({ job_no: '2026/9/R/902',
      filters: [{ category: 'Oil Filter', filter_no: 'C-206', qty: 1 }] })), 201);
    assert.strictEqual(get('SELECT store_id FROM service_jobs WHERE id = ?', s.service.id).store_id, MTR);
    assert.strictEqual(stock.balanceOf('filter', 'C206', MTR), -1);
    // Its edit form is shown Muthur's shelf, whoever opens it.
    const ctx = ok(await call('boss', 'GET', `/filters/stock-context?service_id=${s.service.id}`));
    assert.deepStrictEqual([ctx.store.id, ctx.rule.filter], [MTR, null]);
  } finally {
    run('UPDATE workshops SET own_store = 0, active = 0 WHERE id = ?', MTR);
  }
});

// ================================================================== the register's receipt, at the cut-over
test('a receipt on the filter register opens the shelf at the cut-over at once', async () => {
  const f = get("SELECT id FROM filter_stock WHERE part_no = 'VIC-C112'");
  const before = bal('filter', 'VICC112');
  ok(await call('boss', 'POST', `/filter-stock/${f.id}/receive`, { qty: 2 }), 201);
  assert.strictEqual(bal('filter', 'VICC112'), before + 2);
});
