'use strict';

/**
 * ===========================================================================
 * Vehicle Documents & Statutory Renewal Monitoring Router (Phase 3)
 *
 * REST Endpoints:
 * - Fleet Compliance KPIs, type breakdowns, and upcoming expirations.
 * - Vehicle document container queries & eRL renewal readiness checklists.
 * - Version lifecycle: Draft submission, Manager verification, and Promotion.
 * - Physical attachment uploads (PDF/Images) with SHA-256 and secure streaming.
 * - Formal fleet exemptions (laid-up / off-road vehicles).
 * - Renewal tasks tracking and workflow progress.
 * ===========================================================================
 */

const express = require('express');
const fs = require('fs');
const { get, all, run } = require('../db');
const audit = require('../lib/audit');
const aliases = require('../lib/aliases');
const vdocs = require('../lib/vehicle_documents');
const { requireCap, hasCap } = require('../lib/auth');
const { asyncHandler, toInt } = require('../lib/http');
const { sendXlsx } = require('../lib/export');

const router = express.Router();

// Helper to parse file payload (base64 data URL or raw fields)
function parseFileUpload(body) {
  let buffer = null;
  let mimeType = String(body.mimeType || body.mime_type || '').trim().toLowerCase();
  let originalFilename = String(body.filename || body.originalFilename || body.original_filename || '').trim();
  const kind = String(body.kind || 'certificate').trim();

  const dataUrl = body.dataUrl || body.data_url || body.file || body.content;
  if (dataUrl && typeof dataUrl === 'string') {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/i);
    if (match) {
      mimeType = mimeType || match[1].toLowerCase();
      buffer = Buffer.from(match[2], 'base64');
    } else {
      buffer = Buffer.from(dataUrl, 'base64');
    }
  } else if (body.base64 && typeof body.base64 === 'string') {
    buffer = Buffer.from(body.base64, 'base64');
  }

  return { buffer, mimeType, originalFilename, kind };
}

// ---------------------------------------------------------------------------
// 1. Dashboard, Catalogs & Upcoming Expirations
// ---------------------------------------------------------------------------

/**
 * GET /types
 * List all active statutory and company document types.
 */
router.get('/types', requireCap('vehicle_docs.view'), asyncHandler((req, res) => {
  const types = vdocs.listDocTypes();
  res.json(types);
}));

/**
 * GET /compliance-summary
 * Aggregated fleet compliance KPIs, type breakdown, and upcoming expirations.
 */
router.get('/compliance-summary', requireCap('vehicle_docs.view'), asyncHandler((req, res) => {
  const today = req.query.today ? String(req.query.today).trim() : undefined;
  const summary = vdocs.getFleetComplianceSummary({ today, projectId: (req.user && !req.user.isAllSitesMode) ? req.user.activeProjectId : null, workshopId: (req.user && !req.user.isAllSitesMode) ? req.user.activeWorkshopId : null });
  res.json(summary);
}));

/**
 * GET /upcoming-expirations
 * List of document certificates expiring in the next N days (default: 30 days).
 */
router.get('/upcoming-expirations', requireCap('vehicle_docs.view'), asyncHandler((req, res) => {
  const daysAhead = toInt(req.query.daysAhead || req.query.days_ahead, 30);
  const today = req.query.today ? String(req.query.today).trim() : undefined;
  const list = vdocs.getUpcomingExpirations({ daysAhead, today, projectId: (req.user && !req.user.isAllSitesMode) ? req.user.activeProjectId : null, workshopId: (req.user && !req.user.isAllSitesMode) ? req.user.activeWorkshopId : null });
  res.json(list);
}));

/**
 * GET /export.xlsx
 * Export comprehensive vehicle statutory documents compliance register to Excel.
 */
router.get('/export.xlsx', requireCap('vehicle_docs.export'), asyncHandler(async (req, res) => {
  const today = req.query.today ? String(req.query.today).trim() : undefined;
  const projectId = (req.user && !req.user.isAllSitesMode) ? req.user.activeProjectId : null;
  const workshopId = (req.user && !req.user.isAllSitesMode) ? req.user.activeWorkshopId : null;
  const summary = vdocs.getFleetComplianceSummary({ today, projectId, workshopId });
  const vehicles = summary.vehicles || [];

  const rows = [];
  for (const v of vehicles) {
    for (const d of v.documents || []) {
      const cur = d.current_version;
      const ev = d.evaluation || {};
      const b = ev.badge || {};

      rows.push({
        code: v.code || '',
        registration: v.registration || '',
        type: v.type || '',
        overall_status: v.overall_status || '',
        doc_type_name: d.doc_type_name || '',
        category: d.doc_type_category || '',
        is_mandatory: d.is_required ? 'Yes' : 'No',
        doc_number: cur ? cur.doc_number : '—',
        issuer: cur && cur.issuer_name ? cur.issuer_name : '—',
        valid_from: cur && cur.valid_from ? cur.valid_from : '—',
        valid_until: cur && cur.valid_until ? cur.valid_until : '—',
        status: b.text || d.status || '—',
        days_remaining: ev.days_remaining != null ? ev.days_remaining : '—',
        is_exempt: d.is_exempt ? 'Yes' : 'No',
        exemption_reason: d.exemption_reason || ''
      });
    }
  }

  const columns = [
    { header: 'Vehicle Code', key: 'code', width: 14 },
    { header: 'Registration No', key: 'registration', width: 16 },
    { header: 'Type / Model', key: 'type', width: 18 },
    { header: 'Fleet Status', key: 'overall_status', width: 16 },
    { header: 'Document Type', key: 'doc_type_name', width: 28 },
    { header: 'Category', key: 'category', width: 14 },
    { header: 'Mandatory', key: 'is_mandatory', width: 12 },
    { header: 'Certificate / Policy No', key: 'doc_number', width: 22 },
    { header: 'Issuer / Authority', key: 'issuer', width: 22 },
    { header: 'Valid From', key: 'valid_from', width: 14 },
    { header: 'Valid Until', key: 'valid_until', width: 14 },
    { header: 'Document Status', key: 'status', width: 16 },
    { header: 'Days Remaining', key: 'days_remaining', width: 16 },
    { header: 'Exempt', key: 'is_exempt', width: 10 },
    { header: 'Exemption Reason', key: 'exemption_reason', width: 32 }
  ];

  await sendXlsx(res, `fleet-vehicle-documents-${(today || vdocs.getColomboToday())}.xlsx`, [
    { name: 'Vehicle Documents', columns, rows }
  ]);
}));

// ---------------------------------------------------------------------------
// 2. Renewal Tasks Management
// ---------------------------------------------------------------------------

/**
 * GET /tasks
 * List renewal tasks with optional filters (stage, active_only, asset_id, assigned_to).
 */
router.get('/tasks', requireCap('vehicle_docs.view'), asyncHandler((req, res) => {
  const filters = {
    stage: req.query.stage ? String(req.query.stage).trim() : undefined,
    active_only: req.query.active_only === '1' || req.query.active_only === 'true',
    asset_id: req.query.asset_id ? toInt(req.query.asset_id) : undefined,
    assigned_to: req.query.assigned_to ? toInt(req.query.assigned_to) : undefined
  };
  const tasks = vdocs.getRenewalTasks(filters);
  res.json(tasks);
}));

/**
 * POST /tasks
 * Create a new renewal task.
 */
router.post('/tasks', requireCap('vehicle_docs.renew'), asyncHandler((req, res) => {
  const docId = toInt(req.body.document_id);
  if (!docId) return res.status(400).json({ error: 'Missing document_id' });

  const task = vdocs.createRenewalTask(docId, req.body, req.user);
  res.status(201).json(task);
}));

/**
 * PUT /tasks/:taskId
 * Update renewal task stage, target date, or costs.
 */
router.put('/tasks/:taskId', requireCap('vehicle_docs.renew'), asyncHandler((req, res) => {
  const taskId = toInt(req.params.taskId);
  const updated = vdocs.updateRenewalTask(taskId, req.body, req.user);
  res.json(updated);
}));

// ---------------------------------------------------------------------------
// 3. Vehicle Documents & eRL Checklist by Asset ID
// ---------------------------------------------------------------------------

/**
 * GET /assets/:assetId
 * Retrieve all statutory documents for an asset with active versions and badges.
 */
router.get('/assets/:assetId', requireCap('vehicle_docs.view'), asyncHandler((req, res) => {
  const assetId = toInt(req.params.assetId);
  const today = req.query.today ? String(req.query.today).trim() : undefined;
  const docs = vdocs.getVehicleDocuments(assetId, { today });
  res.json(docs);
}));

/**
 * GET /assets/:assetId/erl-checklist
 * Evaluate eRL Revenue Licence renewal readiness checklist for an asset.
 */
router.get('/assets/:assetId/erl-checklist', requireCap('vehicle_docs.view'), asyncHandler((req, res) => {
  const assetId = toInt(req.params.assetId);
  const targetDate = req.query.targetDate || req.query.target_date;
  const evaluation = vdocs.evaluateErlChecklist(assetId, { targetDate });
  res.json(evaluation);
}));

// ---------------------------------------------------------------------------
// 3b. Bulk Statutory Expiry Import
// ---------------------------------------------------------------------------

/**
 * Resolve an asset strictly against existing assets and already-resolved aliases
 * without queuing pending alias noise on typos.
 */
function lookupAssetForDocImport(row) {
  if (row.asset_id) {
    const byId = get('SELECT id, code, registration FROM assets WHERE id = ?', toInt(row.asset_id));
    if (byId) return byId;
  }
  const raw = String(row.vehicle || row.code || row.registration || '').trim();
  if (!raw) return null;
  const norm = aliases.normalize(raw);
  if (!norm) return null;

  let asset = get('SELECT id, code, registration FROM assets WHERE code_norm = ?', norm);
  if (asset) return asset;

  asset = get(
    "SELECT id, code, registration FROM assets WHERE UPPER(REPLACE(REPLACE(COALESCE(registration, ''), '-', ''), ' ', '')) = ?",
    norm
  );
  if (asset) return asset;

  const knownAlias = get(
    'SELECT a.id, a.code, a.registration FROM asset_aliases al JOIN assets a ON a.id = al.asset_id WHERE al.raw_norm = ? AND al.resolved = 1 LIMIT 1',
    norm
  );
  return knownAlias || null;
}

/**
 * POST /bulk-import
 * Bulk-import expiry dates and certificate numbers across vehicles.
 */
router.post('/bulk-import', requireCap('vehicle_docs.renew', 'vehicle_docs.edit'), asyncHandler((req, res) => {
  const body = req.body || {};
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows || !rows.length) {
    return res.status(400).json({ error: 'rows must be a non-empty array' });
  }
  if (rows.length > 500) {
    return res.status(400).json({ error: 'Cannot bulk-import more than 500 rows per request' });
  }

  const autoVerifyDefault = Boolean(body.auto_verify);
  const canVerify = hasCap(req.user, 'vehicle_docs.verify');
  const docTypes = vdocs.listDocTypes();
  const findDocType = (raw) => {
    const k = String(raw || '').trim().toLowerCase();
    if (!k) return null;
    return docTypes.find((t) => String(t.code).toLowerCase() === k || String(t.name).toLowerCase() === k) || null;
  };

  const imported = [];
  const skipped = [];

  for (let idx = 0; idx < rows.length; idx++) {
    const r = rows[idx] || {};
    const asset = lookupAssetForDocImport(r);
    if (!asset) {
      skipped.push({ index: idx, reason: 'vehicle_not_found', input: r.vehicle || r.code || r.registration || r.asset_id || null });
      continue;
    }

    const docType = findDocType(r.doc_type || r.doc_type_code);
    if (!docType) {
      skipped.push({ index: idx, asset_id: asset.id, reason: 'invalid_doc_type', input: r.doc_type || r.doc_type_code || null });
      continue;
    }

    const validUntil = r.valid_until ? String(r.valid_until).trim().slice(0, 10) : '';
    if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) {
      skipped.push({ index: idx, asset_id: asset.id, doc_type: docType.code, reason: 'invalid_valid_until_date' });
      continue;
    }
    if (docType.is_renewable && !validUntil) {
      skipped.push({ index: idx, asset_id: asset.id, doc_type: docType.code, reason: 'valid_until_required' });
      continue;
    }

    const docNumber = String(r.doc_number || '').trim()
      || (validUntil ? `BULK-${String(docType.code).toUpperCase()}-${validUntil}` : `BULK-${String(docType.code).toUpperCase()}-${asset.id}`);
    const validFrom = r.valid_from ? String(r.valid_from).trim().slice(0, 10) : undefined;
    const issueDate = r.issue_date ? String(r.issue_date).trim().slice(0, 10) : undefined;

    vdocs.ensureVehicleDocuments(asset.id);
    const container = get(
      'SELECT id FROM vehicle_documents WHERE asset_id = ? AND doc_type_id = ?',
      asset.id, docType.id
    );
    if (!container) {
      skipped.push({ index: idx, asset_id: asset.id, doc_type: docType.code, reason: 'document_container_missing' });
      continue;
    }

    const ver = vdocs.createDraftVersion(container.id, {
      doc_number: docNumber,
      issuer_name: r.issuer_name || null,
      issue_date: issueDate,
      valid_from: validFrom,
      valid_until: validUntil || undefined,
      cost_amount: r.cost_amount != null ? Number(r.cost_amount) : 0,
      notes: r.notes || null,
      status: 'pending_verification',
    }, req.user);

    let finalVer = ver;
    const shouldVerify = r.verify !== undefined ? Boolean(r.verify) : autoVerifyDefault;
    if (shouldVerify && canVerify) {
      finalVer = vdocs.verifyVersion(ver.id, {
        decision: 'approve',
        notes: 'Bulk import verified',
        today: r.today ? String(r.today).trim().slice(0, 10) : undefined,
      }, req.user);
    }

    imported.push({
      index: idx,
      asset_id: asset.id,
      asset_code: asset.code,
      document_id: container.id,
      version_id: finalVer.id,
      doc_type: docType.code,
      doc_number: finalVer.doc_number,
      valid_until: finalVer.valid_until,
      status: finalVer.status,
    });
  }

  audit.record({
    userId: req.user ? req.user.id : null,
    entity: 'vehicle_document',
    action: 'bulk_import',
    after: { imported_count: imported.length, skipped_count: skipped.length },
  });

  res.status(201).json({
    ok: true,
    imported_count: imported.length,
    skipped_count: skipped.length,
    imported,
    skipped,
  });
}));

// ---------------------------------------------------------------------------
// 4. Document Container & Exemption
// ---------------------------------------------------------------------------

/**
 * GET /:documentId
 * Get a specific document container by ID.
 */
router.get('/:documentId', requireCap('vehicle_docs.view'), asyncHandler((req, res) => {
  const docId = toInt(req.params.documentId);
  const doc = vdocs.getDocumentById(docId);
  if (!doc) return res.status(404).json({ error: 'Vehicle document not found' });
  res.json(doc);
}));

/**
 * GET /:documentId/history
 * Immutable version history and all attached certificates.
 */
router.get('/:documentId/history', requireCap('vehicle_docs.view'), asyncHandler((req, res) => {
  const docId = toInt(req.params.documentId);
  const history = vdocs.getDocumentHistory(docId);
  res.json(history);
}));

/**
 * PUT /:documentId/exemption
 * Mark a vehicle document exempt or un-exempt (laid-up / off-road fleet).
 */
router.put('/:documentId/exemption', requireCap('vehicle_docs.exempt'), asyncHandler((req, res) => {
  const docId = toInt(req.params.documentId);
  const isExempt = req.body.isExempt === true || req.body.isExempt === 'true' || req.body.is_exempt === 1;
  const reason = String(req.body.reason || '').trim();

  if (isExempt && !reason) {
    return res.status(400).json({ error: 'Exemption reason is required when laying up a vehicle' });
  }

  const updated = vdocs.setExemption(docId, { isExempt, reason }, req.user);
  res.json(updated);
}));

/**
 * POST /:documentId/tasks
 * Create a renewal task directly on a document container.
 */
router.post('/:documentId/tasks', requireCap('vehicle_docs.renew'), asyncHandler((req, res) => {
  const docId = toInt(req.params.documentId);
  const task = vdocs.createRenewalTask(docId, req.body, req.user);
  res.status(201).json(task);
}));

// ---------------------------------------------------------------------------
// 5. Version Lifecycle: Draft, Update, Verify & Future Promotion
// ---------------------------------------------------------------------------

/**
 * POST /:documentId/versions
 * Submit a new renewal version (draft or pending_verification).
 */
router.post('/:documentId/versions', requireCap('vehicle_docs.renew', 'vehicle_docs.edit'), asyncHandler((req, res) => {
  const docId = toInt(req.params.documentId);
  const version = vdocs.createDraftVersion(docId, req.body, req.user);
  res.status(201).json(version);
}));

/**
 * PUT /versions/:versionId
 * Update an unverified version. (Verified versions cannot be edited).
 */
router.put('/versions/:versionId', requireCap('vehicle_docs.edit', 'vehicle_docs.renew'), asyncHandler((req, res) => {
  const versionId = toInt(req.params.versionId);
  const updated = vdocs.updateDraftVersion(versionId, req.body, req.user);
  res.json(updated);
}));

/**
 * POST /versions/:versionId/verify
 * Manager verification & version promotion (Transport / Operational Manager).
 */
router.post('/versions/:versionId/verify', requireCap('vehicle_docs.verify'), asyncHandler((req, res) => {
  const versionId = toInt(req.params.versionId);
  const decision = String(req.body.decision || '').trim().toLowerCase();
  const notes = String(req.body.notes || '').trim();

  if (decision !== 'approve' && decision !== 'reject') {
    return res.status(400).json({ error: 'Decision must be "approve" or "reject"' });
  }

  const verified = vdocs.verifyVersion(versionId, { decision, notes }, req.user);
  res.json(verified);
}));

/**
 * POST /promote-future
 * Periodic or manual promotion of verified future-dated versions whose start date has arrived.
 */
router.post('/promote-future', requireCap('vehicle_docs.verify'), asyncHandler((req, res) => {
  const today = req.body.today ? String(req.body.today).trim() : undefined;
  const promoted = vdocs.checkAndPromoteFutureVersions(today);
  res.json({ ok: true, promoted_count: promoted.length, promoted_ids: promoted });
}));

/**
 * POST /check-reminders
 * Trigger on-demand compliance check and deduplicated reminder logging.
 */
router.post('/check-reminders', requireCap('vehicle_docs.renew'), asyncHandler((req, res) => {
  const today = req.body.today ? String(req.body.today).trim() : undefined;
  const result = vdocs.runDailyReminderCheck({ today });
  res.json({ ok: true, ...result });
}));

// ---------------------------------------------------------------------------
// 6. Attachments (Upload, Download & Deletion)
// ---------------------------------------------------------------------------

/**
 * POST /versions/:versionId/attachments
 * Upload a certificate scan, receipt, or slip.
 */
router.post('/versions/:versionId/attachments', requireCap('vehicle_docs.upload'), asyncHandler((req, res) => {
  const versionId = toInt(req.params.versionId);
  const { buffer, mimeType, originalFilename, kind } = parseFileUpload(req.body);

  if (!buffer) {
    return res.status(400).json({ error: 'File payload is required (dataUrl or base64)' });
  }

  const attachment = vdocs.addAttachment(versionId, {
    originalFilename,
    mimeType,
    buffer,
    kind
  }, req.user);

  res.status(201).json(attachment);
}));

/**
 * GET /attachments/:attachmentId
 * Get attachment metadata.
 */
router.get('/attachments/:attachmentId', requireCap('vehicle_docs.view'), asyncHandler((req, res) => {
  const attachmentId = toInt(req.params.attachmentId);
  const att = vdocs.getAttachment(attachmentId);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  res.json(att);
}));

/**
 * GET /attachments/:attachmentId/download
 * Download or stream the physical certificate file.
 */
router.get('/attachments/:attachmentId/download', requireCap('vehicle_docs.download'), asyncHandler((req, res) => {
  const attachmentId = toInt(req.params.attachmentId);
  const att = vdocs.getAttachment(attachmentId);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  if (!att.exists_on_disk) return res.status(404).json({ error: 'Physical file is missing from storage' });

  res.setHeader('Content-Type', att.mime_type || 'application/pdf');
  res.setHeader('Content-Length', att.file_size);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(att.original_filename)}"`);
  fs.createReadStream(att.absolute_path).pipe(res);
}));

/**
 * DELETE /attachments/:attachmentId
 * Delete attachment from an unverified draft or pending version.
 */
router.delete('/attachments/:attachmentId', requireCap('vehicle_docs.upload', 'vehicle_docs.edit'), asyncHandler((req, res) => {
  const attachmentId = toInt(req.params.attachmentId);
  const result = vdocs.deleteAttachment(attachmentId, req.user);
  res.json(result);
}));

/**
 * DELETE /:documentId
 * Remove or deactivate a statutory document requirement.
 */
router.delete('/:documentId', requireCap('vehicle_docs.delete'), asyncHandler((req, res) => {
  const docId = toInt(req.params.documentId);
  const doc = get('SELECT * FROM vehicle_documents WHERE id = ?', docId);
  if (!doc) return res.status(404).json({ error: 'Vehicle document not found' });
  run("UPDATE vehicle_documents SET is_required = 0, updated_at = datetime('now') WHERE id = ?", docId);
  audit.record({ userId: req.user.id, entity: 'vehicle_document', entityId: docId, action: 'delete', before: doc });
  res.json({ ok: true, deleted: true });
}));

module.exports = router;
