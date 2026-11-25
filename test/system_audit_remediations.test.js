'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-audit-rem-'));
process.env.DB_PATH = path.join(TMP, 'audit_rem.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.MULTIDB = '0';
delete process.env.CSRF_TRUSTED_ORIGINS;
delete process.env.PUBLIC_ORIGIN;
delete process.env.SAP_GATEWAY_API_KEY;

const test = require('node:test');
const assert = require('node:assert');
const dbMod = require('../src/db');
const { migrate, run, get } = dbMod;
const auth = require('../src/lib/auth');
const permissions = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');
const costing = require('../src/lib/costing');
const rules = require('../src/lib/access_rules');
const assetMerge = require('../src/lib/asset_merge');
const { buildHtml } = require('../src/lib/outsourcing_pdf');

migrate();
permissions.seedDefaults();
capabilities.seedCapabilities();

for (const n of ['admin', 'manager', 'workshop', 'viewer', 'audit_custom']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, n);
}
try { run('UPDATE roles SET require_mfa = 0'); } catch {}

const PW = 'AuditPass2026!Secure';
function mkUser(username, roles = [], extra = {}) {
  const id = run(
    `INSERT INTO users (username, password_hash, full_name, active, must_change_password, workshop_id, access_until)
     VALUES (?, ?, ?, 1, 0, ?, ?)`,
    username, auth.hashPassword(PW), username, extra.workshop_id || 1, extra.access_until || null
  ).lastInsertRowid;
  for (const r of roles) {
    run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  }
  return id;
}

const adminId = mkUser('rem_admin', ['admin']);
const wsId = (get('SELECT id FROM workshops WHERE active = 1 ORDER BY id LIMIT 1') || {}).id || 1;
const mgrId = mkUser('rem_mgr', ['manager'], { workshop_id: wsId });
mkUser('rem_wksp', ['workshop'], { workshop_id: wsId });
mkUser('rem_viewer', ['viewer'], { workshop_id: wsId });

const app = require('../src/server');
let server;
let port;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
});

test.after(() => {
  if (server) server.close();
  try { if (dbMod.rawDb && typeof dbMod.rawDb.close === 'function') dbMod.rawDb.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

function req(method, p, { body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, buf, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function login(username) {
  const r = await req('POST', '/api/auth/login', { body: { username, password: PW } });
  assert.strictEqual(r.status, 200, `login failed for ${username}: ${r.text}`);
  const sc = r.headers['set-cookie'] || [];
  return sc.map((s) => s.split(';')[0]).join('; ');
}

test('BUG-2: Tool Scrap Certificate PDF endpoint no longer crashes with htmlToPdfBuffer TypeError', async () => {
  const adminCookie = await login('rem_admin');
  const toolId = run(
    `INSERT INTO workshop_tools (tool_code, name, workshop_id, status) VALUES ('TL-REM-1', 'Impact Wrench', ?, 'in_store')`,
    wsId
  ).lastInsertRowid;
  const scrapId = run(
    `INSERT INTO tool_scrap_requests (request_no, tool_id, tool_code, tool_name, damage_date, damage_reason, reported_by, status)
     VALUES ('SCR-REM-001', ?, 'TL-REM-1', 'Impact Wrench', '2026-11-12', 'Broken anvil', ?, 'pending_approval')`,
    toolId, adminId
  ).lastInsertRowid;

  const r = await req('GET', `/api/tools/scrap-requests/${scrapId}/download.pdf`, { cookie: adminCookie });
  assert.strictEqual(r.status, 200, `Expected 200 PDF/HTML fallback, got ${r.status}: ${r.text}`);
  const ct = String(r.headers['content-type'] || '');
  assert.ok(ct.includes('application/pdf') || ct.includes('text/html'), `Unexpected content-type: ${ct}`);
});

test('BUG-3: Posted CCOM outsourcing cost persists across costing.refreshJobTotals', async () => {
  const adminCookie = await login('rem_admin');
  const assetId = run(`INSERT INTO assets (code, code_norm, registration) VALUES ('REM-EQ-1', 'REMEQ1', 'WP-9991')`).lastInsertRowid;
  const vendorId = run(`INSERT INTO outsourcing_vendors (code, name) VALUES ('V-REM-1', 'Acme Lathe')`).lastInsertRowid;
  const jobId = run(
    `INSERT INTO job_cards (job_no, asset_id, type, status, description, requested_at, workshop_id)
     VALUES ('2026/11/R/9001', ?, 'repair', 'IN_PROGRESS', 'CCOM repair', '2026-11-10', ?)`,
    assetId, wsId
  ).lastInsertRowid;
  const orqId = run(
    `INSERT INTO outsourcing_requests (ref_no, repair_job_id, vendor_id, asset_id, status, created_by, workshop_id)
     VALUES ('CCOM-REM-1', ?, ?, ?, 'completed', ?, ?)`,
    jobId, vendorId, assetId, adminId, wsId
  ).lastInsertRowid;

  const postRes = await req('POST', `/api/outsourcing/requests/${orqId}/post-cost`, {
    cookie: adminCookie,
    body: { invoice_no: 'INV-REM-100', invoice_date: '2026-11-12', amount: 45250.75 },
  });
  assert.strictEqual(postRes.status, 200, postRes.text);

  let job = get('SELECT external_cost, total_cost FROM job_cards WHERE id = ?', jobId);
  assert.strictEqual(job.external_cost, 45250.75);
  assert.strictEqual(job.total_cost, 45250.75);

  const refreshed = costing.refreshJobTotals(jobId);
  assert.strictEqual(refreshed.external_cost, 45250.75);
  assert.strictEqual(refreshed.total_cost, 45250.75);

  job = get('SELECT external_cost, total_cost FROM job_cards WHERE id = ?', jobId);
  assert.strictEqual(job.external_cost, 45250.75);
  assert.strictEqual(job.total_cost, 45250.75);
});

test('BUG-7: Rejected daily-work request rolls back auto-created closed job card (no orphans)', async () => {
  const dwUserId = mkUser('rem_dw_noclose', ['viewer'], { workshop_id: wsId });
  capabilities.setUserCapability(dwUserId, 'dailywork.edit', true, adminId);
  permissions.setUserPermission(dwUserId, 'dailywork', 'add', adminId);
  const dwCookie = await login('rem_dw_noclose');

  const assetId = run(`INSERT INTO assets (code, code_norm, registration) VALUES ('REM-DW-1', 'REMDW1', 'WP-DW-1')`).lastInsertRowid;
  const beforeCount = get('SELECT COUNT(*) c FROM job_cards WHERE asset_id = ?', assetId).c;
  assert.strictEqual(beforeCount, 0);

  const r = await req('POST', '/api/daily-work', {
    cookie: dwCookie,
    body: {
      asset_id: assetId,
      work_date: '2026-11-12',
      mechanic: 'Kamal',
      description: 'Should roll back auto-created closed job',
      hours: 2,
    },
  });
  assert.strictEqual(r.status, 403, `Expected 403, got ${r.status}: ${r.text}`);
  const afterCount = get('SELECT COUNT(*) c FROM job_cards WHERE asset_id = ?', assetId).c;
  assert.strictEqual(afterCount, 0, 'Orphan auto-created job card must be rolled back on 403');
});

test('SEC-1: POST /api/access/people/:id/save rejects string/numeric capability bypass and unauthorized role assignment', async () => {
  const subMgrId = mkUser('rem_submgr', ['workshop'], { workshop_id: wsId });
  capabilities.setUserCapability(subMgrId, 'access.manage', true, adminId);
  capabilities.setUserCapability(subMgrId, 'users.manage', true, adminId);
  const subMgrCookie = await login('rem_submgr');

  const targetId = mkUser('rem_target', ['workshop'], { workshop_id: wsId });

  const capBypass = await req('POST', `/api/access/people/${targetId}/save`, {
    cookie: subMgrCookie,
    body: { capabilities: { 'finance.period.reopen': 1 } },
  });
  assert.strictEqual(capBypass.status, 403, `Numeric capability bypass should fail with 403, got ${capBypass.status}: ${capBypass.text}`);

  const strBypass = await req('POST', `/api/access/people/${targetId}/save`, {
    cookie: subMgrCookie,
    body: { capabilities: { 'finance.period.reopen': 'true' } },
  });
  assert.strictEqual(strBypass.status, 403, `String capability bypass should fail with 403, got ${strBypass.status}: ${strBypass.text}`);

  const roleEsc = await req('POST', `/api/access/people/${targetId}/save`, {
    cookie: subMgrCookie,
    body: { roles: ['manager'] },
  });
  assert.strictEqual(roleEsc.status, 403, `Role escalation should fail with 403, got ${roleEsc.status}: ${roleEsc.text}`);

  const missingRole = await req('POST', `/api/access/people/${targetId}/save`, {
    cookie: subMgrCookie,
    body: { roles: ['nonexistent_role_xyz'] },
  });
  assert.strictEqual(missingRole.status, 400);
});

test('SEC-2: Expired access_until drops positive elevations while preserving explicit revocations AND locking out expired contractors', () => {
  const elevUserId = mkUser('rem_expired_elev', ['workshop'], { access_until: '2020-01-01T00:00:00Z' });
  const baseCaps = capabilities.capsForRoles(['workshop']);
  const revokedCap = baseCaps[0];
  assert.ok(revokedCap, 'workshop baseline should have capabilities');
  capabilities.setUserCapability(elevUserId, revokedCap, false, adminId);
  capabilities.setUserCapability(elevUserId, 'finance.period.reopen', true, adminId);
  permissions.setUserPermission(elevUserId, 'jobs', 'none', adminId);

  const effCaps = capabilities.effectiveCaps({ id: elevUserId, roles: ['workshop'], access_until: '2020-01-01T00:00:00Z', skipDelegations: true });
  assert.ok(!effCaps.includes('finance.period.reopen'), 'Expired positive cap elevation must be dropped');
  assert.ok(!effCaps.includes(revokedCap), 'Explicit cap revocation must remain enforced after expiry');

  const effJobLevel = permissions.effectiveLevel({ id: elevUserId, roles: ['workshop'], access_until: '2020-01-01T00:00:00Z' }, 'jobs');
  assert.strictEqual(effJobLevel, 'none', 'Explicit section revocation must remain enforced after expiry');

  const contractorId = mkUser('rem_contractor_exp', ['viewer'], { access_until: '2020-01-01T00:00:00Z' });
  const contCaps = capabilities.effectiveCaps({ id: contractorId, roles: ['viewer'], access_until: '2020-01-01T00:00:00Z' });
  assert.deepStrictEqual(contCaps, []);
  const contLvl = permissions.effectiveLevel({ id: contractorId, roles: ['viewer'], access_until: '2020-01-01T00:00:00Z' }, 'assets');
  assert.strictEqual(contLvl, 'none');
});

test('SEC-3: Non-admin manager cannot manage peer holding extra capabilities beyond actor own caps', () => {
  const peerAId = mkUser('rem_peer_a', ['workshop'], { workshop_id: wsId });
  const peerBId = mkUser('rem_peer_b', ['workshop'], { workshop_id: wsId });
  capabilities.setUserCapability(peerBId, 'finance.period.reopen', true, adminId);

  const actorA = { id: peerAId, roles: ['workshop'] };
  assert.throws(() => rules.assertCanManageUser(actorA, peerBId), (err) => err.status === 403);
});

test('SEC-5: outsourcing_pdf rejects malformed non-image signature_data URIs', () => {
  const html = buildHtml(
    { id: 1, ref_no: 'CCOM-XSS', status: 'approved', requested_at: '2026-11-12', asset_code: 'EX-1' },
    [],
    { signature_data: 'data:image/svg+xml" onerror="alert(1)', signed_name: 'Eng X', signed_at: '2026-11-12' },
    false
  );
  assert.ok(!html.includes('onerror='), 'Malformed signature URI must not inject attribute into PDF HTML');
  assert.ok(html.includes('DIGITALLY APPROVED'), 'Should fall back to digital approval stamp');
});

test('SEC-6 & SEC-7: SAP OData auth + dual-auth visibility/self-guard + uploads default-deny + assets LIMIT clamp', async () => {
  const healthz = await req('GET', '/api/sap/v1/healthz');
  assert.strictEqual(healthz.status, 200);
  const odataRoot = await req('GET', '/api/sap/v1/odata/');
  assert.strictEqual(odataRoot.status, 401);
  const odataMeta = await req('GET', '/api/sap/v1/odata/$metadata');
  assert.strictEqual(odataMeta.status, 401);

  const viewerCookie = await login('rem_viewer');
  const mgrCookie = await login('rem_mgr');
  const dualId = run(
    `INSERT INTO dual_auth_requests (operation_type, entity_type, entity_id, requested_by, reason, proposed_data, status)
     VALUES ('security_escalation', 'user', ?, ?, 'Secret escalation test', '{"role":"admin"}', 'PENDING')`,
    mgrId, mgrId
  ).lastInsertRowid;

  const vPending = await req('GET', '/api/dual-auth/pending', { cookie: viewerCookie });
  assert.strictEqual(vPending.status, 200);
  assert.ok(!vPending.json.requests.some((r) => r.id === dualId), 'Viewer must not see another user pending dual-auth request');

  const mPending = await req('GET', '/api/dual-auth/pending', { cookie: mgrCookie });
  assert.strictEqual(mPending.status, 200);
  assert.ok(mPending.json.requests.some((r) => r.id === dualId), 'Manager approver should see pending dual-auth request');

  const selfMId = mkUser('rem_self_ws', ['workshop'], { workshop_id: wsId });
  capabilities.setUserCapability(selfMId, 'access.manage', true, adminId);
  const selfMCookie = await login('rem_self_ws');
  const selfAssign = await req('POST', `/api/dual-auth/users/${selfMId}/workshops`, {
    cookie: selfMCookie,
    body: { workshop_ids: [wsId] },
  });
  assert.strictEqual(selfAssign.status, 403);

  fs.mkdirSync(path.join(process.env.UPLOAD_DIR, 'private_other'), { recursive: true });
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'private_other', 'secret.txt'), 'secret');
  mkUser('rem_zerocap', ['audit_custom']);
  const zeroCookie = await login('rem_zerocap');
  const upRes = await req('GET', '/uploads/private_other/secret.txt', { cookie: zeroCookie });
  assert.strictEqual(upRes.status, 403);

  run(`INSERT INTO assets (code, code_norm, registration) VALUES ('REM-LIM-1', 'REMLIM1', 'WP-L1')`);
  run(`INSERT INTO assets (code, code_norm, registration) VALUES ('REM-LIM-2', 'REMLIM2', 'WP-L2')`);
  const adminCookie = await login('rem_admin');
  const limRes = await req('GET', '/api/assets?limit=-1', { cookie: adminCookie });
  assert.strictEqual(limRes.status, 200);
  assert.strictEqual(limRes.json.length, 1, 'limit=-1 must be clamped to >= 1 instead of unbounded SQLite scan');
});

test('Batch 3 Performance: findDuplicateCandidates and GET /api/reports/jobs-summary.html succeed cleanly', async () => {
  const adminCookie = await login('rem_admin');
  const cands = assetMerge.findDuplicateCandidates({ limit: 20 });
  assert.ok(Array.isArray(cands));

  const sumRes = await req('GET', '/api/reports/jobs-summary.html', { cookie: adminCookie });
  assert.strictEqual(sumRes.status, 200);
  assert.ok(sumRes.text.includes('Jobs Attended'));
});
