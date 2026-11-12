'use strict';

/**
 * ===========================================================================
 * Vehicle Documents REST API Test Suite (Phase 3)
 *
 * Validates:
 * 1. RBAC and Capability guards on all endpoints.
 * 2. GET /api/vehicle-documents/types
 * 3. GET /api/vehicle-documents/compliance-summary
 * 4. GET /api/vehicle-documents/upcoming-expirations
 * 5. GET /api/vehicle-documents/assets/:assetId & /api/assets/:id/documents
 * 6. GET /api/vehicle-documents/assets/:assetId/erl-checklist & /api/assets/:id/erl-checklist
 * 7. POST /api/vehicle-documents/:docId/versions (Draft submission)
 * 8. PUT /api/vehicle-documents/versions/:versionId (Update draft)
 * 9. POST /api/vehicle-documents/versions/:versionId/attachments (Upload scan)
 * 10. GET /api/vehicle-documents/attachments/:attachmentId/download (File streaming)
 * 11. POST /api/vehicle-documents/versions/:versionId/verify (Manager promotion)
 * 12. Immutability guards on verified versions & attachments
 * 13. PUT /api/vehicle-documents/:docId/exemption (Laid-up fleet exemption)
 * 14. GET & POST /api/vehicle-documents/tasks (Renewal workflow tracker)
 * ===========================================================================
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-vdocs-api-'));
process.env.DB_PATH = path.join(TMP, 'vdocs_api.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const permissions = require('../src/lib/permissions');

migrate();

// 1. Seed Roles & Clearances
const PW = 'fleet-statutory-token-pw';
function mkUser(username, roleName) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', roleName, roleName);
  const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', username, auth.hashPassword(PW)).lastInsertRowid;
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, roleName);
  return uid;
}

const adminId = mkUser('boss_admin', 'admin');
const tmId = mkUser('transport_mgr', 'transport_manager');
const unauthId = mkUser('viewer_user', 'viewer');

capabilities.seedCapabilities();

// 2. Seed Test Vehicles
run(`INSERT OR IGNORE INTO assets (id, code, code_norm, registration, brand, type, asset_class, status)
    VALUES (201, 'TM-01', 'TM01', 'WP LB-5555', 'NISSAN', 'Lorry', 'vehicle', 'active')`);

// 3. Start Test HTTP Server
const app = require('../src/server');
let server;
let port;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
});

test.after(() => {
  if (server) server.close();
});

function req(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = {};
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); });
      res.on('end', () => {
        const rawBuf = Buffer.concat(chunks);
        const buf = rawBuf.toString('utf8');
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        const sc = res.headers['set-cookie'];
        resolve({
          status: res.statusCode,
          body: json,
          text: buf,
          raw: rawBuf,
          headers: res.headers,
          cookie: sc ? sc[0].split(';')[0] : null
        });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function login(username) {
  const r = await req('POST', '/api/auth/login', { body: { username, password: PW } });
  assert.strictEqual(r.status, 200, r.text);
  return r.cookie;
}

// ---------------------------------------------------------------------------
// TEST 1: Unauthenticated & Unauthorized Refusals
// ---------------------------------------------------------------------------
test('API refuses unauthenticated requests with 401', async () => {
  const r = await req('GET', '/api/vehicle-documents/types');
  assert.strictEqual(r.status, 401);
});

test('API enforces granular capabilities on endpoints', async () => {
  const viewerCookie = await login('viewer_user');

  // viewer role lacks vehicle_docs.exempt
  const exemptRes = await req('PUT', '/api/vehicle-documents/1/exemption', {
    cookie: viewerCookie,
    body: { isExempt: true, reason: 'Testing forbidden' }
  });
  assert.strictEqual(exemptRes.status, 403, 'Refuses without vehicle_docs.exempt');
});

// ---------------------------------------------------------------------------
// TEST 2: Catalogs, Dashboards & Upcoming Expirations
// ---------------------------------------------------------------------------
test('GET /api/vehicle-documents/types returns statutory document types', async () => {
  const tmCookie = await login('transport_mgr');
  const r = await req('GET', '/api/vehicle-documents/types', { cookie: tmCookie });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.ok(r.body.length >= 7);
  const codes = r.body.map((t) => t.code);
  assert.ok(codes.includes('revenue_licence'));
  assert.ok(codes.includes('insurance'));
});

test('GET /api/vehicle-documents/compliance-summary returns fleet KPIs', async () => {
  const tmCookie = await login('transport_mgr');
  const r = await req('GET', '/api/vehicle-documents/compliance-summary', { cookie: tmCookie });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.kpis);
  assert.ok(r.body.type_breakdown);
  assert.ok(Array.isArray(r.body.upcoming_expirations));
});

test('GET /api/vehicle-documents/upcoming-expirations returns upcoming list', async () => {
  const tmCookie = await login('transport_mgr');
  const r = await req('GET', '/api/vehicle-documents/upcoming-expirations?daysAhead=45', { cookie: tmCookie });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body));
});

// ---------------------------------------------------------------------------
// TEST 3: Vehicle Document Containers & eRL Checklist Endpoints
// ---------------------------------------------------------------------------
test('GET /api/vehicle-documents/assets/:id and /api/assets/:id/documents', async () => {
  const tmCookie = await login('transport_mgr');

  const r1 = await req('GET', '/api/vehicle-documents/assets/201', { cookie: tmCookie });
  assert.strictEqual(r1.status, 200);
  assert.ok(Array.isArray(r1.body));
  assert.ok(r1.body.some((d) => d.doc_type_code === 'revenue_licence'));

  const r2 = await req('GET', '/api/assets/201/documents', { cookie: tmCookie });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.body.length, r1.body.length);
});

test('GET /api/assets/:id/erl-checklist returns prerequisite readiness', async () => {
  const tmCookie = await login('transport_mgr');
  const r = await req('GET', '/api/assets/201/erl-checklist', { cookie: tmCookie });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.asset_id, 201);
  assert.strictEqual(typeof r.body.ready_for_renewal, 'boolean');
  assert.ok(Array.isArray(r.body.items));
});

// ---------------------------------------------------------------------------
// TEST 4: Version Creation, Attachment Upload & Verification Flow
// ---------------------------------------------------------------------------
test('Version creation, attachment upload, download streaming, and verification', async () => {
  const tmCookie = await login('transport_mgr');
  const adminCookie = await login('boss_admin');

  // 1. Fetch documents for vehicle 201 to get Revenue Licence container ID
  const docsRes = await req('GET', '/api/vehicle-documents/assets/201', { cookie: tmCookie });
  const rlDoc = docsRes.body.find((d) => d.doc_type_code === 'revenue_licence');
  assert.ok(rlDoc, 'Found RL document');

  // 2. Submit renewal version
  const newVerRes = await req('POST', `/api/vehicle-documents/${rlDoc.id}/versions`, {
    cookie: tmCookie,
    body: {
      doc_number: 'RL-REST-2026-001',
      issuer_name: 'DMT Colombo Central',
      issue_date: '2026-10-08',
      valid_from: '2026-10-08',
      valid_until: '2027-10-07',
      cost_amount: 18500,
      notes: 'Renewed via postal / DMT counters'
    }
  });
  assert.strictEqual(newVerRes.status, 201);
  const version = newVerRes.body;
  assert.strictEqual(version.doc_number, 'RL-REST-2026-001');
  assert.strictEqual(version.status, 'pending_verification');

  // 3. Upload PDF attachment using base64 data URL
  const samplePdf = '%PDF-1.4\nTest Document Stream\n%%EOF';
  const dataUrl = `data:application/pdf;base64,${Buffer.from(samplePdf).toString('base64')}`;

  const uploadRes = await req('POST', `/api/vehicle-documents/versions/${version.id}/attachments`, {
    cookie: tmCookie,
    body: {
      dataUrl,
      filename: 'statutory_revenue_licence.pdf',
      kind: 'certificate'
    }
  });
  assert.strictEqual(uploadRes.status, 201);
  const attachment = uploadRes.body;
  assert.strictEqual(attachment.original_filename, 'statutory_revenue_licence.pdf');
  assert.strictEqual(attachment.mime_type, 'application/pdf');

  // 4. Download & stream file
  const downloadRes = await req('GET', `/api/vehicle-documents/attachments/${attachment.id}/download`, {
    cookie: tmCookie
  });
  assert.strictEqual(downloadRes.status, 200);
  assert.strictEqual(downloadRes.headers['content-type'], 'application/pdf');
  assert.ok(downloadRes.text.includes('Test Document Stream'));

  // 5. Manager verifies version (Transport Manager has vehicle_docs.verify)
  const verifyRes = await req('POST', `/api/vehicle-documents/versions/${version.id}/verify`, {
    cookie: adminCookie,
    body: {
      decision: 'approve',
      notes: 'Certificate scan and eRL payment receipt matched'
    }
  });
  assert.strictEqual(verifyRes.status, 200);
  assert.strictEqual(verifyRes.body.status, 'verified');

  // 6. Verify container updated
  const updatedDocRes = await req('GET', `/api/vehicle-documents/${rlDoc.id}`, { cookie: tmCookie });
  assert.strictEqual(updatedDocRes.body.current_version_id, version.id);

  // 7. Immutability guard: Attempting to delete attachment on verified version must fail
  const delRes = await req('DELETE', `/api/vehicle-documents/attachments/${attachment.id}`, {
    cookie: adminCookie
  });
  assert.strictEqual(delRes.status, 403, 'Deleting verified attachment must be forbidden');
});

// ---------------------------------------------------------------------------
// TEST 5: Formal Exemption & Renewal Task Endpoints
// ---------------------------------------------------------------------------
test('Exemption endpoint and Renewal Tasks endpoints', async () => {
  const adminCookie = await login('boss_admin');
  const tmCookie = await login('transport_mgr');

  const docsRes = await req('GET', '/api/vehicle-documents/assets/201', { cookie: tmCookie });
  const insDoc = docsRes.body.find((d) => d.doc_type_code === 'insurance');

  // 1. Exemption
  const exemptRes = await req('PUT', `/api/vehicle-documents/${insDoc.id}/exemption`, {
    cookie: adminCookie,
    body: {
      isExempt: true,
      reason: 'Vehicle stationed on private site; off public highways'
    }
  });
  assert.strictEqual(exemptRes.status, 200);
  assert.strictEqual(exemptRes.body.is_exempt, 1);

  // 2. Create Renewal Task
  const taskRes = await req('POST', '/api/vehicle-documents/tasks', {
    cookie: tmCookie,
    body: {
      document_id: insDoc.id,
      stage: 'preparing',
      target_date: '2026-11-01',
      estimated_cost: 65000
    }
  });
  assert.strictEqual(taskRes.status, 201);
  const task = taskRes.body;
  assert.strictEqual(task.stage, 'preparing');

  // 3. Update Renewal Task
  const updateTaskRes = await req('PUT', `/api/vehicle-documents/tasks/${task.id}`, {
    cookie: tmCookie,
    body: {
      stage: 'appointment_booked',
      actual_cost: 62000
    }
  });
  assert.strictEqual(updateTaskRes.status, 200);
  assert.strictEqual(updateTaskRes.body.stage, 'appointment_booked');

  // 4. List Tasks
  const listTasksRes = await req('GET', '/api/vehicle-documents/tasks?active_only=true', { cookie: tmCookie });
  assert.strictEqual(listTasksRes.status, 200);
  assert.ok(listTasksRes.body.some((t) => t.id === task.id));
});

// ---------------------------------------------------------------------------
// TEST 6: Excel Compliance Register Export Endpoint
// ---------------------------------------------------------------------------
test('GET /api/vehicle-documents/export.xlsx generates downloadable spreadsheet', async () => {
  const tmCookie = await login('transport_mgr');
  const r = await req('GET', '/api/vehicle-documents/export.xlsx', { cookie: tmCookie });

  assert.strictEqual(r.status, 200);
  assert.ok(
    r.headers['content-type'].includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    `Expected XLSX content type, got: ${r.headers['content-type']}`
  );
  assert.ok(
    r.headers['content-disposition'].includes('attachment; filename="fleet-vehicle-documents-'),
    `Expected attachment disposition, got: ${r.headers['content-disposition']}`
  );
  // Excel files (.xlsx) are zip archives starting with 'PK' (0x50, 0x4B)
  assert.ok(r.raw.length > 500, 'XLSX file size should be > 500 bytes');
  assert.strictEqual(r.raw[0], 0x50, 'XLSX file must begin with PK header byte 0');
  assert.strictEqual(r.raw[1], 0x4b, 'XLSX file must begin with PK header byte 1');
});

// ---------------------------------------------------------------------------
// TEST 7: Trigger Reminders & Promotion via REST API
// ---------------------------------------------------------------------------
test('POST /api/vehicle-documents/check-reminders triggers automated check and promotion', async () => {
  const tmCookie = await login('transport_mgr');
  const viewerCookie = await login('viewer_user');

  // 1. Viewer role lacks vehicle_docs.renew capability
  const forbidRes = await req('POST', '/api/vehicle-documents/check-reminders', {
    cookie: viewerCookie,
    body: { today: '2026-10-15' }
  });
  assert.strictEqual(forbidRes.status, 403, 'Refuses check-reminders without vehicle_docs.renew');

  // 2. Transport manager triggers check
  const r = await req('POST', '/api/vehicle-documents/check-reminders', {
    cookie: tmCookie,
    body: { today: '2026-10-15' }
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(typeof r.body.promoted_count, 'number');
  assert.strictEqual(typeof r.body.reminders_logged, 'number');
});

