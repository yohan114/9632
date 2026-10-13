'use strict';

/**
 * ===========================================================================
 * Vehicle Documents & Statutory Renewal Monitoring Engine (Phase 2)
 *
 * Sri Lankan Statutory Regulations:
 * - Certificate of Registration (CR): Master vehicle identity document.
 * - Revenue Licence (RL): Annual statutory licence issued by Provincial DMT.
 * - Vehicle Insurance: Statutory third-party or comprehensive policy.
 * - Vehicle Emission Test: Annual statutory green test certificate.
 * - Fitness Certificate: Annual statutory test for heavy/commercial vehicles.
 * - Passenger / Service Permit: Statutory permit for commercial transit.
 *
 * Compliance Rules:
 * 1. Countdowns and timestamps strictly in Asia/Colombo (UTC+5:30).
 * 2. 1-calendar-month renewal rule (e.g., Nov 8 expiry -> Oct 8 first alert).
 * 3. Immutable document history: certificates and files are never overwritten.
 * 4. eRL renewal readiness checklist evaluator.
 * 5. Future-dated renewals stay active/verified ahead without interrupting current coverage.
 * 6. Formal exemption handling for laid-up or off-road fleet units.
 * ===========================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const multidb = require('../db/multidb');
const audit = require('./audit');
const emitter = require('./emitter');

// Supported MIME types and max upload size (15 MB)
const ALLOWED_MIME_TYPES = new Map([
  ['application/pdf', 'pdf'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp']
]);
const MAX_FILE_BYTES = 15 * 1024 * 1024;

// Heavy commercial vehicle categories and types requiring statutory fitness certificate
const COMMERCIAL_FITNESS_TYPES = new Set([
  'lorry', 'truck', 'mixer', 'truck mixer', 'self loader mixer', 'bowser',
  'bitumen bowser', 'tipper', 'bus', 'prime mover', 'trailer', 'bed',
  'crane', 'mobile crane', 'pump truck', 'boom truck', 'heavy_commercial', 'commercial'
]);

/**
 * Returns the active core database instance.
 */
function getDb() {
  return multidb.getCoreDb();
}

// ---------------------------------------------------------------------------
// 1. Date & Time Helpers (Asia/Colombo UTC+5:30)
// ---------------------------------------------------------------------------

/**
 * Returns today's date formatted as YYYY-MM-DD in Asia/Colombo.
 */
function getColomboToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Colombo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

/**
 * Returns current timestamp formatted as YYYY-MM-DD HH:mm:ss in Asia/Colombo.
 */
function getColomboNow() {
  const d = new Date();
  const dateStr = getColomboToday();
  const timeStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Colombo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(d);
  return `${dateStr} ${timeStr}`;
}

/**
 * Calculates calendar day difference: (validUntil - fromDate).
 */
function calculateDaysRemaining(validUntil, fromDate = getColomboToday()) {
  if (!validUntil || !fromDate) return null;
  const d1 = new Date(fromDate + 'T00:00:00Z');
  const d2 = new Date(validUntil + 'T00:00:00Z');
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return null;
  const diffTime = d2.getTime() - d1.getTime();
  return Math.round(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Exact 1-calendar-month rule:
 * Calculates the date exactly 1 calendar month before dateStr.
 * Example: 2026-11-08 -> 2026-10-08; 2026-03-31 -> 2026-02-28.
 */
function calculateOneMonthBefore(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  let prevMonth = m - 1;
  let prevYear = y;
  if (prevMonth === 0) {
    prevMonth = 12;
    prevYear -= 1;
  }
  const maxDays = new Date(prevYear, prevMonth, 0).getDate();
  const prevDay = Math.min(d, maxDays);
  return `${prevYear}-${String(prevMonth).padStart(2, '0')}-${String(prevDay).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// 2. Status & Badge Evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluates document validity, countdown and badge styling.
 */
function evaluateDocStatus(doc, currentVersion, options = {}) {
  const today = options.today || getColomboToday();

  // 1. Exemption check
  if (doc && doc.is_exempt) {
    return {
      status: 'exempt',
      days_remaining: null,
      is_expired: false,
      is_exempt: true,
      badge: { text: 'Exempt', color: 'gray', level: 'exempt' },
      needs_action: false
    };
  }

  // 2. Missing current verified version
  if (!currentVersion || currentVersion.status !== 'verified') {
    return {
      status: 'missing',
      days_remaining: null,
      is_expired: true,
      is_exempt: false,
      badge: { text: 'Missing', color: 'red', level: 'danger' },
      needs_action: true
    };
  }

  // 3. Lifetime / Permanent Master document (e.g. CR with no expiry)
  if (currentVersion.valid_until === '9999-12-31' || !currentVersion.valid_until) {
    return {
      status: 'valid',
      days_remaining: null,
      is_expired: false,
      is_exempt: false,
      badge: { text: 'Active (Master)', color: 'green', level: 'ok' },
      needs_action: false
    };
  }

  // 4. Date countdown calculation
  const validUntil = currentVersion.valid_until;
  const days = calculateDaysRemaining(validUntil, today);

  if (days < 0) {
    const overdueDays = Math.abs(days);
    return {
      status: 'expired',
      days_remaining: days,
      overdue_days: overdueDays,
      is_expired: true,
      is_exempt: false,
      badge: { text: `Expired (${overdueDays}d ago)`, color: 'red', level: 'danger' },
      needs_action: true
    };
  }

  if (days === 0) {
    return {
      status: 'expires_today',
      days_remaining: 0,
      is_expired: false,
      is_exempt: false,
      badge: { text: 'Expires Today', color: 'red', level: 'danger' },
      needs_action: true
    };
  }

  if (days <= 7) {
    return {
      status: 'critical',
      days_remaining: days,
      is_expired: false,
      is_exempt: false,
      badge: { text: `${days}d Left`, color: 'red', level: 'critical' },
      needs_action: true
    };
  }

  if (days <= 14) {
    return {
      status: 'expiring_soon',
      days_remaining: days,
      is_expired: false,
      is_exempt: false,
      badge: { text: `${days}d Left`, color: 'amber', level: 'warning' },
      needs_action: true
    };
  }

  if (days <= 30) {
    return {
      status: 'due_for_renewal',
      days_remaining: days,
      is_expired: false,
      is_exempt: false,
      badge: { text: `${days}d Left`, color: 'blue', level: 'info' },
      needs_action: true
    };
  }

  return {
    status: 'valid',
    days_remaining: days,
    is_expired: false,
    is_exempt: false,
    badge: { text: 'Valid', color: 'green', level: 'ok' },
    needs_action: false
  };
}

/**
 * Checks whether an asset requires a commercial vehicle fitness certificate.
 */
function isFitnessRequiredForAsset(asset) {
  if (!asset) return false;
  const t = String(asset.type || '').trim().toLowerCase();
  const c = String(asset.asset_class || '').trim().toLowerCase();
  if (c === 'heavy_commercial') return true;
  for (const k of COMMERCIAL_FITNESS_TYPES) {
    if (t.includes(k)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 3. eRL (Electronic Revenue Licence) Prerequisite Checklist Evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluates whether a vehicle has satisfied all prerequisite statutory requirements
 * to apply for the annual Sri Lankan Revenue Licence (via DMT / eRL portal).
 */
function evaluateErlChecklist(assetId, options = {}) {
  const targetDate = options.targetDate || getColomboToday();
  const db = getDb();

  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
  if (!asset) {
    const err = new Error(`Asset #${assetId} not found`);
    err.status = 404;
    throw err;
  }

  // Ensure document container rows exist
  ensureVehicleDocuments(assetId);

  // Fetch current documents and active versions
  const docs = getVehicleDocuments(assetId, { today: targetDate });
  const byCode = new Map(docs.map((d) => [d.doc_type_code, d]));

  const items = [];

  // Item 1: Certificate of Registration (CR)
  const crDoc = byCode.get('cr');
  const hasCr = Boolean(crDoc && crDoc.current_version && crDoc.current_version.status === 'verified');
  items.push({
    key: 'cr',
    label: 'Certificate of Registration (CR)',
    required: true,
    passed: hasCr,
    details: hasCr
      ? `CR No: ${crDoc.current_version.doc_number} on file`
      : 'CR document missing or not verified'
  });

  // Item 2: Previous Revenue Licence on record
  const rlDoc = byCode.get('revenue_licence');
  const hasPrevRl = Boolean(rlDoc && rlDoc.current_version);
  items.push({
    key: 'previous_rl',
    label: 'Previous Revenue Licence',
    required: true,
    passed: hasPrevRl,
    details: hasPrevRl
      ? `Previous Licence No: ${rlDoc.current_version.doc_number} (Exp: ${rlDoc.current_version.valid_until})`
      : 'No previous revenue licence on record (first registration requires DMT assessment)'
  });

  // Item 3: Active Vehicle Insurance
  const insDoc = byCode.get('insurance');
  const hasActiveIns = Boolean(
    insDoc &&
    insDoc.current_version &&
    insDoc.current_version.status === 'verified' &&
    insDoc.current_version.valid_until >= targetDate
  );
  items.push({
    key: 'insurance',
    label: 'Active Insurance Coverage',
    required: true,
    passed: hasActiveIns,
    details: hasActiveIns
      ? `Policy No: ${insDoc.current_version.doc_number} (Valid until ${insDoc.current_version.valid_until})`
      : (insDoc && insDoc.current_version
          ? `Policy expired on ${insDoc.current_version.valid_until} — renewal requires valid cover`
          : 'Insurance policy record missing')
  });

  // Item 4: Vehicle Emission Test Certificate
  const emDoc = byCode.get('emission');
  const hasValidEmission = Boolean(
    emDoc &&
    emDoc.current_version &&
    emDoc.current_version.status === 'verified' &&
    emDoc.current_version.valid_until >= targetDate
  );
  items.push({
    key: 'emission',
    label: 'Valid Vehicle Emission Certificate',
    required: true,
    passed: hasValidEmission,
    details: hasValidEmission
      ? `Test Certificate No: ${emDoc.current_version.doc_number} (Valid until ${emDoc.current_version.valid_until})`
      : (emDoc && emDoc.current_version
          ? `Emission test expired on ${emDoc.current_version.valid_until} — must pass test first`
          : 'Emission certificate missing')
  });

  // Item 5: Commercial Vehicle Fitness Certificate
  const fitDoc = byCode.get('fitness');
  const fitnessRequired = isFitnessRequiredForAsset(asset);
  if (!fitnessRequired) {
    items.push({
      key: 'fitness',
      label: 'Vehicle Fitness Certificate',
      required: false,
      passed: true,
      details: 'Not required for this vehicle category (light / non-commercial)'
    });
  } else {
    const hasValidFitness = Boolean(
      fitDoc &&
      fitDoc.current_version &&
      fitDoc.current_version.status === 'verified' &&
      fitDoc.current_version.valid_until >= targetDate
    );
    items.push({
      key: 'fitness',
      label: 'Vehicle Fitness Certificate (Commercial/Heavy)',
      required: true,
      passed: hasValidFitness,
      details: hasValidFitness
        ? `Fitness Certificate No: ${fitDoc.current_version.doc_number} (Valid until ${fitDoc.current_version.valid_until})`
        : (fitDoc && fitDoc.current_version
            ? `Fitness certificate expired on ${fitDoc.current_version.valid_until}`
            : 'Fitness inspection certificate missing for commercial vehicle')
    });
  }

  const mandatoryItems = items.filter((i) => i.required);
  const ready = mandatoryItems.every((i) => i.passed);
  const blockers = items.filter((i) => i.required && !i.passed).map((i) => i.label);

  return {
    asset_id: asset.id,
    registration: asset.registration,
    asset_code: asset.code,
    ready_for_renewal: ready,
    items,
    blockers,
    evaluated_at: getColomboNow()
  };
}

// ---------------------------------------------------------------------------
// 4. Document Types Catalog
// ---------------------------------------------------------------------------

function listDocTypes() {
  const db = getDb();
  return db.prepare('SELECT * FROM vehicle_doc_types WHERE active = 1 ORDER BY sort_order, id').all();
}

function getDocTypeByCode(code) {
  const db = getDb();
  return db.prepare('SELECT * FROM vehicle_doc_types WHERE code = ?').get(code);
}

// ---------------------------------------------------------------------------
// 5. Vehicle Document Containers & History
// ---------------------------------------------------------------------------

/**
 * Ensures container rows exist in vehicle_documents for all statutory document types.
 */
function ensureVehicleDocuments(assetId) {
  const db = getDb();
  const types = listDocTypes();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO vehicle_documents (asset_id, doc_type_id, is_required)
    VALUES (?, ?, 1)
  `);

  db.transaction(() => {
    for (const t of types) {
      insert.run(assetId, t.id);
    }
  })();
}

/**
 * Returns all document records for a given vehicle/asset, enriched with active version,
 * calculated countdown, badges, renewal tasks, and attachments.
 */
function getVehicleDocuments(assetId, options = {}) {
  const db = getDb();
  const today = options.today || getColomboToday();

  ensureVehicleDocuments(assetId);

  const rows = db.prepare(`
    SELECT vd.*,
           vdt.code AS doc_type_code,
           vdt.name AS doc_type_name,
           vdt.category AS doc_type_category,
           vdt.is_renewable,
           vdt.is_master,
           vdt.default_remind_days,
           vdt.requires_fitness
      FROM vehicle_documents vd
      JOIN vehicle_doc_types vdt ON vdt.id = vd.doc_type_id
     WHERE vd.asset_id = ?
     ORDER BY vdt.sort_order, vdt.id
  `).all(assetId);

  const getVerStmt = db.prepare('SELECT * FROM vehicle_doc_versions WHERE id = ?');
  const getFutureVerStmt = db.prepare(`
    SELECT * FROM vehicle_doc_versions
     WHERE document_id = ? AND status = 'verified' AND valid_from > ?
     ORDER BY valid_from ASC LIMIT 1
  `);
  const getAttachmentsStmt = db.prepare('SELECT * FROM vehicle_doc_attachments WHERE version_id = ?');
  const getTaskStmt = db.prepare(`
    SELECT * FROM vehicle_renewal_tasks
     WHERE document_id = ? AND stage != 'completed'
     ORDER BY id DESC LIMIT 1
  `);

  return rows.map((doc) => {
    const curVer = doc.current_version_id ? getVerStmt.get(doc.current_version_id) : null;
    const futureVer = getFutureVerStmt.get(doc.id, today);
    const evaluation = evaluateDocStatus(doc, curVer, { today });

    let attachments = [];
    if (curVer) {
      attachments = getAttachmentsStmt.all(curVer.id);
    }

    const activeTask = getTaskStmt.get(doc.id);

    return {
      ...doc,
      current_version: curVer,
      future_version: futureVer,
      evaluation,
      active_renewal_task: activeTask,
      attachments
    };
  });
}

/**
 * Gets a single document container record by its ID.
 */
function getDocumentById(documentId) {
  const db = getDb();
  return db.prepare(`
    SELECT vd.*,
           vdt.code AS doc_type_code,
           vdt.name AS doc_type_name,
           vdt.category AS doc_type_category,
           vdt.is_renewable,
           vdt.is_master,
           a.registration,
           a.code AS asset_code
      FROM vehicle_documents vd
      JOIN vehicle_doc_types vdt ON vdt.id = vd.doc_type_id
      JOIN assets a ON a.id = vd.asset_id
     WHERE vd.id = ?
  `).get(documentId);
}

/**
 * Returns the immutable historical record of all issued versions for a document.
 */
function getDocumentHistory(documentId) {
  const db = getDb();
  const versions = db.prepare(`
    SELECT v.*,
           u1.username AS created_by_name,
           u2.username AS verified_by_name
      FROM vehicle_doc_versions v
      LEFT JOIN users u1 ON u1.id = v.created_by
      LEFT JOIN users u2 ON u2.id = v.verified_by
     WHERE v.document_id = ?
     ORDER BY v.version_no DESC
  `).all(documentId);

  const getAttStmt = db.prepare('SELECT * FROM vehicle_doc_attachments WHERE version_id = ? ORDER BY id ASC');

  return versions.map((v) => ({
    ...v,
    attachments: getAttStmt.all(v.id)
  }));
}

// ---------------------------------------------------------------------------
// 6. Version Management & Renewal Verification (Immutability Engine)
// ---------------------------------------------------------------------------

/**
 * Creates a new draft or renewal version for a vehicle document.
 */
function createDraftVersion(documentId, data, user) {
  const db = getDb();
  const doc = getDocumentById(documentId);
  if (!doc) {
    const err = new Error('Vehicle document container not found');
    err.status = 404;
    throw err;
  }

  const docNumber = String(data.doc_number || '').trim();
  if (!docNumber) {
    const err = new Error('Document / certificate number is required');
    err.status = 400;
    throw err;
  }

  const issueDate = String(data.issue_date || '').trim() || getColomboToday();
  const validFrom = String(data.valid_from || '').trim() || issueDate;
  const validUntil = String(data.valid_until || '').trim();

  if (doc.is_renewable && !validUntil) {
    const err = new Error('Statutory expiration date (valid_until) is required for renewable documents');
    err.status = 400;
    throw err;
  }

  // Calculate incremented version_no
  const lastVer = db.prepare('SELECT MAX(version_no) AS max_v FROM vehicle_doc_versions WHERE document_id = ?').get(documentId);
  const versionNo = (lastVer && lastVer.max_v ? lastVer.max_v : 0) + 1;

  const status = data.status === 'draft' ? 'draft' : 'pending_verification';

  const info = db.prepare(`
    INSERT INTO vehicle_doc_versions (
      document_id, version_no, doc_number, issuer_name, issue_date,
      valid_from, valid_until, valid_until_time, cost_amount,
      policy_type, responsible_user_id, notes, status,
      created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    documentId,
    versionNo,
    docNumber,
    data.issuer_name || null,
    issueDate,
    validFrom,
    validUntil || '9999-12-31',
    data.valid_until_time || null,
    Number(data.cost_amount || 0),
    data.policy_type || null,
    data.responsible_user_id || (user ? user.id : null),
    data.notes || null,
    status,
    user ? user.id : null,
    getColomboNow()
  );

  const newVersionId = info.lastInsertRowid;

  // If a renewal task is provided or active, link target_version_id
  if (data.task_id) {
    db.prepare('UPDATE vehicle_renewal_tasks SET target_version_id = ?, stage = \'pending_verification\', updated_at = ? WHERE id = ?')
      .run(newVersionId, getColomboNow(), data.task_id);
  }

  audit.record({
    userId: user ? user.id : null,
    entity: 'vehicle_document',
    entityId: documentId,
    action: 'create_version',
    after: { versionId: newVersionId, versionNo, docNumber, status }
  });

  return db.prepare('SELECT * FROM vehicle_doc_versions WHERE id = ?').get(newVersionId);
}

/**
 * Updates an unverified (draft or pending_verification) version.
 */
function updateDraftVersion(versionId, data, user) {
  const db = getDb();
  const ver = db.prepare('SELECT * FROM vehicle_doc_versions WHERE id = ?').get(versionId);
  if (!ver) {
    const err = new Error('Document version not found');
    err.status = 404;
    throw err;
  }
  if (ver.status !== 'draft' && ver.status !== 'pending_verification') {
    const err = new Error('Only draft or pending versions can be updated. Verified records are immutable.');
    err.status = 403;
    throw err;
  }

  db.prepare(`
    UPDATE vehicle_doc_versions
       SET doc_number = COALESCE(?, doc_number),
           issuer_name = COALESCE(?, issuer_name),
           issue_date = COALESCE(?, issue_date),
           valid_from = COALESCE(?, valid_from),
           valid_until = COALESCE(?, valid_until),
           cost_amount = COALESCE(?, cost_amount),
           policy_type = COALESCE(?, policy_type),
           notes = COALESCE(?, notes),
           status = COALESCE(?, status)
     WHERE id = ?
  `).run(
    data.doc_number ? String(data.doc_number).trim() : null,
    data.issuer_name || null,
    data.issue_date || null,
    data.valid_from || null,
    data.valid_until || null,
    data.cost_amount != null ? Number(data.cost_amount) : null,
    data.policy_type || null,
    data.notes || null,
    data.status || null,
    versionId
  );

  return db.prepare('SELECT * FROM vehicle_doc_versions WHERE id = ?').get(versionId);
}

/**
 * Manager verification & version promotion:
 * Approves and promotes renewed version to active coverage.
 */
function verifyVersion(versionId, { decision, notes = '' }, user) {
  const db = getDb();
  const ver = db.prepare('SELECT * FROM vehicle_doc_versions WHERE id = ?').get(versionId);
  if (!ver) {
    const err = new Error('Document version not found');
    err.status = 404;
    throw err;
  }
  if (ver.status !== 'pending_verification' && ver.status !== 'draft') {
    const err = new Error(`Cannot verify document version in '${ver.status}' status`);
    err.status = 400;
    throw err;
  }

  const today = getColomboToday();
  const now = getColomboNow();

  if (decision === 'approve') {
    return db.transaction(() => {
      // Check if version is effective immediately (valid_from <= today)
      const isEffectiveNow = ver.valid_from <= today;

      if (isEffectiveNow) {
        // Fetch current active version
        const doc = db.prepare('SELECT current_version_id FROM vehicle_documents WHERE id = ?').get(ver.document_id);
        if (doc && doc.current_version_id && doc.current_version_id !== ver.id) {
          db.prepare('UPDATE vehicle_doc_versions SET status = \'superseded\' WHERE id = ?').run(doc.current_version_id);
        }

        // Promote to verified & current
        db.prepare(`
          UPDATE vehicle_doc_versions
             SET status = 'verified',
                 verified_by = ?,
                 verified_at = ?,
                 verification_notes = ?
           WHERE id = ?
        `).run(user ? user.id : null, now, notes, versionId);

        db.prepare('UPDATE vehicle_documents SET current_version_id = ?, updated_at = ? WHERE id = ?')
          .run(versionId, now, ver.document_id);
      } else {
        // Future-dated renewal: mark verified, old version stays active until valid_from
        db.prepare(`
          UPDATE vehicle_doc_versions
             SET status = 'verified',
                 verified_by = ?,
                 verified_at = ?,
                 verification_notes = ?
           WHERE id = ?
        `).run(user ? user.id : null, now, notes, versionId);
      }

      // Mark any associated renewal task completed
      db.prepare(`
        UPDATE vehicle_renewal_tasks
           SET stage = 'completed',
               completed_at = ?,
               actual_cost = ?,
               updated_at = ?
         WHERE document_id = ? AND stage != 'completed'
      `).run(now, ver.cost_amount || 0, now, ver.document_id);

      audit.record({
        userId: user ? user.id : null,
        entity: 'vehicle_document',
        entityId: ver.document_id,
        action: 'verify_version',
        after: { versionId, decision: 'approved', isEffectiveNow, notes }
      });

      return db.prepare('SELECT * FROM vehicle_doc_versions WHERE id = ?').get(versionId);
    })();
  } else if (decision === 'reject') {
    db.prepare(`
      UPDATE vehicle_doc_versions
         SET status = 'cancelled',
             verified_by = ?,
             verified_at = ?,
             verification_notes = ?
       WHERE id = ?
    `).run(user ? user.id : null, now, notes, versionId);

    // Reopen/return associated renewal task
    db.prepare(`
      UPDATE vehicle_renewal_tasks
         SET stage = 'returned',
             updated_at = ?
       WHERE document_id = ? AND stage != 'completed'
    `).run(now, ver.document_id);

    audit.record({
      userId: user ? user.id : null,
      entity: 'vehicle_document',
      entityId: ver.document_id,
      action: 'reject_version',
      after: { versionId, decision: 'rejected', notes }
    });

    return db.prepare('SELECT * FROM vehicle_doc_versions WHERE id = ?').get(versionId);
  } else {
    const err = new Error('Invalid verification decision: must be "approve" or "reject"');
    err.status = 400;
    throw err;
  }
}

/**
 * Scheduled / periodic promotion of verified future-dated versions once their valid_from date arrives.
 */
function checkAndPromoteFutureVersions(today = getColomboToday()) {
  const db = getDb();
  const pendingFuture = db.prepare(`
    SELECT v.*, d.current_version_id, d.id AS doc_id
      FROM vehicle_doc_versions v
      JOIN vehicle_documents d ON d.id = v.document_id
     WHERE v.status = 'verified'
       AND v.valid_from <= ?
       AND (d.current_version_id IS NULL OR d.current_version_id != v.id)
       AND (v.valid_until >= ? OR d.current_version_id IS NULL)
  `).all(today, today);

  const promoted = [];
  const now = getColomboNow();

  for (const ver of pendingFuture) {
    db.transaction(() => {
      if (ver.current_version_id) {
        db.prepare('UPDATE vehicle_doc_versions SET status = \'superseded\' WHERE id = ?').run(ver.current_version_id);
      }
      db.prepare('UPDATE vehicle_documents SET current_version_id = ?, updated_at = ? WHERE id = ?')
        .run(ver.id, now, ver.doc_id);
    })();
    promoted.push(ver.id);
  }

  return promoted;
}

// ---------------------------------------------------------------------------
// 7. Renewal Tasks Management
// ---------------------------------------------------------------------------

function getRenewalTasks(filters = {}) {
  const db = getDb();
  let sql = `
    SELECT t.*,
           vd.asset_id,
           a.registration,
           a.code AS asset_code,
           vdt.code AS doc_type_code,
           vdt.name AS doc_type_name,
           u.username AS assigned_to_name
      FROM vehicle_renewal_tasks t
      JOIN vehicle_documents vd ON vd.id = t.document_id
      JOIN assets a ON a.id = vd.asset_id
      JOIN vehicle_doc_types vdt ON vdt.id = vd.doc_type_id
      LEFT JOIN users u ON u.id = t.assigned_to
     WHERE 1=1
  `;
  const params = [];

  if (filters.stage) {
    sql += ' AND t.stage = ?';
    params.push(filters.stage);
  } else if (filters.active_only) {
    sql += ' AND t.stage != \'completed\'';
  }

  if (filters.asset_id) {
    sql += ' AND vd.asset_id = ?';
    params.push(filters.asset_id);
  }

  if (filters.assigned_to) {
    sql += ' AND t.assigned_to = ?';
    params.push(filters.assigned_to);
  }

  sql += ' ORDER BY t.target_date ASC, t.id DESC';

  return db.prepare(sql).all(...params);
}

function createRenewalTask(documentId, data, user) {
  const db = getDb();
  const doc = getDocumentById(documentId);
  if (!doc) {
    const err = new Error('Vehicle document container not found');
    err.status = 404;
    throw err;
  }

  const targetDate = data.target_date || getColomboToday();
  const info = db.prepare(`
    INSERT INTO vehicle_renewal_tasks (
      document_id, target_version_id, stage, assigned_to,
      target_date, checklist_json, estimated_cost, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    documentId,
    data.target_version_id || null,
    data.stage || 'assigned',
    data.assigned_to || (user ? user.id : null),
    targetDate,
    data.checklist_json ? JSON.stringify(data.checklist_json) : null,
    Number(data.estimated_cost || 0),
    getColomboNow(),
    getColomboNow()
  );

  return db.prepare('SELECT * FROM vehicle_renewal_tasks WHERE id = ?').get(info.lastInsertRowid);
}

function updateRenewalTask(taskId, data, user) {
  const db = getDb();
  const task = db.prepare('SELECT * FROM vehicle_renewal_tasks WHERE id = ?').get(taskId);
  if (!task) {
    const err = new Error('Renewal task not found');
    err.status = 404;
    throw err;
  }

  db.prepare(`
    UPDATE vehicle_renewal_tasks
       SET stage = COALESCE(?, stage),
           assigned_to = COALESCE(?, assigned_to),
           target_date = COALESCE(?, target_date),
           checklist_json = COALESCE(?, checklist_json),
           estimated_cost = COALESCE(?, estimated_cost),
           actual_cost = COALESCE(?, actual_cost),
           temporary_receipt_no = COALESCE(?, temporary_receipt_no),
           completed_at = CASE WHEN ? = 'completed' THEN datetime('now') ELSE completed_at END,
           updated_at = ?
     WHERE id = ?
  `).run(
    data.stage || null,
    data.assigned_to !== undefined ? data.assigned_to : null,
    data.target_date || null,
    data.checklist_json ? JSON.stringify(data.checklist_json) : null,
    data.estimated_cost != null ? Number(data.estimated_cost) : null,
    data.actual_cost != null ? Number(data.actual_cost) : null,
    data.temporary_receipt_no || null,
    data.stage || null,
    getColomboNow(),
    taskId
  );

  return db.prepare('SELECT * FROM vehicle_renewal_tasks WHERE id = ?').get(taskId);
}

// ---------------------------------------------------------------------------
// 8. Formal Exemptions (Off-road / Laid-up Fleet Units)
// ---------------------------------------------------------------------------

function setExemption(documentId, { isExempt, reason = '' }, user) {
  const db = getDb();
  const doc = getDocumentById(documentId);
  if (!doc) {
    const err = new Error('Vehicle document container not found');
    err.status = 404;
    throw err;
  }

  const exemptVal = isExempt ? 1 : 0;
  const exemptionDate = exemptVal ? getColomboToday() : null;
  const exemptionBy = exemptVal ? (user ? user.id : null) : null;
  const exemptionReason = exemptVal ? String(reason || '').trim() : null;

  db.prepare(`
    UPDATE vehicle_documents
       SET is_exempt = ?,
           exemption_reason = ?,
           exemption_date = ?,
           exemption_by = ?,
           updated_at = ?
     WHERE id = ?
  `).run(exemptVal, exemptionReason, exemptionDate, exemptionBy, getColomboNow(), documentId);

  audit.record({
    userId: user ? user.id : null,
    entity: 'vehicle_document',
    entityId: documentId,
    action: exemptVal ? 'exempt_document' : 'unexempt_document',
    reason: exemptionReason,
    after: { is_exempt: exemptVal, exemption_reason: exemptionReason }
  });

  return getDocumentById(documentId);
}

// ---------------------------------------------------------------------------
// 9. Document Attachments (PDF Certificates & Payment Slips)
// ---------------------------------------------------------------------------

function getVehicleUploadDir(assetId) {
  const baseUploadDir = config.uploadDir || path.resolve(__dirname, '..', '..', 'uploads');
  const dir = path.resolve(baseUploadDir, 'vehicle_documents', String(assetId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Saves and attaches a physical certificate, receipt, or slip to a document version.
 */
function addAttachment(versionId, { originalFilename, mimeType, buffer, kind = 'certificate' }, user) {
  const db = getDb();
  const ver = db.prepare(`
    SELECT v.*, vd.asset_id
      FROM vehicle_doc_versions v
      JOIN vehicle_documents vd ON vd.id = v.document_id
     WHERE v.id = ?
  `).get(versionId);

  if (!ver) {
    const err = new Error('Document version not found');
    err.status = 404;
    throw err;
  }

  const mime = String(mimeType || '').trim().toLowerCase();
  const ext = ALLOWED_MIME_TYPES.get(mime);
  if (!ext) {
    const err = new Error(`Unsupported file format "${mime}". Allowed: PDF, JPEG, PNG, WebP.`);
    err.status = 400;
    throw err;
  }

  if (!buffer || !Buffer.isBuffer(buffer)) {
    const err = new Error('Invalid file payload');
    err.status = 400;
    throw err;
  }

  if (buffer.length > MAX_FILE_BYTES) {
    const err = new Error(`File size ${(buffer.length / 1024 / 1024).toFixed(1)} MB exceeds maximum limit of 15 MB`);
    err.status = 400;
    throw err;
  }

  // Compute SHA-256
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  // Sanitize filename and save to storage
  const cleanOriginal = path.basename(String(originalFilename || `doc_${Date.now()}.${ext}`)).replace(/[^a-zA-Z0-9._-]/g, '_');
  const storedFilename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${cleanOriginal}`;
  const targetDir = getVehicleUploadDir(ver.asset_id);
  const targetFilePath = path.join(targetDir, storedFilename);

  fs.writeFileSync(targetFilePath, buffer);

  const relativePath = `vehicle_documents/${ver.asset_id}/${storedFilename}`;

  const info = db.prepare(`
    INSERT INTO vehicle_doc_attachments (
      version_id, kind, original_filename, stored_filename,
      file_path, mime_type, file_size, sha256, uploaded_by, uploaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    versionId,
    kind,
    cleanOriginal,
    storedFilename,
    relativePath,
    mime,
    buffer.length,
    sha256,
    user ? user.id : null,
    getColomboNow()
  );

  return db.prepare('SELECT * FROM vehicle_doc_attachments WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Deletes an attachment only if its parent version is still in draft or pending status.
 */
function deleteAttachment(attachmentId, user) {
  const db = getDb();
  const att = db.prepare(`
    SELECT a.*, v.status AS version_status
      FROM vehicle_doc_attachments a
      JOIN vehicle_doc_versions v ON v.id = a.version_id
     WHERE a.id = ?
  `).get(attachmentId);

  if (!att) {
    const err = new Error('Attachment not found');
    err.status = 404;
    throw err;
  }

  if (att.version_status !== 'draft' && att.version_status !== 'pending_verification') {
    const err = new Error('Verified document attachments are immutable and cannot be deleted.');
    err.status = 403;
    throw err;
  }

  // Remove physical file
  const baseUploadDir = config.uploadDir || path.resolve(__dirname, '..', '..', 'uploads');
  const absPath = path.resolve(baseUploadDir, att.file_path);
  try {
    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
  } catch {}

  db.prepare('DELETE FROM vehicle_doc_attachments WHERE id = ?').run(attachmentId);

  audit.record({
    userId: user ? user.id : null,
    entity: 'vehicle_document_attachment',
    entityId: attachmentId,
    action: 'delete_attachment',
    after: { filename: att.original_filename }
  });

  return { ok: true };
}

function getAttachment(attachmentId) {
  const db = getDb();
  const att = db.prepare('SELECT * FROM vehicle_doc_attachments WHERE id = ?').get(attachmentId);
  if (!att) return null;

  const baseUploadDir = config.uploadDir || path.resolve(__dirname, '..', '..', 'uploads');
  const absolutePath = path.resolve(baseUploadDir, att.file_path);

  return {
    ...att,
    absolute_path: absolutePath,
    exists_on_disk: fs.existsSync(absolutePath)
  };
}

// ---------------------------------------------------------------------------
// 10. Fleet Compliance KPIs & Summary
// ---------------------------------------------------------------------------

/**
 * Computes complete fleet compliance metrics across all registered vehicles.
 */
function getFleetComplianceSummary(options = {}) {
  const db = getDb();
  const today = options.today || getColomboToday();

  // Fetch all registered fleet assets
  const assets = db.prepare(`
    SELECT id, code, registration, type, asset_class, status, home_project_id, current_project_id
      FROM assets
     WHERE registration IS NOT NULL
       AND registration != ''
       AND status NOT IN ('scrapped', 'sold')
     ORDER BY code ASC
  `).all();

  const totalVehicles = assets.length;
  let fullyCompliant = 0;
  let criticalCount = 0;
  let warningCount = 0;
  let expiredCount = 0;
  let missingCount = 0;
  let exemptCount = 0;

  const typeBreakdown = {
    revenue_licence: { valid: 0, critical: 0, warning: 0, expired: 0, missing: 0, exempt: 0 },
    insurance: { valid: 0, critical: 0, warning: 0, expired: 0, missing: 0, exempt: 0 },
    emission: { valid: 0, critical: 0, warning: 0, expired: 0, missing: 0, exempt: 0 },
    fitness: { valid: 0, critical: 0, warning: 0, expired: 0, missing: 0, exempt: 0 }
  };

  const vehicleDetails = [];

  for (const asset of assets) {
    const docs = getVehicleDocuments(asset.id, { today });
    let vehicleHasExpired = false;
    let vehicleHasCritical = false;
    let vehicleHasWarning = false;
    let vehicleHasMissing = false;
    let vehicleAllExempt = docs.length > 0;

    for (const d of docs) {
      if (!d.is_required) continue;

      if (!d.is_exempt) vehicleAllExempt = false;

      const evalRes = d.evaluation;
      const typeCode = d.doc_type_code;

      if (typeBreakdown[typeCode]) {
        if (evalRes.is_exempt) {
          typeBreakdown[typeCode].exempt += 1;
        } else if (evalRes.status === 'expired' || evalRes.status === 'expires_today') {
          typeBreakdown[typeCode].expired += 1;
          vehicleHasExpired = true;
        } else if (evalRes.status === 'critical') {
          typeBreakdown[typeCode].critical += 1;
          vehicleHasCritical = true;
        } else if (evalRes.status === 'expiring_soon' || evalRes.status === 'due_for_renewal') {
          typeBreakdown[typeCode].warning += 1;
          vehicleHasWarning = true;
        } else if (evalRes.status === 'missing') {
          typeBreakdown[typeCode].missing += 1;
          vehicleHasMissing = true;
        } else {
          typeBreakdown[typeCode].valid += 1;
        }
      }
    }

    let overallStatus = 'compliant';
    if (vehicleAllExempt) {
      overallStatus = 'exempt';
      exemptCount += 1;
    } else if (vehicleHasExpired) {
      overallStatus = 'expired';
      expiredCount += 1;
    } else if (vehicleHasCritical) {
      overallStatus = 'critical';
      criticalCount += 1;
    } else if (vehicleHasWarning) {
      overallStatus = 'warning';
      warningCount += 1;
    } else if (vehicleHasMissing) {
      overallStatus = 'missing';
      missingCount += 1;
    } else {
      fullyCompliant += 1;
    }

    vehicleDetails.push({
      asset_id: asset.id,
      code: asset.code,
      registration: asset.registration,
      type: asset.type,
      overall_status: overallStatus,
      documents: docs
    });
  }

  // Calculate compliance percentage
  const compliancePercentage = totalVehicles > 0
    ? Math.round((fullyCompliant / totalVehicles) * 100)
    : 100;

  // Upcoming expirations (next 60 days)
  const upcomingExpirations = getUpcomingExpirations({ daysAhead: 60, today });

  return {
    kpis: {
      total_vehicles: totalVehicles,
      fully_compliant: fullyCompliant,
      compliance_percentage: compliancePercentage,
      critical_count: criticalCount,
      warning_count: warningCount,
      expired_count: expiredCount,
      missing_count: missingCount,
      exempt_count: exemptCount
    },
    type_breakdown: typeBreakdown,
    vehicles: vehicleDetails,
    upcoming_expirations: upcomingExpirations,
    as_of_date: today
  };
}

/**
 * Returns a list of all document certificates expiring in the next N days.
 */
function getUpcomingExpirations({ daysAhead = 30, today = getColomboToday() } = {}) {
  const db = getDb();
  const maxDate = new Date(new Date(today + 'T00:00:00Z').getTime() + (daysAhead * 24 * 60 * 60 * 1000))
    .toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT vd.id AS document_id,
           vd.asset_id,
           vd.is_exempt,
           a.code AS asset_code,
           a.registration,
           a.type AS asset_type,
           vdt.code AS doc_type_code,
           vdt.name AS doc_type_name,
           v.id AS version_id,
           v.doc_number,
           v.valid_from,
           v.valid_until,
           v.status AS version_status
      FROM vehicle_documents vd
      JOIN assets a ON a.id = vd.asset_id
      JOIN vehicle_doc_types vdt ON vdt.id = vd.doc_type_id
      JOIN vehicle_doc_versions v ON v.id = vd.current_version_id
     WHERE vd.is_exempt = 0
       AND v.status = 'verified'
       AND v.valid_until <= ?
     ORDER BY v.valid_until ASC
  `).all(maxDate);

  return rows.map((r) => {
    const days = calculateDaysRemaining(r.valid_until, today);
    return {
      ...r,
      days_remaining: days,
      one_month_before: calculateOneMonthBefore(r.valid_until),
      is_expired: days < 0,
      badge: days < 0
        ? { text: `Expired (${Math.abs(days)}d ago)`, color: 'red', level: 'danger' }
        : (days === 0
            ? { text: 'Expires Today', color: 'red', level: 'danger' }
            : (days <= 7
                ? { text: `${days}d Left`, color: 'red', level: 'critical' }
                : (days <= 14
                    ? { text: `${days}d Left`, color: 'amber', level: 'warning' }
                    : { text: `${days}d Left`, color: 'blue', level: 'info' })))
    };
  });
}

// ---------------------------------------------------------------------------
// 11. Expiry Reminders Logging
// ---------------------------------------------------------------------------

function logReminderSent(versionId, stage, recipientId, channel = 'in_app') {
  const db = getDb();
  return db.prepare(`
    INSERT OR IGNORE INTO vehicle_doc_reminders (
      version_id, stage, recipient_id, channel, sent_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(versionId, stage, recipientId, channel, getColomboNow());
}

function getRemindersForVersion(versionId) {
  const db = getDb();
  return db.prepare(`
    SELECT r.*, u.username AS recipient_name
      FROM vehicle_doc_reminders r
      JOIN users u ON u.id = r.recipient_id
     WHERE r.version_id = ?
     ORDER BY r.sent_at DESC
  `).all(versionId);
}

/**
 * Executes scheduled compliance and reminder check:
 * 1. Promotes future versions whose valid_from has arrived.
 * 2. Evaluates expiration countdowns across all registered active fleet documents.
 * 3. Logs deduplicated reminders across target statutory thresholds:
 *    - 1_month (30 days or 1 calendar month)
 *    - 14_days
 *    - 7_days
 *    - 3_days
 *    - 1_day
 *    - expires_today (0 days)
 *    - overdue (< 0 days)
 * 4. Emits real-time data_changed event.
 */
function runDailyReminderCheck(options = {}) {
  const db = getDb();
  const today = options.today || getColomboToday();

  // 1. Check and promote future-dated verified renewals whose start date has arrived
  const promoted = checkAndPromoteFutureVersions(today);

  // 2. Fetch all registered active fleet assets
  const assets = db.prepare(`
    SELECT id, code, registration, type, asset_class
      FROM assets
     WHERE registration IS NOT NULL
       AND registration != ''
       AND status NOT IN ('scrapped', 'sold')
     ORDER BY code ASC
  `).all();

  // Target reminder recipients: active managers and transport officers
  const defaultRecipients = db.prepare(`
    SELECT DISTINCT u.id
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r ON r.id = ur.role_id
     WHERE u.active = 1
       AND r.name IN ('transport_manager', 'assistant_transport_manager', 'operational_manager', 'manager', 'admin')
  `).all().map((r) => r.id);

  let remindersLogged = 0;
  const remindersByStage = {};

  for (const asset of assets) {
    const docs = getVehicleDocuments(asset.id, { today });

    for (const d of docs) {
      if (!d.is_required || d.is_exempt) continue;
      const cur = d.current_version;
      if (!cur || cur.status !== 'verified') continue;
      if (cur.valid_until === '9999-12-31' || !cur.valid_until) continue;

      const days = calculateDaysRemaining(cur.valid_until, today);
      const stagesToTrigger = [];

      if (days === 30 || today === calculateOneMonthBefore(cur.valid_until)) {
        stagesToTrigger.push('1_month');
      }
      if (days <= 14 && days > 7) {
        stagesToTrigger.push('14_days');
      }
      if (days <= 7 && days > 3) {
        stagesToTrigger.push('7_days');
      }
      if (days <= 3 && days > 1) {
        stagesToTrigger.push('3_days');
      }
      if (days === 1) {
        stagesToTrigger.push('1_day');
      }
      if (days === 0) {
        stagesToTrigger.push('expires_today');
      }
      if (days < 0) {
        stagesToTrigger.push('overdue');
      }

      if (!stagesToTrigger.length) continue;

      const recipientIds = new Set(defaultRecipients);
      if (cur.responsible_user_id) recipientIds.add(cur.responsible_user_id);

      for (const stg of stagesToTrigger) {
        for (const recipientId of recipientIds) {
          const res = logReminderSent(cur.id, stg, recipientId, 'in_app');
          if (res && res.changes > 0) {
            remindersLogged += 1;
            remindersByStage[stg] = (remindersByStage[stg] || 0) + 1;
            emitter.emit('data_changed', {
              entity: 'vehicle_document',
              action: 'reminder_triggered',
              stage: stg,
              version_id: cur.id,
              document_id: d.id,
              asset_id: asset.id,
              recipient_id: recipientId
            });
          }
        }
      }
    }
  }

  return {
    today,
    promoted_count: promoted.length,
    promoted_ids: promoted,
    reminders_logged: remindersLogged,
    reminders_by_stage: remindersByStage
  };
}

/**
 * Starts the background compliance check & reminder scheduler.
 */
function startScheduler(everyMinutes = 60) {
  const tick = () => {
    try {
      const res = runDailyReminderCheck();
      if (res.promoted_count > 0 || res.reminders_logged > 0) {
        console.log(`[vehicle-docs] Reminder check: ${res.promoted_count} version(s) promoted, ${res.reminders_logged} reminder(s) logged`);
      }
    } catch (e) {
      console.error('[vehicle-docs] Reminder scheduler failed:', e && e.message);
    }
  };

  setImmediate(tick);
  const timer = setInterval(tick, Math.max(5, everyMinutes) * 60 * 1000);
  timer.unref();
  return timer;
}

// ---------------------------------------------------------------------------
// Module Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Date & Time Helpers
  getColomboToday,
  getColomboNow,
  calculateDaysRemaining,
  calculateOneMonthBefore,

  // Status & Readiness
  evaluateDocStatus,
  evaluateErlChecklist,
  isFitnessRequiredForAsset,

  // Document Types Catalog
  listDocTypes,
  getDocTypeByCode,

  // Container & Versions
  ensureVehicleDocuments,
  getVehicleDocuments,
  getDocumentById,
  getDocumentHistory,
  createDraftVersion,
  updateDraftVersion,
  verifyVersion,
  checkAndPromoteFutureVersions,

  // Renewal Tasks
  getRenewalTasks,
  createRenewalTask,
  updateRenewalTask,

  // Exemptions
  setExemption,

  // Attachments
  addAttachment,
  deleteAttachment,
  getAttachment,

  // Fleet Compliance & KPIs
  getFleetComplianceSummary,
  getUpcomingExpirations,
  logReminderSent,
  getRemindersForVersion,

  // Reminder Engine & Scheduler
  runDailyReminderCheck,
  startScheduler
};
