'use strict';

// Receiving a filter that is not the number that was asked for.
//
// A request names one part; the shop supplies an equivalent. The receipt has to record the
// number on the BOX, or nobody can find it on the shelf afterwards — and the equivalence
// itself is worth keeping, so the next time that number is requested the storekeeper is
// offered what was accepted for it before.
//
// What must NOT happen: the requested text being overwritten (the two have to stay
// comparable), or a stray number being welded into the filter catalogue.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-recv-xref-test.db');
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

// A catalogue entry for the requested filter, with one known equivalent.
const cat = run(`INSERT INTO filter_catalogue (category, oem_pn, oem_pn_norm, description)
                 VALUES ('Engine Oil Filter', 'C-206', 'C206', 'test')`).lastInsertRowid;
run(`INSERT INTO filter_xrefs (catalogue_id, brand, part_number, part_number_norm, ref_type, source)
     VALUES (?, 'Sakura', 'C-1501', 'C1501', 'cross', 'import')`, cat);
// The placeholder that sits on a thousand real catalogue rows and must never be offered.
run(`INSERT INTO filter_xrefs (catalogue_id, brand, part_number, part_number_norm, ref_type, source)
     VALUES (?, 'HIFI', '🔍 TBD', 'TBD', 'hifi', 'import')`, cat);

const mrn = run(`INSERT INTO mrn (mrn_no, req_date, status) VALUES ('R-1', date('now'), 'open')`).lastInsertRowid;
const line = run(`INSERT INTO mrn_lines (mrn_id, description, qty, unit) VALUES (?, 'Oil Filter (C-206)', 4, 'nos')`, mrn).lastInsertRowid;
const plain = run(`INSERT INTO mrn_lines (mrn_id, description, qty, unit) VALUES (?, 'Grease Nipple', 2, 'nos')`, mrn).lastInsertRowid;

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

test('a filter line is offered the equivalents already on record', async () => {
  const r = await api('/stores/pending?limit=100');
  const row = r.body.find((x) => x.id === line);
  assert.ok(row, 'the line is awaiting receipt');
  assert.strictEqual(row.requested_part_no, 'C-206', 'the number is read out of the description');
  const offered = row.equivalents.map((e) => e.part_number);
  assert.ok(offered.includes('C-1501'), `expected the Sakura equivalent, got ${JSON.stringify(offered)}`);
  assert.ok(!offered.some((p) => /TBD/.test(p)), 'the TBD placeholder is never offered');
});

test('a line that is not a filter is simply left alone', async () => {
  const r = await api('/stores/pending?limit=100');
  const row = r.body.find((x) => x.id === plain);
  assert.strictEqual(row.requested_part_no, null);
  assert.deepStrictEqual(row.equivalents, []);
});

test('receiving records the number on the box, and keeps the number asked for', async () => {
  const r = await api('/stores/grn/bulk-receive', {
    method: 'POST',
    body: { rows: [{ mrn_line_id: line, qty: 2, received_part_no: 'C-1501', grn_no: 'G-1' }] },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.received, 1);

  const g = get('SELECT description, received_part_no, qty FROM grn WHERE mrn_line_id = ?', line);
  assert.strictEqual(g.received_part_no, 'C-1501', 'what arrived');
  assert.strictEqual(g.description, 'Oil Filter (C-206)', 'and what was asked for, unchanged');
  assert.strictEqual(get('SELECT qty_received q FROM mrn_lines WHERE id = ?', line).q, 2);
});

test('an equivalence the system had not seen is remembered', async () => {
  const before = get(`SELECT COUNT(*) c FROM filter_xrefs WHERE catalogue_id = ?`, cat).c;
  await api('/stores/grn/bulk-receive', {
    method: 'POST',
    body: { rows: [{ mrn_line_id: line, qty: 1, received_part_no: 'LF3874', grn_no: 'G-2' }] },
  });
  const added = get(`SELECT * FROM filter_xrefs WHERE catalogue_id = ? AND part_number_norm = 'LF3874'`, cat);
  assert.ok(added, 'the new equivalent joined the catalogue entry the request belongs to');
  assert.strictEqual(added.source, 'received');
  assert.match(added.note, /supplied against C-206/);
  assert.strictEqual(get(`SELECT COUNT(*) c FROM filter_xrefs WHERE catalogue_id = ?`, cat).c, before + 1);

  // Next time, it is offered.
  const r = await api('/stores/pending?limit=100');
  const row = r.body.find((x) => x.id === line);
  assert.ok(row.equivalents.map((e) => e.part_number).includes('LF3874'));
});

test('receiving the same number twice does not duplicate the cross-reference', async () => {
  const before = get(`SELECT COUNT(*) c FROM filter_xrefs WHERE catalogue_id = ? AND part_number_norm = 'LF3874'`, cat).c;
  await api('/stores/grn/bulk-receive', {
    method: 'POST', body: { rows: [{ mrn_line_id: line, qty: 1, received_part_no: 'LF 3874', grn_no: 'G-3' }] },
  });
  assert.strictEqual(get(`SELECT COUNT(*) c FROM filter_xrefs WHERE catalogue_id = ? AND part_number_norm = 'LF3874'`, cat).c,
    before, '"LF 3874" and "LF3874" are the same part');
});

test('receiving exactly what was asked for records nothing extra', async () => {
  const before = get('SELECT COUNT(*) c FROM filter_xrefs').c;
  const r = await api('/stores/grn/bulk-receive', {
    method: 'POST', body: { rows: [{ mrn_line_id: plain, qty: 1 }] },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(get('SELECT received_part_no r FROM grn WHERE mrn_line_id = ?', plain).r, null);
  assert.strictEqual(get('SELECT COUNT(*) c FROM filter_xrefs').c, before, 'no cross-reference invented');
});

test('a number the catalogue has never heard of is recorded but not filed', async () => {
  // The receipt still has to say what arrived; but with nothing to attach it to, guessing a
  // catalogue entry would corrupt the book.
  const m2 = run(`INSERT INTO mrn (mrn_no, req_date, status) VALUES ('R-2', date('now'), 'open')`).lastInsertRowid;
  const l2 = run(`INSERT INTO mrn_lines (mrn_id, description, qty) VALUES (?, 'Oil Filter (ZZ-9999)', 1)`, m2).lastInsertRowid;
  const before = get('SELECT COUNT(*) c FROM filter_xrefs').c;
  await api('/stores/grn/bulk-receive', {
    method: 'POST', body: { rows: [{ mrn_line_id: l2, qty: 1, received_part_no: 'QQ-1234' }] },
  });
  assert.strictEqual(get('SELECT received_part_no r FROM grn WHERE mrn_line_id = ?', l2).r, 'QQ-1234', 'still recorded');
  assert.strictEqual(get('SELECT COUNT(*) c FROM filter_xrefs').c, before, 'and nothing added to the catalogue');
});

test('what arrived follows through to the shelf, so it can be found', () => {
  const stock = require('../src/lib/stock');
  const rows = stock.receivedLines({ mrn: 'R-1' });
  const hit = rows.find((r) => r.received_part_no === 'C-1501');
  assert.ok(hit, 'the received number reaches the "in store" list used when issuing');
  assert.strictEqual(hit.description, 'Oil Filter (C-206)', 'alongside what was originally asked for');
});
