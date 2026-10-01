'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-doc-test-'));
process.env.DB_PATH = path.join(TMP, 'test_docs.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const {
  renderMrnDocumentHtml,
  renderGrnDocumentHtml,
  renderMinDocumentHtml,
  renderMtnDocumentHtml,
} = require('../src/lib/stores_documents');
const { generatePdfBuffer } = require('../src/lib/pdf_generator');

migrate();

// Set up test roles and admin user
for (const n of ['admin', 'workshop', 'manager', 'storekeeper', 'operational_manager']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Role ' + n);
}
const adminId = run(
  'INSERT INTO users (username, full_name, password_hash, active) VALUES (?, ?, ?, 1)',
  'admin_test', 'System Administrator', auth.hashPassword('pass123')
).lastInsertRowid;
for (const r of ['admin', 'manager', 'storekeeper']) {
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', adminId, r);
}

const reqMock = { ip: '127.0.0.1', headers: { 'user-agent': 'node-test' } };
const session = auth.createSession(adminId, reqMock);

test('Stores 4-Document Lifecycle: HTML Rendering & Form Layouts', async (t) => {
  // 1. Seed Asset, Project, Job Card
  const assetId = run('INSERT INTO assets (code, code_norm, registration, status) VALUES (?, ?, ?, ?)', 'CAT-320D', 'CAT320D', 'WP-CAT-01', 'active').lastInsertRowid;
  const projId = run('INSERT INTO projects (code, name) VALUES (?, ?)', 'PRJ-01', 'Central Expressway Section 2').lastInsertRowid;
  const jobId = run('INSERT INTO job_cards (job_no, asset_id, type, description, status) VALUES (?, ?, ?, ?, ?)', '2026/9/R/888', assetId, 'repair', 'Hydraulic Overhaul', 'IN_PROGRESS').lastInsertRowid;

  // 2. MRN Document EC1.ST.FO.01
  const mrnId = run(
    `INSERT INTO mrn (mrn_no, req_date, requested_by, requested_sig, certified_by, certified_sig, certified_at, approved_by, approved_sig, approved_at, approval_status, asset_id, project_id, job_id, purpose)
     VALUES (?, date('now'), 'Sunil Perera', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'Eng. Bandara', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', datetime('now'), 'G. Fernando', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', datetime('now'), 'approved', ?, ?, ?, 'Hydraulic overhaul parts')`,
    '165789', assetId, projId, jobId
  ).lastInsertRowid;

  run(`INSERT INTO mrn_lines (mrn_id, description, qty, unit, qty_received) VALUES (?, 'Hydraulic Hose 1/2 inch', 4, 'nos', 2)`, mrnId);
  run(`INSERT INTO mrn_lines (mrn_id, description, qty, unit, qty_received) VALUES (?, 'Seal Kit Boom Cylinder', 2, 'sets', 0)`, mrnId);

  const mrnHtml = renderMrnDocumentHtml(mrnId);
  assert.ok(mrnHtml, 'renderMrnDocumentHtml should return HTML');
  assert.ok(mrnHtml.includes('Doc. No.: EC1.ST.FO.01'), 'MRN must contain ISO quality code EC1.ST.FO.01');
  assert.ok(mrnHtml.includes('Issue No.: 04'), 'MRN must specify Issue No.: 04');
  assert.ok(mrnHtml.includes('Date of Issue: 2018.11.14'), 'MRN must specify ISO issue date 2018.11.14');
  assert.ok(mrnHtml.includes('165789'), 'MRN must show MR No. 165789');
  assert.ok(mrnHtml.includes('Hydraulic Hose 1/2 inch'), 'MRN must include line items');
  assert.ok(mrnHtml.includes('Sunil Perera'), 'MRN must include Requested By');
  assert.ok(mrnHtml.includes('Eng. Bandara'), 'MRN must include Certified By');
  assert.ok(mrnHtml.includes('G. Fernando'), 'MRN must include Approved By');

  // 3. GRN Document EC1.ST.FO.2:5:21.12
  const grnVoucherId = run(
    `INSERT INTO grn_vouchers (grn_no, received_date, supplier, project_site, po_no, invoice_no, delivery_note_no, bin_card_page, prepared_by, approved_by, status)
     VALUES (?, date('now'), 'United Tractors & Equipment', 'Central Workshop — Badalgama', 'PO-2026-99', 'INV-5544', 'DN-9988', 'BC-42', 'Nimal Silva', 'Eng. Bandara', 'received')`,
    '1451'
  ).lastInsertRowid;

  const grnLineId = run(
    `INSERT INTO grn (voucher_id, grn_no, delivery_date, supplier, po_no, invoice_no, delivery_note_no, bin_card_page, description, qty, unit, unit_price, mrn_id)
     VALUES (?, '1451', date('now'), 'United Tractors & Equipment', 'PO-2026-99', 'INV-5544', 'DN-9988', 'BC-42', 'Hydraulic Hose 1/2 inch', 2, 'nos', 8500, ?)`,
    grnVoucherId, mrnId
  ).lastInsertRowid;

  const grnHtml = renderGrnDocumentHtml(grnVoucherId);
  assert.ok(grnHtml, 'renderGrnDocumentHtml should return HTML');
  assert.ok(grnHtml.includes('Doc. No.: EC1.ST.FO.2:5:21.12'), 'GRN must contain ISO quality code EC1.ST.FO.2:5:21.12');
  assert.ok(grnHtml.includes('Nawala Road, Nugegoda'), 'GRN must contain company registered address');
  assert.ok(grnHtml.includes('1451'), 'GRN must show GRN No 1451');
  assert.ok(grnHtml.includes('United Tractors &amp; Equipment'), 'GRN must show Supplier');
  assert.ok(grnHtml.includes('PO-2026-99'), 'GRN must show PO No');
  assert.ok(grnHtml.includes('DN-9988'), 'GRN must show Delivery Note No');
  assert.ok(grnHtml.includes('8,500.00'), 'GRN must show Unit Price');

  // 4. MIN Document EC1.ST.FO.04
  const minNoteId = run(
    `INSERT INTO min_notes (min_no, issue_date, project_id, asset_id, job_id, purpose, requested_by, approved_by, received_by, status)
     VALUES (?, date('now'), ?, ?, ?, 'Job No 2026/9/R/888 - Hydraulic overhaul', 'K. Jayatissa', 'Sunil Perera', 'M. Fitter', 'issued')`,
    '2799', projId, assetId, jobId
  ).lastInsertRowid;

  run(
    `INSERT INTO issues (min_id, min_no, asset_id, job_id, description, qty, unit, unit_price, issue_date, issued_by, purpose)
     VALUES (?, '2799', ?, ?, 'Hydraulic Hose 1/2 inch', 2, 'nos', 8500, date('now'), 'Sunil Perera', 'Installed on boom cylinder')`,
    minNoteId, assetId, jobId
  );

  const minHtml = renderMinDocumentHtml(minNoteId);
  assert.ok(minHtml, 'renderMinDocumentHtml should return HTML');
  assert.ok(minHtml.includes('Doc. No.: EC1.ST.FO.04'), 'MIN must contain ISO quality code EC1.ST.FO.04');
  assert.ok(minHtml.includes('Issue No.: 03'), 'MIN must specify Issue No.: 03');
  assert.ok(minHtml.includes('Date of Issue: 2018.01.26'), 'MIN must specify ISO issue date 2018.01.26');
  assert.ok(minHtml.includes('2799'), 'MIN must show MIN No. 2799');
  assert.ok(minHtml.includes('Hydraulic Hose 1/2 inch'), 'MIN must show item');
  assert.ok(minHtml.includes('17,000.00'), 'MIN must calculate total value 2 * 8500 = 17,000.00');
  assert.ok(minHtml.includes('K. Jayatissa'), 'MIN must show Requested By');
  assert.ok(minHtml.includes('Sunil Perera'), 'MIN must show Approved By');
  assert.ok(minHtml.includes('M. Fitter'), 'MIN must show Received By');

  // 5. MTN Document EC1.ST.FO.05
  const mtnId = run(
    `INSERT INTO mtn (mtn_no, txn_date, from_location, to_location, mr_no, transferred_by, prepared_by, approved_by, received_by, accepted_by, status)
     VALUES (?, date('now'), 'Central Workshop Badalgama', 'Peliyagoda Yard', '165789', 'Sunil Perera', 'Sunil Perera', 'Eng. Bandara', 'A. Driver', 'S. Destination Storekeeper', 'dispatched')`,
    '73851'
  ).lastInsertRowid;

  run(
    `INSERT INTO mtn_lines (mtn_id, line_no, description, qty, unit, value, mr_no, remarks)
     VALUES (?, 1, 'Excavator Bucket Tooth 1.2m3', 6, 'nos', 45000, '165789', 'Transferred for urgent site requirement')`,
    mtnId
  );

  const mtnHtml = renderMtnDocumentHtml(mtnId);
  assert.ok(mtnHtml, 'renderMtnDocumentHtml should return HTML');
  assert.ok(mtnHtml.includes('Doc. No.: EC1.ST.FO.05'), 'MTN must contain ISO quality code EC1.ST.FO.05');
  assert.ok(mtnHtml.includes('Issue No.: 04'), 'MTN must specify Issue No.: 04');
  assert.ok(mtnHtml.includes('Date of Issue: 2018.07.25'), 'MTN must specify ISO issue date 2018.07.25');
  assert.ok(mtnHtml.includes('73851'), 'MTN must show MTN No. 73851');
  assert.ok(mtnHtml.includes('Excavator Bucket Tooth'), 'MTN must show transferred item');
  assert.ok(mtnHtml.includes('Central Workshop Badalgama'), 'MTN must show Transferred From');
  assert.ok(mtnHtml.includes('Peliyagoda Yard'), 'MTN must show Transferred To');
  assert.ok(mtnHtml.includes('Prepared By'), 'MTN must have Prepared By block');
  assert.ok(mtnHtml.includes('Approved By'), 'MTN must have Approved By block');
  assert.ok(mtnHtml.includes('Received By'), 'MTN must have Received By block');
  assert.ok(mtnHtml.includes('Accepted By'), 'MTN must have Accepted By block');
});

test('Stores 4-Document Lifecycle: Headless Print-to-PDF Conversion', async () => {
  const sampleHtml = renderMrnDocumentHtml('165789', { forPdf: true });
  assert.ok(sampleHtml, 'Must generate HTML for PDF');

  const pdfBuf = await generatePdfBuffer(sampleHtml);
  assert.ok(Buffer.isBuffer(pdfBuf), 'Result should be a binary buffer');
  assert.ok(pdfBuf.length > 5000, `PDF should be of realistic size (>5KB), got ${pdfBuf.length} bytes`);
  assert.strictEqual(pdfBuf.slice(0, 4).toString(), '%PDF', 'PDF buffer must start with %PDF magic header');
});

test('Stores Approval Processes: GRN, MIN, and MTN Approval Lifecycle', async () => {
  // Test GRN Approval & Rejection
  const grnVoucher = run(
    `INSERT INTO grn_vouchers (grn_no, received_date, supplier, prepared_by, status)
     VALUES (?, date('now'), 'Auto Parts Lanka', 'Storekeeper Perera', 'pending_approval')`,
    'GRN-APPR-01'
  ).lastInsertRowid;

  // Insert initial prepare approval entry
  run(`INSERT INTO grn_approvals (voucher_id, stage, role, approver_id, signed_name, decision, reason)
       VALUES (?, 'prepare', 'storekeeper', ?, 'Storekeeper Perera', 'approved', 'Goods received in good order')`,
    grnVoucher, adminId);

  // Approve GRN
  run(`UPDATE grn_vouchers SET status = 'approved', approved_by = 'Eng. Bandara', approved_sig = 'data:image/png;base64,sig', approved_at = datetime('now') WHERE id = ?`, grnVoucher);
  run(`INSERT INTO grn_approvals (voucher_id, stage, role, approver_id, signed_name, signature, decision, reason)
       VALUES (?, 'approve', 'manager', ?, 'Eng. Bandara', 'data:image/png;base64,sig', 'approved', 'Verified and approved')`,
    grnVoucher, adminId);

  const updatedGrn = get('SELECT * FROM grn_vouchers WHERE id = ?', grnVoucher);
  assert.strictEqual(updatedGrn.status, 'approved', 'GRN status must be approved');
  assert.strictEqual(updatedGrn.approved_by, 'Eng. Bandara');

  const grnApprovals = all('SELECT * FROM grn_approvals WHERE voucher_id = ? ORDER BY id', grnVoucher);
  assert.strictEqual(grnApprovals.length, 2, 'Must have 2 approval records: prepare and approve');
  assert.strictEqual(grnApprovals[0].stage, 'prepare');
  assert.strictEqual(grnApprovals[1].stage, 'approve');

  // Test MIN 3-Tier Lifecycle
  const minNote = run(
    `INSERT INTO min_notes (min_no, issue_date, purpose, requested_by, status)
     VALUES (?, date('now'), 'Emergency brake overhaul', 'Store Clerk Silva', 'requested')`,
    'MIN-APPR-01'
  ).lastInsertRowid;

  run(`INSERT INTO min_approvals (min_id, stage, role, approver_id, signed_name, decision, reason)
       VALUES (?, 'request', 'storekeeper', ?, 'Store Clerk Silva', 'approved', 'Brake pads requested')`,
    minNote, adminId);

  // Stage 2: Engineer Approves
  run(`UPDATE min_notes SET status = 'approved', approved_by = 'Foreman Kamal', approved_sig = 'data:image/png;base64,sig', approved_at = datetime('now') WHERE id = ?`, minNote);
  run(`INSERT INTO min_approvals (min_id, stage, role, approver_id, signed_name, signature, decision, reason)
       VALUES (?, 'approve', 'workshop', ?, 'Foreman Kamal', 'data:image/png;base64,sig', 'approved', 'Brake overhaul approved')`,
    minNote, adminId);

  // Stage 3: Mechanic signs receipt & hand over
  run(`UPDATE min_notes SET status = 'issued', received_by = 'Mechanic Bandara', received_sig = 'data:image/png;base64,sig', received_at = datetime('now') WHERE id = ?`, minNote);
  run(`INSERT INTO min_approvals (min_id, stage, role, approver_id, signed_name, signature, decision, reason)
       VALUES (?, 'receive', 'mechanic', ?, 'Mechanic Bandara', 'data:image/png;base64,sig', 'approved', 'Parts physically received')`,
    minNote, adminId);

  const updatedMin = get('SELECT * FROM min_notes WHERE id = ?', minNote);
  assert.strictEqual(updatedMin.status, 'issued');
  assert.strictEqual(updatedMin.approved_by, 'Foreman Kamal');
  assert.strictEqual(updatedMin.received_by, 'Mechanic Bandara');

  const minApprovals = all('SELECT * FROM min_approvals WHERE min_id = ? ORDER BY id', minNote);
  assert.strictEqual(minApprovals.length, 3, 'MIN must record all 3 lifecycle stages: request, approve, receive');

  // Test MTN 4-Stage Custody Chain Lifecycle
  const mtn = run(
    `INSERT INTO mtn (mtn_no, txn_date, from_location, to_location, transferred_by, status)
     VALUES (?, date('now'), 'Central Store', 'Site Colombo', 'Storekeeper Nimal', 'draft')`,
    'MTN-APPR-01'
  ).lastInsertRowid;

  // Stage 1: Approve
  run(`UPDATE mtn SET status = 'approved', approved_by = 'Store In-Charge Wickrama', approved_sig = 'sig1', approved_at = datetime('now') WHERE id = ?`, mtn);
  run(`INSERT INTO mtn_approvals (mtn_id, stage, role, approver_id, signed_name, signature, decision) VALUES (?, 'approve', 'manager', ?, 'Store In-Charge Wickrama', 'sig1', 'approved')`, mtn, adminId);

  // Stage 2: Dispatch
  run(`UPDATE mtn SET status = 'dispatched', received_by = 'Driver Silva', received_sig = 'sig2', received_at = datetime('now') WHERE id = ?`, mtn);
  run(`INSERT INTO mtn_approvals (mtn_id, stage, role, approver_id, signed_name, signature, decision) VALUES (?, 'dispatch', 'driver', ?, 'Driver Silva', 'sig2', 'approved')`, mtn, adminId);

  // Stage 3: Receive
  run(`UPDATE mtn SET status = 'received' WHERE id = ?`, mtn);
  run(`INSERT INTO mtn_approvals (mtn_id, stage, role, approver_id, signed_name, decision) VALUES (?, 'receive', 'storekeeper', ?, 'Dest Clerk Fernando', 'approved')`, mtn, adminId);

  // Stage 4: Accept & Bin
  run(`UPDATE mtn SET status = 'accepted', accepted_by = 'Dest Storekeeper Fernando', accepted_sig = 'sig3', accepted_at = datetime('now') WHERE id = ?`, mtn);
  run(`INSERT INTO mtn_approvals (mtn_id, stage, role, approver_id, signed_name, signature, decision) VALUES (?, 'accept', 'storekeeper', ?, 'Dest Storekeeper Fernando', 'sig3', 'approved')`, mtn, adminId);

  const updatedMtn = get('SELECT * FROM mtn WHERE id = ?', mtn);
  assert.strictEqual(updatedMtn.status, 'accepted');
  assert.strictEqual(updatedMtn.approved_by, 'Store In-Charge Wickrama');
  assert.strictEqual(updatedMtn.received_by, 'Driver Silva');
  assert.strictEqual(updatedMtn.accepted_by, 'Dest Storekeeper Fernando');

  const mtnApprovals = all('SELECT * FROM mtn_approvals WHERE mtn_id = ? ORDER BY id', mtn);
  assert.strictEqual(mtnApprovals.length, 4, 'MTN must have all 4 custody transfer stages logged');
  assert.deepStrictEqual(mtnApprovals.map(a => a.stage), ['approve', 'dispatch', 'receive', 'accept']);
});

test('Stores 4-Document Stepper Progress & Document Counts Verification', () => {
  // 1. Verify GRN Voucher creation with multiple line items directly
  const vres = run(
    `INSERT INTO grn_vouchers (grn_no, received_date, supplier, po_no, invoice_no, delivery_note_no, status)
     VALUES (?, date('now'), 'United Motors Lanka', 'PO-9001', 'INV-5501', 'DN-101', 'pending_approval')`,
    'GRN-TEST-ITEMS-01'
  );
  const vid = vres.lastInsertRowid;

  const item1 = run(
    `INSERT INTO grn (voucher_id, grn_no, description, qty, unit, unit_price, status)
     VALUES (?, 'GRN-TEST-ITEMS-01', 'Fuel Filter Element', 4, 'nos', 1250, 'pending_approval')`,
    vid
  ).lastInsertRowid;

  const item2 = run(
    `INSERT INTO grn (voucher_id, grn_no, description, qty, unit, unit_price, status)
     VALUES (?, 'GRN-TEST-ITEMS-01', 'Engine Oil 15W40', 20, 'ltrs', NULL, 'pending_approval')`,
    vid
  ).lastInsertRowid;

  const linked = all('SELECT * FROM grn WHERE voucher_id = ?', vid);
  assert.strictEqual(linked.length, 2, 'Must have 2 items linked to the GRN voucher');

  // 2. Count queries for GRN
  const grnToPrice = get(`SELECT COUNT(*) c FROM grn WHERE unit_price IS NULL`).c;
  assert.ok(grnToPrice >= 1, 'At least 1 item awaiting price');

  const grnPendingApp = get(`SELECT COUNT(*) c FROM grn WHERE status = 'pending_approval'`).c;
  assert.ok(grnPendingApp >= 2, 'Pending approval items present');

  // 3. Count queries for MIN (Issues)
  const minToApprove = get(`SELECT COUNT(*) c FROM min_notes WHERE status IN ('pending_approval', 'requested')`).c;
  assert.ok(typeof minToApprove === 'number');

  // 4. Count queries for MTN (Transfers)
  const mtnFlight = get(`SELECT COUNT(*) c FROM mtn WHERE status NOT IN ('accepted', 'rejected')`).c;
  assert.ok(typeof mtnFlight === 'number');

  // 5. Count queries for MRN
  const mrnTotal = get('SELECT COUNT(*) c FROM mrn').c;
  assert.ok(typeof mrnTotal === 'number');
});

