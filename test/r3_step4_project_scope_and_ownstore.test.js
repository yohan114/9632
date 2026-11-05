'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-h8-cep03-'));
const TEST_DB = path.join(TMP, 'test.db');
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { migrate, run, get, all, db } = require('../src/db');
const auth = require('../src/lib/auth');
const storeLocations = require('../src/lib/store_locations');
const scope = require('../src/lib/scope');
migrate();

// Seed workshops & projects
run("INSERT OR IGNORE INTO workshops (id, code, name, active) VALUES (1, 'CW', 'Central Workshop', 1)");
run("INSERT OR IGNORE INTO projects (id, code, name, active) VALUES (10, 'CEP-03', 'CEP-03 Project', 1)");
run("INSERT OR IGNORE INTO projects (id, code, name, active) VALUES (20, 'RUW', 'Ruwanwella Project', 1)");

storeLocations.seedStoreLocations(db);
// Set project_id = 10 for CEP-03 store (id = 4)
run("UPDATE store_locations SET project_id = 10 WHERE id = 4");

// Seed users
for (const n of ['admin', 'storekeeper']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
const uid = run("INSERT INTO users (username, password_hash, active) VALUES ('cep03_user', ?, 1)", auth.hashPassword('pw')).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'storekeeper'))", uid);
run("INSERT INTO store_location_access (user_id, store_location_id, can_view, can_request) VALUES (?, 4, 1, 1)", uid);

// Seed assets: 1 in CEP-03, 1 in RUW
run("INSERT INTO assets (code, code_norm, current_project_id) VALUES ('V-CEP03', 'vcep03', 10)");
run("INSERT INTO assets (code, code_norm, current_project_id) VALUES ('V-OTHER', 'vother', 20)");

// Seed job cards: 1 in CEP-03, 1 in RUW
run("INSERT INTO job_cards (job_no, status, project_id, asset_id, description) VALUES ('JOB-CEP03', 'IN_PROGRESS', 10, 1, 'CEP Job')");
run("INSERT INTO job_cards (job_no, status, project_id, asset_id, description) VALUES ('JOB-OTHER', 'IN_PROGRESS', 20, 2, 'Other Job')");

// Seed costs: asset 1 (CEP-03) has 5000, asset 2 (RUW) has 12000
const now = new Date();
const curY = now.getFullYear();
const curM = now.getMonth() + 1;
run("INSERT INTO vehicle_monthly_costs (asset_id, year, month, total_cost, parts_cost, oil_cost, filter_cost, labour_cost) VALUES (1, ?, ?, 5000, 2000, 1000, 500, 1500)", curY, curM);
run("INSERT INTO vehicle_monthly_costs (asset_id, year, month, total_cost, parts_cost, oil_cost, filter_cost, labour_cost) VALUES (2, ?, ?, 12000, 6000, 2000, 1000, 3000)", curY, curM);

// Seed audit log
const ruwUid = run("INSERT INTO users (username, password_hash, active) VALUES ('ruw_user', ?, 1)", auth.hashPassword('pw')).lastInsertRowid;
run("INSERT INTO audit_log (user_id, entity, entity_id, action) VALUES (?, 'projects', 10, 'update_cep03')", uid);
run("INSERT INTO audit_log (user_id, entity, entity_id, action) VALUES (?, 'projects', 20, 'update_ruw')", ruwUid);

const app = require('../src/server');
let server;
let base;
let cookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;

  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'cep03_user', password: 'pw' }),
  });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
});

test.after(() => {
  if (server) server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test('M6: scope.ownStore returns null, never a store_locations id, when no legacy store exists', () => {
  const user = { id: uid, activeStoreId: 4, isAllSitesMode: false };
  const storeId = scope.ownStore(user);
  assert.strictEqual(storeId, null, 'ownStore must return null, never store_locations id 4');
});

test('H8: CEP-03 project store login sees only CEP-03 dashboard counts and figures', async () => {
  const res = await fetch(`${base}/api/dashboard/overview`, {
    headers: { cookie }
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();

  // Active jobs should be 1 (only JOB-CEP03), NOT 2
  assert.strictEqual(data.active_jobs, 1, 'Dashboard active_jobs must be scoped to CEP-03 project (1 job)');
  // Vehicles in workshop / project should be 1, NOT 2
  assert.strictEqual(data.vehicles_in_workshop, 1, 'Dashboard vehicles must be scoped to CEP-03 project (1 vehicle)');

  // Job status breakdown should sum to 1 (only CEP-03 job), NOT 2
  const totalBreakdown = (data.job_status_breakdown || []).reduce((acc, r) => acc + r.count, 0);
  assert.strictEqual(totalBreakdown, 1, 'Job status breakdown must be scoped to CEP-03 project');

  // Monthly cost total should be 5000 (only CEP-03 asset 1), NOT 17000
  assert.strictEqual(data.monthly_cost_total, 5000, 'CEP-03 user sees only CEP-03 monthly cost (5000)');
  assert.strictEqual(data.top_5_cost_vehicles.length, 1, 'Only CEP-03 vehicle in top cost');
  assert.strictEqual(data.top_5_cost_vehicles[0].asset_id, 1);

  // Recent activity should only show CEP-03 actions
  assert.ok(data.recent_activity.length > 0, 'Recent activity has items');
  const hasRuw = data.recent_activity.some((a) => a.action === 'update_ruw');
  assert.strictEqual(hasRuw, false, 'CEP-03 user must not see RUW project activity');
});
