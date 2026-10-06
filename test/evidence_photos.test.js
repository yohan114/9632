'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), `workshopone-evidence-photos-${Date.now()}.db`);
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

// Configure test upload directory
const TEST_UPLOAD_DIR = path.join(os.tmpdir(), `workshopone-uploads-${Date.now()}`);
fs.mkdirSync(TEST_UPLOAD_DIR, { recursive: true });
process.env.UPLOAD_DIR = TEST_UPLOAD_DIR;

const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');
const evidencePhotos = require('../src/lib/evidence_photos');
const config = require('../src/config');
config.uploadDir = TEST_UPLOAD_DIR;

migrate();

// Seed roles and test users
for (const n of ['admin', 'storekeeper', 'workshop']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}

const uid = run('INSERT INTO users (username, password_hash, active, workshop_id) VALUES (?, ?, 1, 1)', 'sk_photo', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ['admin', 'storekeeper', 'workshop']) {
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
}

// Seed workshops
run("INSERT OR IGNORE INTO workshops (id, code, name, active) VALUES (1, 'CW', 'Central Workshop', 1)");
run("INSERT OR IGNORE INTO workshops (id, code, name, active) VALUES (2, 'WS2', 'Workshop 2', 1)");
run("INSERT INTO settings (key, value) VALUES ('workshops_separate', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");

// User in workshop 2 (mechanic/engineer in workshop 2)
const uid2 = run('INSERT INTO users (username, password_hash, active, workshop_id) VALUES (?, ?, 1, 2)', 'sk_ws2', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ['workshop']) {
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid2, r);
}

const app = require('../src/server');
let server;
let base;
let cookie1;
let cookie2;

// 1x1 transparent PNG data URL for testing
const TINY_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;

  const r1 = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'sk_photo', password: 'pw' }),
  });
  cookie1 = (r1.headers.get('set-cookie') || '').split(';')[0];

  const r2 = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'sk_ws2', password: 'pw' }),
  });
  cookie2 = (r2.headers.get('set-cookie') || '').split(';')[0];
});

test.after(() => {
  if (server) server.close();
  try { fs.rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true }); } catch {}
});

const api = async (p, opts = {}) => {
  const r = await fetch(base + '/api' + p, {
    method: opts.method || 'GET',
    headers: {
      'content-type': 'application/json',
      cookie: opts.cookie !== undefined ? opts.cookie : cookie1
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, text, headers: r.headers };
};

// -----------------------------------------------------------------------------
// Unit Tests: src/lib/evidence_photos.js
// -----------------------------------------------------------------------------

test('evidencePhotos rejects invalid entity types and invalid MIME formats', () => {
  assert.throws(() => {
    evidencePhotos.savePhoto({ entityType: 'invalid_type', entityId: 1, dataUrl: TINY_PNG_DATA_URL });
  }, /Invalid entity type/);

  assert.throws(() => {
    evidencePhotos.savePhoto({ entityType: 'mrn_line', entityId: 1, dataUrl: 'data:text/plain;base64,aGVsbG8=' });
  }, /Invalid image format/);
});

test('evidencePhotos rejects non-existent MRN lines', () => {
  assert.throws(() => {
    evidencePhotos.savePhoto({ entityType: 'mrn_line', entityId: 999999, dataUrl: TINY_PNG_DATA_URL });
  }, /Request line #999999 not found/);
});

test('evidencePhotos saves off-DB file to filesystem and stores metadata in DB', () => {
  // Create an MRN and MRN line in workshop 1
  const mrnId = run("INSERT INTO mrn (mrn_no, req_date, workshop_id, status, approval_status) VALUES ('MRN-PHOTO-01', '2026-10-06', 1, 'open', 'approved')").lastInsertRowid;
  const lineId = run("INSERT INTO mrn_lines (mrn_id, description, qty, unit) VALUES (?, 'Excavator Pin 80mm', 2, 'nos')", mrnId).lastInsertRowid;

  const photo = evidencePhotos.savePhoto({
    entityType: 'mrn_line',
    entityId: lineId,
    dataUrl: TINY_PNG_DATA_URL,
    filename: 'worn_pin.png',
    kind: 'worn_part',
    caption: 'Severely scored pin surface',
    userId: uid
  });

  assert.ok(photo.id > 0);
  assert.strictEqual(photo.entity_type, 'mrn_line');
  assert.strictEqual(photo.entity_id, lineId);
  assert.strictEqual(photo.kind, 'worn_part');
  assert.strictEqual(photo.caption, 'Severely scored pin surface');
  assert.strictEqual(photo.mime_type, 'image/png');
  assert.ok(photo.file_size > 0);
  assert.ok(photo.existsOnDisk);
  assert.ok(fs.existsSync(photo.absPath));

  // Verify DB table contains only metadata, no binary base64
  const dbRow = get('SELECT * FROM line_evidence_photos WHERE id = ?', photo.id);
  assert.ok(dbRow);
  assert.strictEqual(dbRow.file_path, photo.file_path);
  assert.ok(!dbRow.photo_blob && !dbRow.data_url);

  // List photos
  const list = evidencePhotos.listPhotos('mrn_line', lineId);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, photo.id);

  // Batch lookup
  const batch = evidencePhotos.getBatchPhotos('mrn_line', [lineId]);
  assert.ok(batch.has(lineId));
  assert.strictEqual(batch.get(lineId).length, 1);

  // Delete photo
  const deleted = evidencePhotos.deletePhoto(photo.id, uid);
  assert.strictEqual(deleted, true);
  assert.strictEqual(fs.existsSync(photo.absPath), false);
  assert.strictEqual(get('SELECT id FROM line_evidence_photos WHERE id = ?', photo.id), undefined);
});

// -----------------------------------------------------------------------------
// Route Integration Tests: MRN line, GRN receipt, and Raw streaming
// -----------------------------------------------------------------------------

test('MRN line photo API lifecycle (upload, list, raw stream, delete)', async () => {
  const mrnId = run("INSERT INTO mrn (mrn_no, req_date, workshop_id, status, approval_status) VALUES ('MRN-PHOTO-02', '2026-10-06', 1, 'open', 'approved')").lastInsertRowid;
  const lineId = run("INSERT INTO mrn_lines (mrn_id, description, qty, unit) VALUES (?, 'Hydraulic Seal Kit', 1, 'set')", mrnId).lastInsertRowid;

  // 1. Upload photo via POST /api/stores/mrn-lines/:id/photos
  const uploadRes = await api(`/stores/mrn-lines/${lineId}/photos`, {
    method: 'POST',
    body: {
      dataUrl: TINY_PNG_DATA_URL,
      filename: 'broken_seal.png',
      kind: 'worn_part',
      caption: 'Torn inner O-ring'
    }
  });
  assert.strictEqual(uploadRes.status, 201);
  assert.ok(uploadRes.body.id);
  const photoId = uploadRes.body.id;

  // 2. Query list via GET /api/stores/mrn-lines/:id/photos
  const listRes = await api(`/stores/mrn-lines/${lineId}/photos`);
  assert.strictEqual(listRes.status, 200);
  assert.strictEqual(listRes.body.length, 1);
  assert.strictEqual(listRes.body[0].caption, 'Torn inner O-ring');

  // 3. Raw photo streaming via GET /api/stores/evidence-photos/:photoId/raw
  const rawRes = await api(`/stores/evidence-photos/${photoId}/raw`);
  assert.strictEqual(rawRes.status, 200);
  assert.strictEqual(rawRes.headers.get('content-type'), 'image/png');
  assert.strictEqual(rawRes.headers.get('cache-control'), 'private, max-age=86400');
  assert.ok(Number(rawRes.headers.get('content-length')) > 0);

  // 4. GET /api/stores/mrn/:id attaches photos to line items
  const mrnRes = await api(`/stores/mrn/${mrnId}`);
  assert.strictEqual(mrnRes.status, 200);
  const lineWithPhoto = mrnRes.body.lines.find((l) => l.id === lineId);
  assert.ok(lineWithPhoto);
  assert.strictEqual(lineWithPhoto.photos.length, 1);
  assert.strictEqual(lineWithPhoto.photos[0].id, photoId);

  // 5. Delete photo via DELETE /api/stores/mrn-lines/:id/photos/:photoId
  const delRes = await api(`/stores/mrn-lines/${lineId}/photos/${photoId}`, { method: 'DELETE' });
  assert.strictEqual(delRes.status, 200);
  assert.strictEqual(delRes.body.ok, true);

  // Check it is gone
  const afterList = await api(`/stores/mrn-lines/${lineId}/photos`);
  assert.strictEqual(afterList.body.length, 0);
});

test('GRN receipt photo API lifecycle and side-by-side trace pipeline', async () => {
  const chainNo = 'CHN-2026-99991';
  const mrnId = run("INSERT INTO mrn (mrn_no, chain_no, req_date, workshop_id, status, approval_status) VALUES ('MRN-PHOTO-03', ?, '2026-10-06', 1, 'open', 'approved')", chainNo).lastInsertRowid;
  const lineId = run("INSERT INTO mrn_lines (mrn_id, description, qty, qty_received, unit) VALUES (?, 'Track Roller Assembly', 2, 2, 'nos')", mrnId).lastInsertRowid;
  const grnId = run("INSERT INTO grn (grn_no, chain_no, delivery_date, mrn_id, mrn_line_id, description, qty, unit_price, store_id) VALUES ('GRN-PHOTO-03', ?, '2026-10-06', ?, ?, 'Track Roller Assembly', 2, 45000, 1)", chainNo, mrnId, lineId).lastInsertRowid;

  // 1. Attach Request photo to MRN line
  const reqPhotoRes = await api(`/stores/mrn-lines/${lineId}/photos`, {
    method: 'POST',
    body: {
      dataUrl: TINY_PNG_DATA_URL,
      filename: 'old_roller.png',
      kind: 'worn_part',
      caption: 'Worn flange on existing roller'
    }
  });
  assert.strictEqual(reqPhotoRes.status, 201);

  // 2. Attach Receipt photo to GRN
  const recPhotoRes = await api(`/stores/grn/${grnId}/photos`, {
    method: 'POST',
    body: {
      dataUrl: TINY_PNG_DATA_URL,
      filename: 'new_roller_delivery.png',
      kind: 'delivery_goods',
      caption: 'Delivered Berco roller in crate'
    }
  });
  assert.strictEqual(recPhotoRes.status, 201);
  const recPhotoId = recPhotoRes.body.id;

  // 3. GET /api/stores/grn/:id includes photos
  const grnGetRes = await api(`/stores/grn/${grnId}`);
  assert.strictEqual(grnGetRes.status, 200);
  assert.strictEqual(grnGetRes.body.photos.length, 1);
  assert.strictEqual(grnGetRes.body.photos[0].id, recPhotoId);

  // 4. Universal Trace Screen GET /api/stores/pipeline/trace returns both request_photos and receipt_photos
  const traceRes = await api(`/stores/pipeline/trace?chain_no=${chainNo}`);
  assert.strictEqual(traceRes.status, 200);
  assert.strictEqual(traceRes.body.items.length, 1);

  const traceItem = traceRes.body.items[0];
  assert.strictEqual(traceItem.description, 'Track Roller Assembly');
  assert.strictEqual(traceItem.request_photos.length, 1);
  assert.strictEqual(traceItem.request_photos[0].caption, 'Worn flange on existing roller');
  assert.strictEqual(traceItem.receipt_photos.length, 1);
  assert.strictEqual(traceItem.receipt_photos[0].caption, 'Delivered Berco roller in crate');
});

test('Evidence photo workshop isolation refuses unauthorized cross-workshop viewing', async () => {
  // MRN line created in workshop 1
  const mrnId = run("INSERT INTO mrn (mrn_no, req_date, workshop_id, status, approval_status) VALUES ('MRN-ISOLATED', '2026-10-06', 1, 'open', 'approved')").lastInsertRowid;
  const lineId = run("INSERT INTO mrn_lines (mrn_id, description, qty, unit) VALUES (?, 'Confidential Part', 1, 'nos')", mrnId).lastInsertRowid;

  const photo = evidencePhotos.savePhoto({
    entityType: 'mrn_line',
    entityId: lineId,
    dataUrl: TINY_PNG_DATA_URL,
    filename: 'ws1_only.png',
    kind: 'general',
    userId: uid
  });

  // sk_photo (workshop 1) can access raw photo
  const okRes = await api(`/stores/evidence-photos/${photo.id}/raw`, { cookie: cookie1 });
  assert.strictEqual(okRes.status, 200);

  // sk_ws2 (workshop 2) is refused with 403 when trying to access raw photo
  const refRes = await api(`/stores/evidence-photos/${photo.id}/raw`, { cookie: cookie2 });
  assert.strictEqual(refRes.status, 403);
});
