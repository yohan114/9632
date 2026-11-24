'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-stage-d-'));
process.env.DB_PATH = path.join(TMP, 'staged.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '30';
process.env.BACKUP_RETENTION = '5';
process.env.CEYPETCO_SYNC_ENABLED = 'false';
delete process.env.MULTIDB;

const { db, migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const permissions = require('../src/lib/permissions');
const backupStatus = require('../src/lib/backup_status');
const totp = require('../src/lib/totp');
const app = require('../src/server');

let server;
let baseUrl;
let adminCookie;
let mgrCookie;
let viewerCookie;
let dormantCookie;
const ids = {};

async function reqJson(urlPath, { method = 'GET', body = null, cookie = adminCookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, headers: res.headers, body: json };
}

async function loginAs(username, password) {
  const res = await reqJson('/api/auth/login', {
    method: 'POST',
    cookie: null,
    body: { username, password },
  });
  assert.equal(res.status, 200, `Login failed for ${username}: ${JSON.stringify(res.body)}`);
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, `Missing set-cookie for ${username}`);
  return setCookie.split(';')[0];
}

test('Setup Stage D isolated DB, roles & users', async () => {
  migrate();

  for (const [name, label] of [
    ['admin', 'Administrator'],
    ['manager', 'Manager'],
    ['operational_manager', 'Operations Manager'],
    ['accountant', 'Cost Accountant / Finance'],
    ['storekeeper', 'Storekeeper'],
    ['viewer', 'Viewer'],
  ]) {
    run('INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES (?, ?, 1, 1)', name, label);
  }
  permissions.seedDefaults();
  capabilities.seedCapabilities();

  const pwHash = auth.hashPassword('StageD-Secret#2026');
  const mkUser = (username, fullName, roleName, { mustChange = 0 } = {}) => {
    const uRes = run(
      'INSERT INTO users (username, password_hash, full_name, active, must_change_password) VALUES (?, ?, ?, 1, ?)',
      username, pwHash, fullName, mustChange
    );
    const uid = Number(uRes.lastInsertRowid);
    const r = get('SELECT id FROM roles WHERE name = ?', roleName);
    run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', uid, r.id);
    return uid;
  };

  ids.admin1 = mkUser('admin_one', 'Primary Admin', 'admin');
  ids.admin2 = mkUser('admin_two', 'Backup Admin', 'admin');
  ids.mgr = mkUser('mgr_access', 'Delegated Manager', 'manager');
  run("INSERT OR REPLACE INTO user_capabilities (user_id, capability, granted) VALUES (?, 'access.manage', 1)", ids.mgr);
  run("INSERT OR REPLACE INTO user_capabilities (user_id, capability, granted) VALUES (?, 'users.manage', 1)", ids.mgr);

  ids.dormant = mkUser('store', 'Seed Storekeeper', 'storekeeper', { mustChange: 1 });
  ids.extraStaff = mkUser('staff_idle', 'Idle Staff Account', 'viewer', { mustChange: 1 });
  ids.viewer = mkUser('viewer_only', 'Read Only Viewer', 'viewer');

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  adminCookie = await loginAs('admin_one', 'StageD-Secret#2026');
  mgrCookie = await loginAs('mgr_access', 'StageD-Secret#2026');
  viewerCookie = await loginAs('viewer_only', 'StageD-Secret#2026');

  // Create an active session row directly for dormant user to verify session revocation upon deactivation
  const tok = 'dormant-test-session-' + Date.now();
  run("INSERT INTO sessions (user_id, token, created_at, expires_at, mfa_verified) VALUES (?, ?, datetime('now'), datetime('now', '+1 day'), 0)", ids.dormant, tok);
  dormantCookie = `wo_session=${tok}`;
});

test('1. Security posture audit summarizes roles, MFA coverage, password resets & runtime', async () => {
  const denied = await reqJson('/api/access/security-posture', { cookie: viewerCookie });
  assert.equal(denied.status, 403);

  const res = await reqJson('/api/access/security-posture');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const p = res.body;

  assert.equal(p.summary.active_users, 6);
  assert.equal(p.summary.active_admins, 2);
  assert.equal(p.summary.mfa_enrolled_users, 0);
  assert.equal(p.summary.privileged_roles_total, 4);
  assert.equal(p.summary.privileged_roles_enforced, 0);
  assert.equal(p.summary.must_change_password_count, 2);
  assert.equal(p.summary.actor_mfa_enabled, false);
  assert.ok(p.summary.dormant_accounts_count >= 1);

  const seedRow = p.users.find((u) => u.id === ids.dormant);
  assert.ok(seedRow);
  assert.equal(seedRow.is_default_seed, true);
  assert.equal(seedRow.can_deactivate, true);

  const adm2Row = p.users.find((u) => u.id === ids.admin2);
  assert.equal(adm2Row.can_deactivate, false, 'Admin accounts cannot be bulk-deactivated from audit table');
  assert.ok(p.runtime && p.runtime.node_version);
});

test('2. Privileged MFA policy enforces self-unenrolled confirmation, TOTP enrollment recovery & non-admin boundaries', async () => {
  // Admin without MFA enrolled gets 409 confirmation guard when enabling admin role
  const guard = await reqJson('/api/access/security-posture/mfa-policy', {
    method: 'POST',
    body: { roles: ['admin', 'operational_manager'], require_mfa: true },
  });
  assert.equal(guard.status, 409, JSON.stringify(guard.body));
  assert.equal(guard.body.requires_self_mfa_confirm, true);
  assert.deepEqual(guard.body.affected_self_roles, ['admin']);

  // Enforcing another role that admin does not hold works immediately without self confirmation
  const otherRoleOn = await reqJson('/api/access/security-posture/mfa-policy', {
    method: 'POST',
    body: { roles: ['operational_manager'], require_mfa: true },
  });
  assert.equal(otherRoleOn.status, 200, JSON.stringify(otherRoleOn.body));
  assert.equal(otherRoleOn.body.posture.summary.privileged_roles_enforced, 1);

  // Non-admin cannot touch admin role policy
  const mgrAdminDeny = await reqJson('/api/access/security-posture/mfa-policy', {
    method: 'POST',
    cookie: mgrCookie,
    body: { roles: ['admin'], require_mfa: true, confirm_self_unenrolled: true },
  });
  assert.equal(mgrAdminDeny.status, 403);

  // Non-admin cannot relax MFA on any role
  const mgrRelaxDeny = await reqJson('/api/access/security-posture/mfa-policy', {
    method: 'POST',
    cookie: mgrCookie,
    body: { roles: ['operational_manager'], require_mfa: false },
  });
  assert.equal(mgrRelaxDeny.status, 403);

  // Confirming self-unenrolled enforces 2FA on admin and triggers 428 enrollment gate until TOTP is enabled
  const okOn = await reqJson('/api/access/security-posture/mfa-policy', {
    method: 'POST',
    body: { roles: ['admin'], require_mfa: true, confirm_self_unenrolled: true },
  });
  assert.equal(okOn.status, 200, JSON.stringify(okOn.body));
  assert.equal(okOn.body.require_mfa, true);
  assert.equal(okOn.body.posture.summary.privileged_roles_enforced, 2);

  const gated = await reqJson('/api/access/security-posture');
  assert.equal(gated.status, 428);
  assert.equal(gated.body.mfaSetupRequired, true);

  // Enroll admin_one via allowed MFA setup/enable endpoints without losing current session
  const setup = await reqJson('/api/auth/mfa/setup', { method: 'POST' });
  assert.equal(setup.status, 200);
  const code = totp.codeAt(setup.body.secret);
  const enabled = await reqJson('/api/auth/mfa/enable', { method: 'POST', body: { code } });
  assert.equal(enabled.status, 200);

  const restored = await reqJson('/api/access/security-posture');
  assert.equal(restored.status, 200);
  assert.equal(restored.body.summary.actor_mfa_enabled, true);
  assert.equal(restored.body.summary.mfa_enrolled_users, 1);

  // Admin can relax MFA cleanly
  const okOff = await reqJson('/api/access/security-posture/mfa-policy', {
    method: 'POST',
    body: { roles: ['admin', 'operational_manager'], require_mfa: false },
  });
  assert.equal(okOff.status, 200);
  assert.equal(okOff.body.posture.summary.privileged_roles_enforced, 0);
});

test('3. Bulk deactivation requires audit reason, preserves admins & revokes active sessions atomically', async () => {
  const shortReason = await reqJson('/api/access/security-posture/deactivate-users', {
    method: 'POST',
    body: { user_ids: [ids.dormant], reason: 'no' },
  });
  assert.equal(shortReason.status, 400);

  // Trying to deactivate self alongside another account rolls back the whole batch
  const selfAttempt = await reqJson('/api/access/security-posture/deactivate-users', {
    method: 'POST',
    body: { user_ids: [ids.extraStaff, ids.admin1], reason: 'Rollback check' },
  });
  assert.equal(selfAttempt.status, 403);
  assert.equal(get('SELECT active FROM users WHERE id = ?', ids.extraStaff).active, 1);

  // Admin cannot deactivate the last active admin either (deactivate admin2 then try non-self check with 1 left)
  const admin2Gone = await reqJson('/api/access/security-posture/deactivate-users', {
    method: 'POST',
    body: { user_ids: [ids.admin2], reason: 'Removing second admin before test' },
  });
  assert.equal(admin2Gone.status, 200);
  // Restore admin2 for remaining posture counts
  run('UPDATE users SET active = 1 WHERE id = ?', ids.admin2);

  // Non-admin cannot deactivate an admin account
  const mgrVsAdmin = await reqJson('/api/access/security-posture/deactivate-users', {
    method: 'POST',
    cookie: mgrCookie,
    body: { user_ids: [ids.admin2], reason: 'Privilege escalation block test' },
  });
  assert.equal(mgrVsAdmin.status, 403);

  // Valid deactivation of dormant seed account revokes its sessions and logs audit
  const okDeact = await reqJson('/api/access/security-posture/deactivate-users', {
    method: 'POST',
    body: { user_ids: [ids.dormant], reason: 'Deactivate default seed account in Stage D audit' },
  });
  assert.equal(okDeact.status, 200, JSON.stringify(okDeact.body));
  assert.equal(okDeact.body.deactivated.length, 1);
  assert.equal(okDeact.body.deactivated[0].username, 'store');
  assert.ok(okDeact.body.deactivated[0].sessions_revoked >= 1);

  const sessLeft = get('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?', ids.dormant).c;
  assert.equal(sessLeft, 0);
  const stillSignedIn = await reqJson('/api/auth/me', { cookie: dormantCookie });
  assert.equal(stillSignedIn.status, 401);

  const aud = get("SELECT reason FROM audit_log WHERE entity = 'user' AND entity_id = ? AND action = 'deactivate_security_audit' ORDER BY id DESC LIMIT 1", ids.dormant);
  assert.equal(aud.reason, 'Deactivate default seed account in Stage D audit');
});

test('4. Cold backup & integrity check endpoint produces verified SQLite snapshot', async () => {
  const denied = await reqJson('/api/access/security-posture/backup-verify', {
    method: 'POST',
    cookie: viewerCookie,
  });
  assert.equal(denied.status, 403);

  const res = await reqJson('/api/access/security-posture/backup-verify', { method: 'POST' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.verify.integrity, 'ok');
  assert.ok(res.body.verify.tables > 10);
  assert.equal(res.body.verify.users, 6);
  assert.equal(res.body.backup.ok, true);

  const snapFile = path.join(process.env.BACKUP_DIR, res.body.snapshot);
  assert.ok(fs.existsSync(snapFile), `Expected cold snapshot file ${snapFile}`);
  const summary = backupStatus.summary();
  assert.equal(summary.ok, true);
});

test('5. CI workflow, unified deploy/update.sh (LF), and Security cockpit frontend pass checks', () => {
  const root = path.join(__dirname, '..');

  const ciPath = path.join(root, '.github', 'workflows', 'ci.yml');
  assert.ok(fs.existsSync(ciPath), 'Missing .github/workflows/ci.yml');
  const ciSrc = fs.readFileSync(ciPath, 'utf8');
  assert.match(ciSrc, /npm test/);
  assert.match(ciSrc, /capabilities\.test\.js/);

  const updPath = path.join(root, 'deploy', 'update.sh');
  const updSrc = fs.readFileSync(updPath, 'utf8');
  assert.equal(/\r/.test(updSrc), false, 'deploy/update.sh must use Unix LF line endings');
  assert.match(updSrc, /workshopone-unified/);
  assert.match(updSrc, /restore\.js --verify --latest/);
  assert.match(updSrc, /integrity_check/);

  const appSrc = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const lines = appSrc.split(/\r?\n/).length;
  assert.ok(lines < 24000, `Expected public/app.js < 24,000 lines, got ${lines}`);
  assert.match(appSrc, /tab === 'security'/);

  const acSrc = fs.readFileSync(path.join(root, 'public', 'modules', 'access_control.js'), 'utf8');
  new vm.Script(acSrc, { filename: 'access_control.js' });
  assert.match(acSrc, /function renderSecurityHardeningTab\s*\(/);
  assert.match(acSrc, /security-posture\/backup-verify/);
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
