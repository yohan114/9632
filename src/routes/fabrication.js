'use strict';

/**
 * ===========================================================================
 * Fabrication Section & Costing Router
 *
 * REST Endpoints:
 * - Categories: Listing, creation, updates, and deactivation for General Works.
 * - Drawings: Secure upload and download/streaming with capability protection.
 * - Settings: Overhead rate and fabrication feature toggle.
 * - Costing Sheet: Draft -> Submit -> Approve / Reject lifecycle with Segregation of Duties.
 * - Adjustments: Manual non-stock and outsourced work line tracking.
 * - Summaries: KPI metrics and card listing for Fabrication Officers and Managers.
 * ===========================================================================
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { get, all, run, tx } = require('../db');
const scope = require('../lib/scope');
const { requireCap, hasCap } = require('../lib/auth');
const { isAdmin } = require('../lib/access_rules');
const audit = require('../lib/audit');
const costing = require('../lib/costing');
const config = require('../config');
const { asyncHandler, toInt } = require('../lib/http');

const router = express.Router();

// Helper to parse file payload (base64 data URL or raw buffer fields)
function parseDrawingUpload(body) {
  let buffer = null;
  let mimeType = String(body.mimeType || body.mime_type || '').trim().toLowerCase();
  let originalFilename = String(body.filename || body.originalFilename || body.original_filename || '').trim();
  const drawingRef = String(body.drawing_ref || body.drawingRef || '').trim();

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

  return { buffer, mimeType, originalFilename, drawingRef };
}

// ---------------------------------------------------------------------------
// 1. Categories Management
// ---------------------------------------------------------------------------

/**
 * GET /categories
 * List active fabrication categories (all if requested with settings cap).
 */
router.get('/categories', asyncHandler((req, res) => {
  const showAll = req.query.all === '1' && (isAdmin(req.user) || hasCap(req.user, 'fabrication.settings'));
  const sql = showAll
    ? 'SELECT * FROM fabrication_categories ORDER BY display_order ASC, label ASC'
    : 'SELECT * FROM fabrication_categories WHERE is_active = 1 ORDER BY display_order ASC, label ASC';
  const categories = all(sql);
  res.json(categories);
}));

/**
 * POST /categories
 * Create a new fabrication category.
 */
router.post('/categories', requireCap('fabrication.settings'), asyncHandler((req, res) => {
  const label = String(req.body.label || '').trim();
  if (!label) return res.status(400).json({ error: 'Category label is required.' });

  const rawKey = String(req.body.key || label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const key = rawKey || 'cat_' + Date.now();
  const description = req.body.description ? String(req.body.description).trim() : null;
  const order = toInt(req.body.display_order, 50);

  const existing = get('SELECT id FROM fabrication_categories WHERE key = ?', key);
  if (existing) {
    return res.status(409).json({ error: `Category with key '${key}' already exists.` });
  }

  const result = run(
    'INSERT INTO fabrication_categories (key, label, description, display_order, is_active) VALUES (?, ?, ?, ?, 1)',
    key, label, description, order
  );

  audit.record({
    userId: req.user.id,
    entity: 'fabrication_category',
    entityId: result.lastInsertRowid,
    action: 'create',
    after: { key, label, description, order }
  });

  res.status(201).json(get('SELECT * FROM fabrication_categories WHERE id = ?', result.lastInsertRowid));
}));

/**
 * PUT /categories/:id
 * Update an existing category.
 */
router.put('/categories/:id', requireCap('fabrication.settings'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const cat = get('SELECT * FROM fabrication_categories WHERE id = ?', id);
  if (!cat) return res.status(404).json({ error: 'Category not found' });

  const label = req.body.label != null ? String(req.body.label).trim() : cat.label;
  const description = req.body.description != null ? String(req.body.description).trim() : cat.description;
  const order = req.body.display_order != null ? toInt(req.body.display_order) : cat.display_order;
  const isActive = req.body.is_active != null ? (req.body.is_active ? 1 : 0) : cat.is_active;

  run(
    'UPDATE fabrication_categories SET label = ?, description = ?, display_order = ?, is_active = ? WHERE id = ?',
    label, description, order, isActive, id
  );

  audit.record({
    userId: req.user.id,
    entity: 'fabrication_category',
    entityId: id,
    action: 'update',
    before: cat,
    after: { label, description, display_order: order, is_active: isActive }
  });

  res.json(get('SELECT * FROM fabrication_categories WHERE id = ?', id));
}));

/**
 * DELETE /categories/:id
 * Soft-delete (deactivate) a fabrication category.
 */
router.delete('/categories/:id', requireCap('fabrication.settings'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const cat = get('SELECT * FROM fabrication_categories WHERE id = ?', id);
  if (!cat) return res.status(404).json({ error: 'Category not found' });

  run('UPDATE fabrication_categories SET is_active = 0 WHERE id = ?', id);
  audit.record({
    userId: req.user.id,
    entity: 'fabrication_category',
    entityId: id,
    action: 'deactivate'
  });

  res.json({ ok: true, message: `Category '${cat.label}' deactivated.` });
}));

// ---------------------------------------------------------------------------
// 2. Drawings Upload & Streaming
// ---------------------------------------------------------------------------

// No .svg: an SVG can carry script, and a drawing is served from this site's own origin.
const ALLOWED_DRAWING_EXTS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.dwg', '.dxf', '.step', '.stp']);

/**
 * POST /drawings
 * Upload a fabrication drawing file.
 */
router.post('/drawings', requireCap('fabrication.drawings', 'fabrication.edit', 'jobrequests.create_fabrication'), asyncHandler((req, res) => {
  const { buffer, originalFilename, drawingRef } = parseDrawingUpload(req.body);
  if (!buffer || !buffer.length) {
    return res.status(400).json({ error: 'No drawing file data provided.' });
  }

  const ext = path.extname(originalFilename || '').toLowerCase();
  if (!ALLOWED_DRAWING_EXTS.has(ext)) {
    return res.status(400).json({
      error: `Unsupported drawing file type '${ext}'. Allowed types: ${Array.from(ALLOWED_DRAWING_EXTS).join(', ')}`
    });
  }

  // Max 25 MB
  if (buffer.length > 25 * 1024 * 1024) {
    return res.status(400).json({ error: 'Drawing file exceeds maximum limit of 25 MB.' });
  }

  const drawingsDir = path.join(config.uploadDir, 'drawings');
  if (!fs.existsSync(drawingsDir)) {
    fs.mkdirSync(drawingsDir, { recursive: true });
  }

  const safeBasename = path.basename(originalFilename, ext).replace(/[^a-z0-9_-]/gi, '_');
  const storedFilename = `dwg_${Date.now()}_${safeBasename}${ext}`;
  const targetPath = path.join(drawingsDir, storedFilename);

  fs.writeFileSync(targetPath, buffer);

  const drawingPath = `/uploads/drawings/${storedFilename}`;
  res.status(201).json({
    ok: true,
    drawing_ref: drawingRef || originalFilename,
    drawing_path: drawingPath,
    drawing_filename: originalFilename || storedFilename,
    file_size: buffer.length
  });
}));

/**
 * GET /drawings/:filename
 * Securely stream/download a fabrication drawing.
 */
router.get('/drawings/:filename', requireCap('fabrication.drawings', 'fabrication.view'), asyncHandler((req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(config.uploadDir, 'drawings', filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Drawing file not found.' });
  }

  // A download, never rendered in the page's origin (older uploads may still be .svg).
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.attachment(filename);
  res.sendFile(filePath);
}));

// ---------------------------------------------------------------------------
// 3. Settings
// ---------------------------------------------------------------------------

/**
 * GET /settings
 * Get fabrication system settings (overhead percentage and status).
 */
router.get('/settings', requireCap('fabrication.view', 'fabrication.settings'), asyncHandler((req, res) => {
  const enabledRow = get("SELECT value FROM settings WHERE key = 'fabrication.enabled'");
  const overheadRow = get("SELECT value FROM settings WHERE key = 'fabrication.default_overhead_rate'");
  res.json({
    enabled: enabledRow ? enabledRow.value === '1' : true,
    default_overhead_rate: overheadRow ? parseFloat(overheadRow.value) || 0 : 0
  });
}));

/**
 * POST /settings
 * Update fabrication system settings.
 */
router.post('/settings', requireCap('fabrication.settings'), asyncHandler((req, res) => {
  const enabled = req.body.enabled != null ? (req.body.enabled ? '1' : '0') : null;
  const overheadRate = req.body.default_overhead_rate != null ? Number(req.body.default_overhead_rate) : null;

  tx(() => {
    if (enabled != null) {
      run("INSERT INTO settings (key, value) VALUES ('fabrication.enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", enabled);
    }
    if (overheadRate != null && !isNaN(overheadRate) && overheadRate >= 0) {
      run("INSERT INTO settings (key, value) VALUES ('fabrication.default_overhead_rate', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(overheadRate));
    }
  });

  audit.record({
    userId: req.user.id,
    entity: 'fabrication_settings',
    entityId: 0,
    action: 'update',
    after: { enabled, default_overhead_rate: overheadRate }
  });

  res.json({ ok: true, message: 'Fabrication settings updated successfully.' });
}));

// ---------------------------------------------------------------------------
// 4. Fabrication Costing Sheet Lifecycle
// ---------------------------------------------------------------------------

function loadJobAndCheckAccess(user, jobId) {
  const j = get('SELECT * FROM job_cards WHERE id = ?', jobId);
  if (!j || j.type !== 'fabrication') {
    const err = new Error('Fabrication job card not found.');
    err.status = 404;
    throw err;
  }
  const refusal = scope.jobReadRefusal(user, jobId);
  if (refusal) {
    const err = new Error(refusal.error || 'Job not found');
    err.status = refusal.status || 404;
    throw err;
  }
  return j;
}

/**
 * GET /costing/:jobId
 * Retrieve the Costing Sheet for a fabrication job, combining live actuals from
 * computeJobCost with estimates, adjustments, and overhead.
 */
router.get('/costing/:jobId', requireCap('fabrication.cost.view', 'fabrication.cost.edit', 'fabrication.view'), asyncHandler((req, res) => {
  const jobId = toInt(req.params.jobId);
  const job = loadJobAndCheckAccess(req.user, jobId);

  let sheet = get('SELECT * FROM fabrication_costing_sheets WHERE job_id = ?', jobId);
  if (!sheet) {
    // Return empty draft container
    const defaultOverheadRow = get("SELECT value FROM settings WHERE key = 'fabrication.default_overhead_rate'");
    const defaultOverhead = defaultOverheadRow ? parseFloat(defaultOverheadRow.value) || 0 : 0;
    sheet = {
      job_id: jobId,
      status: 'draft',
      estimated_materials: 0,
      estimated_labour: 0,
      estimated_total: 0,
      outside_quotation: 0,
      overhead_percentage: defaultOverhead,
      notes: null,
      adjustments: []
    };
  } else {
    sheet.adjustments = all('SELECT * FROM fabrication_costing_adjustments WHERE sheet_id = ? ORDER BY id ASC', sheet.id);
  }

  // Authoritative actuals computed from costing engine
  const computed = costing.computeJobCost(jobId);

  // Mask individual wage rates if caller lacks labour.rates.view
  const canSeeRates = isAdmin(req.user) || hasCap(req.user, 'labour.rates.view');
  const maskedLabourLines = (computed.labourLines || []).map((l) => ({
    ...l,
    rate: canSeeRates ? l.rate : null
  }));

  const adjustmentsTotal = (sheet.adjustments || []).reduce((sum, a) => sum + (a.amount || 0), 0);
  const actualSubtotal = computed.total_cost + adjustmentsTotal;
  const overheadAmount = Math.round((actualSubtotal * ((sheet.overhead_percentage || 0) / 100)) * 100) / 100;
  const actualTotalWithOverhead = Math.round((actualSubtotal + overheadAmount) * 100) / 100;

  // Variances
  const varianceVsEstimate = Math.round((sheet.estimated_total - actualTotalWithOverhead) * 100) / 100;
  const varianceVsOutside = sheet.outside_quotation > 0
    ? Math.round((sheet.outside_quotation - actualTotalWithOverhead) * 100) / 100
    : null;

  // Include preparer and approver names
  if (sheet.prepared_by) {
    const pu = get('SELECT username, full_name FROM users WHERE id = ?', sheet.prepared_by);
    sheet.preparer_name = pu ? (pu.full_name || pu.username) : null;
  }
  if (sheet.approved_by) {
    const au = get('SELECT username, full_name FROM users WHERE id = ?', sheet.approved_by);
    sheet.approver_name = au ? (au.full_name || au.username) : null;
  }
  if (sheet.rejected_by) {
    const rju = get('SELECT username, full_name FROM users WHERE id = ?', sheet.rejected_by);
    sheet.rejecter_name = rju ? (rju.full_name || rju.username) : null;
  }

  res.json({
    sheet,
    actuals: {
      material_cost: computed.material_cost,
      labour_cost: computed.labour_cost,
      oil_cost: computed.oil_cost,
      general_cost: computed.general_cost,
      field_cost: computed.field_cost,
      base_total: computed.total_cost,
      adjustments_total: adjustmentsTotal,
      overhead_amount: overheadAmount,
      actual_total: actualTotalWithOverhead,
      labour_lines: maskedLabourLines
    },
    variance: {
      vs_estimate: varianceVsEstimate,
      vs_outside: varianceVsOutside
    },
    job: {
      id: job.id,
      job_no: job.job_no,
      status: job.status,
      work_target: job.work_target,
      category: job.category,
      cost_centre: job.cost_centre,
      drawing_ref: job.drawing_ref,
      drawing_path: job.drawing_path,
      drawing_filename: job.drawing_filename,
      deliver_to: job.deliver_to
    }
  });
}));

/**
 * POST /costing/:jobId/save
 * Save costing sheet estimates, outside quotation, overhead, and notes (Draft status).
 */
router.post('/costing/:jobId/save', requireCap('fabrication.cost.edit'), asyncHandler((req, res) => {
  const jobId = toInt(req.params.jobId);
  const job = loadJobAndCheckAccess(req.user, jobId);

  let sheet = get('SELECT * FROM fabrication_costing_sheets WHERE job_id = ?', jobId);
  if (sheet && sheet.status === 'approved') {
    return res.status(400).json({ error: 'Cannot edit an already approved costing sheet.' });
  }

  const estMaterials = Math.max(0, Number(req.body.estimated_materials || 0));
  const estLabour = Math.max(0, Number(req.body.estimated_labour || 0));
  const estTotal = req.body.estimated_total != null ? Math.max(0, Number(req.body.estimated_total)) : (estMaterials + estLabour);
  const outsideQuote = Math.max(0, Number(req.body.outside_quotation || 0));
  const overheadPct = Math.max(0, Number(req.body.overhead_percentage != null ? req.body.overhead_percentage : 0));
  const notes = req.body.notes != null ? String(req.body.notes).trim() : (sheet ? sheet.notes : null);

  let sheetId;
  tx(() => {
    if (sheet) {
      run(
        `UPDATE fabrication_costing_sheets
            SET estimated_materials = ?, estimated_labour = ?, estimated_total = ?,
                outside_quotation = ?, overhead_percentage = ?, notes = ?,
                prepared_by = ?, prepared_at = datetime('now'), updated_at = datetime('now'),
                status = CASE WHEN status = 'rejected' THEN 'draft' ELSE status END
          WHERE id = ?`,
        estMaterials, estLabour, estTotal, outsideQuote, overheadPct, notes, req.user.id, sheet.id
      );
      sheetId = sheet.id;
    } else {
      const ins = run(
        `INSERT INTO fabrication_costing_sheets (job_id, status, estimated_materials, estimated_labour, estimated_total,
                                                outside_quotation, overhead_percentage, notes, prepared_by, prepared_at)
         VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        jobId, estMaterials, estLabour, estTotal, outsideQuote, overheadPct, notes, req.user.id
      );
      sheetId = ins.lastInsertRowid;
    }
  });

  audit.record({
    userId: req.user.id,
    entity: 'fabrication_costing_sheet',
    entityId: sheetId,
    action: 'save',
    after: { job_id: jobId, estimated_total: estTotal, outside_quotation: outsideQuote, overhead_percentage: overheadPct }
  });

  res.json({ ok: true, sheet: get('SELECT * FROM fabrication_costing_sheets WHERE id = ?', sheetId) });
}));

/**
 * POST /costing/:jobId/submit
 * Submit the costing sheet for managerial approval.
 */
router.post('/costing/:jobId/submit', requireCap('fabrication.cost.edit'), asyncHandler((req, res) => {
  const jobId = toInt(req.params.jobId);
  const job = loadJobAndCheckAccess(req.user, jobId);

  const sheet = get('SELECT * FROM fabrication_costing_sheets WHERE job_id = ?', jobId);
  if (!sheet) {
    return res.status(400).json({ error: 'Please save a draft of the costing sheet before submitting.' });
  }
  if (sheet.status === 'approved') {
    return res.status(400).json({ error: 'Costing sheet is already approved.' });
  }

  run(
    `UPDATE fabrication_costing_sheets
        SET status = 'submitted', submitted_at = datetime('now'), prepared_by = ?, updated_at = datetime('now')
      WHERE id = ?`,
    req.user.id, sheet.id
  );

  audit.record({
    userId: req.user.id,
    entity: 'fabrication_costing_sheet',
    entityId: sheet.id,
    action: 'submit',
    after: { status: 'submitted' }
  });

  res.json({ ok: true, message: 'Costing sheet submitted for approval.', sheet: get('SELECT * FROM fabrication_costing_sheets WHERE id = ?', sheet.id) });
}));

/**
 * POST /costing/:jobId/approve
 * Managerial approval of the fabrication costing sheet.
 * Enforces Segregation of Duties (SoD): Preparer cannot approve their own sheet.
 */
router.post('/costing/:jobId/approve', requireCap('fabrication.cost.approve'), asyncHandler((req, res) => {
  const jobId = toInt(req.params.jobId);
  const job = loadJobAndCheckAccess(req.user, jobId);

  const sheet = get('SELECT * FROM fabrication_costing_sheets WHERE job_id = ?', jobId);
  if (!sheet) {
    return res.status(400).json({ error: 'Costing sheet does not exist.' });
  }
  if (sheet.status === 'approved') {
    return res.status(409).json({ error: 'Costing sheet is already approved.' });
  }

  // Segregation of Duties: Preparer cannot approve own sheet
  if (sheet.prepared_by && sheet.prepared_by === req.user.id && !isAdmin(req.user)) {
    return res.status(403).json({
      error: 'Segregation of Duties violation: The person who prepared the costing sheet cannot approve it.'
    });
  }

  const signature = req.body.signature || null;

  tx(() => {
    run(
      `UPDATE fabrication_costing_sheets
          SET status = 'approved', approved_by = ?, approved_at = datetime('now'),
              rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL,
              updated_at = datetime('now')
        WHERE id = ?`,
      req.user.id, sheet.id
    );

    // Refresh job totals to incorporate approved adjustments and overhead into other_cost
    costing.refreshJobTotals(jobId);
  });

  audit.record({
    userId: req.user.id,
    entity: 'fabrication_costing_sheet',
    entityId: sheet.id,
    action: 'approve',
    after: { status: 'approved', approved_by: req.user.id }
  });

  res.json({
    ok: true,
    message: 'Fabrication Costing Sheet approved successfully.',
    sheet: get('SELECT * FROM fabrication_costing_sheets WHERE id = ?', sheet.id),
    job: get('SELECT id, job_no, total_cost, other_cost FROM job_cards WHERE id = ?', jobId)
  });
}));

/**
 * POST /costing/:jobId/reject
 * Reject a submitted costing sheet, returning it to the officer with a mandatory reason.
 */
router.post('/costing/:jobId/reject', requireCap('fabrication.cost.approve'), asyncHandler((req, res) => {
  const jobId = toInt(req.params.jobId);
  const job = loadJobAndCheckAccess(req.user, jobId);

  const sheet = get('SELECT * FROM fabrication_costing_sheets WHERE job_id = ?', jobId);
  if (!sheet) {
    return res.status(400).json({ error: 'Costing sheet does not exist.' });
  }
  if (sheet.status === 'approved') {
    return res.status(400).json({ error: 'Approved costing sheet cannot be rejected.' });
  }

  const reason = String(req.body.reason || req.body.rejection_reason || '').trim();
  if (!reason) {
    return res.status(400).json({ error: 'A rejection reason is mandatory.' });
  }

  run(
    `UPDATE fabrication_costing_sheets
        SET status = 'rejected', rejected_by = ?, rejected_at = datetime('now'),
            rejection_reason = ?, updated_at = datetime('now')
      WHERE id = ?`,
    req.user.id, reason, sheet.id
  );

  audit.record({
    userId: req.user.id,
    entity: 'fabrication_costing_sheet',
    entityId: sheet.id,
    action: 'reject',
    reason
  });

  res.json({ ok: true, message: 'Costing sheet rejected.', sheet: get('SELECT * FROM fabrication_costing_sheets WHERE id = ?', sheet.id) });
}));

// ---------------------------------------------------------------------------
// 5. Costing Adjustments (Non-stock purchases & outsourced work)
// ---------------------------------------------------------------------------

/**
 * POST /costing/:jobId/adjustments
 * Add a manual adjustment line (non-stock purchase, outsourced work, etc.).
 */
router.post('/costing/:jobId/adjustments', requireCap('fabrication.cost.edit'), asyncHandler((req, res) => {
  const jobId = toInt(req.params.jobId);
  const job = loadJobAndCheckAccess(req.user, jobId);

  let sheet = get('SELECT * FROM fabrication_costing_sheets WHERE job_id = ?', jobId);
  if (!sheet) {
    const ins = run("INSERT INTO fabrication_costing_sheets (job_id, status, prepared_by, prepared_at) VALUES (?, 'draft', ?, datetime('now'))", jobId, req.user.id);
    sheet = get('SELECT * FROM fabrication_costing_sheets WHERE id = ?', ins.lastInsertRowid);
  }
  if (sheet.status === 'approved') {
    return res.status(400).json({ error: 'Cannot add adjustments to an approved costing sheet.' });
  }

  const kind = String(req.body.kind || 'non_stock_purchase').trim();
  if (!['non_stock_purchase', 'outsourced_work', 'other'].includes(kind)) {
    return res.status(400).json({ error: 'kind must be non_stock_purchase, outsourced_work, or other' });
  }

  const description = String(req.body.description || '').trim();
  if (!description) return res.status(400).json({ error: 'Description is required.' });

  const amount = Number(req.body.amount || 0);
  if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero.' });

  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Reason for adjustment is required.' });

  const supplier = req.body.supplier_or_contractor ? String(req.body.supplier_or_contractor).trim() : null;
  const invoiceRef = req.body.invoice_ref ? String(req.body.invoice_ref).trim() : null;

  const result = run(
    `INSERT INTO fabrication_costing_adjustments (sheet_id, job_id, kind, description, amount, reason,
                                                 supplier_or_contractor, invoice_ref, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sheet.id, jobId, kind, description, amount, reason, supplier, invoiceRef, req.user.id
  );

  audit.record({
    userId: req.user.id,
    entity: 'fabrication_costing_adjustment',
    entityId: result.lastInsertRowid,
    action: 'create',
    after: { job_id: jobId, kind, description, amount, reason }
  });

  res.status(201).json(get('SELECT * FROM fabrication_costing_adjustments WHERE id = ?', result.lastInsertRowid));
}));

/**
 * DELETE /costing/adjustments/:adjustmentId
 * Delete an adjustment line.
 */
router.delete('/costing/adjustments/:adjustmentId', requireCap('fabrication.cost.edit'), asyncHandler((req, res) => {
  const adjId = toInt(req.params.adjustmentId);
  const adj = get('SELECT a.*, s.status FROM fabrication_costing_adjustments a JOIN fabrication_costing_sheets s ON s.id = a.sheet_id WHERE a.id = ?', adjId);
  if (!adj) return res.status(404).json({ error: 'Adjustment line not found.' });

  if (adj.status === 'approved') {
    return res.status(400).json({ error: 'Cannot delete adjustments from an approved costing sheet.' });
  }

  run('DELETE FROM fabrication_costing_adjustments WHERE id = ?', adjId);
  audit.record({
    userId: req.user.id,
    entity: 'fabrication_costing_adjustment',
    entityId: adjId,
    action: 'delete'
  });

  res.json({ ok: true, message: 'Adjustment line deleted.' });
}));

// ---------------------------------------------------------------------------
// 6. Fabrication Summary & Job Cards List
// ---------------------------------------------------------------------------

/**
 * GET /summary
 * High-level fabrication KPIs and distribution (General Works vs Vehicle Works).
 */
router.get('/summary', requireCap('fabrication.view'), asyncHandler((req, res) => {
  const fabClause = scope.fabricationClause(req.user, 'j');
  const countRow = get(`
    SELECT
      COUNT(*) AS total_cards,
      SUM(CASE WHEN j.status IN ('OPEN', 'IN_PROGRESS', 'WAITING_PARTS') THEN 1 ELSE 0 END) AS active_cards,
      SUM(CASE WHEN j.status = 'COMPLETED' OR j.status = 'CLOSED' THEN 1 ELSE 0 END) AS closed_cards,
      SUM(CASE WHEN j.work_target = 'general' THEN 1 ELSE 0 END) AS general_works_count,
      SUM(CASE WHEN j.work_target <> 'general' OR j.work_target IS NULL THEN 1 ELSE 0 END) AS vehicle_works_count,
      ROUND(COALESCE(SUM(j.total_cost), 0), 2) AS total_cost
    FROM job_cards j
    WHERE j.type = 'fabrication' ${fabClause ? ' AND ' + fabClause : ''}
  `);

  const categoriesDist = all(`
    SELECT COALESCE(j.category, 'unassigned') AS category, COUNT(*) AS count, ROUND(COALESCE(SUM(j.total_cost), 0), 2) AS cost
      FROM job_cards j
     WHERE j.type = 'fabrication' AND j.work_target = 'general' ${fabClause ? ' AND ' + fabClause : ''}
     GROUP BY j.category
  `);

  res.json({
    kpis: countRow || {
      total_cards: 0,
      active_cards: 0,
      closed_cards: 0,
      general_works_count: 0,
      vehicle_works_count: 0,
      total_cost: 0
    },
    by_category: categoriesDist
  });
}));

module.exports = router;
