'use strict';

// Improvement plan, Step 2b — reports and dashboards are kept apart too.
//
//   With the workshops kept apart, someone outside head office reads their own workshop's figures
//   in every report and on the dashboard: cost, the month, a vehicle's teardown, the job lists, the
//   anomalies, a project's cost, the Daily Work month. Stock figures are their own store's. A
//   figure that cannot be split by workshop (the vehicle cost rollup, the company's oil counts) is
//   head office's. Head office still reads everything, or the one workshop it picks; and while the
//   workshops are not kept apart nothing changes for anyone.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-step2b-'));
process.env.DB_PATH = path.join(TMP, 'step2b.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');
const workshops = require('../src/lib/workshops');
const stores = require('../src/lib/stores');
const stock = require('../src/lib/stock');
const scope = require('../src/lib/scope');
const audit = require('../src/lib/audit');

migrate();
for (const n of ['admin', 'workshop', 'manager', 'storekeeper']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
// A site lead reads every report section; the workshop role adds the daily-report notes.
run("INSERT OR IGNORE INTO roles (name, label) VALUES ('site_lead', 'Site lead')");
for (const m of ['reports', 'attention', 'cost_teardown', 'projects', 'dailywork', 'dashboard', 'jobs', 'service_plan', 'oil']) {
  run("INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES ('site_lead', ?, 'view')", m);
}
const CW = workshops.defaultId();
const MTR = run("INSERT INTO workshops (code, name, place) VALUES ('MTR', 'Muthur Workshop', 'Muthur')").lastInsertRowid;
const PW = 'ember-harbour-quarry';
function mkUser(username, roles, ws = CW) {
  const id = run('INSERT INTO users (username, password_hash, active, workshop_id) VALUES (?, ?, 1, ?)', username, auth.hashPassword(PW), ws).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const U = { boss: mkUser('boss', ['admin']), mgr: mkUser('mgr', ['manager']), leadM: mkUser('leadM', ['workshop', 'site_lead'], MTR) };
const actor = { id: U.boss, roles: ['admin'] };
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const TODAY = day(0);
const YM = TODAY.slice(0, 7);
const NOW = new Date();
let seq = 0;
const asset = (code) => run('INSERT INTO assets (code, code_norm, status, in_register) VALUES (?, ?, ?, 1)', code, code.replace(/\W/g, ''), 'active').lastInsertRowid;

// ================================================================== fixtures
// One vehicle worked on in both workshops, a project both work for, and each workshop's labour,
// receipts, oil, services and issues this month.
const S = {};
test('fixtures: a vehicle and a project shared by Central and Muthur, each with its own month', () => {
  stores.setStore(actor, MTR, { own: true, opened: TODAY });
  S.veh = asset('V-SHARED');
  S.proj = run("INSERT INTO projects (code, name) VALUES ('P1', 'Highway Package')").lastInsertRowid;
  const job = (ws, cost, extra = {}) => {
    const no = `${NOW.getFullYear()}/${NOW.getMonth() + 1}/R/${900 + (++seq)}`;
    const id = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, is_historical, requested_at, workshop_id, project_id,
                                           labour_cost, material_cost, total_cost, completed_at)
                    VALUES (?, ?, 'repair', 'fault', ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    no, extra.asset || S.veh, extra.status || 'IN_PROGRESS', TODAY, ws, S.proj, cost.labour, cost.material, cost.labour + cost.material,
    extra.status === 'CLOSED' ? TODAY : null).lastInsertRowid;
    return { id, no };
  };
  S.jC = job(CW, { labour: 400, material: 600 });
  S.jM = job(MTR, { labour: 100, material: 200 });
  S.jClosed = job(CW, { labour: 0, material: 0 }, { status: 'CLOSED', asset: asset('V-CW-ONLY') });   // no cost snapshot
  S.jC2 = job(CW, { labour: 0, material: 0 }, { asset: asset('V-CW-2') });   // a second vehicle in Central

  run("INSERT INTO job_labour (job_id, work_date, mechanic, hours, rate, amount) VALUES (?, ?, 'Chandra', 4, 100, 400)", S.jC.id, TODAY);
  run("INSERT INTO job_labour (job_id, work_date, mechanic, hours, rate, amount) VALUES (?, ?, 'Mohan', 2, 50, 100)", S.jM.id, TODAY);
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours, description) VALUES (?, ?, 'Chandra', 4, 'engine')", S.jC.id, TODAY);
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours, description) VALUES (?, ?, 'Mohan', 2, 'brakes')", S.jM.id, TODAY);
  // Mohan lent a hand at Central too, and Central worked in a month Muthur did not.
  run("INSERT INTO job_labour (job_id, work_date, mechanic, hours, rate, amount) VALUES (?, ?, 'Mohan', 1, 30, 30)", S.jC.id, TODAY);
  S.oldMonth = day(-75).slice(0, 7);
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours, description) VALUES (?, ?, 'Chandra', 1, 'old')", S.jC.id, day(-75));
  run("INSERT INTO job_parts (job_id, source_type, description, qty, unit_price) VALUES (?, 'grn', 'Central gasket', 1, 9)", S.jC.id);
  run("INSERT INTO job_parts (job_id, source_type, description, qty, unit_price) VALUES (?, 'grn', 'Muthur seal', 1, 4)", S.jM.id);

  // Requests and receipts: Central's twice the same line on one day (a likely double entry), and a
  // filter whose last price jumped; Muthur's one plain line.
  const mrn = (no, ws, jobId) => run(`INSERT INTO mrn (mrn_no, asset_id, job_id, workshop_id, req_date, approval_status, requested_by)
                                      VALUES (?, ?, ?, ?, ?, 'requested', 'someone')`, no, S.veh, jobId, ws, TODAY).lastInsertRowid;
  const line = (m, desc) => run("INSERT INTO mrn_lines (mrn_id, description, qty) VALUES (?, ?, 1)", m, desc).lastInsertRowid;
  const grn = (m, l, desc, qty, price, src, store) => run(`INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, unit_price, delivery_date, purchase_source_norm, store_id)
                                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 'G-' + (++seq), m, l, desc, qty, price, TODAY, src, store).lastInsertRowid;
  S.mC1 = mrn('MC-1', CW, S.jC.id); S.mC2 = mrn('MC-2', CW, S.jC.id); S.mM = mrn('MM-1', MTR, S.jM.id);
  S.lC = line(S.mC1, 'Filter X'); line(S.mC2, 'Filter X'); S.lM = line(S.mM, 'Wiper');
  grn(S.mC1, S.lC, 'Filter X', 1, 10, 'head_office', CW); grn(S.mC1, S.lC, 'Filter X', 1, 10, 'head_office', CW);
  S.grnC = grn(S.mC2, null, 'Filter X', 1, 80, 'head_office', CW);
  S.grnM = grn(S.mM, S.lM, 'Wiper', 1, 7, 'local_purchase', MTR);
  // Muthur's first Filter X, months ago: dear only next to Central's prices, not its own.
  S.grnOld = run(`INSERT INTO grn (grn_no, description, qty, unit_price, delivery_date, store_id) VALUES ('G-OLD', 'Filter X', 1, 60, ?, ?)`, day(-75), MTR).lastInsertRowid;
  // A hose (a catalogue item): Muthur paid 10, Central 50 — dear only next to Muthur's price.
  const hose = run("INSERT INTO store_items (name, category, is_general, balance) VALUES ('Hose', 'General Items', 1, 0)").lastInsertRowid;
  run(`INSERT INTO grn (grn_no, description, qty, unit_price, delivery_date, store_id, store_item_id) VALUES ('G-HOSE-M', 'Hose', 1, 10, ?, ?, ?)`, day(-80), MTR, hose);
  S.hoseC = run(`INSERT INTO grn (grn_no, description, qty, unit_price, delivery_date, store_id, store_item_id) VALUES ('G-HOSE-C', 'Hose', 1, 50, ?, ?, ?)`, day(-75), CW, hose).lastInsertRowid;
  // A belt: Muthur paid 100, Central 20 — Muthur has no other belt to judge it by, so no spike for it.
  const belt = run("INSERT INTO store_items (name, category, is_general, balance) VALUES ('Belt', 'General Items', 1, 0)").lastInsertRowid;
  S.beltM = run(`INSERT INTO grn (grn_no, description, qty, unit_price, delivery_date, store_id, store_item_id) VALUES ('G-BELT-M', 'Belt', 1, 100, ?, ?, ?)`, day(-85), MTR, belt).lastInsertRowid;
  run(`INSERT INTO grn (grn_no, description, qty, unit_price, delivery_date, store_id, store_item_id) VALUES ('G-BELT-C', 'Belt', 1, 20, ?, ?, ?)`, day(-82), CW, belt);

  // Oil: 100 L into Central, 30 L into Muthur (reorder at 40); 3 L and 2 L drawn this month.
  S.oil = run("INSERT INTO products (code, name, unit, unit_price, active) VALUES ('OIL-9001', 'Engine Oil 15W40', 'L', 10, 1)").lastInsertRowid;
  run("INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, txn_date, store_id) VALUES (?, 'receipt', 100, 100, 10, ?, ?)", S.oil, TODAY, CW);
  run("INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, txn_date, store_id) VALUES (?, 'receipt', 30, 130, 10, ?, ?)", S.oil, TODAY, MTR);
  run("INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, txn_date, store_id, job_id, asset_id) VALUES (?, 'issue', -3, 127, 10, ?, ?, ?, ?)", S.oil, TODAY, CW, S.jC.id, S.veh);
  run("INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, txn_date, store_id, job_id, asset_id) VALUES (?, 'issue', -2, 125, 10, ?, ?, ?, ?)", S.oil, TODAY, MTR, S.jM.id, S.veh);
  // Central's own vehicle: 1 L two months ago, 20 L today — far above its own rate. The last row's
  // balance is wrong, so the company's oil book does not add up (a check for head office).
  S.vCw = get("SELECT id FROM assets WHERE code = 'V-CW-ONLY'").id;
  run("INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, txn_date, store_id, job_id, asset_id) VALUES (?, 'issue', -1, 124, 10, ?, ?, ?, ?)", S.oil, day(-60), CW, S.jClosed.id, S.vCw);
  run("INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, txn_date, store_id, job_id, asset_id) VALUES (?, 'issue', -20, 0, 10, ?, ?, ?, ?)", S.oil, TODAY, CW, S.jClosed.id, S.vCw);
  // The shared vehicle drew a little at Central two months ago — Central's history, not Muthur's.
  run("INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, txn_date, store_id, job_id, asset_id) VALUES (?, 'issue', -1, 0, 10, ?, ?, ?, ?)", S.oil, day(-60), CW, S.jC.id, S.veh);
  require('../src/lib/lubricants').seedCatalogueAliases();
  run("INSERT INTO store_reorder (store_id, section, item_key, level) VALUES (?, 'oil', ?, 40)", MTR, stock.itemKey('oil', 'Engine Oil 15W40', 'OIL-9001'));
  // A general item low in the company's book, kept only in Central.
  run("INSERT INTO store_items (name, category, is_general, balance, min_stock, unit_cost) VALUES ('Shop Rag', 'General Items', 1, 1, 5, 5)");
  stock.rebuild({ wipe: true });
  // A second shared vehicle, oil drawn for its services (so no month's cost moves): Muthur 3 L two
  // months ago and 2 L today — its usual rate; Central 10 L today. Muthur's own figures are calm.
  S.veh2 = asset('V-SHARED-2');
  for (const [qty, when, store] of [[-3, day(-60), MTR], [-2, TODAY, MTR], [-10, TODAY, CW]]) {
    run(`INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, txn_date, store_id, asset_id, consumer_type)
         VALUES (?, 'issue', ?, 0, 10, ?, ?, ?, 'service')`, S.oil, qty, when, store, S.veh2);
  }

  // A service each (Muthur's labour 50), an issue each to the vehicle (Central 11, Muthur 22).
  const svcC = run("INSERT INTO service_jobs (vehicle_label, service_date, job_no, workshop_id, labour_charge) VALUES ('V-SHARED', ?, ?, ?, 15)", TODAY, S.jC.no, CW).lastInsertRowid;
  run("INSERT INTO service_oils (service_id, oil_name, qty, price) VALUES (?, 'Gear oil', 1, 5)", svcC);
  run("INSERT INTO service_jobs (vehicle_label, service_date, job_no, workshop_id, labour_charge) VALUES ('V-SHARED', ?, ?, ?, 50)", TODAY, S.jM.no, MTR);
  run("INSERT INTO issues (asset_id, job_id, description, qty, unit_price, issue_date, store_id) VALUES (?, ?, 'bolt', 1, 11, ?, ?)", S.veh, S.jC.id, TODAY, CW);
  run("INSERT INTO issues (asset_id, job_id, description, qty, unit_price, issue_date, store_id) VALUES (?, ?, 'nut', 1, 22, ?, ?)", S.veh, S.jM.id, TODAY, MTR);

  // The company's vehicle cost rollup (no workshop on it) and the company's oil count.
  run('INSERT INTO vehicle_monthly_costs (asset_id, year, month, total_cost) VALUES (?, ?, ?, 999)', S.veh, NOW.getFullYear(), NOW.getMonth() + 1);
  run("INSERT INTO stock_counts (product_id, period, book_qty, counted_qty, variance) VALUES (?, ?, 125, 120, -5)", S.oil, YM);

  // Somebody from each workshop did something.
  audit.record({ userId: U.boss, entity: 'job_card', entityId: S.jC.id, action: 'boss_did_this' });
  audit.record({ userId: U.leadM, entity: 'job_card', entityId: S.jM.id, action: 'muthur_did_this' });
});

// ================================================================== HTTP
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
        const buf = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(buf); } catch { /* not json */ }
        const sc = res.headers['set-cookie'];
        resolve({ status: res.statusCode, body: json, text: buf, headers: res.headers, cookie: sc ? sc[0].split(';')[0] : null });
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
const GET = async (user, p) => req('GET', p, { cookie: await as(user) });
const PUT = async (user, p, body) => req('PUT', p, { body, cookie: await as(user) });
const separate = (on) => scope.setSwitch(actor, on);
const projRow = (rows) => rows.find((r) => (r.project_id || r.id) === S.proj);

// ================================================================== switched off: as before
test('while the workshops are not kept apart, a site lead reads the company\'s figures, as before', async () => {
  separate(false);
  assert.strictEqual(projRow((await GET('leadM', '/api/reports/cost/by-project')).body).total, 1300);
  assert.strictEqual((await GET('leadM', '/api/reports/monthly')).body.this_month.labour, 530);
  const ov = (await GET('leadM', '/api/dashboard/overview')).body;
  assert.strictEqual(ov.monthly_cost_total, 999, 'the company rollup');
  assert.ok(ov.recent_activity.some((a) => a.action === 'boss_did_this'));
  assert.strictEqual((await GET('leadM', '/api/reports/vehicle-cost-complete?asset_id=' + S.veh + '&year=' + NOW.getFullYear())).status, 200);
  assert.strictEqual((await GET('leadM', '/api/reports/variance')).status, 200);
  assert.strictEqual((await PUT('leadM', `/api/reports/daily/job-summary/notes/${S.jC.id}`, { job_status: 'ok' })).status, 200);
  separate(true);
});

// ================================================================== cost reports
test('cost by vehicle, project, site and source are the site\'s own; head office reads all, or the one it picks', async () => {
  const total = (rows, k, v) => (rows.find((r) => r[k] === v) || {}).total;
  assert.strictEqual(total((await GET('leadM', '/api/reports/cost/by-asset')).body, 'asset_id', S.veh), 300);
  assert.strictEqual(total((await GET('mgr', '/api/reports/cost/by-asset')).body, 'asset_id', S.veh), 1300);
  assert.strictEqual(total((await GET('mgr', `/api/reports/cost/by-asset?workshop_id=${MTR}`)).body, 'asset_id', S.veh), 300, 'head office picks Muthur');
  assert.strictEqual(total((await GET('leadM', `/api/reports/cost/by-asset?workshop_id=${CW}`)).body, 'asset_id', S.veh), 300, 'a site cannot pick another');
  assert.strictEqual(projRow((await GET('leadM', '/api/reports/cost/by-project')).body).total, 300);
  assert.strictEqual(projRow((await GET('mgr', '/api/reports/cost/by-project')).body).total, 1300);
  assert.deepStrictEqual((await GET('leadM', '/api/reports/cost/by-site')).body.map((r) => r.total), [300]);
  assert.deepStrictEqual((await GET('leadM', '/api/reports/cost/by-source')).body.map((r) => [r.purchase_source, r.total]), [['(unspecified)', 170], ['Local Purchase', 7]]);
  assert.strictEqual((await GET('mgr', '/api/reports/cost/by-source')).body.length, 3);
  const x = await GET('leadM', '/api/reports/cost/by-asset?format=xlsx');
  assert.match(x.headers['content-disposition'], /cost-by-asset-MTR\.xlsx/);
});

// ================================================================== the month
test('the month: totals, the vehicles behind them and one vehicle\'s lines are the site\'s own', async () => {
  const m = (await GET('leadM', '/api/reports/monthly')).body.this_month;
  assert.deepStrictEqual([m.labour, m.head_office, m.local_purchase, m.oil, m.service, m.jobs, m.total], [100, 0, 7, 20, 50, 1, 177]);
  const hq = (await GET('mgr', '/api/reports/monthly')).body.this_month;
  assert.deepStrictEqual([hq.labour, hq.head_office, hq.oil, hq.service, hq.jobs], [530, 100, 250, 70, 4]);
  const a = (await GET('leadM', `/api/reports/monthly/${YM}/assets`)).body.assets;
  assert.deepStrictEqual(a.map((r) => [r.asset_id, r.labour, r.material, r.oil, r.total]), [[S.veh, 100, 7, 20, 127]]);
  const d = (await GET('leadM', `/api/reports/monthly/${YM}/asset/${S.veh}`)).body;
  assert.deepStrictEqual(d.labour_lines.map((l) => l.job_no), [S.jM.no]);
  assert.deepStrictEqual(d.material_lines.map((l) => l.description), ['Wiper']);
  assert.strictEqual(d.total, 127);
  assert.strictEqual((await GET('mgr', `/api/reports/monthly/${YM}/asset/${S.veh}`)).body.labour_lines.length, 3);
  assert.deepStrictEqual((await GET('mgr', `/api/reports/monthly/${YM}/assets`)).body.assets.map((r) => r.asset_id).sort(), [S.veh, S.vCw].sort());
});

// ================================================================== a vehicle, the job lists
test('a vehicle\'s teardown, the ongoing jobs and the jobs attended are the site\'s own', async () => {
  const t = (await GET('leadM', `/api/reports/teardown/asset/${S.veh}`)).body;
  assert.deepStrictEqual(t.jobs.map((j) => j.job_no), [S.jM.no]);
  assert.strictEqual(t.buckets.total, 300);
  assert.deepStrictEqual(t.mechanics.map((x) => [x.mechanic, x.amount]), [['Mohan', 100]], 'not the hour Mohan gave Central');
  assert.deepStrictEqual(t.parts.map((x) => x.description), ['Muthur seal']);
  assert.strictEqual((await GET('mgr', `/api/reports/teardown/asset/${S.veh}`)).body.buckets.total, 1300);
  const tp = (await GET('leadM', `/api/reports/teardown/asset/${S.veh}/print.html`)).text;
  assert.ok(tp.includes('Muthur Workshop') && tp.includes(S.jM.no) && !tp.includes(S.jC.no));

  const og = (await GET('leadM', '/api/reports/ongoing-jobs.html')).text;
  assert.ok(og.includes(S.jM.no) && !og.includes(S.jC.no), 'ongoing jobs: Muthur\'s only');
  assert.ok(og.includes('Muthur Workshop'));
  const ogHq = (await GET('mgr', '/api/reports/ongoing-jobs.html')).text;
  assert.ok(ogHq.includes(S.jM.no) && ogHq.includes(S.jC.no));
  assert.match((await GET('leadM', '/api/reports/ongoing-jobs.xlsx')).headers['content-disposition'], /-MTR\.xlsx/);
  const js = (await GET('leadM', '/api/reports/jobs-summary.html')).text;
  assert.ok(js.includes(S.jM.no) && !js.includes(S.jC.no), 'jobs attended: Muthur\'s only');
});

// ================================================================== anomalies and checks
test('anomalies and checks are the site\'s own; the dashboard counts them the same way', async () => {
  const an = (await GET('leadM', '/api/reports/anomalies')).body;
  assert.deepStrictEqual(an.unusual_consumption, []);
  assert.deepStrictEqual(an.duplicate_mrn.likely_double_entries, []);
  assert.deepStrictEqual(an.grn_price_spikes, []);
  const anHq = (await GET('mgr', '/api/reports/anomalies')).body;
  assert.deepStrictEqual(anHq.unusual_consumption.map((u) => u.asset_code).sort(), ['V-CW-ONLY', 'V-SHARED', 'V-SHARED-2'], 'the shared vehicles against Central\'s history: not Muthur\'s to see');
  assert.strictEqual(anHq.duplicate_mrn.likely_double_entries.length, 1, 'Central\'s Filter X twice on one day');
  const byId = (a, b) => a - b;
  assert.deepStrictEqual(anHq.grn_price_spikes.map((g) => g.grn_id).sort(byId), [S.grnC, S.grnOld, S.hoseC, S.beltM].sort(byId),
    'against the company\'s prices — head office sees them all');
  assert.strictEqual((await GET('leadM', '/api/reports/integrity')).body.count, 0);
  const ih = (await GET('mgr', '/api/reports/integrity')).body.issues.map((i) => i.type);
  assert.ok(ih.includes('closed_without_snapshot') && ih.includes('ledger_reconcile'), 'head office checks the company book');
  const na = (await GET('leadM', '/api/reports/dashboard')).body.needs_attention;
  assert.deepStrictEqual([na.unusual_consumption, na.duplicate_mrn, na.grn_price_spikes, na.integrity_issues], [0, 0, 0, 0]);
  const naHq = (await GET('mgr', '/api/reports/dashboard')).body.needs_attention;
  assert.deepStrictEqual([naHq.unusual_consumption, naHq.duplicate_mrn, naHq.grn_price_spikes], [3, 1, 4]);
  assert.ok(naHq.integrity_issues >= 2);
});

// ================================================================== what cannot be split
test('the company rollup and the company oil counts are head office\'s; stock value is the site\'s own store', async () => {
  const vc = await GET('leadM', `/api/reports/vehicle-cost-complete?asset_id=${S.veh}&year=${NOW.getFullYear()}`);
  assert.strictEqual(vc.status, 403);
  assert.match(vc.body.error, /whole company/);
  assert.strictEqual((await GET('mgr', `/api/reports/vehicle-cost-complete?asset_id=${S.veh}&year=${NOW.getFullYear()}`)).status, 200);
  assert.strictEqual((await GET('leadM', '/api/reports/variance')).status, 409);
  assert.strictEqual((await GET('mgr', '/api/reports/variance')).body.length, 1);
  const sv = (await GET('leadM', '/api/reports/stock-valuation')).body;
  assert.strictEqual(sv.store_id, MTR);
  assert.strictEqual(sv.oil_value, 280, '28 L on Muthur\'s shelf at Rs 10');
  assert.strictEqual(sv.grand_total, 437);
  // Muthur's shelf: its wiper, Filter X, hose and belt (each at the item's price, as every stock
  // screen values it).
  assert.strictEqual(sv.general_parts_value, 157, 'not Central\'s filters, hose and belt');
  assert.deepStrictEqual(sv.counts, { general: 4, oil: 1, filter: 0 });
  assert.strictEqual((await GET('mgr', '/api/reports/stock-valuation')).body.store_id, undefined, 'head office: the company\'s');
});

// ================================================================== requests, issues
test('the request analysis and a vehicle\'s issues are the site\'s own', async () => {
  const count = (b) => b.by_status.reduce((n, s) => n + s.count, 0);
  assert.strictEqual(count((await GET('leadM', '/api/reports/mrn-analysis')).body), 1);
  assert.strictEqual(count((await GET('mgr', '/api/reports/mrn-analysis')).body), 3);
  assert.deepStrictEqual((await GET('leadM', '/api/reports/mrn-analysis')).body.top_requested_items.map((i) => i.description), ['Wiper']);
  const iv = (await GET('leadM', `/api/reports/issues-by-vehicle?asset_id=${S.veh}`)).body;
  assert.deepStrictEqual([iv.summary.count, iv.summary.total_cost, iv.issues.map((i) => i.description)], [1, 22, ['nut']]);
  assert.strictEqual((await GET('mgr', `/api/reports/issues-by-vehicle?asset_id=${S.veh}`)).body.summary.total_cost, 33);
});

// ================================================================== the daily report notes
test('a note goes only on the site\'s own job, request line and receipt', async () => {
  assert.strictEqual((await PUT('leadM', `/api/reports/daily/job-summary/notes/${S.jC.id}`, { job_status: 'x' })).status, 403);
  assert.strictEqual((await PUT('leadM', `/api/reports/daily/job-summary/notes/${S.jM.id}`, { job_status: 'x' })).status, 200);
  assert.strictEqual((await PUT('leadM', `/api/reports/daily/pending-parts/notes/${S.lC}`, { remarks: 'x' })).status, 403);
  assert.strictEqual((await PUT('leadM', `/api/reports/daily/pending-parts/notes/${S.lM}`, { remarks: 'x' })).status, 200);
  const no = await PUT('leadM', `/api/reports/daily/pending-price/notes/${S.grnC}`, { remarks: 'x' });
  assert.strictEqual(no.status, 403);
  assert.match(no.body.error, /receipt belongs to/);
  assert.strictEqual((await PUT('leadM', `/api/reports/daily/pending-price/notes/${S.grnM}`, { remarks: 'x' })).status, 200);
  assert.strictEqual((await PUT('boss', `/api/reports/daily/pending-price/notes/${S.grnC}`, { remarks: 'x' })).status, 200);
});

// ================================================================== dashboards
test('the dashboard overview, live figures and workflow monitor are the site\'s own; head office\'s are the company\'s', async () => {
  const ov = (await GET('leadM', '/api/dashboard/overview')).body;
  assert.strictEqual(ov.active_jobs, 1);
  assert.strictEqual(ov.vehicles_in_workshop, 1);
  assert.strictEqual(ov.pending_requests, 1);
  assert.strictEqual(ov.todays_issue_cost, 22);
  assert.strictEqual(ov.monthly_cost_total, 177, 'worked out from Muthur\'s own month, not the company rollup');
  assert.deepStrictEqual(ov.top_5_cost_vehicles.map((v) => [v.asset_id, v.total_cost]), [[S.veh, 127]]);
  const last = ov.monthly_cost_trend[ov.monthly_cost_trend.length - 1];
  assert.deepStrictEqual([last.parts_cost, last.oil_cost, last.labour_cost, last.service_cost, last.total_cost], [7, 20, 100, 50, 177]);
  assert.deepStrictEqual(ov.job_status_breakdown.map((s) => [s.status, s.count]), [['IN_PROGRESS', 1]]);
  assert.deepStrictEqual(ov.recent_activity.map((a) => a.action).filter((a) => a.endsWith('did_this')), ['muthur_did_this']);
  assert.deepStrictEqual([ov.low_stock_items, ov.low_oil_stock, ov.low_filter_stock], [0, 1, 0], 'Muthur\'s store: the oil under 40');
  assert.deepStrictEqual(ov.stock_alerts.map((a) => a.kind), ['oil']);

  const hq = (await GET('mgr', '/api/dashboard/overview')).body;
  assert.strictEqual(hq.active_jobs, 3);
  assert.strictEqual(hq.monthly_cost_total, 999);
  assert.strictEqual(hq.monthly_cost_trend[0].service_cost, undefined, 'the company chart is as before');
  assert.ok(hq.recent_activity.some((a) => a.action === 'boss_did_this'));
  assert.strictEqual(hq.low_stock_items, 3, 'the company\'s book: the rag, the hose and the belt');

  const live = (await GET('leadM', '/api/dashboard/live-stats')).body;
  assert.deepStrictEqual([live.active_jobs, live.pending_requests, live.low_stock_alerts, live.todays_cost, live.monthly_cost], [1, 1, 1, 22, 177]);
  assert.strictEqual((await GET('mgr', '/api/dashboard/live-stats')).body.monthly_cost, 999);
  const wf = (await GET('leadM', '/api/dashboard/workflow-monitor')).body.kpis;
  assert.deepStrictEqual([wf.monthly_cost_total, wf.low_stock_total], [177, 1]);
});

// ================================================================== projects, the Daily Work month
test('a project\'s cost and the Daily Work month are the site\'s own', async () => {
  assert.strictEqual(projRow((await GET('leadM', '/api/projects')).body).month_cost, 300);
  assert.strictEqual(projRow((await GET('mgr', '/api/projects')).body).month_cost, 1300);
  assert.strictEqual((await GET('leadM', `/api/projects/${S.proj}`)).body.cost.total, 300);
  assert.deepStrictEqual((await GET('leadM', `/api/projects/${S.proj}/cost`)).body.map((r) => r.total), [300]);
  assert.deepStrictEqual((await GET('mgr', `/api/projects/${S.proj}/cost`)).body.map((r) => r.total), [1300]);
  const dw = (await GET('leadM', `/api/daily-work/monthly-summary?month=${YM}`)).body;
  assert.deepStrictEqual([dw.entries_count, dw.labor_summary.map((l) => l.mechanic), dw.total_labour_cost], [1, ['Mohan'], 100]);
  assert.ok(!dw.available_months.some((m) => m.month === S.oldMonth), 'a month only Central worked is not on Muthur\'s list');
  assert.ok((await GET('mgr', `/api/daily-work/monthly-summary?month=${YM}`)).body.available_months.some((m) => m.month === S.oldMonth));
  assert.strictEqual((await GET('mgr', `/api/daily-work/monthly-summary?month=${YM}`)).body.entries_count, 2);
});
