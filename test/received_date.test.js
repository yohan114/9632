'use strict';

// When an item arrived.
//
// The store already said WHETHER something was received; these cover WHEN. The rules that
// matter, and why each is a rule rather than a preference:
//
//  * The date comes from the goods-received notes, never from the received QUANTITY. One real
//    line ('seat kit', MRN 166898) carries a quantity with no note behind it — a typo pair
//    whose receipt was corrected onto its sibling — and it must say so rather than borrow a
//    date from anywhere.
//  * delivery_date is the arrival; grn_date is the number on the paper (blank on 3781 of 3880
//    rows) and created_at is when the row was imported. Printing created_at as an arrival would
//    date 3270 receipts to the import run.
//  * A line delivered in more than one drop reports the completing date AND says it was split.
//    57 real lines are like this and 37 span different days — three by 127, 172 and 314.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-received-date-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const { receivedLabel, lineReceiptSql } = require('../src/lib/received_date');

migrate();
for (const n of ['admin', 'storekeeper']) run('INSERT INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'sk', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ['admin', 'storekeeper']) {
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
}

const ASSET = require('../src/lib/aliases').findOrCreateAsset('RD-01').id;

// One request holding every shape a line can be in.
const MRN = run(`INSERT INTO mrn (mrn_no, req_date, asset_id, status) VALUES ('D-1', '2026-01-05', ?, 'open')`, ASSET).lastInsertRowid;
const line = (desc, qty, recd) => run('INSERT INTO mrn_lines (mrn_id, description, qty, qty_received, unit) VALUES (?, ?, ?, ?, ?)',
  MRN, desc, qty, recd, 'nos').lastInsertRowid;
const receipt = (lineId, qty, deliveryDate, extra = {}) => run(
  `INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, delivery_date, grn_date, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  extra.grn_no || null, MRN, lineId, 'x', qty, deliveryDate,
  extra.grn_date || null, extra.created_at || '2026-07-16 08:47:14').lastInsertRowid;

const FULL = line('Fully received', 4, 4);        receipt(FULL, 4, '2026-03-02');
const PART = line('Part received', 10, 4);        receipt(PART, 4, '2026-04-09');
const NONE = line('Nothing yet', 3, 0);
const SPLIT = line('Two deliveries', 12, 12);     receipt(SPLIT, 6, '2026-02-01'); receipt(SPLIT, 6, '2026-06-20');
const SAME_DAY = line('Two notes, one day', 8, 8); receipt(SAME_DAY, 4, '2026-05-05'); receipt(SAME_DAY, 4, '2026-05-05');
// The 'seat kit' shape: a quantity with no note behind it.
const ORPHAN = line('Quantity but no note', 4, 4);
// A receipt whose only date is the import timestamp — delivery_date genuinely blank.
const BLANK = line('Note with no date', 2, 2);    receipt(BLANK, 2, null, { created_at: '2026-07-16 08:47:14' });
// The reversal shape (mrn_line 7384 in the live book): delivered, then sent back under the same
// GRN number, so the line nets to nothing.
const RETURNED = line('Delivered then returned', 2, 0);
receipt(RETURNED, 2, '2026-06-06', { grn_no: '201415' });
receipt(RETURNED, -2, '2026-06-08', { grn_no: '201415' });
// And the same, but only part of it went back — 3 arrived, 1 returned, 2 still on the shelf.
const PART_RETURNED = line('Part returned', 3, 2);
receipt(PART_RETURNED, 3, '2026-05-01'); receipt(PART_RETURNED, -1, '2026-05-20');

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
const byId = (rows, id) => rows.find((r) => r.id === id);

// ---- the rule itself -------------------------------------------------------

test('the date of a received line is the day the goods arrived', () => {
  const rows = all(`SELECT ml.id, ${lineReceiptSql('ml.id')} FROM mrn_lines ml WHERE ml.mrn_id = ?`, MRN);
  assert.strictEqual(byId(rows, FULL).last_received, '2026-03-02');
  assert.strictEqual(byId(rows, FULL).receipt_days, 1);
});

test('a part-delivered line is dated by what has actually turned up', () => {
  const rows = all(`SELECT ml.id, ${lineReceiptSql('ml.id')} FROM mrn_lines ml WHERE ml.mrn_id = ?`, MRN);
  assert.strictEqual(byId(rows, PART).last_received, '2026-04-09');
});

test('a line nothing has arrived for has no date at all', () => {
  const rows = all(`SELECT ml.id, ${lineReceiptSql('ml.id')} FROM mrn_lines ml WHERE ml.mrn_id = ?`, MRN);
  assert.strictEqual(byId(rows, NONE).last_received, null);
  assert.strictEqual(byId(rows, NONE).receipt_days, 0);
});

test('a split delivery reports the completing date and both ends of the spread', () => {
  const rows = all(`SELECT ml.id, ${lineReceiptSql('ml.id')} FROM mrn_lines ml WHERE ml.mrn_id = ?`, MRN);
  const r = byId(rows, SPLIT);
  assert.strictEqual(r.last_received, '2026-06-20', 'the day it was completed');
  assert.strictEqual(r.first_received, '2026-02-01', 'and the day the first of it came');
  assert.strictEqual(r.receipt_days, 2);
});

test('two notes on the same day are one delivery, not two', () => {
  const rows = all(`SELECT ml.id, ${lineReceiptSql('ml.id')} FROM mrn_lines ml WHERE ml.mrn_id = ?`, MRN);
  const r = byId(rows, SAME_DAY);
  assert.strictEqual(r.receipt_days, 1, 'counted by day, not by note — otherwise every re-keyed receipt reads as split');
  assert.strictEqual(r.first_received, r.last_received);
});

// ---- what must NOT happen --------------------------------------------------

test('a quantity with no note behind it does not borrow a date', () => {
  const rows = all(`SELECT ml.id, ${lineReceiptSql('ml.id')} FROM mrn_lines ml WHERE ml.mrn_id = ?`, MRN);
  const r = byId(rows, ORPHAN);
  assert.strictEqual(r.last_received, null, 'the quantity is not evidence of a date');
  assert.strictEqual(receivedLabel({ ...r, qty_received: 4 }).text, 'not recorded', 'and the screen says so');
});

test('the import timestamp is never shown as an arrival', () => {
  // The row exists and was created on the import run; its delivery_date is blank. The old
  // COALESCE(delivery_date, created_at) idiom would print 2026-07-16 for goods nobody dated.
  const rows = all(`SELECT ml.id, ${lineReceiptSql('ml.id')} FROM mrn_lines ml WHERE ml.mrn_id = ?`, MRN);
  const r = byId(rows, BLANK);
  assert.strictEqual(r.last_received, null);
  assert.ok(!/2026-07-16/.test(JSON.stringify(r)), 'no build timestamp anywhere near a received date');
});

test('a return is not an arrival', () => {
  // The credit note is dated LATER than the delivery, so counting it would date the line to the
  // day the goods went back — and badge the pair as two deliveries.
  const rows = all(`SELECT ml.id, ${lineReceiptSql('ml.id')} FROM mrn_lines ml WHERE ml.mrn_id = ?`, MRN);
  const r = byId(rows, RETURNED);
  assert.strictEqual(r.last_received, '2026-06-06', 'the day it came, not the day it went back');
  assert.strictEqual(r.receipt_days, 1, 'one delivery, not two');
});

test('a line that was delivered and wholly returned shows no date', () => {
  const rows = all(`SELECT ml.id, ml.qty_received, ${lineReceiptSql('ml.id')} FROM mrn_lines ml WHERE ml.mrn_id = ?`, MRN);
  const r = byId(rows, RETURNED);
  assert.strictEqual(r.qty_received, 0, 'nothing is held');
  assert.strictEqual(receivedLabel(r).text, '', 'so no arrival date beside "not received · 0"');
});

test('a partly returned line still reports when the goods came', () => {
  const rows = all(`SELECT ml.id, ml.qty_received, ${lineReceiptSql('ml.id')} FROM mrn_lines ml WHERE ml.mrn_id = ?`, MRN);
  const r = byId(rows, PART_RETURNED);
  assert.strictEqual(r.last_received, '2026-05-01');
  assert.strictEqual(r.receipt_days, 1);
  assert.strictEqual(receivedLabel(r).text, '2026-05-01', 'two are still on the shelf, and this is when they arrived');
});

test('the GRN paper date is not mistaken for the arrival', () => {
  const l = line('Paper dated later', 1, 1);
  receipt(l, 1, '2026-02-10', { grn_date: '2026-02-28' });
  const r = get(`SELECT ml.id, ${lineReceiptSql('ml.id')} FROM mrn_lines ml WHERE ml.id = ?`, l);
  assert.strictEqual(r.last_received, '2026-02-10', 'when it arrived, not when the note was written up');
});

test('a timestamp is trimmed to the day', () => {
  const l = line('Timestamped', 1, 1);
  receipt(l, 1, '2026-03-14 06:19:07');
  const r = get(`SELECT ml.id, ${lineReceiptSql('ml.id')} FROM mrn_lines ml WHERE ml.id = ?`, l);
  assert.strictEqual(r.last_received, '2026-03-14');
});

// ---- how it reads ----------------------------------------------------------

test('the label spells out a split rather than hiding it', () => {
  const l = receivedLabel({ last_received: '2026-06-20', first_received: '2026-02-01', receipt_days: 2, qty_received: 12 });
  assert.strictEqual(l.text, '2026-06-20');
  assert.ok(l.split);
  assert.match(l.title, /2 dates, 2026-02-01 to 2026-06-20/, 'says dates, because distinct days is what is counted');
});

test('a line nothing arrived for reads as empty, not as "not recorded"', () => {
  assert.strictEqual(receivedLabel({ last_received: null, qty_received: 0 }).text, '');
});

test('the browser renders the same three answers as the server', () => {
  // The SPA carries its own copy of receivedLabel so a screen and its Excel cannot disagree.
  // If one is edited without the other this fails.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const m = src.match(/const receivedLabel = \(r\) => \{[\s\S]*?\n\};/);
  assert.ok(m, 'the browser copy still exists');
  const browser = new Function('return ' + m[0].replace('const receivedLabel = ', ''))();
  for (const row of [
    { last_received: null, qty_received: 0 },
    { last_received: null, qty_received: 4 },
    { last_received: '2026-03-02', first_received: '2026-03-02', receipt_days: 1, qty_received: 4 },
    { last_received: '2026-06-20', first_received: '2026-02-01', receipt_days: 2, qty_received: 12 },
    { last_received: '2026-06-06', first_received: '2026-06-06', receipt_days: 1, qty_received: 0 },
  ]) {
    const a = receivedLabel(row); const b = browser(row);
    assert.deepStrictEqual(b, a, `the two copies disagree for ${JSON.stringify(row)}`);
  }
});

test('the split count is a number the exports can print', () => {
  // It is interpolated straight into a cell as "+N". A boolean here shipped "+true" to 37 rows
  // of the stores search workbook.
  const l = receivedLabel({ last_received: '2026-06-20', first_received: '2026-02-01', receipt_days: 3, qty_received: 9 });
  assert.strictEqual(l.split, 2, 'the number of EXTRA dates, not a flag');
  assert.strictEqual(typeof l.split, 'number');
  assert.strictEqual(receivedLabel({ last_received: '2026-06-20', first_received: '2026-06-20', receipt_days: 1, qty_received: 9 }).split, 0);
});

// ---- the surfaces ----------------------------------------------------------

test('the search list carries the date', async () => {
  const r = await api('/stores/search?limit=100');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(byId(r.body, FULL).last_received, '2026-03-02');
  assert.strictEqual(byId(r.body, NONE).last_received, null);
});

test('the search list can be sorted by it, with the undated last either way', async () => {
  const dates = async (dir) => (await api('/stores/search?limit=100&sort=received_' + dir)).body.map((x) => x.last_received);
  const desc = await dates('desc');
  const withDate = desc.filter(Boolean);
  assert.deepStrictEqual(withDate, [...withDate].sort().reverse(), 'newest first');
  assert.ok(desc.slice(withDate.length).every((d) => d === null), 'and nothing-yet at the bottom');

  const asc = await dates('asc');
  const ascDated = asc.filter(Boolean);
  assert.deepStrictEqual(ascDated, [...ascDated].sort(), 'oldest first');
  assert.ok(asc.slice(ascDated.length).every((d) => d === null), 'still at the bottom, not sorted to the top');
});

test('the pending list dates the part-delivery already in', async () => {
  const r = await api('/stores/pending?limit=100');
  assert.strictEqual(byId(r.body, PART).last_received, '2026-04-09');
  assert.strictEqual(byId(r.body, NONE).last_received, null);
});

test('the request detail dates each item', async () => {
  const r = await api('/stores/mrn/' + MRN);
  assert.strictEqual(byId(r.body.lines, FULL).last_received, '2026-03-02');
  assert.strictEqual(byId(r.body.lines, ORPHAN).last_received, null);
});

test('the request list dates the whole request by its last delivery', async () => {
  const r = await api('/stores/mrn?limit=50');
  const m = r.body.find((x) => x.id === MRN);
  assert.strictEqual(m.last_received, '2026-06-20', 'the latest goods against the request');
  assert.strictEqual(m.first_received, '2026-02-01');
});

test('the awaiting list dates a part-delivery too', async () => {
  const r = await api('/stores/awaiting-grn?limit=100');
  assert.strictEqual(byId(r.body, PART).last_received, '2026-04-09');
});

test('a receipt keeps its date when it is picked for issue', () => {
  const stock = require('../src/lib/stock');
  const g = get('SELECT id FROM grn WHERE mrn_line_id = ? LIMIT 1', FULL);
  assert.strictEqual(stock.receivedLine(g.id).received_date, '2026-03-02',
    'the picker shows it; selecting it must not drop it');
});

// ---- nothing else moved ----------------------------------------------------

test('adding the date changed no quantity, count or status', async () => {
  const s = await api('/stores/search?limit=100');
  const f = byId(s.body, FULL);
  assert.strictEqual(f.qty, 4);
  assert.strictEqual(f.qty_received, 4);
  assert.strictEqual(f.pending, 0);
  assert.strictEqual(f.status, 'received');
  assert.strictEqual(byId(s.body, PART).status, 'partial');
  assert.strictEqual(byId(s.body, NONE).status, 'not received');
  // The receipts COUNT is per note; receipt_days is per day. They are different numbers and
  // both are still right.
  assert.strictEqual(byId(s.body, SAME_DAY).receipts, 2);
  assert.strictEqual(byId(s.body, SAME_DAY).receipt_days, 1);
});

test('reading a date never writes one', async () => {
  const before = all('SELECT id, delivery_date, grn_date, created_at FROM grn ORDER BY id');
  await api('/stores/search?limit=100&sort=received_desc');
  await api('/stores/pending?limit=100');
  await api('/stores/mrn/' + MRN);
  assert.deepStrictEqual(all('SELECT id, delivery_date, grn_date, created_at FROM grn ORDER BY id'), before);
});
