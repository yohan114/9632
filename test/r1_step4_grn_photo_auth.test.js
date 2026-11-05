'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-grn-photo-auth-'));
const TEST_DB = path.join(TMP, 'test.db');
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const TEST_UPLOAD_DIR = path.join(TMP, 'uploads');
fs.mkdirSync(TEST_UPLOAD_DIR, { recursive: true });
process.env.UPLOAD_DIR = TEST_UPLOAD_DIR;

const { migrate, run } = require('../src/db');
const auth = require('../src/lib/auth');
const evidencePhotos = require('../src/lib/evidence_photos');
const config = require('../src/config');
config.uploadDir = TEST_UPLOAD_DIR;

migrate();

// Seed roles and admin user
for (const n of ['admin', 'storekeeper']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
const uid = run("INSERT INTO users (username, password_hash, active, workshop_id) VALUES ('sk_admin', ?, 1, 1)", auth.hashPassword('pw')).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'admin'))", uid);

const app = require('../src/server');
let server;
let base;
let cookie;

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;

  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'sk_admin', password: 'pw' }),
  });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
});

test.after(() => {
  if (server) server.close();
  try { fs.rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true }); } catch {}
});

test('DELETE /grn/:id/photos/:photoId refuses cross-GRN photo deletion', async () => {
  // Create an MRN and line to attach GRNs to
  const mrnId = run("INSERT INTO mrn (mrn_no, req_date, workshop_id, status, approval_status) VALUES ('MRN-TEST-100', '2026-11-05', 1, 'open', 'approved')").lastInsertRowid;
  const lineId = run("INSERT INTO mrn_lines (mrn_id, description, qty, unit) VALUES (?, 'Bearing 6204', 1, 'nos')", mrnId).lastInsertRowid;

  // Create two separate GRN records
  const grnId1 = run("INSERT INTO grn (grn_no, delivery_date, mrn_id, mrn_line_id, status) VALUES ('GRN-001', '2026-11-05', ?, ?, 'received')", mrnId, lineId).lastInsertRowid;
  const grnId2 = run("INSERT INTO grn (grn_no, delivery_date, mrn_id, mrn_line_id, status) VALUES ('GRN-002', '2026-11-05', ?, ?, 'received')", mrnId, lineId).lastInsertRowid;

  // Save photo on GRN 1
  const photo1 = evidencePhotos.savePhoto({
    entityType: 'grn',
    entityId: grnId1,
    dataUrl: TINY_PNG,
    filename: 'grn1_delivery.png',
    uploadedBy: uid
  });

  // Attempt to delete photo1 using GRN 2 URL
  const delRes = await fetch(`${base}/api/stores/grn/${grnId2}/photos/${photo1.id}`, {
    method: 'DELETE',
    headers: { cookie }
  });

  // Cross-GRN deletion must return 404 (or 403), never 200/204
  assert.strictEqual(delRes.status, 404, 'Cross-GRN photo deletion must be rejected with 404');

  // Verify photo1 was NOT deleted
  const photoStillExists = evidencePhotos.getPhoto(photo1.id);
  assert.ok(photoStillExists, 'Photo must still exist after rejected cross-GRN deletion attempt');

  // Verify deletion succeeds when calling with correct GRN 1 URL
  const validDelRes = await fetch(`${base}/api/stores/grn/${grnId1}/photos/${photo1.id}`, {
    method: 'DELETE',
    headers: { cookie }
  });
  assert.ok(validDelRes.status === 200 || validDelRes.status === 204, 'Correct GRN photo deletion should succeed');
});
