'use strict';

/**
 * CCOM Outsourced Service & Repair Request PDF Generator
 *
 * Implements the company letterhead format for "REQUEST FOR REPAIR" addressed to C.COM
 * with dual signature blocks, watermark on unapproved revisions, and SHA256 document hashing.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pdfGenerator = require('./pdf_generator');
const { run, get } = require('../db');

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render the official C.COM Request for Repair / Service HTML
 */
function buildHtml(request, lines, approval = null, isDraft = true) {
  const isApproved = !isDraft && request.status !== 'draft' && request.status !== 'pending_approval' && request.status !== 'returned';

  const refNo = request.ref_no || `DRAFT-REQ-${request.id}`;
  const reqDate = (approval && approval.signed_at ? approval.signed_at.slice(0, 10) : (request.created_at || new Date().toISOString())).slice(0, 10);

  const parentJobNo = request.repair_job_no || request.job_no || (request.repair_job_id ? `JOB-${request.repair_job_id}` : `SRV-${request.service_record_id}`);

  // Vehicle Snapshot / Details
  let vehicleReg = request.asset_registration || request.reg_no || request.vehicle_label || '—';
  let vehicleMakeModel = request.asset_make_model || request.make_model || request.model_no || '—';
  let fleetNo = request.asset_code || request.fleet_no || '—';

  if (request.asset_snapshot) {
    try {
      const snap = JSON.parse(request.asset_snapshot);
      if (snap.registration) vehicleReg = snap.registration;
      if (snap.make || snap.model) vehicleMakeModel = `${snap.make || ''} ${snap.model || ''}`.trim();
      if (snap.code) fleetNo = snap.code;
    } catch (_) {}
  }

  const vendorName = request.vendor_name || 'C.COM (United Motors Lanka PLC)';
  const contactName = request.contact_person || request.vendor_contact_name || 'Service Desk';
  const engineerName = request.assigned_engineer_name || (approval ? approval.signed_name : null) || 'Mechanical Engineer';
  const requesterName = request.created_by_name || 'Store Keeper';

  const linesHtml = (lines && lines.length ? lines : [{ line_no: 1, description: 'Inspection and repair as informed', location: '', remarks: '' }])
    .map((l, idx) => `
      <tr>
        <td class="text-center" style="width: 14%;">${esc(parentJobNo)}</td>
        <td style="width: 48%; font-weight: 500;">${esc(l.description)}</td>
        <td style="width: 18%;">${esc(l.location || 'Site')}</td>
        <td style="width: 20%;">${esc(l.remarks || '—')}</td>
      </tr>
    `).join('');

  const meterDisplay = request.meter_reading != null ? `${request.meter_reading} ${request.meter_unit || 'hours'}` : '—';

  // Electronic Signature / Stamp for Approved by
  let signatureBlock = '';
  if (isApproved && approval) {
    if (approval.signature_data && approval.signature_data.startsWith('data:image')) {
      signatureBlock = `<img src="${approval.signature_data}" style="max-height: 48px; max-width: 180px; display: block; margin-bottom: 4px;" alt="Signature" />`;
    } else {
      signatureBlock = `
        <div class="e-signature-badge">
          <div style="font-size: 11px; font-weight: bold; color: #1e3a8a;">DIGITALLY APPROVED &amp; SIGNED</div>
          <div style="font-size: 9.5px; color: #475569;">${esc(approval.signed_name || engineerName)} · ${esc((approval.signed_at || '').slice(0, 16).replace('T', ' '))}</div>
        </div>
      `;
    }
  } else {
    signatureBlock = `<div style="height: 42px;"></div>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>REQUEST FOR REPAIR — ${esc(refNo)}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 14mm 15mm 15mm 15mm;
    }
    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 11.5pt;
      line-height: 1.45;
      color: #0f172a;
      margin: 0;
      padding: 0;
      position: relative;
    }
    ${isDraft ? `
    .draft-watermark {
      position: fixed;
      top: 38%;
      left: 8%;
      width: 84%;
      text-align: center;
      font-size: 46pt;
      font-weight: 800;
      color: rgba(220, 38, 38, 0.14);
      transform: rotate(-30deg);
      z-index: 9999;
      pointer-events: none;
      letter-spacing: 3px;
    }
    ` : ''}

    .letterhead {
      border-bottom: 2px solid #0f172a;
      padding-bottom: 10px;
      margin-bottom: 14px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    .company-title {
      font-size: 16pt;
      font-weight: 800;
      letter-spacing: 0.5px;
      color: #0f172a;
      margin: 0 0 2px 0;
    }
    .company-subtitle {
      font-size: 10.5pt;
      font-weight: 600;
      color: #334155;
      margin: 0;
    }
    .company-contacts {
      font-size: 8.5pt;
      color: #64748b;
      margin-top: 3px;
    }
    .doc-type-badge {
      text-align: right;
    }
    .doc-ref {
      font-size: 12pt;
      font-weight: 800;
      color: #1e3a8a;
    }
    .doc-name {
      font-size: 9pt;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #475569;
      font-weight: 600;
    }

    .meta-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;
      font-size: 10pt;
    }
    .meta-table td {
      padding: 3px 6px;
      vertical-align: top;
    }
    .meta-label {
      width: 14%;
      font-weight: 700;
      color: #334155;
    }
    .meta-val {
      width: 36%;
      color: #0f172a;
    }

    .sub-banner {
      background: #f8fafc;
      border-left: 4px solid #1e3a8a;
      padding: 6px 10px;
      margin: 12px 0 16px 0;
      font-weight: 700;
      font-size: 10.5pt;
    }

    .work-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 18px;
      font-size: 10pt;
    }
    .work-table th, .work-table td {
      border: 1px solid #cbd5e1;
      padding: 8px 10px;
    }
    .work-table th {
      background-color: #f1f5f9;
      font-weight: 700;
      color: #1e293b;
      text-transform: uppercase;
      font-size: 9pt;
      letter-spacing: 0.5px;
    }
    .text-center { text-align: center; }

    .attendance-box {
      border: 1px solid #e2e8f0;
      border-radius: 4px;
      background: #f8fafc;
      padding: 10px 14px;
      margin-bottom: 24px;
      font-size: 9.5pt;
    }
    .attendance-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      row-gap: 6px;
      column-gap: 20px;
    }

    .signature-section {
      display: table;
      width: 100%;
      margin-top: 28px;
      page-break-inside: avoid;
    }
    .sig-col {
      display: table-cell;
      width: 50%;
      vertical-align: top;
      padding-right: 15px;
    }
    .sig-col:last-child {
      padding-right: 0;
      padding-left: 15px;
    }
    .sig-title {
      font-weight: 700;
      font-size: 9.5pt;
      color: #475569;
      text-transform: uppercase;
      margin-bottom: 4px;
      border-bottom: 1px solid #cbd5e1;
      padding-bottom: 4px;
    }
    .sig-name {
      font-size: 10.5pt;
      font-weight: 700;
      color: #0f172a;
      margin-top: 4px;
    }
    .sig-desig {
      font-size: 9pt;
      color: #64748b;
    }
    .sig-date {
      font-size: 8.5pt;
      color: #64748b;
      margin-top: 2px;
    }
    .e-signature-badge {
      border: 1px dashed #3b82f6;
      background: #eff6ff;
      border-radius: 4px;
      padding: 4px 8px;
      margin-bottom: 4px;
      display: inline-block;
    }

    .footer-note {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      text-align: center;
      font-size: 8pt;
      color: #94a3b8;
      border-top: 1px solid #e2e8f0;
      padding-top: 6px;
    }
  </style>
</head>
<body>
  ${isDraft ? '<div class="draft-watermark">DRAFT — NOT APPROVED</div>' : ''}

  <div class="letterhead">
    <div>
      <h1 class="company-title">EDWARD &amp; CHRISTIE (PVT) LTD</h1>
      <div class="company-subtitle">Central Work Shop — Badalgama</div>
      <div class="company-contacts">Tel: 031-2253388 / 031-2253389 · Email: workshop@edwardchristie.com</div>
    </div>
    <div class="doc-type-badge">
      <div class="doc-name">Request for Repair / Service</div>
      <div class="doc-ref">${esc(refNo)}</div>
    </div>
  </div>

  <table class="meta-table">
    <tr>
      <td class="meta-label">TO:</td>
      <td class="meta-val"><b>${esc(vendorName)}</b></td>
      <td class="meta-label">DATE:</td>
      <td class="meta-val"><b>${esc(reqDate)}</b></td>
    </tr>
    <tr>
      <td class="meta-label">ATTN:</td>
      <td class="meta-val">${esc(contactName)}</td>
      <td class="meta-label">FROM:</td>
      <td class="meta-val">${esc(engineerName)}</td>
    </tr>
    <tr>
      <td class="meta-label">REGISTER NO:</td>
      <td class="meta-val"><b>${esc(vehicleReg)}</b></td>
      <td class="meta-label">FLEET NO:</td>
      <td class="meta-val"><b>${esc(fleetNo)}</b></td>
    </tr>
    <tr>
      <td class="meta-label">VEHICLE / MAKE:</td>
      <td class="meta-val" colspan="3">${esc(vehicleMakeModel)}</td>
    </tr>
  </table>

  <div class="sub-banner">
    SUB: REQUEST FOR OUTSOURCED REPAIR / SERVICE — ${esc(refNo)} (${esc(vehicleReg)})
  </div>

  <table class="work-table">
    <thead>
      <tr>
        <th class="text-center" style="width: 14%;">Job No</th>
        <th style="width: 48%;">Service &amp; Repair Description</th>
        <th style="width: 18%;">Location</th>
        <th style="width: 20%;">Remarks</th>
      </tr>
    </thead>
    <tbody>
      ${linesHtml}
    </tbody>
  </table>

  <div class="attendance-box">
    <div class="attendance-grid">
      <div><b>Current Meter Reading:</b> ${esc(meterDisplay)}</div>
      <div><b>Contact Number:</b> ${esc(request.contact_number || '—')}</div>
      <div><b>Site Contact Person:</b> ${esc(request.contact_name || '—')}</div>
      <div><b>Informed By:</b> ${esc(request.informed_by || '—')}</div>
    </div>
  </div>

  <div class="signature-section">
    <div class="sig-col">
      <div class="sig-title">REQUESTED BY</div>
      <div style="height: 38px;"></div>
      <div class="sig-name">${esc(requesterName)}</div>
      <div class="sig-desig">Store Keeper</div>
      <div class="sig-date">Date: ${esc((request.created_at || reqDate).slice(0, 10))}</div>
    </div>
    <div class="sig-col">
      <div class="sig-title">APPROVED BY</div>
      ${signatureBlock}
      <div class="sig-name">${esc(approval ? (approval.signed_name || engineerName) : engineerName)}</div>
      <div class="sig-desig">Mechanical Engineer</div>
      <div class="sig-date">Date: ${esc(approval && approval.signed_at ? approval.signed_at.slice(0, 10) : 'Pending')}</div>
    </div>
  </div>

  <div class="footer-note">
    Document Reference: ${esc(refNo)} · Generated from WorkshopOne System · Edward &amp; Christie Central Work Shop
  </div>
</body>
</html>`;
}

/**
 * Generate PDF buffer using headless Chrome / Edge
 */
async function generatePdf(request, lines, approval = null, isDraft = true) {
  const html = buildHtml(request, lines, approval, isDraft);
  return await pdfGenerator.generatePdfBuffer(html);
}

/**
 * Generate and permanently store the approved PDF on disk and in outsourcing_documents
 */
async function generateAndStoreApprovedPdf(request, lines, approval) {
  const isDraft = false;
  const pdfBuffer = await generatePdf(request, lines, approval, isDraft);

  const hash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
  const dir = path.join(process.cwd(), 'data', 'outsourcing');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const safeRef = (request.ref_no || `REQ-${request.id}`).replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${safeRef}_rev${approval.revision_id}.pdf`;
  const filePath = path.join(dir, filename);

  fs.writeFileSync(filePath, pdfBuffer);

  const docId = run(`
    INSERT INTO outsourcing_documents (request_id, revision_id, doc_type, file_path, file_hash, file_size)
    VALUES (?, ?, 'approved_request_pdf', ?, ?, ?)
  `, request.id, approval.revision_id, filePath, hash, pdfBuffer.length).lastInsertRowid;

  return get('SELECT * FROM outsourcing_documents WHERE id = ?', docId);
}

module.exports = {
  buildHtml,
  generatePdf,
  generateAndStoreApprovedPdf
};
