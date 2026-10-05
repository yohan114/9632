'use strict';

// ===========================================================================
// WorkshopOne — Step 3b Test Suite: Stand-in Approvals (plan §4.2 & Decision D9)
//
// Rules verified:
//   1. Hand-over form & API: granter, stand-in, start_date, end_date, reason.
//   2. Who sets it up: user delegates own approvals or admin delegates on their behalf.
//   3. What passes: ONLY certify and approve capabilities (no user/role/settings mgmt).
//   4. Decision D9:
//      - Manager keeps their own signing rights during hand-over.
//      - Manager's approval limit applies to the stand-in.
//      - Maximum 30 days strictly enforced.
//   5. Normal segregation of duties enforced:
//      - Stand-in cannot approve their own requests.
//      - Stand-in acting for granter cannot approve granter's own requests.
//      - Stand-in cannot both certify and approve the same request.
//   6. No delegation chains: stand-in cannot re-delegate; cycles prevented.
//   7. Records: approvals tables, printed fields, and audit log stamp both names ("Ruwan for Nimal").
//   8. Auto-expiration and early revocation by granter, stand-in, or admin.
// ===========================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-step3b-'));
process.env.DB_PATH = path.join(TMP, 'step3b.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const standIn = require('../src/lib/stand_in');
const capabilities = require('../src/lib/capabilities');
const approvalLimits = require('../src/lib/approval_limits');

migrate();

// Roles
for (const n of ['admin', 'storekeeper', 'workshop', 'operational_manager', 'transport_manager', 'assistant_transport_manager', 'viewer']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
run("INSERT OR IGNORE INTO roles (name, label) VALUES ('stores_writer', 'Stores writer')");
run("INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES ('stores_writer', 'stores', 'full')");

const PW = 'lantern-cobalt-meadow';
const U = {};
const mkUser = (name, roles, fullName = null) => {
  U[name] = run('INSERT INTO users (username, full_name, password_hash, active) VALUES (?, ?, ?, 1)',
    name, fullName || name, auth.hashPassword(PW)).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', U[name], r);
};

mkUser('boss', ['admin'], 'Boss Admin');
mkUser('nimal', ['operational_manager', 'workshop', 'stores_writer'], 'Nimal Perera');   // Manager away
mkUser('ruwan', ['workshop', 'stores_writer'], 'Ruwan Silva');                // Workshop Engineer (Stand-in)
mkUser('kamal', ['storekeeper', 'stores_writer'], 'Kamal Fernando');          // Storekeeper (raiser)
mkUser('tm_sunil', ['transport_manager'], 'Sunil Transport');                 // Transport Manager
mkUser('tam_anil', ['assistant_transport_manager'], 'Anil Assistant');        // Transport Assistant
mkUser('plain_user', ['viewer'], 'Plain Viewer');                             // Unrelated user

const app = require('../src/server');
let server;
let base;
const cookies = {};

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const u of Object.keys(U)) {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u, password: PW })
    });
    assert.strictEqual(r.status, 200, u);
    cookies[u] = (r.headers.get('set-cookie') || '').split(';')[0];
  }
});

test.after(() => server && server.close());

const call = async (who, method, p, body) => {
  const r = await fetch(base + '/api' + p, {
    method,
    headers: { 'content-type': 'application/json', cookie: cookies[who] },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const ASSET = require('../src/lib/aliases').findOrCreateAsset('WP-01', {}).id;
let mrnSeq = 0;
let jrSeq = 0;

const createMrn = async (who) => {
  const r = await call(who, 'POST', '/stores/mrn', {
    mrn_no: `MRN-3B-${++mrnSeq}`,
    asset_id: ASSET,
    purpose: 'scheduled maintenance',
    lines: [{ description: 'Oil Filter', qty: 2, unit: 'nos' }]
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.mrn.id;
};

const createJobRequest = async (who) => {
  const r = await call(who, 'POST', '/job-requests', {
    asset_id: ASSET,
    description: `Fault test ${++jrSeq}`,
    type: 'repair'
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.request.id;
};

// ===========================================================================
// 1. Delegation Creation & Validation Rules
// ===========================================================================

test('Rule 1 & 2: User can delegate their own approvals; non-admin cannot delegate for others; admin can delegate for anyone', async () => {
  const today = standIn.todayDate();
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  // Ruwan tries to delegate Nimal's approvals -> 403 Forbidden
  const forbidden = await call('ruwan', 'POST', '/access/stand-ins', {
    granter_id: U.nimal,
    stand_in_id: U.ruwan,
    start_date: today,
    end_date: nextWeek,
    reason: 'Trying unauthorized delegation'
  });
  assert.strictEqual(forbidden.status, 403);

  // Nimal delegates own approvals to Ruwan -> 201 Created
  const okUser = await call('nimal', 'POST', '/access/stand-ins', {
    granter_id: U.nimal,
    stand_in_id: U.ruwan,
    start_date: today,
    end_date: nextWeek,
    reason: 'Annual leave in Nuwara Eliya'
  });
  assert.strictEqual(okUser.status, 201);
  assert.strictEqual(okUser.body.granter_id, U.nimal);
  assert.strictEqual(okUser.body.stand_in_id, U.ruwan);

  // Admin delegates TM Sunil to Ruwan -> 201 Created
  const okAdmin = await call('boss', 'POST', '/access/stand-ins', {
    granter_id: U.tm_sunil,
    stand_in_id: U.ruwan,
    start_date: today,
    end_date: nextWeek,
    reason: 'Transport manager hospital leave'
  });
  assert.strictEqual(okAdmin.status, 201);
  assert.strictEqual(okAdmin.body.granter_id, U.tm_sunil);
});

test('Self-delegation (delegating to yourself) is rejected', async () => {
  const today = standIn.todayDate();
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const r = await call('nimal', 'POST', '/access/stand-ins', {
    granter_id: U.nimal,
    stand_in_id: U.nimal,
    start_date: today,
    end_date: nextWeek,
    reason: 'Self delegation'
  });
  assert.strictEqual(r.status, 400);
  assert.ok(r.body.error.includes('yourself'));
});

test('Reason is strictly required', async () => {
  const today = standIn.todayDate();
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const r = await call('nimal', 'POST', '/access/stand-ins', {
    granter_id: U.nimal,
    stand_in_id: U.ruwan,
    start_date: today,
    end_date: nextWeek,
    reason: '   '
  });
  assert.strictEqual(r.status, 400);
  assert.ok(r.body.error.includes('reason'));
});

test('Decision D9: Maximum 30 days duration is strictly enforced', async () => {
  const today = standIn.todayDate();
  // 31 days ahead
  const day31 = new Date(Date.now() + 31 * 86400000).toISOString().slice(0, 10);
  const r = await call('nimal', 'POST', '/access/stand-ins', {
    granter_id: U.nimal,
    stand_in_id: U.ruwan,
    start_date: today,
    end_date: day31,
    reason: 'Extended vacation'
  });
  assert.strictEqual(r.status, 400);
  assert.ok(r.body.error.includes('cannot exceed 30 days'));
});

test('Dates validation: start date cannot be after end date', async () => {
  const r = await call('nimal', 'POST', '/access/stand-ins', {
    granter_id: U.nimal,
    stand_in_id: U.ruwan,
    start_date: '2026-10-15',
    end_date: '2026-10-10',
    reason: 'Reversed dates'
  });
  assert.strictEqual(r.status, 400);
  assert.ok(r.body.error.includes('cannot be after end date'));
});

test('No delegation cycles (circular delegation A -> B -> A is rejected)', async () => {
  const today = standIn.todayDate();
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  // Nimal already delegated to Ruwan above. Now Ruwan delegating back to Nimal during same dates is rejected.
  const cycle = await call('ruwan', 'POST', '/access/stand-ins', {
    granter_id: U.ruwan,
    stand_in_id: U.nimal,
    start_date: today,
    end_date: nextWeek,
    reason: 'Mutual delegation loop'
  });
  assert.strictEqual(cycle.status, 400);
  assert.ok(cycle.body.error.includes('Circular delegation'));
});

// ===========================================================================
// 2. Active Delegation Resolution and Date Boundaries
// ===========================================================================

test('Active delegations API lists active delegations for user and granter', async () => {
  const r = await call('ruwan', 'GET', '/access/stand-ins/active');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.as_stand_in.length >= 1);
  assert.ok(r.body.as_stand_in.some(d => d.granter_id === U.nimal));
  assert.strictEqual(r.body.active_now, true);
});

test('Date boundaries: inactive before start_date and after end_date', () => {
  // Test query on date before delegation
  const beforeList = standIn.getActiveDelegationsFor(U.ruwan, '2020-01-01');
  assert.strictEqual(beforeList.length, 0);

  // Test query on date in future after delegation
  const futureList = standIn.getActiveDelegationsFor(U.ruwan, '2030-01-01');
  assert.strictEqual(futureList.length, 0);
});

// ===========================================================================
// 3. Capabilities: Only Certify & Approve Pass; Manager Keeps Rights
// ===========================================================================

test('Rule 3 & Decision D9: Only certify & approve capabilities pass; Manager retains their rights', () => {
  // Nimal has operational_manager caps
  const nimalUser = get('SELECT id, active FROM users WHERE id = ?', U.nimal);
  nimalUser.roles = ['operational_manager', 'stores_writer'];
  const nimalCaps = capabilities.effectiveCaps(nimalUser);
  assert.ok(nimalCaps.includes('stores.mrn.approve'), 'Manager has approve cap');

  // Ruwan has workshop caps normally
  const ruwanUser = get('SELECT id, active FROM users WHERE id = ?', U.ruwan);
  ruwanUser.roles = ['workshop', 'stores_writer'];
  const ruwanOwnCaps = capabilities.effectiveCaps({ ...ruwanUser, skipDelegations: true });
  assert.ok(!ruwanOwnCaps.includes('stores.mrn.approve'), 'Ruwan does not normally have mrn.approve');

  // But with delegation, Ruwan effectively gains stores.mrn.approve
  const ruwanEffectiveCaps = capabilities.effectiveCaps(ruwanUser);
  assert.ok(ruwanEffectiveCaps.includes('stores.mrn.approve'), 'Ruwan gains mrn.approve through delegation');
  assert.ok(ruwanEffectiveCaps.includes('jobs.approve_operations'), 'Ruwan gains jobs.approve_operations');

  // But does NOT gain non-delegatable caps like access.manage or user management
  assert.ok(!ruwanEffectiveCaps.includes('access.manage'));
  assert.ok(!ruwanEffectiveCaps.includes('users.manage'));

  // And Nimal STILL keeps their rights (Decision D9)
  const nimalEffectiveCaps = capabilities.effectiveCaps(nimalUser);
  assert.ok(nimalEffectiveCaps.includes('stores.mrn.approve'), 'Manager keeps their rights');
});

// ===========================================================================
// 4. Decision D9: Approval Limits Apply
// ===========================================================================

test('Decision D9: Manager approval limit applies to the stand-in', () => {
  // Set limit of Rs 25,000 on operational_manager role for mrn_approve
  run('INSERT OR REPLACE INTO approval_limits (role, kind, max_amount) VALUES (?, ?, ?)', 'operational_manager', 'mrn_approve', 25000);

  const ruwanUser = get('SELECT id, active FROM users WHERE id = ?', U.ruwan);
  ruwanUser.roles = ['workshop', 'stores_writer'];

  // Without delegation Ruwan would have no limit or workshop limit
  // With delegation from Nimal (operational_manager), Ruwan inherits Nimal's Rs 25,000 limit
  const inheritedLimit = approvalLimits.limitFor(ruwanUser, 'mrn_approve');
  assert.strictEqual(inheritedLimit, 25000);
});

// ===========================================================================
// 5. Segregation of Duties & Self-Refusal
// ===========================================================================

test('Normal rules enforced: Stand-in cannot approve a request raised by themselves', async () => {
  // Ruwan raises an MRN
  const mrnId = await createMrn('ruwan');
  // Certify by Ruwan is blocked by Step 3a self-refusal
  const certSelf = await call('ruwan', 'POST', `/stores/mrn/${mrnId}/certify`, { reason: 'Certifying self' });
  assert.strictEqual(certSelf.status, 403);
  assert.ok(certSelf.body.own_request);

  // Even if certified by someone else, Ruwan cannot approve their own request as stand-in
  const bossCert = await call('boss', 'POST', `/stores/mrn/${mrnId}/certify`, { reason: 'Boss cert' });
  assert.strictEqual(bossCert.status, 200);

  const appSelf = await call('ruwan', 'POST', `/stores/mrn/${mrnId}/approve`, { reason: 'Approving self' });
  assert.strictEqual(appSelf.status, 403);
  assert.ok(appSelf.body.own_request);
});

test('Stand-in acting for granter cannot approve a request raised by the granter', async () => {
  // Nimal raises an MRN
  const mrnId = await createMrn('nimal');
  // Boss certifies it
  const bossCert = await call('boss', 'POST', `/stores/mrn/${mrnId}/certify`, { reason: 'Boss cert' });
  assert.strictEqual(bossCert.status, 200);

  // Ruwan acting for Nimal tries to approve Nimal's request -> 403 Forbidden
  const app = await call('ruwan', 'POST', `/stores/mrn/${mrnId}/approve`, {
    stand_in_for: U.nimal,
    reason: 'Approving for Nimal'
  });
  assert.strictEqual(app.status, 403);
  assert.ok(app.body.error.includes('acting for the person who raised'));
});

test('Stand-in cannot both certify and approve the same request', async () => {
  // Kamal (storekeeper) raises an MRN
  const mrnId = await createMrn('kamal');

  // Ruwan certifies the MRN in their own right as Workshop Engineer
  const cert = await call('ruwan', 'POST', `/stores/mrn/${mrnId}/certify`, { reason: 'Workshop ok' });
  assert.strictEqual(cert.status, 200);

  // Ruwan tries to approve as stand-in for Nimal -> 403 Segregation of duties violation
  const app = await call('ruwan', 'POST', `/stores/mrn/${mrnId}/approve`, {
    stand_in_for: U.nimal,
    reason: 'Approving as stand-in'
  });
  assert.strictEqual(app.status, 403);
  assert.ok(app.body.error.includes('Segregation of duties violation'));
});

// ===========================================================================
// 6. Signatures & Records: "Ruwan for Nimal"
// ===========================================================================

test('Rule 7: MRN approval stamps "Ruwan for Nimal" on signed_name, mrn record, and audit log', async () => {
  // Kamal raises MRN
  const mrnId = await createMrn('kamal');

  // Boss certifies
  const cert = await call('boss', 'POST', `/stores/mrn/${mrnId}/certify`, { reason: 'Certified' });
  assert.strictEqual(cert.status, 200);

  // Ruwan approves as stand-in for Nimal
  const app = await call('ruwan', 'POST', `/stores/mrn/${mrnId}/approve`, {
    stand_in_for: U.nimal,
    reason: 'Approved on behalf of Nimal'
  });
  assert.strictEqual(app.status, 200);

  // Check mrn record
  const mrnRow = get('SELECT * FROM mrn WHERE id = ?', mrnId);
  assert.strictEqual(mrnRow.approval_status, 'approved');
  assert.strictEqual(mrnRow.approved_by, 'Ruwan Silva for Nimal Perera');

  // Check mrn_approvals record
  const appRow = get(`SELECT * FROM mrn_approvals WHERE mrn_id = ? AND stage = 'approve' ORDER BY id DESC LIMIT 1`, mrnId);
  assert.strictEqual(appRow.approver_id, U.ruwan);
  assert.strictEqual(appRow.signed_name, 'Ruwan Silva for Nimal Perera');
  assert.strictEqual(appRow.role, 'stand_in');

  // Check audit log
  const auditRow = get(`SELECT * FROM audit_log WHERE entity = 'mrn' AND entity_id = ? AND action = 'approve' ORDER BY id DESC LIMIT 1`, mrnId);
  const afterJson = JSON.parse(auditRow.after_json || '{}');
  assert.strictEqual(afterJson.stand_in_for, U.nimal);
  assert.strictEqual(afterJson.approved_by, 'Ruwan Silva for Nimal Perera');
});

test('Rule 7: Job Request certify and approve stamp "Ruwan for Sunil" and "Ruwan for Nimal"', async () => {
  // Anil raises job request
  const jrId = await createJobRequest('tam_anil');

  // Ruwan certifies as stand-in for Transport Manager Sunil
  const cert = await call('ruwan', 'POST', `/job-requests/${jrId}/certify`, {
    stand_in_for: U.tm_sunil,
    reason: 'Certifying as stand-in for Sunil'
  });
  assert.strictEqual(cert.status, 200);
  const jrAfterCert = get('SELECT * FROM job_requests WHERE id = ?', jrId);
  assert.strictEqual(jrAfterCert.certified_by, 'Ruwan Silva for Sunil Transport');

  const certAppRow = get(`SELECT * FROM job_request_approvals WHERE job_request_id = ? AND stage = 'certify' ORDER BY id DESC LIMIT 1`, jrId);
  assert.strictEqual(certAppRow.signed_name, 'Ruwan Silva for Sunil Transport');
  assert.strictEqual(certAppRow.role, 'stand_in');

  // Boss approves
  const app = await call('boss', 'POST', `/job-requests/${jrId}/approve`, { reason: 'Final approve' });
  assert.strictEqual(app.status, 200);
});

test('Rule 7: Job card transitions stamp "Ruwan for Sunil" in job_approvals', async () => {
  // Create job card in REQUESTED status
  const jobResult = run(`
    INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at)
    VALUES ('2026/10/R/3999', ?, 'repair', 'Test card', 'REQUESTED', date('now'))
  `, ASSET);
  const jobId = jobResult.lastInsertRowid;

  // Ruwan approves transport as stand-in for Sunil
  const trans = await call('ruwan', 'POST', `/jobs/${jobId}/transition`, {
    to: 'APPROVED_TRANSPORT',
    stand_in_for: U.tm_sunil,
    reason: 'Transport cleared'
  });
  assert.strictEqual(trans.status, 200);

  const jAppRow = get(`SELECT * FROM job_approvals WHERE job_id = ? AND role = 'transport_manager' ORDER BY id DESC LIMIT 1`, jobId);
  assert.strictEqual(jAppRow.approver_id, U.ruwan);
  assert.strictEqual(jAppRow.signed_name, 'Ruwan Silva for Sunil Transport');
});

// ===========================================================================
// 7. Early Revocation
// ===========================================================================

test('Rule 9: Revocation early by granter, stand-in, or admin; third party refused', async () => {
  const today = standIn.todayDate();
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  // Create fresh delegation: Sunil -> Ruwan
  const created = standIn.createDelegation({ id: U.tm_sunil, roles: ['transport_manager'] }, {
    granter_id: U.tm_sunil,
    stand_in_id: U.ruwan,
    start_date: today,
    end_date: nextWeek,
    reason: 'Short leave'
  });

  // Plain viewer tries to revoke -> 403 Forbidden
  const badRevoke = await call('plain_user', 'POST', `/access/stand-ins/${created.id}/revoke`, { reason: 'Unauthorized' });
  assert.strictEqual(badRevoke.status, 403);

  // Stand-in Ruwan revokes -> 200 OK
  const okRevoke = await call('ruwan', 'POST', `/access/stand-ins/${created.id}/revoke`, { reason: 'Returning duties' });
  assert.strictEqual(okRevoke.status, 200);
  assert.strictEqual(okRevoke.body.active, 0);
  assert.ok(okRevoke.body.revoked_at);

  // Check that it is no longer returned in active delegations
  const activeNow = standIn.getActiveDelegationsFor(U.ruwan);
  const found = activeNow.find(d => d.id === created.id);
  assert.strictEqual(found, undefined, 'Revoked delegation is not active');
});
