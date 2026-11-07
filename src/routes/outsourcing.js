'use strict';

/**
 * CCOM Outsourced Service & Repair Requests API Routes
 *
 * Mounts at /api/outsourcing
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { run, get, all, tx } = require('../db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const costing = require('../lib/costing');
const validation = require('../lib/outsourcing_validation');
const access = require('../lib/outsourcing_access');
const outsourcingPdf = require('../lib/outsourcing_pdf');
const mailOutbox = require('../lib/mail_outbox');
const scope = require('../lib/scope');

function requireCap(...caps) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.role === 'admin' || req.user.roles?.includes('admin')) return next();
    for (const c of caps) {
      if (access.hasCap(req.user, c)) return next();
    }
    return res.status(403).json({ error: `Permission denied: Requires capability '${caps.join("' or '")}'` });
  };
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------------------------------------------------------------------------
// 1. Vendors & Contacts
// ---------------------------------------------------------------------------

router.get('/vendors', requireCap('outsourcing.view', 'outsourcing.create'), asyncHandler(async (req, res) => {
  const vendors = all('SELECT * FROM outsourcing_vendors WHERE active = 1 ORDER BY id ASC');
  for (const v of vendors) {
    v.contacts = all('SELECT * FROM outsourcing_vendor_contacts WHERE vendor_id = ? AND active = 1 ORDER BY is_default DESC, name ASC', v.id);
  }
  res.json({ vendors });
}));

router.post('/vendors', requireCap('outsourcing.settings'), asyncHandler(async (req, res) => {
  const code = validation.sanitizeOneLine(req.body.code).toUpperCase();
  const name = validation.sanitizeOneLine(req.body.name);
  if (!code || !name) return res.status(400).json({ error: 'Vendor code and name are required' });

  const info = run(`
    INSERT INTO outsourcing_vendors (code, name, address, phone, email, notes, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `, code, name, validation.sanitizeOneLine(req.body.address), validation.sanitizeOneLine(req.body.phone),
     validation.sanitizeOneLine(req.body.email), validation.sanitizeOneLine(req.body.notes));

  audit.record({ userId: req.user.id, entity: 'outsourcing_vendor', entityId: info.lastInsertRowid, action: 'create', after: { code, name } });
  res.status(201).json(get('SELECT * FROM outsourcing_vendors WHERE id = ?', info.lastInsertRowid));
}));

router.post('/vendors/:id/contacts', requireCap('outsourcing.settings'), asyncHandler(async (req, res) => {
  const vendorId = Number(req.params.id);
  const v = get('SELECT id FROM outsourcing_vendors WHERE id = ?', vendorId);
  if (!v) return res.status(404).json({ error: 'Vendor not found' });

  const name = validation.sanitizeOneLine(req.body.name);
  const email = validation.clean(req.body.email);
  if (!name || !email || !validation.isValidEmail(email)) {
    return res.status(400).json({ error: 'Valid contact name and email address are required' });
  }

  const isDefault = req.body.is_default ? 1 : 0;
  if (isDefault) {
    run('UPDATE outsourcing_vendor_contacts SET is_default = 0 WHERE vendor_id = ?', vendorId);
  }

  const info = run(`
    INSERT INTO outsourcing_vendor_contacts (vendor_id, name, designation, email, phone, is_default, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `, vendorId, name, validation.sanitizeOneLine(req.body.designation), email, validation.sanitizeOneLine(req.body.phone), isDefault);

  res.status(201).json(get('SELECT * FROM outsourcing_vendor_contacts WHERE id = ?', info.lastInsertRowid));
}));

// ---------------------------------------------------------------------------
// 2. Engineer Approval Inbox
// ---------------------------------------------------------------------------

router.get('/approval-inbox', requireCap('outsourcing.approve'), asyncHandler(async (req, res) => {
  const isGlobalAdmin = req.user.role === 'admin' || req.user.roles?.includes('admin');
  let sql = `
    SELECT r.*,
           v.name AS vendor_name,
           u.full_name AS created_by_name,
           eng.full_name AS assigned_engineer_name,
           a.registration AS asset_registration,
           a.code AS asset_code,
           COALESCE(j.job_no, s.job_no) AS parent_job_no
      FROM outsourcing_requests r
      JOIN outsourcing_vendors v ON v.id = r.vendor_id
      JOIN users u ON u.id = r.created_by
      LEFT JOIN users eng ON eng.id = r.assigned_engineer_id
      LEFT JOIN assets a ON a.id = r.asset_id
      LEFT JOIN job_cards j ON j.id = r.repair_job_id
      LEFT JOIN service_jobs s ON s.id = r.service_record_id
     WHERE r.status = 'pending_approval'
  `;
  const params = [];
  if (!isGlobalAdmin) {
    sql += ` AND (r.assigned_engineer_id = ? OR r.assigned_engineer_id IS NULL)`;
    params.push(req.user.id);
  }
  sql += ` ORDER BY r.required_date ASC, r.id DESC`;

  const rows = all(sql, ...params);
  res.json({ requests: rows });
}));

// ---------------------------------------------------------------------------
// 3. Requests: List by Parent, Create Draft, Read, Edit
// ---------------------------------------------------------------------------

router.get('/requests', requireCap('outsourcing.view'), asyncHandler(async (req, res) => {
  const repairJobId = req.query.repair_job_id ? Number(req.query.repair_job_id) : null;
  const serviceRecId = req.query.service_record_id ? Number(req.query.service_record_id) : null;

  const clauses = [];
  const params = [];

  if (repairJobId || serviceRecId) {
    // Check parent access
    const pCheck = access.checkParentAccess(req.user, repairJobId ? 'repair' : 'service', repairJobId || serviceRecId);
    if (!pCheck.allowed) {
      return res.status(403).json({ error: pCheck.reason });
    }
    if (repairJobId) {
      clauses.push('r.repair_job_id = ?');
      params.push(repairJobId);
    } else {
      clauses.push('r.service_record_id = ?');
      params.push(serviceRecId);
    }
  } else {
    // Global register query: allow listing across jobs with appropriate scoping
    if (req.query.status && req.query.status !== 'all') {
      clauses.push('r.status = ?');
      params.push(req.query.status);
    }
    if (req.query.workshop_id) {
      clauses.push('r.workshop_id = ?');
      params.push(Number(req.query.workshop_id));
    } else {
      const own = scope.readFilter(req.user, 'r.workshop_id', 'job');
      if (own.sql) {
        clauses.push(own.sql);
        params.push(...own.params);
      }
    }
    if (req.query.asset_id) {
      clauses.push('r.asset_id = ?');
      params.push(Number(req.query.asset_id));
    }
    const canViewFab = req.user.role === 'admin' || req.user.roles?.includes('admin') || access.hasCap(req.user, 'fabrication.view');
    if (!canViewFab) {
      clauses.push("(j.type IS NULL OR j.type <> 'fabrication')");
    }
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = all(`
    SELECT r.*,
           v.name AS vendor_name,
           u.full_name AS created_by_name,
           eng.full_name AS assigned_engineer_name,
           a.registration AS asset_registration,
           a.code AS asset_code,
           COALESCE(j.job_no, s.job_no) AS parent_job_no,
           (SELECT COUNT(*) FROM outsourcing_request_lines WHERE request_id = r.id) AS lines_count,
           (SELECT id FROM outsourcing_documents WHERE request_id = r.id ORDER BY id DESC LIMIT 1) AS latest_document_id,
           (SELECT amount FROM outsourcing_cost_links WHERE request_id = r.id ORDER BY id DESC LIMIT 1) AS posted_invoice_amount,
           (SELECT invoice_no FROM outsourcing_cost_links WHERE request_id = r.id ORDER BY id DESC LIMIT 1) AS posted_invoice_no
      FROM outsourcing_requests r
      JOIN outsourcing_vendors v ON v.id = r.vendor_id
      JOIN users u ON u.id = r.created_by
      LEFT JOIN users eng ON eng.id = r.assigned_engineer_id
      LEFT JOIN assets a ON a.id = r.asset_id
      LEFT JOIN job_cards j ON j.id = r.repair_job_id
      LEFT JOIN service_jobs s ON s.id = r.service_record_id
     ${whereSql}
     ORDER BY r.id DESC
  `, ...params);

  res.json({ requests: rows });
}));

router.post('/requests', requireCap('outsourcing.create'), asyncHandler(async (req, res) => {
  const val = validation.validateDraftPayload(req.body);
  if (!val.valid) {
    return res.status(400).json({ error: val.errors.join(' ') });
  }

  const d = val.data;

  // Check parent access
  const parentType = d.repair_job_id ? 'repair' : 'service';
  const parentId = d.repair_job_id || d.service_record_id;
  const pCheck = access.checkParentAccess(req.user, parentType, parentId);
  if (!pCheck.allowed) {
    return res.status(403).json({ error: pCheck.reason });
  }

  // Resolve asset and snapshot
  let assetId = null;
  let assetSnapshot = null;
  let workshopId = null;

  if (d.repair_job_id) {
    const job = get('SELECT asset_id, workshop_id FROM job_cards WHERE id = ?', d.repair_job_id);
    if (job) {
      assetId = job.asset_id;
      workshopId = job.workshop_id;
    }
  } else if (d.service_record_id) {
    const srv = get('SELECT asset_id, workshop_id FROM service_jobs WHERE id = ?', d.service_record_id);
    if (srv) {
      assetId = srv.asset_id;
      workshopId = srv.workshop_id;
    }
  }

  if (assetId) {
    const a = get('SELECT * FROM assets WHERE id = ?', assetId);
    if (a) {
      assetSnapshot = JSON.stringify({
        id: a.id,
        code: a.code,
        registration: a.registration,
        brand: a.brand,
        model_no: a.model_no,
        yom: a.yom,
        type: a.type
      });
    }
  }

  const storeLocId = req.user.storeLocationId || (req.user.storeLocations && req.user.storeLocations[0]?.id) || null;

  const newId = tx(() => {
    const info = run(`
      INSERT INTO outsourcing_requests (
        repair_job_id, service_record_id, vendor_id, vendor_contact_id,
        assigned_engineer_id, request_type, required_date, priority,
        meter_reading, meter_unit, contact_name, contact_number,
        informed_by, status, version, created_by, store_location_id,
        workshop_id, asset_id, asset_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?, ?)
    `, d.repair_job_id, d.service_record_id, d.vendor_id, d.vendor_contact_id,
       d.assigned_engineer_id, d.request_type, d.required_date, d.priority,
       d.meter_reading, d.meter_unit, d.contact_name, d.contact_number,
       d.informed_by, req.user.id, storeLocId, workshopId, assetId, assetSnapshot);

    const reqId = info.lastInsertRowid;

    if (d.lines && d.lines.length) {
      for (const l of d.lines) {
        run(`
          INSERT INTO outsourcing_request_lines (request_id, line_no, description, location, remarks)
          VALUES (?, ?, ?, ?, ?)
        `, reqId, l.line_no, l.description, l.location, l.remarks);
      }
    }

    run(`
      INSERT INTO outsourcing_events (request_id, event_type, user_id, details_json)
      VALUES (?, 'created', ?, ?)
    `, reqId, req.user.id, JSON.stringify({ status: 'draft', request_type: d.request_type }));

    return reqId;
  });

  const created = get('SELECT * FROM outsourcing_requests WHERE id = ?', newId);
  audit.record({ userId: req.user.id, entity: 'outsourcing_request', entityId: newId, action: 'create', after: { status: 'draft', parentType, parentId } });
  res.status(201).json(created);
}));

router.get('/requests/:id', requireCap('outsourcing.view'), asyncHandler(async (req, res) => {
  const reqId = Number(req.params.id);
  const r = get(`
    SELECT r.*,
           v.name AS vendor_name,
           v.code AS vendor_code,
           vc.name AS vendor_contact_name,
           vc.email AS vendor_contact_email,
           u.full_name AS created_by_name,
           eng.full_name AS assigned_engineer_name,
           a.registration AS asset_registration,
           a.code AS asset_code,
           a.brand AS asset_make,
           a.model_no AS asset_model,
           COALESCE(j.job_no, s.job_no) AS parent_job_no
      FROM outsourcing_requests r
      JOIN outsourcing_vendors v ON v.id = r.vendor_id
      LEFT JOIN outsourcing_vendor_contacts vc ON vc.id = r.vendor_contact_id
      JOIN users u ON u.id = r.created_by
      LEFT JOIN users eng ON eng.id = r.assigned_engineer_id
      LEFT JOIN assets a ON a.id = r.asset_id
      LEFT JOIN job_cards j ON j.id = r.repair_job_id
      LEFT JOIN service_jobs s ON s.id = r.service_record_id
     WHERE r.id = ?
  `, reqId);

  if (!r) return res.status(404).json({ error: 'Outsourcing request not found' });
  if (!access.canViewRequest(req.user, r)) {
    return res.status(403).json({ error: 'Access denied to this outsourcing request' });
  }

  r.lines = all('SELECT * FROM outsourcing_request_lines WHERE request_id = ? ORDER BY line_no ASC, id ASC', reqId);
  r.revisions = all('SELECT id, revision_no, content_hash, submitted_by, submitted_at FROM outsourcing_revisions WHERE request_id = ? ORDER BY revision_no DESC', reqId);
  r.approvals = all('SELECT * FROM outsourcing_approvals WHERE request_id = ? ORDER BY id DESC', reqId);
  r.documents = all('SELECT * FROM outsourcing_documents WHERE request_id = ? ORDER BY id DESC', reqId);
  r.emails = all('SELECT * FROM outsourcing_email_outbox WHERE request_id = ? ORDER BY id DESC', reqId);
  r.cost_links = all('SELECT * FROM outsourcing_cost_links WHERE request_id = ? ORDER BY id DESC', reqId);

  res.json(r);
}));

router.patch('/requests/:id', requireCap('outsourcing.edit_draft'), asyncHandler(async (req, res) => {
  const reqId = Number(req.params.id);
  const r = get('SELECT * FROM outsourcing_requests WHERE id = ?', reqId);
  if (!r) return res.status(404).json({ error: 'Outsourcing request not found' });

  const eCheck = access.canEditDraft(req.user, r);
  if (!eCheck.allowed) {
    return res.status(403).json({ error: eCheck.reason });
  }

  const b = req.body;
  const d = {
    vendor_id: b.vendor_id ? Number(b.vendor_id) : r.vendor_id,
    vendor_contact_id: b.vendor_contact_id !== undefined ? (b.vendor_contact_id ? Number(b.vendor_contact_id) : null) : r.vendor_contact_id,
    assigned_engineer_id: b.assigned_engineer_id !== undefined ? (b.assigned_engineer_id ? Number(b.assigned_engineer_id) : null) : r.assigned_engineer_id,
    request_type: ['repair', 'service'].includes(b.request_type) ? b.request_type : r.request_type,
    required_date: b.required_date ? b.required_date.slice(0, 10) : r.required_date,
    priority: ['urgent', 'high', 'normal', 'low'].includes(b.priority) ? b.priority : r.priority,
    meter_reading: b.meter_reading !== undefined ? (b.meter_reading !== null ? Number(b.meter_reading) : null) : r.meter_reading,
    meter_unit: ['hours', 'km'].includes(b.meter_unit) ? b.meter_unit : r.meter_unit,
    contact_name: b.contact_name !== undefined ? validation.sanitizeOneLine(b.contact_name) : r.contact_name,
    contact_number: b.contact_number !== undefined ? validation.sanitizeOneLine(b.contact_number) : r.contact_number,
    informed_by: b.informed_by !== undefined ? validation.sanitizeOneLine(b.informed_by) : r.informed_by
  };

  tx(() => {
    run(`
      UPDATE outsourcing_requests
         SET vendor_id = ?, vendor_contact_id = ?, assigned_engineer_id = ?,
             request_type = ?, required_date = ?, priority = ?,
             meter_reading = ?, meter_unit = ?, contact_name = ?,
             contact_number = ?, informed_by = ?, version = version + 1,
             updated_at = datetime('now')
       WHERE id = ?
    `, d.vendor_id, d.vendor_contact_id, d.assigned_engineer_id,
       d.request_type, d.required_date, d.priority,
       d.meter_reading, d.meter_unit, d.contact_name,
       d.contact_number, d.informed_by, reqId);

    if (Array.isArray(b.lines)) {
      run('DELETE FROM outsourcing_request_lines WHERE request_id = ?', reqId);
      b.lines.forEach((l, i) => {
        const desc = validation.sanitizeOneLine(l.description);
        if (desc) {
          run(`
            INSERT INTO outsourcing_request_lines (request_id, line_no, description, location, remarks)
            VALUES (?, ?, ?, ?, ?)
          `, reqId, i + 1, desc, validation.sanitizeOneLine(l.location), validation.sanitizeOneLine(l.remarks));
        }
      });
    }

    run(`
      INSERT INTO outsourcing_events (request_id, event_type, user_id, details_json)
      VALUES (?, 'updated', ?, ?)
    `, reqId, req.user.id, JSON.stringify({ version: r.version + 1 }));
  });

  const updated = get('SELECT * FROM outsourcing_requests WHERE id = ?', reqId);
  res.json(updated);
}));

// ---------------------------------------------------------------------------
// 4. Submit for Engineer Review & Return
// ---------------------------------------------------------------------------

router.post('/requests/:id/submit', requireCap('outsourcing.submit'), asyncHandler(async (req, res) => {
  const reqId = Number(req.params.id);
  const r = get('SELECT * FROM outsourcing_requests WHERE id = ?', reqId);
  if (!r) return res.status(404).json({ error: 'Outsourcing request not found' });

  const lines = all('SELECT * FROM outsourcing_request_lines WHERE request_id = ? ORDER BY line_no ASC', reqId);
  const subCheck = validation.validateSubmission(r, lines);
  if (!subCheck.valid) {
    return res.status(400).json({ error: subCheck.errors.join(' ') });
  }

  // Generate reference number if not already allocated
  const year = new Date().getFullYear();
  let refNo = r.ref_no;

  tx(() => {
    if (!refNo) {
      const countRow = get("SELECT COUNT(*) c FROM outsourcing_requests WHERE ref_no LIKE ?", `CCOM-${year}-%`);
      const nextSeq = String((countRow ? countRow.c : 0) + 1).padStart(4, '0');
      refNo = `CCOM-${year}-${nextSeq}`;
    }

    // Freeze revision content
    const revCount = get('SELECT COUNT(*) c FROM outsourcing_revisions WHERE request_id = ?', reqId).c;
    const revNo = revCount + 1;

    const revisionContent = {
      request: { ...r, ref_no: refNo },
      lines
    };
    const contentJson = JSON.stringify(revisionContent);
    const contentHash = crypto.createHash('sha256').update(contentJson).digest('hex');

    const revId = run(`
      INSERT INTO outsourcing_revisions (request_id, revision_no, content_json, content_hash, submitted_by)
      VALUES (?, ?, ?, ?, ?)
    `, reqId, revNo, contentJson, contentHash, req.user.id).lastInsertRowid;

    run(`
      UPDATE outsourcing_requests
         SET ref_no = ?, status = 'pending_approval', current_revision_id = ?,
             version = version + 1, updated_at = datetime('now')
       WHERE id = ?
    `, refNo, revId, reqId);

    run(`
      INSERT INTO outsourcing_events (request_id, event_type, user_id, details_json)
      VALUES (?, 'submitted', ?, ?)
    `, reqId, req.user.id, JSON.stringify({ ref_no: refNo, revision_no: revNo, hash: contentHash }));
  });

  const submitted = get('SELECT * FROM outsourcing_requests WHERE id = ?', reqId);
  audit.record({ userId: req.user.id, entity: 'outsourcing_request', entityId: reqId, action: 'submit', after: { status: 'pending_approval', ref_no: refNo } });
  res.json({ ok: true, status: 'pending_approval', ref_no: refNo, request: submitted });
}));

router.post('/requests/:id/return', requireCap('outsourcing.approve'), asyncHandler(async (req, res) => {
  const reqId = Number(req.params.id);
  const r = get('SELECT * FROM outsourcing_requests WHERE id = ?', reqId);
  if (!r) return res.status(404).json({ error: 'Outsourcing request not found' });

  const appCheck = access.canApproveRequest(req.user, r);
  if (!appCheck.allowed) {
    return res.status(403).json({ error: appCheck.reason });
  }

  const reason = validation.sanitizeOneLine(req.body.reason || req.body.return_reason);
  if (!reason) {
    return res.status(400).json({ error: 'A clear reason is required when returning a request for correction' });
  }

  tx(() => {
    run(`
      INSERT INTO outsourcing_approvals (request_id, revision_id, engineer_id, decision, approval_note, signed_name)
      VALUES (?, ?, ?, 'returned', ?, ?)
    `, reqId, r.current_revision_id, req.user.id, reason, req.user.fullName || req.user.username);

    run(`
      UPDATE outsourcing_requests
         SET status = 'returned', version = version + 1, updated_at = datetime('now')
       WHERE id = ?
    `, reqId);

    run(`
      INSERT INTO outsourcing_events (request_id, event_type, user_id, details_json)
      VALUES (?, 'returned', ?, ?)
    `, reqId, req.user.id, JSON.stringify({ reason }));
  });

  audit.record({ userId: req.user.id, entity: 'outsourcing_request', entityId: reqId, action: 'return', after: { status: 'returned', reason } });
  res.json({ ok: true, status: 'returned', reason });
}));

// ---------------------------------------------------------------------------
// 5. Engineer Approval & E-Sign
// ---------------------------------------------------------------------------

router.post('/requests/:id/approve', asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const reqId = Number(req.params.id);
  const r = get('SELECT * FROM outsourcing_requests WHERE id = ?', reqId);
  if (!r) return res.status(404).json({ error: 'Outsourcing request not found' });

  const appCheck = access.canApproveRequest(req.user, r);
  if (!appCheck.allowed) {
    return res.status(403).json({ error: appCheck.reason });
  }

  // Re-authentication check
  const password = req.body.password;
  const isGlobalAdmin = req.user.role === 'admin' || req.user.roles?.includes('admin');
  if (!isGlobalAdmin && !access.verifyEngineerReauth(req.user, password)) {
    return res.status(401).json({ error: 'Re-authentication failed: Please enter your correct password to electronically sign this CCOM request.' });
  }

  const approvalNote = validation.sanitizeOneLine(req.body.approval_note) || 'Approved for C.COM inspection & repair';
  const signedName = req.user.fullName || req.user.username;
  const signatureData = req.user.signature || null;

  let approvalId = null;
  let approval = null;

  tx(() => {
    const appInfo = run(`
      INSERT INTO outsourcing_approvals (
        request_id, revision_id, engineer_id, decision, approval_note,
        signed_name, signature_data
      ) VALUES (?, ?, ?, 'approved', ?, ?, ?)
    `, reqId, r.current_revision_id, req.user.id, approvalNote, signedName, signatureData);

    approvalId = appInfo.lastInsertRowid;
    approval = get('SELECT * FROM outsourcing_approvals WHERE id = ?', approvalId);

    run(`
      UPDATE outsourcing_requests
         SET status = 'approved', version = version + 1, updated_at = datetime('now')
       WHERE id = ?
    `, reqId);

    run(`
      INSERT INTO outsourcing_events (request_id, event_type, user_id, details_json)
      VALUES (?, 'approved', ?, ?)
    `, reqId, req.user.id, JSON.stringify({ approval_id: approvalId, signed_name: signedName }));
  });

  // Generate and store PDF outside the synchronous SQLite transaction
  const lines = all('SELECT * FROM outsourcing_request_lines WHERE request_id = ? ORDER BY line_no ASC', reqId);
  const doc = await outsourcingPdf.generateAndStoreApprovedPdf(r, lines, approval);

  audit.record({ userId: req.user.id, entity: 'outsourcing_request', entityId: reqId, action: 'approve', after: { status: 'approved', signed_name: signedName } });
  res.json({ ok: true, status: 'approved', document: doc });
}));

// ---------------------------------------------------------------------------
// 6. Preview & PDF Download
// ---------------------------------------------------------------------------

router.get('/requests/:id/preview', requireCap('outsourcing.view'), asyncHandler(async (req, res) => {
  const reqId = Number(req.params.id);
  const r = get('SELECT * FROM outsourcing_requests WHERE id = ?', reqId);
  if (!r) return res.status(404).json({ error: 'Outsourcing request not found' });
  if (!access.canViewRequest(req.user, r)) return res.status(403).json({ error: 'Access denied' });

  const lines = all('SELECT * FROM outsourcing_request_lines WHERE request_id = ? ORDER BY line_no ASC', reqId);
  const approval = get("SELECT * FROM outsourcing_approvals WHERE request_id = ? AND decision = 'approved' ORDER BY id DESC LIMIT 1", reqId);
  const isDraft = r.status !== 'approved' && r.status !== 'sent' && r.status !== 'completed' && r.status !== 'closed';

  const html = outsourcingPdf.buildHtml(r, lines, approval, isDraft);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

router.get('/requests/:id/pdf', requireCap('outsourcing.view'), asyncHandler(async (req, res) => {
  const reqId = Number(req.params.id);
  const r = get('SELECT * FROM outsourcing_requests WHERE id = ?', reqId);
  if (!r) return res.status(404).json({ error: 'Outsourcing request not found' });
  if (!access.canViewRequest(req.user, r)) return res.status(403).json({ error: 'Access denied' });

  const lines = all('SELECT * FROM outsourcing_request_lines WHERE request_id = ? ORDER BY line_no ASC', reqId);
  const approval = get("SELECT * FROM outsourcing_approvals WHERE request_id = ? AND decision = 'approved' ORDER BY id DESC LIMIT 1", reqId);
  const isDraft = r.status !== 'approved' && r.status !== 'sent' && r.status !== 'completed' && r.status !== 'closed';

  // If approved and stored on disk, serve exact bytes
  const doc = get('SELECT * FROM outsourcing_documents WHERE request_id = ? ORDER BY id DESC LIMIT 1', reqId);
  if (!isDraft && doc && doc.file_path && fs.existsSync(doc.file_path)) {
    const safeFilename = `${(r.ref_no || `REQ-${r.id}`).replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    return fs.createReadStream(doc.file_path).pipe(res);
  }

  // Otherwise generate live
  const buf = await outsourcingPdf.generatePdf(r, lines, approval, isDraft);
  const safeFilename = `${(r.ref_no || `REQ-${r.id}`).replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
}));

// ---------------------------------------------------------------------------
// 7. Email Outbox & Dispatch
// ---------------------------------------------------------------------------

router.post('/requests/:id/send', requireCap('outsourcing.send'), asyncHandler(async (req, res) => {
  const reqId = Number(req.params.id);
  const r = get('SELECT * FROM outsourcing_requests WHERE id = ?', reqId);
  if (!r) return res.status(404).json({ error: 'Outsourcing request not found' });

  if (r.status !== 'approved' && r.status !== 'sent') {
    return res.status(400).json({ error: `Only approved requests can be emailed to C.COM (current status: '${r.status}')` });
  }

  const val = validation.validateEmailPayload(req.body);
  if (!val.valid) {
    return res.status(400).json({ error: val.errors.join(' ') });
  }

  const doc = get('SELECT * FROM outsourcing_documents WHERE request_id = ? ORDER BY id DESC LIMIT 1', reqId);
  if (!doc) {
    return res.status(400).json({ error: 'No approved PDF document exists for this request' });
  }

  const outbox = mailOutbox.queueEmail({
    requestId: reqId,
    documentId: doc.id,
    to: val.data.to,
    cc: val.data.cc,
    subject: val.data.subject,
    body: val.data.body,
    userId: req.user.id,
    idempotencyKey: req.body.idempotency_key
  });

  // Process dispatch
  const processed = await mailOutbox.processOutboxItem(outbox.id);
  audit.record({ userId: req.user.id, entity: 'outsourcing_email', entityId: outbox.id, action: 'send', after: { to: val.data.to, status: processed.status } });
  res.json({ ok: true, outbox: processed });
}));

router.get('/requests/:id/emails', requireCap('outsourcing.send', 'outsourcing.view'), asyncHandler(async (req, res) => {
  const reqId = Number(req.params.id);
  const emails = all('SELECT * FROM outsourcing_email_outbox WHERE request_id = ? ORDER BY id DESC', reqId);
  res.json({ emails });
}));

// ---------------------------------------------------------------------------
// 8. Work Progress & Completion Verification
// ---------------------------------------------------------------------------

router.post('/requests/:id/progress', requireCap('outsourcing.record_progress'), asyncHandler(async (req, res) => {
  const reqId = Number(req.params.id);
  const r = get('SELECT * FROM outsourcing_requests WHERE id = ?', reqId);
  if (!r) return res.status(404).json({ error: 'Outsourcing request not found' });

  const status = clean(req.body.status) || 'in_progress';
  if (!['acknowledged', 'in_progress', 'completed'].includes(status)) {
    return res.status(400).json({ error: "Invalid progress status. Must be 'acknowledged', 'in_progress', or 'completed'." });
  }

  const notes = validation.sanitizeOneLine(req.body.notes);

  tx(() => {
    run(`
      UPDATE outsourcing_requests
         SET status = ?, version = version + 1, updated_at = datetime('now')
       WHERE id = ?
    `, status, reqId);

    run(`
      INSERT INTO outsourcing_events (request_id, event_type, user_id, details_json)
      VALUES (?, 'progress_update', ?, ?)
    `, reqId, req.user.id, JSON.stringify({ status, notes }));
  });

  audit.record({ userId: req.user.id, entity: 'outsourcing_request', entityId: reqId, action: 'progress', after: { status, notes } });
  res.json({ ok: true, status });
}));

router.post('/requests/:id/verify-completion', requireCap('outsourcing.verify_completion'), asyncHandler(async (req, res) => {
  const reqId = Number(req.params.id);
  const r = get('SELECT * FROM outsourcing_requests WHERE id = ?', reqId);
  if (!r) return res.status(404).json({ error: 'Outsourcing request not found' });

  const notes = validation.sanitizeOneLine(req.body.verification_note) || 'Work completed and verified by Mechanical Engineer';

  tx(() => {
    run(`
      UPDATE outsourcing_requests
         SET status = 'completed', version = version + 1, updated_at = datetime('now')
       WHERE id = ?
    `, reqId);

    run(`
      INSERT INTO outsourcing_events (request_id, event_type, user_id, details_json)
      VALUES (?, 'completion_verified', ?, ?)
    `, reqId, req.user.id, JSON.stringify({ notes }));
  });

  audit.record({ userId: req.user.id, entity: 'outsourcing_request', entityId: reqId, action: 'verify_completion', after: { status: 'completed', notes } });
  res.json({ ok: true, status: 'completed', notes });
}));

// ---------------------------------------------------------------------------
// 9. Cost Posting to Parent Job/Service
// ---------------------------------------------------------------------------

router.post('/requests/:id/post-cost', requireCap('outsourcing.cost.post'), asyncHandler(async (req, res) => {
  const reqId = Number(req.params.id);
  const r = get('SELECT * FROM outsourcing_requests WHERE id = ?', reqId);
  if (!r) return res.status(404).json({ error: 'Outsourcing request not found' });

  const invoiceNo = validation.sanitizeOneLine(req.body.invoice_no);
  const invoiceDate = req.body.invoice_date ? req.body.invoice_date.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const amount = Number(req.body.amount);

  if (!invoiceNo) return res.status(400).json({ error: 'Invoice number is required' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invoice amount must be greater than 0' });

  // Prevent duplicate posting
  const existingPosting = get('SELECT id FROM outsourcing_cost_links WHERE request_id = ? AND posted_to_parent = 1', reqId);
  if (existingPosting) {
    return res.status(400).json({ error: 'An authoritative cost posting has already been recorded for this CCOM request' });
  }

  let costType = '';
  const now = new Date().toISOString();

  tx(() => {
    if (r.repair_job_id) {
      costType = 'job_cards_external_cost';
      // Post to job_cards.external_cost and refresh totals
      const job = get('SELECT external_cost, total_cost FROM job_cards WHERE id = ?', r.repair_job_id);
      if (job) {
        const newExt = Math.round(((job.external_cost || 0) + amount) * 100) / 100;
        const newTot = Math.round(((job.total_cost || 0) + amount) * 100) / 100;
        run("UPDATE job_cards SET external_cost = ?, total_cost = ?, updated_at = datetime('now') WHERE id = ?", newExt, newTot, r.repair_job_id);
      }
    } else if (r.service_record_id) {
      costType = 'service_jobs_outside_estimate';
      // Post to service_jobs.outside_estimate and grand_total
      const srv = get('SELECT outside_estimate, grand_total FROM service_jobs WHERE id = ?', r.service_record_id);
      if (srv) {
        const newEst = Math.round(((srv.outside_estimate || 0) + amount) * 100) / 100;
        const newGrand = Math.round(((srv.grand_total || 0) + amount) * 100) / 100;
        run('UPDATE service_jobs SET outside_estimate = ?, grand_total = ? WHERE id = ?', newEst, newGrand, r.service_record_id);
      }
    }

    run(`
      INSERT INTO outsourcing_cost_links (
        request_id, invoice_no, invoice_date, amount, posted_to_parent,
        parent_cost_type, posted_by, posted_at, notes
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
    `, reqId, invoiceNo, invoiceDate, amount, costType, req.user.id, now, validation.sanitizeOneLine(req.body.notes));

    run(`
      UPDATE outsourcing_requests
         SET status = 'closed', version = version + 1, updated_at = datetime('now')
       WHERE id = ?
    `, reqId);

    run(`
      INSERT INTO outsourcing_events (request_id, event_type, user_id, details_json)
      VALUES (?, 'cost_posted', ?, ?)
    `, reqId, req.user.id, JSON.stringify({ invoice_no: invoiceNo, amount, cost_type: costType }));
  });

  audit.record({ userId: req.user.id, entity: 'outsourcing_request', entityId: reqId, action: 'post_cost', after: { invoiceNo, amount, costType } });
  res.json({ ok: true, status: 'closed', invoice_no: invoiceNo, amount, cost_type: costType });
}));

// ---------------------------------------------------------------------------
// 10. Cancellation & Events
// ---------------------------------------------------------------------------

router.post('/requests/:id/cancel', requireCap('outsourcing.cancel'), asyncHandler(async (req, res) => {
  const reqId = Number(req.params.id);
  const r = get('SELECT * FROM outsourcing_requests WHERE id = ?', reqId);
  if (!r) return res.status(404).json({ error: 'Outsourcing request not found' });

  if (['closed', 'cancelled'].includes(r.status)) {
    return res.status(400).json({ error: `Cannot cancel request in '${r.status}' state` });
  }

  const reason = validation.sanitizeOneLine(req.body.reason);
  if (!reason) return res.status(400).json({ error: 'A cancellation reason is required' });

  const now = new Date().toISOString();
  tx(() => {
    run(`
      UPDATE outsourcing_requests
         SET status = 'cancelled', cancellation_reason = ?, cancelled_by = ?,
             cancelled_at = ?, version = version + 1, updated_at = datetime('now')
       WHERE id = ?
    `, reason, req.user.id, now, reqId);

    run(`
      INSERT INTO outsourcing_events (request_id, event_type, user_id, details_json)
      VALUES (?, 'cancelled', ?, ?)
    `, reqId, req.user.id, JSON.stringify({ reason }));
  });

  audit.record({ userId: req.user.id, entity: 'outsourcing_request', entityId: reqId, action: 'cancel', after: { status: 'cancelled', reason } });
  res.json({ ok: true, status: 'cancelled', reason });
}));

router.get('/requests/:id/events', requireCap('outsourcing.view'), asyncHandler(async (req, res) => {
  const reqId = Number(req.params.id);
  const events = all(`
    SELECT e.*, u.full_name AS user_name, u.username
      FROM outsourcing_events e
      LEFT JOIN users u ON u.id = e.user_id
     WHERE e.request_id = ?
     ORDER BY e.id ASC
  `, reqId);
  res.json({ events });
}));

function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

module.exports = router;
