'use strict';

/**
 * ===========================================================================
 * Vehicle Documents & Statutory Renewal Monitoring Test Suite (Phase 1 & 2)
 *
 * Validates:
 * 1. Asia/Colombo timezone date & 1-calendar-month calculation rules.
 * 2. Document status evaluation and badge generation across all lifecycle states.
 * 3. Document container initialization (linking to assets) and history retrieval.
 * 4. Version lifecycle: Draft -> Verification -> Immutable Historical Record.
 * 5. Physical attachments: SHA-256 hashing, MIME validation, immutable once verified.
 * 6. Future-dated renewals: verified ahead without interrupting current active coverage.
 * 7. eRL Revenue Licence preparation checklist evaluator (light vs heavy commercial).
 * 8. Formal exemptions for laid-up / off-road fleet units.
 * 9. Renewal tasks tracking and automatic completion on approval.
 * 10. Fleet compliance summary KPIs and upcoming expirations aggregation.
 * ===========================================================================
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-vdocs-'));
process.env.DB_PATH = path.join(TMP, 'vdocs.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const vdocs = require('../src/lib/vehicle_documents');
const capabilities = require('../src/lib/capabilities');

migrate();

// 1. Seed Roles & Capabilities
run("INSERT OR IGNORE INTO roles (name, label) VALUES ('transport_manager', 'Transport Manager')");
run("INSERT OR IGNORE INTO roles (name, label) VALUES ('operational_manager', 'Operational Manager')");
run("INSERT OR IGNORE INTO roles (name, label) VALUES ('workshop', 'Workshop User')");
capabilities.seedCapabilities();

// 2. Seed Users
run("INSERT OR IGNORE INTO users (id, username, password_hash, full_name, active) VALUES (1, 'admin', 'hash', 'System Admin', 1)");
run("INSERT OR IGNORE INTO users (id, username, password_hash, full_name, active) VALUES (2, 'tm_user', 'hash', 'Transport Manager', 1)");
const adminUser = { id: 1, username: 'admin', roles: ['admin'] };
const tmUser = { id: 2, username: 'tm_user', roles: ['transport_manager'] };

// 3. Seed Test Fleet Assets
// Asset 1: Heavy Commercial Lorry (requires Fitness Certificate)
run(`INSERT OR IGNORE INTO assets (id, code, code_norm, registration, brand, type, asset_class, status)
    VALUES (101, 'TR-01', 'TR01', 'WP NA-1001', 'ISUZU', 'Lorry', 'vehicle', 'active')`);

// Asset 2: Light Double Cab (does NOT require Fitness Certificate)
run(`INSERT OR IGNORE INTO assets (id, code, code_norm, registration, brand, type, asset_class, status)
    VALUES (102, 'CB-01', 'CB01', 'WP CAB-2002', 'TOYOTA', 'Double Cab', 'vehicle', 'active')`);

// ---------------------------------------------------------------------------
// TEST 1: Date & Time Calculation in Asia/Colombo (UTC+5:30)
// ---------------------------------------------------------------------------
test('Date helpers follow Asia/Colombo and 1-calendar-month rule', () => {
  const colomboToday = vdocs.getColomboToday();
  assert.match(colomboToday, /^\d{4}-\d{2}-\d{2}$/, 'Returns YYYY-MM-DD');

  const colomboNow = vdocs.getColomboNow();
  assert.match(colomboNow, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'Returns YYYY-MM-DD HH:mm:ss');

  // Days difference
  assert.strictEqual(vdocs.calculateDaysRemaining('2026-10-15', '2026-10-08'), 7);
  assert.strictEqual(vdocs.calculateDaysRemaining('2026-10-08', '2026-10-08'), 0);
  assert.strictEqual(vdocs.calculateDaysRemaining('2026-10-01', '2026-10-08'), -7);

  // 1-Calendar-Month rule
  assert.strictEqual(vdocs.calculateOneMonthBefore('2026-11-08'), '2026-10-08');
  assert.strictEqual(vdocs.calculateOneMonthBefore('2026-03-31'), '2026-02-28', 'Clamps to Feb 28 in non-leap year');
  assert.strictEqual(vdocs.calculateOneMonthBefore('2024-03-31'), '2024-02-29', 'Clamps to Feb 29 in leap year');
  assert.strictEqual(vdocs.calculateOneMonthBefore('2026-01-15'), '2025-12-15', 'Handles year wrap-around');
  assert.strictEqual(vdocs.calculateOneMonthBefore('2026-05-31'), '2026-04-30', 'Clamps to 30 days in April');
});

// ---------------------------------------------------------------------------
// TEST 2: Status & Badge Evaluator
// ---------------------------------------------------------------------------
test('Status evaluator correctly categorizes document states and assigns badges', () => {
  const today = '2026-10-08';

  // 1. Missing version
  const missingEval = vdocs.evaluateDocStatus({ is_exempt: 0 }, null, { today });
  assert.strictEqual(missingEval.status, 'missing');
  assert.strictEqual(missingEval.badge.text, 'Missing');
  assert.strictEqual(missingEval.badge.level, 'danger');
  assert.strictEqual(missingEval.needs_action, true);

  // 2. Exempt
  const exemptEval = vdocs.evaluateDocStatus({ is_exempt: 1 }, null, { today });
  assert.strictEqual(exemptEval.status, 'exempt');
  assert.strictEqual(exemptEval.badge.text, 'Exempt');
  assert.strictEqual(exemptEval.badge.level, 'exempt');
  assert.strictEqual(exemptEval.needs_action, false);

  // 3. Expired
  const expiredEval = vdocs.evaluateDocStatus({ is_exempt: 0 }, { status: 'verified', valid_until: '2026-10-01' }, { today });
  assert.strictEqual(expiredEval.status, 'expired');
  assert.strictEqual(expiredEval.days_remaining, -7);
  assert.strictEqual(expiredEval.badge.text, 'Expired (7d ago)');
  assert.strictEqual(expiredEval.needs_action, true);

  // 4. Expires today
  const todayEval = vdocs.evaluateDocStatus({ is_exempt: 0 }, { status: 'verified', valid_until: '2026-10-08' }, { today });
  assert.strictEqual(todayEval.status, 'expires_today');
  assert.strictEqual(todayEval.badge.text, 'Expires Today');

  // 5. Critical (<= 7 days)
  const critEval = vdocs.evaluateDocStatus({ is_exempt: 0 }, { status: 'verified', valid_until: '2026-10-13' }, { today });
  assert.strictEqual(critEval.status, 'critical');
  assert.strictEqual(critEval.days_remaining, 5);
  assert.strictEqual(critEval.badge.level, 'critical');

  // 6. Expiring soon (8-14 days)
  const soonEval = vdocs.evaluateDocStatus({ is_exempt: 0 }, { status: 'verified', valid_until: '2026-10-20' }, { today });
  assert.strictEqual(soonEval.status, 'expiring_soon');
  assert.strictEqual(soonEval.badge.level, 'warning');

  // 7. Due for renewal (15-30 days)
  const dueEval = vdocs.evaluateDocStatus({ is_exempt: 0 }, { status: 'verified', valid_until: '2026-11-05' }, { today });
  assert.strictEqual(dueEval.status, 'due_for_renewal');
  assert.strictEqual(dueEval.badge.level, 'info');

  // 8. Valid (> 30 days)
  const validEval = vdocs.evaluateDocStatus({ is_exempt: 0 }, { status: 'verified', valid_until: '2027-10-08' }, { today });
  assert.strictEqual(validEval.status, 'valid');
  assert.strictEqual(validEval.badge.level, 'ok');
  assert.strictEqual(validEval.needs_action, false);
});

// ---------------------------------------------------------------------------
// TEST 3: Document Container Initialization & Retrieval
// ---------------------------------------------------------------------------
test('ensureVehicleDocuments initializes statutory document containers for an asset', () => {
  vdocs.ensureVehicleDocuments(101);
  const docs = vdocs.getVehicleDocuments(101);
  assert.ok(docs.length >= 7, 'Seeded with all 7 standard statutory & company document types');

  const codes = docs.map((d) => d.doc_type_code);
  assert.ok(codes.includes('cr'), 'Has Certificate of Registration');
  assert.ok(codes.includes('revenue_licence'), 'Has Revenue Licence');
  assert.ok(codes.includes('insurance'), 'Has Insurance');
  assert.ok(codes.includes('emission'), 'Has Emission Test');
  assert.ok(codes.includes('fitness'), 'Has Fitness Certificate');
  assert.ok(codes.includes('permit'), 'Has Permit');
  assert.ok(codes.includes('company_doc'), 'Has Company Document');
});

// ---------------------------------------------------------------------------
// TEST 4: Draft Version Creation, Attachments & Immutability
// ---------------------------------------------------------------------------
test('Draft version creation, physical file attachments, SHA-256 and immutability', () => {
  const docs = vdocs.getVehicleDocuments(101);
  const rlDoc = docs.find((d) => d.doc_type_code === 'revenue_licence');
  assert.ok(rlDoc, 'Found Revenue Licence container');

  // 1. Create draft renewal version
  const draftVer = vdocs.createDraftVersion(rlDoc.id, {
    doc_number: 'RL-WP-2026-999',
    issuer_name: 'DMT Western Province',
    issue_date: '2026-10-08',
    valid_from: '2026-10-09',
    valid_until: '2027-10-08',
    cost_amount: 14500,
    status: 'draft'
  }, tmUser);

  assert.strictEqual(draftVer.version_no, 1);
  assert.strictEqual(draftVer.doc_number, 'RL-WP-2026-999');
  assert.strictEqual(draftVer.status, 'draft');

  // 2. Add PDF attachment
  const samplePdfBuffer = Buffer.from('%PDF-1.4 Fake PDF Content for Test Purposes');
  const att = vdocs.addAttachment(draftVer.id, {
    originalFilename: 'licence_scan.pdf',
    mimeType: 'application/pdf',
    buffer: samplePdfBuffer,
    kind: 'certificate'
  }, tmUser);

  assert.ok(att.id, 'Attachment inserted');
  assert.strictEqual(att.mime_type, 'application/pdf');
  assert.strictEqual(att.file_size, samplePdfBuffer.length);
  assert.strictEqual(att.sha256.length, 64, 'SHA-256 computed');

  const fetchedAtt = vdocs.getAttachment(att.id);
  assert.strictEqual(fetchedAtt.exists_on_disk, true, 'Physical file saved to disk');

  // 3. Add second attachment (receipt image)
  const sampleImgBuffer = Buffer.from('Fake PNG Image Bytes');
  const att2 = vdocs.addAttachment(draftVer.id, {
    originalFilename: 'receipt.png',
    mimeType: 'image/png',
    buffer: sampleImgBuffer,
    kind: 'receipt'
  }, tmUser);
  assert.ok(att2.id);

  // 4. Delete attachment 2 while still in draft (should succeed)
  const delRes = vdocs.deleteAttachment(att2.id, tmUser);
  assert.strictEqual(delRes.ok, true);
  assert.strictEqual(vdocs.getAttachment(att2.id), null);

  // 5. Update draft version fields
  const updatedVer = vdocs.updateDraftVersion(draftVer.id, {
    doc_number: 'RL-WP-2026-999-REVISED',
    cost_amount: 15200,
    status: 'pending_verification'
  }, tmUser);
  assert.strictEqual(updatedVer.doc_number, 'RL-WP-2026-999-REVISED');
  assert.strictEqual(updatedVer.cost_amount, 15200);
  assert.strictEqual(updatedVer.status, 'pending_verification');
});

// ---------------------------------------------------------------------------
// TEST 5: Manager Verification, Immediate Promotion & Immutability Lock
// ---------------------------------------------------------------------------
test('Manager verification promotes version to current and locks attachments from deletion', () => {
  const docs = vdocs.getVehicleDocuments(101);
  const rlDoc = docs.find((d) => d.doc_type_code === 'revenue_licence');
  const history = vdocs.getDocumentHistory(rlDoc.id);
  const pendingVer = history[0];

  // Make valid_from <= today so it takes effect immediately upon approval
  vdocs.updateDraftVersion(pendingVer.id, { valid_from: '2026-10-01' }, tmUser);

  // Manager approves
  const verifiedVer = vdocs.verifyVersion(pendingVer.id, {
    decision: 'approve',
    notes: 'Verified against DMT Western Province eRL portal receipt'
  }, adminUser);

  assert.strictEqual(verifiedVer.status, 'verified');
  assert.strictEqual(verifiedVer.verified_by, adminUser.id);
  assert.ok(verifiedVer.verified_at);

  // Verify container pointer updated
  const updatedDoc = vdocs.getDocumentById(rlDoc.id);
  assert.strictEqual(updatedDoc.current_version_id, pendingVer.id, 'Promoted to current_version_id');

  // Verify attachments are now IMMUTABLE
  const attList = vdocs.getDocumentHistory(rlDoc.id)[0].attachments;
  assert.ok(attList.length > 0);
  assert.throws(() => {
    vdocs.deleteAttachment(attList[0].id, tmUser);
  }, /immutable/i, 'Deleting attachment from verified document must throw error');

  // Verify updating verified version is blocked
  assert.throws(() => {
    vdocs.updateDraftVersion(pendingVer.id, { doc_number: 'TAMPERED' }, tmUser);
  }, /immutable/i, 'Updating verified version must throw error');
});

// ---------------------------------------------------------------------------
// TEST 6: Future-Dated Renewal Promotion Engine
// ---------------------------------------------------------------------------
test('Future-dated renewal stays verified ahead without replacing active coverage until valid_from', () => {
  const docs = vdocs.getVehicleDocuments(101);
  const insDoc = docs.find((d) => d.doc_type_code === 'insurance');

  // Version 1: Current active policy expiring on 2026-10-31
  const v1 = vdocs.createDraftVersion(insDoc.id, {
    doc_number: 'POL-SLIC-2025',
    issue_date: '2025-10-01',
    valid_from: '2025-11-01',
    valid_until: '2026-10-31',
    cost_amount: 85000,
    status: 'draft'
  }, tmUser);
  vdocs.verifyVersion(v1.id, { decision: 'approve' }, adminUser);

  // Check current version is V1
  let curIns = vdocs.getVehicleDocuments(101).find((d) => d.doc_type_code === 'insurance');
  assert.strictEqual(curIns.current_version_id, v1.id);

  // Version 2: Future renewal policy starting 2026-11-01
  const v2 = vdocs.createDraftVersion(insDoc.id, {
    doc_number: 'POL-SLIC-2026-RENEWED',
    issue_date: '2026-10-05',
    valid_from: '2026-11-01',
    valid_until: '2027-10-31',
    cost_amount: 92000,
    status: 'pending_verification'
  }, tmUser);
  vdocs.verifyVersion(v2.id, { decision: 'approve' }, adminUser);

  // V2 is verified ahead, but current_version_id must STILL BE V1 because today is 2026-10-08!
  curIns = vdocs.getVehicleDocuments(101, { today: '2026-10-08' }).find((d) => d.doc_type_code === 'insurance');
  assert.strictEqual(curIns.current_version_id, v1.id, 'Active coverage remains V1');
  assert.strictEqual(curIns.future_version.id, v2.id, 'V2 recognized as future coverage');

  // Trigger checkAndPromoteFutureVersions as of 2026-11-01
  const promoted = vdocs.checkAndPromoteFutureVersions('2026-11-01');
  assert.ok(promoted.includes(v2.id), 'V2 promoted once valid_from reached');

  // Verify container updated and V1 superseded
  curIns = vdocs.getDocumentById(insDoc.id);
  assert.strictEqual(curIns.current_version_id, v2.id, 'V2 is now current_version_id');
  const v1Post = get('SELECT status FROM vehicle_doc_versions WHERE id = ?', v1.id);
  assert.strictEqual(v1Post.status, 'superseded', 'V1 marked superseded');
});

// ---------------------------------------------------------------------------
// TEST 7: eRL Revenue Licence Readiness Checklist Evaluator
// ---------------------------------------------------------------------------
test('eRL checklist evaluator correctly checks CR, previous RL, Insurance, Emission, and Fitness', () => {
  // Asset 101 is heavy commercial ('Lorry')
  // Initially missing CR, Emission, and Fitness
  const checklistInitial = vdocs.evaluateErlChecklist(101, { targetDate: '2026-10-08' });
  assert.strictEqual(checklistInitial.ready_for_renewal, false);
  assert.ok(checklistInitial.blockers.length > 0);

  // Set up Certificate of Registration (CR)
  const docs = vdocs.getVehicleDocuments(101);
  const crDoc = docs.find((d) => d.doc_type_code === 'cr');
  const crVer = vdocs.createDraftVersion(crDoc.id, {
    doc_number: 'CR-DMT-1001',
    issue_date: '2018-05-10',
    valid_from: '2018-05-10',
    valid_until: '9999-12-31',
    status: 'draft'
  }, tmUser);
  vdocs.verifyVersion(crVer.id, { decision: 'approve' }, adminUser);

  // Set up Emission Certificate
  const emDoc = docs.find((d) => d.doc_type_code === 'emission');
  const emVer = vdocs.createDraftVersion(emDoc.id, {
    doc_number: 'EM-CLEANCO-777',
    issue_date: '2026-10-01',
    valid_from: '2026-10-01',
    valid_until: '2027-10-01',
    cost_amount: 3200
  }, tmUser);
  vdocs.verifyVersion(emVer.id, { decision: 'approve' }, adminUser);

  // Set up Fitness Certificate for Asset 101 (Heavy commercial)
  const fitDoc = docs.find((d) => d.doc_type_code === 'fitness');
  const fitVer = vdocs.createDraftVersion(fitDoc.id, {
    doc_number: 'FIT-DMT-888',
    issue_date: '2026-10-01',
    valid_from: '2026-10-01',
    valid_until: '2027-10-01',
    cost_amount: 5500
  }, tmUser);
  vdocs.verifyVersion(fitVer.id, { decision: 'approve' }, adminUser);

  // Now all prerequisites for Asset 101 are met!
  const checklistComplete = vdocs.evaluateErlChecklist(101, { targetDate: '2026-10-08' });
  assert.strictEqual(checklistComplete.ready_for_renewal, true);
  assert.strictEqual(checklistComplete.blockers.length, 0);

  // Test Asset 102 (Light vehicle Double Cab) - Fitness is exempt/not required
  const checklistLight = vdocs.evaluateErlChecklist(102, { targetDate: '2026-10-08' });
  const fitnessItem = checklistLight.items.find((i) => i.key === 'fitness');
  assert.strictEqual(fitnessItem.required, false, 'Fitness is not required for light Double Cab');
  assert.strictEqual(fitnessItem.passed, true);
});

// ---------------------------------------------------------------------------
// TEST 8: Formal Laid-up Fleet Exemptions
// ---------------------------------------------------------------------------
test('Formal exemptions mark document exempt and log audit trail', () => {
  const docs = vdocs.getVehicleDocuments(102);
  const rlDoc = docs.find((d) => d.doc_type_code === 'revenue_licence');

  // Mark exempt (e.g. laid up for complete engine overhaul)
  const exemptDoc = vdocs.setExemption(rlDoc.id, {
    isExempt: true,
    reason: 'Vehicle laid up for 6 months for complete engine rebuild'
  }, tmUser);

  assert.strictEqual(exemptDoc.is_exempt, 1);
  assert.strictEqual(exemptDoc.exemption_reason, 'Vehicle laid up for 6 months for complete engine rebuild');

  const reloadedDocs = vdocs.getVehicleDocuments(102);
  const reloadedRl = reloadedDocs.find((d) => d.id === rlDoc.id);
  assert.strictEqual(reloadedRl.evaluation.status, 'exempt');
  assert.strictEqual(reloadedRl.evaluation.badge.text, 'Exempt');
  assert.strictEqual(reloadedRl.evaluation.needs_action, false);

  // Un-exempt
  const unexemptDoc = vdocs.setExemption(rlDoc.id, { isExempt: false }, tmUser);
  assert.strictEqual(unexemptDoc.is_exempt, 0);
  assert.strictEqual(unexemptDoc.exemption_reason, null);
});

// ---------------------------------------------------------------------------
// TEST 9: Renewal Tasks Management & Workflow Progression
// ---------------------------------------------------------------------------
test('Renewal tasks track workflow stages and complete automatically on verification', () => {
  const docs = vdocs.getVehicleDocuments(102);
  const insDoc = docs.find((d) => d.doc_type_code === 'insurance');

  // 1. Create renewal task
  const task = vdocs.createRenewalTask(insDoc.id, {
    stage: 'assigned',
    assigned_to: tmUser.id,
    target_date: '2026-10-25',
    estimated_cost: 75000,
    checklist_json: { quote_received: true }
  }, adminUser);

  assert.ok(task.id);
  assert.strictEqual(task.stage, 'assigned');

  // 2. Advance stage to application_submitted
  const updatedTask = vdocs.updateRenewalTask(task.id, {
    stage: 'application_submitted',
    actual_cost: 72000,
    temporary_receipt_no: 'RCP-INS-555'
  }, tmUser);
  assert.strictEqual(updatedTask.stage, 'application_submitted');
  assert.strictEqual(updatedTask.actual_cost, 72000);

  // 3. Submit renewal version and link task
  const newVer = vdocs.createDraftVersion(insDoc.id, {
    doc_number: 'POL-CAB-2026',
    issue_date: '2026-10-08',
    valid_from: '2026-10-08',
    valid_until: '2027-10-08',
    cost_amount: 72000,
    task_id: task.id
  }, tmUser);

  // 4. Verify version -> task must automatically complete
  vdocs.verifyVersion(newVer.id, { decision: 'approve' }, adminUser);

  const finalTask = get('SELECT * FROM vehicle_renewal_tasks WHERE id = ?', task.id);
  assert.strictEqual(finalTask.stage, 'completed', 'Renewal task completed automatically');
  assert.ok(finalTask.completed_at);
});

// ---------------------------------------------------------------------------
// TEST 10: Fleet Compliance KPIs & Upcoming Expirations
// ---------------------------------------------------------------------------
test('Fleet compliance summary aggregates KPIs, type breakdowns and upcoming expirations', () => {
  const summary = vdocs.getFleetComplianceSummary({ today: '2026-10-08' });
  assert.ok(summary.kpis.total_vehicles >= 2);
  assert.ok(summary.type_breakdown.revenue_licence);
  assert.ok(summary.type_breakdown.insurance);
  assert.ok(summary.type_breakdown.emission);
  assert.ok(summary.type_breakdown.fitness);

  // Reminders logging
  const docs = vdocs.getVehicleDocuments(101);
  const rlDoc = docs.find((d) => d.doc_type_code === 'revenue_licence');
  const verId = rlDoc.current_version_id;

  vdocs.logReminderSent(verId, '1_month', tmUser.id, 'in_app');
  const reminders = vdocs.getRemindersForVersion(verId);
  assert.strictEqual(reminders.length, 1);
  assert.strictEqual(reminders[0].stage, '1_month');

  // Deduplication check: second log does not duplicate
  vdocs.logReminderSent(verId, '1_month', tmUser.id, 'in_app');
  const remindersAfter = vdocs.getRemindersForVersion(verId);
  assert.strictEqual(remindersAfter.length, 1, 'Duplicate reminder log prevented by unique constraint');
});

// ---------------------------------------------------------------------------
// TEST 11: Scheduled Compliance Checks & Automated Reminder Engine
// ---------------------------------------------------------------------------
test('runDailyReminderCheck evaluates fleet, auto-promotes eligible versions, and logs deduplicated reminders', () => {
  // Setup: create future-dated renewal for Asset 102
  const docs102 = vdocs.getVehicleDocuments(102);
  const emDoc = docs102.find((d) => d.doc_type_code === 'emission');
  const futureVer = vdocs.createDraftVersion(emDoc.id, {
    doc_number: 'EM-FUT-2027',
    valid_from: '2026-10-10',
    valid_until: '2027-10-10'
  }, tmUser);
  vdocs.verifyVersion(futureVer.id, { decision: 'approve' }, adminUser);

  // 1. Run check on 2026-10-08 -> version is future-dated, not promoted yet
  const resBefore = vdocs.runDailyReminderCheck({ today: '2026-10-08' });
  assert.ok(Array.isArray(resBefore.promoted_ids));
  assert.ok(!resBefore.promoted_ids.includes(futureVer.id), 'Not promoted before valid_from');

  // 2. Run check on 2026-10-10 -> start date arrived, promoted!
  const resOnDay = vdocs.runDailyReminderCheck({ today: '2026-10-10' });
  assert.ok(resOnDay.promoted_ids.includes(futureVer.id), 'Promoted on valid_from date');
  const reloadedDoc = vdocs.getDocumentById(emDoc.id);
  assert.strictEqual(reloadedDoc.current_version_id, futureVer.id, 'Future version promoted to current_version_id');

  // 3. Reminders generated and deduplicated
  assert.ok(resOnDay.reminders_logged >= 0);

  // Running again on the same day should log 0 new reminders due to unique constraint deduplication
  const resSecondRun = vdocs.runDailyReminderCheck({ today: '2026-10-10' });
  assert.strictEqual(resSecondRun.promoted_ids.length, 0, 'No re-promotion');
  assert.strictEqual(resSecondRun.reminders_logged, 0, 'Zero new duplicate reminders logged on same day');
});

// ---------------------------------------------------------------------------
// TEST 12: Background Reminder Scheduler Initialization
// ---------------------------------------------------------------------------
test('startScheduler initializes interval timer and clears cleanly', () => {
  const timer = vdocs.startScheduler(60);
  assert.ok(timer, 'Timer handle created');
  clearInterval(timer);
});

