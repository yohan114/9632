'use strict';

// Improvement plan, Step 3a — the permission gaps on requests (plan §4.2).
//
//   - Whoever raised a request does not certify or approve it: someone else does. The admin is
//     exempt, as from the rule that the certifier does not also approve.
//   - What was certified is what gets approved. A request changed after it was certified — by any
//     route — goes back to be certified again instead of being approved.
//
// Both for material requests (MRN) and job requests.

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-step3a-'));
process.env.DB_PATH = path.join(TMP, 'step3a.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();
for (const n of ['admin', 'storekeeper', 'workshop', 'operational_manager', 'transport_manager', 'assistant_transport_manager']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
// The workshop role may raise a request, but sees Stores only to read by default: this gives the
// engineers the Stores access an admin gives a workshop that raises its own requests.
run("INSERT OR IGNORE INTO roles (name, label) VALUES ('stores_writer', 'Stores writer')");
run("INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES ('stores_writer', 'stores', 'full')");
const PW = 'lantern-cobalt-meadow';
const U = {};
const mkUser = (name, roles) => {
  U[name] = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', name, auth.hashPassword(PW)).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', U[name], r);
};
mkUser('boss', ['admin']);
mkUser('sk', ['storekeeper']);
mkUser('eng', ['workshop', 'stores_writer']);         // raises and certifies MRNs
mkUser('eng2', ['workshop', 'stores_writer']);
mkUser('om', ['operational_manager']);
mkUser('allin', ['workshop', 'operational_manager', 'stores_writer']); // may raise, certify and approve an MRN
mkUser('tam', ['assistant_transport_manager']);
mkUser('tm', ['transport_manager']);
mkUser('tmx', ['assistant_transport_manager', 'transport_manager', 'operational_manager']); // all three steps of a job request

const app = require('../src/server');
let server; let base;
const cookies = {};
test.before(async () => {
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const u of Object.keys(U)) {
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: PW }) });
    assert.strictEqual(r.status, 200, u);
    cookies[u] = (r.headers.get('set-cookie') || '').split(';')[0];
  }
});
test.after(() => server && server.close());
const call = async (who, method, p, body) => {
  const r = await fetch(base + '/api' + p, { method, headers: { 'content-type': 'application/json', cookie: cookies[who] }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const ASSET = require('../src/lib/aliases').findOrCreateAsset('RR-01', {}).id;
const PROJECT = run("INSERT INTO projects (code, name) VALUES ('P-3A', 'Step 3a project')").lastInsertRowid;
const JOB = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, is_historical, requested_at)
                 VALUES ('2026/10/R/3001', ?, 'repair', 'fault', 'IN_PROGRESS', 0, date('now'))`, ASSET).lastInsertRowid;
let seq = 0;
const newMrn = async (who) => {
  const r = await call(who, 'POST', '/stores/mrn', { mrn_no: `R3A-${++seq}`, asset_id: ASSET, purpose: 'repair',
    lines: [{ description: 'Fuel Filter', qty: 4, unit: 'nos' }, { description: 'Oil Filter', qty: 2, unit: 'nos' }] });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.mrn.id;
};
const mrn = (id) => get('SELECT * FROM mrn WHERE id = ?', id);
const newJr = async (who) => {
  const r = await call(who, 'POST', '/job-requests', { asset_id: ASSET, description: 'Brakes pulling left', type: 'repair' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.request.id;
};
const jr = (id) => get('SELECT * FROM job_requests WHERE id = ?', id);

// ================================================================== the database step
test('old requests take their raiser from the audit log; ones already certified are sealed as they stand', () => {
  const old = run("INSERT INTO mrn (mrn_no, req_date, requested_by, approval_status) VALUES ('OLD-1', date('now'), 'Kasun', 'requested')").lastInsertRowid;
  run("INSERT INTO audit_log (user_id, entity, entity_id, action) VALUES (?, 'mrn', ?, 'create')", U.eng, old);
  const imported = run("INSERT INTO mrn (mrn_no, req_date, approval_status) VALUES ('OLD-2', date('now'), 'requested')").lastInsertRowid;
  const certified = run("INSERT INTO mrn (mrn_no, req_date, requested_by, approval_status, certified_by) VALUES ('OLD-3', date('now'), 'Kasun', 'certified', 'Engineer')").lastInsertRowid;
  run("INSERT INTO mrn_lines (mrn_id, description, qty) VALUES (?, 'Hose', 1)", certified);
  const jrOld = run("INSERT INTO job_requests (jr_no, req_date, description, approval_status) VALUES ('JR-OLD', date('now'), 'Old fault', 'certified')").lastInsertRowid;
  migrate();   // runs again on every start; safe to repeat
  assert.strictEqual(mrn(old).raised_by_user, U.eng);
  assert.strictEqual(mrn(imported).raised_by_user, null, 'an imported request has no raiser, and the rule passes it by');
  assert.strictEqual(mrn(certified).certified_seal, require('../src/lib/request_rules').seal('mrn', certified));
  assert.ok(jr(jrOld).certified_seal);
  assert.strictEqual(mrn(old).certified_seal, null, 'only certified requests are sealed');
});

// ================================================================== material requests
test('an MRN records who raised it, and they cannot certify it; another engineer can', async () => {
  const id = await newMrn('eng');
  assert.strictEqual(mrn(id).raised_by_user, U.eng);
  const self = await call('eng', 'POST', `/stores/mrn/${id}/certify`, {});
  assert.strictEqual(self.status, 403);
  assert.strictEqual(self.body.error, 'You raised this request. Someone else must certify it.');
  assert.strictEqual(mrn(id).approval_status, 'requested');
  assert.strictEqual((await call('eng2', 'POST', `/stores/mrn/${id}/certify`, {})).status, 200);
  assert.strictEqual(mrn(id).certified_seal, require('../src/lib/request_rules').seal('mrn', id), 'sealed as certified');
  assert.strictEqual((await call('om', 'POST', `/stores/mrn/${id}/approve`, {})).status, 200);
});

test('whoever raised an MRN cannot approve it either', async () => {
  const id = await newMrn('allin');
  assert.strictEqual((await call('eng', 'POST', `/stores/mrn/${id}/certify`, {})).status, 200);
  const self = await call('allin', 'POST', `/stores/mrn/${id}/approve`, {});
  assert.strictEqual(self.status, 403);
  assert.strictEqual(self.body.error, 'You raised this request. Someone else must approve it.');
  assert.strictEqual(mrn(id).approval_status, 'certified');
  assert.strictEqual((await call('om', 'POST', `/stores/mrn/${id}/approve`, {})).status, 200);
});

test('the reorder button records who raised the request too', async () => {
  const r = await call('sk', 'POST', '/stock-cockpit/create-reorder-mrn', { items: [{ name: 'Shop Rag', qty: 5 }] });
  assert.ok(r.status < 300, JSON.stringify(r.body));
  assert.strictEqual(get('SELECT raised_by_user u FROM mrn ORDER BY id DESC LIMIT 1').u, U.sk);
});

test('the admin is exempt: raises, certifies and approves', async () => {
  const id = await newMrn('boss');
  assert.strictEqual((await call('boss', 'POST', `/stores/mrn/${id}/certify`, {})).status, 200);
  assert.strictEqual((await call('boss', 'POST', `/stores/mrn/${id}/approve`, {})).status, 200);
});

test('an MRN changed after it was certified, by any route, goes back to be certified again', async () => {
  const id = await newMrn('sk');
  assert.strictEqual((await call('eng', 'POST', `/stores/mrn/${id}/certify`, {})).status, 200);
  // Not through the edit routes (they already withdraw the certification): straight into the table.
  run('UPDATE mrn_lines SET qty = 40 WHERE id = (SELECT MIN(id) FROM mrn_lines WHERE mrn_id = ?)', id);
  const r = await call('om', 'POST', `/stores/mrn/${id}/approve`, {});
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, 'This request was changed after it was certified. It must be certified again.');
  assert.strictEqual(r.body.recertification_required, true);
  const m = mrn(id);
  assert.deepStrictEqual([m.approval_status, m.certified_by, m.certified_seal], ['requested', null, null]);
  assert.match(get("SELECT reason FROM mrn_approvals WHERE mrn_id = ? ORDER BY id DESC LIMIT 1", id).reason, /certification withdrawn/);
  assert.ok(get("SELECT 1 x FROM audit_log WHERE entity = 'mrn' AND entity_id = ? AND reason LIKE 'certification withdrawn%'", id));
  // Certified again, as it now stands: approved.
  assert.strictEqual((await call('eng', 'POST', `/stores/mrn/${id}/certify`, {})).status, 200);
  assert.strictEqual((await call('om', 'POST', `/stores/mrn/${id}/approve`, {})).status, 200);
  assert.strictEqual(mrn(id).approval_status, 'approved');
});

test('each part of what was asked for is in the seal; the vehicle, a category and buying details are not', async () => {
  const rules = require('../src/lib/request_rules');
  const id = await newMrn('sk');
  const line = get('SELECT MIN(id) id FROM mrn_lines WHERE mrn_id = ?', id).id;
  const before = rules.seal('mrn', id);
  const changes = [
    ['UPDATE mrn_lines SET description = ? WHERE id = ?', 'Air Filter', line], ['UPDATE mrn_lines SET qty = ? WHERE id = ?', 9, line],
    ['UPDATE mrn_lines SET unit = ? WHERE id = ?', 'set', line], ['UPDATE mrn SET purpose = ? WHERE id = ?', 'other', id],
    ['UPDATE mrn SET requested_by = ? WHERE id = ?', 'Someone', id], ['UPDATE mrn SET required_date = ? WHERE id = ?', '2030-01-01', id],
    ['UPDATE mrn SET req_date = ? WHERE id = ?', '2030-01-01', id], ['UPDATE mrn SET job_id = ? WHERE id = ?', JOB, id],
    ['UPDATE mrn SET project_id = ? WHERE id = ?', PROJECT, id]];
  for (const [sql, v, at] of changes) {
    const keep = get(`SELECT * FROM ${sql.includes('mrn_lines') ? 'mrn_lines' : 'mrn'} WHERE id = ?`, at);
    run(sql, v, at);
    assert.notStrictEqual(rules.seal('mrn', id), before, sql);
    const col = sql.match(/SET (\w+)/)[1];
    run(sql, keep[col], at);
    assert.strictEqual(rules.seal('mrn', id), before, 'and back: ' + sql);
  }
  run("INSERT INTO mrn_lines (mrn_id, description, qty) VALUES (?, 'Extra', 1)", id);
  assert.notStrictEqual(rules.seal('mrn', id), before, 'an item added');
  run("DELETE FROM mrn_lines WHERE mrn_id = ? AND description = 'Extra'", id);
  for (const [sql, v] of [['UPDATE mrn SET asset_id = ? WHERE id = ?', null], ['UPDATE mrn SET purchase_source = ? WHERE id = ?', 'LOCAL']]) run(sql, v, id);
  for (const [sql, v] of [['UPDATE mrn_lines SET category = ? WHERE id = ?', 'Filters'], ['UPDATE mrn_lines SET qty_received = ? WHERE id = ?', 1],
    ['UPDATE mrn_lines SET purchase_source = ? WHERE id = ?', 'LOCAL']]) run(sql, v, line);
  assert.strictEqual(rules.seal('mrn', id), before, 'merging vehicles or categories, buying and receiving do not change what was asked for');
  // So a request certified before those still approves.
  assert.strictEqual((await call('eng', 'POST', `/stores/mrn/${id}/certify`, {})).status, 200);
  run("UPDATE mrn_lines SET category = 'Hoses' WHERE id = ?", line);
  assert.strictEqual((await call('om', 'POST', `/stores/mrn/${id}/approve`, {})).status, 200);
});

// ================================================================== job requests
test('a job request: whoever raised it neither certifies nor approves it', async () => {
  const id = await newJr('tmx');
  assert.strictEqual(jr(id).requested_by_user, U.tmx);
  const c = await call('tmx', 'POST', `/job-requests/${id}/certify`, {});
  assert.strictEqual(c.status, 403);
  assert.strictEqual(c.body.error, 'You raised this request. Someone else must certify it.');
  assert.strictEqual((await call('tm', 'POST', `/job-requests/${id}/certify`, {})).status, 200);
  assert.strictEqual(jr(id).certified_seal, require('../src/lib/request_rules').seal('jr', id));
  const a = await call('tmx', 'POST', `/job-requests/${id}/approve`, {});
  assert.strictEqual(a.status, 403);
  assert.strictEqual(a.body.error, 'You raised this request. Someone else must approve it.');
  assert.strictEqual((await call('om', 'POST', `/job-requests/${id}/approve`, {})).status, 200);
});

test('a job request changed after it was certified goes back to be certified again', async () => {
  const id = await newJr('tam');
  assert.strictEqual((await call('tm', 'POST', `/job-requests/${id}/certify`, {})).status, 200);
  run("UPDATE job_requests SET description = 'Brakes and steering' WHERE id = ?", id);
  const r = await call('om', 'POST', `/job-requests/${id}/approve`, {});
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, 'This request was changed after it was certified. It must be certified again.');
  const j = jr(id);
  assert.deepStrictEqual([j.approval_status, j.certified_by, j.certified_seal], ['requested', null, null]);
  assert.match(get('SELECT reason FROM job_request_approvals WHERE job_request_id = ? ORDER BY id DESC LIMIT 1', id).reason, /certification withdrawn/);
  assert.ok(get("SELECT 1 x FROM audit_log WHERE entity = 'job_request' AND entity_id = ? AND reason LIKE 'certification withdrawn%'", id));
  assert.strictEqual((await call('tm', 'POST', `/job-requests/${id}/certify`, {})).status, 200);
  assert.strictEqual((await call('om', 'POST', `/job-requests/${id}/approve`, {})).status, 200);
});

test('the job request seal covers what was asked for, not the vehicle', () => {
  const rules = require('../src/lib/request_rules');
  const id = run("INSERT INTO job_requests (jr_no, req_date, description, type) VALUES ('JR-S1', '2026-10-01', 'Noise', 'repair')").lastInsertRowid;
  const before = rules.seal('jr', id);
  for (const [col, v] of [['description', 'Smoke'], ['type', 'service'], ['severity', 'major'], ['priority', 'urgent'], ['req_date', '2026-10-02'],
    ['required_date', '2026-10-09'], ['project_id', PROJECT], ['requested_by', 'Someone']]) {
    const keep = jr(id)[col];
    run(`UPDATE job_requests SET ${col} = ? WHERE id = ?`, v, id);
    assert.notStrictEqual(rules.seal('jr', id), before, col);
    run(`UPDATE job_requests SET ${col} = ? WHERE id = ?`, keep, id);
  }
  run('UPDATE job_requests SET asset_id = ? WHERE id = ?', ASSET, id);
  assert.strictEqual(rules.seal('jr', id), before, 'a vehicle merge does not stop an approval');
});

test('the job request list offers no Certify or Approve to whoever raised it, and says why', async () => {
  const id = await newJr('tmx');
  const row = async (who) => (await call(who, 'GET', '/job-flow/requests?step=to_certify')).body.rows.find((r) => r.id === id);
  const mine = await row('tmx');
  assert.strictEqual(mine.can.certify, false);
  assert.strictEqual(mine.note, 'You raised it — someone else certifies and approves.');
  assert.strictEqual((await row('tm')).can.certify, true);
  assert.strictEqual((await call('tm', 'POST', `/job-requests/${id}/certify`, {})).status, 200);
  const mine2 = (await call('tmx', 'GET', '/job-flow/requests?step=to_approve')).body.rows.find((r) => r.id === id);
  assert.strictEqual(mine2.can.approve, false);
  assert.strictEqual((await call('om', 'GET', '/job-flow/requests?step=to_approve')).body.rows.find((r) => r.id === id).can.approve, true);
});

test('the screens can tell whose request it is', async () => {
  const id = await newMrn('eng');
  const d = (await call('eng', 'GET', `/stores/mrn/${id}`)).body;
  assert.strictEqual(d.mrn.raised_by_user, U.eng);
  assert.ok((await call('eng', 'GET', '/stores/mrn?limit=500')).body.find((m) => m.id === id).raised_by_user === U.eng);
  const j = await newJr('tam');
  assert.strictEqual((await call('tam', 'GET', `/job-requests/${j}`)).body.request.requested_by_user, U.tam);
});
