'use strict';

// W1 — mechanic attendance and the daily tally (docs/WORKSHOPONE_PLAN.md §3.1, docs/W1_CLOUD_BRIEF.md).
//
//   Worked = (Out − In) − Break; out before in is an overnight shift; absent/leave/holiday = 0.
//   Booked = every daily-work line naming the mechanic, FULL hours each (hours are per person),
//            general workshop counted, external not.
//   The tally never changes labour cost, runs only from the start date, and does nothing while
//   switched off. A signed-off day locks its attendance and every daily-work write path.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-w1-'));
process.env.DB_PATH = path.join(TMP, 'w1.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const costing = require('../src/lib/costing');
const att = require('../src/lib/attendance');

migrate();
for (const n of ['admin', 'workshop', 'manager', 'operational_manager', 'viewer', 'storekeeper']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
// May log daily work, but has no attendance permission.
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
mkUser('mgr', ['manager']);
mkUser('om', ['operational_manager']);
mkUser('clerk', ['dw_clerk']);
mkUser('look', ['viewer']);
mkUser('sk', ['storekeeper']);          // Daily Work clearance: none

// ---- people and cards --------------------------------------------------------------------------
const mech = (name, active = 1) => run('INSERT INTO mechanics (name, name_norm, active) VALUES (?, ?, ?)', name, name.toUpperCase().replace(/[^A-Z0-9]/g, ''), active).lastInsertRowid;
const M = {
  govinda: mech('Govinda'), vinod: mech('Vinod'), anura: mech('Anura'),
  tk: mech('Theminda Krishna'), buddhika: mech('Buddhika'), sunil: mech('Sunil'), retired: mech('Old Timer', 0),
};
for (const [n, r] of [['Govinda', 300], ['Vinod', 250], ['Anura', 425], ['Theminda Krishna', 275], ['Buddhika', 350], ['Sunil', 260]]) {
  run("INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES (?, ?, '2020-01-01')", n, r);
}
const assetId = run("INSERT INTO assets (code, code_norm, status, in_register) VALUES ('AC-06', 'AC06', 'active', 1)").lastInsertRowid;
const J1 = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at)
                VALUES ('2026/9/R/700', ?, 'repair', 'gearbox', 'IN_PROGRESS', date('now', '-60 day'))`, assetId).lastInsertRowid;
const GWS = run(`INSERT INTO job_cards (job_no, type, description, status, legacy_ref)
                 VALUES ('GENERAL-WS', 'repair', 'General workshop daily work', 'REQUESTED', 'general-workshop')`).lastInsertRowid;
const line = (jobId, date, mechanic, hours, extra = {}) => run(
  `INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value)
   VALUES (?, ?, ?, ?, ?, ?, ?)`, jobId, date, mechanic, extra.description || 'work', hours, extra.external ? 1 : 0, extra.external_value || 0).lastInsertRowid;

// Every day is relative to today: attendance.record reaches today and yesterday only.
const T = att.today();
const day = (n) => att.addDays(T, n);
const START = day(-20);
att.saveSettings({ enabled: true, start_date: START });

const present = (id, date, time_in = '08:00', time_out = '17:00', break_minutes = 60) =>
  att.saveRows(date, [{ mechanic_id: id, status: 'present', time_in, time_out, break_minutes }], null);
const rowOf = (date, id) => att.day(date).rows.find((r) => r.mechanic_id === id);

// ---- HTTP ----------------------------------------------------------------------------------------
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

// ================================================================== how it is counted
test('worked = (out − in) − break; out before in is an overnight shift; off days are 0', () => {
  assert.strictEqual(att.workedMinutes({ status: 'present', time_in: '08:00', time_out: '17:00', break_minutes: 60 }), 480);
  assert.strictEqual(att.workedMinutes({ status: 'present', time_in: '22:00', time_out: '06:00', break_minutes: 30 }), 450, 'overnight');
  assert.strictEqual(att.workedMinutes({ status: 'half_day', time_in: '08:00', time_out: '12:00', break_minutes: 0 }), 240);
  for (const s of ['absent', 'leave', 'holiday']) assert.strictEqual(att.workedMinutes({ status: s, time_in: '08:00', time_out: '17:00' }), 0, s);
  assert.strictEqual(att.workedMinutes({ status: 'present', time_in: '08:00', time_out: null }), null, 'out not entered yet');
  assert.strictEqual(att.workedMinutes(null), null);
});

test('an overnight shift tallies against the work booked on the day it started', () => {
  const d = day(-19);
  present(M.sunil, d, '22:00', '06:00', 30);   // 7.5 h
  line(J1, d, 'Sunil', 7.5);
  const r = rowOf(d, M.sunil);
  assert.strictEqual(r.worked_hours, 7.5);
  assert.strictEqual(r.tally, 'matched');
});

test('a crew line counts its FULL hours for each named mechanic — never divided, never multiplied', () => {
  const d = day(-18);
  line(J1, d, 'Govinda, Vinod', 4);
  line(J1, d, 'Govinda & Vinod', 2);
  const g = rowOf(d, M.govinda); const v = rowOf(d, M.vinod);
  assert.strictEqual(g.booked_hours, 6);
  assert.strictEqual(v.booked_hours, 6);
  assert.strictEqual(g.lines.length, 2);
});

test('"Theminda Krishna" is one person, not two', () => {
  const d = day(-18);
  line(J1, d, 'Theminda Krishna', 3);
  assert.strictEqual(rowOf(d, M.tk).booked_hours, 3);
  assert.deepStrictEqual(att.day(d).unmatched, []);
});

test('general-workshop lines count as booked; external lines do not', () => {
  const d = day(-17);
  line(GWS, d, 'Anura', 2);
  line(J1, d, 'Anura', 3, { external: true, external_value: 5000 });
  line(J1, d, 'Anura', 1);
  assert.strictEqual(rowOf(d, M.anura).booked_hours, 3);
});

test('an unmatched name is listed, with its hours, and queued for the Alias Queue — not dropped', async () => {
  const d = day(-17);
  line(J1, d, 'Mystery Man', 3);
  const u = att.day(d).unmatched;
  assert.strictEqual(u.length, 1);
  assert.strictEqual(u[0].name, 'Mystery Man');
  assert.strictEqual(u[0].hours, 3);
  assert.strictEqual(u[0].lines[0].job_no, '2026/9/R/700');
  const r = await req('GET', `/api/attendance/day?date=${d}`, { cookie: await as('ws') });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.unmatched[0].name, 'Mystery Man');
  const q = get("SELECT resolved, hit_count FROM mechanic_aliases WHERE raw_norm = 'MYSTERYMAN'");
  assert.ok(q && q.resolved === 0, 'a pending alias somebody can link');
  await req('GET', `/api/attendance/day?date=${d}`, { cookie: await as('ws') });
  assert.strictEqual(get("SELECT hit_count FROM mechanic_aliases WHERE raw_norm = 'MYSTERYMAN'").hit_count, q.hit_count, 'queued once, not on every look');
});

test('the tolerance: exactly 15 minutes either way is still matched; a minute more is not', () => {
  const cases = [[7.75, 'matched'], [8.25, 'matched'], [8, 'matched'], [7.7, 'unbooked'], [8.3, 'over_booked']];
  cases.forEach(([booked, want], i) => {
    const d = day(-16 + i);
    present(M.buddhika, d);                // 8 h worked
    line(J1, d, 'Buddhika', booked);
    const r = rowOf(d, M.buddhika);
    assert.strictEqual(r.tally, want, `booked ${booked} h against 8 h worked`);
    assert.strictEqual(r.red, want === 'over_booked');
  });
});

test('no attendance, and absent with work, are red; nothing booked and nothing entered is not', () => {
  const d = day(-10);
  line(J1, d, 'Govinda', 5);
  att.saveRows(d, [{ mechanic_id: M.vinod, status: 'leave' }], null);
  line(J1, d, 'Vinod', 2);
  att.saveRows(d, [{ mechanic_id: M.anura, status: 'absent' }], null);
  att.saveRows(d, [{ mechanic_id: M.tk, status: 'present', time_in: '08:00' }], null);  // out not entered yet
  line(J1, d, 'Theminda Krishna', 1);
  const g = rowOf(d, M.govinda); const v = rowOf(d, M.vinod); const a = rowOf(d, M.anura); const tk = rowOf(d, M.tk);
  assert.deepStrictEqual([g.tally, g.red], ['no_attendance', true]);
  assert.deepStrictEqual([v.tally, v.red, v.worked_hours], ['absent_with_work', true, 0]);
  assert.deepStrictEqual([a.tally, a.red], ['off', false]);
  assert.deepStrictEqual([tk.tally, tk.red, tk.tally_label], ['no_attendance', true, 'In/out missing']);
  assert.deepStrictEqual([rowOf(d, M.sunil).tally, rowOf(d, M.sunil).red], ['not_entered', false]);
  assert.strictEqual(att.day(d).red_count, 3);
});

test('every active mechanic has a row; an inactive one appears only when they have something that day', () => {
  const d = day(-9);
  const names = () => att.day(d).rows.map((r) => r.name);
  assert.ok(names().includes('Sunil'));
  assert.ok(!names().includes('Old Timer'));
  line(J1, d, 'Old Timer', 2);
  assert.ok(names().includes('Old Timer'));
});

test('days before the start date are never flagged', () => {
  const d = day(-25);
  line(J1, d, 'Govinda', 9);
  line(J1, d, 'Govinda', 9);          // an imported duplicate
  const r = rowOf(d, M.govinda);
  assert.strictEqual(r.tally, 'before_start');
  assert.strictEqual(r.red, false);
  assert.strictEqual(att.day(d).red_count, 0);
  assert.strictEqual(r.booked_hours, 18, 'the numbers still show');
});

// ================================================================== labour cost does not move
test('recording attendance, signing off and unlocking never changes any job\'s labour cost', async () => {
  const d = day(-8);
  line(J1, d, 'Govinda, Vinod', 4);
  line(GWS, d, 'Anura', 3);
  require('../src/lib/mechanics').syncJobLabourForMonth(d.slice(0, 7));
  const snap = () => ({
    j1: costing.computeJobCost(J1),
    gws: costing.computeJobCost(GWS),
    labour: all('SELECT job_id, work_date, mechanic, hours, rate, amount FROM job_labour ORDER BY id'),
  });
  const before = snap();
  assert.strictEqual(before.j1.labour_cost > 0, true);
  const boss = await as('boss');
  const rows = Object.values(M).map((id) => ({ mechanic_id: id, status: 'present', time_in: '08:00', time_out: '17:00', break_minutes: 60 }));
  assert.strictEqual((await req('POST', '/api/attendance/day', { cookie: boss, body: { date: d, rows } })).status, 200);
  att.saveRows(d, [{ mechanic_id: M.govinda, time_out: '13:00' }, { mechanic_id: M.vinod, time_out: '13:00' }, { mechanic_id: M.anura, time_out: '12:00' }], null);
  for (const id of [M.sunil, M.buddhika, M.tk, M.retired]) att.saveRows(d, [{ mechanic_id: id, clear: true }], null);
  const so = await req('POST', '/api/attendance/day/signoff', { cookie: boss, body: { date: d } });
  assert.strictEqual(so.status, 200, so.text);
  assert.strictEqual((await req('POST', '/api/attendance/day/unlock', { cookie: boss, body: { date: d, reason: 'check' } })).status, 200);
  const after = snap();
  assert.deepStrictEqual(after.j1.labour_cost, before.j1.labour_cost);
  assert.deepStrictEqual(after.gws.labour_cost, before.gws.labour_cost);
  assert.ok(before.labour.length > 0);
  assert.deepStrictEqual(after.labour, before.labour);
  assert.strictEqual(before.j1.labour_cost >= 4 * 300 + 4 * 250, true, 'crew line: each mechanic is charged the full hours');
});

// ================================================================== sign-off, lock and unlock
test('sign-off is refused while anyone is red, and allowed once nobody is', async () => {
  const d = day(-7);
  line(J1, d, 'Govinda', 8);                          // no attendance → red
  const mgr = await as('mgr');
  const refused = await req('POST', '/api/attendance/day/signoff', { cookie: mgr, body: { date: d } });
  assert.strictEqual(refused.status, 409);
  assert.match(refused.body.error, /Govinda \(No attendance\)/);
  present(M.govinda, d);
  const ok = await req('POST', '/api/attendance/day/signoff', { cookie: mgr, body: { date: d } });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.strictEqual(ok.body.locked, true);
  assert.deepStrictEqual([ok.body.can.edit, ok.body.can.unlock], [false, true], 'the answer carries what this person may do next, for the screen');
  assert.ok(get("SELECT 1 x FROM audit_log WHERE entity = 'workday_signoff' AND action = 'signoff'"));
  const before = await req('POST', '/api/attendance/day/signoff', { cookie: mgr, body: { date: day(-30) } });
  assert.strictEqual(before.status, 409, 'not before the start date');
  const future = await req('POST', '/api/attendance/day/signoff', { cookie: mgr, body: { date: day(1) } });
  assert.strictEqual(future.status, 400, 'not a day that has not come');
});

test('a signed-off day refuses every daily-work write path and attendance edits — batches whole', async () => {
  const L = day(-6);                    // locked
  const O = day(-5);                    // open
  present(M.govinda, L); present(M.vinod, L);
  const onL = line(J1, L, 'Govinda', 8);
  const onL2 = line(J1, L, 'Vinod', 8);
  const onO = line(J1, O, 'Govinda', 2);
  const pool = line(GWS, L, 'Vinod', 0.5);
  run('UPDATE job_daily_work SET hours = 7.5 WHERE id = ?', onL2);
  const boss = await as('boss');
  const s = await req('POST', '/api/attendance/day/signoff', { cookie: boss, body: { date: L } });
  assert.strictEqual(s.status, 200, s.text);
  const count = () => get('SELECT COUNT(*) n, SUM(hours) h FROM job_daily_work').n + '/' + get('SELECT SUM(hours) h FROM job_daily_work').h;
  const was = count();

  const tries = [
    ['POST', '/api/daily-work', { work_date: L, job_id: J1, mechanic: 'Govinda', hours: 1 }],
    ['POST', '/api/daily-work', { work_date: L, request_type: 'general', mechanic: 'Govinda', hours: 1 }],
    ['POST', '/api/daily-work/bulk-log', { date: L, entries: [{ mechanic: 'Govinda', job_id: J1, hours: 1 }] }],
    ['PATCH', `/api/daily-work/${onL}`, { hours: 6 }],
    ['PATCH', `/api/daily-work/${onO}`, { work_date: L }],            // moving a line INTO a locked day
    ['PATCH', `/api/daily-work/${onL}`, { work_date: O }],            // ...or out of one
    ['DELETE', `/api/daily-work/${onL}`],
    ['POST', '/api/daily-work/batch-update', { updates: [{ id: onO, hours: 3 }, { id: onL, hours: 5 }] }],
    ['POST', `/api/jobs/${J1}/daily-work`, { work_date: L, mechanic: 'Govinda', hours: 1 }],
    ['DELETE', `/api/jobs/${J1}/daily-work/${onL}`],
    ['POST', `/api/jobs/${J1}/daily-work/attach`, { ids: [pool] }],
    ['POST', '/api/attendance/day', { date: L, rows: [{ mechanic_id: M.govinda, time_out: '16:00' }] }],
  ];
  for (const [method, p, body] of tries) {
    const r = await req(method, p, { cookie: boss, body });
    assert.strictEqual(r.status, 423, `${method} ${p} ${JSON.stringify(body || {})} → ${r.status} ${r.text}`);
    assert.match(r.body.error, /signed off/);
  }
  assert.strictEqual(count(), was, 'nothing was saved — not even the batch line on the open day');
  assert.strictEqual(get('SELECT hours h FROM job_daily_work WHERE id = ?', onO).h, 2);
  assert.strictEqual(get('SELECT time_out t FROM mechanic_attendance WHERE mechanic_id = ? AND work_date = ?', M.govinda, L).t, '17:00');

  // The open day next to it is unaffected.
  assert.strictEqual((await req('PATCH', `/api/daily-work/${onO}`, { cookie: boss, body: { hours: 2.5 } })).status, 200);
});

test('unlocking needs the permission and a reason, is audited, and opens the day again', async () => {
  const L = day(-6);
  const ws = await as('ws');
  const mgr = await as('mgr');
  const noCap = await req('POST', '/api/attendance/day/unlock', { cookie: ws, body: { date: L, reason: 'mistake' } });
  assert.strictEqual(noCap.status, 403, 'the workshop signs off but does not unlock');
  const noReason = await req('POST', '/api/attendance/day/unlock', { cookie: mgr, body: { date: L, reason: '  ' } });
  assert.strictEqual(noReason.status, 400);
  assert.strictEqual(att.isLocked(L), true);
  const ok = await req('POST', '/api/attendance/day/unlock', { cookie: mgr, body: { date: L, reason: 'Vinod booked 30 min on the wrong day' } });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.strictEqual(ok.body.locked, false);
  assert.strictEqual(ok.body.signoff.unlock_reason, 'Vinod booked 30 min on the wrong day');
  const a = get("SELECT reason, user_id FROM audit_log WHERE entity = 'workday_signoff' AND action = 'unlock' ORDER BY id DESC LIMIT 1");
  assert.strictEqual(a.reason, 'Vinod booked 30 min on the wrong day');
  const r = await req('POST', '/api/daily-work', { cookie: await as('boss'), body: { work_date: L, job_id: J1, mechanic: 'Vinod', hours: 0.5 } });
  assert.strictEqual(r.status, 201, r.text);
  const again = await req('POST', '/api/attendance/day/unlock', { cookie: mgr, body: { date: L, reason: 'x' } });
  assert.strictEqual(again.status, 409, 'not signed off any more');
});

// ================================================================== permissions and the edit window
test('a role without attendance.record gets 403; reading follows Daily Work clearance', async () => {
  const body = { date: T, rows: [{ mechanic_id: M.govinda, status: 'present', time_in: '08:00', time_out: '17:00', break_minutes: 60 }] };
  assert.strictEqual((await req('POST', '/api/attendance/day', { cookie: await as('clerk'), body })).status, 403, 'daily work clerk');
  assert.strictEqual((await req('POST', '/api/attendance/day', { cookie: await as('look'), body })).status, 403, 'viewer');
  assert.strictEqual((await req('GET', `/api/attendance/day?date=${T}`, { cookie: await as('look') })).status, 200, 'viewer reads');
  assert.strictEqual((await req('GET', `/api/attendance/day?date=${T}`, { cookie: await as('sk') })).status, 403, 'no Daily Work clearance, no attendance');
  assert.strictEqual((await req('POST', '/api/attendance/day/signoff', { cookie: await as('clerk'), body: { date: day(-4) } })).status, 403);
  assert.strictEqual((await req('PUT', '/api/attendance/settings', { cookie: await as('mgr'), body: { tolerance_minutes: 30 } })).status, 403, 'settings are admin only');
  const ok = await req('POST', '/api/attendance/day', { cookie: await as('ws'), body });
  assert.strictEqual(ok.status, 200, ok.text);
  const audited = get("SELECT action, after_json FROM audit_log WHERE entity = 'mechanic_attendance' ORDER BY id DESC LIMIT 1");
  assert.strictEqual(audited.action, 'create');
  assert.match(audited.after_json, /"mechanic":"Govinda"/);
});

test('attendance.record reaches today and yesterday; older days need attendance.unlock; never the future', async () => {
  const row = (d) => ({ date: d, rows: [{ mechanic_id: M.sunil, status: 'present', time_in: '08:00', time_out: '17:00', break_minutes: 60 }] });
  const ws = await as('ws');
  assert.strictEqual((await req('POST', '/api/attendance/day', { cookie: ws, body: row(day(-1)) })).status, 200, 'yesterday');
  const old = await req('POST', '/api/attendance/day', { cookie: ws, body: row(day(-3)) });
  assert.strictEqual(old.status, 403);
  assert.match(old.body.error, /today's and yesterday's/);
  assert.strictEqual((await req('POST', '/api/attendance/day', { cookie: await as('om'), body: row(day(-3)) })).status, 200, 'the operational manager can correct an older day');
  assert.strictEqual((await req('POST', '/api/attendance/day', { cookie: await as('boss'), body: row(day(1)) })).status, 400, 'tomorrow');
  const g = await req('GET', `/api/attendance/day?date=${day(-3)}`, { cookie: ws });
  assert.strictEqual(g.body.can.edit, false);
  assert.strictEqual((await req('GET', `/api/attendance/day?date=${T}`, { cookie: ws })).body.can.edit, true);
});

test('bad input is refused with a plain message', async () => {
  const boss = await as('boss');
  const bad = async (r) => (await req('POST', '/api/attendance/day', { cookie: boss, body: { date: T, rows: [{ mechanic_id: M.anura, ...r }] } }));
  assert.strictEqual((await bad({ time_in: '8.00' })).status, 400);
  assert.strictEqual((await bad({ status: 'sick' })).status, 400);
  assert.strictEqual((await bad({ break_minutes: -5 })).status, 400);
  assert.strictEqual((await bad({ time_in: '08:00', time_out: '08:30', break_minutes: 60 })).status, 400);
  assert.strictEqual((await req('POST', '/api/attendance/day', { cookie: boss, body: { date: T, rows: [{ mechanic_id: 99999 }] } })).status, 400);
  const leave = await bad({ status: 'leave', time_in: '08:00', time_out: '17:00' });
  assert.strictEqual(leave.status, 200);
  const saved = get('SELECT time_in, time_out FROM mechanic_attendance WHERE mechanic_id = ? AND work_date = ?', M.anura, T);
  assert.deepStrictEqual([saved.time_in, saved.time_out], [null, null], 'leave keeps no times');
});

// ================================================================== unbooked: book the rest, or a reason
test('"Unbooked": one click books the rest to the General Workshop card; a reason can be recorded instead', async () => {
  const d = day(-4);
  present(M.anura, d);                                 // 8 h
  line(J1, d, 'Anura', 5.5);
  assert.strictEqual(rowOf(d, M.anura).tally, 'unbooked');
  const clerk = await req('POST', '/api/attendance/day/book-rest', { cookie: await as('look'), body: { date: d, mechanic_id: M.anura } });
  assert.strictEqual(clerk.status, 403);
  const r = await req('POST', '/api/attendance/day/book-rest', { cookie: await as('ws'), body: { date: d, mechanic_id: M.anura } });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.body.hours, 2.5);
  assert.strictEqual(r.body.job_no, 'GENERAL-WS');
  const l = get('SELECT job_id, mechanic, hours FROM job_daily_work WHERE id = ?', r.body.id);
  assert.deepStrictEqual([l.job_id, l.mechanic, l.hours], [GWS, 'Anura', 2.5]);
  assert.strictEqual(rowOf(d, M.anura).tally, 'matched');
  const twice = await req('POST', '/api/attendance/day/book-rest', { cookie: await as('ws'), body: { date: d, mechanic_id: M.anura } });
  assert.strictEqual(twice.status, 409, 'nothing left to book');

  present(M.sunil, day(-1));
  line(J1, day(-1), 'Sunil', 6);
  const why = await req('POST', '/api/attendance/day', { cookie: await as('ws'), body: { date: day(-1), rows: [{ mechanic_id: M.sunil, unbooked_reason: 'Cleaning the bay' }] } });
  assert.strictEqual(why.status, 200, why.text);
  const s = rowOf(day(-1), M.sunil);
  assert.strictEqual(s.tally, 'unbooked');
  assert.strictEqual(s.attendance.unbooked_reason, 'Cleaning the bay');
});

// ================================================================== at the point of entry
test('hours left: attended, booked and what is left, for the entry forms', async () => {
  const d = day(-2);
  present(M.govinda, d);
  const l1 = line(J1, d, 'Govinda, Vinod', 6.5);
  const c = await as('ws');
  const r = await req('GET', `/api/attendance/hours-left?date=${d}&names=${encodeURIComponent('Govinda, Vinod|Nobody Known')}`, { cookie: c });
  assert.strictEqual(r.status, 200, r.text);
  const g = r.body.mechanics.find((m) => m.name === 'Govinda');
  assert.deepStrictEqual([g.attended_hours, g.booked_hours, g.left_hours], [8, 6.5, 1.5]);
  const v = r.body.mechanics.find((m) => m.name === 'Vinod');
  assert.deepStrictEqual([v.attended_hours, v.booked_hours, v.left_hours], [null, 6.5, null], 'no attendance: nothing to measure against');
  assert.strictEqual(r.body.mechanics.find((m) => m.name === 'Nobody Known').resolved, false);
  const ex = await req('GET', `/api/attendance/hours-left?date=${d}&names=Govinda&exclude_line=${l1}`, { cookie: c });
  assert.strictEqual(ex.body.mechanics[0].left_hours, 8, 'the line being edited does not count against itself');
  // Over-booking only warns: the entry is still accepted.
  const over = await req('POST', '/api/daily-work', { cookie: c, body: { work_date: d, job_id: J1, mechanic: 'Govinda', hours: 4 } });
  assert.strictEqual(over.status, 201, over.text);
  assert.strictEqual(rowOf(d, M.govinda).tally, 'over_booked');
});

// ================================================================== the month
test('the month: attended, booked and utilisation per mechanic, from the start date', async () => {
  const ym = day(-2).slice(0, 7);
  const m = att.month(ym);
  assert.ok(m.from >= START);
  const g = m.mechanics.find((x) => x.name === 'Govinda');
  assert.ok(g.attended_hours > 0);
  assert.strictEqual(g.utilisation, Math.round((g.booked_hours / g.attended_hours) * 1000) / 10);
  const s = await req('GET', `/api/daily-work/monthly-summary?month=${ym}`, { cookie: await as('ws') });
  assert.strictEqual(s.status, 200, s.text);
  const row = s.body.labor_summary.find((l) => l.mechanic === 'Govinda');
  assert.ok(row && 'attended_hours' in row && 'utilisation' in row);
  const x = await req('GET', `/api/daily-work/monthly-summary?month=${ym}&format=xlsx`, { cookie: await as('ws') });
  assert.strictEqual(x.status, 200, 'the Excel summary downloads');
});

// ================================================================== switched off
test('switched off: no lock, no columns, no hints — Daily Work behaves exactly as before', async () => {
  const d = day(-11);
  present(M.govinda, d);
  line(J1, d, 'Govinda', 8);
  const boss = await as('boss');
  assert.strictEqual((await req('POST', '/api/attendance/day/signoff', { cookie: boss, body: { date: d } })).status, 200);
  assert.strictEqual((await req('PUT', '/api/attendance/settings', { cookie: boss, body: { enabled: false } })).status, 200);
  try {
    assert.strictEqual(att.isLocked(d), false);
    const r = await req('POST', '/api/daily-work', { cookie: boss, body: { work_date: d, job_id: J1, mechanic: 'Govinda', hours: 1 } });
    assert.strictEqual(r.status, 201, 'a signed-off day is not locked while attendance is off');
    const dayView = await req('GET', `/api/daily-work?date=${d}`, { cookie: boss });
    assert.ok(!('locked' in dayView.body));
    const sum = await req('GET', `/api/daily-work/monthly-summary?month=${d.slice(0, 7)}`, { cookie: boss });
    assert.ok(!('attendance' in sum.body));
    assert.ok(sum.body.labor_summary.every((l) => !('attended_hours' in l)));
    const hl = await req('GET', `/api/attendance/hours-left?date=${d}&names=Govinda`, { cookie: boss });
    assert.deepStrictEqual(hl.body, { enabled: false });
    const w = await req('POST', '/api/attendance/day', { cookie: boss, body: { date: T, rows: [{ mechanic_id: M.govinda, status: 'absent' }] } });
    assert.strictEqual(w.status, 409);
    assert.ok(get("SELECT 1 x FROM audit_log WHERE entity = 'settings' AND action = 'attendance_settings'"));
  } finally {
    att.saveSettings({ enabled: true });
  }
  assert.strictEqual(att.settings().start_date, START, 'switching back on keeps the start date');
  assert.strictEqual(att.isLocked(d), true, 'and the sign-off still stands');
});

test('switching on for the first time starts the tally today', () => {
  run("DELETE FROM settings WHERE key LIKE 'attendance_%'");
  try {
    assert.strictEqual(att.settings().enabled, false, 'off until somebody switches it on');
    const s = att.saveSettings({ enabled: true });
    assert.deepStrictEqual([s.enabled, s.start_date, s.shift_start, s.shift_end, s.break_minutes, s.tolerance_minutes], [true, T, '08:00', '17:00', 60, 15]);
  } finally {
    att.saveSettings({ enabled: true, start_date: START });
  }
});
