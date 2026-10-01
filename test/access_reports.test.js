'use strict';

// Reports are checked on the server, not only hidden in the menu (access plan, AC-D13).
//
//   Every /api/reports address needs the Reports section (view) — except the few read from other
//   sections: the Dashboard's own figures and your approvals (everyone signed in, the figures trimmed
//   to the sections the person may see), a job card's report and cost sheet (Job Cards), the day
//   tally (Daily Work) and a service's outside prices (Service Records edit, or the monthly-inputs
//   permission). Entering the monthly inputs needs its own permission. The Dashboard's Live Overview
//   (/api/dashboard) needs Reports too, as the Dashboard screen already asked.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-accrep-'));
process.env.DB_PATH = path.join(TMP, 'ar.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');
const perms = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');

migrate();
for (const n of ['admin', 'workshop', 'manager', 'storekeeper', 'main_storekeeper', 'operational_manager', 'transport_manager',
  'assistant_transport_manager', 'purchase_local', 'purchase_head_office', 'viewer']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
capabilities.seedCapabilities();
perms.seedDefaults();
// Roles an admin might make: job cards only; daily work only; nothing at all.
run("INSERT INTO roles (name, label) VALUES ('jobsonly', 'Job cards only'), ('dwonly', 'Daily work only'), ('nothing', 'Nothing')");
for (const m of perms.MODULE_KEYS) {
  perms.setPermission('jobsonly', m, m === 'jobs' ? 'view' : 'none');
  perms.setPermission('dwonly', m, m === 'dailywork' ? 'view' : 'none');
  perms.setPermission('nothing', m, 'none');
}

const PW = 'copper-lantern-gravel';
function mkUser(username, roles) {
  const id = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', username, auth.hashPassword(PW)).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
for (const [u, r] of [['boss', 'admin'], ['buyer', 'purchase_local'], ['view', 'viewer'], ['ws', 'workshop'], ['sk', 'storekeeper'],
  ['om', 'operational_manager'], ['jo', 'jobsonly'], ['dw', 'dwonly'], ['no', 'nothing']]) mkUser(u, [r]);

// A card with a cost this month, and a service record.
const today = new Date().toISOString().slice(0, 10);
const A = run("INSERT INTO assets (code, code_norm, status, in_register) VALUES ('EX-1', 'EX1', 'active', 1)").lastInsertRowid;
const P = run("INSERT INTO projects (name) VALUES ('Harbour road')").lastInsertRowid;
const J = run(`INSERT INTO job_cards (job_no, asset_id, project_id, type, description, status, requested_at, total_cost)
               VALUES ('2026/9/R/1', ?, ?, 'repair', 'Hydraulic leak', 'IN_PROGRESS', ?, 12500)`, A, P, today).lastInsertRowid;
const A2 = run("INSERT INTO assets (code, code_norm, status, in_register) VALUES ('EX-2', 'EX2', 'active', 1)").lastInsertRowid;
run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at, partial_closed_at)
     VALUES ('2026/9/R/2', ?, 'repair', 'Waiting for the bill', 'PARTIALLY_CLOSED', ?, ?)`, A2, today, today);
// A lubricant below its reorder level, and a battery whose warranty runs out soon.
run("INSERT INTO products (name, unit, reorder_level, active) VALUES ('Engine oil 15W-40', 'L', 10, 1)");
run("INSERT INTO batteries (serial_no, warranty_date, state) VALUES ('BT-777', date('now', '+10 days'), 'installed')");
const SVC = run("INSERT INTO service_jobs (vehicle_label, asset_id, service_date) VALUES ('EX-1', ?, ?)", A, today).lastInsertRowid;

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
        resolve({ status: res.statusCode, body: json, text: buf });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const cookies = {};
async function as(user) {
  if (!cookies[user]) {
    const r = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ username: user, password: PW });
      const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/login',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.headers['set-cookie'][0].split(';')[0]));
      });
      q.on('error', reject); q.write(data); q.end();
    });
    cookies[user] = r;
  }
  return cookies[user];
}
const call = async (user, method, p, body) => req(method, '/api' + p, { cookie: await as(user), body });
const status = async (user, method, p, body) => (await call(user, method, p, body)).status;
const Y = new Date().getFullYear();
const inputs = { year: Y, month: 1, sheet: 'fuel', lines: [{ label: 'Diesel', amount1: 1000 }] };

// ================================================================== every report
test('someone without Reports is refused every report on the server', async () => {
  const router = require('../src/routes/reports');
  const fill = (p) => p.replace(':id', String(J)).replace(':month', `${Y}-01`).replace(':kind', 'pending_parts')
    .replace(':jobId', String(J)).replace(':lineId', '1').replace(':grnId', '1');
  // Read from other sections, checked for those instead (below).
  const elsewhere = new Set(['/dashboard', '/pending-approvals', '/service-outside',
    '/job/:id/report', '/job/:id/report.html', '/job/:id/costsheet', '/job/:id/costsheet.html']);
  let n = 0;
  for (const layer of router.stack.filter((l) => l.route)) {
    const p = layer.route.path;
    if (elsewhere.has(p)) continue;
    for (const method of Object.keys(layer.route.methods)) {
      n++;
      for (const user of ['buyer', 'no']) {
        assert.strictEqual(await status(user, method.toUpperCase(), '/reports' + fill(p), method === 'get' ? undefined : {}), 403,
          `${user}: ${method.toUpperCase()} /reports${p}`);
      }
    }
  }
  assert.ok(n >= 35, `every address walked (${n})`);
  for (const p of ['/dashboard/overview', '/dashboard/live-stats']) {
    assert.strictEqual(await status('buyer', 'GET', p), 403, p);
    assert.strictEqual(await status('view', 'GET', p), 200, p + ' with Reports');
  }
});

test('with Reports view the reports open, as before', async () => {
  for (const p of ['/reports/monthly', '/reports/service-due', `/reports/monthly-inputs?year=${Y}&month=1`, '/reports/daily/pending_parts',
    `/reports/daily-progress?date=${today}`, '/reports/ongoing-jobs.html']) {
    for (const user of ['view', 'ws', 'sk', 'om', 'boss']) assert.strictEqual(await status(user, 'GET', p), 200, `${user}: ${p}`);
  }
});

// ================================================================== the writes
test('entering the monthly inputs needs its own permission; the read-only viewer and the buyers do not have it', async () => {
  const holders = capabilities.CAPABILITIES.find((c) => c.key === 'reports.monthly_inputs').legacy.slice().sort();
  assert.deepStrictEqual(holders, ['assistant_transport_manager', 'main_storekeeper', 'manager', 'operational_manager', 'storekeeper',
    'transport_manager', 'workshop'], 'every built-in role that could open the Reports page, except the viewer');
  for (const user of ['buyer', 'view', 'no', 'jo', 'dw']) assert.strictEqual(await status(user, 'POST', '/reports/monthly-inputs', inputs), 403, user);
  for (const user of ['ws', 'om', 'boss']) assert.strictEqual(await status(user, 'POST', '/reports/monthly-inputs', inputs), 200, user);
  assert.strictEqual(get("SELECT COUNT(*) c FROM monthly_report_inputs WHERE sheet = 'fuel'").c, 1);
  // Taken away from a role on the Access screen, it is gone for its holders at once.
  capabilities.setCapability('workshop', 'reports.monthly_inputs', false);
  try { assert.strictEqual(await status('ws', 'POST', '/reports/monthly-inputs', inputs), 403); }
  finally { capabilities.setCapability('workshop', 'reports.monthly_inputs', true); }
});

test('a service\'s outside price: Service Records edit, or the monthly-inputs permission', async () => {
  const body = (v) => ({ items: [{ id: SVC, outside: v }] });
  const before = get('SELECT outside_estimate v FROM service_jobs WHERE id = ?', SVC).v;
  for (const user of ['buyer', 'view', 'no', 'jo']) assert.strictEqual(await status(user, 'POST', '/reports/service-outside', body(1)), 403, user);
  assert.strictEqual(get('SELECT outside_estimate v FROM service_jobs WHERE id = ?', SVC).v, before, 'nothing was saved');
  // Service Records edit alone is enough (the storekeeper, with the monthly-inputs permission taken away).
  capabilities.setCapability('storekeeper', 'reports.monthly_inputs', false);
  try { assert.strictEqual(await status('sk', 'POST', '/reports/service-outside', body(2500)), 200, 'storekeeper: Service Records full'); }
  finally { capabilities.setCapability('storekeeper', 'reports.monthly_inputs', true); }
  assert.strictEqual(get('SELECT outside_estimate v FROM service_jobs WHERE id = ?', SVC).v, 2500);
  // Service Records at view, but the monthly-inputs permission: allowed (the inputs screen saves it).
  assert.strictEqual(perms.levelForRoles(['transport_manager'], 'filters'), 'view');
  mkUser('tm', ['transport_manager']);
  assert.strictEqual(await status('tm', 'POST', '/reports/service-outside', body(3000)), 200);
});

// ================================================================== read from other sections
test('a job card\'s report and cost sheet follow Job Cards; the day tally follows Daily Work', async () => {
  for (const p of [`/reports/job/${J}/report`, `/reports/job/${J}/costsheet`, `/reports/job/${J}/report.html`, `/reports/job/${J}/costsheet.html`]) {
    assert.strictEqual(await status('jo', 'GET', p), 200, 'Job Cards only: ' + p);
    assert.strictEqual(await status('view', 'GET', p), 200, 'Reports: ' + p);
    assert.strictEqual(await status('buyer', 'GET', p), 403, 'neither: ' + p);
    assert.strictEqual(await status('dw', 'GET', p), 403, 'Daily Work only: ' + p);
  }
  assert.strictEqual(await status('jo', 'GET', '/reports/ongoing-jobs.html'), 403, 'Job Cards alone does not open the reports');
  assert.strictEqual(await status('dw', 'GET', '/reports/daily/day_tally'), 200, 'the day tally is Daily Work');
  assert.strictEqual(await status('dw', 'GET', '/reports/daily/day_tally/history'), 200);
  assert.strictEqual(await status('jo', 'GET', '/reports/daily/day_tally'), 403, 'no Daily Work');
  assert.strictEqual(await status('dw', 'GET', '/reports/daily/pending_parts'), 403, 'the other daily reports are Reports');
});

test('the Dashboard\'s figures are trimmed to what the person may see', async () => {
  const boss = (await call('boss', 'GET', '/reports/dashboard')).body;
  assert.ok(boss.month_cost_by_project.some((p) => p.project === 'Harbour road' && p.total === 12500), 'cost by project');
  assert.ok(boss.jobs_by_status.some((s) => s.status === 'IN_PROGRESS'));
  assert.strictEqual(boss.open_jobs_count, 1);
  assert.deepStrictEqual([boss.low_stock_oil.map((p) => p.name), boss.batteries_warranty.map((b) => b.serial_no)], [['Engine oil 15W-40'], ['BT-777']]);
  assert.ok(Object.keys(boss.needs_attention).length > 0);
  const buyer = (await call('buyer', 'GET', '/reports/dashboard')).body;
  assert.deepStrictEqual([buyer.month_cost_by_project, buyer.jobs_by_status, buyer.awaiting_price, buyer.partly_closed,
    buyer.low_stock_oil, buyer.batteries_warranty, buyer.open_jobs_count, buyer.needs_attention],
  [[], [], [], [], [], [], null, {}], 'a buyer: nothing of the workshop\'s');
  const jo = (await call('jo', 'GET', '/reports/dashboard')).body;
  assert.deepStrictEqual([jo.month_cost_by_project, jo.open_jobs_count, jo.partly_closed.map((j) => j.job_no)], [[], 1, ['2026/9/R/2']],
    'Job Cards without Reports: the jobs, not the costs');
  assert.strictEqual(await status('buyer', 'GET', '/reports/pending-approvals'), 200, 'your approvals: everyone');
});
