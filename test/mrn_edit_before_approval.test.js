'use strict';

// Correcting a material request before it is approved.
//
// A request goes requested → certified (Workshop Engineer) → approved (Operational Manager).
// It can be corrected right up until approval; after that it IS the authority to spend, so it
// is frozen and a change means a new request.
//
// The rule that matters: editing a CERTIFIED request withdraws that certification. The
// engineer signed for particular items and quantities — leaving the signature attached to
// different ones would make the record say something nobody agreed to.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-mrn-edit-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();

for (const n of ['admin', 'storekeeper', 'workshop', 'operational_manager']) run('INSERT INTO roles (name) VALUES (?)', n);
const mkUser = (name, roles) => {
  const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', name, auth.hashPassword('pw')).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
  return uid;
};
mkUser('sk', ['storekeeper']);
mkUser('eng', ['workshop']);
mkUser('om', ['operational_manager']);

const app = require('../src/server');
let server; let base;
let SK; let ENG; let OM;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
  // One hook: `base` has to exist before anyone can log in.
  SK = await login('sk'); ENG = await login('eng'); OM = await login('om');
});
test.after(() => server && server.close());

const login = async (u) => {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: u, password: 'pw' }),
  });
  return (r.headers.get('set-cookie') || '').split(';')[0];
};
const api = async (cookie, p, opts = {}) => {
  const r = await fetch(base + '/api' + p, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const ASSET = require('../src/lib/aliases').findOrCreateAsset('MR-01', {}).id;

// A fresh request, raised the way the app raises them.
const newMrn = async (no) => {
  const r = await api(SK, '/stores/mrn', { method: 'POST', body: {
    mrn_no: no, asset_id: ASSET, requested_by: 'Storekeeper', purpose: 'repair',
    lines: [{ description: 'Fuel Filter (FC-1503)', qty: 4, unit: 'nos' },
      { description: 'Oil Filter (C-206)', qty: 2, unit: 'nos' }],
  } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.mrn ? r.body.mrn.id : r.body.id;
};

test('an un-certified request can be corrected', async () => {
  const id = await newMrn('E-1');
  const r = await api(SK, '/stores/mrn/' + id, { method: 'PATCH', body: { purpose: 'service, not repair', requested_by: 'K. Perera' } });
  assert.strictEqual(r.status, 200);
  const m = get('SELECT purpose, requested_by FROM mrn WHERE id = ?', id);
  assert.strictEqual(m.purpose, 'service, not repair');
  assert.strictEqual(m.requested_by, 'K. Perera');
  assert.ok(!r.body.recertification_required, 'nothing was certified, so nothing was withdrawn');
});

test('an item’s description and quantity can be corrected', async () => {
  const id = await newMrn('E-2');
  const line = get('SELECT id FROM mrn_lines WHERE mrn_id = ? ORDER BY id LIMIT 1', id);
  const r = await api(SK, '/stores/mrn/line/' + line.id, { method: 'PATCH', body: { description: 'Fuel Filter (FC-1801)', qty: 6 } });
  assert.strictEqual(r.status, 200);
  const l = get('SELECT description, qty FROM mrn_lines WHERE id = ?', line.id);
  assert.strictEqual(l.description, 'Fuel Filter (FC-1801)');
  assert.strictEqual(l.qty, 6);
});

test('an item can be added and removed before approval', async () => {
  const id = await newMrn('E-3');
  const add = await api(SK, '/stores/mrn/' + id + '/lines', { method: 'POST', body: { description: 'Air Filter', qty: 1 } });
  assert.strictEqual(add.status, 201);
  assert.strictEqual(get('SELECT COUNT(*) c FROM mrn_lines WHERE mrn_id = ?', id).c, 3);

  const del = await api(SK, '/stores/mrn/line/' + add.body.id, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(get('SELECT COUNT(*) c FROM mrn_lines WHERE mrn_id = ?', id).c, 2);
});

test('editing a CERTIFIED request withdraws the certification', async () => {
  const id = await newMrn('E-4');
  const c = await api(ENG, '/stores/mrn/' + id + '/certify', { method: 'POST', body: {} });
  assert.strictEqual(c.status, 200);
  assert.strictEqual(get('SELECT approval_status FROM mrn WHERE id = ?', id).approval_status, 'certified');

  const line = get('SELECT id FROM mrn_lines WHERE mrn_id = ? ORDER BY id LIMIT 1', id);
  const r = await api(SK, '/stores/mrn/line/' + line.id, { method: 'PATCH', body: { qty: 99 } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.recertification_required, 'the caller is told');

  const m = get('SELECT approval_status, certified_by, certified_at, certified_sig FROM mrn WHERE id = ?', id);
  assert.strictEqual(m.approval_status, 'requested', 'back to awaiting certification');
  assert.strictEqual(m.certified_by, null);
  assert.strictEqual(m.certified_at, null);
  assert.strictEqual(m.certified_sig, null);

  // And the withdrawal is on the record, not silent.
  const trail = get(`SELECT * FROM mrn_approvals WHERE mrn_id = ? ORDER BY id DESC LIMIT 1`, id);
  assert.strictEqual(trail.decision, 'rejected');
  assert.match(trail.reason, /certification withdrawn/);
});

test('changing only the purchase source does NOT withdraw a certification', async () => {
  // Where it is bought is a routing detail — it is not what the engineer signed for.
  const id = await newMrn('E-5');
  await api(ENG, '/stores/mrn/' + id + '/certify', { method: 'POST', body: {} });
  const r = await api(SK, '/stores/mrn/' + id, { method: 'PATCH', body: { purchase_source: 'local_purchase' } });
  assert.strictEqual(r.status, 200);
  assert.ok(!r.body.recertification_required);
  assert.strictEqual(get('SELECT approval_status FROM mrn WHERE id = ?', id).approval_status, 'certified');
});

test('an APPROVED request is frozen', async () => {
  const id = await newMrn('E-6');
  await api(ENG, '/stores/mrn/' + id + '/certify', { method: 'POST', body: {} });
  await api(OM, '/stores/mrn/' + id + '/approve', { method: 'POST', body: {} });
  assert.strictEqual(get('SELECT approval_status FROM mrn WHERE id = ?', id).approval_status, 'approved');

  const line = get('SELECT id FROM mrn_lines WHERE mrn_id = ? ORDER BY id LIMIT 1', id);
  for (const [what, call] of [
    ['header', () => api(SK, '/stores/mrn/' + id, { method: 'PATCH', body: { purpose: 'changed' } })],
    ['line', () => api(SK, '/stores/mrn/line/' + line.id, { method: 'PATCH', body: { qty: 50 } })],
    ['add', () => api(SK, '/stores/mrn/' + id + '/lines', { method: 'POST', body: { description: 'X', qty: 1 } })],
    ['delete', () => api(SK, '/stores/mrn/line/' + line.id, { method: 'DELETE' })],
  ]) {
    const r = await call();
    assert.strictEqual(r.status, 409, `${what} should be refused on an approved request`);
    assert.match(r.body.error, /approved/i);
  }
  assert.strictEqual(get('SELECT purpose FROM mrn WHERE id = ?', id).purpose, 'repair', 'nothing changed');
});

test('a quantity cannot drop below what has already been received', async () => {
  const id = await newMrn('E-7');
  const line = get('SELECT id FROM mrn_lines WHERE mrn_id = ? ORDER BY id LIMIT 1', id);
  await api(SK, '/stores/grn/bulk-receive', { method: 'POST', body: { rows: [{ mrn_line_id: line.id, qty: 3 }] } });

  const bad = await api(SK, '/stores/mrn/line/' + line.id, { method: 'PATCH', body: { qty: 1 } });
  assert.strictEqual(bad.status, 409);
  assert.match(bad.body.error, /already received/);
  assert.strictEqual(get('SELECT qty FROM mrn_lines WHERE id = ?', line.id).qty, 4, 'left as it was');

  const ok = await api(SK, '/stores/mrn/line/' + line.id, { method: 'PATCH', body: { qty: 5 } });
  assert.strictEqual(ok.status, 200, 'but it can still be raised');
});

test('an item that has been part-received cannot be removed', async () => {
  const id = await newMrn('E-8');
  const line = get('SELECT id FROM mrn_lines WHERE mrn_id = ? ORDER BY id LIMIT 1', id);
  await api(SK, '/stores/grn/bulk-receive', { method: 'POST', body: { rows: [{ mrn_line_id: line.id, qty: 1 }] } });
  const r = await api(SK, '/stores/mrn/line/' + line.id, { method: 'DELETE' });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /already received/);
});

test('a request is never emptied of every item', async () => {
  const id = await newMrn('E-9');
  const lines = require('../src/db').all('SELECT id FROM mrn_lines WHERE mrn_id = ? ORDER BY id', id);
  const first = await api(SK, '/stores/mrn/line/' + lines[0].id, { method: 'DELETE' });
  assert.strictEqual(first.status, 200);
  const last = await api(SK, '/stores/mrn/line/' + lines[1].id, { method: 'DELETE' });
  assert.strictEqual(last.status, 409, 'the last item stays — reject the request instead');
  assert.match(last.body.error, /at least one item/);
});

test('every correction is on the audit trail', async () => {
  const id = await newMrn('E-10');
  await api(SK, '/stores/mrn/' + id, { method: 'PATCH', body: { purpose: 'audited change' } });
  const a = get(`SELECT * FROM audit_log WHERE entity = 'mrn' AND action = 'update' ORDER BY id DESC LIMIT 1`);
  assert.ok(a, 'recorded');
  assert.match(a.before_json, /repair/);
  assert.match(a.after_json, /audited change/);
});

// ---- an admin may add to an approved request -------------------------------
//
// An approved request IS the authority to spend, so it is frozen. But a forgotten item on a
// request already being received against is a real situation, and raising a second request for
// one line helps nobody — so an admin may put it on, and only an admin.
//
// The approval is NOT withdrawn: 17 of the 25 approved requests in the live book already have
// goods coming in, and un-approving them would stop that. Instead the LINE carries the mark —
// who added it, when, and why — on the screen, on the printed form and on the approval trail.
// An override without a reason is just a hole, so the reason is required.

let ADMIN;
test('an approved request refuses a new item from a storekeeper', async () => {
  const id = await newMrn('E-20');
  await api(ENG, '/stores/mrn/' + id + '/certify', { method: 'POST', body: {} });
  await api(OM, '/stores/mrn/' + id + '/approve', { method: 'POST', body: {} });
  const r = await api(SK, '/stores/mrn/' + id + '/lines', { method: 'POST', body: { description: 'Late item', qty: 1 } });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /approved/i);
  assert.strictEqual(get('SELECT COUNT(*) c FROM mrn_lines WHERE mrn_id = ?', id).c, 2, 'nothing added');
});

test('an admin can, but must say why', async () => {
  mkUser('boss', ['admin']);
  ADMIN = await login('boss');
  const id = await newMrn('E-21');
  await api(ENG, '/stores/mrn/' + id + '/certify', { method: 'POST', body: {} });
  await api(OM, '/stores/mrn/' + id + '/approve', { method: 'POST', body: {} });

  const noReason = await api(ADMIN, '/stores/mrn/' + id + '/lines', { method: 'POST', body: { description: 'Late item', qty: 2 } });
  assert.strictEqual(noReason.status, 400);
  assert.match(noReason.body.error, /why/i);
  assert.strictEqual(get('SELECT COUNT(*) c FROM mrn_lines WHERE mrn_id = ?', id).c, 2, 'refused, nothing written');

  const ok = await api(ADMIN, '/stores/mrn/' + id + '/lines', {
    method: 'POST', body: { description: 'Late item', qty: 2, reason: 'missed off the original — same job' } });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(get('SELECT COUNT(*) c FROM mrn_lines WHERE mrn_id = ?', id).c, 3);
});

test('the added item carries the mark, and the others do not', () => {
  const mrnId = get(`SELECT id FROM mrn WHERE mrn_no = 'E-21'`).id;
  const added = get(`SELECT * FROM mrn_lines WHERE mrn_id = ? AND description = 'Late item'`, mrnId);
  assert.strictEqual(added.added_after_approval, 1);
  assert.strictEqual(added.added_by, 'boss');
  assert.match(added.added_reason, /missed off the original/);
  assert.ok(added.added_at, 'and when');
  const original = get(`SELECT * FROM mrn_lines WHERE mrn_id = ? AND description <> 'Late item' LIMIT 1`, mrnId);
  assert.strictEqual(original.added_after_approval, 0, 'the items that WERE approved are not marked');
});

test('the approval still stands, so receiving is not interrupted', () => {
  const m = get(`SELECT approval_status, approved_by FROM mrn WHERE mrn_no = 'E-21'`);
  assert.strictEqual(m.approval_status, 'approved');
  assert.ok(m.approved_by, 'the signature is untouched');
});

test('the approval trail records that the request grew after signing', () => {
  const mrnId = get(`SELECT id FROM mrn WHERE mrn_no = 'E-21'`).id;
  const a = get(`SELECT * FROM mrn_approvals WHERE mrn_id = ? AND stage = 'amend' ORDER BY id DESC LIMIT 1`, mrnId);
  assert.ok(a, 'it is on the approval record, not only in the audit log');
  assert.strictEqual(a.signed_name, 'boss');
  assert.match(a.reason, /item added after approval: Late item x2/);
});

test('the printed form shows the mark', async () => {
  const mrnId = get(`SELECT id FROM mrn WHERE mrn_no = 'E-21'`).id;
  const r = await fetch(`${base}/api/stores/mrn/${mrnId}/print.html`, { headers: { cookie: ADMIN } });
  const html = await r.text();
  assert.match(html, /ADDED AFTER APPROVAL/, 'whoever reads the paper has to see it was not part of what was approved');
  assert.match(html, /boss/);
});

test('adding before approval is unchanged — no mark, and it still un-certifies', async () => {
  const id = await newMrn('E-22');
  await api(ENG, '/stores/mrn/' + id + '/certify', { method: 'POST', body: {} });
  const r = await api(SK, '/stores/mrn/' + id + '/lines', { method: 'POST', body: { description: 'Ordinary addition', qty: 1 } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(get(`SELECT added_after_approval a FROM mrn_lines WHERE id = ?`, r.body.id).a, 0);
  assert.strictEqual(get('SELECT approval_status s FROM mrn WHERE id = ?', id).s, 'requested',
    'the storekeeper route is exactly as it was');
});

// ---- imported records are settled too --------------------------------------
//
// 1,651 of the 1,709 requests in the live book came in with the import and carry no requester,
// so the app shows them as "approved (imported)" and nobody was able to add an item to one —
// even though many are live work (166782 is still part-received with an outstanding line).
// An admin can, on the same terms as an approved request.

const importedMrn = (no) => {
  const id = run(`INSERT INTO mrn (mrn_no, req_date, asset_id, status, approval_status, requested_by)
                  VALUES (?, '2026-08-07', ?, 'partially_received', 'requested', NULL)`, no, ASSET).lastInsertRowid;
  run(`INSERT INTO mrn_lines (mrn_id, description, qty, unit) VALUES (?, 'Ignition Switch', 1, 'nos')`, id);
  return id;
};

test('a storekeeper cannot add to an imported record', async () => {
  const id = importedMrn('E-30');
  const r = await api(SK, '/stores/mrn/' + id + '/lines', { method: 'POST', body: { description: 'Rear Tay Light Cup', qty: 2 } });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /only an admin/i);
  assert.strictEqual(get('SELECT COUNT(*) c FROM mrn_lines WHERE mrn_id = ?', id).c, 1);
});

test('an admin can, with a reason, and it keeps the same MRN number', async () => {
  const id = importedMrn('E-31');
  const noReason = await api(ADMIN, '/stores/mrn/' + id + '/lines', { method: 'POST', body: { description: 'Rear Tay Light Cup', qty: 2 } });
  assert.strictEqual(noReason.status, 400);

  const r = await api(ADMIN, '/stores/mrn/' + id + '/lines', {
    method: 'POST', body: { description: 'Rear Tay Light Cup', qty: 2, reason: 'left off when the request was filed' } });
  assert.strictEqual(r.status, 201);
  const lines = require('../src/db').all('SELECT description, added_after_approval, added_by FROM mrn_lines WHERE mrn_id = ? ORDER BY id', id);
  assert.strictEqual(lines.length, 2, 'on the same request, not a new one');
  assert.strictEqual(lines[0].added_after_approval, 0, 'the original line is untouched');
  assert.strictEqual(lines[1].added_after_approval, 1);
  assert.strictEqual(lines[1].added_by, 'boss');
  assert.strictEqual(get('SELECT mrn_no FROM mrn WHERE id = ?', id).mrn_no, 'E-31', 'same number');
});

test('an imported record is not turned into an approved one by the edit', () => {
  const m = get(`SELECT approval_status, requested_by, approved_by FROM mrn WHERE mrn_no = 'E-31'`);
  assert.strictEqual(m.approval_status, 'requested', 'it stays what it was');
  assert.strictEqual(m.requested_by, null);
  assert.strictEqual(m.approved_by, null, 'no signature is invented for it');
});

test('a request still moving through the workflow is unaffected', async () => {
  // Has a requester, so it is NOT imported: the storekeeper adds to it as always, no reason.
  const id = await newMrn('E-32');
  const r = await api(SK, '/stores/mrn/' + id + '/lines', { method: 'POST', body: { description: 'Ordinary', qty: 1 } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(get('SELECT added_after_approval a FROM mrn_lines WHERE id = ?', r.body.id).a, 0);
});
