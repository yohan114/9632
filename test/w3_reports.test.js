'use strict';

// W3 — reports and dashboards (docs/WORKSHOPONE_PLAN.md, Stage W3).
//
//   The monthly cost report puts a partly closed job in the Closed section of its partial-close
//   month, flagged "prices pending", and nowhere else — the one addition to the section rules
//   (W-D9). A month with no partly closed job is built exactly as before. The day tally is frozen
//   day by day like the other daily reports and exports to Excel; the dashboard shows today's
//   tally and the days still to sign off. Attendance moves no money.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-w3-'));
process.env.DB_PATH = path.join(TMP, 'w3.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const report = require('../src/lib/monthly_cost_report');
const att = require('../src/lib/attendance');
const daily = require('../src/lib/daily_reports');

migrate();
for (const n of ['admin', 'workshop', 'operational_manager', 'storekeeper', 'viewer']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
const PW = 'ember-harbour-quarry';
function mkUser(username, roles) {
  const id = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', username, auth.hashPassword(PW)).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
mkUser('boss', ['admin']); mkUser('ws', ['workshop']); mkUser('om', ['operational_manager']); mkUser('sk', ['storekeeper']);

run("INSERT INTO mechanics (name, name_norm) VALUES ('Anura', 'ANURA'), ('Vinod', 'VINOD')");
run("INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Anura', 400, '2020-01-01'), ('Vinod', 300, '2020-01-01')");
let n = 0;
const asset = () => { n++; return run('INSERT INTO assets (code, code_norm, in_register) VALUES (?, ?, 1)', `W3-${n}`, `W3${n}`).lastInsertRowid; };
const job = (no, status, extra = {}) => run(
  `INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at, completed_at, closed_at, partial_closed_at, material_cost, total_cost)
   VALUES (?, ?, 'repair', ?, ?, ?, ?, ?, ?, 1000, 1000)`,
  no, asset(), extra.description || `job ${no}`, status, extra.requested_at || '2026-06-01',
  extra.completed_at || null, extra.closed_at || null, extra.partial_closed_at || null).lastInsertRowid;
const work = (jobId, date, hours = 4, mechanic = 'Anura') => run(
  'INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, ?, ?, ?, ?)', jobId, date, mechanic, 'work', hours);

// June 2026: one closed, one partly closed, one in progress, one rejected (still "pending", as before).
const A = job('2026/6/R/101', 'CLOSED', { completed_at: '2026-06-20', closed_at: '2026-06-20' });
const B = job('2026/6/R/102', 'PARTIALLY_CLOSED', { completed_at: '2026-06-15 10:00:00', partial_closed_at: '2026-06-15 10:00:00', description: 'Gearbox overhaul' });
const C = job('2026/6/R/103', 'IN_PROGRESS');
const D = job('2026/6/R/104', 'REJECTED');
for (const j of [A, B, C, D]) work(j, '2026-06-10');
require('../src/lib/mechanics').syncJobLabourForMonth('2026-06');

const repairCells = (wb) => {
  const ws = wb.getWorksheet('Repair cost');
  const rows = [];
  ws.eachRow((row) => rows.push(row.values.map((v) => (v && typeof v === 'object' && 'result' in v ? v.result : v))));
  return rows;
};

// ================================================================== the monthly cost report
test('a partly closed job is in Closed, in its partial-close month, flagged — and only there', async () => {
  const { wb, parts } = await report.buildWorkbook(2026, 6);
  const rep = parts.repair;
  assert.deepStrictEqual(rep.closed_jobs.map((j) => j.id).sort(), [A, B].sort());
  assert.deepStrictEqual(rep.pending_jobs.map((j) => j.id).sort(), [C, D].sort(), 'pending as before, without the partly closed job');
  assert.strictEqual(rep.partly_closed_count, 1);
  const rows = repairCells(wb);
  const withB = rows.filter((r) => r.includes('2026/6/R/102'));
  assert.strictEqual(withB.length, 1, 'shown once');
  assert.match(String(withB[0][8]), /^Gearbox overhaul — PRICES PENDING \(partly closed 2026-06-15\)$/);
  assert.ok(rows.some((r) => r.some((v) => /Closed Jobs .*\(2, of which 1 partly closed — prices pending\)/.test(String(v)))), 'the banner says so');
  assert.ok(!rows.some((r) => r.includes('2026/6/R/101') && /PRICES PENDING/.test(String(r[8]))), 'a closed job is not flagged');
  assert.ok(rep.closed_job_rows.find((x) => x.id === B).partly_closed);
});

test('it counts once in the totals: its labour is not also Other Labour', async () => {
  const { parts } = await report.buildWorkbook(2026, 6);
  const junLabour = get("SELECT ROUND(SUM(amount), 2) v FROM job_labour WHERE substr(work_date,1,7) = '2026-06'").v;
  const shown = parts.repair.closed_jobs.reduce((t, j) => t + j.labour, 0) + parts.repair.pending_jobs.reduce((t, j) => t + j.labour, 0)
    + parts.repair.other_labour_total;
  assert.strictEqual(Math.round(shown * 100) / 100, junLabour, 'every rupee of June labour, once');
});

test('the owner\'s hand-kept Pending list cannot put it in Pending as well', async () => {
  run("INSERT INTO monthly_report_inputs (year, month, sheet, seq, label) VALUES (2026, 6, 'pending', 1, '2026/6/R/102'), (2026, 6, 'pending', 2, '2026/6/R/103')");
  try {
    const { parts } = await report.buildWorkbook(2026, 6);
    assert.deepStrictEqual(parts.repair.pending_jobs.map((j) => j.id), [C]);
    assert.ok(parts.repair.closed_jobs.some((j) => j.id === B));
  } finally {
    run("DELETE FROM monthly_report_inputs WHERE year = 2026 AND month = 6 AND sheet = 'pending'");
  }
});

test('later months: a late price lands in its own month, and a full close keeps it there', async () => {
  work(C, '2026-07-03');
  // The seal kit's invoice arrives in July.
  run("INSERT INTO job_parts (job_id, source_type, description, qty, unit_price) VALUES (?, 'external', 'Seal kit', 1, 2500)", B);
  require('../src/lib/costing').refreshJobTotals(B);
  const june = await report.buildWorkbook(2026, 6);
  assert.strictEqual(june.parts.repair.closed_jobs.find((j) => j.id === B).material, 2500, 'the price shows on its June row');
  const july = await report.buildWorkbook(2026, 7);
  assert.ok(!july.parts.repair.closed_jobs.some((j) => j.id === B) && !july.parts.repair.pending_jobs.some((j) => j.id === B),
    'not in July at all');
  run("UPDATE job_cards SET status = 'CLOSED', closed_at = '2026-07-05' WHERE id = ?", B);
  try {
    const again = await report.buildWorkbook(2026, 6);
    assert.ok(again.parts.repair.closed_jobs.some((j) => j.id === B), 'still June, now closed fully');
    assert.strictEqual(again.parts.repair.partly_closed_count, 0);
    assert.ok(!repairCells(again.wb).some((r) => /PRICES PENDING/.test(String(r[8]))), 'no flag once fully closed');
  } finally {
    run("UPDATE job_cards SET status = 'PARTIALLY_CLOSED', closed_at = NULL WHERE id = ?", B);
  }
});

test('a month with no partly closed job is built exactly as before', async () => {
  run("UPDATE job_cards SET status = 'CLOSED' WHERE id = ?", B);
  try {
    const { wb, parts } = await report.buildWorkbook(2026, 6);
    // The rule before W3: Closed = status CLOSED in its completed_at month; Pending = status <> CLOSED.
    const oldClosed = all("SELECT id FROM job_cards WHERE status = 'CLOSED' AND substr(completed_at,1,7) = '2026-06' ORDER BY id").map((r) => r.id);
    const oldPending = all(`SELECT id FROM job_cards WHERE status <> 'CLOSED' AND EXISTS (SELECT 1 FROM job_daily_work w WHERE w.job_id = job_cards.id AND substr(w.work_date,1,7) = '2026-06') ORDER BY id`).map((r) => r.id);
    assert.deepStrictEqual(parts.repair.closed_jobs.map((j) => j.id).sort(), oldClosed);
    assert.deepStrictEqual(parts.repair.pending_jobs.map((j) => j.id).sort(), oldPending);
    assert.ok(repairCells(wb).some((r) => r.some((v) => String(v) === 'Closed Jobs — completed & closed in June 2026; labour = this month\'s work (2)')),
      'the banner reads as it always did');
    assert.ok(!wb.getWorksheet('Attendance & utilisation'), 'no extra sheet while attendance is off');
    assert.strictEqual(wb.worksheets.length, 14);
  } finally {
    run("UPDATE job_cards SET status = 'PARTIALLY_CLOSED' WHERE id = ?", B);
  }
});

// ================================================================== HTTP: repair detail, day tally, dashboard
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
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null; try { json = JSON.parse(buf.toString()); } catch { /* not json */ }
        const sc = res.headers['set-cookie'];
        resolve({ status: res.statusCode, body: json, text: buf.toString(), raw: buf, type: res.headers['content-type'] || '', cookie: sc ? sc[0].split(';')[0] : null });
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

test('the printable repair detail uses the same rule: the partly closed job once', async () => {
  const r = await req('GET', '/api/reports/monthly-repair-detail.html?year=2026&month=6', { cookie: await as('boss') });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.text.split('Job 2026/6/R/102').length - 1, 1);
  assert.strictEqual(r.text.split('Job 2026/6/R/103').length - 1, 1);
});

// Attendance, today — every date relative to today so the edit window and "today" line up.
const T = att.today();

test('with attendance on, the workbook gains "Attendance & utilisation"; no cost figure moves', async () => {
  const [y, m] = T.split('-').map(Number);
  const J = job(`2026/9/R/${900 + n}`, 'IN_PROGRESS', { requested_at: T });
  work(J, T, 6);
  work(J, T, 2, 'Vinod');
  require('../src/lib/mechanics').syncJobLabourForMonth(T.slice(0, 7));
  const before = await report.buildWorkbook(y, m);
  att.saveSettings({ enabled: true, start_date: T });
  att.saveRows(T, [{ mechanic_id: 1, status: 'present', time_in: '08:00', time_out: '17:00', break_minutes: 60 }], null);
  const after = await report.buildWorkbook(y, m);
  const ws = after.wb.getWorksheet('Attendance & utilisation');
  assert.ok(ws, 'the sheet is there');
  assert.strictEqual(after.wb.worksheets.length, before.wb.worksheets.length + 1, 'added last, nothing else changes');
  assert.deepStrictEqual(after.parts.repair.sums, before.parts.repair.sums, 'repair costs identical');
  assert.deepStrictEqual(after.total, before.total, 'totals identical');
  assert.ok(after.parts.attendance && after.parts.attendance.mechanics >= 1);
  const cells = []; ws.eachRow((row) => cells.push(row.values));
  const anuraRow = cells.find((r) => r.includes('Anura'));
  assert.strictEqual(anuraRow[4], 8, 'attended 8 h');
  assert.strictEqual(anuraRow[5], 6, 'booked 6 h');
  assert.ok(Math.abs(anuraRow[6] - 0.75) < 1e-9, 'utilisation 75%');
  // Switched off again, the same month is back to the fourteen sheets.
  att.saveSettings({ enabled: false });
  try {
    const off = await report.buildWorkbook(y, m);
    assert.ok(!off.wb.getWorksheet('Attendance & utilisation'));
    assert.strictEqual(off.wb.worksheets.length, before.wb.worksheets.length);
  } finally {
    att.saveSettings({ enabled: true });
  }
});

test('the day tally is a daily report: live, frozen, exported — for Daily Work readers only', async () => {
  const ws = await as('ws');
  const r = await req('GET', `/api/reports/daily/day_tally?date=${T}`, { cookie: ws });
  assert.strictEqual(r.status, 200, r.text);
  const anura = r.body.rows.find((x) => x.mechanic === 'Anura');
  assert.deepStrictEqual([anura.worked, anura.booked, anura.tally], [8, 6, 'unbooked']);
  const vinod = r.body.rows.find((x) => x.mechanic === 'Vinod');
  assert.deepStrictEqual([vinod.tally, vinod.red], ['no_attendance', true]);
  assert.strictEqual(r.body.red_count, 1);
  assert.strictEqual((await req('GET', `/api/reports/daily/day_tally?date=${T}`, { cookie: await as('sk') })).status, 403, 'no Daily Work clearance');
  assert.strictEqual((await req('GET', `/api/reports/daily/day_tally/export.xlsx?date=${T}`, { cookie: await as('sk') })).status, 403);
  const saved = await req('POST', '/api/reports/daily/day_tally/save', { cookie: ws, body: { date: T } });
  assert.strictEqual(saved.status, 200, saved.text);
  assert.strictEqual(daily.readSnapshot('day_tally', T).data.rows.length, r.body.rows.length);
  const x = await req('GET', `/api/reports/daily/day_tally/export.xlsx?date=${T}`, { cookie: ws });
  assert.strictEqual(x.status, 200);
  assert.match(x.type, /spreadsheetml/);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.raw);
  const vals = []; wb.worksheets[0].eachRow((row) => vals.push(row.values.join('|')));
  assert.ok(vals.some((v) => /Anura/.test(v) && /Unbooked/.test(v)));
  assert.ok(vals.some((v) => /Vinod/.test(v) && /No attendance/.test(v)));
  const month = await req('GET', `/api/attendance/month.xlsx?month=${T.slice(0, 7)}`, { cookie: ws });
  assert.strictEqual(month.status, 200);
  assert.match(month.type, /spreadsheetml/);
  assert.strictEqual((await req('GET', `/api/attendance/month.xlsx?month=${T.slice(0, 7)}`, { cookie: await as('sk') })).status, 403);
});

test('switched off, the day tally report is empty', () => {
  att.saveSettings({ enabled: false });
  try {
    const d = daily.build('day_tally', { asOf: T });
    assert.deepStrictEqual([d.enabled, d.rows.length], [false, 0]);
  } finally {
    att.saveSettings({ enabled: true });
  }
});

test('the dashboard: today\'s tally and the days still to sign off; the sign-off queue', async () => {
  const Y = att.addDays(T, -1);
  att.saveSettings({ start_date: att.addDays(T, -3) });
  const J2 = job(`2026/9/R/${950 + n}`, 'IN_PROGRESS', { requested_at: Y });
  work(J2, Y, 3, 'Vinod');
  const d = await req('GET', '/api/reports/dashboard', { cookie: await as('ws') });
  assert.strictEqual(d.status, 200, d.text);
  assert.strictEqual(d.body.attendance_today.date, T);
  assert.strictEqual(d.body.attendance_today.red_count, 1);
  assert.deepStrictEqual(d.body.attendance_today.unsigned_days.map((x) => x.date), [Y]);
  assert.strictEqual((await req('GET', '/api/reports/dashboard', { cookie: await as('sk') })).body.attendance_today, null, 'not for those without Daily Work');
  const pa = await req('GET', '/api/reports/pending-approvals', { cookie: await as('ws') });
  assert.deepStrictEqual(pa.body.signoff.map((x) => [x.date, x.red_count]), [[Y, 1]]);
  assert.ok(pa.body.is_approver && pa.body.total >= 1);
  assert.deepStrictEqual((await req('GET', '/api/reports/pending-approvals', { cookie: await as('om') })).body.signoff, [], 'only for those who sign days off');
  // Signed off, it leaves the list.
  att.saveRows(Y, [{ mechanic_id: 2, status: 'present', time_in: '08:00', time_out: '11:00', break_minutes: 0 }], null);
  assert.strictEqual((await req('POST', '/api/attendance/day/signoff', { cookie: await as('ws'), body: { date: Y } })).status, 200);
  const after = await req('GET', '/api/reports/dashboard', { cookie: await as('ws') });
  assert.deepStrictEqual(after.body.attendance_today.unsigned_days, []);
});
