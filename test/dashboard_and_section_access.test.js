'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-dash-access-'));
const TEST_DB = path.join(TMP, 'live.db');
process.env.DB_PATH = TEST_DB;
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();

// Insert base roles
for (const n of ['admin', 'workshop_supervisor', 'storekeeper', 'technician']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, n);
}

function mkUser(username, password, roles = []) {
  const id = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)',
    username, auth.hashPassword(password)).lastInsertRowid;
  for (const r of roles) {
    run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  }
  return id;
}

const adminUid = mkUser('admin_user', 'admin-pass-12345', ['admin']);
const techUid = mkUser('tech_user', 'tech-pass-12345', ['technician']);

const app = require('../src/server');
let server;
let base;
let adminCookie;
let techCookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;

  // Log in admin
  const r1 = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin_user', password: 'admin-pass-12345' }),
  });
  adminCookie = (r1.headers.get('set-cookie') || '').split(';')[0];

  // Log in technician
  const r2 = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'tech_user', password: 'tech-pass-12345' }),
  });
  techCookie = (r2.headers.get('set-cookie') || '').split(';')[0];
});

test.after(() => {
  if (server) server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

async function api(pathStr, opts = {}) {
  const r = await fetch(base + '/api' + pathStr, {
    method: opts.method || 'GET',
    headers: {
      'content-type': 'application/json',
      cookie: opts.cookie !== undefined ? opts.cookie : adminCookie,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

test('dashboard workflow-monitor requires authentication', async () => {
  const r = await api('/dashboard/workflow-monitor', { cookie: '' });
  assert.strictEqual(r.status, 401);
});

test('dashboard workflow-monitor returns complete pipeline & watchboard data structure', async () => {
  const r = await api('/dashboard/workflow-monitor', { cookie: adminCookie });
  assert.strictEqual(r.status, 200);

  // Check top-level keys
  assert(r.body.kpis, 'missing kpis');
  assert(r.body.jobs_pipeline, 'missing jobs_pipeline');
  assert(r.body.stores_pipeline, 'missing stores_pipeline');
  assert(r.body.approvals_process, 'missing approvals_process');
  assert(r.body.on_hold, 'missing on_hold');

  // Check KPI keys
  assert(typeof r.body.kpis.active_jobs === 'number');
  assert(typeof r.body.kpis.vehicles_in_workshop === 'number');
  assert(typeof r.body.kpis.total_pending === 'number');
  assert(typeof r.body.kpis.low_stock_total === 'number');

  // Check Jobs Road & Steps
  assert(Array.isArray(r.body.jobs_pipeline.steps));
  assert(r.body.jobs_pipeline.steps.length >= 6);
  assert(r.body.jobs_pipeline.workshop !== undefined);
  assert(r.body.jobs_pipeline.finishing !== undefined);

  // Check Stores Road & Steps
  assert(Array.isArray(r.body.stores_pipeline.steps));
  assert(r.body.stores_pipeline.steps.length >= 6);
  assert(r.body.stores_pipeline.today !== undefined);
  assert(r.body.stores_pipeline.shelf !== undefined);

  // Check Process Approvals categories
  const ap = r.body.approvals_process;
  assert(Array.isArray(ap.inflow), 'inflow must be an array');
  assert(Array.isArray(ap.authorizations), 'authorizations must be an array');
  assert(Array.isArray(ap.warehouse), 'warehouse must be an array');
  assert(Array.isArray(ap.compliance), 'compliance must be an array');
  assert(typeof ap.total_pending === 'number');
  assert(typeof ap.is_approver === 'boolean');

  // Check On-Hold Watchboard categories
  const oh = r.body.on_hold;
  assert(Array.isArray(oh.jobs_waiting_parts), 'jobs_waiting_parts must be an array');
  assert(Array.isArray(oh.unattended_jobs), 'unattended_jobs must be an array');
  assert(typeof oh.stuck_cards_count === 'number');
  assert(Array.isArray(oh.stuck_cards_sample), 'stuck_cards_sample must be an array');
  assert(Array.isArray(oh.dual_open_vehicles), 'dual_open_vehicles must be an array');
  assert(typeof oh.unpriced_grns_count === 'number');
  assert(Array.isArray(oh.unpriced_grns_sample), 'unpriced_grns_sample must be an array');
  assert(oh.unreturned_cores !== undefined);
});

test('access section-matrix requires admin permission', async () => {
  // Technician has no access module clearance
  const r = await api('/access/section-matrix', { cookie: techCookie });
  assert.strictEqual(r.status, 403);
});

test('access section-matrix returns 7 functional sections and capabilities for admin', async () => {
  const r = await api('/access/section-matrix', { cookie: adminCookie });
  assert.strictEqual(r.status, 200);

  assert(Array.isArray(r.body.sections), 'sections must be array');
  assert.strictEqual(r.body.sections.length, 7, 'must define 7 functional sections');

  const expectedSections = ['operations', 'stores', 'fleet', 'dailywork', 'purchasing', 'batteries', 'admin'];
  const actualSectionIds = r.body.sections.map(s => s.id);
  assert.deepStrictEqual(actualSectionIds, expectedSections);

  // Check structure of first section (operations)
  const ops = r.body.sections.find(s => s.id === 'operations');
  assert(ops.modules.includes('jobs'));
  assert(ops.modules.includes('jobrequests'));
  assert(ops.presets.none);
  assert(ops.presets.view);
  assert(ops.presets.operator);
  assert(ops.presets.manager);
  assert(r.body.capabilities.some(c => c.key === 'jobs.create'));

  // Check roles list
  assert(Array.isArray(r.body.roles));
  assert(r.body.roles.some(ro => ro.name === 'admin'));
  assert(r.body.roles.some(ro => ro.name === 'workshop_supervisor'));
});

test('access section-save protects the admin role from modification', async () => {
  const r = await api('/access/section-save', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      role: 'admin',
      section_id: 'operations',
      modules: { jobs: 'none' },
      capabilities: {}
    }
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /admin role holds full access and cannot be changed/i);
});

test('access section-save atomically updates module clearances and capability grants', async () => {
  // Save section settings for workshop_supervisor in 'operations'
  const saveRes = await api('/access/section-save', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      role: 'workshop_supervisor',
      section_id: 'operations',
      modules: { jobs: 'full', jobrequests: 'edit' },
      capabilities: {
        'jobs.create': true,
        'jobs.close': true,
        'jobs.reopen': false
      }
    }
  });
  assert.strictEqual(saveRes.status, 200);
  assert(saveRes.body.role, 'response includes role');
  assert(saveRes.body.matrix, 'response includes updated matrix');

  // Verify capabilities in returned role object
  assert(saveRes.body.role.caps.includes('jobs.create'));
  assert(saveRes.body.role.caps.includes('jobs.close'));
  assert(!saveRes.body.role.caps.includes('jobs.reopen'));

  // Fetch section matrix and verify
  const matrixRes = await api('/access/section-matrix', { cookie: adminCookie });
  assert.strictEqual(matrixRes.status, 200);

  const supGrid = matrixRes.body.matrix.grid['workshop_supervisor'];
  assert(supGrid, 'workshop_supervisor matrix grid found');
  assert.strictEqual(supGrid.jobs, 'full');
  assert.strictEqual(supGrid.jobrequests, 'edit');

  // Check audit log for role_permission and role_capability updates
  const auditPerms = all("SELECT * FROM audit_log WHERE entity = 'role_permission' AND action = 'update' ORDER BY id DESC LIMIT 5");
  assert(auditPerms.length > 0);
  assert(auditPerms.some(a => JSON.parse(a.after_json || '{}').role === 'workshop_supervisor'));

  const auditCaps = all("SELECT * FROM audit_log WHERE entity = 'role_capability' ORDER BY id DESC LIMIT 5");
  assert(auditCaps.length > 0);
});
