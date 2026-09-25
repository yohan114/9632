'use strict';

// Job cards plan, Part 2 — Ongoing: every card in the workshop, attended or not (src/lib/jobs_flow.js).
//
//   A card is attended on a day with a daily-work line (JC-D3). Not worked on today, it has gone that
//   many working days without work — Sundays do not count — 1–2 amber, 3 or more red (JC-D4). No work
//   yet: not started, counted from its approval. "Waiting for parts" comes from the Stores list: any
//   part requested for the card not yet issued (JC-D6). Any other reason a supervisor gives; red cards
//   with none come first (JC-D5). A reason stays until work is recorded again, then it is history.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-jp2-'));
process.env.DB_PATH = path.join(TMP, 'jp2.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const workshops = require('../src/lib/workshops');
const scope = require('../src/lib/scope');
const flow = require('../src/lib/jobs_flow');

migrate();
for (const n of ['admin', 'workshop', 'manager', 'storekeeper', 'operational_manager', 'transport_manager', 'assistant_transport_manager']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
require('../src/lib/capabilities').seedCapabilities();
require('../src/lib/permissions').seedDefaults();
const CW = workshops.defaultId();
const MTR = run("INSERT INTO workshops (code, name) VALUES ('MTR', 'Muthur Workshop')").lastInsertRowid;
const PW = 'copper-lantern-gravel';
function mkUser(username, roles, ws = CW, fullName = null) {
  const id = run('INSERT INTO users (username, password_hash, active, workshop_id, full_name) VALUES (?, ?, 1, ?, ?)',
    username, auth.hashPassword(PW), ws, fullName).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const U = { boss: mkUser('boss', ['admin']), ws: mkUser('ws', ['workshop'], CW, 'Kamal Supervisor'), wsM: mkUser('wsM', ['workshop'], MTR),
  sk: mkUser('sk', ['storekeeper']), om: mkUser('om', ['operational_manager']) };

// Dates: today, and N working days back (Sundays skipped) — counted here the long way round.
const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const TODAY = iso(new Date());
const wd = (n) => { const d = new Date(); let k = 0; while (k < n) { d.setDate(d.getDate() - 1); if (d.getDay() !== 0) k++; } return iso(d); };
const cal = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const YM = `${new Date().getFullYear()}/${new Date().getMonth() + 1}`;

let seq = 0;
const asset = (code) => run('INSERT INTO assets (code, code_norm, status, in_register) VALUES (?, ?, ?, 1)', code, code.replace(/\W/g, ''), 'active').lastInsertRowid;
function card(desc, { status = 'IN_PROGRESS', ws = CW, approved = cal(10), historical = 0, legacy = null, field = 0, type = 'repair', noAsset = false } = {}) {
  const no = `${YM}/R/${++seq}`;
  const id = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at, approved_ops_at, workshop_id, is_historical, legacy_ref, field)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, no, noAsset ? null : asset('V-' + seq), type, desc, status, cal(20), approved, ws, historical, legacy, field).lastInsertRowid;
  return id;
}
const work = (job, date, mechanic, hours = 2) => run('INSERT INTO job_daily_work (job_id, work_date, mechanic, hours) VALUES (?, ?, ?, ?)', job, date, mechanic, hours);
const reason = (job, code, at, note = null) => run('INSERT INTO job_hold_reasons (job_id, reason, note, set_by, set_at) VALUES (?, ?, ?, ?, ?)', job, code, note, U.om, at + ' 09:00:00');
const no = (id) => get('SELECT job_no FROM job_cards WHERE id = ?', id).job_no;

// ---- the workshop ---------------------------------------------------------------------------------
const A = card('Worked on today'); work(A, wd(2), 'Anura', 3); work(A, TODAY, 'Anura', 4); work(A, TODAY, 'Sunil', 2);
const B = card('Two days without work'); work(B, wd(4), 'Ravi', 1); work(B, wd(2), 'Kamal', 5);
const C = card('Red, waiting for parts'); work(C, wd(5), 'Kamal', 1);
const D = card('Red, nobody said why'); work(D, wd(4), 'Anura', 1);
const E = card('Not started for long', { status: 'IN_WORKSHOP', approved: wd(6) });
const F = card('Not started, just approved', { status: 'APPROVED_OPERATIONS', approved: TODAY });
const G = card('Red, with a reason'); work(G, wd(3), 'Sunil', 2); reason(G, 'outside_repair', wd(1), 'Pump sent out');
const H = card('Reason given, then worked, now idle'); reason(H, 'waiting_mechanic', wd(10)); work(H, wd(4), 'Kamal', 1);
const I = card('Field job worked today', { field: 1 }); work(I, TODAY, 'Ravi', 6);
// Never in the list: work done, imported, a holder card, another workshop's (while kept apart, below).
const DONE = card('Work done', { status: 'WORK_COMPLETE' });
card('Imported in progress', { historical: 1 });
card('Stores materials holder', { noAsset: true, legacy: 'general-workshop' });
const M = card('Muthur card', { ws: MTR }); work(M, TODAY, 'Nimal', 3);

// Parts for C: two not yet issued (one to buy, one received and on the shelf), one issued, one on a rejected request.
const mrn = (status = 'approved', job = C) => run(`INSERT INTO mrn (mrn_no, req_date, requested_by, approval_status, job_id, workshop_id, request_type)
                                                  VALUES (?, ?, 'Kamal', ?, ?, ?, 'vehicle')`, 'MRN-' + (++seq), cal(6), status, job, CW).lastInsertRowid;
const M1 = mrn();
const L1 = run("INSERT INTO mrn_lines (mrn_id, description, qty, qty_received) VALUES (?, 'Clutch plate', 1, 0)", M1).lastInsertRowid;
const L2 = run("INSERT INTO mrn_lines (mrn_id, description, qty, qty_received) VALUES (?, 'Oil seal', 2, 2)", M1).lastInsertRowid;
const L3 = run("INSERT INTO mrn_lines (mrn_id, description, qty, qty_received) VALUES (?, 'Gasket', 1, 1)", M1).lastInsertRowid;
const G3 = run("INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, unit_price, delivery_date) VALUES ('G-1', ?, ?, 'Gasket', 1, 500, ?)", M1, L3, cal(3)).lastInsertRowid;
run("INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, unit_price, delivery_date) VALUES ('G-2', ?, ?, 'Oil seal', 2, 300, ?)", M1, L2, cal(3));
run("INSERT INTO issues (job_id, grn_id, description, qty, unit_price, issue_date) VALUES (?, ?, 'Gasket', 1, 500, ?)", C, G3, cal(2));
run("INSERT INTO mrn_lines (mrn_id, description, qty, qty_received) VALUES (?, 'Rejected bearing', 1, 0)", mrn('rejected'));

// ---- the server -----------------------------------------------------------------------------------
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
        resolve({ status: res.statusCode, body: json, text: buf, type: res.headers['content-type'] });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const cookies = {};
async function as(user) {
  if (!cookies[user]) {
    cookies[user] = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ username: user, password: PW });
      const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/login',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.headers['set-cookie'][0].split(';')[0]));
      });
      q.on('error', reject); q.write(data); q.end();
    });
  }
  return cookies[user];
}
const call = async (user, method, p, body) => req(method, '/api' + p, { cookie: await as(user), body });
const ok = (r, status = 200) => { assert.strictEqual(r.status, status, r.text); return r.body; };
const ongoing = async (user, qs = '') => ok(await call(user, 'GET', '/job-flow/ongoing' + qs));
const byId = (rows, id) => rows.find((r) => r.id === id);

// ================================================================== the rule
test('working days: Sundays do not count', () => {
  assert.strictEqual(flow.workingDays('2026-09-19', '2026-09-21'), 1, 'Saturday to Monday: the Monday');
  assert.strictEqual(flow.workingDays('2026-09-20', '2026-09-21'), 1, 'from a Sunday');
  assert.strictEqual(flow.workingDays('2026-09-21', '2026-09-21'), 0);
  assert.strictEqual(flow.workingDays('2026-09-22', '2026-09-21'), 0, 'never negative');
  assert.strictEqual(flow.workingDays('2026-09-14', '2026-09-21'), 6, 'a week');
  assert.strictEqual(flow.workingDays('2026-09-01', '2026-09-22'), 18, 'three weeks, three Sundays');
  assert.strictEqual(flow.workingDays('2026-09-19', '2026-09-20'), 0, 'Saturday to Sunday');
});

test('attended today, amber, red, not started', () => {
  const s = (r) => { const x = flow.attendedState(r, TODAY); return [x.state, x.idle]; };
  assert.deepStrictEqual(s({ last_work: TODAY }), ['today', 0]);
  assert.deepStrictEqual(s({ last_work: wd(1) }), ['amber', 1]);
  assert.deepStrictEqual(s({ last_work: wd(2) }), ['amber', 2]);
  assert.deepStrictEqual(s({ last_work: wd(3) }), ['red', 3]);
  assert.deepStrictEqual(s({ last_work: null, approved_ops_at: wd(5) + ' 08:00:00', requested_at: cal(30) }), ['not_started', 5]);
  assert.deepStrictEqual(s({ last_work: null, approved_ops_at: null, started_at: null, requested_at: wd(2) }), ['not_started', 2]);
  // Worked on Saturday, looked at on Sunday: not today, so at least a day.
  assert.deepStrictEqual(flow.attendedState({ last_work: '2026-09-19' }, '2026-09-20'), { state: 'amber', idle: 1 });
});

// ================================================================== the list
test('every card in the workshop, red ones with no reason first', async () => {
  const d = await ongoing('boss');
  assert.deepStrictEqual(d.rows.map((r) => [r.job_no, r.state, r.idle, r.needs_reason]), [
    [no(E), 'not_started', 6, true],
    ...[[no(D), 'red', 4, true], [no(H), 'red', 4, true]].sort((a, b) => (a[0] > b[0] ? 1 : -1)),
    [no(C), 'red', 5, false],
    [no(G), 'red', 3, false],
    [no(B), 'amber', 2, false],
    [no(F), 'not_started', 0, false],
    ...[[no(A), 'today', 0, false], [no(I), 'today', 0, false], [no(M), 'today', 0, false]].sort((a, b) => (a[0] > b[0] ? 1 : -1)),
  ]);
  assert.ok(!d.rows.some((r) => r.id === DONE), 'work done is not ongoing');
  assert.deepStrictEqual(d.counts, { all: 10, today: 3, idle: 5, amber: 1, red: 4, not_started: 2, parts: 1, no_reason: 3, field: 1 });
});

test('each row: who worked, when last, hours, parts from Stores, the reason now', async () => {
  const rows = (await ongoing('boss')).rows;
  const a = byId(rows, A);
  assert.deepStrictEqual([a.today_mechanics.split(',').sort(), a.hours, a.last_worked, a.reason, a.can.reason], [['Anura', 'Sunil'], 9, TODAY, null, false],
    'worked today: nothing to explain');
  const b = byId(rows, B);
  assert.deepStrictEqual([b.last_worked, b.last_mechanics, b.today_mechanics, b.can.reason], [wd(2), 'Kamal', null, true]);
  const c = byId(rows, C);
  assert.deepStrictEqual(c.parts.lines.map((l) => [l.description, l.step]), [['Clutch plate', 'to_buy'], ['Oil seal', 'ready']],
    'not issued yet: to buy, and received but not handed over — not the issued gasket, not the rejected bearing');
  assert.strictEqual(c.parts.waiting, 2);
  assert.strictEqual(c.reason, null);
  const g = byId(rows, G);
  assert.deepStrictEqual([g.reason.code, g.reason.label, g.reason.note], ['outside_repair', 'Outside repair', 'Pump sent out']);
  assert.strictEqual(byId(rows, H).reason, null, 'a reason from before the last work is history');
  assert.deepStrictEqual(byId(rows, E).road.map((m) => m.state).slice(2, 4), ['done', 'now']);
});

test('the filters', async () => {
  const ids = async (qs) => (await ongoing('boss', qs)).rows.map((r) => r.id).sort((x, y) => x - y);
  assert.deepStrictEqual(await ids('?show=today'), [A, I, M].sort((x, y) => x - y));
  assert.deepStrictEqual(await ids('?show=idle'), [B, C, D, G, H].sort((x, y) => x - y));
  assert.deepStrictEqual(await ids('?show=red'), [C, D, G, H].sort((x, y) => x - y));
  assert.deepStrictEqual(await ids('?show=not_started'), [E, F].sort((x, y) => x - y));
  assert.deepStrictEqual(await ids('?show=parts'), [C]);
  assert.deepStrictEqual(await ids('?show=no_reason'), [D, E, H].sort((x, y) => x - y));
  assert.deepStrictEqual(await ids('?show=field'), [I]);
  assert.deepStrictEqual(await ids('?q=' + encodeURIComponent('nobody said')), [D]);
  assert.deepStrictEqual(await ids('?show=red&q=' + encodeURIComponent('with a reason')), [G]);
  assert.deepStrictEqual(await ids('?type=service'), []);
  assert.strictEqual((await ongoing('boss', '?show=nonsense')).rows.length, 10);
  assert.strictEqual((await ongoing('boss', '?q=zzz')).counts.all, 10, 'the counts are the whole workshop, not the search');
});

// ================================================================== saying why
test('saying why: from the list, kept on the card, gone from the list once work starts again', async () => {
  refusedWith(await call('sk', 'POST', `/job-flow/jobs/${D}/reason`, { reason: 'waiting_mechanic' }), 403);
  refusedWith(await call('ws', 'POST', `/job-flow/jobs/${D}/reason`, { reason: 'lunch' }), 400, /Choose a reason/);
  refusedWith(await call('ws', 'POST', `/job-flow/jobs/${D}/reason`, { reason: 'other' }), 400, /Say what the reason is/);
  refusedWith(await call('ws', 'POST', `/job-flow/jobs/${DONE}/reason`, { reason: 'waiting_mechanic' }), 409, /not in the workshop/);
  const a = ok(await call('ws', 'POST', `/job-flow/jobs/${D}/reason`, { reason: 'other', note: 'Mechanic on leave' }), 201);
  assert.deepStrictEqual([a.reason.code, a.reason.note, a.reason.set_by, a.needs_reason], ['other', 'Mechanic on leave', 'Kamal Supervisor', false]);
  assert.strictEqual(get("SELECT COUNT(*) n FROM audit_log WHERE entity = 'job_card' AND entity_id = ? AND action = 'hold_reason'", D).n, 1);
  assert.strictEqual((await ongoing('boss')).counts.no_reason, 2);
  // On the card's own page: the reason now, and every reason given.
  const card = ok(await call('ws', 'GET', `/jobs/${D}`)).attended;
  assert.deepStrictEqual([card.ongoing, card.state, card.reason.label, card.history.length], [true, 'red', 'Other', 1]);
  // Work again: the reason is history, not the reason now.
  work(D, TODAY, 'Anura', 1);
  const again = byId((await ongoing('boss')).rows, D);
  assert.deepStrictEqual([again.state, again.reason], ['today', null]);
  assert.strictEqual(ok(await call('ws', 'GET', `/jobs/${D}`)).attended.history[0].note, 'Mechanic on leave');
  // A card no longer in the workshop keeps its history, and is not "ongoing".
  run('INSERT INTO job_hold_reasons (job_id, reason, set_by) VALUES (?, ?, ?)', DONE, 'waiting_decision', U.om);
  assert.deepStrictEqual(ok(await call('ws', 'GET', `/jobs/${DONE}`)).attended, { ongoing: false, history: [{ code: 'waiting_decision', label: 'Waiting for a decision', note: null, set_at: get('SELECT set_at FROM job_hold_reasons WHERE job_id = ?', DONE).set_at, set_by: 'om' }] });
});
function refusedWith(r, status, re) { assert.strictEqual(r.status, status, r.text); if (re) assert.match(r.body.error, re); }

// ================================================================== the Monitor
test('the Monitor: the Ongoing counts, and mechanics present on no job', async () => {
  let m = ok(await call('boss', 'GET', '/job-flow/monitor'));
  assert.deepStrictEqual(m.workshop, { all: 10, not_started: 2, worked_today: 4, idle_1_2: 1, idle_3: 3, waiting_parts: 1, no_reason: 2, idle_mechanics: null },
    'attendance off: not known');
  require('../src/lib/attendance').saveSettings({ enabled: true, start_date: cal(30) });
  const mech = (name) => run('INSERT INTO mechanics (name, name_norm, active) VALUES (?, ?, 1)', name, name.toUpperCase()).lastInsertRowid;
  const present = (id) => run("INSERT INTO mechanic_attendance (mechanic_id, work_date, time_in, time_out, status) VALUES (?, ?, '07:30', '16:30', 'present')", id, TODAY);
  present(mech('Anura'));          // booked on A today
  present(mech('Priyantha'));      // on no job
  run("INSERT INTO mechanic_attendance (mechanic_id, work_date, status) VALUES (?, ?, 'leave')", mech('Dilan'), TODAY);
  m = ok(await call('boss', 'GET', '/job-flow/monitor'));
  assert.strictEqual(m.workshop.idle_mechanics, 1);
  assert.strictEqual(ok(await call('sk', 'GET', '/job-flow/monitor')).workshop.idle_mechanics, null, 'only for whoever reads Daily Work');
  require('../src/lib/attendance').saveSettings({ enabled: false });
});

// ================================================================== store by store
test('with the workshops kept apart, each sees and explains its own', async () => {
  scope.setSwitch({ id: U.boss }, true);
  try {
    assert.ok(!(await ongoing('ws')).rows.some((r) => r.id === M));
    assert.deepStrictEqual((await ongoing('wsM')).rows.map((r) => r.id), [M]);
    refusedWith(await call('wsM', 'POST', `/job-flow/jobs/${B}/reason`, { reason: 'waiting_mechanic' }), 403);
    assert.strictEqual(ok(await call('wsM', 'GET', '/job-flow/monitor')).workshop.all, 1);
  } finally {
    scope.setSwitch({ id: U.boss }, false);
  }
});

// ================================================================== the report
test('the Ongoing jobs report says attended or not, and why', async () => {
  const h = await call('boss', 'GET', '/reports/ongoing-jobs.html');
  assert.strictEqual(h.status, 200);
  assert.match(h.text, /Not attended 2 days/);
  assert.match(h.text, /Waiting for parts \(2\)/);
  assert.match(h.text, /Outside repair: Pump sent out/);
  assert.match(h.text, /No reason given/);
  const x = await call('boss', 'GET', '/reports/ongoing-jobs.xlsx');
  assert.deepStrictEqual([x.status, /spreadsheetml/.test(x.type)], [200, true]);
});
