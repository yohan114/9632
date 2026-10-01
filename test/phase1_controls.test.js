'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-phase1-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');
const aliases = require('../src/lib/aliases');

migrate();

// Set up roles
for (const [n] of [['admin'], ['manager'], ['workshop'], ['operational_manager'], ['storekeeper'], ['transport_manager']]) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}

// User 1: manager1 (holds manager role)
const m1Id = run('INSERT INTO users (username, password_hash, active, full_name) VALUES (?, ?, 1, ?)', 'mgr1', auth.hashPassword('pw'), 'Manager One').lastInsertRowid;
run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', m1Id, 'manager');

// User 2: manager2 (holds manager role)
const m2Id = run('INSERT INTO users (username, password_hash, active, full_name) VALUES (?, ?, 1, ?)', 'mgr2', auth.hashPassword('pw'), 'Manager Two').lastInsertRowid;
run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', m2Id, 'manager');

// User 3: storekeeper
const skId = run('INSERT INTO users (username, password_hash, active, full_name) VALUES (?, ?, 1, ?)', 'sk', auth.hashPassword('pw'), 'Store Keeper').lastInsertRowid;
run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', skId, 'storekeeper');

aliases.findOrCreateAsset('TEST-01', {});

const app = require('../src/server');
let server;
let base;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

async function makeRequest(path_, opts = {}, cookie = null) {
  const res = await fetch(base + path_, {
    method: opts.method || 'GET',
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const setc = res.headers.get('set-cookie');
  const sessionCookie = setc ? setc.split(';')[0] : cookie;
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body, cookie: sessionCookie };
}

async function loginAs(username, password = 'pw') {
  const r = await makeRequest('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.strictEqual(r.status, 200, `login as ${username}`);
  return r.cookie;
}

test('R-04: Unauthenticated access to reporting and data endpoints is blocked with 401', async () => {
  // Public exceptions: /api/health and /api/auth/login
  const health = await makeRequest('/api/health');
  assert.strictEqual(health.status, 200);

  const loginBad = await makeRequest('/api/auth/login', { method: 'POST', body: { username: 'foo', password: 'bar' } });
  assert.strictEqual(loginBad.status, 401);

  // Protected reporting and business endpoints must answer 401 without login
  const endpoints = [
    '/api/reports/dashboard',
    '/api/reports/monthly',
    '/api/reports/fleet-register',
    '/api/reports/mechanic-summary',
    '/api/assets',
    '/api/jobs',
    '/api/stores/mrn',
    '/api/daily-work',
  ];

  for (const ep of endpoints) {
    const res = await makeRequest(ep);
    assert.strictEqual(res.status, 401, `Anonymous request to ${ep} should return 401`);
  }
});

test('R-06: Dual sign-off enforcement on material requisitions (self-approval prohibited)', async () => {
  // Certifying is the workshop's step by default now; an existing database keeps the manager's
  // grant, and that is the case tested here (the manager certifies, then may not approve).
  require('../src/lib/capabilities').setCapability('manager', 'stores.mrn.certify', true);
  const skCookie = await loginAs('sk');
  const mgr1Cookie = await loginAs('mgr1');
  const mgr2Cookie = await loginAs('mgr2');

  // 1. Storekeeper raises an MRN
  const mrnRes = await makeRequest('/api/stores/mrn', {
    method: 'POST',
    body: {
      asset: 'TEST-01',
      purpose: 'Repair starter motor',
      lines: [{ description: 'Starter Relay', qty: 1, unit: 'nos' }]
    }
  }, skCookie);
  assert.strictEqual(mrnRes.status, 201);
  const mrnId = mrnRes.body.mrn.id;

  // 2. Manager 1 certifies the MRN
  const certRes = await makeRequest(`/api/stores/mrn/${mrnId}/certify`, {
    method: 'POST',
    body: { reason: 'Verified needed' }
  }, mgr1Cookie);
  assert.strictEqual(certRes.status, 200);
  assert.strictEqual(certRes.body.approval_status, 'certified');

  // Verify actual role recorded
  const certApproval = get("SELECT * FROM mrn_approvals WHERE mrn_id = ? AND stage = 'certify'", mrnId);
  assert.strictEqual(certApproval.role, 'manager', 'Actual role should be manager, not fake workshop label');
  assert.strictEqual(certApproval.approver_id, m1Id);

  // 3. Manager 1 tries to approve their own certified MRN -> 403 Forbidden!
  const selfApproveRes = await makeRequest(`/api/stores/mrn/${mrnId}/approve`, {
    method: 'POST',
    body: { reason: 'Attempting self-approval' }
  }, mgr1Cookie);
  assert.strictEqual(selfApproveRes.status, 403, 'Self-approval should be strictly blocked');
  assert.match(selfApproveRes.body.error, /Segregation of duties violation/);

  // 4. Manager 2 (independent signer) approves -> 200 OK
  const validApproveRes = await makeRequest(`/api/stores/mrn/${mrnId}/approve`, {
    method: 'POST',
    body: { reason: 'Dual sign-off confirmed' }
  }, mgr2Cookie);
  assert.strictEqual(validApproveRes.status, 200);
  assert.strictEqual(validApproveRes.body.approval_status, 'approved');

  const approveApproval = get("SELECT * FROM mrn_approvals WHERE mrn_id = ? AND stage = 'approve'", mrnId);
  assert.strictEqual(approveApproval.role, 'manager');
  assert.strictEqual(approveApproval.approver_id, m2Id);
});

// ---- the same rule on job cards and job requests, and the admin exemption --------------------
function mkUser(username, roles) {
  for (const r of roles) run('INSERT OR IGNORE INTO roles (name) VALUES (?)', r);
  const id = run('INSERT INTO users (username, password_hash, active, full_name) VALUES (?, ?, 1, ?)', username, auth.hashPassword('pw'), username).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
// Someone who holds BOTH approval roles: the only person who could approve twice.
mkUser('both', ['transport_manager', 'operational_manager']);
mkUser('ops2', ['operational_manager']);
mkUser('atm', ['assistant_transport_manager']);
mkUser('boss', ['admin']);

test('R-06: a job card\'s operations approval cannot come from whoever gave the transport approval', async () => {
  const both = await loginAs('both');
  aliases.findOrCreateAsset('TEST-02', {});
  const job = await makeRequest('/api/jobs', { method: 'POST', body: { asset: 'TEST-02', type: 'repair', description: 'gearbox noise' } }, both);
  assert.strictEqual(job.status, 201, JSON.stringify(job.body));
  const id = job.body.job.id;
  const t = await makeRequest(`/api/jobs/${id}/transition`, { method: 'POST', body: { to: 'APPROVED_TRANSPORT' } }, both);
  assert.strictEqual(t.status, 200, JSON.stringify(t.body));

  const self = await makeRequest(`/api/jobs/${id}/transition`, { method: 'POST', body: { to: 'APPROVED_OPERATIONS' } }, both);
  assert.strictEqual(self.status, 403);
  assert.match(self.body.error, /Segregation of duties/);

  const other = await makeRequest(`/api/jobs/${id}/transition`, { method: 'POST', body: { to: 'APPROVED_OPERATIONS' } }, await loginAs('ops2'));
  assert.strictEqual(other.status, 200, 'a second person may');
});

test('R-06: a job request cannot be approved by whoever certified it', async () => {
  aliases.findOrCreateAsset('TEST-03', {});
  const jr = await makeRequest('/api/job-requests', { method: 'POST', body: { asset: 'TEST-03', description: 'hydraulic leak' } }, await loginAs('atm'));
  assert.strictEqual(jr.status, 201, JSON.stringify(jr.body));
  const id = jr.body.request.id;
  const both = await loginAs('both');
  assert.strictEqual((await makeRequest(`/api/job-requests/${id}/certify`, { method: 'POST', body: {} }, both)).status, 200);
  const self = await makeRequest(`/api/job-requests/${id}/approve`, { method: 'POST', body: {} }, both);
  assert.strictEqual(self.status, 403);
  assert.match(self.body.error, /Segregation of duties/);
  const other = await makeRequest(`/api/job-requests/${id}/approve`, { method: 'POST', body: {} }, await loginAs('ops2'));
  assert.ok(other.status < 300, JSON.stringify(other.body));
});

test('R-06: the admin is exempt (a one-person emergency is still possible)', async () => {
  const boss = await loginAs('boss');
  aliases.findOrCreateAsset('TEST-04', {});
  const job = await makeRequest('/api/jobs', { method: 'POST', body: { asset: 'TEST-04', type: 'repair', description: 'no start' } }, boss);
  const id = job.body.job.id;
  assert.strictEqual((await makeRequest(`/api/jobs/${id}/transition`, { method: 'POST', body: { to: 'APPROVED_TRANSPORT' } }, boss)).status, 200);
  assert.strictEqual((await makeRequest(`/api/jobs/${id}/transition`, { method: 'POST', body: { to: 'APPROVED_OPERATIONS' } }, boss)).status, 200);
});

test('R-04: the two-factor code step is reachable without a session', async () => {
  // It is the second half of signing in, so it comes before any session by design. The gate must
  // let it through to its own check ("timed out"), not answer "Authentication required".
  const r = await makeRequest('/api/auth/mfa/verify', { method: 'POST', body: { challenge: 'nope', code: '123456' } });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.restart, true, 'answered by the code step itself');
  assert.doesNotMatch(r.body.error, /Authentication required/);
});

test('J-3.1: store_items schema contains description column on rebuild/boot', () => {
  const cols = require('../src/db').all('PRAGMA table_info(store_items)');
  const hasDesc = cols.some((c) => c.name === 'description');
  assert.ok(hasDesc, 'description column must exist in store_items');
});
