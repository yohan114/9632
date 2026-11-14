'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-ui-reg-'));
process.env.DB_PATH = path.join(TMP, 'ui-reg.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert/strict');

const { migrate, run } = require('../src/db');
const auth = require('../src/lib/auth');
const perms = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');

migrate();
for (const r of ['admin', ...Object.keys(perms.DEFAULT_MATRIX)]) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', r, r);
}
capabilities.seedCapabilities();
perms.seedDefaults();

const PW = 'amber-compass-rivet';
const adminId = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)',
  'ui_admin', auth.hashPassword(PW)).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'admin'))", adminId);

// Seed minimal mechanic daily work so mechanics-kpi scorecard returns a row
const assetId = run("INSERT INTO assets (code, code_norm, status, in_register) VALUES ('TR-100', 'TR100', 'active', 1)").lastInsertRowid;
const jobId = run(
  "INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at) VALUES ('2026/11/R/10', ?, 'repair', 'Brake check', 'IN_PROGRESS', date('now'))",
  assetId
).lastInsertRowid;
require('../src/lib/mechanics').findOrCreateMechanic('Nimal');
run("INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Nimal', 500, '2020-01-01')");
run(
  "INSERT INTO job_daily_work (job_id, mechanic, hours, work_date, description, outside_labour) VALUES (?, 'Nimal', 3, date('now'), 'Replaced brake pads', 4000)",
  jobId
);

const app = require('../src/server');
let server;
let port;
let adminCookie;

function req(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let buf = '';
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, body: json, text: buf, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  const login = await req('POST', '/api/auth/login', { body: { username: 'ui_admin', password: PW } });
  adminCookie = login.headers['set-cookie'][0].split(';')[0];
});

test.after(() => {
  if (server) server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('mechanics-kpi scorecard returns numeric priced_entries_count and entries_with_outside_cost', async () => {
  const res = await req('GET', '/api/daily-work/mechanics-kpi', { cookie: adminCookie });
  assert.equal(res.status, 200);
  const row = (res.body.mechanics || []).find((m) => m.mechanic === 'Nimal');
  assert.ok(row, 'seeded mechanic must appear in scorecard');
  assert.equal(row.priced_entries_count, 1);
  assert.equal(row.entries_with_outside_cost, 1);
  assert.equal(row.entries_count, 1);
  assert.equal(row.coverage_pct, 100);
});

test('dashboard workflow-monitor and overview succeed after removing obsolete generalstock key', async () => {
  const wm = await req('GET', '/api/dashboard/workflow-monitor', { cookie: adminCookie });
  assert.equal(wm.status, 200);
  assert.ok(wm.body.kpis);
  assert.ok(wm.body.stores_pipeline);

  assert.ok(wm.body.privilege_profile && wm.body.privilege_profile.domains);
  assert.equal(wm.body.privilege_profile.domains.stores, true);

  const ov = await req('GET', '/api/dashboard/overview', { cookie: adminCookie });
  assert.equal(ov.status, 200);
  assert.equal(typeof ov.body.active_jobs, 'number');
  assert.notEqual(ov.body.todays_issue_cost, null);
  assert.ok(Array.isArray(ov.body.stock_alerts));
});

test('public/app.js fixes all UI audit regressions', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  // 1. Dead #/jobcards links fixed
  assert.equal(appJs.includes('#/jobcards/'), false, 'must not link to non-existent #/jobcards route');

  // 2. No double-escaped pageHeader title on Service & Filter Plan
  assert.equal(appJs.includes("pageHeader('Service &amp; Filter Plan'"), false);
  assert.ok(appJs.includes("pageHeader('Service & Filter Plan'"));

  // 3. No duplicated Rs prefixes around money()
  assert.equal(/Rs \$\{money\(/.test(appJs), false, 'money() already prepends Rs');
  assert.equal(/\$\{money\([^)]*\)\}\s*Rs\b/.test(appJs), false, 'money() already prepends Rs');

  // 4. Grammar & spelling fixes
  assert.equal(appJs.includes('log entry${'), false, 'tools log entryies typo must be fixed');
  assert.equal(appJs.includes('Maintenance Summery'), false, 'UI subtitle spelling must be Maintenance Summary');
  assert.ok(appJs.includes("Nothing on the request yet — add the battery needed for this vehicle."));

  // 5. Mechanics KPI uses priced_entries_count fallback cleanly
  assert.ok(appJs.includes('m.priced_entries_count ?? m.entries_with_outside_cost ?? 0'));

  // 6. Pipeline trace skips empty /stores/pipeline/trace? call
  assert.equal(/else loadTrace\(\);\s/.test(appJs) && !appJs.includes('if (!qStr)'), false);
  assert.ok(appJs.includes('if (!qStr) {\n      content.innerHTML = emptyTracePrompt;\n      return;\n    }')
    || appJs.includes('if (!qStr) {\r\n      content.innerHTML = emptyTracePrompt;\r\n      return;\r\n    }'));

  // 7. NAV_MODULE / navVisible align with backend switches
  assert.ok(appJs.includes("lubecapacities: 'lubricants'"));
  assert.ok(appJs.includes("serviceplan: 'service_plan'"));
  assert.ok(appJs.includes("attention: 'attention'"));
  assert.ok(appJs.includes("progress: 'daily_progress'"));
  assert.ok(appJs.includes("teardown: 'cost_teardown'"));

  // 8. Modals close cleanly on navigation & have close button; session lock logout tolerates 401
  assert.ok(appJs.includes("qsa('.modal-bg').forEach((el) => { if (el.dataset.persistent !== '1') el.remove(); });"));
  assert.ok(appJs.includes('modal-x'));
  assert.ok(appJs.includes("try { await api('/auth/logout', { method: 'POST' }); } catch {}"));
});
