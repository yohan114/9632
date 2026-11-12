'use strict';

/**
 * ===========================================================================
 * Evidence Photos & Commercial Document Storage Engine (Step 5 + GRN Docs)
 * 
 * Off-DB File Storage for Request Lines (MRN), Receipt Lines (GRN), Vouchers,
 * and Stock Receipts:
 * 1. Physical files (Images, PDFs, Office Documents) are stored in the
 *    filesystem under `uploads/evidence/`.
 *    The SQLite database stores ONLY lightweight metadata (id, paths, sizes, captions).
 *    This ensures database backups via SQLite WAL/backup API stay lean and fast.
 * 2. Supported formats: PDF, JPEG, PNG, WebP, GIF, Word, Excel, CSV, TXT.
 * 3. Enforces workshop scoping and access control on serving.
 * 4. Captures Supplier Tax Invoices, Delivery Notes/Challans, PO Copies,
 *    worn parts, nameplates, delivered goods condition, and transit damage.
 * ===========================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { get, all, run, tx } = require('../db');

const ALLOWED_MIME_TYPES = new Map([
  ['application/pdf', 'pdf'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['application/msword', 'doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['text/plain', 'txt'],
  ['text/csv', 'csv']
]);

const EXT_TO_MIME = new Map([
  ['.pdf', 'application/pdf'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.txt', 'text/plain'],
  ['.csv', 'text/csv']
]);

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB maximum upload
const VALID_ENTITY_TYPES = new Set([
  'mrn_line',
  'grn',
  'grn_voucher',
  'general_item_txn',
  'stock_ledger',
  'filter_stock_ledger'
]);
const VALID_KINDS = new Set([
  'invoice',
  'delivery_note',
  'po_copy',
  'supporting_doc',
  'worn_part',
  'nameplate',
  'delivery_goods',
  'damage_in_transit',
  'general'
]);

const DATA_URL_RE = /^data:([a-zA-Z0-9.+/-]*);base64,(.+)$/i;

function getEvidenceDir(entityType, entityId) {
  const dir = path.resolve(config.uploadDir, 'evidence', String(entityType), String(entityId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveMimeType(rawMime, filename) {
  let mime = String(rawMime || '').trim().toLowerCase();
  if (ALLOWED_MIME_TYPES.has(mime)) return mime;
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext && EXT_TO_MIME.has(ext)) return EXT_TO_MIME.get(ext);
  return mime;
}

function enrichAttachmentRow(r) {
  if (!r) return null;
  const mime = String(r.mime_type || '').toLowerCase();
  const isPdf = mime === 'application/pdf' || String(r.file_name || '').toLowerCase().endsWith('.pdf');
  const isImage = mime.startsWith('image/');
  return {
    ...r,
    is_pdf: isPdf,
    is_image: isImage,
    url: r.url || `/api/stores/evidence-photos/${r.id}/raw`
  };
}

/**
 * Save an evidence photo or commercial document (PDF/Image/Doc) to the filesystem
 * and record metadata in line_evidence_photos.
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
    const err = new Error(`Invalid entity type "${entityType}".`);
    err.status = 400;
    throw err;
  }
  if (!eId || eId <= 0) {
    const err = new Error('Invalid entity ID');
    err.status = 400;
    throw err;
  }

  let fileBuffer = buffer;
  let resolvedMime = resolveMimeType(mimeType, filename);

  if (dataUrl) {
    const match = String(dataUrl).match(DATA_URL_RE);
    if (!match) {
      const err = new Error('Invalid file format: must be a valid PDF, Image (JPEG/PNG/WebP), or Document data URL');
      err.status = 400;
      throw err;
    }
    resolvedMime = resolveMimeType(match[1], filename);
    fileBuffer = Buffer.from(match[2], 'base64');
  }

  if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
    const err = new Error('No file payload provided');
    err.status = 400;
    throw err;
  }

  if (fileBuffer.length > MAX_FILE_BYTES) {
    const err = new Error(`File is too large (${Math.round(fileBuffer.length / 1024)} KB). Maximum allowed is 15 MB.`);
    err.status = 413;
    throw err;
  }

  const ext = ALLOWED_MIME_TYPES.get(resolvedMime);
  if (!ext) {
    const err = new Error(`Unsupported file type "${resolvedMime || 'unknown'}". Allowed formats: PDF, JPEG, PNG, WebP, Word, Excel.`);
    err.status = 400;
    throw err;
  }

  // Verify entity exists
  if (eType === 'mrn_line') {
    const exists = get('SELECT id FROM mrn_lines WHERE id = ?', eId);
    if (!exists) { const err = new Error(`Request line #${eId} not found`); err.status = 404; throw err; }
  } else if (eType === 'grn') {
    const exists = get('SELECT id FROM grn WHERE id = ?', eId);
    if (!exists) { const err = new Error(`Receipt line (GRN) #${eId} not found`); err.status = 404; throw err; }
  } else if (eType === 'grn_voucher') {
    const exists = get('SELECT id FROM grn_vouchers WHERE id = ?', eId);
    if (!exists) { const err = new Error(`GRN Voucher #${eId} not found`); err.status = 404; throw err; }
  }

  const cleanKind = VALID_KINDS.has(kind) ? kind : (eType === 'grn' || eType === 'grn_voucher' ? 'invoice' : 'general');
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

  // If this is a GRN that belongs to a multi-line voucher, also link the same file_path to sibling GRN lines
  // so every line on the voucher reflects the attached invoice/document.
  if (eType === 'grn') {
    const grnRow = get('SELECT id, voucher_id, grn_no FROM grn WHERE id = ?', eId);
    if (grnRow && (grnRow.voucher_id || grnRow.grn_no)) {
      const siblings = all(
        `SELECT id FROM grn WHERE id != ? AND ((voucher_id IS NOT NULL AND voucher_id = ?) OR (grn_no IS NOT NULL AND grn_no != '' AND grn_no = ?))`,
        eId, grnRow.voucher_id || -1, grnRow.grn_no || ''
      );
      for (const sib of siblings) {
        const already = get('SELECT id FROM line_evidence_photos WHERE entity_type = ? AND entity_id = ? AND file_path = ?', 'grn', sib.id, relPath);
        if (!already) {
          run(`
            INSERT INTO line_evidence_photos (
              entity_type, entity_id, kind, file_path, file_name, mime_type, file_size, caption, uploaded_by
            ) VALUES ('grn', ?, ?, ?, ?, ?, ?, ?, ?)
          `, sib.id, cleanKind, relPath, origName, resolvedMime, fileBuffer.length, cleanCaption, userId || null);
        }
      }
    }
  }

  return getPhoto(photoId);
}

/**
 * Save an array of attachments across one or more GRN IDs (e.g. during voucher creation or bulk receive).
 * Writes each physical file once and links metadata to all target GRN IDs.
 */
function saveBatchGrnAttachments({ grnIds = [], attachments = [], defaultKind = 'invoice', userId = null }) {
  const cleanIds = Array.from(new Set((grnIds || []).map(Number).filter((n) => n > 0)));
  if (!cleanIds.length || !Array.isArray(attachments) || !attachments.length) return [];

  const saved = [];
  const primaryId = cleanIds[0];

  for (const att of attachments) {
    if (!att) continue;
    const dataUrl = att.dataUrl || att.photo || att.image || att.file;
    if (!dataUrl && !att.buffer) continue;

    // Save on primary GRN ID (which also auto-propagates to voucher siblings, and we explicitly link any remaining cleanIds)
    const firstPhoto = savePhoto({
      entityType: 'grn',
      entityId: primaryId,
      buffer: att.buffer || null,
      dataUrl: dataUrl || null,
      filename: att.filename || att.file_name || 'invoice_document',
      mimeType: att.mimeType || att.mime_type || '',
      kind: att.kind || defaultKind,
      caption: att.caption || att.note || '',
      userId
    });
    saved.push(firstPhoto);

    for (let i = 1; i < cleanIds.length; i++) {
      const targetId = cleanIds[i];
      const already = get(
        'SELECT id FROM line_evidence_photos WHERE entity_type = ? AND entity_id = ? AND file_path = ?',
        'grn', targetId, firstPhoto.file_path
      );
      if (!already) {
        run(`
          INSERT INTO line_evidence_photos (
            entity_type, entity_id, kind, file_path, file_name, mime_type, file_size, caption, uploaded_by
          ) VALUES ('grn', ?, ?, ?, ?, ?, ?, ?, ?)
        `, targetId, firstPhoto.kind, firstPhoto.file_path, firstPhoto.file_name, firstPhoto.mime_type, firstPhoto.file_size, firstPhoto.caption, userId || null);
      }
    }
  }

  return saved;
}

/**
 * Retrieve photo/document metadata and absolute filesystem path by ID.
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
  return enrichAttachmentRow({
    ...row,
    absPath,
    existsOnDisk: fs.existsSync(absPath),
    url: `/api/stores/evidence-photos/${row.id}/raw`
  });
}

/**
 * List all evidence photos & documents attached to an entity.
 * For 'grn', also surfaces any linked purchasing invoice photos from mrn_line_invoices.
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
  `, eType, eId).map(enrichAttachmentRow);

  if (eType === 'grn') {
    const grn = get('SELECT id, mrn_line_id, voucher_id, grn_no FROM grn WHERE id = ?', eId);
    if (grn && grn.mrn_line_id) {
      const mInvoices = all(`
        SELECT i.id, i.mrn_line_id, i.seq, i.image, i.note, i.uploaded_by, i.uploaded_at,
               u.username AS uploaded_by_name
          FROM mrn_line_invoices i
          LEFT JOIN users u ON u.id = i.uploaded_by
         WHERE i.mrn_line_id = ?
         ORDER BY i.seq, i.id
      `, grn.mrn_line_id);
      for (const inv of mInvoices) {
        rows.push({
          id: `mrn_inv_${inv.id}`,
          entity_type: 'mrn_line_invoice',
          entity_id: inv.mrn_line_id,
          kind: 'invoice',
          file_path: null,
          file_name: `Purchasing Invoice #${(inv.seq || 0) + 1}.jpg`,
          mime_type: 'image/jpeg',
          file_size: inv.image ? Math.round((inv.image.length * 3) / 4) : 0,
          caption: inv.note || 'Uploaded by Purchasing Officer',
          uploaded_by: inv.uploaded_by,
          uploaded_at: inv.uploaded_at,
          uploaded_by_name: inv.uploaded_by_name || 'Purchasing',
          is_pdf: false,
          is_image: true,
          is_purchasing_invoice: true,
          url: inv.image
        });
      }
    }
  }

  return rows;
}

/**
 * Delete an evidence photo/document from the database and unlink it from disk if unreferenced.
 */
function deletePhoto(photoId, userId = null) {
  const photo = getPhoto(photoId);
  if (!photo) return false;

  tx(() => {
    // Delete this row and any sibling rows on the same voucher sharing the exact file_path
    run('DELETE FROM line_evidence_photos WHERE id = ?', photo.id);
    const remaining = get('SELECT COUNT(*) AS c FROM line_evidence_photos WHERE file_path = ?', photo.file_path);
    if ((!remaining || remaining.c === 0) && photo.absPath && fs.existsSync(photo.absPath)) {
      try {
        fs.unlinkSync(photo.absPath);
      } catch (err) {
        console.warn(`Failed to unlink evidence file at ${photo.absPath}:`, err.message);
      }
    }
  });

  return true;
}

/**
 * Batch lookup of photos/documents for an array of entity IDs.
 * Returns a Map of entityId -> array of attachment objects.
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
    list.push(enrichAttachmentRow(r));
    map.set(r.entity_id, list);
  }

  return map;
}

module.exports = {
  savePhoto,
  saveBatchGrnAttachments,
  getPhoto,
  listPhotos,
  deletePhoto,
  getBatchPhotos,
  ALLOWED_MIME_TYPES,
  MAX_FILE_BYTES,
  VALID_KINDS,
  VALID_ENTITY_TYPES
};
