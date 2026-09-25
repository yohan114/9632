'use strict';

// Multi-site Stage 4, part A — attendance per workshop (src/lib/attendance.js).
//
//   With the workshops kept apart (Stage 3's switch, and a second workshop), each workshop has
//   its own day: its own mechanics (where each belonged on the date), its own tally and its own
//   sign-off, which locks only its own attendance and daily work. Head office sees every
//   workshop's. A mechanic's hours booked on another workshop's cards still count (S4-D3). Off:
//   one day for the whole company, as before.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-s4a-'));
process.env.DB_PATH = path.join(TMP, 's4a.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const workshops = require('../src/lib/workshops');
const att = require('../src/lib/attendance');

migrate();
for (const n of ['admin', 'workshop', 'operational_manager', 'manager']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
const CW = workshops.defaultId();
const MTR = run("INSERT INTO workshops (code, name, place) VALUES ('MTR', 'Muthur Workshop', 'Muthur')").lastInsertRowid;
const PW = 'ember-harbour-quarry';
function mkUser(username, roles, ws = CW) {
  const id = run('INSERT INTO users (username, password_hash, active, workshop_id) VALUES (?, ?, 1, ?)', username, auth.hashPassword(PW), ws).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const U = { boss: mkUser('boss', ['admin']), mgr: mkUser('mgr', ['manager']), wsC: mkUser('wsC', ['workshop']), wsM: mkUser('wsM', ['workshop'], MTR) };
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const TODAY = day(0); const Y = day(-1);
att.saveSettings({ enabled: true, start_date: day(-20) });

run("INSERT INTO mechanics (name, name_norm) VALUES ('Anura', 'ANURA'), ('Buddhika', 'BUDDHIKA')");
run("INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Anura', 400, '2020-01-01'), ('Buddhika', 450, '2020-01-01')");
const ANURA = get("SELECT id FROM mechanics WHERE name = 'Anura'").id;
const BUDDHIKA = get("SELECT id FROM mechanics WHERE name = 'Buddhika'").id;
run('INSERT INTO mechanic_workshops (mechanic_id, workshop_id, from_date) VALUES (?, ?, ?)', ANURA, MTR, day(-3));   // Anura moved to Muthur 3 days ago

let seq = 0;
const asset = (code) => run('INSERT INTO assets (code, code_norm, status, in_register) VALUES (?, ?, ?, 1)', code, code.replace(/\W/g, ''), 'active').lastInsertRowid;
const job = (ws) => run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at, workshop_id)
  VALUES (?, ?, 'repair', 'x', 'IN_PROGRESS', ?, ?)`, `2026/9/R/${600 + (++seq)}`, asset('A-' + seq), day(-15), ws).lastInsertRowid;
const J = { c: job(CW), m: job(MTR) };
const present = (mech, date, inT = '08:00', outT = '17:00') => run(`INSERT INTO mechanic_attendance (mechanic_id, work_date, time_in, time_out, break_minutes, status)
  VALUES (?, ?, ?, ?, 60, 'present') ON CONFLICT(mechanic_id, work_date) DO UPDATE SET time_in = excluded.time_in, time_out = excluded.time_out`, mech, date, inT, outT);
const book = (jobId, date, mech, hours, description = 'w') => run(
  'INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, ?, ?, ?, ?)', jobId, date, mech, description, hours);

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
        resolve({ status: res.statusCode, body: json, text: buf, cookie: res.headers['set-cookie'] ? res.headers['set-cookie'][0].split(';')[0] : null });
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
const separate = async (on) => assert.strictEqual((await req('PUT', '/api/workshops/separate', { cookie: await as('boss'), body: { on } })).status, 200);
const names = (d) => d.rows.map((r) => r.name);

// ================================================================== off: one company day
test('workshops not kept apart: one day for the whole company, as before', async () => {
  present(ANURA, day(-2)); present(BUDDHIKA, day(-2));
  book(J.c, day(-2), 'Buddhika', 8); book(J.m, day(-2), 'Anura', 8);
  const d = (await req('GET', `/api/attendance/day?date=${day(-2)}`, { cookie: await as('wsM') })).body;
  assert.deepStrictEqual(names(d), ['Anura', 'Buddhika']);
  assert.strictEqual(d.workshop_id, null);
  const s = await req('POST', '/api/attendance/day/signoff', { cookie: await as('wsC'), body: { date: day(-2) } });
  assert.strictEqual(s.status, 200, s.text);
  assert.deepStrictEqual(all('SELECT workshop_id FROM workday_signoffs WHERE work_date = ?', day(-2)).map((r) => r.workshop_id), [0]);
  assert.strictEqual(att.isLocked(day(-2)), true);
});

// ================================================================== kept apart: each workshop's day
test('kept apart: your own workshop\'s mechanics on the day — where each belonged on the date', async () => {
  await separate(true);
  present(ANURA, Y); present(BUDDHIKA, Y);
  const m = (await req('GET', `/api/attendance/day?date=${Y}`, { cookie: await as('wsM') })).body;
  assert.strictEqual(m.workshop_id, MTR);
  assert.deepStrictEqual(names(m), ['Anura']);
  const c = (await req('GET', `/api/attendance/day?date=${Y}`, { cookie: await as('wsC') })).body;
  assert.deepStrictEqual(names(c), ['Buddhika']);
  // Before the move, Anura was Central's.
  assert.deepStrictEqual(names((await req('GET', `/api/attendance/day?date=${day(-5)}`, { cookie: await as('wsC') })).body), ['Anura', 'Buddhika']);
  assert.deepStrictEqual(names((await req('GET', `/api/attendance/day?date=${day(-5)}`, { cookie: await as('wsM') })).body), []);
  // Someone kept to their workshop cannot ask for another's.
  assert.strictEqual((await req('GET', `/api/attendance/day?date=${Y}&workshop_id=${CW}`, { cookie: await as('wsM') })).body.workshop_id, MTR);
  // Head office picks: their home by default, any workshop when asked.
  assert.strictEqual((await req('GET', `/api/attendance/day?date=${Y}`, { cookie: await as('mgr') })).body.workshop_id, CW);
  assert.deepStrictEqual(names((await req('GET', `/api/attendance/day?date=${Y}&workshop_id=${MTR}`, { cookie: await as('mgr') })).body), ['Anura']);
});

test('you record attendance only for your own workshop\'s mechanics', async () => {
  const r = await req('POST', '/api/attendance/day', { cookie: await as('wsM'),
    body: { date: TODAY, rows: [{ mechanic_id: BUDDHIKA, status: 'present', time_in: '08:00', time_out: '17:00', break_minutes: 60 }] } });
  assert.strictEqual(r.status, 403);
  assert.match(r.body.error, /Buddhika belongs to Central Workshop/);
  assert.ok(!get('SELECT 1 x FROM mechanic_attendance WHERE mechanic_id = ? AND work_date = ?', BUDDHIKA, TODAY));
  const ok = await req('POST', '/api/attendance/day', { cookie: await as('wsM'),
    body: { date: TODAY, rows: [{ mechanic_id: ANURA, status: 'present', time_in: '08:00', time_out: '17:00', break_minutes: 60 }] } });
  assert.strictEqual(ok.status, 200, ok.text);
});

test('a lent mechanic\'s hours count wherever booked; unmatched names stay with the card\'s workshop', async () => {
  book(J.m, Y, 'Anura', 5);
  book(J.c, Y, 'Anura', 3, 'helped Central');          // lent to Central for the afternoon
  book(J.c, Y, 'Kamal', 2, 'somebody unknown');        // a name that is nobody's
  book(J.c, Y, 'Buddhika', 8);
  const m = (await req('GET', `/api/attendance/day?date=${Y}`, { cookie: await as('wsM') })).body;
  const anura = m.rows.find((r) => r.name === 'Anura');
  assert.strictEqual(anura.booked_hours, 8, 'Central\'s 3 h count too');
  assert.strictEqual(anura.tally, 'matched');
  assert.deepStrictEqual(m.unmatched, [], 'Kamal was booked on Central\'s card');
  const c = (await req('GET', `/api/attendance/day?date=${Y}`, { cookie: await as('wsC') })).body;
  assert.deepStrictEqual(c.unmatched.map((u) => u.name), ['Kamal']);
});

test('each workshop signs off its own day; the lock holds only that workshop\'s work', async () => {
  run("DELETE FROM job_daily_work WHERE description = 'somebody unknown'");   // nothing red at Central either
  const s = await req('POST', '/api/attendance/day/signoff', { cookie: await as('wsM'), body: { date: Y } });
  assert.strictEqual(s.status, 200, s.text);
  assert.strictEqual(s.body.locked, true);
  assert.deepStrictEqual(all('SELECT workshop_id FROM workday_signoffs WHERE work_date = ?', Y).map((r) => r.workshop_id), [MTR]);
  assert.strictEqual((await req('GET', `/api/attendance/day?date=${Y}`, { cookie: await as('wsC') })).body.locked, false, 'Central\'s day is still open');
  // Muthur's cards are locked for that day; Central's are not.
  const onM = await req('POST', `/api/jobs/${J.m}/daily-work`, { cookie: await as('wsM'), body: { work_date: Y, mechanic: 'Anura', hours: 1, description: 'late' } });
  assert.strictEqual(onM.status, 423, onM.text);
  const onC = await req('POST', `/api/jobs/${J.c}/daily-work`, { cookie: await as('wsC'), body: { work_date: Y, mechanic: 'Buddhika', hours: 0.5, description: 'late' } });
  assert.strictEqual(onC.status, 201, onC.text);
  const viaDaily = await req('POST', '/api/daily-work', { cookie: await as('wsM'), body: { work_date: Y, job_id: J.m, mechanic: 'Anura', hours: 1 } });
  assert.strictEqual(viaDaily.status, 423);
  // Head office at home in Central (whose day is open) still meets Muthur's lock on Muthur's card —
  // and is not held by it on Central's.
  const ho = await req('POST', '/api/daily-work', { cookie: await as('boss'), body: { work_date: Y, job_id: J.m, mechanic: 'Anura', hours: 1 } });
  assert.strictEqual(ho.status, 423, ho.text);
  const hoC = await req('POST', '/api/daily-work', { cookie: await as('boss'), body: { work_date: Y, job_id: J.c, mechanic: 'Buddhika', hours: 0.5, description: 'late' } });
  assert.strictEqual(hoC.status, 201, hoC.text);
  // Attendance of Muthur's mechanics on that day is locked too (a manager could otherwise change it).
  const attM = await req('POST', '/api/attendance/day', { cookie: await as('mgr'),
    body: { date: Y, workshop_id: MTR, rows: [{ mechanic_id: ANURA, note: 'x' }] } });
  assert.strictEqual(attM.status, 423);
  // Central signs off its own (the half hour just added would leave Buddhika over-booked).
  run("DELETE FROM job_daily_work WHERE job_id = ? AND description = 'late'", J.c);
  const sc = await req('POST', '/api/attendance/day/signoff', { cookie: await as('wsC'), body: { date: Y } });
  assert.strictEqual(sc.status, 200, sc.text);
  assert.deepStrictEqual(all('SELECT workshop_id FROM workday_signoffs WHERE work_date = ? ORDER BY workshop_id', Y).map((r) => r.workshop_id), [CW, MTR]);
});

test('unlocking one workshop\'s day leaves the other\'s signed off', async () => {
  const r = await req('POST', '/api/attendance/day/unlock', { cookie: await as('mgr'), body: { date: Y, workshop_id: MTR, reason: 'late sheet' } });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(att.isLocked(Y, att.settings(), MTR), false);
  assert.strictEqual(att.isLocked(Y, att.settings(), CW), true);
});

test('a whole-company sign-off from before the split still holds every workshop\'s day', () => {
  assert.strictEqual(att.isLocked(day(-2), att.settings(), MTR), true);
  assert.strictEqual(att.isLocked(day(-2), att.settings(), CW), true);
});

test('days to sign off: your own workshop\'s; head office sees each workshop\'s, named', async () => {
  present(ANURA, day(-4)); present(BUDDHIKA, day(-4));
  const qM = (await req('GET', '/api/reports/pending-approvals', { cookie: await as('wsM') })).body.signoff;
  assert.ok(qM.some((d) => d.date === Y) && qM.every((d) => d.workshop_id === MTR));
  assert.ok(!qM.some((d) => d.date === day(-4)), 'on that day both mechanics were Central\'s');
  const qC = (await req('GET', '/api/reports/pending-approvals', { cookie: await as('wsC') })).body.signoff;
  assert.ok(!qC.some((d) => d.date === Y), 'Central signed off yesterday');
  assert.ok(qC.some((d) => d.date === day(-4)));
  const qHo = (await req('GET', '/api/reports/pending-approvals', { cookie: await as('mgr') })).body.signoff;
  assert.ok(qHo.some((d) => d.date === Y && d.workshop_name === 'Muthur Workshop'));
  assert.ok(qHo.some((d) => d.date === day(-4) && d.workshop_name === 'Central Workshop — Badalgama'));
  const dash = (await req('GET', '/api/reports/dashboard', { cookie: await as('wsM') })).body.attendance_today;
  assert.ok(dash.unsigned_days.every((d) => d.workshop_id === MTR));
});

test('the month: each mechanic only for the days they belonged to the workshop', async () => {
  const m = (await req('GET', `/api/attendance/month?month=${Y.slice(0, 7)}`, { cookie: await as('wsM') })).body;
  assert.strictEqual(m.workshop_id, MTR);
  assert.deepStrictEqual(m.mechanics.map((x) => x.name), ['Anura']);
  const c = (await req('GET', `/api/attendance/month?month=${Y.slice(0, 7)}`, { cookie: await as('wsC') })).body;
  const anuraAtC = c.mechanics.find((x) => x.name === 'Anura');
  if (Y.slice(0, 7) === day(-4).slice(0, 7)) assert.ok(anuraAtC, 'Anura\'s days before the move are Central\'s');
  if (anuraAtC) assert.ok(anuraAtC.attended_hours > 0 && anuraAtC.attended_hours <= 16);
});

test('switched off again: one company day once more', async () => {
  await separate(false);
  const d = (await req('GET', `/api/attendance/day?date=${Y}`, { cookie: await as('wsM') })).body;
  assert.strictEqual(d.workshop_id, null);
  assert.deepStrictEqual(names(d), ['Anura', 'Buddhika']);
  assert.strictEqual(d.locked, true, 'Central\'s sign-off still stands for the company day');
  // …and so it locks every card that day, Muthur's included.
  const r = await req('POST', `/api/jobs/${J.m}/daily-work`, { cookie: await as('wsM'), body: { work_date: Y, mechanic: 'Anura', hours: 1, description: 'x' } });
  assert.strictEqual(r.status, 423, r.text);
});
