'use strict';

// Multi-site Stage 5 — reports per workshop.
//
//   Head office reads any workshop's reports or the whole company's; with the workshops kept apart
//   everyone else reads their own (store staff: the workshops their store serves). The Daily
//   Reports and their saved copies, the 14-sheet Job Cost workbook (with its monthly inputs), Repair
//   Detail, the reconciler and Daily Progress all follow the choice. A cost belongs to its job
//   card's workshop, else to the workshop of the store it came from. The whole company's workbook is
//   what it always was, plus "Workshops compared"; the workshops' workbooks add up to it. With one
//   workshop nothing changes.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-s5-'));
process.env.DB_PATH = path.join(TMP, 's5.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const workshops = require('../src/lib/workshops');
const scope = require('../src/lib/scope');
const daily = require('../src/lib/daily_reports');
const monthly = require('../src/lib/monthly_cost_report');

migrate();
for (const n of ['admin', 'workshop', 'manager', 'storekeeper']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
const CW = workshops.defaultId();
// Muthur starts retired: the first test is the one-workshop company.
const MTR = run("INSERT INTO workshops (code, name, place, active) VALUES ('MTR', 'Muthur Workshop', 'Muthur', 0)").lastInsertRowid;
const PW = 'ember-harbour-quarry';
function mkUser(username, roles, ws = CW) {
  const id = run('INSERT INTO users (username, password_hash, active, workshop_id) VALUES (?, ?, 1, ?)', username, auth.hashPassword(PW), ws).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const U = {
  boss: mkUser('boss', ['admin']), mgr: mkUser('mgr', ['manager']), skC: mkUser('skC', ['storekeeper']),
  wsC: mkUser('wsC', ['workshop']), wsM: mkUser('wsM', ['workshop'], MTR),
};
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const TODAY = day(0);
const YM = TODAY.slice(0, 7);
const [YEAR, MONTH] = YM.split('-').map(Number);
let seq = 0;
const asset = (code) => run('INSERT INTO assets (code, code_norm, registration, status, in_register) VALUES (?, ?, ?, ?, 1)', code, code.replace(/\W/g, ''), code, 'active').lastInsertRowid;
// A card closed today, with this month's labour and its material.
function closedJob(ws, labour, material) {
  const id = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, is_historical, requested_at, completed_at, workshop_id, material_cost)
    VALUES (?, ?, 'repair', 'brakes', 'CLOSED', 0, ?, ?, ?, ?)`, `2026/9/R/${900 + (++seq)}`, asset('V-' + seq), TODAY, TODAY, ws, material).lastInsertRowid;
  run('INSERT INTO job_labour (job_id, mechanic, hours, rate, amount, work_date) VALUES (?, ?, ?, 100, ?, ?)', id, 'Anura', labour / 100, labour, TODAY);
  run('INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, ?, ?, ?, ?)', id, TODAY, 'Anura', 'pads', labour / 100);
  return id;
}
const openJob = (ws) => run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, is_historical, requested_at, workshop_id)
  VALUES (?, ?, 'repair', 'engine', 'IN_PROGRESS', 0, ?, ?)`, `2026/9/R/${900 + (++seq)}`, asset('V-' + seq), TODAY, ws).lastInsertRowid;
const J = { c: closedJob(CW, 1000, 500), m: closedJob(MTR, 2000, 700), openC: openJob(CW), openM: openJob(MTR) };
const jobNo = (id) => get('SELECT job_no FROM job_cards WHERE id = ?', id).job_no;
// Requests still waiting for parts, and receipts still waiting for a price.
function request(ws, desc) {
  const m = run("INSERT INTO mrn (mrn_no, requested_by, approval_status, workshop_id, req_date) VALUES (?, 'x', 'approved', ?, ?)", 'R5-' + (++seq), ws, TODAY).lastInsertRowid;
  run("INSERT INTO mrn_lines (mrn_id, description, qty, category) VALUES (?, ?, 2, 'General Items')", m, desc);
  return m;
}
const M = { c: request(CW, 'Central bolt'), m: request(MTR, 'Muthur hose') };
const lineOf = (m) => get('SELECT id FROM mrn_lines WHERE mrn_id = ?', m).id;
run('INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, delivery_date) VALUES (?, ?, ?, ?, 1, ?)', 'G5-1', M.c, lineOf(M.c), 'Central bolt', TODAY);
run('INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, delivery_date) VALUES (?, ?, ?, ?, 1, ?)', 'G5-2', M.m, lineOf(M.m), 'Muthur hose', TODAY);
// A receipt with no request at all, taken into Muthur's store.
run('INSERT INTO grn (grn_no, description, qty, delivery_date, store_id) VALUES (?, ?, 1, ?, ?)', 'G5-3', 'Loose drum', TODAY, MTR);
// Services: one on Central's card, one on Muthur's, one with no card taken from Muthur's store.
const svc = (jobNoText, labour, store) => run(`INSERT INTO service_jobs (job_no, service_date, labour_charge, parts_subtotal, store_id)
  VALUES (?, ?, ?, 0, ?)`, jobNoText, TODAY, labour, store).lastInsertRowid;
const S = { c: svc(jobNo(J.openC), 300, CW), m: svc(jobNo(J.openM), 500, CW), loose: svc('', 250, MTR) };
// A tyre on Muthur's card; oil with no card from Muthur's store; a general item on Central's card.
run("INSERT INTO tyre_battery_prices (kind, category_norm, category, unit_price) VALUES ('tyre', '1000X20', '1000 X 20', 40000)");
run("INSERT INTO tyre_battery_issues (kind, issue_date, qty, category, category_norm, job_id, row_hash) VALUES ('tyre', ?, 1, '1000 X 20', '1000X20', ?, 't1')", TODAY, J.openM);
const PROD = run("INSERT INTO products (code, name, unit, category, unit_price) VALUES ('OIL-7001', 'Engine Oil 15W40', 'L', 'engine_oil', 1500)").lastInsertRowid;
run("INSERT INTO stock_ledger (product_id, kind, qty, balance_after, txn_date, store_id) VALUES (?, 'issue', -4, 0, ?, ?)", PROD, TODAY, MTR);
const RAG = run("INSERT INTO store_items (name, is_general, balance, unit_cost) VALUES ('Shop Rag', 1, 10, 50)").lastInsertRowid;
run("INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, job_id, txn_date) VALUES (?, 'issue', -3, 7, ?, ?)", RAG, J.openC, TODAY);
// Monthly inputs already entered (before this stage): Central's.
run("INSERT INTO monthly_report_inputs (year, month, sheet, seq, label, amount1) VALUES (?, ?, 'other', 0, 'Electricity', 10000)", YEAR, MONTH);

const app = require('../src/server');
let server; let port;
test.before(async () => { await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); }); port = server.address().port; });
test.after(() => { server && server.close(); });
function req(method, p, { body, cookie, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = {};
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null; if (!raw) { try { json = JSON.parse(buf.toString()); } catch { /* not json */ } }
        const sc = res.headers['set-cookie'];
        resolve({ status: res.statusCode, body: json, text: raw ? '' : buf.toString(), buf, headers: res.headers, cookie: sc ? sc[0].split(';')[0] : null });
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
const mrnNos = (d) => d.sections.flatMap((s) => s.rows.map((r) => r.mrn_no)).filter(Boolean);
const grnNos = (d) => d.sections.flatMap((s) => s.rows.map((r) => r.grn_no)).filter(Boolean);
const grand = async (ws) => (await monthly.buildWorkbook(YEAR, MONTH, { ws })).total.grand_total;
async function readXlsx(buf) { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; }

// ================================================================== one workshop: as before
test('one workshop: the whole company, the same titles, no comparison sheet — and a workshop asked for is ignored', async () => {
  assert.strictEqual(workshops.isMulti(), false);
  assert.deepStrictEqual(scope.reportWorkshop({ id: U.wsM, roles: ['workshop'] }, MTR), { ws: null, fixed: false, choices: null });
  const d = (await req('GET', `/api/reports/daily/pending_parts?workshop_id=${MTR}`, { cookie: await as('wsC') })).body;
  assert.deepStrictEqual(mrnNos(d).sort(), [get('SELECT mrn_no FROM mrn WHERE id = ?', M.c).mrn_no, get('SELECT mrn_no FROM mrn WHERE id = ?', M.m).mrn_no].sort());
  assert.strictEqual(d.workshop_name, null);
  const { wb } = await monthly.buildWorkbook(YEAR, MONTH);
  assert.strictEqual(wb.getWorksheet('Repair cost').getCell(1, 1).value, 'Edward and Christie (Pvt) Ltd — Badalgama W/S');
  assert.strictEqual(wb.getWorksheet('Workshops compared'), undefined);
  const mi = (await req('GET', `/api/reports/monthly-inputs?year=${YEAR}&month=${MONTH}`, { cookie: await as('mgr') })).body;
  assert.strictEqual(mi.editable, true);
  assert.deepStrictEqual(mi.inputs.other.map((l) => [l.label, l.workshop_id]), [['Electricity', CW]], 'what was entered before is Central\'s');
  assert.deepStrictEqual((await req('GET', `/api/reports/workshops-compared?year=${YEAR}&month=${MONTH}`, { cookie: await as('mgr') })).body.rows, []);
  const saved = (await req('POST', '/api/reports/daily/pending_parts/save', { cookie: await as('mgr'), body: { date: TODAY } })).body;
  assert.strictEqual(saved.workshop_id, 0);
});

// ================================================================== who reads which workshop
test('who reads which workshop: head office any or all; kept apart, the rest their own; store staff the workshops their store serves', async () => {
  run('UPDATE workshops SET active = 1 WHERE id = ?', MTR);
  assert.strictEqual(workshops.isMulti(), true);
  const as_ = (id, roles) => ({ id, roles });
  // Switched off: anyone may pick, as with every other screen.
  assert.deepStrictEqual(scope.reportWorkshop(as_(U.wsM, ['workshop']), CW), { ws: CW, fixed: false, choices: null });
  assert.deepStrictEqual(scope.reportWorkshop(as_(U.wsM, ['workshop'])), { ws: null, fixed: false, choices: null });
  scope.setSwitch({ id: U.boss }, true);
  assert.deepStrictEqual(scope.reportWorkshop(as_(U.mgr, ['manager']), MTR), { ws: MTR, fixed: false, choices: null });
  assert.deepStrictEqual(scope.reportWorkshop(as_(U.mgr, ['manager']), 999), { ws: null, fixed: false, choices: null });
  assert.deepStrictEqual(scope.reportWorkshop(as_(U.wsM, ['workshop']), CW), { ws: MTR, fixed: true, choices: [MTR] });
  // One store serves both workshops: its staff see both, and pick.
  assert.deepStrictEqual(scope.reportWorkshop(as_(U.skC, ['storekeeper']), MTR), { ws: MTR, fixed: false, choices: null });
  scope.setSwitch({ id: U.boss }, false);
});

// ================================================================== daily reports
test('daily reports: each workshop its own requests, receipts and jobs; the whole company all of them', async () => {
  const mgr = await as('mgr');
  const get_ = async (kind, ws) => (await req('GET', `/api/reports/daily/${kind}${ws ? `?workshop_id=${ws}` : ''}`, { cookie: mgr })).body;
  const noOf = (id) => get('SELECT mrn_no FROM mrn WHERE id = ?', id).mrn_no;
  assert.deepStrictEqual(mrnNos(await get_('pending_parts', MTR)), [noOf(M.m)]);
  assert.deepStrictEqual(mrnNos(await get_('pending_parts', CW)), [noOf(M.c)]);
  assert.strictEqual(mrnNos(await get_('pending_parts')).length, 2);
  assert.strictEqual((await get_('pending_parts', MTR)).workshop_name, 'Muthur Workshop');
  assert.deepStrictEqual(grnNos(await get_('pending_price', MTR)).sort(), ['G5-2', 'G5-3'], 'a receipt with no request is its store\'s');
  assert.deepStrictEqual(grnNos(await get_('pending_price', CW)), ['G5-1']);
  // The job summary lists the machines worked on this month.
  const sumM = await get_('job_summary', MTR);
  assert.deepStrictEqual(sumM.rows.map((r) => r.job_id), []);
  run('INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, ?, ?, ?, 2)', J.openM, TODAY, 'Anura', 'hose');
  run('INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, ?, ?, ?, 3)', J.openC, TODAY, 'Anura', 'bolt');
  assert.deepStrictEqual((await get_('job_summary', MTR)).rows.map((r) => r.job_id), [J.openM]);
  assert.deepStrictEqual((await get_('job_summary', CW)).rows.map((r) => r.job_id), [J.openC]);
  // The Excel carries the workshop.
  const x = await req('GET', `/api/reports/daily/job_summary/export.xlsx?workshop_id=${MTR}`, { cookie: mgr, raw: true });
  assert.match(x.headers['content-disposition'], /Job report MTR /);
  const wb = await readXlsx(x.buf);
  assert.strictEqual(wb.worksheets[0].getCell(1, 1).value, 'Maintenance Summery-  Muthur Workshop');
});

test('the day tally of one workshop: its own mechanics, even with the workshops not kept apart', () => {
  require('../src/lib/attendance').saveSettings({ enabled: true, start_date: day(-20) });
  run("INSERT INTO mechanics (name, name_norm) VALUES ('Anura', 'ANURA'), ('Kasun', 'KASUN')");
  const ANURA = get("SELECT id FROM mechanics WHERE name = 'Anura'").id;
  run('INSERT INTO mechanic_workshops (mechanic_id, workshop_id, from_date) VALUES (?, ?, ?)', ANURA, MTR, day(-10));
  assert.deepStrictEqual(daily.dayTally({ ws: MTR }).rows.map((r) => r.mechanic), ['Anura']);
  assert.deepStrictEqual(daily.dayTally({ ws: CW }).rows.map((r) => r.mechanic), ['Kasun']);
  assert.deepStrictEqual(daily.dayTally({}).rows.map((r) => r.mechanic), ['Anura', 'Kasun']);
});

test('saved copies: one per workshop and one for the company; each read back and listed apart', async () => {
  const mgr = await as('mgr');
  const past = day(-2);
  for (const ws of [MTR, CW, null]) {
    const r = await req('POST', '/api/reports/daily/pending_parts/save', { cookie: mgr, body: { date: past, workshop_id: ws || undefined } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.workshop_id, ws || 0);
  }
  assert.strictEqual(get("SELECT COUNT(*) n FROM daily_report_snapshots WHERE kind = 'pending_parts' AND report_date = ?", past).n, 3);
  const back = (await req('GET', `/api/reports/daily/pending_parts?date=${past}&workshop_id=${MTR}`, { cookie: mgr })).body;
  assert.strictEqual(back.saved, true);
  assert.strictEqual(back.workshop_name, 'Muthur Workshop');
  const hist = (await req('GET', `/api/reports/daily/pending_parts/history?workshop_id=${MTR}`, { cookie: mgr })).body;
  assert.ok(hist.length && hist.every((h) => h.workshop_id === MTR));
});

// ================================================================== the Job Cost workbook
test('the workbook of one workshop: its jobs, services, tyres, oil, items and inputs — its name on top', async () => {
  const m = await monthly.buildWorkbook(YEAR, MONTH, { ws: MTR });
  const c = await monthly.buildWorkbook(YEAR, MONTH, { ws: CW });
  assert.strictEqual(m.wb.getWorksheet('Repair cost').getCell(1, 1).value, 'Edward and Christie (Pvt) Ltd — Muthur Workshop');
  assert.deepStrictEqual(m.parts.repair.closed_jobs.map((j) => j.id), [J.m]);
  assert.deepStrictEqual(c.parts.repair.closed_jobs.map((j) => j.id), [J.c]);
  assert.deepStrictEqual(m.parts.service.service_jobs.map((s) => s.id).sort(), [S.m, S.loose].sort(), 'a service goes with its card, else its store');
  assert.deepStrictEqual(c.parts.service.service_jobs.map((s) => s.id), [S.c]);
  assert.strictEqual(m.parts.tyre.sums.total, 40000);
  assert.strictEqual(c.parts.tyre.sums.total, 0);
  assert.strictEqual(m.parts.oils.sums.total, 6000, 'oil with no card: its store\'s');
  assert.strictEqual(c.parts.oils.sums.total, 0);
  assert.strictEqual(c.parts.general.sums.total, 150);
  assert.strictEqual(m.parts.general.sums.total, 0);
  assert.strictEqual(c.parts.other.sums.total, 10000);
  assert.strictEqual(m.parts.other.sums.total, 0);
  // Each service's share of the transport pool is the company's reckoning.
  const all_ = await monthly.buildWorkbook(YEAR, MONTH);
  const share = (b) => b.parts.service.sums.transport;
  assert.ok(Math.abs(share(m) + share(c) - share(all_)) < 0.05);
  // The workshops add up to the company.
  assert.ok(Math.abs((await grand(MTR)) + (await grand(CW)) - (await grand(null))) < 0.05);
  assert.strictEqual(all_.wb.getWorksheet('Repair cost').getCell(1, 1).value, 'Edward and Christie (Pvt) Ltd — Badalgama W/S');
  const cmp = all_.wb.getWorksheet('Workshops compared');
  assert.ok(cmp, 'the company\'s workbook compares the workshops');
  assert.deepStrictEqual([cmp.getCell(5, 1).value, cmp.getCell(6, 1).value], ['Central Workshop — Badalgama', 'Muthur Workshop']);
});

test('the workbook over HTTP: the workshop in the file name; kept apart, the rest get their own', async () => {
  const r = await req('GET', `/api/reports/monthly-cost.xlsx?year=${YEAR}&month=${MONTH}&workshop_id=${MTR}`, { cookie: await as('mgr'), raw: true });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['content-disposition'], /-MTR\.xlsx/);
  scope.setSwitch({ id: U.boss }, true);
  const own = await req('GET', `/api/reports/monthly-cost.xlsx?year=${YEAR}&month=${MONTH}&workshop_id=${CW}`, { cookie: await as('wsM'), raw: true });
  assert.match(own.headers['content-disposition'], /-MTR\.xlsx/, 'asking for Central gives Muthur\'s own');
  const wb = await readXlsx(own.buf);
  assert.strictEqual(wb.getWorksheet('Workshops compared'), undefined);
  const pp = (await req('GET', `/api/reports/daily/pending_parts?workshop_id=${CW}`, { cookie: await as('wsM') })).body;
  assert.deepStrictEqual(mrnNos(pp), [get('SELECT mrn_no FROM mrn WHERE id = ?', M.m).mrn_no]);
  scope.setSwitch({ id: U.boss }, false);
});

test('monthly inputs: one workshop at a time; saving replaces only that workshop\'s lines', async () => {
  const mgr = await as('mgr');
  const all_ = (await req('GET', `/api/reports/monthly-inputs?year=${YEAR}&month=${MONTH}`, { cookie: mgr })).body;
  assert.strictEqual(all_.editable, false);
  const none = await req('POST', '/api/reports/monthly-inputs', { cookie: mgr, body: { year: YEAR, month: MONTH, sheet: 'other', lines: [] } });
  assert.strictEqual(none.status, 400);
  assert.match(none.body.error, /Choose a workshop/);
  const r = await req('POST', '/api/reports/monthly-inputs', { cookie: mgr, body: { year: YEAR, month: MONTH, sheet: 'other', workshop_id: MTR, lines: [{ label: 'Generator', amount1: 4000 }] } });
  assert.strictEqual(r.status, 200, r.text);
  const mine = (await req('GET', `/api/reports/monthly-inputs?year=${YEAR}&month=${MONTH}&workshop_id=${MTR}`, { cookie: mgr })).body;
  assert.strictEqual(mine.editable, true);
  assert.deepStrictEqual(mine.inputs.other.map((l) => l.label), ['Generator']);
  assert.deepStrictEqual(all('SELECT label, workshop_id FROM monthly_report_inputs WHERE sheet = ? ORDER BY id', 'other'),
    [{ label: 'Electricity', workshop_id: CW }, { label: 'Generator', workshop_id: MTR }], 'Central\'s line is untouched');
  assert.strictEqual((await monthly.buildWorkbook(YEAR, MONTH, { ws: MTR })).parts.other.sums.total, 4000);
  // Kept apart, Muthur writes only its own, whatever it asks for. Saving needs the monthly-cost
  // permission: without it the workshop user is refused outright.
  scope.setSwitch({ id: U.boss }, true);
  const refused = await req('POST', '/api/reports/monthly-inputs', { cookie: await as('wsM'), body: { year: YEAR, month: MONTH, sheet: 'other', workshop_id: MTR, lines: [{ label: 'Water', amount1: 900 }] } });
  assert.strictEqual(refused.status, 403, 'monthly inputs need reports.monthly_cost.edit');
  require('../src/lib/capabilities').setCapability('workshop', 'reports.monthly_cost.edit', true);
  await req('POST', '/api/reports/monthly-inputs', { cookie: await as('wsM'), body: { year: YEAR, month: MONTH, sheet: 'other', workshop_id: CW, lines: [{ label: 'Water', amount1: 900 }] } });
  assert.deepStrictEqual(all('SELECT label, workshop_id FROM monthly_report_inputs WHERE sheet = ? ORDER BY id', 'other').map((x) => [x.label, x.workshop_id]),
    [['Electricity', CW], ['Water', MTR]]);
  // ...and prices only its own services.
  await req('POST', '/api/reports/service-outside', { cookie: await as('wsM'), body: { items: [{ id: S.c, outside: 99 }, { id: S.m, outside: 88 }] } });
  assert.deepStrictEqual([get('SELECT outside_estimate v FROM service_jobs WHERE id = ?', S.c).v, get('SELECT outside_estimate v FROM service_jobs WHERE id = ?', S.m).v], [0, 88]);
  require('../src/lib/capabilities').setCapability('workshop', 'reports.monthly_cost.edit', false);
  scope.setSwitch({ id: U.boss }, false);
});

test('workshops compared: one row per workshop, each its own workbook\'s figures; head office only', async () => {
  const d = (await req('GET', `/api/reports/workshops-compared?year=${YEAR}&month=${MONTH}`, { cookie: await as('mgr') })).body;
  assert.deepStrictEqual(d.rows.map((r) => r.code), ['CW', 'MTR']);
  const mtr = d.rows.find((r) => r.code === 'MTR');
  assert.ok(Math.abs(mtr.total - (await grand(MTR))) < 0.01);
  assert.strictEqual(mtr.jobs_closed, 1);
  assert.strictEqual(mtr.hours_booked, 22, 'Muthur: 20 hours on the closed card, 2 on the open one');
  assert.strictEqual(d.rows.find((r) => r.code === 'CW').services, 1);
  scope.setSwitch({ id: U.boss }, true);
  assert.strictEqual((await req('GET', `/api/reports/workshops-compared?year=${YEAR}&month=${MONTH}`, { cookie: await as('wsM') })).status, 403);
  scope.setSwitch({ id: U.boss }, false);
});

test('repair detail, the reconciler and daily progress follow the workshop; the vehicle teardown names each job\'s', async () => {
  const mgr = await as('mgr');
  const html = (await req('GET', `/api/reports/monthly-repair-detail.html?year=${YEAR}&month=${MONTH}&workshop_id=${MTR}`, { cookie: mgr })).text;
  assert.ok(html.includes(jobNo(J.m)) && !html.includes(jobNo(J.c)));
  assert.match(html, /Ltd — Muthur Workshop/);
  const secs = (await req('GET', `/api/reports/repair-sections?year=${YEAR}&month=${MONTH}&workshop_id=${CW}`, { cookie: mgr })).body;
  assert.deepStrictEqual(secs.closed_jobs.map((j) => j.id), [J.c]);
  assert.strictEqual(secs.tally.total_daily_work_labour, 10 * 250 + 3 * 250, 'the daily work on Central\'s cards only');
  run("INSERT INTO stock_ledger (product_id, kind, qty, balance_after, job_id, txn_date) VALUES (?, 'issue', -1, 0, ?, ?)", PROD, J.openC, TODAY);
  const dp = (await req('GET', `/api/reports/daily-progress?date=${TODAY}&workshop_id=${MTR}`, { cookie: mgr })).body;
  assert.deepStrictEqual(dp.jobs.map((j) => j.job_id).sort(), [J.m, J.openM].sort());
  assert.deepStrictEqual(dp.requested.map((r) => r.mrn_no), [get('SELECT mrn_no FROM mrn WHERE id = ?', M.m).mrn_no]);
  assert.deepStrictEqual(dp.oil.map((o) => o.job_no), [null], 'the oil from Muthur\'s store, not the oil on Central\'s card');
  const dpAll = (await req('GET', `/api/reports/daily-progress?date=${TODAY}`, { cookie: mgr })).body;
  assert.strictEqual(dpAll.jobs.length, 4);
  const aid = get('SELECT asset_id FROM job_cards WHERE id = ?', J.m).asset_id;
  const td = (await req('GET', `/api/reports/teardown/asset/${aid}`, { cookie: mgr })).body;
  assert.strictEqual(td.jobs[0].workshop_name, 'Muthur Workshop');
});
