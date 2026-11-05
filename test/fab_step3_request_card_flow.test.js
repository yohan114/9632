'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fab-flow-test-'));
process.env.DB_PATH = path.join(TMP, 'fab.db');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const app = require('../src/server');

let server;
let port;

function req(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = {};
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(buf); } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: json !== undefined ? json : buf,
          cookie: (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; '),
        });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function login(username, password = 'password123') {
  const res = await req('POST', '/api/auth/login', { body: { username, password } });
  assert.strictEqual(res.status, 200, `Login failed for ${username}`);
  return res.cookie;
}

test.before(async () => {
  migrate();
  capabilities.seedCapabilities();

  // Create roles
  for (const r of ['admin', 'assistant_transport_manager', 'transport_manager', 'operational_manager', 'workshop', 'viewer']) {
    run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', r, r);
  }

  // Create users
  const mkUser = (u, r) => {
    const uid = run('INSERT INTO users (username, password_hash, full_name, active) VALUES (?, ?, ?, 1)',
      u, auth.hashPassword('password123'), u).lastInsertRowid;
    run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
    return uid;
  };

  mkUser('admin_user', 'admin');
  mkUser('asst_user', 'assistant_transport_manager');
  mkUser('tm_user', 'transport_manager');
  mkUser('om_user', 'operational_manager');
  mkUser('ws_user', 'workshop');
  mkUser('plain_viewer', 'viewer');

  // Seed sample vehicle, project, workshop
  run("INSERT INTO assets (code, code_norm, status) VALUES ('FAB-01', 'FAB01', 'active')");
  run("INSERT INTO projects (code, name) VALUES ('P-01', 'Central Yard')");

  await new Promise((res) => {
    server = app.listen(0, '127.0.0.1', res);
  });
  port = server.address().port;
});

test.after(() => {
  if (server) server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('Fabrication Request & Card Flow', async (t) => {
  const adminCookie = await login('admin_user');
  const asstCookie = await login('asst_user');
  const tmCookie = await login('tm_user');
  const omCookie = await login('om_user');
  const wsCookie = await login('ws_user');
  const viewCookie = await login('plain_viewer');

  const asset = get("SELECT id FROM assets WHERE code = 'FAB-01'");
  const project = get("SELECT id FROM projects WHERE code = 'P-01'");

  // 1. When fabrication.enabled is '0', creation is blocked with 403
  run("UPDATE settings SET value = '0' WHERE key = 'fabrication.enabled'");
  const disabledRes = await req('POST', '/api/job-requests', {
    cookie: asstCookie,
    body: {
      type: 'fabrication',
      fabrication_kind: 'new',
      description: 'Fabricate new tipper bucket',
      asset_id: asset.id,
      project_id: project.id,
    },
  });
  assert.strictEqual(disabledRes.status, 403);
  assert.match(disabledRes.body.error, /disabled/i);

  // 2. Enable fabrication
  run("UPDATE settings SET value = '1' WHERE key = 'fabrication.enabled'");

  // 3. User without capability (plain viewer) gets 403
  const unauthRes = await req('POST', '/api/job-requests', {
    cookie: viewCookie,
    body: {
      type: 'fabrication',
      fabrication_kind: 'new',
      description: 'Fabricate new tipper bucket',
      asset_id: asset.id,
      project_id: project.id,
    },
  });
  assert.strictEqual(unauthRes.status, 403);

  // 4. Missing or invalid fabrication_kind returns 400
  const invalidKindRes = await req('POST', '/api/job-requests', {
    cookie: asstCookie,
    body: {
      type: 'fabrication',
      fabrication_kind: 'unsupported_kind',
      description: 'Fabricate new tipper bucket',
      asset_id: asset.id,
      project_id: project.id,
    },
  });
  assert.strictEqual(invalidKindRes.status, 400);

  // 5. Successful creation of fabrication request
  const createRes = await req('POST', '/api/job-requests', {
    cookie: asstCookie,
    body: {
      type: 'fabrication',
      fabrication_kind: 'new',
      description: 'Fabricate new tipper bucket',
      asset_id: asset.id,
      project_id: project.id,
    },
  });
  assert.strictEqual(createRes.status, 201);
  const jr = createRes.body.request;
  assert.strictEqual(jr.type, 'fabrication');
  assert.strictEqual(jr.fabrication_kind, 'new');
  assert.strictEqual(jr.issue_store_location_id, 1, 'Defaults to Central Main Stores (1)');
  assert.strictEqual(jr.approval_status, 'requested');

  // 6. Certify stage (Transport Manager)
  const certRes = await req('POST', `/api/job-requests/${jr.id}/certify`, {
    cookie: tmCookie,
    body: { signature: 'data:image/png;base64,tm_sig' },
  });
  assert.strictEqual(certRes.status, 200);
  assert.strictEqual(certRes.body.approval_status, 'certified');

  // 7. Approve stage (Operational Manager)
  const appRes = await req('POST', `/api/job-requests/${jr.id}/approve`, {
    cookie: omCookie,
    body: { signature: 'data:image/png;base64,om_sig' },
  });
  assert.strictEqual(appRes.status, 200);
  assert.strictEqual(appRes.body.request.approval_status, 'approved');

  // 8. Workshop opens Job Card against approved request
  const openRes = await req('POST', '/api/jobs', {
    cookie: wsCookie,
    body: {
      job_request_id: jr.id,
      take_in: true,
      note: 'Started fabrication jig setup',
    },
  });
  assert.strictEqual(openRes.status, 201);
  const job = openRes.body.job;
  assert.strictEqual(job.type, 'fabrication');
  assert.strictEqual(job.fabrication_kind, 'new');
  assert.strictEqual(job.issue_store_location_id, 1);
  assert.strictEqual(job.job_request_id, jr.id);
  assert.match(job.job_no, /\/\d+\/F\/\d+$/, 'Job number must use F sequence (YYYY/M/F/seq)');

  // 9. Verify reverse pointer in job_requests
  const updatedJr = get('SELECT job_id FROM job_requests WHERE id = ?', jr.id);
  assert.strictEqual(updatedJr.job_id, job.id);

  // 10. Verify unallocated asset handling for new fabrication build (Plan A2 & D6)
  const unallocRes = await req('POST', '/api/job-requests', {
    cookie: asstCookie,
    body: {
      type: 'fabrication',
      fabrication_kind: 'new',
      description: 'New structural trailer bed chassis build (no vehicle yet)',
      project_id: project.id,
    },
  });
  assert.strictEqual(unallocRes.status, 201);
  const unallocJr = unallocRes.body.request;
  assert.strictEqual(unallocJr.asset_id, null);

  // Certify & Approve unallocated build
  await req('POST', `/api/job-requests/${unallocJr.id}/certify`, { cookie: tmCookie, body: {} });
  await req('POST', `/api/job-requests/${unallocJr.id}/approve`, { cookie: omCookie, body: {} });

  // Workshop opens unallocated fabrication card
  const unallocJobRes = await req('POST', '/api/jobs', {
    cookie: wsCookie,
    body: { job_request_id: unallocJr.id },
  });
  assert.strictEqual(unallocJobRes.status, 201);
  assert.strictEqual(unallocJobRes.body.job.asset_id, null);
  assert.strictEqual(unallocJobRes.body.job.type, 'fabrication');
  assert.strictEqual(unallocJobRes.body.job.fabrication_kind, 'new');

  // Verify that a standard repair request WITHOUT asset IS rejected at card open
  run("INSERT INTO job_requests (jr_no, type, description, approval_status) VALUES ('JR-REPAIR-UNALLOC', 'repair', 'Broken pump', 'approved')");
  const repairUnallocJr = get("SELECT id FROM job_requests WHERE jr_no = 'JR-REPAIR-UNALLOC'");
  const blockedRepairCard = await req('POST', '/api/jobs', {
    cookie: wsCookie,
    body: { job_request_id: repairUnallocJr.id },
  });
  assert.strictEqual(blockedRepairCard.status, 409);
  assert.strictEqual(blockedRepairCard.body.unlinked_asset, true);
});
