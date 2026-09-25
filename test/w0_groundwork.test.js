'use strict';

// W0 groundwork (docs/WORKSHOPONE_PLAN.md §A.3):
//   1. one meaning of "open" and "not final", used everywhere;
//   2. one guard, jobstate.checkAdd(), on every path that adds to a job card — including the two
//      that used to let a request through on a CLOSED card (MRN, tyre/battery);
//   3. the review of stuck REQUESTED cards: suggestions only, a person applies, all-or-nothing.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-w0-'));
process.env.DB_PATH = path.join(TMP, 'w0.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const jobstate = require('../src/lib/jobstate');
const review = require('../src/lib/job_review');

migrate();
require('../src/migrate/015_phase4_erp_gaps').runStep();
require('../src/migrate/26_subcategories').runStep();
for (const n of ['admin', 'storekeeper', 'workshop', 'viewer']) run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
// A custom role that may log daily work but not change closed cards.
run("INSERT INTO roles (name, label) VALUES ('dw_clerk', 'Daily work clerk')");
capabilities.setCapability('dw_clerk', 'dailywork.add', true);
capabilities.setCapability('dw_clerk', 'dailywork.edit', true);
run("INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES ('dw_clerk', 'dailywork', 'edit')");

const PW = 'ember-harbour-quarry';
function mkUser(username, roles) {
  const id = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', username, auth.hashPassword(PW)).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
mkUser('boss', ['admin']);
mkUser('ws', ['workshop']);
mkUser('clerk', ['dw_clerk']);

const asset = (code, status = 'active') => run('INSERT INTO assets (code, code_norm, status, in_register) VALUES (?, ?, ?, 1)', code, code.replace(/\W/g, ''), status).lastInsertRowid;
const job = (no, assetId, status, extra = {}) => run(
  `INSERT INTO job_cards (job_no, asset_id, type, description, status, is_historical, requested_at, legacy_ref)
   VALUES (?, ?, 'repair', ?, ?, ?, COALESCE(?, datetime('now')), ?)`,
  no, assetId, extra.description || 'test', status, extra.imported ? 1 : 0, extra.requested_at || null, extra.legacy_ref || null).lastInsertRowid;

const vOpen = asset('TST-OPEN');
const vClosed = asset('TST-CLOSED');
const openJob = job('2026/9/R/901', vOpen, 'IN_PROGRESS');
const closedJob = job('2026/8/R/902', vClosed, 'CLOSED');

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
  if (!cookies[user]) cookies[user] = (await req('POST', '/api/auth/login', { body: { username: user, password: PW } })).cookie;
  return cookies[user];
}

// ---------------------------------------------------------------- one meaning of "open"
test('"open" and "not final" come from one place', () => {
  // They part company at partial close (W2): a PARTIALLY_CLOSED card no longer holds its vehicle,
  // but is not finished with either.
  assert.strictEqual(jobstate.openSql('j'), "j.status NOT IN ('PARTIALLY_CLOSED', 'CLOSED', 'REJECTED')");
  assert.strictEqual(jobstate.notFinalSql(), "status NOT IN ('CLOSED', 'REJECTED')");
  assert.ok(jobstate.isOpen('REQUESTED') && jobstate.isOpen('WORK_COMPLETE') && !jobstate.isOpen('CLOSED'));
  assert.ok(!jobstate.isOpen('PARTIALLY_CLOSED') && !jobstate.isFinal('PARTIALLY_CLOSED'));
  assert.ok(jobstate.isFinal('REJECTED') && !jobstate.isFinal('IN_PROGRESS'));
});

test('no file writes its own definition of an open card any more', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(__dirname, '..', 'src')).filter((x) => x.endsWith('.js') && !x.endsWith('jobstate.js'))) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/NOT IN \('CLOSED', ?'REJECTED'\)/.test(src), `${path.basename(f)} has its own open-card SQL — use jobstate.openSql / notFinalSql`);
    assert.ok(!/status !== 'CLOSED' && [\w.]*status !== 'REJECTED'/.test(src), `${path.basename(f)} has its own open-card test — use jobstate.isOpen`);
  }
});

test('every query that now uses the helpers still runs', async () => {
  const c = await as('boss');
  for (const p of ['/api/reports/dashboard', '/api/reports/ongoing-jobs.html', '/api/reports/daily-progress?date=2026-09-24',
    '/api/assets', `/api/assets/${vOpen}`, '/api/dashboard/overview', '/api/jobs?open=1', '/api/jobs']) {
    const r = await req('GET', p, { cookie: c });
    assert.strictEqual(r.status, 200, `${p}: ${r.text.slice(0, 200)}`);
  }
});

// ---------------------------------------------------------------- the one guard
test('checkAdd: what a finished card allows, kind by kind', () => {
  const closed = { job_no: 'X', status: 'CLOSED' };
  const rejected = { job_no: 'X', status: 'REJECTED' };
  const storekeeper = { roles: ['storekeeper'] };
  const viewer = { roles: ['viewer'] };
  for (const kind of ['mrn', 'tb_request']) {
    assert.strictEqual(jobstate.checkAdd(closed, kind, { user: storekeeper }).status, 409, `${kind} refused on CLOSED`);
    assert.strictEqual(jobstate.checkAdd(rejected, kind, { user: storekeeper }).status, 409, `${kind} refused on REJECTED`);
    assert.ok(!jobstate.checkAdd(closed, kind, { user: { roles: ['admin'] }, allowClosed: true }).ok, `${kind}: no confirmation or permission gets past it`);
  }
  for (const kind of ['daily_work', 'part', 'price', 'attach', 'edit']) {
    assert.ok(jobstate.checkAdd(closed, kind, { user: storekeeper }).ok, `${kind}: jobs.edit_closed may`);
    assert.strictEqual(jobstate.checkAdd(closed, kind, { user: viewer }).status, 423, `${kind}: others may not`);
    assert.ok(jobstate.checkAdd(rejected, kind, { user: viewer }).ok, `${kind}: a REJECTED card stays editable, as before`);
  }
  for (const kind of ['issue', 'general']) {
    assert.strictEqual(jobstate.checkAdd(closed, kind).body.needs_confirm, true);
    assert.ok(jobstate.checkAdd(closed, kind, { allowClosed: true }).ok);
  }
  for (const kind of Object.keys(jobstate.ADD_RULES)) assert.ok(jobstate.checkAdd({ status: 'IN_PROGRESS' }, kind).ok, `${kind} on an open card`);
  assert.throws(() => jobstate.checkAdd(closed, 'nonsense'), /unknown kind/);
});

test('a new MRN, an MRN line or a tyre/battery request on a CLOSED card is refused — even for an admin', async () => {
  const c = await as('boss');
  const onClosed = await req('POST', '/api/stores/mrn', { cookie: c, body: { asset_id: vClosed, job_id: closedJob, lines: [{ description: 'Filter', qty: 1 }] } });
  assert.strictEqual(onClosed.status, 409, onClosed.text);
  assert.match(onClosed.body.error, /is CLOSED\. Reopen it/);
  assert.ok(!onClosed.body.needs_confirm, 'not something to confirm past');
  const forced = await req('POST', '/api/stores/mrn', { cookie: c, body: { asset_id: vClosed, job_id: closedJob, allow_closed: true, lines: [{ description: 'Filter', qty: 1 }] } });
  assert.strictEqual(forced.status, 409);
  const onOpen = await req('POST', '/api/stores/mrn', { cookie: c, body: { asset_id: vOpen, job_id: openJob, lines: [{ description: 'Filter', qty: 1 }] } });
  assert.ok(onOpen.status < 300, onOpen.text);

  // An MRN raised while the card was open; the card is closed later; adding a line asks for more.
  const mrnId = onOpen.body.mrn.id;
  run("UPDATE job_cards SET status = 'CLOSED' WHERE id = ?", openJob);
  const line = await req('POST', `/api/stores/mrn/${mrnId}/lines`, { cookie: c, body: { description: 'Gasket', qty: 1 } });
  assert.strictEqual(line.status, 409, line.text);
  run("UPDATE job_cards SET status = 'IN_PROGRESS' WHERE id = ?", openJob);

  const tb = await req('POST', '/api/tb/requests', { cookie: c, body: { kind: 'tyre', job_id: closedJob, lines: [{ qty: 1 }] } });
  assert.strictEqual(tb.status, 409, tb.text);
});

test('a late stores issue on a closed card still needs the confirmation, exactly as before', async () => {
  const c = await as('boss');
  const r = await req('POST', '/api/stores/issues', { cookie: c, body: { job_id: closedJob, description: 'Head Lamp', qty: 1, unit_price: 1200 } });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.needs_confirm, true);
  const ok = await req('POST', '/api/stores/issues', { cookie: c, body: { job_id: closedJob, description: 'Head Lamp', qty: 1, unit_price: 1200, allow_closed: true } });
  assert.ok(ok.status < 300, ok.text);
  const si = await req('POST', '/api/stores/stock-issue', { cookie: c, body: { job_id: closedJob, issue_date: '2026-09-01', lines: [{ description: 'x', qty: 1 }] } });
  assert.strictEqual(si.status, 409);
  assert.strictEqual(si.body.needs_confirm, true);
});

test('a general-item transaction onto a job checks the job exists, and asks before a closed one', async () => {
  const c = await as('boss');
  const item = run("INSERT INTO store_items (name, balance) VALUES ('Cotton waste', 50)").lastInsertRowid;
  assert.strictEqual((await req('POST', `/api/stores/items/${item}/txn`, { cookie: c, body: { txn_type: 'issue', qty: 1, job_id: 999999 } })).status, 400);
  const r = await req('POST', `/api/stores/items/${item}/txn`, { cookie: c, body: { txn_type: 'issue', qty: 1, job_id: closedJob } });
  assert.strictEqual(r.body.needs_confirm, true);
  assert.ok((await req('POST', `/api/stores/items/${item}/txn`, { cookie: c, body: { txn_type: 'issue', qty: 1, job_id: openJob } })).status < 300);
});

test('Daily Work follows the job card\'s rule: a closed card needs "Change items on a CLOSED job card"', async () => {
  const clerk = await as('clerk');
  const ws = await as('ws');
  const body = { work_date: '2026-09-02', job_id: closedJob, mechanic: 'Anura', hours: 2, description: 'late entry' };
  const refused = await req('POST', '/api/daily-work', { cookie: clerk, body });
  assert.strictEqual(refused.status, 423, 'a role without it cannot add to a closed card from the Daily Work page either');
  const allowed = await req('POST', '/api/daily-work', { cookie: ws, body });
  assert.strictEqual(allowed.status, 201, `workshop holds it, so nothing changed for them: ${allowed.text}`);
  const edit = await req('PATCH', `/api/daily-work/${allowed.body.id}`, { cookie: clerk, body: { hours: 3 } });
  assert.strictEqual(edit.status, 423);
  const batch = await req('POST', '/api/daily-work/batch-update', { cookie: clerk, body: { updates: [{ id: allowed.body.id, hours: 3 }] } });
  assert.strictEqual(batch.status, 423, 'a batch touching a closed card is refused whole');
  assert.strictEqual(get('SELECT hours h FROM job_daily_work WHERE id = ?', allowed.body.id).h, 2);
  const onOpen = await req('POST', '/api/daily-work', { cookie: clerk, body: { ...body, job_id: openJob } });
  assert.strictEqual(onOpen.status, 201, onOpen.text);
});

// ---------------------------------------------------------------- stuck REQUESTED cards
const vA = asset('TST-A', 'under_repair');
const vB = asset('TST-B', 'under_repair');
const vC = asset('TST-C');
const vD = asset('TST-D');
// imported, no activity: numbered 2023, stamped with the import day
const rReject = job('2023/3/R/58', vA, 'REQUESTED', { imported: true, requested_at: '2026-07-16 10:00:00' });
// imported, work recorded long ago
const rClose = job('2023/4/R/101', vB, 'REQUESTED', { imported: true, requested_at: '2026-07-16 10:00:00' });
run("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours) VALUES (?, '2024-05-10', 'Anura', 3)", rClose);
job('2026/9/R/903', vB, 'IN_PROGRESS');   // the same vehicle has another open card
// live and recent
const rKeep = job('2026/9/R/904', vC, 'REQUESTED');
// imported, but touched recently
const rRecent = job('2023/5/R/200', vD, 'REQUESTED', { imported: true, requested_at: '2026-07-16 10:00:00' });
run("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours) VALUES (?, date('now', '-10 day'), 'Anura', 1)", rRecent);
// the general workshop container
job('GENERAL-WS-TEST', null, 'REQUESTED', { legacy_ref: 'general-workshop' });

test('the review suggests, from the right dates, and leaves containers out', () => {
  const r = review.listStuck();
  const by = Object.fromEntries(r.cards.map((x) => [x.id, x]));
  assert.ok(!r.cards.some((x) => x.job_no === 'GENERAL-WS-TEST'), 'the general workshop card is not "stuck"');
  assert.strictEqual(by[rReject].suggestion, 'reject');
  assert.strictEqual(by[rReject].preselected, true);
  assert.strictEqual(by[rReject].period, '2023-03-01', 'an imported card is dated by its number, not the import day');
  assert.strictEqual(by[rClose].suggestion, 'close');
  assert.strictEqual(by[rClose].preselected, false, 'closing puts it in a cost report — never pre-ticked');
  assert.strictEqual(by[rClose].close_date, '2024-05-10');
  assert.strictEqual(by[rClose].report_month, '2024-05');
  assert.strictEqual(by[rKeep].suggestion, 'keep');
  assert.strictEqual(by[rRecent].suggestion, 'keep', 'touched in the last 90 days');
});

test('only someone allowed can see or apply it', async () => {
  assert.strictEqual((await req('GET', '/api/jobs/review/stuck', { cookie: await as('ws') })).status, 403);
  assert.strictEqual((await req('POST', '/api/jobs/review/apply', { cookie: await as('ws'), body: { actions: [], reason: 'x' } })).status, 403);
});

test('applying is all-or-nothing, needs a reason, and touches only REQUESTED cards', async () => {
  const c = await as('boss');
  const noReason = await req('POST', '/api/jobs/review/apply', { cookie: c, body: { actions: [{ job_id: rReject, action: 'reject' }], reason: '' } });
  assert.strictEqual(noReason.status, 400);
  const mixed = await req('POST', '/api/jobs/review/apply', { cookie: c, body: {
    reason: 'clean-up', actions: [{ job_id: rReject, action: 'reject' }, { job_id: openJob, action: 'reject' }] } });
  assert.strictEqual(mixed.status, 400);
  assert.match(mixed.body.error, /Nothing was changed/);
  assert.strictEqual(get('SELECT status s FROM job_cards WHERE id = ?', rReject).s, 'REQUESTED', 'the valid one was not applied either');
});

test('reject and close do what they say — and the vehicle is free for a new card', async () => {
  const c = await as('boss');
  const r = await req('POST', '/api/jobs/review/apply', { cookie: c, body: {
    reason: 'Clean-up of old imported cards',
    actions: [{ job_id: rReject, action: 'reject' }, { job_id: rClose, action: 'close', close_date: '2024-05-10' }] } });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual([r.body.rejected, r.body.closed], [1, 1]);

  assert.strictEqual(get('SELECT status s FROM job_cards WHERE id = ?', rReject).s, 'REJECTED');
  const appr = get('SELECT role, reason FROM job_approvals WHERE job_id = ? AND decision = ?', rReject, 'rejected');
  assert.match(appr.reason, /Not carried out — Clean-up/);
  assert.strictEqual(appr.role, 'operational_manager', 'recorded like an ordinary reject by someone who approves operations');
  const closed = get('SELECT status, completed_at, closed_at FROM job_cards WHERE id = ?', rClose);
  assert.deepStrictEqual([closed.status, closed.completed_at, closed.closed_at], ['CLOSED', '2024-05-10', '2024-05-10'], 'the same as "close on date"');
  assert.ok(get('SELECT 1 x FROM job_costs WHERE job_id = ?', rClose), 'a cost snapshot, like every close');

  assert.strictEqual(get('SELECT status s FROM assets WHERE id = ?', vA).s, 'active', 'nothing else holds it: back in service');
  assert.strictEqual(get('SELECT status s FROM assets WHERE id = ?', vB).s, 'under_repair', 'it still has an open card');
  assert.ok(get("SELECT 1 x FROM audit_log WHERE action = 'review_reject' AND entity_id = ?", rReject));
  assert.ok(get("SELECT 1 x FROM audit_log WHERE action = 'review_close' AND entity_id = ?", rClose));

  const fresh = await req('POST', '/api/jobs', { cookie: c, body: { asset_id: vA, type: 'repair', description: 'New fault after the clean-up' } });
  assert.strictEqual(fresh.status, 201, `the vehicle is free: ${fresh.text}`);
});
