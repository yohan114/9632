'use strict';

// One transfer note, several items.
//
// A paper MTN lists everything that went on the trip. Before the system could hold that, the
// store faked it by suffixing the number — 58631, 58631-2 … 58631-5 is ONE note with five
// items, and 93 of the first 190 rows carry a -N. Now a note holds its items directly.
//
// Two things make this more than a list. First, the note's header keeps `description` and
// `qty` as a SUMMARY of the items, because the list, the search, the asset timeline and the
// exports all read a transfer as a single row — break that and five screens go blank. Second,
// an item may have come from somewhere other than the note says: transfer 64965 moved three
// filters off three DIFFERENT machines to one mechanic, so a line carries its own from/to.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-mtn-items-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();
for (const n of ['admin', 'storekeeper']) run('INSERT INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'sk', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ['admin', 'storekeeper']) {
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
}
const HEX23 = require('../src/lib/aliases').findOrCreateAsset('HEX-23').id;
const LO4925 = require('../src/lib/aliases').findOrCreateAsset('LO-4925').id;

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
    method: opts.method || 'GET', headers: { 'content-type': 'application/json', cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// The five-item note that used to need five numbers.
const makeFive = async (no) => {
  const r = await api('/stores/mtn', { method: 'POST', body: {
    mtn_no: no, txn_date: '2026-07-19', from_location: 'Work Shop Stores', to_location: 'Batticoloa W/S',
    transferred_by: 'Bandula', received_by: 'Lakmal',
    lines: [
      { description: 'Fly Wheel (43-1191)', qty: 1, unit: 'nos' },
      { description: 'Presure Platte Assy (43-1191)', qty: 1 },
      { description: 'Clutch Plate (Re-Lining)', qty: 1 },
      { description: 'Clutch Bearing', qty: 2 },
      { description: 'Bell Housing', qty: 1 },
    ],
  } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
};

// ---- one note, many items --------------------------------------------------

test('a transfer can carry several items under one number', async () => {
  const id = await makeFive('M-1');
  const d = await api('/stores/mtn/' + id);
  assert.strictEqual(d.body.lines.length, 5);
  assert.deepStrictEqual(d.body.lines.map((l) => l.line_no), [1, 2, 3, 4, 5]);
  assert.strictEqual(d.body.mtn.mtn_no, 'M-1', 'one number, not five suffixed ones');
});

test('the note still reads as one row wherever it is listed', async () => {
  const id = await makeFive('M-2');
  const m = get('SELECT description, qty FROM mtn WHERE id = ?', id);
  assert.match(m.description, /^Fly Wheel \(43-1191\) \+ 4 more$/, 'a summary a storekeeper can recognise');
  assert.strictEqual(m.qty, 6, '1+1+1+2+1 — the note total');
});

test('a one-item transfer is unchanged, header and all', async () => {
  const r = await api('/stores/mtn', { method: 'POST', body: { mtn_no: 'M-3', qty: 4, description: 'Grease' } });
  assert.strictEqual(r.status, 201);
  const m = get('SELECT description, qty FROM mtn WHERE id = ?', r.body.id);
  assert.strictEqual(m.description, 'Grease', 'no "+ 0 more" decoration');
  assert.strictEqual(m.qty, 4);
  assert.strictEqual(get('SELECT COUNT(*) c FROM mtn_lines WHERE mtn_id = ?', r.body.id).c, 1);
});

test('an item can come off a different machine than the note says', async () => {
  // Transfer 64965 in the real book: three filters, three source machines, one destination.
  const r = await api('/stores/mtn', { method: 'POST', body: {
    mtn_no: 'M-4', to_location: 'CEP-03 Wadakada', transferred_by: 'Bandula',
    lines: [
      { description: 'Hydrolic Filter (7319444)', qty: 1, from_asset_id: HEX23 },
      { description: 'Cabin Lifting Pump', qty: 1, from_asset_id: LO4925 },
      { description: 'Oil Filter', qty: 1 },
    ],
  } });
  assert.strictEqual(r.status, 201);
  const d = await api('/stores/mtn/' + r.body.id);
  assert.strictEqual(d.body.lines[0].from_asset_code, 'HEX-23');
  assert.strictEqual(d.body.lines[1].from_asset_code, 'LO-4925');
  assert.strictEqual(d.body.lines[2].from_asset_id, null, 'blank still means "same as the note"');
});

test('an item can carry its own reason', async () => {
  // 58605 carried a separate invoice value per line.
  const r = await api('/stores/mtn', { method: 'POST', body: {
    mtn_no: 'M-5', to_location: 'Head Office',
    lines: [{ description: 'Dimo Invoice 95217896', qty: 1, reason: 'Value 34158.93' },
      { description: 'Dimo Invoice 96259705', qty: 1, reason: 'Value 35877.16' }],
  } });
  const d = await api('/stores/mtn/' + r.body.id);
  assert.deepStrictEqual(d.body.lines.map((l) => l.reason), ['Value 34158.93', 'Value 35877.16']);
});

// ---- correcting a note -----------------------------------------------------

test('an item can be added to a note already written', async () => {
  const id = await makeFive('M-6');
  const r = await api('/stores/mtn/' + id + '/lines', { method: 'POST', body: { description: 'Gear Box', qty: 1 } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(get('SELECT COUNT(*) c FROM mtn_lines WHERE mtn_id = ?', id).c, 6);
  assert.strictEqual(get('SELECT qty FROM mtn WHERE id = ?', id).qty, 7, 'the note total follows');
  assert.match(get('SELECT description FROM mtn WHERE id = ?', id).description, /\+ 5 more/);
});

test('an item can be corrected', async () => {
  const id = await makeFive('M-7');
  const line = get('SELECT id FROM mtn_lines WHERE mtn_id = ? ORDER BY line_no LIMIT 1', id);
  const r = await api('/stores/mtn/line/' + line.id, { method: 'PATCH', body: { qty: 3, description: 'Fly Wheel (43-1192)' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(get('SELECT qty FROM mtn_lines WHERE id = ?', line.id).qty, 3);
  assert.strictEqual(get('SELECT qty FROM mtn WHERE id = ?', id).qty, 8, 'recomputed, not left stale');
  assert.match(get('SELECT description FROM mtn WHERE id = ?', id).description, /^Fly Wheel \(43-1192\) \+ 4 more$/);
});

test('an item can be taken off', async () => {
  const id = await makeFive('M-8');
  const line = get('SELECT id FROM mtn_lines WHERE mtn_id = ? ORDER BY line_no DESC LIMIT 1', id);
  const r = await api('/stores/mtn/line/' + line.id, { method: 'DELETE' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(get('SELECT COUNT(*) c FROM mtn_lines WHERE mtn_id = ?', id).c, 4);
  assert.strictEqual(get('SELECT qty FROM mtn WHERE id = ?', id).qty, 5);
});

test('the last item is never taken off, leaving a number standing for nothing', async () => {
  const r0 = await api('/stores/mtn', { method: 'POST', body: { mtn_no: 'M-9', qty: 1, description: 'Only item' } });
  const line = get('SELECT id FROM mtn_lines WHERE mtn_id = ?', r0.body.id);
  const r = await api('/stores/mtn/line/' + line.id, { method: 'DELETE' });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /at least one item/);
  assert.strictEqual(get('SELECT COUNT(*) c FROM mtn_lines WHERE mtn_id = ?', r0.body.id).c, 1);
});

test('a quantity on the note is refused once there is more than one item', async () => {
  // There is no single item it could mean, so saying nothing would silently change the wrong one.
  const id = await makeFive('M-10');
  const r = await api('/stores/mtn/' + id, { method: 'PATCH', body: { qty: 99 } });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /5 items/);
  assert.strictEqual(get('SELECT qty FROM mtn WHERE id = ?', id).qty, 6, 'untouched');
});

test('but on a one-item note it still edits that item, as it always did', async () => {
  const r0 = await api('/stores/mtn', { method: 'POST', body: { mtn_no: 'M-11', qty: 2, description: 'Grease' } });
  const r = await api('/stores/mtn/' + r0.body.id, { method: 'PATCH', body: { qty: 7, description: 'Grease (HD)' } });
  assert.strictEqual(r.status, 200);
  const line = get('SELECT description, qty FROM mtn_lines WHERE mtn_id = ?', r0.body.id);
  assert.strictEqual(line.qty, 7, 'the item itself moved, not just the summary');
  assert.strictEqual(line.description, 'Grease (HD)');
  assert.strictEqual(get('SELECT qty FROM mtn WHERE id = ?', r0.body.id).qty, 7);
});

test('an item with no quantity is refused, naming which one', async () => {
  const r = await api('/stores/mtn', { method: 'POST', body: {
    mtn_no: 'M-12', lines: [{ description: 'A', qty: 1 }, { description: 'B', qty: 0 }],
  } });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /Item 2/);
  assert.strictEqual(get(`SELECT COUNT(*) c FROM mtn WHERE mtn_no = 'M-12'`).c, 0, 'and nothing was written');
});

test('a transfer with no items at all is refused', async () => {
  const r = await api('/stores/mtn', { method: 'POST', body: { mtn_no: 'M-13' } });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /at least one item/);
});

// ---- an item's own source reaches the machine's history ---------------------

test('typing a machine code as an item’s source links it to that machine', async () => {
  // The storekeeper types "LO-4925" in the item's From box, not an id. If that is only kept as
  // text the transfer never reaches the machine, which is the whole point of a per-item source.
  const r = await api('/stores/mtn', { method: 'POST', body: {
    mtn_no: 'M-20', to_location: 'CEP-03',
    lines: [{ description: 'Cabin Lifting Pump', qty: 1, from_location: 'LO-4925' }],
  } });
  assert.strictEqual(r.status, 201);
  const l = get('SELECT from_location, from_asset_id FROM mtn_lines WHERE mtn_id = ?', r.body.id);
  assert.strictEqual(l.from_location, 'LO-4925', 'the text is kept as typed');
  assert.strictEqual(l.from_asset_id, LO4925, 'and linked to the machine');
});

test('a place that is not a machine stays plain text', async () => {
  const r = await api('/stores/mtn', { method: 'POST', body: {
    mtn_no: 'M-21', lines: [{ description: 'Grease', qty: 1, from_location: 'Head Office' }],
  } });
  const l = get('SELECT from_location, from_asset_id FROM mtn_lines WHERE mtn_id = ?', r.body.id);
  assert.strictEqual(l.from_location, 'Head Office');
  assert.strictEqual(l.from_asset_id, null, 'no machine invented for a place name');
});

test('correcting the source off a machine drops the link with it', async () => {
  const r = await api('/stores/mtn', { method: 'POST', body: {
    mtn_no: 'M-22', lines: [{ description: 'Filter', qty: 1, from_location: 'LO-4925' }],
  } });
  const line = get('SELECT id FROM mtn_lines WHERE mtn_id = ?', r.body.id);
  await api('/stores/mtn/line/' + line.id, { method: 'PATCH', body: { from_location: 'Head Office' } });
  assert.strictEqual(get('SELECT from_asset_id FROM mtn_lines WHERE id = ?', line.id).from_asset_id, null,
    'otherwise the old machine stays attached to a transfer that no longer touches it');
});

test('a machine’s history shows a transfer only one item of which touched it', async () => {
  await api('/stores/mtn', { method: 'POST', body: {
    mtn_no: 'M-23', to_location: 'CEP-03',
    lines: [{ description: 'Something else', qty: 1 },
      { description: 'Hydrolic Filter (7319444)', qty: 1, from_location: 'HEX-23' }],
  } });
  const r = await api('/assets/' + HEX23);
  const hit = (r.body.timeline || []).find((t) => t.kind === 'mtn' && t.ref === 'M-23');
  assert.ok(hit, 'the note reaches the machine through the item');
  assert.strictEqual(hit.description, 'Hydrolic Filter (7319444)',
    'described by the item that touched it, not by the note summary');
});

// ---- finding it again ------------------------------------------------------

test('a transfer is found by an item that is not the first one', async () => {
  await makeFive('M-14');
  const r = await api('/stores/mtn?q=' + encodeURIComponent('Bell Housing'));
  assert.ok(r.body.some((t) => t.mtn_no === 'M-14'),
    'the header only summarises, so the search has to reach the items');
});

test('the list says how many items are on each note', async () => {
  const r = await api('/stores/mtn?q=M-14');
  const t = r.body.find((x) => x.mtn_no === 'M-14');
  assert.strictEqual(t.item_count, 5);
});

test('a transfer is found by a machine only one of its items came off', async () => {
  const r = await api('/stores/mtn?q=LO-4925');
  assert.ok(r.body.some((t) => t.mtn_no === 'M-4'));
});

// ---- what must not have moved ---------------------------------------------

test('every note still has at least one item, and the totals agree', () => {
  assert.strictEqual(get('SELECT COUNT(*) c FROM mtn m WHERE NOT EXISTS (SELECT 1 FROM mtn_lines l WHERE l.mtn_id = m.id)').c, 0);
  for (const m of all('SELECT id, qty FROM mtn')) {
    const s = get('SELECT ROUND(COALESCE(SUM(qty),0),3) s FROM mtn_lines WHERE mtn_id = ?', m.id).s;
    assert.strictEqual(Math.round(m.qty * 1000) / 1000, s, `note ${m.id}: header total must equal its items`);
  }
});

test('the categories rollup counts items, not notes', async () => {
  const r = await api('/stores/categories');
  const total = r.body.transfers.reduce((s, x) => s + x.transfers, 0);
  assert.strictEqual(total, get('SELECT COUNT(*) c FROM mtn_lines').c,
    'a note carrying a filter and a battery belongs to both categories');
});
