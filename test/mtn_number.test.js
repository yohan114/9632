'use strict';

// The transfer note number.
//
// MTNs continue a paper book, so the storekeeper has to be able to type the number actually
// written on it — the system's next-in-sequence is a suggestion, not a decision. The number
// is UNIQUE in the schema, so a clash has to come back as something readable rather than a
// 500, and correcting a number later must not be able to collide either.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-mtn-no-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();
for (const n of ['admin', 'storekeeper']) run('INSERT INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'sk', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ['admin', 'storekeeper']) {
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
}

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
  await seedTransfers(); // one hook — a second one would run before `base` exists
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

test('a transfer can be given the number written in the book', async () => {
  const r = await api('/stores/mtn', { method: 'POST', body: { mtn_no: 'A-9001', qty: 3, description: 'Grease' } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.mtn_no, 'A-9001', 'the number typed, not the one counted to');
  assert.strictEqual(r.body.qty, 3);
});

test('left blank, the next in the sequence is used', async () => {
  const suggested = (await api('/stores/numbers')).body.next_mtn;
  const r = await api('/stores/mtn', { method: 'POST', body: { qty: 1 } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.mtn_no, suggested);
});

test('whitespace is not a number', async () => {
  const r = await api('/stores/mtn', { method: 'POST', body: { mtn_no: '   ', qty: 1 } });
  assert.strictEqual(r.status, 201);
  assert.ok(/^\d+$/.test(r.body.mtn_no), 'falls back to the sequence rather than storing blanks');
});

test('a number already used is refused, in words', async () => {
  const r = await api('/stores/mtn', { method: 'POST', body: { mtn_no: 'A-9001', qty: 1 } });
  assert.strictEqual(r.status, 409, 'not a 500 from the UNIQUE constraint');
  assert.match(r.body.error, /already exists/);
  assert.strictEqual(get(`SELECT COUNT(*) c FROM mtn WHERE mtn_no = 'A-9001'`).c, 1, 'and nothing was written');
});

test('the number can be corrected afterwards', async () => {
  const made = await api('/stores/mtn', { method: 'POST', body: { mtn_no: 'A-9100', qty: 2 } });
  const r = await api('/stores/mtn/' + made.body.id, { method: 'PATCH', body: { mtn_no: 'A-9101' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.mtn_no, 'A-9101');
  assert.strictEqual(get(`SELECT COUNT(*) c FROM mtn WHERE mtn_no = 'A-9100'`).c, 0);
});

test('correcting it onto a number already in use is refused', async () => {
  const made = await api('/stores/mtn', { method: 'POST', body: { mtn_no: 'A-9200', qty: 1 } });
  const r = await api('/stores/mtn/' + made.body.id, { method: 'PATCH', body: { mtn_no: 'A-9001' } });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(get('SELECT mtn_no FROM mtn WHERE id = ?', made.body.id).mtn_no, 'A-9200', 'left as it was');
});

test('saving a transfer under its own number is not a clash with itself', async () => {
  const made = await api('/stores/mtn', { method: 'POST', body: { mtn_no: 'A-9300', qty: 1 } });
  const r = await api('/stores/mtn/' + made.body.id, { method: 'PATCH', body: { mtn_no: 'A-9300', description: 'renamed only' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.description, 'renamed only');
});

test('the rest of a transfer can be corrected too', async () => {
  const made = await api('/stores/mtn', { method: 'POST', body: { mtn_no: 'A-9400', qty: 1, from_location: 'Yard' } });
  const r = await api('/stores/mtn/' + made.body.id, { method: 'PATCH', body: {
    qty: 5, txn_date: '2026-08-01', from_location: 'Main Stores', to_location: 'Rack 2C',
    transferred_by: 'K. Perera', received_by: 'S. Silva', reason: 'restock',
  } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.qty, 5);
  assert.strictEqual(r.body.from_location, 'Main Stores');
  assert.strictEqual(r.body.to_location, 'Rack 2C');
  assert.strictEqual(r.body.reason, 'restock');
});

test('a quantity of zero is refused', async () => {
  const made = await api('/stores/mtn', { method: 'POST', body: { mtn_no: 'A-9500', qty: 2 } });
  const r = await api('/stores/mtn/' + made.body.id, { method: 'PATCH', body: { qty: 0 } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(get('SELECT qty FROM mtn WHERE id = ?', made.body.id).qty, 2);
});

test('editing an MTN that is not there is a 404', async () => {
  const r = await api('/stores/mtn/99999', { method: 'PATCH', body: { mtn_no: 'X-1' } });
  assert.strictEqual(r.status, 404);
});

test('changes are audited with what they were before', async () => {
  const made = await api('/stores/mtn', { method: 'POST', body: { mtn_no: 'A-9600', qty: 1 } });
  await api('/stores/mtn/' + made.body.id, { method: 'PATCH', body: { mtn_no: 'A-9601' } });
  const a = get(`SELECT * FROM audit_log WHERE entity = 'mtn' AND action = 'update' ORDER BY id DESC LIMIT 1`);
  assert.ok(a);
  assert.match(a.before_json, /A-9600/);
  assert.match(a.after_json, /A-9601/);
});

// ── Finding a transfer again ──────────────────────────────────────────────────
//
// The book runs to hundreds of notes. A storekeeper looking one up knows one of a few
// things about it — the number, roughly what was moved, where it went, or who signed —
// so any of those has to find it. What it must NOT do is treat a wildcard as a wildcard:
// typing % into a search box is a search for a percent sign, not a request for everything.

const { all } = require('../src/db');

// Nothing here reuses a location, a name or a date used by the tests above — a search
// assertion that quietly matched one of those rows would be testing nothing.
async function seedTransfers() {
  const A = require('../src/lib/aliases').findOrCreateAsset('SR-77').id;
  run('UPDATE assets SET registration = ? WHERE id = ?', 'ZZ-4141', A); // findOrCreateAsset does not take one
  await api('/stores/mtn', { method: 'POST', body: {
    mtn_no: 'S-100', qty: 4, description: 'Hydraulic Oil 68', txn_date: '2026-03-04',
    from_location: 'Central Store', to_location: 'Quarry Yard', transferred_by: 'W. Bandara', received_by: 'T. Fernando',
  } });
  await api('/stores/mtn', { method: 'POST', body: {
    mtn_no: 'S-101', qty: 1, description: 'Air Filter (AF-25)', txn_date: '2026-06-20',
    from_location: 'Quarry Yard', to_location: 'Central Store', to_asset_id: A,
  } });
  await api('/stores/mtn', { method: 'POST', body: {
    mtn_no: 'S-102', qty: 2, description: '100% synthetic grease', txn_date: '2026-09-09',
  } });
}

const search = async (params) => (await api('/stores/mtn?' + new URLSearchParams(params))).body.map((t) => t.mtn_no);

test('a transfer is found by its number', async () => {
  assert.deepStrictEqual(await search({ q: 'S-101' }), ['S-101']);
});

test('…by what was moved, without minding case', async () => {
  assert.deepStrictEqual(await search({ q: 'hydraulic' }), ['S-100']);
});

test('…by where it came from or went to', async () => {
  assert.deepStrictEqual((await search({ q: 'Quarry Yard' })).sort(), ['S-100', 'S-101']);
});

test('…by who handed it over or took it', async () => {
  assert.deepStrictEqual(await search({ q: 'Bandara' }), ['S-100']);
  assert.deepStrictEqual(await search({ q: 'T. Fernando' }), ['S-100']);
});

test('…and by the machine it was moved to', async () => {
  // The code is on the asset, not on the transfer row — the search still has to reach it.
  assert.deepStrictEqual(await search({ q: 'SR-77' }), ['S-101']);
  assert.deepStrictEqual(await search({ q: 'ZZ-4141' }), ['S-101'], 'the registration finds it too');
});

test('a wildcard is searched for, not obeyed', async () => {
  assert.deepStrictEqual(await search({ q: '%' }), ['S-102'], 'only the transfer whose text really contains %');
  assert.deepStrictEqual(await search({ q: '_' }), [], 'and _ matches nothing rather than everything');
});

test('nothing matching gives nothing, not everything', async () => {
  assert.deepStrictEqual(await search({ q: 'no such transfer' }), []);
});

test('the list can be held to a date range', async () => {
  assert.deepStrictEqual((await search({ from: '2026-03-01', to: '2026-06-30' })).sort(), ['S-100', 'S-101']);
  assert.deepStrictEqual(await search({ from: '2026-09-01' }), ['S-102'], 'an open-ended range works');
  assert.deepStrictEqual(await search({ to: '2026-03-04' }), ['S-100'], 'and the bounds are inclusive');
});

test('a date range and a search narrow together', async () => {
  assert.deepStrictEqual(await search({ q: 'Central Store', from: '2026-06-01' }), ['S-101'],
    'S-100 is a Central Store transfer too, but it falls outside the range');
});

test('searching never changes anything', async () => {
  const before = all('SELECT id, mtn_no, qty FROM mtn ORDER BY id');
  await search({ q: 'Bandara', from: '2026-01-01', to: '2026-12-31' });
  assert.deepStrictEqual(all('SELECT id, mtn_no, qty FROM mtn ORDER BY id'), before);
});
