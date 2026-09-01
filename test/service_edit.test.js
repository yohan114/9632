'use strict';

// Editing a service record that has already been entered.
//
// The awkward part is not the form, it is the oil. Recording a service takes lubricant off
// the shelf, and oil balances here are a RUNNING balance carried on each ledger row
// (balance_after), not a sum — so deleting or voiding the original movement would leave every
// later balance exactly as it was and the stock quietly wrong. An edit therefore settles the
// difference: use more and the extra is issued, use less and the difference comes back, and
// correcting a date moves nothing at all.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-svc-edit-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();

for (const n of ['admin', 'workshop', 'viewer']) run('INSERT INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'sk', auth.hashPassword('pw')).lastInsertRowid;
run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, 'admin');

// An oil we stock, with 500 L on the shelf.
const OIL = 'Hydraulic Oil HD-68';
const pid = run(`INSERT INTO products (name, unit, active) VALUES (?, 'L', 1)`, OIL).lastInsertRowid;
run(`INSERT INTO stock_ledger (product_id, kind, qty, balance_after, txn_date, note)
     VALUES (?, 'opening', 500, 500, date('now'), 'opening')`, pid);

const ASSET = require('../src/lib/aliases').findOrCreateAsset('SV-01', {}).id;

const app = require('../src/server');
let server; let base; let cookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'sk', password: 'pw' }),
  });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
});
test.after(() => server && server.close());

const api = async (p, opts = {}) => {
  const r = await fetch(base + '/api' + p, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// The shelf as the app reads it: the balance carried on the newest row.
const shelf = () => get('SELECT balance_after FROM stock_ledger WHERE product_id = ? ORDER BY id DESC LIMIT 1', pid).balance_after;
const ledgerRows = () => get('SELECT COUNT(*) c FROM stock_ledger WHERE product_id = ?', pid).c;

const payload = (over = {}) => ({
  asset: 'SV-01', asset_id: ASSET, service_date: '2026-08-01', service_type: '500 Hrs', site_location: 'Badalgama',
  labour_rate: 20, sundry_rate: 5,
  oils: [{ oil_name: OIL, oil_type: 'HD-68', cv: 'C', qty: 20, price: 24000 }],
  filters: [{ category: 'Engine Oil Filter', filter_no: 'C-1121', qty: 1, xe: 'X', price: 1500 }],
  parts: [],
  ...over,
});

let sid;

test('recording the service takes the oil off the shelf', async () => {
  const r = await api('/filters/services', { method: 'POST', body: payload() });
  assert.strictEqual(r.status, 201);
  sid = r.body.service.id;
  assert.strictEqual(r.body.oil_issues, 1);
  assert.strictEqual(shelf(), 480, '500 - 20');
  // 20 + 24000 → subtotal 25500, labour 20%, sundry 5%
  assert.strictEqual(r.body.service.parts_subtotal, 25500);
  assert.strictEqual(r.body.service.grand_total, 31875);
});

test('editing only the header moves no stock at all', async () => {
  const rowsBefore = ledgerRows();
  const r = await api('/filters/services/' + sid, {
    method: 'PUT', body: payload({ site_location: 'Iginimitiya', service_type: '1000 Hrs' }),
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.stock_moves, 0, 'nothing about the oil changed');
  assert.strictEqual(shelf(), 480, 'the shelf is untouched');
  assert.strictEqual(ledgerRows(), rowsBefore, 'and no row was written');
  assert.strictEqual(r.body.service.site_location, 'Iginimitiya');
  assert.strictEqual(r.body.service.service_type, '1000 Hrs');
});

test('using more oil issues only the difference', async () => {
  const r = await api('/filters/services/' + sid, {
    method: 'PUT',
    body: payload({ site_location: 'Iginimitiya', oils: [{ oil_name: OIL, oil_type: 'HD-68', cv: 'C', qty: 32, price: 38400 }] }),
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.stock_moves, 1);
  assert.strictEqual(shelf(), 468, '500 - 32, not 500 - 20 - 32');
  const last = get('SELECT kind, qty FROM stock_ledger WHERE product_id = ? ORDER BY id DESC LIMIT 1', pid);
  assert.strictEqual(last.kind, 'issue');
  assert.strictEqual(last.qty, -12, 'the extra 12 L only');
});

test('using less oil gives the difference back', async () => {
  const r = await api('/filters/services/' + sid, {
    method: 'PUT',
    body: payload({ site_location: 'Iginimitiya', oils: [{ oil_name: OIL, oil_type: 'HD-68', cv: 'C', qty: 5, price: 6000 }] }),
  });
  assert.strictEqual(r.body.stock_moves, 1);
  assert.strictEqual(shelf(), 495, '500 - 5');
  const last = get('SELECT kind, qty FROM stock_ledger WHERE product_id = ? ORDER BY id DESC LIMIT 1', pid);
  assert.strictEqual(last.kind, 'adjustment');
  assert.strictEqual(last.qty, 27, '32 booked, 5 used — 27 back');
});

test('taking the oil off the service returns all of it', async () => {
  const r = await api('/filters/services/' + sid, { method: 'PUT', body: payload({ oils: [] }) });
  assert.strictEqual(r.body.stock_moves, 1);
  assert.strictEqual(shelf(), 500, 'right back where it started');
  assert.strictEqual(get('SELECT COUNT(*) c FROM service_oils WHERE service_id = ?', sid).c, 0);
});

test('putting it back issues it again — the ledger nets to what the service says', async () => {
  const r = await api('/filters/services/' + sid, { method: 'PUT', body: payload() });
  assert.strictEqual(shelf(), 480);
  assert.strictEqual(r.body.service.grand_total, 31875, 'back to the original total');
  // However many corrections were made, the service's own movements net to what it uses.
  const net = get(
    `SELECT COALESCE(SUM(-qty), 0) AS used FROM stock_ledger
      WHERE consumer_type = 'service' AND (note = ? OR note LIKE ?)`,
    'Service record #' + sid, 'Service record #' + sid + ' · %').used;
  assert.strictEqual(net, 20, 'net consumption equals the 20 L on the record');
});

test('the lines are replaced, not appended', () => {
  assert.strictEqual(get('SELECT COUNT(*) c FROM service_oils WHERE service_id = ?', sid).c, 1);
  assert.strictEqual(get('SELECT COUNT(*) c FROM service_filters WHERE service_id = ?', sid).c, 1);
});

test('re-saving does not keep counting the same filter as a fresh use', () => {
  const uses = get(`SELECT uses FROM filter_prices WHERE filter_no_norm = 'C1121'`).uses;
  assert.strictEqual(uses, 1, `used once on one service, however many times it was edited (got ${uses})`);
});

test('a filter added by the edit does count, and the totals follow', async () => {
  const r = await api('/filters/services/' + sid, {
    method: 'PUT',
    body: payload({ filters: [
      { category: 'Engine Oil Filter', filter_no: 'C-1121', qty: 1, xe: 'X', price: 1500 },
      { category: 'Fuel Filter', filter_no: 'FC-707A', qty: 2, xe: 'X', price: 1000 },
    ] }),
  });
  assert.strictEqual(get(`SELECT uses FROM filter_prices WHERE filter_no_norm = 'FC707A'`).uses, 1, 'the new number is a real use');
  assert.strictEqual(get(`SELECT uses FROM filter_prices WHERE filter_no_norm = 'C1121'`).uses, 1, 'the old one still is not');
  assert.strictEqual(r.body.service.parts_subtotal, 27500, '24000 oil + 1500 + 2×1000');
});

test('an edit cannot strip the machine off the record', async () => {
  const before = get('SELECT asset_id FROM service_jobs WHERE id = ?', sid).asset_id;
  assert.ok(before, 'the service has a machine to begin with');
  const r = await api('/filters/services/' + sid, { method: 'PUT', body: payload({ asset: '', asset_id: '' }) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(get('SELECT asset_id FROM service_jobs WHERE id = ?', sid).asset_id, before);
});

test('editing a service that is not there is a 404, not a new one', async () => {
  const r = await api('/filters/services/99999', { method: 'PUT', body: payload() });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(get('SELECT COUNT(*) c FROM service_jobs').c, 1, 'nothing was created');
});

test('the edit is on the audit trail with what changed', () => {
  const a = get(`SELECT * FROM audit_log WHERE entity = 'service_job' AND action = 'update' ORDER BY id DESC LIMIT 1`);
  assert.ok(a, 'an update was recorded');
  assert.ok(a.before_json && a.after_json, 'with both sides');
});

test('a machine is found by any of its names, and finds ALL its services', async () => {
  // A machine answers to a code, a registration and an E&C number, and the paperwork uses
  // whichever came to hand. Searching used to match the free-text label and the code only, so
  // the registration returned FEWER services than the E&C number for the very same vehicle.
  const a = require('../src/db').get('SELECT id, code, registration, ec_code FROM assets WHERE id = ?', ASSET);
  require('../src/db').run('UPDATE assets SET registration = ?, ec_code = ? WHERE id = ?', 'ZX-1234', 'SV-01', ASSET);

  // Two services on the one machine, labelled inconsistently — one naming the registration,
  // one naming neither.
  const mk = (label) => require('../src/db').run(
    `INSERT INTO service_jobs (vehicle_label, asset_id, service_date, service_type) VALUES (?, ?, '2026-04-01', 'X')`,
    label, ASSET);
  mk('ZX-1234 (SV-01)');
  mk(null);

  const counts = {};
  for (const term of ['ZX-1234', 'SV-01', 'zx 1234', 'ZX1234']) {
    const r = await api('/filters/services?limit=500&q=' + encodeURIComponent(term));
    counts[term] = r.body.filter((x) => x.asset_reg === 'ZX-1234' || x.asset_ec === 'SV-01').length;
  }
  const vals = Object.values(counts);
  assert.ok(vals[0] >= 2, `expected the machine's services, got ${JSON.stringify(counts)}`);
  assert.ok(vals.every((v) => v === vals[0]),
    `every spelling must find the same services — got ${JSON.stringify(counts)}`);

  require('../src/db').run('UPDATE assets SET registration = ?, ec_code = ? WHERE id = ?', a.registration, a.ec_code, ASSET);
});

test('a LIKE wildcard in the search box is text, not a wildcard', async () => {
  // "%" used to match every service, so the search looked like it ignored what was typed.
  const all = await api('/filters/services?limit=500');
  const pct = await api('/filters/services?limit=500&q=%25');
  assert.ok(all.body.length > 0);
  assert.strictEqual(pct.body.length, 0, 'a bare % must find nothing, not everything');
});

test('the form reads back everything it needs to re-render the record', async () => {
  const r = await api('/filters/services/' + sid);
  assert.strictEqual(r.status, 200);
  const f = r.body.filters[0];
  // The line price is what THIS service was charged — without it an edit would silently
  // re-price the record from the book.
  assert.ok('price' in f, 'the filter line carries its own price');
  assert.strictEqual(f.price, 1500);
  assert.strictEqual(r.body.oils[0].qty, 20);
});
