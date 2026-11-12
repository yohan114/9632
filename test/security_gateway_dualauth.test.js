'use strict';

// Two holes closed in the 2026-11-11 security pass, pinned so they cannot quietly reopen.
//
// 1. The SAP gateway (/api/sap/v1) used to fall back to a key written in the source, accept it in
//    the query string, and let signed-in users through by role NAME. Now: no key unless
//    SAP_GATEWAY_API_KEY is set (32+ characters), header only, and a signed-in user is let in by
//    capability per scope.
// 2. Approving or rejecting a dual-authorization request had no permission check at all, and a
//    "job_reopen" approval rewrote job_cards directly — skipping the job card's own reopen, which
//    keeps the job in the cost-report month it was first closed in.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-secgw-'));
process.env.DB_PATH = path.join(TMP, 'live.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.CSRF_TRUSTED_ORIGINS;
delete process.env.PUBLIC_ORIGIN;
delete process.env.SAP_GATEWAY_API_KEY;

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();
for (const n of ['admin', 'manager', 'gw_nobody']) run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
function mkUser(username, password, roles = []) {
  const id = run('INSERT INTO users (username, password_hash, active, must_change_password) VALUES (?, ?, 1, 0)',
    username, auth.hashPassword(password)).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const PW = 'granite-harbour-lantern';
const adminId = mkUser('gw_chief', PW, ['admin']);
const managerId = mkUser('gw_manager', PW, ['manager']);
const nobodyId = mkUser('gw_nobody', PW, ['gw_nobody']);
// A role that requires two-factor sign-in reaches only the enrolment screens until it is set up;
// that is not what these tests are about, so the fixture roles do not require it.
try { run("UPDATE roles SET require_mfa = 0 WHERE name IN ('admin', 'manager', 'gw_nobody')"); } catch { /* column absent */ }

const app = require('../src/server');
let server; let port;
test.before(async () => { await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); }); port = server.address().port; });
test.after(() => { server && server.close(); });

function req(method, p, { body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch { /* not json */ }
        const setc = res.headers['set-cookie'];
        resolve({ status: res.statusCode, headers: res.headers, body: json, text: buf,
          cookie: setc ? setc[0].split(';')[0] : null });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
async function login(username) {
  const r = await req('POST', '/api/auth/login', { body: { username, password: PW } });
  assert.strictEqual(r.status, 200, `login ${username}: ${r.text}`);
  return r.cookie;
}

// ---------------------------------------------------------------- SAP gateway
const OLD_KEY = 'sap-wsone-dev-token-2026';
const STRONG_KEY = 'k'.repeat(16) + '-0123456789abcdef-strong';

test('SAP gateway: no key works when SAP_GATEWAY_API_KEY is unset — not even the old built-in one', async () => {
  delete process.env.SAP_GATEWAY_API_KEY;
  for (const headers of [{ 'x-sap-api-key': OLD_KEY }, { Authorization: `Bearer ${OLD_KEY}` }, {}]) {
    const r = await req('GET', '/api/sap/v1/odata/Equipments', { headers });
    assert.strictEqual(r.status, 401, JSON.stringify(headers));
  }
  assert.strictEqual((await req('GET', `/api/sap/v1/odata/Equipments?apiKey=${OLD_KEY}`)).status, 401);
  for (const p of ['/api/sap/v1/analytics/cds-models', '/api/sap/v1/analytics/hana-ddl', '/api/sap/v1/analytics/datasphere-package']) {
    assert.strictEqual((await req('GET', p)).status, 401, p);
  }
  // The descriptive endpoints stay public.
  assert.strictEqual((await req('GET', '/api/sap/v1/healthz')).status, 200);
});

test('SAP gateway: a configured key works in the header only, and a short key is ignored', async () => {
  try {
    process.env.SAP_GATEWAY_API_KEY = 'too-short-key';
    assert.strictEqual((await req('GET', '/api/sap/v1/odata/Equipments', { headers: { 'x-sap-api-key': 'too-short-key' } })).status, 401);

    process.env.SAP_GATEWAY_API_KEY = STRONG_KEY;
    assert.strictEqual((await req('GET', '/api/sap/v1/odata/Equipments', { headers: { 'x-sap-api-key': STRONG_KEY } })).status, 200);
    assert.strictEqual((await req('GET', '/api/sap/v1/odata/Equipments', { headers: { Authorization: `Bearer ${STRONG_KEY}` } })).status, 200);
    assert.strictEqual((await req('GET', `/api/sap/v1/odata/Equipments?apiKey=${STRONG_KEY}`)).status, 401, 'never from the query string');
    assert.strictEqual((await req('GET', '/api/sap/v1/odata/Equipments', { headers: { 'x-sap-api-key': STRONG_KEY + 'x' } })).status, 401);
  } finally {
    delete process.env.SAP_GATEWAY_API_KEY;
  }
});

test('SAP gateway: a signed-in user is let in by capability, not by role name', async () => {
  const admin = await login('gw_chief');
  assert.strictEqual((await req('GET', '/api/sap/v1/odata/Equipments', { cookie: admin })).status, 200);
  assert.strictEqual((await req('GET', '/api/sap/v1/analytics/cds-models', { cookie: admin })).status, 200);

  // A role that was given nothing reads nothing.
  const nobody = await login('gw_nobody');
  assert.strictEqual((await req('GET', '/api/sap/v1/odata/MaterialMaster', { cookie: nobody })).status, 403);
  assert.strictEqual((await req('GET', '/api/sap/v1/analytics/hana-ddl', { cookie: nobody })).status, 403);
});

// ---------------------------------------------------------------- dual authorization
function pending(operation, entityType, entityId, by) {
  return run(`INSERT INTO dual_auth_requests (operation_type, entity_type, entity_id, requested_by, reason, proposed_data, status)
              VALUES (?, ?, ?, ?, 'test', '{}', 'PENDING')`, operation, entityType, entityId, by).lastInsertRowid;
}

test('dual auth: approving or rejecting needs dual_auth.override', async () => {
  const id = pending('stock_scrap', 'tool', 999999, adminId);
  const nobody = await login('gw_nobody');
  assert.strictEqual((await req('POST', `/api/dual-auth/${id}/approve`, { cookie: nobody, body: {} })).status, 403);
  assert.strictEqual((await req('POST', `/api/dual-auth/${id}/reject`, { cookie: nobody, body: {} })).status, 403);
  assert.strictEqual(get('SELECT status FROM dual_auth_requests WHERE id = ?', id).status, 'PENDING');

  const manager = await login('gw_manager');
  const r = await req('POST', `/api/dual-auth/${id}/reject`, { cookie: manager, body: { note: 'no' } });
  assert.strictEqual(r.status, 200, r.text);
});

test('dual auth: a job_reopen request is never applied by a raw update — the job card reopens it', async () => {
  const id = pending('job_reopen', 'job_card', 424242, adminId);
  const manager = await login('gw_manager');
  const r = await req('POST', `/api/dual-auth/${id}/approve`, { cookie: manager, body: {} });
  assert.strictEqual(r.status, 409, r.text);
  assert.match(r.body.error, /job card/i);
  assert.strictEqual(get('SELECT status FROM dual_auth_requests WHERE id = ?', id).status, 'PENDING');
});
