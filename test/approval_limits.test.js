'use strict';

// Approval limits (Stage 1) — the most money a role may sign off on its own
// (src/lib/approval_limits.js).
//
//   Set per role and per kind of approval on Access Control. No limit set = no limit, so nothing
//   changes until an amount is typed in. Above the limit the approval is refused and waits for
//   someone with a higher limit: an MRN's approval (its estimated value) and a job card's full
//   close (its total cost), on every path that does either.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-limits-'));
process.env.DB_PATH = path.join(TMP, 'limits.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const limits = require('../src/lib/approval_limits');
const closeLib = require('../src/lib/job_close');

migrate();
for (const n of ['admin', 'workshop', 'operational_manager', 'manager', 'storekeeper', 'transport_manager', 'viewer']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
// A custom role that may also approve MRNs, and one that manages access (for the settings rules).
const customRole = (name, label, caps) => {
  run('INSERT INTO roles (name, label) VALUES (?, ?)', name, label);
  for (const c of caps) run('INSERT INTO role_capabilities (role, capability, granted) VALUES (?, ?, 1)', name, c);
};
customRole('senior_approver', 'Senior Approver', ['stores.mrn.approve']);
customRole('deputy', 'Deputy', ['access.manage', 'stores.mrn.approve']);

const PW = 'ember-harbour-quarry';
function mkUser(username, roles) {
  const id = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', username, auth.hashPassword(PW)).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
run("INSERT INTO mechanics (name, name_norm) VALUES ('Anura', 'ANURA')");
run("INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Anura', 400, '2020-01-01')");
const U = {
  boss: mkUser('boss', ['admin']), ws: mkUser('ws', ['workshop']), om: mkUser('om', ['operational_manager']),
  mgr: mkUser('mgr', ['manager']), sk: mkUser('sk', ['storekeeper']),
  omv: mkUser('omv', ['operational_manager', 'viewer']),          // viewer gives no approval
  omm: mkUser('omm', ['operational_manager', 'manager']),         // manager: no limit
  oms: mkUser('oms', ['operational_manager', 'senior_approver']), // two limits: the higher counts
  dep: mkUser('dep', ['deputy']),
};
const userOf = (name) => ({ id: U[name], roles: auth.rolesForUser(U[name]) });

let seq = 0;
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const asset = (code) => run('INSERT INTO assets (code, code_norm, status, in_register) VALUES (?, ?, ?, 1)', code, code.replace(/\W/g, ''), 'under_repair').lastInsertRowid;
const job = (assetId, status = 'WORK_COMPLETE', cost = 5000) => {
  const id = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, is_historical, requested_at)
                  VALUES (?, ?, 'repair', 'test job', ?, 0, ?)`, `2024/9/R/${900 + (++seq)}`, assetId, status, day(-20)).lastInsertRowid;
  if (cost != null) run("INSERT INTO job_parts (job_id, source_type, description, qty, unit_price) VALUES (?, 'external', 'Seal kit', 1, ?)", id, cost);
  return id;
};
const J = (id) => get('SELECT * FROM job_cards WHERE id = ?', id);

// A store item with a price history, and a certified MRN asking for `qty` of it (certified by ws).
const ITEM = run("INSERT INTO store_items (name, unit_cost) VALUES ('Injector nozzle', 900)").lastInsertRowid;
run("INSERT INTO grn (grn_no, store_item_id, description, qty, unit_price) VALUES ('G-OLD', ?, 'Injector nozzle', 1, 1000)", ITEM);
run("INSERT INTO grn (grn_no, store_item_id, description, qty, unit_price) VALUES ('G-NEW', ?, 'Injector nozzle', 1, 1200)", ITEM);
function certifiedMrn(qty, extraLines = []) {
  const m = run("INSERT INTO mrn (mrn_no, requested_by, approval_status, certified_by) VALUES (?, 'sk', 'certified', 'ws')", 'L-' + (++seq)).lastInsertRowid;
  run("INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty) VALUES (?, ?, 'Injector nozzle', ?)", m, ITEM, qty);
  for (const l of extraLines) run('INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty) VALUES (?, ?, ?, ?)', m, l.item || null, l.description, l.qty);
  run("INSERT INTO mrn_approvals (mrn_id, stage, role, approver_id, decision) VALUES (?, 'certify', 'workshop', ?, 'approved')", m, U.ws);
  return m;
}
const setLimit = (role, kind, amount) => limits.setLimit(userOf('boss'), role, kind, amount);
const clearAll = () => run('DELETE FROM approval_limits');

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
        resolve({ status: res.statusCode, body: json, text: buf, cookie: sc ? sc[0].split(';')[0] : null });
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

// ================================================================== no limits: as before
test('no limit set (the default): big MRNs are approved and big jobs closed exactly as before', async () => {
  clearAll();
  assert.strictEqual(get('SELECT COUNT(*) n FROM approval_limits').n, 0, 'nothing is set until somebody sets it');
  const m = certifiedMrn(1000);   // Rs 1.2 million
  const r = await req('POST', `/api/stores/mrn/${m}/approve`, { cookie: await as('om'), body: {} });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(get('SELECT approval_status FROM mrn WHERE id = ?', m).approval_status, 'approved');

  const j = job(asset('NL-1'), 'WORK_COMPLETE', 2000000);
  const c = await req('POST', `/api/jobs/${j}/transition`, { cookie: await as('ws'), body: { to: 'CLOSED' } });
  assert.strictEqual(c.status, 200, c.text);
  assert.strictEqual(J(j).status, 'CLOSED');
  assert.strictEqual(limits.limitFor(userOf('om'), 'mrn_approve'), null);
});

// ================================================================== what an MRN is worth
test('an MRN is worth each line × the last price paid; lines with no price are counted, not guessed', () => {
  // Store item: its newest priced receipt (1,200), not the older one or its maintained cost.
  const lube = run("INSERT INTO products (code, name, unit_price) VALUES ('OIL-9', 'Hydraulic Oil 68', 850)").lastInsertRowid;
  assert.ok(lube);
  run("INSERT INTO grn (grn_no, description, qty, unit_price) VALUES ('G-D', 'Wiper blade', 2, 300)");
  const bare = run("INSERT INTO store_items (name, unit_cost) VALUES ('Fan belt', 0)").lastInsertRowid;
  run("INSERT INTO grn (grn_no, description, qty, unit_price) VALUES ('G-N', 'Fan belt', 1, 2500)"); // imported: no store_item_id
  const costOnly = run("INSERT INTO store_items (name, unit_cost) VALUES ('Air filter', 4000)").lastInsertRowid;
  const m = certifiedMrn(2, [
    { item: bare, description: 'Fan belt', qty: 1 },            // by the item's name: 2,500
    { item: costOnly, description: 'Air filter', qty: 1 },      // the item's maintained cost: 4,000
    { description: 'Hydraulic Oil 68', qty: 10 },               // the oil book: 8,500
    { description: 'wiper blade ', qty: 3 },                    // a receipt with the same description: 900
    { description: 'Something never bought', qty: 5 },          // no price anywhere
  ]);
  const w = limits.mrnValue(m);
  assert.deepStrictEqual(w.lines.map((l) => l.unit_price), [1200, 2500, 4000, 850, 300, null]);
  assert.strictEqual(w.value, 2 * 1200 + 2500 + 4000 + 8500 + 900);
  assert.strictEqual(w.unpriced, 1);

  // What was paid for this very line wins over everything else — even a newer receipt of the item.
  const lineId = w.lines[0].id;
  run('INSERT INTO grn (grn_no, mrn_id, mrn_line_id, store_item_id, description, qty, unit_price) VALUES (?, ?, ?, ?, ?, 1, 1500)',
    'G-OWN', m, lineId, ITEM, 'Injector nozzle');
  run("INSERT INTO grn (grn_no, store_item_id, description, qty, unit_price) VALUES ('G-NEWER', ?, 'Injector nozzle', 1, 1300)", ITEM);
  assert.strictEqual(limits.mrnValue(m).lines[0].unit_price, 1500);
  run("DELETE FROM grn WHERE grn_no IN ('G-OWN', 'G-NEWER')");   // the item's last price stays 1,200 below
});

// ================================================================== MRN approval
test('an MRN above the approver\'s limit is refused and waits for a higher limit; below it, approved', async () => {
  clearAll();
  setLimit('operational_manager', 'mrn_approve', 10000);
  const big = certifiedMrn(10);    // 12,000
  const small = certifiedMrn(5);   // 6,000
  const om = await as('om');

  const r = await req('POST', `/api/stores/mrn/${big}/approve`, { cookie: om, body: {} });
  assert.strictEqual(r.status, 403, r.text);
  assert.strictEqual(r.body.over_limit, true);
  assert.strictEqual(r.body.value, 12000);
  assert.strictEqual(r.body.limit, 10000);
  assert.match(r.body.error, /This MRN is worth about Rs 12,000\. Your limit is Rs 10,000\./);
  assert.ok(r.body.who_can.includes('Built-in manager') && r.body.who_can.includes('Admin'), JSON.stringify(r.body.who_can));
  assert.ok(!r.body.who_can.includes('Built-in operational_manager'));
  const after = get('SELECT approval_status, approved_by FROM mrn WHERE id = ?', big);
  assert.deepStrictEqual(after, { approval_status: 'certified', approved_by: null }, 'nothing written');
  assert.strictEqual(get("SELECT COUNT(*) n FROM mrn_approvals WHERE mrn_id = ? AND stage = 'approve'", big).n, 0);

  assert.strictEqual((await req('POST', `/api/stores/mrn/${small}/approve`, { cookie: om, body: {} })).status, 200);
  // Exactly at the limit is within it.
  const exact = certifiedMrn(0);
  run('UPDATE mrn_lines SET qty = ? WHERE mrn_id = ?', 10000 / 1200, exact);
  assert.strictEqual((await req('POST', `/api/stores/mrn/${exact}/approve`, { cookie: om, body: {} })).status, 200);

  // Someone with no limit approves the big one; so does the admin.
  assert.strictEqual((await req('POST', `/api/stores/mrn/${big}/approve`, { cookie: await as('mgr'), body: {} })).status, 200);
  const big2 = certifiedMrn(100);
  assert.strictEqual((await req('POST', `/api/stores/mrn/${big2}/approve`, { cookie: await as('boss'), body: {} })).status, 200);
});

test('several roles: only roles that give the approval count; any of them without a limit means no limit', () => {
  clearAll();
  setLimit('operational_manager', 'mrn_approve', 10000);
  setLimit('senior_approver', 'mrn_approve', 50000);
  // A viewer role with no limit set must not lift the manager's limit: it gives no approval.
  assert.strictEqual(limits.limitFor(userOf('omv'), 'mrn_approve'), 10000);
  // Manager gives the approval and has no limit.
  assert.strictEqual(limits.limitFor(userOf('omm'), 'mrn_approve'), null);
  // Two limits: the higher one.
  assert.strictEqual(limits.limitFor(userOf('oms'), 'mrn_approve'), 50000);
  // A retired role gives nothing — even to a session that still carries it — and approves nothing.
  run("UPDATE roles SET active = 0 WHERE name = 'senior_approver'");
  try {
    assert.strictEqual(limits.limitFor(userOf('oms'), 'mrn_approve'), 10000);
    assert.strictEqual(limits.limitFor({ id: U.oms, roles: ['operational_manager', 'senior_approver'] }, 'mrn_approve'), 10000);
    assert.ok(!limits.whoCan('mrn_approve', 20000).includes('Senior Approver'));
  } finally { run("UPDATE roles SET active = 1 WHERE name = 'senior_approver'"); }
  assert.ok(limits.whoCan('mrn_approve', 20000).includes('Senior Approver'));
  // Only roles somebody active holds are named.
  run("UPDATE users SET active = 0 WHERE id = ?", U.oms);
  try {
    assert.ok(!limits.whoCan('mrn_approve', 20000).includes('Senior Approver'));
  } finally { run("UPDATE users SET active = 1 WHERE id = ?", U.oms); }
  // Admin: never a limit, even with one set on another of their roles.
  assert.strictEqual(limits.limitFor({ id: 0, roles: ['admin', 'operational_manager'] }, 'mrn_approve'), null);
  // The kinds are separate.
  assert.strictEqual(limits.limitFor(userOf('om'), 'job_close'), null);
});

test('the approval queue and the MRN page show the value, and say when it is above your limit', async () => {
  clearAll();
  setLimit('operational_manager', 'mrn_approve', 10000);
  const big = certifiedMrn(20);   // 24,000
  const q = (await req('GET', '/api/reports/pending-approvals', { cookie: await as('om') })).body;
  const row = q.approve.find((x) => x.id === big);
  assert.ok(row, 'still in the queue');
  assert.strictEqual(row.value, 24000);
  assert.strictEqual(row.over_limit, true);
  assert.strictEqual(row.limit, 10000);
  const qm = (await req('GET', '/api/reports/pending-approvals', { cookie: await as('mgr') })).body;
  assert.strictEqual(qm.approve.find((x) => x.id === big).over_limit, false);

  const d = (await req('GET', `/api/stores/mrn/${big}`, { cookie: await as('om') })).body;
  assert.strictEqual(d.worth.value, 24000);
  assert.strictEqual(d.worth.limit.ok, false);
  const ds = (await req('GET', `/api/stores/mrn/${big}`, { cookie: await as('sk') })).body;
  assert.strictEqual(ds.worth, null, 'only for whoever approves');
});

// ================================================================== job close
test('closing a job fully above the limit is refused on every path; below it, closed', async () => {
  clearAll();
  setLimit('workshop', 'job_close', 10000);
  const ws = await as('ws');

  // One card.
  const big = job(asset('JC-1'), 'WORK_COMPLETE', 25000);
  const r = await req('POST', `/api/jobs/${big}/transition`, { cookie: ws, body: { to: 'CLOSED' } });
  assert.strictEqual(r.status, 403, r.text);
  assert.strictEqual(r.body.over_limit, true);
  assert.match(r.body.error, /This job costs Rs 25,000\. Your limit is Rs 10,000\. Someone with a higher limit must close it:/);
  assert.strictEqual(J(big).status, 'WORK_COMPLETE', 'not closed');
  const detail = (await req('GET', `/api/jobs/${big}`, { cookie: ws })).body;
  assert.strictEqual(detail.closeLimit.ok, false);
  assert.strictEqual(detail.closeLimit.value, 25000);

  // In bulk.
  const big2 = job(asset('JC-2'), 'WORK_COMPLETE', 30000);
  const small = job(asset('JC-3'), 'WORK_COMPLETE', 4000);
  const b = (await req('POST', '/api/jobs/bulk-transition', { cookie: ws, body: { ids: [big2, small], to: 'CLOSED' } })).body;
  assert.deepStrictEqual(b.succeeded.map((x) => x.id), [small]);
  assert.strictEqual(b.failed[0].id, big2);
  assert.strictEqual(b.failed[0].over_limit, true);
  assert.strictEqual(J(big2).status, 'WORK_COMPLETE');

  // On a chosen date.
  const cd = await req('POST', `/api/jobs/${big2}/close-on-date`, { cookie: ws, body: { date: day(-2) } });
  assert.strictEqual(cd.status, 403, cd.text);
  assert.strictEqual(J(big2).status, 'WORK_COMPLETE');

  // Someone with no limit for closing closes both.
  const om = await as('om');
  assert.strictEqual((await req('POST', `/api/jobs/${big}/transition`, { cookie: om, body: { to: 'CLOSED' } })).status, 200);
  assert.strictEqual((await req('POST', `/api/jobs/${big2}/close-on-date`, { cookie: om, body: { date: day(-2) } })).status, 200);
});

test('a partial close is not checked; closing it fully later is', async () => {
  clearAll();
  closeLib.setEnabled(true);
  try {
    setLimit('workshop', 'job_close', 10000);
    const ws = await as('ws');
    const v = asset('PC-1');
    const j = job(v, 'IN_PROGRESS', null);
    run("INSERT INTO job_parts (job_id, source_type, description, qty, unit_price) VALUES (?, 'external', 'Gearbox', 1, NULL)", j);
    run("INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, ?, 'Anura', 'work', 3)", j, day(-3));
    const pc = await req('POST', `/api/jobs/${j}/partial-close`, { cookie: ws, body: { note: 'price to come' } });
    assert.strictEqual(pc.status, 200, pc.text);
    run('UPDATE job_parts SET unit_price = 40000 WHERE job_id = ?', j);
    const full = await req('POST', `/api/jobs/${j}/transition`, { cookie: ws, body: { to: 'CLOSED' } });
    assert.strictEqual(full.status, 403, full.text);
    assert.strictEqual(J(j).status, 'PARTIALLY_CLOSED');
    assert.strictEqual((await req('POST', `/api/jobs/${j}/transition`, { cookie: await as('om'), body: { to: 'CLOSED' } })).status, 200);
  } finally { closeLib.setEnabled(false); }
});

test('the stuck-card clean-up refuses a close above the person\'s limit, and changes nothing', () => {
  clearAll();
  setLimit('workshop', 'job_close', 10000);
  const review = require('../src/lib/job_review');
  const cheap = job(asset('TR-1'), 'REQUESTED', 500);
  const dear = job(asset('TR-2'), 'REQUESTED', 60000);
  assert.throws(() => review.applyReview(
    [{ job_id: cheap, action: 'close', close_date: day(-30) }, { job_id: dear, action: 'close', close_date: day(-30) }],
    { userId: U.ws, user: userOf('ws'), reason: 'finished long ago' }),
  (e) => e.status === 400 && /costs Rs 60,000, above your limit of Rs 10,000/.test(e.message));
  assert.strictEqual(J(cheap).status, 'REQUESTED', 'all or nothing');
  const done = review.applyReview([{ job_id: dear, action: 'close', close_date: day(-30) }],
    { userId: U.boss, user: userOf('boss'), reason: 'finished long ago' });
  assert.strictEqual(done.closed, 1);
});

// ================================================================== the settings
test('the settings screen: lists the roles that give each approval; admin sets and clears, audited', async () => {
  clearAll();
  const boss = await as('boss');
  const s = (await req('GET', '/api/access/approval-limits', { cookie: boss })).body;
  assert.deepStrictEqual(s.kinds.map((k) => k.key), ['mrn_approve', 'job_close']);
  const om = s.roles.find((r) => r.name === 'operational_manager');
  assert.deepStrictEqual(om.gives, { mrn_approve: true, job_close: true });
  assert.deepStrictEqual(om.limits, {});
  assert.ok(!s.roles.some((r) => r.name === 'viewer'), 'a role that gives no approval has nothing to limit');
  assert.ok(!s.roles.some((r) => r.name === 'admin'), 'admin never has a limit');
  assert.strictEqual(s.roles.find((r) => r.name === 'storekeeper'), undefined);

  const put = (body, who = boss) => req('PUT', '/api/access/approval-limits', { cookie: who, body });
  const mark = get('SELECT COALESCE(MAX(id), 0) n FROM audit_log').n;
  const set = await put({ role: 'operational_manager', kind: 'mrn_approve', max_amount: '150,000' });
  assert.strictEqual(set.status, 200, set.text);
  assert.strictEqual(set.body.roles.find((r) => r.name === 'operational_manager').limits.mrn_approve, 150000);
  assert.strictEqual((await put({ role: 'operational_manager', kind: 'mrn_approve', max_amount: '' })).status, 200);
  assert.strictEqual(get("SELECT COUNT(*) n FROM approval_limits WHERE role = 'operational_manager'").n, 0, 'empty = no limit');
  const trail = all("SELECT action, before_json, after_json FROM audit_log WHERE entity = 'approval_limit' AND id > ? ORDER BY id", mark);
  assert.deepStrictEqual(trail.map((t) => t.action), ['set', 'clear']);
  assert.strictEqual(JSON.parse(trail[0].after_json).max_amount, 150000);
  assert.strictEqual(JSON.parse(trail[1].before_json).max_amount, 150000);

  assert.strictEqual((await put({ role: 'admin', kind: 'mrn_approve', max_amount: 5 })).status, 400);
  assert.strictEqual((await put({ role: 'operational_manager', kind: 'mrn_approve', max_amount: -1 })).status, 400);
  assert.strictEqual((await put({ role: 'operational_manager', kind: 'mrn_approve', max_amount: 'lots' })).status, 400);
  assert.strictEqual((await put({ role: 'operational_manager', kind: 'fuel', max_amount: 5 })).status, 400);
  assert.strictEqual((await put({ role: 'nobody', kind: 'mrn_approve', max_amount: 5 })).status, 404);
  // Nobody without Access Control may read or change them.
  assert.strictEqual((await req('GET', '/api/access/approval-limits', { cookie: await as('om') })).status, 403);
  assert.strictEqual((await put({ role: 'workshop', kind: 'job_close', max_amount: 1 }, await as('om'))).status, 403);
});

test('someone who manages access but is not an admin: not their own role, not above their own limit', async () => {
  clearAll();
  setLimit('deputy', 'mrn_approve', 20000);
  const dep = await as('dep');
  const put = (body) => req('PUT', '/api/access/approval-limits', { cookie: dep, body });
  assert.strictEqual((await put({ role: 'operational_manager', kind: 'mrn_approve', max_amount: 15000 })).status, 200);
  const above = await put({ role: 'operational_manager', kind: 'mrn_approve', max_amount: 25000 });
  assert.strictEqual(above.status, 403);
  assert.match(above.body.error, /up to your own \(Rs 20,000\)/);
  assert.strictEqual((await put({ role: 'operational_manager', kind: 'mrn_approve', max_amount: '' })).status, 403, 'no limit is above any limit');
  const own = await put({ role: 'deputy', kind: 'mrn_approve', max_amount: 1000000 });
  assert.strictEqual(own.status, 403);
  assert.match(own.body.error, /your own role/);
  assert.strictEqual(get("SELECT max_amount FROM approval_limits WHERE role = 'operational_manager' AND kind = 'mrn_approve'").max_amount, 15000);
  // Only for approvals they give themselves: they close no jobs.
  const other = await put({ role: 'workshop', kind: 'job_close', max_amount: 99999999 });
  assert.strictEqual(other.status, 403);
  assert.match(other.body.error, /approvals you give yourself/);
});
