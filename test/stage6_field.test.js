'use strict';

// Multi-site Stage 6 — field work (src/lib/field.js).
//
//   A breakdown reported from a site opens a field job card at once. A card can be marked in the
//   field, at a project or site; three times give the response time and the downtime; travel is a
//   daily-work line marked travel; km driven are charged at the rate in force when entered. A field
//   board lists the open field jobs, the machines still down first. Parts brought back unused go back
//   into the store and off the job's cost. With no field jobs, nothing changes.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-s6-'));
process.env.DB_PATH = path.join(TMP, 's6.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const workshops = require('../src/lib/workshops');
const scope = require('../src/lib/scope');
const stock = require('../src/lib/stock');
const costing = require('../src/lib/costing');
const monthly = require('../src/lib/monthly_cost_report');
const fieldLib = require('../src/lib/field');

migrate();
for (const n of ['admin', 'workshop', 'manager', 'storekeeper', 'transport_manager', 'assistant_transport_manager']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
const CW = workshops.defaultId();
const PW = 'ember-harbour-quarry';
function mkUser(username, roles, ws = CW) {
  const id = run('INSERT INTO users (username, password_hash, active, workshop_id) VALUES (?, ?, 1, ?)', username, auth.hashPassword(PW), ws).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const U = {
  boss: mkUser('boss', ['admin']), wsC: mkUser('wsC', ['workshop']), sk: mkUser('sk', ['storekeeper']),
  tm: mkUser('tm', ['transport_manager']), atm: mkUser('atm', ['assistant_transport_manager']), mgr: mkUser('mgr', ['manager']),
};
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
// The field story happens yesterday, so its times (06:30, 08:00, 11:30) are always in the past
// whatever hour the tests run at; its month is the month the reports are asked for.
const DAY = day(-1);
const [YEAR, MONTH] = DAY.slice(0, 7).split('-').map(Number);
const at = (d, hm) => `${day(d)} ${hm}`;
let seq = 0;
const asset = (code) => run('INSERT INTO assets (code, code_norm, registration, status, in_register) VALUES (?, ?, ?, ?, 1)', code, code.replace(/\W/g, ''), code, 'active').lastInsertRowid;
const PROJ = run("INSERT INTO projects (name) VALUES ('Dam Project')").lastInsertRowid;
const SITE = run("INSERT INTO sites (project_id, name) VALUES (?, 'Spillway')", PROJ).lastInsertRowid;
run("INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Anura', 400, '2020-01-01')");
const V = { a: asset('EX-1'), b: asset('EX-2'), c: asset('EX-3'), busy: asset('EX-9') };
const BUSY = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, is_historical, requested_at, workshop_id)
  VALUES ('2026/9/R/999', ?, 'repair', 'in the workshop', 'IN_PROGRESS', 0, ?, ?)`, V.busy, DAY, CW).lastInsertRowid;

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
const jobRow = (id) => get('SELECT * FROM job_cards WHERE id = ?', id);
const B = {};

// ================================================================== nothing changes
test('no field jobs: every card a workshop card, no tile, no Field work sheet', async () => {
  const d = (await req('GET', '/api/reports/dashboard', { cookie: await as('mgr') })).body;
  assert.strictEqual(d.field_down, null);
  const j = (await req('GET', `/api/jobs/${BUSY}`, { cookie: await as('mgr') })).body;
  assert.strictEqual(j.field.field, false);
  assert.strictEqual(j.cost.other_cost, 0);
  const { wb } = await monthly.buildWorkbook(YEAR, MONTH);
  assert.strictEqual(wb.getWorksheet('Field work'), undefined);
});

// ================================================================== breakdowns
test('a breakdown from the site: a field job card at once — for the site and the workshop; checked', async () => {
  const atm = await as('atm');
  const bad = async (body, code, re) => { const r = await req('POST', '/api/field/breakdown', { cookie: atm, body }); assert.strictEqual(r.status, code, r.text); if (re) assert.match(r.body.error, re); };
  await bad({ description: 'x', place: `s:${SITE}` }, 400, /Choose the machine/);
  await bad({ asset_id: V.a, place: `s:${SITE}` }, 400, /what is wrong/i);
  await bad({ asset_id: V.a, description: 'hydraulic hose burst' }, 400, /site/);
  await bad({ asset_id: V.a, description: 'x', place: `s:${SITE}`, stopped_at: `${day(1)} 08:00` }, 400, /future/);
  await bad({ asset_id: V.busy, description: 'x', place: `s:${SITE}` }, 409, /already has an open job card \(2026\/9\/R\/999\)/);
  const r = await req('POST', '/api/field/breakdown', { cookie: atm, body: { asset_id: V.a, description: 'hydraulic hose burst', place: `s:${SITE}`, stopped_at: at(-1, '06:30') } });
  assert.strictEqual(r.status, 201, r.text);
  B.a = r.body.job.id;
  const j = jobRow(B.a);
  assert.deepStrictEqual([j.status, j.field, j.breakdown, j.field_place, j.field_location, j.project_id, j.reported_at, j.workshop_id],
    ['REQUESTED', 1, 1, `s:${SITE}`, 'Spillway (Dam Project)', PROJ, at(-1, '06:30'), CW]);
  // The workshop can report one too; a storekeeper cannot.
  const w = await req('POST', '/api/field/breakdown', { cookie: await as('wsC'), body: { asset_id: V.b, description: 'will not start', place: `p:${PROJ}`, stopped_at: at(-1, '09:00') } });
  assert.strictEqual(w.status, 201, w.text);
  B.b = w.body.job.id;
  assert.strictEqual((await req('POST', '/api/field/breakdown', { cookie: await as('sk'), body: { asset_id: V.c, description: 'x', place: `p:${PROJ}` } })).status, 403);
  // A workshop is not a field site.
  await bad({ asset_id: V.c, description: 'x', place: `w:${CW}` }, 400, /not at a workshop/);
});

// ================================================================== times and response
test('the times: one button each, in order; response and downtime from them', async () => {
  const wsC = await as('wsC');
  assert.strictEqual((await req('POST', `/api/field/jobs/${B.a}/working`, { cookie: wsC })).status, 409, 'working again needs the arrival first');
  assert.strictEqual((await req('POST', `/api/field/jobs/${B.a}/arrived`, { cookie: await as('tm') })).status, 403, 'the transport manager does not record field work');
  const a1 = await req('POST', `/api/field/jobs/${B.a}/arrived`, { cookie: wsC });
  assert.strictEqual(a1.status, 200, a1.text);
  assert.strictEqual((await req('POST', `/api/field/jobs/${B.a}/arrived`, { cookie: wsC })).status, 409, 'recorded once');
  // Correct the times by hand: arrived 08:00, working 11:30 — response 1.5 h, downtime 5 h.
  const p = await req('PATCH', `/api/field/jobs/${B.a}`, { cookie: wsC, body: { arrived_at: at(-1, '08:00'), working_at: at(-1, '11:30') } });
  assert.strictEqual(p.status, 200, p.text);
  assert.deepStrictEqual([p.body.response_hours, p.body.downtime_hours, p.body.down], [1.5, 5, false]);
  for (const [body, re] of [
    [{ arrived_at: at(-1, '06:00') }, /arrive before the breakdown/],
    [{ working_at: at(-1, '07:00') }, /working again before the mechanic arrived/],
    [{ arrived_at: '', working_at: at(-1, '11:30') }, /arrival before/],
    [{ reported_at: 'yesterday' }, /date and time/],
  ]) {
    const r = await req('PATCH', `/api/field/jobs/${B.a}`, { cookie: wsC, body });
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, re);
  }
});

// ================================================================== a workshop card goes out
test('marking a card in the field, and back: the site is a project or site, and back clears it', async () => {
  const wsC = await as('wsC');
  assert.strictEqual((await req('PATCH', `/api/field/jobs/${BUSY}`, { cookie: wsC, body: { km: 5 } })).status, 400, 'in the field first');
  assert.strictEqual((await req('POST', `/api/field/jobs/${BUSY}/arrived`, { cookie: wsC })).status, 409, 'a workshop card has no arrival');
  assert.strictEqual((await req('PATCH', `/api/field/jobs/${BUSY}`, { cookie: await as('atm'), body: { field: true } })).status, 403, 'reporting is not recording');
  const r = await req('PATCH', `/api/field/jobs/${BUSY}`, { cookie: wsC, body: { field: true, location: 'Dam Project' } });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual([r.body.field, r.body.place, r.body.breakdown], [true, `p:${PROJ}`, false], 'the text names the place');
  const back = await req('PATCH', `/api/field/jobs/${BUSY}`, { cookie: wsC, body: { field: false } });
  assert.deepStrictEqual([back.body.field, back.body.place, back.body.location], [false, null, null]);
});

// ================================================================== cost: km and travel
test('km at the rate then; travel costed like any hour, shown apart; the columns still add up', async () => {
  const wsC = await as('wsC');
  assert.strictEqual((await req('PUT', '/api/field/settings', { cookie: wsC, body: { km_rate: 150 } })).status, 403);
  assert.strictEqual((await req('PUT', '/api/field/settings', { cookie: await as('boss'), body: { km_rate: -1 } })).status, 400);
  assert.strictEqual((await req('PUT', '/api/field/settings', { cookie: await as('boss'), body: { km_rate: 150 } })).body.km_rate, 150);
  const total0 = jobRow(B.a).total_cost;
  let v = (await req('PATCH', `/api/field/jobs/${B.a}`, { cookie: wsC, body: { km: 40 } })).body;
  assert.deepStrictEqual([v.km, v.km_rate, v.transport_cost], [40, 150, 6000]);
  assert.strictEqual(jobRow(B.a).total_cost, total0 + 6000, 'the card total carries the km at once');
  await req('PUT', '/api/field/settings', { cookie: await as('boss'), body: { km_rate: 200 } });
  assert.strictEqual(jobRow(B.a).field_km_rate, 150, 'km already entered keep their rate');
  v = (await req('PATCH', `/api/field/jobs/${B.a}`, { cookie: wsC, body: { km: 50 } })).body;
  assert.deepStrictEqual([v.km_rate, v.transport_cost], [200, 10000], 'new km: the rate now');
  // Travel: 2 h there and back, 3 h of work.
  for (const [hours, travel] of [[2, true], [3, false]]) {
    const r = await req('POST', `/api/jobs/${B.a}/daily-work`, { cookie: wsC, body: { work_date: DAY, mechanic: 'Anura', hours, travel, description: travel ? 'to site and back' : 'hose replaced' } });
    assert.strictEqual(r.status, 201, r.text);
  }
  assert.deepStrictEqual(all('SELECT hours, travel FROM job_daily_work WHERE job_id = ? ORDER BY id', B.a), [{ hours: 2, travel: 1 }, { hours: 3, travel: 0 }]);
  const c = costing.reconciledCost(B.a);
  assert.deepStrictEqual([c.labour_cost, c.travel_hours, c.travel_cost, c.field_cost, c.other_cost, c.total_cost], [2000, 2, 800, 10000, 10000, 12000]);
  const j = jobRow(B.a);
  assert.strictEqual(j.labour_cost + j.material_cost + j.oil_cost + j.general_cost + j.other_cost, j.total_cost, 'the stored columns add up');
  assert.strictEqual(fieldLib.view(j).travel_hours, 2);
  // Travel on an external line is not travel.
  await req('POST', `/api/jobs/${B.a}/daily-work`, { cookie: wsC, body: { work_date: DAY, hours: 1, travel: true, is_external: true, external_value: 500 } });
  assert.strictEqual(get('SELECT travel FROM job_daily_work WHERE job_id = ? ORDER BY id DESC LIMIT 1', B.a).travel, 0);
});

// ================================================================== the board
test('the field board: still down first; the dashboard counts them; kept apart, your workshop\'s', async () => {
  const mgr = await as('mgr');
  const b = (await req('GET', '/api/field/board', { cookie: mgr })).body;
  assert.deepStrictEqual(b.rows.map((r) => [r.id, r.down]), [[B.b, true], [B.a, false]]);
  assert.strictEqual(b.down, 1);
  assert.strictEqual((await req('GET', '/api/reports/dashboard', { cookie: mgr })).body.field_down, 1);
  // Muthur's breakdown is Muthur's.
  const MTR = run("INSERT INTO workshops (code, name) VALUES ('MTR', 'Muthur Workshop')").lastInsertRowid;
  const wsM = mkUser('wsM', ['workshop'], MTR);
  const m = await req('POST', '/api/field/breakdown', { cookie: await as('wsM'), body: { asset_id: V.c, description: 'track off', place: `p:${PROJ}` } });
  assert.strictEqual(m.status, 201, m.text);
  assert.strictEqual(jobRow(m.body.job.id).workshop_id, MTR);
  scope.setSwitch({ id: U.boss }, true);
  const mine = (await req('GET', '/api/field/board', { cookie: await as('wsC') })).body;
  assert.ok(!mine.rows.some((r) => r.id === m.body.job.id), 'Central does not see Muthur\'s');
  assert.strictEqual((await req('POST', `/api/field/jobs/${m.body.job.id}/arrived`, { cookie: await as('wsC') })).status, 403);
  assert.strictEqual((await req('GET', '/api/reports/dashboard', { cookie: await as('wsM') })).body.field_down, 1);
  assert.strictEqual((await req('GET', '/api/field/board', { cookie: mgr })).body.down, 2, 'head office sees every one');
  scope.setSwitch({ id: U.boss }, false);
  run("UPDATE job_cards SET status = 'REJECTED' WHERE id = ?", m.body.job.id);
  run('UPDATE workshops SET active = 0 WHERE id = ?', MTR);
  void wsM;
});

// ================================================================== returns
test('parts brought back unused: back into the store they left, off the job\'s cost', async () => {
  run("INSERT INTO store_items (name, is_general, balance) VALUES ('Hydraulic Hose', 1, 0)");
  const g = run("INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, txn_date) VALUES ((SELECT id FROM store_items WHERE name = 'Hydraulic Hose'), 'opening', 10, 10, ?)", day(-2)).lastInsertRowid;
  void g;
  stock.syncItems(); stock.rebuild({ wipe: true });
  const item = get("SELECT id, item_key FROM stock_items WHERE name = 'Hydraulic Hose'");
  const sk = await as('sk');
  const iss = await req('POST', '/api/stores/stock-issue', { cookie: sk, body: { job_id: B.a, issue_date: DAY, lines: [{ stock_item_id: item.id, qty: 5, unit_price: 1000 }] } });
  assert.strictEqual(iss.status, 201, iss.text);
  const issue = get('SELECT * FROM issues WHERE job_id = ? ORDER BY id DESC LIMIT 1', B.a);
  const bal = () => stock.balanceOf('general', item.item_key, null);
  assert.strictEqual(bal(), 5);
  const before = jobRow(B.a).total_cost;
  assert.strictEqual((await req('POST', `/api/stores/issues/${issue.id}/return`, { cookie: await as('wsC'), body: { qty: 1 } })).status, 403, 'the storekeeper returns');
  run("INSERT OR IGNORE INTO roles (name, label) VALUES ('stclerk', 'Store clerk')");
  require('../src/lib/permissions').setPermission('stclerk', 'stores', 'edit');
  mkUser('clerk', ['stclerk']);
  assert.strictEqual((await req('POST', `/api/stores/issues/${issue.id}/return`, { cookie: await as('clerk'), body: { qty: 1 } })).status, 403, 'stores edit alone does not return');
  assert.strictEqual((await req('POST', `/api/stores/issues/${issue.id}/return`, { cookie: sk, body: { qty: 6 } })).status, 400);
  assert.strictEqual((await req('POST', `/api/stores/issues/${issue.id}/return`, { cookie: sk, body: { qty: 1, return_date: day(-3) } })).status, 400, 'not before the issue');
  const r = await req('POST', `/api/stores/issues/${issue.id}/return`, { cookie: sk, body: { qty: 2, note: 'not needed at site' } });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.body.left, 3);
  assert.strictEqual(bal(), 7, 'back on the shelf at once');
  assert.strictEqual(jobRow(B.a).total_cost, before - 2000, 'off the job\'s cost');
  const vmc = () => get('SELECT parts_cost FROM vehicle_monthly_costs WHERE asset_id = ? AND year = ? AND month = ?', V.a, YEAR, MONTH).parts_cost;
  assert.strictEqual(vmc(), 3000, 'off the machine\'s month');
  costing.recalcVehicleMonth(V.a, YEAR, MONTH);
  assert.strictEqual(vmc(), 3000, 'a recompute of the month keeps the return');
  assert.deepStrictEqual(get("SELECT qty, unit_price, source_type FROM job_parts WHERE job_id = ? AND source_type = 'return'", B.a), { qty: -2, unit_price: 1000, source_type: 'return' });
  const list = (await req('GET', `/api/stores/issues?job_id=${B.a}`, { cookie: sk })).body;
  assert.strictEqual(list.find((x) => x.id === issue.id).returned, 2);
  assert.strictEqual((await req('POST', `/api/stores/issues/${issue.id}/return`, { cookie: sk, body: { qty: 4 } })).status, 400, 'only 3 left');
  stock.rebuild({ wipe: true });
  assert.strictEqual(bal(), 7, 'a rebuild keeps the return');
});

test('a received part handed over and returned: the receipt has it on the shelf again', async () => {
  const m = run("INSERT INTO mrn (mrn_no, requested_by, approval_status, job_id) VALUES ('R6-1', 'x', 'approved', ?)", B.b).lastInsertRowid;
  const l = run("INSERT INTO mrn_lines (mrn_id, description, qty, category) VALUES (?, 'Starter Motor', 1, 'General Items')", m).lastInsertRowid;
  const gid = run("INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, unit_price, delivery_date) VALUES ('G6-1', ?, ?, 'Starter Motor', 1, 45000, ?)", m, l, DAY).lastInsertRowid;
  run("INSERT INTO job_parts (job_id, source_type, source_id, mrn_line_id, description, qty, unit_price) VALUES (?, 'grn', ?, ?, 'Starter Motor', 1, 45000)", B.b, gid, l);
  costing.refreshJobTotals(B.b);
  stock.rebuild({ wipe: true });
  const sk = await as('sk');
  assert.strictEqual((await req('POST', '/api/stores/stock-issue', { cookie: sk, body: { job_id: B.b, issue_date: DAY, lines: [{ grn_id: gid, qty: 1 }] } })).status, 201);
  assert.strictEqual(stock.receivedLine(gid).remaining, 0);
  const cost0 = jobRow(B.b).total_cost;
  const issue = get('SELECT id FROM issues WHERE grn_id = ?', gid);
  assert.strictEqual((await req('POST', `/api/stores/issues/${issue.id}/return`, { cookie: sk, body: { qty: 1 } })).status, 201);
  assert.strictEqual(stock.receivedLine(gid).remaining, 1, 'on the shelf again');
  assert.strictEqual(jobRow(B.b).total_cost, cost0 - 45000, 'the cost booked at receipt comes off the job');
});

// ================================================================== reports
test('the Job Cost workbook: a Field work sheet with each job and each site; closed field jobs say so', async () => {
  run("UPDATE job_cards SET status = 'CLOSED', completed_at = ? WHERE id = ?", DAY, B.a);
  const { wb, parts } = await monthly.buildWorkbook(YEAR, MONTH);
  const ws = wb.getWorksheet('Field work');
  assert.ok(ws, 'a month with field work has the sheet');
  assert.strictEqual(parts.field.jobs, 2);
  const firstRow = [3, 5, 8, 9, 11, 12].map((c) => ws.getCell(5, c).value);
  assert.deepStrictEqual(firstRow, [`${jobRow(B.a).job_no} (breakdown)`, 'Spillway (Dam Project)', 1.5, 5, 50, 10000]);
  const repair = wb.getWorksheet('Repair cost');
  let marked = null;
  repair.eachRow((row) => { if (row.getCell(3).value === jobRow(B.a).job_no) marked = row.getCell(15).value; });
  assert.strictEqual(marked, 'Field · 50 km');
  const month = (await req('GET', `/api/field/month?month=${DAY.slice(0, 7)}`, { cookie: await as('mgr') })).body;
  assert.deepStrictEqual(month.sites.map((s) => [s.site, s.jobs]).sort(), [['Dam Project', 1], ['Spillway (Dam Project)', 1]]);
  // A closed card's field details are locked.
  assert.strictEqual((await req('PATCH', `/api/field/jobs/${B.a}`, { cookie: await as('wsC'), body: { km: 1 } })).status, 409);
});

test('who may read: the field routes need Job Cards view', async () => {
  run("INSERT OR IGNORE INTO roles (name, label) VALUES ('nojobs', 'No jobs')");
  require('../src/lib/permissions').setPermission('nojobs', 'jobs', 'none');
  mkUser('nj', ['nojobs']);
  assert.strictEqual((await req('GET', '/api/field/board', { cookie: await as('nj') })).status, 403);
  assert.strictEqual((await req('GET', '/api/field/board', { cookie: await as('atm') })).status, 200);
});
