'use strict';

// Buying what the workshop asked for.
//
// Two officers, one on the Head Office account and one buying locally, and the split is per ITEM:
// a request can be part local and part head office, and an item one of them cannot source gets
// handed to the other. Each sees their own channel and nothing else — that separation IS the
// feature, so most of what is worth testing is what each officer canNOT do.
//
// The invariant underneath it all: BOUGHT IS NOT RECEIVED. stock_moves is a projection rebuilt
// from grn, so if the tick ever moved stock it would be counted a second time when the storekeeper
// posts the real GRN against the same line.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-purchasing-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const permissions = require('../src/lib/permissions');

migrate();
permissions.seedDefaults();

function mkUser(username, roles) {
  const id = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)',
    username, auth.hashPassword('pw')).lastInsertRowid;
  for (const r of roles) {
    run('INSERT OR IGNORE INTO roles (name) VALUES (?)', r);
    run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  }
  return id;
}
mkUser('hq', ['purchase_head_office']);
mkUser('loc', ['purchase_local']);
mkUser('boss', ['manager']);
mkUser('fitter', ['workshop']);

const ASSET = require('../src/lib/aliases').findOrCreateAsset('AC-06').id;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

// An approved request — approval is what puts it in front of an officer.
const MRN = run(`INSERT INTO mrn (mrn_no, req_date, asset_id, status, approval_status, requested_by, required_date)
   VALUES ('M-7001', '2026-08-01', ?, 'open', 'approved', 'sunil', '2026-08-10')`, ASSET).lastInsertRowid;
const mkLine = (desc, qty, source) => run(
  'INSERT INTO mrn_lines (mrn_id, description, qty, unit, qty_received, purchase_source) VALUES (?, ?, ?, ?, 0, ?)',
  MRN, desc, qty, 'nos', source).lastInsertRowid;

const L_HQ = mkLine('Compressor Belt', 2, 'head_office');
const L_LOCAL = mkLine('Brake Fluid', 4, 'local_purchase');
const L_NONE = mkLine('Wiper Blade', 2, null);

// A request nobody has approved or sent to be bought — must never reach the queue.
const MRN_RAW = run(`INSERT INTO mrn (mrn_no, req_date, asset_id, status, approval_status, requested_by)
   VALUES ('M-7002', '2026-08-02', ?, 'open', 'requested', 'sunil')`, ASSET).lastInsertRowid;
run('INSERT INTO mrn_lines (mrn_id, description, qty, unit, qty_received, purchase_source) VALUES (?, ?, ?, ?, 0, ?)',
  MRN_RAW, 'Not approved yet', 1, 'nos', 'head_office');

const app = require('../src/server');
let server; let base;
const cookies = {};
test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const u of ['hq', 'loc', 'boss', 'fitter']) {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u, password: 'pw' }),
    });
    cookies[u] = (r.headers.get('set-cookie') || '').split(';')[0];
  }
});
test.after(() => server && server.close());

const api = async (who, p, opts = {}) => {
  const r = await fetch(base + '/api' + p, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', cookie: cookies[who] },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ---- who sees what ---------------------------------------------------------

test('each officer sees only their own channel', async () => {
  const hq = await api('hq', '/purchasing/queue?tab=to_buy');
  assert.strictEqual(hq.status, 200);
  assert.deepStrictEqual(hq.body.rows.map((r) => r.id), [L_HQ]);

  const loc = await api('loc', '/purchasing/queue?tab=to_buy');
  assert.deepStrictEqual(loc.body.rows.map((r) => r.id), [L_LOCAL],
    'the local officer must not see the head-office list, or the split means nothing');
});

test('a manager sees both', async () => {
  const r = await api('boss', '/purchasing/queue?tab=to_buy');
  assert.strictEqual(r.body.sees_both, true);
  assert.deepStrictEqual(r.body.rows.map((r2) => r2.id).sort(), [L_HQ, L_LOCAL].sort());
});

test('someone with no purchasing access cannot open the screen at all', async () => {
  const r = await api('fitter', '/purchasing/queue');
  assert.strictEqual(r.status, 403, 'the module gate is what keeps this off everyone else’s screen');
});

test('items with no channel wait in a tray both officers can see', async () => {
  for (const who of ['hq', 'loc']) {
    const r = await api(who, '/purchasing/queue?tab=unassigned');
    assert.deepStrictEqual(r.body.rows.map((x) => x.id), [L_NONE],
      '1,714 of 1,738 real requests carry no channel — without this tray the queue is empty');
  }
});

test('a request nobody approved is not in anyone’s queue', async () => {
  const r = await api('boss', '/purchasing/queue?tab=to_buy');
  assert.ok(!r.body.rows.some((x) => x.description === 'Not approved yet'),
    'most requests never get bought as written; putting them all up buries the ones that matter');
});

// ---- handing an item to the other officer ---------------------------------

test('an officer can hand over an item they cannot source, with a reason', async () => {
  const r = await api('hq', `/purchasing/lines/${L_HQ}/source`, {
    method: 'POST', body: { purchase_source: 'local_purchase', reason: 'No head office account with this supplier' } });
  assert.strictEqual(r.status, 200);

  const row = get('SELECT purchase_source, source_changed_from, source_changed_by, source_changed_reason FROM mrn_lines WHERE id = ?', L_HQ);
  assert.strictEqual(row.purchase_source, 'local_purchase');
  assert.strictEqual(row.source_changed_from, 'head_office', 'where it came from is part of the record');
  assert.strictEqual(row.source_changed_by, 'hq');
  assert.match(row.source_changed_reason, /head office account/i);

  assert.ok((await api('loc', '/purchasing/queue?tab=to_buy')).body.rows.some((x) => x.id === L_HQ),
    'and it lands in the other officer’s list');
  // put it back for the tests below
  await api('loc', `/purchasing/lines/${L_HQ}/source`, { method: 'POST', body: { purchase_source: 'head_office', reason: 'returning for the test' } });
});

test('a handover without a reason is refused', async () => {
  const r = await api('hq', `/purchasing/lines/${L_HQ}/source`, { method: 'POST', body: { purchase_source: 'local_purchase' } });
  assert.strictEqual(r.status, 400,
    'a few months of reasons is the case for opening an account; without one a switch is indistinguishable from a slip');
});

test('an officer cannot reach into the other one’s queue and take an item', async () => {
  const r = await api('hq', `/purchasing/lines/${L_LOCAL}/source`, {
    method: 'POST', body: { purchase_source: 'head_office', reason: 'I want this one' } });
  assert.strictEqual(r.status, 403);
});

test('either officer may claim an unassigned item', async () => {
  const r = await api('loc', `/purchasing/lines/${L_NONE}/source`, {
    method: 'POST', body: { purchase_source: 'local_purchase', reason: 'buying it in town today' } });
  assert.strictEqual(r.status, 200);
});

test('the request header summarises its lines, and says "mixed" when they differ', () => {
  // The header is a maintained summary, never a second truth. Flattening it to whichever line was
  // updated last would quietly relabel the whole request.
  assert.strictEqual(get('SELECT purchase_source FROM mrn WHERE id = ?', MRN).purchase_source, 'mixed');
});

// ---- the tick --------------------------------------------------------------

test('buying an item records the invoice and the photo', async () => {
  const r = await api('hq', `/purchasing/lines/${L_HQ}/purchase`, { method: 'POST', body: {
    supplier: 'Auto Parts Lanka', invoice_no: 'INV-9001', invoice_date: '2026-08-05',
    purchase_amount: 3400, images: [PNG] } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const row = get('SELECT purchased_at, purchased_by, supplier, invoice_no, purchase_amount FROM mrn_lines WHERE id = ?', L_HQ);
  assert.ok(row.purchased_at);
  assert.strictEqual(row.purchased_by, 'hq');
  assert.strictEqual(row.purchase_amount, 3400);
  assert.strictEqual(get('SELECT COUNT(*) c FROM mrn_line_invoices WHERE mrn_line_id = ?', L_HQ).c, 1);
});

test('the tick moves no stock — that is still the GRN’s job', () => {
  // The one thing that would quietly corrupt the balances. stock_moves is rebuilt from grn, so a
  // purchase that added stock would be counted again the moment the goods are actually received.
  assert.strictEqual(get('SELECT COUNT(*) c FROM grn WHERE mrn_line_id = ?', L_HQ).c, 0);
  const moves = get("SELECT COUNT(*) c FROM stock_moves WHERE source_table = 'grn'").c;
  assert.strictEqual(moves, 0, 'nothing here may write a movement');
});

test('an invoice photo is required', async () => {
  const r = await api('loc', `/purchasing/lines/${L_LOCAL}/purchase`, { method: 'POST', body: {
    supplier: 'Town Hardware', invoice_no: 'INV-1', images: [] } });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /photo/i);
});

test('a photo that is not an image, or is enormous, is refused', async () => {
  const notImage = await api('loc', `/purchasing/lines/${L_LOCAL}/purchase`, { method: 'POST', body: {
    supplier: 'X', invoice_no: 'Y', images: ['not-a-data-url'] } });
  assert.strictEqual(notImage.status, 400);

  const huge = await api('loc', `/purchasing/lines/${L_LOCAL}/purchase`, { method: 'POST', body: {
    supplier: 'X', invoice_no: 'Y', images: ['data:image/png;base64,' + 'A'.repeat(950000)] } });
  assert.strictEqual(huge.status, 413,
    'the database is copied whole every 30 minutes — an unbounded photo multiplies every backup');
});

test('an officer cannot tick an item on the other channel', async () => {
  const r = await api('hq', `/purchasing/lines/${L_LOCAL}/purchase`, { method: 'POST', body: {
    supplier: 'Auto Parts Lanka', invoice_no: 'INV-X', images: [PNG] } });
  assert.strictEqual(r.status, 403);
});

test('an unclaimed item cannot be ticked — it has no officer', async () => {
  const spare = run('INSERT INTO mrn_lines (mrn_id, description, qty, unit, qty_received) VALUES (?, ?, 1, ?, 0)',
    MRN, 'Unclaimed thing', 'nos').lastInsertRowid;
  const r = await api('hq', `/purchasing/lines/${spare}/purchase`, { method: 'POST', body: {
    supplier: 'X', invoice_no: 'Y', images: [PNG] } });
  assert.strictEqual(r.status, 403);
  assert.match(r.body.error, /claim/i);
});

test('the same item cannot be bought twice', async () => {
  const r = await api('hq', `/purchasing/lines/${L_HQ}/purchase`, { method: 'POST', body: {
    supplier: 'Someone Else', invoice_no: 'INV-DUP', images: [PNG] } });
  assert.strictEqual(r.status, 409);
});

test('a bought item cannot be shunted to the other channel afterwards', async () => {
  const r = await api('hq', `/purchasing/lines/${L_HQ}/source`, {
    method: 'POST', body: { purchase_source: 'local_purchase', reason: 'changed my mind' } });
  assert.strictEqual(r.status, 409, 'the invoice says who bought it; the channel has to keep agreeing');
});

test('a bought item moves to the Bought tab and off the To buy list', async () => {
  const toBuy = await api('hq', '/purchasing/queue?tab=to_buy');
  assert.ok(!toBuy.body.rows.some((x) => x.id === L_HQ));
  const bought = await api('hq', '/purchasing/queue?tab=bought');
  assert.ok(bought.body.rows.some((x) => x.id === L_HQ));
});

// ---- undoing, and the price check -----------------------------------------

test('a wrong invoice can be cleared and re-entered', async () => {
  const undo = await api('hq', `/purchasing/lines/${L_HQ}/purchase`, { method: 'DELETE' });
  assert.strictEqual(undo.status, 200);
  assert.strictEqual(get('SELECT purchased_at FROM mrn_lines WHERE id = ?', L_HQ).purchased_at, null);
  assert.strictEqual(get('SELECT COUNT(*) c FROM mrn_line_invoices WHERE mrn_line_id = ?', L_HQ).c, 0,
    'the old photo goes with it, or the next invoice inherits the wrong evidence');

  await api('hq', `/purchasing/lines/${L_HQ}/purchase`, { method: 'POST', body: {
    supplier: 'Auto Parts Lanka', invoice_no: 'INV-9002', purchase_amount: 3400, images: [PNG] } });
});

test('once some of it has arrived the purchase cannot be undone', async () => {
  run('UPDATE mrn_lines SET qty_received = 1 WHERE id = ?', L_HQ);
  const r = await api('hq', `/purchasing/lines/${L_HQ}/purchase`, { method: 'DELETE' });
  assert.strictEqual(r.status, 409);
  run('UPDATE mrn_lines SET qty_received = 0 WHERE id = ?', L_HQ);
});

test('an invoice price that disagrees with the receipt is reported, not resolved', async () => {
  // A price before the goods arrive is new — until now the only price was the one on the receipt.
  // When they differ that is worth someone's attention, so it is surfaced rather than one silently
  // overwriting the other.
  run(`INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, unit_price, delivery_date)
       VALUES ('G-7001', ?, ?, 'Compressor Belt', 2, 2000, '2026-08-09')`, MRN, L_HQ);
  const r = await api('hq', `/purchasing/lines/${L_HQ}`);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.price_check, 'invoice said 3400, the receipt says 4000 — that should not pass in silence');
  assert.strictEqual(r.body.price_check.invoice, 3400);
  assert.strictEqual(r.body.price_check.received, 4000);
  assert.strictEqual(r.body.price_check.difference, 600);
});

test('matching prices raise nothing', async () => {
  run('UPDATE grn SET unit_price = 1700 WHERE mrn_line_id = ?', L_HQ);
  const r = await api('hq', `/purchasing/lines/${L_HQ}`);
  assert.strictEqual(r.body.price_check, null, 'a warning that fires when nothing is wrong gets ignored when something is');
});

// ---- the "new since I looked" badge ---------------------------------------

test('what is new is answered per person, not with a shared flag', async () => {
  // Two officers sharing one flag would clear each other's badge, and "what is new" is a different
  // question for each of them.
  const before = await api('loc', '/purchasing/queue?tab=to_buy');
  assert.ok(before.body.rows.every((r) => r.is_new), 'never looked before, so everything is new');

  assert.strictEqual((await api('loc', '/purchasing/seen', { method: 'POST' })).status, 200);
  const after = await api('loc', '/purchasing/queue?tab=to_buy');
  assert.ok(after.body.rows.every((r) => !r.is_new), 'seen now');

  const other = await api('hq', '/purchasing/queue?tab=to_buy');
  assert.ok(other.body.rows.every((r) => r.is_new),
    'the other officer has looked at nothing and their badge must be untouched');
});

test('the counts match the lists they label', async () => {
  const counts = await api('loc', '/purchasing/counts');
  const toBuy = await api('loc', '/purchasing/queue?tab=to_buy');
  const unassigned = await api('loc', '/purchasing/queue?tab=unassigned');
  assert.strictEqual(counts.body.to_buy, toBuy.body.rows.length);
  assert.strictEqual(counts.body.unassigned, unassigned.body.rows.length);
});
