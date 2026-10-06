'use strict';

/**
 * ===========================================================================
 * Evidence Photos Storage Engine (Step 5)
 * 
 * Off-DB File Storage for Request Lines (MRN) and Receipt Lines (GRN):
 * 1. Physical image files are stored in the filesystem under `uploads/evidence/`.
 *    The SQLite database stores ONLY lightweight metadata (id, paths, sizes, captions).
 *    This ensures database backups via SQLite WAL/backup API stay lean and fast.
 * 2. Supported formats: JPEG, PNG, WebP.
 * 3. Enforces workshop scoping and access control on serving.
 * 4. Captures worn parts, nameplates, delivered goods condition, and transit damage.
 * ===========================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { get, all, run, tx } = require('../db');

const ALLOWED_MIME_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp']
]);

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB maximum upload
const VALID_ENTITY_TYPES = new Set(['mrn_line', 'grn']);
const VALID_KINDS = new Set(['worn_part', 'nameplate', 'delivery_goods', 'damage_in_transit', 'general']);

const DATA_URL_RE = /^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/i;

function getEvidenceDir(entityType, entityId) {
  const dir = path.resolve(config.uploadDir, 'evidence', String(entityType), String(entityId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Save an evidence photo to the filesystem and record metadata in line_evidence_photos.
 */
function savePhoto({
  entityType,
  entityId,
  buffer = null,
  dataUrl = null,
  filename = '',
  mimeType = '',
  kind = 'general',
  caption = '',
  userId = null
}) {
  const eType = String(entityType || '').trim().toLowerCase();
  const eId = Number(entityId);
  if (!VALID_ENTITY_TYPES.has(eType)) {
    const err = new Error(`Invalid entity type "${entityType}". Must be "mrn_line" or "grn".`);
    err.status = 400;
    throw err;
  }
  if (!eId || eId <= 0) {
    const err = new Error('Invalid entity ID');
    err.status = 400;
    throw err;
  }

  let fileBuffer = buffer;
  let resolvedMime = mimeType ? String(mimeType).toLowerCase() : '';

  if (dataUrl) {
    const match = String(dataUrl).match(DATA_URL_RE);
    if (!match) {
      const err = new Error('Invalid image format: must be PNG, JPEG or WebP data URL or binary buffer');
      err.status = 400;
      throw err;
    }
    resolvedMime = match[1].toLowerCase();
    fileBuffer = Buffer.from(match[2], 'base64');
  }

  if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
    const err = new Error('No image file payload provided');
    err.status = 400;
    throw err;
  }

  if (fileBuffer.length > MAX_FILE_BYTES) {
    const err = new Error(`Image is too large (${Math.round(fileBuffer.length / 1024)} KB). Maximum allowed is 10 MB.`);
    err.status = 413;
    throw err;
  }

  const ext = ALLOWED_MIME_TYPES.get(resolvedMime);
  if (!ext) {
    const err = new Error(`Unsupported image type "${resolvedMime}". Allowed formats: JPEG, PNG, WebP.`);
    err.status = 400;
    throw err;
  }

  // Verify entity exists
  if (eType === 'mrn_line') {
    const exists = get('SELECT id FROM mrn_lines WHERE id = ?', eId);
    if (!exists) {
      const err = new Error(`Request line #${eId} not found`);
      err.status = 404;
      throw err;
    }
  } else if (eType === 'grn') {
    const exists = get('SELECT id FROM grn WHERE id = ?', eId);
    if (!exists) {
      const err = new Error(`Receipt line (GRN) #${eId} not found`);
      err.status = 404;
      throw err;
    }
  }

  const cleanKind = VALID_KINDS.has(kind) ? kind : 'general';
  const targetDir = getEvidenceDir(eType, eId);
  const randomSuffix = crypto.randomBytes(8).toString('hex');
  const storedFilename = `${Date.now()}_${randomSuffix}.${ext}`;
  const absPath = path.join(targetDir, storedFilename);
  const relPath = path.join('evidence', eType, String(eId), storedFilename).replace(/\\/g, '/');

  // Write file to filesystem
  fs.writeFileSync(absPath, fileBuffer);

  const origName = String(filename || storedFilename).slice(0, 150);
  const cleanCaption = caption ? String(caption).slice(0, 500) : null;

  // Insert metadata into line_evidence_photos
  const info = run(`
    INSERT INTO line_evidence_photos (
      entity_type, entity_id, kind, file_path, file_name, mime_type, file_size, caption, uploaded_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, eType, eId, cleanKind, relPath, origName, resolvedMime, fileBuffer.length, cleanCaption, userId || null);

  const photoId = info.lastInsertRowid;
  return getPhoto(photoId);
}

/**
 * Retrieve photo metadata and absolute filesystem path by photo ID.
 */
function getPhoto(photoId) {
  const pid = Number(photoId);
  if (!pid) return null;

  const row = get(`
    SELECT p.*, u.username AS uploaded_by_name
      FROM line_evidence_photos p
      LEFT JOIN users u ON u.id = p.uploaded_by
     WHERE p.id = ?
  `, pid);

  if (!row) return null;

  const absPath = path.resolve(config.uploadDir, row.file_path);
  return {
    ...row,
    absPath,
    existsOnDisk: fs.existsSync(absPath),
    url: `/api/stores/evidence-photos/${row.id}/raw`
  };
}

/**
 * List all evidence photos attached to an entity.
 */
function listPhotos(entityType, entityId) {
  const eType = String(entityType || '').trim().toLowerCase();
  const eId = Number(entityId);
  if (!eId) return [];

  const rows = all(`
    SELECT p.id, p.entity_type, p.entity_id, p.kind, p.file_path, p.file_name,
           p.mime_type, p.file_size, p.caption, p.uploaded_by, p.uploaded_at,
           u.username AS uploaded_by_name
      FROM line_evidence_photos p
      LEFT JOIN users u ON u.id = p.uploaded_by
     WHERE p.entity_type = ? AND p.entity_id = ?
     ORDER BY p.id ASC
  `, eType, eId);

  return rows.map((r) => ({
    ...r,
    url: `/api/stores/evidence-photos/${r.id}/raw`
  }));
}

/**
 * Delete an evidence photo from the database and unlink it from disk.
 */
function deletePhoto(photoId, userId = null) {
  const photo = getPhoto(photoId);
  if (!photo) return false;

  tx(() => {
    run('DELETE FROM line_evidence_photos WHERE id = ?', photo.id);
    if (photo.absPath && fs.existsSync(photo.absPath)) {
      try {
        fs.unlinkSync(photo.absPath);
      } catch (err) {
        console.warn(`Failed to unlink evidence photo file at ${photo.absPath}:`, err.message);
      }
    }
  });

  return true;
}

/**
 * Batch lookup of photos for an array of entity IDs.
 * Returns a Map of entityId -> array of photo objects.
 */
function getBatchPhotos(entityType, entityIds) {
  const eType = String(entityType || '').trim().toLowerCase();
  const ids = Array.isArray(entityIds) ? entityIds.map(Number).filter((n) => n > 0) : [];
  const map = new Map();
  if (!ids.length) return map;

  const placeholders = ids.map(() => '?').join(',');
  const rows = all(`
    SELECT p.id, p.entity_type, p.entity_id, p.kind, p.file_path, p.file_name,
           p.mime_type, p.file_size, p.caption, p.uploaded_by, p.uploaded_at,
           u.username AS uploaded_by_name
      FROM line_evidence_photos p
      LEFT JOIN users u ON u.id = p.uploaded_by
     WHERE p.entity_type = ? AND p.entity_id IN (${placeholders})
     ORDER BY p.id ASC
  `, eType, ...ids);

  for (const r of rows) {
    const list = map.get(r.entity_id) || [];
    list.push({
      ...r,
      url: `/api/stores/evidence-photos/${r.id}/raw`
    });
    map.set(r.entity_id, list);
  }

  return map;
}

module.exports = {
  savePhoto,
  getPhoto,
  listPhotos,
  deletePhoto,
  getBatchPhotos,
  ALLOWED_MIME_TYPES,
  MAX_FILE_BYTES,
  VALID_KINDS
};
